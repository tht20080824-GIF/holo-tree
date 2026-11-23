/**
 * 自动截图 / 自动验证：用本机 Chrome（Playwright 驱动）打开页面，定时截图。
 *
 * 为什么用它：这个项目最难的是「改完看不到效果」，每次都要人录屏。
 * 有了它我可以在无头 Chrome 里渲染 WebGL、按时间点截帧，自己核对画面，
 * 也能把手机录屏当成虚拟摄像头喂进去跑手势识别（--fake-camera）。
 *
 * 用法：
 *   node tools/shot.mjs                      # 截 1 张（6 秒后）
 *   node tools/shot.mjs --shots 3,6,10       # 指定时间点（秒）
 *   node tools/shot.mjs --url http://127.0.0.1:8767/
 *   node tools/shot.mjs --fake-camera a.y4m  # 用视频文件当摄像头
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const url = arg('url', 'http://127.0.0.1:8767/');
const times = arg('shots', '6').split(',').map(Number).sort((a, b) => a - b);
const fakeCamera = arg('fake-camera', null);
const outDir = arg('out', '.tmp/shots');
const width = Number(arg('width', 430));
const height = Number(arg('height', 932));
await mkdir(outDir, { recursive: true });

const chromeArgs = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  // 无头环境没有真摄像头，必须用虚拟设备，否则页面会卡在「等待摄像头授权」
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];
if (fakeCamera) {
  chromeArgs.push(`--use-file-for-fake-video-capture=${path.resolve(fakeCamera)}`);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: chromeArgs,
});
const ctx = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
  permissions: ['camera'],
});
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });

let last = 0;
for (const t of times) {
  await page.waitForTimeout(Math.max(0, t * 1000 - last));
  last = t * 1000;
  const file = path.join(outDir, `t${String(t).replace('.', '_')}.png`);
  await page.screenshot({ path: file });
  console.log('shot', file);
}

// 报告现场状态：帧率、HUD 文本、WebGL 是否真的在跑
const info = await page.evaluate(() => {
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const canvas = document.querySelector('canvas');
  const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
  return {
    gesture: txt('#gesture') || [...document.querySelectorAll('*')].find((e) => /指|握拳|张开/.test(e.textContent || '') && e.children.length === 0)?.textContent?.trim() || null,
    renderer: gl ? gl.getParameter(gl.RENDERER) : 'no-webgl',
    canvas: canvas ? `${canvas.width}x${canvas.height}` : 'none',
  };
});
console.log('state', JSON.stringify(info));
if (logs.length) console.log('console:\n' + logs.slice(-15).join('\n'));
await browser.close();
