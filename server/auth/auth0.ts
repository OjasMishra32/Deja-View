// Sign-in with Auth0 for the public link. Walking into a memory stays open to everyone; adding a memory, deleting
// one and driving the headset from the /host remote need a signed-in person once the server is reachable from the
// internet. Requests from this machine (the host laptop, scripts, tests) and machine callers holding the API token
// or DV_KEY are not asked.
//
// The pages sign in with Auth0's Universal Login (authorization code + PKCE, no client secret) and send the access
// token as `Authorization: Bearer <jwt>`. This module checks that token: RS256 signature against the tenant's JWKS,
// issuer, audience, expiry. No SDK: WebCrypto does the signature.
//
// Environment (all three, or sign-in stays off):
//   AUTH0_DOMAIN     the tenant, e.g. dejaview.us.auth0.com
//   AUTH0_CLIENT_ID  the Single Page Application's client id (public; the pages need it)
//   AUTH0_AUDIENCE   the API identifier the access tokens are issued for, e.g. https://dejaview/api

export interface Auth0Config {
  domain: string;
  clientId: string;
  audience: string;
}

export interface Auth0User {
  sub: string;
  name?: string;
  email?: string;
  scope?: string;
}

export type VerifyResult = { ok: true; user: Auth0User } | { ok: false; reason: string };

export interface VerifierOptions {
  config: Auth0Config;
  fetch?: (url: string) => Promise<Response>;
  /** Seconds. */
  now?: () => number;
  /** Clock skew allowed on exp/nbf/iat, seconds. Default 60. */
  leeway?: number;
  /** How long a fetched key set is trusted, ms. Default 10 minutes. */
  jwksTtlMs?: number;
}

export interface Auth0Verifier {
  readonly config: Auth0Config;
  verify(token: string): Promise<VerifyResult>;
  /** The bearer token of a request, verified; null when there is none. */
  fromRequest(req: Request): Promise<VerifyResult | null>;
}

