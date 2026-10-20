// What it's for: six uses, each shown with our own footage, in the site's "What it's for" style. Someone you love
// (Shivin's dad by the fire), the home you miss (the old house, from its listing photos), a listing before you visit
// (our kitchen), your childhood map (Tilted Towers), game night (the foosball memory), and play (the Roblox rally).
import { ease, el, seg, type Shot } from '../lib';

const DUR = 9.5;
const C = '/film/out/uc';
const CARDS = [
  { src: `${C}/love.mp4`, title: 'Someone you love', line: 'Sit by the fire with Dad again.' },
  { src: `${C}/home.mp4`, title: 'The home you miss', line: 'Rebuilt from its old listing photos.' },
  { src: `${C}/listing.mp4`, title: 'A listing, before you visit', line: 'Walk a home from its photos.' },
  { src: `${C}/childhood.mp4`, title: 'Your childhood map', line: 'Tilted Towers, from gameplay footage.' },
  { src: `${C}/gamenight.mp4`, title: 'Game night, again', line: 'Both players, back in 3D.' },
  { src: `${C}/fun.mp4`, title: 'Just for fun', line: 'Play together from anywhere.' },
];
const CW = 500, CH = 281, GX = 44, X0 = (1920 - (3 * CW + 2 * GX)) / 2, Y0 = 210, ROW = CH + 116;
const vids: HTMLVideoElement[] = [];
const cards: HTMLCanvasElement[] = [];
const text: HTMLElement[][] = [];
let head: HTMLElement;

async function seek(v: HTMLVideoElement, t: number) {
  t = Math.min(Math.max(0, t), v.duration - 0.05);
  if (Math.abs(v.currentTime - t) < 1e-3) return;
  await new Promise((r) => { v.onseeked = () => r(null); v.currentTime = t; });
}

const shot: Shot = {
  duration: DUR,
  async setup() {
    head = el('', X0, 92, "What it's for.");
    head.style.cssText += 'font-size:64px;font-weight:700;letter-spacing:-0.03em;color:#f5f5f7';
    for (const [i, c] of CARDS.entries()) {
      const v = document.createElement('video');
      v.src = c.src;
      v.muted = true;
      v.preload = 'auto';
      await new Promise((r) => (v.onloadeddata = () => r(null)));
      vids.push(v);
      const x = X0 + (i % 3) * (CW + GX), y = Y0 + Math.floor(i / 3) * ROW;
      const cv = document.createElement('canvas');
      cv.width = CW * 2;
      cv.height = CH * 2;
      cv.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${CW}px;height:${CH}px;border-radius:20px;background:#1d1d1f`;
      document.getElementById('overlay')!.appendChild(cv);
      cards.push(cv);
      const t1 = el('', x, y + CH + 18, c.title);
      t1.style.cssText += 'font-size:28px;font-weight:600;letter-spacing:-0.015em;color:#f5f5f7';
      const t2 = el('axis', x, y + CH + 56, c.line);
      t2.style.cssText += 'font-size:22px';
      text.push([t1, t2]);
    }
  },

  async frame(t) {
    head.style.opacity = String(ease.site(seg(t, 0.1, 0.7)));
    head.style.transform = `translateY(${(1 - ease.site(seg(t, 0.1, 0.7))) * 20}px)`;
    for (const [i, v] of vids.entries()) {
      await seek(v, 0.2 + t * 0.85);
      cards[i].getContext('2d')!.drawImage(v, 0, 0, CW * 2, CH * 2);
      const k = ease.site(seg(t, 0.4 + i * 0.32, 1.2 + i * 0.32));
      cards[i].style.opacity = String(k);
      cards[i].style.transform = `translateY(${(1 - k) * 28}px)`;
      for (const e of text[i]) e.style.opacity = String(ease.site(seg(t, 0.6 + i * 0.32, 1.4 + i * 0.32)));
    }
  },
};

export default shot;
