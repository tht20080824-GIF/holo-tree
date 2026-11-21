#!/usr/bin/env node
/**
 * 极简单文件打包器：把 ESM 模块树压成一个"经典脚本"，塞进一个 HTML 里。
 *
 * 为什么自己写而不用 esbuild/rollup：
 * 这台机器上没有它们，也不想为了一个 1.5MB 的产物拉一整套工具链。
 * 我们的模块图很小（9 个源文件 + 12 个 three addon），而且没有循环依赖，
 * 所以只要做三件事：解析 import、剥掉 export、用函数作用域隔离每个模块。
 *
 * 产物特性：
 * - 没有 import / export 语句，可以直接内联到 <script>（不需要 type="module"）
 * - 双击（file://）也能跑，因为没有任何跨文件请求
 * - 模块之间靠 __require(id) 拿导出，天然避免顶层变量重名
 *
 * 用法： node tools/bundle.mjs
 * 产物： dist/圣诞树.html 和 dist/index.html（内容相同，后者方便部署）
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ENTRY = 'js/main.js';
const CDN_MODE = process.argv.includes('--cdn');

// CDN 模式下 three / addon 不内联，改成顶层 import，产物只有我们自己的代码（几十 KB）
const externals = new Map();   // spec -> 变量名
const externalImports = [];    // { name, spec }

function externalVar(spec) {
  if (!externals.has(spec)) {
    const name = `__ext${externals.size}`;
    externals.set(spec, name);
    externalImports.push({ name, spec });
  }
  return externals.get(spec);
}

// ---------------------------------------------------------------- 模块解析

function resolve(fromId, spec) {
  if (CDN_MODE && (spec === 'three' || spec.startsWith('three/addons/'))) {
    return { external: spec };
  }
  if (spec === 'three') return 'vendor/three.module.js';
  if (spec.startsWith('three/addons/')) return `vendor/three-addons/${spec.slice('three/addons/'.length)}`;
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(fromId);
    return path.posix.normalize(path.posix.join(dir, spec));
  }
  return null; // 裸模块（CDN 之类的）不参与打包
}

// ---------------------------------------------------------------- 单模块改写

const IMPORT_RE = /^import\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]\s*;?/gm;
const SIDE_EFFECT_IMPORT_RE = /^import\s*['"]([^'"]+)['"]\s*;?/gm;

function parseBindings(clause) {
  // 形如： { a, b as c }  或  * as NS  或  Default  或  Default, { a }
  const out = { namespace: null, defaultName: null, named: [] };
  let rest = clause.trim();

  const nsMatch = rest.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (nsMatch) {
    out.namespace = nsMatch[1];
    return out;
  }

  const braceStart = rest.indexOf('{');
  const head = braceStart === -1 ? rest : rest.slice(0, braceStart).replace(/,\s*$/, '').trim();
  if (head && /^[A-Za-z_$][\w$]*$/.test(head)) out.defaultName = head;

  if (braceStart !== -1) {
    const inner = rest.slice(braceStart + 1, rest.lastIndexOf('}'));
    for (const part of inner.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) out.named.push([asMatch[1], asMatch[2]]);
      else out.named.push([t, t]);
    }
  }
  return out;
}

function transformModule(id, src, resolveSpec) {
  const declared = new Set(); // 需要挂到 __exports 上的本地名字
  const header = [];

  // 1) 静态 import → __require
  let code = src.replace(IMPORT_RE, (whole, clause, spec) => {
    const target = resolveSpec(id, spec);
    if (!target) throw new Error(`${id}: 无法解析导入 "${spec}"（裸模块不参与打包）`);
    const b = parseBindings(clause);

    // 外部依赖：从顶层 import 进来的命名空间解构，不再 __require
    if (typeof target === 'object' && target.external) {
      const v = externalVar(target.external);
      if (b.namespace) return `const ${b.namespace} = ${v};`;
      const parts = [];
      if (b.defaultName) parts.push(`${b.defaultName} = ${v}.default`);
      if (b.named.length) {
        const names = b.named.map(([orig, alias]) => (orig === alias ? orig : `${orig}: ${alias}`));
        parts.push(`{ ${names.join(', ')} } = ${v}`);
      }
      return `const ${parts.join(', ')};`;
    }
    if (b.namespace) return `const ${b.namespace} = __require(${JSON.stringify(target)});`;
    const parts = [];
    if (b.defaultName) parts.push(`${b.defaultName} = __require(${JSON.stringify(target)}).default`);
    if (b.named.length) {
      const names = b.named.map(([orig, alias]) => (orig === alias ? orig : `${orig}: ${alias}`));
      parts.push(`{ ${names.join(', ')} } = __require(${JSON.stringify(target)})`);
    }
    return `const ${parts.join(', ')};`;
  });

  // 2) 纯副作用 import → 只执行
  code = code.replace(SIDE_EFFECT_IMPORT_RE, (whole, spec) => {
    const target = resolveSpec(id, spec);
    if (!target) return '';
    return `__require(${JSON.stringify(target)});`;
  });

  // 3) export 声明
  code = code.replace(/^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (m, asyncKw, name) => {
    declared.add(name);
    return `${asyncKw ?? ''}function ${name}`;
  });
  code = code.replace(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm, (m, name) => {
    declared.add(name);
    return `class ${name}`;
  });
  code = code.replace(/^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m, kw, name) => {
    declared.add(name);
    return `${kw} ${name}`;
  });

  // 4) export { a, b as c }  以及 export { a } from './x'
  code = code.replace(/^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"]\s*)?;?/gm, (m, inner, from) => {
    const pairs = inner
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const asMatch = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        return asMatch ? [asMatch[1], asMatch[2]] : [p, p];
      });

    if (from) {
      const target = resolveSpec(id, from);
      if (!target) throw new Error(`${id}: 无法解析再导出来源 "${from}"`);
      const tmp = `__reexport_${declared.size}`;
      header.push(`const ${tmp} = __require(${JSON.stringify(target)});`);
      return pairs.map(([orig, alias]) => `__exports[${JSON.stringify(alias)}] = ${tmp}[${JSON.stringify(orig)}];`).join('\n');
    }
    return pairs.map(([orig, alias]) => `__exports[${JSON.stringify(alias)}] = ${orig};`).join('\n');
  });

  // 5) export default
  code = code.replace(/^export\s+default\s+/gm, '__exports.default = ');

  if (/^\s*(import|export)\b/m.test(code)) {
    const line = code.split('\n').find((l) => /^\s*(import|export)\b/.test(l));
    throw new Error(`${id}: 还有没处理掉的 import/export —— ${line}`);
  }

  const tail = [...declared].map((n) => `__exports[${JSON.stringify(n)}] = ${n};`).join('\n');
  return [header.join('\n'), code, tail].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- 打包

const modules = new Map(); // id → transformed body
const order = [];

function visit(id) {
  if (modules.has(id)) return;
  modules.set(id, null); // 占位，防止重复
  const src = read(id);
  const body = transformModule(id, src, resolve);
  modules.set(id, body);
  order.push(id);
}

// 广度遍历，先确定整张图再改写（改写时 resolve 已可用，顺序无关）
const queue = [ENTRY];
const seen = new Set();
while (queue.length) {
  const id = queue.shift();
  if (seen.has(id)) continue;
  seen.add(id);
  const src = read(id);
  for (const m of src.matchAll(/(?:^import\s+[^;]*?from\s*|^import\s*)['"]([^'"]+)['"]/gm)) {
    const target = resolve(id, m[1]);
    if (!target) continue;
    if (typeof target === 'object' && target.external) {
      externalVar(target.external); // CDN 模式：只登记，不打包
      continue;
    }
    if (!seen.has(target)) queue.push(target);
  }
  visit(id);
}

const parts = [];
parts.push('/* 由 tools/bundle.mjs 生成 —— 不要手改，改源码后重新构建 */');
for (const { name, spec } of externalImports) {
  parts.push(`import * as ${name} from ${JSON.stringify(spec)};`);
}
parts.push('(function () {');
parts.push('  var __defs = {}, __cache = {};');
parts.push('  function __require(id) {');
parts.push('    if (__cache[id]) return __cache[id];');
parts.push('    var exports = {};');
parts.push('    __cache[id] = exports;');
parts.push('    __defs[id].call(null, __require, exports);');
parts.push('    return exports;');
parts.push('  }');
for (const id of order) {
  parts.push(`  __defs[${JSON.stringify(id)}] = function (__require, __exports) {`);
  parts.push(modules.get(id));
  parts.push('  };');
}
parts.push(`  __require(${JSON.stringify(ENTRY)});`);
parts.push('})();');

