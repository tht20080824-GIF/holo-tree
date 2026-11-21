/**
 * 圣诞装饰：小礼盒 + 蝴蝶结。
 *
 * 设计原则（对应"美观但不廉价"）：
 * - 数量克制：礼盒 5 个、蝴蝶结 4 个；
 * - 只挂在树身外侧 1.16 倍半径处，不挡主体、不穿模；
 * - 材质走"绒面 + 金属丝带"，靠材质反射出质感，而不是靠发光；
 * - 颜色全部取自现有调色板（深绿 / 酒红 / 墨蓝 + 香槟金），不引入新色系。
 */

import * as THREE from 'three';
import { placeOrnaments } from './ornament-math.js';

/** 蝴蝶结：两个压扁的环 + 结心 + 两条飘带 */
export function createBow({ scale = 1, color = 0xd9b264, sheen = 0xa8874a } = {}) {
  const group = new THREE.Group();

  const material = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.35,
    roughness: 0.32,
    sheen: 0.6,
    sheenColor: new THREE.Color(sheen),
    sheenRoughness: 0.5,
  });

  const loopGeo = new THREE.TorusGeometry(0.15, 0.042, 10, 26);
  for (const dir of [-1, 1]) {
    const loop = new THREE.Mesh(loopGeo, material);
    loop.scale.set(1, 0.62, 0.42);
    loop.rotation.z = dir * 0.52;
    loop.position.set(dir * 0.13, 0.01, 0);
    group.add(loop);
  }

  // 结心
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), material);
  knot.scale.set(1, 0.85, 0.9);
  group.add(knot);

  // 飘带
  const tailGeo = new THREE.BoxGeometry(0.055, 0.26, 0.018);
  for (const dir of [-1, 1]) {
    const tail = new THREE.Mesh(tailGeo, material);
    tail.position.set(dir * 0.06, -0.19, 0);
    tail.rotation.z = dir * 0.22;
    group.add(tail);
  }

  group.scale.setScalar(scale);
  return group;
}

/** 小礼盒：盒身 + 盒盖 + 十字丝带 + 顶部蝴蝶结 */
export function createGiftBox({
  size = 0.7,
  bodyColor = 0x103f2c,
  ribbonColor = 0xd9b264,
} = {}) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: bodyColor,
    metalness: 0.15,
    roughness: 0.62,
    sheen: 0.5,
    sheenColor: new THREE.Color(0xffffff),
    sheenRoughness: 0.7,
  });
  const ribbonMat = new THREE.MeshStandardMaterial({
    color: ribbonColor,
    metalness: 0.85,
    roughness: 0.26,
  });

  const h = size * 0.72;
  const body = new THREE.Mesh(new THREE.BoxGeometry(size, h, size), bodyMat);
  body.position.y = h / 2;
  group.add(body);

  // 盒盖略大一圈，边缘才不像个纯色方块
  const lid = new THREE.Mesh(new THREE.BoxGeometry(size * 1.07, size * 0.09, size * 1.07), bodyMat);
  lid.position.y = h + size * 0.045;
  group.add(lid);

  // 十字丝带
  const bandH = new THREE.Mesh(new THREE.BoxGeometry(size * 1.09, h * 1.02, size * 0.14), ribbonMat);
  bandH.position.y = h / 2;
  group.add(bandH);

  const bandV = new THREE.Mesh(new THREE.BoxGeometry(size * 0.14, h * 1.02, size * 1.09), ribbonMat);
  bandV.position.y = h / 2;
  group.add(bandV);

  const bow = createBow({ scale: size * 0.62, color: ribbonColor });
  bow.position.y = h + size * 0.1;
  group.add(bow);

  return group;
}

/**
 * 一整组装饰：按摆放算法挂在树身外侧。
 * @returns {{group: THREE.Group, update: (dt:number, time:number) => void}}
 */
export function createOrnamentSet({ cfg, shape }) {
  const group = new THREE.Group();
  const items = [];

  const gifts = placeOrnaments({
    count: cfg.gifts,
    height: shape.height,
    floorY: shape.floorY,
    baseRadius: shape.baseRadius,
    tMin: 0.16,
    tMax: 0.58,      // 礼盒压在中下部，不抢顶部
    clearance: 1.16,
  });

  const bows = placeOrnaments({
    count: cfg.bows,
    height: shape.height,
    floorY: shape.floorY,
    baseRadius: shape.baseRadius,
    tMin: 0.42,
    tMax: 0.84,      // 蝴蝶结偏上，形成节奏
    clearance: 1.18,
  });

  const giftColors = cfg.giftColors;
  gifts.forEach((spot, i) => {
    const node = createGiftBox({
      size: cfg.giftSize * spot.scale,
      bodyColor: giftColors[i % giftColors.length],
      ribbonColor: cfg.ribbonColor,
    });
    node.position.set(spot.position.x, spot.position.y, spot.position.z);
    node.rotation.y = spot.yaw;
    node.rotation.z = spot.tilt * 0.5;
    group.add(node);
    items.push({ node, baseY: spot.position.y, phase: spot.phase, amp: 0.16 });
  });

  const bowColors = cfg.bowColors;
  bows.forEach((spot, i) => {
    const node = createBow({ scale: cfg.bowSize * spot.scale, color: bowColors[i % bowColors.length] });
    node.position.set(spot.position.x, spot.position.y, spot.position.z);
    node.rotation.y = spot.yaw;
    node.rotation.z = spot.tilt;
    group.add(node);
    items.push({ node, baseY: spot.position.y, phase: spot.phase, amp: 0.22 });
  });

  return {
    group,
    items,
    update(dt, time) {
      for (const item of items) {
        // 极轻的上下浮动，幅度 <0.25 单位，避免"挂件乱晃"
        item.node.position.y = item.baseY + Math.sin(time * 0.9 + item.phase) * item.amp;
      }
    },
  };
}
