// The end card: the name and the link, four real numbers, and every sponsor whose work is in the film.
import { BLUE, ease, el, seg, type Shot } from '../lib';

const DUR = 9;
const L = '/film/assets/logos';
const STATS: [number, string][] = [
  [10, 'worlds you can walk into'],
  [163, 'cameras solved in one room'],
  [2304, 'views checked for gaps'],
  [874, 'tests passing'],
];
const white = 'filter:brightness(0) invert(1)';
const LOGOS = [
  `<img src="${L}/vobile.png" style="height:30px">`,
  `<span style="display:inline-flex;align-items:center;gap:10px"><img src="${L}/deepspace-ring.png" style="height:30px"><b style="font-size:22px">DeepSpace</b></span>`,
  `<img src="${L}/roblox.svg" style="height:22px">`,
  `<span style="display:inline-flex;align-items:center;gap:10px"><img src="${L}/gemini-sparkle.svg" style="height:26px"><b style="font-size:23px">Gemini</b></span>`,
  `<img src="${L}/vultr-white.svg" style="height:24px">`,
  `<img src="${L}/auth0-white.svg" style="height:30px">`,
  `<img src="${L}/tigerdata.svg" style="height:28px">`,
  `<img src="${L}/godaddy-registry.svg" style="height:22px;${white}">`,
  `<img src="${L}/mlh.svg" style="height:34px">`,
];
const ui: Record<string, HTMLElement> = {};
const nums: HTMLElement[] = [];
const logos: HTMLElement[] = [];

const center = (y: number, html: string) => {
  const e = el('', 0, y, html);
  e.style.cssText += 'width:1920px;text-align:center';
  return e;
};

const shot: Shot = {
  duration: DUR,
  async setup() {
    ui.name = center(250, 'Deja View');
    ui.name.style.cssText += 'font-size:120px;font-weight:700;letter-spacing:-0.035em;color:#f5f5f7';
    ui.link = center(410, 'deja-view.photo');
    ui.link.style.cssText += `font-size:36px;font-weight:500;letter-spacing:-0.01em;color:${BLUE}`;
    const W = 1440, cw = W / STATS.length, x0 = (1920 - W) / 2;
    STATS.forEach(([, label], i) => {
      const n = el('', x0 + i * cw, 560, '');
      n.style.cssText += `width:${cw}px;text-align:center;font-size:56px;font-weight:600;letter-spacing:-0.02em;color:#f5f5f7;font-variant-numeric:tabular-nums`;
      const l = el('axis', x0 + i * cw, 638, label);
      l.style.cssText += `width:${cw}px;text-align:center;font-size:22px`;
      nums.push(n, l);
    });
    ui.with = center(800, 'Built with');
    ui.with.className = 'axis';
    ui.with.style.cssText += 'font-size:20px';
    const row = el('', 0, 852, '');
    row.style.cssText += 'width:1920px;display:flex;justify-content:center;align-items:center;gap:56px;color:#f5f5f7';
    for (const h of LOGOS) {
      const s = document.createElement('span');
      s.innerHTML = h;
      s.style.cssText = 'display:inline-flex;align-items:center';
      row.appendChild(s);
      logos.push(s);
    }
  },

  frame(t) {
    const out = 1 - ease.site(seg(t, DUR - 1.0, DUR));
    const show = (e: HTMLElement, a: number, b: number) => {
      const k = ease.site(seg(t, a, b));
      e.style.opacity = String(k * out);
      e.style.transform = `translateY(${(1 - k) * 20}px)`;
    };
    show(ui.name, 0.2, 1.1);
    show(ui.link, 0.6, 1.5);
    STATS.forEach(([v], i) => {
      const k = ease.out(seg(t, 1.3 + i * 0.15, 2.8 + i * 0.15));
      nums[2 * i].textContent = Math.round(v * k).toLocaleString('en-US');
      show(nums[2 * i], 1.2 + i * 0.15, 1.9 + i * 0.15);
      show(nums[2 * i + 1], 1.3 + i * 0.15, 2.0 + i * 0.15);
    });
    show(ui.with, 2.6, 3.2);
    logos.forEach((e, i) => show(e, 2.8 + i * 0.09, 3.5 + i * 0.09));
  },
};

export default shot;
