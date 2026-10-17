import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_PLACES } from './prompts.mjs';

// notes/<sceneId>.json: one summary per clip (scripts/video-notes.mjs, then checked by hand). Read on every call, so
// a fixed file counts at once. A missing file is normal; a broken one is skipped with one warning.
const SCENE_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const warned = new Set();
// long fields are cut at a word, so a hand-written paragraph cannot crowd out the question
function text(value, max = 400) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : max).replace(/[\s,;:.]+$/, '')}…`;
}
const list = (value, max = 8, length = 240) => (Array.isArray(value) ? value.map((item) => text(item, length)).filter(Boolean).slice(0, max) : []);
const sentence = (value) => (/[.!?…]$/.test(value) ? value : `${value}.`);

export const notesDir = () => process.env.NOTES_DIR || join(import.meta.dirname, 'notes');
export const notesPath = (sceneId) => (SCENE_ID.test(sceneId || '') ? join(notesDir(), `${sceneId}.json`) : null);

export function cleanNotes(raw, sceneId = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const moments = (Array.isArray(raw.moments) ? raw.moments : []).filter((moment) => moment && typeof moment === 'object').map((moment) => ({ t: Number.isFinite(Number(moment.t)) ? Number(moment.t) : null, what: text(moment.what, 240) })).filter((moment) => moment.what).slice(0, 8);
  const notes = { sceneId: text(raw.sceneId, 80) || sceneId, clip: text(raw.clip, 120), oneLine: text(raw.oneLine), activity: text(raw.activity), people: list(raw.people), objects: list(raw.objects, 12, 160), outcome: text(raw.outcome), moments, funnyDetail: text(raw.funnyDetail), checkedBy: text(raw.checkedBy, 60), confidence: typeof raw.confidence === 'number' || typeof raw.confidence === 'string' ? raw.confidence : '' };
  return notes.oneLine || notes.outcome || notes.activity || notes.moments.length ? notes : null;
}

export async function loadNotes(sceneId) {
  const file = notesPath(sceneId);
  if (!file) return null;
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch { return null; }
  try { const notes = cleanNotes(JSON.parse(raw), sceneId); if (!notes) throw new Error('no oneLine, outcome, activity or moments'); return notes; }
  catch (error) { const key = `${file}:${error.message}`; if (!warned.has(key)) { warned.add(key); console.warn(`notes: skipping ${sceneId}.json (${error.message})`); } return null; }
}

// The scene's own notes, then the notes of the place a video memory happened in.
export async function sceneNotes(scene) {
  const ids = [...new Set([scene?.id, MEMORY_PLACES[scene?.id]].filter((id) => typeof id === 'string' && id))];
  return (await Promise.all(ids.map(loadNotes))).filter(Boolean);
}

export function notesContext(notes = []) {
  return notes.map((item) => [
    `Notes on ${item.sceneId}${item.checkedBy ? ` (checked: ${item.checkedBy})` : ''}:`,
    item.oneLine && sentence(item.oneLine),
    item.activity && `Activity: ${sentence(item.activity)}`,
    item.people.length && `People: ${item.people.map(sentence).join(' ')}`,
    item.outcome && `Outcome: ${sentence(item.outcome)}`,
    item.moments.length && `Moments: ${item.moments.map((moment) => `${moment.t ?? '?'}s: ${sentence(moment.what)}`).join(' ')}`,
    item.funnyDetail && `Funny detail: ${sentence(item.funnyDetail)}`,
  ].filter(Boolean).join(' ')).join('\n');
}

export function notesOutcome(notes = []) { return notes.find((item) => item.outcome)?.outcome || ''; }
