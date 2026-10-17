// Social layer networking: presence parsing and units, the request body, the server clock, the
// 4 Hz presence loop against a fake server, the /ws dispatcher and fetchJson's failure handling.

import { describe, expect, test } from 'bun:test';
import {
  ClockSync,
  PresenceClient,
  SocialSocket,
  fetchJson,
  parsePerson,
  parsePresence,
  presenceBody,
  questId,
  toSeconds,
  validSceneId,
  webId,
  wrapAngle,
  type FetchLike,
  type PresenceSnapshot,
} from '../web/src/viewer/social/presence-client.ts';

describe('parsePerson', () => {
  test('reads the contract shape (metres)', () => {
    const p = parsePerson({ id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, age: 0.12, head: [0.42, 1.62, -1.1], hands: [[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]] })!;
    expect(p).toMatchObject({ id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, age: 0.12 });
    expect(p.head).toEqual([0.42, 1.62, -1.1]);
    expect(p.hands![1]).toEqual([0.65, 1.25, -1.35]);
  });

  test('rejects unusable entries and fills sensible defaults', () => {
    expect(parsePerson(null)).toBeNull();
    expect(parsePerson({ id: 'x', x: 'a', z: 0 })).toBeNull();
    expect(parsePerson({ x: 1, z: 1 })).toBeNull();
    const r = parsePerson({ id: 'rbx-12345', x: 1, z: 2 })!;
    expect(r.kind).toBe('roblox');
    expect(r.y).toBe(0);
    expect(r.yaw).toBe(0);
    expect(r.name).toBe('Roblox player');
    expect(r.head).toBeNull();
    expect(r.hands).toBeNull();
    expect(parsePerson({ id: 'quest-2', x: 0, z: 0 })!.kind).toBe('vr');
    expect(parsePerson({ id: 'web-7f3a19c2', x: 0, z: 0, kind: 'alien' })!.kind).toBe('web');
  });

  test('names are capped at 40 characters, yaw is wrapped, ages are clamped', () => {
    const p = parsePerson({ id: 'web-1', name: 'x'.repeat(80), x: 0, z: 0, yaw: 3 * Math.PI, age: -3 })!;
    expect(p.name.length).toBe(40);
    expect(p.yaw).toBeCloseTo(Math.PI, 6);
    expect(p.age).toBe(0);
  });

  test('one missing hand is replaced by the other; null hands stay null', () => {
    expect(parsePerson({ id: 'q', x: 0, z: 0, hands: [null, [1, 1, 1]] })!.hands).toEqual([[1, 1, 1], [1, 1, 1]]);
    expect(parsePerson({ id: 'q', x: 0, z: 0, hands: null })!.hands).toBeNull();
    expect(parsePerson({ id: 'q', x: 0, z: 0, hands: [[NaN, 0, 0], null] })!.hands).toBeNull();
  });

  test('studs convert to metres axis for axis (3.57 studs per metre)', () => {
    const p = parsePerson({ id: 'rbx-1', x: 4, y: 0, z: -3.57, yaw: 1.57, head: [3.57, 5.712, 0] }, 3.57)!;
    expect(p.x).toBeCloseTo(4 / 3.57, 6);
    expect(p.z).toBeCloseTo(-1, 6);
    expect(p.head![1]).toBeCloseTo(1.6, 6);
    expect(p.yaw).toBeCloseTo(1.57, 6);
  });
});

describe('parsePresence', () => {
  test('people list, own ids excluded, duplicates dropped', () => {
    const s = parsePresence(
      { t: 1760715600.31, people: [{ id: 'quest-1', x: 0, z: 0 }, { id: 'rbx-1', name: 'shivin', kind: 'roblox', x: 1.05, z: -0.38 }, { id: 'rbx-1', x: 9, z: 9 }, { bogus: true }] },
      new Set(['quest-1']),
    )!;
    expect(s.t).toBeCloseTo(1760715600.31, 3);
    expect(s.people.map((p) => p.id)).toEqual(['rbx-1']);
    expect(s.people[0].x).toBe(1.05);
  });

  test('metres by default, studs only when the payload says so', () => {
    expect(parsePresence({ others: [{ id: 'quest-1', x: 3.57, z: 0 }] })!.people[0].x).toBe(3.57);
    expect(parsePresence({ units: 'studs', people: [{ id: 'quest-1', x: 3.57, z: 0 }] })!.people[0].x).toBeCloseTo(1, 6);
    expect(parsePresence({ studsPerMeter: 3.57, others: [{ id: 'quest-1', x: 7.14, z: 0 }] })!.people[0].x).toBeCloseTo(2, 6);
  });

  test('times: seconds stay seconds, milliseconds become seconds, junk is null', () => {
    expect(toSeconds(1760715600.31)).toBeCloseTo(1760715600.31, 2);
    expect(toSeconds(1760715600310)).toBeCloseTo(1760715600.31, 2);
    expect(toSeconds('soon')).toBeNull();
    expect(parsePresence([{ id: 'a', x: 0, z: 0 }])!.t).toBeNull();
    expect(parsePresence({ nope: 1 })).toBeNull();
  });

  test('scene ids follow the server rule', () => {
    expect(validSceneId('game-night-k3x9a')).toBe(true);
    expect(validSceneId('-bad')).toBe(false);
    expect(validSceneId('Upper')).toBe(false);
    expect(validSceneId('a'.repeat(97))).toBe(false);
  });
});

