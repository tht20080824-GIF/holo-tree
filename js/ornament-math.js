/**
 * 装饰物的摆放算法（纯函数，可单测）。
 *
 * 原则：挂在树身外侧一点点（不穿模、不悬空），高度错开，角度用黄金角散开，
 * 避免"一排挂在同一高度"的廉价感。
 */

import { trunkRadius } from './ribbon-math.js';

const GOLDEN_ANGLE = 2.399963;

/**
 * 散开态下蝴蝶结要飞去的地方：和粒子云的球壳同一个量级，
 * 但不与树心重合，避免所有蝴蝶结挤成一团。
 */
export function makeScatterPoint(rng = Math.random) {
  const phi = Math.acos(2 * rng() - 1);
  const theta = rng() * Math.PI * 2;
  const layer = 15 + rng() * 11;
  return {
    x: Math.sin(phi) * Math.cos(theta) * layer,
    y: Math.cos(phi) * layer * 0.6 + 2,
    z: Math.sin(phi) * Math.sin(theta) * layer,
  };
}

/**
 * @param {object} opts
 * @param {number} opts.count 数量
 * @param {number} opts.height 树高
 * @param {number} opts.floorY 树底 y
 * @param {number} opts.baseRadius 树底半径
 * @param {number} opts.tMin 最低高度（0~1）
 * @param {number} opts.tMax 最高高度
 * @param {number} opts.clearance 相对树身半径的外扩倍数
 * @param {() => number} opts.rng
 */
export function placeOrnaments({
  count,
  height,
  floorY,
  baseRadius,
  tMin = 0.14,
  tMax = 0.86,
  clearance = 1.16,
  rng = Math.random,
} = {}) {
  const items = [];

  for (let i = 0; i < count; i++) {
    // 均匀铺开再抖一点，避免等距排列的死板
    const base = count === 1 ? 0.5 : i / (count - 1);
    const t = tMin + (tMax - tMin) * (base * 0.86 + rng() * 0.14);

    const angle = i * GOLDEN_ANGLE + rng() * 0.5;
    const r = trunkRadius(t, baseRadius) * (clearance + rng() * 0.06);
    const y = floorY + height * t;

    items.push({
      t,
      angle,
      radius: r,
      position: {
        x: Math.cos(angle) * r,
        y: y + (rng() - 0.5) * 0.4,
        z: Math.sin(angle) * r,
      },
      // 朝外，并带一点随机倾斜，看着是"挂"上去的而不是贴纸
      yaw: Math.atan2(Math.cos(angle) * r, Math.sin(angle) * r),
      tilt: (rng() - 0.5) * 0.35,
      scale: 0.78 + rng() * 0.4,
      phase: rng() * Math.PI * 2,
    });
  }

  return items;
}
