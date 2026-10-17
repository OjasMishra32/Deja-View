// Test harness on :8791 for the front end and the Third Wheel video layer, independent of the
// real server and viewer.
//
//   bun tests/harness/tw-serve.ts            serve http://localhost:8791
//   bun tests/harness/tw-serve.ts --shoot    serve, take screenshots with headless Chrome into
//                                            data/evidence/frontend/, print checks, exit
//
// Routes:
//   /            landing + gallery (web/index.html), against a mock API
//   /capture     capture flow (web/capture.html); uploads go to the mock API
//   /view, /tw   painted bedroom splat (Spark) + the video layer for ?scene= (default test-thirdwheel)
//                ?view=front|camera|side45|side-45|side-80|behind|top  ?t=<seconds>  ?autoplay=1
//   /api/*, /ws  mock of the HTTP API and event stream from docs/ARCHITECTURE.md
//   /data/scenes/<id>/<file>   scene assets with HTTP Range support
//
// The mock reads real scenes from data/scenes (read-only; DELETE only hides them), keeps uploads
// in memory and simulates job progress over /ws. A name containing "fail" fails once at ~50%.

import { networkInterfaces } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import type { ServerWebSocket } from 'bun';
import type { HealthInfo, Scene, SceneMode, ServerEvent } from '../../shared/types.ts';
import indexPage from '../../web/index.html';
import capturePage from '../../web/capture.html';

const ROOT = resolve(import.meta.dir, '..', '..');
const SCENES = join(ROOT, 'data', 'scenes');
const PORT = Number(process.env.TW_PORT ?? 8791);
const SHOOT = process.argv.includes('--shoot');
const DEMO = !process.argv.includes('--no-demo');
const HPG_ONLINE = process.argv.includes('--hpg-online');
const JOB_SECONDS = Number(process.env.TW_JOB_SECONDS ?? 14);

// ---------------------------------------------------------------------------------------------
// Mock state

interface MockScene {
  scene: Scene;
  files: Map<string, Blob | string>; // in-memory uploads or aliases to files on disk
  failOnce: boolean;
  timer?: ReturnType<typeof setInterval>;
}

const mock = new Map<string, MockScene>();
const hidden = new Set<string>();
let server: ReturnType<typeof Bun.serve>;

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

function health(): HealthInfo {
  return {
    ok: true,
    version: 'harness',
    https: false,
    lan: lanAddresses(),
    hpg: {
      online: HPG_ONLINE,
      user: 'sbernalorta',
      worker: HPG_ONLINE ? { alive: true, host: 'c0906a-s29', gpu: 'RTX PRO 6000', lastBeat: new Date().toISOString() } : { alive: false },
    },
    space: { available: true },
    local: { python: true },
  };
}

function publish(ev: ServerEvent) {
  server?.publish('events', JSON.stringify(ev));
}

async function diskScenes(): Promise<Scene[]> {
  const out: Scene[] = [];
  let names: string[] = [];
  try {
    names = await readdir(SCENES);
  } catch {
    return out;
  }
  for (const name of names) {
    if (hidden.has(name)) continue;
    const f = Bun.file(join(SCENES, name, 'scene.json'));
    if (!(await f.exists())) continue;
    try {
      out.push(JSON.parse(await f.text()) as Scene);
    } catch {}
  }
  return out;
}

