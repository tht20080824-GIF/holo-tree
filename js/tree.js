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
import { buildTreeLayout } from './layout.js';
import { createRibbon } from './ribbon.js';
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
    this._camBlend = null;   // 开场交棒时的机位过渡
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

    // 相机：绕树转由 treeRoot 承担，所以相机只沿 z 推拉，保持构图稳定
    this.treeRoot.rotation.y = rig.yaw;
    this.treeRoot.rotation.x = rig.pitch;
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
    } else {
      this.camera.position.z = zTo;
      this.camera.position.y = yTo;
      this.camera.lookAt(0, 0.4, 0);
    }

    this._updateParticles(dt, t);

    // 装饰球/照片：轻微上下浮动 + 缓慢自转
    this.decor.rotation.y += dt * 0.12;
    for (const item of this.decor.children) {
      item.position.y = item.userData.baseY + Math.sin(t * 0.8 + item.userData.phase) * 0.45;
    }

    // 星星呼吸
    const pulse = 3.9 + Math.sin(t * 1.8) * 0.45;
    this.star.scale.setScalar(pulse);
    this.starLight.intensity = 40 + Math.sin(t * 1.8) * 12;

    this._updateSnow(dt);
    this._updateBursts(dt);
    this._updateFocus(dt);

    // 光带：树形态下常亮，散开后淡出，避免和爆炸的粒子糊成一团
    const ribbonTarget = this.mode === MODE.TREE ? 1 : 0;
    this._ribbonOpacity += (ribbonTarget - this._ribbonOpacity) * (1 - Math.exp(-4 * dt));
    this.ribbon.update(dt, this.camera, this.renderer.getPixelRatio(), this._ribbonOpacity);
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
      TMP_OBJ.scale.setScalar(this.size[i] * (0.85 + 0.22 * Math.sin(t * 2.2 + this.seed[i])));
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
  }

  dispose() {
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
