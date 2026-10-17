// Tag moments and the reality report: event parsing (units), round timing, who is "it",
// duplicate tags from referee retries, winners and ties, and reality.json parsing.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_ROUND_SECONDS, TagGame, formatClock, parseDuration, parseTagEvent, topScorer } from '../web/src/viewer/social/tag.ts';
import { parseRealityReport } from '../web/src/viewer/social/reality.ts';

describe('parseTagEvent', () => {
  test('the /ws roblox wrapper and bare events', () => {
    expect(parseTagEvent({ type: 'roblox', sceneId: 's', event: { type: 'tag', by: 'quest-1', target: 'rbx-12345', t: 1760715612.4 } })).toEqual({
      type: 'tag',
      by: 'quest-1',
      target: 'rbx-12345',
      t: 1760715612.4,
      targetName: undefined,
    });
    const r = parseTagEvent({ type: 'round', state: 'start', scores: { 'quest-1': 0, 'rbx-1': 3, bad: 'x' }, duration: 25 })!;
    expect(r).toMatchObject({ type: 'round', state: 'start', scores: { 'quest-1': 0, 'rbx-1': 3 }, duration: 25, t: null });
    expect(parseTagEvent({ type: 'round', state: 'paused' })).toBeNull();
    expect(parseTagEvent({ type: 'tag', by: 'x' })).toBeNull();
    expect(parseTagEvent('tag')).toBeNull();
  });

  test('units: millisecond times and durations become seconds', () => {
    expect(parseTagEvent({ type: 'tag', by: 'a', target: 'b', t: 1760715612400 })!.t).toBeCloseTo(1760715612.4, 3);
    expect(parseDuration(25000)).toBe(25);
    expect(parseDuration(90)).toBe(90);
    expect(parseDuration(-1)).toBeNull();
  });
});

