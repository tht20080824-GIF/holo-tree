/**
 * 环绕光带：一条从树底绕到树顶的螺旋粒子丝带。
 *
 * 规格来自 `01-环绕光带-提示词.md`：
 * - 3.5~4 圈，半径 = 该高度树身半径 × 1.1（跟着树收分，不写死绝对值）
 * - 8000~12000 颗粒子，一次 draw call，动画全在着色器里算
 * - 自转 0.12 rad/s，同时沿螺旋向上流动，约 4 秒一圈
 * - 转到树后侧时亮度衰减 40%，避免"贴纸感"
 *
 * 关键设计：几何体只建一次，每帧只更新 uniforms。禁止重建 BufferGeometry。
 */

import * as THREE from 'three';
import {
  TAU,
  RIBBON_TURNS,
  RIBBON_TOP_RATIO,
  RIBBON_RADIUS_FACTOR,
  TAPER_EXPONENT,
  pointScale,
} from './ribbon-math.js';

const VERT = /* glsl */ `
  attribute float aPhase;      // 在螺旋上的位置 0~1
  attribute float aBandR;      // 径向抖动（带宽内）
  attribute float aBandY;      // 纵向抖动
  attribute float aSize;
  attribute float aBright;
  attribute float aTint;

  uniform float uTime;
  uniform float uTurns;
  uniform float uFlow;         // 相位流速（圈/秒）
  uniform float uRot;          // 整体自转角速度
  uniform float uHeight;
  uniform float uFloorY;
  uniform float uBaseRadius;
  uniform float uPointScale;
  uniform float uReveal;       // 0→1 自下而上生长
  uniform vec3  uCamPos;
  uniform vec3  uCenter;
  uniform vec3  uColorA;
  uniform vec3  uColorB;

  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    // 粒子沿螺旋向上流动；fract 保证首尾闭合、不出现接缝
    float phase = fract(aPhase + uTime * uFlow);
    float t = phase;

    float ang = phase * uTurns * ${TAU.toFixed(8)} + uTime * uRot;

    // 半径跟着树的收分走，绝不写死绝对值
    float baseR = uBaseRadius * pow(1.0 - t, ${TAPER_EXPONENT.toFixed(4)}) * ${RIBBON_RADIUS_FACTOR.toFixed(4)};
    float r = baseR * (1.0 + aBandR);

    // 终止在树顶下方 8% 处，避免顶部悬一个大环
    float y = uFloorY + uHeight * ${RIBBON_TOP_RATIO.toFixed(4)} * t + aBandY;

    vec3 pos = vec3(cos(ang) * r, y, sin(ang) * r);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    // 夹住下限：再小的点也要 1 像素，否则整条光带会"消失"
    gl_PointSize = clamp(aSize * uPointScale / max(0.06, -mv.z), 1.0, 64.0);

    // 转到树身背后时压暗 40%：拿"粒子相对树心"与"粒子朝向相机"点乘判断
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vec3 toCam = normalize(uCamPos - world.xyz);
    vec3 fromCenter = normalize(world.xyz - uCenter);
    float facing = dot(toCam, fromCenter);           // 近侧 >0，远侧 <0
    float depthFactor = mix(0.6, 1.0, smoothstep(-0.55, 0.35, facing));

    // 生长：按静态弧长 aPhase 一刀切，s > uReveal 的粒子完全隐藏。
    // 注意用 aPhase 而不是流动后的 phase —— 流动会让"刀口"在原地闪烁。
    float s = aPhase;
    float hide = smoothstep(uReveal - 0.02, uReveal + 0.02, s);
    // 生长前沿提亮：正在冒出来的那一段最亮，成形后回落到基态
    float growing = 1.0 - step(0.999, uReveal);
    float edge = exp(-pow((uReveal - s) / 0.05, 2.0)) * growing;
    float growBright = 1.0 + 1.2 * edge;

    vAlpha = aBright * depthFactor * (1.0 - hide) * growBright;
    vColor = mix(uColorA, uColorB, aTint);
  }
`;

