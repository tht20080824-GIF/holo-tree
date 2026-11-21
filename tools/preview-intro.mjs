/**
 * 把开场「星尘张开」阶段离线画成 PNG，检查环的大小/比例对不对。
 *
 * 浏览器没法自动化截图，所以这里用和 js/intro.js 完全相同的取景、缩放、
 * 张开曲线、自转，把粒子投影出来画成图 —— 点用软粒子 + 一次廉价 bloom，
 * 尽量接近真实画面（真实画面还有 UnrealBloom，这里只是别让学生看成硬点）。
 *
 * 用法： node tools/preview-intro.mjs [--out 目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import url from 'node:url';

import {
  frameCamera,
  fitDustRadius,
  dustTiltAt,
  DUST_TILT_TARGET,
  easeInOutCubic,
  clamp01,
} from '../js/intro-math.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(root, 'docs', 'preview');
fs.mkdirSync(OUT, { recursive: true });

const SHAPE = { height: 24, floorY: -12, baseRadius: 9 };
const GATHER_END = 3.2;

// ---------------------------------------------------------------- 粒子（镜像 intro.js 的分布）

function buildDust(n = 17000, seed = 20261222) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const r = SHAPE.baseRadius * (1.9 + Math.pow(rand(), 0.65) * 2.4);
    x[i] = Math.cos(ang) * r;
    z[i] = Math.sin(ang) * r;
    y[i] = (rand() - 0.5) * SHAPE.height * 0.09;
  }
  return { n, x, z, y };
}

// ---------------------------------------------------------------- 取景（镜像 _refit）

function setup(w, h) {
  const aspect = w / h;
  const cam = frameCamera({
    fov: 42,
    aspect,
    yMin: SHAPE.floorY - 1,
    yMax: SHAPE.floorY + SHAPE.height + 3,
    halfW: SHAPE.baseRadius * 1.2,
  });
  const thickness = SHAPE.height * 0.045;
  const maxDustR = SHAPE.baseRadius * 4.3;
  const warpCap = (cam.distance * 0.42) / Math.cos(DUST_TILT_TARGET);
  const fit = fitDustRadius(
    { distance: cam.distance, targetY: cam.targetY, tanV: cam.tanV, aspect },
    { tilt: DUST_TILT_TARGET, thickness, marginBottom: 0.9, cap: Math.min(maxDustR, warpCap) },
  );
  return {
    w, h, aspect,
    distance: cam.distance,
    targetY: cam.targetY,
    tanV: cam.tanV,
    thickness,
    fit,
    scale: fit / maxDustR,
  };
}

// ---------------------------------------------------------------- 光栅

function canvas(w, h) {
  const buf = new Float32Array(w * h * 3);
  return { w, h, buf };
}

function splat(c, px, py, rgb) {
  // 3×3 软点：中心 1，边 0.35，角 0.12
  const w = c.w;
  const h = c.h;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = dx === 0 && dy === 0 ? 1 : (dx === 0 || dy === 0 ? 0.35 : 0.12);
      const i = (y * w + x) * 3;
      c.buf[i] += rgb[0] * k;
      c.buf[i + 1] += rgb[1] * k;
      c.buf[i + 2] += rgb[2] * k;
    }
  }
}

/** 一次廉价 bloom：4 倍降采样 → 两遍盒模糊 → 加回去 */
function bloom(c, strength = 0.3) {
  const { w, h, buf } = c;
  const dw = Math.max(1, Math.round(w / 4));
  const dh = Math.max(1, Math.round(h / 4));
  const small = new Float32Array(dw * dh * 3);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const j = (((y / 4) | 0) * dw + ((x / 4) | 0)) * 3;
      small[j] += buf[i];
      small[j + 1] += buf[i + 1];
      small[j + 2] += buf[i + 2];
    }
  }
  const tmp = new Float32Array(small);
  const box = (src, dst, r, horizontal) => {
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        let r0 = 0; let g0 = 0; let b0 = 0; let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= dw || yy >= dh) continue;
          const j = (yy * dw + xx) * 3;
          r0 += src[j]; g0 += src[j + 1]; b0 += src[j + 2]; n++;
        }
        const j = (y * dw + x) * 3;
        dst[j] = r0 / n; dst[j + 1] = g0 / n; dst[j + 2] = b0 / n;
      }
    }
  };
  box(small, tmp, 3, true);
  const tmp2 = new Float32Array(dw * dh * 3);
  box(tmp, tmp2, 3, false);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const j = (((y / 4) | 0) * dw + ((x / 4) | 0)) * 3;
      buf[i] += tmp2[j] * strength * 16;
      buf[i + 1] += tmp2[j + 1] * strength * 16;
      buf[i + 2] += tmp2[j + 2] * strength * 16;
    }
  }
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

