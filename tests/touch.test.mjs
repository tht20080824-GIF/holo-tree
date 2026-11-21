import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPointerControls } from '../js/touch.js';

// 用假的 canvas / rig 跑真实的 touch.js，覆盖手机上的几种典型手势序列
function makeHarness() {
  const handlers = {};
  const canvas = {
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {},
  };
  const calls = { tap: [], double: [] };
  let clock = 1000;
  const rig = {
    handActive: false,
    touch() {}, nudgeYaw() {}, nudgePitch() {}, nudgeZoom() {},
  };
  attachPointerControls(canvas, rig, {
    onTap: (x, y, type) => { calls.tap.push({ x, y, type }); return false; },
    onDoubleTap: () => calls.double.push(1),
    now: () => clock,
  });
  const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn({ type, pointerId: 1, pointerType: 'touch', ...ev }));
  const tick = (ms) => { clock += ms; };
  return { calls, fire, tick };
}

test('手机点击：手指抖 10px、按住 180ms 仍然算点击', () => {
  const { calls, fire, tick } = makeHarness();
  fire('pointerdown', { clientX: 200, clientY: 400 });
  tick(120);
  fire('pointermove', { clientX: 205, clientY: 406 });
  tick(60);
  fire('pointerup', { clientX: 208, clientY: 410 });
  assert.equal(calls.tap.length, 1);
  assert.equal(calls.tap[0].type, 'touch');
});

test('拖动超过阈值：抬手不算点击', () => {
  const { calls, fire, tick } = makeHarness();
  fire('pointerdown', { clientX: 200, clientY: 400 });
  tick(80);
  fire('pointermove', { clientX: 240, clientY: 430 });
  tick(80);
  fire('pointerup', { clientX: 245, clientY: 435 });
  assert.equal(calls.tap.length, 0);
});

test('双指捏合：任何一根抬起都不算点击', () => {
  const { calls, fire, tick } = makeHarness();
  fire('pointerdown', { clientX: 200, clientY: 400 });
  tick(40);
  fire('pointerdown', { pointerId: 2, clientX: 260, clientY: 460 });
  tick(60);
  fire('pointerup', { pointerId: 2, clientX: 260, clientY: 460 });
  tick(40);
  fire('pointerup', { clientX: 200, clientY: 400 });
  assert.equal(calls.tap.length, 0);
});

test('pointercancel / pointerleave 不算点击', () => {
  const { calls, fire, tick } = makeHarness();
  fire('pointerdown', { clientX: 200, clientY: 400 });
  tick(100);
  fire('pointercancel', { clientX: 200, clientY: 400 });
  tick(100);
  fire('pointerdown', { clientX: 200, clientY: 400 });
  tick(100);
  fire('pointerleave', { clientX: 200, clientY: 400 });
  assert.equal(calls.tap.length, 0);
});

test('连点两下（同一位置、300ms 内）触发双击切形态', () => {
  const { calls, fire, tick } = makeHarness();
  fire('pointerdown', { clientX: 200, clientY: 400 });
  tick(90);
  fire('pointerup', { clientX: 200, clientY: 400 });
  tick(140);
  fire('pointerdown', { clientX: 202, clientY: 401 });
  tick(90);
  fire('pointerup', { clientX: 202, clientY: 401 });
  assert.equal(calls.tap.length, 2);
  assert.equal(calls.double.length, 1);
});
