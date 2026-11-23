import test from 'node:test';
import assert from 'node:assert/strict';
import { measureHand } from '../js/gesture.js';

/**
 * 合成 3D 手：按真实比例摆手指，然后整体旋转，
 * 模拟「正对镜头 / 侧对镜头 / 斜着比」三种情况。
 * extendedFingers: 例如 [0,1] = 只伸食指和中指（比 2）。
 */
function hand3d({ extendedFingers = [0, 1, 2, 3], yaw = 0, pitch = 0, curl = 'back' } = {}) {
  const S = 1;
  const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[0] = { x: 0, y: 0.9 * S, z: 0 };                 // 手腕
  const mcpX = [-0.30, -0.10, 0.10, 0.30];
  const mcpY = [-0.85, -0.92, -0.88, -0.80];
  const chains = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];

  chains.forEach(([mcp, pip, tip], i) => {
    const mx = mcpX[i] * S;
    const my = mcpY[i] * S;
    lm[mcp] = { x: mx, y: my, z: 0 };
    if (extendedFingers.includes(i)) {
      lm[pip] = { x: mx, y: my - 0.32 * S, z: 0.02 };
      lm[tip] = { x: mx, y: my - 0.60 * S, z: 0.04 };
    } else if (curl === 'back') {
      // 蜷起 A：指尖收回掌心（朝镜头方向折）
      lm[pip] = { x: mx, y: my - 0.26 * S, z: 0.10 };
      lm[tip] = { x: mx, y: my - 0.10 * S, z: -0.16 };
    } else {
      // 蜷起 B：手指向下折回掌心（真实握拳更常见）
      lm[pip] = { x: mx, y: my - 0.30 * S, z: 0.02 };
      lm[tip] = { x: mx, y: my - 0.05 * S, z: -0.18 };
    }
  });
  // 指缝过渡点（8/12/16/20 已用），这里补 7/11/15/19
  lm[7] = { x: (lm[6].x + lm[8].x) / 2, y: (lm[6].y + lm[8].y) / 2, z: (lm[6].z + lm[8].z) / 2 };
  lm[11] = { x: (lm[10].x + lm[12].x) / 2, y: (lm[10].y + lm[12].y) / 2, z: (lm[10].z + lm[12].z) / 2 };
  lm[15] = { x: (lm[14].x + lm[16].x) / 2, y: (lm[14].y + lm[16].y) / 2, z: (lm[14].z + lm[16].z) / 2 };
  lm[19] = { x: (lm[18].x + lm[20].x) / 2, y: (lm[18].y + lm[20].y) / 2, z: (lm[18].z + lm[20].z) / 2 };

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return lm.map((p) => {
    const x = p.x * cy + p.z * sy;
    const z = -p.x * sy + p.z * cy;
    const y = p.y * cp - z * sp;
    const z2 = p.y * sp + z * cp;
    return { x: x + 0.5, y: y + 2, z: z2 };
  });
}

const countOf = (opts) => measureHand(hand3d(opts)).extended.filter(Boolean).length;

test('手掌法向：正对镜头，比 2 → 数出 2 指', () => {
  assert.equal(countOf({ extendedFingers: [0, 1] }), 2);
});

test('手掌法向：正对镜头，比 1 → 数出 1 指', () => {
  assert.equal(countOf({ extendedFingers: [0] }), 1);
});

test('手掌法向：正对镜头，五指张开 → 5 指', () => {
  assert.equal(countOf({ extendedFingers: [0, 1, 2, 3] }), 4, '四指模型 + 大拇指不在 FINGERS 里');
});

test('手掌法向：手侧转 40°（手机常见角度）依然数得对', () => {
  assert.equal(countOf({ extendedFingers: [0, 1], yaw: 0.7 }), 2);
  assert.equal(countOf({ extendedFingers: [0], yaw: 0.7 }), 1);
});

test('手掌法向：手抬起 35°（俯视/仰视）依然数得对', () => {
  assert.equal(countOf({ extendedFingers: [0, 1, 2], pitch: 0.6 }), 3);
});

test('手掌法向：握拳 → 0 指', () => {
  assert.equal(countOf({ extendedFingers: [], yaw: 0.3 }), 0);
});

test('手掌法向：比 1 时，两种蜷指姿态都不能被算成 2 指', () => {
  assert.equal(countOf({ extendedFingers: [0], curl: 'back' }), 1);
  assert.equal(countOf({ extendedFingers: [0], curl: 'down' }), 1);
});

test('手掌法向：握拳两种蜷指姿态都是 0 指', () => {
  assert.equal(countOf({ extendedFingers: [], curl: 'back' }), 0);
  assert.equal(countOf({ extendedFingers: [], curl: 'down' }), 0);
});
