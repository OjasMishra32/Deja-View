// The real server process (server/index.ts) with the live layer wired in, against both teammate stand-ins
// (tests/harness/mock-deepspace.ts, mock-guide.ts): presence in and out, the DeepSpace push, notes from the map
// to /ws, Roblox moments to /ws, host cues, stored labels, the guide relay, and /describe in the upload path.
// Its own data folder (THIRDWHEEL_DATA) and ports, HiPerGator off: nothing here touches data/ or a real GPU.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockDeepSpace, type MockDeepSpace } from './harness/mock-deepspace.ts';
import { startMockGuide, type MockGuide } from './harness/mock-guide.ts';

const ROOT = resolve(import.meta.dir, '..');
const SCENE = 'live-room-aaaaa';
const KEY = 'test-ds-key';

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function until<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

let data = '';
let port = 0;
let base = '';
let httpBase = '';
let child: ChildProcess | null = null;
let ds: MockDeepSpace;
let guide: MockGuide;
let log = '';
const messages: any[] = [];
let ws: WebSocket | null = null;

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'tw-boot-'));
  const dir = join(data, 'scenes', SCENE);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(dir, 'scene.json'),
    JSON.stringify({
      id: SCENE,
      name: 'Live room',
      mode: 'sample',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'other' },
    }),
  );
  ds = startMockDeepSpace({ port: freePort(), key: KEY, hostname: '127.0.0.1', quiet: true });
  guide = startMockGuide({ port: freePort(), hostname: '127.0.0.1', quiet: true, speech: false });
  port = freePort();
  base = `http://127.0.0.1:${port}`;
  const httpPort = freePort();
  httpBase = `http://127.0.0.1:${httpPort}`;
  child = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      // the second, plain-HTTP listener (contracts 2.1: 8788 next to the https 8787), same process and data
      HTTP_PORT: String(httpPort),
      ROBLOX_API_KEY: '',
      ROBLOX_CREATOR_ID: '',
      THIRDWHEEL_DATA: data,
      THIRDWHEEL_HPG: 'off',
      THIRDWHEEL_BACKENDS: 'hpg-worker',
      THIRDWHEEL_HTTPS: '0',
      THIRDWHEEL_READONLY: '',
      DS_URL: ds.url,
      DS_KEY: KEY,
      GUIDE_URL: guide.url,
      GUIDE_KEY: '',
      DV_KEY: '',
      THIRDWHEEL_API_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok, 30_000, `the server (log: ${log.slice(-600)})`);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await until(() => messages.some((m) => m.type === 'health'), 5000, 'the first /ws message');
}, 60_000);

afterAll(async () => {
  ws?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await until(() => child!.exitCode !== null || child!.signalCode !== null, 5000, 'the server to stop').catch(() => child?.kill('SIGKILL'));
  }
  ds?.stop();
  guide?.stop();
  if (data) await rm(data, { recursive: true, force: true });
});

