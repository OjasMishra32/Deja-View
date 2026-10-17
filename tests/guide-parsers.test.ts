// Parsers the guide relies on: WAV headers (the guide's speech), data URLs and base64, and .npy
// (input_depth.npy). The .npy cases include files written by real NumPy when .venv has it.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { depthMapFromNpy, parseNpy } from '../web/src/viewer/guide/hotspots.ts';
import { base64ToBytes, bytesToBase64, encodeWav16, parseDataUrl, parseWav, pickRecorderType, speechDuration, toDataUrl } from '../web/src/viewer/guide/voice.ts';
import { encodeNpyF32, encodePng, makeSpeechWav } from './harness/guide-harness.ts';

const ROOT = resolve(import.meta.dir, '..');
const PY = join(ROOT, '.venv', 'bin', 'python');

function riff(chunks: Array<[string, Uint8Array]>, riffSize?: number): Uint8Array {
  const body = chunks.reduce((n, [, d]) => n + 8 + d.length + (d.length & 1), 0);
  const out = new Uint8Array(12 + body);
  const dv = new DataView(out.buffer);
  out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  dv.setUint32(4, riffSize ?? 4 + body, true);
  out.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  let o = 12;
  for (const [id, d] of chunks) {
    out.set([...id].map((c) => c.charCodeAt(0)), o);
    dv.setUint32(o + 4, d.length, true);
    out.set(d, o + 8);
    o += 8 + d.length + (d.length & 1);
  }
  return out;
}

function fmt(format: number, channels: number, rate: number, bits: number, extensible = false): Uint8Array {
  const d = new Uint8Array(extensible ? 40 : 16);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, extensible ? 0xfffe : format, true);
  dv.setUint16(2, channels, true);
  dv.setUint32(4, rate, true);
  dv.setUint32(8, (rate * channels * bits) / 8, true);
  dv.setUint16(12, (channels * bits) / 8, true);
  dv.setUint16(14, bits, true);
  if (extensible) {
    dv.setUint16(16, 22, true);
    dv.setUint16(24, format, true);
  }
  return d;
}

