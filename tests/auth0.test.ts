// Auth0 access-token checks against a key pair made here and a fake JWKS endpoint (no network, no tenant).

import { beforeAll, describe, expect, test } from 'bun:test';
import { auth0ConfigFromEnv, bearerToken, createAuth0Verifier, publicAuthConfig, type Auth0Config } from '../server/auth/auth0.ts';

const config: Auth0Config = { domain: 'dejaview.us.auth0.com', clientId: 'spa-client', audience: 'https://dejaview/api' };
const NOW = 1_792_300_000;

let priv: CryptoKey;
let pubJwk: JsonWebKey;
let otherPriv: CryptoKey;

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}): Promise<string> {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? priv, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

const good = (extra: Record<string, unknown> = {}) => ({
  iss: `https://${config.domain}/`,
  aud: [config.audience, `https://${config.domain}/userinfo`],
  sub: 'google-oauth2|123',
  exp: NOW + 3600,
  iat: NOW - 10,
  scope: 'openid profile email',
  'https://dejaview/name': 'Judge Person',
  ...extra,
});

function jwksFetch(counter = { n: 0 }, kids = ['k1']) {
  return async (url: string) => {
    counter.n++;
    expect(url).toBe(`https://${config.domain}/.well-known/jwks.json`);
    return Response.json({ keys: kids.map((kid) => ({ ...pubJwk, kid, use: 'sig', alg: 'RS256' })) });
  };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  priv = pair.privateKey;
  pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const other = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  otherPriv = other.privateKey;
});

describe('auth0 verifier', () => {
  test('accepts a good token and reads the namespaced name', async () => {
    const v = createAuth0Verifier({ config, fetch: jwksFetch(), now: () => NOW });
    const r = await v.verify(await sign(good()));
    expect(r).toEqual({ ok: true, user: { sub: 'google-oauth2|123', name: 'Judge Person', scope: 'openid profile email' } });
  });

  test('refuses forged, foreign, stale and malformed tokens', async () => {
    const v = createAuth0Verifier({ config, fetch: jwksFetch(), now: () => NOW });
    const reason = async (t: string) => {
      const r = await v.verify(t);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await reason(await sign(good(), { key: otherPriv }))).toBe('bad signature');
    expect(await reason(await sign(good({ iss: 'https://evil.example/' })))).toBe('wrong issuer');
    expect(await reason(await sign(good({ aud: 'https://someone-else/api' })))).toBe('wrong audience');
    expect(await reason(await sign(good({ exp: NOW - 120 })))).toBe('expired');
    expect(await reason(await sign(good({ exp: NOW - 30 })))).toBe('ok'); // inside the 60 s leeway
    expect(await reason(await sign(good({ nbf: NOW + 600 })))).toBe('not valid yet');
    expect(await reason(await sign(good(), { alg: 'HS256' }))).toBe('algorithm HS256 not accepted');
    expect(await reason(await sign(good(), { kid: 'nope' }))).toBe('unknown key id');
    expect(await reason('a.b')).toBe('not a JWT');
    // alg "none" with the signature stripped
    const [h, b] = (await sign(good())).split('.');
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b}.`;
    expect(await reason(none)).toBe('algorithm none not accepted');
    expect(h).toBeTruthy();
  });

  test('caches the key set, and refetches at most once a minute for an unknown key id', async () => {
    const counter = { n: 0 };
    const v = createAuth0Verifier({ config, fetch: jwksFetch(counter), now: () => NOW });
    for (let i = 0; i < 5; i++) expect((await v.verify(await sign(good()))).ok).toBe(true);
    expect(counter.n).toBe(1);
    await v.verify(await sign(good(), { kid: 'rotated' }));
    await v.verify(await sign(good(), { kid: 'rotated' }));
    expect(counter.n).toBe(2);
  });

  test('a key set that cannot be loaded is a refusal, not a crash', async () => {
    const v = createAuth0Verifier({ config, fetch: async () => new Response('nope', { status: 503 }), now: () => NOW });
    const r = await v.verify(await sign(good()));
    expect(r).toEqual({ ok: false, reason: 'cannot load the sign-in keys: key set answered 503' });
  });

  test('fromRequest reads only a JWT-shaped bearer token', async () => {
    const v = createAuth0Verifier({ config, fetch: jwksFetch(), now: () => NOW });
    const t = await sign(good());
    expect(await v.fromRequest(new Request('http://x/', { headers: { Authorization: `Bearer ${t}` } }))).toMatchObject({ ok: true });
    expect(await v.fromRequest(new Request('http://x/'))).toBeNull();
    // the API token from .env is not a JWT and is left to the guard
    expect(bearerToken(new Request('http://x/', { headers: { Authorization: 'Bearer plain-api-token' } }))).toBeNull();
  });
});

describe('auth0 config', () => {
  test('off when nothing is set, all three or an error, the domain normalised', () => {
    expect(auth0ConfigFromEnv({})).toBeNull();
    expect(() => auth0ConfigFromEnv({ AUTH0_DOMAIN: 'x.auth0.com' })).toThrow(/all three/);
    expect(auth0ConfigFromEnv({ AUTH0_DOMAIN: 'https://x.us.auth0.com/', AUTH0_CLIENT_ID: 'c', AUTH0_AUDIENCE: 'a' })).toEqual({
      domain: 'x.us.auth0.com',
      clientId: 'c',
      audience: 'a',
    });
    expect(publicAuthConfig(null)).toEqual({ enabled: false });
    expect(publicAuthConfig(config)).toEqual({ enabled: true, ...config });
  });
});
