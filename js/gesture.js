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

/**
 * 主动意图：把「手在动」翻译成明确的动作，而不是只吃左右位置。
 *
 * 之前只有「手停在左边/右边 → 一直转」，手划一下跟手停住没区别，
 * 用户会觉得"我明明甩了一下，它却没反应"。这里额外识别两类动作：
 *   - 划动：短时间内的直线位移（横划转身、竖划抬头）
 *   - 推拉：手掌尺度的快速变化（推向镜头 = 靠近，拉远 = 后退）
 */
export const INTENT = Object.freeze({
  NONE: 'NONE',
  SWIPE_LEFT: 'SWIPE_LEFT',
  SWIPE_RIGHT: 'SWIPE_RIGHT',
  SWIPE_UP: 'SWIPE_UP',
  SWIPE_DOWN: 'SWIPE_DOWN',
  PUSH: 'PUSH',   // 手推向镜头（画面里手变大）→ 应该靠近
  PULL: 'PULL',   // 手拉远（画面里手变小）→ 应该后退
});

/**
 * 意图识别器：纯计算，能吃单测。
 *
 * 判据刻意写得"严格一点"：位移够长、速度够快、路径够直，三者同时满足才算划动。
 * 只满足一个的话，手在画面里随便晃两下就会误触发，比不灵敏更难受。
 */
export class GestureIntent {
  constructor(cfg = {}) {
    this.cfg = {
      windowMs: 280,
      minSpanMs: 110,
      swipeDist: 0.2,
      swipeSpeed: 0.85,
      straightness: 0.72,
      swipeCooldownMs: 300,
      pushScale: 0.26,
      pushCooldownMs: 550,
      ...cfg,
    };
    this._buf = [];
    this._lastAt = new Map();
  }

  reset() {
    this._buf.length = 0;
  }

  _cooldownMs(intent) {
    return intent === INTENT.PUSH || intent === INTENT.PULL
      ? this.cfg.pushCooldownMs
      : this.cfg.swipeCooldownMs;
  }

  _ready(intent, now) {
    const last = this._lastAt.has(intent) ? this._lastAt.get(intent) : -Infinity;
    return now - last >= this._cooldownMs(intent);
  }

  /** 触发后清空轨迹：同一段挥动不能连续触发两次 */
  _fire(intent, now, strength) {
    this._lastAt.set(intent, now);
    this._buf.length = 0;
    return { intent, strength, at: now };
  }

