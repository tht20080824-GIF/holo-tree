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
    follow: 7.0,           // 跟随刚度，越大越跟手越容易抖

    // --- 判向持续旋转（新交互） ---
    steerEnter: 0.20,      // 手的横向偏移超过它 → 判定为「往这个方向转」（越低越果断）
    steerHold: 0.03,       // 方向要保持多久才生效（秒）；手甩得快时会被速度直接抢判，不等这个时间
    steerSpeed: 0.85,      // 基础持续转速（弧度/秒 ≈ 49°/s）
    steerMinMul: 0.55,     // 刚过门限时的转速系数（手越靠边越接近 1）
    steerBoost: 1.1,       // 手速带来的额外倍率上限：最快 ≈ 2.1 倍速
    steerRefSpeed: 1.1,    // 达到满加成所需的手速（画面宽度/秒）
    steerKickSpeed: 0.9,   // 横向手速超过它，方向立刻生效，不等 steerHold
    centerStop: 0.26,      // 手回到中心 ±26% 内持续 centerStopTime 秒 → 停止转向
    centerStopTime: 0.45,

    // --- 甩手冲量：手快速划一下，直接给一个明显的角度，不用等转速积累 ---
    flickYaw: 0.5,         // 一次横划给的角度（弧度 ≈ 29°）
    flickPitch: 0.16,      // 一次竖划给的俯仰（弧度 ≈ 9°）
    flickZoom: 0.16,       // 一次推/拉给的距离系数变化

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
    openOn: 1.45,      // 五指张开度大于它=张开手掌（真手约 2.0；1.6 时手机远景常常够不到）
    fistOn: 1.15,      // 张开度小于它=握拳（真手握拳约 0.9）
    holdTime: 0.3,     // 手势保持多久才切换形态（秒），防止误触
  },

  // 主动识别：把「手在动」翻译成明确意图（划动 / 推拉），而不是只吃左右位置
  intent: {
    windowMs: 280,        // 看最近多久的手部轨迹
    minSpanMs: 110,       // 轨迹至少要有这么长的时间跨度
    swipeDist: 0.20,      // 划动位移（画面宽度比例）超过它才算「划了一下」
    swipeSpeed: 0.85,     // 划动速度（画面宽度/秒）下限，防止慢慢挪也触发
    straightness: 0.72,   // 位移 / 实际路径，越小越弯；太弯不算划动（防画圈误触）
    swipeCooldownMs: 300, // 两次划动之间至少隔这么久
    pushScale: 0.26,      // 手掌尺度相对变化超过 26% → 推/拉
    pushCooldownMs: 550,  // 推拉的冷却
  },


  // 收尾漩涡：从画面下方转上来，不是一下出现
  vortex: {
    count: 2600,       // 桌面粒子数；手机上 main.js 降到 1400
    duration: 1.6,
    rise: 14,
    height: 26,
    radius: 9.5,
    turns: 2.4,
    delay: 0.45,
    fadeIn: 0.18,
  },

  intro: {
    enabled: true,
    count: 17000,          // 桌面粒子数；手机上 main.js 会降到 9000
    loop: false,           // 播完进入交互模式；设 true 会一直循环
    startDelay: 15,        // 等摄像头授权结果再开第一帧，最多等这么久（秒）
    bloom: { strength: 0.92, radius: 0.7, threshold: 0.3 },
    mobileBloom: { strength: 0.74, radius: 0.7, threshold: 0.3 },
  },

  ribbon: {
    count: 9000,          // 规格 8000~12000；手机上会在 main.js 里降到 5000
    colorA: 0xa8e6ff,     // 冰蓝（想跟主体融合可换成 0xffd9a0 香槟金）
    colorB: 0xffffff,     // 过渡到白
  },

  ornaments: {
    gifts: 5,             // 礼盒个数
    bows: 3,              // 蝴蝶结个数（多了会显得廉价）
    giftSize: 0.85,       // 单位：世界坐标，树高 24
    bowSize: 1.9,         // 蝴蝶结更大，远看也认得出
    bowClearance: 1.32,   // 挂得比树身更靠外
    density: 1,           // 粒子密度系数，手机端会调低
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
