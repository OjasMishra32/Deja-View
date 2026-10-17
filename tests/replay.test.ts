// Replays: the recorder's buffering against a fake database, and the real queries against a throwaway local Postgres
// (initdb + pg_ctl in a temp dir; skipped when Postgres is not installed). TimescaleDB-only paths run when the
// extension is installed locally, or against Tiger Data with REPLAY_TEST_URL=<connection string>.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { createRecorder } from '../server/replay/recorder.ts';
import { createReplay } from '../server/replay/routes.ts';
import { openReplayDb, redactUrl, wantsTls, type Moment, type ReplayDb, type Sample } from '../server/replay/store.ts';
import type { PersonView, PresenceEvent } from '../server/social/presence.ts';

/** A presence store stand-in: tests push snapshots and events by hand. */
function fakePresence() {
  const ps = new Set<(s: string, p: PersonView[], t: number) => void>();
  const es = new Set<(s: string, e: PresenceEvent) => void>();
  return {
    onPresence(fn: (s: string, p: PersonView[], t: number) => void) {
      ps.add(fn);
      return () => ps.delete(fn);
    },
    onEvent(fn: (s: string, e: PresenceEvent) => void) {
      es.add(fn);
      return () => es.delete(fn);
    },
    push(sceneId: string, people: PersonView[], t: number) {
      for (const f of ps) f(sceneId, people, t);
    },
    event(sceneId: string, e: PresenceEvent) {
      for (const f of es) f(sceneId, e);
    },
    get listeners() {
      return ps.size + es.size;
    },
  };
}

const person = (id: string, name: string, kind: 'vr' | 'web' | 'roblox', x: number, z: number, yaw = 0): PersonView => ({
  id,
  name,
  kind,
  x,
  y: 0,
  z,
  yaw,
  age: 0,
});

