// The host's remote for the demo (/host, team/contracts.md 11 and 13.4): what is up and what to do when it is not, the
// two headset cues, the worlds in demo order with "Open in headset", and a live feed of what happens in the room.
// Phone-first; the table laptop gets the same page in columns.
//
// Data: GET /api/host/status every 5 s (server/host.ts), plus /ws for scene progress, cues, notes and Roblox moments.
// Cues go to POST /api/host/cue with by:"host". When the server wants DV_KEY from this device, the page asks for it
// once and keeps it in localStorage.

import type { CheckName, HostCheck, HostScene, HostStatus } from '../../server/host.ts';
import { LiveEvents, modeKind, type HealthInfo, type Scene, type ServerEvent } from './api.ts';
import { authHeaders, mountSignIn } from './auth.ts';
import {
  describeEvent,
  isBuilding,
  parsePins,
  pin,
  PINS_KEY,
  progressText,
  pushFeed,
  readStored,
  SLOTS,
  slotOf,
  unpin,
  writeStored,
  type FeedItem,
  type Pins,
} from './host-model.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const KEY_KEY = 'dv.host.key';
const TOGGLES_KEY = 'dv.host.toggles';
const POLL_MS = 5000;

const TILE_NAMES: Record<CheckName, string> = {
  gpu: 'GPU worker',
  guide: 'Guide',
  deepspace: 'DeepSpace',
  tunnel: 'Public link',
  roblox: 'Roblox',
  people: 'People',
};
const TILE_ORDER: CheckName[] = ['gpu', 'guide', 'deepspace', 'tunnel', 'roblox', 'people'];

const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const ICON_X =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// ---------------------------------------------------------------------------------------------
// State

let status: HostStatus | null = null;
/** The last status call failed: the tiles show what they last knew, greyed, or "Can't check". */
let statusError: { status: number; message: string } | null = null;
const scenes = new Map<string, HostScene>();
let pins: Pins = parsePins(readStored(PINS_KEY));
let feed: FeedItem[] = [];
let key: string | null = readStored(KEY_KEY);
let lastHealth: HealthInfo | undefined;
/** Scene whose "pin as" chooser is open. */
let picking: string | null = null;
/** Scenes that just became ready (glow once). */
const fresh = new Set<string>();
/** Scenes whose load cue is on its way, and ones just sent. */
const sending = new Set<string>();
const sent = new Set<string>();
/** Worlds that became ready while this page watched, and when: they stay in the live build for a while. */
const justReady = new Map<string, number>();
const LIVE_KEEP_MS = 3 * 60_000;
const names = new Map<string, string>();
let toggles = readToggles();
let loaded = false;

function readToggles(): { reality: boolean; labels: boolean } {
  try {
    const v = JSON.parse(readStored(TOGGLES_KEY) ?? '{}');
    return { reality: v?.reality === true, labels: v?.labels !== false };
  } catch {
    return { reality: false, labels: true };
  }
}

// ---------------------------------------------------------------------------------------------
// Little helpers

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, bad = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
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

class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server wants a signed-in person (server/auth), not the event key. */
    readonly signIn = false,
  ) {
    super(message);
  }
}

/** fetch with the event key (when this device has one) and, for a cue, the sign-in; throws HostError with the server's sentence. */
async function hostFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(key ? { 'x-dejaview-key': key } : {}),
        ...(init.method && init.method !== 'GET' ? authHeaders() : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new HostError("Can't reach the server. Check that it is still running.", 0);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = typeof body?.error === 'string' && body.error.trim() ? body.error : `The server answered ${res.status}.`;
    throw new HostError(msg, res.status, res.status === 401 && body?.signIn === true);
  }
  return body as T;
}

function sceneName(id: string): string {
  return scenes.get(id)?.name ?? id;
}

