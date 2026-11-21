import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTRO_DURATION,
  easeInOutCubic,
  easeOutCubic,
  burstOffset,
  starPulse,
  dustSpin,
  dustRingExtent,
  fitDustRadius,
  tiltDisc,
  dustTiltFor,
  DUST_TILT,
  frameCamera,
  projectToNdc,
  letterProgress,
  TEXT_LETTER_DELAY,
  TEXT_LETTER_DURATION,
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

test('星尘盘：转速随进度加快（平方）', () => {
  assert.ok(dustSpin(1) > dustSpin(0.5) && dustSpin(0.5) > dustSpin(0));
});

/** 与 js/intro.js 的 _refit() 完全一致的取景参数 */
const INTRO_SHAPE = { height: 24, floorY: -12, baseRadius: 9 };
const DUST_THICKNESS = INTRO_SHAPE.height * 0.055;

function introCam(w, h) {
  const aspect = w / h;
  const cam = frameCamera({
    fov: 42,
    aspect,
    yMin: INTRO_SHAPE.floorY - 1,
    yMax: INTRO_SHAPE.floorY + INTRO_SHAPE.height + 3,
    halfW: INTRO_SHAPE.baseRadius * 1.2,
  });
  const tilt = dustTiltFor(aspect);
  return { distance: cam.distance, targetY: cam.targetY, tanV: cam.tanV, aspect, tilt };
}

/** 和 _refit() 一样：反算半径 + 取上限 */
function fitFor(w, h) {
  const cam = introCam(w, h);
  const radius = fitDustRadius(cam, {
    tilt: cam.tilt,
    thickness: DUST_THICKNESS,
    marginX: 0.92,
    marginTop: 0.9,
    marginBottom: 0.96,
    cap: INTRO_SHAPE.baseRadius * 2.6,
  });
  return { cam, radius, extent: dustRingExtent(radius, cam, { tilt: cam.tilt, thickness: DUST_THICKNESS }) };
}

const CANVASES = [
  [390, 844],   // 手机竖屏
  [1080, 1920], // 手机长屏
  [820, 1180],  // 平板竖屏
  [1440, 700],  // 笔记本（用户录屏的画幅）
  [2560, 1080], // 超宽屏
];

test('星尘盘：半径按画幅反算后，整圈都在画面内（不能超出屏幕）', () => {
  for (const [w, h] of CANVASES) {
    const { extent } = fitFor(w, h);
    assert.ok(
      extent.maxX <= 0.921,
      `${w}×${h} 的星尘环横向越界：${extent.maxX.toFixed(2)}（应 ≤ 0.92）`,
    );
    assert.ok(
      extent.minY >= -0.961,
      `${w}×${h} 的星尘环掉出画面下沿：${extent.minY.toFixed(2)}（应 ≥ -0.96）`,
    );
    assert.ok(
      extent.maxY <= 0.901,
      `${w}×${h} 的星尘环顶出画面上沿：${extent.maxY.toFixed(2)}（应 ≤ 0.90）`,
    );
  }
});

test('星尘盘：窄屏环更小、宽屏环更大（不能写死一个世界半径）', () => {
  const portrait = fitFor(390, 844);
  const wide = fitFor(2560, 1080);

  assert.ok(portrait.radius > 0 && wide.radius > 0);
  assert.ok(
    wide.radius > portrait.radius * 1.6,
    `宽屏 ${wide.radius.toFixed(1)} 与竖屏 ${portrait.radius.toFixed(1)} 差得不够，说明没按画幅算`,
  );
  // 竖屏要尽量吃满宽度，不能缩成一个小点
  assert.ok(
    portrait.extent.maxX > 0.85,
    `竖屏的环只占 ${(portrait.extent.maxX * 100).toFixed(0)}% 半宽，太小`,
  );
});

test('星尘盘：半径上限 2.6× 树底，横屏也不会张到离谱', () => {
  const cap = INTRO_SHAPE.baseRadius * 2.6;
  const { radius } = fitFor(2560, 1080);
  assert.ok(radius <= cap + 1e-9, `超宽屏星尘环半径 ${radius.toFixed(1)} 超过上限 ${cap}`);
});

test('星尘盘：投影出来是个挂着的环，不是一条横线也不是一坨圆', () => {
  for (const [w, h] of CANVASES) {
    const { extent } = fitFor(w, h);
    const ratio = (extent.maxY - extent.minY) / 2 / extent.maxX;
    assert.ok(ratio > 0.28, `${w}×${h} 太扁（短/长轴 ${ratio.toFixed(2)}），会看成一条线`);
    assert.ok(ratio < 0.9, `${w}×${h} 太圆（短/长轴 ${ratio.toFixed(2)}），看不出俯视感`);
  }
});

test('星尘盘：竖屏的椭圆比例贴近参考画面（0.30~0.42）', () => {
  // 参考视频是在竖长窗口里录的：环占满宽度，短/长轴 ≈ 0.33。
  // 竖屏手机上如果只倾斜 26°，投影会被 aspect 压成 0.2 的一条扁带，所以按画幅自适应。
  for (const [w, h] of [[390, 844], [1080, 1920]]) {
    const { extent } = fitFor(w, h);
    const ratio = (extent.maxY - extent.minY) / 2 / extent.maxX;
    assert.ok(
      ratio > 0.3 && ratio < 0.42,
      `${w}×${h} 的短/长轴是 ${ratio.toFixed(2)}，和参考画面的 0.33 差太多`,
    );
  }
});

test('星尘盘：先自转再倾斜（反过来会像陀螺一样晃）', () => {
  const p = tiltDisc(10, 0, 0);
  assert.ok(Math.abs(p.x - 10) < 1e-9, '绕 X 倾斜不该改变 x');
  assert.ok(Math.abs(p.y) < 1e-9, 'y0=0 时倾斜不该凭空抬高');

  const q = tiltDisc(0, 0, 10);
  assert.ok(Math.abs(q.y + 10 * Math.sin(DUST_TILT)) < 1e-9, '远侧（+z）应该沉下去');
  assert.ok(Math.abs(q.z - 10 * Math.cos(DUST_TILT)) < 1e-9);
});

test('星尘盘：汇聚结束时半径一定小于开始', () => {
  for (const [w, h] of CANVASES) {
    const { radius } = fitFor(w, h);
    const r1 = Math.min(radius * 0.62, INTRO_SHAPE.baseRadius * 1.45);
    assert.ok(r1 < radius, `${w}×${h} 的环在"越聚越散"`);
  }
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
