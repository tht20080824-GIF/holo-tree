/**
 * 布局计算：粒子在"合拢态"和"散开态"下分别该在哪。
 *
 * 抽成独立模块的理由很实际 —— 这段决定了"看起来像不像一棵树"，
 * 而它跟 three.js 完全无关，可以塞进单测里断言：
 * 底部半径必须比顶部大、高度必须在范围内、散开态不能全挤在中心。
 *
 * rng 参数是为了测试可复现；运行时传 Math.random 即可。
 */

const GOLDEN_ANGLE = 2.399963;

/**
 * @param {number} count 粒子数
 * @param {{height:number,radius:number,floorY:number}} shape
 * @param {() => number} rng
 */
export function buildTreeLayout(count, shape, rng = Math.random) {
  const { height, radius, floorY } = shape;

  const tree = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const t = i / Math.max(count - 1, 1); // 0 = 底部, 1 = 顶部

    // 圆锥 + 黄金角螺旋：比纯随机更均匀，还自带一点"缠绕"的秩序感
    const y = floorY + height * t;
    const r = radius * Math.pow(1 - t, 0.88) * (0.72 + rng() * 0.42);
    const angle = i * GOLDEN_ANGLE + rng() * 0.4;

    tree[i * 3] = Math.cos(angle) * r;
    tree[i * 3 + 1] = y + (rng() - 0.5) * 0.55;
    tree[i * 3 + 2] = Math.sin(angle) * r;

    // 散开态：球壳，半径 16~29，纵向压扁一点更像星云而不是球
    const phi = Math.acos(2 * rng() - 1);
    const theta = rng() * Math.PI * 2;
    const layer = 16 + rng() * 13;
    scatter[i * 3] = Math.sin(phi) * Math.cos(theta) * layer;
    scatter[i * 3 + 1] = Math.cos(phi) * layer * 0.62 + 2;
    scatter[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * layer;

    seed[i] = rng() * 100;
    size[i] = 0.7 + rng() * 0.9;
  }

  return { tree, scatter, seed, size };
}

/** 散开态下粒子离原点的平均距离，用于断言"确实是散开的" */
export function meanRadius(positions) {
  let sum = 0;
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    sum += Math.hypot(x, y, z);
  }
  return sum / n;
}

/** 按高度分层的平均水平半径（测试和调参都用得上） */
export function radiusProfile(positions, bands = 5) {
  const n = positions.length / 3;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxY - minY, 1e-6);
  const sums = new Array(bands).fill(0);
  const counts = new Array(bands).fill(0);

  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1];
    const band = Math.min(bands - 1, Math.floor(((y - minY) / span) * bands));
    sums[band] += Math.hypot(positions[i * 3], positions[i * 3 + 2]);
    counts[band]++;
  }

  return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}