async function allScenes(): Promise<Scene[]> {
  const list = [...(await diskScenes()), ...[...mock.values()].map((m) => m.scene)];
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function findScene(id: string): Promise<Scene | undefined> {
  if (mock.has(id)) return mock.get(id)!.scene;
  if (hidden.has(id)) return undefined;
  return (await diskScenes()).find((s) => s.id === id);
}

const STAGES: Record<string, string[]> = {
  thirdwheel: ['Uploading to HiPerGator', 'Estimating video depth', 'Cutting out the cook', 'Generating the room', 'Lining up depth and room', 'Packing the RGBD video', 'Downloading results'],
  rentfree: ['Uploading to HiPerGator', 'Picking the sharpest frame', 'Generating the world', 'Filling in the corners', 'Compressing splats', 'Downloading results'],
  reconstruct: ['Uploading to HiPerGator', 'Estimating cameras', 'Fitting splats', 'Downloading results'],
};

function touch(m: MockScene, patch: Partial<Scene>) {
  m.scene = { ...m.scene, ...patch, updatedAt: new Date().toISOString() };
  publish({ type: 'scene', scene: m.scene });
}

function simulate(m: MockScene) {
  clearInterval(m.timer);
  const stages = STAGES[m.scene.mode] ?? STAGES.rentfree;
  const tickMs = 250;
  const total = Math.max(1, (JOB_SECONDS * 1000) / tickMs);
  let tick = 0;
  touch(m, { status: 'queued', stage: 'Waiting for a GPU', progress: 0, error: undefined, backend: HPG_ONLINE ? 'hpg-worker' : m.scene.mode === 'rentfree' ? 'hf-space' : 'local' });
  m.timer = setInterval(() => {
    tick++;
    if (tick < 4) return;
    const p = Math.min(1, (tick - 4) / total);
    if (m.failOnce && p >= 0.5) {
      clearInterval(m.timer);
      m.failOnce = false;
      touch(m, { status: 'failed', error: 'FlashWorld Space ran out of free GPU minutes. Retry, or bring the HiPerGator worker online.' });
      return;
    }
    if (p >= 1) {
      clearInterval(m.timer);
      finish(m);
      return;
    }
    const stage = stages[Math.min(stages.length - 1, Math.floor(p * stages.length))];
    const status = p < 0.08 ? 'uploading' : p > 0.92 ? 'downloading' : 'running';
    touch(m, { status, stage, progress: Math.round(p * 1000) / 1000 });
  }, tickMs);
}

function finish(m: MockScene) {
  const bedroom = join(SCENES, 'sample-painted-bedroom');
  const tw = join(SCENES, 'test-thirdwheel');
  m.files.set('world.spz', join(bedroom, 'world.spz'));
  const patch: Partial<Scene> = {
    status: 'ready',
    stage: 'Ready',
    progress: 1,
    world: {
      file: 'world.spz',
      transform: { position: [0, 0, 0], quaternion: [1, 0, 0, 0], scale: 1 },
      floorY: null,
      source: 'marble-sample',
    },
  };
  if (m.scene.mode === 'thirdwheel') {
    m.files.set('tw.mp4', join(tw, 'tw.mp4'));
    if (!m.files.has('thumb.jpg')) m.files.set('thumb.jpg', join(tw, 'thumb.jpg'));
    patch.thumb = 'thumb.jpg';
    patch.caption = 'The mock job reuses the synthetic test clip';
    const twScene = Bun.file(join(tw, 'scene.json'));
    patch.world = undefined;
    void twScene.text().then((t) => {
      const s = JSON.parse(t) as Scene;
      touch(m, { ...patch, world: s.world, video: s.video });
    });
    return;
  }
  if (m.files.has('thumb.jpg')) patch.thumb = 'thumb.jpg';
  patch.caption = 'The mock job reuses the painted bedroom sample';
  touch(m, patch);
}

function seedDemo() {
  const now = Date.now();
  const iso = (dt: number) => new Date(now - dt).toISOString();
  const tw = join(SCENES, 'test-thirdwheel');
  const add = (scene: Scene, files: [string, string][] = []) => {
    const m: MockScene = { scene, files: new Map(files), failOnce: false };
    mock.set(scene.id, m);
    return m;
  };
  const running = add(
    {
      id: 'demo-running',
      name: 'Kitchen, rent free',
      mode: 'rentfree',
      status: 'running',
      stage: 'Generating the world',
      progress: 0.38,
      createdAt: iso(60_000),
      updatedAt: iso(1000),
      backend: 'hf-space',
      thumb: 'thumb.jpg',
      input: { files: ['00.jpg'] },
    },
    [['thumb.jpg', join(tw, 'plate.jpg')]],
  );
  // Slow live progress so the gallery shows /ws updates.
  running.timer = setInterval(() => {
    const p = running.scene.progress ?? 0;
    touch(running, { progress: p >= 0.9 ? 0.38 : Math.round((p + 0.01) * 1000) / 1000, stage: p > 0.6 ? 'Filling in the corners' : 'Generating the world' });
  }, 700);
  add({
    id: 'demo-failed',
    name: 'Sam makes pancakes',
    mode: 'thirdwheel',
    status: 'failed',
    stage: 'Estimating video depth',
    progress: 0.41,
    error: 'Video depth ran out of GPU memory on hpg-turin (L4, 24 GB). Retry picks a bigger GPU.',
    createdAt: iso(3_600_000),
    updatedAt: iso(3_000_000),
    backend: 'hpg-batch',
    input: { files: ['video.mp4'] },
  });
  add({
    id: 'demo-queued',
    name: "A lighthouse keeper's kitchen",
    mode: 'rentfree',
    status: 'queued',
    stage: 'Waiting for a GPU',
    createdAt: iso(20_000),
    updatedAt: iso(20_000),
    input: { files: [], prompt: "a lighthouse keeper's kitchen at dusk, warm lamps, sea through the window" },
  });
}

// ---------------------------------------------------------------------------------------------
// Static scene files with Range support

const MIME: Record<string, string> = {
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeOf(name: string, fallback = 'application/octet-stream') {
  const m = /\.[a-z0-9]+$/i.exec(name);
  return (m && MIME[m[0].toLowerCase()]) || fallback;
}

async function serveBlob(req: Request, blob: Blob, type: string): Promise<Response> {
  const size = blob.size;
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    let start: number, end: number;
    if (!m[1]) {
      const n = Number(m[2]);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(blob.slice(start, end + 1), { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(blob, { status: 200, headers });
}

async function serveSceneFile(req: Request, id: string, rel: string): Promise<Response> {
  const m = mock.get(id);
  if (m) {
    const entry = m.files.get(rel);
    if (entry === undefined) return new Response('not found', { status: 404 });
    if (typeof entry === 'string') return serveBlob(req, Bun.file(entry), mimeOf(entry));
    return serveBlob(req, entry, entry.type || mimeOf(rel));
  }
  const base = join(SCENES, id);
  const full = normalize(join(base, rel));
  if (!full.startsWith(base + sep)) return new Response('bad path', { status: 400 });
  const f = Bun.file(full);
  if (!(await f.exists())) return new Response('not found', { status: 404 });
  return serveBlob(req, f, mimeOf(full));
}

// ---------------------------------------------------------------------------------------------
// API

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

const CREATABLE: SceneMode[] = ['rentfree', 'thirdwheel', 'reconstruct'];

async function createScene(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'Expected multipart form data' }, 400);
  }
  const mode = String(form.get('mode') ?? '') as SceneMode;
  const name = String(form.get('name') ?? '').trim();
  const prompt = String(form.get('prompt') ?? '').trim();
  const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (!CREATABLE.includes(mode)) return json({ error: `Unknown mode "${mode}"` }, 400);
  if (!name) return json({ error: 'Give it a name' }, 400);
  const videos = files.filter((f) => f.type.startsWith('video/'));
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (mode === 'thirdwheel' && (videos.length !== 1 || images.length)) return json({ error: 'Third Wheel needs exactly one video' }, 400);
  if (mode === 'rentfree' && !files.length && !prompt) return json({ error: 'Add a photo, a clip or a prompt' }, 400);
  if (mode === 'reconstruct' && images.length < 8 && videos.length !== 1) return json({ error: 'Reconstruct needs 8+ photos or a video' }, 400);

  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'scene'}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const stored = new Map<string, Blob | string>();
  const names: string[] = [];
  files.forEach((f, i) => {
    const ext = f.type.startsWith('video/') ? 'mp4' : 'jpg';
    const n = videos.length && f.type.startsWith('video/') ? `video.${ext}` : `${String(i).padStart(2, '0')}.${ext}`;
    stored.set(`input/${n}`, f);
    names.push(`input/${n}`);
  });
  if (images[0]) stored.set('thumb.jpg', images[0]);
  console.log(`[mock] POST /api/scenes mode=${mode} name="${name}" prompt=${prompt ? JSON.stringify(prompt) : '-'} files=${files.map((f) => `${f.name}(${f.type},${(f.size / 1024).toFixed(0)} KB)`).join(', ') || '-'}`);
  const scene: Scene = {
    id,
    name,
    mode,
    status: 'queued',
    stage: 'Waiting for a GPU',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    input: { files: names, ...(prompt ? { prompt } : {}) },
  };
  const m: MockScene = { scene, files: stored, failOnce: /fail/i.test(name) };
  mock.set(id, m);
  lastUpload = { mode, name, prompt, files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) };
  lastUploadFiles = files;
  setTimeout(() => simulate(m), 300);
  publish({ type: 'scene', scene });
  return json(scene, 201);
}

