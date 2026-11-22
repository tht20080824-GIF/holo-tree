import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEART_DISSOLVE,
  easeOutCubic,
  smoothstep,
  edgeAlpha,
  centerAlpha,
  dissolveAlpha,
  dissolveSize,
  dissolveDarken,
  createHeartDissolve,
  dissolveOffset,
} from '../js/heart-dissolve.js';

function seeded(seed = 17) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** 造一圈假的爱心平面坐标（半径 0~1） */
function ring(n) {
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const rng = seeded(3);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const r = rng();
    u[i] = Math.cos(a) * r;
    v[i] = Math.sin(a) * r;
  }
  return { u, v };
}

test('消散：亮度先降、形状后散（边缘 0.35s 到 0.55，中心仍全亮）', () => {
  assert.equal(edgeAlpha(0), 1);
  assert.ok(Math.abs(edgeAlpha(0.35) - 0.55) < 1e-6, `边缘 0.35s 应降到 0.55，实际 ${edgeAlpha(0.35)}`);
  assert.equal(centerAlpha(0.35), 1, '0.35s 时中心还应是全亮');
  assert.equal(edgeAlpha(3.0), 0);
  assert.equal(centerAlpha(3.0), 0);
});

test('消散：三段亮度曲线单调不上升', () => {
  for (const fn of [edgeAlpha, centerAlpha]) {
    let prev = fn(0);
    for (let t = 0.05; t <= 3.2; t += 0.05) {
      const v = fn(t);
      assert.ok(v <= prev + 1e-6, `t=${t.toFixed(2)} 亮度回升了`);
      prev = v;
    }
  }
});

test('消散：单颗粒子透明度在「边缘/中心」之间插值', () => {
  const t = 0.35;
  assert.ok(Math.abs(dissolveAlpha(1, t) - edgeAlpha(t)) < 1e-6);
  assert.ok(Math.abs(dissolveAlpha(0, t) - centerAlpha(t)) < 1e-6);
  const mid = dissolveAlpha(0.5, t);
  assert.ok(mid > edgeAlpha(t) && mid < centerAlpha(t), '中间半径应该介于两者之间');
});

test('消散：尺寸 1.0 → 0.45', () => {
  assert.equal(dissolveSize(0), 1);
  assert.equal(dissolveSize(1), 1);
  assert.ok(Math.abs(dissolveSize(3.0) - 0.45) < 1e-6);
});

test('消散：颜色在 1.8s 之后才明显变暗', () => {
  assert.equal(dissolveDarken(1.5), 0);
  assert.ok(dissolveDarken(2.2) > 0.1);
  assert.equal(dissolveDarken(3.2), 1);
});

test('消散：轮廓相位分组 —— 12~16 组，组间错峰 0.06s', () => {
  const n = 4000;
  const { u, v } = ring(n);
  const st = createHeartDissolve(n, u, v, 1, seeded(5));

  const groups = new Set(st.group);
  assert.ok(groups.size >= 12 && groups.size <= 16, `实际分成 ${groups.size} 组`);
  assert.ok(HEART_DISSOLVE.groups >= 12 && HEART_DISSOLVE.groups <= 16);

  const delays = new Set(Array.from(st.delay, (d) => d.toFixed(3)));
  assert.ok(delays.size >= 12, '每组都要有不同的起始时间');
  assert.ok(Math.max(...st.delay) > 0.5, '最后一组要明显晚于第一组');

  // 组号越大，起始越晚
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(st.delay[i] - st.group[i] * HEART_DISSOLVE.stagger) < 1e-6);
  }
});

test('消散：速度分层 0.22~1.0，且慢的占多数（pow(seed,2)）', () => {
  const n = 2000;
  const { u, v } = ring(n);
  const st = createHeartDissolve(n, u, v, 1, seeded(9));
  let slow = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(st.speed[i] >= 0.22 - 1e-6 && st.speed[i] <= 1 + 1e-6);
    if (st.speed[i] < 0.5) slow++;
  }
  assert.ok(slow > n * 0.5, '平方分布应该让慢速粒子占多数');
});

test('消散：丝带分股 —— 3~4 股且都有粒子', () => {
  const n = 3000;
  const { u, v } = ring(n);
  const st = createHeartDissolve(n, u, v, 1, seeded(11));
  const counts = new Map();
  for (let i = 0; i < n; i++) counts.set(st.strand[i], (counts.get(st.strand[i]) || 0) + 1);
  assert.equal(counts.size, HEART_DISSOLVE.strands);
  assert.ok(counts.size >= 3 && counts.size <= 4);
  for (const c of counts.values()) assert.ok(c > n * 0.1, '每股都应该有足够粒子');
});

test('消散：起丝前（<0.35s）粒子不动', () => {
  const n = 400;
  const { u, v } = ring(n);
  const st = createHeartDissolve(n, u, v, 1, seeded(13));
  const out = [0, 0, 0];
  for (const t of [0, 0.1, 0.34]) {
    for (let i = 0; i < n; i++) {
      dissolveOffset(st, i, t, out);
      assert.ok(Math.hypot(out[0], out[1]) < 1e-9, `t=${t} 就有粒子动了`);
    }
  }
});

test('消散：0.5s 心形还聚得住，1.5s 已经散开', () => {
  const n = 800;
  const { u, v } = ring(n);
  const st = createHeartDissolve(n, u, v, 1, seeded(15));
  const out = [0, 0, 0];

  const meanAt = (t) => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      dissolveOffset(st, i, t, out);
      sum += Math.hypot(out[0], out[1]);
    }
    return sum / n;
  };

  const early = meanAt(0.5);
  const late = meanAt(1.5);
  assert.ok(early < 0.25, `0.5s 平均位移 ${early.toFixed(3)} 太大，心形会散架`);
  assert.ok(late > early * 2.5, `1.5s 应明显散开：${late.toFixed(2)} vs ${early.toFixed(2)}`);
});

test('消散：位移有界，不会飞出天际', () => {
  const n = 300;
  const { u, v } = ring(n);
  const maxR = 1;
  const st = createHeartDissolve(n, u, v, maxR, seeded(19));
  const cfg = { ...HEART_DISSOLVE, maxSpread: maxR * 2.6 };
  const out = [0, 0, 0];
  let worst = 0;
  for (let i = 0; i < n; i++) {
    dissolveOffset(st, i, 3.2, out, cfg);
    worst = Math.max(worst, Math.hypot(out[0], out[1]));
  }
  assert.ok(worst < maxR * 5, `最远粒子跑到了 ${worst.toFixed(2)}（爱心半径 ${maxR}）`);
});

test('消散：easeOutCubic 端点正确', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-1), 0);
  assert.equal(easeOutCubic(2), 1);
  assert.ok(easeOutCubic(0.2) > 0.2, 'easeOut 应该一开始就快');
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
});