function hostScene(s: Scene): HostScene {
  return {
    id: s.id,
    name: s.name || s.id,
    mode: modeKind(s.mode),
    status: s.status,
    ...(s.stage ? { stage: s.stage } : {}),
    ...(typeof s.progress === 'number' ? { progress: s.progress } : {}),
    ...(s.error ? { error: s.error } : {}),
    thumb: s.thumb ? `/data/scenes/${encodeURIComponent(s.id)}/${s.thumb.split('/').map(encodeURIComponent).join('/')}` : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Status tiles

function tileHtml(name: CheckName, c: HostCheck, fill = false): string {
  const red = c.state === 'bad' || c.state === 'warn';
  const tunnelUrl = name === 'tunnel' ? status?.tunnel.url : null;
  const cmd = c.command
    ? (c.where ? `<div class="h-where">Run ${esc(c.where)}:</div>` : '') +
      `<div class="h-cmd"><code>${esc(c.command)}</code><button class="h-btn h-btn-sm" type="button" data-copy="${esc(c.command)}" aria-label="Copy the command">${ICON_COPY}Copy</button></div>`
    : '';
  // the public link: its address is the detail line (tap to open), then copy and check
  const detail = c.detail
    ? tunnelUrl
      ? `<a class="h-tile-detail h-url" href="${esc(tunnelUrl)}" target="_blank" rel="noopener">${esc(c.detail)}</a>`
      : `<div class="h-tile-detail">${esc(c.detail)}</div>`
    : '';
  const link = tunnelUrl
    ? `<div class="h-link"><button class="h-btn h-btn-sm" type="button" data-copy="${esc(tunnelUrl)}" aria-label="Copy the public link">Copy</button>` +
      `<button class="h-btn h-btn-sm" type="button" data-check="1">Check</button></div>`
    : '';
  const fix = c.fix && c.state !== 'ok' ? `<div class="h-fix">${esc(c.fix)}</div>` : '';
  return (
    `<div class="h-tile ${c.state}${red ? ' wide' : ''}${fill ? ' fill' : ''}" data-k="${name}">` +
    `<div class="h-tile-top"><span class="h-tile-name">${TILE_NAMES[name]}</span><span class="h-dot ${c.state}${c.state === 'ok' && name === 'gpu' ? ' pulse' : ''}"></span></div>` +
    `<div class="h-tile-text">${esc(c.text)}</div>` +
    detail +
    link +
    fix +
    cmd +
    `</div>`
  );
}

/** The summary while the status call fails: short, like "3 to fix". */
function failedSummary(e: { status: number }): string {
  return e.status === 401 ? 'needs the key' : e.status === 0 ? 'server not answering' : "can't check";
}

function renderTiles() {
  const box = $('#tiles');
  const sum = $('#status-summary');
  if (!box || !sum) return;
  // what the tiles show may be old: grey them out until the server answers again
  box.classList.toggle('stale', !!status && !!statusError);
  if (statusError) {
    sum.className = 'h-summary bad';
    sum.textContent = failedSummary(statusError);
  }
  if (!status) {
    const c: HostCheck = statusError ? { state: 'off', text: "Can't check" } : { state: 'idle', text: 'Checking' };
    box.innerHTML = TILE_ORDER.map((k) => tileHtml(k, c)).join('');
    return;
  }
  // red tiles first, so the phone shows what needs doing without scrolling
  const rank = (k: CheckName) => ({ bad: 0, warn: 1, off: 2, idle: 3, ok: 4 })[status!.checks[k].state];
  const order = [...TILE_ORDER].sort((a, b) => rank(a) - rank(b) || TILE_ORDER.indexOf(a) - TILE_ORDER.indexOf(b));
  // two columns on a phone: an odd tile out stretches across instead of leaving a hole
  const narrow = order.filter((k) => !['bad', 'warn'].includes(status!.checks[k].state));
  const fill = narrow.length % 2 ? narrow[narrow.length - 1] : null;
  box.innerHTML = order.map((k) => tileHtml(k, status!.checks[k], k === fill)).join('');
  if (statusError) return;
  const count = (state: HostCheck['state']) => TILE_ORDER.filter((k) => status!.checks[k].state === state).length;
  const [bad, warn, off] = [count('bad'), count('warn'), count('off')];
  // a part that is switched off is not "all set" either (the preflight blocks on it)
  sum.className = 'h-summary' + (bad || off ? ' bad' : !warn ? ' ok' : '');
  sum.textContent = [bad ? `${bad} to fix` : '', warn ? `${warn} to watch` : '', off ? `${off} off` : ''].filter(Boolean).join(', ') || 'all set';
}

// ---------------------------------------------------------------------------------------------
// Toggles

function renderToggles() {
  for (const [id, on] of [
    ['#t-reality', toggles.reality],
    ['#t-labels', toggles.labels],
  ] as const) {
    const el = $(id);
    if (!el) continue;
    el.setAttribute('aria-checked', String(on));
    const st = $('.h-toggle-state', el);
    if (st) st.textContent = on ? 'On' : 'Off';
  }
}

async function sendCue(body: Record<string, unknown>): Promise<void> {
  await hostFetch('/api/host/cue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, by: 'host' }) });
}

async function flip(action: 'reality' | 'labels', el: HTMLElement) {
  const was = toggles[action];
  toggles = { ...toggles, [action]: !was };
  renderToggles();
  el.classList.add('busy');
  try {
    await sendCue({ action, on: !was });
    writeStored(TOGGLES_KEY, JSON.stringify(toggles));
  } catch (e) {
    toggles = { ...toggles, [action]: was };
    renderToggles();
    onRequestError(e);
  } finally {
    el.classList.remove('busy');
  }
}

// ---------------------------------------------------------------------------------------------
// Worlds

function inHeadset(id: string): boolean {
  return !!status?.presence.headset && status.presence.sceneId === id;
}

function thumbHtml(s: HostScene | undefined): string {
  return `<div class="h-thumb">${s?.thumb ? `<img src="${esc(s.thumb)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</div>`;
}

function openButton(s: HostScene, small = false): string {
  const cls = `h-btn h-btn-primary h-open${small ? ' h-btn-sm' : ''}`;
  if (sending.has(s.id)) return `<button class="${cls}" type="button" disabled>Sending…</button>`;
  if (sent.has(s.id)) return `<button class="h-btn h-open sent${small ? ' h-btn-sm' : ''}" type="button" data-open="${esc(s.id)}">Sent to headset</button>`;
  return `<button class="${cls}" type="button" data-open="${esc(s.id)}">Open in headset</button>`;
}

const newestFirst = (a: HostScene, b: HostScene) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');

/** The live build: worlds building now, and ones that finished while this page watched (for a few minutes). */
function liveList(): HostScene[] {
  const t = Date.now();
  for (const [id, at] of justReady) if (t - at > LIVE_KEEP_MS) justReady.delete(id);
  return [...scenes.values()].filter((s) => isBuilding(s.status) || (s.status === 'ready' && justReady.has(s.id))).sort(newestFirst);
}

/** Every world that is not building: ready ones newest first, then the last few failed builds. */
function worldList(): HostScene[] {
  const list = [...scenes.values()].filter((s) => !isBuilding(s.status)).sort(newestFirst);
  return list.filter((s) => s.status === 'ready').concat(list.filter((s) => s.status === 'failed').slice(0, 3));
}

function worldHtml(s: HostScene): string {
  const building = isBuilding(s.status);
  const slot = slotOf(pins, s.id);
  const badges = [
    `<span class="h-badge ${s.mode}">${s.mode === 'video' ? 'Video' : s.mode === 'sample' ? 'Sample' : 'Photo'}</span>`,
    inHeadset(s.id) ? '<span class="h-badge here">In headset now</span>' : '',
    slot >= 0 ? `<span class="h-badge pinned">${slot + 1} · ${esc(SLOTS[slot]!.label)}</span>` : '',
  ].join('');
  let body = `<h3 class="h-world-name">${esc(s.name)}</h3><div class="h-world-meta">${badges}</div>`;
  let actions = '';
  if (building) {
    const p = typeof s.progress === 'number' && s.progress > 0 ? Math.min(1, s.progress) : null;
    body +=
      `<div class="h-stage">${esc(progressText(s))}</div>` +
      `<div class="h-progress${p === null ? ' indeterminate' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100"${p === null ? '' : ` aria-valuenow="${Math.round(p * 100)}"`}><span style="transform:scaleX(${p ?? 0.3})"></span></div>`;
    actions = `<div class="h-world-actions"><button class="h-btn h-open" type="button" disabled>Opens when it is ready</button></div>`;
  } else if (s.status === 'failed') {
    body += `<div class="h-error">${esc(s.error || 'This one did not make it.')}</div>`;
  } else {
    actions =
      `<div class="h-world-actions">${openButton(s)}` +
      `<a class="h-btn" href="/view?scene=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">${s.mode === 'video' ? 'Watch here' : 'Walk here'}</a>` +
      `<button class="h-btn" type="button" data-pin="${esc(s.id)}" aria-expanded="${picking === s.id}">${slot >= 0 ? 'Move' : 'Pin'}</button></div>`;
    if (picking === s.id) {
      actions +=
        `<div class="h-pick"><span>Pin as</span>` +
        SLOTS.map((sl, i) => `<button class="h-btn h-btn-sm${pins[i] === s.id ? ' sent' : ''}" type="button" data-slot="${i}" data-id="${esc(s.id)}">${i + 1} · ${esc(sl.label)}</button>`).join('') +
        `</div>`;
    }
  }
  const cls = `h-world${building ? ' building' : ''}${s.status === 'failed' ? ' failed' : ''}${fresh.has(s.id) ? ' fresh' : ''}`;
  return `<article class="${cls}" data-id="${esc(s.id)}">${thumbHtml(s)}<div class="h-world-body">${body}</div>${actions}</article>`;
}

function renderWorlds() {
  if (!loaded) {
    // nothing from the server yet: say why instead of loading forever
    for (const box of [$('#videos'), $('#worlds')]) {
      if (box && statusError) {
        box.innerHTML = `<div class="h-empty">${statusError.status === 401 ? 'The worlds show up once the key is saved.' : 'The worlds show up when the server answers.'}</div>`;
      }
    }
    return;
  }
  const live = liveList();
  const section = $('#live-section');
  if (section) section.hidden = !live.length;
  const building = live.filter((s) => isBuilding(s.status)).length;
  const buildCount = $('#build-count');
  if (buildCount) buildCount.textContent = building ? `${building} building` : 'just finished';
  const liveBox = $('#live-worlds');
  if (liveBox) renderList(liveBox, live);

  // two rows to swipe through: video memories, then worlds
  const all = worldList();
  const rows: [string, string, HostScene[], string][] = [
    ['#videos', '#videos-count', all.filter((s) => s.mode === 'video'), 'No videos yet. Add a clip on the capture page.'],
    ['#worlds', '#worlds-count', all.filter((s) => s.mode !== 'video'), 'No worlds yet. Make one on the capture page.'],
  ];
  for (const [boxSel, countSel, list, empty] of rows) {
    const count = $(countSel);
    if (count) count.textContent = `${list.filter((s) => s.status === 'ready').length} ready`;
    const box = $(boxSel);
    if (!box) continue;
    if (!list.length) box.innerHTML = `<div class="h-empty">${empty}</div>`;
    else renderList(box, list);
  }
}

/** Keyed render: cards keep their element (and its loaded thumbnail) while their text changes. */
function renderList(box: HTMLElement, list: HostScene[]) {
  if (box.querySelector('.h-empty, .h-skel')) box.innerHTML = '';
  const existing = new Map([...box.querySelectorAll<HTMLElement>('.h-world')].map((el) => [el.dataset.id!, el]));
  let prev: Element | null = null;
  for (const s of list) {
    const html = worldHtml(s);
    let el = existing.get(s.id);
    if (el && el.dataset.html !== html) {
      const img = el.querySelector('.h-thumb');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const next = tmp.firstElementChild as HTMLElement;
      // keep the loaded thumbnail when the picture did not change
      const nextImg = next.querySelector('.h-thumb');
      if (img && nextImg && img.innerHTML === nextImg.innerHTML) nextImg.replaceWith(img);
      el.replaceWith(next);
      el = next;
    } else if (!el) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      el = tmp.firstElementChild as HTMLElement;
      // only a card that is new to the list slides in; updates swap in place
      el.classList.add('enter');
    }
    el.dataset.html = html;
    existing.delete(s.id);
    const want: Element | null = prev ? prev.nextElementSibling : box.firstElementChild;
    if (want !== el) box.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

function renderSlots() {
  const box = $('#slots');
  if (!box) return;
  box.innerHTML = SLOTS.map((sl, i) => {
    const s = pins[i] ? scenes.get(pins[i]!) : undefined;
    if (!s) {
      const hint = !pins[i] ? 'Tap Pin on a world below' : loaded ? 'Tap Pin on a world below (that world is gone)' : 'Pinned. Waiting for the server';
      return (
        `<div class="h-slot empty"><div class="h-slot-top"><span class="h-slot-n">${i + 1}</span>` +
        `<div class="h-slot-body"><div class="h-slot-label">${esc(sl.label)} · ${esc(sl.when)}</div>` +
        `<div class="h-slot-name">${hint}</div></div></div>${thumbHtml(undefined)}</div>`
      );
    }
    const ready = s.status === 'ready';
    return (
      `<div class="h-slot" data-id="${esc(s.id)}"><div class="h-slot-top"><span class="h-slot-n">${i + 1}</span>` +
      `<div class="h-slot-body"><div class="h-slot-label">${esc(sl.label)} · ${esc(sl.when)}</div>` +
      `<div class="h-slot-name">${esc(s.name)}</div></div></div>${thumbHtml(s)}` +
      `<div class="h-slot-actions">${ready ? openButton(s, true) : `<button class="h-btn h-btn-sm h-open" type="button" disabled>${esc(progressText(s))}</button>`}` +
      `<button class="h-icon h-x" type="button" data-unpin="${i}" aria-label="Unpin ${esc(s.name)}">${ICON_X}</button></div></div>`
    );
  }).join('');
}

async function openInHeadset(id: string) {
  const s = scenes.get(id);
  if (!s || sending.has(id)) return;
  sending.add(id);
  renderAll();
  try {
    await sendCue({ action: 'load', sceneId: id });
    sent.clear();
    sent.add(id);
    toast(`Opening ${s.name} in the headset`);
    setTimeout(() => {
      sent.delete(id);
      renderAll();
    }, 4000);
  } catch (e) {
    onRequestError(e);
  } finally {
    sending.delete(id);
    renderAll();
  }
}

function savePins(next: Pins) {
  pins = next;
  if (!writeStored(PINS_KEY, JSON.stringify(pins))) toast("Pinned for now. This browser won't remember it after a reload.");
}

// ---------------------------------------------------------------------------------------------
// Feed

const timeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : null;

function renderFeed(newest = false) {
  const box = $('#feed');
  if (!box) return;
  const count = $('#feed-count');
  if (count) count.textContent = feed.length ? `last ${feed.length}` : '';
  if (!feed.length) {
    box.innerHTML = '<li class="h-feed-empty">Nothing yet. Tags, notes, cues and finished worlds show up here.</li>';
    return;
  }
  box.innerHTML = feed
    .map((f, i) => {
      const d = new Date(f.at);
      const t = timeFmt ? timeFmt.format(d) : d.toTimeString().slice(0, 8);
      return `<li class="k-${f.kind}${newest && i === 0 ? ' new' : ''}"><time datetime="${d.toISOString()}">${esc(t)}</time><span class="h-dot"></span><span>${esc(f.text)}</span></li>`;
    })
    .join('');
}

function addToFeed(ev: ServerEvent) {
  const item = describeEvent(ev, {
    previous: (id) => scenes.get(id),
    sceneName,
    personName: (id) => names.get(id),
    previousHealth: lastHealth,
  });
  if (!item) return;
  feed = pushFeed(feed, item);
  renderFeed(true);
}

// ---------------------------------------------------------------------------------------------
// Data

function renderAll() {
  renderTiles();
  renderSlots();
  renderWorlds();
}

function showBanner(msg: string | null) {
  const el = $('#banner');
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

function onRequestError(e: unknown) {
  const err = e instanceof HostError ? e : new HostError('Something went wrong. Try again.', 0);
  if (err.signIn) {
    toast(`${err.message} Use Sign in at the top.`, true);
    return;
  }
  if (err.status === 401) {
    $('#key-form')!.hidden = false;
    $<HTMLInputElement>('#key-input')?.focus();
    toast(key ? 'That key was refused. Check DV_KEY and try again.' : 'This page needs the event key first.', true);
    return;
  }
  toast(err.message, true);
}

/** Merges a list from the server; a /ws update that is newer than the list wins. */
function mergeScenes(list: HostScene[]) {
  const seen = new Set<string>();
  for (const s of list) {
    seen.add(s.id);
    const cur = scenes.get(s.id);
    if (!cur || (s.updatedAt ?? '') >= (cur.updatedAt ?? '')) scenes.set(s.id, s);
  }
  // the status lists the newest 40; anything older that the page knew stays
  if (list.length < 40) for (const id of [...scenes.keys()]) if (!seen.has(id)) scenes.delete(id);
}

let refreshing: Promise<void> | null = null;
async function refreshStatus(force = false): Promise<void> {
  if (refreshing && !force) return refreshing;
  const btn = $('#refresh');
  if (force) btn?.classList.add('spin');
  refreshing = (async () => {
    try {
      const st = await hostFetch<HostStatus>(`/api/host/status${force ? '?refresh=1' : ''}`);
      status = st;
      statusError = null;
      for (const p of st.presence.names) names.set(p.id, p.name);
      mergeScenes(st.scenes.list);
      loaded = true;
      showBanner(st.readOnly ? 'This server is a read-only copy: cues work, but nothing builds here.' : null);
      $('#key-form')!.hidden = true;
      renderAll();
    } catch (e) {
      const err = e instanceof HostError ? e : null;
      statusError = { status: err?.status ?? 0, message: err?.message ?? '' };
      if (err?.status === 401) {
        $('#key-form')!.hidden = false;
        showBanner(null);
      } else if (err?.status === 403) {
        showBanner('Open this page from the Déjà View server itself (its own address), not from another site.');
      } else {
        showBanner(err?.message ?? "Can't reach the server. Check that it is still running.");
      }
      renderAll();
    } finally {
      btn?.classList.remove('spin');
      refreshing = null;
    }
  })();
  return refreshing;
}

function onScene(scene: Scene) {
  if (scene.unlisted) return; // a test build: never in the list of worlds
  const prev = scenes.get(scene.id);
  addToFeed({ type: 'scene', scene });
  scenes.set(scene.id, hostScene(scene));
  if (scene.status === 'ready' && prev && prev.status !== 'ready') {
    fresh.add(scene.id);
    justReady.set(scene.id, Date.now());
    setTimeout(() => {
      fresh.delete(scene.id);
      renderWorlds();
    }, 5000);
    toast(`${scene.name || scene.id} is ready. Tap Open in headset.`);
  }
  loaded = true;
  renderSlots();
  renderWorlds();
}

function setLive(state: 'connecting' | 'open' | 'closed') {
  const dot = $('#live-dot');
  const txt = $('#live-txt');
  if (!dot || !txt) return;
  dot.className = 'h-dot' + (state === 'open' ? ' ok pulse' : state === 'connecting' ? ' warn' : ' bad');
  txt.textContent = state === 'open' ? 'live' : state === 'connecting' ? 'connecting' : 'reconnecting';
}

function onClick(e: MouseEvent) {
  const t = (e.target as HTMLElement).closest<HTMLElement>('button, a');
  if (!t) return;
  const d = t.dataset;
  if (d.copy) {
    void copyText(d.copy).then((ok) => toast(ok ? 'Copied' : d.copy!));
  } else if (d.check) {
    void refreshStatus(true).then(() => {
      // the server did not answer: what the tile says is old news
      if (statusError) return toast(statusError.status === 401 ? 'This page needs the event key first.' : statusError.message || "Can't check right now.", true);
      const c = status?.checks.tunnel;
      if (c) toast(c.state === 'ok' ? 'The public link answers' : `Public link: ${c.text}`, c.state !== 'ok');
    });
  } else if (d.open) {
    void openInHeadset(d.open);
  } else if (d.pin) {
    picking = picking === d.pin ? null : d.pin;
    renderWorlds();
  } else if (d.slot !== undefined && d.id) {
    const i = Number(d.slot);
    savePins(pin(pins, i, d.id));
    picking = null;
    toast(`Pinned as ${i + 1} · ${SLOTS[i]!.label}`);
    renderSlots();
    renderWorlds();
  } else if (d.unpin !== undefined) {
    savePins(unpin(pins, Number(d.unpin)));
    renderSlots();
    renderWorlds();
  }
}

function main() {
  renderTiles();
  renderToggles();
  renderSlots();
  renderFeed();
  document.addEventListener('click', onClick);
  for (const id of ['#t-reality', '#t-labels']) {
    const el = $(id);
    el?.addEventListener('click', () => void flip(el.dataset.action as 'reality' | 'labels', el));
  }
  $('#refresh')?.addEventListener('click', () => void refreshStatus(true));
  void mountSignIn($('#sign-in')).then((err) => err && toast(err, true));
  $<HTMLFormElement>('#key-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>('#key-input')?.value.trim() ?? '';
    key = v || null;
    writeStored(KEY_KEY, key);
    const input = $<HTMLInputElement>('#key-input');
    if (input) input.value = '';
    void refreshStatus(true);
  });

  const events = new LiveEvents();
  let opened = false;
  events.onState((s) => {
    setLive(s);
    if (s === 'open') {
      // after a reconnect, events may have been missed
      if (opened) void refreshStatus();
      opened = true;
    }
  });
  events.on('scene', (ev) => onScene(ev.scene));
  events.on('scene_deleted', (ev) => {
    addToFeed(ev);
    scenes.delete(ev.id);
    renderSlots();
    renderWorlds();
  });
  events.on('cue', (ev) => {
    addToFeed(ev);
    if (ev.action === 'reality' || ev.action === 'labels') {
      toggles = { ...toggles, [ev.action]: ev.on !== false };
      writeStored(TOGGLES_KEY, JSON.stringify(toggles));
      renderToggles();
    }
  });
  events.on('note', (ev) => addToFeed(ev));
  events.on('roblox', (ev) => {
    const e = ev.event as Record<string, unknown>;
    if (typeof e.target === 'string' && typeof e.targetName === 'string') names.set(e.target, e.targetName);
    addToFeed(ev);
  });
  events.on('health', (ev) => {
    addToFeed(ev);
    lastHealth = ev.health;
    void refreshStatus();
  });
  events.start();

  void refreshStatus();
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshStatus();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshStatus();
  });
}

main();
