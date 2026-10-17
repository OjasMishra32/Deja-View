// What the headset's lens opens onto (hero.ts): a short film of how Déjà View made the Infinity Hall
// Game Lawn, told with the real material from it, one shot per idea and every shot a function of the
// scroll so it plays forwards and backwards:
//
//   photo    the phone's photos as a fanned stack of prints, IMG_7350 on top
//   cameras  every photo floating where it was taken, around the rebuilt room
//   photo    IMG_7350 alone again, rising to the middle
//   rebuild  a flight through the rebuilt room that starts exactly at that photo's view: the print's
//            paper fades, the flight's first frame takes the picture's place, grows to fill the screen,
//            and the scroll scrubs the flight
//   world    the room's real splats, live: small discs first, then soft brushstrokes; later, the place
//            you walk into (until the live view is up, and without WebGL, the flight loops instead)
//   people   the real foosball clip, then both players rebuilt in 3D at the table, the clip inset
//
// Media lives in web/public/landing (served at /landing). Posters load when the visitor starts down
// the page; each clip loads about a screen before its shot, and the live world once the film has
// stayed on screen a moment past its first shots.

import type { Scene } from '../../shared/types.ts';
import { getScene } from './api.ts';
import type { HeroWorld } from './hero-world.ts';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** When each shot is on screen, in the film's progress (0..1); the edges cross-fade over FADE. The last ones run past 1 so they stay up to the end. */
const SHOTS: Record<string, [number, number][]> = {
  photo: [[0, 0.15], [0.27, 0.4]],
  cameras: [[0.13, 0.29]],
  rebuild: [[0.29, 0.45]],
  world: [[0.43, 0.6], [0.84, 2]],
  people: [[0.6, 0.86]],
};
const FADE = 0.02;
/** The single print rises back to the middle as it returns. */
const RISE: [number, number] = [0.27, 0.3];
/** The print's paper fades, then the flight's first frame (the same view) takes the picture's place, then grows. */
const PAPER: [number, number] = [0.295, 0.305];
const DISSOLVE: [number, number] = [0.305, 0.315];
const GROW: [number, number] = [0.315, 0.355];
/** The flight is scrubbed by the scroll over this range. */
const SCRUB: [number, number] = [0.33, 0.45];
/** The people shot: the clip alone, then the 3D players come in and the clip moves to a corner. */
const PEOPLE_3D: [number, number] = [0.69, 0.72];
/** The splats grow from small discs (Gaussian cutoff in standard deviations) to soft blobs, under their caption. */
const DETAIL: [number, number] = [0.47, 0.54];
/** Clips start loading about a screen of scrolling before their shot. */
const AHEAD = 0.2;
/** Where the print sits: centred across, a little above the middle (the words go underneath), about half the height; keep in step with .film-print in styles.css. */
const PRINT_TOP = 0.42;
const PRINT_H = 0.46;

/** How much of a shot shows at film progress p. */
function shown(key: string, p: number): number {
  let k = 0;
  for (const [a, b] of SHOTS[key] ?? []) k = Math.max(k, smooth(a - FADE, a, p) * (1 - smooth(b - FADE, b, p)));
  return k;
}
/** Where a shot first appears. */
const firstAt = (key: string) => SHOTS[key]?.[0]?.[0] ?? 0;

