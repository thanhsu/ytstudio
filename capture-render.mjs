import puppeteer from 'puppeteer-core';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'prototype-render.html');
const outDir = path.join(__dirname, 'render-screenshots');
mkdirSync(outDir, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const SCREENS = [
  { id: 'render',     label: 'R1-render-editor-3panel' },
  { id: 'cut',        label: 'R2-cut-trim-editor' },
  { id: 'export',     label: 'R3-export-copyright' },
  { id: 'render-err', label: 'R4-render-failed-inline-error' },
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise(r => setTimeout(r, 1200));

const saved = [];

for (const { id, label } of SCREENS) {
  await page.evaluate((screenId) => {
    if (typeof showScreen === 'function') showScreen(screenId);
  }, id);
  await new Promise(r => setTimeout(r, 500));

  const outPath = path.join(outDir, `${label}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  saved.push(outPath);
  console.log('Saved:', outPath);
}

// Extra: Render editor with Effects tab open
await page.evaluate(() => {
  showScreen('render');
  const tabs = document.querySelectorAll('.inspector-tab');
  if (tabs[1]) tabs[1].click();
});
await new Promise(r => setTimeout(r, 400));
const effectsPath = path.join(outDir, 'R1b-render-effects-tab.png');
await page.screenshot({ path: effectsPath, fullPage: false });
saved.push(effectsPath);
console.log('Saved:', effectsPath);

// Extra: Toast notification example
await page.evaluate(() => {
  showScreen('render');
  if (typeof toast === 'function') {
    toast('err', 'Render thất bại — FFmpeg error', 'bg-loop.mp4: No such file or directory', true);
    toast('info', 'Mapping đã approve', 'scene-02 clip mapping saved.');
    toast('warn', 'Low confidence clip', 'scene-04 confidence 31%. Kiểm tra lại.');
  }
});
await new Promise(r => setTimeout(r, 700));
const toastPath = path.join(outDir, 'R5-toast-notifications.png');
await page.screenshot({ path: toastPath, fullPage: false });
saved.push(toastPath);
console.log('Saved:', toastPath);

await browser.close();
console.log('\nDone. Files saved to:', outDir);
saved.forEach(p => console.log(' ', p));
