import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTreeLayout, meanRadius, radiusProfile } from '../js/layout.js';
import { CONFIG } from '../js/config.js';

// 可复现的伪随机，测试断言才稳定
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const shape = CONFIG.particles;

test('布局：树是圆锥形，底部明显比顶部粗', () => {
  const { tree } = buildTreeLayout(1600, shape, seeded());
  const profile = radiusProfile(tree, 5);

  assert.equal(profile.length, 5);
  // 从底到顶单调变细（允许极小噪音）
  for (let i = 1; i < profile.length; i++) {
    assert.ok(
      profile[i] <= profile[i - 1] + 0.35,
      `第 ${i} 层半径 ${profile[i].toFixed(2)} 大于下一层 ${profile[i - 1].toFixed(2)}，不成锥形`,
    );
  }
  assert.ok(profile[0] > profile[4] * 2.5, '底部半径应至少是顶部的 2.5 倍');
});

test('布局：高度落在配置范围内，不会穿到地面以下', () => {
  const { tree } = buildTreeLayout(1600, shape, seeded());
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < tree.length; i += 3) {
    minY = Math.min(minY, tree[i + 1]);
    maxY = Math.max(maxY, tree[i + 1]);
  }
  assert.ok(minY >= shape.floorY - 0.4, `最低点 ${minY.toFixed(2)} 低于地面 ${shape.floorY}`);
  assert.ok(maxY <= shape.floorY + shape.height + 0.4, `最高点 ${maxY.toFixed(2)} 超出树顶`);
  assert.ok(maxY - minY > shape.height * 0.85, '树的纵向跨度太小，会挤成一团');
});

test('布局：散开态的粒子确实散在四周，不是一堆在中心', () => {
  const { scatter } = buildTreeLayout(1600, shape, seeded());
  const avg = meanRadius(scatter);
  assert.ok(avg > 12, `散开态平均半径只有 ${avg.toFixed(2)}，太挤了`);
  assert.ok(avg < 40, `散开态平均半径 ${avg.toFixed(2)} 太大，会飞出画面`);
});

test('布局：两组目标坐标不相等（否则切形态看不到任何变化）', () => {
  const { tree, scatter } = buildTreeLayout(200, shape, seeded());
  let maxDiff = 0;
  for (let i = 0; i < tree.length; i++) maxDiff = Math.max(maxDiff, Math.abs(tree[i] - scatter[i]));
  assert.ok(maxDiff > 5, `两套坐标最大差异只有 ${maxDiff.toFixed(2)}`);
});

test('布局：所有数组长度与粒子数一致，且没有 NaN', () => {
  const count = 300;
  const { tree, scatter, seed, size } = buildTreeLayout(count, shape, seeded());
  assert.equal(tree.length, count * 3);
  assert.equal(scatter.length, count * 3);
  assert.equal(seed.length, count);
  assert.equal(size.length, count);
  for (const arr of [tree, scatter, seed, size]) {
    for (const v of arr) assert.ok(Number.isFinite(v), '出现了 NaN/Infinity');
  }
});
