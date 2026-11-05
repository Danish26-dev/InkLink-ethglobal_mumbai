// Visual QA: renders each chapter on desktop + mobile with real Chrome and
// records console errors. Usage: node scripts/shoot.mjs [baseUrl]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5173/';
const out = 'qa-shots';
fs.mkdirSync(out, { recursive: true });

const STOPS = [
  ['hero', 0.0],
  ['hero', 0.9],
  ['workshop', 0.15],
  ['workshop', 0.5],
  ['workshop', 0.85],
  ['workflow', 0.1],
  ['workflow', 0.3],
  ['workflow', 0.5],
  ['workflow', 0.7],
  ['workflow', 0.95],
  ['local', 0.2],
  ['local', 0.85],
  ['offlinepay', 0.2],
  ['offlinepay', 0.85],
  ['technology', 0.4],
  ['privacy', 0.1],
  ['privacy', 0.4],
  ['privacy', 0.6],
  ['privacy', 0.9],
  ['developers', 0.4],
  ['final', 0.7],
];

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'],
});

for (const [name, vp] of [
  ['desk', { width: 1440, height: 900 }],
  ['mob', { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: name === 'mob', hasTouch: name === 'mob' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5200);
  let i = 0;
  for (const [id, p] of STOPS) {
    await page.evaluate(
      ([id, p]) => {
        const el = document.getElementById(id);
        const span = el.offsetHeight - innerHeight;
        window.scrollTo({ top: el.offsetTop + span * p, behavior: 'instant' });
      },
      [id, p]
    );
    await page.waitForTimeout(name === 'desk' ? 2600 : 2200);
    await page.screenshot({ path: `${out}/${name}-${String(i).padStart(2, '0')}-${id}-${p}.png` });
    i++;
  }
  if (name === 'desk') {
    // interaction: select a technology module in the list
    await page.evaluate(() => {
      const el = document.getElementById('technology');
      window.scrollTo({ top: el.offsetTop + (el.offsetHeight - innerHeight) * 0.4, behavior: 'instant' });
    });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /Autonomous Payments/ }).first().click();
    await page.waitForTimeout(2600);
    await page.screenshot({ path: `${out}/desk-zz-tech-selected.png` });
    await page.getByRole('button', { name: /Launch Inklink/ }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/desk-zz-launch-dialog.png` });
  }
  fs.writeFileSync(`${out}/${name}-console.txt`, errors.join('\n') || 'no errors');
  await ctx.close();
}
await browser.close();
console.log('done');
