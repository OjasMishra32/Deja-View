// A stand-in for Brianna's guide service (team/brianna.md section 5), so labels, greetings and spoken answers work
// end to end without the real model. Answers are canned or keyword-based; speech is real (macOS `say`, returned as a
// 24 kHz mono 16-bit WAV data URL, the same format the real guide sends).
//
//   bun tests/harness/mock-guide.ts        port 8795 (PORT overrides); GUIDE_KEY, when set, is required as X-Guide-Key
//   then run the server with GUIDE_URL=http://127.0.0.1:8795 (and the same GUIDE_KEY)
//
// Routes: GET /health, POST /describe /hotspots /narrate /ask (shapes exactly as in the contract, plus ms/degraded/cached
// /mock). Failure drills (POST /mock/mode {mode} or setMode()): ok | slow (12 s, past every server timeout) |
// degraded (200 + canned answer + degraded: true) | html (502 HTML page) | error (500 JSON).
// MOCK_GUIDE_VOICE picks a `say` voice; MOCK_GUIDE_HEARD is what the mock pretends a spoken question said.

import { createHash, randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';

export type GuideMockMode = 'ok' | 'slow' | 'degraded' | 'html' | 'error';

export interface MockGuide {
  url: string;
  port: number;
  /** Every request to a guide route: name and parsed body. */
  requests: { name: string; body: any; headers: Record<string, string>; at: number }[];
  last(name: string): any;
  setMode(mode: GuideMockMode): void;
  stop(): void;
}

export interface MockGuideOptions {
  port?: number;
  hostname?: string;
  key?: string;
  voice?: string;
  /** What a spoken question is taken to say (the mock does no speech recognition). */
  heard?: string;
  /** Turn speech off (faster tests). */
  speech?: boolean;
  quiet?: boolean;
}

const IMAGE_URL = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
const AUDIO_URL = /^data:audio\/[a-z0-9.+-]+(;[^,;]*)*;base64,/i;

function hash(s: string): number {
  return createHash('sha1').update(s).digest().readUInt32BE(0);
}

function pick<T>(list: readonly T[], seed: number): T {
  return list[seed % list.length]!;
}

/** Rebuilds a WAV with only the fmt and data chunks (macOS writes an extra FLLR padding chunk). */
export function cleanWav(buf: Uint8Array): { wav: Uint8Array; seconds: number } | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (buf.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt: Uint8Array | null = null;
  let data: Uint8Array | null = null;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    if (id === 'fmt ') fmt = body;
    if (id === 'data') data = body;
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16) return null;
  const fv = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  const channels = fv.getUint16(2, true);
  const rate = fv.getUint32(4, true);
  const bits = fv.getUint16(14, true);
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + data.length);
  const ov = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  ov.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  ov.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  const d = 20 + fmt.length;
  out.set([0x64, 0x61, 0x74, 0x61], d);
  ov.setUint32(d + 4, data.length, true);
  out.set(data, d + 8);
  return { wav: out, seconds: data.length / (rate * channels * (bits / 8)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Canned content

const CAPTIONS = [
  'A cozy lounge with a grey couch facing a wide TV on a low wooden cabinet, carpet tiles and warm lamp light; just outside the frame, a bookshelf, a hallway door and a window with blinds behind the camera.',
  'A bright dorm room with a lofted bed, a pine desk under a wide window, grey carpet and soft afternoon light; beyond the frame, a closet with mirror doors, a mini fridge and a hallway door behind the camera.',
  'A sunny stylised hillside with wooden cabins, a winding dirt path and round cartoon trees under a clear sky; beyond the frame, more cabins, a small lake and rolling green hills in the same game art style.',
  'A small kitchen with white cabinets, a gas stove, a steel fridge and a window over the sink in cool daylight; just outside the frame, a dining table, a pantry door and a hallway behind the camera.',
] as const;

const OBJECTS: { re: RegExp; label: string; blurbs: string[] }[] = [
  { re: /\b(tv|television|screens?|monitors?)\b/, label: 'screen', blurbs: ['Scene of the crime', 'The final score lives here'] },
  { re: /\b(controllers?|gamepads?)\b/, label: 'controllers', blurbs: ['Still warm', 'Button mashing zone'] },
  { re: /\b(couch|sofa)\b/, label: 'couch', blurbs: ['Prime real estate', 'One seat suspiciously empty'] },
  { re: /\b(snacks?|chips|popcorn|pizza)\b/, label: 'snacks', blurbs: ['Mostly crumbs now'] },
  { re: /\blamps?\b/, label: 'lamp', blurbs: ['Mood lighting, allegedly'] },
  { re: /\bwindows?\b/, label: 'window', blurbs: ['Free daylight'] },
  { re: /\bdesks?\b/, label: 'desk', blurbs: ['Homework goes here to die'] },
  { re: /\bbed\b/, label: 'bed', blurbs: ['Nap headquarters'] },
  { re: /\bplants?\b/, label: 'plant', blurbs: ['Barely hanging on'] },
  { re: /\b(bookshelf|bookshelves|books)\b/, label: 'bookshelf', blurbs: ['Mostly decorative'] },
  { re: /\b(stove|oven)\b/, label: 'stove', blurbs: ['Where dinner happens'] },
  { re: /\b(fridge|refrigerator)\b/, label: 'fridge', blurbs: ['Midnight destination'] },
  { re: /\btrees?\b/, label: 'trees', blurbs: ['Cartoon forestry'] },
  { re: /\bcabins?\b/, label: 'cabin', blurbs: ['Loot is probably inside'] },
  { re: /\b(lake|river|pond)\b/, label: 'lake', blurbs: ['Swim at your own risk'] },
  { re: /\btable\b/, label: 'table', blurbs: ['Holds everything'] },
];
const DEFAULT_LABELS = ['screen', 'couch', 'snacks', 'lamp', 'window', 'table'];
const BLURB: Record<string, string> = Object.fromEntries(OBJECTS.map((o) => [o.label, o.blurbs[0]!]));

function labelsFor(scene: any, seed: number): string[] {
  const text = `${scene?.caption ?? ''} ${scene?.name ?? ''}`.toLowerCase();
  const found = OBJECTS.filter((o) => o.re.test(text)).map((o) => o.label);
  const out = [...new Set(found)];
  for (let i = 0; out.length < 3; i++) {
    const l = DEFAULT_LABELS[(seed + i) % DEFAULT_LABELS.length]!;
    if (!out.includes(l)) out.push(l);
  }
  return out.slice(0, 3 + (seed % 4)).slice(0, 6);
}

function hotspotsFor(image: string, scene: any) {
  const seed = hash(image.slice(-4096) + String(scene?.id ?? ''));
  const labels = labelsFor(scene, seed);
  // spread the pins over the frame: a jittered grid so no two land on top of each other
  const cells = [
    [0.3, 0.35], [0.62, 0.3], [0.45, 0.62], [0.75, 0.6], [0.2, 0.68], [0.55, 0.45],
  ] as const;
  return labels.map((label, i) => {
    const [cx, cy] = cells[(i + seed) % cells.length]!;
    const j = hash(`${seed}:${label}`);
    const x = Math.round((cx + ((j % 100) / 100 - 0.5) * 0.08) * 1000) / 1000;
    const y = Math.round((cy + (((j >> 8) % 100) / 100 - 0.5) * 0.08) * 1000) / 1000;
    const o = OBJECTS.find((q) => q.label === label);
    return { label, x, y, blurb: o ? pick(o.blurbs, j) : 'Worth a closer look' };
  });
}

function mainThing(scene: any): string {
  const h = scene?.hotspots?.[0]?.label;
  if (typeof h === 'string' && h) return h;
  const text = `${scene?.caption ?? ''}`.toLowerCase();
  return OBJECTS.find((o) => o.re.test(text))?.label ?? 'couch';
}

function greeting(scene: any): string {
  const thing = mainThing(scene);
  const lines = [
    `Nice place. Someone left every light on, and that ${thing} has seen things.`,
    `Welcome back. The ${thing} remembers you, even if nobody else does.`,
    `You made it. Grab a spot by the ${thing} before someone else does.`,
    `Ah, a visitor. Mind the ${thing}; it has opinions.`,
  ];
  return pick(lines, hash(String(scene?.id ?? scene?.name ?? 'x')));
}

function answer(question: string, scene: any): { answer: string; hotspot?: { label: string; x: number; y: number } } {
  const q = question.toLowerCase();
  const thing = mainThing(scene);
  if (/\bwho\b.*\b(won|win|wins|winning)\b/.test(q)) {
    return { answer: 'The scoreboard says a last-second upset. The couch still has not recovered.', hotspot: { label: 'screen', x: 0.52, y: 0.31 } };
  }
  if (/\bwhere\b|\bwhat (is|'s) this place\b|\bwhat place\b/.test(q)) {
    const clause = String(scene?.caption ?? '').split(/[;,.]/)[0]?.trim();
    return { answer: clause ? `${scene?.name ? `${scene.name}. ` : ''}${clause}. You are standing right in it.` : 'A memory someone saved for you. You are standing right in it.' };
  }
  if (/\bwhat('s| is)? (that|this)\b/.test(q)) {
    return { answer: `That's the ${thing}. ${BLURB[thing] ?? 'Worth a closer look'}.`, hotspot: { label: thing, x: 0.5, y: 0.45 } };
  }
  if (/\b(hello|hi|hey)\b/.test(q)) return { answer: "Hey. Make yourself at home, just don't touch the snacks." };
  if (/\b(missing|who('s| is) not here|skipped)\b/.test(q)) return { answer: 'Someone skipped game night. The empty seat on the couch noticed.' };
  return { answer: `Good question. All I know is that ${thing} has seen better days.` };
}

const HTML_ERROR = '<!doctype html><html><body><h1>502 Bad gateway</h1></body></html>';

export function startMockGuide(opts: MockGuideOptions = {}): MockGuide {
  const key = opts.key ?? process.env.GUIDE_KEY ?? '';
  const voice = opts.voice ?? process.env.MOCK_GUIDE_VOICE ?? '';
  const heard = opts.heard ?? process.env.MOCK_GUIDE_HEARD ?? 'who won?';
  const speechOn = opts.speech ?? true;
  const log = opts.quiet ? () => {} : (m: string) => console.log(`[mock-guide] ${m}`);
  const started = Date.now();
  const requests: MockGuide['requests'] = [];
  const narrateCache = new Map<string, { at: number; body: any }>();
  const hotspotCache = new Map<string, any>();
  const speechCache = new Map<string, Promise<{ url: string; seconds: number } | null>>();
  let mode: GuideMockMode = 'ok';

  function speak(text: string): Promise<{ url: string; seconds: number } | null> {
    if (!speechOn || !text) return Promise.resolve(null);
    let p = speechCache.get(text);
    if (!p) {
      p = (async () => {
        const out = join(tmpdir(), `dv-mock-speech-${randomBytes(6).toString('hex')}.wav`);
        try {
          const argv = ['say', ...(voice ? ['-v', voice] : []), '-o', out, '--file-format=WAVE', '--data-format=LEI16@24000', text];
          const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' });
          const timer = setTimeout(() => proc.kill('SIGKILL'), 8000);
          const code = await proc.exited;
          clearTimeout(timer);
          if (code !== 0) return null;
          const clean = cleanWav(new Uint8Array(await Bun.file(out).arrayBuffer()));
          if (!clean) return null;
          return { url: `data:audio/wav;base64,${Buffer.from(clean.wav).toString('base64')}`, seconds: Math.round(clean.seconds * 10) / 10 };
        } catch {
          return null;
        } finally {
          await unlink(out).catch(() => {});
        }
      })();
      speechCache.set(text, p);
      if (speechCache.size > 200) speechCache.delete(speechCache.keys().next().value!);
    }
    return p;
  }

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  async function route(name: string, body: any): Promise<Response> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    if (body.image !== undefined && (typeof body.image !== 'string' || !IMAGE_URL.test(body.image))) return json({ error: 'image must be a base64 data URL' }, 400);
    const scene = body.scene && typeof body.scene === 'object' ? body.scene : {};

    if (name === 'describe') {
      if (!body.image) return json({ error: 'image required' }, 400);
      if (mode === 'degraded') return json({ caption: '', degraded: true, error: 'model unavailable' });
      return json({ caption: pick(CAPTIONS, hash(body.image.slice(-4096))), ms: { understand: ms() }, mock: true });
    }

    if (name === 'hotspots') {
      if (!body.image) return json({ error: 'image required' }, 400);
      if (mode === 'degraded') return json({ hotspots: [], degraded: true, error: 'model unavailable' });
      const k = `${scene.id ?? ''}:${hash(body.image)}`;
      const hit = hotspotCache.get(k);
      if (hit) return json({ hotspots: hit, cached: true, degraded: false, ms: { understand: ms() }, mock: true });
      const hs = hotspotsFor(body.image, scene);
      hotspotCache.set(k, hs);
      return json({ hotspots: hs, cached: false, degraded: false, ms: { understand: ms() }, mock: true });
    }

    if (name === 'narrate') {
      const id = typeof scene.id === 'string' ? scene.id : '';
      const hit = id ? narrateCache.get(id) : undefined;
      if (hit && Date.now() - hit.at < 30 * 60_000) return json({ ...hit.body, cached: true, ms: { total: ms() } });
      if (!body.image) return json({ error: 'image required' }, 400);
      const line = mode === 'degraded' ? 'Welcome in. Take a look around.' : greeting(scene);
      const s = await speak(line);
      const out = { answer: line, speech: s?.url ?? null, speechSeconds: s?.seconds ?? 0, cached: false, degraded: mode === 'degraded', mock: true, ms: { total: ms() } };
      if (id && mode !== 'degraded') narrateCache.set(id, { at: Date.now(), body: out });
      return json(out);
    }

    // ask
    if (body.audio !== undefined && (typeof body.audio !== 'string' || !AUDIO_URL.test(body.audio))) return json({ error: 'audio must be a base64 data URL' }, 400);
    if (!body.audio && !(typeof body.question === 'string' && body.question.trim())) return json({ error: 'audio or question required' }, 400);
    let question = typeof body.question === 'string' ? body.question.trim() : '';
    if (body.audio) {
      const bytes = Math.floor(((body.audio.length - body.audio.indexOf(',') - 1) * 3) / 4);
      if (bytes < 2048) {
        const miss = 'Sorry, I missed that. Hold the button and try again.';
        const s = await speak(miss);
        return json({ question: '', answer: miss, speech: s?.url ?? null, speechSeconds: s?.seconds ?? 0, degraded: false, mock: true, ms: { total: ms() } });
      }
      question = heard;
    }
    if (mode === 'degraded') {
      return json({ question, answer: "My brain is buffering. Ask me again in a second.", speech: null, degraded: true, error: 'model timeout', mock: true });
    }
    const a = answer(question, scene);
    const s = await speak(a.answer);
    return json({ question, answer: a.answer, speech: s?.url ?? null, speechSeconds: s?.seconds ?? 0, ...(a.hotspot ? { hotspot: a.hotspot } : {}), degraded: false, mock: true, ms: { total: ms() } });
  }

  const server: Server<undefined> = Bun.serve({
    port: opts.port ?? 8795,
    hostname: opts.hostname ?? '127.0.0.1',
    idleTimeout: 30,
    maxRequestBodySize: 32 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      const name = url.pathname.replace(/^\/+|\/+$/g, '');
      if (name === 'health' && req.method === 'GET') {
        return json({ ok: true, gemini: 'off', mock: true, models: { fast: 'mock', spatial: 'mock', tts: 'say' }, voice: voice || 'system', uptimeS: Math.round((Date.now() - started) / 1000) });
      }
      if (name === 'mock/mode' && req.method === 'POST') {
        const b: any = await req.json().catch(() => null);
        if (!['ok', 'slow', 'degraded', 'html', 'error'].includes(b?.mode)) return json({ error: 'unknown mode' }, 400);
        mode = b.mode;
        log(`mode: ${mode}`);
        return json({ ok: true, mode });
      }
      if (!['describe', 'hotspots', 'narrate', 'ask'].includes(name)) return json({ error: 'not found' }, 404);
      if (req.method !== 'POST') return json({ error: 'use POST' }, 405);
      if (key && req.headers.get('x-guide-key') !== key) return json({ error: 'bad guide key' }, 401);
      const text = await req.text();
      if (text.length > 15 * 1024 * 1024) return json({ error: 'too large' }, 413);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: 'malformed JSON' }, 400);
      }
      requests.push({ name, body, headers: Object.fromEntries(req.headers), at: Date.now() });
      if (requests.length > 500) requests.splice(0, requests.length - 500);
      if (mode === 'slow') await Bun.sleep(12_000);
      if (mode === 'html') return new Response(HTML_ERROR, { status: 502, headers: { 'Content-Type': 'text/html' } });
      if (mode === 'error') return json({ error: 'internal error' }, 500);
      const res = await route(name, body ?? {});
      log(`/${name} -> ${res.status}`);
      return res;
    },
  });

  // warm the speech engine so the first spoken answer is not the slow one
  if (speechOn) void speak('Ready.');

  return {
    url: `http://${opts.hostname ?? '127.0.0.1'}:${server.port}`,
    port: server.port!,
    requests,
    last: (name) => [...requests].reverse().find((r) => r.name === name)?.body,
    setMode: (m) => {
      mode = m;
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 8795);
  const g = startMockGuide({ port, hostname: process.env.HOST || '127.0.0.1' });
  console.log(`\nStand-in guide on ${g.url} (canned answers, real speech)`);
  console.log(`  Server env: GUIDE_URL=${g.url}${process.env.GUIDE_KEY ? ' GUIDE_KEY=<the same key>' : ''}\n`);
  const stop = () => {
    g.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
