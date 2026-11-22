/**
 * 爱心「丝带分流」消散：纯数学，不碰 three.js，能 node 单测。
 *
 * 四拍（总 3.2s）：
 *   0.00–0.35  蓄力：整体内收 3%，边缘先失亮
 *   0.35–1.10  起丝：按轮廓角度分组错峰出发，带切向分量 → 拉出股
 *   1.10–2.20  分流：丝带拉长拉细，上飘 + 外扩 + 正弦摆动（摆幅随距离长）
 *   2.20–3.20  化尘：缩小、变暗、暖橙 → 暗褐，8% 余烬闪烁
 *
 * 关键：起点不是同一帧。每颗粒子有 groupDelay = group * 0.06s，
 * 所以看到的是「从一侧开始抽丝，慢慢传过去」，而不是整体膨胀。
 */

const TAU = Math.PI * 2;

export const HEART_DISSOLVE = Object.freeze({
  total: 3.2,
  startAt: 0.35,       // 起丝的时刻（此前只有内收和变暗）
  travel: 1.7,         // 单颗粒子走完全程的时长（太快会糊，太慢轮廓留太久）
  groups: 14,          // 轮廓相位分组数（12~16）
  strands: 4,          // 合并成几股丝带（3~4）
  stagger: 0.06,       // 每组错峰（秒）
  maxSpread: 0.55,     // 位移上限（相对画面短边的一半，避免铺满屏）
  radialWeight: 0.70,     // 保留：径向分量（在极坐标里表现为 r 的增长）
  upWeight: 0.50,         // 上飘
  tangentWeight: 0.35,    // 切向分量（螺旋）
  jitterWeight: 0.20,
  expand: 1.9,            // 保留（丝带外端半径倍数）
  swirl: 1.5,             // 丝带沿程旋转（弧度，越大越卷）
  spreadGain: 0.30,
  slide: 1.05,            // 粒子沿丝带滑动的距离（1 = 走完整条）
  armGap: 0.55,           // 每股只占自己扇区的一部分 → 股与股之间留空，才数得出来
  armJitter: 0.05,        // 沿丝带方向的抖动，打散「同速成团」
  swayAmp: 0.16,       // 横向摆动幅值（随距离增长）
  swayFreq: 0.6,
  turbAmp: 0.10,       // 湍流幅值
  turbFreq: 0.6,
  emberRatio: 0.08,
  contract: 0.03,      // 蓄力内收 3%
});

export function easeOutCubic(x) {
  const t = Math.min(1, Math.max(0, x));
  const y = 1 - t;
  return 1 - y * y * y;
}

export function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** 边缘粒子：0.35s 内先降到 0.55 */
export function edgeAlpha(t) {
  if (t <= 0) return 1;
  if (t < 0.35) return 1 - 0.45 * (t / 0.35);
  if (t < 1.8) return 0.55 - 0.37 * ((t - 0.35) / 1.45);
  if (t < 3.0) return 0.18 * (1 - (t - 1.8) / 1.2);
  return 0;
}

/** 中心粒子：0.35s 前保持全亮，之后跟着走 */
export function centerAlpha(t) {
  if (t <= 0.35) return 1;
  if (t < 1.8) return 1 - 0.82 * ((t - 0.35) / 1.45);
  if (t < 3.0) return 0.18 * (1 - (t - 1.8) / 1.2);
  return 0;
}

/** 单颗粒子的透明度：边缘先暗、中心留住轮廓 */
export function dissolveAlpha(edge, t) {
  const e = Math.min(1, Math.max(0, edge));
  return edgeAlpha(t) * e + centerAlpha(t) * (1 - e);
}

/** 尺寸 1.0 → 0.45（2.2s 之后才开始明显变小） */
export function dissolveSize(t) {
  if (t < 1.1) return 1;
  if (t < 2.6) return 1 - 0.55 * ((t - 1.1) / 1.5);
  return 0.45;
}

/** 暖橙 → 暗褐 的进度 */
export function dissolveDarken(t) {
  return smoothstep((t - 1.8) / 1.2);
}

/**
 * 把「爱心平面」上的坐标 (u,v) 转成消散用的状态。
 *
 * @param {number} n 粒子数
 * @param {Float32Array} u 平面 x（世界单位，相对爱心中心）
 * @param {Float32Array} v 平面 y（向上为正）
 * @param {number} maxR 爱心最大半径（算 edge 用）
 * @param {() => number} rng
 */