const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    // 圆形点精灵，边缘柔化，做出"光的丝带"而不是硬边线条
    vec2 d = gl_PointCoord - vec2(0.5);
    float dist = length(d);
    if (dist > 0.5) discard;
    float falloff = smoothstep(0.5, 0.05, dist);
    gl_FragColor = vec4(vColor * vAlpha, falloff * vAlpha * uOpacity);
  }
`;

/**
 * @param {object} opts
 * @param {number} opts.count 粒子数（桌面 9000 / 手机 5000）
 * @param {number} opts.height 树高
 * @param {number} opts.floorY 树底 y
 * @param {number} opts.baseRadius 树底半径
 * @param {string|number} opts.colorA 主色（冰蓝）
 * @param {string|number} opts.colorB 次色（白）
 */
export function createRibbon({
  count = 9000,
  height,
  floorY,
  baseRadius,
  colorA = 0xa8e6ff,
  colorB = 0xffffff,
} = {}) {
  const phase = new Float32Array(count);
  const bandR = new Float32Array(count);
  const bandY = new Float32Array(count);
  const size = new Float32Array(count);
  const bright = new Float32Array(count);
  const tint = new Float32Array(count);

  const bandHeight = height * 0.04;   // 带宽 ≈ 树高 4%
  const lateral = height * 0.03;      // 横向抖动 ±3%
  const positions = new Float32Array(count * 3); // 占位（实际位置在 shader 里算）

  for (let i = 0; i < count; i++) {
    phase[i] = i / count;

    // 中心密、边缘稀：把随机数往 0 压，避免硬边
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    bandR[i] = gauss() * (bandHeight / Math.max(baseRadius, 1)) * 0.9;
    bandY[i] = gauss() * lateral;
    size[i] = 0.5 + Math.random() * 0.8;
    // 亮度随机 ±25%，中心亮一点
    const centerBias = 1 - Math.min(Math.abs(bandR[i]) * baseRadius / bandHeight, 1) * 0.35;
    // 亮度压到塔尖星芒之下（规格：不超过 0.7 倍），±25% 抖动
    bright[i] = (0.55 + Math.random() * 0.3) * centerBias;
    // 大部分保持冰蓝，少数过渡到白，丝带才有层次而不是一条白线
    tint[i] = Math.pow(Math.random(), 1.8);
  }

  const geometry = new THREE.BufferGeometry();
  // position 必须存在，但真正的坐标由 shader 用 aPhase 算
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute('aBandR', new THREE.BufferAttribute(bandR, 1));
  geometry.setAttribute('aBandY', new THREE.BufferAttribute(bandY, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, floorY + height / 2, 0), height);

  const uniforms = {
    uTime: { value: 0 },
    uTurns: { value: RIBBON_TURNS },
    uFlow: { value: 0.25 },      // 4 秒走完一圈
    uRot: { value: 0.12 },       // 0.12 rad/s 自转
    uHeight: { value: height },
    uFloorY: { value: floorY },
    uBaseRadius: { value: baseRadius },
    uPointScale: { value: 900 },
    uCamPos: { value: new THREE.Vector3() },
    uCenter: { value: new THREE.Vector3(0, floorY + height * 0.5, 0) },
    uColorA: { value: new THREE.Color(colorA) },
    uColorB: { value: new THREE.Color(colorB) },
    uOpacity: { value: 1 },
    uReveal: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // 按规格关闭；空间感靠 shader 里的 facing 衰减
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    uniforms,
    /**
     * @param {number} dt
     * @param {THREE.Camera} camera
     * @param {number} pixelRatio
     * @param {number} opacity
     * @param {number} reveal 0→1 生长进度
     * @param {boolean} frozen 生长期间冻结流动，刀口才不会原地闪
     */
    update(dt, camera, pixelRatio = 1, opacity = 1, reveal = 1, frozen = false) {
      uniforms.uTime.value += dt;
      uniforms.uOpacity.value = opacity;
      uniforms.uReveal.value = reveal;
      uniforms.uFlow.value = frozen ? 0 : 0.25;
      uniforms.uCamPos.value.copy(camera.position);
      uniforms.uPointScale.value = pointScale(window.innerHeight, pixelRatio, camera.fov);
    },
  };
}
