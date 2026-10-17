import { describe, expect, test } from 'bun:test';
import {
  ingestPayload,
  normalizeYaw,
  parsePresenceBody,
  PresenceStore,
  robloxWsMessage,
  type PersonInput,
  type PersonView,
} from '../server/social/presence.ts';

function clock(start = 1_760_715_600_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function person(id: string, extra: Partial<PersonInput> = {}): PersonInput {
  return { id, name: id, kind: 'vr', x: 0, y: 0, z: 0, yaw: 0, ...extra };
}

describe('PresenceStore: who is where', () => {
  test('stores people per scene and computes age on read', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now });
    s.upsert('room-a', person('quest-1', { x: 0.42, z: -1.1, yaw: 0.3, hands: [[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]] }));
    c.advance(120);
    const snap = s.snapshot('room-a');
    expect(snap.t).toBeCloseTo(c.now() / 1000, 3);
    expect(snap.people).toHaveLength(1);
    const p = snap.people[0]!;
    expect(p).toMatchObject({ id: 'quest-1', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3 });
    expect(p.age).toBeCloseTo(0.12, 3);
    expect(p.hands).toEqual([[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]]);
    expect(s.snapshot('room-b').people).toEqual([]);
  });

  test('drops anyone silent for longer than the TTL (3 s by default)', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now });
    expect(s.ttlMs).toBe(3000);
    s.upsert('room-a', person('quest-1'));
    c.advance(2900);
    s.upsert('room-a', person('web-1', { kind: 'web' }));
    expect(s.snapshot('room-a').people.map((p) => p.id).sort()).toEqual(['quest-1', 'web-1']);
    c.advance(200); // quest-1 is now 3.1 s old
    expect(s.snapshot('room-a').people.map((p) => p.id)).toEqual(['web-1']);
    expect(s.sceneOf('quest-1')).toBeUndefined();
    expect(s.get('quest-1')).toBeNull();
    c.advance(3001);
    expect(s.snapshot('room-a').people).toEqual([]);
    expect(s.activeScenes()).toEqual([]);
  });

  test('an id is in one scene at a time', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now });
    s.upsert('room-a', person('quest-1'));
    const r = s.upsert('room-b', person('quest-1'));
    expect(r).toEqual({ ok: true, moved: 'room-a' });
    expect(s.snapshot('room-a').people).toEqual([]);
    expect(s.snapshot('room-b').people.map((p) => p.id)).toEqual(['quest-1']);
    expect(s.sceneOf('quest-1')).toBe('room-b');
  });

  test('snapshot can leave out the caller', () => {
    const s = new PresenceStore();
    s.upsert('r', person('quest-1'));
    s.upsert('r', person('rbx-1', { kind: 'roblox' }));
    expect(s.snapshot('r', ['quest-1']).people.map((p) => p.id)).toEqual(['rbx-1']);
  });

  test('rate limit per id (token bucket) refills over time', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now, rate: { perSecond: 4, burst: 3 } });
    for (let i = 0; i < 3; i++) expect(s.upsert('r', person('quest-1')).ok).toBe(true);
    const r = s.upsert('r', person('quest-1'));
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'rate') expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(s.upsert('r', person('quest-2')).ok).toBe(true); // other ids are not affected
    c.advance(260);
    expect(s.upsert('r', person('quest-1')).ok).toBe(true);
  });

  test('a scene is capped', () => {
    const s = new PresenceStore({ maxPerScene: 2 });
    expect(s.upsert('r', person('a')).ok).toBe(true);
    expect(s.upsert('r', person('b')).ok).toBe(true);
    expect(s.upsert('r', person('c'))).toEqual({ ok: false, reason: 'full' });
    expect(s.upsert('r', person('a')).ok).toBe(true); // an existing id still updates
  });

  test('syncServer drops a Roblox server\'s players the moment they stop being listed', () => {
    const s = new PresenceStore();
    s.upsert('r', person('rbx-1', { kind: 'roblox', server: 'job-a' }));
    s.upsert('r', person('rbx-2', { kind: 'roblox', server: 'job-a' }));
    s.upsert('r', person('rbx-3', { kind: 'roblox', server: 'job-b' }));
    expect(s.syncServer('r', 'job-a', ['rbx-1'])).toEqual(['rbx-2']);
    expect(s.snapshot('r').people.map((p) => p.id).sort()).toEqual(['rbx-1', 'rbx-3']);
  });

  test('activeHeadset is the demo headset (quest-1), else a numbered one, else the most recently heard guest', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now });
    expect(s.activeHeadset()).toBeNull();
    s.upsert('room-g', person('quest-g1a2b3c'));
    c.advance(100);
    s.upsert('room-h', person('quest-gffff000'));
    expect(s.activeHeadset()).toEqual({ sceneId: 'room-h', id: 'quest-gffff000' });
    s.upsert('room-b', person('quest-2'));
    expect(s.activeHeadset()).toEqual({ sceneId: 'room-b', id: 'quest-2' });
    c.advance(100);
    s.upsert('room-a', person('quest-1'));
    c.advance(100);
    // a guest headset on a shared link, heard later, never takes over the demo headset's world
    s.upsert('room-c', person('quest-g0000001'));
    s.upsert('room-d', person('web-1', { kind: 'web' }));
    expect(s.activeHeadset()).toEqual({ sceneId: 'room-a', id: 'quest-1' });
  });

  test('yaw is wrapped into (-pi, pi]', () => {
    expect(normalizeYaw(0)).toBe(0);
    expect(normalizeYaw(Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeYaw(-Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeYaw(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    expect(normalizeYaw(-7)).toBeCloseTo(-7 + 2 * Math.PI);
    const s = new PresenceStore();
    s.upsert('r', person('q', { yaw: 2 * Math.PI + 0.25 }));
    expect(s.snapshot('r').people[0]!.yaw).toBeCloseTo(0.25, 3);
  });
});

describe('PresenceStore: subscribers', () => {
  test('onPresence: immediate push, throttled, heartbeat, and exactly one empty push when the last person leaves', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now, emitMs: 200, heartbeatMs: 1000 });
    const got: { scene: string; ids: string[]; t: number }[] = [];
    s.onPresence((scene, people, t) => got.push({ scene, ids: people.map((p) => p.id), t }));
    s.upsert('r', person('quest-1'));
    expect(got).toHaveLength(1); // first change goes out at once
    c.advance(50);
    s.upsert('r', person('rbx-1', { kind: 'roblox' }));
    expect(got).toHaveLength(1); // throttled
    c.advance(160);
    s.tick();
    expect(got).toHaveLength(2);
    expect(got[1]!.ids.sort()).toEqual(['quest-1', 'rbx-1']);
    // nothing moves: a heartbeat at least once a second while anyone is there
    c.advance(1000);
    s.upsert('r', person('quest-1'));
    s.upsert('r', person('rbx-1', { kind: 'roblox' }));
    const before = got.length;
    c.advance(1001);
    s.tick();
    expect(got.length).toBeGreaterThan(before);
    // everyone goes silent: one empty snapshot, then nothing
    c.advance(3100);
    s.tick();
    const last = got[got.length - 1]!;
    expect(last.ids).toEqual([]);
    const n = got.length;
    c.advance(2000);
    s.tick();
    s.tick();
    expect(got.length).toBe(n);
  });

  test('moving scenes pushes both scenes', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now });
    const got: string[] = [];
    s.onPresence((scene, people) => got.push(`${scene}:${people.length}`));
    s.upsert('a', person('quest-1'));
    c.advance(300);
    s.upsert('b', person('quest-1'));
    expect(got).toEqual(['a:1', 'a:0', 'b:1']);
  });

  test('a throwing subscriber never breaks the store or other subscribers', () => {
    const logs: string[] = [];
    const s = new PresenceStore({ log: (m) => logs.push(m) });
    let ok = 0;
    s.onPresence(() => {
      throw new Error('boom');
    });
    s.onPresence(() => ok++);
    s.onEvent(() => {
      throw new Error('bang');
    });
    expect(s.upsert('r', person('q')).ok).toBe(true);
    expect(ok).toBe(1);
    const ev = s.publishEvent('r', { type: 'tag', by: 'quest-1', target: 'rbx-1' });
    expect(ev.t).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
    expect(logs.some((l) => l.includes('bang'))).toBe(true);
  });

  test('onEvent gets t added; unsubscribe works; currentRound tracks a running round', () => {
    const c = clock();
    const s = new PresenceStore({ now: c.now });
    const got: unknown[] = [];
    const off = s.onEvent((scene, ev) => got.push({ scene, ev }));
    s.publishEvent('r', { type: 'round', state: 'start', scores: { 'quest-1': 0 }, duration: 25 });
    expect(got).toHaveLength(1);
    expect((got[0] as any).ev.t).toBeCloseTo(c.now() / 1000, 3);
    expect(s.currentRound('r')?.duration).toBe(25);
    c.advance(31_000);
    expect(s.currentRound('r')).toBeNull();
    s.publishEvent('r', { type: 'round', state: 'start', scores: {} });
    s.publishEvent('r', { type: 'round', state: 'end', scores: {} });
    expect(s.currentRound('r')).toBeNull();
    off();
    s.publishEvent('r', { type: 'tag', by: 'quest-1', target: 'rbx-1' });
    expect(got).toHaveLength(3);
  });

  test('start/stop runs the tick on a timer', async () => {
    const s = new PresenceStore({ ttlMs: 60, tickMs: 10, emitMs: 0 });
    const got: number[] = [];
    s.onPresence((_scene, people) => got.push(people.length));
    s.start();
    s.upsert('r', person('q'));
    await Bun.sleep(150);
    s.stop();
    expect(got[0]).toBe(1);
    expect(got[got.length - 1]).toBe(0);
  });
});

