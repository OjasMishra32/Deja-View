// Serves tests/harness/avatar-scene.html (the-courts world + the people from IMG_7373 on a media clock) and, unless
// --serve, drives it in headless Chrome: checks that the people follow the clock exactly (paused = frozen, seeks
// exact, held at the clip's end, poses where avatar.json says), the crossfade near the recording camera and the
// frustum culling; measures their skinned meshes over the whole clip (feet on the floor, human height, facing each
// other, no stray or stretched vertices, smooth motion, and with --box nobody inside that obstacle); with a real
// clip, checks the people line up with its frames at the right time (sync); times renders with and without them;
// then screenshots every time x view (and a paused circle) and a contact sheet.
//
//   bun tests/harness/avatar-scene-shots.ts [--times 2,6,10] [--views rec,orbit0,orbit90,orbit180,orbit270]
//       [--circle 6[,6]] [--centre x,z] [--box cx,cz,ux,uz,halfLong,halfWide,y0,y1] [--sync 2.2,3.5,9.3,11.6]
//       [--out data/evidence/avatar-scene] [--port 8858] [--video <clip.mp4>] [--footage <clip>] [--serve]
//
// Views: rec (the recording camera), orbit<deg> (around the people), around<deg> (that far around the centre from
// the recording camera's bearing, same distance, eye 1.6 m), behind<i> (1.3 m behind person i, looking at the
// centre), near<i> (1 m from person i, to their side, eye 1.6 m; plain `near` alternates i with the time).
// The centre is --centre, else the midpoint of the people at that time. --circle t[,n]: paused at t, n views on a
// 2.6 m circle around the centre. --box: an upright box in the viewer frame (centre and long axis on the floor, half
// sizes, y span), e.g. the foosball table's cabinet at the Game Lawn:
//   --box -0.158,-1.922,-0.225,-0.974,0.665,0.372,0.5,0.89
// --video plays a real media element (any H.264/VP9 file, repo-relative or absolute) instead of the fake clock;
// --sync then lists the times of the sync check (the clip's frame vs the people a little ahead or behind).
// --footage puts the clip's own frame at each time (ffmpeg) in the contact sheet's first column.
// --serve only serves: open http://127.0.0.1:<port>/avatar-scene?t=6&paused=1&cam=orbit,30 and walk around.
// One headless Chrome at a time. Output: <out>/t<time>-<view>.png, <out>/sheet.png and a JSON summary on stdout.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import page from './avatar-scene.html';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (name: string, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : def;
};
const PORT = Number(opt('--port', '8858'));
const TIMES = opt('--times', '2,6,10').split(',').map(Number);
const VIEWS = opt('--views', 'rec,orbit0,orbit90,orbit180,orbit270').split(',');
const OUT = resolve(ROOT, opt('--out', 'data/evidence/avatar-scene'));
const VIDEO = opt('--video');
const FOOTAGE = opt('--footage');
const SERVE_ONLY = args.includes('--serve');
const SETTLE_MS = Number(opt('--settle', '700'));
const CIRCLE = opt('--circle') ? opt('--circle').split(',').map(Number) : null;
const CENTRE = opt('--centre') ? opt('--centre').split(',').map(Number) : null;
const BOX = opt('--box') ? opt('--box').split(',').map(Number) : null;
const SYNC_TIMES = opt('--sync', '2.2,3.5,9.3,11.6').split(',').map(Number);
const SYNC_OFFSETS = [-0.5, -0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3, 0.5];
if (BOX && (BOX.length !== 8 || BOX.some((v) => !Number.isFinite(v)))) throw new Error('--box takes cx,cz,ux,uz,halfLong,halfWide,y0,y1');

