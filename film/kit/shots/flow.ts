// How a memory travels: the path of one clip through the product, each step done by the sponsor that does it.
// DeepSpace takes it in, Vultr and HiPerGator build it, deja-view.photo serves it, Auth0 keeps it in the family,
// Tiger Data remembers every visit. A dot carries the memory along; each card lights as it arrives.
import { BLUE, ease, el, seg, story, type Shot } from '../lib';

const DUR = 10;
const L = '/film/assets/logos';
const STEPS = [
  { logo: `<img src="${L}/deepspace-ring.png" style="height:40px;margin-right:12px"><span style="font-size:24px;font-weight:600;color:#f5f5f7;letter-spacing:-0.01em">DeepSpace</span>`, title: 'Add a memory', body: 'A photo or a clip, added in the DeepSpace app the family already uses.' },
  { logo: `<img src="${L}/vultr-white.svg" style="height:22px"><span style="color:#6e6e73;margin:0 8px">+</span><span style="font-size:17px;font-weight:600;color:#f5f5f7;white-space:nowrap">UF HiPerGator</span>`, title: 'Built on GPUs', body: 'The same worker code on a Vultr GPU and on HiPerGator, side by side.' },
  { logo: `<img src="${L}/godaddy-registry.svg" style="height:22px;filter:brightness(0) invert(1)">`, title: 'deja-view.photo', body: 'One link for the headset, Roblox and the browser.' },
  { logo: `<img src="${L}/auth0-white.svg" style="height:34px">`, title: 'Memory Keys', body: 'A private memory opens only for the people its owner lets in.' },
  { logo: `<img src="${L}/tigerdata.svg" style="height:30px">`, title: 'Every visit', body: 'Positions five times a second into a Timescale hypertable.' },
];
const CW = 280, CH = 350, GAP = 36, X0 = (1920 - (5 * CW + 4 * GAP)) / 2, Y0 = 160;
const cards: HTMLElement[] = [];
let dot: HTMLElement, rail: HTMLElement, fill: HTMLElement;
let words: ReturnType<typeof story>;
const ARRIVE = STEPS.map((_, i) => 1.4 + i * 1.35); // when the memory reaches each card

const shot: Shot = {
  duration: DUR,
  async setup() {
    const railY = Y0 + CH + 48;
    rail = el('', X0 + CW / 2, railY, '');
    rail.style.cssText += `width:${4 * (CW + GAP)}px;height:2px;background:rgba(245,245,247,.12)`;
    fill = el('', X0 + CW / 2, railY, '');
    fill.style.cssText += `width:${4 * (CW + GAP)}px;height:2px;background:${BLUE};transform-origin:0 50%;transform:scaleX(0)`;
    STEPS.forEach((s, i) => {
      const c = el('', X0 + i * (CW + GAP), Y0, `
        <div style="height:116px;display:flex;align-items:center;justify-content:center">${s.logo}</div>
        <div style="padding:0 28px">
          <div style="font-size:28px;font-weight:600;color:#f5f5f7;letter-spacing:-0.015em">${s.title}</div>
          <div style="margin-top:10px;font-size:21px;line-height:1.38;color:#86868b">${s.body}</div>
        </div>`);
      c.style.cssText += `width:${CW}px;height:${CH}px;border-radius:24px;background:#1d1d1f;box-shadow:inset 0 0 0 1px rgba(245,245,247,.06)`;
      cards.push(c);
    });
    dot = el('', 0, railY - 7, '');
    dot.style.cssText += `width:16px;height:16px;margin-left:-8px;border-radius:50%;background:${BLUE};box-shadow:0 0 0 6px rgba(41,151,255,.18),0 0 24px rgba(41,151,255,.6)`;
    words = story('How a memory travels', 'From a phone to a place.',
      'One clip goes in. It comes back as a world at one link, opens only for the family, and remembers every time someone walks through it.');
  },

  frame(t) {
    cards.forEach((c, i) => {
      const k = ease.site(seg(t, 0.2 + i * 0.14, 0.9 + i * 0.14));
      const lit = ease.site(seg(t, ARRIVE[i] - 0.15, ARRIVE[i] + 0.35));
      c.style.opacity = String(k * (0.55 + 0.45 * lit));
      c.style.transform = `translateY(${(1 - k) * 24}px)`;
      c.style.boxShadow = `inset 0 0 0 ${1 + lit}px rgba(41,151,255,${0.06 + 0.5 * lit})`;
    });
    // the dot glides from card to card, pausing a moment at each
    const span = CW + GAP;
    let x = 0;
    for (let i = 0; i < STEPS.length - 1; i++) x += ease.inOut(seg(t, ARRIVE[i] + 0.35, ARRIVE[i + 1]));
    const left = X0 + CW / 2 + x * span;
    dot.style.left = `${left}px`;
    dot.style.opacity = String(ease.site(seg(t, ARRIVE[0] - 0.4, ARRIVE[0])));
    fill.style.transform = `scaleX(${x / (STEPS.length - 1)})`;
    rail.style.opacity = fill.style.opacity = String(ease.site(seg(t, 0.6, 1.2)));
    words.show(t, 0.8);
  },
};

export default shot;
