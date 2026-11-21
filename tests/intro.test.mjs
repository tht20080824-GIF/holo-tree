import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTRO_DURATION,
  easeInOutCubic,
  easeOutCubic,
  burstOffset,
  starPulse,
  dustRadius,
  dustPoint,
  frameCamera,
  projectToNdc,
  letterProgress,
  TEXT_LETTER_DELAY,
  TEXT_LETTER_DURATION,
  dustSpin,
} from '../js/intro-math.js';

/** 树的世界尺寸（与 config 一致） */
const TREE = { yMin: -13.5, yMax: 14.5, halfW: 10.5 };

test('开场：总时长 16 秒', () => {
  assert.equal(INTRO_DURATION, 16);
});

test('开场：缓动函数端点与单调性正确', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.ok(Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-9);

  let prev = -1;
  for (let x = 0; x <= 1; x += 0.05) {
    const v = easeOutCubic(x);
    assert.ok(v >= prev - 1e-9, 'easeOutCubic 不单调');
    prev = v;
  }
});

test('爆散：位移曲线端点 = 0 → 4.2，且先缓后猛', () => {
  assert.equal(burstOffset(0), 0);
  assert.ok(Math.abs(burstOffset(1) - 4.2) < 1e-9, `末端 ${burstOffset(1)}`);

  // 前 20% 只走了不到 15%
  assert.ok(burstOffset(0.2) < 0.15 * 4.2, '爆散开始太猛，缺少蓄力感');

  let prev = 0;
  for (let e = 0; e <= 1; e += 0.02) {
    const v = burstOffset(e);
    assert.ok(v >= prev - 1e-9, '爆散位移不单调');
    prev = v;
  }
});

test('爆散：加速度递增（二阶差分 > 0）', () => {
  const a = burstOffset(0.3) - burstOffset(0.2);
  const b = burstOffset(0.7) - burstOffset(0.6);
  assert.ok(b > a, '后半段应比前半段更快（e^2.1 项）');
});

test('塔尖星芒：5.85 秒达到峰值，σ=0.3 外快速衰减', () => {
  assert.ok(Math.abs(starPulse(5.85) - 1) < 1e-9);
  assert.ok(starPulse(5.85 + 0.3) < 0.65);
  assert.ok(starPulse(5.85 + 0.9) < 0.02);
  assert.ok(starPulse(5.0) < 0.02);
});

test('星尘盘：半径收到 1.5×树底半径，且一定在收缩', () => {
  assert.ok(Math.abs(dustRadius(1, 9) - 13.5) < 1e-9);
  assert.ok(dustRadius(0, 9) > dustRadius(1, 9), '起点必须比终点大，否则是"越聚越散"');
  let prev = Infinity;
  for (let p = 0; p <= 1; p += 0.05) {
    const r = dustRadius(p, 9);
    assert.ok(r <= prev + 1e-9, '半径应单调收缩');
    prev = r;
  }
});

test('星尘盘：转速随进度加快（平方）', () => {
  assert.ok(dustSpin(1) > dustSpin(0.5) && dustSpin(0.5) > dustSpin(0));
});

test('星尘盘：有垂直厚度，不会看成一条线', () => {
  const ys = new Set();
  for (let i = 0; i < 40; i++) {
    const p = dustPoint(i * 0.4, 6, 0.6, (i % 10) / 10 - 0.5);
    ys.add(p.y.toFixed(2));
  }
  assert.ok(ys.size > 8, `垂直方向只有 ${ys.size} 个不同高度，盘太扁`);
});

test('取景：五种画幅下树完整可见、文字区不压树', () => {
  const canvases = [
    [390, 844],   // 手机竖屏
    [820, 1180],  // 平板竖屏
    [1440, 900],  // 笔记本横屏
    [2560, 1080], // 超宽屏
    [1080, 1920], // 手机长屏
  ];

  for (const [w, h] of canvases) {
    const aspect = w / h;
    const cam = frameCamera({ fov: 44, aspect, ...TREE });

    // 树顶、树底、左右最外沿
    const probes = [
      { x: 0, y: TREE.yMax, z: 0, name: '顶部' },
      { x: 0, y: TREE.yMin, z: 0, name: '底部' },
      { x: TREE.halfW, y: 0, z: 0, name: '右侧' },
      { x: -TREE.halfW, y: 0, z: 0, name: '左侧' },
      { x: TREE.halfW * 0.8, y: TREE.yMin, z: TREE.halfW * 0.6, name: '右前下' },
    ];

    for (const p of probes) {
      const ndc = projectToNdc(p, { ...cam, aspect });
      assert.ok(
        Math.abs(ndc.x) <= 0.96,
        `${w}×${h} 的${p.name}横向越界：x=${ndc.x.toFixed(2)}`,
      );
      assert.ok(
        ndc.y <= 0.9,
        `${w}×${h} 的${p.name}顶到上边缘：y=${ndc.y.toFixed(2)}`,
      );
      // 文字在底部 4.2vh（NDC ≈ -0.92 以下），-0.8 以内都算安全；
      // 近侧底角因透视会略低于 -0.6，属正常
      assert.ok(
        ndc.y >= -0.8,
        `${w}×${h} 的${p.name}压到文字区：y=${ndc.y.toFixed(2)}`,
      );
    }
  }
});

test('取景：距离取宽高两个约束的最大值（不能只按一个方向算）', () => {
  // 极宽屏幕：高度约束更松，宽度约束应该主导
  const wide = frameCamera({ fov: 44, aspect: 2.37, ...TREE });
  // 极窄屏幕：宽度约束松，高度应该主导
  const tall = frameCamera({ fov: 44, aspect: 0.46, ...TREE });
  assert.ok(wide.distance > 0 && tall.distance > 0);
  assert.ok(wide.distance !== tall.distance, '两个方向应算出不同距离');
});

test('文字：逐字进度，前面的字母先完成', () => {
  const start = 6.35;
  assert.equal(letterProgress(start, 0), 0);
  const mid = start + TEXT_LETTER_DURATION;
  assert.ok(Math.abs(letterProgress(mid, 0) - 1) < 1e-9);
  // 第 3 个字母比第 1 个晚
  assert.ok(letterProgress(mid, 3) < letterProgress(mid, 1));
  // 全部写完的时间点
  const last = 12;
  const done = start + last * TEXT_LETTER_DELAY + TEXT_LETTER_DURATION;
  assert.ok(done < 12.0, `文字写到 ${done.toFixed(2)}s，来不及在爆散前淡出`);
});
