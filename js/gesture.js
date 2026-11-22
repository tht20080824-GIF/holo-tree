/**
 * 手势层：把 MediaPipe 的 21 个手部关键点，翻译成几个"物理量"。
 *
 * 这一层刻意不碰 DOM、不碰 three.js，只做纯计算，所以能被 node 单测覆盖。
 *
 * 输出的量：
 *   x / y     手掌中心（镜像后）在画面里的位置，0~1
 *   scale     手掌尺度 = 手腕→中指根的距离，当"离镜头远近"的代理量
 *   pinchRatio 拇指尖↔食指尖 距离 / 手掌尺度，捏合 ≈ 0.1~0.3，张开 ≈ 1.5+
 *   openness  五指尖到手腕的平均距离 / 手掌尺度，张开 ≈ 2.2+，握拳 ≈ 1.0
 *
 * 用"比值"而不是绝对像素距离，是因为手离镜头远近会整体缩放所有距离，
 * 比值对距离不敏感，人往后退一点也不会突然失灵。
 */

export const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
};

const FINGER_TIPS = [8, 12, 16, 20];
const FINGERS = [
  [5, 6, 8],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, 20],
];

export const GESTURE = Object.freeze({
  NONE: 'NONE',
  HOVER: 'HOVER',
  PINCH: 'PINCH',
  OPEN: 'OPEN',
  FIST: 'FIST',
});

export const MODE = Object.freeze({ TREE: 'TREE', SCATTER: 'SCATTER', TEXT: 'TEXT' });

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * @param {Array<{x:number,y:number,z:number}>} lm 21 个归一化关键点
 * @returns {null | {present:boolean,x:number,y:number,scale:number,pinchRatio:number,openness:number,extended:boolean[],landmarks:Array}}
 */
export function measureHand(lm) {
  if (!lm || lm.length < 21) return null;

  const wrist = lm[LANDMARK.WRIST];
  const middleMcp = lm[LANDMARK.MIDDLE_MCP];

  // 手掌尺度做分母，最小 1e-4 防除零（关键点重合时会出现）
  const scale = Math.max(dist2d(wrist, middleMcp), 1e-4);

  const pinchRatio = dist2d(lm[LANDMARK.THUMB_TIP], lm[LANDMARK.INDEX_TIP]) / scale;

  let tipSum = 0;
  for (const tip of FINGER_TIPS) tipSum += dist2d(lm[tip], wrist);
  const openness = tipSum / FINGER_TIPS.length / scale;

  // 单指是否伸直：指尖离手腕明显比第二关节远
  const extended = FINGERS.map(([, pip, tip]) => dist2d(lm[tip], wrist) > dist2d(lm[pip], wrist) * 1.12);

  return {
    present: true,
    // 摄像头画面是镜像显示的，手往屏幕右边移应该让 x 变大
    x: 1 - middleMcp.x,
    y: middleMcp.y,
    scale,
    pinchRatio,
    openness,
    extended,
    landmarks: lm,
  };
}

/**
 * 手势识别器：负责滞回（hysteresis）和"保持一段时间才生效"的去抖。
 *
 * 为什么要去抖：张开手掌和握拳的张开度阈值挨得很近，单帧误判会让树
 * 在"合拢/散开"之间疯狂横跳，非常毁体验。所以要求姿势稳定 holdTime 秒。
 */
export class GestureRecognizer {
  constructor(settings, { holdTime } = {}) {
    this.cfg = settings;
    this.holdTime = holdTime ?? settings.holdTime ?? 0.32;

    this.pinched = false;
    this.mode = MODE.TREE;
    this._pose = null;       // 当前正在累计时长的姿势候选
    this._poseTime = 0;
    this._lastGesture = GESTURE.NONE;
  }

  /** 没有手的时候调用，清掉瞬时状态（但保留 mode 和捏合锁存） */
  reset() {
    this._pose = null;
    this._poseTime = 0;
    this._lastGesture = GESTURE.NONE;
  }

