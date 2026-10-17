// scripts/video-notes.mjs with a stubbed Files API and model: upload, poll until ACTIVE, one JSON call, the notes
// file, and never replacing a file without --force.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { VIDEO_SCHEMA } from '../prompts.mjs';
import { videoNotes } from '../scripts/video-notes.mjs';

const REPLY = { oneLine: 'Two friends play giant chess', activity: 'chess', people: ['white shirt', 'black hoodie'], objects: ['giant king', 'board'], outcome: 'Black hoodie won with the queen', moments: [{ t: 3, what: 'first capture' }, { t: 17, what: 'checkmate' }], funnyDetail: 'The king fell over on its own', confidence: 'medium' };
let dir, clip;

function stubAi({ states = ['PROCESSING', 'ACTIVE'], reply = REPLY } = {}) {
  const log = { upload: [], get: 0, generate: [], deleted: [] };
  let step = 0;
  const file = () => ({ name: 'files/abc123', uri: 'https://files.test/abc123', mimeType: 'video/quicktime', state: states[Math.min(step, states.length - 1)] });
  return {
    log,
    files: {
      async upload(params) { log.upload.push(params); return file(); },
      async get({ name }) { assert.equal(name, 'files/abc123'); log.get++; step++; return file(); },
      async delete({ name }) { log.deleted.push(name); return {}; },
    },
    models: { async generateContent(request) { log.generate.push(request); return { text: JSON.stringify(reply) }; } },
  };
}
const quiet = () => {};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'guide-video-'));
  process.env.NOTES_DIR = join(dir, 'notes');
  clip = join(dir, 'chess.mov');
  writeFileSync(clip, 'not really a video');
});
beforeEach(() => rmSync(process.env.NOTES_DIR, { recursive: true, force: true }));
after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.NOTES_DIR; });

describe('video notes script', () => {
  test('uploads, waits for ACTIVE, asks once with the schema and writes the notes file', async () => {
    const ai = stubAi({ states: ['PROCESSING', 'PROCESSING', 'ACTIVE'] });
    const result = await videoNotes({ sceneId: 'chess-match', clip, ai, pollMs: 1, log: quiet });
    assert.equal(ai.log.upload.length, 1);
    assert.deepEqual(ai.log.upload[0], { file: clip, config: { mimeType: 'video/quicktime', displayName: 'chess-match.mov' } });
    assert.equal(ai.log.get, 2);
    assert.equal(ai.log.generate.length, 1);
    const [request] = ai.log.generate;
    assert.deepEqual(request.contents[0].parts[1], { fileData: { fileUri: 'https://files.test/abc123', mimeType: 'video/quicktime' } });
    assert.equal(request.config.responseMimeType, 'application/json');
    assert.equal(request.config.responseJsonSchema, VIDEO_SCHEMA);
    assert.deepEqual(ai.log.deleted, ['files/abc123']);
    const written = JSON.parse(readFileSync(join(process.env.NOTES_DIR, 'chess-match.json'), 'utf8'));
    assert.deepEqual(Object.keys(written), ['sceneId', 'clip', 'oneLine', 'activity', 'people', 'objects', 'outcome', 'moments', 'funnyDetail', 'checkedBy', 'confidence']);
    assert.deepEqual(written, { sceneId: 'chess-match', clip: 'chess.mov', ...REPLY, checkedBy: null });
    assert.deepEqual(result.notes, written);
  });

  test('an existing notes file is kept without --force, and nothing is uploaded', async () => {
    await videoNotes({ sceneId: 'chess-match', clip, ai: stubAi(), pollMs: 1, log: quiet });
    const path = join(process.env.NOTES_DIR, 'chess-match.json');
    const handChecked = JSON.stringify({ ...REPLY, outcome: 'White won, actually', checkedBy: 'Brianna' });
    writeFileSync(path, handChecked);
    const ai = stubAi();
    const result = await videoNotes({ sceneId: 'chess-match', clip, ai, pollMs: 1, log: quiet });
    assert.equal(result.skipped, true);
    assert.equal(ai.log.upload.length, 0);
    assert.equal(readFileSync(path, 'utf8'), handChecked);
    await videoNotes({ sceneId: 'chess-match', clip, ai, force: true, pollMs: 1, log: quiet });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).outcome, REPLY.outcome);
  });

  test('a failed upload throws, still deletes the file on Google, and writes nothing', async () => {
    const ai = stubAi({ states: ['PROCESSING', 'FAILED'] });
    await assert.rejects(videoNotes({ sceneId: 'chess-match', clip, ai, pollMs: 1, log: quiet }), /video processing failed/);
    assert.deepEqual(ai.log.deleted, ['files/abc123']);
    assert.equal(existsSync(join(process.env.NOTES_DIR, 'chess-match.json')), false);
  });

  test('bad input is refused before anything is uploaded', async () => {
    const ai = stubAi();
    await assert.rejects(videoNotes({ sceneId: '../chess', clip, ai, log: quiet }), /scene id/);
    await assert.rejects(videoNotes({ sceneId: 'chess-match', clip: join(dir, 'chess.gif'), ai, log: quiet }), /unknown clip type/);
    await assert.rejects(videoNotes({ sceneId: 'chess-match', clip: join(dir, 'missing.mp4'), ai, log: quiet }), /no such clip/);
    await assert.rejects(videoNotes({ sceneId: 'chess-match', clip, ai: stubAi({ reply: { people: [] } }), pollMs: 1, log: quiet }), /no usable notes/);
    assert.equal(ai.log.upload.length, 0);
  });
});
