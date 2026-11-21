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

/**
 * 星尘盘倾斜角（弧度）。
 *
 * 盘面平躺在 y≈0 时，相机几乎和盘面等高，投影出来是一条横贯屏幕的"煎饼"。
 * 26° 对应画面上椭圆短/长轴 ≈ 0.44（sin 26°），和参考画面一致。
 */
export const DUST_TILT = (26 * Math.PI) / 180;

/**
 * 按画幅选倾斜角：让投影出来的椭圆「短/长轴」稳定在 0.33 左右。
 *
 * 同样是 26° 的盘，竖屏手机上会被压成 0.2 的扁椭圆（因为 NDC 横向要除以 aspect），
 * 所以窄屏要看得更"俯"一点、宽屏可以接近躺平。0.33 取自参考画面的实测值。
 */
export function dustTiltFor(aspect, { ratio = 0.33, minDeg = 18, maxDeg = 45 } = {}) {
  const s = Math.min(Math.max(ratio / Math.max(aspect, 1e-3), 1e-3), 1);
  const deg = (Math.asin(s) * 180) / Math.PI;
  const clamped = Math.min(Math.max(deg, minDeg), maxDeg);
  return (clamped * Math.PI) / 180;
}

/**
 * 盘上一点 → 世界坐标：先绕 Y 自转（x/z），再绕 X 倾斜。
 * 顺序不能反：先倾斜再自转，盘子会像陀螺一样左右晃。
 */
export function tiltDisc(x, y0, z, tilt = DUST_TILT) {
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return { x, y: y0 * ct - z * st, z: y0 * st + z * ct };
}

/** 星尘盘转速：随进度平方加快 */
export function dustSpin(p, base = 0.6) {
  const e = clamp01(p);
  return base + 2.6 * e * e;
}

/**
 * 盘面在 NDC 里占多大（采样一圈，取最外侧）。
 *
 * 单看横向不够：近侧的盘边离镜头最近，透视会把它甩到画面下方，
 * 之前环"看着大得离谱"就是这个原因 —— 横向和纵向都得算。
 */
export function dustRingExtent(radius, cam, {
  tilt = DUST_TILT,
  thickness = 0,
  samples = 96,
} = {}) {
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const { distance, targetY, tanV, aspect } = cam;

  let maxX = 0;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z0 = Math.sin(a) * radius;

    for (const y0 of thickness > 0 ? [thickness, -thickness] : [0]) {
      const y = y0 * ct - z0 * st;
      const z = y0 * st + z0 * ct;
      const dz = distance - z;
      if (dz <= 1e-3) {          // 越到镜头后面了，算越界
        maxX = Infinity;
        minY = -Infinity;
        continue;
      }
      const ndcX = x / (dz * tanV * aspect);
      const ndcY = (y - targetY) / (dz * tanV);
      if (Math.abs(ndcX) > maxX) maxX = Math.abs(ndcX);
      if (ndcY < minY) minY = ndcY;
      if (ndcY > maxY) maxY = ndcY;
    }
  }
  return { maxX, minY, maxY };
}

/**
 * 反算「整圈都留在画面里」的星尘盘半径。
 *
 * 为什么不在 config 里写死半径：同一个世界半径，横屏笔记本上只占半屏，
 * 竖屏手机上会超出 4.5 倍。按画幅反算才能两头都好看。
 *
 * @returns 满足 margin 的最大半径（世界单位）；cap 用来防止横屏时环过大。
 */
export function fitDustRadius(cam, {
  tilt = DUST_TILT,
  thickness = 0,
  marginX = 0.92,
  marginTop = 0.9,
  marginBottom = 0.96,
  cap = Infinity,
} = {}) {
  const fits = (r) => {
    const e = dustRingExtent(r, cam, { tilt, thickness });
    if (!Number.isFinite(e.maxX)) return false;
    return e.maxX <= marginX && e.maxY <= marginTop && e.minY >= -marginBottom;
  };

  const hardCap = Math.min(cap, cam.distance * 0.92);
  if (fits(hardCap)) return hardCap;

  // 越界程度随半径单调上升，二分找边界
  let lo = 0;
  let hi = hardCap;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- 文字

/** 逐字书写：每字母延迟 62ms，时长 460ms */
export const TEXT_LETTER_DELAY = 0.062;
export const TEXT_LETTER_DURATION = 0.46;

export function letterProgress(t, index, start = 6.35) {
  const local = t - start - index * TEXT_LETTER_DELAY;
  return clamp01(local / TEXT_LETTER_DURATION);
}
