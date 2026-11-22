/**
 * 16 秒开场动画（v2：按参考实现重写，主打「顺」）。
 *
 * 上一版为什么不流畅：每帧对每颗粒子调用 dustPoint()——sin/cos/pow 各一次，
 * 17000 颗就是 6.8 万次三角函数，加上逐帧上传 attribute，主线程直接被拖住。
 *
 * 这一版的做法（和参考实现一致）：
 * - 预计算：每颗粒子的树坐标、星尘矢量、爆散方向全部在初始化时算好
 * - 每帧只算「帧级」的三角函数（自转角、额外圈、回卷角），逐粒子只剩加减乘
 * - 各阶段直接写回预存坐标，不做重复推导
 * - 闪烁也放进顶点着色器（uTime + aSeed），CPU 不参与
 *
 * 主体元素用我们自己的：树高 24、树底半径 9、调色板（绿/金/红/白）。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  INTRO_DURATION,
  easeInOutCubic,
  easeOutCubic,
  clamp01,
  progress,
  burstOffset,
  starPulse,
  frameCamera,
  fitDustRadius,
  dustTiltAt,
  DUST_TILT_TARGET,
  letterProgress,
  TEXT_LETTER_DELAY,
  TEXT_LETTER_DURATION,
} from './intro-math.js';

const T = {
  gatherEnd: 3.2,
  riseEnd: 5.6,
  flashEnd: 6.2,
  showEnd: 8.4,
  holdEnd: 10.3,
  implodeEnd: 10.55,
  burstEnd: 12.1,
  blastEnd: 12.55,
  returnEnd: 14.6,
  hold2End: 15.1,
  fadeEnd: 15.85,
  cutAt: 12.32,            // 闪屏峰值：这里收尾，交给主场景散开→重组
};

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aSeed;
  attribute float aRim;

  uniform float uK;
  uniform float uSizeScale;
  uniform float uMix;
  uniform float uAlpha;
  uniform float uBright;
  uniform float uTime;
  uniform float uRim;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    // 外沿一圈加大加亮：让「圆环」在远处也能看清边界
    float rim = smoothstep(0.82, 1.0, aRim) * uRim;
    float s = aSize * (1.0 + 1.5 * rim) * 0.0086 * uK / max(0.06, -mv.z);
    gl_PointSize = clamp(s, 1.0, 110.0) * uSizeScale;

    vec3 gold = vec3(1.0, 0.79, 0.44);
    float tw = 0.88 + 0.12 * sin(uTime * 2.7 + aSeed * 43.0);
    vColor = mix(gold, aColor, uMix) * uBright * tw * (1.0 + 0.9 * rim);
    vAlpha = uAlpha;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float a = pow(max(0.0, 1.0 - d * 2.0), 2.2);
    gl_FragColor = vec4(vColor, a * vAlpha);
  }
`;

export class IntroSequence {
  constructor({ shape, cfg, renderer }) {
    this.cfg = cfg;
    this.renderer = renderer;
    this.shape = shape;
    this.time = 0;
    this.done = false;
    this.finished = false;   // true = 自然播到闪屏（不是用户点的跳过）

    this.count = cfg.count;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    // 树整体缓慢自转用这个 group，别直接转相机
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this._buildParticles(shape);
    this._buildGuide();
    this._buildFireworks();
    this._buildCamera();
    this._buildComposer();
    this._buildOverlays();
  }

  // ---------------------------------------------------------------- 预计算

  _buildParticles(shape) {
    const n = this.count;
    const { height, floorY, baseRadius } = shape;

    this.treeX = new Float32Array(n);
    this.treeY = new Float32Array(n);
    this.treeZ = new Float32Array(n);
    this.dustX = new Float32Array(n);   // 单位矢量 × 半径（预旋转好的基准）
    this.dustZ = new Float32Array(n);
    this.dustY = new Float32Array(n);
    this.bDir = new Float32Array(n * 3);
    this.bScale = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.hf = new Float32Array(n);

    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const seeds = new Float32Array(n);
    const rims = new Float32Array(n);

    const palette = [
      { c: [0.12, 0.55, 0.34], w: 0.34 },
      { c: [0.18, 0.75, 0.45], w: 0.26 },
      { c: [1.0, 0.82, 0.48], w: 0.24 },
      { c: [1.0, 0.23, 0.36], w: 0.11 },
      { c: [1.0, 1.0, 1.0], w: 0.05 },
    ];
    const acc = [];
    let sum = 0;
    for (const p of palette) { sum += p.w; acc.push(sum); }
    const pickColor = () => {
      const r = Math.random() * sum;
      for (let i = 0; i < palette.length; i++) if (r <= acc[i]) return palette[i].c;
      return palette[0].c;
    };

    const spins = 6.5;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;

      // --- 树体：体积填充 + 螺旋光带 ---
      const yf = 1 - Math.sqrt(Math.random());  // 底部更密
      const coneR = baseRadius * (1 - yf * 0.965);
      let ang;
      let r;
      if (Math.random() < 0.32) {
        ang = yf * spins * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
        r = coneR * (0.86 + Math.random() * 0.22);
      } else {
        ang = Math.random() * Math.PI * 2;
        r = coneR * (0.18 + 0.82 * Math.pow(Math.random(), 0.45));
      }
      if (Math.random() < 0.04) r *= 1.08 + Math.random() * 0.2;

      this.treeX[i] = Math.cos(ang) * r;
      this.treeZ[i] = Math.sin(ang) * r;
      this.treeY[i] = floorY + yf * height + (Math.random() - 0.5) * 0.6;
      this.hf[i] = yf;

      // --- 星尘：预存「单位矢量 × 半径」，每帧只做一次全局旋转 ---
      const dAng = Math.random() * Math.PI * 2;
      const dR = baseRadius * (1.9 + Math.pow(Math.random(), 0.65) * 2.4);
      this.dustX[i] = Math.cos(dAng) * dR;
      this.dustZ[i] = Math.sin(dAng) * dR;
      this.dustY[i] = (Math.random() - 0.5) * height * 0.09;
      rims[i] = Math.min(1, dR / (baseRadius * 4.3));

      // --- 爆散方向（略偏镜头） ---
      const a = Math.random() * Math.PI * 2;
      let dx = Math.cos(a) * 0.78;
      let dy = (Math.random() - 0.42) * 0.62;
      let dz = Math.sin(a) * 0.58 + (0.16 + Math.random() * 0.34);
      const len = Math.hypot(dx, dy, dz) || 1;
      this.bDir[i3] = dx / len;
      this.bDir[i3 + 1] = dy / len;
      this.bDir[i3 + 2] = dz / len;
      this.bScale[i] = 0.65 + Math.random() * 1.55;

      this.seed[i] = Math.random();
      seeds[i] = this.seed[i];

      const c = pickColor();
      colors[i3] = c[0];
      colors[i3 + 1] = c[1];
      colors[i3 + 2] = c[2];

      sizes[i] = 0.82 + Math.random() * 1.25;

      positions[i3] = this.dustX[i];
      positions[i3 + 1] = this.dustY[i];
      positions[i3 + 2] = this.dustZ[i];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aRim', new THREE.BufferAttribute(rims, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 120);

    this.uniforms = {
      uK: { value: 900 },
      uSizeScale: { value: 1 },
      uMix: { value: 0 },
      uAlpha: { value: 1 },
      uBright: { value: 1 },
      uTime: { value: 0 },
      uRim: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.world.add(this.points);

    this.geometry = geo;
    this.positions = positions;

    // 爆散的统一尺度：按树底半径换算，树缩放也跟着变
    this.burstUnit = baseRadius * 1.15;
  }

  /** 开场圆环的"实体描边"：一圈带内/外沿的发光圆环，跟星尘盘同倾角、同缩放 */
  _buildGuide() {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2;
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0.00, 'rgba(255,220,150,0)');
    g.addColorStop(0.36, 'rgba(255,220,150,0)');
    g.addColorStop(0.43, 'rgba(255,226,170,0.30)');   // 内沿，勾出"洞"
    g.addColorStop(0.50, 'rgba(255,226,170,0.05)');
    g.addColorStop(0.84, 'rgba(255,214,140,0)');
    g.addColorStop(0.92, 'rgba(255,236,190,0.95)');   // 外沿，主圆
    g.addColorStop(0.965, 'rgba(255,205,120,0.30)');
    g.addColorStop(1.00, 'rgba(255,205,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cx, cx, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.guide = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.guide.renderOrder = 2;
    this.guide.rotation.x = -Math.PI / 2 + DUST_TILT_TARGET;
    this.guide.scale.setScalar(this.dustFit || 1);
    this.world.add(this.guide);
  }

  _buildFireworks() {
    const clusters = 5;
    const per = 90;
    const total = clusters * per;

    const pos = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const sizes = new Float32Array(total).fill(2.2);
    const seeds = new Float32Array(total);
    const dir = new Float32Array(total * 3);

    for (let i = 0; i < total; i++) {
      const i3 = i * 3;
      const phi = Math.acos(2 * Math.random() - 1);
      const th = Math.random() * Math.PI * 2;
      const sp = 0.55 + Math.random() * 0.7;
      dir[i3] = Math.sin(phi) * Math.cos(th) * sp;
      dir[i3 + 1] = Math.cos(phi) * sp * 0.85;
      dir[i3 + 2] = Math.sin(phi) * Math.sin(th) * sp;
      colors[i3] = 1;
      colors[i3 + 1] = 0.82;
      colors[i3 + 2] = 0.5;
      seeds[i] = Math.random();
      pos[i3 + 1] = -999;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.fire = {
      clusters, per, total,
      pos, dir,
      geo,
      points: new THREE.Points(geo, mat),
      unit: this.shape.baseRadius * 0.55,
    };
    this.fire.points.frustumCulled = false;
    this.fire.points.visible = false;
    this.world.add(this.fire.points);
  }

  // ---------------------------------------------------------------- 相机

  _buildCamera() {
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this._refit();
  }

  _refit() {
    const { height, floorY, baseRadius } = this.shape;
    const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const cam = frameCamera({
      fov: 42,
      aspect,
      yMin: floorY - 1,
      yMax: floorY + height + 3,
      halfW: baseRadius * 1.2,
    });
    this.camera.aspect = aspect;
    this.camera.position.set(0, cam.targetY, cam.distance);
    this.camera.lookAt(0, cam.targetY, 0);
    this.camera.updateProjectionMatrix();
    this.baseDistance = cam.distance;
    this.baseTargetY = cam.targetY;

    // 星尘盘：分布一点没动，只按画幅算一个整体缩放，保证整圈留在画面里
    this.dustTiltTarget = DUST_TILT_TARGET;
    this.dustThickness = height * 0.045;
    const maxDustR = baseRadius * 4.3;   // = _buildParticles 里 1.9+2.4 的上界
    // 盘半径别超过镜距的 42%：再大透视就把环拉成漏斗了（横屏尤其明显）
    const warpCap = (cam.distance * 0.42) / Math.cos(this.dustTiltTarget);
    const fit = fitDustRadius(
      { distance: cam.distance, targetY: cam.targetY, tanV: cam.tanV, aspect },
      {
        tilt: this.dustTiltTarget,
        thickness: this.dustThickness,
        marginBottom: 0.9,
        cap: Math.min(maxDustR, warpCap),
      },
    );
    this.dustScale = fit / maxDustR;
    this.dustFit = fit;
    this.dustCos = Math.cos(this.dustTiltTarget);   // 帧级的常量，别每帧再算
    this.dustSin = Math.sin(this.dustTiltTarget);
  }

  _buildComposer() {
    const { width, height } = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const b = this.cfg.bloom;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), b.strength, b.radius, b.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // ---------------------------------------------------------------- 覆盖层

  _buildOverlays() {
    this.flash = document.createElement('div');
    this.flash.id = 'intro-flash';
    document.body.appendChild(this.flash);

    this.fade = document.createElement('div');
    this.fade.id = 'intro-fade';
    document.body.appendChild(this.fade);

    this.textWrap = document.createElement('div');
    this.textWrap.id = 'intro-text';
    this.textWrap.innerHTML = '<div class="intro-silent"></div>'
      + '<div class="intro-cn">圣诞节快乐</div>'
      + '<div class="intro-sign">愿此夜长明</div>';
    document.body.appendChild(this.textWrap);

    const silent = this.textWrap.querySelector('.intro-silent');
    this.letters = [];
    for (const ch of 'Silent Night') {
      const span = document.createElement('span');
      span.textContent = ch === ' ' ? '\u00a0' : ch;
      span.className = 'intro-letter';
      silent.appendChild(span);
      this.letters.push(span);
    }
    this.cnLine = this.textWrap.querySelector('.intro-cn');
    this.signLine = this.textWrap.querySelector('.intro-sign');
  }

  // ---------------------------------------------------------------- 每帧

  update(dt) {
    if (this.done) return;
    this.time += dt;
    const t = this.time;
    this._step(t);
  }

  _step(t) {
    // 闪屏峰值处收尾：不再播回卷/定格/黑场，后面交给主场景的散开→重组
    if (t >= T.cutAt) {
      this.finished = true;
      this.done = true;
      return;
    }
    const n = this.count;
    const P = this.positions;
    const shape = this.shape;

    let sizeScale = 1;
    let mix = 0;
    let bright = 1;
    let alpha = 1;

    // --- 帧级的三角函数，只算一次 ---
    const spin = this._spin(t);                    // 星尘盘自转
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    // 圆环阶段：外沿高亮 + 轻微放大，让「圈」看得出来
    const rimK = t < T.gatherEnd
      ? clamp01((t - 0.6) / 0.5) * (1 - clamp01((t - 2.55) / 0.5))
      : 0;

    if (t < T.gatherEnd) {
      // A. 星尘汇聚：张开 + 自转 + 后段收缩，纯加减乘，无逐粒子三角函数
      const p = t / T.gatherEnd;
      // 张开：前 1.55 秒从横带转到环（这一下是"活的"，少了它就硬）
      const open = dustTiltAt(t, this.dustTiltTarget);
      const ct = Math.cos(open);
      const st = Math.sin(open);
      // 收缩留到最后 58% 才发生，环先完整地开出来
      // 环在 1.75s 完全张开，先完整停留 0.25s，再开始收缩（否则永远看不到完整的圆）
      const shrink = 1 - 0.42 * easeInOutCubic(clamp01((t - 2.0) / (T.gatherEnd - 2.0)));
      const sc = this.dustScale * shrink;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const x0 = this.dustX[i] * sc;
        const z0 = this.dustZ[i] * sc;
        const x = x0 * cs - z0 * sn;
        const z = x0 * sn + z0 * cs;
        const y0 = this.dustY[i] * (1 - 0.35 * p);
        P[i3] = x;
        P[i3 + 1] = y0 * ct - z * st;
        P[i3 + 2] = y0 * st + z * ct;
      }
      mix = 0;
      bright = 0.95 + 0.35 * p;
      sizeScale = 1 + 0.2 * rimK;
      this._guideOpen = open;
      this._guideScale = this.dustFit * shrink;
    } else if (t < T.riseEnd) {
      // B. 螺旋垒树：按高度分配延迟 + 全局额外旋转
      const p = shiftProgress(t, T.gatherEnd, T.riseEnd);
      const extra = (1 - easeOutCubic(p)) * Math.PI * 2;
      const ce = Math.cos(extra);
      const se = Math.sin(extra);
      const sc = this.dustScale * 0.58;           // 接住 A 段结束时的半径
      const ct = this.dustCos;
      const st = this.dustSin;

      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const delay = this.hf[i] * 0.55;
        const b = easeInOutCubic(clamp01((p - delay) / (1 - 0.55)));

        const x0 = this.dustX[i] * sc;
        const z0 = this.dustZ[i] * sc;
        const dx = x0 * cs - z0 * sn;
        const dz0 = x0 * sn + z0 * cs;
        const y0 = this.dustY[i];
        const dy = y0 * ct - dz0 * st;
        const dz = y0 * st + dz0 * ct;

        // 先在盘面上多绕一点，再落位
        const sx = dx * ce - dz * se;
        const sz = dx * se + dz * ce;

        P[i3] = sx + (this.treeX[i] - sx) * b;
        P[i3 + 1] = dy + (this.treeY[i] - dy) * b;
        P[i3 + 2] = sz + (this.treeZ[i] - sz) * b;
      }
      mix = easeOutCubic(clamp01((p - 0.55) / 0.45));
      bright = 0.9 + 0.4 * (1 - p);
    } else if (t < T.holdEnd) {
      // C/D. 树形 + 星芒 + 烟花（位置就是预存的树坐标）
      this._setTree();
      mix = 1;
      bright = 0.62;
      if (t < T.flashEnd + 0.55) {
        const f = starPulse(t);
        if (f > 0.01) {
          bright += f * 1.1;
          mix = Math.max(mix, f * 0.85);
        }
      }
      // 定格段缓慢自转交给 world 旋转
      this.world.rotation.y += 0.0015;
    } else if (t < T.implodeEnd) {
      // E. 内收蓄力
      const e = clamp01((t - T.holdEnd) / (T.implodeEnd - T.holdEnd));
      const s = 1 - 0.45 * e * e;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        P[i3] = this.treeX[i] * s;
        P[i3 + 1] = this.treeY[i] * s;
        P[i3 + 2] = this.treeZ[i] * s;
      }
      sizeScale = 1 + 0.18 * e;
      bright = 1 + 0.5 * e;
      mix = 1;
    } else if (t < T.burstEnd) {
      // F. 爆散冲击
      const e = clamp01((t - T.implodeEnd) / (T.burstEnd - T.implodeEnd));
      const d = burstOffset(e) * this.burstUnit;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const sc = this.bScale[i] * d;
        P[i3] = this.treeX[i] * 0.55 + this.bDir[i3] * sc;
        P[i3 + 1] = this.treeY[i] * 0.55 + this.bDir[i3 + 1] * sc;
        P[i3 + 2] = this.treeZ[i] * 0.55 + this.bDir[i3 + 2] * sc;
      }
      sizeScale = 1 + 2.4 * Math.pow(e, 1.35);
      bright = 1 + 0.5 * e;
      alpha = 1 - clamp01((e - 0.72) / 0.28) * 0.85;
      mix = 1;
      if (e > 0.72) bright += (1 - clamp01((e - 0.72) / 0.28)) * 0.4;
    } else if (t < T.blastEnd) {
      // G. 闪光期：粒子隐没，交给覆盖层
      this._setTree();
      alpha = 0;
      mix = 1;
    } else if (t < T.returnEnd) {
      // H. 回卷重组
      const e = easeOutCubic(clamp01((t - T.blastEnd) / (T.returnEnd - T.blastEnd)));
      const endD = burstOffset(1) * this.burstUnit;
      const sw = (1 - e) * 1.25;
      const cw = Math.cos(sw);
      const sw2 = Math.sin(sw);

      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const sc = this.bScale[i] * endD;
        const ex = this.treeX[i] * 0.55 + this.bDir[i3] * sc;
        const ey = this.treeY[i] * 0.55 + this.bDir[i3 + 1] * sc;
        const ez = this.treeZ[i] * 0.55 + this.bDir[i3 + 2] * sc;

        const x = ex * (1 - e) + this.treeX[i] * e;
        const z = ez * (1 - e) + this.treeZ[i] * e;

        P[i3] = x * cw - z * sw2;
        P[i3 + 1] = ey * (1 - e) + this.treeY[i] * e;
        P[i3 + 2] = x * sw2 + z * cw;
      }
      sizeScale = 1 + 2.4 * (1 - e);
      bright = 1;
      alpha = clamp01(e * 1.6);
      mix = 1;
    } else {
      // I. 定格 → 淡出
      this._setTree();
      mix = 1;
      bright = 0.62;
    }

    // 循环锚点：开头淡入、结尾淡出
    const fadeOut = clamp01((t - (T.fadeEnd - 0.75)) / 0.75);
    alpha *= clamp01(t / 0.55) * (1 - fadeOut);

    this.uniforms.uSizeScale.value = sizeScale;
    this.uniforms.uMix.value = mix;
    this.uniforms.uAlpha.value = alpha;
    this.uniforms.uBright.value = bright;
    this.uniforms.uTime.value = t;
    // 圆环阶段开启外沿高亮，进入垒树后关掉
    this.uniforms.uRim.value = rimK;

    if (this.guide) {
      const show = t < T.gatherEnd
        ? clamp01((t - 0.12) / 0.3) * (1 - clamp01((t - 2.95) / 0.25))
        : 0;
      this.guide.material.opacity = 0.95 * show;
      this.guide.rotation.x = -Math.PI / 2 + (this._guideOpen ?? DUST_TILT_TARGET);
      this.guide.scale.setScalar(this._guideScale || this.dustFit || 1);
    }
    this.uniforms.uK.value = this._pointK();

    this.geometry.attributes.position.needsUpdate = true;

    this._updateFireworks(t);
    this._updateCamera(t);
    this._updateText(t);
    this._updateFlash(t);

    if (starPulse(t) > 0.02) this.world.rotation.y += 0.0006;

    if (t >= INTRO_DURATION) {
      if (this.cfg.loop) this.time = 0;
      else this.done = true;
    }
  }

  _setTree() {
    const n = this.count;
    const P = this.positions;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      P[i3] = this.treeX[i];
      P[i3 + 1] = this.treeY[i];
      P[i3 + 2] = this.treeZ[i];
    }
  }

  _spin(t) {
    // 转速随进度平方加快
    const p = clamp01(t / T.gatherEnd);
    return (0.6 + 2.6 * p * p) * Math.min(t, T.gatherEnd) * 0.5;
  }

  _pointK() {
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    return this.renderer.domElement.height / (2 * tanV);
  }

  _updateCamera(t) {
    const dolly = 1 + 0.05 * Math.sin(clamp01(progress(t, 5.6, 6.35)) * Math.PI);
    const shakeP = progress(t, 12.05, 12.55);
    const shake = shakeP > 0 && shakeP < 1 ? 0.03 * Math.sin(shakeP * Math.PI) : 0;

    this.camera.position.z = this.baseDistance * dolly;
    this.camera.position.y = this.baseTargetY + Math.sin(t * 61) * shake * 8;
    this.camera.position.x = Math.cos(t * 47) * shake * 8;
    this.camera.lookAt(0, this.baseTargetY, 0);
  }

  _updateText(t) {
    const start = 6.35;
    const fadeOut = progress(t, 11.65, 12.0);   // 文档：12.00s 随爆散淡出
    this.textWrap.style.opacity = String(1 - fadeOut);
    this.textWrap.style.visibility = t >= start - 0.1 && t < 12.1 ? 'visible' : 'hidden';

    for (let i = 0; i < this.letters.length; i++) {
      const p = letterProgress(t, i, start);
      this.letters[i].style.clipPath = p >= 1 ? 'inset(0 -14% 0 0)' : `inset(0 ${(1 - p) * 100}% 0 0)`;
    }
    // 第一行写完之后再落第二、三行（+0.55s / +0.95s）
    const firstLineEnd = start + (this.letters.length - 1) * TEXT_LETTER_DELAY + TEXT_LETTER_DURATION;
    this.cnLine.style.opacity = String(letterProgress(t, 0, firstLineEnd + 0.55));
    this.signLine.style.opacity = String(letterProgress(t, 0, firstLineEnd + 0.95));
  }

  _updateFireworks(t) {
    const f = this.fire;
    const start = 6.2;
    const end = 8.4;
    if (t < start || t > end + 1.4) {
      f.points.visible = false;
      return;
    }
    f.points.visible = true;

    const unit = f.unit;
    for (let c = 0; c < f.clusters; c++) {
      const born = start + c * 0.44;
      const age = t - born;
      const base = c * f.per;
      const side = c % 2 === 0 ? -1 : 1;
      const cx = side * unit * (1.4 + (c * 0.7) % 2.2);
      const cy = unit * (1.9 + (c % 3) * 0.9);

      for (let k = 0; k < f.per; k++) {
        const idx = (base + k) * 3;
        if (age < 0) { f.pos[idx + 1] = -999; continue; }
        const spread = 1 - Math.exp(-3.2 * age);
        const travel = spread * age * unit * 1.5;
        f.pos[idx] = cx + f.dir[idx] * travel;
        f.pos[idx + 1] = cy + f.dir[idx + 1] * travel - 4.5 * age * age * unit * 0.12;
        f.pos[idx + 2] = f.dir[idx + 2] * travel;
      }
    }
    f.geo.attributes.position.needsUpdate = true;
  }

  _updateFlash(t) {
    this.flash.style.opacity = String(this._flashValue(t));
    this.fade.style.opacity = String(progress(t, 15.1, 15.85));
  }

  _flashValue(t) {
    const p = progress(t, 12.1, 12.55);
    if (p <= 0 || p >= 1) return 0;
    return Math.sin(p * Math.PI) * 0.92;
  }

  // ---------------------------------------------------------------- 渲染

  render() {
    this.composer.render();
  }

  resize() {
    this._refit();
    const { width, height } = this.renderer.getSize(new THREE.Vector2());
    this.composer.setSize(width, height);
  }

  dispose() {
    this.world.remove(this.points);
    this.geometry.dispose();
    this.points.material.dispose();
    if (this.guide) {
      this.world.remove(this.guide);
      this.guide.geometry.dispose();
      this.guide.material.map?.dispose();
      this.guide.material.dispose();
    }
    this.world.remove(this.fire.points);
    this.fire.geo.dispose();
    this.fire.points.material.dispose();
    this.composer.dispose?.();
    this.flash.remove();
    this.fade.remove();
    this.textWrap.remove();
  }
}

/** 让 t 在 [a,b] 之间映射成 0~1 */
function shiftProgress(t, a, b) {
  return clamp01((t - a) / (b - a));
}
