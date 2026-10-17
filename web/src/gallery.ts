// Landing page: the group-chat hero, the live gallery, and the same-Wi-Fi panel.

import {
  ApiError,
  LiveEvents,
  MODE_NAME,
  deleteScene,
  errorText,
  getHealth,
  lanUrls,
  listScenes,
  modeKind,
  retryScene,
  sceneAssetUrl,
  sceneErrorDetails,
  viewUrl,
  type HealthInfo,
  type Scene,
} from './api.ts';

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
// Cover for scenes without a thumbnail yet: a soft gradient with a photo or video glyph.

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const COVER_TINTS: [string, string][] = [
  ['#e8eef7', '#d5deeb'],
  ['#eef0f4', '#dcdfe6'],
  ['#e9f1f0', '#d3e1df'],
  ['#f2eef4', '#e0d9e6'],
];

const thumbCache = new Map<string, string>();
function placeholderThumb(scene: { id: string; mode?: string }): string {
  const key = `${scene.id}|${scene.mode ?? ''}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const [a, b] = COVER_TINTS[hashString(scene.id) % COVER_TINTS.length];
  const glyph =
    modeKind(scene.mode) === 'video'
      ? '<rect x="292" y="178" width="40" height="44" rx="8"/><path d="M332 193l20-12v38l-20-12z"/>'
      : '<rect x="290" y="176" width="60" height="48" rx="8"/><circle cx="306" cy="192" r="5"/><path d="M290 214l18-16 14 12 10-8 18 14"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><g fill="none" stroke="#8e8e93" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" opacity=".7">${glyph}</g></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  thumbCache.set(key, url);
  return url;
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
// Same-Wi-Fi panel (the server's health says which addresses phones and the headset can reach)

let health: HealthInfo | undefined;

function setHealth(h: HealthInfo | undefined) {
  health = h;
  renderLan();
}

function currentLanUrl(): string | null {
  const urls = health ? lanUrls(health) : [];
  if (urls.length) return urls[0];
  if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return location.origin;
  return null;
}

let lastQr = '';
function renderLan() {
  const url = currentLanUrl();
  const link = $<HTMLAnchorElement>('#lan-url');
  const note = $('#lan-note');
  const qr = $('#qr');
  const cap = $<HTMLAnchorElement>('#lan-capture');
  if (!link || !note || !qr) return;
  if (!url) {
    link.textContent = health ? 'No Wi-Fi address found' : 'Finding this laptop…';
    link.removeAttribute('href');
    note.textContent = health ? 'Connect the laptop to Wi-Fi, then reload. Phones and the headset must be on the same network.' : '';
    qr.innerHTML = '';
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
  note.textContent = health?.https || url.startsWith('https:')
    ? 'Scan it with your phone camera or type it into the headset browser. Accept the certificate warning once per device.'
    : 'Scan it with your phone camera or type it into the headset browser. VR in the headset needs HTTPS: start the server with bun run https.';
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
// Gallery

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  running: 'Running',
  downloading: 'Downloading',
  ready: 'Ready',
  failed: 'Failed',
};
const BACKEND_LABEL: Record<string, string> = {
  'hpg-worker': 'warm GPU',
  'hpg-batch': 'GPU cluster',
  'hf-space': 'cloud GPU',
  local: 'this laptop',
  bundled: 'built in',
};
const ACTIVE = new Set(['queued', 'uploading', 'running', 'downloading']);

const scenes = new Map<string, Scene>();
let filter = 'all';
let loaded = false;
let highlightId: string | null = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('new') : null;
const confirming = new Map<string, ReturnType<typeof setTimeout>>();

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;
function ago(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = (t - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (!rtf) return new Date(t).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

function ordered(): Scene[] {
  return [...scenes.values()].sort((a, b) => {
    const sa = a.mode === 'sample' ? 1 : 0, sb = b.mode === 'sample' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

function matches(s: Scene): boolean {
  if (filter === 'all') return true;
  return modeKind(s.mode) === filter;
}

/** The scene's thumbnail, else its first uploaded photo, else a generated cover. */
function thumbUrl(s: Scene): string {
  if (s.thumb) return sceneAssetUrl(s.id, s.thumb);
  const first = s.input?.files?.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (first) return sceneAssetUrl(s.id, first.includes('/') ? first : `input/${first}`);
  return placeholderThumb(s);
}

const ICON_TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

function metaLine(s: Scene): string {
  const clip = s.video && Number.isFinite(s.video.duration) ? `${Math.round(s.video.duration)} s${s.video.hasAudio ? ' with sound' : ''}` : '';
  return [ago(s.createdAt), clip, s.backend ? BACKEND_LABEL[s.backend] ?? s.backend : ''].filter(Boolean).join(' · ');
}

/** The server's stage line, else the status. */
function stageText(s: Scene): string {
  return s.stage?.trim() || STATUS_LABEL[s.status] || s.status;
}

/** What the scene was made from, for cards whose job has not finished. */
function sourceLine(s: Scene): string {
  const files = s.input?.files ?? [];
  if (modeKind(s.mode) === 'video') return 'From one video';
  if (files.length > 1) return `From ${files.length} photos`;
  if (files.some((f) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f))) return 'From one clip';
  if (files.length) return 'From one photo';
  return s.input?.prompt ? 'From a description' : 'From one photo';
}

function subline(s: Scene): string {
  // Prompts are the person's own words and captions come from the server; both are shown as written.
  const kind = modeKind(s.mode);
  const caption = s.caption?.trim() ?? '';
  const prompt = s.input?.prompt?.trim();
  if (s.status === 'failed') return s.stage && s.stage !== 'Failed' ? `Stopped at: ${stageText(s)}` : 'This one did not make it.';
  // The stage line under it already says what is happening; this says what it is being made from.
  if (ACTIVE.has(s.status)) return prompt ? `“${prompt}”` : caption && caption !== stageText(s) ? caption : sourceLine(s);
  if (caption) return caption;
  if (prompt) return `“${prompt}”`;
  return kind === 'video' ? 'The room, with the real footage in 3D' : kind === 'sample' ? 'A world to try first' : 'A world you can walk into';
}

/** The failure reason, with technical details folded into a collapsed block. */
function errorBox(s: Scene): string {
  const { headline, detail } = errorText(s.error || 'This one stopped without a reason. Retry it, or make it again.', sceneErrorDetails(s));
  return `<div class="error-box"><span>${esc(headline)}</span>${detail ? `<details><summary>Details</summary><pre>${esc(detail)}</pre></details>` : ''}</div>`;
}

function cardBody(s: Scene): string {
  const active = ACTIVE.has(s.status);
  const pct = typeof s.progress === 'number' ? Math.round(s.progress * 100) : null;
  const meta = metaLine(s);
  const isConfirm = confirming.has(s.id);
  return `
    <h3 class="card-title">${esc(s.name || 'Untitled')}</h3>
    <p class="card-sub">${esc(subline(s))}</p>
    ${
      active
        ? `<div class="stage-line"><b class="stage">${esc(stageText(s))}</b><span class="pct">${pct !== null ? pct + '%' : ''}</span></div>
           <div class="progress${pct === null ? ' indeterminate' : ''}"><div class="progress-fill" style="transform:scaleX(${pct !== null ? Math.max(0.02, pct / 100) : 0.3})"></div></div>`
        : ''
    }
    ${s.status === 'failed' ? errorBox(s) : ''}
    <div class="card-foot">
      <span class="meta" title="${esc(s.createdAt)}">${esc(meta)}</span>
      ${s.status === 'failed' ? `<button class="btn btn-xs" data-act="retry" type="button">Retry</button>` : ''}
      ${
        s.mode === 'sample'
          ? ''
          : `<button class="icon-btn del${isConfirm ? ' confirm' : ''}" data-act="delete" type="button" aria-label="Delete ${esc(s.name)}">${isConfirm ? 'Delete?' : ICON_TRASH}</button>`
      }
      <a class="btn ${s.status === 'ready' ? 'btn-primary' : ''} btn-xs" data-act="enter" href="${esc(viewUrl(s.id))}"${
        s.status === 'ready' ? '' : ' aria-disabled="true" tabindex="-1"'
      }>Walk in</a>
    </div>`;
}

function badges(s: Scene): string {
  const active = ACTIVE.has(s.status);
  const kind = modeKind(s.mode);
  return `<span class="badge mode-${kind}">${MODE_NAME[kind]}</span>
    <span class="badge status-${esc(s.status)}">${esc(active ? 'Building' : STATUS_LABEL[s.status] ?? s.status)}</span>`;
}

function makeCard(s: Scene): HTMLElement {
  const el = document.createElement('article');
  el.className = 'scene-card';
  el.innerHTML = `<div class="thumb"><img alt="" decoding="async" /><div class="thumb-badges"></div></div><div class="card-body"></div>`;
  const img = el.querySelector('img')!;
  img.addEventListener('error', () => {
    // Missing or not yet written: fall back to the generated cover.
    const s2 = scenes.get(el.dataset.id ?? '') ?? s;
    const fallback = placeholderThumb(s2);
    if (img.src !== fallback) img.src = fallback;
  });
  fillCard(el, s, true);
  return el;
}

function fillCard(el: HTMLElement, s: Scene, fresh = false) {
  const prevStatus = el.dataset.status;
  el.dataset.id = s.id;
  el.dataset.status = s.status;
  el.dataset.mode = s.mode;
  const thumb = $('.thumb', el)!;
  const url = thumbUrl(s);
  if (thumb.dataset.src !== url) {
    thumb.dataset.src = url;
    thumb.querySelector('img')!.src = url;
  }
  $('.thumb-badges', el)!.innerHTML = badges(s);
  const body = $('.card-body', el)!;
  // Progress-only changes update in place so the bar animates instead of jumping.
  if (!fresh && prevStatus === s.status && ACTIVE.has(s.status) && $('.progress', body) && !confirming.has(s.id)) {
    const pct = typeof s.progress === 'number' ? Math.round(s.progress * 100) : null;
    const fill = $('.progress-fill', body)!;
    $('.progress', body)!.classList.toggle('indeterminate', pct === null);
    fill.style.transform = `scaleX(${pct !== null ? Math.max(0.02, pct / 100) : 0.3})`;
    $('.stage', body)!.textContent = stageText(s);
    $('.pct', body)!.textContent = pct !== null ? `${pct}%` : '';
    $('.card-sub', body)!.textContent = subline(s);
    $('.card-title', body)!.textContent = s.name || 'Untitled';
    return;
  }
  body.innerHTML = cardBody(s);
}

function renderFilters() {
  const bar = $('#filters');
  if (!bar) return;
  const all = [...scenes.values()];
  const count = (k: string) => all.filter((s) => modeKind(s.mode) === k).length;
  const opts: [string, string, number][] = [
    ['all', 'All', all.length],
    ['photo', 'Photo', count('photo')],
    ['video', 'Video', count('video')],
  ];
  if (count('sample')) opts.push(['sample', 'Samples', count('sample')]);
  bar.innerHTML = opts
    .map(([k, label, n]) => `<button class="filter" type="button" data-filter="${k}" aria-pressed="${filter === k}">${label}<span class="n">${n}</span></button>`)
    .join('');
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  renderThread();
  renderFilters();
  const list = ordered().filter(matches);
  if (!list.length) {
    grid.innerHTML = loaded
      ? `<div class="empty"><h3>${scenes.size ? 'Nothing here in this filter.' : 'Nothing here yet.'}</h3><p>${
          scenes.size ? 'Try another filter, or make something new.' : 'Your first world is one photo away.'
        }</p><a class="btn btn-primary" href="/capture">Make a world</a></div>`
      : grid.innerHTML;
    return;
  }
  const existing = new Map<string, HTMLElement>();
  for (const el of grid.querySelectorAll<HTMLElement>('.scene-card')) if (el.dataset.id) existing.set(el.dataset.id, el);
  for (const el of grid.querySelectorAll('.skeleton, .empty')) el.remove();
  let prev: Element | null = null;
  for (const s of list) {
    let el = existing.get(s.id);
    if (el) {
      existing.delete(s.id);
      fillCard(el, s);
    } else el = makeCard(s);
    const anchor: ChildNode | null = prev ? prev.nextSibling : grid.firstChild;
    if (el !== anchor) grid.insertBefore(el, anchor);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  applyHighlight();
}

function upsert(s: Scene) {
  if (!s || typeof s.id !== 'string') return;
  const had = scenes.has(s.id);
  scenes.set(s.id, s);
  if (!had) {
    renderGrid();
    return;
  }
  const el = $(`.scene-card[data-id="${CSS.escape(s.id)}"]`);
  if (el && matches(s)) fillCard(el, s);
  else renderGrid();
  if (s.status === 'ready') renderThread();
}

function removeScene(id: string) {
  scenes.delete(id);
  const el = $(`.scene-card[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.add('leaving');
    setTimeout(() => {
      el.remove();
      if (!scenes.size || ![...scenes.values()].some(matches)) renderGrid();
      else renderFilters();
    }, 280);
  } else renderGrid();
}

