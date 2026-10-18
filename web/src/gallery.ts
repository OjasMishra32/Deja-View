// Landing page: the headset intro and the how-it-works story (hero.ts, story.ts), the hero's chips and the Step
// inside row (worlds-row.ts), the curated All worlds list, and the phone-or-headset panel.

import {
  ApiError,
  LiveEvents,
  MODE_NAME,
  errorText,
  getHealth,
  lanUrls,
  listScenes,
  modeKind,
  sceneAssetUrl,
  viewUrl,
  type HealthInfo,
  type Scene,
} from './api.ts';
import { authConfig } from './auth.ts';
import { Intro } from './hero.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------------------------------
// QR code (byte mode, error correction level L, versions 1-10) for the same-Wi-Fi link.

const QR_L: Record<number, { ec: number; blocks: number[] }> = {
  1: { ec: 7, blocks: [19] },
  2: { ec: 10, blocks: [34] },
  3: { ec: 15, blocks: [55] },
  4: { ec: 20, blocks: [80] },
  5: { ec: 26, blocks: [108] },
  6: { ec: 18, blocks: [68, 68] },
  7: { ec: 20, blocks: [78, 78] },
  8: { ec: 24, blocks: [97, 97] },
  9: { ec: 30, blocks: [116, 116] },
  10: { ec: 18, blocks: [68, 68, 69, 69] },
};
const QR_ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const res = new Array<number>(degree).fill(0);
  res[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < res.length; j++) {
      res[j] = gfMul(res[j], root);
      if (j + 1 < res.length) res[j] ^= res[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return res;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const res = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (res.shift() as number);
    res.push(0);
    divisor.forEach((coef, i) => (res[i] ^= gfMul(coef, factor)));
  }
  return res;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = QR_L[v].blocks.reduce((a, b) => a + b, 0);
    if (4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= cap * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('Text too long for a QR code');
  const { ec, blocks } = QR_L[version];
  const dataCap = blocks.reduce((a, b) => a + b, 0);

  const bits: number[] = [];
  const push = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);

  const div = rsDivisor(ec);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let k = 0;
  for (const len of blocks) {
    const blk = data.slice(k, k + len);
    k += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, div));
  }
  const words: number[] = [];
  const maxLen = Math.max(...blocks);
  for (let i = 0; i < maxLen; i++) for (const b of dataBlocks) if (i < b.length) words.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) words.push(b[i]);

  const size = version * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mods[y][x] = dark;
    isFn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const al = QR_ALIGN[version];
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = (mask: number) => {
    const d = (1 << 3) | mask; // level L = 01
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && bi < words.length * 8) {
          mods[y][x] = ((words[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1;
          bi++;
        }
      }
    }
  }
  const maskFn = (m: number, x: number, y: number): boolean => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn(m, x, y)) mods[y][x] = !mods[y][x];
  };
  const penalty = (): number => {
    let p = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      const seq: number[] = [];
      for (let i = 0; i < size; i++) {
        seq.push(get(i) ? 1 : 0);
        if (i > 0) {
          if (get(i) === get(i - 1)) run++;
          else {
            if (run >= 5) p += 3 + run - 5;
            run = 1;
          }
        }
      }
      if (run >= 5) p += 3 + run - 5;
      const s = seq.join('');
      for (const pat of ['10111010000', '00001011101']) {
        let idx = s.indexOf(pat);
        while (idx >= 0) {
          p += 40;
          idx = s.indexOf(pat, idx + 1);
        }
      }
    };
    for (let y = 0; y < size; y++) line((i) => mods[y][i]);
    for (let x = 0; x < size; x++) line((i) => mods[i][x]);
    let dark = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (mods[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          const c = mods[y][x];
          if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) p += 3;
        }
      }
    const total = size * size;
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return p;
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = penalty();
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
    applyMask(m);
  }
  applyMask(best);
  drawFormat(best);
  return mods;
}

