import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exifApp1,
  extractFrame,
  FFMPEG,
  imageSize,
  insertApp1,
  laplacianVariance,
  pickBestFrameTime,
  probeVideo,
  readJpegExif,
  sniffKind,
} from '../server/media.ts';
import { SceneStore } from '../server/store.ts';
import { createSceneFromUpload, UploadError, validateUpload } from '../server/upload.ts';

let root: string;
let media: string;
let store: SceneStore;

async function ff(args: string[]) {
  const p = Bun.spawn([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', ...args], { stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

/** Big-endian EXIF with Orientation in IFD0 and FocalLengthIn35mmFilm in the Exif IFD, like many cameras write. */
function exifBigEndian(orientation: number, focal35: number): Uint8Array {
  const t = new Uint8Array(56);
  const dv = new DataView(t.buffer);
  t.set([0x4d, 0x4d, 0x00, 0x2a]);
  dv.setUint32(4, 8);
  dv.setUint16(8, 2);
  dv.setUint16(10, 0x0112); dv.setUint16(12, 3); dv.setUint32(14, 1); dv.setUint16(18, orientation);
  dv.setUint16(22, 0x8769); dv.setUint16(24, 4); dv.setUint32(26, 1); dv.setUint32(30, 38);
  dv.setUint32(34, 0);
  dv.setUint16(38, 1);
  dv.setUint16(40, 0xa405); dv.setUint16(42, 3); dv.setUint32(44, 1); dv.setUint16(48, focal35);
  dv.setUint32(52, 0);
  const body = new Uint8Array(6 + t.length);
  body.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  body.set(t, 6);
  const seg = new Uint8Array(4 + body.length);
  seg.set([0xff, 0xe1, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255]);
  seg.set(body, 4);
  return seg;
}

const file = async (name: string, type = '') => new File([await Bun.file(join(media, name)).arrayBuffer()], name, { type });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tw-upload-'));
  media = join(root, 'media');
  await Bun.write(join(media, '.keep'), '');
  store = new SceneStore(join(root, 'scenes'));
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', '-q:v', '3', join(media, 'room.jpg')]);
  await ff(['-f', 'lavfi', '-i', 'mandelbrot=s=480x320', '-frames:v', '1', join(media, 'frac.png')]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=40x24', '-frames:v', '1', '-q:v', '3', join(media, 'tiny.jpg')]);
  // A streamed WebM (as MediaRecorder and many recorders write it) has no duration in its header.
  const webm = Bun.spawn(
    [FFMPEG, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=15', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
      '-t', '2', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-live', '1', '-f', 'webm', 'pipe:1'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const webmBytes = await new Response(webm.stdout).arrayBuffer();
  if ((await webm.exited) === 0) await Bun.write(join(media, 'streamed.webm'), webmBytes);
  await ff([
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(media, 'clip.mp4'),
  ]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(media, 'silent.mov')]);
  const jpg = new Uint8Array(await Bun.file(join(media, 'room.jpg')).arrayBuffer());
  await Bun.write(join(media, 'portrait.jpg'), insertApp1(jpg, exifBigEndian(6, 26)));
  const sips = Bun.spawn(['/usr/bin/sips', '-s', 'format', 'heic', join(media, 'room.jpg'), '--out', join(media, 'room.heic')], { stdout: 'ignore', stderr: 'ignore' });
  await sips.exited;
  await Bun.write(join(media, 'notes.txt'), 'hello');
  // A recorder's MPEG-TS clip: one keyframe, no seek index.
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25', '-t', '2', '-c:v', 'libx264', '-g', '250', '-pix_fmt', 'yuv420p', '-f', 'mpegts', join(media, 'game.ts')]);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('media helpers', () => {
  test('sniffKind uses magic bytes before names', async () => {
    const head = async (n: string) => new Uint8Array(await Bun.file(join(media, n)).slice(0, 64).arrayBuffer());
    expect(sniffKind(await head('room.jpg'), 'photo.png')).toBe('jpeg');
    expect(sniffKind(await head('frac.png'), 'x')).toBe('png');
    expect(sniffKind(await head('clip.mp4'), 'x.bin')).toBe('video');
    expect(sniffKind(await head('silent.mov'), 'x')).toBe('video');
    expect(sniffKind(await head('room.heic'), 'IMG_0001')).toBe('heic');
    expect(sniffKind(await head('notes.txt'), 'notes.txt')).toBe('unknown');
    expect(sniffKind(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'clip.webm')).toBe('video');
  });

  test('EXIF reader handles both byte orders; writer round-trips', async () => {
    const be = readJpegExif(new Uint8Array(await Bun.file(join(media, 'portrait.jpg')).arrayBuffer()));
    expect(be).toEqual({ orientation: 6, focal35: 26 });
    const jpg = new Uint8Array(await Bun.file(join(media, 'room.jpg')).arrayBuffer());
    expect(readJpegExif(jpg).orientation).toBe(1);
    expect(readJpegExif(insertApp1(jpg, exifApp1(13)))).toEqual({ orientation: 1, focal35: 13 });
    expect(readJpegExif(new Uint8Array([1, 2, 3]))).toEqual({ orientation: 1 });
  });

  test('probeVideo and frame picking', async () => {
    const info = await probeVideo(join(media, 'clip.mp4'));
    expect(info.width).toBe(320);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(1.5);
    expect((await probeVideo(join(media, 'silent.mov'))).hasAudio).toBe(false);
    await expect(probeVideo(join(media, 'notes.txt'))).rejects.toThrow(/looks incomplete or damaged/);
    const t = await pickBestFrameTime(join(media, 'clip.mp4'), info.duration);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(info.duration);
  });

  test('laplacian variance ranks a sharp pattern above a flat one', () => {
    const w = 64, h = 64;
    const flat = new Uint8Array(w * h).fill(128);
    const checker = new Uint8Array(w * h).map((_, i) => (((i % w) >> 2) + ((i / w) >> 2)) % 2 ? 255 : 0);
    expect(laplacianVariance(checker, w, h)).toBeGreaterThan(laplacianVariance(flat, w, h));
    expect(laplacianVariance(flat, w, h)).toBe(0);
  });
});

describe('validateUpload', () => {
  const f = (name: string, bytes: number[]) => new File([new Uint8Array(bytes)], name);
  const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
  const MP4 = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];

  test('per-mode rules', async () => {
    await expect(validateUpload({ mode: 'x', files: [] })).rejects.toThrow('Unknown mode "x". Use photo or video.');
    await expect(validateUpload({ mode: '', files: [] })).rejects.toThrow('Choose a mode: photo or video.');
    // The public names are aliases of the internal ids.
    await expect(validateUpload({ mode: 'photo', prompt: 'a cave', files: [] })).resolves.toMatchObject({ mode: 'rentfree' });
    await expect(validateUpload({ mode: ' Video ', files: [f('a.mp4', MP4)] })).resolves.toMatchObject({ mode: 'thirdwheel' });
    await expect(validateUpload({ mode: 'video', files: [f('a.jpg', JPG)] })).rejects.toThrow('Video mode needs one video, filmed from a still, propped-up phone.');
    await expect(validateUpload({ mode: 'rentfree', files: [] })).rejects.toThrow(/photo, a video or a prompt/);
    await expect(validateUpload({ mode: 'rentfree', prompt: 'a cave', files: [] })).resolves.toMatchObject({ mode: 'rentfree', prompt: 'a cave' });
    await expect(validateUpload({ mode: 'thirdwheel', files: [f('a.jpg', JPG)] })).rejects.toThrow(/one video/);
    await expect(validateUpload({ mode: 'thirdwheel', files: [f('a.mp4', MP4), f('b.mp4', MP4)] })).rejects.toThrow(/one video at a time/);
    await expect(validateUpload({ mode: 'rentfree', files: [f('a.jpg', JPG), f('a.mp4', MP4)] })).rejects.toThrow(/not both/);
    await expect(validateUpload({ mode: 'reconstruct', files: [f('a.jpg', JPG)] })).rejects.toThrow(/at least 8 photos/);
    const eight = Array.from({ length: 8 }, (_, i) => f(`${i}.jpg`, JPG));
    await expect(validateUpload({ mode: 'reconstruct', files: eight })).resolves.toMatchObject({ mode: 'reconstruct' });
    await expect(validateUpload({ mode: 'reconstruct', files: [f('v.mp4', MP4)] })).resolves.toMatchObject({ mode: 'reconstruct' });
    await expect(validateUpload({ mode: 'rentfree', files: [f('notes.txt', [1, 2, 3])] })).rejects.toThrow(UploadError);
  });
});

describe('createSceneFromUpload', () => {
  test('photos of every kind become oriented JPEGs with a thumbnail and meta.json', async () => {
    const files = [await file('room.jpg'), await file('room.heic', 'image/heic'), await file('frac.png'), await file('portrait.jpg')];
    const scene = await createSceneFromUpload(store, { mode: 'rentfree', name: 'My Dorm Room!', files });
    expect(scene.id).toMatch(/^my-dorm-room-[a-z2-9]{5}$/);
    expect(scene.status).toBe('queued');
    expect(scene.thumb).toBe('thumb.jpg');
    expect(scene.input?.files).toEqual(['input/00.jpg', 'input/01.jpg', 'input/02.jpg', 'input/03.jpg']);
    const dir = store.sceneDir(scene.id);
    expect(await imageSize(join(dir, 'input/00.jpg'))).toEqual({ width: 640, height: 360 });
    expect(await imageSize(join(dir, 'input/01.jpg'))).toEqual({ width: 640, height: 360 });
    expect(await imageSize(join(dir, 'input/02.jpg'))).toEqual({ width: 480, height: 320 });
    // EXIF orientation 6 is applied to the pixels and the focal length survives.
    expect(await imageSize(join(dir, 'input/03.jpg'))).toEqual({ width: 360, height: 640 });
    expect(readJpegExif(new Uint8Array(await Bun.file(join(dir, 'input/03.jpg')).arrayBuffer()))).toEqual({ orientation: 1, focal35: 26 });
    for (const f of ['00', '01', '02']) {
      const head = new Uint8Array(await Bun.file(join(dir, `input/${f}.jpg`)).slice(0, 3).arrayBuffer());
      expect([...head]).toEqual([0xff, 0xd8, 0xff]);
    }
    const meta = await Bun.file(join(dir, 'input/meta.json')).json();
    expect(meta['03.jpg']).toMatchObject({ source: 'portrait.jpg', focal35: 26, width: 360, height: 640 });
    expect((await imageSize(join(dir, 'thumb.jpg'))).width).toBe(640);
    expect((await readdir(join(dir, 'input'))).filter((n) => n.startsWith('.'))).toEqual([]);
    expect(await Bun.file(join(dir, 'log.txt')).text()).toContain('created rentfree scene');
    expect((await store.get(scene.id))?.input?.files.length).toBe(4);
  });

  test('a video is kept as uploaded, probed, and thumbnailed', async () => {
    const scene = await createSceneFromUpload(store, { mode: 'thirdwheel', name: 'Ana cooking', files: [await file('clip.mp4')] });
    const dir = store.sceneDir(scene.id);
    expect(scene.input?.files).toEqual(['input/video.mp4']);
    expect(Bun.file(join(dir, 'input/video.mp4')).size).toBe(Bun.file(join(media, 'clip.mp4')).size);
    expect((await imageSize(join(dir, 'thumb.jpg'))).width).toBe(320);
    expect(scene.caption).toBeUndefined();
    const silent = await createSceneFromUpload(store, { mode: 'thirdwheel', name: 'Quiet', files: [await file('silent.mov')] });
    expect(silent.input?.files).toEqual(['input/video.mov']);
    expect(silent.caption).toBe('This clip has no sound.');
  });

  test('a transport-stream clip is copied into Matroska so frames can be picked by time', async () => {
    const scene = await createSceneFromUpload(store, { mode: 'photo', name: 'Recorder clip', files: [await file('game.ts')] });
    const dir = store.sceneDir(scene.id);
    expect(scene.input?.files).toEqual(['input/video.mkv']);
    expect(await Bun.file(join(dir, 'input/video.ts')).exists()).toBe(false);
    expect((await probeVideo(join(dir, 'input/video.mkv'))).duration).toBeGreaterThan(1.5);
    await extractFrame(join(dir, 'input/video.mkv'), 1.5, join(root, 'ts-frame.jpg'));
    expect((await imageSize(join(root, 'ts-frame.jpg'))).width).toBe(320);
    expect(await Bun.file(join(dir, 'log.txt')).text()).toContain('no seek index');
  });

  test('prompt-only scenes get a placeholder thumbnail and a name from the prompt', async () => {
    const scene = await createSceneFromUpload(store, { mode: 'rentfree', prompt: '  a cozy cabin with a fireplace and snow outside the windows ', files: [] });
    expect(scene.name).toBe('a cozy cabin with a fireplace and');
    expect(scene.input).toEqual({ files: [], prompt: 'a cozy cabin with a fireplace and snow outside the windows' });
    expect((await imageSize(join(store.sceneDir(scene.id), 'thumb.jpg'))).width).toBe(640);
  });

  test('a broken video is rejected and leaves nothing behind', async () => {
    const before = await readdir(store.dir).catch(() => []);
    const fake = new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3])], 'broken.mp4');
    const err = await createSceneFromUpload(store, { mode: 'thirdwheel', name: 'Broken', files: [fake] }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    // One product sentence: no tool output, no server paths.
    expect(err.message).toBe('"broken.mp4" looks incomplete or damaged (still copying?). Export or AirDrop it again.');
    expect(await readdir(store.dir)).toEqual(before);
  });

  test('a corrupt photo is rejected with its name', async () => {
    const fake = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], 'bad.jpg');
    await expect(createSceneFromUpload(store, { mode: 'rentfree', name: 'Bad', files: [fake] })).rejects.toThrow('"bad.jpg" isn\'t a photo we can open.');
  });

  test('a photo too small to build from is refused before any work starts', async () => {
    const before = await readdir(store.dir).catch(() => []);
    await expect(createSceneFromUpload(store, { mode: 'photo', name: 'Tiny', files: [await file('tiny.jpg')] })).rejects.toThrow(
      '"tiny.jpg" is too small (40x24). Use a photo at least 320 px on the short side.',
    );
    expect(await readdir(store.dir)).toEqual(before);
  });

  test('a streamed WebM without a duration in its header is remuxed and accepted', async () => {
    if (!(await Bun.file(join(media, 'streamed.webm')).exists()) || Bun.file(join(media, 'streamed.webm')).size === 0) return; // no VP8 encoder
    const scene = await createSceneFromUpload(store, { mode: 'photo', name: 'Game clip', files: [await file('streamed.webm', 'video/webm')] });
    expect(scene.input?.files).toEqual(['input/video.webm']);
    expect(await Bun.file(join(store.sceneDir(scene.id), 'log.txt')).text()).toContain('remuxed');
  });
});
