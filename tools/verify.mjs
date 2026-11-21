#!/usr/bin/env node
/**
 * 静态自检：不需要浏览器，检查那些"打开页面才会发现"的低级错误。
 *
 * 检查项：
 * 1. importmap 指向的文件是否真的存在
 * 2. 每个 js 模块的相对 import / bare import 能否解析到本地文件
 * 3. index.html 里被 js 引用的 DOM id 是否都存在
 * 4. vendor 里的关键资源（模型、wasm）是否齐全
 * 5. config 里的阈值顺序是否自洽（握拳阈值必须小于张开的）
 *
 * 用法： node tools/verify.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

// ---------------------------------------------------------------- 1. importmap
const html = read('index.html');
const importmapRaw = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
if (!importmapRaw) problems.push('index.html 里没有 importmap');
const imports = importmapRaw ? JSON.parse(importmapRaw).imports ?? {} : {};

for (const [spec, target] of Object.entries(imports)) {
  const p = path.join(root, target);
  const ok = target.endsWith('/') ? fs.existsSync(p) && fs.statSync(p).isDirectory() : fs.existsSync(p);
  if (!ok) problems.push(`importmap "${spec}" → ${target} 不存在`);
}

// ---------------------------------------------------------------- 2. 模块导入
function resolveSpec(fromFile, spec) {
  if (spec.startsWith('.')) {
    return path.resolve(path.dirname(path.join(root, fromFile)), spec);
  }
  if (spec === 'three') return path.join(root, imports.three ?? '');
  if (spec.startsWith('three/addons/')) {
    return path.join(root, (imports['three/addons/'] ?? '') + spec.slice('three/addons/'.length));
  }
  return null;
}

const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`);

for (const file of jsFiles) {
  const src = read(file);
  const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specs) {
    const resolved = resolveSpec(file, spec);
    if (!resolved) {
      problems.push(`${file}: 无法解析的导入 "${spec}"（importmap 里没映射）`);
    } else if (!fs.existsSync(resolved)) {
      problems.push(`${file}: 导入 "${spec}" 指向的文件不存在`);
    }
  }
}

// ---------------------------------------------------------------- 3. DOM id
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const mainSrc = read('js/main.js');
const usedIds = new Set([...mainSrc.matchAll(/\$\('#([^'\s]+)'\)/g)].map((m) => m[1]));
for (const id of usedIds) {
  if (!htmlIds.has(id)) problems.push(`js/main.js 引用了 #${id}，但 index.html 里没有这个元素`);
}

// ---------------------------------------------------------------- 4. vendor 资源
const vendorFiles = [
  'vendor/three.module.js',
  'vendor/tasks-vision.js',
  'vendor/three-addons/postprocessing/OutputPass.js',
  'vendor/three-addons/postprocessing/UnrealBloomPass.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/hand_landmarker.task',
];
for (const f of vendorFiles) {
  if (!exists(f)) problems.push(`缺少 vendor 文件: ${f}`);
}

const modelPath = 'vendor/mediapipe/hand_landmarker.task';
if (exists(modelPath)) {
  const size = fs.statSync(path.join(root, modelPath)).size;
  if (size < 4 * 1024 * 1024) problems.push(`模型文件只有 ${(size / 1048576).toFixed(1)}MB，可能没下载完整（应约 5~8MB）`);
  else notes.push(`模型 ${(size / 1048576).toFixed(1)}MB`);
}

// ---------------------------------------------------------------- 5. 配置自洽
const { CONFIG, ...rest } = await import(url.pathToFileURL(path.join(root, 'js/config.js')).href);
void rest;
const g = CONFIG.gesture;
if (!(g.fistOn < g.openOn)) problems.push('config: fistOn 必须小于 openOn');
if (!(g.pinchOn < g.pinchOff)) problems.push('config: pinchOn 必须小于 pinchOff（否则滞回失效）');
if (!(CONFIG.camera.minDistance < CONFIG.rig.zoomNear * CONFIG.camera.baseDistance)) {
  notes.push('提示：zoomNear 已经把相机拉到 minDistance 附近，再调小可能穿模');
}

// ---------------------------------------------------------------- 输出
console.log('—— 静态自检 ——');
for (const n of notes) console.log(`  ℹ ${n}`);
if (!problems.length) {
  console.log('  ✓ 全部通过');
  process.exit(0);
}
for (const p of problems) console.log(`  ✗ ${p}`);
process.exit(1);
