// Who may change things. The server listens on the LAN with no accounts, so state-changing requests (create,
// retry, delete) are accepted only from the app's own pages or with the API token from .env. Without this, any web
// page open on a phone on the same Wi-Fi could delete scenes or queue GPU jobs (a simple multipart POST needs no
// CORS preflight). Reads (GET /api/scenes, GET /data/...) stay open to every origin.

import { timingSafeEqual } from 'node:crypto';
import { API } from './copy.ts';

export interface GuardOptions {
  /** THIRDWHEEL_API_TOKEN: lets scripts and other origins call the API (X-DejaView-Token or Authorization: Bearer). */
  token?: string;
  /** THIRDWHEEL_ALLOWED_ORIGINS: extra origins allowed to change things, comma separated (a tunnel URL, say). */
  allowedOrigins?: string[];
}

export function guardOptionsFromEnv(env: Record<string, string | undefined> = process.env): GuardOptions {
  return {
    token: (env.THIRDWHEEL_API_TOKEN ?? '').trim() || undefined,
    allowedOrigins: (env.THIRDWHEEL_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const NOT_ALLOWED_MESSAGE = API.notAllowed;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(h: string | null): string | null {
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m ? m[1]!.trim() : null;
}

/** True when the Origin is this server itself (same scheme-less host:port the request was sent to). */
function sameHost(origin: string, req: Request): boolean {
  try {
    const o = new URL(origin);
    const host = req.headers.get('host') ?? new URL(req.url).host;
    return o.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** True when a browser page from `origin` may change things: this server's own pages or a configured origin. */
export function originAllowed(origin: string, req: Request, opts: GuardOptions): boolean {
  const o = origin.trim().replace(/\/+$/, '');
  if (!o || o === 'null') return false;
  return sameHost(o, req) || !!opts.allowedOrigins?.includes(o);
}

/** True when a token is configured and the request carries it (X-DejaView-Token or Authorization: Bearer). */
export function hasApiToken(req: Request, opts: GuardOptions): boolean {
  if (!opts.token) return false;
  const given = req.headers.get('x-dejaview-token') ?? bearer(req.headers.get('authorization'));
  return !!given && safeEqual(given, opts.token);
}

/**
 * Why a state-changing request is refused (for the server log), or null when it may go ahead.
 *  - a valid token always passes;
 *  - a browser request passes when its Origin is this server (or listed in allowedOrigins);
 *  - a request with neither Origin nor a cross-site Sec-Fetch-Site is not from a web page (curl, scripts, tests):
 *    it passes unless a token is configured, in which case it must carry the token.
 */
export function mutationBlocked(req: Request, opts: GuardOptions): string | null {
  if (hasApiToken(req, opts)) return null;
  const origin = req.headers.get('origin');
  if (origin !== null) {
    if (originAllowed(origin, req, opts)) return null;
    return `cross-origin request from ${origin.slice(0, 120)}`;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return `cross-site request (Sec-Fetch-Site: ${site})`;
  if (opts.token) return 'no API token';
  return null;
}

/** The same response without any Access-Control-* header, so other origins cannot read it. */
export function withoutCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith('access-control-')) headers.delete(k);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
