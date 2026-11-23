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
  // ---- 手掌坐标系：用掌面法向 + 掌心朝前方向判「伸直」----
  // 2D 距离比在手机远景下会被手部朝向骗到（侧对镜头时伸直的手指看着很近），
  // 换成 3D 的手掌坐标系后就与镜头角度无关了。
  const P = (i) => lm[i] || { x: 0, y: 0, z: 0 };
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const len = (v) => Math.hypot(v.x, v.y, v.z) || 1e-6;
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const norm = (v) => { const l = len(v); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });

  // forward：掌心朝向（手腕 → 中指根）；normal：掌面法向（食指根 × 小指根）
  const forward = norm(sub(P(9), P(0)));

  const extended = FINGERS.map(([mcp, pip, tip]) => {
    const a = P(mcp);
    const b = P(pip);
    const c = P(tip);

    // ① 3D 指节夹角（伸直 ≈ 180°，蜷起 < 120°）
    const v1 = sub(a, b);
    const v2 = sub(c, b);
    const cos = dot(v1, v2) / (len(v1) * len(v2));
    const straight = cos < -0.72;

    // ② 指尖沿「掌心朝前」方向伸出多少（用指节长度归一化，与手大小无关）
    const proj = dot(sub(c, a), forward);
    const seg = len(sub(b, a));
    const along = seg > 1e-6 ? proj / seg : 0;

    // 必须「又直又伸」才认：只看距离会把蜷起的手指也算进来
    // （用户比 1，中指蜷着但指尖离手腕更远 → 被判成 2 指，就是这个坑）
    return straight && along > 0.85;
  });

  return {
    present: true,
    // 摄像头画面是镜像显示的，手往屏幕右边移应该让 x 变大
    x: 1 - middleMcp.x,
    y: middleMcp.y,
    scale,
    pinchRatio,
    openness,
    extended,
    // 直接给出「比了几根手指」：张开手掌优先按 5 根算
    fingerCount: openness > 1.6 ? 5 : extended.filter(Boolean).length,
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
  constructor(seq = [1, 2, 3, 5], {
    holdMs = 130,
    resetMs = 4000,
    cooldownMs = 1500,
    graceMs = 400,     // 手指切换时的中间态（1→2 中间闪过 3 之类）容许的宽限
  } = {}) {
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
    this.graceMs = graceMs;
    this._mismatchAt = 0;
    // 每一步允许的手指数集合：只放宽序列自己，不碰「1/2 停住」那两条判定
    // idx2 = 比 3 时无名指/小指常被判错，容忍 4；idx3 = 张开，4 根也算
    this.accept = seq.map((n, i) => {
      if (i === seq.length - 1) return new Set([n, n - 1]);
      if (i === 2 && n === 3) return new Set([3, 4]);
      return new Set([n]);
    });
  }

  /** 作废当前进度（比如这一下「1」被判成爱心了，不能再算序列第一步） */
  reset() {
    this.step = 0;
    this.cand = -1;
    this.stable = -1;
    this.candAt = 0;
    this.stepAt = 0;
    this._mismatchAt = 0;
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
    if (count === this.stable) {
      // 同一个「错误手势」一直保持：宽限到期就作废（否则上面那行会一直提前返回）
      if (this._mismatchAt && now - this._mismatchAt >= this.graceMs) {
        this._mismatchAt = 0;
        this.step = count === this.seq[0] ? 1 : 0;
        this.stepAt = now;
      }
      return false;
    }
    this.stable = count;

    if (count === 0) return false;
    if (now - this.stepAt > this.resetMs) this.step = 0;

    const ok = this.accept[this.step].has(count);
    // 跳一级也算过：手换得太快，中间那种手指整帧被漏掉（1 直接到 3）
    // 只有序列已经开跑（step>0）才允许跳级；
    // 否则单比「2」会直接跳到第 3 步，把「比 2 = 生肖」这条判定顶掉。
    const skip = !ok
      && this.step > 0
      && this.step + 1 < this.seq.length
      && this.accept[this.step + 1].has(count);
    if (ok || skip) {
      if (skip) this.step += 1;
      this._mismatchAt = 0;
      this.step++;
      this.stepAt = now;
      if (this.step === this.seq.length) {
        this.step = 0;
        this.stable = -1;
        this.cand = -1;
        this.cooldownUntil = now + this.cooldownMs;
        return true;
      }
      return false;
    }

    // 不符合预期：先给 graceMs 宽限。
    // 换手指的过程中常会短暂数错（比如 1→2 之间闪过 3），
    // 以前这种中间态会立刻把序列清零，用户看起来就是「比了没反应」。
    if (this.step > 0) {
      if (!this._mismatchAt) {
        this._mismatchAt = now;
        return false;
      }
      if (now - this._mismatchAt < this.graceMs) return false;
    }

    this._mismatchAt = 0;
    this.step = count === this.seq[0] ? 1 : 0;
    this.stepAt = now;
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
    // 「1」「2」停住触发爱心/生肖的门槛。
    // 必须明显长于「1→2→3→张开」里每一步的停留时间，否则做序列时会被爱心抢走。
    heartHoldMs = 1000,
    heartCooldownMs = 1600,
    zodiacHoldMs = 1000,
    zodiacCooldownMs = 1800,
    ...seqOpts
  } = {}) {
    this.seq = new MorphSequence(seq, seqOpts);
    this.heartHoldMs = heartHoldMs;
    this.heartCooldownMs = heartCooldownMs;
    this.zodiacHoldMs = zodiacHoldMs;
    this.zodiacCooldownMs = zodiacCooldownMs;
    this._lastChangeAt = 0; // 手指数最后变化的时间（换手指 = 正在走序列）
    this._prevCount = -1;
    this._oneSince = -1;    // -1 = 还没开始按住（0 会被当成「假值」，踩过）
    this._heartUntil = 0;
    this._twoSince = -1;
    this._zodiacUntil = 0;
    this._armed = true;     // 一次「按住」只触发一次，松开手指才重新装填
    this._twoArmed = true;
    this._suppressCount = -1;   // 刚触发爱心/生肖的那个手指数，改掉之前不再喂序列
  }

  /** 序列当前等待的手指数（0 表示序列没在跑） */
  expectedCount() {
    if (this.seq.step <= 0) return 0;
    const set = this.seq.accept[this.seq.step];
    return set ? Math.min(...set) : 0;
  }

  /**
   * 按住进度 0~1：HUD 上显示「❤️ 62%」，用户就知道还要停多久。
   * @param {number} count
   * @param {number} now
   */
  holdProgress(count, now) {
    if (count === 1 && this._oneSince >= 0 && this._armed) {
      return Math.min(1, (now - Math.max(this._oneSince, this._lastChangeAt)) / this.heartHoldMs);
    }
    if (count === 2 && this._twoSince >= 0 && this._twoArmed && this.seq.step === 0) {
      return Math.min(1, (now - Math.max(this._twoSince, this._lastChangeAt)) / this.zodiacHoldMs);
    }
    return 0;
  }

  /**
   * @param {number} count 当前手指数量（0~5，-1 = 没有手）
   * @param {number} now 毫秒
   * @returns {'none'|'text'|'heart'|'zodiac'}
   */
  update(count, now) {
    if (count == null || count < 0) {
      this._oneSince = -1;
      this._twoSince = -1;
      return 'none';
    }

    if (count === 1) {
      if (this._oneSince < 0) this._oneSince = now;
    } else {
      this._oneSince = -1;
      this._armed = true;      // 手指放下来了，下次再比 1 才能再触发
    }

    if (count === 2) {
      if (this._twoSince < 0) this._twoSince = now;
    } else {
      this._twoSince = -1;
      this._twoArmed = true;
    }

    // 手指还在变，说明用户在走 1→2→3→5，这时候不该判爱心/生肖
    if (count !== this._prevCount) {
      this._prevCount = count;
      this._lastChangeAt = now;
    }

    // 刚用「1」/「2」触发过爱心/生肖：继续比同一根手指数不再喂序列，
    // 否则一直按着 1 会把序列的第一步重新登记上，接着比 2、3、张开就误触发文字。
    if (this._suppressCount === count) {
      return 'none';
    }
    if (this._suppressCount >= 0 && count !== this._suppressCount) this._suppressCount = -1;

    // 序列先跑：1 之后如果接上了 2，就把「爱心」的可能排掉
    if (this.seq.update(count, now)) {
      this._oneSince = 0;
      return 'text';
    }

    // 只比「2」并停住 → 生肖（但 1→2 已经在走序列时不算）
    const stillTwo = now - Math.max(this._twoSince, this._lastChangeAt) >= this.zodiacHoldMs;
    const heldTwo = count === 2 && this._twoSince >= 0 && stillTwo;
    if (heldTwo && this._twoArmed && this.seq.step === 0 && now >= this._zodiacUntil) {
      this._zodiacUntil = now + this.zodiacCooldownMs;
      this._twoArmed = false;
      this._twoSince = now;
      this._suppressCount = count;
      return 'zodiac';
    }

    const stillOne = now - Math.max(this._oneSince, this._lastChangeAt) >= this.heartHoldMs;
    const heldOne = count === 1 && this._oneSince >= 0 && stillOne;
    if (heldOne && this._armed && now >= this._heartUntil) {
      this._armed = false;
      this._heartUntil = now + this.heartCooldownMs;
      this.seq.reset();          // 这个 1 算爱心，不算序列第一步
      this._oneSince = now;
      this._suppressCount = count;
      return 'heart';
    }

    return 'none';
  }
}


