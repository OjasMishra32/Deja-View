import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { PresenceStore, type PresenceEvent } from '../server/social/presence.ts';
import { RobloxMapService, type MapBuilder } from '../server/social/roblox.ts';
import { createSocial, createSocialRoutes, type SocialRoutes } from '../server/social/routes.ts';

const ROOT = resolve(import.meta.dir, '..');
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const REMOTE = { requestIP: () => ({ address: '10.0.0.5' }) };
const LOCAL = { requestIP: () => ({ address: '127.0.0.1' }) };

function scene(id: string, extra: Partial<Scene> = {}): Scene {
  return {
    id,
    name: `Room ${id}`,
    mode: 'rentfree',
    status: 'ready',
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    world: { file: 'world.ply', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: -1.2, source: 'other' },
    ...extra,
  };
}

interface Rig {
  dir: string;
  scenes: Map<string, Scene>;
  presence: PresenceStore;
  maps: RobloxMapService;
  routes: SocialRoutes;
  builds: { sceneDir: string; maxParts: number; key: string }[];
  builder: { delayMs: number; fail: boolean };
}

async function rig(opts: { dvKey?: string; waitMs?: number } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tw-social-'));
  roots.push(dir);
  const scenes = new Map<string, Scene>();
  for (const s of [scene('room-a'), scene('busy-b', { status: 'running', world: undefined }), scene('noworld-c', { world: undefined })]) {
    scenes.set(s.id, s);
    await mkdir(join(dir, s.id), { recursive: true });
  }
  await writeFile(join(dir, 'room-a', 'world.ply'), 'ply fake world');
  const builds: Rig['builds'] = [];
  const builderCfg = { delayMs: 0, fail: false };
  const builder: MapBuilder = async ({ sceneDir, out, maxParts, key }) => {
    builds.push({ sceneDir, maxParts, key });
    if (builderCfg.delayMs) await Bun.sleep(builderCfg.delayMs);
    if (builderCfg.fail) throw new Error('synthetic failure');
    const n = Math.min(maxParts, 6001);
    const parts = Array.from({ length: n }, (_, i) => [i % 50, i === 0 ? -0.5 : 1, 0, 1, 1, 1, 120, 104, 90]);
    await writeFile(out, JSON.stringify({ sceneId: 'room-a', name: 'Room room-a', studsPerMeter: 3.57, spawn: [0, 0, 5.4], parts, build: { key } }));
  };
  const getScene = async (id: string) => structuredClone(scenes.get(id) ?? null);
  const presence = new PresenceStore();
  const maps = new RobloxMapService({
    getScene,
    sceneDir: (id) => join(dir, id),
    python: 'unused',
    script: join(ROOT, 'pipeline', 'roblox_map.py'),
    cwd: ROOT,
    builder,
    waitMs: opts.waitMs ?? 1000,
    failureHoldMs: 500,
    log: () => {},
  });
  const routes = createSocialRoutes({ getScene, presence, maps, dvKey: opts.dvKey, sceneCacheMs: 0, log: () => {} });
  return { dir, scenes, presence, maps, routes, builds, builder: builderCfg };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

const PRESENCE = '/api/presence/:sceneId';
const RMAP = '/api/roblox/:sceneId/map';
const RPRES = '/api/roblox/:sceneId/presence';
const REVENT = '/api/roblox/:sceneId/event';

const judge = { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, head: [0.42, 1.62, -1.1], hands: [[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]] };

describe('route table', () => {
  test('exports exactly the contract paths', async () => {
    const r = await rig();
    const PP = ['/api/roblox/:sceneId/pingpong', '/api/roblox/:sceneId/pingpong/wait', '/api/pingpong/:sceneId'];
    expect(Object.keys(r.routes).sort()).toEqual([PRESENCE, RMAP, RPRES, REVENT, ...PP].sort());
  });

  test('OPTIONS answers with CORS for posts', async () => {
    const r = await rig();
    for (const k of Object.keys(r.routes)) {
      const res = await r.routes[k]!(new Request('http://localhost/api/presence/room-a', { method: 'OPTIONS' }));
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(res.headers.get('access-control-allow-headers')!.toLowerCase()).toContain('x-dejaview-key');
    }
  });
});

describe('/api/presence/:sceneId (metres)', () => {
  test('the headset posts and gets everyone else; GET shows everyone', async () => {
    const r = await rig();
    let res = await r.routes[PRESENCE]!(post('/api/presence/room-a', judge));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    let body = (await res.json()) as any;
    expect(body.people).toEqual([]);
    expect(typeof body.t).toBe('number');
    res = await r.routes[PRESENCE]!(post('/api/presence/room-a', { id: 'web-7f3a19c2', name: 'Maya', kind: 'web', x: -1, y: 0, z: 0.8, yaw: 3.1 }));
    body = await res.json();
    expect(body.people).toHaveLength(1);
    expect(body.people[0]).toMatchObject({ id: 'quest-1', kind: 'vr', x: 0.42, z: -1.1, yaw: 0.3 });
    expect(body.people[0].hands).toHaveLength(2);
    res = await r.routes[PRESENCE]!(get('/api/presence/room-a'));
    body = await res.json();
    expect(body.people.map((p: any) => p.id).sort()).toEqual(['quest-1', 'web-7f3a19c2']);
    expect(body.people[0].age).toBeGreaterThanOrEqual(0);
  });

  test('errors are JSON sentences with the right status', async () => {
    const r = await rig();
    const call = (req: Request) => r.routes[PRESENCE]!(req);
    let res = await call(post('/api/presence/room-a', { ...judge, x: 'a' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'x must be a finite number' });
    res = await call(post('/api/presence/room-a', { ...judge, kind: 'ghost' }));
    expect(res.status).toBe(400);
    res = await call(post('/api/presence/room-a', { ...judge, name: 'n'.repeat(41) }));
    expect(res.status).toBe(400);
    res = await call(post('/api/presence/nope', judge));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such scene' });
    res = await call(get('/api/presence/nope'));
    expect(res.status).toBe(404);
    res = await call(post('/api/presence/room-a', '{not json'));
    expect(res.status).toBe(400);
    res = await call(post('/api/presence/room-a', { ...judge, name: 'x', pad: 'y'.repeat(9000) }));
    expect(res.status).toBe(413);
    res = await call(new Request('http://localhost/api/presence/room-a', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });

  test('a flood from one id gets 429 with Retry-After; others are unaffected', async () => {
    const r = await rig();
    let limited: Response | null = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await r.routes[PRESENCE]!(post('/api/presence/room-a', judge));
      if (res.status === 429) limited = res;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const other = await r.routes[PRESENCE]!(post('/api/presence/room-a', { ...judge, id: 'quest-2' }));
    expect(other.status).toBe(200);
  });
});

describe('/api/roblox/:sceneId/presence (studs)', () => {
  test('studs in, studs out; everyone else sees metres', async () => {
    const r = await rig();
    await r.routes[PRESENCE]!(post('/api/presence/room-a', judge));
    const res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', { players: [{ id: 'rbx-1', name: 'curl', x: 4, y: 0, z: 0, yaw: 0 }], server: 'job-1' }), REMOTE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.others).toHaveLength(1);
    const q = body.others[0];
    expect(q.id).toBe('quest-1');
    expect(q.x).toBeCloseTo(0.42 * 3.57, 2);
    expect(q.z).toBeCloseTo(-1.1 * 3.57, 2);
    expect(q.yaw).toBe(0.3);
    expect(q.hands[0]).toEqual([0.714, 4.32, -4.998]);
    expect(q.head[1]).toBeCloseTo(1.62 * 3.57, 2);
    expect(body.active).toEqual({ sceneId: 'room-a', name: 'Room room-a' });
    const metres = (await (await r.routes[PRESENCE]!(get('/api/presence/room-a'))).json()) as any;
    const rbx = metres.people.find((p: any) => p.id === 'rbx-1');
    expect(rbx.kind).toBe('roblox');
    expect(rbx.x).toBeCloseTo(1.12, 2); // contracts 13.2
  });

  test('never echoes the posted players; server sync drops players that left', async () => {
    const r = await rig();
    const send = (players: unknown[]) => r.routes[RPRES]!(post('/api/roblox/room-a/presence', { players, server: 'job-1' }), REMOTE);
    let body = (await (await send([{ id: 'rbx-1', x: 0, y: 0, z: 0, yaw: 0 }, { id: 'rbx-2', x: 1, y: 0, z: 0, yaw: 0 }])).json()) as any;
    expect(body.others).toEqual([]);
    body = await (await send([{ id: 'rbx-1', x: 0, y: 0, z: 0, yaw: 0 }])).json();
    expect(body.others).toEqual([]);
    expect(r.presence.snapshot('room-a').people.map((p) => p.id)).toEqual(['rbx-1']);
    // an empty room list still returns others (the lobby board)
    await r.routes[PRESENCE]!(post('/api/presence/room-a', judge));
    body = await (await r.routes[RPRES]!(post('/api/roblox/room-a/presence', { players: {} }), REMOTE)).json();
    expect(body.others.map((p: any) => p.id).sort()).toEqual(['quest-1', 'rbx-1']);
  });

  test('bad players are skipped and counted; bad bodies are 400', async () => {
    const r = await rig();
    let res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', { players: [{ id: 'rbx-1', x: 0, y: 0, z: 0, yaw: 0 }, { id: 'rbx-2', x: null }] }), REMOTE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).skipped).toBe(1);
    res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', { players: 'no' }), REMOTE);
    expect(res.status).toBe(400);
    res = await r.routes[RPRES]!(post('/api/roblox/zzz/presence', { players: [] }), REMOTE);
    expect(res.status).toBe(404);
  });
});

describe('DV_KEY', () => {
  test('checked on /api/roblox/* when set; this machine skips it unless it came through the tunnel', async () => {
    const r = await rig({ dvKey: 'secret-key' });
    const body = { players: [] };
    let res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', body), REMOTE);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Bad key' });
    res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', body, { 'x-dejaview-key': 'wrong' }), REMOTE);
    expect(res.status).toBe(401);
    res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', body, { 'x-dejaview-key': 'secret-key' }), REMOTE);
    expect(res.status).toBe(200);
    res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', body), LOCAL);
    expect(res.status).toBe(200);
    res = await r.routes[RPRES]!(post('/api/roblox/room-a/presence', body, { 'cf-connecting-ip': '1.2.3.4' }), LOCAL);
    expect(res.status).toBe(401);
    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map'), REMOTE);
    expect(res.status).toBe(401);
    res = await r.routes[REVENT]!(post('/api/roblox/room-a/event', { type: 'tag', by: 'quest-1', target: 'rbx-1' }), REMOTE);
    expect(res.status).toBe(401);
    // the headset route never needs the key
    res = await r.routes[PRESENCE]!(post('/api/presence/room-a', judge), REMOTE);
    expect(res.status).toBe(200);
  });
});

describe('/api/roblox/:sceneId/event', () => {
  test('a tag reaches subscribers with t, the target position (metres) and name', async () => {
    const r = await rig();
    const got: { scene: string; ev: PresenceEvent }[] = [];
    r.presence.onEvent((scene, ev) => got.push({ scene, ev }));
    await r.routes[RPRES]!(post('/api/roblox/room-a/presence', { players: [{ id: 'rbx-12345', name: 'shivin', x: 3.57, y: 0, z: -7.14, yaw: 0 }] }), REMOTE);
    const res = await r.routes[REVENT]!(post('/api/roblox/room-a/event', { type: 'tag', by: 'quest-1', target: 'rbx-12345' }), REMOTE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]!.scene).toBe('room-a');
    expect(got[0]!.ev).toMatchObject({ type: 'tag', by: 'quest-1', target: 'rbx-12345', targetName: 'shivin', pos: [1, 0, -2] });
    expect(got[0]!.ev.t).toBe(body.t);
  });

  test('a retried duplicate is delivered once; rounds update the presence response', async () => {
    const r = await rig();
    let n = 0;
    r.presence.onEvent(() => n++);
    const start = { type: 'round', state: 'start', scores: { 'quest-1': 0, 'rbx-12345': 3 }, duration: 25 };
    let res = await r.routes[REVENT]!(post('/api/roblox/room-a/event', start), REMOTE);
    expect(res.status).toBe(200);
    res = await r.routes[REVENT]!(post('/api/roblox/room-a/event', start), REMOTE);
    expect(((await res.json()) as any).duplicate).toBe(true);
    expect(n).toBe(1);
    const pres = (await (await r.routes[PRESENCE]!(get('/api/presence/room-a'))).json()) as any;
    expect(pres.round).toMatchObject({ type: 'round', state: 'start', duration: 25 });
  });

  test('bad events are 400, unknown scenes 404, floods 429', async () => {
    const r = await rig();
    let res = await r.routes[REVENT]!(post('/api/roblox/room-a/event', { type: 'tag', by: 'quest-1' }), REMOTE);
    expect(res.status).toBe(400);
    res = await r.routes[REVENT]!(post('/api/roblox/nope/event', { type: 'tag', by: 'quest-1', target: 'rbx-1' }), REMOTE);
    expect(res.status).toBe(404);
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      res = await r.routes[REVENT]!(post('/api/roblox/room-a/event', { type: 'tag', by: 'quest-1', target: `rbx-${i}` }), REMOTE);
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });
});

describe('/api/roblox/:sceneId/map', () => {
  test('202 while building, then 200 from memory, gzip, ETag, HEAD and chunks', async () => {
    const r = await rig({ waitMs: 30 });
    r.builder.delayMs = 150;
    let res = await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'building', retryAfter: 2 });
    expect(res.headers.get('retry-after')).toBe('2');
    await Bun.sleep(250);
    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL);
    expect(res.status).toBe(200);
    const plain = await res.text();
    const map = JSON.parse(plain);
    expect(map.studsPerMeter).toBe(3.57);
    expect(map.parts).toHaveLength(6000);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-map-parts')).toBe('6000');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"rm-/);
    expect(r.builds).toHaveLength(1);
    expect(existsSync(join(r.dir, 'room-a', 'roblox-map.json'))).toBe(true);

    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map', { 'Accept-Encoding': 'gzip, deflate' }), LOCAL);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const gz = new Uint8Array(await res.arrayBuffer());
    expect(gz.byteLength).toBeLessThan(plain.length);
    expect(new TextDecoder().decode(Bun.gunzipSync(gz))).toBe(plain);

    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map', { 'If-None-Match': etag }), LOCAL);
    expect(res.status).toBe(304);
    res = await r.routes[RMAP]!(new Request('http://localhost/api/roblox/room-a/map', { method: 'HEAD' }), LOCAL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');

    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map?chunk=3'), LOCAL);
    const c = (await res.json()) as any;
    expect(c).toMatchObject({ chunk: 3, chunks: 3, studsPerMeter: 3.57, spawn: [0, 0, 5.4] });
    expect(c.parts).toHaveLength(1000);
    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map?chunk=0'), LOCAL);
    expect(res.status).toBe(400);
    expect(r.builds).toHaveLength(1);
  });

  test('maxParts picks a separate cached budget', async () => {
    const r = await rig();
    const res = await r.routes[RMAP]!(get('/api/roblox/room-a/map?maxParts=3000'), LOCAL);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).parts).toHaveLength(3000);
    expect(r.builds[0]!.maxParts).toBe(3000);
    expect(existsSync(join(r.dir, 'room-a', 'roblox-map-3000.json'))).toBe(true);
  });

  test('a Video memory has no Roblox room: its map is a 404 (contracts 6.2)', async () => {
    const r = await rig();
    r.scenes.set('clip-v', scene('clip-v', { mode: 'thirdwheel' }));
    const res = await r.routes[RMAP]!(get('/api/roblox/clip-v/map'), LOCAL);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('Photo');
    expect(r.builds.length).toBe(0);
  });

  test('404, 409 not ready (with status), 409 without a world', async () => {
    const r = await rig();
    let res = await r.routes[RMAP]!(get('/api/roblox/zzz/map'), LOCAL);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such scene' });
    res = await r.routes[RMAP]!(get('/api/roblox/busy-b/map'), LOCAL);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Scene is not ready', status: 'running' });
    res = await r.routes[RMAP]!(get('/api/roblox/noworld-c/map'), LOCAL);
    expect(res.status).toBe(409);
    res = await r.routes[RMAP]!(get('/api/roblox/..%2Fetc/map'), LOCAL);
    expect(res.status).toBe(404);
  });

  test('the cache survives a restart and is rebuilt when the world or the floor changes', async () => {
    const r = await rig();
    expect((await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL)).status).toBe(200);
    expect(r.builds).toHaveLength(1);
    // a new service over the same folder reads the file instead of rebuilding
    const maps2 = new RobloxMapService({
      getScene: async (id) => r.scenes.get(id) ?? null,
      sceneDir: (id) => join(r.dir, id),
      python: 'unused',
      script: join(ROOT, 'pipeline', 'roblox_map.py'),
      cwd: ROOT,
      builder: async () => {
        throw new Error('should not build');
      },
      log: () => {},
    });
    expect((await maps2.get('room-a')).status).toBe(200);
    // floorY written by the map bake changes the room frame: rebuild
    r.scenes.get('room-a')!.world!.floorY = -1.3;
    expect((await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL)).status).toBe(200);
    expect(r.builds).toHaveLength(2);
    // a new world file: rebuild
    await Bun.sleep(5);
    await writeFile(join(r.dir, 'room-a', 'world.ply'), 'ply another fake world, longer');
    expect((await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL)).status).toBe(200);
    expect(r.builds).toHaveLength(3);
    expect(new Set(r.builds.map((b) => b.key)).size).toBe(3);
  });

  test('a failed build answers 500 and is not retried in a loop', async () => {
    const r = await rig();
    r.builder.fail = true;
    let res = await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toContain('blocks');
    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL);
    expect(res.status).toBe(500);
    expect(r.builds).toHaveLength(1);
    await Bun.sleep(550);
    r.builder.fail = false;
    res = await r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL);
    expect(res.status).toBe(200);
    expect(r.builds).toHaveLength(2);
  });

  test('concurrent requests share one build', async () => {
    const r = await rig({ waitMs: 2000 });
    r.builder.delayMs = 100;
    const all = await Promise.all(Array.from({ length: 5 }, () => r.routes[RMAP]!(get('/api/roblox/room-a/map'), LOCAL)));
    expect(all.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    expect(r.builds).toHaveLength(1);
  });
});

