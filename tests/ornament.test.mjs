import test from 'node:test';
import assert from 'node:assert/strict';

import { placeOrnaments, makeScatterPoint } from '../js/ornament-math.js';
import { bowShape, giftShape, placeShape } from '../js/ornament-shapes.js';
import { trunkRadius } from '../js/ribbon-math.js';
import { CONFIG } from '../js/config.js';

const shape = {
  count: 9,
  height: CONFIG.particles.height,
  floorY: CONFIG.particles.floorY,
  baseRadius: CONFIG.particles.radius,
};

function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

test('装饰：数量正确，且每个都有合法坐标', () => {
  const items = placeOrnaments({ ...shape, rng: seeded() });
  assert.equal(items.length, shape.count);
  for (const it of items) {
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Number.isFinite(it.position[k]), `${k} 不是有限数`);
    }
  }
});

test('装饰：挂在树身外侧，不穿模也不悬空', () => {
  const items = placeOrnaments({ ...shape, rng: seeded(3) });
  for (const it of items) {
    const trunk = trunkRadius(it.t, shape.baseRadius);
    const ratio = it.radius / trunk;
    assert.ok(ratio > 1.1 && ratio < 1.25, `外扩倍数 ${ratio.toFixed(2)} 不在 1.1~1.25`);
  }
});

test('装饰：高度集中在树身中段，不会爬满全身', () => {
  const items = placeOrnaments({ ...shape, rng: seeded(5), tMin: 0.16, tMax: 0.58 });
  for (const it of items) {
    assert.ok(it.t >= 0.16 && it.t <= 0.58, `t=${it.t}`);
  }
});

test('装饰：角度散开，不是排成一列', () => {
  const items = placeOrnaments({ ...shape, rng: seeded(11) });
  const angles = items.map((i) => ((i.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
  const sorted = [...angles].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  assert.ok(maxGap < Math.PI, '出现了超过半圈的空档，分布不均');
});

test('装饰：尺寸有小幅随机，避免一模一样', () => {
  const items = placeOrnaments({ ...shape, rng: seeded(13) });
  const scales = items.map((i) => i.scale);
  assert.ok(Math.min(...scales) >= 0.78 && Math.max(...scales) <= 1.18);
  assert.ok(new Set(scales.map((s) => s.toFixed(3))).size > 3, '尺寸几乎相同，缺少变化');
});

test('装饰：数量克制（规格上"不能太多"）', () => {
  assert.ok(CONFIG.ornaments.gifts <= 6, '礼盒太多会显廉价');
  assert.ok(CONFIG.ornaments.bows <= 5, '蝴蝶结太多会显廉价');
});

test('蝴蝶结：挂得比礼盒更靠外，才显眼', () => {
  const bows = placeOrnaments({
    ...shape, count: CONFIG.ornaments.bows, clearance: CONFIG.ornaments.bowClearance, rng: seeded(17),
  });
  for (const it of bows) {
    const ratio = it.radius / trunkRadius(it.t, shape.baseRadius);
    assert.ok(ratio > 1.28, `蝴蝶结外扩只有 ${ratio.toFixed(2)} 倍，会埋在树里`);
  }
});

test('蝴蝶结：尺寸足够大（与礼盒同量级）', () => {
  assert.ok(CONFIG.ornaments.bowSize >= 1.2, '蝴蝶结太小，远看不见');
  assert.ok(CONFIG.ornaments.bowSize >= CONFIG.ornaments.giftSize * 1.2, '蝴蝶结应比礼盒更大');
});

test('散开目标：落在粒子云同一量级的球壳上', () => {
  for (let i = 0; i < 50; i++) {
    const p = makeScatterPoint(seeded(i + 1));
    const r = Math.hypot(p.x, p.y, p.z);
    assert.ok(Number.isFinite(r), '出现 NaN');
    assert.ok(r > 10 && r < 35, `散开半径 ${r.toFixed(1)} 超出范围`);
  }
});

test('散开目标：不是所有蝴蝶结飞去同一个点', () => {
  const pts = Array.from({ length: 5 }, (_, i) => makeScatterPoint(seeded(i + 100)));
  const key = new Set(pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`));
  assert.ok(key.size >= 4, '散开位置重复，会挤成一团');
});

test('装饰形状：蝴蝶结由上百颗粒子组成，不是实体网格', () => {
  const pts = bowShape(1, seeded(21));
  assert.ok(pts.length > 100, `只有 ${pts.length} 颗，太少`);
  for (const p of pts) {
    for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(p[k]), `${k} 非法`);
    assert.ok(Number.isFinite(p.size) && p.size > 0, 'size 非法');
  }
  // 尺寸收敛在 ±0.5 以内，不会散得到处都是
  const spanX = Math.max(...pts.map((p) => Math.abs(p.x)));
  assert.ok(spanX < 0.6, `横向跨度 ${spanX.toFixed(2)} 太大`);
});

test('装饰形状：礼盒含盒身/盒盖/丝带，粒子数量明显更多', () => {
  const pts = giftShape(1, seeded(23));
  assert.ok(pts.length > 200, `礼盒只有 ${pts.length} 颗`);
  const maxY = Math.max(...pts.map((p) => p.y));
  const minY = Math.min(...pts.map((p) => p.y));
  assert.ok(maxY > 0.5, '没有盒盖/蝴蝶结部分');
  assert.ok(minY > -0.05, '粒子跑到盒子底部以下了');
});

test('装饰形状：颜色都取自主体调色板（绿/金/红）', () => {
  const palette = new Set([
    0x1e8a56, 0x2fbf72, 0x0e6440,
    0xffd27a, 0xffb547, 0xfff3c9,
    0xff3b5c, 0xd6233f, 0xff6f83,
  ]);
  for (const p of [...bowShape(1, seeded(25)), ...giftShape(1, seeded(27))]) {
    assert.ok(palette.has(p.color), `出现了调色板外的颜色 0x${p.color.toString(16)}`);
  }
});

test('装饰形状：placeShape 的 yaw 旋转方向正确（不会转到树里面）', () => {
  const out = placeShape([{ x: 1, y: 0, z: 0, color: 0, size: 1 }], {
    position: { x: 0, y: 0, z: 0 },
    yaw: Math.PI / 2,
  });
  assert.ok(Math.abs(out[0].x) < 1e-9, `x 应为 0，实际 ${out[0].x}`);
  assert.ok(Math.abs(out[0].z + 1) < 1e-9, `z 应为 -1，实际 ${out[0].z}`);
});

test('配置：蝴蝶结为 3 个且明显放大', () => {
  assert.equal(CONFIG.ornaments.bows, 3);
  assert.ok(CONFIG.ornaments.bowSize >= 1.8, `蝴蝶结尺寸 ${CONFIG.ornaments.bowSize} 还不够大`);
});