let lastUpload: unknown = null;
let lastUploadFiles: File[] = [];

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === '/api/health') return json(health());
  if (path === '/api/_last-upload') return json(lastUpload);
  if (path === '/api/_last-upload-file') {
    const f = lastUploadFiles[Number(url.searchParams.get('i') ?? 0)];
    return f ? new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }) : json({ error: 'none' }, 404);
  }
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path === '/api/scenes' && req.method === 'GET') return json(await allScenes());
  if (path === '/api/scenes' && req.method === 'POST') return createScene(req);
  const m = /^\/api\/scenes\/([^/]+)(\/retry)?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2] && req.method === 'POST') {
      const ms = mock.get(id);
      if (!ms) return json({ error: 'Only mock scenes can be retried here' }, 404);
      simulate(ms);
      return json(ms.scene);
    }
    if (req.method === 'DELETE') {
      const ms = mock.get(id);
      if (ms) {
        clearInterval(ms.timer);
        mock.delete(id);
      } else hidden.add(id);
      publish({ type: 'scene_deleted', id });
      return new Response(null, { status: 204 });
    }
    const s = await findScene(id);
    return s ? json(s) : json({ error: 'No such scene' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------------------------
// Video layer page

const CLIENT_SRC = /* ts */ `
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { createVideoLayer, type VideoLayerHandle } from '../../web/src/viewer/thirdwheel.ts';
import type { Scene } from '../../shared/types.ts';

const params = new URLSearchParams(location.search);
const sceneId = params.get('scene') ?? 'test-thirdwheel';
const hud = document.getElementById('hud')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const status = (s: string) => (hud.textContent = s);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
{
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#1b2330'); grad.addColorStop(0.55, '#0d1016'); grad.addColorStop(1, '#050506');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 200);
const spark = new SparkRenderer({ renderer });
scene.add(spark);

let layer: VideoLayerHandle | null = null;
let meta: Scene | null = null;
const target = new THREE.Vector3(0, 0, -2);
let yaw = 0, pitch = 0, dist = 2.5, eye = new THREE.Vector3();
let floorY = 0;

function subjectWorld(): THREE.Vector3 {
  if (!layer) return target.clone();
  const s = layer.object.userData.thirdWheel.subject as THREE.Vector3;
  return layer.object.localToWorld(s.clone());
}

function placeOrbit() {
  const t = subjectWorld();
  camera.position.set(t.x + Math.sin(yaw) * Math.cos(pitch) * dist, t.y + Math.sin(pitch) * dist, t.z + Math.cos(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(t);
}

function setView(name: string) {
  if (!layer || !meta?.video) return;
  const v = meta.video;
  camera.fov = 65;
  if (name === 'camera') {
    // Exactly the video camera: same pose and vertical field of view.
    camera.position.copy(layer.object.position);
    camera.quaternion.copy(layer.object.quaternion);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(v.height / 2 / v.intrinsics.fy));
    camera.updateProjectionMatrix();
    mode = 'fixed';
    return;
  }
  camera.updateProjectionMatrix();
  const t = subjectWorld();
  const cam = layer.object.position.clone();
  const flat = new THREE.Vector3(cam.x - t.x, 0, cam.z - t.z);
  const baseYaw = Math.atan2(flat.x, flat.z);
  const eyeY = floorY + 1.6;
  // Angle around the subject (degrees from the video camera direction) and radius. Radii keep the
  // test camera on open floor in the painted bedroom.
  const views: Record<string, [number, number]> = {
    front: [0, flat.length()],
    side45: [45, 1.4],
    'side-45': [-45, 1.5],
    'side-80': [-80, 1.5],
    behind: [140, 1.0],
    top: [0, 1.6],
  };
  const [deg, r] = views[name] ?? views.front;
  yaw = baseYaw + THREE.MathUtils.degToRad(deg);
  dist = r;
  pitch = Math.atan2(eyeY - t.y, r);
  if (name === 'top') pitch = THREE.MathUtils.degToRad(60);
  dist = r / Math.cos(pitch);
  mode = 'orbit';
  placeOrbit();
}

let mode: 'orbit' | 'fixed' = 'orbit';
let dragging = false, lx = 0, ly = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; if (mode === 'fixed') { mode = 'orbit'; } });
addEventListener('pointerup', () => (dragging = false));
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lx) * 0.005; pitch = Math.max(-0.4, Math.min(1.2, pitch + (e.clientY - ly) * 0.004));
  lx = e.clientX; ly = e.clientY; placeOrbit();
});
renderer.domElement.addEventListener('wheel', (e) => { dist = Math.max(0.3, Math.min(8, dist * Math.exp(e.deltaY * 0.001))); placeOrbit(); e.preventDefault(); }, { passive: false });
addEventListener('keydown', (e) => {
  const views: Record<string, string> = { '1': 'front', '2': 'side45', '3': 'side-45', '4': 'side-80', '5': 'behind', '6': 'camera', '7': 'top' };
  if (views[e.key]) setView(views[e.key]);
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

async function togglePlay() {
  if (!layer) return;
  if (layer.playing) layer.pause();
  else await layer.play().catch((err) => status('play() blocked: ' + err.message));
  playBtn.hidden = layer.playing;
}
playBtn.onclick = () => togglePlay();

let frames = 0, fps = 0, fpsT = performance.now(), last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  layer?.update(dt, camera);
  renderer.render(scene, camera);
  frames++;
  if (now - fpsT > 500) {
    fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now;
    if (layer && meta) status(meta.name + '  ' + layer.currentTime.toFixed(2) + ' / ' + layer.duration.toFixed(2) + ' s  ' + fps.toFixed(0) + ' fps  ' + (layer.playing ? 'playing' : 'paused') + '   drag to orbit, 1-7 views, space play');
  }
});

const ready = (async () => {
  status('loading ' + sceneId);
  const res = await fetch('/api/scenes/' + encodeURIComponent(sceneId));
  if (!res.ok) throw new Error('scene ' + sceneId + ': ' + res.status);
  meta = (await res.json()) as Scene;
  const base = '/data/scenes/' + encodeURIComponent(meta.id) + '/';
  if (meta.world) {
    const w = meta.world;
    const mesh = new SplatMesh({ url: base + w.file });
    mesh.position.fromArray(w.transform.position);
    mesh.quaternion.fromArray(w.transform.quaternion);
    mesh.scale.setScalar(w.transform.scale);
    scene.add(mesh);
    await mesh.initialized;
    floorY = w.floorY ?? -1.1;
  }
  if (meta.video) {
    layer = createVideoLayer(meta.video, base, renderer);
    scene.add(layer.object);
    await layer.ready;
    const t = Number(params.get('t') ?? 0);
    if (t) layer.seek(t);
    if (params.get('autoplay') === '1') await layer.play().catch(() => {});
    playBtn.hidden = layer.playing;
  } else playBtn.hidden = true;
  setView(params.get('view') ?? 'front');
  status(meta.name);
})();
ready.catch((err) => status('error: ' + err.message));

(window as any).__tw = {
  THREE, renderer, scene, camera, spark,
  get layer() { return layer; },
  get meta() { return meta; },
  get fps() { return fps; },
  ready, setView, subjectWorld,
  async seekAndPlay(t: number) {
    if (!layer) return;
    layer.seek(t);
    await new Promise((r) => layer!.video.addEventListener('seeked', r, { once: true }));
    await layer.play();
  },
  async pauseAt(t: number) {
    if (!layer) return;
    layer.pause();
    layer.seek(t);
    await new Promise((r) => layer!.video.addEventListener('seeked', r, { once: true }));
  },
};
`;

const VIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Third Wheel layer harness</title>
<style>
  html, body { margin: 0; height: 100%; background: #050506; overflow: hidden; font: 13px/1.4 ui-monospace, Menlo, monospace; color: #e8e6e1; }
  canvas { display: block; touch-action: none; }
  #hud { position: fixed; left: 12px; top: 10px; padding: 6px 10px; background: rgba(0,0,0,.45); border-radius: 6px; pointer-events: none; }
  #play { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 12px 22px; font: 600 15px system-ui; border: 0; border-radius: 999px; background: #d7ff3f; color: #0b0b0c; cursor: pointer; }
  body.shoot #hud, body.shoot #play { display: none; }
</style></head>
<body><div id="hud">loading</div><button id="play" hidden>Play with sound</button>
<script>if (new URLSearchParams(location.search).get('shoot') === '1') document.body.classList.add('shoot');</script>
<script type="module" src="/harness/tw.js"></script></body></html>`;

const CLIENT_ENTRY = join(import.meta.dir, '__tw-harness-client.ts');

async function buildClient(): Promise<Response> {
  const result = await Bun.build({
    entrypoints: ['tw-harness-client'],
    target: 'browser',
    format: 'esm',
    sourcemap: 'inline',
    plugins: [
      {
        name: 'tw-harness-client',
        setup(b) {
          b.onResolve({ filter: /^tw-harness-client$/ }, () => ({ path: CLIENT_ENTRY, namespace: 'file' }));
          b.onLoad({ filter: /__tw-harness-client\.ts$/ }, () => ({ contents: CLIENT_SRC, loader: 'ts' }));
        },
      },
    ],
  });
  if (!result.success) {
    const msg = result.logs.map((l) => String(l)).join('\n');
    console.error(msg);
    return new Response(`console.error(${JSON.stringify(msg)})`, { headers: { 'Content-Type': 'text/javascript' } });
  }
  return new Response(await result.outputs[0].text(), { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------------------------
// Server

server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  development: { hmr: false },
  routes: {
    '/': indexPage,
    '/capture': capturePage,
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (srv.upgrade(req, { data: undefined })) return undefined as unknown as Response;
      return new Response('expected websocket', { status: 400 });
    }
    if (url.pathname === '/view' || url.pathname === '/tw') return new Response(VIEW_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/harness/tw.js') return buildClient();
    if (url.pathname.startsWith('/api/') || url.pathname === '/favicon.ico') return api(req, url);
    const m = /^\/data\/scenes\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m) return serveSceneFile(req, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws: ServerWebSocket<undefined>) {
      ws.subscribe('events');
      ws.send(JSON.stringify({ type: 'health', health: health() } satisfies ServerEvent));
    },
    message() {},
  },
});

if (DEMO) seedDemo();
setInterval(() => publish({ type: 'health', health: health() }), 10_000);
console.log(`harness on http://localhost:${PORT}  (lan: ${lanAddresses().map((a) => `http://${a}:${PORT}`).join(', ') || 'none'})`);

if (SHOOT) {
  await runShots(`http://localhost:${PORT}`);
  server.stop(true);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Screenshots with headless Chrome (playwright-core)

/** 4032 x 3024 test JPEG with a minimal EXIF block: Orientation 6, FocalLengthIn35mmFilm 26. */
async function makeExifJpeg(file: string) {
  const plain = file + '.plain.jpg';
  const r = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=4032x3024', '-frames:v', '1', '-q:v', '4', plain]);
  if (r.exitCode !== 0) throw new Error('ffmpeg failed: ' + r.stderr.toString());
  const jpeg = new Uint8Array(await Bun.file(plain).arrayBuffer());
  const tiff = new Uint8Array(56);
  const dv = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49], 0);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 2, true);
  dv.setUint16(10, 0x0112, true);
  dv.setUint16(12, 3, true);
  dv.setUint32(14, 1, true);
  dv.setUint16(18, 6, true);
  dv.setUint16(22, 0x8769, true);
  dv.setUint16(24, 4, true);
  dv.setUint32(26, 1, true);
  dv.setUint32(30, 38, true);
  dv.setUint16(38, 1, true);
  dv.setUint16(40, 0xa405, true);
  dv.setUint16(42, 3, true);
  dv.setUint32(44, 1, true);
  dv.setUint16(48, 26, true);
  const len = 2 + 6 + tiff.length;
  const app1 = new Uint8Array([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
  const outBytes = new Uint8Array(jpeg.length + app1.length);
  outBytes.set(jpeg.subarray(0, 2), 0);
  outBytes.set(app1, 2);
  outBytes.set(jpeg.subarray(2), 2 + app1.length);
  await Bun.write(file, outBytes);
  await Bun.file(plain).delete();
}

async function runShots(base: string) {
  const { chromium } = await import('playwright-core');
  const out = join(ROOT, 'data', 'evidence', 'frontend');
  await mkdir(out, { recursive: true });
  const only = (process.env.TW_SHOTS ?? 'landing,capture,layer').split(',');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const results: string[] = [];
  const shot = async (page: import('playwright-core').Page, name: string, full = false) => {
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, fullPage: full });
    results.push(file);
  };
  const logConsole = (page: import('playwright-core').Page, tag: string) => {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${tag} ${m.type()}] ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`);
    });
    page.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) console.log(`[${tag} http ${r.status()}] ${r.url()}`);
    });
  };

  try {
    if (only.includes('landing')) {
      const desk = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      logConsole(desk, 'landing');
      await desk.goto(base + '/', { waitUntil: 'networkidle' });
      await desk.waitForSelector('.scene-card', { timeout: 15000 });
      await desk.waitForTimeout(1800);
      await shot(desk, 'landing-desktop');
      await shot(desk, 'landing-desktop-full', true);
      const cards = await desk.$$eval('.scene-card', (els) => els.map((e) => e.getAttribute('data-status')));
      console.log('gallery cards:', cards.join(', '));
      const p1 = await desk.$eval('[data-id="demo-running"] .progress-fill', (e) => (e as HTMLElement).style.transform).catch(() => 'none');
      await desk.waitForTimeout(1600);
      const p2 = await desk.$eval('[data-id="demo-running"] .progress-fill', (e) => (e as HTMLElement).style.transform).catch(() => 'none');
      console.log(`live progress via /ws: ${p1} -> ${p2}`);
      // Decode the same-Wi-Fi QR code with the browser's own barcode reader where available.
      const qr = await desk.evaluate(async () => {
        const svg = document.querySelector('#qr svg');
        const href = (document.querySelector('#lan-url') as HTMLAnchorElement | null)?.href ?? '';
        if (!svg) return { href, decoded: null, note: 'no qr' };
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(new XMLSerializer().serializeToString(svg));
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 480;
        const g = c.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 480, 480);
        g.drawImage(img, 0, 0, 480, 480);
        const BD = (window as any).BarcodeDetector;
        if (!BD) return { href, decoded: null, note: 'BarcodeDetector unavailable' };
        const found = await new BD({ formats: ['qr_code'] }).detect(c);
        return { href, decoded: found[0]?.rawValue ?? null, note: `${found.length} codes` };
      });
      console.log('QR check:', JSON.stringify(qr));
      await desk.close();

      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      logConsole(phone, 'landing-phone');
      await phone.goto(base + '/', { waitUntil: 'networkidle' });
      await phone.waitForSelector('.scene-card', { timeout: 15000 });
      await phone.waitForTimeout(1500);
      await shot(phone, 'landing-phone');
      await shot(phone, 'landing-phone-full', true);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      console.log(`phone horizontal overflow: ${overflow}px`);
      await phone.close();
    }

    if (only.includes('capture')) {
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      logConsole(phone, 'capture');
      await phone.goto(base + '/capture', { waitUntil: 'networkidle' });
      await phone.waitForTimeout(800);
      await shot(phone, 'capture-phone');
      await shot(phone, 'capture-phone-full', true);
      // Third Wheel with a photo must be rejected, then accept the clip.
      await phone.click('[data-mode="thirdwheel"]');
      await phone.setInputFiles('#pick-files', join(SCENES, 'test-thirdwheel', 'thumb.jpg'));
      await phone.waitForTimeout(400);
      const err = await phone.$eval('#capture-error', (e) => e.textContent?.trim() ?? '');
      console.log(`thirdwheel + photo validation: "${err}"`);
      await phone.click('.pv-x');
      await phone.setInputFiles('#pick-files', join(SCENES, 'test-thirdwheel', 'tw.mp4'));
      await phone.waitForTimeout(1000);
      const err2 = await phone.$eval('#capture-error', (e) => e.textContent?.trim() ?? '');
      console.log(`thirdwheel + one video validation: "${err2}"`);
      await shot(phone, 'capture-phone-thirdwheel', true);
      // Rent Free with a photo: downscale, upload with progress, land on the gallery.
      await phone.goto(base + '/capture?mode=rentfree', { waitUntil: 'networkidle' });
      await phone.setInputFiles('#pick-files', join(SCENES, 'test-thirdwheel', 'plate.jpg'));
      await phone.fill('#scene-name', 'Harness kitchen');
      await phone.waitForTimeout(800);
      const meta = await phone.$eval('.pv-meta', (e) => e.textContent ?? '');
      console.log(`processed photo preview: "${meta}"`);
      await shot(phone, 'capture-phone-ready', true);
      await Promise.all([phone.waitForURL(/\?new=/, { timeout: 20000 }), phone.click('#submit')]);
      await phone.waitForSelector('.scene-card.is-new', { timeout: 10000 });
      await phone.waitForTimeout(1500);
      await shot(phone, 'capture-phone-after-upload');
      const up = await (await fetch(base + '/api/_last-upload')).json();
      console.log('mock received upload:', JSON.stringify(up));

      // A 12 MP phone JPEG stored sideways (EXIF orientation 6, 26 mm equivalent) must arrive
      // upright, at most 2048 px, with the focal length kept and the orientation reset.
      const big = join(out, 'test-12mp-exif.jpg');
      await makeExifJpeg(big);
      await phone.goto(base + '/capture?mode=rentfree', { waitUntil: 'networkidle' });
      await phone.setInputFiles('#pick-files', big);
      await phone.fill('#scene-name', 'Sideways photo');
      await phone.waitForFunction(() => !document.querySelector('.pv-meta')?.textContent?.includes('shrinking'), null, { timeout: 15000 });
      console.log('12 MP preview:', await phone.$eval('.pv-meta', (e) => e.textContent));
      await Promise.all([phone.waitForURL(/\?new=/, { timeout: 30000 }), phone.click('#submit')]);
      const sent = new Uint8Array(await (await fetch(base + '/api/_last-upload-file?i=0')).arrayBuffer());
      const sentPath = join(out, 'test-12mp-exif-uploaded.jpg');
      await Bun.write(sentPath, sent);
      const probe = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sentPath]);
      const { readJpegExif } = await import('../../server/media.ts');
      console.log(`12 MP upload: ${(sent.length / 1024).toFixed(0)} KB, ${probe.stdout.toString().trim()} px, exif ${JSON.stringify(readJpegExif(sent))}`);
      await phone.close();

      const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      logConsole(desk, 'capture-desktop');
      await desk.goto(base + '/capture?mode=thirdwheel', { waitUntil: 'networkidle' });
      await desk.waitForTimeout(800);
      await shot(desk, 'capture-desktop');
      await desk.close();
    }

    if (only.includes('layer')) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      logConsole(page, 'layer');
      const dbg = process.env.TW_DEBUG ? `&twdebug=${process.env.TW_DEBUG}` : '';
      const sfx = dbg ? '-debug' : '';
      await page.goto(base + '/view?scene=test-thirdwheel&shoot=1' + dbg, { waitUntil: 'load' });
      await page.waitForFunction(() => (window as any).__tw?.layer && (window as any).__tw.meta, null, { timeout: 60000 });
      await page.evaluate(() => (window as any).__tw.ready);
      await page.evaluate(() => (window as any).__tw.seekAndPlay(1.6));
      await page.waitForTimeout(2500);
      const info = await page.evaluate(() => {
        const tw = (window as any).__tw;
        const s = tw.subjectWorld();
        return { t: tw.layer.currentTime, playing: tw.layer.playing, fps: tw.fps, subject: [s.x, s.y, s.z].map((v: number) => +v.toFixed(3)) };
      });
      console.log('layer state:', JSON.stringify(info));
      for (const view of ['front', 'side45', 'side-45', 'camera', 'side-80', 'behind']) {
        await page.evaluate((v) => (window as any).__tw.setView(v), view);
        await page.waitForTimeout(1300);
        await shot(page, `layer-${view}${sfx}`);
      }
      // Paused frame from the side to check a still pose without motion blur of the sort.
      await page.evaluate(() => (window as any).__tw.pauseAt(3.2));
      await page.evaluate(() => (window as any).__tw.setView('side45'));
      await page.waitForTimeout(1500);
      await shot(page, `layer-side45-paused${sfx}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('screenshots:\n' + results.join('\n'));
}
