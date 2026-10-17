import { afterAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { cornerFrame, FEATURES_FILE, featuresToStuds, readFeatures, sceneFeatures } from '../server/social/features.ts';
import { PresenceStore } from '../server/social/presence.ts';
import { createRobloxModelRoutes, RobloxModelService } from '../server/social/roblox-model.ts';
import { mapChunk, mapResponse, RobloxMapService, type BuiltMap, type MapBuilder } from '../server/social/roblox.ts';
import { createSocialRoutes } from '../server/social/routes.ts';

const ROOT = resolve(import.meta.dir, '..');
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const LOCAL = { requestIP: () => ({ address: '127.0.0.1' }) };
const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers });
const RMAP = '/api/roblox/:sceneId/map';
const MODEL = '/api/roblox/:sceneId/model';
const IDENTITY = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: 1 };

function scene(id: string, world: Partial<NonNullable<Scene['world']>> = {}): Scene {
  return {
    id,
    name: `Room ${id}`,
    mode: 'reconstruct',
    status: 'ready',
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    world: { file: 'world.ply', transform: IDENTITY, floorY: 0, source: 'other', ...world },
  };
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// a 2 x 1 m table, its top 0.76 m up, long side along +x
const TABLE = { corners: [[-1, 0.76, -0.5], [1, 0.76, -0.5], [1, 0.76, 0.5], [-1, 0.76, 0.5]], height: 0.76 };

const near = (got: number[], want: number[], digits = 2) => {
  expect(got).toHaveLength(want.length);
  want.forEach((w, i) => expect(got[i]!).toBeCloseTo(w, digits));
};

/** What PingPongSim.fromCorners works out from four corners (roblox/src/shared/PingPongSim.luau), for comparison. */
function luauFromCorners(c: number[][]) {
  const e1 = [0, 1, 2].map((k) => c[1]![k]! - c[0]![k]!);
  const e2 = [0, 1, 2].map((k) => c[2]![k]! - c[1]![k]!);
  const [long, short] = Math.hypot(...e2) > Math.hypot(...e1) ? [e2, e1] : [e1, e2];
  const centre = [0, 1, 2].map((k) => (c[0]![k]! + c[1]![k]! + c[2]![k]! + c[3]![k]!) / 4);
  return { centre, yaw: Math.atan2(-long[0]!, -long[2]!), length: Math.hypot(...long), width: Math.hypot(...short) };
}

describe('features.json (metres) to studs in the map frame', () => {
  test('identity world: studs axis for axis, the table frame worked out as the game does', () => {
    const f = featuresToStuds({ pingPongTable: TABLE }, { transform: IDENTITY, floorY: 0, studsPerMeter: 3.57 })!;
    const t = f.pingPongTable as any;
    expect(t.corners).toEqual([[-3.57, 2.713, -1.785], [3.57, 2.713, -1.785], [3.57, 2.713, 1.785], [-3.57, 2.713, 1.785]]);
    expect(t.height).toBe(2.713);
    expect(t.centre).toEqual([0, 2.713, 0]);
    expect(t.length).toBe(7.14);
    expect(t.width).toBe(3.57);
    // long axis +x: yaw = atan2(-1, -0) = -pi/2 (Roblox CFrame.Angles(0, yaw, 0) turns local -Z onto +x)
    expect(t.yaw).toBeCloseTo(-Math.PI / 2, 4);
    const luau = luauFromCorners(t.corners);
    expect(t.yaw).toBeCloseTo(luau.yaw, 4);
    expect(t.length).toBeCloseTo(luau.length, 3);
    near(t.centre, luau.centre, 3);
  });

  test('the floor the map was built on moves to y = 0 (y_room = y_scene - floorY), x and z only scale', () => {
    const lifted = { corners: TABLE.corners.map(([x, y, z]) => [x!, y! - 1.2, z!]) };
    const t = featuresToStuds({ pingPongTable: lifted }, { transform: IDENTITY, floorY: -1.2, studsPerMeter: 3.57 })!.pingPongTable as any;
    expect(t.corners[0]).toEqual([-3.57, 2.713, -1.785]);
    expect(t.height).toBe(2.713);
  });

  test('world.transform as roblox_map.py applies it: scale, rotation, position; lengths and directions follow', () => {
    // a quarter turn about +Y (x -> -z, z -> x), scale 2, then up 0.5 and along +x by 1; floor at 0.5 after that
    const s = Math.SQRT1_2;
    const frame = { transform: { position: [1, 0.5, 0] as [number, number, number], quaternion: [0, s, 0, s] as [number, number, number, number], scale: 2 }, floorY: 0.5, studsPerMeter: 1 };
    const f = featuresToStuds(
      {
        pingPongTable: { corners: TABLE.corners.map(([x, y, z]) => [x! / 2, y! / 2, z! / 2]) },
        foosballTable: { corners: TABLE.corners.map(([x, y, z]) => [x! / 2, y! / 2, z! / 2]), rods: [0, 0, 1], rodOffsets: [-0.25, 0.25], fieldHeight: 0.3, rimHeight: 0.45 },
      },
      frame,
    )!;
    const t = f.pingPongTable as any;
    // (x, y, z) -> (2z + 1, 2y + 0.5 - 0.5, -2x): corner 1 (-0.5, 0.38, -0.25) -> (0.5, 0.76, 1)
    near(t.corners[0], [0.5, 0.76, 1], 3);
    near(t.corners[1], [0.5, 0.76, -1], 3);
    near(t.centre, [1, 0.76, 0], 3);
    expect(t.length).toBeCloseTo(2, 3);
    expect(t.width).toBeCloseTo(1, 3);
    // the long side now runs along -z: yaw 0 (Roblox's forward)
    expect(t.yaw).toBeCloseTo(0, 4);
    const fb = f.foosballTable as any;
    near(fb.rods, [1, 0, 0], 4); // +z turned onto +x
    expect(fb.rodOffsets).toEqual([-0.5, 0.5]); // x |scale|
    expect(fb.fieldHeight).toBeCloseTo(0.6, 3); // 2 x 0.3 + 0.5 - 0.5
    expect(fb.rimHeight).toBeCloseTo(0.9, 3); // 2 x 0.45 + 0.5 - 0.5
  });

  test('corners given short side first: the long axis is still the longer pair (as the game reads it)', () => {
    const c = [[1, 0.76, -0.5], [1, 0.76, 0.5], [-1, 0.76, 0.5], [-1, 0.76, -0.5]];
    const t = featuresToStuds({ pingPongTable: { corners: c } }, { floorY: 0, studsPerMeter: 1 })!.pingPongTable as any;
    expect(t.length).toBeCloseTo(2, 3);
    expect(t.width).toBeCloseTo(1, 3);
    expect(t.yaw).toBeCloseTo(luauFromCorners(t.corners).yaw, 4);
    expect(cornerFrame(t.corners).yaw).toBe(t.yaw);
  });

  test('chessBoard keeps a1 (1-based) and the corner squares; poolTable keeps its pockets, rail and cloth', () => {
    const f = featuresToStuds(
      {
        chessBoard: { corners: [[0, 0, -2], [2, 0, -2], [2, 0, 0], [0, 0, 0]], a1: 4, a1Index0: 3, cornerSquares: ['a8', 'h8', 'h1', 'a1'], size: 2, square: 0.25, files: [1, 0, 0], whiteForward: [0, 0, -1], note: 'x' },
        poolTable: {
          corners: [[-0.56, 0.78, -1.12], [0.56, 0.78, -1.12], [0.56, 0.78, 1.12], [-0.56, 0.78, 1.12]],
          pockets: [[-0.56, 0.78, -1.12], [0.56, 0.78, -1.12], [0.56, 0.78, 1.12], [-0.56, 0.78, 1.12], [-0.56, 0.78, 0], [0.56, 0.78, 0]],
          railHeight: 0.036,
          clothColor: [38, 110, 72],
        },
      },
      { transform: IDENTITY, floorY: 0, studsPerMeter: 3.57 },
    )!;
    expect(f.chessBoard).toEqual({
      corners: [[0, 0, -7.14], [7.14, 0, -7.14], [7.14, 0, 0], [0, 0, 0]],
      a1: 4,
      cornerSquares: ['a8', 'h8', 'h1', 'a1'],
      centre: [3.57, 0, -3.57],
      size: 7.14,
      square: 0.893,
      files: [1, 0, 0],
      whiteForward: [0, 0, -1],
    });
    const pool = f.poolTable as any;
    expect(pool.corners[0]).toEqual([-1.999, 2.785, -3.998]);
    expect(pool.pockets).toHaveLength(6);
    expect(pool.railHeight).toBe(0.129);
    expect(pool.clothColor).toEqual([38, 110, 72]);
  });

  test('a broken table is left out on its own; nothing usable gives null', () => {
    const frame = { transform: IDENTITY, floorY: 0, studsPerMeter: 3.57 };
    const f = featuresToStuds({ pingPongTable: TABLE, foosballTable: { corners: TABLE.corners.slice(0, 3) }, chessBoard: { corners: TABLE.corners, a1: 5 }, poolTable: 'no' }, frame)!;
    expect(Object.keys(f)).toEqual(['pingPongTable']);
    expect(featuresToStuds({ pingPongTable: { corners: [[0, 0, 0], [1, 0, 0], [1, 0, 'x'], [0, 0, 1]] } }, frame)).toBeNull();
    expect(featuresToStuds({ frame: 'only a note' }, frame)).toBeNull();
    expect(featuresToStuds([TABLE], frame)).toBeNull();
    expect(featuresToStuds({ pingPongTable: TABLE }, { ...frame, floorY: Number.NaN })).toBeNull();
  });
});

describe("the real worlds' features.json", () => {
  test('the-courts: the table-tennis table is the real 2.74 x 1.525 m (PingPongSim LEN 9.78, WID 5.44), 0.76 m up', async () => {
    const sc = JSON.parse(await Bun.file(join(ROOT, 'data/scenes/the-courts/scene.json')).text()) as Scene;
    const f = (await sceneFeatures(join(ROOT, 'data/scenes/the-courts', FEATURES_FILE), sc, null, 3.57))!;
    const pp = f.pingPongTable as any;
    expect(pp.corners).toHaveLength(4);
    expect(pp.length).toBeCloseTo(9.78, 1);
    expect(pp.width).toBeCloseTo(5.44, 1);
    expect(pp.height).toBeCloseTo(2.71, 1);
    for (const c of pp.corners) expect(c[1]).toBe(pp.height);
    // the net crosses the middle of the long sides
    near([(pp.net[0][0] + pp.net[1][0]) / 2, (pp.net[0][2] + pp.net[1][2]) / 2], [pp.centre[0], pp.centre[2]], 2);
    expect(Math.hypot(pp.net[1][0] - pp.net[0][0], pp.net[1][2] - pp.net[0][2])).toBeCloseTo(pp.width, 2);
    const fb = f.foosballTable as any;
    expect(fb.length).toBeGreaterThan(fb.width);
    expect(fb.length / 3.57).toBeCloseTo(1.2, 1);
    expect(fb.width / 3.57).toBeCloseTo(0.7, 1);
    // corners are on the field the ball rolls on (Foosball.luau: the table frame's y = 0 is the pitch, the ball sits
    // BALL_R above it), 0.74 m up; the cabinet top is rimHeight, the rods between the two
    expect(fb.height / 3.57).toBeCloseTo(0.74, 2);
    for (const c of fb.corners) expect(c[1]).toBe(fb.height);
    expect(fb.centre[1]).toBe(fb.height);
    expect(fb.fieldHeight).toBe(fb.height);
    expect(fb.rimHeight / 3.57).toBeCloseTo(0.877, 2);
    expect(fb.rodHeight).toBeGreaterThan(fb.fieldHeight);
    expect(fb.rodHeight).toBeLessThan(fb.rimHeight);
    // the rods run across: square to the long side (corner 1 to 2)
    const long = [fb.corners[1][0] - fb.corners[0][0], fb.corners[1][2] - fb.corners[0][2]];
    expect(Math.abs(long[0]! * fb.rods[0] + long[1]! * fb.rods[2]) / Math.hypot(long[0]!, long[1]!)).toBeLessThan(0.001);
    expect(fb.rodOffsets).toHaveLength(8);
    expect(f.chessBoard).toBeUndefined();
  });

  test('chess-room: the board with its a1 corner (1-based), as Chess.luau reads it', async () => {
    const sc = JSON.parse(await Bun.file(join(ROOT, 'data/scenes/chess-room/scene.json')).text()) as Scene;
    const f = (await sceneFeatures(join(ROOT, 'data/scenes/chess-room', FEATURES_FILE), sc, null, 3.57))!;
    const b = f.chessBoard as any;
    expect(b.a1).toBe(4);
    expect(b.cornerSquares[b.a1 - 1]).toBe('a1');
    expect(b.corners[3]).toEqual([-8.917, 0, -9.158]);
    // Chess.luau: side = |corner 1 - corner 2|
    expect(Math.hypot(b.corners[0][0] - b.corners[1][0], b.corners[0][2] - b.corners[1][2])).toBeCloseTo(b.size, 1);
    expect(b.square * 8).toBeCloseTo(b.size, 1);
  });
});

describe('reading features.json', () => {
  test('missing: null; broken JSON or not an object: null and one log line per version of the file', async () => {
    const dir = await tmp('dv-feat-');
    const path = join(dir, FEATURES_FILE);
    const logs: string[] = [];
    expect(await readFeatures(path, (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(0);
    await writeFile(path, '{"pingPongTable": ');
    expect(await readFeatures(path, (m) => logs.push(m))).toBeNull();
    expect(await readFeatures(path, (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(1);
    await writeFile(path, '[1, 2, 3]');
    await utimes(path, new Date(), new Date(Date.now() + 2000));
    expect(await readFeatures(path, (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('not a JSON object');
  });

  test('cached per mtime and size: an edit with a new mtime is read again, the old version is not', async () => {
    const dir = await tmp('dv-feat-');
    const path = join(dir, FEATURES_FILE);
    const t0 = new Date(Date.now() - 60_000);
    await writeFile(path, JSON.stringify({ pingPongTable: { ...TABLE, height: 0.76 } }));
    await utimes(path, t0, t0);
    const a = await readFeatures(path);
    expect(await readFeatures(path)).toBe(a); // the same parsed object: not read again
    // same size, same mtime: still the cached version
    await writeFile(path, JSON.stringify({ pingPongTable: { ...TABLE, height: 0.77 } }));
    await utimes(path, t0, t0);
    expect(((await readFeatures(path))!.pingPongTable as any).height).toBe(0.76);
    // a new mtime: read again
    await utimes(path, t0, new Date(t0.getTime() + 5000));
    expect(((await readFeatures(path))!.pingPongTable as any).height).toBe(0.77);
    // deleted: gone
    await rm(path);
    expect(await readFeatures(path)).toBeNull();
  });
});

// ---------------------------------------------------------------- the routes

describe('GET /api/roblox/:sceneId/model features', () => {
  async function rig(world: Partial<NonNullable<Scene['world']>> = {}, sidecar: Record<string, unknown> = {}) {
    const dir = await tmp('dv-feat-model-');
    await mkdir(join(dir, 'room-a'), { recursive: true });
    const glb = new Uint8Array(64);
    glb.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 64, 0, 0, 0]);
    await writeFile(join(dir, 'room-a', 'roblox.glb'), glb);
    await writeFile(join(dir, 'room-a', 'roblox-model.json'), JSON.stringify({ version: 1, sceneId: 'room-a', units: 'studs', studsPerMeter: 3.57, sha1: 'x', ...sidecar }));
    const scenes = new Map([['room-a', scene('room-a', world)]]);
    const logs: string[] = [];
    const models = new RobloxModelService({ sceneDir: (id) => join(dir, id), log: () => {} });
    const routes = createRobloxModelRoutes({ getScene: async (id) => scenes.get(id) ?? null, models, log: (m) => logs.push(m) });
    const get = async () => (await (await routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    return { dir, path: join(dir, 'room-a', FEATURES_FILE), get, logs };
  }

  test('no features.json: no features field; with one: features in studs, through the floor the model was built on', async () => {
    const r = await rig({ floorY: -1.2 }, { floorY: -1.2 });
    expect('features' in (await r.get())).toBe(false);
    await writeFile(r.path, JSON.stringify({ pingPongTable: { corners: TABLE.corners.map(([x, y, z]) => [x!, y! - 1.2, z!]) } }));
    const b = await r.get();
    expect(b.features.pingPongTable.corners[0]).toEqual([-3.57, 2.713, -1.785]);
    expect(b.features.pingPongTable.height).toBe(2.713);
    expect(b.sceneFloorY).toBe(-1.2);
    expect(b.floorY).toBe(0);
  });

  test('a broken file: no features field, the rest of the response as before, one log line', async () => {
    const r = await rig();
    await writeFile(r.path, 'not json');
    const b = await r.get();
    expect(b.features).toBeUndefined();
    expect(b.sceneId).toBe('room-a');
    expect(r.logs.filter((l) => l.includes('[features]'))).toHaveLength(1);
  });

  test('an edited file reaches the next request', async () => {
    const r = await rig();
    await writeFile(r.path, JSON.stringify({ pingPongTable: TABLE }));
    expect((await r.get()).features.pingPongTable.height).toBe(2.713);
    await writeFile(r.path, JSON.stringify({ pingPongTable: { corners: TABLE.corners.map(([x, , z]) => [x!, 0.9, z!]) } }));
    await utimes(r.path, new Date(), new Date(Date.now() + 5000));
    expect((await r.get()).features.pingPongTable.height).toBe(3.213);
  });
});

describe('GET /api/roblox/:sceneId/map features', () => {
  async function rig() {
    const dir = await tmp('dv-feat-map-');
    const scenes = new Map<string, Scene>([
      ['courts', scene('courts', { bounds: { min: [-1, 0, -1], max: [1, 2, 1] } })],
      ['plain', scene('plain')],
    ]);
    for (const id of scenes.keys()) {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(join(dir, id, 'world.ply'), 'ply fake world');
    }
    const builder: MapBuilder = async ({ out, key }) => {
      const parts = Array.from({ length: 3000 }, (_, i) => [i, 0.5, 0, 1, 1, 1, 120, 104, 90]);
      await writeFile(out, JSON.stringify({ sceneId: 'x', studsPerMeter: 3.57, spawn: [0, 0, 5.4], floorY: 0, parts, build: { key } }));
    };
    const getScene = async (id: string) => structuredClone(scenes.get(id) ?? null);
    const maps = new RobloxMapService({ getScene, sceneDir: (id) => join(dir, id), python: 'unused', script: join(ROOT, 'pipeline', 'roblox_map.py'), cwd: ROOT, builder, waitMs: 5000, log: () => {} });
    const routes = createSocialRoutes({ getScene, presence: new PresenceStore(), maps, sceneCacheMs: 0, log: () => {} });
    const get = (id: string, q = '', headers: Record<string, string> = {}) => routes[RMAP]!(req(`/api/roblox/${id}/map${q}`, headers), LOCAL);
    return { dir, get };
  }

  test('spliced in after walkBounds, with its own ETag part; gzip, 304 and every chunk carry it; an edit changes the ETag', async () => {
    const r = await rig();
    let res = await r.get('courts');
    const before = res.headers.get('etag')!;
    expect(before).not.toContain('-f');
    expect(((await res.json()) as any).features).toBeUndefined();

    const path = join(r.dir, 'courts', FEATURES_FILE);
    await copyFile(join(ROOT, 'data/scenes/the-courts', FEATURES_FILE), path);
    res = await r.get('courts');
    const plain = await res.text();
    const map = JSON.parse(plain);
    expect(Object.keys(map).slice(0, 2)).toEqual(['walkBounds', 'features']);
    expect(Object.keys(map.features).sort()).toEqual(['foosballTable', 'pingPongTable']);
    expect(map.features.pingPongTable.length).toBeCloseTo(9.78, 1);
    expect(map.parts).toHaveLength(3000);
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"rm-.*-w[0-9a-f]{8}-f[0-9a-f]{8}"$/);
    expect(res.headers.get('content-length')).toBe(String(new TextEncoder().encode(plain).byteLength));

    res = await r.get('courts', '', { 'Accept-Encoding': 'gzip' });
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))).toBe(plain);
    expect((await r.get('courts', '', { 'If-None-Match': etag })).status).toBe(304);
    // a game holding the map from before the features gets the new body, not a 304
    expect((await r.get('courts', '', { 'If-None-Match': before })).status).toBe(200);
    for (const c of [1, 2]) {
      const body = (await (await r.get('courts', `?chunk=${c}`)).json()) as any;
      expect(body.chunks).toBe(2);
      expect(body.features).toEqual(map.features);
    }

    const f = JSON.parse(await Bun.file(path).text());
    f.pingPongTable.corners = f.pingPongTable.corners.map(([x, , z]: number[]) => [x, 0.8, z]);
    await writeFile(path, JSON.stringify(f));
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    res = await r.get('courts');
    expect(res.headers.get('etag')).not.toBe(etag);
    expect(((await res.json()) as any).features.pingPongTable.height).toBe(2.856);
  });

  test('a scene without features.json or with a broken one: the map exactly as before', async () => {
    const r = await rig();
    const res = await r.get('plain');
    const etag = res.headers.get('etag')!;
    expect(((await res.json()) as any).features).toBeUndefined();
    await writeFile(join(r.dir, 'plain', FEATURES_FILE), '{ broken');
    const again = await r.get('plain');
    expect(again.headers.get('etag')).toBe(etag);
    expect(((await again.json()) as any).features).toBeUndefined();
  });

  test('mapResponse and mapChunk on their own: features alone, and a map that carries its own is left alone', () => {
    const raw = { sceneId: 's', studsPerMeter: 3.57, floorY: 0, parts: [[0, -0.5, 0, 10, 1, 10, 1, 2, 3]], build: { key: 'k' } };
    const body = new TextEncoder().encode(JSON.stringify(raw));
    const map: BuiltMap = { key: 'k', body, gzip: Bun.gzipSync(body), etag: '"rm-k"', parts: 1 };
    const features = { pingPongTable: { corners: [[0, 2.71, 0], [1, 2.71, 0], [1, 2.71, 1], [0, 2.71, 1]], height: 2.71 } };
    const out = mapResponse(map, null, features);
    expect(JSON.parse(new TextDecoder().decode(out.body))).toEqual({ features, ...raw });
    expect(out.etag).toMatch(/^"rm-k-f[0-9a-f]{8}"$/);
    expect(mapResponse(map, null, features)).toBe(out);
    expect(mapResponse(map, null, null)).toBe(map);
    const c = mapChunk(map, 1, null, features);
    expect(c.ok && c.body.features).toEqual(features);

    const own = new TextEncoder().encode(JSON.stringify({ ...raw, features: { chessBoard: {} } }));
    const mapOwn: BuiltMap = { key: 'k2', body: own, gzip: own, etag: '"rm-k2"', parts: 1 };
    expect(mapResponse(mapOwn, null, features)).toBe(mapOwn);
    const c2 = mapChunk(mapOwn, 1, null, features);
    expect(c2.ok && c2.body.features).toEqual({ chessBoard: {} });
  });
});
