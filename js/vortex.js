/**
 * 「上升漩涡」：动画收尾时从画面下方转上来的一股粒子，慢慢收成树。
 *
 * 关键点是「不是一下子出现」：
 *   - 每颗粒子有自己的 delay（0~0.45s），从下往上依次冒出来；
 *   - 起点在树底以下（floorY - rise），用 0.2s 淡入；
 *   - 上升过程中绕 Y 轴转，半径随高度收小 → 像一个漏斗被提起来。
 *
 * 纯数学放这里，能单测；怎么画在 tree.js。
 */

export const VORTEX = Object.freeze({
  duration: 1.6,     // 整段时长（秒）
  floorY: -12,       // 树底（main 会按 config 覆盖）
  rise: 14,          // 从树底再往下多少开始起
  height: 26,        // 上升的总高度（够从底部穿到树顶）
  radius: 9.5,       // 底部的起始半径
  turns: 2.4,        // 整段转多少圈
  delay: 0.45,       // 粒子之间的错峰（秒）
  fadeIn: 0.18,      // 单颗粒子淡入
});

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createRiseVortex(n, cfg = VORTEX, rng = Math.random) {
  const theta = new Float32Array(n);
  const radius = new Float32Array(n);
  const delay = new Float32Array(n);
  const speed = new Float32Array(n);
  const offset = new Float32Array(n);
  const size = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    theta[i] = rng() * TAU;
    radius[i] = cfg.radius * (0.35 + rng() * 0.65);
    delay[i] = rng() * cfg.delay;
    speed[i] = 0.85 + rng() * 0.3;
    offset[i] = (rng() - 0.5) * 1.2;   // 纵向抖动，别像一圈环
    size[i] = 0.7 + rng() * 0.9;
  }

  return { n, theta, radius, delay, speed, offset, size, cfg };
}

/**
 * 某颗粒子在时刻 t 的局部坐标。
 * 还没轮到的粒子返回 false（调用方把尺寸设 0 即可）。
 */
export function vortexPoint(f, i, t, out) {
  const cfg = f.cfg;
  const lt = t - f.delay[i];
  if (lt <= 0) return false;

  // 0..1 的上升进度（速度略有差异，快的先到顶）
  const p = clamp01((lt / cfg.duration) * f.speed[i]);
  const y = cfg.floorY - cfg.rise + (cfg.height + cfg.rise) * p + f.offset[i];

  // 半径随高度收小：底部大、顶上细，像一个被提起来的漏斗
  const r = f.radius[i] * (1 - 0.72 * p);
  const a = f.theta[i] + TAU * cfg.turns * p;

  out[0] = Math.cos(a) * r;
  out[1] = y;
  out[2] = Math.sin(a) * r;
  return true;
}

/** 单颗粒子的不透明度：淡入 + 整体末段淡出（保证整段结束一定归零） */
export function vortexAlpha(f, i, t) {
  const cfg = f.cfg;
  const lt = t - f.delay[i];
  if (lt <= 0) return 0;
  const end = cfg.duration + cfg.delay;
  const fadeIn = clamp01(lt / cfg.fadeIn);
  const fadeOut = clamp01((end - t) / 0.35);
  return Math.min(fadeIn, fadeOut);
}

/** 整段是否播完 */
export function vortexDone(t, cfg = VORTEX) {
  return t >= cfg.duration + cfg.delay;
}