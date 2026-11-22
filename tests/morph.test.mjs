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
