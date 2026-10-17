// The Gemini side with a stubbed client: frames in /describe, world hints, clip notes and the notes fallback.
// No network and no key: setClient() replaces the SDK, and notes come from a temporary NOTES_DIR.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, mock, test } from 'node:test';
import { answerFallback } from '../fallback.mjs';
import { ask, describe as describeImage, health, hotspots, narrate, resetTtsRest, setClient, speak } from '../gemini.mjs';
import { loadNotes, notesContext, sceneNotes } from '../notes.mjs';
import { DESCRIBE_SYSTEM, FRAMES_SYSTEM, MEMORY_PLACES, WORLD_HINTS, worldHints } from '../prompts.mjs';

const jpeg = (text) => `data:image/jpeg;base64,${Buffer.from(text).toString('base64')}`;
const WAV = (() => {
  const wav = Buffer.alloc(44 + 4800);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 4800, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
  return wav.toString('base64');
})();

// Understanding calls are recorded and answered with `reply` (an object, an Error, or a function of the request);
// text-to-speech calls get a short WAV.
function stubGemini(reply) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(request) {
        if (request.config?.responseModalities) return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV } }] } }] };
        calls.push(request);
        const value = typeof reply === 'function' ? reply(request) : reply;
        if (value instanceof Error) throw value;
        return { text: JSON.stringify(value) };
      },
    },
  };
}
const parts = (request) => request.contents[0].parts;
const promptOf = (request) => parts(request)[0].text;

const FOOSBALL = { sceneId: 'courts-foosball', clip: 'foosball.mov', oneLine: 'Two friends play foosball on the patio', activity: 'foosball', people: ['grey hoodie on the left', 'red cap on the right'], objects: ['foosball table', 'ping pong table'], outcome: 'Red cap won 5 to 3 with a last-second goal', moments: [{ t: 4, what: 'first goal' }, { t: 14, what: 'the winning goal' }], funnyDetail: 'Grey hoodie blamed the table', checkedBy: 'Brianna', confidence: 'high' };
const KITCHEN = { sceneId: 'kitchen', oneLine: 'Two friends cook at the steel prep table', activity: 'cooking', people: [], objects: ['stove'], outcome: 'They made garlic fried rice', moments: [], funnyDetail: '', checkedBy: '', confidence: 0.8 };
let dir;

before(() => {
  delete process.env.MOCK_GEMINI;
  delete process.env.GEMINI_API_KEY;
  dir = mkdtempSync(join(tmpdir(), 'guide-notes-'));
  process.env.NOTES_DIR = dir;
  writeFileSync(join(dir, 'courts-foosball.json'), JSON.stringify(FOOSBALL));
  writeFileSync(join(dir, 'kitchen.json'), JSON.stringify(KITCHEN));
  writeFileSync(join(dir, 'chess-match.json'), '{ "oneLine": "half writ');
  writeFileSync(join(dir, 'a-list.json'), '[1, 2]');
  writeFileSync(join(dir, 'only-people.json'), JSON.stringify({ people: ['someone'] }));
});
after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.NOTES_DIR; });
afterEach(() => setClient(null));

