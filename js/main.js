/**
 * 入口：把场景、手势、操控、UI 串起来。
 *
 * 三条铁律（都是上一版踩过的坑）：
 * 1. 摄像头/模型挂了不能白屏 —— 树必须先渲染出来，手势是增强不是前提。
 * 2. 没有手的时候必须有退路 —— 鼠标拖拽 / 滚轮 / 键盘都能玩。
 * 3. 所有状态都在 HUD 上可见 —— 手势识别不到时能一眼看出是"没识别"还是"没反应"。
 */

import { CONFIG } from './config.js';
import { measureHand, GestureRecognizer, GESTURE, MODE } from './gesture.js';
import { Rig } from './controls.js';
import { HoloTree } from './tree.js';
import { HandTracker } from './hands.js';
import { attachPointerControls } from './touch.js';
import { GyroControl } from './gyro.js';
import { IntroSequence } from './intro.js';

// --- 手机/小屏：降粒子、降像素比，先把帧率稳住 ---
const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
const isSmallScreen = Math.min(window.innerWidth, window.innerHeight) < 720;

if (isTouchDevice || isSmallScreen) {
  CONFIG.particles.count = 1000;        // 1600 → 1000
  CONFIG.quality.snowCount = 420;
  CONFIG.quality.maxPixelRatio = 1.75;  // 手机上 3x DPR 会直接掉到 20fps
  CONFIG.photos.defaultCount = 5;
  CONFIG.ribbon.count = 5000;   // 光带也要降，否则手机掉帧
  CONFIG.ornaments.gifts = 4;
  CONFIG.ornaments.bows = 2;
  CONFIG.ornaments.density = 0.6;   // 装饰粒子密度减半，手机才稳
  CONFIG.intro.count = 9000;
  CONFIG.intro.bloom = CONFIG.intro.mobileBloom;
}

// ---------------------------------------------------------------- 全局错误兜底
// 手机上出问题时，黑屏什么都看不出来。这里把错误直接画到加载层上，
// 至少能截图给我，而不是"打不开"三个字。

let fatalShown = false;

function showFatal(message, detail = '') {
  if (fatalShown) return;
  fatalShown = true;
  const loader = document.getElementById('loader');
  if (!loader) return;
  loader.classList.remove('hidden');
  loader.innerHTML = `
    <div style="max-width:min(520px,86vw);text-align:center;font-family:-apple-system,'PingFang SC',sans-serif">
      <div style="color:#ff8a8a;font-size:15px;font-weight:600;margin-bottom:10px">页面没能启动</div>
      <div style="color:#9fb2ba;font-size:12.5px;line-height:1.8;word-break:break-word">${message}</div>
      <div style="color:#5d6f77;font-size:11px;line-height:1.7;margin-top:12px;word-break:break-all">${detail}</div>
      <div style="color:#9fb2ba;font-size:12px;margin-top:16px">把这张截图发我，我照着修</div>
    </div>`;
}

