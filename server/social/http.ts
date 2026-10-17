// Small HTTP helpers shared by the presence and Roblox routes: JSON responses with CORS, a size-capped JSON body
// reader, the DV_KEY check and "is this request really from this machine".

import { timingSafeEqual } from 'node:crypto';

/** CORS for the social routes: browsers (a phone viewer, the DeepSpace page) may read and post. */
export const SOCIAL_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-DejaView-Key, If-None-Match, Accept-Encoding',
  'Access-Control-Expose-Headers': 'ETag, Retry-After, Content-Length, Content-Encoding',
  'Access-Control-Max-Age': '86400',
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SOCIAL_CORS, ...headers },
  });
}

/** `{ "error": "<a sentence a person understands>" }` plus any extra fields (contracts 3.4). */
export function fail(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ error, ...extra }, status, headers);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: SOCIAL_CORS });
}

export function methodNotAllowed(allow: string): Response {
  return fail(405, "That action isn't supported here.", {}, { Allow: allow });
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/**
 * Reads a JSON body of at most `maxBytes` (a larger body is refused without reading all of it). Any content type
 * is accepted: Roblox and curl both send JSON, and a missing header should not cost a person their ghost.
 */
export async function readJson(req: Request, maxBytes: number): Promise<BodyResult> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, error: 'That request is too big.' };
  if (!req.body) return { ok: false, status: 400, error: 'The request needs a JSON body.' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'That request is too big.' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "The request didn't arrive in one piece." };
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (!text.trim()) return { ok: false, status: 400, error: 'The request needs a JSON body.' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "The request body isn't valid JSON." };
  }
}

/** Anything that can tell us the peer address of a request (Bun's Server). */
export interface RequestIpSource {
  requestIP(req: Request): { address: string } | null;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

/**
 * True for a request made on this machine (the bot, curl, tests). A request that came through the public tunnel also
 * arrives from 127.0.0.1, so any proxy header makes it count as remote.
 */
export function isLocalRequest(req: Request, server?: RequestIpSource | null): boolean {
  for (const h of PROXY_HEADERS) if (req.headers.has(h)) return false;
  let addr: string | undefined;
  try {
    addr = server?.requestIP(req)?.address;
  } catch {
    addr = undefined;
  }
  return !!addr && LOOPBACK.has(addr);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * DV_KEY (contracts 2.2): checked on /api/roblox/* only when a key is configured; requests from this machine skip it.
 * Returns a 401 response when the key is wrong or missing, else null.
 */
export function keyRejected(req: Request, key: string | null | undefined, server?: RequestIpSource | null): Response | null {
  if (!key) return null;
  if (isLocalRequest(req, server)) return null;
  const given = req.headers.get('x-dejaview-key') ?? '';
  if (given && safeEqual(given.trim(), key)) return null;
  return fail(401, 'Bad key');
}

/** Scene ids, exactly the server's own rule (contracts 3.4). */
export const SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

/** The decoded path segment at `index` (0-based, after splitting on "/"), or null. */
export function pathSegment(req: Request, index: number): string | null {
  try {
    const parts = new URL(req.url).pathname.split('/');
    const raw = parts[index];
    return raw === undefined ? null : decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A finite number rounded to `dp` decimals (and -0 turned into 0). */
export function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f + 0;
}
