// The "Step inside" row on the landing page: our best real worlds as big cards, each a looping flight through it.
//
// The four known worlds render at once with their stills, so the section is never empty. Then the page checks
// which flights exist (listed in /landing/worlds/index.json: <id>.mp4 and .jpg; a world without one keeps its still)
// and what the server says about each world: names, and whether it is ready. refresh() asks the server again, so worlds join, leave and get renamed live.
// A flight loads and plays only while its card is on screen, at most three at a time on a wide screen and two on a
// narrower one, and never while the tab is hidden. With reduced motion nothing plays until someone presses play.

import { listScenes, sceneAssetUrl, viewUrl, type Scene } from './api.ts';

interface Known {
  name: string;
  made: string;
}

/** The worlds, best first. Each shows at once with its still; one the server does not call ready leaves. */
const ORDER = ['the-courts', 'chess-room', 'kitchen', 'tilted-towers'];

/** What each known world was made from, in our words. The names are the server's, except the Game Lawn's. */
const KNOWN: Record<string, Known> = {
  'the-courts': { name: 'Infinity Hall Game Lawn', made: '25 photos and two phone clips.' },
  'chess-room': { name: 'Giant chess', made: 'Stills of four phone clips of the giant chess board.' },
  kitchen: { name: 'Kitchen', made: '36 photos and a cooking clip.' },
  'tilted-towers': { name: 'Tilted Towers', made: 'Stills of Tilted Towers Tour | Fortnite OG S2 by woodinjake.' },
};

/** Names that stay ours whatever the server calls the scene. */
const FIXED_NAME: Record<string, string> = { 'the-courts': 'Infinity Hall Game Lawn' };

/** Words a card never repeats from the server, because they would not be true of how the world was made. */
const UNTRUE = /still[- ]camera|\bblocks?\b|the courts/i;

/** How many flights play at once: three across a wide screen, two below it. */
const WIDE = '(min-width: 1068px)';
const MAX_PLAYING_WIDE = 3;
const MAX_PLAYING = 2;
/** How much of a card must be on screen before its flight plays. */
const VISIBLE = 0.35;
/** refresh() asks the server at most this often. */
const REFRESH_GAP = 2000;

type Want = 'auto' | 'on' | 'off';

interface Card {
  id: string;
  li: HTMLLIElement;
  media: HTMLDivElement;
  img: HTMLImageElement;
  name: HTMLHeadingElement;
  made: HTMLParagraphElement;
  walkName: HTMLSpanElement;
  video: HTMLVideoElement | null;
  toggle: HTMLButtonElement | null;
  title: string;
  /** /landing/worlds/<id>.jpg once we know it exists. */
  poster: string | null;
  /** The scene's own thumbnail. */
  thumb: string | null;
  /** The still in the img right now. */
  shown: string | null;
  failed: Set<string>;
  probed: boolean;
  /** How much of the card is on screen, 0..1. */
  ratio: number;
  /** auto: plays when on screen (unless reduced motion); on/off: the viewer pressed play or pause. */
  want: Want;
  /** When the viewer last pressed play or pause on this card. */
  wantAt: number;
}

