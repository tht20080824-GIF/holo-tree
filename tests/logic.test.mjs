import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../js/config.js';
import { measureHand, GestureRecognizer, GESTURE, MODE } from '../js/gesture.js';
import { Rig } from '../js/controls.js';
import { makeHand } from './fixtures.mjs';

test('measureHand: 张开手掌 vs 握拳，张开度落在合理区间', () => {
  const open = measureHand(makeHand({ open: true }));
  const fist = measureHand(makeHand({ open: false }));

  assert.ok(open.openness > CONFIG.gesture.openOn, `张开度 ${open.openness.toFixed(2)} 应大于阈值 ${CONFIG.gesture.openOn}`);
  assert.ok(fist.openness < CONFIG.gesture.fistOn, `握拳张开度 ${fist.openness.toFixed(2)} 应小于阈值 ${CONFIG.gesture.fistOn}`);
  // 中间不能有重叠：阈值之间必须留出安全带
  assert.ok(CONFIG.gesture.fistOn < CONFIG.gesture.openOn);
});

test('measureHand: 捏合时 pinchRatio 明显变小', () => {
  const pinch = measureHand(makeHand({ pinched: true }));
  const spread = measureHand(makeHand({ pinched: false }));
  assert.ok(pinch.pinchRatio < CONFIG.gesture.pinchOn);
  assert.ok(spread.pinchRatio > CONFIG.gesture.pinchOff);
});

test('measureHand: 手在画面右侧时 x 变大（镜像后）', () => {
  // 注意：px 是「未镜像的摄像头原图」坐标。真手往自己右边移 → 原图里偏左。
  const right = measureHand(makeHand({ px: 0.15 }));
  const left = measureHand(makeHand({ px: 0.85 }));
  assert.ok(right.x > 0.5 && left.x < 0.5);
});

test('measureHand: 空输入返回 null，尺度不除零', () => {
  assert.equal(measureHand(null), null);
  assert.equal(measureHand([]), null);
  const degenerate = makeHand();
  degenerate[9] = { ...degenerate[0] }; // 中指根和手腕重合
  const m = measureHand(degenerate);
  assert.ok(Number.isFinite(m.scale) && m.scale > 0);
});

test('识别器：捏合有滞回，中间值不会来回闪', () => {
  const r = new GestureRecognizer(CONFIG.gesture);
  const hand = (ratio) => ({ ...measureHand(makeHand()), pinchRatio: ratio });

  assert.equal(r.update(hand(0.2), 1 / 60).pinched, true);   // 低于 pinchOn 进入捏合
  assert.equal(r.update(hand(0.45), 1 / 60).pinched, true);  // 处于中间带：保持
  assert.equal(r.update(hand(0.6), 1 / 60).pinched, false);  // 高于 pinchOff 才松开
});

test('识别器：张开手掌需保持 holdTime 才切到散开态', () => {
  const r = new GestureRecognizer(CONFIG.gesture);
  const open = measureHand(makeHand({ open: true }));
  const dt = 1 / 60;

  // 只保持 0.1 秒：不该切换
  for (let t = 0; t < 0.1; t += dt) {
    const out = r.update(open, dt);
    assert.equal(out.modeChanged, null);
    assert.equal(out.mode, MODE.TREE);
  }

  // 继续保持到超过 holdTime：切换，且只切一次
  let changes = 0;
  for (let t = 0; t < 0.6; t += dt) {
    const out = r.update(open, dt);
    if (out.modeChanged) changes += 1;
  }
  assert.equal(changes, 1, 'modeChanged 只应触发一次');
  assert.equal(r.mode, MODE.SCATTER);
});

test('识别器：握拳回到合拢态，手消失清掉姿势但不丢形态', () => {
  const r = new GestureRecognizer(CONFIG.gesture);
  const dt = 1 / 60;
  for (let t = 0; t < 0.5; t += dt) r.update(measureHand(makeHand({ open: true })), dt);
  assert.equal(r.mode, MODE.SCATTER);

  for (let t = 0; t < 0.5; t += dt) r.update(measureHand(makeHand({ open: false })), dt);
  assert.equal(r.mode, MODE.TREE);

  const gone = r.update(null, dt);
  assert.equal(gone.present, false);
  assert.equal(gone.mode, MODE.TREE);
});