export function qrSvg(text: string): string {
  const m = qrMatrix(text);
  const n = m.length, q = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><path fill="#0b0b0d" d="${d}"/></svg>`;
}

// ---------------------------------------------------------------------------------------------
// On your phone or headset. Opened at a local or private address (this laptop, or a Wi-Fi address), the panel
// gives the address phones and the headset can reach (from the server's health) with the Wi-Fi and certificate
// words. Opened anywhere else, at a public link, it gives that link and nothing about Wi-Fi.

let health: HealthInfo | undefined;

/** A local or private address: this laptop, 10.x, 172.16-31.x or 192.168.x. */
export function isLanHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const onLan = typeof location !== 'undefined' && isLanHost(location.hostname);
/** The phone layout: no QR code (this is the phone), and the phone's own controls first. */
const phoneScreen = typeof matchMedia === 'function' ? matchMedia('(max-width: 734px)') : null;

function setHealth(h: HealthInfo | undefined) {
  health = h;
  renderLan();
}

function currentLanUrl(): string | null {
  if (!onLan) return location.origin;
  const urls = health ? lanUrls(health) : [];
  if (urls.length) return urls[0];
  if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return location.origin;
  return null;
}

let lastQr = '';
function renderLan() {
  const url = currentLanUrl();
  const title = $('#lan-title');
  const link = $<HTMLAnchorElement>('#lan-url');
  const note = $('#lan-note');
  const qr = $('#qr');
  const cap = $<HTMLAnchorElement>('#lan-capture');
  if (!link || !note || !qr) return;
  const phone = !!phoneScreen?.matches;
  if (title) title.textContent = onLan ? 'Same Wi-Fi? Open this.' : 'Open this link.';
  if (!url) {
    link.textContent = health ? 'No Wi-Fi address found' : 'Finding this laptop…';
    link.removeAttribute('href');
    note.textContent = health ? 'Connect the laptop to Wi-Fi, then reload. Phones and the headset must be on the same network.' : '';
    qr.innerHTML = '';
    lastQr = '';
    return;
  }
  link.textContent = url.replace(/^https?:\/\//, '');
  link.href = url;
  if (cap) cap.href = url + '/capture';
  if (url !== lastQr) {
    try {
      qr.innerHTML = qrSvg(url);
      lastQr = url;
    } catch {
      qr.innerHTML = '';
    }
  }
  const where = phone ? 'Type it into the headset browser.' : 'Scan it with your phone camera or type it into the headset browser.';
  if (!onLan) note.textContent = phone ? 'Type it into the headset browser to walk in with VR.' : where;
  else
    note.textContent = `${where} ${
      health?.https || url.startsWith('https:') ? 'Accept the certificate warning once per device.' : 'VR in the headset needs HTTPS: start the server with bun run https.'
    }`;
}

/** On a phone its own controls come first; the laptop's and the headset's fold away under one line. */
function layoutControls() {
  const box = $('#controls');
  if (!box) return;
  const part = (k: string) => box.querySelector<HTMLElement>(`[data-ctl="${k}"]`);
  const laptop = part('laptop'), phone = part('phone'), vr = part('vr');
  if (!laptop || !phone || !vr) return;
  let more = box.querySelector<HTMLDetailsElement>('.ctl-more');
  if (phoneScreen?.matches) {
    if (!more) {
      more = document.createElement('details');
      more.className = 'ctl-more';
      const summary = document.createElement('summary');
      summary.textContent = 'Laptop and VR headset';
      more.appendChild(summary);
    }
    more.append(laptop, vr);
    box.append(phone, more);
  } else {
    box.append(laptop, phone, vr);
    more?.remove();
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Sign-in: when the server has it on, the page says so beside the ways in to making one.

const SIGN_IN_NOTE = 'Sign in to make your own. Anyone can walk in.';
let signInOn = false;

function showSignInNotes() {
  signInOn = true;
  const chips = $('#hero-chips');
  if (chips && !chips.querySelector('.hero-signin')) {
    const p = document.createElement('p');
    p.className = 'hero-signin';
    p.textContent = SIGN_IN_NOTE;
    chips.prepend(p);
  }
  const lan = $('#lan-signin');
  if (lan) {
    lan.textContent = SIGN_IN_NOTE;
    lan.hidden = false;
  }
  if ($('#grid .wl-empty')) renderGrid();
}

// ---------------------------------------------------------------------------------------------
// All worlds: a fixed list of our worlds, each with one true line on how it was made (styles in worlds-list.css).
// The server only says which of them are ready: a world shows once it is, and leaves if it stops being. No status,
// no times, nothing to delete. Above it, the worlds this visitor just made (?new=<id> from the capture page, kept for
// the tab) show how far along they are.

type Kind = 'photo' | 'video';

interface Curated {
  id: string;
  name: string;
  kind: Kind;
  /** How it was made, in one line that fits a laptop row. */
  line: string;
}

const TILTED_CREDIT = 'Tilted Towers Tour | Fortnite OG S2 by woodinjake';

/** The worlds the landing lists, in this order. */
const CURATED: readonly Curated[] = [
  { id: 'the-courts', name: 'Infinity Hall Game Lawn', kind: 'photo', line: 'From 25 photos and two phone clips: table tennis, foosball and the lawn.' },
  { id: 'chess-room', name: 'Giant chess', kind: 'photo', line: 'From stills of four phone clips, frozen just after a knight move.' },
  { id: 'kitchen', name: 'Kitchen', kind: 'photo', line: 'From 36 photos and a cooking clip: the stoves, the sink and the bar tables.' },
  { id: 'old-house-kitchen', name: 'The old house kitchen', kind: 'photo', line: 'From four photos of its old real-estate listing, a home in Pennsylvania.' },
  { id: 'tilted-towers', name: 'Tilted Towers', kind: 'photo', line: `From stills of ${TILTED_CREDIT}.` },
  { id: 'brick-apartment', name: 'Brick House apartment', kind: 'photo', line: `From 71 frames of ${TILTED_CREDIT}.` },
  { id: 'alzheimers-memory', name: "Alzheimer's memory", kind: 'video', line: 'From one phone video: a grandfather and his grandchild by the fire, two moments in one memory.' },
  { id: 'courts-foosball', name: 'Foosball at the Game Lawn', kind: 'video', line: 'From one phone video: two friends at the foosball table.' },
  { id: 'kitchen-cooking', name: 'Sebastian cooking', kind: 'video', line: 'From one phone video: Seb at the counters, the stove and the sink.' },
  { id: 'chess-match', name: 'Giant chess match', kind: 'video', line: 'From one phone video: two friends playing on the giant board.' },
];
const curatedIds = new Set(CURATED.map((c) => c.id));

const STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting its turn',
  uploading: 'Uploading',
  running: 'Being made',
  downloading: 'Almost there',
  ready: 'Ready',
  failed: 'Failed',
};
const ACTIVE = new Set(['queued', 'uploading', 'running', 'downloading']);

const scenes = new Map<string, Scene>();
let filter: 'all' | Kind = 'all';
let loaded = false;
/** The last list request failed; with no worlds known the list keeps its loading rows. */
let loadFailed = false;
const SKELETONS = '<div class="skeleton"></div>'.repeat(3);
/** Thumbnails that did not load: those rows keep a plain tile rather than a broken picture. */
const brokenThumbs = new Set<string>();

/** The Step inside row, once mounted. */
let rowRefresh: (() => void) | null = null;
let rowTimer: ReturnType<typeof setTimeout> | undefined;
/** A world arrived, became ready or left: the row looks again about a second later, once per burst. */
function rowChanged() {
  if (!rowRefresh) return;
  clearTimeout(rowTimer);
  rowTimer = setTimeout(() => {
    try {
      rowRefresh?.();
    } catch {}
  }, 1000);
}
/** Which worlds exist, which are ready and what they are called, to tell when a fresh list changed anything the row shows. */
function rowKey(): string {
  return [...scenes.values()]
    .map((s) => `${s.id}:${s.status === 'ready' ? 1 : 0}:${s.name ?? ''}:${s.thumb ?? ''}`)
    .sort()
    .join(',');
}

// ---- the visitor's own worlds, for this tab

const MINE_KEY = 'dv.mine';
let mine: string[] = [];
let highlightId: string | null = null;

function readMine(): string[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(MINE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function writeMine() {
  try {
    sessionStorage.setItem(MINE_KEY, JSON.stringify(mine));
  } catch {}
}

/** ?new=<id> from the capture page: kept for this tab, then taken out of the address. */
function takeNew() {
  mine = readMine();
  const url = new URL(location.href);
  const id = url.searchParams.get('new');
  if (!id) return;
  highlightId = id;
  if (!curatedIds.has(id)) {
    mine = [id, ...mine.filter((x) => x !== id)].slice(0, 6);
    writeMine();
  }
  url.searchParams.delete('new');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

// ---- rows

/** The Game Lawn's old working name never reaches the page. */
function lawnName(text: string): string {
  return text.replace(/\bthe courts\b/gi, (m) => `${m[0] === 'T' ? 'The' : 'the'} Infinity Hall Game Lawn`);
}

function displayName(s: Scene): string {
  const name = (s.name ?? '').trim();
  if (/^the courts\.?$/i.test(name)) return 'Infinity Hall Game Lawn';
  return lawnName(name) || 'Untitled';
}

/** The scene's thumbnail, else its first uploaded photo; null when there is neither. */
function thumbUrl(s: Scene | undefined): string | null {
  if (!s) return null;
  let url: string | null = null;
  if (s.thumb) url = sceneAssetUrl(s.id, s.thumb);
  else {
    const first = s.input?.files?.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
    if (first) url = sceneAssetUrl(s.id, first.includes('/') ? first : `input/${first}`);
  }
  return url && !brokenThumbs.has(url) ? url : null;
}

/** 0 to 100 when the server knows; null while it cannot tell, or while queued with nothing done. */
function percent(s: Scene): number | null {
  if (typeof s.progress !== 'number' || !Number.isFinite(s.progress)) return null;
  if (s.status === 'queued' && s.progress <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(s.progress * 100)));
}

const ICON_GO =
  '<svg class="wl-go" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true"><path d="M1.5 1.5 6.5 7l-5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

interface RowData {
  id: string;
  name: string;
  kind: Kind;
  line: string;
  state: 'ready' | 'active' | 'failed';
  /** 0..100 while being made, when known. */
  pct?: number | null;
}

function setText(root: ParentNode, sel: string, text: string) {
  const el = root.querySelector<HTMLElement>(sel);
  if (el && el.textContent !== text) el.textContent = text;
}

/** innerHTML, skipped when unchanged so focus and hover survive live updates. */
const htmlCache = new WeakMap<Element, string>();
function setHtml(el: Element | null, html: string) {
  if (!el || htmlCache.get(el) === html) return;
  htmlCache.set(el, html);
  el.innerHTML = html;
}

/** No picture keeps the slot as a plain tile, so names and hairlines line up with the rest. */
function setThumb(el: HTMLElement, url: string | null) {
  const box = el.querySelector<HTMLElement>('.wl-thumb')!;
  const img = box.querySelector('img')!;
  el.classList.toggle('no-thumb', !url);
  img.hidden = !url;
  if (!url) {
    delete box.dataset.src;
    img.removeAttribute('src');
  } else if (box.dataset.src !== url) {
    box.dataset.src = url;
    img.src = url;
  }
}

function makeRow(id: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'world-row';
  el.setAttribute('role', 'listitem');
  el.dataset.id = id;
  el.innerHTML = `<div class="wl-thumb" aria-hidden="true"><img alt="" decoding="async" loading="lazy" width="44" height="44" hidden /></div>
    <div class="wl-main"><p class="wl-head"><span class="wl-name"></span><span class="wl-chip"></span></p><p class="wl-line"></p><span class="wl-bar" aria-hidden="true" hidden><i></i></span></div>
    <div class="wl-actions"></div>`;
  el.querySelector('img')!.addEventListener('error', () => {
    // Missing or not written yet: no picture rather than a broken one.
    const src = el.querySelector<HTMLElement>('.wl-thumb')?.dataset.src;
    if (src) brokenThumbs.add(src);
    setThumb(el, null);
  });
  return el;
}

function fillRow(el: HTMLElement, d: RowData, thumb: string | null) {
  el.dataset.mode = d.kind;
  el.dataset.state = d.state;
  el.classList.toggle('is-ready', d.state === 'ready');
  setThumb(el, thumb);
  setText(el, '.wl-name', d.name);
  setText(el, '.wl-chip', MODE_NAME[d.kind]);
  setText(el, '.wl-line', d.line);
  const bar = el.querySelector<HTMLElement>('.wl-bar')!;
  bar.hidden = d.state !== 'active';
  bar.classList.toggle('indeterminate', d.state === 'active' && d.pct == null);
  bar.querySelector('i')!.style.transform = `scaleX(${d.pct == null ? 0 : Math.max(0.02, d.pct / 100)})`;
  const name = esc(d.name);
  setHtml(
    el.querySelector('.wl-actions'),
    d.state === 'ready'
      ? `<a class="wl-walk" href="${esc(viewUrl(d.id))}"><span class="wl-walk-text">Walk in</span>${ICON_GO}<span class="wl-sr">: ${name}</span></a>`
      : d.state === 'failed'
        ? `<a class="wl-again" href="/capture">Try again<span class="wl-sr">: make ${name} again</span></a>`
        : '',
  );
}

/** Puts `rows` into `box` in order, reusing the rows already there. */
function placeRows(box: HTMLElement, rows: { id: string; data: RowData; thumb: string | null }[]) {
  const existing = new Map<string, HTMLElement>();
  for (const el of box.querySelectorAll<HTMLElement>('.world-row')) if (el.dataset.id) existing.set(el.dataset.id, el);
  for (const el of box.querySelectorAll('.skeleton, .wl-empty')) el.remove();
  let prev: Element | null = null;
  for (const r of rows) {
    let el = existing.get(r.id);
    if (el) existing.delete(r.id);
    else el = makeRow(r.id);
    fillRow(el, r.data, r.thumb);
    const anchor: ChildNode | null = prev ? prev.nextSibling : box.firstChild;
    if (el !== anchor) box.insertBefore(el, anchor);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

// ---- the list and its filter

function shownWorlds(): Curated[] {
  return CURATED.filter((c) => scenes.get(c.id)?.status === 'ready');
}

function renderFilters(list: Curated[]) {
  const bar = $('#filters');
  if (!bar) return;
  const photo = list.filter((c) => c.kind === 'photo').length;
  const video = list.length - photo;
  // A filter only earns its place once the list holds both Photo and Video worlds.
  const show = photo > 0 && video > 0;
  bar.hidden = !show;
  if (!show) {
    filter = 'all';
    setHtml(bar, '');
    return;
  }
  const opts: ['all' | Kind, string, number][] = [
    ['all', 'All', list.length],
    ['photo', 'Photo', photo],
    ['video', 'Video', video],
  ];
  setHtml(
    bar,
    opts
      .map(([k, label, n]) => `<button class="filter" type="button" data-filter="${k}" aria-pressed="${filter === k}">${label}<span class="n">${n}</span></button>`)
      .join(''),
  );
}

function emptyHtml(): string {
  return `<div class="wl-empty"><p class="wl-empty-title">No worlds to show right now.</p><p>Try again in a moment, or make your own.</p><a class="btn btn-primary" href="/capture">Make your own</a>${
    signInOn ? `<p class="signin-note">${SIGN_IN_NOTE}</p>` : ''
  }</div>`;
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const list = shownWorlds();
  renderFilters(list);
  const visible = list.filter((c) => filter === 'all' || c.kind === filter);
  if (!visible.length) {
    if (!loaded || (loadFailed && !scenes.size)) {
      // still loading, or the list could not load: the loading rows stay (under the banner)
      if (!grid.querySelector('.skeleton')) {
        grid.removeAttribute('role');
        grid.innerHTML = SKELETONS;
      }
    } else {
      grid.removeAttribute('role');
      setHtml(grid, emptyHtml());
    }
    return;
  }
  htmlCache.delete(grid);
  grid.setAttribute('role', 'list');
  placeRows(
    grid,
    visible.map((c) => ({ id: c.id, data: { id: c.id, name: c.name, kind: c.kind, line: c.line, state: 'ready' }, thumb: thumbUrl(scenes.get(c.id)) })),
  );
}

function mineRow(s: Scene): RowData {
  const kind: Kind = modeKind(s.mode) === 'video' ? 'video' : 'photo';
  const base = { id: s.id, name: displayName(s), kind };
  if (s.status === 'ready') return { ...base, line: 'Ready to walk in.', state: 'ready' };
  if (s.status === 'failed') return { ...base, line: 'This one didn’t make it.', state: 'failed' };
  const pct = percent(s);
  const stage = (s.status === 'running' && s.stage?.trim()) || STATUS_LABEL[s.status] || STATUS_LABEL.running!;
  return { ...base, line: pct !== null ? `${stage} · ${pct}%` : stage, state: 'active', pct };
}

function renderMine() {
  const box = $('#mine');
  const list = $('#mine-list');
  if (!box || !list) return;
  const items = mine.map((id) => scenes.get(id)).filter((s): s is Scene => !!s);
  box.hidden = !items.length;
  placeRows(list, items.map((s) => ({ id: s.id, data: mineRow(s), thumb: thumbUrl(s) })));
  applyHighlight();
}

function applyHighlight() {
  if (!highlightId) return;
  const el = $(`#gallery .world-row[data-id="${CSS.escape(highlightId)}"]`);
  if (!el) return;
  el.classList.add('is-new');
  setTimeout(() => el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' }), 120);
  highlightId = null;
}

function upsert(s: Scene) {
  if (!s || typeof s.id !== 'string' || s.unlisted) return; // a test build: never in the list of worlds
  const prev = scenes.get(s.id);
  scenes.set(s.id, s);
  if (!prev || (s.status === 'ready') !== (prev.status === 'ready') || s.name !== prev.name || s.caption !== prev.caption || s.thumb !== prev.thumb) rowChanged();
  if (curatedIds.has(s.id)) renderGrid();
  if (mine.includes(s.id)) renderMine();
}

function removeScene(id: string) {
  if (scenes.delete(id)) rowChanged();
  if (mine.includes(id)) {
    mine = mine.filter((x) => x !== id);
    writeMine();
    renderMine();
  }
  if (curatedIds.has(id)) renderGrid();
}

async function refreshScenes() {
  const banner = $('#gallery-error');
  try {
    const list = await listScenes();
    // After the first load, a fresh list (reconnect, or polling while the socket is down) can carry
    // changes no live event announced.
    const before = loaded ? rowKey() : null;
    const seen = new Set(list.map((s) => s.id));
    for (const id of [...scenes.keys()]) if (!seen.has(id)) scenes.delete(id);
    for (const s of list) scenes.set(s.id, s);
    if (before !== null && before !== rowKey()) rowChanged();
    // worlds this tab made that the server no longer has are forgotten
    if (mine.some((id) => !seen.has(id))) {
      mine = mine.filter((id) => seen.has(id));
      writeMine();
    }
    loaded = true;
    loadFailed = false;
    banner?.classList.remove('show');
    renderGrid();
    renderMine();
  } catch (err) {
    loaded = true;
    loadFailed = true;
    if (banner) {
      const why = err instanceof ApiError || err instanceof Error ? errorText(err.message).headline : '';
      banner.textContent = `Can’t load the worlds right now.${why ? ` ${why}` : ''} Trying again…`;
      banner.classList.add('show');
    }
    if (!scenes.size) renderGrid();
  }
}

async function refreshHealth() {
  try {
    setHealth(await getHealth());
  } catch {
    setHealth(undefined);
  }
}

function main() {
  if ($('#intro-stage')) new Intro();
  // the how-it-works chapters load their 3D only as they come near the screen
  if ($('[data-chapter]')) void import('./story.ts').then((m) => m.startStory());
  // the hero's chips and the best worlds, each playing a flight through it
  const row = $('#worlds-row');
  const chips = $('#hero-chips');
  if (row || chips)
    void import('./worlds-row.ts')
      .then((m) => {
        if (chips) {
          try {
            m.mountHeroChips(chips);
          } catch {}
        }
        if (!row) return;
        const api = m.mountWorldsRow(row);
        rowRefresh = () => api.refresh();
      })
      .catch(() => row?.closest('section')?.setAttribute('hidden', ''));

  void authConfig().then((cfg) => {
    if (cfg.enabled) showSignInNotes();
  });

  takeNew();
  layoutControls();
  renderLan();
  phoneScreen?.addEventListener?.('change', () => {
    layoutControls();
    renderLan();
  });

  $('#filters')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter as 'all' | Kind;
    renderGrid();
  });
  $('#lan-copy')?.addEventListener('click', async () => {
    const url = currentLanUrl();
    if (!url) return toast('No network address yet');
    toast((await copyText(url)) ? 'Link copied' : url);
  });

  const events = new LiveEvents();
  let opened = false;
  events.onState((s) => {
    if (s === 'open') {
      // After a reconnect, events may have been missed.
      if (opened) void refreshScenes();
      opened = true;
    }
  });
  events.on('scene', (ev) => upsert(ev.scene));
  events.on('scene_deleted', (ev) => removeScene(ev.id));
  events.on('health', (ev) => setHealth(ev.health));
  events.start();

  void refreshScenes();
  void refreshHealth();

  // Polling fallback while the socket is down, and a slow health refresh regardless.
  setInterval(() => {
    if (events.state !== 'open') void refreshScenes();
  }, 4000);
  setInterval(() => void refreshHealth(), 20000);
}

// The capture page imports qrSvg from here; only the landing page has a gallery grid.
if (typeof document !== 'undefined' && document.getElementById('grid')) main();