interface Details {
  id: string;
  name: string;
  made: string;
  thumb: string | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function icon(paths: string[], viewBox = '0 0 24 24'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const PLAY = ['M8 5.6v12.8c0 .8.9 1.3 1.6.9l10.2-6.4c.6-.4.6-1.4 0-1.8L9.6 4.7C8.9 4.3 8 4.8 8 5.6z'];
const PAUSE = ['M7.2 5h2.6c.4 0 .7.3.7.7v12.6c0 .4-.3.7-.7.7H7.2c-.4 0-.7-.3-.7-.7V5.7c0-.4.3-.7.7-.7zm7 0h2.6c.4 0 .7.3.7.7v12.6c0 .4-.3.7-.7.7h-2.6c-.4 0-.7-.3-.7-.7V5.7c0-.4.3-.7.7-.7z'];
const CHEVRON_LEFT = ['M20.6 11.2 14 18l6.6 6.8'];
const CHEVRON_RIGHT = ['M15.4 11.2 22 18l-6.6 6.8'];

function landing(id: string, ext: 'mp4' | 'jpg'): string {
  return `/landing/worlds/${encodeURIComponent(id)}.${ext}`;
}

interface Manifest {
  /** Worlds with a flight: <id>.mp4 and its <id>.jpg poster. */
  clips: Set<string>;
  /** Worlds with a small flight for the hero chips: <id>-chip.mp4 and <id>-chip.jpg. */
  chips: Set<string>;
}

let manifest: Promise<Manifest> | null = null;
/**
 * Which worlds have a flight: /landing/worlds/index.json lists them, so the page asks once instead of
 * asking for files that may not be there yet. Read again on refresh, when new flights may have landed.
 */
function readManifest(fresh = false): Promise<Manifest> {
  if (fresh) manifest = null;
  const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  manifest ??= fetch('/landing/worlds/index.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { clips?: unknown; chips?: unknown } | null) => ({ clips: ids(d?.clips), chips: ids(d?.chips) }))
    .catch(() => ({ clips: new Set<string>(), chips: new Set<string>() }));
  return manifest;
}

function clipList(fresh = false): Promise<Set<string>> {
  return readManifest(fresh).then((m) => m.clips);
}

/**
 * What a world was made from, out of the first sentence of its caption: "The kitchen, rebuilt from 36 photos: the
 * fridge, ..." -> "36 photos." Empty when the caption does not say, or says something we never repeat, so the card
 * never claims something untrue.
 */
function madeFrom(caption: string | undefined | null): string {
  const text = String(caption ?? '').trim();
  if (UNTRUE.test(text)) return '';
  // no lookbehind here: Safari before 16.4 cannot parse one, and that would sink the whole module
  const first = text.split(/[.!?]\s+/)[0] ?? '';
  const m = /\b(?:rebuilt|made|built|reconstructed|recreated)\s+from\s+(.+)$/i.exec(first);
  if (!m) return '';
  let s = (m[1] ?? '').split(/\s*[:;(]\s*|\s+[–—-]\s+|,?\s+and\s+(?:frozen|then|now|walk)\b|,\s+(?:then|now|frozen|walk)\b/i)[0] ?? '';
  s = s.replace(/[\s.,!?]+$/, '');
  if (!s || s.length > 72) return '';
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
}

function details(scene: Scene): Details {
  const known = KNOWN[scene.id];
  const given = scene.name?.trim() ?? '';
  return {
    id: scene.id,
    name: FIXED_NAME[scene.id] ?? ((given && !UNTRUE.test(given) ? given : '') || known?.name || 'A world'),
    made: known?.made ?? madeFrom(scene.caption),
    thumb: scene.thumb ? sceneAssetUrl(scene.id, scene.thumb) : null,
  };
}

function bucket(ratio: number): number {
  return ratio >= 0.95 ? 3 : ratio >= 0.7 ? 2 : ratio >= VISIBLE ? 1 : 0;
}

class WorldsRow {
  private readonly section: HTMLElement | null;
  private readonly track: HTMLUListElement;
  private readonly nav: HTMLDivElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly io: IntersectionObserver | null;
  private readonly motion: MediaQueryList | null;
  private readonly wide: MediaQueryList | null;
  private reduced: boolean;
  private cards: Card[] = [];
  private navFrame = 0;
  /** Once the row is near the screen every still loads, the ones off to the side included. */
  private near = false;
  /** Whether the section is hidden because the last card left (and so comes back with the next one). */
  private emptied = false;
  /** The stills that would not load for a world that left, so it does not come back only to leave again. */
  private readonly deadStills = new Map<string, Set<string>>();
  /** refresh(): when the server was last asked, whether an ask is running, waiting, or wanted after this one. */
  private askedAt = -Infinity;
  private asking = false;
  private askTimer = 0;
  private askAgain = false;

  constructor(private readonly host: HTMLElement) {
    this.section = host.closest('section');
    this.motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.wide = typeof matchMedia === 'function' ? matchMedia(WIDE) : null;
    this.reduced = !!this.motion?.matches;

    this.track = el('ul', 'wr-track');
    this.track.id = 'worlds-track';
    this.track.setAttribute('role', 'list');

    this.nav = el('div', 'wrap wr-nav');
    this.nav.hidden = true;
    this.prev = this.arrow('Previous worlds', CHEVRON_LEFT, -1);
    this.next = this.arrow('Next worlds', CHEVRON_RIGHT, 1);
    this.nav.append(this.prev, this.next);

    host.replaceChildren(this.track, this.nav);

    this.io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => this.onIntersect(entries), { threshold: [0, VISIBLE, 0.7, 0.95, 1] })
        : null;

    if (typeof IntersectionObserver === 'function') {
      const nearby = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          nearby.disconnect();
          this.near = true;
          for (const c of this.cards) c.img.loading = 'eager';
        },
        { rootMargin: '800px 0px' },
      );
      nearby.observe(host);
    } else {
      this.near = true;
    }

    this.track.addEventListener('scroll', () => this.queueNav(), { passive: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.queueNav()).observe(this.track);
    else addEventListener('resize', () => this.queueNav());
    document.addEventListener('visibilitychange', () => this.schedule());
    this.motion?.addEventListener?.('change', () => {
      this.reduced = !!this.motion?.matches;
      this.schedule();
    });
    this.wide?.addEventListener?.('change', () => this.schedule());
  }

  /** The known worlds, straight away, then whatever the files and the server add. */
  start(): void {
    for (const id of ORDER) {
      const known = KNOWN[id];
      if (!known) continue;
      const card = this.build({ id, name: known.name, made: known.made, thumb: sceneAssetUrl(id, 'thumb.jpg') });
      this.insert(card);
      this.showStill(card);
      void this.probe(card).then(() => this.showStill(card));
    }
    this.updateCount();
    this.refresh();
  }

  /**
   * Ask the server again: worlds that became ready join, ones that went away leave, renamed ones change their name.
   * Safe to call as often as you like: it asks at most once every two seconds, one ask at a time, and a call that
   * comes in while it waits or asks is folded into the next ask.
   */
  refresh(): void {
    if (this.askTimer) return;
    if (this.asking) {
      this.askAgain = true;
      return;
    }
    const wait = this.askedAt + REFRESH_GAP - performance.now();
    if (wait > 0) {
      this.askTimer = window.setTimeout(() => {
        this.askTimer = 0;
        this.refresh();
      }, wait);
      return;
    }
    this.askedAt = performance.now();
    this.asking = true;
    void this.refine()
      .catch(() => undefined)
      .finally(() => {
        this.asking = false;
        if (!this.askAgain) return;
        this.askAgain = false;
        this.refresh();
      });
  }

  private arrow(label: string, path: string[], dir: number): HTMLButtonElement {
    const b = el('button', 'wr-arrow');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-controls', this.track.id);
    const svg = icon(path, '0 0 36 36');
    b.appendChild(svg);
    b.addEventListener('click', () => this.step(dir));
    return b;
  }

  private build(d: Details): Card {
    const li = el('li', 'wr-card');
    li.dataset.id = d.id;

    const media = el('div', 'wr-media');
    media.setAttribute('aria-hidden', 'true');
    const img = el('img', 'wr-still');
    img.alt = '';
    img.decoding = 'async';
    img.loading = this.near ? 'eager' : 'lazy';
    img.draggable = false;
    media.appendChild(img);

    const copy = el('div', 'wr-copy');
    const name = el('h3', 'wr-name', d.name);
    const made = el('p', 'wr-made', d.made);
    made.hidden = !d.made;
    const walk = el('a', 'btn btn-white wr-walk', 'Walk in');
    walk.href = viewUrl(d.id);
    const walkName = el('span', 'sr-only', `: ${d.name}`);
    walk.appendChild(walkName);
    copy.append(name, made, walk);

    li.append(media, copy);

    const card: Card = {
      id: d.id,
      li,
      media,
      img,
      name,
      made,
      walkName,
      video: null,
      toggle: null,
      title: d.name,
      poster: null,
      thumb: d.thumb,
      shown: null,
      failed: new Set(this.deadStills.get(d.id)),
      probed: false,
      ratio: 0,
      want: 'auto',
      wantAt: 0,
    };

    img.addEventListener('load', () => li.classList.add('has-still'));
    img.addEventListener('error', () => {
      if (card.shown) card.failed.add(card.shown);
      card.shown = null;
      this.showStill(card);
    });
    return card;
  }

  private insert(card: Card): void {
    const rank = ORDER.indexOf(card.id);
    const after = this.cards.findIndex((c) => ORDER.indexOf(c.id) > rank);
    if (after < 0) {
      this.cards.push(card);
      this.track.appendChild(card.li);
    } else {
      this.cards.splice(after, 0, card);
      this.track.insertBefore(card.li, this.cards[after + 1]!.li);
    }
    this.io?.observe(card.li);
    if (!this.io) card.ratio = 1;
    // the row had emptied and hidden itself: a world is back, so is the section
    if (this.emptied && this.section) {
      this.emptied = false;
      this.section.hidden = false;
    }
  }

  private drop(card: Card): void {
    const i = this.cards.indexOf(card);
    if (i < 0) return;
    this.cards.splice(i, 1);
    this.io?.unobserve(card.li);
    card.ratio = 0;
    card.video?.pause();
    card.li.remove();
    if (card.failed.size) this.deadStills.set(card.id, card.failed);
    this.updateCount();
    if (!this.cards.length && this.section && !this.section.hidden) {
      this.section.hidden = true;
      this.emptied = true;
    }
    this.schedule();
  }

  private updateCount(): void {
    this.host.dataset.count = String(this.cards.length);
    this.queueNav();
  }

  /** The best still we have: the flight's own poster, else the scene's thumbnail. A card with neither goes. */
  private showStill(card: Card): void {
    const next = [card.poster, card.thumb].find((u): u is string => !!u && !card.failed.has(u));
    if (!next) {
      // the poster may still turn up; only give up once we know
      if (card.probed) this.drop(card);
      return;
    }
    if (card.shown === next) return;
    card.shown = next;
    card.img.src = next;
  }

  private async probe(card: Card, fresh = false): Promise<void> {
    const has = (await clipList(fresh)).has(card.id);
    if (has) card.poster = landing(card.id, 'jpg');
    if (has && !card.video) this.attachVideo(card, landing(card.id, 'mp4'));
    card.probed = true;
  }

  private attachVideo(card: Card, url: string): void {
    const v = el('video', 'wr-video');
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'none';
    v.setAttribute('disablepictureinpicture', '');
    v.setAttribute('disableremoteplayback', '');
    v.tabIndex = -1;
    v.dataset.src = url;
    v.addEventListener('playing', () => {
      card.li.classList.add('has-frame');
      this.syncToggle(card);
    });
    v.addEventListener('play', () => this.syncToggle(card));
    v.addEventListener('pause', () => this.syncToggle(card));
    v.addEventListener('error', () => this.detachVideo(card));
    card.media.appendChild(v);
    card.video = v;

    const t = el('button', 'wr-toggle');
    t.type = 'button';
    t.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const playing = !v.paused;
      card.want = playing ? 'off' : 'on';
      card.wantAt = performance.now();
      this.schedule();
    });
    card.li.appendChild(t);
    card.toggle = t;
    this.syncToggle(card);
    this.schedule();
  }