/**
 * 手指数的时域平滑：窗口内取众数。
 *
 * 手机远景下 MediaPipe 的关键点会逐帧抖，某根手指时伸时蜷，
 * 直接拿去喂序列会导致「1 还没站稳就跳回 0」，序列反复重来。
 * 这里用一个 150ms 的滑窗取众数，单帧毛刺直接被吃掉。
 */
export class StableCount {
  constructor({ windowMs = 150 } = {}) {
    this.windowMs = windowMs;
    this.buf = [];
  }

  reset() {
    this.buf.length = 0;
  }

  /**
   * @param {number} count 本帧数出来的手指数（-1 = 没有手）
   * @param {number} now 毫秒
   * @returns {number} 平滑后的手指数
   */
  push(count, now) {
    if (count == null || count < 0) {
      this.reset();
      return -1;
    }
    this.buf.push({ count, now });
    while (this.buf.length > 1 && now - this.buf[0].now > this.windowMs) this.buf.shift();

    const tally = new Map();
    for (const b of this.buf) tally.set(b.count, (tally.get(b.count) || 0) + 1);

    let best = -1;
    let bestN = -1;
    for (const [c, n] of tally) {
      if (n >= bestN) {          // 平票取最新的，变化时反应更快
        bestN = n;
        best = c;
      }
    }
    return best;
  }
}
