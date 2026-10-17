// describeForJob (server/integrations/describe.ts): resize first, one time budget, null on any failure.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike, Logger } from '../server/integrations/config.ts';
import { cleanCaption, describeForJob, imageDataUrlForGuide } from '../server/integrations/describe.ts';
import { createGuideClient } from '../server/integrations/guide.ts';

const quiet: Logger = { info: () => {}, warn: () => {} };
let root = '';
let big = '';
const hasFfmpeg = !!Bun.which('ffmpeg');

/** Width and height from a JPEG's SOF marker. */
function jpegSize(b: Uint8Array): { width: number; height: number } {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (m >= 0xc0 && m <= 0xc3) return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dv-describe-'));
  big = join(root, 'photo.jpg');
  if (hasFfmpeg) {
    const p = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2400x1600:rate=1', '-frames:v', '1', '-q:v', '3', big]);
    if (p.exitCode !== 0) throw new Error('could not make the test photo');
  }
});
afterAll(() => rm(root, { recursive: true, force: true }));

function client(handler: (body: any, init?: RequestInit) => Response | Promise<Response>, url: string | null = 'http://guide.test') {
  const seen: any[] = [];
  const f: FetchLike = async (_u, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seen.push(body);
    return handler(body, init);
  };
  const c = createGuideClient({ config: { url, key: null, timeouts: { describe: 5000, hotspots: 1, narrate: 1, ask: 1, health: 200 } }, fetch: f, log: quiet });
  return { c, seen };
}

describe('describeForJob', () => {
  test.skipIf(!hasFfmpeg)('shrinks a big photo to 1024 px on the long side before sending it', async () => {
    const url = await imageDataUrlForGuide(big, { maxSide: 1024 });
    expect(url).toStartWith('data:image/jpeg;base64,');
    const bytes = Buffer.from(url!.split(',')[1]!, 'base64');
    expect(jpegSize(bytes)).toEqual({ width: 1024, height: 682 });
    expect(bytes.length).toBeLessThan(400_000);
  });

  test.skipIf(!hasFfmpeg)('returns the cleaned caption', async () => {
    const { c, seen } = client(() => Response.json({ caption: '  "A bright dorm room\nwith a lofted bed."  ', ms: { understand: 900 } }));
    expect(await describeForJob(big, { client: c, log: quiet })).toBe('A bright dorm room with a lofted bed.');
    expect(Object.keys(seen[0])).toEqual(['image']);
  });

  test.skipIf(!hasFfmpeg)('null when the guide is degraded, down, slow or off', async () => {
    const degraded = client(() => Response.json({ caption: '', degraded: true, error: 'gemini timeout' }));
    expect(await describeForJob(big, { client: degraded.c, log: quiet })).toBeNull();

    const down = client(() => {
      throw Object.assign(new Error('refused'), { code: 'ConnectionRefused' });
    });
    expect(await describeForJob(big, { client: down.c, log: quiet })).toBeNull();
    down.c.close();

    const slow = client((_b, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const t0 = performance.now();
    expect(await describeForJob(big, { client: slow.c, timeoutMs: 900, log: quiet })).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1500);
    slow.c.close();

    const off = client(() => Response.json({ caption: 'x' }), null);
    expect(await describeForJob(big, { client: off.c, log: quiet })).toBeNull();
    expect(off.seen.length).toBe(0);
  });

  test('null for a file that does not exist (and no guide call)', async () => {
    const { c, seen } = client(() => Response.json({ caption: 'A room.' }));
    expect(await describeForJob(join(root, 'missing.jpg'), { client: c, log: quiet })).toBeNull();
    expect(seen.length).toBe(0);
  });

  test('cleanCaption', () => {
    expect(cleanCaption('  A   small room.  ')).toBe('A small room.');
    expect(cleanCaption('A room')).toBeNull(); // too short to be a world prompt
    expect(cleanCaption('')).toBeNull();
    expect(cleanCaption(42)).toBeNull();
    const long = 'A sentence about the room. '.repeat(40);
    const out = cleanCaption(long)!;
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith('.')).toBe(true);
  });
});