describe('WAV', () => {
  test('encodeWav16 -> parseWav: 24 kHz mono 16-bit, exact duration', () => {
    const s = new Float32Array(24000 * 1.5).map((_, i) => Math.sin(i / 10));
    const info = parseWav(encodeWav16(s, 24000));
    expect(info).toMatchObject({ format: 1, sampleRate: 24000, channels: 1, bitsPerSample: 16, dataOffset: 44, frames: 36000 });
    expect(info.duration).toBeCloseTo(1.5, 9);
  });

  test('samples are clamped and rounded', () => {
    const w = encodeWav16([2, -2, 0.5, -0.5, Number.NaN], 8000);
    const dv = new DataView(w.buffer);
    expect([0, 1, 2, 3, 4].map((i) => dv.getInt16(44 + i * 2, true))).toEqual([32767, -32768, 16384, -16384, 0]);
  });

  test('skips extra chunks (LIST, odd sizes padded) to find the data', () => {
    const data = new Uint8Array(4800 * 2);
    const w = riff([['fmt ', fmt(1, 1, 24000, 16)], ['LIST', new Uint8Array(13)], ['data', data]]);
    const info = parseWav(w);
    expect(info.dataOffset).toBe(12 + 24 + 8 + 14 + 8);
    expect(info.duration).toBeCloseTo(0.2, 9);
  });

  test('streaming headers: data size 0 or 0xFFFFFFFF runs to the end', () => {
    const data = new Uint8Array(2400 * 2);
    for (const size of [0, 0xffffffff]) {
      const w = riff([['fmt ', fmt(1, 1, 24000, 16)], ['data', data]]);
      new DataView(w.buffer).setUint32(12 + 24 + 4, size, true);
      expect(parseWav(w).duration).toBeCloseTo(0.1, 9);
    }
  });

  test('a data size past the end is cut to what arrived', () => {
    const w = riff([['fmt ', fmt(1, 2, 48000, 16)], ['data', new Uint8Array(960)]]);
    new DataView(w.buffer).setUint32(12 + 24 + 4, 1e6, true);
    expect(parseWav(w).frames).toBe(240);
  });

  test('WAVE_FORMAT_EXTENSIBLE resolves to its sub-format; float 32-bit stereo', () => {
    const w = riff([['fmt ', fmt(3, 2, 44100, 32, true)], ['data', new Uint8Array(44100 * 8)]]);
    const info = parseWav(w);
    expect(info.format).toBe(3);
    expect(info.channels).toBe(2);
    expect(info.duration).toBeCloseTo(1, 9);
  });

  test('rejects what is not a WAV', () => {
    expect(() => parseWav(new Uint8Array(4))).toThrow();
    expect(() => parseWav(new TextEncoder().encode('RIFF0000AVI LIST'))).toThrow(/RIFF\/WAVE/);
    expect(() => parseWav(riff([['data', new Uint8Array(8)]]))).toThrow(/fmt/);
    expect(() => parseWav(riff([['fmt ', fmt(1, 1, 24000, 16)]]))).toThrow(/data/);
  });

  test('the harness speech is a valid 24 kHz WAV data URL of the asked length', () => {
    const url = toDataUrl('audio/wav', makeSpeechWav(2));
    expect(url.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(speechDuration(url)).toBeCloseTo(2, 3);
    expect(speechDuration('data:audio/mpeg;base64,AAAA')).toBeNull();
    expect(speechDuration(null)).toBeNull();
  });
});

describe('data URLs and base64', () => {
  test('base64 round trip across chunk boundaries', () => {
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 7919) & 255);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array([0xff, 0, 0x7f]))).toBe(Buffer.from([0xff, 0, 0x7f]).toString('base64'));
  });

  test('parseDataUrl keeps the codec parameters', () => {
    const d = parseDataUrl(`data:audio/webm;codecs=opus;base64,${bytesToBase64(new Uint8Array([1, 2, 3]))}`)!;
    expect(d.mime).toBe('audio/webm');
    expect(d.type).toBe('audio/webm;codecs=opus');
    expect([...d.bytes]).toEqual([1, 2, 3]);
    expect(parseDataUrl('data:text/plain,hello')).toBeNull();
    expect(parseDataUrl('https://example.test/a.wav')).toBeNull();
    expect(parseDataUrl(42)).toBeNull();
  });

  test('the recorder prefers webm/opus and falls back in order', () => {
    expect(pickRecorderType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecorderType((t) => t.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(pickRecorderType(() => false)).toBe('');
    expect(pickRecorderType(() => {
      throw new Error('unsupported');
    })).toBe('');
  });
});