window.addEventListener('error', (e) => {
  const msg = e.message || '脚本执行出错';
  showFatal(msg, `${e.filename || ''}:${e.lineno || 0}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  showFatal(reason?.message || String(reason || 'Promise 未处理错误'));
});

const $ = (sel) => document.querySelector(sel);

const els = {
  app: $('#app'),
  loader: $('#loader'),
  loaderText: $('#loader-text'),
  status: $('#status'),
  gesture: $('#gesture'),
  mode: $('#mode'),
  debug: $('#debug'),
  handDot: $('#hand-dot'),
  video: $('#cam-video'),
  canvas: $('#cam-canvas'),
  camPanel: $('#cam-panel'),
  file: $('#file-input'),
  toast: $('#toast'),
};

const ctx = els.canvas.getContext('2d');
const rig = new Rig(CONFIG.rig);
const recognizer = new GestureRecognizer(CONFIG.gesture);

let tree = null;
try {
  tree = new HoloTree(els.app);
} catch (err) {
  console.error(err);
  els.loaderText.textContent = '这台设备的浏览器不支持 WebGL，换个浏览器或开硬件加速再试';
  throw err;
}

// ------------------------------------------------------------------ 开场动画
// 独立场景 + 独立 composer：播完就把整条序列 dispose 掉，主场景不受影响。

let intro = null;
let introStarted = false;
let introHoldStart = 0;
let cameraSettled = false;

function mountIntro() {
  intro = new IntroSequence({
    shape: {
      height: CONFIG.particles.height,
      floorY: CONFIG.particles.floorY,
      baseRadius: CONFIG.particles.radius,
    },
    cfg: CONFIG.intro,
    renderer: tree.renderer,
  });

  const skip = document.createElement('button');
  skip.id = 'intro-skip';
  skip.type = 'button';
  skip.textContent = '直接开始';
  skip.addEventListener('click', () => {
    if (!intro) return;
    if (!introStarted) startIntro();
    else intro.done = true;
  });
  document.body.appendChild(skip);
  intro.skipButton = skip;
}

if (CONFIG.intro.enabled) {
  try {
    mountIntro();
  } catch (err) {
    console.warn('[intro] 开场初始化失败，直接进入交互模式：', err);
    intro = null;
  }
}

function startIntro() {
  if (!intro || introStarted) return;
  introStarted = true;
  introHoldStart = 0;
  if (intro.skipButton) intro.skipButton.textContent = '跳过开场';
  els.loader.classList.add('hidden');
  toast('开场开始');
}

function endIntro() {
  if (!intro) return;
  intro.skipButton?.remove();
  intro.dispose();
  intro = null;
  els.loader.classList.add('hidden');
}

// 按 R：把当前这条序列丢掉，重建一条，从头再放一遍（播到一半按也生效）
function replayIntro() {
  if (!CONFIG.intro.enabled) {
    toast('开场动画已关闭');
    return;
  }
  if (intro) {
    intro.skipButton?.remove();
    intro.dispose();
    intro = null;
  }
  try {
    mountIntro();
  } catch (err) {
    console.warn('[intro] 重播失败：', err);
    intro = null;
    toast('开场重播失败');
    return;
  }
  introStarted = false;
  introHoldStart = 0;
  startIntro();
  toast('重播开场');
}

// ------------------------------------------------------------------ 照片聚焦
// 照片不再用 DOM 弹层，而是把相框本身"拔"到镜头前（效果见 tree.js 的 focusPhoto）。
// 好处是渲染循环完全不中断：树照常转、雪照常落，照片就悬在场景中央。

function openPhoto(node) {
  if (!node) return;
  tree.focusPhoto(node);
  tree.setHovered(null);
}

function closePhoto() {
  tree.unfocusPhoto();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePhoto();
});

// ------------------------------------------------------------------ 手势

let latestHand = null;   // measureHand() 的结果
let handSeenAt = 0;      // 最近一次拿到手的时刻
let fps = 0;
let debugOn = false;

function onHand(landmarks) {
  if (landmarks) {
    latestHand = measureHand(landmarks);
    handSeenAt = performance.now();
    drawSkeleton(landmarks);
  } else {
    latestHand = null;
    ctx.clearRect(0, 0, CW, CH); // 手离开后别把上一帧的骨架留在画面上
  }
}

function statusText(code) {
  const map = {
    'loading-model': '加载手势模型…',
    'loading-model-cdn': '本地模型缺失，改用 CDN…',
    'requesting-camera': '等待摄像头授权…',
    ready: '手势就绪 · 手放进画面里',
    'camera-denied': '摄像头不可用 · 用手指拖拽也能玩',
    'model-failed': '手势模型加载失败 · 用手指拖拽也能玩',
    insecure: '本地文件模式（无摄像头）· 用手指拖拽 / 倾斜手机',
    'gyro-on': '倾斜手机试试 · 左右转、上下抬',
    'gyro-off': '倾斜控制已关闭',
    'gyro-denied': '系统没给倾斜权限 · 手指拖拽也行',
  };
  els.status.textContent = map[code] ?? code;
}

const tracker = new HandTracker({
  video: els.video,
  onHand,
  onStatus: statusText,
  onFps: (v) => { fps = v; },
});

// ------------------------------------------------------------------ 触摸 / 鼠标兜底

const canvasEl = els.app.querySelector('canvas');

attachPointerControls(canvasEl, rig, {
  onDoubleTap: () => switchMode(rig.mode === MODE.TREE ? MODE.SCATTER : MODE.TREE),
  onTap: (cx, cy) => {
    if (tree.focusedPhoto) { closePhoto(); return; }
    const node = tree.pickAt(cx / window.innerWidth, cy / window.innerHeight);
    if (node) openPhoto(node);
  },
});

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  rig.touch();
  rig.nudgeZoom(e.deltaY * 0.6);
}, { passive: false });

// ------------------------------------------------------------------ 键盘

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'h') document.body.classList.toggle('ui-hidden');
  if (key === 'd') {
    debugOn = !debugOn;
    els.debug.classList.toggle('on', debugOn);
  }
  if (key === '1') switchMode(MODE.TREE);
  if (key === '2') switchMode(MODE.SCATTER);
  if (key === ' ') {
    e.preventDefault();
    fireBurst();
  }
  if (key === 'r') replayIntro();
  if (key === 'c') els.camPanel.classList.toggle('hidden');
});

function switchMode(mode) {
  if (mode === rig.mode) return;
  rig.setMode(mode);
  tree.setMode(mode);
  recognizer.mode = mode; // 同步给识别器，不然它会以为状态没变、不再触发
  toast(mode === MODE.TREE ? '🌲 合拢态' : '✨ 散开态');
}

function fireBurst() {
  tree.burst();
}

// ------------------------------------------------------------------ 倾斜控制（手机兜底）

const gyro = new GyroControl(rig, { onStatus: statusText });
if (isTouchDevice && gyro.supported) {
  gyro.mount($('#tools'));
}

// ------------------------------------------------------------------ 照片

els.file.addEventListener('change', (e) => {
  const files = Array.from(e.target.files ?? []);
  files.forEach((f) => tree.addPhotoFromSource(f));
  if (files.length) toast(`已加入 ${files.length} 张照片`);
  els.file.value = '';
});

// ------------------------------------------------------------------ 提示

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 1400);
}

// ------------------------------------------------------------------ 骨骼绘制

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const CW = els.canvas.width;
const CH = els.canvas.height;

function drawSkeleton(lm) {
  ctx.save();
  ctx.translate(CW, 0);
  ctx.scale(-1, 1); // 关键点坐标是未镜像的原图，画的时候要镜像回来
  ctx.clearRect(0, 0, CW, CH);

  ctx.strokeStyle = 'rgba(80, 240, 180, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(lm[a].x * CW, lm[a].y * CH);
    ctx.lineTo(lm[b].x * CW, lm[b].y * CH);
  }
  ctx.stroke();

  ctx.fillStyle = '#ffd27a';
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x * CW, p.y * CH, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ------------------------------------------------------------------ 主循环

const GESTURE_LABEL = {
  [GESTURE.NONE]: '未检测到手',
  [GESTURE.HOVER]: '手掌跟随',
  [GESTURE.PINCH]: '👌 捏合',
  [GESTURE.OPEN]: '🖐 张开',
  [GESTURE.FIST]: '✊ 握拳',
};

let lastTime = performance.now();
let firstFrame = true;
let lastDebugAt = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const dt = Math.min((now - lastTime) / 1000, 0.05); // 切标签页回来时别让 dt 爆炸
  lastTime = now;

  if (now - handSeenAt > 400) latestHand = null; // 手离开画面一段时间就当作没手

  if (intro) {
    if (intro.done) endIntro();
    else if (!introStarted) {
      // 等摄像头权限弹窗有结果（同意/拒绝）再开始，否则开场会被弹窗盖住
      if (!introHoldStart) introHoldStart = now;
      const waited = (now - introHoldStart) / 1000;
      if (cameraSettled || waited >= CONFIG.intro.startDelay) startIntro();
      else {
        els.loaderText.textContent = isTouchDevice
          ? '正在准备摄像头…（可直接开始）'
          : '等待摄像头授权…（最多 15 秒）';
        return;
      }
    } else {
      intro.update(dt);
      intro.render();
      if (firstFrame) {
        firstFrame = false;
        els.loader.classList.add('hidden');
      }
      return;
    }
  }

  const out = recognizer.update(latestHand, dt);

  // 手势切换形态（张开/握拳）
  if (out.modeChanged) switchMode(out.modeChanged);

  // 捏合：指着相框就展开，空着就撒花
  if (out.pinched && !frame._wasPinched) {
    if (tree.focusedPhoto) closePhoto();
    else if (out.hand && tree.hovered) openPhoto(tree.hovered);
    else fireBurst();
  }
  frame._wasPinched = out.pinched;

  // 手悬停在相框上时放大一点，作为"可点击"的反馈
  if (out.hand && !tree.focusedPhoto) {
    tree.setHovered(tree.pickAt(out.hand.x, out.hand.y));
  } else if (!out.hand) {
    tree.setHovered(null);
  }

  rig.update(dt, out.hand);
  tree.update(dt, rig);

  // 画面上的手部指示点
  if (out.hand) {
    els.handDot.classList.add('on');
    const x = out.hand.x * window.innerWidth;
    const y = out.hand.y * window.innerHeight;
    els.handDot.style.transform = `translate(${x}px, ${y}px)`;
  } else {
    els.handDot.classList.remove('on');
  }

  // HUD
  els.gesture.textContent = GESTURE_LABEL[out.gesture] ?? out.gesture;
  const dirText = rig.spinDir > 0 ? '▶ 右转' : rig.spinDir < 0 ? '◀ 左转' : '自然自转';
  els.mode.textContent = `${rig.mode === MODE.TREE ? '合拢' : '散开'} · ${dirText}`;

  if (debugOn && now - lastDebugAt > 100) {
    lastDebugAt = now;
    els.debug.innerHTML = [
      `构建 ${
        window.__HOLO_BUILD__
          ? new Date(window.__HOLO_BUILD__).toLocaleString('zh-CN', { hour12: false })
          : 'dev'
      }`,
      `手势识别 ${fps} fps`,
      `张开度 ${out.openness.toFixed(2)}  (张开>${CONFIG.gesture.openOn} / 握拳<${CONFIG.gesture.fistOn})`,
      `捏合比 ${out.pinchRatio.toFixed(2)}  (捏合<${CONFIG.gesture.pinchOn})`,
      `手掌尺度 ${(out.hand?.scale ?? 0).toFixed(3)}`,
      `yaw ${rig.yaw.toFixed(2)}  pitch ${rig.pitch.toFixed(2)}  zoom ${rig.distanceFactor.toFixed(2)}`,
    ].join('<br>');
  }

  if (firstFrame) {
    firstFrame = false;
    els.loader.classList.add('hidden');
  }
}

window.addEventListener('resize', () => intro?.resize());

requestAnimationFrame(frame);

// ------------------------------------------------------------------ 启动手势（失败不阻塞）

/**
 * 摄像头启动。
 *
 * 手机上有两条硬约束，都必须靠"用户点击"来满足：
 * 1. iOS Safari 的 getUserMedia 必须由用户手势触发，页面加载时直接调用会被拒。
 * 2. 授权弹窗被拒后，只有再次点击才能重试。
 *
 * 所以触摸设备先出「点击启用」卡片；桌面端自动尝试，失败也能点按钮重试。
 */
let cameraStarting = false;

async function startCamera() {
  if (cameraStarting) return;
  cameraStarting = true;
  setGateState('loading');

  try {
    await tracker.start();
    cameraSettled = true;
    removeGate();
  } catch (err) {
    console.warn('[main] 手势启动失败：', err);
    const insecure = err && err.name === 'InsecureContextError';
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'NotFoundError');

    statusText(insecure ? 'insecure' : denied ? 'camera-denied' : 'model-failed');
    els.camPanel.classList.add('hidden');

    cameraSettled = true;
    if (insecure) {
      setGateState('insecure');
      if (isTouchDevice && gyro.button) gyro.button.classList.add('primary');
    } else if (denied) {
      setGateState('denied');
    } else {
      setGateState('error');
    }
  } finally {
    cameraStarting = false;
  }
}

// ---------------------------------------------------------------- 启动卡片

const gate = document.createElement('div');
gate.id = 'start-gate';
gate.innerHTML = `
  <div class="gate-card">
    <div class="gate-title">用手控制这棵树</div>
    <div class="gate-sub">允许摄像头后，把手放进画面：左右移动转身，张开手掌散开，握拳收拢</div>
    <button type="button" class="gate-btn" data-action="start">启用摄像头</button>
    <button type="button" class="gate-skip" data-action="skip">先不用，用手指玩</button>
    <div class="gate-note"></div>
  </div>
`;
document.body.appendChild(gate);

function setGateState(state) {
  const btn = gate.querySelector('[data-action="start"]');
  const note = gate.querySelector('.gate-note');
  gate.classList.add('on');
  gate.dataset.state = state;

  if (state === 'loading') {
    btn.disabled = true;
    btn.textContent = '正在启动…';
    note.textContent = '';
  } else if (state === 'denied') {
    btn.disabled = false;
    btn.textContent = '再试一次';
    note.textContent = '摄像头被拒绝了。点上面的按钮重试，或去浏览器地址栏左边的权限图标里改成「允许」。';
  } else if (state === 'error') {
    btn.disabled = false;
    btn.textContent = '重试';
    note.textContent = '手势模型没加载成功（多半是网络）。重试一次，或先用手势以外的方式玩。';
  } else {
    btn.disabled = false;
    btn.textContent = '启用摄像头';
    note.textContent = '';
  }

  if (state === 'insecure') {
    btn.disabled = false;
    btn.textContent = '继续用手玩';
    btn.dataset.action = 'skip';

    // 三种"没有摄像头"的原因不一样，别用同一句话糊弄用户
    const why =
      location.protocol === 'file:'
        ? '当前是本地文件（file://），浏览器不给任何网页摄像头权限。'
        : location.protocol === 'https:'
          ? '这个 https 证书没有被信任，浏览器把它当成不安全页面。'
          : '当前是局域网 http 地址，不属于浏览器认可的"安全环境"。';
    gate.querySelector('.gate-sub').textContent = `${why} 这是浏览器的规定，不是页面坏了。`;
    note.textContent =
      '想用摄像头：把文件放到可信的 https 地址（例如拖到 app.netlify.com/drop），' +
      '电脑和手机打开同一个链接就都能用手势。';
  }
}

function removeGate() {
  gate.classList.remove('on');
  setTimeout(() => gate.remove(), 400);
}

gate.addEventListener('click', (e) => {
  const action = e.target?.dataset?.action;
  if (action === 'start') startCamera();
  if (action === 'skip') {
    cameraSettled = true;   // 用户明确不启用摄像头 → 开场不必再等
    removeGate();
  }
});

// 手机上必须先有一次点击（iOS 的硬性要求）；桌面直接尝试
if (isTouchDevice) {
  setGateState('idle');
} else {
  startCamera();
}

// 方便调试
window.__holo = { tree, rig, recognizer, tracker };
