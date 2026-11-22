import test from 'node:test';
import assert from 'node:assert/strict';

import { GestureIntent, INTENT } from '../js/gesture.js';

// 直接喂「手掌量」，不需要 21 个关键点：意图层只关心位置和尺度
const hand = (x, y = 0.5, scale = 0.12) => ({ x, y, scale });

/** 跑一段轨迹，收集这期间触发过的意图 */
function run(g, frames) {
  const fired = [];
  for (const [now, h] of frames) {
    const out = g.update(h, now);
    if (out.intent !== INTENT.NONE) fired.push(out.intent);
  }
  return fired;
}

test('意图：向右划 → SWIPE_RIGHT', () => {
  const g = new GestureIntent();
  const frames = [];
  for (let t = 0; t <= 200; t += 20) frames.push([t, hand(0.3 + (0.4 * t) / 200)]);
  assert.deepEqual(run(g, frames), [INTENT.SWIPE_RIGHT]);
});

test('意图：向左划 → SWIPE_LEFT', () => {
  const g = new GestureIntent();
  const frames = [];
  for (let t = 0; t <= 200; t += 20) frames.push([t, hand(0.75 - (0.4 * t) / 200)]);
  assert.deepEqual(run(g, frames), [INTENT.SWIPE_LEFT]);
});

test('意图：向上划 / 向下划 分别识别（屏幕坐标 y 向下增大）', () => {
  const up = new GestureIntent();
  const upFrames = [];
  for (let t = 0; t <= 200; t += 20) upFrames.push([t, hand(0.5, 0.7 - (0.35 * t) / 200)]);
  assert.deepEqual(run(up, upFrames), [INTENT.SWIPE_UP]);

  const down = new GestureIntent();
  const downFrames = [];
  for (let t = 0; t <= 200; t += 20) downFrames.push([t, hand(0.5, 0.3 + (0.35 * t) / 200)]);
  assert.deepEqual(run(down, downFrames), [INTENT.SWIPE_DOWN]);
});

test('意图：慢慢挪动不算划动（速度不够）', () => {
  const g = new GestureIntent();
  const frames = [];
  for (let t = 0; t <= 600; t += 20) frames.push([t, hand(0.3 + (0.35 * t) / 600)]);
  assert.deepEqual(run(g, frames), []);
});

test('意图：原地抖动不算划动（位移太小 + 路径不直）', () => {
  const g = new GestureIntent();
  const frames = [];
  for (let i = 0; i < 30; i++) {
    const t = i * 20;
    frames.push([t, hand(0.5 + (i % 2 ? 0.02 : -0.02), 0.5 + (i % 2 ? 0.01 : -0.01))]);
  }
  assert.deepEqual(run(g, frames), []);
});

test('意图：画圈（位移不大但路径很弯）不误判成划动', () => {
  const g = new GestureIntent();
  const frames = [];
  const R = 0.09;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    frames.push([i * 18, hand(0.5 + Math.cos(a) * R, 0.5 + Math.sin(a) * R)]);
  }
  assert.deepEqual(run(g, frames), []);
});

test('意图：手推向镜头（手掌变大）→ PUSH；拉远 → PULL', () => {
  const push = new GestureIntent();
  const pushFrames = [];
  for (let t = 0; t <= 200; t += 20) pushFrames.push([t, hand(0.5, 0.5, 0.11 + 0.06 * (t / 200))]);
  assert.deepEqual(run(push, pushFrames), [INTENT.PUSH]);

  const pull = new GestureIntent();
  const pullFrames = [];
  for (let t = 0; t <= 200; t += 20) pullFrames.push([t, hand(0.5, 0.5, 0.17 - 0.06 * (t / 200))]);
  assert.deepEqual(run(pull, pullFrames), [INTENT.PULL]);
});

test('意图：一次挥动只触发一次（触发后清空轨迹）', () => {
  const g = new GestureIntent();
  const frames = [];
  for (let t = 0; t <= 300; t += 20) frames.push([t, hand(0.25 + (0.5 * Math.min(t, 200)) / 200)]);
  const fired = run(g, frames);
  assert.equal(fired.length, 1, `一次挥动触发了 ${fired.length} 次`);
});

test('意图：冷却期内重复划动不再触发，冷却过后可以再触发', () => {
  const g = new GestureIntent();
  // 第一划：0~180ms
  const first = [];
  for (let t = 0; t <= 180; t += 20) first.push([t, hand(0.25 + (0.45 * t) / 180)]);
  assert.deepEqual(run(g, first), [INTENT.SWIPE_RIGHT]);

  // 第二划紧接着（冷却中）：200~380ms
  const second = [];
  for (let t = 200; t <= 380; t += 20) second.push([t, hand(0.25 + (0.45 * (t - 200)) / 180)]);
  assert.deepEqual(run(g, second), []);

  // 第三划在冷却之后：700ms 起
  const third = [];
  for (let t = 700; t <= 880; t += 20) third.push([t, hand(0.25 + (0.45 * (t - 700)) / 180)]);
  assert.deepEqual(run(g, third), [INTENT.SWIPE_RIGHT]);
});

test('意图：手消失后清空轨迹，不会把手离开当成划动', () => {
  const g = new GestureIntent();
  for (let t = 0; t <= 100; t += 20) g.update(hand(0.4), t);
  assert.equal(g.update(null, 120).intent, INTENT.NONE);
  // 手回来时只有一个点，跨度不够，不应该触发
  assert.equal(g.update(hand(0.9), 140).intent, INTENT.NONE);
});