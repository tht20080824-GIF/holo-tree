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
