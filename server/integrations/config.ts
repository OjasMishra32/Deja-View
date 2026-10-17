// Settings for the server's connections to teammates' services (team/contracts.md sections 2, 7 and 8):
//   DeepSpace worker  DS_URL + DS_KEY        presence push (7.1), notes read and write (7.2)
//   guide service     GUIDE_URL + GUIDE_KEY  /describe /hotspots /narrate /ask (8)
//   public link       data/public-url.txt    written by scripts/tunnel.ts
//
// Every value has a demo default, and a missing URL turns that integration off (it then answers politely instead of
// failing). Keys are never logged and never appear in status objects.
//
// Also the plumbing both integrations share: callJson() (one request with a hard timeout, classified as ok / http /
// offline / timeout / bad-response so callers back off on the right things), backoff and log-once helpers.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Env = Record<string, string | undefined>;

export const ROOT = resolve(import.meta.dir, '..', '..');

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export function prefixedLogger(prefix: string, base: Pick<Console, 'log' | 'warn'> = console): Logger {
  return {
    info: (m) => base.log(`[${prefix}] ${m}`),
    warn: (m) => base.warn(`[${prefix}] ${m}`),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

/** Times and limits from the contract. Change them here, not at the call sites. */
export const CONTRACT = {
  /** 7.1: about 4 pushes a second per scene with people in it. */
  pushHz: 4,
  /** 7.1: fire and forget with a 2 s timeout. */
  pushTimeoutMs: 2000,
  /** 7.1: at most 32 people per push. */
  maxPeople: 32,
  /** 7.1: DeepSpace refuses bodies over 32 KB. */
  maxIngestBytes: 32 * 1024,
  /** 7.2: read notes every 2 s for every scene with someone in it. */
  notesIntervalMs: 2000,
  /** 7.2: a note is placed 1.4 m above the floor unless set. */
  noteDefaultY: 1.4,
  /** 7.2: note text 1 to 120 characters, author at most 40. */
  noteTextMax: 120,
  authorMax: 40,
  /** 8: server timeouts per guide endpoint. */
  guideTimeoutMs: { describe: 5000, hotspots: 15000, narrate: 10000, ask: 10000, health: 2000 },
} as const;

export type GuideEndpoint = 'describe' | 'hotspots' | 'narrate' | 'ask';

export interface DeepSpaceConfig {
  /** Base URL of the DeepSpace worker, no trailing slash. null = integration off. */
  url: string | null;
  key: string | null;
  pushHz: number;
  /** Push rate when nobody in a scene moved (still at least 1 Hz, as the contract asks). Defaults to pushHz. */
  idleHz: number;
  pushTimeoutMs: number;
  notesIntervalMs: number;
  notesTimeoutMs: number;
  notesPostTimeoutMs: number;
  maxPeople: number;
}

export interface GuideConfig {
  url: string | null;
  key: string | null;
  timeouts: Record<GuideEndpoint | 'health', number>;
  /** Whole JSON body from the headset. The guide itself accepts 15 MB. */
  maxBodyBytes: number;
  /** One image data URL (the headset sends about 50 to 200 KB). */
  maxImageBytes: number;
  /** One audio data URL (1 to 8 s of webm/opus is well under 1 MB). */
  maxAudioBytes: number;
}

export interface IntegrationsConfig {
  deepspace: DeepSpaceConfig;
  guide: GuideConfig;
  /** Where scripts/tunnel.ts writes the public https BASE. */
  publicUrlFile: string;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** The data folder, resolved exactly like server/config.ts does. */
export function dataDir(env: Env = process.env): string {
  return resolve(expandHome(env.THIRDWHEEL_DATA || join(ROOT, 'data')));
}

/** "https://x.app.space/" -> "https://x.app.space"; anything that is not an http(s) URL -> null. */
export function normalizeBaseUrl(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function secret(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  return s || null;
}

export function integrationsConfigFromEnv(env: Env = process.env): IntegrationsConfig {
  const pushHz = num(env.DS_PUSH_HZ, CONTRACT.pushHz, 1, 10);
  const t = CONTRACT.guideTimeoutMs;
  return {
    deepspace: {
      url: normalizeBaseUrl(env.DS_URL),
      key: secret(env.DS_KEY),
      pushHz,
      idleHz: Math.min(pushHz, num(env.DS_IDLE_HZ, pushHz, 1, 10)),
      pushTimeoutMs: num(env.DS_PUSH_TIMEOUT_MS, CONTRACT.pushTimeoutMs, 200, 10_000),
      notesIntervalMs: num(env.DS_NOTES_MS, CONTRACT.notesIntervalMs, 500, 60_000),
      notesTimeoutMs: num(env.DS_NOTES_TIMEOUT_MS, 2500, 200, 10_000),
      notesPostTimeoutMs: num(env.DS_NOTES_POST_TIMEOUT_MS, 4000, 200, 15_000),
      maxPeople: CONTRACT.maxPeople,
    },
    guide: {
      url: normalizeBaseUrl(env.GUIDE_URL),
      key: secret(env.GUIDE_KEY),
      timeouts: {
        describe: num(env.GUIDE_DESCRIBE_TIMEOUT_MS, t.describe, 500, 30_000),
        hotspots: num(env.GUIDE_HOTSPOTS_TIMEOUT_MS, t.hotspots, 500, 60_000),
        narrate: num(env.GUIDE_NARRATE_TIMEOUT_MS, t.narrate, 500, 60_000),
        ask: num(env.GUIDE_ASK_TIMEOUT_MS, t.ask, 500, 60_000),
        health: t.health,
      },
      maxBodyBytes: 12 * 1024 * 1024,
      maxImageBytes: 8 * 1024 * 1024,
      maxAudioBytes: 4 * 1024 * 1024,
    },
    publicUrlFile: resolve(expandHome(env.TUNNEL_URL_FILE || join(dataDir(env), 'public-url.txt'))),
  };
}

/** The public https BASE written by scripts/tunnel.ts, or null when no tunnel is running. */
export async function readPublicUrl(file = integrationsConfigFromEnv().publicUrlFile): Promise<string | null> {
  try {
    return normalizeBaseUrl(await Bun.file(file).text());
  } catch {
    return null;
  }
}

/** Host part only, for logs and status pages (never the key, never a query string). */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared plumbing: one JSON call with a hard timeout, classified so callers can back off on the right things.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CallKind =
  /** 2xx with a JSON body. */
  | 'ok'
  /** Any other status with a JSON body (the service answered and said no). */
  | 'http'
  /** Could not connect (refused, DNS, reset). */
  | 'offline'
  /** No answer within the timeout. */
  | 'timeout'
  /** An answer that is not JSON: an HTML error page from the tunnel, a proxy, or a crashed service. */
  | 'bad-response';

export interface CallResult {
  kind: CallKind;
  status: number;
  /** Parsed JSON body (kind ok or http), else null. */
  body: any;
  /** Raw body text when one arrived (lets a proxy pass large bodies through without re-encoding them). */
  text: string | null;
  ms: number;
  /** Short technical reason for logs. */
  detail?: string;
}

/** Largest response we read from a teammate's service (a spoken answer is about 50 KB per second of WAV). */
export const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * fetch with a timeout that covers connecting, waiting and reading the body. Never throws.
 * `signal` (optional) cancels early, e.g. when the headset hangs up.
 */
export async function callJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs: number; maxBytes?: number },
): Promise<CallResult> {
  const t0 = performance.now();
  const { timeoutMs, maxBytes = MAX_RESPONSE_BYTES, signal: outer, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([timeout, outer]) : timeout;
  const ms = () => Math.round(performance.now() - t0);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, signal });
  } catch (e) {
    if (isTimeout(e) || timeout.aborted) return { kind: 'timeout', status: 0, body: null, text: null, ms: ms(), detail: 'timed out' };
    const err = e as { code?: string; message?: string };
    return { kind: 'offline', status: 0, body: null, text: null, ms: ms(), detail: String(err?.code || err?.message || e).slice(0, 160) };
  }
  let text: string | null;
  try {
    text = await readCapped(res, maxBytes);
  } catch (e) {
    if (isTimeout(e) || timeout.aborted) return { kind: 'timeout', status: res.status, body: null, text: null, ms: ms(), detail: 'timed out reading the body' };
    return { kind: 'offline', status: res.status, body: null, text: null, ms: ms(), detail: `body: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  if (text === null) return { kind: 'bad-response', status: res.status, body: null, text: null, ms: ms(), detail: 'response too large' };
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const head = text.trimStart().slice(0, 1);
  if (type.includes('text/html') || head === '<') {
    return { kind: 'bad-response', status: res.status, body: null, text, ms: ms(), detail: `HTML instead of JSON (HTTP ${res.status})` };
  }
  let body: any = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'bad-response', status: res.status, body: null, text, ms: ms(), detail: `not JSON (HTTP ${res.status})` };
    }
  }
  return { kind: res.ok ? 'ok' : 'http', status: res.status, body, text, ms: ms() };
}

/** Exponential backoff: 1, 2, 4 ... capped. `failures` counts from 1. */
export function backoffMs(failures: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, failures - 1));
}

/** Logs a message the first time a key is seen, then stays quiet until reset (no log spam at 4 Hz). */
export function onceLogger(log: Logger) {
  const seen = new Set<string>();
  return {
    warn(key: string, msg: string) {
      if (seen.has(key)) return;
      seen.add(key);
      log.warn(msg);
    },
    reset(prefix?: string) {
      if (!prefix) return seen.clear();
      for (const k of [...seen]) if (k.startsWith(prefix)) seen.delete(k);
    },
  };
}