const bundle = parts.join('\n');

// ---------------------------------------------------------------- 组装 HTML

let html = read('index.html');
const css = read('css/app.css');

// 注意：替换内容必须用函数形式。String.replace 的字符串参数里，
// `$'` / `$&` / `$\`` 都是特殊模式 —— three.js 源码里有 `'$'`，
// 用字符串替换会把它展开成"匹配点之后整段 HTML"，直接把文件写坏。
html = html.replace(/<link rel="stylesheet" href="\.\/css\/app\.css" \/>/, () => `<style>\n${css}\n</style>`);

if (CDN_MODE) {
  // CDN 模式：importmap 必须指向 jsdelivr，否则会去找不存在的 ./vendor/
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, () => `<script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>`);
} else {
  // 单文件模式：没有模块了，importmap 删掉
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
}

// 移动端：禁止双指缩放页面，手势才不会被浏览器抢走
html = html.replace(
  /<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />',
);

// 用内联脚本替换 module 入口
// inline script 里不能出现字面量 </script>，否则 HTML 解析器会提前结束脚本
const safeBundle = bundle.replace(/<\/script/gi, '<\\/script');
// CDN 模式的 bundle 带顶层 import，必须是 type="module"；单文件模式是经典脚本
const openTag = CDN_MODE ? '<script type="module">' : '<script>';
html = html.replace(
  /<script type="module" src="\.\/js\/main\.js"><\/script>/,
  () => `<script>window.__HOLO_NO_VENDOR__ = true;</script>\n${openTag}\n${safeBundle}\n</script>`,
);

if (html.includes('__defs') === false) throw new Error('入口脚本没有被替换，检查 index.html 的 script 标签');
if (!CDN_MODE && /<script[^>]+src=/.test(html)) throw new Error('产物里还有外链 script，单文件要求全部内联');

const outDir = CDN_MODE ? 'dist-cdn' : 'docs';
fs.mkdirSync(path.join(root, outDir), { recursive: true });
// 单文件版只要 docs/index.html（Pages 的发布入口）；
// CDN 版同时留一份中文名，方便直接发给别人
if (CDN_MODE) {
  fs.writeFileSync(path.join(root, outDir, '圣诞树.html'), html, 'utf8');
}
fs.writeFileSync(path.join(root, outDir, 'index.html'), html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log('—— 单文件构建 ——');
console.log(`  模块数 ${order.length}`);
console.log(`  JS   ${kb(bundle.length)}`);
console.log(`  CSS  ${kb(css.length)}`);
console.log(`  产物 ${kb(html.length)}  → ${outDir}/index.html`);
