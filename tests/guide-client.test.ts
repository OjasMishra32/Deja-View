// The guide's relay client against a real local server (timeouts, retries, offline detection,
// the hotspot store), plus the small pure helpers the guide and its captions use.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { Scene } from '../shared/types.ts';
import { followTarget, yawOffset } from '../web/src/viewer/guide/captions.ts';
import { wrapLines } from '../web/src/viewer/guide/hotspots.ts';
import { GuideClient, GuideRequestError, decodableImage, isVideoScene, questionAbout, readingSeconds } from '../web/src/viewer/guide/index.ts';
import { flipRows, snapshotSize } from '../web/src/viewer/guide/snapshot.ts';
import { freeHarnessPort } from './harness/guide-harness.ts';

let server: ReturnType<typeof Bun.serve>;
let base = '';
const hits = new Map<string, number>();
const stored = new Map<string, unknown>();

beforeAll(async () => {
  const port = await freeHarnessPort();
  server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const n = (hits.get(url.pathname) ?? 0) + 1;
      hits.set(url.pathname, n);
      const j = (d: unknown, status = 200) => Response.json(d, { status });
      switch (url.pathname) {
        case '/api/guide/ask': {
          const body = (await req.json()) as { question?: string };
          return j({ question: body.question, answer: 'ok', speech: null });
        }
        case '/api/guide/narrate':
          return j({ error: 'guide offline' }, 502);
        case '/html':
          return new Response('<!doctype html><title>530</title>', { status: 530, headers: { 'content-type': 'text/html' } });
        case '/text':
          return new Response('fine, thanks', { status: 200, headers: { 'content-type': 'text/plain' } });
        case '/bad':
          return j({ error: 'Send audio or a question.' }, 400);
        case '/slow':
          await Bun.sleep(1500);
          return j({ late: true });
        case '/flaky':
          return n < 3 ? j({ error: 'guide offline' }, 502) : j({ ok: true, attempt: n });
        default: {
          const m = /^\/api\/scenes\/([^/]+)\/hotspots$/.exec(url.pathname);
          if (m) {
            if (req.method === 'PUT') {
              stored.set(m[1], await req.json());
              return j({ ok: true });
            }
            return stored.has(m[1]) ? j(stored.get(m[1])) : j({ error: 'No labels stored for this scene.' }, 404);
          }
          return j({ error: 'Not found.' }, 404);
        }
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

async function failure(p: Promise<unknown>): Promise<GuideRequestError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GuideRequestError);
    return e as GuideRequestError;
  }
  throw new Error('expected a failure');
}

