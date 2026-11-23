/**
 * 光带的几何数学（纯函数，无 three.js 依赖，可单测）。
 *
 * 与 layout.js 共用同一个"树身收分"公式：R(t) = baseRadius * (1-t)^0.88。
 * 光带半径取 1.1 倍 —— 贴在外侧留 10% 间隙，树缩放时不会脱开或穿模。
 */

export const TAU = Math.PI * 2;

/** 树身收分指数，与 layout.js 保持一致 */
export const TAPER_EXPONENT = 0.88;

/** 光带圈数（规格：3.5~4 圈） */
export const RIBBON_TURNS = 3.8;

/** 光带终止高度占树高的比例（规格：树顶下方 8%） */
export const RIBBON_TOP_RATIO = 0.92;

/** 光带半径相对树身半径的倍数（规格：×1.1） */
export const RIBBON_RADIUS_FACTOR = 1.1;

/** 树身在归一化高度 t（0=底，1=顶）处的包络半径 */
export function trunkRadius(t, baseRadius) {
  const clamped = Math.min(Math.max(t, 0), 1);
  return baseRadius * Math.pow(1 - clamped, TAPER_EXPONENT);
}

/** 光带在高度 t 处的半径 */
export function ribbonRadius(t, baseRadius) {
  return trunkRadius(t, baseRadius) * RIBBON_RADIUS_FACTOR;
}

/** 光带在高度 t 处的世界 y 坐标 */
export function ribbonY(t, floorY, height) {
  return floorY + height * RIBBON_TOP_RATIO * t;
}

/** 光带在高度 t 处的螺旋角（不含时间项） */
export function ribbonAngle(t, turns = RIBBON_TURNS) {
  return t * turns * TAU;
}

/**
 * 点尺寸换算：把"世界单位下的粒子直径"换成屏幕像素。
 *
 * 场景尺度：树高约 24，相机 z≈40，垂直视角 44°。
 * 早期照搬了一个 0.0086 的系数，算出来是 0.4 像素 —— 等于肉眼不可见。
 * 正确做法：sizePx = worldSize * (H / (2*tanV)) / distance
 */
export function pointScale(viewportHeight, pixelRatio, fovDeg, worldSize = 0.12) {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  return (viewportHeight * pixelRatio * worldSize) / (2 * tanV);
}

/** 圈间距是否均匀：相邻两圈的垂直间距 */
export function ribbonPitch(height) {
  return (height * RIBBON_TOP_RATIO) / RIBBON_TURNS;
}


/**
 * 自下而上「生长」的进度：1.5s 内 easeOutCubic 走完。
 * 前段快（读得出窜上来），末段慢（收在塔尖下方）。
 */
export function ribbonRevealAt(t, dur = 1.5) {
  const x = Math.min(1, Math.max(0, t / Math.max(1e-4, dur)));
  const y = 1 - x;
  return 1 - y * y * y;
}

/**
 * 螺旋上弧长参数 s（0=树底，1=树顶）对应的点（treeRoot 局部坐标）。
 * 爱心消散时，被卷进漩涡的那部分粒子就沿这条曲线爬升。
 */
export function ribbonPoint(s, {
  floorY,
  height,
  baseRadius,
  turns = RIBBON_TURNS,
  rot = 0,
} = {}) {
  const t = Math.min(1, Math.max(0, s));
  const ang = ribbonAngle(t, turns) + rot;
  const r = ribbonRadius(t, baseRadius);
  return {
    x: Math.cos(ang) * r,
    y: ribbonY(t, floorY, height),
    z: Math.sin(ang) * r,
  };
}
