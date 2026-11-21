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

export function attachPointerControls(canvas, rig, { onDoubleTap, onTap, doubleTapMs = 320 } = {}) {
  const pointers = new Map();
  let lastPinchDistance = 0;
  let lastTapAt = 0;
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let moved = 0;

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    rig.touch();

    if (pointers.size === 1) {
      downAt = performance.now();
      downX = e.clientX;
      downY = e.clientY;
      moved = 0;

      // 双击：手机上比"按两次"更自然的是连点两下
      const now = performance.now();
      if (now - lastTapAt < doubleTapMs) {
        onDoubleTap?.();
        lastTapAt = 0;
      } else {
        lastTapAt = now;
      }
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
    // 轻点（几乎没移动 + 时间短）→ 交给上层做"点相框"
    if (pointers.size === 1 && moved < 8 && performance.now() - downAt < 350) {
      onTap?.(e.clientX, e.clientY);
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinchDistance = 0;
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