describe('recorder', () => {
  function memDb(failing = { on: false }) {
    const samples: Sample[] = [];
    const moments: Moment[] = [];
    const db = {
      features: { postgres: 'mem', timescale: null, hypertable: false, aggregate: false, compression: false },
      async insertSamples(rows: Sample[]) {
        if (failing.on) throw new Error('connection refused');
        samples.push(...rows);
      },
      async insertMoments(rows: Moment[]) {
        if (failing.on) throw new Error('connection refused');
        moments.push(...rows);
      },
    } as unknown as ReplayDb;
    return { db, samples, moments };
  }

  test('one row per person per snapshot, moments with their time, empty snapshots skipped', async () => {
    const presence = fakePresence();
    const { db, samples, moments } = memDb();
    const rec = createRecorder({ db, presence, log: () => {} });
    rec.start();
    presence.push('room-a', [person('vr-1', 'Judge', 'vr', 1, 2), person('rb-7', 'shivin', 'roblox', -1, 0.5)], 1000.25);
    presence.push('room-a', [], 1000.5);
    presence.event('room-a', { type: 'tag', t: 1000.4, by: 'vr-1', target: 'rb-7' });
    await rec.flush();
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ t: 1000250, sceneId: 'room-a', personId: 'vr-1', name: 'Judge', kind: 'vr', x: 1, z: 2 });
    expect(moments).toEqual([{ t: 1000400, sceneId: 'room-a', type: 'tag', body: { by: 'vr-1', target: 'rb-7' } }]);
    expect(rec.status()).toMatchObject({ written: 2, moments: 1, buffered: 0, error: null });
    await rec.stop();
    expect(presence.listeners).toBe(0);
  });

  test('keeps rows while the database is down, drops the oldest past the cap, then catches up', async () => {
    const presence = fakePresence();
    const failing = { on: true };
    const { db, samples } = memDb(failing);
    let clock = 0;
    const rec = createRecorder({ db, presence, maxBuffer: 5, now: () => clock, log: () => {} });
    rec.start();
    for (let i = 0; i < 4; i++) presence.push('room-a', [person('a', 'A', 'web', i, 0), person('b', 'B', 'web', i, 1)], i);
    await rec.flush();
    expect(rec.status()).toMatchObject({ written: 0, buffered: 5, dropped: 3, error: 'connection refused' });
    failing.on = false;
    await rec.flush(); // still inside the backoff window
    expect(samples).toHaveLength(0);
    clock = 60_000;
    await rec.flush();
    expect(samples.map((s) => s.x)).toEqual([1, 2, 2, 3, 3]);
    expect(rec.status()).toMatchObject({ written: 5, buffered: 0, error: null });
    await rec.stop();
  });

  test('connection strings: TLS is detected and passwords never reach logs', () => {
    expect(wantsTls('postgres://u:p@h.tsdb.cloud.timescale.com:3333/tsdb?sslmode=require')).toBe(true);
    expect(wantsTls('postgres://localhost:5432/db')).toBe(false);
    expect(redactUrl('postgres://tsdbadmin:hunter2@h:1/tsdb?sslmode=require')).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real database

const PG_BIN = ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/lib/postgresql/17/bin'].find(
  (d) => Bun.file(join(d, 'initdb')).size > 0,
);
const REMOTE = process.env.REPLAY_TEST_URL?.trim() || null;

let url: string | null = REMOTE;
let dataDir: string | null = null;

beforeAll(async () => {
  if (url || !PG_BIN) return;
  dataDir = mkdtempSync(join(tmpdir(), 'dv-replay-pg-'));
  // macOS: without a valid locale the postmaster refuses to start ("became multithreaded during startup")
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  const port = 55000 + Math.floor(Math.random() * 4000);
  const init = Bun.spawnSync([join(PG_BIN, 'initdb'), '-D', join(dataDir, 'db'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--no-sync'], {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (init.exitCode !== 0) throw new Error(`initdb failed: ${init.stderr.toString()}`);
  const start = Bun.spawnSync(
    [join(PG_BIN, 'pg_ctl'), '-D', join(dataDir, 'db'), '-l', join(dataDir, 'log'), '-w', '-o', `-p ${port} -c listen_addresses=127.0.0.1 -k ${dataDir} -c fsync=off`, 'start'],
    { env, stdout: 'ignore', stderr: 'pipe' },
  );
  if (start.exitCode !== 0) throw new Error(`pg_ctl start failed: ${start.stderr.toString()}`);
  url = `postgres://postgres@127.0.0.1:${port}/postgres`;
}, 60_000);

afterAll(() => {
  if (!dataDir || !PG_BIN) return;
  Bun.spawnSync([join(PG_BIN, 'pg_ctl'), '-D', join(dataDir, 'db'), '-m', 'immediate', 'stop'], { stdout: 'ignore', stderr: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
});

const real = PG_BIN || REMOTE ? describe : describe.skip;

real('replay database', () => {
  // A 20 s game night two days ago (fixed times, so reruns against a shared database can be told apart by scene id)
  const scene = `test-replay-${process.pid}`;
  const T0 = Date.UTC(2026, 9, 15, 22, 0, 0);
  let db: ReplayDb;

  beforeAll(async () => {
    db = await openReplayDb(url!, { log: () => {} });
    const rows: Sample[] = [];
    // the judge walks along +x at 0.5 m/s, Shivin stands still on the couch; 5 snapshots a second
    for (let i = 0; i < 100; i++) {
      const t = T0 + i * 200;
      rows.push({ t, sceneId: scene, personId: 'vr-1', name: 'Judge', kind: 'vr', x: i * 0.1, y: 0, z: 0, yaw: -Math.PI / 2 });
      rows.push({ t, sceneId: scene, personId: 'rb-7', name: 'shivin', kind: 'roblox', x: 2.2, y: 0, z: 3.1, yaw: 0 });
    }
    // a second visit 10 minutes later: just the judge, 3 s
    for (let i = 0; i < 15; i++) {
      rows.push({ t: T0 + 600_000 + i * 200, sceneId: scene, personId: 'vr-1', name: 'Judge', kind: 'vr', x: 0, y: 0, z: 0, yaw: 0 });
    }
    await db.insertSamples(rows);
    await db.insertMoments([{ t: T0 + 5000, sceneId: scene, type: 'tag', body: { by: 'vr-1', target: 'rb-7' } }]);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  test('features describe the database', () => {
    expect(db.features.postgres).toMatch(/^\d+/);
    if (db.features.timescale) expect(db.features.hypertable).toBe(true);
    else expect(db.features).toMatchObject({ hypertable: false, aggregate: false, compression: false });
  });

  test('sessions split on a gap of more than a minute, newest first', async () => {
    const s = await db.sessions(scene);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ from: T0 + 600_000, to: T0 + 603_000, seconds: 3, names: ['Judge'] });
    expect(s[1]).toMatchObject({ from: T0, to: T0 + 20_000, seconds: 20, names: ['Judge', 'shivin'] });
  });

  test('tracks are bucketed per person with times relative to from', async () => {
    const tracks = await db.tracks(scene, T0, T0 + 20_000, 1000);
    const judge = tracks.find((t) => t.id === 'vr-1')!;
    const shivin = tracks.find((t) => t.id === 'rb-7')!;
    expect(judge.t).toHaveLength(20);
    expect(judge.t[0]).toBe(0);
    expect(judge.t[19]).toBe(19_000);
    // each bucket averages five samples: 0.0..0.4 -> 0.2
    expect(judge.x[0]).toBeCloseTo(0.2, 5);
    expect(judge.x[19]).toBeCloseTo(9.7, 5);
    expect(judge.yaw[0]).toBeCloseTo(-Math.PI / 2, 3);
    expect(shivin).toMatchObject({ name: 'shivin', kind: 'roblox' });
    expect(new Set(shivin.x)).toEqual(new Set([2.2]));
  });

  test('moments come back in range only', async () => {
    expect(await db.moments(scene, T0, T0 + 20_000)).toEqual([{ t: T0 + 5000, sceneId: scene, type: 'tag', body: { by: 'vr-1', target: 'rb-7' } }]);
    expect(await db.moments(scene, T0 + 6000, T0 + 20_000)).toEqual([]);
  });

  test('the heatmap counts person-seconds per floor cell', async () => {
    const cells = await db.heat(scene, T0, T0 + 20_000, 1);
    const couch = cells.find((c) => c.ix === 2 && c.iz === 3)!;
    expect(couch).toEqual({ ix: 2, iz: 3, seconds: 20, people: 1 });
    // the judge crosses ten 1 m cells along z = 0, two seconds in each
    const path = cells.filter((c) => c.iz === 0).sort((a, b) => a.ix - b.ix);
    expect(path.map((c) => c.ix)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(path.every((c) => c.seconds === 2)).toBe(true);
  });

  test('routes: latest visit by default, ranges, heat and sessions over HTTP', async () => {
    const presence = fakePresence();
    const scenes = new Set([scene]);
    const getScene = async (id: string) => (scenes.has(id) ? ({ id } as Scene) : null);
    const replay = createReplay({ url: url!, presence, getScene, log: () => {} });
    replay.start();
    for (let i = 0; i < 50 && !replay.status().connected; i++) await Bun.sleep(100);
    expect(replay.status()).toMatchObject({ enabled: true, connected: true, error: null });

    const get = (path: string) => {
      const route = path.split('?')[0].split('/').length > 5 ? '/api/replay/:sceneId/:what' : path.startsWith('/api/replay/status') ? '/api/replay/status' : '/api/replay/:sceneId';
      return replay.routes[route](new Request(`http://localhost${path}`));
    };

    const latest = await (await get(`/api/replay/${scene}`)).json();
    expect(latest).toMatchObject({ from: T0 + 600_000, to: T0 + 603_000, step: 250 });
    expect(latest.people.map((p: { name: string }) => p.name)).toEqual(['Judge']);

    const night = await (await get(`/api/replay/${scene}?from=${T0}&to=${T0 + 20_000}&step=1000`)).json();
    expect(night.people).toHaveLength(2);
    expect(night.moments).toEqual([{ by: 'vr-1', target: 'rb-7', type: 'tag', t: 5000 }]);

    const heat = await (await get(`/api/replay/${scene}/heat?from=${T0}&to=${T0 + 20_000}&cell=1`)).json();
    expect(heat).toMatchObject({ cell: 1, max: 20 });
    const sessions = await (await get(`/api/replay/${scene}/sessions`)).json();
    expect(sessions.sessions).toHaveLength(2);

    expect((await get(`/api/replay/no-such-room`)).status).toBe(404);
    expect((await get(`/api/replay/${scene}?from=${T0}&to=${T0 - 1}`)).status).toBe(400);

    // live recording lands in the next answer (the route flushes first)
    scenes.add(`${scene}-live`);
    const now = Date.now() / 1000;
    presence.push(`${scene}-live`, [person('w-1', 'Brianna', 'web', 1, 1)], now);
    const live = await (await get(`/api/replay/${scene}-live`)).json();
    expect(live.people.map((p: { name: string }) => p.name)).toEqual(['Brianna']);

    const status = await (await get('/api/replay/status')).json();
    expect(status.written).toBe(1);
    expect(status.database).not.toContain('password');
    await replay.stop();
  }, 30_000);

  test('off without a URL', async () => {
    const replay = createReplay({ url: '', presence: fakePresence(), getScene: async () => null });
    replay.start();
    const res = await replay.routes['/api/replay/:sceneId'](new Request('http://localhost/api/replay/abc'));
    expect(res.status).toBe(503);
    expect((await replay.routes['/api/replay/status'](new Request('http://localhost/api/replay/status')).then((r) => r.json())).enabled).toBe(false);
    await replay.stop();
  });
});