describe('presenceBody', () => {
  test('VR posts head and hands (or null hands), the browser posts only the feet', () => {
    const vr = presenceBody('quest-1', 'Judge', 'vr', { x: 0.421234, y: 0, z: -1.1, yaw: 0.3, head: [0.42, 1.62, -1.1], hands: null });
    expect(vr).toEqual({ id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.421, y: 0, z: -1.1, yaw: 0.3, head: [0.42, 1.62, -1.1], hands: null });
    const web = presenceBody('web-0011aabb', 'Maya', 'web', { x: 1, y: 0, z: 2, yaw: 7, head: [1, 1.6, 2], hands: [[0, 0, 0], [1, 1, 1]] });
    expect(web.head).toBeUndefined();
    expect(web.hands).toBeUndefined();
    expect(web.yaw as number).toBeCloseTo(wrapAngle(7), 3);
  });
});

describe('ClockSync', () => {
  test('keeps the smallest-delay estimate and slews toward it without jumps', () => {
    const c = new ClockSync();
    expect(c.synced).toBe(false);
    c.add(1000.0, 10.0); // offset 990.0 (received with some delay)
    expect(c.serverNow(11)).toBeCloseTo(1001, 6);
    c.add(1000.6, 10.5); // offset 990.1: the faster reply wins
    expect(c.target).toBeCloseTo(990.1, 6);
    // moved toward it by at most a few milliseconds
    const after = c.serverNow(11) - 1001;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(0.02);
    // more samples converge on it
    for (let i = 1; i <= 40; i++) c.add(1000.6 + i * 0.25, 10.5 + i * 0.25 + (i % 2) * 0.05);
    expect(c.serverNow(30) - 30).toBeCloseTo(990.1, 2);
    expect(c.toLocal(c.serverNow(30))).toBeCloseTo(30, 6);
  });

  test('a server restart (big jump) starts over', () => {
    const c = new ClockSync();
    c.add(1000, 10);
    c.add(5000, 11);
    expect(c.serverNow(11)).toBeCloseTo(5000, 6);
  });
});

function fakeServer(handler: (method: string, url: string, body: unknown) => { status: number; body: unknown; delayMs?: number; html?: boolean }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const r = handler(method, url, body);
    if (r.delayMs) await Bun.sleep(r.delayMs);
    if (r.status === 0) throw new TypeError('network down');
    return new Response(r.html ? '<html>530</html>' : JSON.stringify(r.body), { status: r.status });
  };
  return { f, calls };
}

const until = async (cond: () => boolean, ms = 1000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await Bun.sleep(5);
};