describe('POST /api/presence body validation', () => {
  const ok = { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, head: [0.42, 1.62, -1.1], hands: [[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]] };

  test('accepts the contract example', () => {
    const r = parsePresenceBody(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, z: -1.1 });
      expect(r.value.head).toEqual([0.42, 1.62, -1.1]);
      expect(r.value.hands).toHaveLength(2);
    }
  });

  test('names the bad field', () => {
    const r = parsePresenceBody({ ...ok, x: 'a' });
    expect(r).toEqual({ ok: false, error: 'x must be a finite number' });
    expect(parsePresenceBody({ ...ok, yaw: null })).toEqual({ ok: false, error: 'yaw must be a finite number' });
    expect(parsePresenceBody({ ...ok, z: Infinity }).ok).toBe(false);
  });

  test('refuses unknown kinds, long names, odd ids, Roblox ids and far positions', () => {
    expect(parsePresenceBody({ ...ok, kind: 'robot' }).ok).toBe(false);
    expect(parsePresenceBody({ ...ok, kind: 'roblox' }).ok).toBe(false);
    expect(parsePresenceBody({ ...ok, name: 'x'.repeat(41) }).ok).toBe(false);
    expect(parsePresenceBody({ ...ok, name: 'x'.repeat(40) }).ok).toBe(true);
    expect(parsePresenceBody({ ...ok, id: '../etc' }).ok).toBe(false);
    expect(parsePresenceBody({ ...ok, id: 'rbx-1' }).ok).toBe(false);
    expect(parsePresenceBody({ ...ok, x: 5000 }).ok).toBe(false);
    expect(parsePresenceBody([1, 2]).ok).toBe(false);
    expect(parsePresenceBody(null).ok).toBe(false);
  });

  test('kind defaults from the id; a lost hand means no hands; names are cleaned', () => {
    const r = parsePresenceBody({ id: 'web-7f3a19c2', x: 0, y: 0, z: 0, yaw: 0, hands: [[1, 2, 3], null], name: ' Maya\u0007 ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('web');
      expect(r.value.hands).toBeUndefined();
      expect(r.value.name).toBe('Maya');
    }
    const q = parsePresenceBody({ id: 'quest-2', x: 0, y: 0, z: 0, yaw: 0, hands: null });
    expect(q.ok && q.value.kind).toBe('vr');
    expect(q.ok && q.value.name).toBe('Headset');
  });
});

describe('payload helpers', () => {
  const people: PersonView[] = [
    { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, age: 0.1, hands: [[0, 1, 0], [1, 1, 0]], head: [0, 1.6, 0] },
  ];

  test('ingestPayload keeps exactly the 7 fields and at most 32 people', () => {
    const body = ingestPayload('room', people, 12.5);
    expect(body).toEqual({ sceneId: 'room', t: 12.5, people: [{ id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3 }] });
    const many = Array.from({ length: 40 }, (_, i) => ({ ...people[0]!, id: `web-${i}` }));
    expect(ingestPayload('room', many, 1).people).toHaveLength(32);
  });

  test('robloxWsMessage is the /ws shape', () => {
    const ev = { type: 'tag', by: 'quest-1', target: 'rbx-1', t: 1.5 };
    expect(robloxWsMessage('room', ev)).toEqual({ type: 'roblox', sceneId: 'room', event: ev });
  });
});