describe('GuideClient', () => {
  test('posts JSON and returns the answer', async () => {
    const c = new GuideClient(base + '/');
    const r = await c.ask({ question: 'who won?', scene: { id: 's' }, history: [] }, { timeoutMs: 2000 });
    expect(r).toEqual({ question: 'who won?', answer: 'ok', speech: null });
  });

  test('502 {"error":"guide offline"} is an unavailable http error with the server sentence', async () => {
    const e = await failure(new GuideClient(base).narrate({ image: 'data:image/jpeg;base64,', scene: { id: 's' } }, { timeoutMs: 2000 }));
    expect(e.kind).toBe('http');
    expect(e.status).toBe(502);
    expect(e.message).toBe('guide offline');
    expect(e.unavailable).toBe(true);
  });

  test('an HTML error page (tunnel down) counts as offline', async () => {
    const e = await failure(new GuideClient(base).request('GET', '/html', undefined, { timeoutMs: 2000 }));
    expect(e.kind).toBe('offline');
    expect(e.unavailable).toBe(true);
  });

  test('a 200 that is not JSON is a bad response', async () => {
    const e = await failure(new GuideClient(base).request('GET', '/text', undefined, { timeoutMs: 2000 }));
    expect(e.kind).toBe('bad-response');
  });

  test('a 400 is our mistake, not an outage', async () => {
    const e = await failure(new GuideClient(base).request('GET', '/bad', undefined, { timeoutMs: 2000 }));
    expect(e.kind).toBe('http');
    expect(e.unavailable).toBe(false);
    expect(e.message).toBe('Send audio or a question.');
  });

  test('times out', async () => {
    const t0 = performance.now();
    const e = await failure(new GuideClient(base).request('GET', '/slow', undefined, { timeoutMs: 200 }));
    expect(e.kind).toBe('timeout');
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test('a closed port is offline', async () => {
    const e = await failure(new GuideClient('http://127.0.0.1:9').request('GET', '/x', undefined, { timeoutMs: 2000 }));
    expect(e.kind).toBe('offline');
  });

  test('retries an outage with the given delays, then succeeds', async () => {
    hits.delete('/flaky');
    const r = await new GuideClient(base).request<{ attempt: number }>('GET', '/flaky', undefined, { timeoutMs: 2000, retryDelaysMs: [20, 20, 20] });
    expect(r.attempt).toBe(3);
  });

  test('retryOn can refuse a retry; 4xx is never retried by default', async () => {
    hits.delete('/flaky');
    const e = await failure(new GuideClient(base).request('GET', '/flaky', undefined, { timeoutMs: 2000, retryDelaysMs: [10, 10], retryOn: () => false }));
    expect(e.status).toBe(502);
    expect(hits.get('/flaky')).toBe(1);
    hits.delete('/bad');
    await failure(new GuideClient(base).request('GET', '/bad', undefined, { timeoutMs: 2000, retryDelaysMs: [10, 10] }));
    expect(hits.get('/bad')).toBe(1);
  });

  test('an abort cancels without retrying', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    hits.delete('/slow');
    const e = await failure(new GuideClient(base).request('GET', '/slow', undefined, { timeoutMs: 5000, signal: ctrl.signal, retryDelaysMs: [10, 10] }));
    expect(e.kind).toBe('aborted');
    expect(hits.get('/slow')).toBe(1);
  });

  test('the hotspot store: 404 is "none yet", PUT then GET round-trips', async () => {
    const c = new GuideClient(base);
    expect(await c.storedHotspots('room-1', 1000)).toBeNull();
    expect(await c.storeHotspots('room-1', { hotspots: [{ label: 'TV', blurb: '', x: 0, y: 1.4, z: -3 }] }, 1000)).toBe(true);
    expect(await c.storedHotspots('room-1', 1000)).toEqual({ hotspots: [{ label: 'TV', blurb: '', x: 0, y: 1.4, z: -3 }] });
    expect(await new GuideClient('http://127.0.0.1:9').storedHotspots('room-1', 500)).toBeNull();
  });
});

describe('helpers', () => {
  test('questionAbout reads naturally', () => {
    expect(questionAbout('Snack bowl')).toBe('Tell me about the snack bowl.');
    expect(questionAbout('TV screen')).toBe('Tell me about the TV screen.');
    expect(questionAbout("Maya's controller")).toBe("Tell me about Maya's controller.");
    expect(questionAbout('The big window!')).toBe('Tell me about the big window.');
    expect(questionAbout('  ')).toBe('What am I looking at?');
  });

  test('readingSeconds grows with the text, within limits', () => {
    expect(readingSeconds('Hi')).toBe(3.5);
    expect(readingSeconds('word '.repeat(20))).toBeCloseTo(7.6, 5);
    expect(readingSeconds('word '.repeat(200))).toBe(14);
  });

  test('video worlds keep Space for play/pause', () => {
    const base = { id: 'x', name: 'x', status: 'ready', createdAt: '', updatedAt: '' } as const;
    expect(isVideoScene({ ...base, mode: 'thirdwheel' } as Scene)).toBe(true);
    expect(isVideoScene({ ...base, mode: 'video' } as unknown as Scene)).toBe(true);
    expect(isVideoScene({ ...base, mode: 'rentfree' } as Scene)).toBe(false);
    expect(isVideoScene({ ...base, mode: 'rentfree' } as Scene, () => true)).toBe(true);
  });

  test('only browser-decodable inputs are sent', () => {
    expect(decodableImage('input/00.jpg')).toBe(true);
    expect(decodableImage('input/00.JPEG')).toBe(true);
    expect(decodableImage('plate.png')).toBe(true);
    expect(decodableImage('input/IMG_1.HEIC')).toBe(false);
    expect(decodableImage('input/video.mp4')).toBe(false);
    expect(decodableImage(undefined)).toBe(false);
  });

  test('wrapLines wraps, ellipsises the last line, and cuts single long words', () => {
    const m = (s: string) => s.length;
    expect(wrapLines('one two three four', 9, m, 3)).toEqual(['one two', 'three', 'four']);
    expect(wrapLines('one two three four five six', 9, m, 2)).toEqual(['one two', 'three…']);
    expect(wrapLines('supercalifragilistic', 8, m, 2)).toEqual(['superca…']);
    expect(wrapLines('', 8, m, 2)).toEqual([]);
  });

  test('snapshot size: 1024 wide (contracts 8: about 1024 x 768), aspect clamped, even height', () => {
    expect(snapshotSize(16 / 10)).toEqual({ width: 1024, height: 640 });
    expect(snapshotSize(4 / 3)).toEqual({ width: 1024, height: 768 });
    expect(snapshotSize(3.5)).toEqual({ width: 1024, height: 568 });
    expect(snapshotSize(0.5)).toEqual({ width: 1024, height: 1024 });
    expect(snapshotSize(Number.NaN)).toEqual({ width: 1024, height: 768 });
    expect(snapshotSize(4 / 3, 768)).toEqual({ width: 768, height: 576 });
  });

  test('flipRows turns GL rows top-down', () => {
    const src = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    expect([...flipRows(src, 2, 2)]).toEqual([3, 3, 3, 3, 4, 4, 4, 4, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('the headset panel sits in front, below the eyes, and knows when you looked away', () => {
    const head = new THREE.Vector3(1, 1.6, 2);
    const p = followTarget(head, 0, { distance: 1.25, drop: 0.3, recentreDeg: 24, glide: 4 });
    expect([p.x, p.y, p.z]).toEqual([1, 1.3, 0.75]);
    const left = followTarget(head, Math.PI / 2, { distance: 1, drop: 0, recentreDeg: 24, glide: 4 });
    expect(left.x).toBeCloseTo(0, 9);
    expect(left.z).toBeCloseTo(2, 9);
    expect(yawOffset(head, 0, p)).toBeCloseTo(0, 9);
    expect(yawOffset(head, Math.PI / 2, p)).toBeCloseTo(-Math.PI / 2, 9);
    expect(Math.abs(yawOffset(head, Math.PI, p))).toBeCloseTo(Math.PI, 9);
  });
});
