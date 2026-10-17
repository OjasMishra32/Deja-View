import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { PresenceStore } from '../server/social/presence.ts';
import { glbBounds, glbBytesBounds, gltfBounds, modelFrame } from '../server/social/model-frame.ts';
import { createRobloxModelRoutes, RobloxModelService } from '../server/social/roblox-model.ts';
import { mapChunk, mapResponse, mapWalkBounds, RobloxMapService, walkBoundsOf, type BuiltMap, type MapBuilder } from '../server/social/roblox.ts';
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

// the-courts' world.bounds (scene frame, metres, floor at 0)
const COURTS = { min: [-5.8691, 0.0, -9.7766] as [number, number, number], max: [6.4519, 4.3423, 3.2308] as [number, number, number] };

function scene(id: string, world: Partial<NonNullable<Scene['world']>> = {}): Scene {
  return {
    id,
    name: `Room ${id}`,
    mode: 'rentfree',
    status: 'ready',
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    world: { file: 'world.ply', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'other', ...world },
  };
}

// ---------------------------------------------------------------- a tiny .glb

/** A .glb with one triangle mesh: (0,0,0), (2,0,0), (0,3,-4); POSITION min/max written unless `noMinMax`. */
function makeGlb(nodes: Record<string, unknown>[], sceneNodes: number[], opts: { noMinMax?: boolean } = {}): Uint8Array {
  const pos = new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, -4]);
  const bin = new Uint8Array(pos.buffer);
  const accessor: Record<string, unknown> = { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' };
  if (!opts.noMinMax) Object.assign(accessor, { min: [0, 0, -4], max: [2, 3, 0] });
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [accessor],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    buffers: [{ byteLength: bin.byteLength }],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLen = Math.ceil(json.length / 4) * 4;
  const binLen = Math.ceil(bin.length / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(json, 20);
  dv.setUint32(20 + jsonLen, binLen, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(bin, 28 + jsonLen);
  return out;
}

const s45 = Math.SQRT1_2;
// node 0: translated and scaled; node 1 (translated) -> node 2 (a quarter turn about +Y) share the mesh
const NODES = [
  { mesh: 0, translation: [10, 1, -5], scale: [2, 2, 2] },
  { translation: [100, 0, 0], children: [2] },
  { mesh: 0, rotation: [0, s45, 0, s45] },
];
// node 0: x 10..14, y 1..7, z -13..-5; node 2: turned (x, z) -> (z, -x): x 96..100, y 0..3, z -2..0
const NODES_BOX = { min: [10, 0, -13], max: [100, 7, 0] };

const close = (box: { min: number[]; max: number[] } | null, want: { min: number[]; max: number[] }) => {
  expect(box).not.toBeNull();
  for (let k = 0; k < 3; k++) {
    expect(box!.min[k]!).toBeCloseTo(want.min[k]!, 4);
    expect(box!.max[k]!).toBeCloseTo(want.max[k]!, 4);
  }
};

describe('walkBounds: world.bounds in the map frame', () => {
  test('the-courts: studs axis for axis, padded 0.5 m on x and z, floor at y = 0', () => {
    expect(walkBoundsOf(COURTS, 0)).toEqual({ min: [-22.74, 0, -36.69], max: [24.82, 15.5, 13.32] });
  });

  test('the floor the map was built with moves to y = 0 (as pipeline/roblox_map.py does), x and z only scale', () => {
    const b = walkBoundsOf({ min: [-1.1, -1.2, -2.1], max: [1.1, 1.4, 2.1] }, -1.2)!;
    expect(b).toEqual({ min: [-5.71, 0, -9.28], max: [5.71, 9.28, 9.28] });
    // swapped corners are put right; no padding when asked
    expect(walkBoundsOf({ min: [1, 2, 3], max: [-1, 0, -3] }, 0, 3.57, 0)).toEqual({ min: [-3.57, 0, -10.71], max: [3.57, 7.14, 10.71] });
  });

  test('missing or broken bounds give nothing', () => {
    expect(walkBoundsOf(undefined, 0)).toBeNull();
    expect(walkBoundsOf({ min: [0, 0], max: [1, 1, 1] }, 0)).toBeNull();
    expect(walkBoundsOf({ min: [0, 0, 'x'], max: [1, 1, 1] }, 0)).toBeNull();
    expect(walkBoundsOf(COURTS, Number.NaN)).toBeNull();
  });

  test('a built map gets walkBounds spliced in front, with its own ETag; gzip matches; a map with its own is left alone', () => {
    const raw = { sceneId: 's', studsPerMeter: 3.57, floorY: -1.2, spawn: [0, 0, 5], parts: [[0, -0.5, 0, 10, 1, 10, 1, 2, 3]], build: { key: 'k' } };
    const body = new TextEncoder().encode(JSON.stringify(raw));
    const map: BuiltMap = { key: 'k', body, gzip: Bun.gzipSync(body), etag: '"rm-k"', parts: 1 };
    const sc = scene('s', { floorY: -1.2, bounds: { min: [-1.1, -1.2, -2.1], max: [1.1, 1.4, 2.1] } });
    const walk = mapWalkBounds(map, sc);
    expect(walk).toEqual({ min: [-5.71, 0, -9.28], max: [5.71, 9.28, 9.28] });
    const out = mapResponse(map, walk);
    const parsed = JSON.parse(new TextDecoder().decode(out.body));
    expect(parsed).toEqual({ walkBounds: walk, ...raw });
    expect(Object.keys(parsed)[0]).toBe('walkBounds');
    expect(new TextDecoder().decode(Bun.gunzipSync(out.gzip as Uint8Array<ArrayBuffer>))).toBe(new TextDecoder().decode(out.body));
    expect(out.etag).toMatch(/^"rm-k-w[0-9a-f]{8}"$/);
    expect(mapResponse(map, walk)).toBe(out); // kept for the same walk box
    expect(mapResponse(map, null)).toBe(map);
    const c = mapChunk(map, 1, walk);
    expect(c.ok && c.body.walkBounds).toEqual(walk);
    // no world.bounds: no walkBounds
    expect(mapWalkBounds(map, scene('s'))).toBeNull();

    const own = new TextEncoder().encode(JSON.stringify({ ...raw, walkBounds: { min: [0, 0, 0], max: [1, 1, 1] } }));
    const mapOwn: BuiltMap = { key: 'k2', body: own, gzip: own, etag: '"rm-k2"', parts: 1 };
    expect(mapResponse(mapOwn, walk)).toBe(mapOwn);
  });
});

describe('GET /api/roblox/:sceneId/map walkBounds', () => {
  async function rig() {
    const dir = await mkdtemp(join(tmpdir(), 'dv-walk-'));
    roots.push(dir);
    const scenes = new Map<string, Scene>([
      ['courts', scene('courts', { bounds: COURTS })],
      ['plain', scene('plain')],
    ]);
    for (const id of scenes.keys()) {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(join(dir, id, 'world.ply'), 'ply fake world');
    }
    const builder: MapBuilder = async ({ out, key }) => {
      const parts = Array.from({ length: 30 }, (_, i) => [i, 0.5, 0, 1, 1, 1, 120, 104, 90]);
      await writeFile(out, JSON.stringify({ sceneId: 'x', studsPerMeter: 3.57, spawn: [0, 0, 5.4], floorY: 0, parts, build: { key } }));
    };
    const getScene = async (id: string) => structuredClone(scenes.get(id) ?? null);
    const maps = new RobloxMapService({
      getScene,
      sceneDir: (id) => join(dir, id),
      python: 'unused',
      script: join(ROOT, 'pipeline', 'roblox_map.py'),
      cwd: ROOT,
      builder,
      waitMs: 5000,
      log: () => {},
    });
    const routes = createSocialRoutes({ getScene, presence: new PresenceStore(), maps, sceneCacheMs: 0, log: () => {} });
    return { routes };
  }

  test('added at response time from scene.json; gzip, 304 and chunks carry it; a scene without bounds has none', async () => {
    const r = await rig();
    let res = await r.routes[RMAP]!(req('/api/roblox/courts/map'), LOCAL);
    expect(res.status).toBe(200);
    const plain = await res.text();
    const map = JSON.parse(plain);
    expect(map.walkBounds).toEqual({ min: [-22.74, 0, -36.69], max: [24.82, 15.5, 13.32] });
    expect(map.parts).toHaveLength(30);
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"rm-.*-w[0-9a-f]{8}"$/);
    expect(res.headers.get('content-length')).toBe(String(new TextEncoder().encode(plain).byteLength));

    res = await r.routes[RMAP]!(req('/api/roblox/courts/map', { 'Accept-Encoding': 'gzip' }), LOCAL);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))).toBe(plain);
    res = await r.routes[RMAP]!(req('/api/roblox/courts/map', { 'If-None-Match': etag }), LOCAL);
    expect(res.status).toBe(304);
    res = await r.routes[RMAP]!(req('/api/roblox/courts/map?chunk=1'), LOCAL);
    expect(((await res.json()) as any).walkBounds).toEqual(map.walkBounds);

    res = await r.routes[RMAP]!(req('/api/roblox/plain/map'), LOCAL);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).walkBounds).toBeUndefined();
    expect(res.headers.get('etag')).not.toContain('-w');
  });
});

