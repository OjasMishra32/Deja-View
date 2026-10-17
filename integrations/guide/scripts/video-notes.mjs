// One-time notes for a video memory: upload the clip with the Files API, wait until it is ACTIVE, ask Gemini once for
// JSON, write notes/<sceneId>.json. /ask and /narrate read that file. An existing file is never replaced without
// --force: a hand-checked file wins.
//   npm run notes -- <sceneId> [clip] [--force]     (clip defaults to cache/video/<sceneId>.mov|.mp4|.m4v|.webm)
import { realpathSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../gemini.mjs';
import { cleanNotes, notesPath } from '../notes.mjs';
import { VIDEO_PROMPT, VIDEO_SCHEMA } from '../prompts.mjs';

const VIDEO_MIME = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm' };
const exists = (path) => access(path).then(() => true, () => false);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function findClip(sceneId) {
  for (const ext of Object.keys(VIDEO_MIME)) { const path = join(import.meta.dirname, '..', 'cache', 'video', `${sceneId}${ext}`); if (await exists(path)) return path; }
  throw new Error(`no clip: pass its path, or put it at cache/video/${sceneId}.mov`);
}

export async function videoNotes({ sceneId, clip = '', force = false, ai = null, pollMs = 2000, maxWaitMs = 5 * 60_000, log = console.log } = {}) {
  const out = notesPath(sceneId);
  if (!out) throw new Error('scene id must be letters, digits, dashes or underscores');
  if (!force && await exists(out)) { log(`notes/${sceneId}.json already exists, kept (pass --force to replace it)`); return { skipped: true, path: out }; }
  const path = clip || await findClip(sceneId);
  const mimeType = VIDEO_MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`unknown clip type ${extname(path) || '(none)'}: use .mov, .mp4, .m4v or .webm`);
  if (!await exists(path)) throw new Error(`no such clip: ${path}`);
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set (npm run notes reads .env)');
    const { GoogleGenAI } = await import('@google/genai');
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  log(`uploading ${basename(path)} (${mimeType})`);
  let file = await ai.files.upload({ file: path, config: { mimeType, displayName: `${sceneId}${extname(path)}` } });
  try {
    const deadline = Date.now() + maxWaitMs;
    while (file.state !== 'ACTIVE') {
      if (file.state === 'FAILED') throw new Error('video processing failed');
      if (Date.now() > deadline) throw new Error(`video still ${file.state || 'processing'} after ${Math.round(maxWaitMs / 1000)} s`);
      await sleep(pollMs);
      file = await ai.files.get({ name: file.name });
    }
    log('processed, asking Gemini');
    const response = await ai.models.generateContent({
      model: process.env.MODEL_VIDEO || 'gemini-3.8-flash',
      contents: [{ role: 'user', parts: [{ text: VIDEO_PROMPT }, { fileData: { fileUri: file.uri, mimeType: file.mimeType || mimeType } }] }],
      config: { responseMimeType: 'application/json', responseJsonSchema: VIDEO_SCHEMA, thinkingConfig: { thinkingLevel: 'LOW' }, temperature: 0.2 },
    });
    const cleaned = cleanNotes(parseJson(response.text), sceneId);
    if (!cleaned) throw new Error('Gemini returned no usable notes');
    const notes = { ...cleaned, sceneId, clip: basename(path), checkedBy: null };
    await mkdir(dirname(out), { recursive: true });
    try { await writeFile(out, `${JSON.stringify(notes, null, 2)}\n`, { flag: force ? 'w' : 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; log(`notes/${sceneId}.json appeared meanwhile, kept`); return { skipped: true, path: out, notes }; }
    return { path: out, notes };
  } finally {
    // the clip has real people in it: do not leave it on Google's side for the 48 hours the Files API keeps it
    try { await ai.files.delete({ name: file.name }); } catch { /* it expires on its own */ }
  }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  const args = process.argv.slice(2);
  const [sceneId, clip] = args.filter((arg) => !arg.startsWith('--'));
  if (!sceneId) { console.error('usage: npm run notes -- <sceneId> [clip] [--force]'); process.exit(2); }
  videoNotes({ sceneId, clip, force: args.includes('--force') })
    .then((result) => { if (!result.skipped) console.log(`wrote notes/${sceneId}.json\noutcome: ${result.notes.outcome}\nRead it, fix anything wrong by hand, and set "checkedBy".`); })
    .catch((error) => { console.error(`video notes failed: ${error.message}`); process.exitCode = 1; });
}
