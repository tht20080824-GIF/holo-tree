/**
 * 入口：把场景、手势、操控、UI 串起来。
 *
 * 三条铁律（都是上一版踩过的坑）：
 * 1. 摄像头/模型挂了不能白屏 —— 树必须先渲染出来，手势是增强不是前提。
 * 2. 没有手的时候必须有退路 —— 鼠标拖拽 / 滚轮 / 键盘都能玩。
 * 3. 所有状态都在 HUD 上可见 —— 手势识别不到时能一眼看出是"没识别"还是"没反应"。
 */

import { CONFIG } from './config.js';
import { measureHand, GestureRecognizer, GestureIntent, GestureRouter, StableCount, GESTURE, INTENT, MODE } from './gesture.js';
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
  CONFIG.quality.maxPixelRatio = 1.6;   // 文档 §7：移动端上限 1.6（3x DPR 会掉到 20fps）
  CONFIG.photos.defaultCount = 5;
  CONFIG.ribbon.count = 5000;   // 光带也要降，否则手机掉帧
  CONFIG.ornaments.gifts = 4;
  CONFIG.ornaments.bows = 2;
  CONFIG.ornaments.density = 0.6;   // 装饰粒子密度减半，手机才稳
  CONFIG.intro.count = 9000;
  CONFIG.intro.bloom = CONFIG.intro.mobileBloom;
  CONFIG.vortex.count = 1400;   // 收尾漩涡也要降
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
  fps: $('#fps'),
  morphInput: $('#morph-input'),
  zodiacInput: $('#zodiac-input'),
  debug: $('#debug'),
  handDot: $('#hand-dot'),
  video: $('#cam-video'),
  canvas: $('#cam-canvas'),
  camPanel: $('#cam-panel'),
  file: $('#file-input'),
  replay: $('#replay-btn'),
  debugBtn: $('#debug-btn'),
  toast: $('#toast'),
};

