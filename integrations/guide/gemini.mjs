import { ASK_SYSTEM, DESCRIBE_SYSTEM, FRAMES_SYSTEM, HOTSPOTS_SYSTEM, NARRATE_SYSTEM, worldHints } from './prompts.mjs';
import { answerFallback, describeFallback, framesFallback, hotspotsFallback, narrationFallback, sleep } from './fallback.mjs';
import { notesContext, sceneNotes } from './notes.mjs';

const models = { fast: process.env.MODEL_FAST || 'gemini-3.5-flash-lite', spatial: process.env.MODEL_SPATIAL || 'gemini-3.8-flash', tts: process.env.MODEL_TTS || 'gemini-3.8-flash-lite-tts' };
const voice = process.env.VOICE || 'Sulafat';
const speechCache = new Map();
let lastFailure = false;
let sdk;
let injected = null;
const isMock = () => process.env.MOCK_GEMINI === '1' || (!injected && !process.env.GEMINI_API_KEY);
// The SDK loads on the first real call, so mock mode and the tests run without it; setClient swaps in a stub.
async function client() { if (injected) return injected; sdk ??= await import('@google/genai'); return new sdk.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); }
export function setClient(next) { injected = next || null; }

function dataUrlPart(value, name) {
  const match = /^data:([^;,]+(?:;[^,]+)?);base64,([a-z0-9+/=\r\n]+)$/i.exec(value || '');
  if (!match) throw new Error(`${name} must be a base64 data URL`);
  return { inlineData: { mimeType: match[1], data: match[2].replace(/\s/g, '') } };
}
const HOTSPOTS_SCHEMA = { type: 'object', properties: { hotspots: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, box_2d: { type: 'array', items: { type: 'integer' } }, blurb: { type: 'string' } }, required: ['label', 'box_2d', 'blurb'] } } }, required: ['hotspots'] };
export function parseJson(text) { return JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
async function timed(fn) { const started = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - started) }; }
// Thinking stays low: it counts against maxOutputTokens, and at the default level it ran past the cap (cut-off JSON)
// and took about 27 s for labels that take under 3 s this way.
// timeoutMs bounds one call (retries included), so a busy model can hand over to another in time.
// A busy (503) or used-up (429) understanding model hands the same request to the other one, so the room keeps talking.
const busy = (error) => /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|high demand/i.test(String(error?.message));
async function generateJson(model, systemInstruction, parts, mediaResolution = 'MEDIA_RESOLUTION_LOW', responseSchema = undefined, timeoutMs = undefined) {
  try { return await generateJsonOnce(model, systemInstruction, parts, mediaResolution, responseSchema, timeoutMs); }
  catch (error) {
    const other = model === models.fast ? models.spatial : models.fast;
    if (!busy(error) || other === model) throw error;
    return generateJsonOnce(other, systemInstruction, parts, mediaResolution, responseSchema, timeoutMs);
  }
}
async function generateJsonOnce(model, systemInstruction, parts, mediaResolution, responseSchema, timeoutMs) {
  const response = await (await client()).models.generateContent({ model, contents: [{ role: 'user', parts }], config: { systemInstruction, responseMimeType: 'application/json', ...(responseSchema ? { responseSchema } : {}), temperature: 0.3, mediaResolution, maxOutputTokens: 1200, thinkingConfig: { thinkingLevel: 'low' }, ...(timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : {}) } });
  return parseJson(response.text);
}
function wavDataUrl(raw, mimeType = '') {
  const source = Buffer.from(raw, 'base64');
  if (/audio\/wav/i.test(mimeType)) {
    const rate = source.length >= 44 ? source.readUInt32LE(24) : 24000;
    const channels = source.length >= 44 ? source.readUInt16LE(22) : 1;
    const bits = source.length >= 44 ? source.readUInt16LE(34) : 16;
    const bytes = source.length >= 44 ? source.readUInt32LE(40) : source.length;
    return { speech: `data:audio/wav;base64,${raw}`, speechSeconds: Number((bytes / (rate * channels * bits / 8)).toFixed(1)) };
  }
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1]) || 24000;
  const channels = Number(/channels=(\d+)/i.exec(mimeType)?.[1]) || 1;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + source.length, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(source.length, 40);
  return { speech: `data:audio/wav;base64,${Buffer.concat([header, source]).toString('base64')}`, speechSeconds: Number((source.length / (rate * channels * 2)).toFixed(1)) };
}

