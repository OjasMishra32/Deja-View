// Splat to game world: the same two rooms side by side, as our Gaussian splat and as the playable Roblox game built
// from it (the Game Lawn, then the giant chess corner). Real footage: our fly-throughs and screen recordings of the
// live Roblox game.
import { ease, el, seg, story, type Shot } from '../lib';

const DUR = 11;
const PAIRS = [
  { splat: '/film/out/s2r/lawn-splat.mp4', rbx: '/film/out/s2r/lawn-rbx.mp4', name: 'Infinity Hall Game Lawn' },
  { splat: '/film/out/s2r/chess-splat.mp4', rbx: '/film/out/s2r/chess-rbx.mp4', name: 'Giant chess' },
];
const SWAP = 5.4; // the second pair takes over here
const CW = 820, CH = 461, GAP = 40, X0 = (1920 - (2 * CW + GAP)) / 2, Y0 = 120;
const vids: HTMLVideoElement[][] = [];
const cards: HTMLCanvasElement[] = [];
const ui: Record<string, HTMLElement> = {};
let words: ReturnType<typeof story>;

async function seek(v: HTMLVideoElement, t: number) {
  t = Math.min(Math.max(0, t), v.duration - 0.05);
  if (Math.abs(v.currentTime - t) < 1e-3) return;
  await new Promise((r) => { v.onseeked = () => r(null); v.currentTime = t; });
}

const shot: Shot = {
  duration: DUR,
  async setup() {
    for (const p of PAIRS) {
      const pair: HTMLVideoElement[] = [];
      for (const src of [p.splat, p.rbx]) {
        const v = document.createElement('video');
        v.src = src;
        v.muted = true;
        v.preload = 'auto';
        await new Promise((r) => (v.onloadeddata = () => r(null)));
        pair.push(v);
      }
      vids.push(pair);
    }
    for (let i = 0; i < 2; i++) {
      const c = document.createElement('canvas');
      c.width = CW * 2;
      c.height = CH * 2;
      c.style.cssText = `position:absolute;left:${X0 + i * (CW + GAP)}px;top:${Y0}px;width:${CW}px;height:${CH}px;border-radius:22px;background:#1d1d1f`;
      document.getElementById('overlay')!.appendChild(c);
      cards.push(c);
    }
    ui.l = el('callout', X0, Y0 + CH + 22, 'Our Gaussian splat');
    ui.r = el('callout', X0 + CW + GAP, Y0 + CH + 22,
      '<img src="/film/assets/logos/roblox.svg" style="height:20px;vertical-align:-2px;margin-right:12px">Playable, at real scale');
    ui.room = el('axis', X0, Y0 - 40, PAIRS[0].name);
    words = story('Splat to game world', 'Then we make it playable.',
      'An agent on HiPerGator reads the splat (the floor, the walls, where the table and the board stand) and builds the room in Roblox Studio at real size, 3.57 studs to the metre.');
  },

  async frame(t) {
    const second = t >= SWAP;
    const local = second ? t - SWAP : t;
    const pair = vids[second ? 1 : 0];
    await seek(pair[0], 0.2 + local);
    await seek(pair[1], 0.2 + local);
    pair.forEach((v, i) => cards[i].getContext('2d')!.drawImage(v, 0, 0, CW * 2, CH * 2));
    // a soft dip between the two rooms
    const dip = second ? ease.site(seg(t, SWAP, SWAP + 0.35)) : 1 - ease.site(seg(t, SWAP - 0.35, SWAP));
    cards.forEach((c, i) => {
      const k = ease.site(seg(t, 0.15 + i * 0.25, 0.9 + i * 0.25));
      c.style.opacity = String(k * (0.15 + 0.85 * dip));
      c.style.transform = `translateY(${(1 - k) * 24}px)`;
    });
    ui.l.style.opacity = String(ease.site(seg(t, 0.4, 1.0)));
    ui.r.style.opacity = String(ease.site(seg(t, 0.65, 1.25)));
    ui.room.textContent = PAIRS[second ? 1 : 0].name;
    ui.room.style.opacity = String(ease.site(seg(t, 0.4, 1.0)) * (0.3 + 0.7 * dip));
    words.show(t, 0.8);
  },
};

export default shot;
