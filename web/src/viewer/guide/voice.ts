// The guide's voice: push-to-talk recording (MediaRecorder, webm/opus), speech playback from WAV
// data URLs, tiny UI sounds, and the WAV/base64 helpers shared with the tests and the harness.
//
// Nothing here touches the DOM at import time, so the pure helpers run under bun.

// ---------------------------------------------------------------------------------------------
// base64 and data URLs

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface DataUrl {
  /** e.g. "audio/wav" (parameters stripped, lower case). */
  mime: string;
  /** The full media type with parameters, e.g. "audio/webm;codecs=opus". */
  type: string;
  bytes: Uint8Array;
}

/** Splits a base64 data URL; null when it is not one. */
export function parseDataUrl(url: unknown): DataUrl | null {
  if (typeof url !== 'string') return null;
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
  if (!m || !m[2]) return null;
  try {
    const type = m[1] || 'application/octet-stream';
    return { mime: type.split(';')[0].trim().toLowerCase(), type, bytes: base64ToBytes(m[3]) };
  } catch {
    return null;
  }
}

export function toDataUrl(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${bytesToBase64(bytes)}`;
}

// ---------------------------------------------------------------------------------------------
// WAV

export interface WavInfo {
  /** 1 = PCM, 3 = IEEE float (WAVE_FORMAT_EXTENSIBLE is resolved to its sub-format). */
  format: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  frames: number;
  /** Seconds. */
  duration: number;
}

/**
 * Reads a RIFF/WAVE header. Tolerates streaming headers whose data size is 0 or 0xFFFFFFFF (the
 * data then runs to the end of the buffer) and odd-sized chunks (padded to even lengths).
 */
export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < 12) throw new Error('not a WAV file: too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file: missing RIFF/WAVE');
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw new Error('WAV fmt chunk is truncated');
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.length) format = dv.getUint16(body + 24, true);
      fmt = { format, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bitsPerSample: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      dataOffset = body;
      const rest = bytes.length - body;
      dataBytes = size === 0 || size === 0xffffffff || size > rest ? rest : size;
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataOffset < 0) throw new Error('WAV has no data chunk');
  if (!fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample) throw new Error('WAV format fields are zero');
  const frameBytes = fmt.channels * Math.ceil(fmt.bitsPerSample / 8);
  const frames = Math.floor(dataBytes / frameBytes);
  return { ...fmt, dataOffset, dataBytes, frames, duration: frames / fmt.sampleRate };
}

/** 16-bit PCM WAV from float samples in [-1, 1] (interleaved when channels > 1). */
export function encodeWav16(samples: ArrayLike<number>, sampleRate: number, channels = 1): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    dv.setInt16(44 + i * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
  }
  return out;
}

/** Duration in seconds of a speech data URL when it is a WAV, else null. */
export function speechDuration(url: unknown): number | null {
  const d = parseDataUrl(url);
  if (!d) return null;
  try {
    return parseWav(d.bytes).duration;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Recording

/** Recorder formats in order of preference; the contract asks for webm/opus (the Quest Browser's native one). */
export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

export function pickRecorderType(isSupported: (t: string) => boolean): string {
  for (const t of RECORDER_TYPES) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* some browsers throw on unknown types */
    }
  }
  return '';
}

export type MicState = 'unknown' | 'asking' | 'ready' | 'denied' | 'unsupported';

export interface Recording {
  /** data:audio/webm;codecs=opus;base64,... */
  dataUrl: string;
  type: string;
  seconds: number;
  bytes: number;
}

/** Shortest hold that counts as a question; anything shorter is a tap. */
export const MIN_RECORDING_SECONDS = 0.45;
/** The contract caps questions at 8 s. */
export const MAX_RECORDING_SECONDS = 8;

function blobToDataUrl(blob: Blob, type: string): Promise<string> {
  return blob.arrayBuffer().then((b) => toDataUrl(type, new Uint8Array(b)));
}

let sharedAudio: AudioContext | null = null;

/** One AudioContext for the level meter and the UI sounds (created lazily, resumed on use). */
export function audioContext(): AudioContext | null {
  if (sharedAudio) {
    if (sharedAudio.state === 'suspended') void sharedAudio.resume().catch(() => undefined);
    return sharedAudio;
  }
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedAudio = new Ctor();
    if (sharedAudio.state === 'suspended') void sharedAudio.resume().catch(() => undefined);
  } catch {
    sharedAudio = null;
  }
  return sharedAudio;
}

/**
 * Push-to-talk microphone. The stream is opened once (the first hold, or warm()) and kept, so
 * later holds start recording at once; a live level drives the waveform in the UI.
 */
export class VoiceRecorder {
  state: MicState = 'unknown';
  maxSeconds = MAX_RECORDING_SECONDS;
  /** Called when a recording hits maxSeconds by itself. */
  onAutoStop: (() => void) | null = null;
  private stream: MediaStream | null = null;
  private opening: Promise<boolean> | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private type = '';
  private startedAt = 0;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private smoothLevel = 0;

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  constructor() {
    if (!VoiceRecorder.supported()) this.state = 'unsupported';
  }

  get available(): boolean {
    return this.state === 'ready' || this.state === 'unknown' || this.state === 'asking';
  }

  get recording(): boolean {
    return !!this.rec && this.rec.state === 'recording';
  }

  /** Seconds since recording started (0 when idle). */
  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /**
   * Opens the microphone only when the browser already has permission (no prompt can appear, so it
   * is safe right before requestSession). Resolves to whether it is open.
   */
  async warmIfGranted(): Promise<boolean> {
    if (this.state === 'unsupported' || this.state === 'denied') return false;
    try {
      const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      if (status?.state !== 'granted') return false;
    } catch {
      return false;
    }
    return this.warm();
  }

  /** Opens the microphone (asks for permission the first time). Resolves to whether it is usable. */
  warm(): Promise<boolean> {
    if (this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live')) return Promise.resolve(true);
    if (this.state === 'unsupported' || this.state === 'denied') return Promise.resolve(false);
    if (this.opening) return this.opening;
    this.state = 'asking';
    this.opening = navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      .then((stream) => {
        this.stream = stream;
        this.state = 'ready';
        this.type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
        this.setupLevel(stream);
        for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => this.dropStream());
        return true;
      })
      .catch((e: unknown) => {
        const name = (e as { name?: string })?.name ?? '';
        this.state = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : 'unknown';
        return false;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private dropStream(): void {
    this.stream = null;
    if (this.state === 'ready') this.state = 'unknown';
    try {
      this.source?.disconnect();
    } catch {
      /* already gone */
    }
    this.source = null;
  }

  private setupLevel(stream: MediaStream): void {
    const ctx = audioContext();
    if (!ctx) return;
    try {
      this.source = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.2;
      this.source.connect(this.analyser);
      this.levelBuf = new Uint8Array(this.analyser.fftSize);
    } catch {
      this.analyser = null;
    }
  }

  /** Microphone loudness 0..1, smoothed (0 when not recording). */
  level(): number {
    if (!this.recording || !this.analyser || !this.levelBuf) {
      this.smoothLevel *= 0.85;
      return this.smoothLevel;
    }
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.levelBuf.length);
    const target = Math.min(1, rms * 5);
    this.smoothLevel += (target - this.smoothLevel) * (target > this.smoothLevel ? 0.5 : 0.15);
    return this.smoothLevel;
  }

  /** Starts recording; resolves false when the microphone is not available. */
  async start(): Promise<boolean> {
    if (this.recording) return true;
    const ok = await this.warm();
    if (!ok || !this.stream) return false;
    this.chunks = [];
    try {
      this.rec = this.type ? new MediaRecorder(this.stream, { mimeType: this.type, audioBitsPerSecond: 32000 }) : new MediaRecorder(this.stream);
    } catch {
      try {
        this.rec = new MediaRecorder(this.stream);
      } catch {
        this.rec = null;
        return false;
      }
    }
    const rec = this.rec;
    rec.addEventListener('dataavailable', (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    try {
      rec.start(250);
    } catch {
      this.rec = null;
      return false;
    }
    this.startedAt = performance.now();
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.rec === rec && this.recording) this.onAutoStop?.();
    }, this.maxSeconds * 1000);
    return true;
  }

  /** Stops and returns the recording (null when nothing usable was captured). */
  stop(): Promise<Recording | null> {
    const rec = this.rec;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (!rec || rec.state === 'inactive') {
      this.rec = null;
      return Promise.resolve(null);
    }
    const seconds = Math.min(this.maxSeconds, (performance.now() - this.startedAt) / 1000);
    return new Promise<Recording | null>((resolve) => {
      const done = () => {
        this.rec = null;
        const type = rec.mimeType || this.type || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        if (!blob.size) return resolve(null);
        blobToDataUrl(blob, type)
          .then((dataUrl) => resolve({ dataUrl, type, seconds, bytes: blob.size }))
          .catch(() => resolve(null));
      };
      rec.addEventListener('stop', done, { once: true });
      try {
        rec.requestData();
      } catch {
        /* some engines refuse requestData right before stop */
      }
      try {
        rec.stop();
      } catch {
        done();
      }
    });
  }

  /** Stops without producing a recording. */
  cancel(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const rec = this.rec;
    this.rec = null;
    this.chunks = [];
    try {
      if (rec && rec.state !== 'inactive') rec.stop();
    } catch {
      /* already stopped */
    }
  }

  dispose(): void {
    this.cancel();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.dropStream();
    this.analyser = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Playback

export type PlayResult = 'ended' | 'stopped' | 'blocked' | 'error';

/**
 * Plays the guide's speech. When the browser refuses to play before a user gesture (desktop
 * narration on page load), the clip waits and plays on the next gesture via unlock().
 */
export class SpeechPlayer {
  volume = 1;
  /** Called when playback was blocked and is waiting for a gesture. */
  onBlocked: (() => void) | null = null;
  /** Called when a clip actually starts making sound. */
  onStart: (() => void) | null = null;
  private audio: HTMLAudioElement | null = null;
  private finish: ((r: PlayResult) => void) | null = null;
  private pending: { url: string; at: number } | null = null;

  get playing(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  get waitingForGesture(): boolean {
    return !!this.pending;
  }

  /** Resolves when the clip ends or is stopped. */
  play(url: string): Promise<PlayResult> {
    this.stop();
    if (typeof Audio === 'undefined') return Promise.resolve('error');
    return new Promise<PlayResult>((resolve) => {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.volume = this.volume;
      this.audio = audio;
      let settled = false;
      const settle = (r: PlayResult) => {
        if (settled) return;
        settled = true;
        if (this.audio === audio) this.audio = null;
        if (this.finish === settle) this.finish = null;
        resolve(r);
      };
      this.finish = settle;
      audio.addEventListener('ended', () => settle('ended'), { once: true });
      audio.addEventListener('error', () => settle('error'), { once: true });
      audio.src = url;
      audio
        .play()
        .then(() => {
          if (!settled) this.onStart?.();
        })
        .catch((e: unknown) => {
          const name = (e as { name?: string })?.name;
          if (name === 'NotAllowedError') {
            this.pending = { url, at: performance.now() };
            this.onBlocked?.();
            settle('blocked');
          } else if (name === 'AbortError') settle('stopped');
          else settle('error');
        });
    });
  }

  /** Call from a user gesture: plays a clip that was blocked (if it is still recent). */
  unlock(maxAgeMs = 25000): Promise<PlayResult> | null {
    const p = this.pending;
    this.pending = null;
    if (!p || performance.now() - p.at > maxAgeMs) return null;
    return this.play(p.url);
  }

  dropPending(): void {
    this.pending = null;
  }

  stop(): void {
    const a = this.audio;
    const f = this.finish;
    this.audio = null;
    this.finish = null;
    if (a) {
      try {
        a.pause();
        a.removeAttribute('src');
        a.load();
      } catch {
        /* nothing to stop */
      }
    }
    f?.('stopped');
  }
}

// ---------------------------------------------------------------------------------------------
// UI sounds: short blips when listening starts and stops (headset feedback without looking)

export type Earcon = 'start' | 'stop' | 'error' | 'pop';

export function playEarcon(kind: Earcon, volume = 0.07): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;
  try {
    const t0 = ctx.currentTime + 0.01;
    const notes: Array<[number, number, number]> =
      kind === 'start' ? [[660, 0, 0.07], [990, 0.07, 0.09]]
      : kind === 'stop' ? [[880, 0, 0.06], [620, 0.06, 0.08]]
      : kind === 'pop' ? [[1240, 0, 0.05]]
      : [[240, 0, 0.12], [190, 0.12, 0.14]];
    for (const [f, at, len] of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0 + at);
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(volume, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
  } catch {
    /* sound is a nicety */
  }
}

/**
 * Reads `text` aloud with the device's own voice (speechSynthesis) when the guide sent no audio, for instance when its
 * speech models are out of quota. Resolves true when it finished speaking, false when the device has no voice, refused
 * (some browsers want a tap first) or took longer than `maxMs`.
 */
export function speakWithDevice(text: string, maxMs: number, signal?: AbortSignal): Promise<boolean> {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined' || !text.trim()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(ok);
    };
    const stop = () => {
      synth.cancel();
      finish(false);
    };
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    const timer = setTimeout(stop, maxMs);
    signal?.addEventListener('abort', stop, { once: true });
    synth.cancel();
    synth.speak(u);
  });
}
