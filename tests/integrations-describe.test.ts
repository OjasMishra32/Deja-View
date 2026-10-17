// describeForJob (server/integrations/describe.ts): resize first, one time budget, null on any failure.
// describeClipForJob: a Video memory's frames (at most 8, in clip order, at most 768 px) with scene {id, name}.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike, Logger } from '../server/integrations/config.ts';
import {
  CLIP_FRAME_SIDE,
  MAX_CLIP_FRAMES,
  cleanCaption,
  clipForScene,
  clipFramesForGuide,
  describeClipForJob,
  describeForJob,
  imageDataUrlForGuide,
} from '../server/integrations/describe.ts';
import { createGuideClient } from '../server/integrations/guide.ts';

const quiet: Logger = { info: () => {}, warn: () => {} };
let root = '';
let big = '';
/** 2 s testsrc clips: landscape 1920x1080, portrait 720x1280, and a packed layer (RGB 640x360 above depth + mask). */
let clip = '';
let portrait = '';
let packed = '';
/** 2 s from black to white: each later frame is brighter, so the order of the frames can be read back. */
let ramp = '';
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
    clip = join(root, 'clip.mp4');
    portrait = join(root, 'portrait.mp4');
    packed = join(root, 'packed.mp4');
    ramp = join(root, 'ramp.mp4');
    for (const [out, src] of [
      [clip, 'testsrc=size=1920x1080:rate=10:duration=2'],
      [portrait, 'testsrc=size=720x1280:rate=10:duration=2'],
      [packed, 'testsrc=size=640x540:rate=10:duration=2'],
      [ramp, 'color=c=white:size=320x240:rate=10:duration=2,fade=t=in:st=0:d=2'],
    ] as const) {
      const v = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p', out]);
      if (v.exitCode !== 0) throw new Error(`could not make ${out}`);
    }
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
    // the guide's mock mode answers with a canned caption: still not a description of this photo
    const canned = client(() => Response.json({ caption: 'A warm, lived-in room with soft light and practical furniture.', degraded: true, error: 'mock mode' }));
    expect(await describeForJob(big, { client: canned.c, log: quiet })).toBeNull();

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

/** Mean brightness of a JPEG data URL (0..255), decoded by ffmpeg down to one gray pixel. */
function brightness(dataUrl: string): number {
  const p = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1'], {
    stdin: Buffer.from(dataUrl.split(',')[1]!, 'base64'),
  });
  if (p.exitCode !== 0 || p.stdout.length < 1) throw new Error('could not decode the frame');
  return p.stdout[0]!;
}