const post = (path: string, body: unknown, method = 'POST') =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('the live layer in the real server', () => {
  test('boot log names the live services', () => {
    expect(log).toContain('Live:   DeepSpace on');
    expect(log).toContain('guide on');
  });

  test('presence: the headset posts, Roblox sees it in studs, the headset sees Roblox in metres, DeepSpace gets 7-field pushes', async () => {
    const me = { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0.42, y: 0, z: -1.1, yaw: 0.3, head: [0.42, 1.62, -1.1], hands: null };
    const r = await post(`/api/presence/${SCENE}`, me);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const rb = await post(`/api/roblox/${SCENE}/presence`, { players: [{ id: 'rbx-1', name: 'curl', x: 4, y: 0, z: 0, yaw: 0 }] });
    expect(rb.status).toBe(200);
    const others = (await rb.json()).others;
    expect(others.find((p: any) => p.id === 'quest-1').x).toBeCloseTo(0.42 * 3.57, 2);
    const view = await (await fetch(`${base}/api/presence/${SCENE}`)).json();
    expect(view.people.find((p: any) => p.id === 'rbx-1').x).toBeCloseTo(1.12, 2);
    const push = await until(() => ds.ingests.find((i) => i.sceneId === SCENE && i.people.some((p) => p.id === 'quest-1')), 4000, 'a DeepSpace push');
    expect(push.key).toBe(KEY);
    expect(push.problems).toEqual([]);
  });

  test('a Roblox tag reaches /ws with the server time and the target position', async () => {
    const r = await post(`/api/roblox/${SCENE}/event`, { type: 'tag', by: 'quest-1', target: 'rbx-1' });
    expect(r.status).toBe(200);
    const m = await until(() => messages.find((x) => x.type === 'roblox' && x.event?.type === 'tag'), 3000, 'the roblox message');
    expect(m.sceneId).toBe(SCENE);
    expect(m.event.by).toBe('quest-1');
    expect(typeof m.event.t).toBe('number');
    expect(m.event.pos?.[0]).toBeCloseTo(1.12, 1);
  });

  test('a note typed on the map pops out on /ws and in GET /api/notes', async () => {
    const keepHere = setInterval(() => void post(`/api/presence/${SCENE}`, { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0, y: 0, z: 0, yaw: 0 }), 250);
    try {
      const note = ds.addNote({ sceneId: SCENE, author: 'Brianna', text: "Seb's seat.", x: 1.2, z: -0.8 });
      const m = await until(() => messages.find((x) => x.type === 'note' && x.note?.id === note.id), 6000, 'the note message');
      expect(m.sceneId).toBe(SCENE);
      expect(m.note.y).toBe(1.4);
      const list = await (await fetch(`${base}/api/notes/${SCENE}`)).json();
      expect(list.notes.some((n: any) => n.id === note.id)).toBe(true);
    } finally {
      clearInterval(keepHere);
    }
  });

  test('host cue and stored labels go out on /ws', async () => {
    expect((await post('/api/host/cue', { action: 'reality', on: true })).status).toBe(200);
    const cue = await until(() => messages.find((x) => x.type === 'cue'), 3000, 'the cue');
    expect(cue).toMatchObject({ action: 'reality', on: true });
    const hs = { hotspots: [{ label: 'TV', blurb: 'The results screen.', x: 0.5, y: 1.2, z: -2 }] };
    const put = await post(`/api/scenes/${SCENE}/hotspots`, hs, 'PUT');
    expect(put.status).toBe(200);
    const m = await until(() => messages.find((x) => x.type === 'hotspots'), 3000, 'the hotspots message');
    expect(m).toEqual({ type: 'hotspots', sceneId: SCENE, hotspots: hs.hotspots });
    expect(await (await fetch(`${base}/api/scenes/${SCENE}/hotspots`)).json()).toEqual(hs);
  });

  test('the guide relay answers with the scene filled in', async () => {
    // a scene without a thumbnail: the headset sends what it sees
    const image = `data:image/jpeg;base64,${Buffer.from('\xff\xd8\xff\xe0 tiny jpeg').toString('base64')}`;
    const r = await post('/api/guide/narrate', { image, scene: { id: SCENE } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.answer).toBe('string');
    expect(guide.last('narrate')?.scene?.name).toBe('Live room');
  });

  test('the plain-HTTP listener is the same server: same data, same presence, same /ws messages', async () => {
    expect(log).toContain(`HTTP:   http://localhost:${new URL(httpBase).port}`);
    const h = await (await fetch(`${httpBase}/api/health`)).json();
    expect(h.ok).toBe(true);
    expect('user' in h.hpg).toBe(false); // the cluster account never leaves the machine
    const mine: any[] = [];
    const ws2 = new WebSocket(`${httpBase.replace('http', 'ws')}/ws`);
    ws2.onmessage = (e) => mine.push(JSON.parse(String(e.data)));
    try {
      await until(() => mine.some((m) => m.type === 'health'), 5000, 'health on the second listener');
      expect(mine.find((m) => m.type === 'health').health.hpg.user).toBeUndefined();
      // posted on one listener, seen on the other
      await post(`/api/presence/${SCENE}`, { id: 'web-12345678', name: 'Maya', kind: 'web', x: 1, y: 0, z: 1, yaw: 0 });
      const there = await (await fetch(`${httpBase}/api/presence/${SCENE}`)).json();
      expect(there.people.some((p: any) => p.id === 'web-12345678')).toBe(true);
      expect((await fetch(`${httpBase}/api/host/cue`, { method: 'POST', body: JSON.stringify({ action: 'labels', on: false }) })).status).toBe(200);
      await until(() => mine.find((m) => m.type === 'cue' && m.action === 'labels'), 3000, 'the cue on the second listener');
      await until(() => messages.find((m) => m.type === 'cue' && m.action === 'labels'), 3000, 'the cue on the first listener');
    } finally {
      ws2.close();
    }
  });

  test('/host and /api/host/status are served; the textured-model routes answer', async () => {
    const page = await fetch(`${base}/host`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const st = await fetch(`${base}/api/host/status`);
    expect(st.status).toBe(200);
    const body = await st.json();
    expect(body.ok).toBe(true);
    expect(Object.keys(body.checks).sort()).toEqual(['deepspace', 'gpu', 'guide', 'people', 'roblox', 'tunnel']);
    expect(body.scenes.list.find((x: any) => x.id === SCENE)).toMatchObject({ mode: 'sample' });
    const model = await fetch(`${base}/api/roblox/${SCENE}/model`);
    expect(model.status).toBe(404);
    expect((await model.json()).error).toBe('This room has no Roblox model yet.');
    expect((await fetch(`${base}/api/roblox/${SCENE}/model.glb`)).status).toBe(404);
    expect((await fetch(`${base}/api/roblox/nope-zzzzz/model`)).status).toBe(404);
  });

  test('an upload declared bigger than the limit gets a JSON 413, not a bare one', async () => {
    // a raw request: fetch would correct the Content-Length to the body it really sends
    let buf = '';
    const sock = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data(_s, d) { buf += Buffer.from(d).toString(); } } });
    sock.write('POST /api/scenes HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: 1153433600\r\n\r\n');
    const text = await until(() => (/\r\n\r\n\{/.test(buf) ? buf : null), 3000, 'the 413');
    sock.end();
    expect(text.split('\r\n')[0]).toContain('413');
    expect(text).toContain('application/json');
    expect(JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)).error).toContain('too big');
  });

  test('the Roblox map route answers in the contract shape (no world file here: an error, never a crash)', async () => {
    const r = await fetch(`${base}/api/roblox/${SCENE}/map`);
    expect([200, 202, 409, 500]).toContain(r.status);
    expect(r.headers.get('content-type')).toContain('json');
    expect((await fetch(`${base}/api/roblox/nope-zzzzz/map`)).status).toBe(404);
  });

  test('a Photo upload is described by the guide before its job: scene.caption and the job prompt', async () => {
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', '-y', join(data, 'room.jpg')]);
    if (ff.status !== 0) {
      console.warn('ffmpeg missing: skipping the upload check');
      return;
    }
    const form = new FormData();
    form.set('mode', 'photo');
    form.set('name', 'Described room');
    form.set('files', new File([await Bun.file(join(data, 'room.jpg')).arrayBuffer()], 'room.jpg', { type: 'image/jpeg' }));
    const r = await fetch(`${base}/api/scenes`, { method: 'POST', body: form });
    expect(r.status).toBe(201);
    const created = await r.json();
    expect(created.mode).toBe('photo'); // contracts 4.1: never the internal name
    const id = created.id as string;
    const wsScene = await until(() => messages.find((m) => m.type === 'scene' && m.scene?.id === id), 3000, 'the scene on /ws');
    expect(wsScene.scene.mode).toBe('photo');
    // no GPU here (HiPerGator off): the job fails after the description, which is what this checks
    const s = await until(async () => {
      const x = await (await fetch(`${base}/api/scenes/${id}`)).json();
      return x.status === 'failed' || x.status === 'ready' ? x : null;
    }, 15_000, 'the job to finish');
    expect(s.captionSource).toBe('guide');
    expect(typeof s.caption).toBe('string');
    expect(guide.last('describe')?.image).toMatch(/^data:image\/jpeg;base64,/);
    const job = await Bun.file(join(data, 'jobs', id, 'job.json')).json();
    expect(job.prompt).toBe(s.caption);
    expect(log).toContain(`[describe] ${id}`);
  }, 30_000);

  test('a Video upload is described too (its first-second frame), so /ask gets the place, not the pipeline', async () => {
    const clip = join(data, 'clip.mp4');
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', '-y', clip]);
    if (ff.status !== 0) {
      console.warn('ffmpeg missing: skipping the video describe check');
      return;
    }
    const before = guide.requests?.filter?.((x: any) => x.endpoint === 'describe').length ?? 0;
    const form = new FormData();
    form.set('mode', 'video');
    form.set('name', 'Clip room');
    form.set('files', new File([await Bun.file(clip).arrayBuffer()], 'clip.mp4', { type: 'video/mp4' }));
    const r = await fetch(`${base}/api/scenes`, { method: 'POST', body: form });
    expect(r.status).toBe(201);
    const created = await r.json();
    expect(created.mode).toBe('video');
    const s = await until(async () => {
      const x = await (await fetch(`${base}/api/scenes/${created.id}`)).json();
      return x.status === 'failed' || x.status === 'ready' ? x : null;
    }, 20_000, 'the video job to finish');
    expect(s.mode).toBe('video');
    expect(s.captionSource).toBe('guide');
    expect(log).toContain(`[describe] ${created.id}`);
    void before;
  }, 40_000);
});