// MODEL_TTS may name several speech models, comma separated. Each has its own daily quota on a free key, so when one
// is used up (429) the next one speaks and the used-up one rests for an hour; any other failure just moves on.
const ttsResting = new Map();
export const TTS_REST_MS = 60 * 60 * 1000;
export function ttsModels() { return String(process.env.MODEL_TTS || models.tts).split(',').map((m) => m.trim()).filter(Boolean); }
export function resetTtsRest() { ttsResting.clear(); }
export async function speak(text) {
  if (!text || isMock()) return { speech: null, speechSeconds: 0 };
  if (speechCache.has(text)) return speechCache.get(text);
  let lastError = null;
  for (const model of ttsModels()) {
    if ((ttsResting.get(model) ?? 0) > Date.now()) continue;
    try {
      const response = await (await client()).models.generateContent({ model, contents: [{ role: 'user', parts: [{ text }] }], config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } });
      const audio = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
      if (!audio?.data) throw new Error('Gemini returned no audio');
      const output = wavDataUrl(audio.data, audio.mimeType);
      speechCache.set(text, output);
      return output;
    } catch (error) {
      lastError = error;
      if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(String(error?.message))) ttsResting.set(model, Date.now() + TTS_REST_MS);
    }
  }
  throw lastError || new Error('every speech model is resting after its quota ran out');
}

export async function describe(image, { frames = [], scene = {} } = {}) {
  if (frames.length) return describeFrames(frames, scene);
  if (isMock()) { await sleep(100); return { caption: describeFallback(), degraded: true, error: 'mock mode', ms: { understand: 100 } }; }
  try { const result = await timed(() => generateJson(models.fast, DESCRIBE_SYSTEM, [{ text: 'Describe this place for a world generator.' }, dataUrlPart(image, 'image')], 'MEDIA_RESOLUTION_MEDIUM')); lastFailure = false; return { caption: result.value.caption || '', degraded: false, ms: { understand: result.ms } }; }
  catch (error) { lastFailure = true; return { caption: '', degraded: true, error: error.message, ms: { understand: 0 } }; }
}

// Frames from a video memory, in order: who is playing what and who wins (or what is cooking). Notes, when there are
// any, give names and the checked outcome; they are also the caption when Gemini is off or fails.
async function describeFrames(frames, scene = {}) {
  const notes = await sceneNotes(scene);
  if (isMock()) { await sleep(100); return { caption: framesFallback(notes) || 'A few friends in the middle of a game. Too close to call from here.', degraded: true, error: 'mock mode', frames: frames.length, ms: { understand: 100 } }; }
  try {
    const context = [`${frames.length} frames from ${scene?.name || 'a clip'}, in order. Say who is playing what and who wins.`, worldHints(scene, 'This place has'), notesContext(notes)].filter(Boolean).join('\n');
    const result = await timed(() => generateJson(models.fast, FRAMES_SYSTEM, [{ text: context }, ...frames.map((frame, index) => dataUrlPart(frame, `frames[${index}]`))], 'MEDIA_RESOLUTION_MEDIUM'));
    lastFailure = false;
    return { caption: result.value.caption || '', degraded: false, frames: frames.length, ms: { understand: result.ms } };
  } catch (error) { lastFailure = true; return { caption: framesFallback(notes), degraded: true, error: error.message, frames: frames.length, ms: { understand: 0 } }; }
}

export async function hotspots(image, scene = {}) {
  if (isMock()) { await sleep(150); return { hotspots: hotspotsFallback(), degraded: true, error: 'mock mode', ms: { understand: 150 } }; }
  try {
    const hints = worldHints(scene);
    const context = `Scene: ${scene.name || 'unnamed'}; mode: ${scene.mode === 'video' ? 'video' : 'photo'}; caption: ${scene.caption || 'none'}. Find room hotspots.${hints ? ` ${hints}` : ''}`;
    const result = await timed(() => generateJson(models.spatial, HOTSPOTS_SYSTEM, [{ text: context }, dataUrlPart(image, 'image')], 'MEDIA_RESOLUTION_LOW', HOTSPOTS_SCHEMA, 8000).catch(() => generateJson(models.fast, HOTSPOTS_SYSTEM, [{ text: context }, dataUrlPart(image, 'image')], 'MEDIA_RESOLUTION_LOW', HOTSPOTS_SCHEMA)));
    lastFailure = false;
    return { hotspots: (result.value.hotspots || []).slice(0, 6).map((item) => ({ label: String(item.label || '').toLowerCase().trim().split(/\s+/).slice(0, 3).join(' '), x: Number((((item.box_2d?.[1] ?? 500) + (item.box_2d?.[3] ?? 500)) / 2000).toFixed(4)), y: Number((((item.box_2d?.[0] ?? 500) + (item.box_2d?.[2] ?? 500)) / 2000).toFixed(4)), blurb: String(item.blurb || '').trim().split(/\s+/).slice(0, 5).join(' '), box: item.box_2d || [] })).filter((item) => item.label), degraded: false, ms: { understand: result.ms } };
  } catch (error) { lastFailure = true; return { hotspots: [], degraded: true, error: error.message, ms: { understand: 0 } }; }
}

