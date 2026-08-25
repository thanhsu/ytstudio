import puppeteer from 'puppeteer-core';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'prototype-ui.html');
const outDir = path.join(__dirname, 'prototype-screenshots');

import { mkdirSync } from 'fs';
mkdirSync(outDir, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const SCREENS = [
  { id: 'projects',           label: '1-projects' },
  { id: 'review-overview',    label: '2-workflow-board' },
  { id: 'review-stage',       label: '3-stage-script' },
  { id: 'review-stage-error', label: '4-stage-error-NEW' },
  { id: 'channel-overview',   label: '5-channel-story-factory' },
  { id: 'sources',            label: '6-sources' },
  { id: 'jobs',               label: '7-jobs' },
  { id: 'config',             label: '8-config' },
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1.5 });

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 15000 });
await new Promise(r => setTimeout(r, 800));

const saved = [];

for (const { id, label } of SCREENS) {
  await page.evaluate((screenId) => {
    if (typeof showScreen === 'function') showScreen(screenId);
  }, id);
  await new Promise(r => setTimeout(r, 350));

  const outPath = path.join(outDir, `${label}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  saved.push(outPath);
  console.log('Saved:', outPath);
}

// Toast demo screenshot
await page.evaluate(() => {
  if (typeof showScreen === 'function') showScreen('review-stage-error');
});
await new Promise(r => setTimeout(r, 200));
await page.evaluate(() => {
  if (typeof toast === 'function') {
    toast('error', 'FFmpeg render thất bại', 'Missing file: bg-loop.mp4\nExit code: 1', true);
    toast('success', 'Voice render hoàn tất', 'su-150-2 · 2m 34s');
    toast('warn', 'Budget gần giới hạn', 'story-001 đã dùng $0.82 / $1.00');
    toast('info', 'Story pipeline đang chạy', 'es-horror / story-001 · Stage: render · 68%');
  }
});
await new Promise(r => setTimeout(r, 600));
const toastPath = path.join(outDir, '9-toast-notification-system-NEW.png');
await page.screenshot({ path: toastPath, fullPage: false });
saved.push(toastPath);
console.log('Saved:', toastPath);

// Job bar screenshot
await page.evaluate(() => {
  if (typeof startJobBar === 'function') startJobBar('Story pipeline running...', 68);
});
await new Promise(r => setTimeout(r, 400));
const jobBarPath = path.join(outDir, '10-job-status-bar-NEW.png');
await page.screenshot({ path: jobBarPath, fullPage: false });
saved.push(jobBarPath);
console.log('Saved:', jobBarPath);

await browser.close();
console.log('\nDone. Files in:', outDir);
console.log(saved.join('\n'));
