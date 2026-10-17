// DeepSpace presence push and notes relay (server/integrations/deepspace.ts) against a fake fetch and a manual clock.
import { describe, expect, test } from 'bun:test';
import type { DeepSpaceConfig, FetchLike, Logger } from '../server/integrations/config.ts';
import {
  createDeepSpaceForwarder,
  createNotesRelay,
  createPresenceFeed,
  presenceFromGetter,
  toIngestPeople,
  validateNoteInput,
  wrapYaw,
  type PresencePerson,
} from '../server/integrations/deepspace.ts';

const DS = 'http://ds.test';
const CFG: DeepSpaceConfig = {
  url: DS,
  key: 'k-123',
  pushHz: 4,
  idleHz: 4,
  pushTimeoutMs: 2000,
  notesIntervalMs: 2000,
  notesTimeoutMs: 2000,
  notesPostTimeoutMs: 2000,
  maxPeople: 32,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(handler: (c: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f: FetchLike = async (input, init) => {
    const h = new Headers(init?.headers);
    const c: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(h),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    return handler(c, init);
  };
  return { f, calls };
}

const ok = (body: unknown = { ok: true }, status = 200) => Response.json(body, { status });

function recorder(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) };
}

const judge = (x = 0.42): PresencePerson => ({ id: 'quest-1', name: 'Judge', kind: 'vr', x, y: 0, z: -1.1, yaw: 0.3, hands: [[0, 1, 0], [1, 1, 0]], head: [x, 1.6, -1.1], age: 0.1 });
const shivin: PresencePerson = { id: 'rbx-12345', name: 'shivin', kind: 'roblox', x: 1.05, y: 0, z: -0.38, yaw: 1.57 };

function clock(start = 1_760_715_600_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the ingest shape', () => {
  test('only the 7 fields, rounded, names clipped to 40, kinds guessed, bad people dropped', () => {
    const people = toIngestPeople([
      judge(0.123456),
      { id: 'web-7f3a19c2', name: 'x'.repeat(60), x: 1, y: 0, z: 2, yaw: 7 },
      { id: 'rbx-9', name: 'nan', kind: 'roblox', x: NaN, y: 0, z: 0, yaw: 0 },
      { id: 'quest-1', name: 'dupe', kind: 'vr', x: 9, y: 9, z: 9, yaw: 0 },
      { id: '', name: 'no id', kind: 'web', x: 0, y: 0, z: 0, yaw: 0 } as PresencePerson,
    ]);
    expect(people).toEqual([
      { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.123, y: 0, z: -1.1, yaw: 0.3 },
      { id: 'web-7f3a19c2', name: 'x'.repeat(40), kind: 'web', x: 1, y: 0, z: 2, yaw: Math.round(wrapYaw(7) * 1e4) / 1e4 },
    ]);
    for (const p of people) expect(Object.keys(p).sort()).toEqual(['id', 'kind', 'name', 'x', 'y', 'yaw', 'z']);
  });

  test('at most 32 people, and the headset is never the one cut', () => {
    const crowd: PresencePerson[] = Array.from({ length: 40 }, (_, i) => ({ id: `rbx-${i}`, name: `p${i}`, kind: 'roblox', x: i, y: 0, z: 0, yaw: 0 }));
    const people = toIngestPeople([...crowd, judge()]);
    expect(people.length).toBe(32);
    expect(people[0]!.id).toBe('quest-1');
  });

  test('accepts the {t, people} shape of GET /api/presence', () => {
    expect(toIngestPeople({ people: [shivin] })).toHaveLength(1);
    expect(toIngestPeople(null)).toEqual([]);
  });

  test('yaw wraps the short way into (-pi, pi]', () => {
    expect(wrapYaw(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapYaw(-Math.PI)).toBe(Math.PI);
    expect(wrapYaw(0.5)).toBeCloseTo(0.5);
  });
});

