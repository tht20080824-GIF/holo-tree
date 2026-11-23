import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RIBBON_TURNS,
  RIBBON_TOP_RATIO,
  RIBBON_RADIUS_FACTOR,
  TAPER_EXPONENT,
  trunkRadius,
  ribbonRadius,
  ribbonY,
  ribbonAngle,
  ribbonPitch,
  pointScale,
  ribbonRevealAt,
  ribbonPoint,
} from '../js/ribbon-math.js';
import { CONFIG } from '../js/config.js';

const { height, floorY, radius } = CONFIG.particles;

test('光带：圈数落在规格区间 3.5~4', () => {
  assert.ok(RIBBON_TURNS >= 3.5 && RIBBON_TURNS <= 4, `圈数 ${RIBBON_TURNS}`);
});

test('光带：顶部止于树顶下方 8%', () => {
  assert.equal(RIBBON_TOP_RATIO, 0.92);
  assert.equal(ribbonY(1, floorY, height), floorY + height * 0.92);
  assert.equal(ribbonY(0, floorY, height), floorY);
});

test('光带：半径恒等于树身半径 ×1.1（不是写死绝对值）', () => {
  for (const t of [0, 0.25, 0.5, 0.75, 0.99]) {
    const expected = trunkRadius(t, radius) * RIBBON_RADIUS_FACTOR;
    assert.ok(Math.abs(ribbonRadius(t, radius) - expected) < 1e-9, `t=${t}`);
  }
  assert.equal(ribbonRadius(0, radius), radius * 1.1);
});

test('光带：随高度单调收分，不会出现"顶部悬浮大环"', () => {
  let prev = Infinity;
  for (let t = 0; t <= 1; t += 0.02) {
    const r = ribbonRadius(t, radius);
    assert.ok(r <= prev + 1e-9, `t=${t.toFixed(2)} 半径反弹了`);
    prev = r;
  }
  // 顶部半径应该非常小
  assert.ok(ribbonRadius(1, radius) < radius * 0.01);
});

test('光带：圈间距均匀（每圈升高相同）', () => {
  const pitch = ribbonPitch(height);
  const ys = [];
  for (let i = 0; i <= Math.floor(RIBBON_TURNS); i++) {
    ys.push(ribbonY(i / RIBBON_TURNS, floorY, height));
  }
  for (let i = 1; i < ys.length; i++) {
    const gap = ys[i] - ys[i - 1];
    assert.ok(Math.abs(gap - pitch) < 1e-6, `第 ${i} 圈间距 ${gap} vs ${pitch}`);
  }
});

test('光带：螺旋角总转角 = 圈数 × 2π', () => {
  const total = ribbonAngle(1) - ribbonAngle(0);
  assert.ok(Math.abs(total - RIBBON_TURNS * Math.PI * 2) < 1e-9);
});

test('光带：与树身布局共用同一个收分公式', () => {
  // 指数必须一致，否则光带会和树身脱开
  assert.equal(TAPER_EXPONENT, 0.88);
  assert.ok(Math.abs(trunkRadius(0.5, radius) - radius * Math.pow(0.5, 0.88)) < 1e-9);
});

test('光带：粒子数在规格区间（桌面 8000~12000）', () => {
  assert.ok(CONFIG.ribbon.count >= 8000 && CONFIG.ribbon.count <= 12000, `count=${CONFIG.ribbon.count}`);
});

test('光带：点尺寸在真实场景尺度下必须可见（≥2 像素）', () => {
  // 典型场景：视口 800 高、DPR 2、视角 44°、相机距离 40
  const scale = pointScale(800, 2, 44);
  const sizePx = (1.0 * scale) / 40;
  assert.ok(sizePx >= 2, `光带粒子只有 ${sizePx.toFixed(2)} 像素，会看不见`);
  assert.ok(sizePx < 24, `光带粒子 ${sizePx.toFixed(2)} 像素，太粗了`);
});

test('光带生长：1.5 秒 easeOutCubic，前快后慢', () => {
  assert.equal(ribbonRevealAt(0), 0);
  assert.equal(ribbonRevealAt(1.5), 1);
  assert.equal(ribbonRevealAt(3), 1);
  const mid = ribbonRevealAt(0.6);
  assert.ok(mid > 0.75 && mid < 0.85, `0.6s 应到 ~78%，实际 ${mid.toFixed(2)}`);
  let prev = -1;
  for (let t = 0; t <= 1.5; t += 0.05) {
    const v = ribbonRevealAt(t);
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
});

test('光带生长：0.6s 时已经走过七成（读得出「窜上来」）', () => {
  assert.ok(ribbonRevealAt(0.6) > 0.7);
  assert.ok(ribbonRevealAt(1.2) > 0.97, `1.2s 应基本到顶，实际 ${ribbonRevealAt(1.2).toFixed(3)}`);
});

test('光带路径：s=0 在树底、s=1 在树顶下方，半径随高度收小', () => {
  const shape = { floorY: -12, height: 24, baseRadius: 9 };
  const bottom = ribbonPoint(0, shape);
  const top = ribbonPoint(1, shape);
  assert.ok(Math.abs(bottom.y - shape.floorY) < 1e-6);
  assert.ok(Math.abs(top.y - (shape.floorY + shape.height * RIBBON_TOP_RATIO)) < 1e-6);
  const rBottom = Math.hypot(bottom.x, bottom.z);
  const rTop = Math.hypot(top.x, top.z);
  assert.ok(rBottom > rTop * 3, '底部半径应明显大于顶部');
});
