// A stand-in for Seb's DeepSpace worker, so presence push and notes can be tested without it.
//
//   bun tests/harness/mock-deepspace.ts            port 8794 (PORT overrides), key from DS_KEY (default dev-ds-key)
//   then run the server with DS_URL=http://127.0.0.1:8794 DS_KEY=dev-ds-key
//   open http://127.0.0.1:8794/ for the live top-down map (add ?dv=http://localhost:8788 to draw the floor plan)
//
// Contract routes (team/contracts.md 7.1, 7.2; team/seb.md 5.4), all behind X-DejaView-Key:
//   POST /api/ingest              {sceneId, t, people}            -> 200 {ok, people} | 400 | 401 | 413 (> 32 KB)
//   GET  /api/notes?sceneId=<id>                                  -> 200 {notes: [...]} oldest first
//   POST /api/notes               {sceneId, author, text, x, y, z} -> 201 {ok, note}
// Page routes (no key; only the page uses them):
//   GET /  GET /ui/state?sceneId=  POST /ui/notes  DELETE /ui/notes?sceneId=  POST /ui/mode {mode}
// Failure drills (POST /ui/mode or setMode()): ok | down (503) | html (502 HTML page, like a dead tunnel) |
//   slow (3 s, past the server's 2 s timeout) | unauthorized (401).

import type { Server } from 'bun';

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const KINDS = new Set(['vr', 'roblox', 'web']);
const PERSON_FIELDS = new Set(['id', 'name', 'kind', 'x', 'y', 'z', 'yaw']);

export type MockMode = 'ok' | 'down' | 'html' | 'slow' | 'unauthorized';