describe('the .glb box', () => {
  test('POSITION min/max through every node transform (translation, scale, a turned child)', () => {
    close(glbBytesBounds(makeGlb(NODES, [0, 1])), NODES_BOX);
    // a node matrix (column-major) is used as it is
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    close(glbBytesBounds(makeGlb([{ mesh: 0, matrix: m }], [0])), { min: [5, 6, 3], max: [7, 9, 7] });
  });

  test('every primitive of a mesh counts, and a mesh used by two nodes counts at both', () => {
    const gltf = {
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 0, translation: [0, 0, 50] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] }],
      accessors: [
        { componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
        { componentType: 5126, count: 3, type: 'VEC3', min: [-4, 2, -3], max: [-2, 9, -1] },
      ],
    };
    close(gltfBounds(gltf) as { min: number[]; max: number[] }, { min: [-4, 0, -3], max: [1, 9, 51] });
  });

  test('an accessor without min/max is read from the BIN chunk', () => {
    close(glbBytesBounds(makeGlb(NODES, [0, 1], { noMinMax: true })), NODES_BOX);
  });

  test('not a .glb, or no geometry: null', () => {
    expect(glbBytesBounds(new Uint8Array(64))).toBeNull();
    expect(glbBytesBounds(makeGlb([{ name: 'empty' }], [0]))).toBeNull();
  });

  test('from a file, rounded to 0.01 and cached per size and mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-glb-'));
    roots.push(dir);
    const f = join(dir, 'roblox.glb');
    await writeFile(f, makeGlb([{ mesh: 0, translation: [0.123456, 0, 0] }], [0]));
    expect(await glbBounds(f)).toEqual({ min: [0.12, 0, -4], max: [2.12, 3, 0] });
    await writeFile(f, makeGlb([{ mesh: 0, translation: [1, 0, 0] }], [0]));
    await utimes(f, new Date(), new Date(Date.now() + 5000));
    expect(await glbBounds(f)).toEqual({ min: [1, 0, -4], max: [3, 3, 0] });
    expect(await glbBounds(join(dir, 'missing.glb'))).toBeNull();
  });
});

