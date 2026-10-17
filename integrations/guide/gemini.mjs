import { GoogleGenAI } from '@google/genai';
import { ASK_SYSTEM, DESCRIBE_SYSTEM, HOTSPOTS_SYSTEM, NARRATE_SYSTEM } from './prompts.mjs';
import { answerFallback, describeFallback, hotspotsFallback, narrationFallback, sleep } from './fallback.mjs';

const models = { fast: process.env.MODEL_FAST || 'gemini-3.5-flash-lite', spatial: process.env.MODEL_SPATIAL || 'gemini-3.8-flash', tts: process.env.MODEL_TTS || 'gemini-3.8-flash-lite-tts' };
const voice = process.env.VOICE || 'Sulafat';
const speechCache = new Map();
let lastFailure = false;
const isMock = () => process.env.MOCK_GEMINI === '1' || !process.env.GEMINI_API_KEY;
const client = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function dataUrlPart(value, name) {
  const match = /^data:([^;,]+(?:;[^,]+)?);base64,([a-z0-9+/=\r\n]+)$/i.exec(value || '');
  if (!match) throw new Error(`${name} must be a base64 data URL`);
  return { inlineData: { mimeType: match[1], data: match[2].replace(/\s/g, '') } };
}
function parseJson(text) { return JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
async function timed(fn) { const started = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - started) }; }
async function generateJson(model, systemInstruction, parts, mediaResolution = 'MEDIA_RESOLUTION_LOW') {
  const response = await client().models.generateContent({ model, contents: [{ role: 'user', parts }], config: { systemInstruction, responseMimeType: 'application/json', temperature: 0.3, mediaResolution, maxOutputTokens: 600 } });
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

export async function speak(text) {
  if (!text || isMock()) return { speech: null, speechSeconds: 0 };
  if (speechCache.has(text)) return speechCache.get(text);
  const response = await client().models.generateContent({ model: models.tts, contents: [{ role: 'user', parts: [{ text }] }], config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } });
  const audio = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
  if (!audio?.data) throw new Error('Gemini returned no audio');
  const output = wavDataUrl(audio.data, audio.mimeType);
  speechCache.set(text, output);
  return output;
}

export async function describe(image) {
  if (isMock()) { await sleep(100); return { caption: describeFallback(), degraded: true, error: 'mock mode', ms: { understand: 100 } }; }
  try { const result = await timed(() => generateJson(models.fast, DESCRIBE_SYSTEM, [{ text: 'Describe this place for a world generator.' }, dataUrlPart(image, 'image')], 'MEDIA_RESOLUTION_MEDIUM')); lastFailure = false; return { caption: result.value.caption || '', degraded: false, ms: { understand: result.ms } }; }
  catch (error) { lastFailure = true; return { caption: '', degraded: true, error: error.message, ms: { understand: 0 } }; }
}

export async function hotspots(image, scene = {}) {
  if (isMock()) { await sleep(150); return { hotspots: hotspotsFallback(), degraded: true, error: 'mock mode', ms: { understand: 150 } }; }
  try {
    const context = `Scene: ${scene.name || 'unnamed'}; mode: ${scene.mode === 'video' ? 'video' : 'photo'}; caption: ${scene.caption || 'none'}. Find room hotspots.`;
    const result = await timed(() => generateJson(models.spatial, HOTSPOTS_SYSTEM, [{ text: context }, dataUrlPart(image, 'image')]));
    lastFailure = false;
    return { hotspots: (result.value.hotspots || []).slice(0, 6).map((item) => ({ label: String(item.label || '').toLowerCase().trim().split(/\s+/).slice(0, 3).join(' '), x: Number((((item.box_2d?.[1] ?? 500) + (item.box_2d?.[3] ?? 500)) / 2000).toFixed(4)), y: Number((((item.box_2d?.[0] ?? 500) + (item.box_2d?.[2] ?? 500)) / 2000).toFixed(4)), blurb: String(item.blurb || '').trim().split(/\s+/).slice(0, 5).join(' '), box: item.box_2d || [] })).filter((item) => item.label), degraded: false, ms: { understand: result.ms } };
  } catch (error) { lastFailure = true; return { hotspots: [], degraded: true, error: error.message, ms: { understand: 0 } }; }
}

