/**
 * 触摸 / 鼠标输入：单指拖拽转，双指捏合缩放，双击切形态。
 *
 * 用 Pointer Events 而不是分别写 mouse/touch —— 一套代码同时覆盖
 * 鼠标、触屏、触控笔，而且 `setPointerCapture` 能保证手指滑出画布也不丢事件。
 *
 * 注意：canvas 上必须 `touch-action: none`，否则移动端会先触发页面滚动/缩放，
 * 事件被浏览器抢走，表现为"拖不动"。
 */

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function attachPointerControls(canvas, rig, { onDoubleTap, onTap, doubleTapMs = 300, now = () => performance.now() } = {}) {
  const pointers = new Map();
  let lastPinchDistance = 0;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let moved = 0;
  let multi = false;      // 这次手势里出现过两根手指 → 不算点击
  let dragged = false;    // 移动超过阈值 → 不算点击

  // 手指点击的判定：短、稳、单指。阈值比鼠标宽一点，但必须有"按住过"的痕迹。
  const TAP_MOVE = 14;    // px：手指自然抖动比鼠标大
  const TAP_TIME = 400;   // ms
  const TAP_MIN = 25;     // ms：太短的触碰多半是误触

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    rig.touch();

    if (pointers.size === 1) {
      downAt = now();
      downX = e.clientX;
      downY = e.clientY;
      moved = 0;
      multi = false;
      dragged = false;
    } else {
      multi = true;
    }

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      lastPinchDistance = distance(a, b);
    }
  }

  function onPointerMove(e) {
    const point = pointers.get(e.pointerId);
    if (!point) return;

    const prev = { x: point.x, y: point.y };
    point.x = e.clientX;
    point.y = e.clientY;
    rig.touch();

    if (pointers.size === 1) {
      moved = Math.max(moved, Math.hypot(point.x - downX, point.y - downY));
      if (moved > TAP_MOVE) {
        dragged = true;
        lastTapAt = 0;      // 拖动过就当没点过，避免拖完随手一抬被当成双击
      }
      // 有手在控制时让位给手势，别两个一起抢
      if (rig.handActive) return;
      rig.nudgeYaw(-(point.x - prev.x));
      rig.nudgePitch(point.y - prev.y);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const next = distance(a, b);
      if (lastPinchDistance > 0) {
        // 撑开 = 拉近；把像素差换算成 rig 的距离系数
        rig.nudgeZoom((lastPinchDistance - next) * 3.2);
      }
      lastPinchDistance = next;
    }
  }

  function onPointerUp(e) {
    const single = pointers.size === 1;
    const at = now();
    const dt = at - downAt;

    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinchDistance = 0;

    // 只在真正的 pointerup 上判点击；cancel / leave 一律不算
    if (e.type !== 'pointerup' || !single || multi || dragged) return;
    if (dt < TAP_MIN || dt > TAP_TIME || moved > TAP_MOVE) return;

    // 交给上层：点到相框就吃掉这次点击（返回 true），不再参与双击切形态
    const consumed = onTap?.(e.clientX, e.clientY, e.pointerType || 'mouse') === true;
    if (consumed) { lastTapAt = 0; return; }

    const near = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 44;
    if (at - lastTapAt < doubleTapMs && near) {
      onDoubleTap?.();
      lastTapAt = 0;
    } else {
      lastTapAt = at;
      lastTapX = e.clientX;
      lastTapY = e.clientY;
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerUp);
  };
}
