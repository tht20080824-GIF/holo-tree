/**
 * 相机/树的"操控层"：把手势量变成平滑的 yaw / pitch / 距离。
 *
 * 这里有两个专门解决实际体验坑的设计，值得单独说明：
 *
 * 1. 绝对映射 + 进入偏移（yawBias）
 *    手放在画面哪个位置，树就转到哪个角度 —— 比"手一划转一点"更容易停住。
 *    但树在没人时是自动旋转的，手突然出现时如果直接套绝对映射，树会"啪"地
 *    跳回正面。所以手刚进入画面的那一刻记录一个偏置，再让它指数衰减，
 *    实现"平滑接管"。
 *
 * 2. 死区（deadzone）
 *    手停在画面正中时，坐标抖动会让树左右微颤。中心 8% 的范围直接映射为 0，
 *    出了死区才线性放大，视觉上稳很多。
 */

import { CONFIG } from './config.js';
import { MODE } from './gesture.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

function applyDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

export class Rig {
  constructor(rigCfg = CONFIG.rig, { mode = MODE.TREE } = {}) {
    this.cfg = rigCfg;
    this.mode = mode;

    this.yaw = 0;
    this.pitch = 0;
    this.distanceFactor = 1;

    this.yawTarget = 0;
    this.pitchTarget = 0;
    this.distanceTarget = 1;

    this.handActive = false;
    this._idleTime = 0;

    // 判向持续旋转的状态
    this.spinDir = 0;       // -1 左 / 0 自然自转 / +1 右
    this._cand = 0;
    this._candTime = 0;
    this._centerTime = 0;

    // 手机倾斜控制（js/gyro.js 驱动）
    this.gyroEnabled = false;
    this.gyro = { yaw: 0, pitch: 0 };
    this._gyroBase = 0;
  }

  enableGyro() {
    this.gyroEnabled = true;
    this._gyroBase = this.yawTarget; // 从当前角度接管，不跳变
  }

  disableGyro() {
    this.gyroEnabled = false;
    this.gyro.yaw = 0;
    this.gyro.pitch = 0;
  }

  setGyro(yaw, pitch) {
    this.gyro.yaw = yaw;
    this.gyro.pitch = pitch;
  }

  setMode(mode) {
    this.mode = mode;
  }

  /** 用户主动操作（拖拽/滚轮）时调用：重置空闲计时，暂停自动旋转 */
  touch() {
    this._idleTime = 0;
  }

  /** 鼠标拖拽：直接推动目标角，不经过平滑，交给 update 里的插值去消化 */
  nudgeYaw(dx) {
    this.yawTarget += dx * this.cfg.pointerYaw;
  }

  nudgePitch(dy) {
    this.pitchTarget = clamp(this.pitchTarget + dy * this.cfg.pointerPitch, -this.cfg.pitchRange, this.cfg.pitchRange);
  }

  nudgeZoom(delta) {
    this.distanceTarget = clamp(
      this.distanceTarget + delta * this.cfg.wheelZoom,
      this.cfg.zoomNear,
      this.cfg.zoomFar,
    );
  }

  /**
   * @param {number} dt 秒
   * @param {object|null} hand measureHand() 的结果，null 表示当前没有手
   */
  update(dt, hand) {
    const c = this.cfg;
    const k = 1 - Math.exp(-c.follow * dt); // 指数平滑，且与帧率无关

    if (hand) {
      this.handActive = true;
      this._idleTime = 0;

      const nx = (hand.x - 0.5) * 2;   // 手在画面横向的位置，-1 左 / +1 右
      const ny = (hand.y - 0.5) * 2;

      // ---------- 判向：只看"手在哪一侧"，不管手是否停住 ----------
      const candidate = nx > c.steerEnter ? 1 : nx < -c.steerEnter ? -1 : 0;
      if (candidate !== this._cand) {
        this._cand = candidate;
        this._candTime = 0;
      }
      this._candTime += dt;
      if (candidate !== 0 && this._candTime >= c.steerHold) {
        this.spinDir = candidate; // 方向锁定，手移开也继续转
      }

      // ---------- 手回到中心并稳住 → 停止转向，回落自然自转 ----------
      if (Math.abs(nx) < c.centerStop) {
        this._centerTime += dt;
        if (this._centerTime >= c.centerStopTime) this.spinDir = 0;
      } else {
        this._centerTime = 0;
      }

      // 仰角、缩放仍然实时跟随（这两项跟"方向"不冲突）
      this.pitchTarget = -ny * c.pitchRange;
      const depth = clamp((hand.scale - c.handScaleFar) / (c.handScaleNear - c.handScaleFar), 0, 1);
      this.distanceTarget = lerp(c.zoomFar, c.zoomNear, depth);
    } else {
      this.handActive = false;
      this._idleTime += dt;

      if (this.gyroEnabled) {
        // 陀螺仪接管时：绝对角度跟随手机倾斜，且不自动旋转
        this.yawTarget = this._gyroBase + this.gyro.yaw;
        this.pitchTarget = this.gyro.pitch;
        return this._settle(dt, k);
      }

      if (this._idleTime > c.idleDelay) {
        this.pitchTarget *= Math.exp(-0.5 * dt);
      }
    }

    // ---------- 持续旋转：方向锁定后就一直转，不依赖手是否还在 ----------
    const speed = this.spinDir !== 0 ? c.steerSpeed : c.idleYawSpeed;
    this.yawTarget += this.spinDir * speed * dt;
    // spinDir 为 0 时上式加的是 0，所以自然自转单独补上
    if (this.spinDir === 0) this.yawTarget += c.idleYawSpeed * dt;

    return this._settle(dt, k);
  }

  /** 把目标值平滑过去；抽出来是为了 gyro 分支能提前 return */
  _settle(dt, k) {
    this.yaw += (this.yawTarget - this.yaw) * k;
    this.pitch += (this.pitchTarget - this.pitch) * k;
    this.distanceFactor += (this.distanceTarget - this.distanceFactor) * k;
    return this;
  }
}