describe('PresenceClient', () => {
  const make = (f: FetchLike, extra: Partial<ConstructorParameters<typeof PresenceClient>[0]> = {}) => {
    const snaps: PresenceSnapshot[] = [];
    const status: boolean[] = [];
    const ownIds = new Set<string>();
    const c = new PresenceClient({
      baseUrl: 'http://x',
      sceneId: 'room-1',
      clock: new ClockSync(),
      ownIds,
      getKind: () => 'vr',
      getId: () => 'quest-1',
      getName: () => 'Judge',
      getPose: () => ({ x: 1, y: 0, z: 2, yaw: 0.5, head: [1, 1.6, 2], hands: null }),
      onSnapshot: (s) => snaps.push(s),
      onStatus: (on) => status.push(on),
      fetchImpl: f,
      ...extra,
    });
    return { c, snaps, status, ownIds };
  };

  test('posts about 4 times a second and delivers everyone else', async () => {
    const srv = fakeServer((m) => ({ status: 200, body: { t: 100, people: [{ id: 'rbx-1', name: 's', kind: 'roblox', x: 1, z: 1, age: 0.1 }, { id: 'quest-1', x: 0, z: 0 }] } }));
    const { c, snaps, ownIds } = make(srv.f);
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += 1 / 60;
      c.tick(1 / 60, now);
      await Bun.sleep(0);
    }
    await until(() => !c['inFlight']);
    const posts = srv.calls.filter((x) => x.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(3);
    expect(posts.length).toBeLessThanOrEqual(5);
    expect(posts[0].url).toBe('http://x/api/presence/room-1');
    expect(posts[0].body).toMatchObject({ id: 'quest-1', kind: 'vr', x: 1, z: 2, head: [1, 1.6, 2], hands: null });
    expect(ownIds.has('quest-1')).toBe(true);
    expect(snaps.length).toBe(posts.length);
    expect(snaps[0].people.map((p) => p.id)).toEqual(['rbx-1']);
  });

  test('never queues: a slow request skips ticks', async () => {
    const srv = fakeServer(() => ({ status: 200, body: { t: 1, people: [] }, delayMs: 120 }));
    const { c } = make(srv.f);
    for (let i = 0; i < 10; i++) c.tick(0.3, i * 0.3);
    expect(srv.calls.length).toBe(1);
    await until(() => !c['inFlight']);
  });

  test('POST failing falls back to GET; repeated failure backs off and reports offline once', async () => {
    let mode: 'post-broken' | 'down' = 'post-broken';
    const srv = fakeServer((m) => (mode === 'down' ? { status: 0, body: null } : m === 'POST' ? { status: 500, body: { error: 'boom' } } : { status: 200, body: { t: 5, people: [{ id: 'web-1', x: 0, z: 0 }] } }));
    const { c, snaps, status } = make(srv.f);
    c.tick(0.3, 1);
    await until(() => snaps.length === 1);
    expect(srv.calls.map((x) => x.method)).toEqual(['POST', 'GET']);
    expect(status).toEqual([true]);
    mode = 'down';
    let now = 2;
    for (let i = 0; i < 40; i++) {
      now += 0.3;
      c.tick(0.3, now);
      await until(() => !c['inFlight']);
    }
    expect(status).toEqual([true, false]);
    // backoff: far fewer than one attempt (POST + GET) per tick
    const attempts = (srv.calls.length - 2) / 2;
    expect(attempts).toBeLessThan(12);
  });

  test('an unknown scene (404) does not also poll GET', async () => {
    const srv = fakeServer(() => ({ status: 404, body: { error: 'No such scene' } }));
    const { c } = make(srv.f);
    c.tick(0.3, 1);
    await until(() => !c['inFlight'] && srv.calls.length > 0);
    await Bun.sleep(5);
    expect(srv.calls.map((x) => x.method)).toEqual(['POST']);
  });

  test('without a pose it only listens (GET)', async () => {
    const srv = fakeServer(() => ({ status: 200, body: { t: 1, people: [] } }));
    const { c } = make(srv.f, { getPose: () => null });
    c.tick(0.3, 1);
    await until(() => srv.calls.length === 1 && !c['inFlight']);
    expect(srv.calls[0].method).toBe('GET');
  });

  test('socket snapshots count; GET polling pauses while they are fresh', async () => {
    const srv = fakeServer(() => ({ status: 200, body: { t: 1, people: [] } }));
    const { c, snaps } = make(srv.f, { getPose: () => null });
    c.ingest({ type: 'presence', t: 9, people: [{ id: 'rbx-2', x: 1, z: 1 }] }, 1);
    expect(snaps.length).toBe(1);
    c.tick(0.3, 1.1);
    await Bun.sleep(5);
    expect(srv.calls.length).toBe(0);
  });
});

