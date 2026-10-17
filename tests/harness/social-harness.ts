// Social layer harness (default port 8796; use 8793-8799). Independent of server/index.ts.
//   bun tests/harness/social-harness.ts            PORT=8797 to change the port
//
// Serves the real viewer with the social layer wired in (tests/harness/social-harness.html), the
// scenes in data/scenes, and fake versions of every social route from team/contracts.md:
//   POST/GET /api/presence/:sceneId   four fake people walking about (two Roblox players, a browser
//                                      viewer and a second headset with hands), plus whoever posts
//   GET/POST /api/notes/:sceneId      three seeded notes; posts are stored and pushed on /ws
//   WS /ws                             {type:'note'}, {type:'roblox', event}, {type:'cue'} pushes
//   GET /data/scenes/<id>/reality.json, world-seen.spz, world-imagined.spz
//                                      made on first request by pipeline/reality_split.py into a temp dir
// Test controls (POST, no body needed):
//   /harness/tag?target=rbx-12345&by=quest-1      /harness/round?state=start&duration=25
//   /harness/round?state=end                      /harness/note?text=...&x=&y=&z=
//   /harness/cue?action=reality&on=1               /harness/people?on=0  (everyone leaves)
// SOCIAL_BARE=1 answers like a server without any social routes (404s, no /ws), to check the
// viewer stays quiet and keeps running when a teammate service is missing.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ServerWebSocket } from 'bun';
import page from './social-harness.html';

const ROOT = resolve(import.meta.dir, '../..');
const SCENES = join(ROOT, 'data', 'scenes');
const PORT = Number(process.env.PORT ?? 8796);
const REALITY_DIR = process.env.SOCIAL_REALITY_DIR ?? join(tmpdir(), 'dv-social-harness-reality');
const PY = existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3';
const T0 = Date.now() / 1000;
const BARE = process.env.SOCIAL_BARE === '1';