const MIME: Record<string, string> = {
  '.json': 'application/json', '.spz': 'application/octet-stream', '.ply': 'application/octet-stream', '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
const mime = (p: string) => MIME[p.slice(p.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

/** A file with HTTP Range support (media elements ask for ranges). */
function fileResponse(path: string, req: Request): Response {
  const size = statSync(path).size;
  const file = Bun.file(path);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  const headers: Record<string, string> = { 'content-type': mime(path), 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  if (!range) return new Response(file, { headers: { ...headers, 'content-length': String(size) } });
  let a = range[1] ? Number(range[1]) : 0;
  let b = range[2] ? Number(range[2]) : size - 1;
  if (!range[1] && range[2]) {
    a = Math.max(0, size - Number(range[2]));
    b = size - 1;
  }
  b = Math.min(b, size - 1);
  if (a > b) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(file.slice(a, b + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': String(b - a + 1) } });
}

const videoPath = VIDEO ? (isAbsolute(VIDEO) ? VIDEO : join(ROOT, VIDEO)) : '';
if (videoPath && !existsSync(videoPath)) throw new Error(`no such video: ${videoPath}`);

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  development: { hmr: false, console: true },
  routes: { '/avatar-scene': page },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/media/clip' && videoPath) return fileResponse(videoPath, req);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (!rel.startsWith('data/scenes/') || rel.split('/').includes('..')) return new Response('not found', { status: 404 });
    const path = join(ROOT, rel);
    if (!existsSync(path) || !statSync(path).isFile()) return new Response('not found', { status: 404 });
    return fileResponse(path, req);
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

if (SERVE_ONLY) {
  console.log(`${BASE}/avatar-scene?t=6&paused=1&cam=orbit,30${videoPath ? '&video=/media/clip' : ''}`);
  await new Promise(() => {});
}

interface Person {
  id: string;
  time: number;
  alpha: number;
  visible: boolean;
  pelvis: number[] | null;
}
/** tests/harness/avatar-scene.ts ProbePerson. */
interface Probe {
  id: string;
  minY: number;
  maxY: number;
  pelvis: number[];
  facingDeg: number | null;
  maxFromPelvis: number;
  maxGrow: number;
  bad: number;
  inBox?: number;
  boxDepth?: number;
}
interface Info {
  media: number;
  paused: boolean;
  clock: string;
  duration: number;
  cam: { kind: string; position: number[]; fov: number };
  recDistance: number | null;
  blend: number;
  coverage: number;
  people: Person[];
  failed: string[];
  count: number;
  splats: number;
  loadMs: number;
  frame: { calls: number; triangles: number };
}

const avatarDoc = JSON.parse(readFileSync(join(ROOT, 'data/scenes/the-courts/avatar.json'), 'utf8'));
const checks: Array<{ name: string; ok: boolean; detail: unknown }> = [];
const check = (name: string, ok: boolean, detail: unknown) => checks.push({ name, ok, detail });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(p: Page, q: string): Promise<void> {
  await p.goto(`${BASE}/avatar-scene?${q}`);
  await p.waitForFunction(() => (window as any).__avatarScene?.ready === true, null, { timeout: 240_000 });
  const err = await p.evaluate(() => (window as any).__avatarScene.error);
  if (err) throw new Error(err);
}
const set = (p: Page, a: Record<string, unknown>) => p.evaluate((x) => (window as any).__avatarScene.set(x), a) as Promise<Info>;
const info = (p: Page) => p.evaluate(() => (window as any).__avatarScene.info()) as Promise<Info>;
const frames = (p: Page, n: number) => p.evaluate((k) => (window as any).__avatarScene.frames(k), n);
const deg = (r: number) => (r * 180) / Math.PI;
/** A fixed camera (the page's x,y,z,yaw,pitch) at (px, py, pz) looking at (tx, ty, tz). */
function lookCam(px: number, py: number, pz: number, tx: number, ty: number, tz: number): string {
  const dx = tx - px, dy = ty - py, dz = tz - pz;
  return [px, py, pz, deg(Math.atan2(-dx, -dz)), deg(Math.atan2(dy, Math.hypot(dx, dz)))].map((v) => v.toFixed(4)).join(',');
}
/** Milliseconds per render of the page's current view with and without the people (medians of 5 alternating batches). */
async function benchPeople(p: Page): Promise<{ withPeople: number; withoutPeople: number }> {
  const bench = (on: boolean) => p.evaluate((x) => (window as any).__avatarScene.bench(120, x), on) as Promise<number>;
  await bench(true);
  await bench(false);
  const on: number[] = [], off: number[] = [];
  for (let i = 0; i < 5; i++) {
    on.push(await bench(true));
    off.push(await bench(false));
  }
  const med = (v: number[]) => +v.sort((a, b) => a - b)[Math.floor(v.length / 2)].toFixed(3);
  return { withPeople: med(on), withoutPeople: med(off) };
}
/** Runs of consecutive indices where ok(i) fails, as [first, last]. */
function runs(n: number, bad: (i: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (!bad(i)) continue;
    if (out.length && out[out.length - 1][1] === i - 1) out[out.length - 1][1] = i;
    else out.push([i, i]);
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const shots: Array<{ t: number; view: string; png: string; people: Array<{ id: string; time: number; alpha: number }>; recDistance: number | null }> = [];
let summary: Record<string, unknown> = {};
try {
  const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const logs: string[] = [];
  p.on('console', (m) => {
    // (failed requests are logged with their URL below)
    if (/^Failed to load resource/.test(m.text())) return;
    if (m.type() === 'error' || m.type() === 'warning' || /\[avatars\]/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  p.on('response', (r) => {
    // (the page looks for the clip under the place's input/ first)
    if (r.status() >= 400 && !/\/input\/IMG_7373\.(mp4|mov)$/.test(r.url())) logs.push(`http ${r.status()}: ${r.url()}`);
  });
  await open(p, `t=0&paused=1&cam=rec&shot=1${videoPath ? '&video=/media/clip' : ''}`);
  const first = await info(p);
  check('both people loaded', first.count === 2 && first.failed.length === 0, { count: first.count, failed: first.failed, loadMs: first.loadMs, clock: first.clock });

  // poses where avatar.json says: the root bone at t = 0 is each person's pelvisStart
  const t0 = await set(p, { t: 0, paused: true, cam: 'orbit,0', blend: false });
  for (const person of avatarDoc.people as Array<{ id: string; pelvisStart: number[] }>) {
    const got = t0.people.find((q) => q.id === person.id)?.pelvis;
    const err = got ? Math.hypot(got[0] - person.pelvisStart[0], got[1] - person.pelvisStart[1], got[2] - person.pelvisStart[2]) : Infinity;
    check(`${person.id} pelvis at t=0 matches avatar.json`, err < 0.02, { got, want: person.pelvisStart, errM: +err.toFixed(4) });
  }

  // paused is a frozen pose, seeks land exactly
  const a = await set(p, { t: 3, paused: true });
  await frames(p, 30);
  await sleep(400);
  const b = await info(p);
  const samePelvis = b.people.every((q, i) => JSON.stringify(q.pelvis) === JSON.stringify(a.people[i].pelvis));
  check('paused: media time and poses frozen', a.media === 3 && b.media === 3 && samePelvis && b.people.every((q, i) => q.time === a.people[i].time && q.time === 3), {
    before: a.people.map((q) => q.time),
    after: b.people.map((q) => q.time),
    pelvisBefore: a.people.map((q) => q.pelvis),
    pelvisAfter: b.people.map((q) => q.pelvis),
  });
  const seeks: Record<string, number[]> = {};
  let exact = true;
  for (const t of [0, 1 / 30, 6.0333, 9.5, 12.3]) {
    const s = await set(p, { t, paused: true });
    seeks[String(+t.toFixed(4))] = s.people.map((q) => q.time);
    exact &&= s.people.every((q) => Math.abs(q.time - (s.media - avatarDoc.start)) < 1e-9);
  }
  check('seeks: animation time = media time - start', exact, seeks);
  const end = await set(p, { t: 12.38, paused: true });
  check('held just below the clip end (no wrap to the first frame)', end.people.every((q) => q.time > 12.358 && q.time < 12.35834), {
    media: end.media,
    times: end.people.map((q) => q.time),
  });

  // playing: the people move with the clock, every frame on the same time
  await set(p, { t: 4, paused: false });
  await sleep(1000);
  const c = await set(p, { paused: true });
  check('playing: animation follows the media clock', c.media > 4.5 && c.people.every((q) => Math.abs(q.time - (c.media - avatarDoc.start)) < 1e-9), {
    media: c.media,
    times: c.people.map((q) => q.time),
  });

  // crossfade near the recording camera
  const rec = await set(p, { t: 6, paused: true, cam: 'rec', blend: true });
  await frames(p, 2);
  const recI = await info(p);
  const [rx, ry, rz] = rec.cam.position;
  await set(p, { cam: `${rx + 0.8},${ry},${rz},0` });
  await frames(p, 2);
  const halfI = await info(p);
  await set(p, { cam: `${rx + 2},${ry},${rz},0` });
  await frames(p, 2);
  const farI = await info(p);
  check(
    'crossfade: hidden at the recording camera, half at 0.8 m, full past 1.2 m',
    recI.blend === 0 && recI.coverage === 0 && recI.people.every((q) => !q.visible) && Math.abs(halfI.blend - 0.5) < 0.01 && farI.blend === 1 && farI.people.every((q) => q.alpha === 1),
    { rec: [recI.recDistance, recI.blend], half: [halfI.recDistance, halfI.blend], far: [farI.recDistance, farI.blend, farI.people.map((q) => q.alpha)] },
  );

  // sync: from the recording camera, the people a little ahead of or behind the clip's own frame on screen
  if (videoPath) {
    const sync: Array<{ t: number; best: number; errs: Array<{ offset: number; err: number }> }> = [];
    for (const t of SYNC_TIMES) {
      await set(p, { t, paused: true, cam: 'rec', blend: false, offset: 0 });
      await frames(p, 10);
      await sleep(400);
      const errs = (await p.evaluate((o) => (window as any).__avatarScene.sync(o), SYNC_OFFSETS)) as Array<{ offset: number; err: number }> | null;
      if (!errs) continue;
      sync.push({ t, best: errs.reduce((a, b) => (b.err < a.err ? b : a)).offset, errs });
    }
    await set(p, { offset: 0 });
    const off = sync.filter((x) => Math.abs(x.best) > 0.1);
    check('sync: the people line up best with the clip at offset 0 (within 0.1 s)', sync.length > 0 && off.length <= Math.floor(sync.length / 4), sync.map((x) => ({ t: x.t, bestOffset: x.best, err: Object.fromEntries(x.errs.map((e) => [e.offset, e.err])) })));
  }

  // render cost with and without the people (people in view, the world drawn): medians of alternating batches
  await set(p, { t: 6, paused: true, cam: 'orbit,0,2.4,1.6', blend: false });
  await frames(p, 10);
  summary.renderMs = await benchPeople(p);

  // screenshots: every time x view, paused
  /** The camera of a view at time t (ti: the time's index). */
  async function viewCam(view: string, t: number, ti: number): Promise<string> {
    if (view === 'rec') return 'rec';
    if (/^orbit-?\d*$/.test(view)) return `orbit,${Number(view.slice(5)) || 0},2.4,1.6`;
    if (!/^(around-?\d*|behind\d*|near\d*)$/.test(view)) return view;
    const at = await set(p, { t, paused: true, cam: 'rec', blend: false });
    const pel = at.people.map((q) => q.pelvis).filter((v): v is number[] => !!v);
    if (!pel.length) return 'orbit,0,2.4,1.6';
    const c = CENTRE ?? [pel.reduce((s, v) => s + v[0], 0) / pel.length, pel.reduce((s, v) => s + v[2], 0) / pel.length];
    const [rx, , rz] = at.cam.position;
    if (view.startsWith('around')) {
      const a = Math.atan2(rx - c[0], rz - c[1]) + ((Number(view.slice(6)) || 90) * Math.PI) / 180;
      const r = Math.max(1.2, Math.hypot(rx - c[0], rz - c[1]));
      return lookCam(c[0] + r * Math.sin(a), 1.6, c[1] + r * Math.cos(a), c[0], 0.9, c[1]);
    }
    const i = Math.min(pel.length - 1, view.startsWith('behind') ? Number(view.slice(6)) || 0 : view.length > 4 ? Number(view.slice(4)) || 0 : ti % pel.length);
    const [x, , z] = pel[i];
    const dl = Math.hypot(c[0] - x, c[1] - z) || 1;
    const dx = (c[0] - x) / dl, dz = (c[1] - z) / dl;
    if (view.startsWith('behind')) return lookCam(x - 1.3 * dx, 1.7, z - 1.3 * dz, c[0], 0.9, c[1]);
    // to the person's side (the recording camera's side), turned 30 degrees away from the centre: face, hands and back
    let sx = -dz, sz = dx;
    if (sx * (rx - x) + sz * (rz - z) < 0) (sx = -sx), (sz = -sz);
    const ox = sx * Math.cos(Math.PI / 6) - dx * 0.5, oz = sz * Math.cos(Math.PI / 6) - dz * 0.5;
    const on = Math.hypot(ox, oz);
    return lookCam(x + ox / on, 1.6, z + oz / on, x, 1.15, z);
  }
  const plan: Array<{ t: number; view: string; ti: number }> = [];
  TIMES.forEach((t, ti) => VIEWS.forEach((view) => plan.push({ t, view, ti })));
  if (CIRCLE) {
    const n = Math.max(1, Math.round(CIRCLE[1] ?? 6));
    for (let k = 0; k < n; k++) plan.push({ t: CIRCLE[0], view: `circle${Math.round((k * 360) / n)}`, ti: 0 });
  }
  let circleCentre: number[] | null = null;
  for (const { t, view, ti } of plan) {
    let cam: string;
    if (view.startsWith('circle')) {
      if (!circleCentre) {
        const at = await set(p, { t, paused: true, cam: 'rec', blend: false });
        const pel = at.people.map((q) => q.pelvis).filter((v): v is number[] => !!v);
        circleCentre = CENTRE ?? (pel.length ? [pel.reduce((s, v) => s + v[0], 0) / pel.length, pel.reduce((s, v) => s + v[2], 0) / pel.length] : [0, -2]);
      }
      const a = (Number(view.slice(6)) * Math.PI) / 180;
      cam = lookCam(circleCentre[0] + 2.6 * Math.sin(a), 1.6, circleCentre[1] + 2.6 * Math.cos(a), circleCentre[0], 0.9, circleCentre[1]);
    } else cam = await viewCam(view, t, ti);
    // (crossfade off: the people from every side, also from the recording camera next to the footage)
    await set(p, { t, paused: true, cam, blend: false });
    await frames(p, 20);
    await sleep(SETTLE_MS);
    const s = await info(p);
    const png = join(OUT, view.startsWith('circle') ? `paused${t.toFixed(2)}-${view}.png` : `t${t.toFixed(2)}-${view}.png`);
    await p.screenshot({ path: png });
    shots.push({ t, view, png, people: s.people.map((q) => ({ id: q.id, time: +q.time.toFixed(4), alpha: +q.alpha.toFixed(3) })), recDistance: s.recDistance });
  }
  summary.logs = logs.slice(-20);
  summary.splats = first.splats;
  await p.close();

  // frustum culling: drawn triangles with the people in view and behind the camera (people only, no world)
  const q = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await open(q, 't=6&paused=1&world=0&shot=1&blend=0&cam=orbit,0,2.4');
  await frames(q, 3);
  const facing = await info(q);
  const [fx, fy, fz] = facing.cam.position;
  await set(q, { cam: `${fx},${fy},${fz + 0.01},180` });
  await frames(q, 3);
  const away = await info(q);
  check('frustum culling: no people drawn when looking away', facing.frame.triangles > 40000 && away.frame.triangles < 1000, {
    facing: facing.frame,
    away: away.frame,
  });
  // the people alone (no world), in view: what they cost to draw
  await set(q, { cam: 'orbit,0,2.4' });
  await frames(q, 3);
  summary.renderMsPeopleOnly = await benchPeople(q);

  // the skinned meshes over the whole clip, at 60 samples a second (fake clock)
  const dur = Number(avatarDoc.mediaDuration) || 12;
  // (keyframes evenly over the person's time range: the GLB's keys are every other frame of the clip)
  const p0 = avatarDoc.people?.[0];
  const keyRate = p0?.keyframes > 1 && p0?.timeRange ? (p0.keyframes - 1) / (p0.timeRange[1] - p0.timeRange[0]) : Number(avatarDoc.fps) || 30;
  const times = Array.from({ length: Math.floor(dur * 60) + 1 }, (_, i) => Math.min(dur, i / 60));
  const box = BOX ? { centre: [BOX[0], BOX[1]], axis: [BOX[2], BOX[3]], half: [BOX[4], BOX[5]], y: [BOX[6], BOX[7]] } : undefined;
  const scan = (await q.evaluate((a) => (window as any).__avatarScene.scan(a.times, a.box), { times, box })) as Array<{ t: number; people: Probe[] }>;
  await q.close();
  const ids = scan[0]?.people.map((x) => x.id) ?? [];
  const at = (i: number) => ({ t: +scan[i].t.toFixed(3), keyframe: Math.round(scan[i].t * keyRate) });
  const span = (r: [number, number]) => `${at(r[0]).t}-${at(r[1]).t} s (keyframes ${at(r[0]).keyframe}-${at(r[1]).keyframe})`;
  const geometry: Record<string, unknown> = {};
  let floorOk = true, scaleOk = true, facingOk = true, meshOk = true, smoothOk = true, boxOk = true;
  ids.forEach((id, pi) => {
    const g = scan.map((f) => f.people[pi]);
    const q = (v: number[], k: number) => +v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * k))].toFixed(3);
    const minY = g.map((x) => x.minY), maxY = g.map((x) => x.maxY), facing = g.map((x) => x.facingDeg ?? 0);
    const grow = Math.max(...g.map((x) => x.maxGrow)), far = Math.max(...g.map((x) => x.maxFromPelvis)), bad = g.reduce((s, x) => s + x.bad, 0);
    let jump = 0;
    for (let i = 1; i < g.length; i++) jump = Math.max(jump, Math.hypot(g[i].pelvis[0] - g[i - 1].pelvis[0], g[i].pelvis[1] - g[i - 1].pelvis[1], g[i].pelvis[2] - g[i - 1].pelvis[2]));
    const floating = runs(g.length, (i) => g[i].minY > 0.04), sunk = runs(g.length, (i) => g[i].minY < -0.04);
    floorOk &&= minY.filter((v) => Math.abs(v) <= 0.03).length >= 0.95 * minY.length && !floating.length && !sunk.length;
    scaleOk &&= q(maxY, 0) > 1.3 && q(maxY, 1) < 2.1;
    facingOk &&= ids.length < 2 || facing.filter((v) => v <= 45).length >= 0.95 * facing.length;
    meshOk &&= grow <= 0.1 && far <= 1.3 && bad === 0;
    smoothOk &&= jump <= 0.05;
    const entry: Record<string, unknown> = {
      soleY: { min: q(minY, 0), p5: q(minY, 0.05), median: q(minY, 0.5), p95: q(minY, 0.95), max: q(minY, 1) },
      floating: floating.map(span),
      sunk: sunk.map(span),
      headTopY: { min: q(maxY, 0), median: q(maxY, 0.5), max: q(maxY, 1) },
      facingOtherDeg: { median: q(facing, 0.5), p95: q(facing, 0.95), max: q(facing, 1) },
      maxEdgeGrowthM: +grow.toFixed(3),
      maxFromPelvisM: +far.toFixed(3),
      pelvisStepM: +jump.toFixed(3),
      nonFinite: bad,
    };
    if (box) {
      const inside = runs(g.length, (i) => (g[i].boxDepth ?? 0) > 0.05);
      boxOk &&= !inside.length;
      const deepest = g.reduce((b, x, i) => ((x.boxDepth ?? 0) > (g[b].boxDepth ?? 0) ? i : b), 0);
      entry.insideBox = { runs: inside.map(span), deepestM: g[deepest].boxDepth, deepestAt: at(deepest), maxVertices: Math.max(...g.map((x) => x.inBox ?? 0)) };
    }
    geometry[id] = entry;
  });
  check('feet on the floor (soles within 3 cm in 95% of the clip, never 4 cm off)', floorOk, Object.fromEntries(ids.map((id) => [id, { soleY: (geometry[id] as any).soleY, floating: (geometry[id] as any).floating, sunk: (geometry[id] as any).sunk }])));
  check('human scale (top of the head 1.3-2.1 m)', scaleOk, Object.fromEntries(ids.map((id) => [id, (geometry[id] as any).headTopY])));
  check('facing each other (hips within 45 degrees, 95% of the clip)', facingOk, Object.fromEntries(ids.map((id) => [id, (geometry[id] as any).facingOtherDeg])));
  check('no stray or stretched vertices (edges grow at most 10 cm, all within 1.3 m of the pelvis)', meshOk, Object.fromEntries(ids.map((id) => [id, { grow: (geometry[id] as any).maxEdgeGrowthM, far: (geometry[id] as any).maxFromPelvisM, nonFinite: (geometry[id] as any).nonFinite }])));
  check('smooth motion (the pelvis moves at most 5 cm in 1/60 s)', smoothOk, Object.fromEntries(ids.map((id) => [id, (geometry[id] as any).pelvisStepM])));
  if (box) check('nobody inside the box (deeper than 5 cm)', boxOk, Object.fromEntries(ids.map((id) => [id, (geometry[id] as any).insideBox])));
  summary.geometry = geometry;

  // contact sheet: one row per time (the footage first, when given), one column per view
  const footage = FOOTAGE ? (isAbsolute(FOOTAGE) ? FOOTAGE : join(ROOT, FOOTAGE)) : '';
  const cell = (file: string, type: string, label: string) =>
    `<figure><img src="data:${type};base64,${readFileSync(file).toString('base64')}"><figcaption>${label}</figcaption></figure>`;
  const rows: string[][] = [];
  for (const t of TIMES) {
    const row: string[] = [];
    if (footage) {
      const jpg = join(OUT, `footage-t${t.toFixed(2)}.jpg`);
      const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-ss', String(t), '-i', footage, '-frames:v', '1', '-vf', 'scale=960:-2', jpg]);
      row.push(r.exitCode === 0 && existsSync(jpg) ? cell(jpg, 'image/jpeg', `t=${t.toFixed(2)} s · the footage`) : '<figure></figure>');
    }
    for (const s of shots.filter((x) => x.t === t && !x.view.startsWith('circle'))) row.push(cell(s.png, 'image/png', `t=${s.t.toFixed(2)} s · ${s.view === 'rec' ? 'from the recording camera' : s.view}`));
    rows.push(row);
  }
  const circle = shots.filter((x) => x.view.startsWith('circle'));
  if (circle.length) rows.push(circle.map((s) => cell(s.png, 'image/png', `paused at ${s.t.toFixed(2)} s · ${s.view.slice(6)} degrees around`)));
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const cells = rows.map((r) => r.concat(Array(cols - r.length).fill('<figure></figure>')).join('')).join('');
  const sheet = await browser.newPage({ viewport: { width: 300 * cols, height: 400 } });
  await sheet.setContent(
    `<style>body{margin:0;background:#101014;color:#ddd;font:13px system-ui}main{display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;padding:4px}` +
      `figure{margin:0}img{width:100%;display:block}figcaption{padding:2px 4px}</style><main>${cells}</main>`,
  );
  const sheetPng = join(OUT, 'sheet.png');
  await sheet.screenshot({ path: sheetPng, fullPage: true });
  summary.sheet = sheetPng;
  await sheet.close();
} finally {
  await browser.close();
  server.stop(true);
}
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, checks, shots: shots.map((s) => ({ ...s, png: s.png.replace(ROOT + '/', '') })), ...summary }, null, 1));
process.exit(ok ? 0 : 1);
