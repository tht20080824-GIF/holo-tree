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

// 必须用官方 ESM 入口 vision_bundle.mjs：
// jsdelivr 的 `+esm` 会重写内部地址，wasm 加载器拿不到 ModuleFactory，
// 报「ModuleFactory not set」——单文件版（GitHub Pages / 隧道）就是这样彻底没手势的。
const CDN_MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs';

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
  constructor({ video, onHand, onStatus = () => {}, onFps = () => {}, onCameraReady = () => {} }) {
    this.video = video;
    this.onHand = onHand;
    this.onStatus = onStatus;
    this.onFps = onFps;
    this.onCameraReady = onCameraReady;

    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this._lastVideoTime = -1;
    this._lastFpsAt = 0;
    this._fpsTarget = 30;      // 摄像头/识别的目标帧率，有手时 60、没手时 30
    this._lastDetectAt = 0;
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
        // 手机远景 + 手部运动模糊时默认 0.5 太严，手会一帧有、一帧没有；
        // 放到 0.4 让跟踪更连续（代价是偶尔误检，但有 StableCount 兜着）
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
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

    // —— 顺序很重要：先开摄像头（快），再在后台加载模型（慢，7.8MB）——
    // 以前是先下模型再开摄像头，网络慢的时候整页会卡在「正在启动…」好几分钟。
    this.onStatus('requesting-camera');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: 640,
        height: 480,
        // 默认 30fps（省电、降温）；检测到手之后 setHandActive(true) 会升到 60
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    await this.video.play();

    this.running = true;
    this._tick();                    // 先跑起来（模型没好时 _tick 什么也不做）
    this.onCameraReady();            // 摄像头就绪：主场景可以先开，模型慢慢加载
    this.onStatus('camera-ready');

    this.onStatus('loading-model');
    try {
      const mp = HAS_VENDOR
        ? await this._loadMediapipe()
        : await import(CDN_MP);
      try {
        // 单文件版没有 vendor 目录：直接走 CDN，不要先试本地路径。
        // 先试本地会 404，FilesetResolver 拿到坏结果后会一直报 ModuleFactory not set。
        if (!HAS_VENDOR) throw new Error('NO_VENDOR');
        this.landmarker = await this._createLandmarker(mp, LOCAL_WASM, LOCAL_MODEL);
      } catch (localErr) {
        console.warn('[hands] 本地模型不可用，尝试 CDN：', localErr);
        this.onStatus('loading-model-cdn');
        this.landmarker = await this._createLandmarker(mp, CDN_WASM, CDN_MODEL);
      }
      this.onStatus('ready');
    } catch (modelErr) {
      // 模型没加载成功不要连摄像头一起废掉：
      // 摄像头已经开着，CAM 预览继续显示，只是暂时没有手势。
      console.warn('[hands] 手势模型加载失败，保留摄像头预览：', modelErr);
      this.landmarker = null;
      this.onStatus('model-failed');
    }
    this.running = true;
    this._tick();
  }

  /** 有手 → 60fps；手离开 2 秒 → 退回 30fps（摄像头和识别一起降，直接降温） */
  async setHandActive(active) {
    const target = active ? 60 : 30;
    if (this._fpsTarget === target) return;
    this._fpsTarget = target;
    const track = this.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ frameRate: { ideal: target, max: target } });
    } catch (err) {
      // 有些摄像头不支持动态改帧率，忽略即可
    }
  }

  _tick = () => {
    if (!this.running) return;

    // 页面在后台就不做识别
    if (document.hidden) {
      this._scheduleNext();
      return;
    }

    if (!this.landmarker) {   // 模型还在后台加载
      this._scheduleNext();
      return;
    }

    const v = this.video;
    const nowMs = performance.now();
    const tooSoon = nowMs - (this._lastDetectAt || 0) < 1000 / this._fpsTarget - 1;

    if (!tooSoon && v.readyState >= 2 && v.currentTime !== this._lastVideoTime) {
      this._lastDetectAt = nowMs;
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

    this._scheduleNext();
  };

  _scheduleNext() {
    const v = this.video;
    if (v?.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this._tick());
    else requestAnimationFrame(() => this._tick());
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}
