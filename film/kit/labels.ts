// Transparent 1920x1080 overlays in the site's style for the headset footage: a world's name and what it was made
// from (bottom left, over a soft shade), and a small Gemini tag (top left) while the guide answers out loud.
//
//   bun film/kit/labels.ts   -> film/out/labels/*.png
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = join(import.meta.dir, '../..');
const OUT = join(ROOT, 'film/out/labels');
mkdirSync(OUT, { recursive: true });
const sparkle = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'film/assets/logos/gemini-sparkle.svg')).toString('base64')}`;
const roblox = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'film/assets/logos/roblox.svg')).toString('base64')}`;

const lower = (name: string, made: string) => `
  <div class="shade"></div>
  <div class="name">${name}</div><div class="made">${made}</div>`;
const tag = (html: string) => `<div class="tag">${html}</div>`;

const LABELS: Record<string, string> = {
  'foosball': lower('Game night, again', 'Foosball at the Game Lawn, from one phone video. Both players, back in 3D.'),
  'kitchen': lower('Everyday moments', 'Seb cooking, from one phone video of our kitchen.'),
  'tilted': lower('Your childhood map', 'Tilted Towers, from a Fortnite gameplay video.'),
  'oldhouse': lower('The home you miss', 'A kitchen in Pennsylvania, rebuilt from its old real-estate listing.'),
  'chess': lower('Play together', 'Giant chess, from four phone clips of the real board.'),
  'crossplay': lower('A friend, playing from Roblox', 'The red figure is a laptop player, live in the same room.'),
  'hopin': lower('deja-view.photo', 'Our GoDaddy Registry domain. One link, any headset, any browser.'),
  'gemini': tag(`<img src="${sparkle}"> Gemini, answering out loud`),
  'url': tag(`Make yours at <b style="color:#2997ff;margin-left:6px">deja-view.photo</b>`),
  'pip': `<div class="pip">Shivin's view</div>`,
  'roblox': tag(`<img src="${roblox}" style="height:18px;width:auto;margin-right:2px"> The same table, in Roblox`),
};

const css = `
  html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:"SF Pro Display",-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .shade{position:absolute;left:0;right:0;bottom:0;height:300px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.6))}
  .name{position:absolute;left:120px;bottom:118px;font-size:40px;font-weight:600;letter-spacing:-0.015em;color:#f5f5f7}
  .made{position:absolute;left:120px;bottom:76px;font-size:26px;color:#c7c7cc;letter-spacing:-0.01em}
  .tag{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:12px;padding:14px 22px;border-radius:999px;
       background:rgba(20,20,22,.62);color:#f5f5f7;font-size:24px;font-weight:500;letter-spacing:-0.01em;
       box-shadow:0 8px 30px rgba(0,0,0,.25)}
  .tag img{height:26px;width:26px}
  .pip{position:absolute;right:96px;top:96px;padding:8px 14px;border-radius:999px;background:rgba(20,20,22,.62);color:#f5f5f7;font-size:20px;font-weight:500}
`;

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [name, html] of Object.entries(LABELS)) {
  await page.setContent(`<!doctype html><style>${css}</style><body>${html}</body>`);
  await page.waitForTimeout(80);
  await page.screenshot({ path: join(OUT, `${name}.png`), omitBackground: true });
}
await browser.close();
console.log('labels:', Object.keys(LABELS).join(' '));
