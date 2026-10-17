/// Local review site for object assets. Scans data/scenes/*/objects/*/, serves the GLB,
/// the preflight texture sheet and scan, and records an approve/deny tied to the file SHA1.
/// It listens on 127.0.0.1 only (REVIEW_HOST overrides): anyone who can reach it can approve.
///   bun scripts/object-review.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DATA = join(ROOT, 'data', 'scenes');
const PORT = Number(process.env.REVIEW_PORT || 8790);
const HOST = process.env.REVIEW_HOST || '127.0.0.1';
const HTML = join(import.meta.dir, 'object-review.html');
/** Scene and object folder names; no leading dot, so never "." or "..". */
const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

type Asset = {
  sceneId: string; objectId: string; glb: string; sheet: string | null; preflight: unknown;
  candidates: unknown; approval: unknown; sha1: string; bytes: number;
};

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function sha1(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function assets(): Asset[] {
  const out: Asset[] = [];
  if (!existsSync(DATA)) return out;
  for (const sceneId of readdirSync(DATA)) {
    const objRoot = join(DATA, sceneId, 'objects');
    if (!existsSync(objRoot)) continue;
    for (const objectId of readdirSync(objRoot)) {
      const dir = join(objRoot, objectId);
      const glb = join(dir, 'roblox.glb');
      if (!existsSync(glb) || !statSync(glb).isFile()) continue;
      const pre = join(dir, 'preflight');
      const sheet = join(pre, 'textures.jpg');
      const base = `/asset/${encodeURIComponent(sceneId)}/${encodeURIComponent(objectId)}`;
      out.push({
        sceneId, objectId, glb: `${base}/roblox.glb`, sheet: existsSync(sheet) ? `${base}/preflight/textures.jpg` : null,
        preflight: readJson(join(pre, 'preflight.json')), candidates: readJson(join(pre, 'candidates.json')),
        approval: readJson(join(pre, 'approval.json')), sha1: sha1(glb), bytes: statSync(glb).size,
      });
    }
  }
  return out;
}

function safeJoin(base: string, rel: string): string | null {
  const p = resolve(base, rel);
  return p === base || p.startsWith(base + sep) ? p : null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css',
};

function file(path: string, type?: string): Response {
  const t = type ?? TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return new Response(Bun.file(path), { headers: { 'content-type': t, 'cache-control': 'no-cache' } });
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response('bad path', { status: 400 }); }
    if (path === '/' || path === '/index.html') return file(HTML, TYPES['.html']);
    if (path === '/api/assets') return Response.json({ assets: assets() });
    if (path === '/vendor/three.module.js') return file(join(ROOT, 'node_modules/three/build/three.module.js'), TYPES['.js']);
    if (path === '/vendor/three.core.js') return file(join(ROOT, 'node_modules/three/build/three.core.js'), TYPES['.js']);
    if (path.startsWith('/vendor/addons/')) {
      const rel = path.slice('/vendor/addons/'.length);
      const p = safeJoin(join(ROOT, 'node_modules/three/examples/jsm'), rel);
      if (!p || !existsSync(p)) return new Response('not found', { status: 404 });
      return file(p);
    }
    if (path.startsWith('/asset/')) {
      const m = /^\/asset\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
      if (!m) return new Response('bad asset path', { status: 400 });
      const [, sceneId, objectId, rest] = m;
      if (!ID_RE.test(sceneId) || !ID_RE.test(objectId)) return new Response('bad asset path', { status: 400 });
      const base = join(DATA, sceneId, 'objects', objectId);
      if (!existsSync(base)) return new Response('not found', { status: 404 });
      const p = safeJoin(base, rest);
      if (!p || !existsSync(p)) return new Response('not found', { status: 404 });
      return file(p);
    }
    if (path === '/api/review' && req.method === 'POST') {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
      const sceneId = String(body.sceneId ?? '');
      const objectId = String(body.objectId ?? '');
      if (!ID_RE.test(sceneId) || !ID_RE.test(objectId)) {
        return Response.json({ error: 'bad id' }, { status: 400 });
      }
      const dir = join(DATA, sceneId, 'objects', objectId);
      const glb = join(dir, 'roblox.glb');
      if (!existsSync(glb)) return Response.json({ error: 'no such asset' }, { status: 404 });
      const approved = body.approved === true;
      const digest = sha1(glb);
      // an approval is for the file the reviewer looked at: refuse it if the GLB changed since the page loaded
      if (approved && body.sha1 !== digest) {
        return Response.json({ error: 'The file changed since you loaded it. Reload and review it again.' }, { status: 409 });
      }
      const note = String(body.note ?? '').slice(0, 2000);
      const pre = join(dir, 'preflight');
      const record = {
        version: 1, glb: 'roblox.glb', sha1: digest, bytes: statSync(glb).size, approved,
        reviewer: String(body.reviewer ?? 'captain').slice(0, 80), at: new Date().toISOString(), note,
      };
      mkdirSync(pre, { recursive: true });
      writeFileSync(join(pre, 'approval.json'), JSON.stringify(record, null, 2));
      console.log(`[review] ${sceneId}/${objectId} ${approved ? 'approved' : 'denied'} ${record.sha1.slice(0, 12)}`);
      return Response.json({ ok: true, approval: record });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`[review] http://${HOST}:${PORT}`);