// 版本水印：把构建时间写进 HUD，一眼能看出跑的是不是最新包（缓存排查用）
(() => {
  const el = document.querySelector('.brand-ver');
  if (!el) return;
  const t = window.__HOLO_BUILD__ ? new Date(window.__HOLO_BUILD__) : null;
  const tag = t
    ? `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    : 'dev';
  el.textContent = `v1.0 · ${tag}`;
})();

const ctx = els.canvas.getContext('2d');
const rig = new Rig(CONFIG.rig);
const recognizer = new GestureRecognizer(CONFIG.gesture);
const intentRec = new GestureIntent(CONFIG.intent);

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
  closeCaptionModal();
  introStarted = true;
  introHoldStart = 0;
  if (intro.skipButton) intro.skipButton.textContent = '跳过开场';
  document.body.classList.add('intro-on');
  els.loader.classList.add('hidden');
  toast('开场开始');
  if (SKIP_INTRO) setTimeout(() => { if (intro) intro.done = true; }, 900);
}

function endIntro() {
  if (!intro) return;
  const handoff = intro.finished;      // 自然播到闪屏 vs 用户点「跳过」
  const camFrom = intro.camera ? {
    z: intro.camera.position.z,
    y: intro.camera.position.y,
    targetY: intro.baseTargetY ?? 0.4,
    fov: intro.camera.fov,
  } : null;
  intro.skipButton?.remove();
  intro.dispose();
  intro = null;
  document.body.classList.remove('intro-on');
  els.loader.classList.add('hidden');
  if (handoff) handoffToMainBody(camFrom);
  // 手机上「怎么玩」面板是收起的，开场结束后给一条一次性提示
  if (isTouchDevice) toast('点相框看大图 · 右上 ＋ 换照片');
  runDemo();
}

// 闪屏之后不再切黑场：主场景先铺成散开态，再用 0.26s 收拢成主体。
// 白色闪光盖住场景切换，用户看到的是「爆散 → 散开 → 重组成本体」。
function handoffToMainBody(camFrom) {
  if (!tree) return;
  tree.snapToScatter();
  tree.startCameraBlend(camFrom, 0.6);
  rig.setMode(MODE.SCATTER);
  flashBridge();
  setTimeout(() => {
    tree.setMode(MODE.TREE);
    rig.setMode(MODE.TREE);
    recognizer.mode = MODE.TREE;
  }, 260);
}

function flashBridge() {
  const el = document.createElement('div');
  el.id = 'intro-flash-bridge';
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '0'; });
  setTimeout(() => el.remove(), 700);
}

// 按 R：把当前这条序列丢掉，重建一条，从头再放一遍（播到一半按也生效）
function replayIntro() {
  if (performance.now() < morphLockUntil) return;
  if (tree.textActive) tree.hideText();
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
    document.body.classList.remove('intro-on');
    toast('开场重播失败');
    return;
  }
  introStarted = false;
  introHoldStart = 0;
  startIntro();
  toast('重播开场');
}

// 手机上没键盘：右上角按钮点一下就能重播
els.replay?.addEventListener('click', replayIntro);

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

// ---------------------------------------------------------------- 照片文字
// 加完照片弹一个小窗，让用户写一句话；写完显示在相框下面
let captionQueue = [];
let captionIdx = 0;
let captionModal = null;

function ensureCaptionModal() {
  if (captionModal) return captionModal;
  captionModal = document.createElement('div');
  captionModal.id = 'caption-modal';
  captionModal.innerHTML = `
    <div class="caption-card">
      <div class="caption-title">给这张照片写一句话</div>
      <div class="caption-sub"></div>
      <input id="caption-input" type="text" maxlength="30" placeholder="例如：圣诞快乐 · 2026 冬" autocomplete="off" spellcheck="false" />
      <div class="caption-actions">
        <button type="button" class="caption-btn skip">跳过</button>
        <button type="button" class="caption-btn save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(captionModal);
  // 打字时别让 R / 空格 / D 这些快捷键触发
  captionModal.addEventListener('keydown', (e) => e.stopPropagation());
  captionModal.querySelector('.skip').addEventListener('click', skipCaption);
  captionModal.querySelector('.save').addEventListener('click', saveCaption);
  const input = captionModal.querySelector('#caption-input');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') saveCaption();
    if (e.key === 'Escape') skipCaption();
  });
  captionModal.addEventListener('click', (e) => {
    if (e.target === captionModal) skipCaption();
  });
  return captionModal;
}

function askCaption(nodes) {
  if (!nodes || !nodes.length) return;
  captionQueue = nodes.slice();
  captionIdx = 0;
  showCaptionStep();
}

function showCaptionStep() {
  const node = captionQueue[captionIdx];
  if (!node) { closeCaptionModal(); return; }
  const modal = ensureCaptionModal();
  modal.querySelector('.caption-sub').textContent = captionQueue.length > 1
    ? `第 ${captionIdx + 1} / ${captionQueue.length} 张 · 可留空`
    : '可留空，照片下面会显示这句话';
  const input = modal.querySelector('#caption-input');
  input.value = tree.photoCaption(node);
  modal.classList.add('on');
  requestAnimationFrame(() => input.focus());
}

function saveCaption() {
  const node = captionQueue[captionIdx];
  const input = captionModal?.querySelector('#caption-input');
  if (node && input) tree.setPhotoCaption(node, input.value);
  captionIdx++;
  showCaptionStep();
}

function skipCaption() {
  captionIdx++;
  showCaptionStep();
}

function closeCaptionModal() {
  if (!captionModal) return;
  captionModal.classList.remove('on');
  captionModal.querySelector('#caption-input')?.blur();
  captionQueue = [];
  captionIdx = 0;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePhoto();
});

// ------------------------------------------------------------------ 手势

let latestHand = null;   // measureHand() 的结果
let handSeenAt = 0;      // 最近一次拿到手的时刻
let fps = 0;
let debugOn = false;

function setDebug(on) {
  debugOn = on;
  els.debug.classList.toggle('on', on);
}

let lastHandTrackAt = 0;

