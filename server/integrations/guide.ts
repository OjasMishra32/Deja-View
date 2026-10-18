// The guide relay (team/contracts.md section 8, team/brianna.md section 5).
//
// The headset calls BASE/api/guide/<name>; the server forwards the body to GUIDE_URL/<name> with X-Guide-Key, fills
// in `scene` ({id} -> {id, name, mode: "photo"|"video", caption, hotspots?}) from its store, and returns the guide's
// status and body unchanged. Requests are size-checked first (images and audio arrive as data URLs).
//
// When the guide is down the answer is fast and friendly:
//   unreachable or not JSON  502 {"error":"guide offline", ...a canned answer, "degraded":true}
//   no answer in time        504 {"error":"guide timeout", ...a canned answer, "degraded":true}
// After a connection failure the client remembers the guide is down and answers the next calls at once (no waiting
// on a dead address), probing GET /health every 2 s and letting one real call through every 5 s until it is back.

import { join, resolve, sep } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import { isPipelineCaption } from '../copy.ts';
import {
  callJson,
  hostOf,
  integrationsConfigFromEnv,
  onceLogger,
  prefixedLogger,
  type CallResult,
  type FetchLike,
  type GuideConfig,
  type GuideEndpoint,
  type Logger,
} from './config.ts';

export type { GuideEndpoint } from './config.ts';

export const GUIDE_ENDPOINTS: readonly GuideEndpoint[] = ['describe', 'hotspots', 'narrate', 'ask'];

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface GuideHotspotRef {
  label: string;
  blurb?: string;
}

/** The `scene` object the guide receives. */
export interface GuideScene {
  id: string;
  name?: string;
  mode?: 'photo' | 'video';
  caption?: string;
  hotspots?: GuideHotspotRef[];
  /**
   * Who is asking, in a private memory (server/auth/memory-keys.ts): the family (owner and guests) may hear who is
   * who and how the moment ended; a visitor only about the place. Set by this server from the request's sign-in,
   * never taken from the client. Absent for a public memory.
   */
  viewer?: { access: 'family' | 'visitor' };
}

/** Messages a person may read (the `error` strings are the contract's exact words). */
export const GUIDE_MESSAGES = {
  offline: 'guide offline',
  timeout: 'guide timeout',
  tooLarge: 'That is too much to send at once. Try a smaller picture or a shorter question.',
  notJson: 'The guide needs a JSON body.',
  badImage: 'image must be a base64 data URL (JPEG, PNG or WebP)',
  badAudio: 'audio must be a base64 data URL',
  imageRequired: 'image required',
  noQuestion: 'Ask something: hold the button and speak, or type a question.',
  unknown: "That guide action doesn't exist.",
  noScene: 'No such scene',
} as const;

/** What the headset can show or say when the guide cannot answer. Never a vendor name. */
export const GUIDE_FALLBACK: Record<GuideEndpoint, Record<string, unknown>> = {
  ask: { question: '', answer: "Sorry, I lost my train of thought. Ask me again in a moment.", speech: null },
  narrate: { answer: 'Welcome in. Take a look around.', speech: null },
  hotspots: { hotspots: [] },
  describe: { caption: '' },
};

// ---------------------------------------------------------------------------------------------------------------
// Client

export interface GuideStatus {
  enabled: boolean;
  host: string | null;
  /** null until the first call or probe answered. */
  up: boolean | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Latency of the last successful call per endpoint, ms. */
  lastMs: Partial<Record<GuideEndpoint, number>>;
  calls: number;
  failures: number;
}

export interface GuideCallResult extends CallResult {
  /** True when the call was answered locally because the guide is known to be down. */
  failFast?: boolean;
}

