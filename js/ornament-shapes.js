/**
 * 装饰物的"粒子形状"采样（纯函数，可单测）。
 *
 * 装饰不再是实体网格，而是**同一套粒子材质**拼出的形状：
 * 所以它们和树身粒子完全同源 —— 同样的光泽、同样的粒度，
 * 散开时自然跟着粒子走，合拢时重新拼回礼盒/蝴蝶结。
 *
 * 每个采样点返回：位置 + 颜色 + 尺寸系数。
 */

const GOLD = [0xffd27a, 0xffb547, 0xfff3c9];
const GREEN = [0x1e8a56, 0x2fbf72, 0x0e6440];
const RED = [0xff3b5c, 0xd6233f, 0xff6f83];

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

/** 在长方体表面均匀采样（六个面各自等概率） */
function boxSurface(w, h, d, count, rng, yBase = 0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const face = Math.floor(rng() * 6);
    const u = rng() - 0.5;
    const v = rng() - 0.5;
    let x = 0;
    let y = 0;
    let z = 0;
    if (face === 0) { x = u * w; y = h / 2; z = v * d; }        // 顶
    else if (face === 1) { x = u * w; y = -h / 2; z = v * d; }  // 底
    else if (face === 2) { x = u * w; y = v * h; z = d / 2; }   // 前
    else if (face === 3) { x = u * w; y = v * h; z = -d / 2; }  // 后
    else if (face === 4) { x = w / 2; y = v * h; z = u * d; }   // 右
    else { x = -w / 2; y = v * h; z = u * d; }                  // 左
    out.push({ x, y: y + yBase, z });
  }
  return out;
}

/** 环形带：沿一个压扁的椭圆采样，带一点厚度抖动 */
function loopBand(cx, cy, a, b, tilt, count, rng, thickness = 0.02) {
  const out = [];
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.05;
    const lx = Math.cos(th) * a;
    const ly = Math.sin(th) * b;
    const jitter = (rng() - 0.5) * thickness;
    out.push({
      x: cx + lx * c - ly * s,
      y: cy + lx * s + ly * c,
      z: jitter,
    });
  }
  return out;
}

/**
 * 蝴蝶结的粒子形状。
 * 结构：两个压扁的环 + 结心 + 两条飘带。
 */
export function bowShape(size = 1, rng = Math.random, density = 1) {
  const pts = [];
  const push = (p, color, s = 1) => pts.push({ ...p, color, size: s });

  const loopCount = Math.max(24, Math.round(46 * density));
  for (const dir of [-1, 1]) {
    const band = loopBand(dir * 0.16 * size, 0.02 * size, 0.19 * size, 0.105 * size, dir * 0.5, loopCount, rng, 0.03 * size);
    for (const p of band) push(p, pick(GOLD, rng), 0.9 + rng() * 0.5);
  }

  // 结心
  const knotCount = Math.max(10, Math.round(16 * density));
  for (let i = 0; i < knotCount; i++) {
    const th = rng() * Math.PI * 2;
    const ph = Math.acos(2 * rng() - 1);
    const r = 0.085 * size * Math.cbrt(rng());
    push({
      x: Math.sin(ph) * Math.cos(th) * r,
      y: Math.cos(ph) * r * 0.9,
      z: Math.sin(ph) * Math.sin(th) * r * 0.8,
    }, pick(RED, rng));
  }

  // 两条飘带
  const tailCount = Math.max(12, Math.round(22 * density));
  for (const dir of [-1, 1]) {
    for (let i = 0; i < tailCount; i++) {
      const t = rng();
      push({
        x: dir * (0.06 + t * 0.05) * size,
        y: (-0.12 - t * 0.3) * size,
        z: (rng() - 0.5) * 0.05 * size,
      }, pick(GOLD, rng), 0.85 + rng() * 0.4);
    }
  }

  return pts;
}

/**
 * 礼盒的粒子形状：盒身 + 盒盖 + 十字丝带 + 顶部小结。
 */
export function giftShape(size = 1, rng = Math.random, density = 1) {
  const pts = [];
  const push = (p, color, s = 1) => pts.push({ ...p, color, size: s });

  const w = size;
  const h = size * 0.72;
  const d = size;

  // 盒身：盒底贴着挂点（y=0），不然半个盒子会陷进树身里
  const bodyCount = Math.max(120, Math.round(240 * density));
  for (const p of boxSurface(w, h, d, bodyCount, rng, h / 2)) {
    push(p, pick(GREEN, rng), 0.85 + rng() * 0.5);
  }

  // 盒盖（略大一圈，有盖沿的体积感）
  const lidCount = Math.max(40, Math.round(80 * density));
  for (const p of boxSurface(w * 1.07, size * 0.09, d * 1.07, lidCount, rng, h + size * 0.045)) {
    push(p, pick(GREEN, rng), 0.85 + rng() * 0.4);
  }

  // 十字丝带：沿盒面中线绕一圈，宽度只有盒身的 ~14%，才是"丝带"而不是"满脸金点"
  const ribbonCount = Math.max(48, Math.round(90 * density));
  const bandW = size * 0.14;
  for (let i = 0; i < ribbonCount; i++) {
    const up = (rng() - 0.5) * h;
    const across = (rng() - 0.5) * bandW;

    if (rng() < 0.5) {
      // 竖向丝带：跨过顶面 + 前后两面（x 只有一条窄带）
      const face = rng();
      if (face < 0.34) {
        push({ x: across, y: h + size * 0.02, z: (rng() - 0.5) * d }, pick(GOLD, rng), 0.8 + rng() * 0.4);
      } else {
        push({ x: across, y: h / 2 + up, z: (rng() < 0.5 ? 1 : -1) * (d / 2 + 0.006) }, pick(GOLD, rng), 0.8 + rng() * 0.4);
      }
    } else {
      // 横向丝带：跨过顶面 + 左右两面（z 只有一条窄带）
      const face = rng();
      if (face < 0.34) {
        push({ x: (rng() - 0.5) * w, y: h + size * 0.02, z: across }, pick(GOLD, rng), 0.8 + rng() * 0.4);
      } else {
        push({ x: (rng() < 0.5 ? 1 : -1) * (w / 2 + 0.006), y: h / 2 + up, z: across }, pick(GOLD, rng), 0.8 + rng() * 0.4);
      }
    }
  }

  // 顶部小结：直接把蝴蝶结缩半叠上去
  const bowPts = bowShape(size * 0.58, rng, density * 0.7);
  for (const p of bowPts) {
    push({ x: p.x, y: p.y + h + size * 0.12, z: p.z }, p.color, p.size);
  }

  return pts;
}

/** 把形状点云变换到树身外侧（绕 Y 旋转 yaw + 轻微倾斜） */
export function placeShape(points, { position, yaw = 0, tilt = 0 }) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);

  return points.map((p) => {
    // 先绕 X 轴微倾斜，再绕 Y 轴朝向外部
    const y1 = p.y * ct - p.z * st;
    const z1 = p.y * st + p.z * ct;
    return {
      x: position.x + p.x * cy + z1 * sy,
      y: position.y + y1,
      z: position.z - p.x * sy + z1 * cy,
      color: p.color,
      size: p.size,
    };
  });
}
