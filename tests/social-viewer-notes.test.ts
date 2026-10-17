// Notes: parsing (defaults and limits), placement without overlaps, where a pointed note lands,
// and the notes client against a fake server (list, post, offline).

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { NOTE_DEFAULT_Y, NOTE_GAP, NotesClient, aimNoteTarget, easeOutBack, parseNote, parseNotes, placeNotes, type Note } from '../web/src/viewer/social/notes.ts';
import type { FetchLike } from '../web/src/viewer/social/presence-client.ts';

const N = (id: string, x: number, y: number, z: number, createdAt?: string): Note => ({ id, author: 'A', text: 't', x, y, z, createdAt });

describe('parseNote', () => {
  test('the contract shape', () => {
    const n = parseNote({ id: 'n_8f2k1q', sceneId: 'game-night-k3x9a', author: 'Brianna', text: "Seb's seat. He was too scared to show up.", x: 1.2, y: 1.4, z: -0.8, createdAt: '2026-10-17T22:41:07Z' })!;
    expect(n).toMatchObject({ id: 'n_8f2k1q', author: 'Brianna', x: 1.2, y: 1.4, z: -0.8 });
  });

  test('defaults and limits: y 1.4, text 120, author 40, whitespace collapsed', () => {
    const n = parseNote({ id: 7, text: `  hi\n\n${'x'.repeat(200)}`, x: 0, z: 0, author: 'b'.repeat(60) })!;
    expect(n.id).toBe('7');
    expect(n.y).toBe(NOTE_DEFAULT_Y);
    expect(n.text.length).toBe(120);
    expect(n.text.startsWith('hi x')).toBe(true);
    expect(n.author.length).toBe(40);
    expect(parseNote({ id: 'a', text: 'x', x: 0, z: 0 })!.author).toBe('Someone');
  });

  test('unusable notes are skipped, duplicates keep the first', () => {
    expect(parseNote({ id: 'a', text: '', x: 0, z: 0 })).toBeNull();
    expect(parseNote({ id: 'a', text: 'x', x: 'left', z: 0 })).toBeNull();
    const list = parseNotes({ notes: [{ id: 'a', text: 'one', x: 0, z: 0 }, { id: 'a', text: 'two', x: 0, z: 0 }, null, { id: 'b', text: 'b', x: 1, z: 1 }] })!;
    expect(list.map((n) => n.text)).toEqual(['one', 'b']);
    expect(parseNotes({ nope: [] })).toBeNull();
    expect(parseNotes([{ id: 'c', text: 'c', x: 0, z: 0 }])!.length).toBe(1);
  });
});

describe('placeNotes', () => {
  test('notes far apart stay exactly where they were left', () => {
    const p = placeNotes([N('a', 0, 1.4, 0), N('b', 2, 1.4, 0)]);
    expect(p.get('a')).toEqual([0, 1.4, 0]);
    expect(p.get('b')).toEqual([2, 1.4, 0]);
  });

  test('a note on top of an older one is stacked above it, oldest stays put', () => {
    const p = placeNotes([N('new', 0.1, 1.4, 0, '2026-10-17T22:42:00Z'), N('old', 0, 1.4, 0, '2026-10-17T22:41:00Z')]);
    expect(p.get('old')).toEqual([0, 1.4, 0]);
    const q = p.get('new')!;
    expect(q[1]).toBeCloseTo(1.4 + NOTE_GAP.height + 0.02, 6);
    expect(q[0]).toBe(0.1);
  });

  test('stacks never overlap, and heights stay readable', () => {
    const notes = Array.from({ length: 9 }, (_, i) => N(`n${i}`, 0, 1.4, 0, `2026-10-17T22:4${i}:00Z`));
    notes.push(N('low', 5, -2, 5), N('high', 8, 9, 8));
    const p = placeNotes(notes);
    const all = [...p.values()];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const overlap = Math.hypot(a[0] - b[0], a[2] - b[2]) < NOTE_GAP.radius && Math.abs(a[1] - b[1]) < NOTE_GAP.height;
        expect(overlap).toBe(false);
      }
    for (const v of all) {
      expect(v[1]).toBeGreaterThanOrEqual(0.35);
      expect(v[1]).toBeLessThanOrEqual(2.6);
    }
    expect(p.get('low')![1]).toBe(0.35);
    expect(p.get('high')![1]).toBe(2.6);
  });

  test('placement is deterministic whatever order the server lists notes in', () => {
    const a = [N('x', 0, 1.4, 0, '2026-10-17T22:41:00Z'), N('y', 0, 1.4, 0, '2026-10-17T22:42:00Z')];
    expect([...placeNotes(a).entries()].sort()).toEqual([...placeNotes([...a].reverse()).entries()].sort());
  });
});