describe('presence adapters', () => {
  test('a push feed forgets a scene that stopped reporting (no ghost dots)', () => {
    const c = clock();
    const feed = createPresenceFeed({ now: c.now, staleMs: 3500 });
    feed.onPresence('room-a', [judge()]);
    feed.onPresence('room-b', { people: [shivin] });
    feed.onPresence('BAD ID', [judge()]);
    expect([...(feed.snapshot() as Map<string, unknown>).keys()].sort()).toEqual(['room-a', 'room-b']);
    c.advance(2000);
    feed.onPresence('room-b', [shivin]);
    c.advance(2000);
    expect(feed.scenes()).toEqual(['room-b']);
    feed.onPresence('room-b', []);
    expect(feed.scenes()).toEqual([]);
  });

  test('a getter adapter asks each scene', async () => {
    const src = presenceFromGetter({ scenes: () => ['a-1', 'b-2'], get: async (id) => (id === 'a-1' ? { t: 1, people: [judge()] } as any : []) });
    const snap = (await src.snapshot()) as [string, unknown][];
    expect(snap.map(([id]) => id)).toEqual(['a-1', 'b-2']);
  });
});

describe('presence forwarder', () => {
  function setup(handler: Parameters<typeof fakeFetch>[0] = () => ok({ ok: true, people: 1 }), cfg: Partial<DeepSpaceConfig> = {}) {
    const c = clock();
    const feed = createPresenceFeed({ now: c.now });
    const { f, calls } = fakeFetch(handler);
    const log = recorder();
    const fw = createDeepSpaceForwarder({ config: { ...CFG, ...cfg }, source: feed, fetch: f, now: c.now, log });
    /** n ticks, `step` ms apart, waiting for every push to settle. */
    const run = async (n: number, step = 250) => {
      for (let i = 0; i < n; i++) {
        await fw.tick();
        await fw.idle();
        c.advance(step);
      }
    };
    return { c, feed, f, calls, fw, log, run };
  }

  test('pushes a full snapshot with the key, 4 times a second', async () => {
    const s = setup();
    s.feed.onPresence('game-night-k3x9a', [judge(), shivin]);
    for (let i = 0; i < 8; i++) {
      s.feed.onPresence('game-night-k3x9a', [judge(0.42 + i * 0.1), shivin]);
      await s.run(1);
    }
    expect(s.calls.length).toBe(8);
    const first = s.calls[0]!;
    expect(first.url).toBe(`${DS}/api/ingest`);
    expect(first.method).toBe('POST');
    expect(first.headers['x-dejaview-key']).toBe('k-123');
    expect(first.headers['content-type']).toBe('application/json');
    expect(first.body).toEqual({
      sceneId: 'game-night-k3x9a',
      t: 1_760_715_600,
      people: [
        { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3 },
        { id: 'rbx-12345', name: 'shivin', kind: 'roblox', x: 1.05, y: 0, z: -0.38, yaw: 1.57 },
      ],
    });
    expect(s.calls[1]!.body.t).toBe(1_760_715_600.25);
    expect(s.fw.status().up).toBe(true);
  });

  test('never more than about 4 Hz, even when ticked faster; keeps pushing when nobody moves', async () => {
    const s = setup();
    for (let i = 0; i < 40; i++) {
      s.feed.onPresence('room-a', [judge()]);
      await s.run(1, 50); // 2 s of 50 ms ticks
    }
    expect(s.calls.length).toBeGreaterThanOrEqual(7);
    expect(s.calls.length).toBeLessThanOrEqual(10);
  });

  test('one push per scene per tick, for every scene with people', async () => {
    const s = setup();
    s.feed.onPresence('room-a', [judge()]);
    s.feed.onPresence('room-b', [shivin]);
    await s.run(1);
    expect(s.calls.map((c) => c.body.sceneId).sort()).toEqual(['room-a', 'room-b']);
    expect(s.fw.activeScenes().sort()).toEqual(['room-a', 'room-b']);
  });

  test('skips (never queues) while the previous push is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async () => {
      await gate;
      return ok();
    });
    s.feed.onPresence('room-a', [judge()]);
    for (let i = 0; i < 6; i++) {
      s.feed.onPresence('room-a', [judge()]);
      await s.fw.tick();
      s.c.advance(250);
    }
    expect(s.calls.length).toBe(1);
    expect(s.fw.status().skippedInFlight).toBe(5);
    release();
    await s.fw.idle();
    s.feed.onPresence('room-a', [judge()]);
    await s.fw.tick();
    expect(s.calls.length).toBe(2);
  });

  test('exactly one push with people: [] when the last person leaves', async () => {
    const s = setup();
    s.feed.onPresence('room-a', [judge()]);
    await s.run(2);
    s.feed.onPresence('room-a', []);
    await s.run(8);
    const bodies = s.calls.map((c) => c.body);
    expect(bodies.length).toBe(3);
    expect(bodies[2]).toEqual({ sceneId: 'room-a', t: expect.any(Number), people: [] });
    expect(s.fw.activeScenes()).toEqual([]);
  });

  test('a scene that just goes quiet (presence layer drops it) also gets its one empty push', async () => {
    const s = setup();
    s.feed.onPresence('room-a', [judge()]);
    await s.run(1);
    s.c.advance(5000); // the feed's 3.5 s staleness passes with no update
    await s.run(4);
    expect(s.calls.map((c) => c.body.people.length)).toEqual([1, 0]);
  });

  test('backs off when DeepSpace is down (1 s, 2 s, 4 s ...), logs once, and recovers', async () => {
    let up = false;
    const s = setup(() => {
      if (!up) throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' });
      return ok();
    });
    const keepAlive = () => s.feed.onPresence('room-a', [judge()]);
    keepAlive();
    await s.run(1); // fails at t=0 -> wait 1 s
    for (let i = 0; i < 3; i++) {
      keepAlive();
      await s.run(1);
    } // t = 250..750: backing off
    expect(s.calls.length).toBe(1);
    keepAlive();
    await s.run(1); // t = 1000: retry, fails -> wait 2 s
    expect(s.calls.length).toBe(2);
    for (let i = 0; i < 7; i++) {
      keepAlive();
      await s.run(1);
    } // until t = 2750
    expect(s.calls.length).toBe(2);
    up = true;
    keepAlive();
    await s.run(1); // t = 3000: retry succeeds
    expect(s.calls.length).toBe(3);
    keepAlive();
    await s.run(1);
    expect(s.calls.length).toBe(4); // back to 4 Hz
    const warns = s.log.lines.filter((l) => l.startsWith('warn'));
    expect(warns.length).toBe(1);
    expect(s.log.lines.some((l) => l.includes('DeepSpace is back'))).toBe(true);
    expect(s.fw.status().up).toBe(true);
  });

  test('an HTML error page (dead tunnel) counts as down; a wrong key backs off for at least 10 s', async () => {
    let status = 502;
    const s = setup(() =>
      status === 502 ? new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }) : ok({ error: 'unauthorized' }, 401),
    );
    s.feed.onPresence('room-a', [judge()]);
    await s.run(1);
    expect(s.fw.status().up).toBe(false);
    expect(s.fw.status().lastError).toContain('HTML');
    status = 401;
    s.c.advance(1000);
    s.feed.onPresence('room-a', [judge()]);
    await s.run(1);
    expect(s.fw.status().lastError).toContain('DS_KEY');
    for (let i = 0; i < 36; i++) {
      s.feed.onPresence('room-a', [judge()]);
      await s.run(1);
    } // 9 s
    expect(s.calls.length).toBe(2);
  });

  test('a 400 is a contract bug: logged once, no backoff', async () => {
    const s = setup(() => ok({ error: 'name of quest-1 must be a string' }, 400));
    for (let i = 0; i < 4; i++) {
      s.feed.onPresence('room-a', [judge()]);
      await s.run(1);
    }
    expect(s.calls.length).toBe(4);
    expect(s.log.lines.filter((l) => l.includes('refused a presence push')).length).toBe(1);
  });

  test('a push that hangs is cut at the timeout and does not pile up', async () => {
    const s = setup(
      (_c, init) =>
        new Promise<Response>((_r, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      { pushTimeoutMs: 60 },
    );
    s.feed.onPresence('room-a', [judge()]);
    const t0 = performance.now();
    await s.fw.tick();
    await s.fw.tick(); // in flight: skipped
    await s.fw.idle();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(s.calls.length).toBe(1);
    expect(s.fw.status().lastError).toContain('timed out');
  });

  test('does nothing without DS_URL', async () => {
    const s = setup(undefined, { url: null });
    s.feed.onPresence('room-a', [judge()]);
    s.fw.start();
    await s.run(4);
    s.fw.stop();
    expect(s.calls.length).toBe(0);
    expect(s.fw.status().enabled).toBe(false);
    expect(s.fw.activeScenes()).toEqual(['room-a']);
  });

  test('a presence source that throws never breaks the loop', async () => {
    const c = clock();
    const { f, calls } = fakeFetch(() => ok());
    let bad = true;
    const fw = createDeepSpaceForwarder({
      config: CFG,
      source: { snapshot: () => (bad ? Promise.reject(new Error('boom')) : new Map([['room-a', [judge()]]])) },
      fetch: f,
      now: c.now,
      log: recorder(),
    });
    await fw.tick();
    bad = false;
    await fw.tick();
    await fw.idle();
    expect(calls.length).toBe(1);
  });
});