  /** The flight would not load: keep the still, lose the button. */
  private detachVideo(card: Card): void {
    const v = card.video;
    if (!v) return;
    card.video = null;
    v.removeAttribute('src');
    v.remove();
    card.toggle?.remove();
    card.toggle = null;
    card.li.classList.remove('has-frame', 'is-playing');
    this.showStill(card);
    this.schedule();
  }

  private syncToggle(card: Card): void {
    const t = card.toggle;
    const v = card.video;
    if (!t || !v) return;
    const playing = !v.paused;
    card.li.classList.toggle('is-playing', playing);
    t.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} the flight through ${card.title}`);
    t.replaceChildren(icon(playing ? PAUSE : PLAY));
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const card = this.cards.find((c) => c.li === e.target);
      if (card) card.ratio = e.isIntersecting ? e.intersectionRatio : 0;
    }
    this.schedule();
  }

  /**
   * Which flights play, out of the cards on screen (three at most on a wide screen, two below): the ones the viewer
   * pressed play on (latest first), then the most visible, so the cards in full view play after a step. Among cards
   * as visible as each other, the ones the viewer paused come first (they keep their slot, so pausing one never
   * starts another), then the ones already playing (no swapping mid-flight), then the first.
   */
  private schedule(): void {
    const hidden = document.visibilityState === 'hidden';
    const onScreen = this.cards.filter((c) => c.video && !hidden && (c.ratio >= VISIBLE || (c.want === 'on' && c.ratio > 0)));
    const pin = (c: Card) => (c.want === 'on' ? 0 : 1);
    const hold = (c: Card) => (c.want === 'off' ? 0 : !c.video!.paused ? 1 : 2);
    onScreen.sort(
      (a, b) =>
        pin(a) - pin(b) ||
        (pin(a) === 0 ? b.wantAt - a.wantAt : 0) ||
        bucket(b.ratio) - bucket(a.ratio) ||
        hold(a) - hold(b) ||
        this.cards.indexOf(a) - this.cards.indexOf(b),
    );
    const max = this.wide?.matches ? MAX_PLAYING_WIDE : MAX_PLAYING;
    const slots = new Set(onScreen.slice(0, max));
    for (const c of this.cards) {
      if (!c.video) continue;
      const play = slots.has(c) && (c.want === 'on' || (c.want === 'auto' && !this.reduced));
      if (play) this.play(c);
      else if (!c.video.paused) c.video.pause();
    }
  }

  private play(card: Card): void {
    const v = card.video;
    if (!v || !v.paused) return;
    if (!v.getAttribute('src') && v.dataset.src) v.src = v.dataset.src;
    const p = v.play();
    p?.catch((err: unknown) => {
      // the browser would not start it on its own: leave the poster and the play button
      if ((err as { name?: string })?.name === 'NotAllowedError' && card.want === 'auto') card.want = 'off';
      this.syncToggle(card);
    });
  }

  private step(dir: number): void {
    const [a, b] = this.cards;
    const stride = a && b ? b.li.offsetLeft - a.li.offsetLeft : this.track.clientWidth;
    this.track.scrollBy({ left: dir * stride, behavior: this.reduced ? 'auto' : 'smooth' });
  }

  private queueNav(): void {
    if (this.navFrame) return;
    this.navFrame = requestAnimationFrame(() => {
      this.navFrame = 0;
      const max = this.track.scrollWidth - this.track.clientWidth;
      const overflow = max > 4;
      this.nav.hidden = !overflow;
      this.prev.disabled = !overflow || this.track.scrollLeft <= 4;
      this.next.disabled = !overflow || this.track.scrollLeft >= max - 4;
    });
  }

  /** Names from the server; later worlds join once ready; a world that is gone or not ready leaves. */
  private async refine(): Promise<void> {
    let scenes: Scene[];
    try {
      scenes = await listScenes();
    } catch {
      return; // keep the worlds as they are
    }
    const byId = new Map(scenes.map((s) => [s.id, s]));
    // flights may have landed since the last look
    await clipList(true);
    await Promise.all(
      ORDER.map(async (id) => {
        const scene = byId.get(id);
        const card = this.cards.find((c) => c.id === id);
        if (!scene || scene.status !== 'ready') {
          if (card) this.drop(card);
          return;
        }
        const d = details(scene);
        if (card) {
          this.update(card, d);
          if (!card.video) {
            await this.probe(card);
            this.showStill(card);
            if (card.video) this.schedule();
          }
          return;
        }
        const fresh = this.build(d);
        await this.probe(fresh);
        // no still that could load: it would only show the night and leave again
        if (![fresh.poster, fresh.thumb].some((u) => !!u && !fresh.failed.has(u))) return;
        if (this.cards.some((c) => c.id === id)) return;
        this.insert(fresh);
        this.updateCount();
        this.showStill(fresh);
        this.schedule();
      }),
    );
  }

  private update(card: Card, d: Details): void {
    if (card.title !== d.name) {
      card.title = d.name;
      card.name.textContent = d.name;
      card.walkName.textContent = `: ${d.name}`;
      this.syncToggle(card);
    }
    if (card.made.textContent !== d.made || card.made.hidden !== !d.made) {
      card.made.textContent = d.made;
      card.made.hidden = !d.made;
    }
    if (d.thumb !== card.thumb) {
      card.thumb = d.thumb;
      this.showStill(card);
    }
  }
}

/** Fills the "Step inside" row. Call refresh() whenever the worlds may have changed; it is cheap to call often. */
export function mountWorldsRow(host: HTMLElement): { refresh(): void } {
  const row = new WorldsRow(host);
  row.start();
  return { refresh: () => row.refresh() };
}

// ---------------------------------------------------------------------------------------------
// The hero's chips: three small worlds under the calls to action, each a link down to Step inside.

interface Chip {
  id: string;
  /** What the chip says. */
  name: string;
  /** The world's full name, for the link's accessible name. */
  title: string;
}

const CHIPS: Chip[] = [
  { id: 'the-courts', name: 'Game Lawn', title: 'Infinity Hall Game Lawn' },
  { id: 'chess-room', name: 'Giant chess', title: 'Giant chess' },
  { id: 'tilted-towers', name: 'Tilted Towers', title: 'Tilted Towers' },
];

/** After the page has loaded, the chips wait this long before their loops start, so they never hold up the hero. */
const CHIP_DELAY = 900;

/**
 * Fills `host` (the hero's #hero-chips) with three chips. Each shows a still at once; a world with a flight
 * (index.json chips, else clips) loops it, muted, but only once the page has loaded, while the chips are on screen
 * and the hero copy is showing, and never with reduced motion or Save-Data on. A chip with no picture that loads goes.
 */
export function mountHeroChips(host: HTMLElement): void {
  const list = el('ul', 'hc-list');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Worlds to step inside');
  host.appendChild(list);

  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  const videos = new Set<HTMLVideoElement>();
  let onScreen = true;
  let settled = false;

  const items = CHIPS.map((c) => {
    const li = el('li', 'hc');
    const a = el('a', 'hc-link');
    a.href = '#worlds';
    if (c.title !== c.name) a.setAttribute('aria-label', c.title);
    const media = el('span', 'hc-media');
    media.setAttribute('aria-hidden', 'true');
    const img = el('img', 'hc-still');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    media.appendChild(img);
    a.append(media, el('span', 'hc-name', c.name));
    li.appendChild(a);
    list.appendChild(li);
    return { c, li, media, img };
  });

  // the hero copy goes inert once the film takes over: the loops rest until it is back
  const playing = () => onScreen && settled && !motion?.matches && !saveData && document.visibilityState !== 'hidden' && !host.closest('[inert]');
  const sync = () => {
    const on = playing();
    for (const v of videos) {
      if (on) {
        if (!v.getAttribute('src') && v.dataset.src) v.src = v.dataset.src;
        if (v.paused) v.play()?.catch(() => undefined);
      } else if (!v.paused) v.pause();
    }
  };

  void readManifest().then((m) => {
    for (const it of items) {
      const { id } = it.c;
      const small = m.chips.has(id);
      const full = m.clips.has(id);
      const stills = [small ? landing(`${id}-chip`, 'jpg') : '', full ? landing(id, 'jpg') : '', sceneAssetUrl(id, 'thumb.jpg')].filter(Boolean);
      let at = 0;
      it.img.addEventListener('load', () => it.li.classList.add('has-still'));
      it.img.addEventListener('error', () => {
        at += 1;
        if (at < stills.length) it.img.src = stills[at]!;
        else it.li.remove();
      });
      it.img.src = stills[0]!;

      const clip = small ? landing(`${id}-chip`, 'mp4') : full ? landing(id, 'mp4') : '';
      if (!clip) continue;
      const v = el('video', 'hc-video');
      v.muted = true;
      v.defaultMuted = true;
      v.setAttribute('muted', '');
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'none';
      v.setAttribute('disablepictureinpicture', '');
      v.setAttribute('disableremoteplayback', '');
      v.tabIndex = -1;
      v.dataset.src = clip;
      v.addEventListener('playing', () => it.li.classList.add('has-frame'));
      v.addEventListener('error', () => {
        videos.delete(v);
        v.removeAttribute('src');
        v.remove();
        it.li.classList.remove('has-frame');
      });
      it.media.appendChild(v);
      videos.add(v);
    }
    sync();
  });

  const settle = () =>
    setTimeout(() => {
      settled = true;
      sync();
    }, CHIP_DELAY);
  if (document.readyState === 'complete') settle();
  else addEventListener('load', settle, { once: true });

  if (typeof IntersectionObserver === 'function')
    new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      sync();
    }).observe(host);
  const copy = host.closest('.intro-copy');
  if (copy && typeof MutationObserver === 'function') new MutationObserver(sync).observe(copy, { attributes: true, attributeFilter: ['inert'] });
  document.addEventListener('visibilitychange', sync);
  motion?.addEventListener?.('change', sync);
}
