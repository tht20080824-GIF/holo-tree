/**
 * 3D 场景：粒子圣诞树 + 装饰球 + 照片云 + 雪 + 辉光。
 *
 * 设计取舍：
 * - 树身用 InstancedMesh 而不是 Points：需要每颗粒子独立颜色、缩放和旋转，
 *   且 1600 个实例只需要一次 draw call，笔记本核显也稳。
 * - "合拢态"和"散开态"是两套预先算好的目标坐标，每帧朝目标做指数插值。
 *   好处是不用物理引擎，快且绝不会炸；代价是没有碰撞，但这个场景不需要。
 * - 所有视觉参数都在 config.js 里，scene 只消费不改。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { CONFIG } from './config.js';
import { buildTreeLayout, sampleShell } from './layout.js';
import { heartPoints } from './heart.js';
import { ZODIAC, zodiacIndexOf } from './zodiac.js';
import { VORTEX, createRiseVortex, vortexPoint, vortexAlpha, vortexDone } from './vortex.js';
import {
  HEART_DISSOLVE,
  createHeartDissolve,
  dissolveOffset,
  dissolveAlpha,
  dissolveSize,
  dissolveDarken,
  smoothstep as dissolveSmooth,
} from './heart-dissolve.js';
import { createRibbon } from './ribbon.js';
import { ribbonRevealAt, ribbonPoint, RIBBON_TURNS } from './ribbon-math.js';
import { giftShape, bowShape, placeShape } from './ornament-shapes.js';
import { placeOrnaments, makeScatterPoint } from './ornament-math.js';
import { MODE } from './gesture.js';

const TMP_OBJ = new THREE.Object3D();
const TMP_COLOR = new THREE.Color();

function radialTexture(inner, outer, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 聚焦时的描边光效：画一个带辉光的圆角方框 */
function frameGlowTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const inset = size * 0.1;
  const r = size * 0.04;

  ctx.strokeStyle = 'rgba(255, 214, 140, 0.95)';
  ctx.lineWidth = size * 0.016;
  ctx.shadowColor = 'rgba(255, 170, 70, 0.95)';
  ctx.shadowBlur = size * 0.06;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, r);
  } else {
    ctx.rect(inset, inset, size - inset * 2, size - inset * 2);
  }
  ctx.stroke();
  ctx.stroke(); // 描两遍，辉光更实

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 没有上传照片时，程序生成的节日装饰图（省得默认一片空白） */
function ornamentTexture(kind) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#0d3a26');
  bg.addColorStop(1, '#04160e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#e8c879';
  ctx.lineWidth = 6;
  ctx.strokeRect(14, 14, size - 28, size - 28);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (kind === 0) {
    ctx.fillStyle = '#ffd27a';
    ctx.font = 'bold 40px Georgia, serif';
    ctx.fillText('MERRY', size / 2, size / 2 - 28);
    ctx.fillText('XMAS', size / 2, size / 2 + 24);
  } else if (kind === 1) {
    // 雪花
    ctx.strokeStyle = '#cfe9ff';
    ctx.lineWidth = 5;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2);
      ctx.lineTo(size / 2 + Math.cos(a) * 88, size / 2 + Math.sin(a) * 88);
      ctx.stroke();
    }
  } else {
    // 马赛克灯点
    const colors = ['#ff3b5c', '#3fe08c', '#ffd27a', '#7ec8ff'];
    for (let i = 0; i < 46; i++) {
      ctx.fillStyle = colors[i % colors.length];
      const r = 4 + Math.random() * 7;
      ctx.beginPath();
      ctx.arc(24 + Math.random() * (size - 48), 24 + Math.random() * (size - 48), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class HoloTree {
  constructor(container, cfg = CONFIG) {
    this.cfg = cfg;
    this.container = container;
    this.mode = MODE.TREE;
    this.time = 0;
    this.textActive = false;

    // 相框交互
    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this.photos = [];
    this.hovered = null;

    // 照片聚焦（飞到镜头前）状态
    this.focus = { node: null, t: 0, closing: false };

    this._initRenderer();
    this._initScene();
    this._initParticles();
    this._initTextPoints();
    this._initRibbon();
    this._initOrnaments();
    this._initDecor();
    this._initSnow();
    this._initStar();
    this._initBurst();
    this._initComposer();

  }

  // ---------------------------------------------------------------- setup

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.cfg.quality.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    const { camera: camCfg, palette } = this.cfg;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(palette.bg);
    this.scene.fog = new THREE.Fog(palette.bg, 52, 110);

    this.camera = new THREE.PerspectiveCamera(camCfg.fov, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, 1.6, camCfg.baseDistance);
    this.camera.lookAt(0, 0.4, 0);

    // 金属装饰球、金色相框要反射环境才好看
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.55));

    const key = new THREE.DirectionalLight(0xfff0d0, 2.1);
    key.position.set(9, 14, 8);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x2f7bff, 1.4);
    rim.position.set(-12, -4, -10);
    this.scene.add(rim);

    // 树整体绕原点转，雪和地面不跟着转
    this.treeRoot = new THREE.Group();
    this.scene.add(this.treeRoot);

    // 舞台光晕
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture('rgba(70,240,170,0.55)', 'rgba(20,90,60,0.18)', 512),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.4,
    }));
    glow.scale.set(40, 40, 1);
    glow.position.set(0, this.cfg.particles.floorY - 2, 0);
    this.scene.add(glow);

    // 聚焦照片时的背景压暗层：放在照片更远处，只压暗树和粒子，不压照片
    this.dimPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x03060a, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.dimPlane.visible = false;
    this.scene.add(this.dimPlane);
  }

  _initParticles() {
    const { count } = this.cfg.particles;
    const { palette } = this.cfg;

    const geometry = new THREE.IcosahedronGeometry(0.085, 0);
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.5,
      roughness: 0.35,
      envMapIntensity: 1.3,
      transparent: true,   // 文字阶段需要用它淡出
      opacity: 1,
    });

    this.particles = new THREE.InstancedMesh(geometry, material, count);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.frustumCulled = false;

    // 形状算法在 layout.js 里，可单测
    const layout = buildTreeLayout(count, this.cfg.particles);
    this.treeTarget = layout.tree;
    this.scatterTarget = layout.scatter;
    this.seed = layout.seed;
    this.size = layout.size;
    this.pos = new Float32Array(this.treeTarget); // 从合拢态开始

    const goldChance = 0.26;
    const redChance = 0.1;
    const whiteChance = 0.06;

    for (let i = 0; i < count; i++) {
      const roll = Math.random();
      let hex;
      if (roll < whiteChance) hex = 0xffffff;
      else if (roll < whiteChance + redChance) hex = palette.red[(Math.random() * palette.red.length) | 0];
      else if (roll < whiteChance + redChance + goldChance) hex = palette.gold[(Math.random() * palette.gold.length) | 0];
      else hex = palette.green[(Math.random() * palette.green.length) | 0];

      TMP_COLOR.setHex(hex);
      this.particles.setColorAt(i, TMP_COLOR);
      TMP_OBJ.position.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      TMP_OBJ.updateMatrix();
      this.particles.setMatrixAt(i, TMP_OBJ.matrix);
    }

    this.particles.instanceColor.needsUpdate = true;
    this.treeRoot.add(this.particles);
  }

  _initTextPoints() {
    // 文字用高密度粒子：树身只有 1600 颗，铺字不够密
    const n = this.cfg.particles.count >= 1500 ? 14000 : 9000;
    this.textKind = 'text';      // 'text' | 'heart'
    this.heartState = null;
    this._heartT = 0;
    this.textCount = n;
    this.textPhase = 'idle';
    this.textT = 0;
    this.textActive = false;
    this._treeOpacity = 1;
    this._treeOpacityTarget = 1;

    this.textPos = new Float32Array(n * 3);
    this.textFrom = new Float32Array(n * 3);
    this.textGoal = new Float32Array(n * 3);
    this.textTo = new Float32Array(n * 3);

    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      colors[i * 3] = 1.0;
      colors[i * 3 + 1] = 0.78 + 0.16 * t;
      colors[i * 3 + 2] = 0.38 + 0.3 * t;
    }

    this.textGeometry = new THREE.BufferGeometry();
    this.textGeometry.setAttribute('position', new THREE.BufferAttribute(this.textPos, 3));
    this.textGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.textGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

    const mat = new THREE.PointsMaterial({
      size: 0.045,
      map: radialTexture('rgba(255,246,220,1)', 'rgba(255,190,90,0.35)', 128),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      toneMapped: false,
      sizeAttenuation: true,
    });
    this.textPoints = new THREE.Points(this.textGeometry, mat);
    this.textPoints.visible = false;
    this.textPoints.frustumCulled = false;
    this.scene.add(this.textPoints);

    this._initHeartDissolve();
    this._initVortex();
  }

  /**
   * 收尾漩涡：一段从画面下方转上来的粒子，作为「散开 → 聚拢」之间的过渡。
   * 和主场景一样挂在 scene 下（不跟 treeRoot 转），用加色混合 + 径向贴图。
   */
  _initVortex() {
    const n = this.cfg.vortex?.count ?? VORTEX.count;
    this._vortexN = n;
    this.vortexField = createRiseVortex(n, {
      ...VORTEX,
      ...this.cfg.vortex,
      floorY: this.cfg.particles.floorY,
    });
    this._vortexPos = new Float32Array(n * 3);
    this._vortexCol = new Float32Array(n * 3);
    this._vortexT = 0;
    this._vortexOn = false;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._vortexPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this._vortexCol, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

    const mat = new THREE.PointsMaterial({
      size: 0.16,
      map: radialTexture('rgba(255,246,220,1)', 'rgba(255,180,80,0.35)', 128),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      toneMapped: false,
      sizeAttenuation: true,
    });

    this.vortexPoints = new THREE.Points(geo, mat);
    this.vortexPoints.visible = false;
    this.vortexPoints.frustumCulled = false;
    this.scene.add(this.vortexPoints);
  }

  /** 开始播放收尾漩涡 */
  startVortex() {
    this._vortexT = 0;
    this._vortexOn = true;
    this.vortexPoints.visible = true;
  }

  _updateVortex(dt) {
    if (!this._vortexOn) return;
    this._vortexT += dt;
    const t = this._vortexT;
    const f = this.vortexField;
    const pos = this._vortexPos;
    const col = this._vortexCol;
    const out = this._vortexTmp || (this._vortexTmp = new Float32Array(3));

    for (let i = 0; i < this._vortexN; i++) {
      const i3 = i * 3;
      const on = vortexPoint(f, i, t, out);
      const a = on ? vortexAlpha(f, i, t) : 0;
      if (!on) {
        pos[i3] = 0;
        pos[i3 + 1] = -999;
        pos[i3 + 2] = 0;
        col[i3] = col[i3 + 1] = col[i3 + 2] = 0;
        continue;
      }
      pos[i3] = out[0];
      pos[i3 + 1] = out[1];
      pos[i3 + 2] = out[2];
      const b = a * (0.85 + f.size[i] * 0.3);
      col[i3] = 1.0 * b;
      col[i3 + 1] = 0.78 * b;
      col[i3 + 2] = 0.42 * b;
    }

    this.vortexPoints.geometry.attributes.position.needsUpdate = true;
    this.vortexPoints.geometry.attributes.color.needsUpdate = true;

    if (vortexDone(t, f.cfg)) {
      this._vortexOn = false;
      this.vortexPoints.visible = false;
    }
  }

  /**
   * 文字 / 爱心消散的专用渲染层：3 倍顶点（本体 + 2 个鬼影），
   * 每颗粒子独立颜色 / 透明度 / 尺寸，所以能做出「丝带拉丝」和「化尘」。
   *
   * 为什么不用 PointsMaterial：它只支持全局 size 和 opacity，
   * 做不到「边缘先暗、中心后暗」「远的更小」「余烬单独闪烁」。
   */
  _initHeartDissolve() {
    const n = this.textCount;
    const verts = n * 3;
    this._heartVerts = verts;
    this._heartPos = new Float32Array(verts * 3);
    this._heartCol = new Float32Array(verts * 3);
    this._heartAlpha = new Float32Array(verts);
    this._heartSize = new Float32Array(verts);
    this._off = [new Float32Array(3), new Float32Array(3), new Float32Array(3)];
    this._offGhost = [new Float32Array(3), new Float32Array(3)];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._heartPos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this._heartCol, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._heartAlpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._heartSize, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: radialTexture('rgba(255,246,220,1)', 'rgba(255,150,70,0.38)', 128) },
        uScale: { value: 600 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSize;
        uniform float uScale;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, aSize * uPixelRatio * (uScale / -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor, tex.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const size = this.renderer.getSize(new THREE.Vector2());
    mat.uniforms.uScale.value = size.y * 0.5;

    this.heartMaterial = mat;
    this.heartPoints = new THREE.Points(geo, mat);
    this.heartPoints.visible = false;
    this.heartPoints.frustumCulled = false;
    this.scene.add(this.heartPoints);
  }

  /** 环绕光带：挂在 treeRoot 下，这样手势转向时会跟着一起转 */
  _initRibbon() {
    const { height, floorY, radius } = this.cfg.particles;
    this.ribbon = createRibbon({
      count: this.cfg.ribbon.count,
      height,
      floorY,
      baseRadius: radius,
      colorA: this.cfg.ribbon.colorA,
      colorB: this.cfg.ribbon.colorB,
    });
    this.treeRoot.add(this.ribbon.points);

    this._ribbonOpacity = 1; // 散开态时淡出
    this._ribbonReveal = 1;  // 光带生长进度（0=没有，1=长到顶）
    this._ribbonGrowing = false;
    this._ribbonGrowT = 0;
    this._starFlash = 0;
    this._camBlend = null;   // 开场交棒时的机位过渡

    // 接回流程锁：散开 → 聚合 这段不接受任何用户输入
    this.restoring = false;
    this._restoreDoneAt = 0;
  }

  /**
   * 圣诞装饰：用**和树身完全相同的粒子**拼出礼盒与蝴蝶结。
   *
   * 关键点：
   * - 复用 this.particles 的 geometry / material（材质真正同步，不是模仿）
   * - 每个装饰粒子有 home（拼形状）和 scatter（散开位置）两套坐标
   * - 合拢时 lerp 到 home，散开时 lerp 到 scatter —— 和树身粒子同一套缓动
   */
  _initOrnaments() {
    const { height, floorY, radius } = this.cfg.particles;
    const cfg = this.cfg.ornaments;

    const giftSpots = placeOrnaments({
      count: cfg.gifts,
      height, floorY, baseRadius: radius,
      tMin: 0.18, tMax: 0.56, clearance: 1.18,
    });

    const bowSpots = placeOrnaments({
      count: cfg.bows,
      height, floorY, baseRadius: radius,
      tMin: 0.44, tMax: 0.86, clearance: cfg.bowClearance,
    });

    const points = [];
    for (const spot of giftSpots) {
      const shape = giftShape(cfg.giftSize * spot.scale, Math.random, cfg.density);
      points.push(...placeShape(shape, spot));
    }
    for (const spot of bowSpots) {
      const shape = bowShape(cfg.bowSize * spot.scale, Math.random, cfg.density);
      points.push(...placeShape(shape, spot));
    }

    const count = points.length;
    const mesh = new THREE.InstancedMesh(this.particles.geometry, this.particles.material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    this.ornamentHome = new Float32Array(count * 3);
    this.ornamentScatter = new Float32Array(count * 3);
    this.ornamentPos = new Float32Array(count * 3);
    this.ornamentSeed = new Float32Array(count);
    this.ornamentSize = new Float32Array(count);

    points.forEach((p, i) => {
      const i3 = i * 3;
      this.ornamentHome[i3] = p.x;
      this.ornamentHome[i3 + 1] = p.y;
      this.ornamentHome[i3 + 2] = p.z;

      this.ornamentPos[i3] = p.x;
      this.ornamentPos[i3 + 1] = p.y;
      this.ornamentPos[i3 + 2] = p.z;

      const scatter = makeScatterPoint();
      this.ornamentScatter[i3] = scatter.x;
      this.ornamentScatter[i3 + 1] = scatter.y;
      this.ornamentScatter[i3 + 2] = scatter.z;

      this.ornamentSeed[i] = Math.random() * 100;
      this.ornamentSize[i] = p.size;

      TMP_COLOR.setHex(p.color);
      mesh.setColorAt(i, TMP_COLOR);
    });
    mesh.instanceColor.needsUpdate = true;

    this.ornamentMesh = mesh;
    this.ornamentCount = count;
    this.treeRoot.add(mesh);
  }

  /** 装饰粒子的每帧运动：和树身粒子同一套指数插值 */
  _updateOrnaments(dt, t) {
    if (!this.ornamentMesh) return;

    const target = this.mode === MODE.TREE ? this.ornamentHome : this.ornamentScatter;
    const stiffness = this.mode === MODE.TREE ? 3.6 : 2.1;
    const k = 1 - Math.exp(-stiffness * dt);

    for (let i = 0; i < this.ornamentCount; i++) {
      const i3 = i * 3;
      const noise = Math.sin(t * 1.3 + this.ornamentSeed[i]) * 0.06;

      this.ornamentPos[i3] += (target[i3] - this.ornamentPos[i3]) * k;
      this.ornamentPos[i3 + 1] += (target[i3 + 1] - this.ornamentPos[i3 + 1]) * k + noise * 0.02;
      this.ornamentPos[i3 + 2] += (target[i3 + 2] - this.ornamentPos[i3 + 2]) * k;

      TMP_OBJ.position.set(this.ornamentPos[i3], this.ornamentPos[i3 + 1], this.ornamentPos[i3 + 2]);
      TMP_OBJ.rotation.set(
        this.ornamentSeed[i] * 6 + t * (this.mode === MODE.TREE ? 0.15 : 0.9),
        this.ornamentSeed[i] * 3,
        0,
      );
      TMP_OBJ.scale.setScalar(
        this.ornamentSize[i] * (0.85 + 0.22 * Math.sin(t * 2.2 + this.ornamentSeed[i])),
      );
      TMP_OBJ.updateMatrix();
      this.ornamentMesh.setMatrixAt(i, TMP_OBJ.matrix);
    }
    this.ornamentMesh.instanceMatrix.needsUpdate = true;
  }

  _initDecor() {
    this.decor = new THREE.Group();
    this.treeRoot.add(this.decor);

    const { floorY } = this.cfg.particles;
    const height = this.cfg.particles.height;
    const radius = this.cfg.particles.radius;

    // 程序生成的 6 张装饰图，摆成照片云
    for (let i = 0; i < this.cfg.photos.defaultCount; i++) {
      const t = 0.18 + (i / this.cfg.photos.defaultCount) * 0.66;
      const angle = i * 1.7 + 0.4;
      const r = radius * Math.pow(1 - t, 0.9) + 2.1;
      const pos = new THREE.Vector3(
        Math.cos(angle) * r,
        floorY + height * t,
        Math.sin(angle) * r,
      );
      this.addPhotoPlane(ornamentTexture(i % 3), pos);
    }
  }

  /** 金色相框 + 照片平面；pos 为空时随机找个位置 */
  addPhotoPlane(texture, pos) {
    const group = new THREE.Group();

    const frameMat = new THREE.MeshStandardMaterial({
      color: 0xd8b264,
      metalness: 1,
      roughness: 0.18,
      envMapIntensity: 1.6,
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.62, 1.62, 0.06), frameMat);
    group.add(frame);

    const photo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.42, 1.42),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    photo.position.z = 0.045;
    group.add(photo);

    // 照片底下的可编辑文字：一块 canvas 纹理贴在相框下方
    const capCanvas = document.createElement('canvas');
    capCanvas.width = 512;
    capCanvas.height = 144;
    const capTex = new THREE.CanvasTexture(capCanvas);
    capTex.colorSpace = THREE.SRGBColorSpace;
    const capMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.86, 0.52),
      new THREE.MeshBasicMaterial({
        map: capTex,
        transparent: true,
        toneMapped: false,
        depthWrite: false,
      }),
    );
    capMesh.position.set(0, -1.08, 0.05);
    capMesh.visible = false;
    group.add(capMesh);
    group.userData.captionCanvas = capCanvas;
    group.userData.captionTexture = capTex;
    group.userData.captionMesh = capMesh;
    group.userData.caption = '';

    const scale = 0.72 + Math.random() * 0.16;
    group.scale.setScalar(scale);

    if (pos) group.position.copy(pos);
    else {
      const t = Math.random();
      const angle = Math.random() * Math.PI * 2;
      const r = this.cfg.particles.radius * Math.pow(1 - t, 0.9) + 1.6;
      group.position.set(
        Math.cos(angle) * r,
        this.cfg.particles.floorY + this.cfg.particles.height * (0.25 + t * 0.6),
        Math.sin(angle) * r,
      );
    }

    group.userData.isPhoto = true;
    group.userData.texture = texture;
    group.userData.baseScale = group.scale.x;
    group.userData.phase = Math.random() * Math.PI * 2;
    group.userData.baseY = group.position.y;
    // 平面默认朝 +Z，绕 y 转到"朝外"
    group.rotation.y = Math.atan2(group.position.x, group.position.z);

    this.decor.add(group);
    this.photos.push(group);
    return group;
  }

  /** 设置照片下方的文字；空字符串 = 隐藏 */
  setPhotoCaption(node, text) {
    if (!node) return;
    const canvas = node.userData.captionCanvas;
    const tex = node.userData.captionTexture;
    const mesh = node.userData.captionMesh;
    if (!canvas || !tex || !mesh) return;

    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    node.userData.caption = value;

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!value) {
      mesh.visible = false;
      tex.needsUpdate = true;
      return;
    }

    ctx.font = '600 34px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe7bb';
    ctx.shadowColor = 'rgba(255, 210, 140, 0.75)';
    ctx.shadowBlur = 12;

    // 按字符换行，最多 3 行；超出用省略号
    const maxW = W - 28;
    const maxLines = 3;
    const lines = [];
    let line = '';
    let overflow = false;
    for (const ch of value) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = ch;
        if (lines.length >= maxLines) { overflow = true; break; }
      } else {
        line = test;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (overflow && lines.length) {
      let last = lines[lines.length - 1];
      while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    const lh = 42;
    const startY = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * lh));

    mesh.visible = true;
    tex.needsUpdate = true;
  }

  photoCaption(node) {
    return node?.userData?.caption || '';
  }

  /**
   * 照片聚焦：把相框从树里"拔"出来，飞到镜头前居中放大。
   * 用的是 3D 对象本身，不是网页弹层 —— 所以树在背后照常转、雪照常落。
   */
  focusPhoto(node) {
    if (!node) return;
    if (this.focus.node === node) return;
    if (this.focus.node) this._restoreFocus();

    // 悬停放大过的话，先还原，否则会把 1.12 倍当成"原位姿"记下来
    this.setHovered(null);

    const home = {
      parent: node.parent,
      local: {
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone(),
      },
    };

    this.scene.attach(node); // 保留世界位置地挪到场景根下，动画才不会打架
    node.userData.focusHome = home;

    if (!node.userData.focusGlow) {
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(1.9, 1.9),
        new THREE.MeshBasicMaterial({
          map: frameGlowTexture(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      glow.position.z = -0.06;
      node.add(glow);
      node.userData.focusGlow = glow;
    }

    this.focus.node = node;
    this.focus.closing = false;
    this.focus.t = Math.max(this.focus.t, 0.001);
  }

  unfocusPhoto() {
    if (this.focus.node) this.focus.closing = true;
  }

  get focusedPhoto() {
    return this.focus.node;
  }

  _restoreFocus() {
    const f = this.focus;
    const node = f.node;
    if (!node) return;

    const home = node.userData.focusHome;
    if (home) {
      home.parent.add(node);
      node.position.copy(home.local.position);
      node.quaternion.copy(home.local.quaternion);
      node.scale.copy(home.local.scale);
      node.userData.focusHome = null;
    }
    if (node.userData.focusGlow) node.userData.focusGlow.material.opacity = 0;

    f.node = null;
    f.t = 0;
    f.closing = false;
  }

  _updateFocus(dt) {
    const f = this.focus;

    if (!f.node) {
      if (this.dimPlane.visible) {
        this.dimPlane.material.opacity *= Math.exp(-8 * dt);
        this.dimPlane.visible = this.dimPlane.material.opacity > 0.005;
      }
      return;
    }

    const node = f.node;
    const cam = this.camera;
    const target = f.closing ? 0 : 1;
    f.t += (target - f.t) * (1 - Math.exp(-7 * dt));

    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const dist = 4.6;
    const focusPos = cam.position.clone().addScaledVector(dir, dist);

    // 让照片高约占画面 62%，手机竖屏也不会顶出边界
    const visH = 2 * dist * Math.tan((cam.fov * Math.PI / 180) / 2);
    const targetScale = (visH * 0.62) / 1.62;

    // 原位姿要每帧重算：树一直在转，旧的世界坐标会飘
    const home = node.userData.focusHome;
    let homePos;
    let homeQuat;
    let homeScale;
    if (home) {
      home.parent.updateMatrixWorld();
      homePos = home.local.position.clone().applyMatrix4(home.parent.matrixWorld);
      homeQuat = home.parent
        .getWorldQuaternion(new THREE.Quaternion())
        .multiply(home.local.quaternion);
      homeScale = home.local.scale.x;
    } else {
      homePos = focusPos.clone();
      homeQuat = cam.quaternion.clone();
      homeScale = targetScale;
    }

    const t = f.t;
    node.position.lerpVectors(homePos, focusPos, t);
    node.quaternion.slerpQuaternions(homeQuat, cam.quaternion, t);
    node.scale.setScalar(homeScale + (targetScale - homeScale) * t);

    if (node.userData.focusGlow) {
      node.userData.focusGlow.material.opacity = 0.9 * t * (0.85 + 0.15 * Math.sin(this.time * 2.4));
    }

    // 背景压暗层：比照片更远 28%，只压暗后面的场景
    const dimDist = dist * 1.28;
    const dimH = 2 * dimDist * Math.tan((cam.fov * Math.PI / 180) / 2);
    this.dimPlane.position.copy(cam.position).addScaledVector(dir, dimDist);
    this.dimPlane.quaternion.copy(cam.quaternion);
    this.dimPlane.scale.set(dimH * 1.7, dimH * 1.1, 1);
    this.dimPlane.visible = t > 0.01;
    this.dimPlane.material.opacity = 0.5 * t;

    if (f.closing && f.t < 0.02) this._restoreFocus();
  }

  /**
   * 用归一化屏幕坐标（0~1，左上原点）拾取相框。
   * 手势和鼠标共用这一个入口，保证两种输入选中的是同一个东西。
   */
  pickAt(x01, y01) {
    this._ndc.set(x01 * 2 - 1, -(y01 * 2 - 1));
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.photos, true);
    if (hits.length) {
      let node = hits[0].object;
      while (node && !node.userData.isPhoto) node = node.parent;
      if (node) return node;
    }

    // 手指容差：相框在屏幕上只有几十像素，射线经常打不中。
    // 退一步按「投影中心 + 相框屏幕半径」找最近的一张，但必须朝向镜头、
    // 且距离不超过 1.35 倍半径 —— 果断一点，又不至于点哪儿都开。
    const W = window.innerWidth;
    const H = window.innerHeight;
    const px = x01 * W;
    const py = y01 * H;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const world = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const quat = new THREE.Quaternion();

    let best = null;
    let bestScore = Infinity;
    for (const node of this.photos) {
      if (!node || node.visible === false) continue;
      node.getWorldPosition(world);
      toCam.copy(this.camera.position).sub(world);
      const dist = toCam.length();
      if (dist < 1e-3) continue;
      toCam.divideScalar(dist);

      normal.set(0, 0, 1).applyQuaternion(node.getWorldQuaternion(quat));
      if (normal.dot(toCam) < 0.15) continue;   // 背对镜头的不算

      const ndc = world.clone().project(this.camera);
      if (ndc.z > 1) continue;
      const sx = (ndc.x * 0.5 + 0.5) * W;
      const sy = (-ndc.y * 0.5 + 0.5) * H;
      const d = Math.hypot(sx - px, sy - py);

      const rWorld = (node.userData.baseScale || 1) * 1.0;
      edge.copy(world).addScaledVector(right, rWorld).project(this.camera);
      const rPx = Math.abs((edge.x * 0.5 + 0.5) * W - sx);
      const radius = Math.min(72, Math.max(26, rPx * 1.35));
      if (d <= radius) {
        const score = d / radius;
        if (score < bestScore) { bestScore = score; best = node; }
      }
    }
    return best;
  }

  /** 悬停放大一点点，给"这里可以点"的反馈 */
  setHovered(node) {
    if (this.hovered === node) return;
    if (this.hovered) this.hovered.scale.setScalar(this.hovered.userData.baseScale);
    this.hovered = node;
    if (node) node.scale.setScalar(node.userData.baseScale * 1.12);
  }

  /** 取出相框里的图，供全屏查看；返回 dataURL 或图片地址 */
  photoSource(node) {
    const img = node?.userData?.texture?.image;
    if (!img) return null;
    if (img.src) return img.src;
    if (typeof img.toDataURL === 'function') return img.toDataURL('image/jpeg', 0.92);
    return null;
  }

  /** 外部传入图片（File/Blob/URL）时加一张照片 */
  addPhotoFromSource(source) {
    const photos = this.decor.children.filter((c) => c.userData.isPhoto !== false);
    if (photos.length > this.cfg.photos.max) {
      console.warn(`[tree] 最多 ${this.cfg.photos.max} 张，先忽略新的`);
      return null;
    }
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const texture = new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
    });
    const node = this.addPhotoPlane(texture, null);
    return node;
  }

  _initStar() {
    const { floorY, height } = this.cfg.particles;

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture('rgba(255,246,214,1)', 'rgba(255,190,80,0.5)', 256),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    sprite.position.set(0, floorY + height + 1.5, 0);
    sprite.scale.setScalar(4.2);
    this.treeRoot.add(sprite);
    this.star = sprite;

    const light = new THREE.PointLight(0xffd27a, 45, 40, 2);
    light.position.copy(sprite.position);
    this.treeRoot.add(light);
    this.starLight = light;
  }

  _initSnow() {
    const count = this.cfg.quality.snowCount;
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 70;
      positions[i * 3 + 1] = Math.random() * 48 - 14;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: this.cfg.palette.snow,
      size: 0.22,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    this.snow = new THREE.Points(geometry, material);
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);
  }

  _initBurst() {
    this.bursts = [];
    const perBurst = 90;

    for (let b = 0; b < 4; b++) {
      const positions = new Float32Array(perBurst * 3);
      const velocities = new Float32Array(perBurst * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        size: 0.28,
        color: 0xffe6a8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geometry, material);
      points.visible = false;
      points.frustumCulled = false;
      this.scene.add(points);
      this.bursts.push({ points, positions, velocities, life: 0, perBurst });
    }
    this._burstIndex = 0;
  }

  _initComposer() {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const { strength, radius, threshold } = this.cfg.quality.bloom;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), strength, radius, threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // ---------------------------------------------------------------- actions

  setMode(mode) {
    this.mode = mode;
  }

  /**
   * 粒子变形文字：用一套高密度粒子把文字铺出来。
   * 出现：树先散开、这套粒子从同一片球壳飞入字形；
   * 消失：字形再飞散回球壳并淡出，树同时重新聚拢。
   * 运动和正常「散开/合拢」一致，没有贴片感。
   */
  showText(rawText) {
    const text = String(rawText || '').trim() || '圣诞快乐';

    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 512;
    const ctx = c.getContext('2d');
    const fontStr = (size) => `700 ${size}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    let size = 280;
    ctx.font = fontStr(size);
    while (size > 60 && ctx.measureText(text).width > c.width * 0.92) {
      size -= 10;
      ctx.font = fontStr(size);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, c.width / 2, c.height / 2);

    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const pts = [];
    let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        if (img[(y * c.width + x) * 4 + 3] > 140) {
          pts.push(x, y);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    this.textKind = 'text';
    const ok = this._morphToPoints(pts, minX, minY, maxX, maxY);
    if (ok) this._prepareDissolve();   // 文字和爱心共用同一套消散数据
    return ok;
  }

  /**
   * 爱心：手势「1」单独保持一段时间触发。
   * 和文字走同一条变形管线，只是把字形采样换成心形采样，
   * 所以「树散开 → 粒子飞入爱心 → 再飞散回树」的手感和文字完全一致。
   */
  showHeart() {
    const h = heartPoints(2600);
    const ok = this._morphToPoints(h.pts, h.minX, h.minY, h.maxX, h.maxY);
    if (!ok) return false;
    this.textKind = 'heart';
    this._prepareDissolve(true);
    return true;
  }

  /** 把平面坐标、分组、速度种子等都算好（文字 / 爱心通用），消散时直接用 */
  _prepareDissolve(withRibbon = false) {
    const n = this.textCount;
    const b = this._morphBasis;
    if (!b) return;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const tmp = new THREE.Vector3();
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      tmp.set(
        this.textGoal[i3] - b.centre.x,
        this.textGoal[i3 + 1] - b.centre.y,
        this.textGoal[i3 + 2] - b.centre.z,
      );
      const ux = tmp.dot(b.right);
      const uy = tmp.dot(b.up);
      u[i] = ux;
      v[i] = uy;
      const r = Math.hypot(ux, uy);
      if (r > maxR) maxR = r;
    }
    this._heartMaxR = maxR || 1;
    this._heartCfg = null;

    // 爱心的 30% 粒子改走「沿漩涡上升」：视觉因果是 散开 → 被卷进漩涡 → 树长出来
    this._ribbonBound = null;
    this._ribbonS = null;
    if (withRibbon) {
      const bound = new Uint8Array(n);
      const arc = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (i % 10 < 3) {
          bound[i] = 1;
          arc[i] = i / n;
        }
      }
      this._ribbonBound = bound;
      this._ribbonS = arc;
    }
    this.heartState = createHeartDissolve(n, u, v, this._heartMaxR, Math.random);
  }

  /**
   * 生肖：手势「2」停住触发。只认十二生肖（`zodiac.js`），
   * 形状用 emoji 字形取 alpha 采样，取不到再退回汉字字形。
   */
  showZodiac(rawText) {
    const idx = zodiacIndexOf(rawText);
    if (idx < 0) return false;
    const sampled = this._sampleGlyph(ZODIAC[idx].emoji, ZODIAC[idx].name);
    if (!sampled) return false;
    this.textKind = 'zodiac';
    const ok = this._morphToPoints(sampled.pts, sampled.minX, sampled.minY, sampled.maxX, sampled.maxY);
    if (ok) this._prepareDissolve();
    return ok;
  }

  /** 把 emoji / 汉字画到 canvas 上取 alpha 采样 */
  _sampleGlyph(emoji, fallbackChar) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';

    const sample = () => {
      const img = ctx.getImageData(0, 0, S, S).data;
      const pts = [];
      let minX = S;
      let minY = S;
      let maxX = 0;
      let maxY = 0;
      for (let y = 0; y < S; y += 2) {
        for (let x = 0; x < S; x += 2) {
          if (img[(y * S + x) * 4 + 3] > 120) {
            pts.push(x, y);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return pts.length >= 40 ? { pts, minX, minY, maxX, maxY } : null;
    };

    // 先试 emoji（彩色字也能取 alpha，取到的是轮廓剪影）
    ctx.font = `380px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", sans-serif`;
    ctx.fillText(emoji, S / 2, S / 2);
    let out = sample();
    if (out) return out;

    // 有些系统没有 emoji 字体：退回汉字
    ctx.clearRect(0, 0, S, S);
    ctx.font = `400px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
    ctx.fillText(fallbackChar, S / 2, S / 2);
    out = sample();
    return out;
  }

  /** 把一组采样点铺到镜头前的平面上（文字 / 爱心共用） */
  _morphToPoints(pts, minX, minY, maxX, maxY) {
    if (pts.length < 20) return false;
    if (this.textPhase === 'dissolve') this._finishDissolve();
    this._regatherAt = 0;   // 新的变形打断「收拢」计划

    const inkW = Math.max(1, maxX - minX);
    const inkH = Math.max(1, maxY - minY);
    const cx = minX + inkW / 2;
    const cy = minY + inkH / 2;

    this.camera.updateMatrixWorld();
    const q = this.camera.quaternion;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

    const dist = 7.0;
    const visH = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 360);
    const visW = visH * this.camera.aspect;
    const sWorld = Math.min((visW * 0.86) / inkW, (visH * 0.6) / inkH);
    const worldW = inkW * sWorld;
    const worldH = inkH * sWorld;

    const centre = this.camera.position.clone().addScaledVector(fwd, dist);
    centre.y -= visH * 0.02;

    // 散开球壳：直接复用树身粒子的散开目标点。
    // 之前这里另起一坨随机球壳，文字和树身是「两片云」；
    // 复用之后两边落在同一批点上，出现/消散看起来就是同一次散开。
    const treeN = Math.max(1, this.cfg.particles.count);
    this.treeRoot.updateMatrixWorld();
    const shellWorld = new Float32Array(treeN * 3);
    const tmpWorld = new THREE.Vector3();
    for (let i = 0; i < treeN; i++) {
      const i3 = i * 3;
      tmpWorld.set(this.scatterTarget[i3], this.scatterTarget[i3 + 1], this.scatterTarget[i3 + 2]);
      this.treeRoot.localToWorld(tmpWorld);
      shellWorld[i3] = tmpWorld.x;
      shellWorld[i3 + 1] = tmpWorld.y;
      shellWorld[i3 + 2] = tmpWorld.z;
    }

    const n = this.textCount;
    const goal = this.textGoal;
    const nPts = pts.length / 2;
    const tmp = new THREE.Vector3();

    // 出现/消散的起点和终点都从树身粒子的散开目标里取 —— 两边同一片云
    const shellFrom = sampleShell(shellWorld, n);
    const shellTo = sampleShell(shellWorld, n);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const k = (Math.random() * nPts) | 0;
      const u = (pts[k * 2] - cx) / inkW;
      const v = (pts[k * 2 + 1] - cy) / inkH;
      tmp.copy(centre)
        .addScaledVector(right, u * worldW)
        .addScaledVector(up, -v * worldH);
      goal[i3] = tmp.x;
      goal[i3 + 1] = tmp.y;
      goal[i3 + 2] = tmp.z;
    }
    this.textFrom.set(shellFrom);
    this.textTo.set(shellTo);
    this.textPos.set(shellFrom);
    this.textGeometry.attributes.position.needsUpdate = true;
    this.textPoints.visible = true;
    this.textPoints.material.opacity = 0;   // 从 0 淡入，避免「啪」一下出现

    this._morphBasis = {
      centre: centre.clone(),
      right: right.clone(),
      up: up.clone(),
      fwd: fwd.clone(),
      visW,
      visH,
    };

    this.textPhase = 'in';
    this.textT = 0;
    this.textActive = true;
    this._textShownAt = this.time;
    this.mode = MODE.SCATTER;          // 树身粒子先散开
    this._treeOpacityTarget = 0;       // 树淡出，让位给文字粒子
    this.decor.visible = false;
    if (this.ornamentMesh) this.ornamentMesh.visible = false;
    if (this.star) this.star.visible = false;
    return true;
  }

  _updateTextPoints(dt) {
    if (this.textPhase === 'idle') return;
    this.textT += dt;
    const arr = this.textPos;
    const n = this.textCount;

    if (this.textPhase === 'in') {
      const p = Math.min(1, this.textT / 0.9);
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const e = p * p * (3 - 2 * p);
        arr[i3] = this.textFrom[i3] + (this.textGoal[i3] - this.textFrom[i3]) * e;
        arr[i3 + 1] = this.textFrom[i3 + 1] + (this.textGoal[i3 + 1] - this.textFrom[i3 + 1]) * e;
        arr[i3 + 2] = this.textFrom[i3 + 2] + (this.textGoal[i3 + 2] - this.textFrom[i3 + 2]) * e;
      }
      this.textGeometry.attributes.position.needsUpdate = true;
      this.textPoints.material.opacity = Math.min(1, this.textT / 0.18);
      if (p >= 1) this.textPhase = 'hold';
      return;
    }

    if (this.textPhase === 'out') {
      const p = Math.min(1, this.textT / 0.85);
      const e = p * p * (3 - 2 * p);
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        arr[i3] = this.textGoal[i3] + (this.textTo[i3] - this.textGoal[i3]) * e;
        arr[i3 + 1] = this.textGoal[i3 + 1] + (this.textTo[i3 + 1] - this.textGoal[i3 + 1]) * e;
        arr[i3 + 2] = this.textGoal[i3 + 2] + (this.textTo[i3 + 2] - this.textGoal[i3 + 2]) * e;
      }
      this.textGeometry.attributes.position.needsUpdate = true;
      // 前半程保持全亮（就是散开的样子），最后 55% 才淡出，
      // 免得字还没飞出去就先「化」没了
      const fade = Math.max(0, (p - 0.45) / 0.55);
      this.textPoints.material.opacity = 1 - fade * fade * (3 - 2 * fade);
      if (p >= 1) {
        this.textPhase = 'idle';
        this.textPoints.visible = false;
        this._revealScatterThenRegather();
      }
    }
  }

  /** 结束文字形态：文字粒子飞散，树重新聚拢 */
  hideText() {
    if (!this.textActive) return;
    this.textActive = false;
    this.restoring = true;      // 从收到终止指令这一刻起，用户输入全部让路

    // 光带同步开始「从地面往上长」：和消散重叠，中间不留空档
    this._ribbonGrowing = true;
    this._ribbonGrowT = 0;
    this._ribbonReveal = 0;

    // 文字和爱心都走 3.2 秒的「丝带分流」消散。
    // 这段时间里树先停在散开态但保持透明 —— 消散完先露出散开的树，再收拢。
    if (this.heartState) {
      this.mode = MODE.SCATTER;
      this._treeOpacityTarget = 0;
      this._startDissolve();
      return;
    }

    this.mode = MODE.SCATTER;       // 文字消散期间树先停在散开态但透明
    this._treeOpacityTarget = 0;
    this.textPhase = 'out';
    this.textT = 0;
  }

  /** 开始消散：把当前字形位置原样搬进消散系统，做到无缝衔接 */
  _startDissolve() {
    const n = this.textCount;
    const pos = this._heartPos;
    const col = this._heartCol;
    const alpha = this._heartAlpha;
    const size = this._heartSize;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      for (let g = 0; g < 3; g++) {
        const v = i * 3 + g;
        const v3 = v * 3;
        pos[v3] = this.textPos[i3];
        pos[v3 + 1] = this.textPos[i3 + 1];
        pos[v3 + 2] = this.textPos[i3 + 2];
        col[v3] = 1;
        col[v3 + 1] = 0.72;
        col[v3 + 2] = 0.38;
        alpha[v] = 1;
        size[v] = 0.045;
      }
    }
    this._heartT = 0;
    this.textPhase = 'dissolve';
    this.textPoints.visible = false;
    this.heartPoints.visible = true;
    this._heartGeoDirty = true;
  }

  /**
   * 四拍消散（文字 / 爱心共用）：内收 → 起丝 → 分流 → 化尘。
   * 每帧算三份位置：本体 + 两个「鬼影」（-0.06s / -0.12s），
   * 鬼影靠加色混合叠成拉丝，不用后处理。
   */
  _updateDissolve(dt) {
    const st = this.heartState;
    const b = this._morphBasis;
    if (!st || !b) return;

    this._heartT += dt;
    const t = this._heartT;

    const n = this.textCount;
    const pos = this._heartPos;
    const col = this._heartCol;
    const alpha = this._heartAlpha;
    const sizeArr = this._heartSize;

    // 位移距离按爱心自身半径算：太小轮廓散不掉，太大直接飞出画面
    const spread = (this._heartMaxR || 4) * 2.6;
    const cfg = this._heartCfg || (this._heartCfg = { ...HEART_DISSOLVE, maxSpread: spread });

    const contract = 1 - HEART_DISSOLVE.contract * dissolveSmooth(t / 0.35);
    const sizeMul = dissolveSize(t);
    const darken = dissolveDarken(t);

    // 暖橙 → 暗褐
    const warm = [1.0, 0.72, 0.38];
    const brown = [0.30, 0.16, 0.09];

    // 移动端粒子数减半；组数和错峰时间不动，否则丝带会断成碎点
    const stride = this.cfg.particles.count >= 1500 ? 1 : 2;

    const off = this._off[0];
    const ghost1 = this._off[1];
    const ghost2 = this._off[2];
    const c = b.centre;
    const rx = b.right.x;
    const ry = b.right.y;
    const rz = b.right.z;
    const ux = b.up.x;
    const uy = b.up.y;
    const uz = b.up.z;
    const fx = b.fwd?.x ?? 0;
    const fy = b.fwd?.y ?? 0;
    const fz = b.fwd?.z ?? 0;

    for (let i = 0; i < n; i++) {
      if (stride > 1 && i % stride === 1) {
        // 被减掉的那一半：尺寸归零，不参与绘制
        for (let g = 0; g < 3; g++) sizeArr[i * 3 + g] = 0;
        continue;
      }

      const a = dissolveAlpha(st.edge[i], t);
      const ember = st.ember[i] === 1;

      let r = warm[0] + (brown[0] - warm[0]) * darken;
      let g = warm[1] + (brown[1] - warm[1]) * darken;
      let bl = warm[2] + (brown[2] - warm[2]) * darken;

      let aMain = a;
      if (ember && t > 1.6) {
        // 余烬：不掉到全黑，带一点不规则闪烁
        const flick = 0.72 + 0.28 * Math.sin(t * 9.3 + st.phase[i] * 3.1);
        aMain = Math.max(a, 0.32 * flick);
        r = Math.min(1, r + 0.5 * flick);
        g = Math.min(1, g + 0.28 * flick);
        bl = Math.min(1, bl + 0.08 * flick);
      }

      // 被漩涡接住的那 30%：沿螺旋爬升，颜色转白
      if (this._ribbonBound && this._ribbonBound[i]) {
        const sArc = this._ribbonS[i];
        const climb = Math.min(1, Math.max(0, (t - HEART_DISSOLVE.startAt) / 1.3));
        const e = 1 - Math.pow(1 - climb, 3);
        const rp = ribbonPoint(sArc, {
          floorY: this.cfg.particles.floorY,
          height: this.cfg.particles.height,
          baseRadius: this.cfg.particles.radius,
          turns: RIBBON_TURNS,
          rot: this.time * 0.12,
        });
        if (!this._ribbonTmp) this._ribbonTmp = new THREE.Vector3();
        this._ribbonTmp.set(rp.x, rp.y, rp.z);
        this.treeRoot.localToWorld(this._ribbonTmp);

        const bx = c.x + rx * (st.u[i] * contract) + ux * (st.v[i] * contract);
        const by = c.y + ry * (st.u[i] * contract) + uy * (st.v[i] * contract);
        const bz = c.z + rz * (st.u[i] * contract) + uz * (st.v[i] * contract);

        const v3r = i * 9;
        pos[v3r] = bx + (this._ribbonTmp.x - bx) * e;
        pos[v3r + 1] = by + (this._ribbonTmp.y - by) * e;
        pos[v3r + 2] = bz + (this._ribbonTmp.z - bz) * e;

        const wr = 1.0;
        const wg = 0.97;
        const wb = 0.88;
        col[v3r] = r + (wr - r) * e;
        col[v3r + 1] = g + (wg - g) * e;
        col[v3r + 2] = bl + (wb - bl) * e;

        const aRib = Math.max(0, 1 - Math.max(0, (t - 1.3) / 1.4));
        alpha[i * 3] = aRib;
        sizeArr[i * 3] = 0.045 * (0.95 - 0.25 * e);
        for (let gI = 0; gI < 2; gI++) {
          const v = i * 3 + gI + 1;
          alpha[v] = 0;
          sizeArr[v] = 0;
        }
        continue;
      }

      // 本体
      dissolveOffset(st, i, t, off, cfg);
      const px = st.u[i] * contract + off[0];
      const py = st.v[i] * contract + off[1];
      let v3 = i * 9;
      pos[v3] = c.x + rx * px + ux * py + fx * off[2];
      pos[v3 + 1] = c.y + ry * px + uy * py + fy * off[2];
      pos[v3 + 2] = c.z + rz * px + uz * py + fz * off[2];
      col[v3] = r; col[v3 + 1] = g; col[v3 + 2] = bl;
      alpha[i * 3] = aMain;
      sizeArr[i * 3] = 0.045 * sizeMul;

      // 鬼影 1 / 2：同一轨道上早 0.06s / 0.12s 的位置
      for (let gI = 0; gI < 2; gI++) {
        const back = gI === 0 ? 0.06 : 0.12;
        const tBack = t - back;
        const v = i * 3 + gI + 1;
        const vv = v * 3;
        if (tBack <= HEART_DISSOLVE.startAt + st.delay[i]) {
          pos[vv] = pos[v3];
          pos[vv + 1] = pos[v3 + 1];
          pos[vv + 2] = pos[v3 + 2];
          col[vv] = r; col[vv + 1] = g; col[vv + 2] = bl;
          alpha[v] = 0;
          sizeArr[v] = 0;
          continue;
        }
        const gg = gI === 0 ? ghost1 : ghost2;
        dissolveOffset(st, i, tBack, gg, cfg);
        const gx = st.u[i] * contract + gg[0];
        const gy = st.v[i] * contract + gg[1];
        pos[vv] = c.x + rx * gx + ux * gy + fx * gg[2];
        pos[vv + 1] = c.y + ry * gx + uy * gy + fy * gg[2];
        pos[vv + 2] = c.z + rz * gx + uz * gy + fz * gg[2];
        col[vv] = r; col[vv + 1] = g; col[vv + 2] = bl;
        alpha[v] = aMain * (gI === 0 ? 0.55 : 0.28);
        sizeArr[v] = 0.045 * sizeMul;
      }
    }

    this.heartPoints.geometry.attributes.position.needsUpdate = true;
    this.heartPoints.geometry.attributes.aColor.needsUpdate = true;
    this.heartPoints.geometry.attributes.aAlpha.needsUpdate = true;
    this.heartPoints.geometry.attributes.aSize.needsUpdate = true;

    if (t >= HEART_DISSOLVE.total) this._finishDissolve();
  }

  _finishDissolve() {
    this.textPhase = 'idle';
    this.heartPoints.visible = false;
    this.textPoints.visible = false;
    this._revealScatterThenRegather();
  }

  /**
   * 文字 / 爱心消散完的统一收尾：
   * 先让「散开态」的树淡入（粒子本来就停在散开云里），停 1.5 秒，
   * 再切回合拢态收成树。装饰和星星等收拢时再回来。
   */
  _revealScatterThenRegather() {
    this.mode = MODE.SCATTER;
    this._treeOpacityTarget = 1;
    // 这一刻粒子其实还停在散开云里、而且是透明的。
    // 先把它们瞬间放回「树的合拢位置」（看不见的时候做，不会穿帮），
    // 再切到散开态 —— 这样看到的就是一次完整的「树炸开 → 再收回」，和平时张开手掌一样。
    this.pos.set(this.treeTarget);
    this._regatherAt = this.time + 1.5;
    this.startVortex();   // 散开态露脸的同时，漩涡从下方转上来，收拢时正好接住
  }

  /** 消散之后：散开态 → 收拢成树 */
  _regatherTree(rig) {
    this._regatherAt = 0;
    this.mode = MODE.TREE;
    this._restoreDoneAt = this.time + 1.2;   // 收拢大约 0.8s，留一点余量再解锁
    rig?.setMode?.(MODE.TREE);
    this.decor.visible = true;
    if (this.ornamentMesh) this.ornamentMesh.visible = true;
    if (this.star) this.star.visible = true;
  }

  /** 从开场机位平滑过渡到交互机位（from: {z,y,targetY,fov}） */
  startCameraBlend(from, duration = 0.6) {
    if (!from) return;
    this._camBlend = { from, dur: Math.max(0.05, duration), t: 0 };
  }

  /** 开场交棒：瞬间铺成散开态，随后 setMode(TREE) 会把它收拢成主体 */
  snapToScatter() {
    this.mode = MODE.SCATTER;
    this.pos.set(this.scatterTarget);
    this._ribbonOpacity = 0;
  }

  /** 捏合时放一小簇金色烟花 */
  burst(origin = new THREE.Vector3(0, 2, 8)) {
    const slot = this.bursts[this._burstIndex++ % this.bursts.length];
    const { positions, velocities, perBurst } = slot;

    for (let i = 0; i < perBurst; i++) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;

      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 7;
      velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      velocities[i * 3 + 1] = Math.cos(phi) * speed * 0.8 + 1.5;
      velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
    }

    slot.points.geometry.attributes.position.needsUpdate = true;
    slot.points.material.opacity = 1;
    slot.points.visible = true;
    slot.life = 1.1;
  }

  // ---------------------------------------------------------------- frame

  update(dt, rig) {
    this.time += dt;
    const t = this.time;

    if (this._regatherAt && this.time >= this._regatherAt) this._regatherTree(rig);
    if (this._restoreDoneAt && this.time >= this._restoreDoneAt) {
      this._restoreDoneAt = 0;
      this.restoring = false;   // 树已恢复，交还控制权
    }

    // 相机：绕树转由 treeRoot 承担，所以相机只沿 z 推拉，保持构图稳定
    // 文字形态期间冻结机位，保证文字一直正对屏幕
    if (!this.textActive) {
      this.treeRoot.rotation.y = rig.yaw;
      this.treeRoot.rotation.x = rig.pitch;
    }
    const zTo = this.cfg.camera.baseDistance * rig.distanceFactor;
    const yTo = 1.6 + rig.pitch * 4;
    if (this._camBlend) {
      // 开场交棒：先从开场的广角机位起步，0.4s 推到交互机位
      const b = this._camBlend;
      b.t = Math.min(1, b.t + dt / b.dur);
      const e = 1 - Math.pow(1 - b.t, 3);
      this.camera.position.z = b.from.z + (zTo - b.from.z) * e;
      this.camera.position.y = b.from.y + (yTo - b.from.y) * e;
      this.camera.lookAt(0, b.from.targetY + (0.4 - b.from.targetY) * e, 0);
      if (b.from.fov && b.from.fov !== this.cfg.camera.fov) {
        this.camera.fov = b.from.fov + (this.cfg.camera.fov - b.from.fov) * e;
        this.camera.updateProjectionMatrix();
      }
      if (b.t >= 1) {
        this.camera.fov = this.cfg.camera.fov;
        this.camera.updateProjectionMatrix();
        this._camBlend = null;
      }
    } else if (!this.textActive) {
      this.camera.position.z = zTo;
      this.camera.position.y = yTo;
      this.camera.lookAt(0, 0.4, 0);
    }

    this._updateParticles(dt, t);

    // 树身粒子在文字阶段淡出/淡入
    this._treeOpacity += (this._treeOpacityTarget - this._treeOpacity) * (1 - Math.exp(-7 * dt));
    const op = this._treeOpacity;
    const pmat = this.particles.material;
    if (Math.abs(pmat.opacity - op) > 0.003) {
      pmat.transparent = op < 0.995;
      pmat.opacity = op;
      pmat.depthWrite = op > 0.995;
    }
    this._updateVortex(dt);
    if (this.textPhase === 'dissolve') this._updateDissolve(dt);
    else this._updateTextPoints(dt);

    // 装饰球/照片：轻微上下浮动 + 缓慢自转
    this.decor.rotation.y += dt * 0.12;
    for (const item of this.decor.children) {
      item.position.y = item.userData.baseY + Math.sin(t * 0.8 + item.userData.phase) * 0.45;
    }

    // 星星呼吸
    const pulse = 3.9 + Math.sin(t * 1.8) * 0.45 + this._starFlash * 2.4;
    this.star.scale.setScalar(pulse);
    this.starLight.intensity = 40 + Math.sin(t * 1.8) * 12 + this._starFlash * 55;

    this._updateSnow(dt);
    this._updateBursts(dt);
    this._updateFocus(dt);

    // 光带生长：1.5s easeOutCubic 从地面长到塔尖
    if (this._ribbonGrowing) {
      this._ribbonGrowT += dt;
      this._ribbonReveal = ribbonRevealAt(this._ribbonGrowT);
      if (this._ribbonReveal >= 1) {
        this._ribbonGrowing = false;
        this._starFlash = 1;      // 长到顶的同时点亮塔尖星芒
      }
    }
    if (this._starFlash > 0.001) this._starFlash *= Math.exp(-2.2 * dt);
    else this._starFlash = 0;

    // 光带：树形态下常亮；生长期间强制可见（不然消散时它是透明的，等于没长）
    const ribbonTarget = Math.max(this.mode === MODE.TREE ? 1 : 0, this._ribbonGrowing ? 1 : 0);
    this._ribbonOpacity += (ribbonTarget - this._ribbonOpacity) * (1 - Math.exp(-4 * dt));
    this.ribbon.update(
      dt,
      this.camera,
      this.renderer.getPixelRatio(),
      this._ribbonOpacity,
      this._ribbonReveal,
      this._ribbonGrowing,
    );
    this._updateOrnaments(dt, this.time);

    this.composer.render();
  }

  _updateParticles(dt, t) {
    const count = this.cfg.particles.count;
    const target = this.mode === MODE.TREE ? this.treeTarget : this.scatterTarget;
    const stiffness = this.mode === MODE.TREE ? 3.6 : 2.1;
    const k = 1 - Math.exp(-stiffness * dt);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const noise = Math.sin(t * 1.3 + this.seed[i]) * 0.06;

      this.pos[i3] += (target[i3] - this.pos[i3]) * k;
      this.pos[i3 + 1] += (target[i3 + 1] - this.pos[i3 + 1]) * k + noise * 0.02;
      this.pos[i3 + 2] += (target[i3 + 2] - this.pos[i3 + 2]) * k;

      TMP_OBJ.position.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      TMP_OBJ.rotation.set(this.seed[i] * 6 + t * 0.4, this.seed[i] * 3, 0);
      TMP_OBJ.scale.setScalar(this.size[i] * (0.85 + 0.22 * Math.sin(t * 2.2 + this.seed[i])) * (this.textActive ? 0.32 : 1));
      TMP_OBJ.updateMatrix();
      this.particles.setMatrixAt(i, TMP_OBJ.matrix);
    }
    this.particles.instanceMatrix.needsUpdate = true;
  }

  _updateSnow(dt) {
    const attr = this.snow.geometry.attributes.position;
    const arr = attr.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 1] -= (1.4 + (i % 7) * 0.12) * dt;
      arr[i] += Math.sin(this.time + i) * 0.004;
      if (arr[i + 1] < -14) {
        arr[i + 1] = 34;
        arr[i] = (Math.random() - 0.5) * 70;
        arr[i + 2] = (Math.random() - 0.5) * 60;
      }
    }
    attr.needsUpdate = true;
    this.snow.rotation.y += dt * 0.01;
  }

  _updateBursts(dt) {
    for (const slot of this.bursts) {
      if (slot.life <= 0) continue;
      slot.life -= dt;
      const { positions, velocities, perBurst } = slot;

      for (let i = 0; i < perBurst; i++) {
        const i3 = i * 3;
        velocities[i3 + 1] -= 6 * dt; // 重力
        positions[i3] += velocities[i3] * dt;
        positions[i3 + 1] += velocities[i3 + 1] * dt;
        positions[i3 + 2] += velocities[i3 + 2] * dt;
      }
      slot.points.geometry.attributes.position.needsUpdate = true;
      slot.points.material.opacity = Math.max(0, slot.life / 1.1);

      if (slot.life <= 0) {
        slot.points.visible = false;
        slot.points.material.opacity = 0;
      }
    }
  }

  /** 动态画质：按帧率需要调低/恢复像素比（保持 50fps 以上） */
  setPixelRatio(pr) {
    const target = Math.max(0.8, Math.min(window.devicePixelRatio || 1, pr));
    if (Math.abs(this.renderer.getPixelRatio() - target) < 0.02) return;
    this.renderer.setPixelRatio(target);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    if (this.heartMaterial) {
      this.heartMaterial.uniforms.uScale.value = h * 0.5;
      this.heartMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    }
  }

  dispose() {
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