const PY = join(ROOT, '.venv', 'bin', 'python');
const SAMPLE = join(ROOT, 'data', 'scenes', 'sample-painted-bedroom');
describe.skipIf(!existsSync(PY) || !existsSync(join(SAMPLE, 'world.spz')))('real builder (python)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tw-social-real-'));
    roots.push(dir);
    await mkdir(join(dir, 'bedroom-real'));
    await symlink(join(SAMPLE, 'world.spz'), join(dir, 'bedroom-real', 'world.spz'));
    const s = JSON.parse(await readFile(join(SAMPLE, 'scene.json'), 'utf8'));
    s.id = 'bedroom-real';
    await writeFile(join(dir, 'bedroom-real', 'scene.json'), JSON.stringify(s));
  });

  test('createSocial builds a real map with the repo python and serves it', async () => {
    const social = createSocial({
      getScene: async (id) => (id === 'bedroom-real' ? JSON.parse(await readFile(join(dir, id, 'scene.json'), 'utf8')) : null),
      sceneDir: (id) => join(dir, id),
      root: ROOT,
      python: PY,
      maps: { waitMs: 60_000 },
      log: () => {},
    });
    try {
      const res = await social.routes[RMAP]!(get('/api/roblox/bedroom-real/map?maxParts=2000'), LOCAL);
      expect(res.status).toBe(200);
      const map = (await res.json()) as any;
      expect(map.sceneId).toBe('bedroom-real');
      expect(map.studsPerMeter).toBe(3.57);
      expect(map.parts.length).toBeGreaterThan(500);
      expect(map.parts.length).toBeLessThanOrEqual(2000);
      expect(map.parts[0][1]).toBe(-0.5); // floor slab first
      expect(map.spawn).toHaveLength(3);
    } finally {
      social.stop();
    }
  }, 90_000);
});

