// Memory Keys in the guide: in a private memory, a visitor hears about the place only; the family hears everything.
// scene.viewer comes from the server (server/auth/memory-keys.ts), from the person's sign-in.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

const jpeg = `data:image/jpeg;base64,${Buffer.from('room').toString('base64')}`;
let dir, setClient, ask, narrate, sceneNotes, VISITOR_RULE;

function stub() {
  const calls = [];
  return { calls, models: { async generateContent(request) { calls.push(request); return { text: JSON.stringify({ answer: 'A warm kitchen.', question: 'who is that?' }) }; } } };
}
const promptOf = (call) => JSON.stringify(call.contents ?? call);

before(async () => {
  for (const name of ['MOCK_GEMINI', 'GEMINI_API_KEY']) delete process.env[name];
  dir = mkdtempSync(join(tmpdir(), 'guide-keys-'));
  process.env.NOTES_DIR = dir;
  writeFileSync(join(dir, 'old-home.json'), JSON.stringify({
    sceneId: 'old-home', oneLine: 'Grandma Rosa bakes bread with Leo', activity: 'baking bread in the kitchen',
    people: ['Grandma Rosa in a blue apron', 'Leo at the counter'], objects: ['oven', 'wooden table'],
    outcome: 'Leo burns the first loaf', moments: [{ t: 4, what: 'Rosa laughs' }], funnyDetail: 'flour on the cat',
  }));
  ({ setClient, ask, narrate } = await import('../gemini.mjs'));
  ({ sceneNotes } = await import('../notes.mjs'));
  ({ VISITOR_RULE } = await import('../prompts.mjs'));
});
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setClient(null));

describe('memory keys: what the guide may say', () => {
  test('a visitor gets the place only: no people, no names, no outcome', async () => {
    const [visitor] = await sceneNotes({ id: 'old-home', viewer: { access: 'visitor' } });
    assert.deepEqual(visitor.people, []);
    assert.equal(visitor.outcome, '');
    assert.equal(visitor.oneLine, '');
    assert.deepEqual(visitor.moments, []);
    assert.equal(visitor.activity, 'baking bread in the kitchen');
    assert.deepEqual(visitor.objects, ['oven', 'wooden table']);
    const [family] = await sceneNotes({ id: 'old-home', viewer: { access: 'family' } });
    assert.equal(family.outcome, 'Leo burns the first loaf');
    const [open] = await sceneNotes({ id: 'old-home' });
    assert.equal(open.people.length, 2); // a public memory is unchanged
  });

  test('a visitor\'s question reaches Gemini with the privacy rule and none of the family\'s details', async () => {
    const gemini = stub();
    setClient(gemini);
    await ask(jpeg, { question: 'who is that?', scene: { id: 'old-home', name: 'Old home', viewer: { access: 'visitor' } } });
    const sent = promptOf(gemini.calls[0]);
    assert.ok(sent.includes('belongs to its family'), 'the visitor rule is in the prompt');
    for (const secret of ['Rosa', 'Leo', 'burns', 'flour on the cat']) assert.ok(!sent.includes(secret), `${secret} must not reach a visitor`);
  });

  test('the family\'s question carries the notes as before', async () => {
    const gemini = stub();
    setClient(gemini);
    await ask(jpeg, { question: 'who is that?', scene: { id: 'old-home', name: 'Old home', viewer: { access: 'family' } } });
    const sent = promptOf(gemini.calls[0]);
    assert.ok(sent.includes('Rosa') && sent.includes('Leo burns the first loaf'));
    assert.ok(!sent.includes(VISITOR_RULE.slice(0, 40)));
  });

  test('a visitor\'s greeting follows the same rule', async () => {
    const gemini = stub();
    setClient(gemini);
    await narrate(jpeg, { id: 'old-home', name: 'Old home', viewer: { access: 'visitor' } });
    const sent = promptOf(gemini.calls[0]);
    assert.ok(sent.includes('belongs to its family') && !sent.includes('Rosa'));
  });
});
