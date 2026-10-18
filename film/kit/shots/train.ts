// Shot 32b: training the Game Lawn, from the real log of the run that made it.
// Left: a photo and our render of the same view, a wipe between them; at the end it switches to a photo the model
// never trained on. Right: PSNR and the splat count climbing step by step, and the camera poses being corrected.
import { ease, el, fmt, json, lerp, reveal, seg, type Shot, LIME, INK } from '../lib';

const DUR = 7.5;
const STEPS = 30000;
const ui: Record<string, HTMLElement> = {};
let rows: any[] = [];
let ema: number[] = [];
let meta: any;
let pick: { train: string; test: string };

const CX = 1190, CY = 330, CW = 610, CH = 300; // PSNR chart
const SY = 700, SH = 110; // splat chart
const P0 = 8, P1 = 34;

const shot: Shot = {
  duration: DUR,
  async setup() {
    meta = await json('/film/assets/kit/courts.json');
    pick = await json('/film/assets/kit/compare/pick.json');
    rows = meta.training;
    let e = rows[0].psnr;
    ema = rows.map((r) => (e = e * 0.7 + r.psnr * 0.3));

    // The comparison: photo underneath, render on top, clipped by the wipe
    const frame = el('', 120, 230, '');
    frame.style.cssText += 'width:960px;height:720px;overflow:hidden;border-radius:18px;background:#111';
    const img = (src: string, half: 0 | 1) => {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;inset:0;background:url(${src}) ${half ? '100%' : '0%'} 0/200% 100% no-repeat`;
      frame.appendChild(d);
      return d;
    };
    ui.trainPhoto = img(`/film/assets/kit/compare/${pick.train}`, 0);
    ui.trainRender = img(`/film/assets/kit/compare/${pick.train}`, 1);
    ui.testPhoto = img(`/film/assets/kit/compare/${pick.test}`, 0);
    ui.testRender = img(`/film/assets/kit/compare/${pick.test}`, 1);
    ui.wipe = document.createElement('div');
    ui.wipe.style.cssText = `position:absolute;top:0;bottom:0;width:3px;background:${LIME};box-shadow:0 0 18px ${LIME}`;
    frame.appendChild(ui.wipe);
    ui.frame = frame;
    ui.lPhoto = el('chip', 144, 254, 'photo');
    ui.lRender = el('chip', 0, 254, 'our render');
    ui.lHeld = el('chip', 144, 254, 'a photo it never trained on');

    ui.label = el('label', 120, 104, 'Training');
    ui.sub = el('note', 120, 144, 'Every splat nudged by gradient descent until our renders match the photos');

    // Charts
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '1920');
    svg.setAttribute('height', '1080');
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
    svg.innerHTML = `
      <g stroke="rgba(245,245,247,.14)" stroke-width="1">
        ${[10, 15, 20, 25, 30].map((v) => `<line x1="${CX}" x2="${CX + CW}" y1="${py(v)}" y2="${py(v)}"/>`).join('')}
        <line x1="${CX}" x2="${CX + CW}" y1="${SY + SH}" y2="${SY + SH}"/>
      </g>
      <g fill="rgba(245,245,247,.45)" font-size="18" font-family="-apple-system,system-ui">
        ${[10, 20, 30].map((v) => `<text x="${CX - 12}" y="${py(v) + 6}" text-anchor="end">${v}</text>`).join('')}
        <text x="${CX}" y="${CY - 18}">PSNR, dB</text>
        <text x="${CX + CW}" y="${CY + CH + 32}" text-anchor="end">step 30,000</text>
        <text x="${CX}" y="${SY - 16}">splats</text>
      </g>
      <g id="raw" fill="rgba(245,245,247,.35)"></g>
      <path id="psnr" fill="none" stroke="${LIME}" stroke-width="3.5" stroke-linejoin="round"/>
      <path id="splats" fill="none" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <circle id="head" r="7" fill="${LIME}"/>`;
    document.getElementById('overlay')!.appendChild(svg);
    ui.svg = svg as unknown as HTMLElement;
    const raw = svg.querySelector('#raw')!;
    rows.forEach((r, i) => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('cx', String(px(r.step)));
      c.setAttribute('cy', String(py(r.psnr)));
      c.setAttribute('r', '3');
      c.setAttribute('data-i', String(i));
      raw.appendChild(c);
    });

    ui.step = el('mid', CX, 860, '');
    ui.stepU = el('unit', CX, 914, 'step');
    ui.splatN = el('mid', CX + 230, 860, '');
    ui.splatU = el('unit', CX + 230, 914, 'splats');
    ui.pose = el('mid', CX + 480, 860, '');
    ui.poseU = el('unit', CX + 480, 914, 'pose correction');

    ui.chips = el('', 120, 984, ['metric depth guidance', 'per-photo exposure', 'camera poses refined', 'colour per viewing direction']
      .map((c) => `<span class="chip" style="position:static;display:inline-block;margin-right:12px">${c}</span>`).join(''));
    ui.foot = el('note', 1190, 990, `30,000 steps · ${(meta.metrics.trainSeconds / 60).toFixed(1)} min · RTX PRO 6000 Blackwell, HiPerGator`);

    ui.held = el('', 120, 230, `<div class="big" style="position:static">${meta.heldOut.psnr.toFixed(1)}<span class="unit" style="margin-left:12px">dB PSNR</span></div>` +
      `<div class="unit" style="position:static;margin-top:10px">${meta.heldOut.ssim.toFixed(2)} SSIM on the 4 photos held out of training</div>`);
    ui.held.style.cssText += `left:${CX}px;top:846px;`;
  },

  frame(t) {
    const k = ease.inOut(seg(t, 0.4, 5.2));
    const step = STEPS * k;
    let i = 0;
    while (i < rows.length - 1 && rows[i + 1].step <= step) i++;
    const j = Math.min(i + 1, rows.length - 1);
    const f = rows[j].step > rows[i].step ? (step - rows[i].step) / (rows[j].step - rows[i].step) : 0;
    const at = (key: string) => lerp(rows[i][key], rows[j][key], f);
    const emaAt = lerp(ema[i], ema[j], f);

    // PSNR curve and raw points up to the current step
    const pts = rows.slice(0, i + 1).map((r, n) => `${px(r.step)},${py(ema[n])}`);
    pts.push(`${px(step)},${py(emaAt)}`);
    ui.svg.querySelector('#psnr')!.setAttribute('d', 'M' + pts.join(' L'));
    ui.svg.querySelectorAll<SVGCircleElement>('#raw circle').forEach((c) => (c.style.opacity = Number(c.dataset.i) <= i ? '1' : '0'));
    const head = ui.svg.querySelector('#head')!;
    head.setAttribute('cx', String(px(step)));
    head.setAttribute('cy', String(py(emaAt)));
    const maxSplats = 1.3e6;
    const sp = rows.slice(0, i + 1).map((r) => `${px(r.step)},${SY + SH - (r.splats / maxSplats) * SH}`);
    sp.push(`${px(step)},${SY + SH - (at('splats') / maxSplats) * SH}`);
    ui.svg.querySelector('#splats')!.setAttribute('d', 'M' + sp.join(' L'));
    ui.svg.style.opacity = String(ease.out(seg(t, 0.2, 0.8)));

    ui.step.textContent = fmt(step);
    ui.splatN.textContent = fmt(at('splats'));
    ui.pose.innerHTML = `${at('poseDeg').toFixed(2)}°<span class="unit" style="position:static;margin-left:8px">${at('poseCm').toFixed(1)} cm</span>`;
    for (const key of ['step', 'stepU', 'splatN', 'splatU', 'pose', 'poseU']) {
      reveal(ui[key], t, 0.3, 0.9);
      ui[key].style.opacity = String(Number(ui[key].style.opacity) * (1 - seg(t, 5.3, 5.7)));
    }

    // The comparison: wipe across the training view, then switch to a held-out photo
    const w = t < 5.2 ? 0.5 + 0.42 * Math.sin((seg(t, 0.6, 5.0) * 2 - 0.5) * Math.PI) : 0.5;
    const held = ease.inOut(seg(t, 5.3, 5.9));
    const clip = `inset(0 0 0 ${(w * 100).toFixed(2)}%)`;
    ui.trainRender.style.clipPath = clip;
    ui.testRender.style.clipPath = clip;
    ui.testPhoto.style.opacity = ui.testRender.style.opacity = String(held);
    ui.wipe.style.left = `${w * 960 - 1.5}px`;
    reveal(ui.frame, t, 0, 0.6, 24);
    ui.lPhoto.style.opacity = String(ease.out(seg(t, 0.6, 1.0)) * (1 - held));
    ui.lHeld.style.opacity = String(held);
    ui.lRender.style.left = `${120 + 960 - 24 - ui.lRender.offsetWidth}px`;
    ui.lRender.style.opacity = String(ease.out(seg(t, 0.6, 1.0)));

    reveal(ui.label, t, 0.1, 0.6);
    reveal(ui.sub, t, 0.25, 0.8);
    reveal(ui.chips, t, 1.0, 1.6);
    reveal(ui.foot, t, 1.2, 1.8);
    reveal(ui.held, t, 5.6, 6.2);
  },
};

function px(step: number) {
  return CX + (step / STEPS) * CW;
}
function py(psnr: number) {
  return CY + CH - ((psnr - P0) / (P1 - P0)) * CH;
}

export default shot;
