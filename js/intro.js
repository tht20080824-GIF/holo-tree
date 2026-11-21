/**
 * 16 秒开场动画：星尘汇聚 → 螺旋垒树 → 塔尖炸光 → 烟花 + 文字 →
 * 定格 → 内收蓄力 → 爆散冲击 → 闪光 → 回卷重组 → 淡出循环。
 *
 * 实现要点（对应 02-开场动画-提示词.md）：
 * - 单个 Points + 单个 BufferGeometry，一次 draw call
 * - 所有时间轴计算在 CPU 上做，只更新 position 属性，绝不重建几何体
 * - 取景用 intro-math.frameCamera 按可用矩形反算，任何画幅不裁切
 * - 文字是 HTML 覆盖层（逐字 clip-path），不是 3D 文字
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
  dustRadius,
  dustSpin,
  dustPoint,
  DUST_TILT,
  frameCamera,
  letterProgress,
  TEXT_LETTER_DELAY,
} from './intro-math.js';

const GOLD = { r: 1.0, g: 0.79, b: 0.44 };

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPointScale;
  uniform float uBright;
  uniform float uMix;
  uniform float uSizeScale;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uSizeScale * uPointScale / max(0.06, -mv.z), 1.0, 128.0);

    vec3 gold = vec3(${GOLD.r.toFixed(3)}, ${GOLD.g.toFixed(3)}, ${GOLD.b.toFixed(3)});
    vColor = mix(gold, aColor, uMix) * uBright;
    vAlpha = 1.0;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float dist = length(d);
    if (dist > 0.5) discard;
    float falloff = smoothstep(0.5, 0.02, dist);
    gl_FragColor = vec4(vColor, falloff * vAlpha);
  }
`;

export class IntroSequence {
  constructor({ shape, cfg, renderer }) {
    this.cfg = cfg;
    this.renderer = renderer;
    this.time = 0;
    this.done = false;
    this.skipped = false;

    this.count = cfg.count;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    this._buildParticles(shape);
    this._buildFireworks();
    this._buildCamera(shape);
    this._buildComposer();
    this._buildOverlays();
  }

  // ---------------------------------------------------------------- 粒子

  _buildParticles(shape) {
    const n = this.count;
    const { height, floorY, baseRadius } = shape;

    this.dust = new Float32Array(n * 4);   // angle, radiusFactor, thickness, spinOffset
    this.tree = new Float32Array(n * 3);
    this.burst = new Float32Array(n * 3);
    this.seed = new Float32Array(n);
    this.heightFactor = new Float32Array(n);

    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);

    const palette = [
      [0.12, 0.55, 0.34],
      [0.18, 0.75, 0.45],
      [1.0, 0.82, 0.48],
      [1.0, 0.23, 0.36],
      [1.0, 1.0, 1.0],
    ];

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;

      // --- 星尘盘 ---
      this.dust[i * 4] = Math.random() * Math.PI * 2;
      this.dust[i * 4 + 1] = 0.55 + Math.random() * 0.45;
      this.dust[i * 4 + 2] = Math.random() - 0.5;   // 垂直抖动，预存，别每帧随机
      this.dust[i * 4 + 3] = Math.random() * 0.4;

      // --- 树位置：yf = 1 - sqrt(rand)，底部更密 ---
      const yf = 1 - Math.sqrt(Math.random());
      const t = 1 - yf;
      const spiral = Math.random() < 0.32;
      const angle = spiral
        ? t * 6.5 * Math.PI * 2 + (Math.random() - 0.5) * 0.6
        : Math.random() * Math.PI * 2;
      const rFrac = spiral ? 0.86 + Math.random() * 0.22 : Math.pow(Math.random(), 0.6);
      const r = shape.baseRadius * Math.pow(1 - t, 0.88) * rFrac * (0.9 + Math.random() * 0.2);

      this.tree[i3] = Math.cos(angle) * r;
      this.tree[i3 + 1] = floorY + height * t;
      this.tree[i3 + 2] = Math.sin(angle) * r;
      this.heightFactor[i] = t;

      // --- 爆散方向：朝外，带一点朝镜头的 z ---
      const len = Math.hypot(this.tree[i3], this.tree[i3 + 2]) || 1;
      this.burst[i3] = this.tree[i3] / len;
      this.burst[i3 + 1] = (Math.random() - 0.35) * 0.7;
      this.burst[i3 + 2] = this.tree[i3 + 2] / len * 0.7 + 0.55;

      this.seed[i] = Math.random() * 100;
      sizes[i] = 0.7 + Math.random() * 0.9;

      const c = palette[Math.floor(Math.random() * palette.length)];
      colors[i3] = c[0];
      colors[i3 + 1] = c[1];
      colors[i3 + 2] = c[2];

      // 初始就在星尘盘上
      const p = dustPoint(
        this.dust[i * 4],
        dustRadius(0, baseRadius) * this.dust[i * 4 + 1],
        0.6,
        this.dust[i * 4 + 2],
      );
      positions[i3] = p.x;
      positions[i3 + 1] = p.y;
      positions[i3 + 2] = p.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 80);

    this.uniforms = {
      uPointScale: { value: 900 },
      uBright: { value: 1 },
      uMix: { value: 0 },
      uSizeScale: { value: 1 },
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
    this.scene.add(this.points);
    this.positions = positions;
    this.geometry = geo;
  }

  _buildFireworks() {
    const clusters = 5;
    const perCluster = 90;
    const total = clusters * perCluster;
    const pos = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3).fill(1);
    const sizes = new Float32Array(total).fill(1.6);

    this.fire = {
      clusters,
      perCluster,
      total,
      pos,
      vel: new Float32Array(total * 3),
      life: new Float32Array(total),
      geo: null,
      points: null,
    };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.fire.geo = geo;
    this.fire.points = new THREE.Points(geo, mat);
    this.fire.points.frustumCulled = false;
    this.fire.points.visible = false;
    this.scene.add(this.fire.points);
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

  _buildCamera(shape) {
    this.camera = new THREE.PerspectiveCamera(44, 1, 0.1, 400);
    this.shape = shape;
    this._refit();
  }

  _refit() {
    const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const cam = frameCamera({
      fov: 44,
      aspect,
      yMin: this.shape.floorY - 1,
      yMax: this.shape.floorY + this.shape.height + 4,
      halfW: this.shape.baseRadius * 1.25,
    });
    this.camera.aspect = aspect;
    this.camera.position.set(0, cam.targetY, cam.distance);
    this.camera.lookAt(0, cam.targetY, 0);
    this.camera.updateProjectionMatrix();
    this.baseDistance = cam.distance;
    this.baseTargetY = cam.targetY;
  }

  // ---------------------------------------------------------------- 覆盖层

  _buildOverlays() {
    // 闪光层
    this.flash = document.createElement('div');
    this.flash.id = 'intro-flash';
    document.body.appendChild(this.flash);

    // 文字层
    this.textWrap = document.createElement('div');
    this.textWrap.id = 'intro-text';
    this.textWrap.innerHTML = `
      <div class="intro-merry"></div>
      <div class="intro-cn">圣诞快乐</div>
    `;
    document.body.appendChild(this.textWrap);

    const merry = this.textWrap.querySelector('.intro-merry');
    const word = 'Merry Christmas';
    this.letters = [];
    for (const ch of word) {
      const span = document.createElement('span');
      span.textContent = ch === ' ' ? '\\u00a0' : ch;
      span.className = 'intro-letter';
      merry.appendChild(span);
      this.letters.push(span);
    }
    this.cnLine = this.textWrap.querySelector('.intro-cn');
  }

  // ---------------------------------------------------------------- 帧更新

  update(dt) {
    if (this.done) return;
    this.time += dt;
    const t = this.time;

    const shape = this.shape;
    const n = this.count;
    const pos = this.positions;

    // --- 阶段参数 ---
    const buildP = progress(t, 3.2, 5.6);
    const explodeP = progress(t, 10.55, 12.1);
    const rewindP = progress(t, 12.55, 14.6);
    const compressP = progress(t, 10.3, 10.55);

    this.uniforms.uMix.value = easeOutCubic(progress(t, 3.2, 5.4));
    this.uniforms.uBright.value = this._brightness(t);
    this.uniforms.uPointScale.value = this._pointScale();
    this.uniforms.uSizeScale.value = this._sizeScale(t);

    const spin = this._spinAccum(t);
    const dustR = dustRadius(buildP, shape.baseRadius);

    const burstLen = burstOffset(1);
    const rewindEase = easeInOutCubic(rewindP);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const hf = this.heightFactor[i];

      // 各阶段的"目标"位置
      const dustP = dustPoint(
        this.dust[i * 4] + spin + this.dust[i * 4 + 3],
        dustR * this.dust[i * 4 + 1],
        0.6,
        this.dust[i * 4 + 2],
      );

      // 垒树：按高度分配延迟，底部先落位
      const delay = hf * 0.55;
      const localBuild = clamp01((buildP - delay) / (1 - 0.55));
      const b = easeInOutCubic(localBuild);

      // 多绕约一圈后落位
      const extraTurn = (1 - b) * Math.PI * 2;
      const cosA = Math.cos(extraTurn);
      const sinA = Math.sin(extraTurn);
      const tx = this.tree[i3] * cosA - this.tree[i3 + 2] * sinA;
      const tz = this.tree[i3] * sinA + this.tree[i3 + 2] * cosA;

      let x;
      let y;
      let z;
      if (t < 3.2) {
        x = dustP.x;
        y = dustP.y;
        z = dustP.z;
      } else if (t < 10.55) {
        x = dustP.x + (tx - dustP.x) * b;
        y = dustP.y + (this.tree[i3 + 1] - dustP.y) * b;
        z = dustP.z + (tz - dustP.z) * b;

        if (compressP > 0) {
          const k = 1 - 0.45 * easeInOutCubic(compressP);
          x *= k;
          y = (y - shape.floorY) * k + shape.floorY;
          z *= k;
        }
      } else if (t < 12.55) {
        // 爆散：位移 = burstOffset(e)，先缓后猛
        const off = burstOffset(explodeP);
        x = this.tree[i3] + this.burst[i3] * off;
        y = this.tree[i3 + 1] + this.burst[i3 + 1] * off;
        z = this.tree[i3 + 2] + this.burst[i3 + 2] * off;
      } else {
        // 回卷：从爆散终点旋回树形，角度衰减 1.25 rad
        const off = burstLen * (1 - rewindEase);
        const decay = 1.25 * (1 - rewindEase);
        const bx = this.burst[i3] * Math.cos(decay) - this.burst[i3 + 2] * Math.sin(decay);
        const bz = this.burst[i3] * Math.sin(decay) + this.burst[i3 + 2] * Math.cos(decay);
        x = this.tree[i3] + bx * off;
        y = this.tree[i3 + 1] + this.burst[i3 + 1] * off;
        z = this.tree[i3 + 2] + bz * off;
      }

      pos[i3] = x;
      pos[i3 + 1] = y;
      pos[i3 + 2] = z;
    }

    this.geometry.attributes.position.needsUpdate = true;

    this._updateFireworks(t);
    this._updateCamera(t);
    this._updateText(t);
    this._updateFlash(t);

    // 淡出黑场 → 循环 / 结束
    const fade = progress(t, 15.1, 15.85);
    this.flash.style.opacity = String(Math.max(this._flashValue(t), fade * 0.9));

    if (t >= INTRO_DURATION) {
      if (this.cfg.loop) {
        this.time = 0;
      } else {
        this.done = true;
      }
    }
  }

  /** 爆散时粒子放大到 3.4 倍；回卷过程中收回 1 倍 */
  _sizeScale(t) {
    if (t < 10.55) return 1;
    if (t < 12.1) return 1 + 2.4 * easeInOutCubic(progress(t, 10.55, 12.1));
    if (t < 12.55) return 3.4;
    return 3.4 - 2.4 * easeInOutCubic(progress(t, 12.55, 14.6));
  }

  _brightness(t) {
    if (t < 5.6) return 1;
    if (t < 6.2) return 1 + 2.2 * starPulse(t);
    if (t < 8.4) return 1;
    if (t < 10.3) return 0.62;               // 定格压亮度，防止加色过曝
    if (t < 10.55) return 0.62 + 1.1 * easeInOutCubic(progress(t, 10.3, 10.55));
    return 1.35;
  }

  _flashValue(t) {
    const p = progress(t, 12.1, 12.55);
    if (t < 12.1 || t > 12.55) return 0;
    return Math.sin(p * Math.PI) * 0.92;
  }

  _spinAccum(t) {
    // 转速随进度平方加快
    const p = clamp01(t / 3.2);
    return dustSpin(p) * Math.min(t, 3.2) * 0.5;
  }

  _pointScale() {
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const dpr = this.renderer.getPixelRatio();
    return (window.innerHeight * dpr * 0.12) / (2 * tanV);
  }

  _updateCamera(t) {
    // 5.6–6.35 后拉 5%，12.05–12.55 震动 0.03
    const dolly = 1 + 0.05 * Math.sin(clamp01(progress(t, 5.6, 6.35)) * Math.PI);
    const shakeP = progress(t, 12.05, 12.55);
    const shake = shakeP > 0 && shakeP < 1 ? 0.03 * Math.sin(shakeP * Math.PI) : 0;

    this.camera.position.z = this.baseDistance * dolly;
    this.camera.position.y = this.baseTargetY + Math.sin(t * 61) * shake;
    this.camera.position.x = Math.cos(t * 47) * shake;
    this.camera.lookAt(0, this.baseTargetY, 0);
  }

  _updateText(t) {
    const start = 6.35;
    const fadeOut = progress(t, 11.6, 12.05);
    this.textWrap.style.opacity = String(1 - fadeOut);

    const show = t >= start - 0.1 && t < 12.1;
    this.textWrap.style.visibility = show ? 'visible' : 'hidden';

    for (let i = 0; i < this.letters.length; i++) {
      const p = letterProgress(t, i, start);
      this.letters[i].style.clipPath = p >= 1 ? 'inset(0 -14% 0 0)' : `inset(0 ${(1 - p) * 100}% 0 0)`;
    }
    const cnP = letterProgress(t, 0, start + 0.9);
    this.cnLine.style.opacity = String(clamp01(cnP));
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

    // 5 簇，左右交替，每 0.44s 一簇
    for (let c = 0; c < f.clusters; c++) {
      const born = start + c * 0.44;
      const age = t - born;
      const base = c * f.perCluster;
      if (age < 0) {
        for (let k = 0; k < f.perCluster; k++) f.pos[(base + k) * 3 + 1] = -999;
        continue;
      }
      const side = c % 2 === 0 ? -1 : 1;
      const cx = side * (4 + (c * 2.1) % 5);
      const cy = 6 + (c % 3) * 3.2;

      for (let k = 0; k < f.perCluster; k++) {
        const idx = (base + k) * 3;
        if (age < 0.02) {
          const phi = Math.acos(2 * Math.random() - 1);
          const th = Math.random() * Math.PI * 2;
          const sp = 3.2 + Math.random() * 4.2;
          f.vel[idx] = Math.sin(phi) * Math.cos(th) * sp;
          f.vel[idx + 1] = Math.cos(phi) * sp * 0.85;
          f.vel[idx + 2] = Math.sin(phi) * Math.sin(th) * sp;
        }
        const spread = 1 - Math.exp(-3.2 * age);
        f.pos[idx] = cx + f.vel[idx] * spread * age * 1.1;
        f.pos[idx + 1] = cy + f.vel[idx + 1] * spread * age - 4.5 * age * age;
        f.pos[idx + 2] = f.vel[idx + 2] * spread * age;
      }
    }
    f.geo.attributes.position.needsUpdate = true;
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
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.points.material.dispose();
    this.composer.dispose?.();
    this.flash.remove();
    this.textWrap.remove();
  }
}