describe('SocialSocket', () => {
  test('dispatches by type, drops other scenes, unknown types and bad JSON', () => {
    const got: string[] = [];
    const s = new SocialSocket('ws://x/ws', 'room-1', () => {
      throw new Error('not used');
    });
    s.on('note', (m) => got.push(`note:${(m.note as { id: string }).id}`));
    s.on('roblox', (m) => got.push(`roblox:${(m.event as { type: string }).type}`));
    s.handle(JSON.stringify({ type: 'note', sceneId: 'room-1', note: { id: 'n1' } }));
    s.handle(JSON.stringify({ type: 'note', sceneId: 'other', note: { id: 'n2' } }));
    s.handle(JSON.stringify({ type: 'roblox', sceneId: 'room-1', event: { type: 'tag' } }));
    s.handle(JSON.stringify({ type: 'health', health: {} }));
    s.handle('{not json');
    s.handle(42);
    expect(got).toEqual(['note:n1', 'roblox:tag']);
  });

  test('a throwing handler does not stop the others', () => {
    const s = new SocialSocket('ws://x/ws', 'r', () => {
      throw new Error('x');
    });
    const got: number[] = [];
    s.on('cue', () => {
      throw new Error('bad handler');
    });
    s.on('cue', () => got.push(1));
    const warn = console.warn;
    console.warn = () => undefined;
    s.handle(JSON.stringify({ type: 'cue', action: 'reality', on: true }));
    console.warn = warn;
    expect(got).toEqual([1]);
  });

  test('reconnects after the socket closes', async () => {
    const made: Array<{ onopen: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null }> = [];
    const s = new SocialSocket('ws://x/ws', 'r', () => {
      const ws = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null, close() {} };
      made.push(ws);
      return ws;
    });
    const states: boolean[] = [];
    s.onStatus = (c) => states.push(c);
    s.start();
    made[0].onopen?.({});
    made[0].onclose?.({});
    await until(() => made.length === 2, 2000);
    expect(made.length).toBe(2);
    expect(states).toEqual([true, false]);
    s.close();
  });
});

describe('fetchJson', () => {
  test('an HTML error page means the link is down', async () => {
    const srv = fakeServer(() => ({ status: 530, body: null, html: true }));
    const r = await fetchJson('http://x/api/notes/a', { fetchImpl: srv.f });
    expect(r.ok).toBe(false);
    expect(r.down).toBe(true);
  });

  test('times out instead of hanging', async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const t0 = Date.now();
    const r = await fetchJson('http://x', { timeoutMs: 60, fetchImpl: hang });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r).toMatchObject({ ok: false, status: 0, error: 'timed out', down: true });
  });

  test('passes the server error sentence through', async () => {
    const srv = fakeServer(() => ({ status: 400, body: { error: 'x must be a finite number' } }));
    const r = await fetchJson('http://x', { method: 'POST', body: {}, fetchImpl: srv.f });
    expect(r.error).toBe('x must be a finite number');
    expect(r.down).toBe(false);
  });
});

describe('ids: one per tab for browsers, quest-1 only on the demo headset', () => {
  function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
    };
  }
  const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
  function withStorage(fn: (local: Storage, session: Storage) => void) {
    const saved = { local: g.localStorage, session: g.sessionStorage };
    const local = memoryStorage();
    const session = memoryStorage();
    g.localStorage = local;
    g.sessionStorage = session;
    try {
      fn(local, session);
    } finally {
      g.localStorage = saved.local;
      g.sessionStorage = saved.session;
    }
  }

  test('webId lives in sessionStorage: a reload keeps it, a second tab gets its own', () => {
    withStorage((local, session) => {
      const a = webId();
      expect(a).toMatch(/^web-[0-9a-f]{8}$/);
      expect(webId()).toBe(a); // same tab, after a reload
      expect(local.getItem('dv.social.webId')).toBeNull(); // not shared across tabs
      session.clear(); // another tab starts with its own session storage
      expect(webId()).not.toBe(a);
    });
  });

  test('questId: ?follow=1 or ?quest=1 is the demo headset and is remembered; anything else is a guest', () => {
    withStorage((local) => {
      const guest = questId(new URLSearchParams(''));
      expect(guest).toMatch(/^quest-g[0-9a-f]{7}$/);
      expect(questId(new URLSearchParams(''))).toBe(guest); // the same device keeps its guest id
      expect(guest > 'quest-1' && guest > 'quest-2').toBe(true); // sorts after the demo headsets
      expect(questId(new URLSearchParams('follow=1'))).toBe('quest-1');
      expect(questId(new URLSearchParams(''))).toBe('quest-1'); // remembered on the demo headset
      expect(questId(new URLSearchParams('quest=2'))).toBe('quest-2');
      expect(local.getItem('dv.social.questId')).toBe('quest-2');
      local.setItem('dv.social.questId', 'quest-1; drop table');
      expect(questId(new URLSearchParams(''))).toMatch(/^quest-g[0-9a-f]{7}$/);
    });
  });
});