test('Rig：手靠近镜头（尺度大）时拉近', () => {
  const near = new Rig(CONFIG.rig);
  near.update(1 / 60, measureHand(makeHand({ s: 0.2 })));
  const far = new Rig(CONFIG.rig);
  far.update(1 / 60, measureHand(makeHand({ s: 0.09 })));
  assert.ok(near.distanceTarget < far.distanceTarget);
  assert.ok(near.distanceTarget >= CONFIG.rig.zoomNear - 1e-9);
});

test('Rig：判向持续旋转与帧率无关（60fps vs 20fps）', () => {
  const a = new Rig(CONFIG.rig);
  const b = new Rig(CONFIG.rig);
  const hand = measureHand(makeHand({ px: 0.1 })); // 真手最右

  for (let i = 0; i < 60; i++) a.update(1 / 60, hand);
  for (let i = 0; i < 20; i++) b.update(1 / 20, hand);

  assert.equal(a.spinDir, 1);
  assert.equal(b.spinDir, 1);
  assert.ok(Math.abs(a.yawTarget - b.yawTarget) < 0.12,
    `60fps=${a.yawTarget.toFixed(3)} 20fps=${b.yawTarget.toFixed(3)}`);
});

test('Rig：无手一段时间后自动旋转', () => {
  const rig = new Rig(CONFIG.rig);
  const start = rig.yawTarget;
  for (let i = 0; i < 180; i++) rig.update(1 / 60, null); // 3 秒
  assert.ok(rig.yawTarget > start + 0.1);
});

test('Rig：陀螺仪接管后跟随倾斜，且不再自动旋转', () => {
  const rig = new Rig(CONFIG.rig);
  for (let i = 0; i < 120; i++) rig.update(1 / 60, null); // 先自转一会儿
  const base = rig.yawTarget;

  rig.enableGyro();
  rig.setGyro(0.6, 0.1);
  rig.update(1 / 60, null);

  // 目标应停在 base + 0.6，不能继续自增
  assert.ok(Math.abs(rig.yawTarget - (base + 0.6)) < 1e-6, `yawTarget=${rig.yawTarget} 期望 ${base + 0.6}`);

  for (let i = 0; i < 60; i++) rig.update(1 / 60, null);
  assert.ok(Math.abs(rig.yawTarget - (base + 0.6)) < 1e-6, '陀螺仪开启时不应再有自动旋转');
  assert.ok(Math.abs(rig.pitchTarget - 0.1) < 1e-6);
});

test('Rig：手出现时优先于陀螺仪', () => {
  const rig = new Rig(CONFIG.rig);
  rig.enableGyro();
  rig.setGyro(0.9, 0);
  rig.update(1 / 60, null);

  const hand = measureHand(makeHand({ px: 0.1 })); // 真手最右
  for (let i = 0; i < 60; i++) rig.update(1 / 60, hand);
  assert.ok(rig.yaw > 0.4, `手应接管，yaw=${rig.yaw.toFixed(2)}`);
});

test('Rig：关闭陀螺仪后恢复正常（自转会回来）', () => {
  const rig = new Rig(CONFIG.rig);
  rig.enableGyro();
  rig.setGyro(0.5, 0);
  rig.update(1 / 60, null);
  rig.disableGyro();

  const before = rig.yawTarget;
  for (let i = 0; i < 180; i++) rig.update(1 / 60, null);
  assert.ok(rig.yawTarget > before + 0.1, '关闭后应重新开始自动旋转');
});

test('Rig：判向成功后手移开，仍然持续旋转', () => {
  const rig = new Rig(CONFIG.rig);
  const hand = measureHand(makeHand({ px: 0.08 })); // 真手最右

  for (let i = 0; i < 12; i++) rig.update(1 / 60, hand); // 0.2s，超过 steerHold
  assert.equal(rig.spinDir, 1, '应锁定为向右');
  const before = rig.yawTarget;

  for (let i = 0; i < 30; i++) rig.update(1 / 60, null); // 手彻底移开 0.5s
  assert.ok(rig.yawTarget > before + 0.2,
    `手移开后应继续转，实际只增加了 ${(rig.yawTarget - before).toFixed(3)}`);
});

test('Rig：没有方向时保持自然自转，速度已按 1.3 倍提升', () => {
  const rig = new Rig(CONFIG.rig);
  const start = rig.yawTarget;
  for (let i = 0; i < 60; i++) rig.update(1 / 60, null); // 1 秒
  const gained = rig.yawTarget - start;
  assert.ok(Math.abs(gained - CONFIG.rig.idleYawSpeed) < 0.02,
    `1 秒自然自转 ${gained.toFixed(3)}，期望 ${CONFIG.rig.idleYawSpeed}`);
  assert.ok(CONFIG.rig.idleYawSpeed > 0.16 * 1.25, '自然转速应比原 0.16 提升约 1.3 倍');
});