const MIME: Record<string, string> = { '.json': 'application/json', '.spz': 'application/octet-stream', '.ply': 'application/octet-stream', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.glb': 'model/gltf-binary' };
const mime = (p: string) => MIME[p.slice(p.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
const now = () => Date.now() / 1000;

function readScene(id: string): Record<string, unknown> | null {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)) return null;
  const p = join(SCENES, id, 'scene.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ---- fake people ------------------------------------------------------------------------------

interface Posted { id: string; name: string; kind: string; x: number; y: number; z: number; yaw: number; head?: number[]; hands?: number[][] | null; at: number }
const posted = new Map<string, Map<string, Posted>>();
let fakesOn = true;

/** Smooth paths in the room frame (floor at 0), in front of the usual spawn (looking down -Z). */
function fakes(t: number) {
  if (!fakesOn) return [];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const a = t * 0.45;
  const sx = Math.cos(a) * 1.1, sz = -2.4 + Math.sin(a) * 0.8;
  const syaw = Math.atan2(1.1 * Math.sin(a), -0.8 * Math.cos(a));
  const b = t * 0.6;
  const bx = 1.4 * Math.sin(b), bz = -1.9 + 0.6 * Math.sin(2 * b);
  const byaw = Math.atan2(-(1.4 * Math.cos(b)), -(1.2 * Math.cos(2 * b)));
  const q = t * 0.8;
  const qx = -1.1 + 0.15 * Math.sin(q), qz = -2.3;
  const head = [qx, 1.62 + 0.03 * Math.sin(q * 2), qz];
  const hands = [[qx - 0.25, 1.15 + 0.25 * Math.max(0, Math.sin(q * 3)), qz - 0.25], [qx + 0.25, 1.2 + 0.2 * Math.sin(q * 2.5), qz - 0.3]];
  return [
    { id: 'rbx-12345', name: 'shivin', kind: 'roblox', x: r(sx), y: 0, z: r(sz), yaw: r(syaw), age: 0.05 },
    { id: 'rbx-67890', name: 'brianna', kind: 'roblox', x: r(bx), y: 0, z: r(bz), yaw: r(byaw), age: 0.08 },
    { id: 'web-7f3a19c2', name: 'Maya', kind: 'web', x: 1.6, y: 0, z: -3.0, yaw: r(0.6 + 0.5 * Math.sin(t * 0.3)), age: 0.1 },
    { id: 'quest-2', name: 'Seb', kind: 'vr', x: r(qx), y: 0, z: qz, yaw: r(-0.4 + 0.3 * Math.sin(q)), head: head.map(r), hands: hands.map((h) => h.map(r)), age: 0.04 },
  ];
}

function everyone(scene: string) {
  const t = now();
  const list: Array<Record<string, unknown>> = fakes(t - T0);
  for (const p of posted.get(scene)?.values() ?? []) {
    const age = t - p.at;
    if (age > 3) continue;
    list.push({ ...p, at: undefined, age: Math.round(age * 1000) / 1000 });
  }
  return { t: Math.round(t * 1000) / 1000, people: list };
}

// ---- notes ----------------------------------------------------------------------------------

interface Note { id: string; sceneId: string; author: string; text: string; x: number; y: number; z: number; createdAt: string }
const notes = new Map<string, Note[]>();
let noteSeq = 0;
function notesFor(scene: string): Note[] {
  let list = notes.get(scene);
  if (!list) {
    const mk = (author: string, text: string, x: number, y: number, z: number, ago: number): Note => ({ id: `n_seed${++noteSeq}`, sceneId: scene, author, text, x, y, z, createdAt: new Date(Date.now() - ago * 1000).toISOString() });
    list = [
      mk('Brianna', "Seb's seat. He was too scared to show up.", 0.7, 1.4, -2.2, 600),
      mk('Shivin', 'GG. Rematch Saturday?', -0.6, 1.5, -2.8, 300),
      mk('Maya', 'I was here', 0.75, 1.45, -2.25, 120),
    ];
    notes.set(scene, list);
  }
  return list;
}

// ---- reality parts --------------------------------------------------------------------------

const splitting = new Map<string, Promise<boolean>>();
function ensureReality(scene: string): Promise<boolean> {
  const out = join(REALITY_DIR, scene);
  if (existsSync(join(out, 'reality.json'))) return Promise.resolve(true);
  if (process.env.SOCIAL_NO_REALITY === '1') return Promise.resolve(false);
  let p = splitting.get(scene);
  if (!p) {
    mkdirSync(out, { recursive: true });
    p = (async () => {
      const proc = Bun.spawn([PY, join(ROOT, 'pipeline/reality_split.py'), join(SCENES, scene), '--out', out], { stdout: 'inherit', stderr: 'inherit' });
      return (await proc.exited) === 0;
    })();
    splitting.set(scene, p);
  }
  return p;
}

// ---- files with Range ---------------------------------------------------------------------------

function fileResponse(path: string, req: Request): Response {
  if (!existsSync(path) || !statSync(path).isFile()) return json({ error: 'Not found' }, 404);
  const size = statSync(path).size;
  const headers: Record<string, string> = { 'content-type': mime(path), 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...CORS };
  const range = req.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, ...CORS } });
    return new Response(Bun.file(path).slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(Bun.file(path), { headers });
}

// ---- server --------------------------------------------------------------------------------------

const sockets = new Set<ServerWebSocket<unknown>>();
const broadcast = (m: unknown) => {
  const s = JSON.stringify(m);
  for (const ws of sockets) ws.send(s);
};
let lastScene = 'sample-painted-bedroom';

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  development: { hmr: false, console: true },
  routes: { '/view': page },
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/ws') return !BARE && srv.upgrade(req) ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 });
    if (BARE && /^\/(api\/(presence|notes)|data\/scenes\/[^/]+\/(reality\.json|world-(seen|imagined)\.spz))/.test(path)) return json({ error: 'Not found' }, 404);
    if (path === '/api/health') return json({ ok: true, harness: 'social' });
    let m = /^\/api\/scenes\/([^/]+)$/.exec(path);
    if (m) {
      const s = readScene(m[1]);
      return s ? json(s) : json({ error: 'No such scene' }, 404);
    }
    m = /^\/api\/presence\/([^/]+)$/.exec(path);
    if (m) {
      const scene = m[1];
      if (!readScene(scene)) return json({ error: 'No such scene' }, 404);
      lastScene = scene;
      if (req.method === 'POST') {
        const b = (await req.json().catch(() => null)) as Posted | null;
        if (!b || typeof b.id !== 'string' || !Number.isFinite(b.x) || !Number.isFinite(b.z)) return json({ error: 'x must be a finite number' }, 400);
        if (b.kind !== 'vr' && b.kind !== 'web') return json({ error: 'kind must be vr or web' }, 400);
        let map = posted.get(scene);
        if (!map) posted.set(scene, (map = new Map()));
        for (const other of posted.values()) other.delete(b.id);
        map.set(b.id, { ...b, at: now() });
        const all = everyone(scene);
        return json({ t: all.t, people: all.people.filter((p) => p.id !== b.id) });
      }
      return json(everyone(scene));
    }
    m = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (m) {
      const scene = m[1];
      if (process.env.SOCIAL_NOTES_DOWN === '1') return json({ error: 'notes offline' }, 502);
      if (req.method === 'POST') {
        const b = (await req.json().catch(() => null)) as Partial<Note> | null;
        if (!b || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 120) return json({ error: 'text must be 1 to 120 characters' }, 400);
        const note: Note = { id: `n_${(++noteSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`, sceneId: scene, author: String(b.author ?? 'Someone').slice(0, 40), text: b.text.trim(), x: Number(b.x), y: Number(b.y ?? 1.4), z: Number(b.z), createdAt: new Date().toISOString() };
        notesFor(scene).push(note);
        broadcast({ type: 'note', sceneId: scene, note });
        return json({ ok: true, note }, 201);
      }
      return json({ notes: notesFor(scene) });
    }
    m = /^\/data\/scenes\/([^/]+)\/(reality\.json|world-seen\.spz|world-imagined\.spz)$/.exec(path);
    if (m) {
      if (!readScene(m[1])) return json({ error: 'Not found' }, 404);
      if (!(await ensureReality(m[1]))) return json({ error: 'Not found' }, 404);
      return fileResponse(join(REALITY_DIR, m[1], m[2]), req);
    }
    m = /^\/data\/scenes\/([^/]+)\/(.+)$/.exec(path);
    if (m && readScene(m[1]) && !m[2].includes('..')) return fileResponse(join(SCENES, m[1], m[2]), req);
    // controls
    if (path.startsWith('/harness/')) {
      const q = url.searchParams;
      const scene = q.get('scene') ?? lastScene;
      const t = now();
      if (path === '/harness/tag') broadcast({ type: 'roblox', sceneId: scene, event: { type: 'tag', by: q.get('by') ?? 'quest-1', target: q.get('target') ?? 'rbx-12345', t } });
      else if (path === '/harness/round') {
        const state = q.get('state') === 'end' ? 'end' : 'start';
        const scores = state === 'start' ? { 'quest-1': 0, 'rbx-12345': 0, 'rbx-67890': 0 } : { 'quest-1': 4, 'rbx-12345': 1, 'rbx-67890': 2 };
        broadcast({ type: 'roblox', sceneId: scene, event: { type: 'round', state, scores, duration: Number(q.get('duration') ?? 90), t } });
      } else if (path === '/harness/note') {
        const note: Note = { id: `n_h${++noteSeq}`, sceneId: scene, author: q.get('author') ?? 'Brianna', text: q.get('text') ?? "Seb's seat. He was too scared to show up.", x: Number(q.get('x') ?? -0.3), y: Number(q.get('y') ?? 1.4), z: Number(q.get('z') ?? -1.8), createdAt: new Date().toISOString() };
        notesFor(scene).push(note);
        broadcast({ type: 'note', sceneId: scene, note });
      } else if (path === '/harness/cue') broadcast({ type: 'cue', action: q.get('action') ?? 'reality', on: q.get('on') !== '0', at: t });
      else if (path === '/harness/people') fakesOn = q.get('on') !== '0';
      else return json({ error: 'unknown control' }, 404);
      return json({ ok: true });
    }
    if (path === '/') return Response.redirect(`/view?scene=${lastScene}`, 302);
    return json({ error: 'Not found' }, 404);
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'health', health: { ok: true } }));
    },
    message() {},
    close(ws) {
      sockets.delete(ws);
    },
  },
});

console.log(`social harness on http://127.0.0.1:${server.port}/view?scene=sample-painted-bedroom (reality parts in ${REALITY_DIR})`);
