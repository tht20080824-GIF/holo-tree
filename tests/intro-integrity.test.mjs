import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'js/intro.js'), 'utf8');

test('开场：调用的私有方法都必须有定义（防止 this._xxx is not a function）', () => {
  const called = new Set([...src.matchAll(/this\.(_[A-Za-z0-9]+)\(/g)].map((m) => m[1]));
  const defined = new Set([...src.matchAll(/^\s{2}(_[A-Za-z0-9]+)\(/gm)].map((m) => m[1]));
  const missing = [...called].filter((n) => !defined.has(n));
  assert.deepEqual(missing, [], `缺少方法定义：${missing.join(', ')}`);
});

test('开场：空格不能写成字面量 \\u00a0', () => {
  assert.ok(!src.includes("'\\\\u00a0'"), '出现转义错误：空格会显示成 "\\u00a0"');
});

test('开场：必须同时有闪光层和黑场淡出层', () => {
  assert.ok(src.includes("id = 'intro-flash'"), '缺少闪光层');
  assert.ok(src.includes("id = 'intro-fade'"), '缺少黑场淡出层');
});

test('开场性能：每帧主循环里只有帧级三角函数（卡顿根因）', () => {
  // 上一版每帧对每颗粒子调 dustPoint()，17000 颗 = 6.8 万次 sin/cos，直接卡死
  const start = src.indexOf('_step(t) {');
  const end = src.indexOf('_setTree() {');
  assert.ok(start > 0 && end > start, '找不到 _step 主循环');
  const stepBody = src.slice(start, end);

  const trig = [...stepBody.matchAll(/Math\.(cos|sin)\(/g)].length;
  assert.ok(
    trig <= 8,
    `每帧主循环里有 ${trig} 次三角函数调用，应该只算帧级别的几次`,
  );
  assert.ok(!stepBody.includes('dustPoint'), '主循环里又出现逐粒子的 dustPoint');
});

test('开场：使用预计算数组（treeX/dustX/bDir）而不是每帧推导', () => {
  for (const name of ['treeX', 'treeY', 'treeZ', 'dustX', 'bDir', 'bScale']) {
    assert.ok(src.includes(`this.${name} = new Float32Array`), `缺少预计算数组 ${name}`);
  }
});