describe('TagGame', () => {
  const mine = new Set(['quest-1']);
  const game = () => new TagGame(() => mine);

  test('round start: 90 s by default, the VR player is it, the clock counts down', () => {
    const g = game();
    const e = g.apply({ type: 'round', state: 'start', t: 1000, scores: { 'quest-1': 0, 'rbx-1': 3 }, duration: null, it: null, winner: null }, 1000.2);
    expect(e).toEqual({ kind: 'start', it: 'quest-1', youAreIt: true, duration: DEFAULT_ROUND_SECONDS });
    expect(g.remaining(1000)).toBe(90);
    expect(g.remaining(1060.5)).toBeCloseTo(29.5, 6);
    expect(g.remaining(1095)).toBe(0);
  });

  test('a skit round of 25 s, and a round whose end never came stops by itself', () => {
    const g = game();
    g.apply({ type: 'round', state: 'start', t: 50, scores: null, duration: 25, it: 'rbx-9', winner: null }, 50);
    expect(g.it).toBe('rbx-9');
    expect(g.remaining(70)).toBe(5);
    expect(g.remaining(90)).toBeNull();
    expect(g.active).toBe(false);
  });

  test('a referee retry within a second flashes once; my tags are marked mine', () => {
    const g = game();
    const a = g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-1', t: 10 }, 10);
    const b = g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-1', t: 10.4 }, 10.4);
    const c = g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-1', t: 12 }, 12);
    expect(a).toEqual({ kind: 'tagged', by: 'quest-1', target: 'rbx-1', mine: true, me: false });
    expect(b).toBeNull();
    expect(c).not.toBeNull();
    expect(g.tags.get('quest-1')).toBe(2);
    expect(g.apply({ type: 'tag', by: 'rbx-2', target: 'quest-1', t: 13 }, 13)).toMatchObject({ mine: false, me: true });
  });

  test('round end: winner from the event, else the top score, else a tie', () => {
    const g = game();
    g.apply({ type: 'round', state: 'start', t: 0, scores: { 'quest-1': 0 }, duration: 25, it: null, winner: null }, 0);
    const end = g.apply({ type: 'round', state: 'end', t: 25, scores: { 'quest-1': 4, 'rbx-1': 0, 'rbx-2': 2 }, duration: null, it: null, winner: null }, 25);
    expect(end).toMatchObject({ kind: 'end', winner: 'quest-1' });
    expect(g.active).toBe(false);
    expect(g.rows((id) => id).map((r) => [r.id, r.score, r.me])).toEqual([['quest-1', 4, true], ['rbx-2', 2, false], ['rbx-1', 0, false]]);
    expect(topScorer({ a: 2, b: 2 })).toBeNull();
    expect(topScorer({})).toBeNull();
    const g2 = game();
    expect(g2.apply({ type: 'round', state: 'end', t: 1, scores: { a: 1 }, duration: null, it: null, winner: 'rbx-7' }, 1)).toMatchObject({ winner: 'rbx-7' });
  });

  test('a tag moves the scoreboard at once: scores from the event, else +1 for the tagger and a life off the target', () => {
    const g = game();
    g.apply({ type: 'round', state: 'start', t: 0, scores: { 'quest-1': 0, 'rbx-1': 3, 'rbx-2': 3 }, duration: 25, it: null, winner: null }, 0);
    g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-1', t: 1 }, 1);
    expect(g.scores).toEqual({ 'quest-1': 1, 'rbx-1': 2, 'rbx-2': 3 });
    g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-2', t: 2, livesLeft: 1 }, 2);
    expect(g.scores).toEqual({ 'quest-1': 2, 'rbx-1': 2, 'rbx-2': 1 });
    g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-1', t: 3, scores: { 'quest-1': 7, 'rbx-1': 0 } }, 3);
    expect(g.scores).toEqual({ 'quest-1': 7, 'rbx-1': 0, 'rbx-2': 1 });
    // a referee retry within a second changes nothing
    expect(g.apply({ type: 'tag', by: 'quest-1', target: 'rbx-1', t: 3.4 }, 3.4)).toBeNull();
    expect(g.scores['quest-1']).toBe(7);
    expect(g.rows((id) => id)[0]).toMatchObject({ id: 'quest-1', score: 7, me: true });
    // the wire shape: scores and livesLeft come through parseTagEvent
    expect(parseTagEvent({ type: 'roblox', event: { type: 'tag', by: 'quest-1', target: 'rbx-1', t: 9, livesLeft: 2, scores: { 'quest-1': 1, x: 'no' } } })).toEqual({
      type: 'tag', by: 'quest-1', target: 'rbx-1', t: 9, targetName: undefined, scores: { 'quest-1': 1 }, livesLeft: 2,
    });
  });

  test('formatClock rounds up so 0:00 means done', () => {
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(0.2)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('parseRealityReport', () => {
  test('reads what pipeline/reality_split.py writes', () => {
    const r = parseRealityReport({ version: 1, world: 'world.spz', seen: { file: 'world-seen.spz', count: 300 }, imagined: { file: 'world-imagined.spz', count: 700 }, total: 1000, seenFraction: 0.3, camera: { source: 'input_camera' } })!;
    expect(r.seen.file).toBe('world-seen.spz');
    expect(r.imagined.count).toBe(700);
    expect(r.seenFraction).toBe(0.3);
    expect(r.camera?.source).toBe('input_camera');
  });

  test('rejects unsafe or missing part files and fills the fraction', () => {
    expect(parseRealityReport({ seen: { file: '../x.spz', count: 1 }, imagined: { file: 'b.spz', count: 1 } })).toBeNull();
    expect(parseRealityReport({ seen: { file: 'a.spz' } })).toBeNull();
    const r = parseRealityReport({ seen: { file: 'a.spz', count: 1 }, imagined: { file: 'b.ply', count: 3 } })!;
    expect(r.total).toBe(4);
    expect(r.seenFraction).toBe(0.25);
  });
});