test('Rig：手回到中心稳住后停止转向', () => {
  const rig = new Rig(CONFIG.rig);
  const right = measureHand(makeHand({ px: 0.08 }));
  const center = measureHand(makeHand({ px: 0.5 }));

  for (let i = 0; i < 20; i++) rig.update(1 / 60, right);
  assert.equal(rig.spinDir, 1);

  // 回中心，但还没到 centerStopTime
  for (let i = 0; i < 20; i++) rig.update(1 / 60, center);
  assert.equal(rig.spinDir, 1, '刚回中心不应立刻停');

  // 继续稳住超过 centerStopTime
  for (let i = 0; i < 40; i++) rig.update(1 / 60, center);
  assert.equal(rig.spinDir, 0, '稳住后应停止转向');
});

test('Rig：方向可以左右切换', () => {
  const rig = new Rig(CONFIG.rig);
  const right = measureHand(makeHand({ px: 0.08 }));
  const left = measureHand(makeHand({ px: 0.92 }));

  for (let i = 0; i < 20; i++) rig.update(1 / 60, right);
  assert.equal(rig.spinDir, 1);

  for (let i = 0; i < 20; i++) rig.update(1 / 60, left);
  assert.equal(rig.spinDir, -1);

  const before = rig.yawTarget;
  for (let i = 0; i < 30; i++) rig.update(1 / 60, left);
  assert.ok(rig.yawTarget < before, '切换后应朝反方向累加');
});

test('Rig：手停在阈值内侧（不够果断的幅度）不会锁定方向', () => {
  const rig = new Rig(CONFIG.rig);
  // 偏移只有 0.2（nx≈0.4 的量级），低于 steerEnter
  const nearCenter = measureHand(makeHand({ px: 0.42 }));
  for (let i = 0; i < 30; i++) rig.update(1 / 60, nearCenter);
  assert.equal(rig.spinDir, 0, '幅度不够时不应锁定');
});

test('Rig：手快速甩向一侧会立即锁定（速度抢判，不等 steerHold）', () => {
  const rig = new Rig(CONFIG.rig);
  const dt = 1 / 60;
  const center = measureHand(makeHand({ px: 0.5 }));

  rig.update(dt, center);
  // 一帧之内甩到右侧：速度极大
  const far = measureHand(makeHand({ px: 0.15 }));
  rig.update(dt, far);
  rig.update(dt, far);
  assert.equal(rig.spinDir, 1, '快速甩动应立即锁向');
});

test('Rig：手移动越快，转速越快（手速加速）', () => {
  const dt = 1 / 60;

  // A：手停在右侧不动
  const slow = new Rig(CONFIG.rig);
  const still = measureHand(makeHand({ px: 0.2 }));
  for (let i = 0; i < 10; i++) slow.update(dt, still);
  const base = slow.yawTarget;
  for (let i = 0; i < 20; i++) slow.update(dt, still);
  const slowGain = slow.yawTarget - base;

  // B：手持续向右快速移动
  const fast = new Rig(CONFIG.rig);
  let farX = 0.45;
  for (let i = 0; i < 10; i++) fast.update(dt, measureHand(makeHand({ px: farX })));
  fast.update(dt, measureHand(makeHand({ px: 0.42 })));
  const fastBase = fast.yawTarget;
  for (let i = 0; i < 20; i++) {
    farX = Math.max(0.05, 0.42 - i * 0.02);
    fast.update(dt, measureHand(makeHand({ px: farX })));
  }
  const fastGain = fast.yawTarget - fastBase;

  assert.ok(fast.speedMul > 1.05, `手速倍率应大于 1，实际 ${fast.speedMul.toFixed(2)}`);
  assert.ok(fastGain > slowGain * 1.15,
    `快速移动应转得更快：慢 ${slowGain.toFixed(2)} vs 快 ${fastGain.toFixed(2)}`);
});

test('Rig：手出现不会打断已锁定的方向', () => {
  const rig = new Rig(CONFIG.rig);
  const right = measureHand(makeHand({ px: 0.08 }));
  for (let i = 0; i < 20; i++) rig.update(1 / 60, right);
  assert.equal(rig.spinDir, 1);

  // 手停在同一侧继续，方向保持
  for (let i = 0; i < 20; i++) rig.update(1 / 60, right);
  assert.equal(rig.spinDir, 1);
});

