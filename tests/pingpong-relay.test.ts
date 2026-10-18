// The cross-play ping pong relay (server/social/pingpong.ts): Roblox's table goes to the scene, the headset's
// events reach a waiting long-poll at once, bad messages are refused, and an old paddle is not handed on.
import { describe, expect, test } from 'bun:test';
import { PingPongRelay } from '../server/social/pingpong.ts';

describe('ping pong relay', () => {
  test("Roblox's table is published to the scene and kept for headsets that load later", () => {
    const sent: unknown[] = [];
    const r = new PingPongRelay((sceneId, ev) => sent.push([sceneId, ev.type]));
    r.fromRoblox('the-courts', { active: true, now: 1 });
    expect(sent).toEqual([['the-courts', 'pingpong']]);
    expect(r.latest('the-courts')?.active).toBe(true);
  });

  test('a join wakes the long-poll, and later polls only see newer events', async () => {
    const r = new PingPongRelay(() => {});
    const waiting = r.wait('the-courts', 0, 2000);
    expect(r.fromHeadset('the-courts', { kind: 'join', id: 'quest-1', name: 'Judge', side: 'B' })).toBeNull();
    const evs = await waiting;
    expect(evs.map((e) => [e.kind, e.side])).toEqual([['join', 'B']]);
    expect(evs[0]!.seq).toBeGreaterThan(1e12); // numbered from the clock
    expect(r.since('the-courts', evs[0]!.seq)).toEqual([]);
    expect(await r.wait('the-courts', evs[0]!.seq, 50)).toEqual([]);
  });

  test('an old event is not replayed to a game server that starts later', () => {
    const r = new PingPongRelay(() => {});
    r.fromHeadset('s', { kind: 'join', id: 'q', side: 'B' });
    const realNow = Date.now;
    Date.now = () => realNow() + 11_000;
    try {
      expect(r.since('s', 0)).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });

  test('shots need a time, a place, an aim and a pace; aim and pace are clamped', () => {
    const r = new PingPongRelay(() => {});
    expect(r.fromHeadset('s', { kind: 'shot', id: 'q', shot: { t: 5, p: [0, 1] } })).toContain('shot needs');
    expect(r.fromHeadset('s', { kind: 'shot', id: 'q', shot: { t: 5, p: [0, 1, 4], aim: 3, flight: 0.1 } })).toBeNull();
    const ev = r.since('s', 0)[0]!;
    expect(ev.shot).toEqual({ t: 5, p: [0, 1, 4], aim: 1, flight: 0.4, serve: false });
    expect(r.fromHeadset('s', { kind: 'dance', id: 'q' })).toContain('kind must be');
    expect(r.fromHeadset('s', { kind: 'join' })).toContain('id is required');
  });

  test('the paddle is handed on only while it is fresh', async () => {
    const r = new PingPongRelay(() => {});
    expect(r.fromHeadset('s', { kind: 'paddle', id: 'q', p: [0, 1, 5], n: [0, 1, 0], f: [0, 0, 1] })).toBeNull();
    expect(r.paddleOf('s')?.p).toEqual([0, 1, 5]);
    expect(r.fromHeadset('s', { kind: 'paddle', id: 'q', p: [0, 1] })).toContain('paddle needs');
  });
});