export class LensFilm {
  private readonly shots = new Map<string, HTMLElement>();
  private readonly videos: HTMLVideoElement[];
  private readonly flight: HTMLVideoElement | null;
  private readonly worldShot: HTMLElement | null;
  private world: HeroWorld | null = null;
  private worldLoading = false;
  private worldFailed = false;
  private seekTo = -1;
  private loaded = false;
  /** The live world mounts after the film has stayed on screen a moment, not when the page merely scrolls past. */
  private dwell = 0;
  private lastNear = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: { mobile: boolean; webgl: boolean; onChange?: () => void },
  ) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-shot]')) this.shots.set(el.dataset.shot!, el);
    this.videos = [...root.querySelectorAll<HTMLVideoElement>('video')];
    this.flight = root.querySelector<HTMLVideoElement>('[data-shot="rebuild"] video');
    this.worldShot = this.shots.get('world') ?? null;
    // the flight is scrubbed: seek again once the last seek lands
    this.flight?.addEventListener('seeked', () => {
      if (this.seekTo >= 0 && this.flight && Math.abs(this.flight.currentTime - this.seekTo) > 1 / 60) this.flight.currentTime = this.seekTo;
    });
  }

  /** Loads the prints and the clips' posters; the clips themselves load as their shots come near. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const img of this.root.querySelectorAll<HTMLImageElement>('img[data-src]')) {
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = img.dataset.src!;
    }
    const tall = this.tall();
    for (const v of this.videos) {
      const poster = (tall && v.dataset.posterPortrait) || v.dataset.poster;
      if (poster) v.poster = poster;
      // the flight can only be scrubbed once its length is known: draw again then
      v.addEventListener('loadedmetadata', () => this.opts.onChange?.(), { once: true });
    }
    // the splat count in the words comes from the world itself
    getScene('the-courts')
      .then((s: Scene) => {
        const n = s.world?.splatCount;
        if (!n) return;
        for (const el of document.querySelectorAll<HTMLElement>('[data-splat-count]')) el.textContent = n.toLocaleString('en-US');
      })
      .catch(() => {});
  }

  /** A tall screen (a phone held upright): wide clips have portrait or square cuts for it. */
  private tall(): boolean {
    return this.root.clientHeight > this.root.clientWidth * 1.15;
  }

  /** A clip's source: a portrait cut on tall screens, a lighter one on phones, when there is one. */
  private source(v: HTMLVideoElement): string {
    return (this.tall() && v.dataset.srcPortrait) || (this.opts.mobile && v.dataset.srcMobile) || v.dataset.src || '';
  }

  /** Draws the film at progress p; `on` is false while the film is hidden or off screen. */
  update(p: number, on: boolean): void {
    if (!this.loaded) this.load();
    const W = this.root.clientWidth, H = this.root.clientHeight;
    // one picture at a time, chosen from the scroll; the change is a short CSS fade (no half-way double exposure)
    for (const [key, el] of this.shots) el.classList.toggle('is-on', shown(key, p) > 0.5);

    // ---- the prints: a fanned stack at first; on its return, the top one alone, rising to the middle, its paper fading
    const photo = this.shots.get('photo');
    if (photo) {
      photo.style.setProperty('--stack', p < 0.2 ? '1' : '0');
      photo.style.setProperty('--rise', (p < 0.2 ? 1 : smooth(RISE[0], RISE[1], p)).toFixed(3));
      photo.style.setProperty('--paper', (1 - smooth(PAPER[0], PAPER[1], p)).toFixed(3));
    }

    // ---- the flight: it starts exactly over the print's picture, then grows to fill the screen
    if (this.flight) {
      const pw = Math.min(0.86 * W, (PRINT_H * H * 4) / 3);
      const cw = Math.max(W, (H * 4) / 3);
      const grow = smooth(GROW[0], GROW[1], p);
      // a hair inside the picture, so no frame edge shows past it
      const s = lerp((pw / cw) * 0.996, 1, grow);
      this.flight.style.width = `${cw.toFixed(1)}px`;
      this.flight.style.top = `${(lerp(PRINT_TOP, 0.5, grow) * 100).toFixed(2)}%`;
      this.flight.style.transform = `translate(-50%, -50%) scale(${s.toFixed(4)})`;
      this.flight.style.opacity = smooth(DISSOLVE[0], DISSOLVE[1], p).toFixed(3);
      const d = this.flight.duration;
      if (on && Number.isFinite(d) && d > 0 && shown('rebuild', p) > 0) {
        const t = smooth(SCRUB[0], SCRUB[1], p) * (d - 0.05);
        this.seekTo = t;
        if (!this.flight.seeking && Math.abs(this.flight.currentTime - t) > 1 / 60) this.flight.currentTime = t;
      }
    }

    // ---- people: the real clip first, then the players in 3D with the clip in the corner
    this.shots.get('people')?.style.setProperty('--people', smooth(PEOPLE_3D[0], PEOPLE_3D[1], p).toFixed(3));

    // ---- clips: each loads about a screen before its shot, and plays only while its shot is on screen (the flight is scrubbed instead)
    for (const v of this.videos) {
      const shot = v.closest<HTMLElement>('[data-shot]')?.dataset.shot ?? '';
      if (!v.getAttribute('src') && on && p > firstAt(shot) - AHEAD) {
        v.preload = v === this.flight ? 'auto' : 'metadata';
        v.src = this.source(v);
      }
      if (v === this.flight) continue;
      const live = on && shown(shot, p) > 0.5 && !(v.classList.contains('world-fallback') && this.world) && !!v.getAttribute('src');
      if (live && v.paused) void v.play().catch(() => {});
      else if (!live && !v.paused) v.pause();
    }

    // ---- the live world: loads once the film has stayed on screen a moment past its first shots (so it
    // is ready by its shot, but not for a page merely scrolling past), and draws only while its shot shows
    // drawn a moment either side of its shot, so it is still drawing while it fades in or out
    const worldOn = on && shown('world', p) > 0.01;
    const near = on && p > 0.25;
    if (near && !this.world && !this.dwell) {
      this.dwell = window.setTimeout(() => {
        this.dwell = 0;
        if (this.lastNear) this.mountWorld();
      }, 400);
    }
    this.lastNear = near;
    this.world?.setRunning(worldOn);
    this.world?.setDetail(lerp(0.35, 2.8, smooth(DETAIL[0], DETAIL[1], p) ** 1.5));
  }

  resize(): void {
    this.world?.resize();
  }

  private mountWorld(): void {
    const host = this.worldShot;
    if (!this.opts.webgl || !host || this.world || this.worldLoading || this.worldFailed) return;
    this.worldLoading = true;
    getScene('the-courts')
      .then((scene: Scene) => import('./hero-world.ts').then((m) => m.mountHeroWorld(host, scene, { mobile: this.opts.mobile, still: false, background: 0x000000 })))
      .then((w) => {
        this.world = w;
        this.opts.onChange?.();
      })
      .catch(() => {
        // the flight keeps looping in its place
        this.worldFailed = true;
        host.querySelector('canvas')?.remove();
      })
      .finally(() => {
        this.worldLoading = false;
      });
  }
}