  /**
   * @param {object|null} hand measureHand() 的结果
   * @param {number} now 毫秒
   * @returns {{intent:string, strength:number}}
   */
  update(hand, now) {
    const none = { intent: INTENT.NONE, strength: 0 };
    if (!hand) {
      this.reset();
      return none;
    }

    const c = this.cfg;
    const b = this._buf;
    b.push({ t: now, x: hand.x, y: hand.y, s: hand.scale });
    while (b.length > 1 && now - b[0].t > c.windowMs) b.shift();

    const first = b[0];
    const last = b[b.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs < c.minSpanMs) return none;
    const span = spanMs / 1000;

    // 实际路径长度：位移/路径 = 直线度，画圈时这个值会很低
    let path = 0;
    for (let i = 1; i < b.length; i++) {
      path += Math.hypot(b[i].x - b[i - 1].x, b[i].y - b[i - 1].y);
    }

    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const dist = Math.hypot(dx, dy);
    const speed = dist / span;
    const straight = path > 1e-6 ? dist / path : 0;

    // 1) 划动优先（比推拉更"有意图"）
    if (dist >= c.swipeDist && speed >= c.swipeSpeed && straight >= c.straightness) {
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      let intent;
      if (horizontal) intent = dx > 0 ? INTENT.SWIPE_RIGHT : INTENT.SWIPE_LEFT;
      else intent = dy > 0 ? INTENT.SWIPE_DOWN : INTENT.SWIPE_UP;

      if (this._ready(intent, now)) {
        return this._fire(intent, now, Math.min(1, dist / (c.swipeDist * 2)));
      }
      return none;
    }

    // 2) 推拉：手掌尺度的相对变化
    const ds = (last.s - first.s) / Math.max(first.s, 1e-4);
    if (Math.abs(ds) >= c.pushScale) {
      const intent = ds > 0 ? INTENT.PUSH : INTENT.PULL;
      if (this._ready(intent, now)) {
        return this._fire(intent, now, Math.min(1, Math.abs(ds) / (c.pushScale * 2)));
      }
    }

    return none;
  }
}

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

  /** 作废当前进度（比如这一下「1」被判成爱心了，不能再算序列第一步） */
  reset() {
    this.step = 0;
    this.cand = -1;
    this.stable = -1;
    this.candAt = 0;
    this.stepAt = 0;
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


/**
 * 「1 → 爱心」和「1→2→3→5 → 文字」的仲裁。
 *
 * 矛盾点：单独一个「1」既是爱心的手势，也是文字序列的第一步。光看一帧分不出来，
 * 所以用「时间」来分辨用户的意图：
 *   - 手指 1 立起来之后**很快**变成 2 → 他在走序列，继续等后面的 3、5；
 *   - 手指 1 **停住不动**超过 heartHoldMs → 他就是想变爱心，直接抢过来。
 *
 * 抢过来之后会把序列作废，避免同一个「1」又被记成序列第一步。
 */
export class GestureRouter {
  constructor(seq = [1, 2, 3, 5], {
    heartHoldMs = 800,
    heartCooldownMs = 1600,
    zodiacHoldMs = 800,
    zodiacCooldownMs = 1800,
    ...seqOpts
  } = {}) {
    this.seq = new MorphSequence(seq, seqOpts);
    this.heartHoldMs = heartHoldMs;
    this.heartCooldownMs = heartCooldownMs;
    this.zodiacHoldMs = zodiacHoldMs;
    this.zodiacCooldownMs = zodiacCooldownMs;
    this._oneSince = 0;
    this._heartUntil = 0;
    this._twoSince = 0;
    this._zodiacUntil = 0;
    this._armed = true;     // 一次「按住」只触发一次，松开手指才重新装填
    this._twoArmed = true;
  }

  /**
   * @param {number} count 当前手指数量（0~5，-1 = 没有手）
   * @param {number} now 毫秒
   * @returns {'none'|'text'|'heart'|'zodiac'}
   */
  update(count, now) {
    if (count == null || count < 0) {
      this._oneSince = 0;
      return 'none';
    }

    if (count === 1) {
      if (!this._oneSince) this._oneSince = now;
    } else {
      this._oneSince = 0;
      this._armed = true;      // 手指放下来了，下次再比 1 才能再触发
    }

    if (count === 2) {
      if (!this._twoSince) this._twoSince = now;
    } else {
      this._twoSince = 0;
      this._twoArmed = true;
    }

    // 序列先跑：1 之后如果接上了 2，就把「爱心」的可能排掉
    if (this.seq.update(count, now)) {
      this._oneSince = 0;
      return 'text';
    }

    // 只比「2」并停住 → 生肖（但 1→2 已经在走序列时不算）
    const heldTwo = count === 2 && this._twoSince && now - this._twoSince >= this.zodiacHoldMs;
    if (heldTwo && this._twoArmed && this.seq.step === 0 && now >= this._zodiacUntil) {
      this._zodiacUntil = now + this.zodiacCooldownMs;
      this._twoArmed = false;
      this._twoSince = now;
      return 'zodiac';
    }

    const heldOne = count === 1 && this._oneSince && now - this._oneSince >= this.heartHoldMs;
    if (heldOne && this._armed && now >= this._heartUntil) {
      this._armed = false;
      this._heartUntil = now + this.heartCooldownMs;
      this.seq.reset();          // 这个 1 算爱心，不算序列第一步
      this._oneSince = now;
      return 'heart';
    }

    return 'none';
  }
}