test('Rig：手越靠边转得越快（比例转向，不是固定转速）', () => {
  const dt = 1 / 60;
  const edge = new Rig(CONFIG.rig);
  const mid = new Rig(CONFIG.rig);

  // px 越小 → x 越大 → 越靠右；0.05 是几乎贴边，0.35 只是刚过门限
  const far = measureHand(makeHand({ px: 0.05 }));
  const near = measureHand(makeHand({ px: 0.35 }));

  for (let i = 0; i < 120; i++) edge.update(dt, far);
  for (let i = 0; i < 120; i++) mid.update(dt, near);

  assert.equal(edge.spinDir, 1);
  assert.equal(mid.spinDir, 1);
  assert.ok(edge.yawTarget > mid.yawTarget * 1.2,
    `贴边转 ${edge.yawTarget.toFixed(2)} 应明显快于刚过门限 ${mid.yawTarget.toFixed(2)}`);
});

test('Rig：甩手冲量立即生效并锁定方向', () => {
  const rig = new Rig(CONFIG.rig);
  const before = rig.yawTarget;
  rig.flickYaw(1, 1);
  assert.ok(rig.yawTarget - before >= CONFIG.rig.flickYaw * 0.99, '冲量应立刻加到目标角上');
  assert.equal(rig.spinDir, 1, '甩完顺势保持这个方向');

  rig.flickYaw(-1, 1);
  assert.equal(rig.spinDir, -1, '反向甩应立刻反向');
});

test('Rig：竖划冲量让俯仰变化，随后自然衰减', () => {
  const rig = new Rig(CONFIG.rig);
  const hand = measureHand(makeHand({ px: 0.5, py: 0.5 })); // 手在正中

  rig.flickPitch(1, 1);
  rig.update(1 / 60, hand);
  const peak = rig.pitchTarget;
  assert.ok(peak > 0.05, `竖划后应有抬头的冲量，实际 ${peak.toFixed(3)}`);

  for (let i = 0; i < 120; i++) rig.update(1 / 60, hand); // 2 秒
  assert.ok(Math.abs(rig.pitchTarget) < 0.02, `冲量应衰减掉，实际 ${rig.pitchTarget.toFixed(3)}`);
});

test('Rig：推向镜头的冲量让距离变小（靠近）', () => {
  const rig = new Rig(CONFIG.rig);
  const hand = measureHand(makeHand({ s: 0.12 }));
  rig.update(1 / 60, hand);
  const base = rig.distanceTarget;

  rig.flickZoom(-1);
  rig.update(1 / 60, hand);
  assert.ok(rig.distanceTarget < base, `推近后距离应更小：${rig.distanceTarget.toFixed(3)} vs ${base.toFixed(3)}`);
});

test('Rig：接回流程锁定期间，手和指针都不生效', () => {
  const rig = new Rig(CONFIG.rig);
  const hand = measureHand(makeHand({ px: 0.1 }));

  for (let i = 0; i < 30; i++) rig.update(1 / 60, hand);
  const yawBefore = rig.yawTarget;
  const pitchBefore = rig.pitchTarget;
  const distBefore = rig.distanceTarget;

  rig.locked = true;
  rig.nudgeYaw(400);
  rig.nudgePitch(300);
  rig.nudgeZoom(900);
  rig.flickYaw(1, 1);
  rig.flickZoom(-1);
  for (let i = 0; i < 60; i++) rig.update(1 / 60, hand);

  assert.equal(rig.yawTarget, yawBefore, '锁定时目标角不能变');
  assert.equal(rig.pitchTarget, pitchBefore, '锁定时俯仰不能变');
  assert.equal(rig.distanceTarget, distBefore, '锁定时距离不能变');
});

test('Rig：解锁后恢复响应', () => {
  const rig = new Rig(CONFIG.rig);
  rig.locked = true;
  const hand = measureHand(makeHand({ px: 0.1 }));
  for (let i = 0; i < 30; i++) rig.update(1 / 60, hand);
  const before = rig.yawTarget;

  rig.locked = false;
  for (let i = 0; i < 60; i++) rig.update(1 / 60, hand);
  assert.ok(rig.yawTarget !== before, '解锁后应重新响应手势');
});
