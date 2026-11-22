import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VORTEX,
  createRiseVortex,
  vortexPoint,
  vortexAlpha,
  vortexDone,
} from '../js/vortex.js';

function seeded(seed = 23) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const CFG = { ...VORTEX, floorY: -12 };

test('漩涡：粒子从画面下方起步（不是凭空出现）', () => {
  const f = createRiseVortex(500, CFG, seeded(1));
  const out = [0, 0, 0];
  let below = 0;
  for (let i = 0; i < f.n; i++) {
    // 还没轮到 / 已经在下方，都算「从下面来」
    if (!vortexPoint(f, i, 0.02, out) || out[1] < CFG.floorY) below++;
  }
  assert.ok(below > f.n * 0.9, `应有九成以上粒子还在树底以下，实际 ${below}`);
});

test('漩涡：随时间上升，最终穿到树顶之上', () => {
  const f = createRiseVortex(300, CFG, seeded(2));
  const out = [0, 0, 0];
  const yAt = (i, t) => (vortexPoint(f, i, t, out) ? out[1] : -Infinity);

  const i = 5;
  const y1 = yAt(i, 0.2);
  const y2 = yAt(i, 0.8);
  const y3 = yAt(i, 1.6);
  assert.ok(y2 > y1, '应在上升');
  assert.ok(y3 > y2, '应持续上升');
  assert.ok(y3 > CFG.floorY + CFG.height * 0.8, `最终应接近树顶，实际 ${y3.toFixed(1)}`);
});

test('漩涡：越往上越收窄（漏斗感）', () => {
  const f = createRiseVortex(300, CFG, seeded(3));
  const out = [0, 0, 0];
  const radiusAt = (i, t) => (vortexPoint(f, i, t, out) ? Math.hypot(out[0], out[2]) : NaN);

  // 挑一颗一开始就在的粒子（delay 最小），避免拿到 NaN
  let i = 0;
  for (let k = 1; k < f.n; k++) if (f.delay[k] < f.delay[i]) i = k;
  const r1 = radiusAt(i, f.delay[i] + 0.15);
  const r2 = radiusAt(i, 1.4);
  assert.ok(r2 < r1 * 0.6, `顶部半径应明显收小：${r1.toFixed(2)} → ${r2.toFixed(2)}`);
});

test('漩涡：错峰出现 —— 不同粒子起始时间不同', () => {
  const f = createRiseVortex(800, CFG, seeded(4));
  const delays = new Set(Array.from(f.delay, (d) => d.toFixed(2)));
  assert.ok(delays.size > 20, '延迟应该有足够多的取值');
  assert.ok(Math.max(...f.delay) > 0.3, '要有一段明显的错峰');

  const out = [0, 0, 0];
  let visibleEarly = 0;
  let total = 0;
  for (let i = 0; i < f.n; i++) {
    total++;
    if (vortexPoint(f, i, 0.05, out)) visibleEarly++;
  }
  assert.ok(visibleEarly < total * 0.35, `刚开始不该全部冒出来（${visibleEarly}/${total}）`);
});

test('漩涡：淡入淡出，首尾都是 0', () => {
  const f = createRiseVortex(200, CFG, seeded(5));
  const i = 3;
  assert.equal(vortexAlpha(f, i, 0), 0, '还没开始应完全透明');
  let peak = 0;
  for (let t = 0; t < 2; t += 0.05) peak = Math.max(peak, vortexAlpha(f, i, t));
  assert.ok(peak > 0.8, '中途应该亮起来');
  assert.ok(vortexAlpha(f, i, CFG.duration + CFG.delay) < 0.05, '结束时应该淡掉');
});

test('漩涡：整段播完可以被判定', () => {
  assert.equal(vortexDone(0.5, CFG), false);
  assert.equal(vortexDone(CFG.duration + CFG.delay + 0.01, CFG), true);
});
