import test from 'node:test';
import assert from 'node:assert/strict';
import { MorphSequence } from '../js/gesture.js';

// 每个手势停两拍（第二拍超过 holdMs）才算稳定
function play(seq, counts, start = 0, step = 200) {
  let t = start;
  let fired = 0;
  for (const c of counts) {
    for (let i = 0; i < 2; i++) {
      if (seq.update(c, t)) fired++;
      t += step;
    }
  }
  return { fired, t };
}

test('1→2→3→五指张开：触发一次', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const r = play(seq, [1, 2, 3, 5]);
  assert.equal(r.fired, 1);
});

test('少一步（1→2→3）不触发', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const r = play(seq, [1, 2, 3]);
  assert.equal(r.fired, 0);
});

test('中间插错（1→2→4）后重新从 1 开始，仍能触发', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const r = play(seq, [1, 2, 4, 1, 2, 3, 5]);
  assert.equal(r.fired, 1);
});

test('两步之间超过 4 秒：序列作废', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const first = play(seq, [1], 0, 200);
  const second = play(seq, [2, 3, 5], first.t + 5000, 200);
  assert.equal(second.fired, 0);
});

test('触发后 1.5 秒冷却内不会连触', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const first = play(seq, [1, 2, 3, 5]);
  assert.equal(first.fired, 1);
  const second = play(seq, [1, 2, 3, 5], first.t + 100, 100);
  assert.equal(second.fired, 0);
});

test('握拳（0 指）不参与序列', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const r = play(seq, [0, 0, 0]);
  assert.equal(r.fired, 0);
});

test('手指抖动（1 和 0 交替）不会误触', () => {
  const seq = new MorphSequence([1, 2, 3, 5]);
  const r = play(seq, [1, 0, 1, 0, 1, 0]);
  assert.equal(r.fired, 0);
});

// ---------------------------------------------------------------- 爱心 vs 文字 仲裁

import { GestureRouter } from '../js/gesture.js';

/** 按「保持某根手指 ms 毫秒」喂帧，收集触发的动作 */
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

test('仲裁：只比「1」并停住 → 爱心', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions } = feed(r, [{ count: 1, ms: 1800 }]);
  assert.deepEqual(actions, ['heart']);
});

test('仲裁：1→2→3→5 走序列 → 文字，不会先冒出一个爱心', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions } = feed(r, [
    { count: 1, ms: 240 },
    { count: 2, ms: 240 },
    { count: 3, ms: 240 },
    { count: 5, ms: 300 },
  ]);
  assert.deepEqual(actions, ['text']);
});

test('仲裁：1 停 0.4 秒（还不够久）再接着比 2、3、5 → 仍然是文字', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions } = feed(r, [
    { count: 1, ms: 400 },
    { count: 2, ms: 240 },
    { count: 3, ms: 240 },
    { count: 5, ms: 300 },
  ]);
  assert.deepEqual(actions, ['text']);
});

test('仲裁：比出爱心后，序列被作废，接着比 2、3、5 不会又变文字', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const first = feed(r, [{ count: 1, ms: 1800 }]);
  assert.deepEqual(first.actions, ['heart']);

  const second = feed(r, [
    { count: 2, ms: 240 },
    { count: 3, ms: 240 },
    { count: 5, ms: 300 },
  ], 30, first.t + 2000);
  assert.deepEqual(second.actions, []);
});

test('仲裁：比出爱心后继续比 1，冷却期内不重复触发', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const { actions, t } = feed(r, [{ count: 1, ms: 3200 }]);
  assert.equal(actions[0], 'heart');
  assert.equal(actions.length, 1, `冷却期内不该连触发，实际 ${actions.join(',')}`);

  // 手指放下来、过一会儿再比 1，应该能再触发一次
  const again = feed(r, [{ count: 0, ms: 300 }, { count: 1, ms: 1800 }], 30, t + 200);
  assert.deepEqual(again.actions, ['heart']);
});

test('仲裁：只有 3/5 时什么都不触发（2 已经归给生肖了）', () => {
  for (const count of [3, 5]) {
    const r = new GestureRouter([1, 2, 3, 5]);
    const { actions } = feed(r, [{ count, ms: 1200 }]);
    assert.deepEqual(actions, [], `比 ${count} 根手指不该触发`);
  }
});

test('仲裁：没有手（-1）会清掉「1」的计时，手回来看见 1 才重新计', () => {
  const r = new GestureRouter([1, 2, 3, 5]);
  const a = feed(r, [{ count: 1, ms: 500 }]);
  assert.deepEqual(a.actions, []);
  const b = feed(r, [{ count: -1, ms: 100 }, { count: 1, ms: 400 }], 30, a.t);
  assert.deepEqual(b.actions, [], '手消失前的 500ms 不能累加');
});

// ---------------------------------------------------------------- 手指数平滑

import { StableCount } from '../js/gesture.js';

test('平滑：单帧毛刺被众数吃掉（1 → 0 → 1 仍然是 1）', () => {
  const s = new StableCount({ windowMs: 150 });
  let out = -1;
  const seq = [1, 1, 1, 1, 0, 1, 1, 1];
  for (let i = 0; i < seq.length; i++) out = s.push(seq[i], i * 33);
  assert.equal(out, 1);
});

test('平滑：真的切到 2 时，一个窗口内会跟上', () => {
  const s = new StableCount({ windowMs: 150 });
  for (let i = 0; i < 5; i++) s.push(1, i * 33);
  let out = -1;
  for (let i = 5; i < 12; i++) out = s.push(2, i * 33);
  assert.equal(out, 2);
});

test('平滑：没有手（-1）立刻清空，不会残留旧手指数', () => {
  const s = new StableCount({ windowMs: 150 });
  for (let i = 0; i < 5; i++) s.push(3, i * 33);
  assert.equal(s.push(-1, 200), -1);
  assert.equal(s.push(1, 233), 1);
});