function onHand(landmarks) {
  if (landmarks) {
    latestHand = measureHand(landmarks);
    handSeenAt = performance.now();
    lastHandTrackAt = handSeenAt;
    tracker.setHandActive(true);
    drawSkeleton(landmarks);
  } else {
    latestHand = null;
    ctx.clearRect(0, 0, CW, CH); // 手离开后别把上一帧的骨架留在画面上
    // 手离开 2 秒就把摄像头/识别降回 30fps，别一直烤着
    if (lastHandTrackAt && performance.now() - lastHandTrackAt > 2000) {
      lastHandTrackAt = 0;
      tracker.setHandActive(false);
    }
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

// 手机排查用：地址后面加 ?tapdebug=1，点屏幕会在左上角显示"点到了什么"
const TAP_DEBUG = new URLSearchParams(location.search).has('tapdebug');
let tapDebugEl = null;
function showTapDebug(text) {
  if (!TAP_DEBUG) return;
  if (!tapDebugEl) {
    tapDebugEl = document.createElement('div');
    tapDebugEl.id = 'tap-debug';
    document.body.appendChild(tapDebugEl);
  }
  tapDebugEl.textContent = text;
}

attachPointerControls(canvasEl, rig, {
  onDoubleTap: () => switchMode(rig.mode === MODE.TREE ? MODE.SCATTER : MODE.TREE),
  onTap: (cx, cy, pointerType) => {
    // 返回 true = 这次点击已经用掉了，不要再拿去做双击切形态
    if (performance.now() < morphLockUntil) return true;
    if (tree.textActive) { tree.hideText(); return true; }
    const tag = `${pointerType} ${Math.round(cx)},${Math.round(cy)}`;
    if (tree.focusedPhoto) {
      showTapDebug(`${tag} → 关闭照片`);
      closePhoto();
      return true;
    }
    const node = tree.pickAt(cx / window.innerWidth, cy / window.innerHeight);
    if (node) {
      const idx = tree.photos.indexOf(node);
      showTapDebug(`${tag} → 命中 #${idx}（共 ${tree.photos.length} 张）`);
      openPhoto(node);
      return true;
    }
    showTapDebug(`${tag} → 没点中（共 ${tree.photos.length} 张）`);
    return false;
  },
});

// 手机没有 D 键：右上角给一个「调试」按钮，点开就是同一块面板
if (isTouchDevice && els.debugBtn) {
  els.debugBtn.hidden = false;
  els.debugBtn.addEventListener('click', () => setDebug(!debugOn));
}

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  rig.touch();
  rig.nudgeZoom(e.deltaY * 0.6);
}, { passive: false });

// ------------------------------------------------------------------ 键盘

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'h') document.body.classList.toggle('ui-hidden');
  if (key === 'd') setDebug(!debugOn);
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
  if (performance.now() < morphLockUntil) return;   // 变形动画前 3 秒不可打断
  if (tree.textActive) { tree.hideText(); return; } // 文字形态下任何切换 = 收起文字
  if (mode === rig.mode) return;
  rig.setMode(mode);
  tree.setMode(mode);
  recognizer.mode = mode; // 同步给识别器，不然它会以为状态没变、不再触发
  toast(mode === MODE.TREE ? '🌲 合拢态' : '✨ 散开态');
}

