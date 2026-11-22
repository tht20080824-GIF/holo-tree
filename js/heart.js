/**
 * 心形采样：给「手势 1 → 粒子聚成爱心」用。
 *
 * 轮廓用经典心形参数方程
 *   x = 16 sin³t
 *   y = 13cos t − 5cos2t − 2cos3t − cos4t
 * 填充不用「中心射线」，而是按扫描线切成一条条横带、在带内均匀取点 ——
 * 这样才是实心且均匀的，不会在正中间留下一条竖着的接缝。
 *
 * 输出是「图像坐标系」（y 向下），能直接喂给和文字同一条变形管线。
 */

const STEPS = 512;
const ROWS = 256;

export function heartOutline() {
  const out = [];
  for (let i = 0; i < STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2;
    const s = Math.sin(t);
    const x = 16 * s * s * s;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    out.push(x, y);
  }
  return out;
}

/**
 * @param {number} count 采样点数量
 * @param {() => number} rng 可复现的随机源
 */
export function heartPoints(count = 4000, rng = Math.random) {
  const outline = heartOutline();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    if (outline[i] < minX) minX = outline[i];
    if (outline[i] > maxX) maxX = outline[i];
    if (outline[i + 1] < minY) minY = outline[i + 1];
    if (outline[i + 1] > maxY) maxY = outline[i + 1];
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;

  // 扫描线：每一行的 [x0, x1] 区间（心形对任意水平线最多两段，但按通用写法收集全部交点）
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    const y = minY + ((r + 0.5) / ROWS) * (maxY - minY);
    const xs = [];
    for (let i = 0; i < STEPS; i++) {
      const j = (i + 1) % STEPS;
      const y0 = outline[i * 2 + 1];
      const y1 = outline[j * 2 + 1];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const x0 = outline[i * 2];
        const x1 = outline[j * 2];
        xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > 1e-6) spans.push([xs[k], w]);
    }
    if (!spans.length) continue;
    const total = spans.reduce((a, s) => a + s[1], 0);
    rows.push({ y, spans, total });
  }

  // 按行宽加权：宽的行多取点，保证密度均匀
  const grand = rows.reduce((a, r) => a + r.total, 0) || 1;
  const cum = [];
  let acc = 0;
  for (const r of rows) {
    acc += r.total / grand;
    cum.push(acc);
  }

  const pts = [];
  let guard = 0;
  while (pts.length < count * 2 && guard < count * 40) {
    guard++;
    const pick = rng();
    let row = rows[rows.length - 1];
    for (let i = 0; i < cum.length; i++) {
      if (pick <= cum[i]) { row = rows[i]; break; }
    }
    let u = rng();
    let spanPick = row.spans[row.spans.length - 1];
    for (const sp of row.spans) {
      const w = sp[1] / row.total;
      if (u < w) { spanPick = sp; break; }
      u -= w;
    }
    const x = spanPick[0] + rng() * spanPick[1];
    // 归一化 + 竖向拉长一点（参数方程本身偏扁），并翻转 y 成图像坐标
    pts.push(x / span, (-row.y / span) * 1.12);
  }

  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < bx0) bx0 = pts[i];
    if (pts[i] > bx1) bx1 = pts[i];
    if (pts[i + 1] < by0) by0 = pts[i + 1];
    if (pts[i + 1] > by1) by1 = pts[i + 1];
  }

  return { pts, minX: bx0, minY: by0, maxX: bx1, maxY: by1, count: pts.length / 2 };
}