const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 自动曝光：把 99.5% 的亮度拉到 0.85，避免一片死白或一片黑 */
function autoExpose(c) {
  const lum = [];
  for (let i = 0; i < c.buf.length; i += 3) {
    lum.push(c.buf[i] * 0.5 + c.buf[i + 1] * 0.4 + c.buf[i + 2] * 0.1);
  }
  lum.sort((a, b) => a - b);
  const p = lum[Math.min(lum.length - 1, Math.floor(lum.length * 0.995))] || 1;
  const gain = p > 1 ? 0.85 / p : 1;
  for (let i = 0; i < c.buf.length; i++) c.buf[i] *= gain;
}

function writePng(file, c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0;
    for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 3;
      const o = y * (c.w * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) {
        // 简单 tonemap，避免叠加处一片死白
        const v = c.buf[i + k] / 255;
        raw[o + k] = Math.round(255 * Math.min(1, v / (1 + v * 0.45)));
      }
    }
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
}

// ---------------------------------------------------------------- 渲染

function renderFrame(env, dust, t, scale = 0.6) {
  const W = Math.round(env.w * scale);
  const H = Math.round(env.h * scale);
  const c = canvas(W, H);

  const p = clamp01(t / GATHER_END);
  const open = dustTiltAt(t);
  const ct = Math.cos(open);
  const st = Math.sin(open);
  const shrink = 1 - 0.42 * easeInOutCubic(clamp01((p - 0.42) / 0.58));
  const sc = env.scale * shrink;
  const spin = (0.6 + 2.6 * p * p) * Math.min(t, GATHER_END) * 0.5;
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  const bright = 0.9 + 0.3 * p;

  for (let i = 0; i < dust.n; i++) {
    const x0 = dust.x[i] * sc;
    const z0 = dust.z[i] * sc;
    const x = x0 * cs - z0 * sn;
    const z = x0 * sn + z0 * cs;
    const y0 = dust.y[i] * (1 - 0.35 * p);
    const wy = y0 * ct - z * st;
    const wz = y0 * st + z * ct;

    const dz = env.distance - wz;
    if (dz <= 0.1) continue;
    const ndcX = x / (dz * env.tanV * env.aspect);
    const ndcY = (wy - env.targetY) / (dz * env.tanV);
    if (Math.abs(ndcX) > 1.6 || Math.abs(ndcY) > 1.6) continue;

    const px = Math.round(((ndcX + 1) / 2) * (W - 1));
    const py = Math.round(((1 - ndcY) / 2) * (H - 1));
    const v = 2.2 * bright;
    splat(c, px, py, [v * 1.0, v * 0.86, v * 0.62]);
  }

  bloom(c);
  autoExpose(c);
  return c;
}

const dust = buildDust();
const cases = [
  [1440, 700, 'laptop'],
  [390, 844, 'phone'],
];
const times = [0.6, 1.2, 1.8, 2.4];

for (const [w, h, name] of cases) {
  const env = setup(w, h);
  console.log(
    `${name} ${w}×${h}: D=${env.distance.toFixed(1)} fit=${env.fit.toFixed(1)} ` +
    `(${(env.fit / SHAPE.baseRadius).toFixed(2)}R, 缩放 ${env.scale.toFixed(3)})`,
  );
  for (const t of times) {
    const file = path.join(OUT, `ring-${name}-t${t.toFixed(1)}.png`);
    writePng(file, renderFrame(env, dust, t));
    console.log(`  → ${path.relative(root, file)}`);
  }
}