function fireBurst() {
  if (performance.now() < morphLockUntil) return;
  if (tree.textActive) tree.hideText();
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
  const added = files.map((f) => tree.addPhotoFromSource(f)).filter(Boolean);
  if (added.length) {
    toast(`已加入 ${added.length} 张照片`);
    askCaption(added);   // 加完立刻让用户写照片文字
  }
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

// 主动识别到的动作，短时间显示在 HUD 上 —— 让用户知道"它认出来了"
const INTENT_LABEL = {
  [INTENT.SWIPE_LEFT]: '👈 左划 · 左转',
  [INTENT.SWIPE_RIGHT]: '👉 右划 · 右转',
  [INTENT.SWIPE_UP]: '👆 上划 · 抬头',
  [INTENT.SWIPE_DOWN]: '👇 下划 · 低头',
  [INTENT.PUSH]: '🫱 推近 · 拉近',
  [INTENT.PULL]: '🫲 拉远 · 后退',
};
let intentFlash = '';
let intentFlashUntil = 0;


let lastTime = performance.now();
let firstFrame = true;
let lastDebugAt = 0;

// ---------------------------------------------------------------- 手势序列 → 粒子文字
// 1 → 2 → 3 → 五指张开，触发粒子变形文字；3 秒内锁定交互
// 手势仲裁：单独「1」停住 = 爱心；1→2→3→5 = 文字
let seqStallAt = 0;   // 序列卡住的起点（毫秒），用来在 HUD 上提示「需要 N 指」
const stableCount = new StableCount({ windowMs: 90 });   // 窗口越短反应越快，手机上 150ms 太粘   // 手指数时域平滑，抗手机抖动

const morphRouter = new GestureRouter([1, 2, 3, 5], {
  holdMs: 45,   // 序列每步更快认，手机上不用刻意停
  resetMs: 4000,
  cooldownMs: 1500,
  // 这两条必须在 1 秒以上：低于它就抢在 1→2→3→5 前面触发爱心/生肖，序列永远走不完
  // 800ms 是「手指停住」的门槛：只要手指数一直在变（走序列），这个计时会被重置
  heartHoldMs: 800,
  zodiacHoldMs: 800,
});
let morphLockUntil = 0;

// ?demo=heart|text|zodiac 自动触发一次形态变化，配合 tools/shot.mjs 做无头复现
const QS = new URLSearchParams(location.search);
const DEMO = QS.get('demo');
const SKIP_INTRO = QS.get('skipintro') === '1';
function runDemo() {
  if (!DEMO) return;
  setTimeout(() => {
    if (DEMO === 'heart') triggerHeart();
    else if (DEMO === 'zodiac') triggerZodiac();
    else triggerMorph();
  }, 800);
}

function fingerCountOf(out) {
  if (!out?.hand) return -1;
  if (out.openness > CONFIG.gesture.openOn) return 5;
  return out.hand.extended.filter(Boolean).length;
}

function triggerMorph() {
  if (tree.focusedPhoto) closePhoto();
  closeCaptionModal();
  const text = (els.morphInput?.value || '').trim() || '圣诞快乐';
  if (!tree.showText(text)) return;
  morphLockUntil = performance.now() + 1200;
  toast(`✍️ ${text}`);
}

/** 手势「2」停住 → 把输入框里的生肖变成粒子形状（只认十二生肖） */
function triggerZodiac() {
  if (tree.focusedPhoto) closePhoto();
  closeCaptionModal();
  // 生肖有自己的输入框，和「文字」互不干扰
  const raw = (els.zodiacInput?.value || '').trim();
  if (!raw) {
    toast('🐭 先在「生肖」输入框里填一个：鼠 牛 虎 兔 龙 蛇 马 羊 猴 鸡 狗 猪');
    return;
  }
  if (!tree.showZodiac(raw)) {
    toast('只认十二生肖：鼠 牛 虎 兔 龙 蛇 马 羊 猴 鸡 狗 猪');
    return;
  }
  morphLockUntil = performance.now() + 1200;
  toast(`✨ ${raw}`);
}

/** 手势「1」停住 → 粒子散开、聚成爱心 */
function triggerHeart() {
  if (tree.focusedPhoto) closePhoto();
  closeCaptionModal();
  if (!tree.showHeart()) return;
  morphLockUntil = performance.now() + 1200;
  toast('❤️ 爱心');
}

function feedMorphGesture(out, now) {
  if (!tree || tree.textActive) return;
  if (now < morphLockUntil) return;
  const raw = fingerCountOf(out);
  // 4 根也算「张开」：手机远景下手掌张开度常常差一点，凑不到 5
  const normalized = raw >= 4 ? 5 : raw;
  const count = stableCount.push(normalized, now);   // 先平滑再判序列
  if (count < 0) return;
  // 卡住检测用这一帧平滑后的 count（不能引用 HUD 里的 shownCount —— 那是另一个作用域）
  if (morphRouter.seq.step > 0 && count !== morphRouter.expectedCount()) {
    if (!seqStallAt) seqStallAt = now;
  } else {
    seqStallAt = 0;
  }

  const stepBefore = morphRouter.seq.step;
  const action = morphRouter.update(count, now);
  if (morphRouter.seq.step > stepBefore && morphRouter.seq.step < 4) {
    toast(`👣 序列 ${morphRouter.seq.step}/4`);
  }
  if (action === 'text') triggerMorph();
  else if (action === 'heart') triggerHeart();
  else if (action === 'zodiac') triggerZodiac();
}


// ---------------------------------------------------------------- 帧率控制
// ---------------------------------------------------------------- 帧率控制
// 目标：稳定在 50~61fps。
// 上限：高刷屏（≥100Hz）隔帧渲染，落到 60；90/144Hz 不跳帧，免得掉到 50 以下。
// 下限：帧率低于 50 时逐级降像素比（0.7x 下限），恢复了再慢慢加回来。
const BASE_PR = Math.min(window.devicePixelRatio || 1, isTouchDevice ? 1.6 : 2);
let rafGap = 16.7;        // 估测的屏幕刷新间隔
let lastRafAt = 0;
let renderFps = 60;
const qualityScale = 1;   // 固定 100%：不做动态降分辨率
let perfElapsed = 0;
let perfFrames = 0;
let lastFpsHudAt = 0;

function shouldRenderFrame(now) {
  if (lastRafAt) rafGap += ((now - lastRafAt) - rafGap) * 0.1;
  lastRafAt = now;
  // 统一 60fps 上限：不管是 120 / 90 / 144Hz，都隔到 60 这一档
  // （90Hz 会落到 45、144Hz 会落到 48，这是 rAF 整数倍跳帧的物理限制）
  return now - lastTime >= 1000 / 61 - 1;
}

function governFrameRate(dt) {
  renderFps += (1 / Math.max(dt, 1e-3) - renderFps) * 0.05;
  // 只统计，不再自动降画质：用户要求画面不允许被压缩。
  // 帧率靠「关掉高分屏 MSAA」这类不损画质的手段来保。
  if (intro) return;
  perfElapsed += dt;
  perfFrames++;
  if (perfElapsed < 1.2) return;
  perfElapsed = 0;
  perfFrames = 0;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) { lastTime = now; return; }   // 后台不渲染，回来也不跳帧
  if (!shouldRenderFrame(now)) return;

  // dt 上限 50ms：掉帧时也不会一步跳太远，但不会把 16 秒开场拖成慢动作
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  governFrameRate(dt);

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

  // 接回流程（散开 → 聚合）期间：所有用户输入一律不生效。
  // 手势、捏合、形态切换、转向、缩放全部让路，直到树完全恢复才交还控制权。
  rig.locked = !!tree.restoring;
  if (tree.restoring) {
    rig.update(dt, null);
    tree.update(dt, rig);
    els.gesture.textContent = '🔄 恢复中';
    els.mode.textContent = '散开 → 聚合（完成前不响应手势）';
    els.handDot.classList.remove('on');
    if (now - lastFpsHudAt > 500) {
      lastFpsHudAt = now;
      els.fps.textContent = `${renderFps.toFixed(0)} fps · ${(1000 / Math.max(renderFps, 1)).toFixed(1)} ms · 画质 ${(qualityScale * 100).toFixed(0)}%`;
    }
    return;
  }

  feedMorphGesture(out, now);

  // 主动意图：手划一下 / 推一下，就直接识别成动作，不用等转速慢慢积累
  // 捏合（要点相框）和看照片时不做意图识别：那会儿手本来就在快速移动，别误判成划动
  if (out.pinched || tree.focusedPhoto) {
    intentRec.reset();
  } else {
    const intent = intentRec.update(out.hand, now);
    if (intent.intent !== INTENT.NONE) {
      const s = intent.strength;
      if (intent.intent === INTENT.SWIPE_RIGHT) rig.flickYaw(1, s);
      else if (intent.intent === INTENT.SWIPE_LEFT) rig.flickYaw(-1, s);
      else if (intent.intent === INTENT.SWIPE_UP) rig.flickPitch(1, s);
      else if (intent.intent === INTENT.SWIPE_DOWN) rig.flickPitch(-1, s);
      else if (intent.intent === INTENT.PUSH) rig.flickZoom(-s);   // 推向镜头 = 靠近
      else if (intent.intent === INTENT.PULL) rig.flickZoom(s);    // 拉远 = 后退
      intentFlash = INTENT_LABEL[intent.intent] ?? intent.intent;
      intentFlashUntil = now + 900;
    }
  }

  // 手势切换形态（张开/握拳）
  if (out.modeChanged) switchMode(out.modeChanged);

  // 捏合：指着相框就展开，空着就撒花
  if (out.pinched && !frame._wasPinched) {
    if (performance.now() < morphLockUntil) { frame._wasPinched = true; return; }
    if (tree.textActive) { tree.hideText(); frame._wasPinched = true; return; }
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
  // 手势栏：0~4 根手指直接显示数字，5 根显示张开 —— 手机上能一眼看出识别对不对
  const shownCount = out.hand ? fingerCountOf(out) : -1;
  // 诊断附注：四根手指的伸直判定 + 张开度，出问题时截一张图就能定位
  const diag = out.hand
    ? ` · [${out.hand.extended.map((e) => (e ? 1 : 0)).join('')}] · 张 ${out.openness.toFixed(2)}`
    : '';
  let gestureText;
  if (shownCount === 5) gestureText = '🖐 张开';
  else if (shownCount >= 1 && shownCount <= 4) gestureText = `${'☝️✌️🤟🖖'[shownCount - 1]} ${shownCount} 指`;
  else gestureText = GESTURE_LABEL[out.gesture] ?? out.gesture;
  gestureText += diag;

  // 按住「1」= 爱心、「2」= 生肖：显示进度，用户知道还要停多久
  const hold = morphRouter.holdProgress(shownCount, now);
  if (hold > 0.05) {
    const tag = shownCount === 1 ? '❤️' : '🐭';
    gestureText += ` · ${tag} ${Math.round(hold * 100)}%`;
  }

  els.gesture.textContent = now < intentFlashUntil ? intentFlash : gestureText;
  const dirText = rig.spinDir > 0 ? '▶ 右转' : rig.spinDir < 0 ? '◀ 左转' : '自然自转';
  const seqStep = morphRouter.seq.step;
  let seqHint = '';
  if (seqStep > 0) {
    seqHint = ` · 👣 ${seqStep}/4`;
    // 卡住超过 1.2 秒就把「它现在要几根手指」直接写出来，不用猜
    const need = morphRouter.expectedCount();
    if (need && shownCount !== need && now - (seqStallAt || 0) > 1200) {
      seqHint += ` · 需要 ${need} 指`;
    }
  }
  els.mode.textContent = `${rig.mode === MODE.TREE ? '合拢' : '散开'} · ${dirText}${seqHint}`;
  if (now - lastFpsHudAt > 500) {
    lastFpsHudAt = now;
    els.fps.textContent = `${renderFps.toFixed(0)} fps · ${(1000 / Math.max(renderFps, 1)).toFixed(1)} ms · 画质 ${(qualityScale * 100).toFixed(0)}%`;
  }

  if (debugOn && now - lastDebugAt > 100) {
    lastDebugAt = now;
    els.debug.innerHTML = [
      `构建 ${
        window.__HOLO_BUILD__
          ? new Date(window.__HOLO_BUILD__).toLocaleString('zh-CN', { hour12: false })
          : 'dev'
      }`,
      `画面 ${renderFps.toFixed(0)} fps · ${(1000 / Math.max(renderFps, 1)).toFixed(1)} ms · 画质 ${(qualityScale * 100).toFixed(0)}%`,
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

// 视口变化统一走一个 debounce（文档 §10）：resize / 转屏 / 地址栏收起都重算
let resizeTimer = 0;
function onViewportChange() {
  tree?.resize();
  intro?.resize();
}
function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onViewportChange, 100);
}
window.addEventListener('resize', scheduleResize);
window.addEventListener('orientationchange', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);

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