  /**
   * @param {object|null} m measureHand() 的结果
   * @param {number} dt 距上一次调用的秒数
   * @returns {{present:boolean,hand:object|null,gesture:string,mode:string,modeChanged:null|string,pinched:boolean,openness:number,pinchRatio:number}}
   */
  update(m, dt) {
    const modeChanged = null;

    if (!m) {
      this.reset();
      return {
        present: false,
        hand: null,
        gesture: GESTURE.NONE,
        mode: this.mode,
        modeChanged,
        pinched: false,
        openness: 0,
        pinchRatio: 0,
      };
    }

    // --- 捏合：双阈值滞回，避免在临界值上闪烁 ---
    if (this.pinched) {
      if (m.pinchRatio > this.cfg.pinchOff) this.pinched = false;
    } else if (m.pinchRatio < this.cfg.pinchOn) {
      this.pinched = true;
    }

    // --- 张开 / 握拳：同一时刻只累计一个候选 ---
    let pose = null;
    if (m.openness > this.cfg.openOn) pose = GESTURE.OPEN;
    else if (m.openness < this.cfg.fistOn) pose = GESTURE.FIST;

    let changed = null;
    if (pose !== this._pose) {
      this._pose = pose;
      this._poseTime = 0;
    }
    if (pose) {
      this._poseTime += dt;
      if (this._poseTime >= this.holdTime) {
        const nextMode = pose === GESTURE.OPEN ? MODE.SCATTER : MODE.TREE;
        if (nextMode !== this.mode) {
          this.mode = nextMode;
          changed = nextMode;
        }
        // 已经生效的姿势不再重复累计，避免长时间保持时反复触发
        this._poseTime = 0;
      }
    }

    // 捏合优先级最高（瞬时动作，不需要保持）
    let gesture = GESTURE.HOVER;
    if (this.pinched) gesture = GESTURE.PINCH;
    else if (pose === GESTURE.OPEN) gesture = GESTURE.OPEN;
    else if (pose === GESTURE.FIST) gesture = GESTURE.FIST;

    this._lastGesture = gesture;

    return {
      present: true,
      hand: m,
      gesture,
      mode: this.mode,
      modeChanged: changed,
      pinched: this.pinched,
      openness: m.openness,
      pinchRatio: m.pinchRatio,
    };
  }
}


/**
 * 手势序列判定：例如 1 → 2 → 3 → 5（五指张开）触发一次动作。
 * 每一步要稳定 holdMs 才认；整体超过 resetMs 没接上就重来。
 */
export class MorphSequence {
  constructor(seq = [1, 2, 3, 5], { holdMs = 130, resetMs = 4000, cooldownMs = 1500 } = {}) {
    this.seq = seq;
    this.holdMs = holdMs;
    this.resetMs = resetMs;
    this.cooldownMs = cooldownMs;
    this.step = 0;
    this.cand = -1;
    this.candAt = 0;
    this.stable = -1;
    this.stepAt = 0;
    this.cooldownUntil = 0;
  }

  /** @returns {boolean} true = 序列完成，应该触发动作 */
  update(count, now) {
    if (count == null || count < 0) return false;
    if (now < this.cooldownUntil) return false;

    if (count !== this.cand) {
      this.cand = count;
      this.candAt = now;
      return false;
    }
    if (now - this.candAt < this.holdMs) return false;
    if (count === this.stable) return false;
    this.stable = count;

    if (count === 0) return false;
    if (now - this.stepAt > this.resetMs) this.step = 0;

    if (count === this.seq[this.step]) {
      this.step++;
      this.stepAt = now;
      if (this.step === this.seq.length) {
        this.step = 0;
        this.stable = -1;
        this.cand = -1;
        this.cooldownUntil = now + this.cooldownMs;
        return true;
      }
    } else {
      this.step = count === this.seq[0] ? 1 : 0;
      this.stepAt = now;
    }
    return false;
  }
}
