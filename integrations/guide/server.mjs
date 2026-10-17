import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ask, describe, health as geminiHealth, hotspots, narrate } from './gemini.mjs';
import { loadCache, saveCache } from './cache.mjs';

const port = Number(process.env.PORT || 8795);
const MAX_BODY = 15 * 1024 * 1024;
const started = Date.now();
const narrateCache = new Map();
const hotspotCache = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const hash = (value) => createHash('sha256').update(value).digest('hex');

function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function secure(req, res) { if (!process.env.GUIDE_KEY || req.url === '/health' || (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/public/'))) || req.headers['x-guide-key'] === process.env.GUIDE_KEY) return true; send(res, 401, { error: 'bad guide key' }); return false; }
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail('too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('body must be valid JSON'); }
}
function image(value) { if (!value) fail('image required'); if (!/^data:image\/[^;,]+(?:;[^,]+)?;base64,[a-z0-9+/=\r\n]+$/i.test(value)) fail('image must be a base64 data URL'); return value; }
function audio(value) { if (!/^data:audio\/[^;,]+(?:;[^,]+)?;base64,[a-z0-9+/=\r\n]+$/i.test(value || '')) fail('audio must be a base64 data URL'); return value; }
function cacheKey(scene, value) { return `${scene?.id || 'anonymous'}:${hash(value)}`; }

async function endpoint(req, res, handler) {
  try { send(res, 200, await handler(await readJson(req))); }
  catch (error) { send(res, error.status || 400, { error: error.message || 'bad request' }); }
}

async function staticFile(req, res) {
  const relative = req.url === '/' ? 'test.html' : req.url.slice('/public/'.length);
  if (!relative || relative.includes('..')) return false;
  try { const file = join(import.meta.dirname, 'public', relative); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file)); }
  catch { send(res, 404, { error: 'Not found' }); }
  return true;
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, ...geminiHealth(), uptimeS: Math.floor((Date.now() - started) / 1000) });
  if (!secure(req, res)) return;
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/public/'))) return staticFile(req, res);
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  if (req.url === '/describe') return endpoint(req, res, async ({ image: rawImage }) => describe(image(rawImage)));
  if (req.url === '/hotspots') return endpoint(req, res, async ({ image: rawImage, scene = {} }) => {
    const validImage = image(rawImage); const key = cacheKey(scene, validImage);
    const cached = hotspotCache.get(key) || await loadCache('hotspots', key);
    if (cached) return { ...cached, cached: true, ms: { understand: 0 } };
    const result = { ...(await hotspots(validImage, scene)), cached: false };
    if (!result.degraded && scene.id) { hotspotCache.set(key, result); await saveCache('hotspots', key, result); }
    return result;
  });
  if (req.url === '/narrate') return endpoint(req, res, async ({ image: rawImage, scene = {} }) => {
    const cached = scene.id && (narrateCache.get(scene.id) || await loadCache('narrate', scene.id));
    if (cached && cached.expires > Date.now()) return { ...cached.value, cached: true, ms: { understand: 0, tts: 0, total: 0 } };
    const validImage = image(rawImage); const result = { ...(await narrate(validImage, scene)), cached: false };
    if (!result.degraded && scene.id) { const entry = { value: result, expires: Date.now() + 30 * 60_000 }; narrateCache.set(scene.id, entry); await saveCache('narrate', scene.id, entry); }
    return result;
  });
  if (req.url === '/ask') return endpoint(req, res, async ({ image: rawImage, audio: rawAudio, question, scene = {}, history = [] }) => {
    const validImage = image(rawImage); const hasQuestion = typeof question === 'string' && question.trim().length > 0; const hasAudio = Boolean(rawAudio);
    if (hasQuestion === hasAudio) fail('set exactly one of audio or question');
    return ask(validImage, { question: hasQuestion ? question.trim() : '', audio: hasAudio ? audio(rawAudio) : '', scene, history: Array.isArray(history) ? history : [] });
  });
  return send(res, 404, { error: 'Not found' });
}).listen(port, () => console.log(`Déjà View guide listening on http://127.0.0.1:${port}`));
