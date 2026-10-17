// Front-end logic that does not need a browser: capture validation, API helpers, QR encoder.

import { describe, expect, test } from 'bun:test';
import type { HealthInfo, Scene } from '../shared/types.ts';
import { lanUrls, sceneAssetUrl, sceneBaseUrl, sortScenes, summarizeHealth, viewUrl } from '../web/src/api.ts';
import { findExifSegment, fitWithin, formatBytes, insertApp1, kindOf, resetExifOrientation, validateSelection } from '../web/src/capture.ts';
import { qrMatrix } from '../web/src/gallery.ts';

describe('capture validation', () => {
  const sel = (images: number, videos: number, prompt = '') => ({ images, videos, prompt });

  test('Third Wheel needs exactly one video', () => {
    expect(validateSelection('thirdwheel', sel(0, 1))).toBeNull();
    expect(validateSelection('thirdwheel', sel(0, 0))).toMatch(/one video/i);
    expect(validateSelection('thirdwheel', sel(0, 2))).toMatch(/one video/i);
    expect(validateSelection('thirdwheel', sel(1, 1))).toMatch(/not photos/i);
    expect(validateSelection('thirdwheel', sel(0, 0, 'a kitchen'))).not.toBeNull();
  });

  test('Rent Free takes photos, one clip, or a prompt alone', () => {
    expect(validateSelection('rentfree', sel(1, 0))).toBeNull();
    expect(validateSelection('rentfree', sel(3, 0))).toBeNull();
    expect(validateSelection('rentfree', sel(0, 1))).toBeNull();
    expect(validateSelection('rentfree', sel(0, 0, 'a lighthouse kitchen'))).toBeNull();
    expect(validateSelection('rentfree', sel(0, 0, '   '))).not.toBeNull();
    expect(validateSelection('rentfree', sel(1, 1))).toMatch(/not both/i);
    expect(validateSelection('rentfree', sel(0, 2))).not.toBeNull();
  });

  test('Reconstruct needs 8+ photos or a video', () => {
    expect(validateSelection('reconstruct', sel(8, 0))).toBeNull();
    expect(validateSelection('reconstruct', sel(0, 1))).toBeNull();
    expect(validateSelection('reconstruct', sel(7, 0))).toMatch(/at least 8/);
  });

  test('media kind from MIME type or extension (iOS sometimes sends no type)', () => {
    expect(kindOf({ type: 'image/heic', name: 'IMG_1.HEIC' })).toBe('image');
    expect(kindOf({ type: '', name: 'IMG_2.HEIC' })).toBe('image');
    expect(kindOf({ type: '', name: 'clip.MOV' })).toBe('video');
    expect(kindOf({ type: 'video/quicktime', name: 'x' })).toBe('video');
    expect(kindOf({ type: 'application/pdf', name: 'a.pdf' })).toBeNull();
  });

  test('downscale target fits in 2048 px and never upscales', () => {
    expect(fitWithin(4032, 3024)).toEqual([2048, 1536]);
    expect(fitWithin(3024, 4032)).toEqual([1536, 2048]);
    expect(fitWithin(1280, 720)).toEqual([1280, 720]);
    expect(fitWithin(8000, 10)).toEqual([2048, 3]);
  });

  test('byte formatting', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });
});

