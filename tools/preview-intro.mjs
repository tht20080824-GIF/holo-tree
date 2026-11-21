/**
 * 把开场「星尘汇聚」阶段离线画成 PNG，用来检查环是不是整圈都在画面里。
 *
 * 为什么要这个脚本：浏览器里没法自动化截图，而"环越界"这种事只看数字容易判断错。
 * 这里用和 intro.js 完全相同的取景/半径/倾斜参数，把粒子投影到 NDC 再画出来，
 * 四周画上画面边框 —— 有点跑出边框就是真的越界了。
 *
 * 粒子分布镜像的是 js/intro.js 的 _buildParticles()（A 阶段只用到 dustX/dustZ/dustU/dustY）。
 *
 * 用法：node tools/preview-intro.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import url from 'node:url';

import {
  frameCamera,
  fitDustRadius,
  dustTiltFor,
  easeInOutCubic,
  clamp01,
} from '../js/intro-math.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs', 'preview');
fs.mkdirSync(OUT, { recursive: true });

const SHAPE = { height: 24, floorY: -12, baseRadius: 9 };
const GATHER_END = 3.2;

// ---------------------------------------------------------------- 粒子

function buildDust(n = 17000, seed = 20261222) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const u = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    x[i] = Math.cos(a);
    z[i] = Math.sin(a);
    u[i] = 0.7 + Math.pow(rand(), 0.8) * 0.3;
    y[i] = (rand() - 0.5) * SHAPE.height * 0.055 * 2;
  }
  return { n, x, z, u, y };
}

// ---------------------------------------------------------------- 取景

function setup(w, h) {
  const aspect = w / h;
  const cam = frameCamera({
    fov: 42,
    aspect,
    yMin: SHAPE.floorY - 1,
    yMax: SHAPE.floorY + SHAPE.height + 3,
    halfW: SHAPE.baseRadius * 1.2,
  });
  const tilt = dustTiltFor(aspect);
  const thickness = SHAPE.height * 0.055;
  const radius = fitDustRadius(
    { distance: cam.distance, targetY: cam.targetY, tanV: cam.tanV, aspect },
    { tilt, thickness, marginX: 0.92, marginTop: 0.9, marginBottom: 0.96, cap: SHAPE.baseRadius * 2.6 },
  );
  return {
    w, h, aspect,
    distance: cam.distance,
    targetY: cam.targetY,
    tanV: cam.tanV,
    tilt,
    thickness,
    radius,
    r1: Math.min(radius * 0.62, SHAPE.baseRadius * 1.45),
  };
}

// ---------------------------------------------------------------- 光栅

function makeCanvas(w, h) {
  const buf = new Uint8Array(w * h * 3);
  const add = (px, py, v) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const i = (py * w + px) * 3;
    buf[i] = Math.min(255, buf[i] + v[0]);
    buf[i + 1] = Math.min(255, buf[i + 1] + v[1]);
    buf[i + 2] = Math.min(255, buf[i + 2] + v[2]);
  };
  return { w, h, buf, add };
}

function drawPixel(c, px, py, v) {
  // 2×2 的软点，接近粒子在屏幕上的大小
  c.add(px, py, v);
  c.add(px + 1, py, v.map((x) => x * 0.45));
  c.add(px, py + 1, v.map((x) => x * 0.45));
  c.add(px + 1, py + 1, v.map((x) => x * 0.25));
}

// ---------------------------------------------------------------- PNG

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0;
    Buffer.from(c.buf.buffer, y * c.w * 3, c.w * 3).copy(raw, y * (c.w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

// ---------------------------------------------------------------- 渲染

function renderFrame(env, dust, t, scale = 0.55) {
  const W = Math.round(env.w * scale);
  const H = Math.round(env.h * scale);
  const c = makeCanvas(W, H);

  // 画面边框：越界的粒子会画到边框外面
  for (let x = 0; x < W; x++) {
    c.add(x, 0, [40, 40, 40]);
    c.add(x, H - 1, [40, 40, 40]);
  }
  for (let y = 0; y < H; y++) {
    c.add(0, y, [40, 40, 40]);
    c.add(W - 1, y, [40, 40, 40]);
  }
  // 画面中线 / 三分之一线，方便看构图
  for (let x = 0; x < W; x++) {
    c.add(x, (H / 2) | 0, [16, 16, 16]);
  }

  const p = clamp01(t / GATHER_END);
  const cur = env.radius + (env.r1 - env.radius) * easeInOutCubic(p);
  const spin = (0.6 + 2.6 * p * p) * Math.min(t, GATHER_END) * 0.5;
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  const ct = Math.cos(env.tilt);
  const st = Math.sin(env.tilt);
  const thickK = 1 - 0.35 * p;
  const bright = 0.9 + 0.3 * p;

  for (let i = 0; i < dust.n; i++) {
    const u = dust.u[i] * cur;
    const x0 = dust.x[i] * u;
    const z0 = dust.z[i] * u;
    const x = x0 * cs - z0 * sn;
    const z = x0 * sn + z0 * cs;
    const y0 = dust.y[i] * thickK;
    const wy = y0 * ct - z * st;
    const wz = y0 * st + z * ct;

    const dz = env.distance - wz;
    if (dz <= 0.1) continue;
    const ndcX = x / (dz * env.tanV * env.aspect);
    const ndcY = (wy - env.targetY) / (dz * env.tanV);

    const px = Math.round(((ndcX + 1) / 2) * (W - 1));
    const py = Math.round(((1 - ndcY) / 2) * (H - 1));
    const rim = clamp01((dust.u[i] - 0.72) / 0.26);
    const v = 120 * bright * (0.82 + 0.42 * rim);
    drawPixel(c, px, py, [v * 1.0, v * 0.86, v * 0.6]);
  }

  return c;
}

const dust = buildDust();
const sizes = [
  [1440, 700, 'laptop'],
  [390, 844, 'phone'],
];
const times = [0.5, 1.6, 2.6];

for (const [w, h, name] of sizes) {
  const env = setup(w, h);
  console.log(
    `${name} ${w}×${h}: D=${env.distance.toFixed(1)} tilt=${((env.tilt * 180) / Math.PI).toFixed(0)}° ` +
    `r0=${env.radius.toFixed(1)} (${(env.radius / SHAPE.baseRadius).toFixed(2)}R) r1=${env.r1.toFixed(1)}`,
  );
  for (const t of times) {
    const c = renderFrame(env, dust, t);
    const file = path.join(OUT, `ring-${name}-t${t.toFixed(1)}.png`);
    const bytes = writePng(file, c);
    console.log(`  → ${path.relative(root, file)} (${(bytes / 1024).toFixed(0)}KB)`);
  }
}
