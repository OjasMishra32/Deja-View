// Sign-in for the pages that add memories or drive the headset (capture, /host), with Auth0 Universal Login:
// authorization code + PKCE in the browser, no client secret, no SDK. When the server says sign-in is off
// (GET /api/auth/config -> {enabled:false}), everything here is a no-op and requests go out as before.
//
// The access token lives in sessionStorage (this tab only) and is sent as `Authorization: Bearer`. A page calls
// `await auth.ready()` once on load: it finishes a sign-in that just came back from Auth0 (?code=&state=) and cleans
// the address bar.

export interface AuthConfig {
  enabled: boolean;
  domain?: string;
  clientId?: string;
  audience?: string;
}

export interface SignedIn {
  accessToken: string;
  /** Unix ms. */
  expiresAt: number;
  name: string;
}

const KEY = 'dv.auth';
const PENDING = 'dv.auth.pending';

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read<T>(k: string): T | null {
  try {
    const raw = store()?.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(k: string, v: unknown | null): void {
  try {
    if (v === null) store()?.removeItem(k);
    else store()?.setItem(k, JSON.stringify(v));
  } catch {}
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function randomString(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** The display name in an ID token (read only for display; the server checks the access token itself). */
function nameFromIdToken(idToken: string | undefined): string {
  try {
    const payload = JSON.parse(atob(idToken!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return String(payload.name || payload.nickname || payload.email || 'Signed in');
  } catch {
    return 'Signed in';
  }
}

let configPromise: Promise<AuthConfig> | null = null;

export function authConfig(): Promise<AuthConfig> {
  configPromise ??= fetch('/api/auth/config', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<AuthConfig>) : { enabled: false }))
    .catch(() => ({ enabled: false }));
  return configPromise;
}

/** The current sign-in, or null (signed out, expired, or sign-in is off). */
export function current(): SignedIn | null {
  const s = read<SignedIn>(KEY);
  if (!s || s.expiresAt - 60_000 < Date.now()) return null;
  return s;
}

/** Headers to add to a request that changes something. Empty when signed out or sign-in is off. */
export function authHeaders(): Record<string, string> {
  const s = current();
  return s ? { Authorization: `Bearer ${s.accessToken}` } : {};
}

/** Sends the browser to Auth0. Comes back to this page; `ready()` finishes the job. */
export async function signIn(): Promise<void> {
  const cfg = await authConfig();
  if (!cfg.enabled || !cfg.domain || !cfg.clientId) return;
  const verifier = randomString(48);
  const state = randomString(16);
  const redirectUri = location.origin + location.pathname;
  write(PENDING, { verifier, state, redirectUri, back: location.search + location.hash });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    audience: cfg.audience ?? '',
    scope: 'openid profile email',
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
  });
  location.assign(`https://${cfg.domain}/authorize?${q}`);
}

export async function signOut(): Promise<void> {
  write(KEY, null);
  const cfg = await authConfig();
  if (!cfg.enabled || !cfg.domain || !cfg.clientId) return;
  const q = new URLSearchParams({ client_id: cfg.clientId, returnTo: location.origin + location.pathname });
  location.assign(`https://${cfg.domain}/v2/logout?${q}`);
}

/**
 * Finishes a sign-in that just came back from Auth0, if this page load is one. Returns the sign-in (or null) and an
 * error sentence when the exchange failed.
 */
export async function ready(): Promise<{ user: SignedIn | null; error: string | null }> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const pending = read<{ verifier: string; state: string; redirectUri: string; back: string }>(PENDING);
  if (!state || (!code && !params.get('error')) || !pending) return { user: current(), error: null };

  write(PENDING, null);
  history.replaceState(null, '', location.pathname + (pending.back || ''));
  if (params.get('error')) return { user: null, error: params.get('error_description') || 'Sign-in was cancelled.' };
  if (state !== pending.state) return { user: null, error: 'That sign-in link is stale. Sign in again.' };

  const cfg = await authConfig();
  if (!cfg.enabled || !cfg.domain || !cfg.clientId) return { user: null, error: null };
  try {
    const res = await fetch(`https://${cfg.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code_verifier: pending.verifier,
        code,
        redirect_uri: pending.redirectUri,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; id_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) return { user: null, error: body.error_description || 'Sign-in did not go through. Try again.' };
    const user: SignedIn = {
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      name: nameFromIdToken(body.id_token),
    };
    write(KEY, user);
    return { user, error: null };
  } catch {
    return { user: null, error: 'Could not reach the sign-in service. Check the connection and try again.' };
  }
}
