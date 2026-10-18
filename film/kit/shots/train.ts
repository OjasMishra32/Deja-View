// Shot 32b: training the Game Lawn, from the real log of the run that made it.
// A photo and our render of the same view with a slider between them, and the real PSNR curve drawing itself step by
// step. At the end the card switches to a photo the model never trained on.
import { ease, el, json, lerp, seg, story, type Shot, BLUE, INK } from '../lib';

const DUR = 7.5;
const STEPS = 30000;
let rows: any[] = [];
let ema: number[] = [];
let meta: any;
let pick: { train: string; test: string };
const ui: Record<string, HTMLElement> = {};
let words: ReturnType<typeof story>;

// layout: card on the left, chart on the right, story text below
const CARD = { x: 240, y: 92, w: 900, h: 540 };
const CH = { x: 1290, y: 150, w: 390, h: 400 };
const P0 = 8, P1 = 34;
const px = (step: number) => CH.x + (step / STEPS) * CH.w;
const py = (v: number) => CH.y + CH.h - ((v - P0) / (P1 - P0)) * CH.h;

const shot: Shot = {
  duration: DUR,
  async setup() {
    meta = await json('/film/assets/kit/courts.json');
    pick = await json('/film/assets/kit/compare/pick.json');
    rows = meta.training;
    let e = rows[0].psnr;
    ema = rows.map((r) => (e = e * 0.65 + r.psnr * 0.35));

    const card = el('card', CARD.x, CARD.y, '');
    card.style.width = `${CARD.w}px`;
    card.style.height = `${CARD.h}px`;
    const layer = (src: string, half: 0 | 1) => {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;inset:0;background:url(${src}) ${half ? '100%' : '0%'} 50%/200% auto no-repeat`;
      card.appendChild(d);
      return d;
    };
    ui.trainPhoto = layer(`/film/assets/kit/compare/${pick.train}`, 0);
    ui.trainRender = layer(`/film/assets/kit/compare/${pick.train}`, 1);
    ui.testPhoto = layer(`/film/assets/kit/compare/${pick.test}`, 0);
    ui.testRender = layer(`/film/assets/kit/compare/${pick.test}`, 1);
    ui.line = document.createElement('div');
    ui.line.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff';
    ui.knob = document.createElement('div');
    ui.knob.style.cssText = 'position:absolute;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#1d1d1f;font-size:22px;font-weight:600;letter-spacing:4px';
    ui.knob.textContent = '‹›';
    card.append(ui.line, ui.knob);
    ui.card = card;
    ui.lPhoto = el('axis', CARD.x, CARD.y - 40, 'Photo');
    ui.lHeld = el('axis', CARD.x, CARD.y - 40, 'A photo it never trained on');
    ui.lRender = el('axis', CARD.x + CARD.w - 74, CARD.y - 40, 'Render');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '1920');
    svg.setAttribute('height', '1080');
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
    svg.innerHTML = `
      <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${BLUE}" stop-opacity=".38"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></linearGradient>
        <clipPath id="clip"><rect id="clipRect" x="${CH.x}" y="${CH.y - 30}" width="0" height="${CH.h + 30}"/></clipPath></defs>
      <g stroke="#2a2a2d" stroke-width="1.5">${[10, 20, 30].map((v) => `<line x1="${CH.x}" x2="${CH.x + CH.w}" y1="${py(v)}" y2="${py(v)}"/>`).join('')}</g>
      <g fill="#6e6e73" font-size="20" font-family="-apple-system,system-ui">
        ${[10, 20, 30].map((v) => `<text x="${CH.x - 14}" y="${py(v) + 7}" text-anchor="end">${v}</text>`).join('')}
        <text x="${CH.x}" y="${CH.y - 44}" fill="#86868b" font-size="22" font-weight="600">PSNR, dB</text>
        <text x="${CH.x}" y="${CH.y + CH.h + 36}">0</text>
        <text x="${CH.x + CH.w}" y="${CH.y + CH.h + 36}" text-anchor="end">30,000 steps</text>
      </g>
      <g clip-path="url(#clip)">
        <path id="area" fill="url(#fill)"/>
        <path id="curve" fill="none" stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      </g>
      <circle id="head" r="7" fill="${INK}"/>`;
    document.getElementById('overlay')!.appendChild(svg);
    ui.svg = svg as unknown as HTMLElement;
    const pts = rows.map((r, i) => `${px(r.step)},${py(ema[i])}`);
    svg.querySelector('#curve')!.setAttribute('d', 'M' + pts.join(' L'));
    svg.querySelector('#area')!.setAttribute('d', `M${px(0)},${py(P0)} L` + pts.join(' L') + ` L${px(STEPS)},${py(P0)} Z`);
    ui.val = el('value', 0, 0, '');

    words = story('Training', 'Thirty thousand steps, until it matches.',
      `Gradient descent moves <b>1.3 million</b> splats until each render matches its photo: about <b>30 dB</b> on photos it learned from, <b>18.6 dB</b> on ones it never saw. Eleven minutes on one GPU.`);
  },

  frame(t) {
    // chart draws itself
    const k = ease.site(seg(t, 0.6, 5.0));
    const step = STEPS * k;
    (ui.svg.querySelector('#clipRect') as SVGRectElement).setAttribute('width', String((step / STEPS) * CH.w + 2));
    let i = 0;
    while (i < rows.length - 1 && rows[i + 1].step <= step) i++;
    const j = Math.min(i + 1, rows.length - 1);
    const f = rows[j].step > rows[i].step ? (step - rows[i].step) / (rows[j].step - rows[i].step) : 0;
    const v = lerp(ema[i], ema[j], f);
    const head = ui.svg.querySelector('#head')!;
    head.setAttribute('cx', String(px(step)));
    head.setAttribute('cy', String(py(v)));
    ui.svg.style.opacity = String(ease.site(seg(t, 0.3, 1.0)));
    ui.val.textContent = `${v.toFixed(1)} dB`;
    ui.val.style.left = `${px(step) + 16}px`;
    ui.val.style.top = `${py(v) - 46}px`;
    ui.val.style.opacity = ui.svg.style.opacity;

    // the slider sweeps the card, then switches to a held-out photo
    const w = t < 5.4 ? 0.5 + 0.36 * Math.sin((seg(t, 0.8, 5.0) * 2 - 0.5) * Math.PI) : 0.5 + 0.12 * Math.sin(seg(t, 5.4, 7.5) * Math.PI);
    const held = ease.site(seg(t, 5.4, 6.1));
    const clip = `inset(0 0 0 ${(w * 100).toFixed(2)}%)`;
    ui.trainRender.style.clipPath = clip;
    ui.testRender.style.clipPath = clip;
    ui.testPhoto.style.opacity = ui.testRender.style.opacity = String(held);
    ui.line.style.left = ui.knob.style.left = `${w * 100}%`;
    const cardIn = ease.site(seg(t, 0, 0.9));
    ui.card.style.opacity = String(cardIn);
    ui.card.style.transform = `translateY(${(1 - cardIn) * 24}px) scale(${lerp(0.985, 1, cardIn) * (1 + 0.025 * seg(t, 5.4, 7.5))})`;
    ui.lPhoto.style.opacity = String(cardIn * (1 - held));
    ui.lHeld.style.opacity = String(held);
    ui.lRender.style.opacity = String(cardIn);

    words.show(t, 0.9);
  },
};

export default shot;