export function createHeartDissolve(n, u, v, maxR, rng = Math.random) {
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);
  const radius = new Float32Array(n);
  const delay = new Float32Array(n);
  const speed = new Float32Array(n);
  const edge = new Float32Array(n);
  const jitterX = new Float32Array(n);
  const jitterY = new Float32Array(n);
  const ember = new Uint8Array(n);
  const phase = new Float32Array(n);
  const group = new Uint8Array(n);
  const strand = new Uint8Array(n);
  const strandMid = new Float32Array(n);
  const s0 = new Float32Array(n);
  const a0 = new Float32Array(n);
  const strandSpin = new Float32Array(n);

  const R = Math.max(maxR, 1e-4);

  for (let i = 0; i < n; i++) {
    // 轮廓相位：atan2 得到角度，再切成 groups 组
    const ang = Math.atan2(v[i], u[i]);
    a0[i] = ang;
    const g = Math.min(HEART_DISSOLVE.groups - 1, Math.floor(((ang + Math.PI) / TAU) * HEART_DISSOLVE.groups));
    group[i] = g;
    delay[i] = g * HEART_DISSOLVE.stagger;

    // 丝带分组：把整圈按角度切成 strands 段，每股共用一个「束中心方向」，
    // 否则每颗粒子各走各的径向，看起来是一圈均匀的雾，不是几股丝带。
    const st = Math.min(HEART_DISSOLVE.strands - 1, Math.floor(((ang + Math.PI) / TAU) * HEART_DISSOLVE.strands));
    strand[i] = st;
    strandMid[i] = -Math.PI + ((st + 0.5) / HEART_DISSOLVE.strands) * TAU;
    strandSpin[i] = st % 2 === 0 ? 1 : -1;
    // 在这一股里的位置（0=弧一端的起点，1=另一端）
    const seg = TAU / HEART_DISSOLVE.strands;
    const rel = (ang - (strandMid[i] - seg / 2) + TAU) % TAU;
    s0[i] = Math.min(0.999, rel / seg);

    const seed = rng();
    // 速度分层：快的先走成丝头，慢的拖在后面
    speed[i] = 0.22 + 0.78 * seed * seed;

    ux[i] = u[i];
    uy[i] = v[i];
    radius[i] = Math.hypot(u[i], v[i]);
    // 半径 0..1：越靠外，越早失亮
    edge[i] = Math.min(1, radius[i] / R);

    jitterX[i] = (rng() * 2 - 1) * 0.5;
    jitterY[i] = (rng() * 2 - 1) * 0.5;
    ember[i] = rng() < HEART_DISSOLVE.emberRatio ? 1 : 0;
    phase[i] = rng() * TAU;
  }

  return {
    n, u: ux, v: uy, radius, delay, speed, edge,
    jitterX, jitterY, ember, phase, group, strand, strandMid, strandSpin, s0, a0, maxR: R,
  };
}

/**
 * 求某颗粒子在时刻 t 的平面位移（不含收缩，收缩由调用方乘在基础坐标上）。
 * 返回写进 out[0]=dx, out[1]=dy, out[2]=dz。
 */
export function dissolveOffset(st, i, t, out, cfg = HEART_DISSOLVE) {
  const t0 = cfg.startAt + st.delay[i];
  const local = Math.max(0, t - t0);
  const prog = easeOutCubic(local / cfg.travel);
  const adv = prog * st.speed[i];          // 0..1，慢的粒子 adv 小

  // 沿丝带滑动：s 从 0.15 一路走到 1（不同速度 → 前后拉开，形成长度差）
  const slide = Math.min(1.15, st.s0[i] * 0.8 + 0.15 + adv * cfg.slide);

  // 丝带：绕中心卷起来的螺旋臂
  const seg = TAU / HEART_DISSOLVE.strands;
  const spreadA = seg * cfg.armGap;                       // 这一股实际张开的角
  const jitterS = (st.jitterX[i] * 0.5 + 0.5) * cfg.armJitter;
  const slide2 = Math.min(1.2, slide + jitterS);
  const ang = st.strandMid[i] + (st.s0[i] - 0.5) * spreadA + st.strandSpin[i] * cfg.swirl * slide2;
  const rOut = st.maxR * (1 + cfg.expand * 0.35);
  const r = st.maxR * 0.2 + (rOut - st.maxR * 0.2) * slide2;

  const curveX = Math.cos(ang) * r;
  const curveY = Math.sin(ang) * r * 0.96;

  // 从爱心原位过渡到丝带（越快的越早上丝带）
  const b = smoothstep(Math.min(1, adv * 1.55));
  const baseX = st.u[i];
  const baseY = st.v[i];

  // 摆动 + 湍流（随 adv 增长，丝带才有丝绸感）
  const sway = Math.sin(TAU * cfg.swayFreq * t + st.phase[i]) * cfg.swayAmp * cfg.maxSpread * adv;
  const turb = cfg.turbAmp * cfg.maxSpread * adv;
  const turbX = Math.sin(TAU * cfg.turbFreq * t + st.phase[i] * 1.7) * turb;
  const turbY = Math.cos(TAU * cfg.turbFreq * t * 0.9 + st.phase[i] * 2.3) * turb;

  const upDrift = cfg.upWeight * st.maxR * 0.9 * adv;

  const x = baseX + (curveX - baseX) * b - Math.sin(ang) * sway + turbX;
  const y = baseY + (curveY - baseY) * b + upDrift + Math.cos(ang) * sway + turbY;

  out[0] = x - st.u[i];
  out[1] = y - st.v[i];
  out[2] = adv * 0.8;
  return out;
}
