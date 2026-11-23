import test from 'node:test';
import assert from 'node:assert/strict';

import { ZODIAC, zodiacIndexOf, zodiacName, zodiacEmoji } from '../js/zodiac.js';
import { GestureRouter } from '../js/gesture.js';

test('生肖：一共 12 个，名字不重复', () => {
  assert.equal(ZODIAC.length, 12);
  const names = new Set(ZODIAC.map((z) => z.name));
  assert.equal(names.size, 12);
  for (const z of ZODIAC) {
    assert.ok(z.name.length === 1, `${z.name} 应该是单字`);
    assert.ok(z.emoji.length > 0);
    assert.ok(z.aliases.includes(z.name));
  }
});

test('生肖：12 个名字都能命中，且命中自己', () => {
  ZODIAC.forEach((z, i) => {
    assert.equal(zodiacIndexOf(z.name), i, `${z.name} 应命中 ${i}`);
  });
});

test('生肖：别名与繁体也能命中', () => {
  assert.equal(zodiacIndexOf('老鼠'), 0);
  assert.equal(zodiacIndexOf('老虎'), 2);
  assert.equal(zodiacIndexOf('龍'), 4);
  assert.equal(zodiacIndexOf('公鸡'), 9);
  assert.equal(zodiacIndexOf('小狗'), 10);
  assert.equal(zodiacIndexOf('亥猪'), 11);
});

test('生肖：普通文字不生效', () => {
  for (const bad of ['圣诞快乐', 'hello', '新年', '', '   ', '我爱你', '福']) {
    assert.equal(zodiacIndexOf(bad), -1, `「${bad}」不该命中`);
  }
});

test('生肖：短句里包含别名可以命中，长句不行', () => {
  assert.equal(zodiacIndexOf('可爱的小老虎'), 2);
  assert.equal(zodiacIndexOf('这是一句很长很长的话里面写了老虎'), -1);
});

test('生肖：取名字和 emoji', () => {
  assert.equal(zodiacName(0), '鼠');
  assert.equal(zodiacEmoji(4), '🐲');
  assert.equal(zodiacName(99), '');
});

// ---------------------------------------------------------------- 手势仲裁

function feed(router, plan, stepMs = 30, start = 0) {
  const actions = [];
  let t = start;
  for (const { count, ms } of plan) {
    for (let e = 0; e < ms; e += stepMs) {
      const a = router.update(count, t);
      if (a !== 'none') actions.push(a);
      t += stepMs;
    }
  }
  return { actions, t };
}

test('仲裁：只比「2」并停住 → 生肖', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions } = feed(r, [{ count: 2, ms: 1800 }]);
  assert.deepEqual(actions, ['zodiac']);
});

test('仲裁：1→2→3→5 走序列时，比 2 不会触发生肖', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions } = feed(r, [
    { count: 1, ms: 240 },
    { count: 2, ms: 600 },
    { count: 3, ms: 240 },
    { count: 5, ms: 300 },
  ]);
  assert.deepEqual(actions, ['text']);
});

test('仲裁：单比 2 之后手放下再比，冷却期内不重复触发', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions, t } = feed(r, [{ count: 2, ms: 3600 }]);
  assert.deepEqual(actions, ['zodiac']);

  const again = feed(r, [{ count: 0, ms: 300 }, { count: 2, ms: 1800 }], 30, t + 200);
  assert.deepEqual(again.actions, ['zodiac']);
});