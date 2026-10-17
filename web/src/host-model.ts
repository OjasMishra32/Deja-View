// The host page's logic that does not touch the DOM: the live feed in plain words, the pinned demo order, and
// storage that survives a private window (every read and write may throw there).

import type { HealthInfo, Scene, ServerEvent } from '../../shared/types.ts';

// ---------------------------------------------------------------------------------------------
// Storage

/** localStorage.getItem, or null when storage is blocked. */
export function readStored(key: string, store: Pick<Storage, 'getItem'> | null = safeStorage()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** localStorage.setItem (removeItem for null); false when storage is blocked. */
export function writeStored(key: string, value: string | null, store: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): boolean {
  try {
    if (!store) return false;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The demo order: three slots, in the order the skit uses them (team/contracts.md 13.4).

export const SLOTS = [
  { key: 'gamenight', label: 'Game night', when: '0:00 · the skit' },
  { key: 'fortnite', label: 'Fortnite', when: '2:10 · drop-in' },
  { key: 'backup', label: 'Backup world', when: 'if the live build is slow' },
] as const;

export type Pins = (string | null)[];

export const PINS_KEY = 'dv.host.pins';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

/** The pinned scene ids, one per slot (null = empty). Anything unreadable is an empty order. */
export function parsePins(raw: string | null): Pins {
  const out: Pins = SLOTS.map(() => null);
  if (!raw) return out;
  try {
    const v = JSON.parse(raw);
    const list = Array.isArray(v) ? v : Array.isArray(v?.slots) ? v.slots : [];
    for (let i = 0; i < out.length; i++) out[i] = typeof list[i] === 'string' && ID_RE.test(list[i]) ? list[i] : null;
  } catch {
    /* a broken value: start over */
  }
  return out;
}

/** Puts `id` in `slot`, taking it out of any other slot first. */
export function pin(pins: Pins, slot: number, id: string): Pins {
  const out = pins.map((p) => (p === id ? null : p));
  if (slot >= 0 && slot < out.length) out[slot] = id;
  return out;
}

export function unpin(pins: Pins, slot: number): Pins {
  return pins.map((p, i) => (i === slot ? null : p));
}

/** Which slot a scene is pinned in, or -1. */
export function slotOf(pins: Pins, id: string): number {
  return pins.indexOf(id);
}

// ---------------------------------------------------------------------------------------------
// Scenes

const BUILDING = new Set(['queued', 'uploading', 'running', 'downloading']);

export function isBuilding(status: string): boolean {
  return BUILDING.has(status);
}

/** "Generating the room · 60%", "Waiting in line", "Ready". */
export function progressText(s: { status: string; stage?: string; progress?: number }): string {
  const stage = s.stage?.trim() || (s.status === 'queued' ? 'Waiting in line' : s.status === 'ready' ? 'Ready' : s.status === 'failed' ? 'Failed' : 'Building');
  if (!isBuilding(s.status) || typeof s.progress !== 'number' || !Number.isFinite(s.progress) || s.progress <= 0) return stage;
  return `${stage} · ${Math.round(Math.min(1, s.progress) * 100)}%`;
}

// ---------------------------------------------------------------------------------------------
// The live feed

export type FeedKind = 'tag' | 'round' | 'note' | 'cue' | 'ready' | 'failed' | 'new' | 'deleted' | 'gpu';

export interface FeedItem {
  kind: FeedKind;
  text: string;
  /** Unix ms when the page saw it. */
  at: number;
}

export interface FeedContext {
  /** The scene as the page knew it before this event (to tell a change of status from a progress tick). */
  previous(id: string): Pick<Scene, 'status' | 'name'> | undefined;
  /** A world's name for an id. */
  sceneName(id: string): string;
  /** A person's display name for an id, when the page has one. */
  personName(id: string): string | undefined;
  /** The last health the page saw. */
  previousHealth?: HealthInfo;
  now?: () => number;
}

export const FEED_MAX = 20;

/** "quest-1" -> "the headset" (or its name), "rbx-123" -> the player's name. */
export function whoIs(id: unknown, ctx: Pick<FeedContext, 'personName'>, fallbackName?: unknown): string {
  const sid = typeof id === 'string' ? id : '';
  const known = sid ? ctx.personName(sid) : undefined;
  if (known) return known;
  if (typeof fallbackName === 'string' && fallbackName.trim()) return fallbackName.trim();
  if (sid.startsWith('quest-')) return 'the headset';
  if (sid.startsWith('rbx-')) return 'a Roblox player';
  if (sid.startsWith('web-')) return 'a browser visitor';
  return sid || 'someone';
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The round's winner: `winner` when Roblox sent one, else the top score. */
function winnerOf(ev: Record<string, unknown>, ctx: FeedContext): string | null {
  if (typeof ev.winner === 'string' && ev.winner) return whoIs(ev.winner, ctx);
  const scores = ev.scores && typeof ev.scores === 'object' ? (ev.scores as Record<string, unknown>) : null;
  if (!scores) return null;
  let best: [string, number] | null = null;
  for (const [id, v] of Object.entries(scores)) if (typeof v === 'number' && (!best || v > best[1])) best = [id, v];
  return best ? `${whoIs(best[0], ctx)} (${best[1]})` : null;
}

/** One line for the feed, or null for events the host does not need to see (progress ticks, labels moving). */
export function describeEvent(ev: ServerEvent, ctx: FeedContext): FeedItem | null {
  const at = (ctx.now ?? Date.now)();
  const item = (kind: FeedKind, text: string): FeedItem => ({ kind, text, at });
  switch (ev.type) {
    case 'roblox': {
      const e = ev.event as Record<string, unknown>;
      if (e.type === 'tag') return item('tag', `${cap(whoIs(e.by, ctx))} tagged ${whoIs(e.target, ctx, e.targetName)}`);
      if (e.type === 'round') {
        if (e.state === 'start') return item('round', `Tag round started${typeof e.duration === 'number' ? ` (${Math.round(e.duration)} s)` : ''}`);
        if (e.state === 'end') {
          const w = winnerOf(e, ctx);
          return item('round', w ? `Round over. Winner: ${w}` : 'Round over');
        }
      }
      return null;
    }
    case 'note': {
      const author = clip(ev.note?.author || 'Someone', 40);
      return item('note', `${author} left a note: “${clip(ev.note?.text ?? '', 80)}”`);
    }
    case 'cue': {
      const by = ev.by ? ` (${ev.by})` : '';
      if (ev.action === 'reality') return item('cue', `Reality check ${ev.on ? 'on' : 'off'}${by}`);
      if (ev.action === 'labels') return item('cue', `Labels ${ev.on ? 'on' : 'off'}${by}`);
      if (ev.action === 'load') return item('cue', `Headset told to open ${ev.sceneId ? ctx.sceneName(ev.sceneId) : 'a world'}${by}`);
      return null;
    }
    case 'scene': {
      const s = ev.scene;
      const prev = ctx.previous(s.id);
      const name = s.name || ctx.sceneName(s.id);
      if (!prev) return isBuilding(s.status) ? item('new', `New world started: ${name}`) : s.status === 'ready' ? item('ready', `${name} is ready`) : null;
      if (prev.status === s.status) return null;
      if (s.status === 'ready') return item('ready', `${name} is ready`);
      if (s.status === 'failed') return item('failed', `${name} failed${s.error ? `: ${clip(s.error, 100)}` : ''}`);
      if (isBuilding(s.status) && !isBuilding(prev.status)) return item('new', `Building ${name} again`);
      return null;
    }
    case 'scene_deleted':
      return item('deleted', `${ctx.sceneName(ev.id)} was deleted`);
    case 'health': {
      const was = ctx.previousHealth?.hpg?.worker?.alive;
      const now = ev.health?.hpg?.worker?.alive;
      if (was === undefined || was === now) return null;
      return item('gpu', now ? 'GPU worker woke up' : 'GPU worker went to sleep');
    }
    default:
      return null;
  }
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Newest first, at most FEED_MAX. */
export function pushFeed(feed: FeedItem[], item: FeedItem | null): FeedItem[] {
  if (!item) return feed;
  return [item, ...feed].slice(0, FEED_MAX);
}
