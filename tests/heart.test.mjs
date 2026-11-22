import test from 'node:test';
import assert from 'node:assert/strict';

import { heartPoints, heartOutline } from '../js/heart.js';

function seeded(seed = 33) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** 射线法：点是否在心形轮廓内 */
function insideHeart(x, yUp, outline) {
  let inside = false;
  const n = outline.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = outline[i * 2];
    const yi = outline[i * 2 + 1];
    const xj = outline[j * 2];
    const yj = outline[j * 2 + 1];
    const hit = yi > yUp !== yj > yUp && x < ((xj - xi) * (yUp - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

test('爱心：采样点数量、数值合法', () => {
  const h = heartPoints(600, seeded(1));
  assert.equal(h.count, 600);
  assert.equal(h.pts.length, 1200);
  for (const v of h.pts) assert.ok(Number.isFinite(v), '出现了 NaN');
});

test('爱心：所有采样点都落在心形轮廓内部（不是一团方块）', () => {
  const outline = heartOutline();
  const h = heartPoints(400, seeded(2));
  let outside = 0;
  for (let i = 0; i < h.pts.length; i += 2) {
    // 采样时 y 被翻转又拉长了 1.12 倍，这里还原回数学坐标再判定
    const x = h.pts[i];
    const yUp = -h.pts[i + 1] / 1.12;
    if (!insideHeart(x * 0.5 + 0, yUp * 0.5 + 0, outline.map((v) => v * 0.5))) outside++;
  }
  assert.equal(outside, 0, `${outside} 个点跑到心形外面了`);
});

test('爱心：形状比例合理（略微竖长，不是扁的/圆的）', () => {
  const h = heartPoints(3000, seeded(3));
  const w = h.maxX - h.minX;
  const hh = h.maxY - h.minY;
  const ratio = hh / w;
  assert.ok(ratio > 0.95 && ratio < 1.35, `高宽比 ${ratio.toFixed(2)} 不像爱心`);
});

test('爱心：上宽下尖（最宽处在上半部，底部是尖的）', () => {
  const h = heartPoints(4000, seeded(4));
  const midY = (h.minY + h.maxY) / 2;
  let topCount = 0;
  let bottomCount = 0;
  for (let i = 0; i < h.pts.length; i += 2) {
    if (h.pts[i + 1] < midY) topCount++;
    else bottomCount++;
  }
  assert.ok(topCount > bottomCount * 1.2, '上半部应该明显比下半部宽/多');

  // 底部一窄条里的横向跨度，应该远小于整体宽度
  const band = h.minY + (h.maxY - h.minY) * 0.9;
  let bandMin = Infinity;
  let bandMax = -Infinity;
  for (let i = 0; i < h.pts.length; i += 2) {
    if (h.pts[i + 1] >= band) {
      bandMin = Math.min(bandMin, h.pts[i]);
      bandMax = Math.max(bandMax, h.pts[i]);
    }
  }
  assert.ok((bandMax - bandMin) / (h.maxX - h.minX) < 0.35, '底部应该收成一个尖');
});

test('爱心：同一个随机种子结果一致（可复现）', () => {
  const a = heartPoints(200, seeded(9));
  const b = heartPoints(200, seeded(9));
  assert.deepEqual(Array.from(a.pts), Array.from(b.pts));
});