export async function narrate(image, scene = {}) {
  if (isMock()) { await sleep(100); return { answer: narrationFallback(scene), speech: null, speechSeconds: 0, degraded: true, error: 'mock mode', ms: { understand: 100, tts: 0, total: 100 } }; }
  try {
    const extra = [worldHints(scene), notesContext(await sceneNotes(scene))].filter(Boolean).map((line) => `\n${line}`).join('');
    const understanding = await timed(() => generateJson(models.fast, NARRATE_SYSTEM, [{ text: `Welcome someone to ${scene.name || 'this room'}. Caption: ${scene.caption || 'none'}.${extra}` }, dataUrlPart(image, 'image')]));
    const answer = understanding.value.answer || narrationFallback(scene); const speech = await timed(() => speak(answer)); lastFailure = false;
    return { answer, ...speech.value, degraded: false, ms: { understand: understanding.ms, tts: speech.ms, total: understanding.ms + speech.ms } };
  } catch (error) { lastFailure = true; return { answer: narrationFallback(scene), speech: null, speechSeconds: 0, degraded: true, error: error.message, ms: { understand: 0, tts: 0, total: 0 } }; }
}

export async function ask(image, { question = '', audio = '', scene = {}, history = [] } = {}) {
  if (audio && Buffer.from(audio.split(',')[1] || '', 'base64').length < 2048) return { question: '', answer: 'Sorry, I missed that. Hold the button and try again.', speech: null, speechSeconds: 0, degraded: false, ms: { understand: 0, tts: 0, total: 0 } };
  const notes = await sceneNotes(scene);
  if (isMock()) { await sleep(180); const fallback = answerFallback(question, scene, notes); return { question, ...fallback, speech: null, speechSeconds: 0, degraded: true, error: 'mock mode', ms: { understand: 180, tts: 0, total: 180 } }; }
  try {
    const turns = history.slice(-4).map((turn) => `Q: ${turn.q || ''}\nA: ${turn.a || ''}`).join('\n');
    const clipNotes = notes.length ? `${notesContext(notes)}\nTrust these notes for who won, who is who and what happened in the clip.\n` : '';
    const prompt = `Scene: ${scene.name || 'unnamed'}; mode: ${scene.mode || 'photo'}; caption: ${scene.caption || 'none'}; known labels: ${(scene.hotspots || []).map((item) => item.label).join(', ') || 'none'}.\n${clipNotes}Previous turns:\n${turns || 'none'}\n${question ? `Typed question: ${question}` : 'Answer the spoken question in the audio.'}`;
    const parts = [{ text: prompt }, dataUrlPart(image, 'image')]; if (audio) parts.push(dataUrlPart(audio, 'audio'));
    const understanding = await timed(() => generateJson(models.fast, ASK_SYSTEM, parts)); const answer = understanding.value.answer || answerFallback(question, scene, notes).answer; const speech = await timed(() => speak(answer)); const box = understanding.value.hotspot_box_2d || []; lastFailure = false;
    return { question: understanding.value.question || question || '', answer, ...speech.value, hotspot: understanding.value.hotspot_label ? { label: understanding.value.hotspot_label, x: Number((((box[1] ?? 500) + (box[3] ?? 500)) / 2000).toFixed(4)), y: Number((((box[0] ?? 500) + (box[2] ?? 500)) / 2000).toFixed(4)) } : undefined, degraded: false, ms: { understand: understanding.ms, tts: speech.ms, total: understanding.ms + speech.ms } };
  } catch (error) { lastFailure = true; const fallback = answerFallback(question, scene, notes); return { question, ...fallback, speech: null, speechSeconds: 0, degraded: true, error: error.message, ms: { understand: 0, tts: 0, total: 0 } }; }
}

export function health() { return { gemini: isMock() ? 'off' : (lastFailure ? 'degraded' : 'ok'), mock: isMock(), models, voice }; }