export interface GuideClient {
  readonly enabled: boolean;
  call(name: GuideEndpoint, body: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<GuideCallResult>;
  /** GET GUIDE_URL/health (no key needed there). */
  health(timeoutMs?: number): Promise<CallResult>;
  isDown(): boolean;
  status(): GuideStatus;
  /**
   * Checks GET /health every `everyMs` while nothing else has talked to the guide, so a dead address is known before
   * the judge asks (the first question then fails fast instead of waiting out its 10 s timeout).
   */
  startMonitor(everyMs?: number): void;
  /** Stops the background probe and monitor (tests, shutdown). */
  close(): void;
}

export interface GuideClientOptions {
  config: Pick<GuideConfig, 'url' | 'key' | 'timeouts'>;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => number;
  /** While down, one real call is let through this often. */
  trialEveryMs?: number;
  probeEveryMs?: number;
}

export function createGuideClient(opts: GuideClientOptions): GuideClient {
  const cfg = opts.config;
  const enabled = !!cfg.url;
  const doFetch: FetchLike = opts.fetch ?? fetch;
  const log = opts.log ?? prefixedLogger('guide');
  const once = onceLogger(log);
  const now = opts.now ?? Date.now;
  const trialEveryMs = opts.trialEveryMs ?? 5000;
  const probeEveryMs = opts.probeEveryMs ?? 2000;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(cfg.key ? { 'X-Guide-Key': cfg.key } : {}) };
  const st: GuideStatus = { enabled, host: hostOf(cfg.url), up: null, lastOkAt: null, lastError: null, lastMs: {}, calls: 0, failures: 0 };
  let down = false;
  let lastTrialAt = 0;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let probing: Promise<boolean> | null = null;
  let lastHeardAt = 0;

  function markUp() {
    if (st.up === false) log.info(`guide is back (${st.host})`);
    st.up = true;
    st.lastOkAt = lastHeardAt = now();
    st.lastError = null;
    down = false;
    stopProbe();
    once.reset('timeout-');
  }

  function markDown(reason: string) {
    if (st.up !== false) log.warn(`guide unreachable at ${st.host} (${reason}); answering with fallbacks until it is back`);
    st.up = false;
    st.lastError = reason;
    down = true;
    lastTrialAt = now(); // the failed call counts as the last try
    startProbe();
  }

  function startProbe() {
    if (probeTimer) return;
    probeTimer = setInterval(() => void probe(), probeEveryMs);
    (probeTimer as { unref?: () => void }).unref?.();
  }

  function stopProbe() {
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
  }

  /** Any HTTP answer from GET /health means the guide process is reachable. Concurrent callers share one probe. */
  function probe(): Promise<boolean> {
    if (!enabled) return Promise.resolve(false);
    probing ??= health(Math.min(1500, cfg.timeouts.health))
      .then((r) => {
        const reachable = r.kind === 'ok' || r.kind === 'http';
        if (reachable) markUp();
        return reachable;
      })
      .finally(() => {
        probing = null;
      });
    return probing;
  }

  function health(timeoutMs = cfg.timeouts.health): Promise<CallResult> {
    if (!enabled) return Promise.resolve({ kind: 'offline', status: 0, body: null, text: null, ms: 0, detail: 'GUIDE_URL is not set' });
    return callJson(doFetch, `${cfg.url}/health`, { method: 'GET', headers, timeoutMs });
  }