describe('notes relay', () => {
  const note = (id: string, ageMs: number, now: number, extra: Record<string, unknown> = {}) => ({
    id,
    sceneId: 'room-a',
    author: 'Brianna',
    text: `note ${id}`,
    x: 1.2,
    y: 1.4,
    z: -0.8,
    createdAt: new Date(now - ageMs).toISOString(),
    userId: 'should-not-leak',
    ...extra,
  });

  function setup(opts: { active?: string[]; handler?: Parameters<typeof fakeFetch>[0] } = {}) {
    const c = clock();
    const store: any[] = [];
    let down = false;
    const { f, calls } = fakeFetch(
      opts.handler ??
        ((call) => {
          if (down) throw Object.assign(new Error('refused'), { code: 'ConnectionRefused' });
          if (call.method === 'GET') return ok({ notes: store });
          const n = { id: `n_${store.length}`, ...call.body, createdAt: new Date(c.now()).toISOString() };
          store.push(n);
          return ok({ ok: true, note: n }, 201);
        }),
    );
    const announced: { sceneId: string; ids: string[] }[] = [];
    const active = new Set(opts.active ?? ['room-a']);
    const relay = createNotesRelay({
      config: CFG,
      activeScenes: () => active,
      fetch: f,
      now: c.now,
      log: recorder(),
      onNotes: (sceneId, notes) => announced.push({ sceneId, ids: notes.map((n) => n.id) }),
      firstWaitMs: 200,
    });
    const step = async (ms = 250) => {
      await relay.tick();
      await relay.idle();
      c.advance(ms);
    };
    return { c, store, calls, relay, announced, active, step, setDown: (v: boolean) => (down = v) };
  }

  test('reads at once for a new scene, then every 2 s, with the key', async () => {
    const s = setup();
    for (let i = 0; i < 17; i++) await s.step(); // 4.25 s
    const gets = s.calls.filter((c) => c.method === 'GET');
    expect(gets.length).toBe(3); // t = 0, 2, 4 s
    expect(gets[0]!.url).toBe(`${DS}/api/notes?sceneId=room-a`);
    expect(gets[0]!.headers['x-dejaview-key']).toBe('k-123');
  });

  test('announces only ids it has not seen; old notes on the first read are taken as known', async () => {
    const s = setup();
    const t = s.c.now();
    s.store.push(note('n_old', 60_000, t), note('n_recent', 3000, t));
    await s.step(2000);
    expect(s.announced).toEqual([{ sceneId: 'room-a', ids: ['n_recent'] }]);
    s.store.push(note('n_new', 0, s.c.now()));
    await s.step(2000);
    await s.step(2000);
    expect(s.announced).toEqual([
      { sceneId: 'room-a', ids: ['n_recent'] },
      { sceneId: 'room-a', ids: ['n_new'] },
    ]);
    const list = await s.relay.list('room-a');
    expect(list.notes.map((n) => n.id)).toEqual(['n_old', 'n_recent', 'n_new']);
    expect(Object.keys(list.notes[0]!).sort()).toEqual(['author', 'createdAt', 'id', 'sceneId', 'text', 'x', 'y', 'z']);
    expect(list.offline).toBeUndefined();
  });

  test('keeps serving the last good list when DeepSpace is unreachable, and backs off', async () => {
    const s = setup();
    s.store.push(note('n_1', 60_000, s.c.now()));
    await s.step(2000);
    s.setDown(true);
    const before = s.calls.length;
    for (let i = 0; i < 40; i++) await s.step(250); // 10 s
    const polls = s.calls.length - before;
    expect(polls).toBeLessThanOrEqual(3); // 2 s, 4 s, 8 s backoff instead of 5 polls
    const list = await s.relay.list('room-a');
    expect(list.notes.map((n) => n.id)).toEqual(['n_1']);
    expect(list.offline).toBe(true);
    s.setDown(false);
    for (let i = 0; i < 40; i++) await s.step(250);
    expect((await s.relay.list('room-a')).offline).toBeUndefined();
  });

  test('a scene nobody is in is read on demand, then kept warm while the headset asks', async () => {
    const s = setup({ active: [] });
    s.store.push(note('n_1', 60_000, s.c.now(), { sceneId: 'quiet-room' }));
    const first = await s.relay.list('quiet-room');
    expect(first.notes.map((n) => n.id)).toEqual(['n_1']);
    const n = s.calls.length;
    for (let i = 0; i < 9; i++) await s.step(); // 2.25 s: watched, so polled again
    expect(s.calls.length).toBe(n + 1);
    s.c.advance(20_000); // nobody asked for 20 s: polling stops
    const m = s.calls.length;
    for (let i = 0; i < 12; i++) await s.step();
    expect(s.calls.length).toBe(m);
  });

  test('forwards a headset note with sceneId added, returns DeepSpace answer, announces it once', async () => {
    const s = setup();
    await s.step();
    const r = await s.relay.create('room-a', { author: 'Judge', text: '  Best seat in the house ', x: 0.6, z: -1.1 });
    expect(r.status).toBe(201);
    expect((r.body as any).note.text).toBe('Best seat in the house');
    const post = s.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${DS}/api/notes`);
    expect(post.headers['x-dejaview-key']).toBe('k-123');
    expect(post.body).toEqual({ sceneId: 'room-a', author: 'Judge', text: 'Best seat in the house', x: 0.6, y: 1.4, z: -1.1 });
    for (let i = 0; i < 10; i++) await s.step();
    expect(s.announced.map((a) => a.ids)).toEqual([['n_0']]);
    expect((await s.relay.list('room-a')).notes.map((n) => n.id)).toEqual(['n_0']);
  });

  test('bad notes never leave the server; an outage is 502 notes offline', async () => {
    const s = setup();
    expect((await s.relay.create('room-a', { text: '', x: 0, z: 0 })).status).toBe(400);
    expect((await s.relay.create('room-a', { text: 'x'.repeat(121), x: 0, z: 0 })).status).toBe(400);
    expect((await s.relay.create('room-a', { text: 'hi', x: 'a', z: 0 })).status).toBe(400);
    expect((await s.relay.create('NOT A SCENE', { text: 'hi', x: 0, z: 0 })).status).toBe(404);
    expect(s.calls.length).toBe(0);
    s.setDown(true);
    expect(await s.relay.create('room-a', { text: 'hi', x: 0, z: 0 })).toEqual({ status: 502, body: { error: 'notes offline' } });
  });

  test('a wrong key is reported as notes offline (logged for the operator)', async () => {
    const s = setup({ handler: () => ok({ error: 'unauthorized' }, 401) });
    expect((await s.relay.create('room-a', { text: 'hi', x: 0, z: 0 })).status).toBe(502);
    expect(s.relay.status().lastError).toContain('DS_KEY');
  });

  test('a DeepSpace 400 is passed through with its sentence', async () => {
    const s = setup({ handler: () => ok({ error: 'text must be 1 to 120 characters' }, 400) });
    expect(await s.relay.create('room-a', { text: 'hi', x: 0, z: 0 })).toEqual({ status: 400, body: { error: 'text must be 1 to 120 characters' } });
  });

  test('without DS_URL: empty lists, 502 on create, no calls', async () => {
    const relay = createNotesRelay({ config: { ...CFG, url: null }, log: recorder() });
    expect(await relay.list('room-a')).toEqual({ notes: [] });
    expect((await relay.create('room-a', { text: 'hi', x: 0, z: 0 })).status).toBe(502);
  });

  test('note validation', () => {
    expect(validateNoteInput({ text: 'hi', x: 1, y: 2, z: 3, author: 'A'.repeat(50) })).toEqual({ ok: true, note: { author: 'A'.repeat(40), text: 'hi', x: 1, y: 2, z: 3 } });
    expect(validateNoteInput({ text: 'hi', x: 1, z: 3 })).toEqual({ ok: true, note: { author: 'Judge', text: 'hi', x: 1, y: 1.4, z: 3 } });
    expect(validateNoteInput({ text: 'hi', x: 1, y: 'up', z: 3 }).ok).toBe(false);
    expect(validateNoteInput(null).ok).toBe(false);
  });

  test('a listener that throws does not stop the others', async () => {
    const s = setup();
    const got: string[] = [];
    s.relay.onNotes(() => {
      throw new Error('boom');
    });
    const off = s.relay.onNotes((_id, notes) => got.push(...notes.map((n) => n.id)));
    s.store.push(note('n_x', 0, s.c.now()));
    await s.step();
    expect(got).toEqual(['n_x']);
    off();
    await flush();
  });
});

describe('with the real presence store (server/social/presence.ts)', () => {
  test('presenceFromGetter over PresenceStore: 7-field pushes, then one empty push when the person times out', async () => {
    const { PresenceStore } = await import('../server/social/presence.ts');
    const c = clock();
    const store = new PresenceStore({ now: c.now });
    const { f, calls } = fakeFetch(() => ok());
    const fw = createDeepSpaceForwarder({
      config: CFG,
      source: presenceFromGetter({ scenes: () => store.activeScenes(), get: (id) => store.snapshot(id) }),
      fetch: f,
      now: c.now,
      log: recorder(),
    });
    store.upsert('game-night-k3x9a', { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, hands: [[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]], head: [0.42, 1.62, -1.1] });
    await fw.tick();
    await fw.idle();
    expect(calls[0]!.body.people).toEqual([{ id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3 }]);
    for (let i = 0; i < 16; i++) {
      c.advance(250); // 4 s of silence: the store drops the headset after 3 s
      await fw.tick();
      await fw.idle();
    }
    const sizes = calls.map((x) => x.body.people.length);
    expect(sizes.filter((n) => n === 0).length).toBe(1);
    expect(sizes.at(-1)).toBe(0);
  });
});
