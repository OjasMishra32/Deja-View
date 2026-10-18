// Memory Keys (server/auth/memory-keys.ts): private memories with an owner, guests and a knock on the door, the
// world-file gate, memory passes, and what the guide is told about who is asking. A fake verifier stands in for
// Auth0: "Bearer u:<sub>:<name>:<email>".
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth0Verifier } from '../server/auth/auth0.ts';
import { createMemoryKeys, type MemoryKeys } from '../server/auth/memory-keys.ts';
import { createGuideProxy, type GuideClient } from '../server/integrations/guide.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const fakeVerifier: Auth0Verifier = {
  config: { domain: 'test.auth0.com', clientId: 'c', audience: 'https://dejaview/api' },
  async verify() {
    return { ok: false, reason: 'unused' };
  },
  async fromRequest(req: Request) {
    const h = req.headers.get('authorization') ?? '';
    const m = /^Bearer u:([^:]+):([^:]*):([^:]*)$/.exec(h);
    if (!m) return h ? { ok: false as const, reason: 'bad token' } : null;
    return { ok: true as const, user: { sub: m[1]!, name: m[2] || undefined, email: m[3] || undefined } };
  },
};

const OWNER = 'Bearer u:auth0|seb:Seb:seb@example.com';
const FRIEND = 'Bearer u:auth0|judge:Judge:judge@example.com';
const OTHER = 'Bearer u:auth0|other:Other:';
const REMOTE = { local: false };
const LOCAL = { local: true };

async function setup(opts: { now?: () => number; admins?: string[] } = {}): Promise<{ keys: MemoryKeys; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dv-keys-'));
  roots.push(root);
  for (const id of ['old-home', 'the-courts']) {
    await mkdir(join(root, 'scenes', id), { recursive: true });
    await writeFile(join(root, 'scenes', id, 'world.spz'), 'SPZ');
  }
  const keys = createMemoryKeys({
    sceneDir: (id) => join(root, 'scenes', id),
    sceneExists: async (id) => existsSync(join(root, 'scenes', id)),
    verifier: fakeVerifier,
    secret: 'test-secret',
    admins: opts.admins,
    now: opts.now,
  });
  return { keys, root };
}

function req(method: string, path: string, auth?: string, body?: unknown, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://deja-view.photo${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call(keys: MemoryKeys, r: Request, facts = REMOTE): Promise<{ status: number; body: any; res: Response }> {
  const res = (await keys.handle(r, facts))!;
  return { status: res.status, body: await res.json(), res };
}

/** Makes old-home private and owned by Seb (claimed from the host laptop). */
async function privateHome(keys: MemoryKeys): Promise<void> {
  expect((await call(keys, req('POST', '/api/memory/old-home/claim', OWNER), LOCAL)).status).toBe(200);
  expect((await call(keys, req('PUT', '/api/memory/old-home', OWNER, { private: true }))).body.visibility).toBe('private');
}

