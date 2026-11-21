/**
 * 全部可调参数集中在这里。
 * 想改手感（转到多少度、缩放多狠、多快跟上手）只改这个文件，不用碰逻辑。
 */
export const CONFIG = {
  palette: {
    bg: 0x04070c,
    green: [0x1e8a56, 0x2fbf72, 0x0e6440],
    gold: [0xffd27a, 0xffb547, 0xfff3c9],
    red: [0xff3b5c, 0xd6233f, 0xff6f83],
    snow: 0xbfe3ff,
  },

  particles: {
    count: 1600,      // 树身粒子数；低于 900 会稀疏，高于 2400 老机器掉帧
    height: 24,       // 树高
    radius: 9,        // 底部半径
    floorY: -12,      // 树底 y
  },

  camera: {
    fov: 44,
    baseDistance: 40, // 1.0 缩放系数时相机到原点的距离（树高 24 时刚好留出边距）
    minDistance: 12,
    maxDistance: 46,
  },

  rig: {
    yawRange: 1.15,        // 兼容旧逻辑保留，用于手部像素映射的上限
    pitchRange: 0.3,       // 上下最大仰角 ≈ 17°
    deadzone: 0.08,        // 画面中心死区（0~1）
    follow: 5.5,           // 跟随刚度，越大越跟手越容易抖

    // --- 判向持续旋转（新交互） ---
    steerEnter: 0.30,      // 手的横向偏移超过它 → 判定为「往这个方向转」（越低越果断）
    steerHold: 0.06,       // 方向要保持多久才生效（秒）；手甩得快时会被速度直接抢判，不等这个时间
    steerSpeed: 0.62,      // 基础持续转速（弧度/秒 ≈ 35°/s）
    steerBoost: 0.9,       // 手速带来的额外倍率上限：最快 ≈ 1.9 倍速
    steerRefSpeed: 1.4,    // 达到满加成所需的手速（画面宽度/秒）
    steerKickSpeed: 1.2,   // 横向手速超过它，方向立刻生效，不等 steerHold
    centerStop: 0.18,      // 手回到中心 ±18% 内持续 centerStopTime 秒 → 停止转向
    centerStopTime: 0.8,

    idleYawSpeed: 0.208,   // 自然自转：原来 0.16，按需求 ×1.3
    idleDelay: 0.6,        // 手离开后多久回落到自然自转（秒）
    zoomNear: 0.62,        // 手离镜头最近时的距离系数（越小越近）
    zoomFar: 1.42,         // 手离镜头最远时的距离系数
    handScaleNear: 0.2,    // 视为“手离镜头最近”的手掌尺度（归一化坐标）
    handScaleFar: 0.09,    // 视为“手离镜头最远”的手掌尺度
    pointerYaw: 0.006,     // 鼠标拖拽灵敏度（弧度/像素）
    pointerPitch: 0.004,
    wheelZoom: 0.0009,     // 滚轮缩放灵敏度
  },

  gesture: {
    pinchOn: 0.35,     // 拇指-食指距离 / 手掌尺度，小于它=捏合
    pinchOff: 0.55,    // 大于它=松开（滞回，防抖）
    openOn: 1.6,       // 五指张开度大于它=张开手掌（真手张开约 2.0）
    fistOn: 1.15,      // 张开度小于它=握拳（真手握拳约 0.9）
    holdTime: 0.3,     // 手势保持多久才切换形态（秒），防止误触
  },

  photos: {
    max: 12,           // 最多放几张照片
    defaultCount: 6,   // 没上传时用程序生成的装饰品
  },

  quality: {
    maxPixelRatio: 2,  // 高分屏别无限放大，费性能
    bloom: { strength: 0.75, radius: 0.6, threshold: 0.35 },
    snowCount: 700,
  },
};
