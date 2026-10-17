// The sponsor pieces as server/index.ts wires them: the scoreboard, tab, replay and auth routes and pages, and Auth0
// sign-in in front of the routes that add, delete or drive things. Two real server processes on one temporary data
// folder: one with sign-in on (a made-up tenant: no token is ever checked against it, so nothing goes out), and a
// read-only one next to it with sign-in off. "Remote" requests carry x-forwarded-for, as the tunnel's do.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SCENE = 'sponsor-room-aaaaa';
const TOKEN = 'test-api-token';
const DVKEY = 'test-dv-key';
const DOMAIN = 'dejaview-test.us.auth0.com';
const REMOTE = { 'x-forwarded-for': '203.0.113.9' };

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function until<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

interface Proc {
  child: ChildProcess;
  base: string;
  log: string;
}

let data = '';
let main: Proc;
let ro: Proc;

async function boot(extra: Record<string, string>): Promise<Proc> {
  const port = freePort();
  const child = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HTTP_PORT: '0',
      ROBLOX_API_KEY: '',
      ROBLOX_CREATOR_ID: '',
      THIRDWHEEL_DATA: data,
      THIRDWHEEL_HPG: 'off',
      THIRDWHEEL_BACKENDS: 'hpg-worker',
      THIRDWHEEL_HTTPS: '0',
      THIRDWHEEL_READONLY: '',
      DS_URL: '',
      GUIDE_URL: '',
      DV_KEY: DVKEY,
      THIRDWHEEL_API_TOKEN: TOKEN,
      SOLANA_SCOREBOARD: '',
      SOLANA_RPC_URL: '',
      NESSIE_API_KEY: '',
      TIGER_DATA_URL: '',
      AUTH0_DOMAIN: '',
      AUTH0_CLIENT_ID: '',
      AUTH0_AUDIENCE: '',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const p: Proc = { child, base: `http://127.0.0.1:${port}`, log: '' };
  child.stdout!.on('data', (d) => (p.log += d));
  child.stderr!.on('data', (d) => (p.log += d));
  await until(async () => (await fetch(`${p.base}/api/health`).catch(() => null))?.ok, 30_000, `the server (log: ${p.log.slice(-600)})`);
  await until(() => p.log.includes('Extras:'), 10_000, 'the boot log');
  return p;
}

async function stop(p: Proc | undefined): Promise<void> {
  if (!p || p.child.exitCode !== null) return;
  p.child.kill('SIGTERM');
  await until(() => p.child.exitCode !== null || p.child.signalCode !== null, 5000, 'the server to stop').catch(() => p.child.kill('SIGKILL'));
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'tw-sponsors-'));
  const dir = join(data, 'scenes', SCENE);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  // a failed build: nothing at boot works on it (no map, no reality split, no job to resume)
  await writeFile(join(dir, 'scene.json'), JSON.stringify({ id: SCENE, name: 'Sponsor room', mode: 'rentfree', status: 'failed', createdAt: now, updatedAt: now }));
  main = await boot({ AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: 'test-client', AUTH0_AUDIENCE: 'https://dejaview/api' });
  ro = await boot({ THIRDWHEEL_READONLY: '1' });
}, 90_000);

afterAll(async () => {
  await stop(main);
  await stop(ro);
  if (data) await rm(data, { recursive: true, force: true });
});