export async function narrate(image, scene = {}) {
  if (isMock()) { await sleep(100); return { answer: narrationFallback(scene), speech: null, speechSeconds: 0, degraded: true, error: 'mock mode', ms: { understand: 100, tts: 0, total: 100 } }; }
  try {
    const understanding = await timed(() => generateJson(models.fast, NARRATE_SYSTEM, [{ text: `Welcome someone to ${scene.name || 'this room'}. Caption: ${scene.caption || 'none'}.` }, dataUrlPart(image, 'image')]));
    const answer = understanding.value.answer || narrationFallback(scene); const speech = await timed(() => speak(answer)); lastFailure = false;
    return { answer, ...speech.value, degraded: false, ms: { understand: understanding.ms, tts: speech.ms, total: understanding.ms + speech.ms } };
  } catch (error) { lastFailure = true; return { answer: narrationFallback(scene), speech: null, speechSeconds: 0, degraded: true, error: error.message, ms: { understand: 0, tts: 0, total: 0 } }; }
}

export async function ask(image, { question = '', audio = '', scene = {}, history = [] } = {}) {
  if (audio && Buffer.from(audio.split(',')[1] || '', 'base64').length < 2048) return { question: '', answer: 'Sorry, I missed that. Hold the button and try again.', speech: null, speechSeconds: 0, degraded: false, ms: { understand: 0, tts: 0, total: 0 } };
  if (isMock()) { await sleep(180); const fallback = answerFallback(question, scene); return { question, ...fallback, speech: null, speechSeconds: 0, degraded: true, error: 'mock mode', ms: { understand: 180, tts: 0, total: 180 } }; }
  try {
    const turns = history.slice(-4).map((turn) => `Q: ${turn.q || ''}\nA: ${turn.a || ''}`).join('\n');
    const prompt = `Scene: ${scene.name || 'unnamed'}; mode: ${scene.mode || 'photo'}; caption: ${scene.caption || 'none'}; known labels: ${(scene.hotspots || []).map((item) => item.label).join(', ') || 'none'}.\nPrevious turns:\n${turns || 'none'}\n${question ? `Typed question: ${question}` : 'Answer the spoken question in the audio.'}`;
    const parts = [{ text: prompt }, dataUrlPart(image, 'image')]; if (audio) parts.push(dataUrlPart(audio, 'audio'));
    const understanding = await timed(() => generateJson(models.fast, ASK_SYSTEM, parts)); const answer = understanding.value.answer || answerFallback(question, scene).answer; const speech = await timed(() => speak(answer)); const box = understanding.value.hotspot_box_2d || []; lastFailure = false;
    return { question: understanding.value.question || question || '', answer, ...speech.value, hotspot: understanding.value.hotspot_label ? { label: understanding.value.hotspot_label, x: Number((((box[1] ?? 500) + (box[3] ?? 500)) / 2000).toFixed(4)), y: Number((((box[0] ?? 500) + (box[2] ?? 500)) / 2000).toFixed(4)) } : undefined, degraded: false, ms: { understand: understanding.ms, tts: speech.ms, total: understanding.ms + speech.ms } };
  } catch (error) { lastFailure = true; const fallback = answerFallback(question, scene); return { question, ...fallback, speech: null, speechSeconds: 0, degraded: true, error: error.message, ms: { understand: 0, tts: 0, total: 0 } }; }
}

export function health() { return { gemini: isMock() ? 'off' : (lastFailure ? 'degraded' : 'ok'), mock: isMock(), models, voice }; }