describe('the map bake (topdown.jpg, floor and bounds into scene.json)', () => {
  async function bakeRig() {
    const dir = await mkdtemp(join(tmpdir(), 'tw-bake-'));
    roots.push(dir);
    const scenes = new Map<string, Scene>();
    const s0 = scene('room-a', { world: { file: 'world.ply', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null, source: 'other' } });
    scenes.set('room-a', s0);
    await mkdir(join(dir, 'room-a'), { recursive: true });
    await writeFile(join(dir, 'room-a', 'world.ply'), 'ply fake world');
    const builds: { topdown?: string; key: string }[] = [];
    const builder: MapBuilder = async ({ out, key, topdown }) => {
      builds.push({ topdown, key });
      const bake = topdown
        ? { floorY: -1.25, bounds: { min: [-2, -1.25, -3], max: [2, 1.3, 1] }, topdown: { file: 'topdown.jpg', min: [-2, -3], max: [2, 1], px: [400, 400] } }
        : undefined;
      if (topdown) await writeFile(topdown, 'jpeg');
      await writeFile(out, JSON.stringify({ sceneId: 'room-a', studsPerMeter: 3.57, spawn: [0, 0, 5], parts: [[0, -0.5, 0, 1, 1, 1, 1, 2, 3]], build: { key }, ...(bake ? { bake } : {}) }));
    };
    const baked: { id: string; key: string; bake: any }[] = [];
    const maps = new RobloxMapService({
      getScene: async (id) => structuredClone(scenes.get(id) ?? null),
      sceneDir: (id) => join(dir, id),
      python: 'unused',
      script: join(ROOT, 'pipeline', 'roblox_map.py'),
      cwd: ROOT,
      builder,
      log: () => {},
      onBaked: async (id, bake, key) => {
        baked.push({ id, key, bake });
        // what server/index.ts storeBake does: merge into the scene, then keep the map under the new key
        const cur = scenes.get(id)!;
        scenes.set(id, { ...cur, world: { ...cur.world!, floorY: cur.world!.floorY ?? bake.floorY, bounds: cur.world!.bounds ?? bake.bounds, topdown: bake.topdown } });
        await maps.adopt(id, key);
      },
    });
    return { dir, scenes, maps, builds, baked };
  }

  test('the default build writes the floor plan, the scene learns it, and the map is not built again for it', async () => {
    const r = await bakeRig();
    await r.maps.prewarm('room-a');
    for (let i = 0; i < 50 && !r.baked.length; i++) await Bun.sleep(20);
    expect(r.builds.length).toBe(1);
    expect(r.builds[0]!.topdown).toBe(join(r.dir, 'room-a', 'topdown.jpg'));
    expect(r.baked[0]!.bake.topdown.min).toEqual([-2, -3]);
    const s = r.scenes.get('room-a')!;
    expect(s.world!.floorY).toBe(-1.25);
    expect(s.world!.topdown).toMatchObject({ file: 'topdown.jpg', min: [-2, -3], max: [2, 1] });
    // the floor changed in scene.json, but the map built from it would be the same: no second build
    const res = await r.maps.get('room-a');
    expect(res.status).toBe(200);
    await r.maps.prewarm('room-a');
    await Bun.sleep(50);
    expect(r.builds.length).toBe(1);
    // other budgets never bake
    await r.maps.get('room-a', 3000);
    expect(r.builds.at(-1)!.topdown).toBeUndefined();
  });

  test('a cached map without its floor plan is built again by prewarm (old worlds get their topdown)', async () => {
    const r = await bakeRig();
    // a map cached before the bake existed: right key, no topdown
    const key = await r.maps.keyFor(r.scenes.get('room-a')!, 6000);
    await writeFile(join(r.dir, 'room-a', 'roblox-map.json'), JSON.stringify({ sceneId: 'room-a', parts: [[0, -0.5, 0, 1, 1, 1, 1, 2, 3]], build: { key } }));
    expect((await r.maps.get('room-a')).status).toBe(200);
    expect(r.builds.length).toBe(0);
    await r.maps.prewarm('room-a');
    for (let i = 0; i < 50 && !r.baked.length; i++) await Bun.sleep(20);
    expect(r.builds.length).toBe(1);
    expect(existsSync(join(r.dir, 'room-a', 'topdown.jpg'))).toBe(true);
  });
});