const call = (p: Proc, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${p.base}${path}`, { redirect: 'manual', ...init });

describe('the sponsor routes and pages', () => {
  test('the boot log says what is on', () => {
    expect(main.log).toContain('scoreboard off');
    expect(main.log).toContain('tab demo bank (NESSIE_API_KEY unset)');
    expect(main.log).toContain('replay off (TIGER_DATA_URL unset)');
    expect(main.log).toContain(`sign-in on (${DOMAIN})`);
    expect(ro.log).toContain('sign-in off');
  });

  test('scoreboard, tab and replay answer, off or on the demo bank', async () => {
    const scores = await (await call(main, '/api/scores')).json();
    expect(scores.enabled).toBe(false);
    expect((await call(main, `/api/scores/${SCENE}`)).status).toBe(200);
    const tab = await call(main, `/api/tab/${SCENE}`);
    expect(tab.status).toBe(200);
    expect((await tab.json()).mode).toBe('demo');
    const status = await (await call(main, '/api/replay/status')).json();
    expect(status.enabled).toBe(false);
    expect((await call(main, `/api/replay/${SCENE}`)).status).toBe(503);
  });

  test('/scores and /tab are pages, and a trailing slash is dropped', async () => {
    for (const path of ['/scores', `/tab?scene=${SCENE}`]) {
      const r = await call(main, path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
    }
    const r = await call(main, '/tab/?scene=x');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/tab?scene=x');
  });

  test('/api/auth/config gives the pages what they need; /api/auth/me wants a token', async () => {
    expect(await (await call(main, '/api/auth/config')).json()).toEqual({ enabled: true, domain: DOMAIN, clientId: 'test-client', audience: 'https://dejaview/api' });
    expect((await call(main, '/api/auth/me')).status).toBe(401);
    expect(await (await call(ro, '/api/auth/config')).json()).toEqual({ enabled: false });
  });
});

describe('sign-in in front of the changes', () => {
  test('deleting, rebuilding and adding a memory from another machine need it', async () => {
    for (const [method, path] of [
      ['DELETE', '/api/scenes/nope-zzzzz'],
      ['POST', `/api/scenes/${SCENE}/retry`],
      ['POST', '/api/scenes'],
    ] as const) {
      const r = await call(main, path, { method, headers: { ...REMOTE, 'Content-Type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'Sign in to do that.', signIn: true });
    }
  });

  test('this machine, the API token and DV_KEY are not asked (the guard still applies after)', async () => {
    // this machine, no token: the guard's own answer, exactly as without sign-in
    expect((await call(main, '/api/scenes/nope-zzzzz', { method: 'DELETE' })).status).toBe(403);
    expect((await call(main, '/api/scenes/nope-zzzzz', { method: 'DELETE', headers: { 'x-dejaview-token': TOKEN } })).status).toBe(404);
    expect((await call(main, '/api/scenes/nope-zzzzz', { method: 'DELETE', headers: { ...REMOTE, 'x-dejaview-token': TOKEN } })).status).toBe(404);
    expect((await call(main, '/api/scenes/nope-zzzzz', { method: 'DELETE', headers: { ...REMOTE, Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    // DV_KEY passes sign-in; without the API token the guard refuses it, as before
    expect((await call(main, '/api/scenes/nope-zzzzz', { method: 'DELETE', headers: { ...REMOTE, 'x-dejaview-key': DVKEY } })).status).toBe(403);
  });

  test('a headset cue from the /host remote needs it, unless the event key comes along', async () => {
    const body = JSON.stringify({ action: 'labels', on: true, by: 'host' });
    const denied = await call(main, '/api/host/cue', { method: 'POST', headers: { ...REMOTE, 'Content-Type': 'application/json' }, body });
    expect(denied.status).toBe(401);
    expect((await denied.json()).signIn).toBe(true);
    const keyed = await call(main, '/api/host/cue', { method: 'POST', headers: { ...REMOTE, 'Content-Type': 'application/json', 'x-dejaview-key': DVKEY }, body });
    expect(keyed.status).toBe(200);
    expect((await call(main, '/api/host/cue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(200);
  });

  test('changing a tab needs it; reading one does not', async () => {
    const body = JSON.stringify({ loserCoversTable: false });
    const page = { Origin: main.base, 'Content-Type': 'application/json' };
    const denied = await call(main, `/api/tab/${SCENE}/rules`, { method: 'POST', headers: { ...REMOTE, ...page }, body });
    expect(denied.status).toBe(401);
    expect((await denied.json()).signIn).toBe(true);
    expect((await call(main, `/api/tab/${SCENE}`, { headers: REMOTE })).status).toBe(200);
    expect((await call(main, `/api/tab/${SCENE}/rules`, { method: 'POST', headers: page, body })).status).toBe(200);
  });
});

describe('read-only next to the main server, exactly as before', () => {
  test('changes are refused with 503 and nothing asks for sign-in', async () => {
    const del = await call(ro, '/api/scenes/nope-zzzzz', { method: 'DELETE', headers: { ...REMOTE, 'x-dejaview-token': TOKEN } });
    expect(del.status).toBe(503);
    const rules = await call(ro, `/api/tab/${SCENE}/rules`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dejaview-token': TOKEN }, body: '{"loserCoversTable":true}' });
    expect(rules.status).toBe(503);
  });

  test('the tab, scoreboard and replay status still read', async () => {
    expect((await call(ro, `/api/tab/${SCENE}`)).status).toBe(200);
    expect((await (await call(ro, '/api/scores')).json()).enabled).toBe(false);
    expect((await (await call(ro, '/api/replay/status')).json()).enabled).toBe(false);
  });
});
