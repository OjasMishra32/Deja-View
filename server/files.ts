// Static file responses with HTTP Range support, MIME types, conditional requests and CORS.

import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.ksplat': 'application/octet-stream',
  '.npy': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * CORS for reads only (scene assets, the scene list, health): any origin may GET them. Requests that change things
 * (POST, DELETE) never get these headers; server/guard.ts decides who may make them.
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, If-None-Match, If-Range, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag',
  'Access-Control-Max-Age': '86400',
};

/**
 * Resolves a URL sub-path (already split from the route) inside `baseDir`.
 * Returns null for anything that could escape the directory or names a hidden file.
 */
export function safeJoin(baseDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((p) => p !== '');
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('.')) return null;
  }
  const base = resolve(baseDir);
  const full = resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range` header against a file size.
 * Returns null when the header is absent or not a bytes range we serve partially (the caller sends 200),
 * 'unsatisfiable' for a 416, or the inclusive byte range.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null;
  const specs = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
  // Multiple ranges would need multipart/byteranges; a full 200 is a valid answer.
  if (specs.length !== 1) return null;
  const spec = specs[0]!;
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r) return null;
  const [, a, b] = r;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    if (size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  let end = b === '' ? size - 1 : Number(b);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (b !== '' && end < start) return null;
  if (start >= size) return 'unsatisfiable';
  if (end >= size) end = size - 1;
  return { start, end };
}

function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

export interface ServeOptions {
  /** Extra headers (CORS is always added). */
  headers?: Record<string, string>;
  cacheControl?: string;
}

/** Serves a file from disk honouring Range, If-Range, If-None-Match and HEAD. 404 when missing. */
export async function serveFile(req: Request, path: string, opts: ServeOptions = {}): Promise<Response> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return notFound();
  }
  if (!st.isFile()) return notFound();
  const size = st.size;
  const etag = etagFor(size, st.mtimeMs);
  const lastModified = new Date(st.mtimeMs).toUTCString();
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': mimeFor(path),
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': lastModified,
    'Cache-Control': opts.cacheControl ?? 'no-cache',
    ...opts.headers,
  };
  const head = req.method === 'HEAD';

  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
    return new Response(null, { status: 304, headers });
  }

  let range = parseRange(req.headers.get('range'), size);
  const ifRange = req.headers.get('if-range');
  if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = null;

  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  const file = Bun.file(path);
  if (range) {
    const len = range.end - range.start + 1;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(len);
    return new Response(head ? null : file.slice(range.start, range.end + 1), { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  // Bun applies a request's Range header by itself when the body is a file. When we deliberately answer
  // a ranged request with the whole file (If-Range mismatch, multiple ranges), stream it instead.
  const body = head ? null : req.headers.has('range') ? file.stream() : file;
  return new Response(body, { status: 200, headers });
}

export function notFound(message = 'Not found.'): Response {
  return Response.json({ error: message }, { status: 404, headers: CORS_HEADERS });
}