describe('without DS_URL and GUIDE_URL', () => {
  let bare: ChildProcess | null = null;
  let bareData = '';
  let bareBase = '';
  let bareLog = '';

  beforeAll(async () => {
    bareData = await mkdtemp(join(tmpdir(), 'tw-bare-'));
    const dir = join(bareData, 'scenes', SCENE);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(join(dir, 'scene.json'), JSON.stringify({ id: SCENE, name: 'Bare room', mode: 'sample', status: 'ready', createdAt: now, updatedAt: now }));
    const p = freePort();
    bareBase = `http://127.0.0.1:${p}`;
    const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production', PORT: String(p), THIRDWHEEL_DATA: bareData, THIRDWHEEL_HPG: 'off', THIRDWHEEL_BACKENDS: 'hpg-worker', THIRDWHEEL_HTTPS: '0' };
    for (const k of ['DS_URL', 'DS_KEY', 'GUIDE_URL', 'GUIDE_KEY', 'DV_KEY', 'THIRDWHEEL_API_TOKEN', 'THIRDWHEEL_READONLY', 'HTTP_PORT']) delete env[k];
    // set, not deleted: the server would load them from the repo's .env otherwise (no uploads to Roblox from tests)
    env.ROBLOX_API_KEY = '';
    env.ROBLOX_CREATOR_ID = '';
    bare = spawn('bun', ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    bare.stdout!.on('data', (d) => (bareLog += d));
    bare.stderr!.on('data', (d) => (bareLog += d));
    await until(async () => (await fetch(`${bareBase}/api/health`).catch(() => null))?.ok, 30_000, `the bare server (log: ${bareLog.slice(-600)})`);
  }, 60_000);

  afterAll(async () => {
    if (bare && bare.exitCode === null) {
      bare.kill('SIGTERM');
      await until(() => bare!.exitCode !== null || bare!.signalCode !== null, 5000, 'the bare server to stop').catch(() => bare?.kill('SIGKILL'));
    }
    if (bareData) await rm(bareData, { recursive: true, force: true });
  });

  test('everything live still answers politely', async () => {
    expect(bareLog).toContain('DeepSpace off (DS_URL unset)');
    expect(bareLog).toContain('guide off (GUIDE_URL unset)');
    const me = { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0, y: 0, z: 0, yaw: 0 };
    expect((await fetch(`${bareBase}/api/presence/${SCENE}`, { method: 'POST', body: JSON.stringify(me) })).status).toBe(200);
    const notes = await fetch(`${bareBase}/api/notes/${SCENE}`);
    expect(notes.status).toBe(200);
    expect((await notes.json()).notes).toEqual([]);
    const ask = await fetch(`${bareBase}/api/guide/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'who won?', scene: { id: SCENE } }) });
    expect(ask.status).toBe(502);
    const askBody = await ask.json();
    expect(askBody.error).toBe('guide offline');
    expect(askBody.configured).toBe(false); // the headset stops asking instead of retrying for minutes
    expect((await fetch(`${bareBase}/api/host/cue`, { method: 'POST', body: JSON.stringify({ action: 'labels', on: true }) })).status).toBe(200);
    expect(await (await fetch(`${bareBase}/api/scenes/${SCENE}/hotspots`)).json()).toEqual({ hotspots: [] });
  });

  test('a Photo upload skips the description and keeps its own prompt', async () => {
    const jpg = join(bareData, 'room.jpg');
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', '-y', jpg]);
    if (ff.status !== 0) return;
    const form = new FormData();
    form.set('mode', 'photo');
    form.set('prompt', 'a quiet library');
    form.set('files', new File([await Bun.file(jpg).arrayBuffer()], 'room.jpg', { type: 'image/jpeg' }));
    const r = await fetch(`${bareBase}/api/scenes`, { method: 'POST', body: form });
    expect(r.status).toBe(201);
    const id = (await r.json()).id as string;
    const s = await until(async () => {
      const x = await (await fetch(`${bareBase}/api/scenes/${id}`)).json();
      return x.status === 'failed' || x.status === 'ready' ? x : null;
    }, 15_000, 'the job to finish');
    expect(s.captionSource).toBeUndefined();
    expect((await Bun.file(join(bareData, 'jobs', id, 'job.json')).json()).prompt).toBe('a quiet library');
  }, 30_000);
});
