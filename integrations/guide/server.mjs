import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ask, describe, hotspots, narrate } from './gemini.mjs';
import { answerFallback, describeFallback, hotspotsFallback, narrationFallback } from './fallback.mjs';

const port = Number(process.env.PORT || 8795);
const MAX_BODY = 15 * 1024 * 1024;
const narrateCache = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function secure(req, res) {
  if (!process.env.GUIDE_KEY || req.url === '/health') return true;
  if (req.headers['x-guide-key'] === process.env.GUIDE_KEY) return true;
  send(res, 401, { error: 'bad guide key' });
  return false;
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('body must be valid JSON'), { status: 400 }); }
}

function withTiming(name, handler) {
  return async (req, res) => {
    const started = performance.now();
    try {
      const input = await body(req);
      if (!input.image) return send(res, 400, { error: 'image is required' });
      const output = await handler(input);
      const ms = Math.round(performance.now() - started);
      console.log(`${name} ${ms}ms`);
      send(res, 200, { ...output, ms });
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      console.error(`${name} ${ms}ms: ${error.message}`);
      const status = error.status || 500;
      send(res, status, { error: status < 500 ? error.message : 'The room lost its train of thought. Please ask again.', ms });
    }
  };
}

const routes = {
  '/describe': withTiming('describe', async ({ image }) => {
    try { return await describe(image); }
    catch (error) { console.warn(`describe Gemini fallback: ${error.message}`); return { caption: describeFallback(), degraded: true }; }
  }),
  '/hotspots': withTiming('hotspots', async ({ image }) => {
    try { return await hotspots(image); }
    catch (error) { console.warn(`hotspots Gemini fallback: ${error.message}`); return { hotspots: [], degraded: true }; }
  }),
  '/narrate': withTiming('narrate', async ({ image, scene = {} }) => {
    if (scene.id && narrateCache.has(scene.id)) return { ...narrateCache.get(scene.id), cached: true };
    let result;
    try { result = await narrate(image, scene); }
    catch (error) { console.warn(`narrate Gemini fallback: ${error.message}`); result = { answer: narrationFallback(scene), speech: null, degraded: true }; }
    if (scene.id) narrateCache.set(scene.id, result);
    return result;
  }),
  '/ask': withTiming('ask', async ({ image, question = '', scene = {} }) => {
    try { return await ask(image, question, scene); }
    catch (error) { console.warn(`ask Gemini fallback: ${error.message}`); const fallback = answerFallback(question, scene); return { question, ...fallback, speech: null, degraded: true }; }
  }),
};

async function staticFile(req, res) {
  const relative = req.url === '/' ? 'test.html' : req.url.slice('/public/'.length);
  if (!relative || relative.includes('..')) return false;
  try {
    const file = join(import.meta.dirname, 'public', relative);
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch { send(res, 404, { error: 'Not found' }); }
  return true;
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, mock: process.env.MOCK_GEMINI === '1' });
  if (!secure(req, res)) return;
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/public/'))) return staticFile(req, res);
  if (req.method !== 'POST' || !routes[req.url]) return send(res, 404, { error: 'Not found' });
  return routes[req.url](req, res);
}).listen(port, () => console.log(`Déjà View guide listening on http://127.0.0.1:${port}`));
