import { GoogleGenAI } from '@google/genai';
import { ASK_SYSTEM, DESCRIBE_SYSTEM, HOTSPOTS_SYSTEM, NARRATE_SYSTEM } from './prompts.mjs';
import { answerFallback, describeFallback, hotspotsFallback, narrationFallback, sleep } from './fallback.mjs';

const mock = () => process.env.MOCK_GEMINI === '1' || !process.env.GEMINI_API_KEY;
const ai = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const imagePart = (dataUrl) => {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new Error('image must be a base64 data URL');
  return { inlineData: { mimeType: match[1], data: match[2] } };
};

async function json(model, systemInstruction, image, text) {
  const response = await ai().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text }, imagePart(image)] }],
    config: { systemInstruction, responseMimeType: 'application/json', temperature: 0.4 },
  });
  return JSON.parse(response.text);
}

export async function describe(image) {
  if (mock()) { await sleep(120); return { caption: describeFallback(), degraded: true }; }
  return { ...(await json(process.env.MODEL_FAST, DESCRIBE_SYSTEM, image, 'Describe this place.')), degraded: false };
}

export async function hotspots(image) {
  if (mock()) { await sleep(180); return { hotspots: hotspotsFallback(), degraded: true }; }
  const result = await json(process.env.MODEL_SPATIAL, HOTSPOTS_SYSTEM, image, 'Find useful room hotspots.');
  return { hotspots: (result.hotspots || []).map((item) => ({
    label: item.label,
    x: ((item.box_2d?.[1] ?? 500) + (item.box_2d?.[3] ?? 500)) / 2000,
    y: ((item.box_2d?.[0] ?? 500) + (item.box_2d?.[2] ?? 500)) / 2000,
    blurb: item.blurb || '',
    box_2d: item.box_2d,
  })), degraded: false };
}

export async function narrate(image, scene) {
  if (mock()) { await sleep(100); return { answer: narrationFallback(scene), speech: null, degraded: true }; }
  const result = await json(process.env.MODEL_FAST, NARRATE_SYSTEM, image, `Welcome someone to ${scene?.name || 'this room'}.`);
  return { answer: result.answer, speech: null, degraded: false };
}

export async function ask(image, question, scene) {
  if (mock()) { await sleep(200); const result = answerFallback(question, scene); return { question, ...result, speech: null, degraded: true }; }
  const result = await json(process.env.MODEL_FAST, ASK_SYSTEM, image, `Question: ${question || 'Please identify what is visible.'}`);
  return {
    question: result.question || question || '', answer: result.answer, speech: null,
    hotspot: result.hotspot_label ? { label: result.hotspot_label, box_2d: result.hotspot_box_2d || [] } : null,
    degraded: false,
  };
}