/** The config from the environment, or null when sign-in is off. A half-filled config is an error worth seeing. */
export function auth0ConfigFromEnv(env: Record<string, string | undefined> = process.env): Auth0Config | null {
  const domain = (env.AUTH0_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const clientId = (env.AUTH0_CLIENT_ID ?? '').trim();
  const audience = (env.AUTH0_AUDIENCE ?? '').trim();
  if (!domain && !clientId && !audience) return null;
  if (!domain || !clientId || !audience) {
    throw new Error('Sign-in needs AUTH0_DOMAIN, AUTH0_CLIENT_ID and AUTH0_AUDIENCE together. Set all three or none.');
  }
  return { domain, clientId, audience };
}

/** What the pages need to start a sign-in (all public values). */
export function publicAuthConfig(cfg: Auth0Config | null): { enabled: boolean; domain?: string; clientId?: string; audience?: string } {
  return cfg ? { enabled: true, domain: cfg.domain, clientId: cfg.clientId, audience: cfg.audience } : { enabled: false };
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer\s+([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)$/.exec(h.trim()) : null;
  return m ? m[1]! : null;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const raw = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  out.set(raw);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export function createAuth0Verifier(opts: VerifierOptions): Auth0Verifier {
  const { config } = opts;
  const doFetch = opts.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(5000) }));
  const now = opts.now ?? (() => Date.now() / 1000);
  const leeway = opts.leeway ?? 60;
  const ttl = opts.jwksTtlMs ?? 600_000;
  const issuer = `https://${config.domain}/`;
  const jwksUrl = `https://${config.domain}/.well-known/jwks.json`;

  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;
  let inflight: Promise<void> | null = null;
  let lastForced = 0;

  async function loadKeys(): Promise<void> {
    const res = await doFetch(jwksUrl);
    if (!res.ok) throw new Error(`key set answered ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, CryptoKey>();
    for (const k of body.keys ?? []) {
      if (k.kty !== 'RSA' || !k.kid || !k.n || !k.e || (k.use && k.use !== 'sig')) continue;
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      next.set(k.kid, key);
    }
    keys = next;
    fetchedAt = Date.now();
  }

  /** The key for `kid`; refetches when the set is stale, or once a minute for a kid we have not seen (key rotation). */
  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const never = fetchedAt === 0;
    const stale = !never && Date.now() - fetchedAt > ttl;
    const unknown = !never && !keys.has(kid) && Date.now() - lastForced > 60_000;
    if (never || stale || unknown) {
      if (unknown) lastForced = Date.now();
      inflight ??= loadKeys().finally(() => (inflight = null));
      try {
        await inflight;
      } catch (e) {
        if (!keys.size) throw e;
      }
    }
    return keys.get(kid) ?? null;
  }

  async function verify(token: string): Promise<VerifyResult> {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
    const header = b64urlJson(parts[0]!);
    const claims = b64urlJson(parts[1]!);
    if (!header || !claims) return { ok: false, reason: 'unreadable token' };
    if (header.alg !== 'RS256') return { ok: false, reason: `algorithm ${String(header.alg)} not accepted` };
    if (typeof header.kid !== 'string') return { ok: false, reason: 'no key id' };
    let key: CryptoKey | null;
    try {
      key = await keyFor(header.kid);
    } catch (e) {
      return { ok: false, reason: `cannot load the sign-in keys: ${(e as Error).message}` };
    }
    if (!key) return { ok: false, reason: 'unknown key id' };
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]!), signed);
    if (!good) return { ok: false, reason: 'bad signature' };
    if (claims.iss !== issuer) return { ok: false, reason: 'wrong issuer' };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(config.audience)) return { ok: false, reason: 'wrong audience' };
    const t = now();
    if (typeof claims.exp !== 'number' || claims.exp + leeway < t) return { ok: false, reason: 'expired' };
    if (typeof claims.nbf === 'number' && claims.nbf - leeway > t) return { ok: false, reason: 'not valid yet' };
    if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'no subject' };
    const user: Auth0User = { sub: claims.sub };
    // Auth0 puts profile fields in the access token only through a namespaced custom claim; take either spelling
    for (const [k, v] of Object.entries(claims)) {
      if (typeof v !== 'string') continue;
      if (k === 'name' || k.endsWith('/name')) user.name ??= v;
      if (k === 'email' || k.endsWith('/email')) user.email ??= v;
    }
    if (typeof claims.scope === 'string') user.scope = claims.scope;
    return { ok: true, user };
  }

  return {
    config,
    verify,
    async fromRequest(req) {
      const token = bearerToken(req);
      return token ? verify(token) : null;
    },
  };
}

export type AuthHandler = (req: Request, server?: { requestIP(req: Request): { address: string } | null }) => Promise<Response>;

/**
 * GET /api/auth/config: what the pages need to start a sign-in (`{enabled:false}` when sign-in is off), and
 * GET /api/auth/me: who the bearer token belongs to (401 when signed out or the token is bad).
 */
export function createAuthRoutes(verifier: Auth0Verifier | null): Record<string, AuthHandler> {
  const headers = { 'Cache-Control': 'no-store' };
  return {
    '/api/auth/config': async () => Response.json(publicAuthConfig(verifier?.config ?? null), { headers }),
    '/api/auth/me': async (req) => {
      if (!verifier) return Response.json({ error: 'Sign-in is off on this server.' }, { status: 404, headers });
      const r = await verifier.fromRequest(req);
      if (!r?.ok) return Response.json({ error: 'Not signed in.' }, { status: 401, headers });
      return Response.json({ user: r.user }, { headers });
    },
  };
}

/**
 * For the routes that add, delete or drive things: null when the request may go ahead, else a 401 to return.
 * Sign-in off, a request from this machine, or a request the API token or DV_KEY already let through (`trusted`)
 * pass; everyone else needs a valid access token.
 */
export async function signInRequired(
  req: Request,
  verifier: Auth0Verifier | null,
  opts: { local: boolean; trusted?: boolean },
): Promise<Response | null> {
  if (!verifier || opts.local || opts.trusted) return null;
  const r = await verifier.fromRequest(req);
  if (r?.ok) return null;
  return Response.json(
    { error: 'Sign in to do that.', signIn: true },
    { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' } },
  );
}