export interface MockPerson {
  id: string;
  name: string;
  kind: 'vr' | 'roblox' | 'web';
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface MockNote {
  id: string;
  sceneId: string;
  author: string;
  text: string;
  x: number;
  y: number;
  z: number;
  createdAt: string;
}

export interface IngestRecord {
  sceneId: string;
  t: number;
  people: MockPerson[];
  /** Local receive time, ms. */
  at: number;
  /** The X-DejaView-Key header as received. */
  key: string | null;
  /** Contract problems seen in this push (extra fields, ...). Empty when the push is clean. */
  problems: string[];
}

export interface MockDeepSpace {
  url: string;
  port: number;
  /** Every accepted ingest, oldest first (capped at 5000). */
  ingests: IngestRecord[];
  /** Every request to a contract route, including refused ones. */
  hits: { method: string; path: string; status: number; at: number }[];
  notes(sceneId: string): MockNote[];
  addNote(n: { sceneId: string; author?: string; text: string; x: number; y?: number; z: number }): MockNote;
  clearNotes(sceneId?: string): void;
  setMode(mode: MockMode): void;
  mode(): MockMode;
  live(sceneId: string): { t: number; people: MockPerson[]; at: number } | null;
  reset(): void;
  stop(): void;
}

export interface MockDeepSpaceOptions {
  port?: number;
  hostname?: string;
  key?: string;
  quiet?: boolean;
}

function rid(n = 6): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates an ingest body the way the real worker does. Returns an error sentence or the parsed body. */
export function validateIngest(b: any): { error: string } | { sceneId: string; t: number; people: MockPerson[]; problems: string[] } {
  if (!b || typeof b !== 'object') return { error: 'body must be a JSON object' };
  if (typeof b.sceneId !== 'string' || !SCENE_ID.test(b.sceneId)) return { error: 'sceneId is missing or invalid' };
  if (!finite(b.t)) return { error: 't must be a finite number' };
  if (!Array.isArray(b.people)) return { error: 'people must be an array' };
  if (b.people.length > 32) return { error: 'at most 32 people' };
  const problems: string[] = [];
  const people: MockPerson[] = [];
  for (const p of b.people) {
    if (!p || typeof p !== 'object') return { error: 'each person must be an object' };
    if (typeof p.id !== 'string' || !p.id) return { error: 'each person needs an id' };
    if (typeof p.name !== 'string' || p.name.length > 40) return { error: `name of ${p.id} must be a string of at most 40 characters` };
    if (!KINDS.has(p.kind)) return { error: `unknown kind "${String(p.kind)}"` };
    for (const k of ['x', 'y', 'z', 'yaw']) if (!finite(p[k])) return { error: `${k} must be a finite number` };
    const extra = Object.keys(p).filter((k) => !PERSON_FIELDS.has(k));
    if (extra.length) problems.push(`${p.id} has extra fields: ${extra.join(', ')}`);
    people.push({ id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
  }
  return { sceneId: b.sceneId, t: b.t, people, problems };
}

function validateNote(b: any): { error: string } | Omit<MockNote, 'id' | 'createdAt'> {
  if (!b || typeof b !== 'object') return { error: 'body must be a JSON object' };
  if (typeof b.sceneId !== 'string' || !SCENE_ID.test(b.sceneId)) return { error: 'sceneId is missing or invalid' };
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > 120) return { error: 'text must be 1 to 120 characters' };
  const author = typeof b.author === 'string' ? b.author.trim() : '';
  if (!author || author.length > 40) return { error: 'author must be 1 to 40 characters' };
  if (!finite(b.x) || !finite(b.z) || (b.y !== undefined && !finite(b.y))) return { error: 'x, y and z must be finite numbers' };
  return { sceneId: b.sceneId, author, text, x: b.x, y: finite(b.y) ? b.y : 1.4, z: b.z };
}

const TUNNEL_ERROR_PAGE =
  '<!doctype html><html><head><title>502 Bad gateway</title></head><body><h1>Bad gateway</h1><p>The origin is unreachable.</p></body></html>';

export function startMockDeepSpace(opts: MockDeepSpaceOptions = {}): MockDeepSpace {
  const key = opts.key ?? 'dev-ds-key';
  const log = opts.quiet ? () => {} : (m: string) => console.log(`[mock-deepspace] ${m}`);
  const ingests: IngestRecord[] = [];
  const hits: MockDeepSpace['hits'] = [];
  const live = new Map<string, { t: number; people: MockPerson[]; at: number }>();
  const notes = new Map<string, MockNote[]>();
  const recent = new Map<string, number[]>(); // sceneId -> receive times (ms), for the rate
  let mode: MockMode = 'ok';

  const notesOf = (id: string) => notes.get(id) ?? [];

  function addNote(n: { sceneId: string; author?: string; text: string; x: number; y?: number; z: number }): MockNote {
    const note: MockNote = {
      id: `n_${rid(6)}`,
      sceneId: n.sceneId,
      author: (n.author ?? 'Guest').slice(0, 40),
      text: n.text.slice(0, 120),
      x: n.x,
      y: n.y ?? 1.4,
      z: n.z,
      createdAt: new Date().toISOString(),
    };
    notes.set(n.sceneId, [...notesOf(n.sceneId), note]);
    log(`note in ${n.sceneId} by ${note.author}: ${JSON.stringify(note.text)}`);
    return note;
  }

  async function contract(req: Request, url: URL): Promise<Response> {
    if (mode === 'slow') await Bun.sleep(3000);
    if (mode === 'down') return json({ error: 'service unavailable' }, 503);
    if (mode === 'html') return new Response(TUNNEL_ERROR_PAGE, { status: 502, headers: { 'Content-Type': 'text/html' } });
    const given = req.headers.get('x-dejaview-key');
    if (mode === 'unauthorized' || !key || given !== key) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      const text = await req.text();
      if (text.length > 32 * 1024) return json({ error: 'body over 32 KB' }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }
      const v = validateIngest(body);
      if ('error' in v) return json({ error: v.error }, 400);
      const at = Date.now();
      if (!live.has(v.sceneId)) log(`presence feed started for ${v.sceneId}`);
      live.set(v.sceneId, { t: v.t, people: v.people, at });
      ingests.push({ ...v, at, key: given });
      if (ingests.length > 5000) ingests.splice(0, ingests.length - 5000);
      const r = (recent.get(v.sceneId) ?? []).filter((x) => at - x < 5000);
      r.push(at);
      recent.set(v.sceneId, r);
      if (v.problems.length) log(`contract problem in ${v.sceneId}: ${v.problems.join('; ')}`);
      if (!v.people.length) log(`${v.sceneId} is empty now`);
      return json({ ok: true, people: v.people.length });
    }
    if (url.pathname === '/api/notes' && req.method === 'GET') {
      const id = url.searchParams.get('sceneId') ?? '';
      if (!SCENE_ID.test(id)) return json({ error: 'sceneId is missing or invalid' }, 400);
      return json({ notes: notesOf(id) });
    }
    if (url.pathname === '/api/notes' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const v = validateNote(body);
      if ('error' in v) return json({ error: v.error }, 400);
      return json({ ok: true, note: addNote(v) }, 201);
    }
    return json({ error: 'not found' }, 404);
  }

  function state(sceneId: string | null) {
    const now = Date.now();
    const ids = new Set<string>([...live.keys(), ...notes.keys()]);
    const scenes = [...ids]
      .map((id) => {
        const l = live.get(id);
        const r = (recent.get(id) ?? []).filter((x) => now - x < 2000);
        return { id, people: l?.people.length ?? 0, lastAt: l?.at ?? 0, age: l ? (now - l.at) / 1000 : null, rate: r.length / 2, notes: notesOf(id).length };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
    const l = sceneId ? live.get(sceneId) : undefined;
    return {
      now: now / 1000,
      mode,
      scenes,
      sceneId,
      live: l ? { t: l.t, people: l.people, age: (now - l.at) / 1000 } : null,
      notes: sceneId ? notesOf(sceneId) : [],
      pushes: ingests.length,
    };
  }

  async function ui(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/' && req.method === 'GET') return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/ui/state' && req.method === 'GET') {
      const id = url.searchParams.get('sceneId');
      return json(state(id && SCENE_ID.test(id) ? id : null));
    }
    if (url.pathname === '/ui/notes' && req.method === 'POST') {
      const b: any = await req.json().catch(() => null);
      const v = validateNote({ ...b, author: b?.author || 'Guest' });
      if ('error' in v) return json({ error: v.error }, 400);
      return json({ ok: true, note: addNote(v) }, 201);
    }
    if (url.pathname === '/ui/notes' && req.method === 'DELETE') {
      const id = url.searchParams.get('sceneId');
      if (id) notes.delete(id);
      else notes.clear();
      return json({ ok: true });
    }
    if (url.pathname === '/ui/mode' && req.method === 'POST') {
      const b: any = await req.json().catch(() => null);
      if (!['ok', 'down', 'html', 'slow', 'unauthorized'].includes(b?.mode)) return json({ error: 'unknown mode' }, 400);
      mode = b.mode;
      log(`mode: ${mode}`);
      return json({ ok: true, mode });
    }
    return json({ error: 'not found' }, 404);
  }

  const server: Server<undefined> = Bun.serve({
    port: opts.port ?? 8794,
    hostname: opts.hostname ?? '127.0.0.1',
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/')) {
        const res = await contract(req, url);
        hits.push({ method: req.method, path: url.pathname, status: res.status, at: Date.now() });
        if (hits.length > 5000) hits.splice(0, hits.length - 5000);
        return res;
      }
      return ui(req, url);
    },
  });