describe('EXIF carry-over after client-side re-encode', () => {
  // Minimal little- or big-endian EXIF: IFD0 { Orientation = 6, ExifIFD -> { FocalLengthIn35mmFilm = 26 } }.
  function exifJpeg(le: boolean): Uint8Array {
    const tiff = new Uint8Array(56);
    const dv = new DataView(tiff.buffer);
    tiff.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
    dv.setUint16(2, 42, le);
    dv.setUint32(4, 8, le);
    dv.setUint16(8, 2, le);
    dv.setUint16(10, 0x0112, le);
    dv.setUint16(12, 3, le);
    dv.setUint32(14, 1, le);
    dv.setUint16(18, 6, le);
    dv.setUint16(22, 0x8769, le);
    dv.setUint16(24, 4, le);
    dv.setUint32(26, 1, le);
    dv.setUint32(30, 38, le);
    dv.setUint32(34, 0, le);
    dv.setUint16(38, 1, le);
    dv.setUint16(40, 0xa405, le);
    dv.setUint16(42, 3, le);
    dv.setUint32(44, 1, le);
    dv.setUint16(48, 26, le);
    dv.setUint32(52, 0, le);
    const app1Len = 2 + 6 + tiff.length;
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, app1Len >> 8, app1Len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, 0xff, 0xd9]);
  }
  const encoded = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

  for (const le of [true, false]) {
    test(`keeps the focal length and resets orientation (${le ? 'II' : 'MM'}), as the server reads it`, async () => {
      const { readJpegExif } = await import('../server/media.ts');
      const original = exifJpeg(le);
      expect(readJpegExif(original)).toMatchObject({ orientation: 6, focal35: 26 });
      const seg = findExifSegment(original)!;
      expect(seg).not.toBeNull();
      const out = insertApp1(encoded, resetExifOrientation(seg));
      expect(readJpegExif(out)).toMatchObject({ orientation: 1, focal35: 26 });
      expect(out.length).toBe(encoded.length + seg.length);
      expect([...out.subarray(out.length - 2)]).toEqual([0xff, 0xd9]);
    });
  }

  test('no EXIF, no change', () => {
    expect(findExifSegment(encoded)).toBeNull();
    expect(findExifSegment(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('api helpers', () => {
  const health = (lan: string[], https = false): HealthInfo => ({
    ok: true,
    version: 't',
    https,
    lan,
    hpg: { online: false, user: 'u', worker: { alive: false } },
    space: { available: true },
    local: { python: false },
  });

  test('LAN entries become full URLs in any of the shapes the server might send', () => {
    const loc = { protocol: 'http:', port: '8787' };
    expect(lanUrls(health(['192.168.1.20']), loc)).toEqual(['http://192.168.1.20:8787']);
    expect(lanUrls(health(['192.168.1.20:9000']), loc)).toEqual(['http://192.168.1.20:9000']);
    expect(lanUrls(health(['https://10.0.0.5:8787/']), loc)).toEqual(['https://10.0.0.5:8787']);
    expect(lanUrls(health(['10.0.0.5'], true), loc)).toEqual(['https://10.0.0.5:8787']);
    expect(lanUrls(health(['10.0.0.5', '10.0.0.5', '']), loc)).toEqual(['http://10.0.0.5:8787']);
  });

  test('health summary', () => {
    const h = health([]);
    const s = summarizeHealth(h);
    expect(s.gpu.ok).toBe(false);
    expect(s.worker.detail).toBe('asleep');
    expect(s.fallbacks).toMatchObject({ ok: true, detail: 'HF Space' });
    h.hpg = { online: true, user: 'u', worker: { alive: true, gpu: 'RTX PRO 6000', host: 'c1' } };
    expect(summarizeHealth(h).worker.detail).toBe('RTX PRO 6000 on c1');
    expect(summarizeHealth(undefined).gpu.detail).toBe('checking');
  });

  test('URLs', () => {
    expect(viewUrl('a b')).toBe('/view?scene=a%20b');
    expect(sceneAssetUrl('s1', 'thumb.jpg')).toBe('/data/scenes/s1/thumb.jpg');
    expect(sceneAssetUrl('s1', 'input/00.jpg')).toBe('/data/scenes/s1/input/00.jpg');
    expect(sceneBaseUrl('s1')).toBe('/data/scenes/s1/');
  });

  test('scenes sort newest first', () => {
    const mk = (id: string, createdAt: string) => ({ id, createdAt }) as Scene;
    expect(sortScenes([mk('a', '2026-10-16T10:00:00Z'), mk('b', '2026-10-17T10:00:00Z')]).map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('QR encoder', () => {
  const finderOk = (m: boolean[][], x0: number, y0: number) => {
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        if (m[y0 + y][x0 + x] !== (d !== 2)) return false;
      }
    return true;
  };

  test('picks the smallest version and draws the function patterns', () => {
    for (const [text, version] of [
      ['http://10.0.0.5:8787', 2],
      ['https://192.168.100.200:8787/capture?mode=thirdwheel', 3],
    ] as const) {
      const m = qrMatrix(text);
      const size = version * 4 + 17;
      expect(m.length).toBe(size);
      expect(finderOk(m, 0, 0)).toBe(true);
      expect(finderOk(m, size - 7, 0)).toBe(true);
      expect(finderOk(m, 0, size - 7)).toBe(true);
      for (let i = 8; i < size - 8; i++) {
        expect(m[6][i]).toBe(i % 2 === 0);
        expect(m[i][6]).toBe(i % 2 === 0);
      }
      expect(m[size - 8][8]).toBe(true); // dark module
    }
  });

  test('format information is a valid level-L BCH codeword, identical in both copies', () => {
    const m = qrMatrix('http://10.136.225.136:8787');
    const size = m.length;
    const bit = (x: number, y: number) => (m[y][x] ? 1 : 0);
    let a = 0;
    const first: number[] = [];
    for (let i = 0; i <= 5; i++) first[i] = bit(8, i);
    first[6] = bit(8, 7);
    first[7] = bit(8, 8);
    first[8] = bit(7, 8);
    for (let i = 9; i < 15; i++) first[i] = bit(14 - i, 8);
    const second: number[] = [];
    for (let i = 0; i < 8; i++) second[i] = bit(size - 1 - i, 8);
    for (let i = 8; i < 15; i++) second[i] = bit(8, size - 15 + i);
    expect(second).toEqual(first);
    first.forEach((b, i) => (a |= b << i));
    const raw = a ^ 0x5412;
    const data = raw >>> 10;
    expect(data >>> 3).toBe(1); // level L
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(raw).toBe((data << 10) | rem);
  });

  test('version 7+ carries version information', () => {
    const m = qrMatrix('x'.repeat(150));
    expect(m.length).toBe(7 * 4 + 17);
  });

  test('rejects text that does not fit version 10', () => {
    expect(() => qrMatrix('x'.repeat(400))).toThrow();
  });
});