describe('memory keys', () => {
  test('every memory starts public and unowned; nothing changes for existing worlds', async () => {
    const { keys } = await setup();
    expect(await keys.roleOf('the-courts', null)).toEqual({ role: 'anonymous', visibility: 'public' });
    expect(await keys.gate(req('GET', '/data/scenes/the-courts/world.spz'), REMOTE)).toBeNull();
    const r = await call(keys, req('GET', '/api/memory/the-courts'));
    expect(r.body).toMatchObject({ visibility: 'public', role: 'anonymous', owner: null });
    expect(await keys.guideAccess(req('POST', '/api/guide/ask'), 'the-courts', REMOTE)).toBeUndefined();
  });

  test('claiming: from the host laptop or by an admin, once', async () => {
    const { keys } = await setup({ admins: ['seb@example.com'] });
    expect((await call(keys, req('POST', '/api/memory/old-home/claim', FRIEND))).status).toBe(403); // not local, not admin
    expect((await call(keys, req('POST', '/api/memory/old-home/claim', OWNER))).status).toBe(200); // admin email
    expect((await call(keys, req('POST', '/api/memory/old-home/claim', OTHER), LOCAL)).status).toBe(409);
    expect((await call(keys, req('POST', '/api/memory/old-home/claim'), LOCAL)).status).toBe(401); // signed out
    expect((await call(keys, req('GET', '/api/memory/nope'))).status).toBe(404);
  });

  test('only the owner makes a memory private, and then its files are only for members', async () => {
    const { keys, root } = await setup();
    expect((await call(keys, req('POST', '/api/memory/old-home/claim', OWNER), LOCAL)).status).toBe(200);
    expect((await call(keys, req('PUT', '/api/memory/old-home', FRIEND, { private: true }))).status).toBe(403);
    await privateHome(keys);
    const file = '/data/scenes/old-home/world.spz';
    expect((await keys.gate(req('GET', file), REMOTE))!.status).toBe(403);
    expect((await keys.gate(req('GET', file, FRIEND), REMOTE))!.status).toBe(403);
    expect(await keys.gate(req('GET', file, OWNER), REMOTE)).toBeNull();
    expect(await keys.gate(req('GET', file), LOCAL)).toBeNull(); // the host laptop and its scripts
    expect(await keys.gate(req('GET', '/data/scenes/the-courts/world.spz'), REMOTE)).toBeNull(); // others untouched
    // the keys live beside data/scenes, never in a served scene folder
    expect(existsSync(join(root, 'memory-keys', 'old-home.json'))).toBe(true);
    expect(existsSync(join(root, 'scenes', 'old-home', 'memory-keys.json'))).toBe(false);
  });

  test('knock to enter: the visitor knocks, the owner allows, the visitor walks in', async () => {
    const { keys } = await setup();
    await privateHome(keys);
    expect((await call(keys, req('POST', '/api/memory/old-home/knock'))).status).toBe(401); // sign in to knock
    const k = await call(keys, req('POST', '/api/memory/old-home/knock', FRIEND));
    expect(k.status).toBe(201);
    expect(k.body.knock.status).toBe('pending');
    expect((await call(keys, req('POST', '/api/memory/old-home/knock', FRIEND))).body.knock.id).toBe(k.body.knock.id);
    // the visitor sees their knock waiting, not the guest list
    const mine = await call(keys, req('GET', '/api/memory/old-home', FRIEND));
    expect(mine.body).toMatchObject({ role: 'visitor', visibility: 'private', owner: 'Seb', knock: { status: 'pending' } });
    expect(mine.body.guests).toBeUndefined();
    // the owner sees it on their phone
    const panel = await call(keys, req('GET', '/api/memory', OWNER));
    expect(panel.body.memories[0].knocks).toEqual([expect.objectContaining({ id: k.body.knock.id, name: 'Judge' })]);
    expect((await call(keys, req('POST', `/api/memory/old-home/knocks/${k.body.knock.id}`, FRIEND, { allow: true }))).status).toBe(403);
    const allowed = await call(keys, req('POST', `/api/memory/old-home/knocks/${k.body.knock.id}`, OWNER, { allow: true }));
    expect(allowed.body.guests.map((g: any) => g.name)).toEqual(['Judge']);
    expect(allowed.body.knocks).toEqual([]);
    expect((await call(keys, req('POST', `/api/memory/old-home/knocks/${k.body.knock.id}`, OWNER, { allow: true }))).status).toBe(409);
    expect((await call(keys, req('GET', '/api/memory/old-home', FRIEND))).body).toMatchObject({ role: 'guest', knock: { status: 'allowed' } });
    expect(await keys.gate(req('GET', '/data/scenes/old-home/world.spz', FRIEND), REMOTE)).toBeNull();
  });

  test('a declined knock lets nobody in', async () => {
    const { keys } = await setup();
    await privateHome(keys);
    const k = await call(keys, req('POST', '/api/memory/old-home/knock', OTHER));
    await call(keys, req('POST', `/api/memory/old-home/knocks/${k.body.knock.id}`, OWNER, { allow: false }));
    expect((await call(keys, req('GET', '/api/memory/old-home', OTHER))).body).toMatchObject({ role: 'visitor', knock: { status: 'declined' } });
    expect((await keys.gate(req('GET', '/data/scenes/old-home/world.spz', OTHER), REMOTE))!.status).toBe(403);
  });

  test('memory passes carry a member to the world files, and stop with their membership', async () => {
    let t = Date.parse('2026-10-18T03:00:00Z');
    const { keys } = await setup({ now: () => t });
    await privateHome(keys);
    expect((await call(keys, req('POST', '/api/memory/old-home/pass', FRIEND))).status).toBe(403); // not a member yet
    const k = await call(keys, req('POST', '/api/memory/old-home/knock', FRIEND));
    await call(keys, req('POST', `/api/memory/old-home/knocks/${k.body.knock.id}`, OWNER, { allow: true }));
    const pass = await call(keys, req('POST', '/api/memory/old-home/pass', FRIEND));
    const setCookie = pass.res.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    const cookie = setCookie.split(';')[0]!;
    const file = '/data/scenes/old-home/world.spz';
    expect(await keys.gate(req('GET', file, undefined, undefined, cookie), REMOTE)).toBeNull(); // no header: the cookie
    const forged = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await keys.gate(req('GET', file, undefined, undefined, forged), REMOTE))!.status).toBe(403);
    expect((await keys.gate(req('GET', '/data/scenes/the-courts/world.spz', undefined, undefined, cookie), REMOTE))).toBeNull();
    // removed as a guest: the same pass stops working at once
    await call(keys, req('POST', '/api/memory/old-home/guests/remove', OWNER, { sub: 'auth0|judge' }));
    expect((await keys.gate(req('GET', file, undefined, undefined, cookie), REMOTE))!.status).toBe(403);
    // and passes expire
    const ownerPass = (await call(keys, req('POST', '/api/memory/old-home/pass', OWNER))).res.headers.get('set-cookie')!.split(';')[0]!;
    expect(await keys.gate(req('GET', file, undefined, undefined, ownerPass), REMOTE)).toBeNull();
    t += 13 * 3600 * 1000;
    expect((await keys.gate(req('GET', file, undefined, undefined, ownerPass), REMOTE))!.status).toBe(403);
  });

  test('the guide is told family or visitor, from the sign-in, never from the page', async () => {
    const { keys } = await setup();
    await privateHome(keys);
    const ask = (auth?: string) => req('POST', '/api/guide/ask', auth);
    expect(await keys.guideAccess(ask(OWNER), 'old-home', REMOTE)).toBe('family');
    expect(await keys.guideAccess(ask(FRIEND), 'old-home', REMOTE)).toBe('visitor');
    expect(await keys.guideAccess(ask(), 'old-home', REMOTE)).toBe('visitor');

    const sent: any[] = [];
    const client: GuideClient = {
      enabled: true,
      async call(_name, body) {
        sent.push(JSON.parse(JSON.stringify(body)));
        return { kind: 'ok', status: 200, body: { answer: 'hi' }, text: '{"answer":"hi"}', ms: 5 } as any;
      },
      async health() {
        return { kind: 'ok', status: 200, body: {}, text: '{}', ms: 1 } as any;
      },
      isDown: () => false,
      status: () => ({}) as any,
      startMonitor() {},
      close() {},
    };
    const proxy = createGuideProxy({
      client,
      config: { maxBodyBytes: 1e6, maxImageBytes: 1e6, maxAudioBytes: 1e6, timeouts: { ask: 1000, narrate: 1000, hotspots: 1000, describe: 1000 } as any },
      getScene: async (id) => ({ id, name: id, mode: 'thirdwheel', status: 'ready' }) as any,
      viewerAccess: (r, id) => keys.guideAccess(r, id, REMOTE),
    });
    const body = (scene: unknown) => JSON.stringify({ question: 'who is that?', scene });
    // the page claims to be family: the server decides it is a visitor
    await proxy.handle('ask', new Request('https://x/api/guide/ask', { method: 'POST', body: body({ id: 'old-home', viewer: { access: 'family' } }) }));
    expect(sent.at(-1).scene.viewer).toEqual({ access: 'visitor' });
    await proxy.handle('ask', new Request('https://x/api/guide/ask', { method: 'POST', headers: { authorization: OWNER }, body: body({ id: 'old-home' }) }));
    expect(sent.at(-1).scene.viewer).toEqual({ access: 'family' });
    await proxy.handle('ask', new Request('https://x/api/guide/ask', { method: 'POST', body: body({ id: 'the-courts' }) }));
    expect(sent.at(-1).scene.viewer).toBeUndefined(); // a public memory: no restriction
  });
});
