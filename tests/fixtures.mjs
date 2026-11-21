/**
 * 造一只"假手"：21 个关键点。
 *
 * 几何按解剖比例来：手腕→中指根 = s（也就是"手掌尺度"），
 * 五指摊开时指尖约在 2.0s 处，握拳时蜷回 ~0.9s 处。
 * 这样 openness ≈ 2.0（张开）/ 0.9（握拳），和真手在同一量级，
 * 单测才能验证阈值设定是否合理。
 */
// px / py 使用「未镜像的摄像头原图」归一化坐标（MediaPipe 输出的就是原图坐标）
export function makeHand({ px = 0.5, py = 0.5, s = 0.12, pinched = false, open = true } = {}) {
  const wrist = { x: px, y: py + s, z: 0 };
  const lm = Array.from({ length: 21 }, () => ({ ...wrist }));

  lm[0] = wrist;
  lm[9] = { x: px, y: py, z: 0 }; // 中指根：wrist→此处距离正好 = s

  const tipLen = open ? 2.0 : 0.9;
  const pipLen = open ? 1.5 : 1.15;
  const chains = [
    [5, 6, 8],
    [9, 10, 12],
    [13, 14, 16],
    [17, 18, 20],
  ];

  chains.forEach(([mcp, pip, tip], i) => {
    const dx = (i - 1.5) * 0.12; // 手指左右散开一点
    if (mcp !== 9) lm[mcp] = { x: px + dx * s, y: py, z: 0 };
    lm[pip] = { x: px + dx * s * 1.2, y: py + s - pipLen * s, z: 0 };
    lm[tip] = { x: px + dx * s * 1.4, y: py + s - tipLen * s, z: 0 };
  });

  const indexTip = lm[8];
  lm[4] = pinched
    ? { x: indexTip.x + 0.2 * s, y: indexTip.y, z: 0 }
    : { x: px - 2.4 * s, y: py - 0.2 * s, z: 0 };

  return lm;
}