function npy(descr: string, shape: number[], body: Uint8Array, opts: { version?: 1 | 2; fortran?: boolean } = {}): Uint8Array {
  const v = opts.version ?? 1;
  let header = `{'descr': '${descr}', 'fortran_order': ${opts.fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pre = v === 1 ? 10 : 12;
  header += ' '.repeat((64 - ((pre + header.length + 1) % 64)) % 64) + '\n';
  const out = new Uint8Array(pre + header.length + body.length);
  out.set([0x93, ...[...'NUMPY'].map((c) => c.charCodeAt(0)), v, 0], 0);
  const dv = new DataView(out.buffer);
  if (v === 1) dv.setUint16(8, header.length, true);
  else dv.setUint32(8, header.length, true);
  out.set([...header].map((c) => c.charCodeAt(0)), pre);
  out.set(body, pre + header.length);
  return out;
}

describe('.npy', () => {
  test('float32 C order, as the harness (and numpy.save) writes it', () => {
    const data = new Float32Array([0, 1.5, 2.25, 0, 3, 4.5]);
    const a = parseNpy(encodeNpyF32(data, [2, 3]));
    expect(a.shape).toEqual([2, 3]);
    expect(a.dtype).toBe('<f4');
    expect([...a.data]).toEqual([...data]);
    const m = depthMapFromNpy(a);
    expect([m.width, m.height]).toEqual([3, 2]);
  });

  test('works from an unaligned view into a bigger buffer', () => {
    const file = encodeNpyF32(new Float32Array([1, 2, 3, 4]), [2, 2]);
    const big = new Uint8Array(file.length + 3);
    big.set(file, 3);
    expect([...parseNpy(big.subarray(3)).data]).toEqual([1, 2, 3, 4]);
  });

  test('float64, float16, uint8, int16 and big-endian float32', () => {
    const f8 = new Uint8Array(new Float64Array([1.25, -2]).buffer);
    expect([...parseNpy(npy('<f8', [2], f8)).data]).toEqual([1.25, -2]);
    // 1.0, -2.0, 0.5, 65504 in IEEE half
    const f2 = new Uint8Array(new Uint16Array([0x3c00, 0xc000, 0x3800, 0x7bff]).buffer);
    expect([...parseNpy(npy('<f2', [4], f2)).data]).toEqual([1, -2, 0.5, 65504]);
    expect([...parseNpy(npy('|u1', [3], new Uint8Array([0, 128, 255]))).data]).toEqual([0, 128, 255]);
    expect([...parseNpy(npy('<i2', [2], new Uint8Array(new Int16Array([-300, 7]).buffer))).data]).toEqual([-300, 7]);
    const be = new Uint8Array(8);
    new DataView(be.buffer).setFloat32(0, 3.5, false);
    new DataView(be.buffer).setFloat32(4, -1, false);
    expect([...parseNpy(npy('>f4', [2], be)).data]).toEqual([3.5, -1]);
  });

  test('format 2.0 headers', () => {
    const a = parseNpy(npy('<f4', [1, 2], new Uint8Array(new Float32Array([7, 8]).buffer), { version: 2 }));
    expect([...a.data]).toEqual([7, 8]);
  });

  test('Fortran order is transposed to rows', () => {
    // [[1, 2, 3], [4, 5, 6]] stored column by column
    const body = new Uint8Array(new Float32Array([1, 4, 2, 5, 3, 6]).buffer);
    const m = depthMapFromNpy(parseNpy(npy('<f4', [2, 3], body, { fortran: true })));
    expect([...m.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('H x W x 1 is a depth map; other shapes are not', () => {
    expect(depthMapFromNpy(parseNpy(npy('<f4', [1, 2, 1], new Uint8Array(8)))).width).toBe(2);
    expect(() => depthMapFromNpy(parseNpy(npy('<f4', [1, 1, 2], new Uint8Array(8))))).toThrow();
    expect(() => depthMapFromNpy(parseNpy(npy('<f4', [2], new Uint8Array(8))))).toThrow();
  });

  test('rejects bad files with an error, never garbage', () => {
    expect(() => parseNpy(new Uint8Array(20))).toThrow(/npy/);
    expect(() => parseNpy(npy('<c8', [1], new Uint8Array(8)))).toThrow(/dtype/);
    expect(() => parseNpy(npy('<f4', [4], new Uint8Array(8)))).toThrow(/truncated/);
    const v9 = npy('<f4', [1], new Uint8Array(4));
    v9[6] = 9;
    expect(() => parseNpy(v9)).toThrow(/version/);
  });

  test.skipIf(!existsSync(PY))('files written by real NumPy (2D float32, Fortran float64, float16)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guide-npy-'));
    try {
      const script = [
        'import numpy as np, sys',
        'd = sys.argv[1]',
        'a = (np.arange(12, dtype=np.float32).reshape(3, 4) / 4)',
        'np.save(d + "/c32.npy", a)',
        'np.save(d + "/f64.npy", np.asfortranarray(a.astype(np.float64)))',
        'np.save(d + "/f16.npy", a.astype(np.float16))',
      ].join('\n');
      const r = Bun.spawnSync([PY, '-I', '-c', script, dir]);
      if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
      const want = Array.from({ length: 12 }, (_, i) => i / 4);
      for (const f of ['c32', 'f64', 'f16']) {
        const m = depthMapFromNpy(parseNpy(readFileSync(join(dir, `${f}.npy`))));
        expect([m.width, m.height]).toEqual([4, 3]);
        expect([...m.data]).toEqual(want);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('harness encoders', () => {
  test('PNG has a valid signature and IHDR', () => {
    const png = encodePng(new Uint8Array(4 * 3 * 2).fill(200), 3, 2);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(3);
    expect(dv.getUint32(20)).toBe(2);
  });

  test('.npy headers are padded to 64 bytes like numpy writes them', () => {
    const f = encodeNpyF32(new Float32Array(6), [2, 3]);
    const headerLen = new DataView(f.buffer).getUint16(8, true);
    expect((10 + headerLen) % 64).toBe(0);
    expect(f[10 + headerLen - 1]).toBe(10);
  });
});
