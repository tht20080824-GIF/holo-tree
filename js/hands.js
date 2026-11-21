/**
 * 手部追踪封装：MediaPipe HandLandmarker + 摄像头。
 *
 * 优先级：本地 vendor 文件 → CDN。
 * 本地优先是因为 jsdelivr 在国内经常慢到离谱（模型 8MB+），
 * 但如果你只拷了 js 没拷 vendor，它会自动退回 CDN，不至于直接废掉。
 *
 * 任何一步失败都只抛错、不阻塞页面：main.js 会接住错误并切到触摸/鼠标模式。
 *
 * 单文件版本里没有 vendor 目录，构建时会把 window.__HOLO_NO_VENDOR__ 设为 true，
 * 这里就会直接走 CDN，不会先撞一次 404。
 */

const CDN_MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/+esm';

// 用 document.baseURI 而不是 import.meta.url：打包成单文件（经典脚本）后
// import.meta 是不存在的语法，直接用会让整个 bundle 解析失败。
const BASE = document.baseURI;
const HAS_VENDOR = !window.__HOLO_NO_VENDOR__;

const LOCAL_MP = new URL('vendor/tasks-vision.js', BASE).href;
const LOCAL_WASM = new URL('vendor/mediapipe/wasm', BASE).href;
const LOCAL_MODEL = new URL('vendor/mediapipe/hand_landmarker.task', BASE).href;

const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm';
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandTracker {
  constructor({ video, onHand, onStatus = () => {}, onFps = () => {} }) {
    this.video = video;
    this.onHand = onHand;
    this.onStatus = onStatus;
    this.onFps = onFps;

    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this._lastVideoTime = -1;
    this._lastFpsAt = 0;
    this._frames = 0;
  }

  /**
   * 动态 import：本地 vendor 缺文件时不至于让整个模块解析失败，
   * 而是回退到 CDN（静态 import 失败会直接白屏，这点很关键）。
   */
  async _loadMediapipe() {
    try {
      return await import(LOCAL_MP);
    } catch (err) {
      console.warn('[hands] 本地 tasks-vision 不可用，改用 CDN：', err);
      return await import(CDN_MP);
    }
  }

  async _createLandmarker(mp, wasmPath, modelPath) {
    const { FilesetResolver, HandLandmarker } = mp;
    const fileset = await FilesetResolver.forVisionTasks(wasmPath);
    const make = (delegate) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
      });

    try {
      return await make('GPU');
    } catch (err) {
      // Safari / 老核显上 GPU delegate 经常直接挂，退回 CPU 还能跑
      console.warn('[hands] GPU 不可用，退回 CPU：', err);
      return await make('CPU');
    }
  }

  async start() {
    // 摄像头只在安全上下文可用：https、localhost。
    // 注意 Chrome 的 file:// 也算 secure context，但 getUserMedia 依旧会被拒，
    // 所以这里额外按协议拦掉 —— 免得白下 17MB 模型再弹失败。
    if (location.protocol === 'file:' || !window.isSecureContext) {
      const err = new Error('INSECURE_CONTEXT');
      err.name = 'InsecureContextError';
      throw err;
    }

    this.onStatus('loading-model');
    const mp = HAS_VENDOR
      ? await this._loadMediapipe()
      : await import(CDN_MP);
    try {
      this.landmarker = await this._createLandmarker(mp, LOCAL_WASM, LOCAL_MODEL);
    } catch (localErr) {
      console.warn('[hands] 本地模型不可用，尝试 CDN：', localErr);
      this.onStatus('loading-model-cdn');
      this.landmarker = await this._createLandmarker(mp, CDN_WASM, CDN_MODEL);
    }

    this.onStatus('requesting-camera');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });

    this.video.srcObject = this.stream;
    await this.video.play();
    this.onStatus('ready');

    this.running = true;
    this._tick();
  }

  _tick = () => {
    if (!this.running) return;

    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this._lastVideoTime) {
      this._lastVideoTime = v.currentTime;
      try {
        const result = this.landmarker.detectForVideo(v, performance.now());
        const lm = result?.landmarks?.[0] ?? null;
        this.onHand(lm);

        this._frames++;
        const now = performance.now();
        if (now - this._lastFpsAt > 500) {
          this.onFps(Math.round((this._frames * 1000) / (now - this._lastFpsAt)));
          this._frames = 0;
          this._lastFpsAt = now;
        }
      } catch (err) {
        console.warn('[hands] 单帧识别失败：', err);
      }
    }

    // requestVideoFrameCallback 只在有新帧时回调，比 rAF 省电
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this._tick());
    else requestAnimationFrame(() => this._tick());
  };

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}
