import { describe, expect, test } from 'bun:test';
import type { PersonView } from '../server/social/presence.ts';
import {
  CHUNK_PARTS,
  mapChunk,
  mapFileName,
  metresToStuds,
  parseRobloxEvent,
  parseRobloxPresence,
  partsBucket,
  personToStuds,
  robloxId,
  STUDS_PER_METER,
  studsToMetres,
  type BuiltMap,
} from '../server/social/roblox.ts';

describe('studs and metres', () => {
  test('3.57 studs per metre, axis for axis, no offsets', () => {
    expect(STUDS_PER_METER).toBe(3.57);
    expect(studsToMetres(4)).toBeCloseTo(1.12, 2); // contracts 13.2: rbx-1 at x = 4 studs is 1.12 m
    expect(metresToStuds(1.6)).toBeCloseTo(5.71, 2); // a standing head
    expect(studsToMetres(metresToStuds(-2.345))).toBeCloseTo(-2.345, 9);
  });

  test('a person converts to studs with head and hands; yaw, age and names are unchanged', () => {
    const p: PersonView = {
      id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, age: 0.12,
      head: [0.42, 1.62, -1.1], hands: [[0.2, 1.21, -1.4], [0.65, 1.25, -1.35]],
    };
    const s = personToStuds(p);
    expect(s).toMatchObject({ id: 'quest-1', name: 'Judge', kind: 'vr', yaw: 0.3, age: 0.12 });
    expect(s.x).toBeCloseTo(1.499, 3);
    expect(s.z).toBeCloseTo(-3.927, 3);
    expect(s.y).toBe(0);
    expect(s.head![1]).toBeCloseTo(5.783, 3);
    expect(s.hands![0]).toEqual([0.714, 4.32, -4.998]);
    expect(p.x).toBe(0.42); // input untouched
  });

  test('yaw keeps its meaning both ways: facing (-sin yaw, -cos yaw) is the same direction in both frames', () => {
    // A Roblox avatar walking toward -X has LookVector (-1, 0, 0): yaw = atan2(-look.X, -look.Z) = +pi/2 (turned left).
    const look = { X: -1, Z: 0 };
    const yaw = Math.atan2(-look.X, -look.Z);
    const parsed = parseRobloxPresence({ players: [{ id: 'rbx-1', name: 'a', x: 3.57, y: 0, z: 0, yaw }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const m = parsed.value.players[0]!;
    expect(m.yaw).toBeCloseTo(Math.PI / 2, 9);
    // in the room frame (three.js), rotation.y = pi/2 faces (-sin, -cos) = (-1, 0): also toward -X
    expect(-Math.sin(m.yaw)).toBeCloseTo(-1, 9);
    expect(-Math.cos(m.yaw)).toBeCloseTo(0, 9);
    // and it goes back to Roblox unchanged
    const back = personToStuds({ id: m.id, name: m.name, kind: m.kind, x: m.x, y: m.y, z: m.z, yaw: m.yaw, age: 0 });
    expect(back.yaw).toBeCloseTo(yaw, 9);
    expect(back.x).toBeCloseTo(3.57, 3);
  });
});

describe('Roblox presence body', () => {
  test('converts studs to metres and keeps state and server', () => {
    const r = parseRobloxPresence({
      players: [
        { id: 'rbx-12345', name: 'shivin', x: 4.2, y: 0.0, z: -1.5, yaw: 1.57, state: 'playing' },
        { id: 'rbx-67890', name: 'brianna', x: -3.0, y: 0.0, z: 2.4, yaw: -0.4 },
      ],
      server: '8b1c0e3a-6f1d-4f9e-9a55-2f3c1d1e9b77',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = r.value.players;
    expect(a!.x).toBeCloseTo(4.2 / 3.57, 9);
    expect(a!.z).toBeCloseTo(-1.5 / 3.57, 9);
    expect(a!.kind).toBe('roblox');
    expect(a!.state).toBe('playing');
    expect(a!.server).toBe('8b1c0e3a-6f1d-4f9e-9a55-2f3c1d1e9b77');
    expect(b!.name).toBe('brianna');
    expect(r.value.listed).toEqual(['rbx-12345', 'rbx-67890']);
    expect(r.value.skipped).toEqual([]);
  });

  test('skips a bad player instead of failing the batch', () => {
    const r = parseRobloxPresence({
      players: [
        { id: 'rbx-1', name: 'ok', x: 0, y: 0, z: 0, yaw: 0 },
        { id: 'rbx-2', name: 'nan', x: 'oops', y: 0, z: 0, yaw: 0 },
        { id: 'quest-1', name: 'imposter', x: 0, y: 0, z: 0, yaw: 0 },
        7,
        { id: 'rbx-1', name: 'dupe', x: 1, y: 0, z: 0, yaw: 0 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.players.map((p) => p.id)).toEqual(['rbx-1']);
    expect(r.value.skipped.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(r.value.listed).toContain('rbx-2'); // listed even when unusable: never echoed back
  });

  test('accepts bare UserIds, empty Luau tables and long names', () => {
    expect(robloxId(12345)).toBe('rbx-12345');
    expect(robloxId('12345')).toBe('rbx-12345');
    expect(robloxId('rbx-12345')).toBe('rbx-12345');
    expect(robloxId('quest-1')).toBeNull();
    for (const players of [[], {}, undefined, null]) {
      const r = parseRobloxPresence({ players });
      expect(r.ok && r.value.players.length).toBe(0);
    }
    const r = parseRobloxPresence({ players: [{ id: 5, name: 'n'.repeat(60), x: 0, y: 0, z: 0, yaw: 0 }] });
    expect(r.ok && r.value.players[0]!.name.length).toBe(40);
  });

  test('refuses malformed bodies', () => {
    expect(parseRobloxPresence(null).ok).toBe(false);
    expect(parseRobloxPresence({ players: 'x' }).ok).toBe(false);
    expect(parseRobloxPresence({ players: [], server: 'bad id with spaces' }).ok).toBe(false);
    expect(parseRobloxPresence({ players: Array.from({ length: 101 }, (_, i) => ({ id: i })) }).ok).toBe(false);
  });
});

describe('Roblox events', () => {
  test('tag', () => {
    const r = parseRobloxEvent({ type: 'tag', by: 'quest-1', target: 'rbx-12345', targetName: 'shivin', nested: { no: 1 } });
    expect(r).toEqual({ ok: true, value: { type: 'tag', by: 'quest-1', target: 'rbx-12345', targetName: 'shivin' } });
    expect(parseRobloxEvent({ type: 'tag', by: 'quest-1' }).ok).toBe(false);
    expect(parseRobloxEvent({ type: 'tag', by: '../x', target: 'rbx-1' }).ok).toBe(false);
  });

  test('tag keeps a valid running score (the headset scoreboard moves on the tag); a bad one never drops the tag', () => {
    const r = parseRobloxEvent({ type: 'tag', by: 'quest-1', target: 'rbx-111', livesLeft: 2, scores: { 'quest-1': 1, 'rbx-111': 2, 222: 3 } });
    expect(r).toEqual({ ok: true, value: { type: 'tag', by: 'quest-1', target: 'rbx-111', scores: { 'quest-1': 1, 'rbx-111': 2, 'rbx-222': 3 }, livesLeft: 2 } });
    const bad = parseRobloxEvent({ type: 'tag', by: 'quest-1', target: 'rbx-111', scores: { 'quest-1': 'one' } });
    expect(bad).toEqual({ ok: true, value: { type: 'tag', by: 'quest-1', target: 'rbx-111' } });
    expect(parseRobloxEvent({ type: 'tag', by: 'quest-1', target: 'rbx-111', scores: [] })).toEqual({ ok: true, value: { type: 'tag', by: 'quest-1', target: 'rbx-111' } });
  });

  test('round start and end with scores (Luau [] means none)', () => {
    const s = parseRobloxEvent({ type: 'round', state: 'start', scores: { 'quest-1': 0, 'rbx-12345': 3 }, duration: 25, it: 'quest-1' });
    expect(s).toEqual({ ok: true, value: { type: 'round', state: 'start', scores: { 'quest-1': 0, 'rbx-12345': 3 }, duration: 25, it: 'quest-1' } });
    const e = parseRobloxEvent({ type: 'round', state: 'end', scores: [], winner: 'vr' });
    expect(e).toEqual({ ok: true, value: { type: 'round', state: 'end', scores: {}, winner: 'vr' } });
    expect(parseRobloxEvent({ type: 'round', state: 'paused' }).ok).toBe(false);
    expect(parseRobloxEvent({ type: 'round', state: 'start', scores: { 'quest-1': 'x' } }).ok).toBe(false);
    expect(parseRobloxEvent({ type: 'round', state: 'start', duration: -1 }).ok).toBe(false);
  });

  test('unknown moment types pass through with simple fields only', () => {
    const r = parseRobloxEvent({ type: 'toast', text: 'hi', n: 2, deep: [1], t: 99 });
    expect(r).toEqual({ ok: true, value: { type: 'toast', text: 'hi', n: 2 } });
    expect(parseRobloxEvent({ type: 'Bad Type' }).ok).toBe(false);
    expect(parseRobloxEvent([]).ok).toBe(false);
  });
});

describe('map budget and chunks', () => {
  test('maxParts buckets: default 6000, cap 12000, never above the request', () => {
    expect(partsBucket(null)).toBe(6000);
    expect(partsBucket('')).toBe(6000);
    expect(partsBucket('abc')).toBe(6000);
    expect(partsBucket(6000)).toBe(6000);
    expect(partsBucket('3000')).toBe(3000);
    expect(partsBucket(3500)).toBe(3000);
    expect(partsBucket(99999)).toBe(12000);
    expect(partsBucket(5)).toBe(100);
    expect(mapFileName(6000)).toBe('roblox-map.json');
    expect(mapFileName(3000)).toBe('roblox-map-3000.json');
  });

  test('chunks are 1-based, at most 2500 parts, and repeat the header', () => {
    const parts = Array.from({ length: 6001 }, (_, i) => [i, 0, 0, 1, 1, 1, 0, 0, 0]);
    const body = new TextEncoder().encode(JSON.stringify({ sceneId: 's', name: 'S', studsPerMeter: 3.57, spawn: [0, 0, 5], parts }));
    const map: BuiltMap = { key: 'k', body, gzip: body, etag: '"x"', parts: parts.length };
    const c1 = mapChunk(map, 1);
    const c3 = mapChunk(map, 3);
    expect(c1.ok && c1.body).toMatchObject({ sceneId: 's', studsPerMeter: 3.57, spawn: [0, 0, 5], chunk: 1, chunks: 3 });
    expect(c1.ok && (c1.body.parts as unknown[]).length).toBe(CHUNK_PARTS);
    expect(c3.ok && (c3.body.parts as number[][])[0]![0]).toBe(5000);
    expect(c3.ok && (c3.body.parts as unknown[]).length).toBe(1001);
    expect(mapChunk(map, 0).ok).toBe(false);
    expect(mapChunk(map, 4).ok).toBe(false);
    expect(mapChunk(map, 1.5).ok).toBe(false);
  });
});