function applyHighlight() {
  if (!highlightId) return;
  const el = $(`.scene-card[data-id="${CSS.escape(highlightId)}"]`);
  if (!el) return;
  el.classList.add('is-new');
  setTimeout(() => el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' }), 120);
  highlightId = null;
  const url = new URL(location.href);
  url.searchParams.delete('new');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

async function refreshScenes() {
  const banner = $('#gallery-error');
  try {
    const list = await listScenes();
    const seen = new Set(list.map((s) => s.id));
    for (const id of [...scenes.keys()]) if (!seen.has(id)) scenes.delete(id);
    for (const s of list) scenes.set(s.id, s);
    loaded = true;
    banner?.classList.remove('show');
    renderGrid();
  } catch (err) {
    loaded = true;
    if (banner) {
      const why = err instanceof ApiError || err instanceof Error ? errorText(err.message).headline : '';
      banner.textContent = `Can't load the gallery right now.${why ? ` ${why}` : ''} Trying again…`;
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

function onGridClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const card = target.closest<HTMLElement>('.scene-card');
  if (!card) return;
  const id = card.dataset.id!;
  const scene = scenes.get(id);
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act) {
    if (target.closest('.thumb') && scene?.status === 'ready') location.href = viewUrl(id);
    return;
  }
  if (act === 'retry') {
    e.preventDefault();
    const btn = target.closest<HTMLButtonElement>('button');
    if (btn) btn.disabled = true;
    retryScene(id)
      .then((s) => {
        if (s) upsert(s);
        toast('Trying that one again.');
      })
      .catch((err) => {
        toast(err instanceof ApiError ? errorText(err.message).headline : 'Could not retry. Try again in a moment.');
        if (btn) btn.disabled = false;
      });
  } else if (act === 'delete') {
    e.preventDefault();
    if (!confirming.has(id)) {
      confirming.set(
        id,
        setTimeout(() => {
          confirming.delete(id);
          const s = scenes.get(id);
          const el = $(`.scene-card[data-id="${CSS.escape(id)}"]`);
          if (s && el) fillCard(el, s, true);
        }, 3500),
      );
      if (scene) fillCard(card, scene, true);
      ($('.del', card) as HTMLButtonElement | null)?.focus();
      return;
    }
    clearTimeout(confirming.get(id));
    confirming.delete(id);
    deleteScene(id)
      .then(() => {
        removeScene(id);
        toast('Deleted. It never happened.');
      })
      .catch((err) => toast(err instanceof ApiError ? errorText(err.message).headline : 'Could not delete it. Try again in a moment.'));
  } else if (act === 'enter' && scene?.status !== 'ready') {
    e.preventDefault();
  }
}

// ---------------------------------------------------------------------------------------------
// Hero group chat: the link a friend pastes unfurls into the newest real world in the gallery.

/** The newest ready world with a thumbnail, preferring one somebody made over the bundled samples. */
function featured(): Scene | null {
  const ready = ordered().filter((s) => s.status === 'ready' && s.thumb);
  return ready.find((s) => s.mode !== 'sample') ?? ready[0] ?? null;
}

let threadId: string | null = null;
function renderThread() {
  const s = featured();
  if (!s || s.id === threadId) return;
  threadId = s.id;
  const img = $<HTMLImageElement>('#chat-link-img');
  if (img) img.src = sceneAssetUrl(s.id, s.thumb!);
  const title = $('#chat-link-title');
  if (title) title.textContent = s.name || 'Game night';
  $<HTMLAnchorElement>('#chat-link')?.setAttribute('href', viewUrl(s.id));
}

function main() {
  // The chat plays in once; without scripts it is simply there.
  $('#chat')?.classList.add('play');

  $('#grid')?.addEventListener('click', onGridClick);
  $('#filters')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter!;
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
  // Keep relative times fresh.
  setInterval(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.scene-card')) {
      const s = scenes.get(el.dataset.id ?? '');
      const meta = el.querySelector('.meta');
      if (s && meta) meta.textContent = metaLine(s);
    }
  }, 30000);
}

// The capture page imports qrSvg from here; only the landing page has a gallery grid.
if (typeof document !== 'undefined' && document.getElementById('grid')) main();