describe('GET /api/roblox/:sceneId/model frame fields', () => {
  async function rig(sidecar: Record<string, unknown>, files: Record<string, Uint8Array>, world: Partial<NonNullable<Scene['world']>>) {
    const dir = await mkdtemp(join(tmpdir(), 'dv-mframe-'));
    roots.push(dir);
    await mkdir(join(dir, 'room-a'), { recursive: true });
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, 'room-a', name), bytes);
    await writeFile(join(dir, 'room-a', 'roblox-model.json'), JSON.stringify(sidecar));
    const scenes = new Map([['room-a', scene('room-a', world)]]);
    const models = new RobloxModelService({ sceneDir: (id) => join(dir, id), log: () => {} });
    const routes = createRobloxModelRoutes({ getScene: async (id) => scenes.get(id) ?? null, models, log: () => {} });
    return async () => (await (await routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
  }

  test('bounds from the .glb files (union of the parts), per-part bounds, walkBounds, floorY 0, spawn', async () => {
    const one = makeGlb([{ mesh: 0, translation: [10, 1, -5], scale: [2, 2, 2] }], [0]);
    const two = makeGlb([{ mesh: 0, translation: [-50, 0, 0] }], [0]);
    const get = await rig(
      {
        version: 2,
        sceneId: 'room-a',
        units: 'studs',
        studsPerMeter: 3.57,
        floorY: -1.2,
        spawn: [1.5, 0, -2],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] }, // stale: the files win
        parts: [{ file: 'roblox.glb', sha1: 'a' }, { file: 'roblox-2.glb', sha1: 'b' }],
      },
      { 'roblox.glb': one, 'roblox-2.glb': two },
      { floorY: -1.2, bounds: { min: [-1.1, -1.2, -2.1], max: [1.1, 1.4, 2.1] } },
    );
    const b = await get();
    expect(b.bounds).toEqual({ min: [-50, 0, -13], max: [14, 7, 0] });
    expect(b.boundsSource).toBe('glb');
    expect(b.parts.map((p: any) => p.bounds)).toEqual([
      { min: [10, 1, -13], max: [14, 7, -5] },
      { min: [-50, 0, -4], max: [-48, 3, 0] },
    ]);
    expect(b.walkBounds).toEqual({ min: [-5.71, 0, -9.28], max: [5.71, 9.28, 9.28] });
    expect(b.floorY).toBe(0);
    expect(b.sceneFloorY).toBe(-1.2);
    expect(b.studsPerMeter).toBe(3.57);
    expect(b.spawn).toEqual([1.5, 0, -2]);
    expect(b).toMatchObject({ sceneId: 'room-a', units: 'studs', glbUrl: '/api/roblox/room-a/model.glb', upload: { state: 'off' } });
  });

  test("a .glb that cannot be read keeps the sidecar's own box; no world.bounds means no walkBounds", async () => {
    const junk = new Uint8Array(64);
    junk.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 64, 0, 0, 0]);
    const get = await rig(
      { version: 1, sceneId: 'room-a', units: 'studs', studsPerMeter: 3.57, sha1: 'x', bounds: { min: [-17.33, -0.75, -21.65], max: [13.57, 10.68, 6.19] } },
      { 'roblox.glb': junk },
      { floorY: 0 },
    );
    const b = await get();
    expect(b.bounds).toEqual({ min: [-17.33, -0.75, -21.65], max: [13.57, 10.68, 6.19] });
    expect(b.boundsSource).toBe('sidecar');
    expect(b.parts[0].bounds).toBeUndefined();
    expect(b.walkBounds).toBeUndefined();
    expect(b.floorY).toBe(0);
    expect(b.sceneFloorY).toBe(0);
  });

  test('modelFrame on its own: the floor falls back to the scene, a missing spawn stays missing', async () => {
    const f = await modelFrame(scene('x', { floorY: 0.5, bounds: { min: [0.1, 0.5, 0.1], max: [1.1, 2.5, 1.1] } }), {}, []);
    expect(f.fields).toEqual({ studsPerMeter: 3.57, floorY: 0, sceneFloorY: 0.5, walkBounds: { min: [-1.43, 0, -1.43], max: [5.71, 7.14, 5.71] } });
    expect(f.partBounds).toEqual([]);
  });
});
