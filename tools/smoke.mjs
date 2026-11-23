/**
 * 冒烟测试：真的把页面跑起来，任何 JS 报错/白屏都算失败。
 *
 * 上一版就是 `ReferenceError: Can't find variable: shownCount` 直接把整页打挂，
 * 但单元测试全绿——所以必须有一条「能启动」的关卡。
 *
 *   node tools/smoke.mjs [url]
 */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:8767/';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
const logs = [];
page.on('console', (m) => {
  logs.push(m.text());
  // 单文件版会先探一下本地 vendor（404 是预期行为），只把真错误算进来
  if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);

const state = await page.evaluate(() => ({
  crash: document.body.innerText.includes('页面没能启动'),
  canvas: !!document.querySelector('canvas'),
  fps: document.body.innerText.match(/(\d+) fps/)?.[1] ?? null,
}));

await browser.close();

const bad = errors.filter((e) => !/GL Driver|gl_context|OpenGL error checking/.test(e));
if (state.crash || bad.length) {
  console.error('❌ 冒烟失败');
  if (state.crash) console.error('  页面显示「页面没能启动」');
  for (const e of bad.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
const tracking = logs.some((l) => /Graph successfully started running|hand_landmarker/i.test(l));
console.log(`✅ 冒烟通过 · canvas=${state.canvas} · fps=${state.fps ?? '?'} · 手部模型=${tracking ? '已加载' : '未确认'}`);
