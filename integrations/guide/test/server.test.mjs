// The HTTP routes in-process, with a stubbed Gemini client: frames validation on /describe, image-only calls as
// before, and "who won?" from the notes when Gemini fails. No network beyond 127.0.0.1, no key.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

const jpeg = (text) => `data:image/jpeg;base64,${Buffer.from(text).toString('base64')}`;
const decoded = (part) => Buffer.from(part.inlineData.data, 'base64').toString();
let base, dir, server, setClient, DESCRIBE_SYSTEM, FRAMES_SYSTEM;

function stubGemini(reply) {
  const calls = [];
  return { calls, models: { async generateContent(request) { calls.push(request); if (reply instanceof Error) throw reply; return { text: JSON.stringify(reply) }; } } };
}
async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  for (const name of ['MOCK_GEMINI', 'GEMINI_API_KEY', 'GUIDE_KEY']) delete process.env[name];
  process.env.PORT = '0';
  dir = mkdtempSync(join(tmpdir(), 'guide-notes-'));
  process.env.NOTES_DIR = dir;
  writeFileSync(join(dir, 'chess-match.json'), JSON.stringify({ sceneId: 'chess-match', oneLine: 'A giant chess game in the lounge', outcome: 'Black won with the queen', people: [], objects: [], moments: [] }));
  ({ setClient } = await import('../gemini.mjs'));
  ({ DESCRIBE_SYSTEM, FRAMES_SYSTEM } = await import('../prompts.mjs'));
  ({ server } = await import('../server.mjs'));
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await once(server, 'close'); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => setClient(null));

describe('POST /describe', () => {
  test('frames go to Gemini in order and come back as a caption', async () => {
    const gemini = stubGemini({ caption: 'Two friends play giant chess. Black is winning.' });
    setClient(gemini);
    const frames = ['a', 'b', 'c'].map(jpeg);
    const { status, body } = await post('/describe', { image: jpeg('thumb'), frames, scene: { id: 'chess-match', name: 'Chess' } });
    assert.equal(status, 200);
    assert.deepEqual([body.caption, body.frames, body.degraded], ['Two friends play giant chess. Black is winning.', 3, false]);
    const [request] = gemini.calls;
    assert.equal(request.config.systemInstruction, FRAMES_SYSTEM);
    assert.deepEqual(request.contents[0].parts.slice(1).map(decoded), ['a', 'b', 'c']);
  });

  test('more than 8 frames keep 8, first and last included', async () => {
    const gemini = stubGemini({ caption: 'x' });
    setClient(gemini);
    const frames = Array.from({ length: 12 }, (_, i) => jpeg(`f${i}`));
    const { status } = await post('/describe', { frames });
    assert.equal(status, 200);
    const sent = gemini.calls[0].contents[0].parts.slice(1).map(decoded);
    assert.equal(sent.length, 8);
    assert.deepEqual([sent[0], sent[7]], ['f0', 'f11']);
    assert.deepEqual(sent, [...sent].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  });

  test('bad frames and a bad image next to frames are 400s', async () => {
    setClient(stubGemini({ caption: 'x' }));
    for (const frames of ['nope', [42], ['data:text/plain;base64,AAAA'], [jpeg('ok'), 'not a data url']]) {
      const { status, body } = await post('/describe', { frames });
      assert.equal(status, 400);
      assert.equal(body.error, 'frames must be an array of base64 image data URLs');
    }
    const { status, body } = await post('/describe', { frames: [jpeg('ok')], image: 'nope' });
    assert.deepEqual([status, body.error], [400, 'image must be a base64 data URL']);
  });

  test('image-only calls behave as before', async () => {
    const gemini = stubGemini({ caption: 'A lounge with a giant chess board.' });
    setClient(gemini);
    const ok = await post('/describe', { image: jpeg('room') });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body), ['caption', 'degraded', 'ms']);
    assert.equal(gemini.calls[0].config.systemInstruction, DESCRIBE_SYSTEM);
    const empty = await post('/describe', { image: jpeg('room'), frames: [] });
    assert.deepEqual(Object.keys(empty.body), ['caption', 'degraded', 'ms']);
    assert.deepEqual(await post('/describe', {}), { status: 400, body: { error: 'image required' } });
    assert.deepEqual(await post('/describe', { image: 'nope' }), { status: 400, body: { error: 'image must be a base64 data URL' } });
  });

  test('when Gemini fails, frames fall back to the notes', async () => {
    setClient(stubGemini(new Error('quota')));
    const { status, body } = await post('/describe', { frames: [jpeg('a')], scene: 'chess-match' });
    assert.equal(status, 200);
    assert.deepEqual([body.caption, body.degraded], ['A giant chess game in the lounge. Black won with the queen.', true]);
  });
});

describe('POST /ask', () => {
  test('"who won?" is answered from the notes when Gemini fails', async () => {
    setClient(stubGemini(new Error('gemini timeout')));
    const { status, body } = await post('/ask', { image: jpeg('chess'), question: 'who won?', scene: { id: 'chess-match', name: 'Chess', mode: 'video' } });
    assert.equal(status, 200);
    assert.deepEqual([body.question, body.answer, body.degraded], ['who won?', 'Black won with the queen', true]);
  });
});
