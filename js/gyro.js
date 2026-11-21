/**
 * 手机倾斜控制：不用摄像头也能"左右转"。
 *
 * 手机上摄像头需要 https，本地打开的单文件是拿不到摄像头的 ——
 * 所以给一套陀螺仪方案：把手机当方向盘，左右倾斜转角，前后仰俯仰角。
 *
 * iOS 13+ 必须在用户手势里申请权限（DeviceOrientationEvent.requestPermission），
 * 所以对外暴露的是一个按钮，点一下才开始。
 */

const DEG = Math.PI / 180;

export class GyroControl {
  constructor(rig, { onStatus = () => {} } = {}) {
    this.rig = rig;
    this.onStatus = onStatus;
    this.active = false;
    this.neutral = null;
    this.button = null;
    this._onOrientation = this._onOrientation.bind(this);
  }

  get supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /** 把按钮挂到指定容器；返回按钮元素，方便上层控制显隐 */
  mount(parent) {
    const btn = document.createElement('button');
    btn.id = 'gyro-btn';
    btn.className = 'btn btn-ghost';
    btn.type = 'button';
    btn.textContent = '📱 倾斜控制';
    btn.addEventListener('click', () => this.toggle());
    parent.appendChild(btn);
    this.button = btn;
    return btn;
  }

  async toggle() {
    if (this.active) {
      this.stop();
      return;
    }

    // iOS 需要显式授权，而且必须在点击事件里调用
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const state = await DeviceOrientationEvent.requestPermission();
        if (state !== 'granted') {
          this.onStatus('gyro-denied');
          return;
        }
      } catch (err) {
        console.warn('[gyro] 授权失败：', err);
        this.onStatus('gyro-denied');
        return;
      }
    }

    this.start();
  }

  start() {
    this.neutral = null;
    this.active = true;
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this.rig.enableGyro();
    if (this.button) {
      this.button.classList.add('on');
      this.button.textContent = '📱 倾斜中 · 点此停止';
    }
    this.onStatus('gyro-on');
  }

  stop() {
    this.active = false;
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    this.rig.disableGyro();
    if (this.button) {
      this.button.classList.remove('on');
      this.button.textContent = '📱 倾斜控制';
    }
    this.onStatus('gyro-off');
  }

  _onOrientation(e) {
    if (e.gamma == null && e.beta == null) return;

    // 横屏时设备坐标轴会转 90°，gamma/beta 的角色要对调
    const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const landscape = Math.abs(angle) === 90;
    const rawYaw = landscape ? (e.beta ?? 0) : (e.gamma ?? 0);
    const rawPitch = landscape ? (e.gamma ?? 0) : (e.beta ?? 0);

    if (!this.neutral) {
      // 第一帧当"中立位"，用户不用刻意把手机摆正
      this.neutral = { yaw: rawYaw, pitch: rawPitch };
      return;
    }

    const cfg = this.rig.cfg;
    const yaw = Math.max(-cfg.yawRange, Math.min(cfg.yawRange, (rawYaw - this.neutral.yaw) * DEG * 1.7));
    const pitch = Math.max(-cfg.pitchRange, Math.min(cfg.pitchRange, -(rawPitch - this.neutral.pitch) * DEG * 0.7));
    this.rig.setGyro(yaw, pitch);
  }
}
