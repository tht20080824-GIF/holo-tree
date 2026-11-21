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
