// Shot 34: people from one video. Real data: the foosball memory's packed stream (people.mp4), whose every frame holds
// the phone video (top), its depth (bottom left) and the people mask (bottom right). Three cards play it in sync.
import { ease, el, seg, story, type Shot } from '../lib';

const DUR = 8;
const SRC = '/data/scenes/courts-foosball/people.mp4';
const CW = 520, CH = 292, GAP = 40, X0 = (1920 - (3 * CW + 2 * GAP)) / 2, Y0 = 150;
let video: HTMLVideoElement;
let words: ReturnType<typeof story>;
const cards: HTMLCanvasElement[] = [];
const labels: HTMLElement[] = [];
let scratch: CanvasRenderingContext2D;

async function seek(t: number) {
  t = Math.min(t, video.duration - 0.05);
  if (Math.abs(video.currentTime - t) < 1e-3) return;
  await new Promise((r) => { video.onseeked = () => r(null); video.currentTime = t; });
}

const shot: Shot = {
  duration: DUR,
  async setup() {
    video = document.createElement('video');
    video.src = SRC;
    video.muted = true;
    video.preload = 'auto';
    await new Promise((r) => (video.onloadeddata = () => r(null)));
    const names = ['One phone video', 'Depth, every frame', 'The people, cut out'];
    names.forEach((n, i) => {
      const c = document.createElement('canvas');
      c.width = CW * 2;
      c.height = CH * 2;
      c.style.cssText = `position:absolute;left:${X0 + i * (CW + GAP)}px;top:${Y0}px;width:${CW}px;height:${CH}px;border-radius:20px;background:#1d1d1f`;
      document.getElementById('overlay')!.appendChild(c);
      cards.push(c);
      labels.push(el('callout', X0 + i * (CW + GAP), Y0 + CH + 22, n));
    });
    const s = document.createElement('canvas');
    s.width = CW * 2;
    s.height = CH * 2;
    scratch = s.getContext('2d', { willReadFrequently: true })!;
    words = story('People from one video', 'Both players, back in 3D.',
      'For every frame we cut the people out, measure depth in metres, and line it up with the empty room, so they stand back in the place, moving, in 3D.');
  },

  async frame(t) {
    await seek(1.0 + t);
    const w = CW * 2, h = CH * 2;
    // the phone video
    const a = cards[0].getContext('2d')!;
    a.drawImage(video, 0, 0, 1920, 1080, 0, 0, w, h);
    // depth: near is bright; tinted toward the site's blue
    scratch.drawImage(video, 0, 1080, 960, 540, 0, 0, w, h);
    const d = scratch.getImageData(0, 0, w, h);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = d.data[i] / 255;
      d.data[i] = 245 * v * v;
      d.data[i + 1] = 60 + 185 * v;
      d.data[i + 2] = 90 + 165 * Math.sqrt(v);
    }
    cards[1].getContext('2d')!.putImageData(d, 0, 0);
    // the people: colour where the mask says so
    scratch.drawImage(video, 960, 1080, 960, 540, 0, 0, w, h);
    const m = scratch.getImageData(0, 0, w, h);
    scratch.drawImage(video, 0, 0, 1920, 1080, 0, 0, w, h);
    const c = scratch.getImageData(0, 0, w, h);
    for (let i = 0; i < c.data.length; i += 4) {
      const k = m.data[i] / 255;
      c.data[i] *= k; c.data[i + 1] *= k; c.data[i + 2] *= k;
    }
    cards[2].getContext('2d')!.putImageData(c, 0, 0);

    cards.forEach((cv, i) => {
      const k = ease.site(seg(t, 0.2 + i * 0.25, 1.0 + i * 0.25));
      cv.style.opacity = String(k);
      cv.style.transform = `translateY(${(1 - k) * 24}px)`;
      labels[i].style.opacity = String(k);
    });
    words.show(t, 0.9);
  },
};

export default shot;