describe('/describe with frames', () => {
  const frames = ['frame one', 'frame two', 'frame three'].map(jpeg);

  test('sends every frame as an image part, in order, after one text part', async () => {
    const gemini = stubGemini({ caption: 'Red cap and grey hoodie face off at foosball. Red cap wins it at the buzzer.' });
    setClient(gemini);
    const result = await describeImage('', { frames, scene: { id: 'courts-foosball', name: 'Foosball' } });
    assert.equal(gemini.calls.length, 1);
    const [request] = gemini.calls;
    assert.equal(request.model, health().models.fast);
    assert.equal(request.config.systemInstruction, FRAMES_SYSTEM);
    assert.equal(request.config.responseMimeType, 'application/json');
    assert.equal(request.config.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
    assert.equal(parts(request).length, 4);
    assert.ok(parts(request)[0].text.startsWith('3 frames from Foosball, in order.'));
    assert.deepEqual(parts(request).slice(1).map((part) => Buffer.from(part.inlineData.data, 'base64').toString()), ['frame one', 'frame two', 'frame three']);
    assert.ok(parts(request).slice(1).every((part) => part.inlineData.mimeType === 'image/jpeg'));
    assert.deepEqual(result, { caption: 'Red cap and grey hoodie face off at foosball. Red cap wins it at the buzzer.', degraded: false, frames: 3, ms: result.ms });
  });

  test('the frames prompt carries the place and the clip notes', async () => {
    const gemini = stubGemini({ caption: 'x' });
    setClient(gemini);
    await describeImage('', { frames, scene: { id: 'courts-foosball' } });
    const prompt = promptOf(gemini.calls[0]);
    assert.match(prompt, /This place has: foosball table, ping pong table, chairs, the glass door\./);
    assert.match(prompt, /Outcome: Red cap won 5 to 3 with a last-second goal\./);
  });

  test('an image-only call is exactly the old call', async () => {
    const gemini = stubGemini({ caption: 'A sunny patio with a foosball table.' });
    setClient(gemini);
    const image = jpeg('room');
    const result = await describeImage(image);
    const [request] = gemini.calls;
    assert.equal(request.config.systemInstruction, DESCRIBE_SYSTEM);
    assert.equal(request.config.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
    assert.deepEqual(parts(request), [{ text: 'Describe this place for a world generator.' }, { inlineData: { mimeType: 'image/jpeg', data: image.split(',')[1] } }]);
    assert.deepEqual(Object.keys(result), ['caption', 'degraded', 'ms']);
    assert.equal(result.caption, 'A sunny patio with a foosball table.');
  });

  test('when Gemini fails, the caption comes from the notes, or is empty without them', async () => {
    setClient(stubGemini(new Error('quota')));
    const withNotes = await describeImage('', { frames, scene: { id: 'courts-foosball' } });
    assert.equal(withNotes.degraded, true);
    assert.equal(withNotes.error, 'quota');
    assert.equal(withNotes.caption, 'Two friends play foosball on the patio. Red cap won 5 to 3 with a last-second goal.');
    const without = await describeImage('', { frames, scene: { id: 'somewhere-else' } });
    assert.deepEqual([without.caption, without.degraded, without.frames], ['', true, 3]);
  });

  test('mock mode answers from the notes too', async () => {
    const result = await describeImage('', { frames, scene: { id: 'courts-foosball' } });
    assert.equal(result.error, 'mock mode');
    assert.match(result.caption, /Red cap won 5 to 3/);
  });
});

describe('world hints', () => {
  test('every demo world has its labels, and memories use their place', () => {
    assert.deepEqual(WORLD_HINTS, {
      'the-courts': ['foosball table', 'ping pong table', 'chairs', 'the glass door'],
      'chess-room': ['the giant king and queen', 'the board', 'the wall TV', 'the UF banner'],
      kitchen: ['the fridge', 'the two stoves', 'the sink', 'the steel prep table', 'the bar tables', 'the plant'],
      'tilted-towers': ['the clock tower', 'the shops'],
      'brick-apartment': ['the kitchen', 'the windows', 'the door', 'the bed'],
      'old-house-kitchen': ['the granite island', 'the cherry cabinets', 'the steel fridge', 'the range and microwave', 'the sliding door', 'the sink window'],
    });
    assert.deepEqual(MEMORY_PLACES, { 'courts-foosball': 'the-courts', 'chess-match': 'chess-room', 'kitchen-cooking': 'kitchen' });
    assert.equal(worldHints({ id: 'kitchen-cooking' }), worldHints({ id: 'kitchen' }));
    assert.equal(worldHints({ id: 'judge-photo' }), '');
    assert.equal(worldHints(undefined), '');
    for (const id of ['constructor', 'toString', '__proto__', 42]) assert.equal(worldHints({ id }), '');
  });

  test('/hotspots folds the hints in only when the world has them', async () => {
    const gemini = stubGemini({ hotspots: [{ label: 'Foosball Table', box_2d: [400, 200, 600, 500], blurb: 'Where friendships end' }] });
    setClient(gemini);
    const result = await hotspots(jpeg('court'), { id: 'courts-foosball', name: 'Foosball', mode: 'video' });
    assert.equal(promptOf(gemini.calls[0]), 'Scene: Foosball; mode: video; caption: none. Find room hotspots. Things worth labelling here: foosball table, ping pong table, chairs, the glass door.');
    assert.deepEqual(result.hotspots[0], { label: 'foosball table', x: 0.35, y: 0.5, blurb: 'Where friendships end', box: [400, 200, 600, 500] });
    await hotspots(jpeg('room'), { id: 'judge-photo', name: 'Judge', mode: 'photo' });
    assert.equal(promptOf(gemini.calls[1]), 'Scene: Judge; mode: photo; caption: none. Find room hotspots.');
  });

  test('/narrate folds the hints in only when the world has them', async () => {
    const gemini = stubGemini({ answer: 'The king is taller than you. Act accordingly.' });
    setClient(gemini);
    const result = await narrate(jpeg('chess'), { id: 'chess-room', name: 'Chess lounge' });
    assert.equal(promptOf(gemini.calls[0]), 'Welcome someone to Chess lounge. Caption: none.\nThings worth labelling here: the giant king and queen, the board, the wall TV, the UF banner.');
    assert.equal(result.degraded, false);
    assert.match(result.speech, /^data:audio\/wav;base64,/);
    await narrate(jpeg('room'), { id: 'judge-photo', name: 'Judge' });
    assert.equal(promptOf(gemini.calls[1]), 'Welcome someone to Judge. Caption: none.');
  });
});

describe('clip notes', () => {
  test('a present file loads with every schema field', async () => {
    assert.deepEqual(await loadNotes('courts-foosball'), FOOSBALL);
  });

  test('a missing file, a bad id and a file with nothing usable are all null', async () => {
    assert.equal(await loadNotes('kitchen-cooking'), null);
    assert.equal(await loadNotes('../courts-foosball'), null);
    assert.equal(await loadNotes(''), null);
    // ids that could leave notes/ are refused before any read, even when the target exists
    const outside = `outside-notes-${process.pid}`;
    writeFileSync(join(dir, '..', `${outside}.json`), JSON.stringify(FOOSBALL));
    try { for (const id of [`../${outside}`, '../../etc/passwd', '..', '/etc/passwd', 'a/b', 'a\\b', 'x\u0000y', [`../${outside}`]]) assert.equal(await loadNotes(id), null); }
    finally { rmSync(join(dir, '..', `${outside}.json`), { force: true }); }
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(await loadNotes('a-list'), null);
    assert.equal(await loadNotes('only-people'), null);
    warn.mock.restore();
  });

  test('long fields are cut at a word', async () => {
    writeFileSync(join(dir, 'long-clip.json'), JSON.stringify({ oneLine: 'word '.repeat(200), people: ['a very long description '.repeat(30)] }));
    const notes = await loadNotes('long-clip');
    assert.ok(notes.oneLine.length <= 401 && notes.oneLine.endsWith('word…'));
    assert.ok(notes.people[0].length <= 241 && notes.people[0].endsWith('description…'));
  });

  test('a malformed file is skipped with one warning', async () => {
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(await loadNotes('chess-match'), null);
    assert.equal(await loadNotes('chess-match'), null);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /chess-match\.json/);
    warn.mock.restore();
  });

  test('a memory also gets the notes of its place', async () => {
    assert.deepEqual((await sceneNotes({ id: 'kitchen-cooking' })).map((item) => item.sceneId), ['kitchen']);
    assert.deepEqual((await sceneNotes({ id: 'courts-foosball' })).map((item) => item.sceneId), ['courts-foosball']);
    assert.deepEqual(await sceneNotes(null), []);
    assert.deepEqual(await sceneNotes({}), []);
  });

  test('notes become one line of context per file', async () => {
    const text = notesContext(await sceneNotes({ id: 'courts-foosball' }));
    assert.equal(text, 'Notes on courts-foosball (checked: Brianna): Two friends play foosball on the patio. Activity: foosball. People: grey hoodie on the left. red cap on the right. Outcome: Red cap won 5 to 3 with a last-second goal. Moments: 4s: first goal. 14s: the winning goal. Funny detail: Grey hoodie blamed the table.');
  });

  test('/ask and /narrate get the notes as context', async () => {
    const gemini = stubGemini((request) => (request.config.systemInstruction.includes('question') ? { question: 'who won?', answer: 'Red cap, five to three.', hotspot_label: '', hotspot_box_2d: [] } : { answer: 'Welcome back.' }));
    setClient(gemini);
    const answer = await ask(jpeg('court'), { question: 'who won?', scene: { id: 'courts-foosball', name: 'Foosball', mode: 'video' } });
    assert.equal(answer.answer, 'Red cap, five to three.');
    assert.match(promptOf(gemini.calls[0]), /^Scene: Foosball; mode: video; caption: none; known labels: none\.\nNotes on courts-foosball \(checked: Brianna\): .*Outcome: Red cap won 5 to 3 with a last-second goal\..*\nTrust these notes for who won.*\nPrevious turns:\nnone\nTyped question: who won\?$/);
    await narrate(jpeg('kitchen'), { id: 'kitchen-cooking', name: 'Cooking' });
    assert.match(promptOf(gemini.calls[1]), /Things worth labelling here: the fridge.*\nNotes on kitchen: .*Outcome: They made garlic fried rice\./s);
    await ask(jpeg('room'), { question: 'what is this?', scene: { id: 'judge-photo', name: 'Judge' } });
    assert.equal(promptOf(gemini.calls[2]), 'Scene: Judge; mode: photo; caption: none; known labels: none.\nPrevious turns:\nnone\nTyped question: what is this?');
  });
});

describe('fallback answers from notes', () => {
  const foosball = [FOOSBALL];

  test('"who won"-type questions answer from the outcome', () => {
    for (const question of ['who won?', 'Who is winning', 'who beat who', "what's the score"]) assert.deepEqual(answerFallback(question, {}, foosball), { answer: FOOSBALL.outcome, hotspot: null });
    assert.equal(answerFallback('what are they making?', {}, [KITCHEN]).answer, 'They made garlic fried rice');
    assert.notEqual(answerFallback('what is this table made of?', { name: 'Foosball' }, foosball).answer, FOOSBALL.outcome);
  });

  test('without notes the canned lines are unchanged', () => {
    assert.equal(answerFallback('who won?', {}).answer, 'I missed the final score. The controllers are refusing to comment.');
    assert.equal(answerFallback('what is that?', { name: 'Foosball' }, foosball).answer, 'I am still getting settled in Foosball. Ask me about something you can see.');
  });

  test('an unheard question in a memory with notes gets the short version', () => {
    assert.equal(answerFallback('', {}, foosball).answer, "Didn't catch that. Short version: Red cap won 5 to 3 with a last-second goal");
  });

  test('long outcomes are cut to 30 words', () => {
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    assert.equal(answerFallback('who won', {}, [{ ...FOOSBALL, outcome: long }]).answer.split(' ').length, 30);
  });

  test('when Gemini fails, /ask answers "who won?" from the notes', async () => {
    setClient(stubGemini(new Error('gemini timeout')));
    const result = await ask(jpeg('court'), { question: 'who won?', scene: { id: 'courts-foosball', name: 'Foosball', mode: 'video' } });
    assert.deepEqual([result.answer, result.degraded, result.error, result.speech], [FOOSBALL.outcome, true, 'gemini timeout', null]);
  });

  test('with no key at all, /ask answers from the notes', async () => {
    const result = await ask(jpeg('kitchen'), { question: 'what are they cooking?', scene: { id: 'kitchen-cooking' } });
    assert.deepEqual([result.answer, result.error], ['They made garlic fried rice', 'mock mode']);
  });
});

describe('speech models', () => {
  afterEach(() => { delete process.env.MODEL_TTS; resetTtsRest(); });
  test('a used-up speech model hands over to the next, and rests instead of being asked again', async () => {
    process.env.MODEL_TTS = 'tts-a, tts-b';
    const asked = [];
    setClient({ models: { async generateContent(request) {
      asked.push(request.model);
      if (request.model === 'tts-a') throw new Error('{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}');
      return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV } }] } }] };
    } } });
    const first = await speak('welcome to the kitchen');
    assert.ok(first.speech.startsWith('data:audio/wav;base64,'));
    await speak('who won the foosball game');
    assert.deepEqual(asked, ['tts-a', 'tts-b', 'tts-b']);
  });
  test('when every speech model fails, the last error comes back', async () => {
    process.env.MODEL_TTS = 'tts-a,tts-b';
    setClient({ models: { async generateContent() { throw new Error('503 UNAVAILABLE'); } } });
    await assert.rejects(speak('hello there, room'), /503/);
  });
});