  return {
    url: `http://${opts.hostname ?? '127.0.0.1'}:${server.port}`,
    port: server.port!,
    ingests,
    hits,
    notes: (id) => [...notesOf(id)],
    addNote,
    clearNotes: (id) => (id ? notes.delete(id) : notes.clear()),
    setMode: (m) => {
      mode = m;
    },
    mode: () => mode,
    live: (id) => live.get(id) ?? null,
    reset() {
      ingests.length = 0;
      hits.length = 0;
      live.clear();
      notes.clear();
      recent.clear();
      mode = 'ok';
    },
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The live map page: snapshot interpolation 300 ms in the past, trails, view cones, notes you can drop by clicking.

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Déjà View · Live map</title>
<style>
  :root { --bg:#0A0B0D; --panel:#111316; --line:#1E2126; --text:#F2F4F5; --dim:#8A9099; --faint:#4A5059; --lime:#C6FF3D; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--text);
    font: 500 14px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { display:grid; grid-template-rows:auto 1fr; overflow:hidden; }
  header { display:flex; align-items:center; gap:16px; padding:14px 20px; border-bottom:1px solid var(--line); }
  .mark { font-weight:900; letter-spacing:.04em; font-size:18px; }
  .mark i { font-style:normal; color:var(--lime); }
  .tag { font-weight:800; font-size:11px; letter-spacing:.16em; color:var(--dim); }
  .spacer { flex:1; }
  select, input, button { font:inherit; color:var(--text); background:#16191D; border:1px solid var(--line); border-radius:10px; padding:8px 12px; }
  select:focus, input:focus { outline:2px solid var(--lime); outline-offset:-1px; }
  button { cursor:pointer; font-weight:800; }
  button:hover { border-color:var(--faint); }
  .pill { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px; font-weight:800; font-size:12px; letter-spacing:.08em; background:#16191D; border:1px solid var(--line); }
  .pill .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); }
  .pill.live .dot { background:var(--lime); box-shadow:0 0 10px var(--lime); }
  .pill.live { color:var(--lime); }
  main { display:grid; grid-template-columns:1fr 330px; min-height:0; }
  #stage { position:relative; min-height:0; }
  canvas { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:crosshair; }
  #empty { position:absolute; inset:0; display:grid; place-items:center; pointer-events:none; opacity:0; transition:opacity .4s; }
  #empty.on { opacity:1; }
  #empty div { font-weight:900; font-size:22px; letter-spacing:.02em; color:var(--dim); text-align:center; }
  #empty small { display:block; margin-top:6px; font-weight:600; font-size:13px; color:var(--faint); }
  aside { border-left:1px solid var(--line); background:var(--panel); overflow:auto; padding:18px; display:flex; flex-direction:column; gap:22px; }
  h2 { margin:0 0 10px; font-size:11px; font-weight:900; letter-spacing:.18em; color:var(--dim); }
  .row { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); }
  .row:last-child { border-bottom:0; }
  .who { font-weight:800; text-transform:uppercase; letter-spacing:.04em; }
  .kind { font-size:10px; font-weight:900; letter-spacing:.14em; color:var(--dim); }
  .pos { margin-left:auto; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--dim); }
  .sw { width:10px; height:10px; border-radius:50%; flex:none; }
  .sw.vr { background:var(--lime); } .sw.roblox { background:#fff; } .sw.web { border:2px solid #9AA0A8; }
  .stat { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .stat div { background:#16191D; border:1px solid var(--line); border-radius:12px; padding:10px 12px; }
  .stat b { display:block; font-size:20px; font-weight:900; }
  .stat span { font-size:11px; font-weight:800; letter-spacing:.12em; color:var(--dim); }
  .drills { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
  .drills button { padding:6px 10px; font-size:12px; border-radius:8px; }
  .drills button.on { background:var(--lime); color:#0A0B0D; border-color:var(--lime); }
  .note { background:var(--lime); color:#0A0B0D; border-radius:10px; padding:10px 12px; margin-bottom:8px; font-weight:800; }
  .note small { display:block; margin-top:4px; font-weight:700; opacity:.7; }
  .muted { color:var(--faint); font-weight:600; }
  #composer { position:absolute; display:none; z-index:5; width:270px; background:#15181C; border:1px solid var(--faint); border-radius:14px; padding:12px; box-shadow:0 18px 50px rgba(0,0,0,.55); }
  #composer input { width:100%; }
  #composer .meta { display:flex; justify-content:space-between; margin-top:8px; font-size:11px; font-weight:800; letter-spacing:.08em; color:var(--dim); }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(20px); opacity:0; transition:all .25s; background:var(--lime); color:#0A0B0D; font-weight:900; padding:10px 16px; border-radius:12px; pointer-events:none; }
  #toast.on { opacity:1; transform:translateX(-50%) translateY(0); }
  @media (max-width: 820px) { main { grid-template-columns:1fr; grid-template-rows:60vh auto; } aside { border-left:0; border-top:1px solid var(--line); } body { overflow:auto; } }
</style>
</head>
<body>
<header>
  <div class="mark">DÉJÀ VIEW<i>.</i></div>
  <div class="tag">LIVE MAP · TEST FEED</div>
  <div class="spacer"></div>
  <select id="scene" aria-label="Room"><option value="">Waiting for a room…</option></select>
  <div id="pill" class="pill"><span class="dot"></span><span id="pilltext">WAITING</span></div>
</header>
<main>
  <div id="stage">
    <canvas id="map"></canvas>
    <div id="empty" class="on"><div>No one here right now<small>People show up the moment someone walks in.</small></div></div>
    <div id="composer">
      <input id="text" maxlength="120" placeholder="Leave a note here…" autocomplete="off">
      <div class="meta"><span>ENTER TO PIN · ESC TO CANCEL</span><span id="count">0/120</span></div>
    </div>
  </div>
  <aside>
    <section>
      <h2>IN THE ROOM</h2>
      <div id="people"><div class="muted">Nobody yet.</div></div>
    </section>
    <section>
      <h2>FEED</h2>
      <div class="stat">
        <div><b id="rate">0.0</b><span>PUSHES / S</span></div>
        <div><b id="age">–</b><span>LAST PUSH</span></div>
      </div>
      <div class="drills" id="drills">
        <button data-mode="ok">Healthy</button><button data-mode="down">Down</button><button data-mode="html">Dead link</button>
        <button data-mode="slow">Slow</button><button data-mode="unauthorized">Wrong key</button>
      </div>
    </section>
    <section>
      <h2>NOTES</h2>
      <label class="tag" for="author">YOUR NAME</label>
      <input id="author" maxlength="40" placeholder="Guest" style="width:100%;margin:6px 0 12px">
      <div id="notes"><div class="muted">Click the map to leave one.</div></div>
      <button id="clear" style="margin-top:6px">Clear notes in this room</button>
    </section>
  </aside>
</main>
<div id="toast"></div>
<script>
(() => {
  const $ = (s) => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  const dvBase = (qs.get('dv') || '').replace(/\\/+$/, '');
  let sceneId = qs.get('scene') || '';
  const canvas = $('#map'), ctx = canvas.getContext('2d');
  const LIME = '#C6FF3D';
  const people = new Map();   // id -> {name, kind, samples:[{t,x,z,yaw}], trail:[{t,x,z}], born, goneAt}
  let offset = null, lastRowT = 0, lastRowLocal = 0, lastMode = 'ok';
  let notes = [], noteBorn = new Map(), hoverNote = null;
  let extent = { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, target = { ...extent };
  let floor = null, bounds = null, composerAt = null;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const nowS = () => performance.now() / 1000;
  try { $('#author').value = localStorage.getItem('dv-author') || ''; } catch {}
  $('#author').addEventListener('input', () => { try { localStorage.setItem('dv-author', $('#author').value); } catch {} });

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 1800); }

  function select(id) {
    if (id === sceneId) return;
    sceneId = id; people.clear(); offset = null; lastRowT = 0; notes = []; notesLoaded = false; floor = null; bounds = null;
    extent = { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }; target = { ...extent };
    const u = new URL(location.href); u.searchParams.set('scene', id); history.replaceState(null, '', u);
    if (dvBase && id) loadScene(id);
  }

  async function loadScene(id) {
    try {
      const s = await (await fetch(dvBase + '/api/scenes/' + encodeURIComponent(id))).json();
      const w = s && s.world;
      if (w && w.bounds) bounds = { minX: w.bounds.min[0], maxX: w.bounds.max[0], minZ: w.bounds.min[2], maxZ: w.bounds.max[2] };
      if (w && w.topdown && w.topdown.file) {
        const img = new Image();
        img.onload = () => { floor = { img, min: w.topdown.min, max: w.topdown.max }; };
        img.src = dvBase + '/data/scenes/' + encodeURIComponent(id) + '/' + w.topdown.file;
      }
    } catch {}
  }

  function onRow(row) {
    if (!row || row.t <= lastRowT) return;
    lastRowT = row.t; lastRowLocal = nowS();
    const local = nowS();
    // offset = local clock minus server clock, from the fastest arrival seen (polling adds up to 250 ms of jitter)
    const o = local - row.t;
    if (offset === null || Math.abs(o - offset) > 1) offset = o;
    else offset = Math.min(offset, o);
    const here = new Set();
    for (const p of row.people) {
      here.add(p.id);
      let e = people.get(p.id);
      if (!e || e.goneAt) { e = { name: p.name, kind: p.kind, samples: [], trail: [], born: local, goneAt: 0 }; people.set(p.id, e); }
      e.name = p.name; e.kind = p.kind;
      e.samples.push({ t: row.t, x: p.x, z: p.z, yaw: p.yaw });
      if (e.samples.length > 12) e.samples.shift();
      e.trail.push({ t: row.t, x: p.x, z: p.z });
      while (e.trail.length && e.trail[0].t < row.t - 16) e.trail.shift();
      grow(p.x, p.z);
    }
    for (const [id, e] of people) if (!here.has(id) && !e.goneAt) e.goneAt = local;
  }

  function grow(x, z) {
    if (floor || bounds) return;
    target.minX = Math.min(target.minX, x - 1); target.maxX = Math.max(target.maxX, x + 1);
    target.minZ = Math.min(target.minZ, z - 1); target.maxZ = Math.max(target.maxZ, z + 1);
  }

  function poseAt(b, rt) {
    if (rt <= b[0].t) return b[0];
    for (let i = 1; i < b.length; i++) if (b[i].t >= rt) {
      const a = b[i - 1], c = b[i], k = (rt - a.t) / (c.t - a.t || 1);
      return { t: rt, x: a.x + (c.x - a.x) * k, z: a.z + (c.z - a.z) * k, yaw: a.yaw + wrap(c.yaw - a.yaw) * k };
    }
    return b[b.length - 1];
  }

  let notesLoaded = false;
  function setNotes(list) {
    const local = nowS();
    // notes already there when the room opens appear at once; new ones pop in
    for (const n of list) if (!noteBorn.has(n.id)) { noteBorn.set(n.id, notesLoaded ? local : local - 1); grow(n.x, n.z); }
    notes = list; notesLoaded = true;
  }

  function panel(s) {
    const sel = $('#scene');
    const ids = s.scenes.map((x) => x.id);
    if (sel.dataset.ids !== ids.join(',')) {
      sel.dataset.ids = ids.join(',');
      sel.innerHTML = ids.length ? ids.map((id) => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('') : '<option value="">Waiting for a room…</option>';
    }
    if (sceneId && ids.includes(sceneId)) sel.value = sceneId;
    const me = s.scenes.find((x) => x.id === sceneId);
    const live = s.live && s.live.age < 5 && s.live.people.length;
    $('#pill').classList.toggle('live', !!live);
    $('#pilltext').textContent = live ? 'LIVE · ' + s.live.people.length + ' INSIDE' : s.mode !== 'ok' ? 'DRILL: ' + s.mode.toUpperCase() : 'WAITING';
    $('#rate').textContent = me ? me.rate.toFixed(1) : '0.0';
    $('#age').textContent = me && me.age !== null ? (me.age < 1 ? 'now' : Math.round(me.age) + ' s') : '–';
    const list = s.live ? s.live.people : [];
    $('#people').innerHTML = list.length ? list.map((p) =>
      '<div class="row"><span class="sw ' + esc(p.kind) + '"></span><div><div class="who">' + esc(p.name) + '</div><div class="kind">' +
      ({ vr: 'HEADSET', roblox: 'ROBLOX', web: 'BROWSER' }[p.kind] || esc(p.kind)) + '</div></div><span class="pos">' +
      p.x.toFixed(1) + ', ' + p.z.toFixed(1) + '</span></div>').join('') : '<div class="muted">Nobody yet.</div>';
    $('#notes').innerHTML = s.notes.length ? s.notes.slice().reverse().map((n) =>
      '<div class="note">' + esc(n.text) + '<small>— ' + esc(n.author) + '</small></div>').join('') : '<div class="muted">Click the map to leave one.</div>';
    if (s.mode !== lastMode || !document.querySelector('#drills .on')) {
      lastMode = s.mode;
      for (const b of document.querySelectorAll('#drills button')) b.classList.toggle('on', b.dataset.mode === s.mode);
    }
  }

  async function poll() {
    try {
      const r = await fetch('/ui/state' + (sceneId ? '?sceneId=' + encodeURIComponent(sceneId) : ''), { cache: 'no-store' });
      const s = await r.json();
      if (!sceneId && s.scenes.length) { select(s.scenes[0].id); }
      else { if (s.live) onRow(s.live); setNotes(s.notes); panel(s); }
    } catch {}
    setTimeout(poll, 250);
  }

  // projection: screen x = world x, screen y = world z, so forward (-Z) points up
  let P = { s: 1, ox: 0, oz: 0 };
  function project(dpr) {
    const pad = 28 * dpr, w = canvas.width - 2 * pad, h = canvas.height - 2 * pad;
    const ex = extent.maxX - extent.minX, ez = extent.maxZ - extent.minZ;
    const s = Math.max(1, Math.min(w / ex, h / ez));
    P = { s, ox: pad + (w - ex * s) / 2 - extent.minX * s, oz: pad + (h - ez * s) / 2 - extent.minZ * s };
  }
  const sx = (x) => P.ox + x * P.s, sz = (z) => P.oz + z * P.s;
  const wx = (px) => (px - P.ox) / P.s, wz = (py) => (py - P.oz) / P.s;

  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

  let lastFrame = nowS();
  function frame() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const local = nowS(), dt = Math.min(0.1, local - lastFrame); lastFrame = local;
    const want = floor ? { minX: floor.min[0], maxX: floor.max[0], minZ: floor.min[1], maxZ: floor.max[1] } : bounds || target;
    const k = 1 - Math.exp(-dt * 4);
    for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) extent[key] += (want[key] - extent[key]) * k;
    project(dpr);
    // draw everyone DELAY seconds in the past, between the two snapshots around that moment
    const DELAY = 0.3 + 0.25; // the contract's 0.3 s, plus this page's 250 ms polling
    const rt = offset === null ? 0 : local - offset - DELAY;

    ctx.fillStyle = '#0A0B0D'; ctx.fillRect(0, 0, W, H);
    if (floor) { ctx.globalAlpha = 0.7; ctx.drawImage(floor.img, sx(floor.min[0]), sz(floor.min[1]), (floor.max[0] - floor.min[0]) * P.s, (floor.max[1] - floor.min[1]) * P.s); ctx.globalAlpha = 1; }
    // grid: 0.5 m, brighter every 1 m
    const gx0 = Math.floor(wx(0) * 2) / 2, gx1 = Math.ceil(wx(W) * 2) / 2, gz0 = Math.floor(wz(0) * 2) / 2, gz1 = Math.ceil(wz(H) * 2) / 2;
    ctx.lineWidth = dpr;
    for (let g = gx0; g <= gx1; g += 0.5) { ctx.strokeStyle = Math.abs(g % 1) < 1e-6 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.035)'; ctx.beginPath(); ctx.moveTo(sx(g), 0); ctx.lineTo(sx(g), H); ctx.stroke(); }
    for (let g = gz0; g <= gz1; g += 0.5) { ctx.strokeStyle = Math.abs(g % 1) < 1e-6 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.035)'; ctx.beginPath(); ctx.moveTo(0, sz(g)); ctx.lineTo(W, sz(g)); ctx.stroke(); }
    // room extent
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1.5 * dpr;
    roundRect(sx(extent.minX), sz(extent.minZ), (extent.maxX - extent.minX) * P.s, (extent.maxZ - extent.minZ) * P.s, 14 * dpr); ctx.stroke();
    // spawn (the headset starts at the origin, facing -Z)
    ctx.strokeStyle = 'rgba(198,255,61,0.35)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(sx(0) - 6 * dpr, sz(0)); ctx.lineTo(sx(0) + 6 * dpr, sz(0)); ctx.moveTo(sx(0), sz(0) - 6 * dpr); ctx.lineTo(sx(0), sz(0) + 6 * dpr); ctx.stroke();
    ctx.fillStyle = 'rgba(198,255,61,0.45)'; ctx.font = '800 ' + 9 * dpr + 'px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('SPAWN', sx(0) + 8 * dpr, sz(0) + 12 * dpr);

    // a dead feed fades everyone out instead of freezing old dots on the map
    if (lastRowLocal && local - lastRowLocal > 5) for (const e of people.values()) if (!e.goneAt) e.goneAt = local;
    let visible = 0;
    for (const [id, e] of people) {
      if (!e.samples.length) continue;
      const fadeIn = Math.min(1, (local - e.born) / 0.3);
      const fadeOut = e.goneAt ? Math.max(0, 1 - (local - e.goneAt) / 0.6) : 1;
      if (e.goneAt && fadeOut <= 0) { people.delete(id); continue; }
      const a = fadeIn * fadeOut;
      if (!e.goneAt) visible++;
      const p = poseAt(e.samples, rt);
      const col = e.kind === 'vr' ? [198, 255, 61] : e.kind === 'roblox' ? [255, 255, 255] : [154, 160, 168];
      // trail: the last 15 s, fading with age
      const pts = e.trail.filter((q) => q.t <= rt && q.t > rt - 15).concat([{ t: rt, x: p.x, z: p.z }]);
      ctx.lineWidth = 2.5 * dpr; ctx.lineCap = 'round';
      for (let i = 1; i < pts.length; i++) {
        const age = rt - pts[i].t;
        ctx.strokeStyle = 'rgba(' + col.join(',') + ',' + (0.55 * (1 - age / 15) * a).toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(sx(pts[i - 1].x), sz(pts[i - 1].z)); ctx.lineTo(sx(pts[i].x), sz(pts[i].z)); ctx.stroke();
      }
      const X = sx(p.x), Z = sz(p.z), sc = 0.7 + 0.3 * fadeIn;
      const ang = Math.atan2(-Math.cos(p.yaw), -Math.sin(p.yaw)); // facing (-sin yaw, -cos yaw) in (x, z)
      if (e.kind === 'vr') {
        const r = 1.2 * P.s, g = ctx.createRadialGradient(X, Z, 0, X, Z, r);
        g.addColorStop(0, 'rgba(198,255,61,' + 0.32 * a + ')'); g.addColorStop(1, 'rgba(198,255,61,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(X, Z); ctx.arc(X, Z, r, ang - Math.PI / 6, ang + Math.PI / 6); ctx.closePath(); ctx.fill();
        const pulse = (local * 0.8) % 1;
        ctx.strokeStyle = 'rgba(198,255,61,' + (0.6 * (1 - pulse) * a) + ')'; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(X, Z, (9 + 16 * pulse) * dpr, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.save(); ctx.translate(X, Z); ctx.scale(sc, sc); ctx.globalAlpha = a;
      ctx.strokeStyle = 'rgba(' + col.join(',') + ',0.9)'; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(Math.cos(ang) * 9 * dpr, Math.sin(ang) * 9 * dpr); ctx.lineTo(Math.cos(ang) * 15 * dpr, Math.sin(ang) * 15 * dpr); ctx.stroke();
      if (e.kind === 'web') { ctx.strokeStyle = '#9AA0A8'; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.arc(0, 0, 6.5 * dpr, 0, Math.PI * 2); ctx.stroke(); }
      else { ctx.fillStyle = 'rgb(' + col.join(',') + ')'; ctx.beginPath(); ctx.arc(0, 0, 7 * dpr, 0, Math.PI * 2); ctx.fill(); }
      if (e.kind === 'roblox') { ctx.fillStyle = '#0A0B0D'; ctx.fillRect(-2.5 * dpr, -2.5 * dpr, 5 * dpr, 5 * dpr); }
      ctx.restore();
      ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.font = '900 ' + 11 * dpr + 'px system-ui, sans-serif';
      ctx.fillStyle = e.kind === 'vr' ? LIME : '#F2F4F5'; ctx.fillText(e.name.toUpperCase(), X, Z - 16 * dpr); ctx.globalAlpha = 1;
    }

    // notes: lime stickies, popping in over 200 ms
    hoverNote = null;
    for (const n of notes) {
      const born = noteBorn.get(n.id) ?? 0, k2 = Math.min(1, (local - born) / 0.2), s2 = 0.6 + 0.4 * (1 - Math.pow(1 - k2, 3)) + (k2 < 1 ? 0.08 * Math.sin(k2 * Math.PI) : 0);
      const X = sx(n.x), Z = sz(n.z), w = 120 * dpr, h = 40 * dpr;
      ctx.save(); ctx.translate(X, Z); ctx.scale(s2, s2); ctx.globalAlpha = k2;
      ctx.fillStyle = LIME; roundRect(-w / 2, -h - 8 * dpr, w, h, 8 * dpr); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-5 * dpr, -8 * dpr); ctx.lineTo(5 * dpr, -8 * dpr); ctx.lineTo(0, 0); ctx.fill();
      ctx.fillStyle = '#0A0B0D'; ctx.textAlign = 'left'; ctx.font = '900 ' + 11 * dpr + 'px system-ui, sans-serif';
      const t = n.text.length > 24 ? n.text.slice(0, 23) + '…' : n.text;
      ctx.fillText(t, -w / 2 + 8 * dpr, -h + 9 * dpr, w - 16 * dpr);
      ctx.font = '700 ' + 9.5 * dpr + 'px system-ui, sans-serif'; ctx.globalAlpha = 0.7 * k2;
      ctx.fillText('— ' + n.author, -w / 2 + 8 * dpr, -h + 23 * dpr, w - 16 * dpr);
      ctx.restore();
    }

    const stale = !lastRowLocal || local - lastRowLocal > 5 || visible === 0;
    $('#empty').classList.toggle('on', stale);
    canvas.style.opacity = stale ? '0.55' : '1';
    requestAnimationFrame(frame);
  }

  // notes composer
  const composer = $('#composer'), input = $('#text');
  canvas.addEventListener('click', (ev) => {
    if (!sceneId) return toast('Pick a room first');
    const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width;
    const px = (ev.clientX - r.left) * dpr, py = (ev.clientY - r.top) * dpr;
    composerAt = { x: +wx(px).toFixed(2), z: +wz(py).toFixed(2) };
    composer.style.left = Math.min(r.width - 280, Math.max(8, ev.clientX - r.left - 135)) + 'px';
    composer.style.top = Math.min(r.height - 90, ev.clientY - r.top + 12) + 'px';
    composer.style.display = 'block'; input.value = ''; $('#count').textContent = '0/120'; input.focus();
  });
  input.addEventListener('input', () => { $('#count').textContent = input.value.length + '/120'; });
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Escape') { composer.style.display = 'none'; return; }
    if (ev.key !== 'Enter' || !input.value.trim() || !composerAt) return;
    const body = { sceneId, author: $('#author').value.trim() || 'Guest', text: input.value.trim(), x: composerAt.x, y: 1.4, z: composerAt.z };
    composer.style.display = 'none';
    try {
      const r = await fetch('/ui/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast(r.ok ? 'Pinned. It is on its way to the headset.' : 'That note could not be saved');
    } catch { toast('That note could not be saved'); }
  });
  $('#scene').addEventListener('change', (ev) => select(ev.target.value));
  $('#clear').addEventListener('click', async () => { if (sceneId) await fetch('/ui/notes?sceneId=' + encodeURIComponent(sceneId), { method: 'DELETE' }); notes = []; noteBorn.clear(); });
  for (const b of document.querySelectorAll('#drills button')) b.addEventListener('click', async () => {
    await fetch('/ui/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: b.dataset.mode }) });
    lastMode = '';
  });
  if (sceneId && dvBase) loadScene(sceneId);
  poll();
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;

if (import.meta.main) {
  const port = Number(process.env.PORT || 8794);
  const key = process.env.DS_KEY || 'dev-ds-key';
  const m = startMockDeepSpace({ port, key, hostname: process.env.HOST || '127.0.0.1' });
  console.log(`\nStand-in live map service on ${m.url}`);
  console.log(`  Live map:  ${m.url}/   (add ?dv=http://localhost:8788 to draw the floor plan)`);
  console.log(`  Server env: DS_URL=${m.url} DS_KEY=${key}\n`);
  const stop = () => {
    m.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