  async function call(name: GuideEndpoint, body: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GuideCallResult> {
    if (!enabled) return { kind: 'offline', status: 0, body: null, text: null, ms: 0, detail: 'GUIDE_URL is not set', failFast: true };
    if (down) {
      const t = now();
      if (t - lastTrialAt < trialEveryMs) return { kind: 'offline', status: 0, body: null, text: null, ms: 0, detail: st.lastError ?? 'guide down', failFast: true };
      lastTrialAt = t;
    }
    st.calls++;
    const r = await callJson(doFetch, `${cfg.url}/${name}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      timeoutMs: o.timeoutMs ?? cfg.timeouts[name],
      signal: o.signal,
    });
    if (o.signal?.aborted) return r; // the caller hung up: says nothing about the guide
    if (r.kind === 'ok' || r.kind === 'http') {
      if (r.kind === 'http' && r.status === 401) {
        once.warn('key', 'the guide refused GUIDE_KEY (401): check the key Brianna handed over');
      }
      markUp();
      if (r.kind === 'ok') st.lastMs[name] = r.ms;
    } else {
      st.failures++;
      if (r.kind === 'timeout') {
        // Slow model or dead address? A quick health probe tells them apart.
        once.warn(`timeout-${name}`, `guide /${name} took longer than ${o.timeoutMs ?? cfg.timeouts[name]} ms`);
        void probe().then((ok) => {
          if (!ok) markDown('no answer');
        });
      } else {
        markDown(r.detail ?? r.kind);
      }
    }
    return r;
  }

  function startMonitor(everyMs = 10_000) {
    if (monitorTimer || !enabled) return;
    const check = async () => {
      if (down || now() - lastHeardAt < everyMs) return; // the 2 s probe, or real traffic, already covers it
      if (!(await probe())) markDown('health check got no answer');
    };
    void check();
    monitorTimer = setInterval(() => void check(), everyMs);
    (monitorTimer as { unref?: () => void }).unref?.();
  }

  return {
    enabled,
    call,
    health,
    isDown: () => down,
    status: () => ({ ...st, lastMs: { ...st.lastMs } }),
    startMonitor,
    close() {
      stopProbe();
      if (monitorTimer) clearInterval(monitorTimer);
      monitorTimer = null;
    },
  };
}

let defaultClient: GuideClient | null = null;

/** One client per process, configured from the environment (used by describeForJob and the narrate warm-up). */
export function defaultGuideClient(): GuideClient {
  return (defaultClient ??= createGuideClient({ config: integrationsConfigFromEnv().guide }));
}

// ---------------------------------------------------------------------------------------------------------------
// Request checks

const IMAGE_URL = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
const AUDIO_URL = /^data:audio\/[a-z0-9.+-]+(;[^,;]*)*;base64,/i;

/** Reads a request body as text, refusing anything over `max` bytes without buffering it. */
export async function readBodyCapped(req: Request, max: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > max) return { ok: false };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? Array.from(s).slice(0, max).join('') : undefined;
}

/** "thirdwheel" | "video" -> "video"; anything else is a place -> "photo". */
export function publicMode(mode: unknown): 'photo' | 'video' {
  return mode === 'thirdwheel' || mode === 'video' ? 'video' : 'photo';
}

function hotspotRefs(raw: unknown): GuideHotspotRef[] | undefined {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { hotspots?: unknown })?.hotspots) ? (raw as { hotspots: unknown[] }).hotspots : null;
  if (!list) return undefined;
  const out: GuideHotspotRef[] = [];
  for (const h of list) {
    const label = str((h as { label?: unknown })?.label, 40);
    if (!label) continue;
    const blurb = str((h as { blurb?: unknown })?.blurb, 80);
    out.push(blurb ? { label, blurb } : { label });
    if (out.length >= 12) break;
  }
  return out;
}

function history(raw: unknown): { q: string; a: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .slice(-4)
    .map((h) => ({ q: str((h as { q?: unknown })?.q, 500) ?? '', a: str((h as { a?: unknown })?.a, 500) ?? '' }))
    .filter((h) => h.q || h.a);
}

/** Base64 payload bytes of a data URL, roughly (4 characters carry 3 bytes). */
function dataUrlBytes(s: string): number {
  const comma = s.indexOf(',');
  return Math.floor(((s.length - comma - 1) * 3) / 4);
}

// ---------------------------------------------------------------------------------------------------------------
// Proxy

export interface GuideProxyDeps {
  client: GuideClient;
  config: Pick<GuideConfig, 'maxBodyBytes' | 'maxImageBytes' | 'maxAudioBytes' | 'timeouts'>;
  /** The scene store (SceneStore.get). */
  getScene?: (id: string) => Promise<Scene | null>;
  /** A scene's directory (SceneStore.sceneDir), for the thumbnail fallback and stored labels. */
  sceneDir?: (id: string) => string;
  /** Labels already pinned in a world ([{label, blurb}]). Default: <sceneDir>/hotspots.json when it exists. */
  getHotspots?: (id: string) => Promise<unknown>;
  /** Memory Keys: what the guide may tell this request about a private memory (undefined: a public one). */
  viewerAccess?: (req: Request, sceneId: string) => Promise<'family' | 'visitor' | undefined>;
  log?: Logger;
}

export interface GuideProxy {
  /** POST /api/guide/:name */
  handle(name: string, req: Request): Promise<Response>;
  /** GET /api/guide/health */
  health(): Promise<Response>;
  /** {id} or "id" -> the full scene context from the store (undefined when there is no usable id). */
  sceneContext(raw: unknown): Promise<GuideScene | undefined>;
  /** POST /narrate with the scene's thumbnail so the greeting is cached before anyone enters. Never throws. */
  narrateWarmup(sceneId: string): Promise<boolean>;
  /** The scene's thumbnail as a data URL, or null. */
  thumbDataUrl(sceneId: string): Promise<string | null>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function createGuideProxy(deps: GuideProxyDeps): GuideProxy {
  const { client, config } = deps;
  const log = deps.log ?? prefixedLogger('guide');

  function inside(dir: string, rel: string): string | null {
    const base = resolve(dir);
    const p = resolve(base, rel);
    return p.startsWith(base + sep) ? p : null;
  }

  async function storedHotspots(id: string): Promise<unknown> {
    if (deps.getHotspots) return deps.getHotspots(id);
    if (!deps.sceneDir) return undefined;
    const f = Bun.file(join(deps.sceneDir(id), 'hotspots.json'));
    return (await f.exists()) ? f.json() : undefined;
  }

  async function sceneContext(raw: unknown): Promise<GuideScene | undefined> {
    const given = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof raw === 'string' ? raw : typeof given.id === 'string' ? given.id : '';
    if (!SCENE_ID.test(id)) return undefined;
    const scene = deps.getScene ? await deps.getScene(id).catch(() => null) : null;
    const ctx: GuideScene = { id };
    const name = str(scene?.name, 80) ?? str(given.name, 80);
    if (name) ctx.name = name;
    if (scene?.mode || given.mode) ctx.mode = publicMode(scene?.mode ?? given.mode);
    // the place, not how it was made: a job's own sentence ("Generated from one photo ...") tells the guide nothing
    const stored = scene?.captionSource === 'guide' || !isPipelineCaption(scene?.caption) ? str(scene?.caption, 600) : undefined;
    const caption = stored ?? (isPipelineCaption(given.caption as string | undefined) ? undefined : str(given.caption, 600));
    if (caption) ctx.caption = caption;
    let hs = hotspotRefs(given.hotspots);
    if (!hs) hs = hotspotRefs(await storedHotspots(id).catch(() => undefined));
    if (hs?.length) ctx.hotspots = hs;
    return ctx;
  }

  async function thumbDataUrl(sceneId: string): Promise<string | null> {
    if (!deps.sceneDir || !SCENE_ID.test(sceneId)) return null;
    try {
      const scene = deps.getScene ? await deps.getScene(sceneId).catch(() => null) : null;
      const dir = deps.sceneDir(sceneId);
      for (const rel of [scene?.thumb, 'thumb.jpg'].filter((r): r is string => !!r)) {
        const path = inside(dir, rel);
        const mime = path ? IMAGE_MIME[path.slice(path.lastIndexOf('.')).toLowerCase()] : undefined;
        if (!path || !mime) continue;
        const f = Bun.file(path);
        if (!(await f.exists()) || f.size > 3 * 1024 * 1024) continue;
        return `data:${mime};base64,${Buffer.from(await f.arrayBuffer()).toString('base64')}`;
      }
    } catch {
      /* no thumbnail */
    }
    return null;
  }

  function failure(name: GuideEndpoint, r: GuideCallResult, body: Record<string, unknown>): Response {
    const timeout = r.kind === 'timeout';
    const fb: Record<string, unknown> = { ...GUIDE_FALLBACK[name] };
    if (name === 'ask' && typeof body.question === 'string') fb.question = body.question;
    // no GUIDE_URL at all: say so, so the headset stops asking instead of retrying for minutes
    const extra = client.enabled ? {} : { configured: false };
    return reply(timeout ? 504 : 502, { error: timeout ? GUIDE_MESSAGES.timeout : GUIDE_MESSAGES.offline, ...fb, degraded: true, ...extra });
  }

  async function handle(rawName: string, req: Request): Promise<Response> {
    const name = rawName as GuideEndpoint;
    if (!GUIDE_ENDPOINTS.includes(name)) return reply(404, { error: GUIDE_MESSAGES.unknown });
    const read = await readBodyCapped(req, config.maxBodyBytes).catch(() => ({ ok: false as const }));
    if (!read.ok) return reply(413, { error: GUIDE_MESSAGES.tooLarge });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = read.text.trim() ? JSON.parse(read.text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply(400, { error: GUIDE_MESSAGES.notJson });
      body = parsed as Record<string, unknown>;
    } catch {
      return reply(400, { error: GUIDE_MESSAGES.notJson });
    }

    // a scene that does not exist is a 404 like on every other route, not a question for the guide
    if (name !== 'describe' && deps.getScene && body.scene !== undefined && body.scene !== null) {
      const raw = body.scene as unknown;
      const id = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '';
      if (id && (!SCENE_ID.test(id) || !(await deps.getScene(id).catch(() => null)))) return reply(404, { error: GUIDE_MESSAGES.noScene });
    }

    if (body.image === null || body.image === '') delete body.image;
    if (body.image !== undefined) {
      if (typeof body.image !== 'string' || !IMAGE_URL.test(body.image)) return reply(400, { error: GUIDE_MESSAGES.badImage });
      if (dataUrlBytes(body.image) > config.maxImageBytes) return reply(413, { error: GUIDE_MESSAGES.tooLarge });
    }
    if ((name === 'describe' || name === 'hotspots') && body.image === undefined) return reply(400, { error: GUIDE_MESSAGES.imageRequired });

    if (name === 'ask') {
      if (body.audio === null || body.audio === '') delete body.audio;
      if (body.audio !== undefined) {
        if (typeof body.audio !== 'string' || !AUDIO_URL.test(body.audio)) return reply(400, { error: GUIDE_MESSAGES.badAudio });
        if (dataUrlBytes(body.audio) > config.maxAudioBytes) return reply(413, { error: GUIDE_MESSAGES.tooLarge });
      }
      const q = str(body.question, 500);
      if (q) body.question = q;
      else delete body.question;
      if (body.audio !== undefined) delete body.question; // exactly one of audio or question
      if (body.audio === undefined && body.question === undefined) return reply(400, { error: GUIDE_MESSAGES.noQuestion });
      const h = history(body.history);
      if (h) body.history = h;
      else delete body.history;
    }

    if (name === 'describe') {
      delete body.scene; // contract: {image} only
    } else {
      const ctx = await sceneContext(body.scene);
      if (ctx && deps.viewerAccess) {
        const access = await deps.viewerAccess(req, ctx.id).catch(() => 'visitor' as const);
        if (access) ctx.viewer = { access };
      }
      if (ctx) body.scene = ctx;
      else delete body.scene;
      if (body.image === undefined && ctx && (name === 'narrate' || name === 'ask')) {
        const thumb = await thumbDataUrl(ctx.id);
        if (thumb) body.image = thumb;
      }
    }

    const r = await client.call(name, body, { timeoutMs: config.timeouts[name], signal: req.signal });
    if (r.kind === 'ok') {
      if (name === 'ask' && r.ms > 2500) log.warn(`ask took ${r.ms} ms (target under 2 s)`);
      return new Response(r.text ?? '{}', { status: r.status, headers: JSON_HEADERS });
    }
    if (r.kind === 'http') {
      if (r.status === 401 || r.status === 403) return failure(name, { ...r, kind: 'offline' }, body);
      return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status, headers: JSON_HEADERS });
    }
    return failure(name, r, body);
  }

  async function health(): Promise<Response> {
    if (!client.enabled) return reply(502, { ok: false, error: GUIDE_MESSAGES.offline, configured: false });
    const r = await client.health();
    if ((r.kind === 'ok' || r.kind === 'http') && r.body && typeof r.body === 'object') {
      return reply(r.kind === 'ok' ? 200 : 502, { ...r.body, ms: r.ms });
    }
    return reply(502, { ok: false, error: GUIDE_MESSAGES.offline });
  }

  async function narrateWarmup(sceneId: string): Promise<boolean> {
    try {
      const ctx = await sceneContext(sceneId);
      const image = ctx ? await thumbDataUrl(ctx.id) : null;
      if (!ctx || !image) return false;
      const r = await client.call('narrate', { image, scene: ctx }, { timeoutMs: config.timeouts.narrate });
      if (r.kind !== 'ok') return false;
      log.info(`greeting ready for ${sceneId} (${r.ms} ms)`);
      return true;
    } catch {
      return false;
    }
  }

  return { handle, health, sceneContext, narrateWarmup, thumbDataUrl };
}
