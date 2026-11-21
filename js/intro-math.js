/**
 * 开场动画的数学层（纯函数，无 three.js 依赖，可单测）。
 *
 * 规格来自 `02-开场动画-提示词.md`：
 * - 16 秒时间轴，缓动统一 easeInOutCubic / easeOutCubic
 * - 爆散位移 = 0.5e + 3.7·e^2.1
 * - 取景按"可用矩形"反算距离并取 max，保证任何画幅都不裁切
 */

export const INTRO_DURATION = 16;

// ---------------------------------------------------------------- 缓动

export const easeOutCubic = (x) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);

export const easeInOutCubic = (x) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

export const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/** 把绝对时间映射到某个区间的 0~1 进度 */
export function progress(t, start, end) {
  if (end <= start) return t >= end ? 1 : 0;
  return clamp01((t - start) / (end - start));
}

// ---------------------------------------------------------------- 爆散与星芒

/** 爆散位移曲线：先缓后猛（e 是 0~1 的爆散进度） */
export function burstOffset(e) {
  const p = clamp01(e);
  return 0.5 * p + 3.7 * Math.pow(p, 2.1);
}

/** 塔尖星芒脉冲：中心 5.85s，σ=0.30 的高斯 */
export function starPulse(t, center = 5.85, sigma = 0.3) {
  const d = (t - center) / sigma;
  return Math.exp(-0.5 * d * d);
}

/** 定格段亮度（加色混合必须压到 0.62，否则过曝成白） */
export function freezeBrightness(phase, lo = 0.62, hi = 1) {
  return lo + (hi - lo) * (1 - clamp01(phase));
}

// ---------------------------------------------------------------- 取景

/**
 * 按"可用矩形"反算相机距离。
 *
 * rect：树在画面中允许占据的纵向区间（0 顶 / 1 底）。
 * 顶部留白 6%、底部留出 20% 给文字区 —— 所以底边是 0.80，rectH = 0.74。
 * （规格里写的 "rectTop=0.06，rectBottom=0.20" 指的是"上下留白"，不是区间端点）
 *
 * 关键：d 取宽、高两个约束的 max —— 只按高度算，横屏会裁左右；
 * 只按宽度算，竖屏会裁上下。
 */
export function frameCamera({
  fov = 44,
  aspect = 1,
  yMin,
  yMax,
  halfW,
  rectTop = 0.06,
  bottomMargin = 0.2,
  heightPad = 1.04,
  widthPad = 1.02,
}) {
  const tanV = Math.tan((fov * Math.PI) / 360);
  const rectBottom = 1 - bottomMargin;
  const rectH = rectBottom - rectTop;
  const rectCy = (rectTop + rectBottom) / 2;

  const halfH = (yMax - yMin) / 2;
  const centreY = (yMax + yMin) / 2;

  const dHeight = (halfH * heightPad) / (rectH * tanV);
  const dWidth = (halfW * widthPad) / (0.92 * tanV * Math.max(aspect, 1e-3));
  const distance = Math.max(dHeight, dWidth);

  const viewH = 2 * distance * tanV;
  const targetY = centreY - (0.5 - rectCy) * viewH;

  return { distance, targetY, viewH, tanV, rectH, rectCy };
}

/** 把世界坐标点投影成 NDC（测试用，验证"不裁切"） */
export function projectToNdc(p, camera) {
  const { distance, targetY, tanV, aspect } = camera;
  const dz = distance - p.z;          // 相机在 +z 看向原点
  if (dz <= 0) return { x: 0, y: 0, visible: false };
  const ndcX = p.x / (dz * tanV * aspect);
  const ndcY = (p.y - targetY) / (dz * tanV);
  return { x: ndcX, y: ndcY, visible: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1 };
}

// ---------------------------------------------------------------- 星尘盘

/** 星尘盘倾斜（弧度）：不倾斜的话正对镜头会看成一条线 */
export const DUST_TILT = (17 * Math.PI) / 180;

/**
 * 星尘盘半径随进度收缩到 1.5×树底半径。
 * 起点不能写死 6：树缩放后可能比 6 小，会变成"越聚越散"。
 * 用 2.2× 树底半径作起点，保证任何树尺寸下都一定是收缩。
 */
export function dustRadius(p, baseRadius) {
  const from = Math.max(6, baseRadius * 2.2);
  const to = baseRadius * 1.5;
  const k = Math.min(1, (to / Math.max(from, 1e-6)));
  // from → to 的插值（from 更大时是收缩）
  return from + (to - from) * easeInOutCubic(clamp01(p));
}

/** 星尘盘转速：随进度平方加快 */
export function dustSpin(p, base = 0.6) {
  const e = clamp01(p);
  return base + 2.6 * e * e;
}

/**
 * 在倾斜盘上取一点（带垂直厚度，避免看成一条线）。
 *
 * yJitter 必须由调用方预存 —— 这里如果用 Math.random()，
 * 每帧都会重新随机，星尘会逐帧乱跳（这个坑踩过）。
 */
export function dustPoint(angle, radius, thickness = 0.5, yJitter = 0) {
  const x = Math.cos(angle) * radius;
  const z0 = Math.sin(angle) * radius;
  const y0 = yJitter * thickness;
  // 绕 X 轴倾斜 17°
  return {
    x,
    y: y0 * Math.cos(DUST_TILT) - z0 * Math.sin(DUST_TILT),
    z: y0 * Math.sin(DUST_TILT) + z0 * Math.cos(DUST_TILT),
  };
}

// ---------------------------------------------------------------- 文字

/** 逐字书写：每字母延迟 62ms，时长 460ms */
export const TEXT_LETTER_DELAY = 0.062;
export const TEXT_LETTER_DURATION = 0.46;

export function letterProgress(t, index, start = 6.35) {
  const local = t - start - index * TEXT_LETTER_DELAY;
  return clamp01(local / TEXT_LETTER_DURATION);
}