describe('aimNoteTarget', () => {
  const wall = { solidAt: (_x: number, _y: number, z: number) => z <= -2 };
  test('lands just in front of the first solid surface along the ray', () => {
    const { point, hit } = aimNoteTarget(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 0, -1), wall);
    expect(hit).toBe(true);
    expect(point.z).toBeGreaterThan(-2);
    expect(point.z).toBeLessThan(-1.7);
    expect(point.y).toBeCloseTo(1.4, 6);
  });

  test('nothing hit (or no collider): a comfortable distance along the ray', () => {
    const a = aimNoteTarget(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(1, 0, 0), wall);
    expect(a.hit).toBe(false);
    expect(a.point.x).toBeCloseTo(1.6, 6);
    const b = aimNoteTarget(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 0, -1), null);
    expect(b.point.z).toBeCloseTo(-1.6, 6);
  });

  test('pointing at the floor keeps the note at a readable height', () => {
    const { point, hit } = aimNoteTarget(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, -1, -0.3), { solidAt: () => false });
    expect(hit).toBe(true);
    expect(point.y).toBeGreaterThanOrEqual(0.45);
  });
});

describe('easeOutBack', () => {
  test('starts at 0, overshoots, ends at 1', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 9);
    expect(easeOutBack(1)).toBeCloseTo(1, 9);
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1);
  });
});

describe('NotesClient', () => {
  const server = (handler: (method: string, body: any) => { status: number; body: unknown }) => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const f: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const r = handler(method, body);
      if (r.status === 0) throw new TypeError('down');
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return { f, calls };
  };

  test('first list is marked initial, later ones are not', async () => {
    const s = server(() => ({ status: 200, body: { notes: [{ id: 'a', text: 'hi', x: 0, z: 0 }] } }));
    const got: Array<[number, boolean]> = [];
    const c = new NotesClient({ baseUrl: '', sceneId: 'room-1', fetchImpl: s.f, onList: (l, initial) => got.push([l.length, initial]) });
    await c.poll();
    await c.poll();
    expect(got).toEqual([[1, true], [1, false]]);
    expect(s.calls[0].url).toBe('/api/notes/room-1');
  });

  test('polls every 2.5 s without the socket and less often with it', () => {
    let up = false;
    const c = new NotesClient({ baseUrl: '', sceneId: 'r', onList: () => undefined, socketUp: () => up });
    expect(c.interval).toBe(2.5);
    up = true;
    expect(c.interval).toBe(6);
  });

  test('post sends {author, text, x, y, z} and returns the stored note', async () => {
    const s = server((_m, b) => ({ status: 201, body: { ok: true, note: { ...b, id: 'n_1', sceneId: 'r', createdAt: '2026-10-17T22:41:07Z' } } }));
    const c = new NotesClient({ baseUrl: 'http://h', sceneId: 'r', fetchImpl: s.f, onList: () => undefined });
    const r = await c.post('Judge', '  I was   here ', [1.23456, 1.4, -2]);
    expect(s.calls[0]).toMatchObject({ method: 'POST', url: 'http://h/api/notes/r', body: { author: 'Judge', text: 'I was here', x: 1.235, y: 1.4, z: -2 } });
    expect(r.ok && r.note.id).toBe('n_1');
  });

  test('notes offline (502) is reported in words; empty text is refused locally', async () => {
    const s = server(() => ({ status: 502, body: { error: 'notes offline' } }));
    const c = new NotesClient({ baseUrl: '', sceneId: 'r', fetchImpl: s.f, onList: () => undefined });
    const r = await c.post('J', 'hello', [0, 1, 0]);
    expect(r).toEqual({ ok: false, error: 'Notes are offline right now.' });
    expect(await c.post('J', '   ', [0, 1, 0])).toEqual({ ok: false, error: 'A note needs some text.' });
    expect(s.calls.length).toBe(1);
  });

  test('a failing server slows polling down and reports once', async () => {
    const s = server(() => ({ status: 0, body: null }));
    const status: boolean[] = [];
    const c = new NotesClient({ baseUrl: '', sceneId: 'r', fetchImpl: s.f, onList: () => undefined, onStatus: (ok) => status.push(ok) });
    for (let i = 0; i < 4; i++) await c.poll();
    expect(status).toEqual([false]);
    expect(c.interval).toBeGreaterThan(2.5);
  });
});
