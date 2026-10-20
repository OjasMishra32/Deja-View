// The project thumbnail: two headset lenses, each looking into one of our worlds (Shivin's dad by the fire, and the
// foosball game with both players back in 3D), over the name and the link. Apple keynote style.
//
//   bun film/kit/thumb.ts   -> film/out/thumb/thumbnail-3x2.png (2400x1600, Devpost) and thumbnail-16x9.png (1920x1080)
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(import.meta.dir, '../..');
const T = join(ROOT, 'film/out/thumb');
const img = (f: string) => `data:image/jpeg;base64,${readFileSync(join(T, f)).toString('base64')}`;
// each lens shows a square crop of a frame: [file, centre x, centre y, half size] in the 1920x1080 source
const LENSES: [string, number, number, number][] = [['dad-8.jpg', 1040, 500, 500], ['foos-10.2.jpg', 1140, 540, 532]];

function page(w: number, h: number, lens: number, gap: number, top: number, title: number) {
  const lensHtml = LENSES.map(([f, cx, cy, r], i) => {
    const s = lens / (2 * r); // source px -> css px
    return `<div class="lens" style="left:${w / 2 + (i ? gap / 2 : -gap / 2 - lens)}px">
      <div class="img" style="background-image:url(${img(f)});background-size:${1920 * s}px ${1080 * s}px;background-position:${-(cx - r) * s}px ${-(cy - r) * s}px"></div>
      <div class="glass"></div></div>`;
  }).join('');
  return `<!doctype html><style>
    html,body{margin:0;width:${w}px;height:${h}px;background:#000;overflow:hidden;
      font-family:"SF Pro Display",-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    .bg{position:absolute;inset:0;background:radial-gradient(60% 55% at 50% 38%,#16161a 0%,#000 70%)}
    .lens{position:absolute;top:${top}px;width:${lens}px;height:${lens}px;border-radius:50%;
      box-shadow:0 0 0 ${lens * 0.035}px #1c1c1f,0 0 0 ${lens * 0.05}px #0c0c0e,0 ${lens * 0.08}px ${lens * 0.25}px rgba(0,0,0,.8),
        0 0 ${lens * 0.35}px rgba(41,151,255,.10)}
    .img,.glass{position:absolute;inset:0;border-radius:50%}
    .img{background-repeat:no-repeat}
    .glass{background:radial-gradient(circle at 50% 50%,rgba(0,0,0,0) 58%,rgba(0,0,0,.55) 100%),
      linear-gradient(140deg,rgba(255,255,255,.14) 0%,rgba(255,255,255,0) 32%)}
    .title{position:absolute;left:0;right:0;top:${top + lens + title * 0.55}px;text-align:center;color:#f5f5f7;
      font-size:${title}px;font-weight:700;letter-spacing:-0.035em}
    .tag{position:absolute;left:0;right:0;top:${top + lens + title * 1.78}px;text-align:center;color:#a1a1a6;
      font-size:${title * 0.3}px;font-weight:500;letter-spacing:-0.01em}
    .url{position:absolute;left:0;right:0;top:${top + lens + title * 2.3}px;text-align:center;color:#2997ff;
      font-size:${title * 0.24}px;font-weight:500}
  </style><body><div class="bg"></div>${lensHtml}
    <div class="title">Déjà View</div><div class="tag">Anything you capture, you can walk into.</div>
    <div class="url">deja-view.photo</div></body>`;
}

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
for (const [name, w, h, dpr, lens, gap, top, title] of [
  ['thumbnail-3x2', 1800, 1200, 4 / 3, 560, 70, 120, 136],
  ['thumbnail-16x9', 1920, 1080, 1, 500, 64, 90, 120],
] as const) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  await p.setContent(page(w, h, lens, gap, top, title));
  await p.waitForTimeout(150);
  await p.screenshot({ path: join(T, `${name}.png`) });
  await p.close();
}
await browser.close();
console.log('wrote thumbnails');