function sizeOf(dataUrl: string) {
  return jpegSize(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

describe('describeClipForJob (Video memories)', () => {
  const scene = { id: 'courts-foosball', name: '  Courts   foosball ' };

  test.skipIf(!hasFfmpeg)('sends 8 evenly spaced frames in clip order, the scene {id, name} and one still', async () => {
    const { c, seen } = client(() => Response.json({ caption: 'Two friends play foosball on the patio. The one in blue wins 5 to 3.' }));
    expect(await describeClipForJob(ramp, scene, { client: c, log: quiet })).toBe('Two friends play foosball on the patio. The one in blue wins 5 to 3.');
    expect(seen.length).toBe(1);
    const body = seen[0];
    expect(Object.keys(body).sort()).toEqual(['frames', 'image', 'scene']);
    expect(body.scene).toEqual({ id: 'courts-foosball', name: 'Courts foosball' });
    expect(body.frames.length).toBe(MAX_CLIP_FRAMES);
    for (const f of body.frames) expect(f).toStartWith('data:image/jpeg;base64,');
    const levels = body.frames.map(brightness);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    expect(levels[0]).toBeGreaterThan(5); // the middle of the first eighth, not the black first frame
    expect(body.image).toBe(body.frames[0]); // no still given: the first frame
  });

  test.skipIf(!hasFfmpeg)('at most 8 frames, at most 768 px on the long side (landscape and portrait)', async () => {
    const wide = await clipFramesForGuide(clip, { count: 20, maxSide: 4000 });
    expect(wide.length).toBe(8);
    for (const f of wide) expect(sizeOf(f)).toEqual({ width: CLIP_FRAME_SIDE, height: 432 });
    const tall = await clipFramesForGuide(portrait);
    expect(tall.length).toBe(8);
    for (const f of tall) expect(sizeOf(f)).toEqual({ width: 432, height: CLIP_FRAME_SIDE });
    expect((await clipFramesForGuide(clip, { count: 3 })).length).toBe(3);
    expect((await clipFramesForGuide(clip, { maxSide: 320 })).map(sizeOf)[0]).toEqual({ width: 320, height: 180 });

    const { c, seen } = client(() => Response.json({ caption: 'A test pattern that never stops moving.' }));
    await describeClipForJob(clip, scene, { client: c, maxFrames: 50, maxSide: 2000, imagePath: big, log: quiet });
    expect(seen[0].frames.length).toBe(8);
    for (const f of seen[0].frames) expect(sizeOf(f)).toEqual({ width: 768, height: 432 });
    expect(sizeOf(seen[0].image)).toEqual({ width: 768, height: 512 }); // the still is shrunk to the same size
    expect(seen[0].image).not.toBe(seen[0].frames[0]);
  });

  test.skipIf(!hasFfmpeg)('a packed video layer gives frames of its RGB rows only', async () => {
    const frames = await clipFramesForGuide(packed, { packed: true, count: 2 });
    expect(frames.map(sizeOf)).toEqual([
      { width: 640, height: 360 },
      { width: 640, height: 360 },
    ]);
  });

  test.skipIf(!hasFfmpeg)('null when the guide is degraded, refuses frames, is down, slow or off', async () => {
    const degraded = client(() => Response.json({ caption: '', degraded: true, error: 'gemini timeout' }));
    expect(await describeClipForJob(clip, scene, { client: degraded.c, log: quiet })).toBeNull();
    // when Gemini fails the guide answers from its notes, degraded: never stored as the caption or the world prompt
    const fromNotes = client(() => Response.json({ caption: 'Two players face off at foosball. Still undecided.', degraded: true, error: 'quota', frames: 8 }));
    expect(await describeClipForJob(clip, scene, { client: fromNotes.c, log: quiet })).toBeNull();
    expect(fromNotes.seen.filter((b) => b.frames).length).toBe(1);

    const refused = client(() => Response.json({ error: 'image required' }, { status: 400 }));
    expect(await describeClipForJob(clip, scene, { client: refused.c, log: quiet })).toBeNull();

    const down = client(() => {
      throw Object.assign(new Error('refused'), { code: 'ConnectionRefused' });
    });
    expect(await describeClipForJob(clip, scene, { client: down.c, log: quiet })).toBeNull();
    down.c.close();

    const slow = client((_b, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const t0 = performance.now();
    expect(await describeClipForJob(clip, scene, { client: slow.c, timeoutMs: 1500, log: quiet })).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(slow.seen.filter((b) => b.frames).length).toBe(1); // the rest is the client's health probe
    slow.c.close();

    const off = client(() => Response.json({ caption: 'A room with a view.' }), null);
    expect(await describeClipForJob(clip, scene, { client: off.c, log: quiet })).toBeNull();
    expect(off.seen.length).toBe(0);
  });

  test('null without a guide call when the clip is missing or not a video', async () => {
    const { c, seen } = client(() => Response.json({ caption: 'A room with a view.' }));
    expect(await describeClipForJob(join(root, 'missing.mp4'), scene, { client: c, log: quiet })).toBeNull();
    const junk = join(root, 'junk.mp4');
    await writeFile(junk, 'not a video at all');
    expect(await describeClipForJob(junk, scene, { client: c, log: quiet })).toBeNull();
    expect(await clipFramesForGuide(junk)).toEqual([]);
    expect(seen.length).toBe(0);
  });

  test.skipIf(!hasFfmpeg)('the photo path is unchanged: {image} only, 1024 px', async () => {
    const { c, seen } = client(() => Response.json({ caption: 'A bright dorm room with a lofted bed.' }));
    expect(await describeForJob(big, { client: c, log: quiet })).toBe('A bright dorm room with a lofted bed.');
    expect(Object.keys(seen[0])).toEqual(['image']);
    expect(sizeOf(seen[0].image)).toEqual({ width: 1024, height: 682 });
  });

  test('clipForScene: the uploaded video first, else the video layer, only files on disk inside the scene', async () => {
    const dir = join(root, 'scene-a');
    await mkdir(join(dir, 'input'), { recursive: true });
    await writeFile(join(dir, 'input', 'video.mov'), 'x');
    await writeFile(join(dir, 'video.mp4'), 'x');
    const layer = { file: 'video.mp4', layout: 'tw-pack-v1' } as any;
    expect(clipForScene({ input: { files: ['input/video.mov'] }, video: layer }, dir)).toEqual({ path: join(dir, 'input', 'video.mov'), packed: false });
    expect(clipForScene({ input: { files: ['input/video.mkv'] }, video: layer }, dir)).toEqual({ path: join(dir, 'video.mp4'), packed: true });
    expect(clipForScene({ input: { files: ['input/00.jpg'] } }, dir)).toBeNull();
    expect(clipForScene({ input: { files: ['input/../../photo.mp4'] }, video: { ...layer, file: '../clip.mp4' } }, dir)).toBeNull();
  });
});
