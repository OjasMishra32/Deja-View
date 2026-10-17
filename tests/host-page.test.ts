// The /host page's logic without a browser (web/src/host-model.ts): the live feed in plain words, the pinned demo
// order, and storage that may throw in a private window.
import { describe, expect, test } from 'bun:test';
import type { HealthInfo, Scene, ServerEvent } from '../shared/types.ts';
import {
  describeEvent,
  FEED_MAX,
  parsePins,
  pin,
  progressText,
  pushFeed,
  readStored,
  SLOTS,
  slotOf,
  unpin,
  whoIs,
  writeStored,
  type FeedContext,
  type FeedItem,
} from '../web/src/host-model.ts';

const scenes = new Map<string, Pick<Scene, 'status' | 'name'>>([
  ['game-night-k3x9a', { status: 'ready', name: 'Game night' }],
  ['judge-photo-bbbbb', { status: 'running', name: "Judge's photo" }],
]);
const people = new Map([
  ['quest-1', 'Judge'],
  ['rbx-12345', 'shivin'],
]);
const ctx: FeedContext = {
  previous: (id) => scenes.get(id),
  sceneName: (id) => scenes.get(id)?.name ?? id,
  personName: (id) => people.get(id),
  now: () => 1000,
};

const text = (ev: ServerEvent, c: FeedContext = ctx) => describeEvent(ev, c)?.text ?? null;

function scene(id: string, extra: Partial<Scene>): Scene {
  return { id, name: scenes.get(id)?.name ?? id, mode: 'rentfree', status: 'running', createdAt: '', updatedAt: '', ...extra };
}

describe('feed lines', () => {
  test('Roblox: tag and round, with names', () => {
    expect(text({ type: 'roblox', sceneId: 's', event: { type: 'tag', by: 'quest-1', target: 'rbx-12345', t: 1 } })).toBe('Judge tagged shivin');
    expect(text({ type: 'roblox', sceneId: 's', event: { type: 'tag', by: 'quest-1', target: 'rbx-999', targetName: 'brianna', t: 1 } })).toBe('Judge tagged brianna');
    expect(text({ type: 'roblox', sceneId: 's', event: { type: 'round', state: 'start', duration: 25, t: 1 } })).toBe('Tag round started (25 s)');
    expect(text({ type: 'roblox', sceneId: 's', event: { type: 'round', state: 'end', scores: { 'quest-1': 4, 'rbx-12345': 0 }, t: 1 } })).toBe('Round over. Winner: Judge (4)');
    expect(text({ type: 'roblox', sceneId: 's', event: { type: 'round', state: 'end', winner: 'rbx-12345', t: 1 } })).toBe('Round over. Winner: shivin');
    expect(text({ type: 'roblox', sceneId: 's', event: { type: 'dance', t: 1 } })).toBeNull();
  });

  test('a note, cues', () => {
    const note = { id: 'n_1', sceneId: 's', author: 'Brianna', text: "Seb's seat. He was too scared to show up.", x: 0, y: 1.4, z: 0, createdAt: '' };
    expect(text({ type: 'note', sceneId: 's', note })).toBe("Brianna left a note: “Seb's seat. He was too scared to show up.”");
    expect(text({ type: 'cue', action: 'reality', on: true, by: 'host', at: 1 })).toBe('Reality check on (host)');
    expect(text({ type: 'cue', action: 'labels', on: false, at: 1 })).toBe('Labels off');
    expect(text({ type: 'cue', action: 'load', sceneId: 'game-night-k3x9a', by: 'bot', at: 1 })).toBe('Headset told to open Game night (bot)');
  });

  test('scenes: only changes of status, never progress ticks', () => {
    expect(text({ type: 'scene', scene: scene('judge-photo-bbbbb', { status: 'running', progress: 0.6 }) })).toBeNull();
    expect(text({ type: 'scene', scene: scene('judge-photo-bbbbb', { status: 'ready' }) })).toBe("Judge's photo is ready");
    expect(text({ type: 'scene', scene: scene('judge-photo-bbbbb', { status: 'failed', error: "We couldn't build this world." }) })).toBe("Judge's photo failed: We couldn't build this world.");
    expect(text({ type: 'scene', scene: scene('new-one-ccccc', { name: 'Dorm room', status: 'queued' }) })).toBe('New world started: Dorm room');
    expect(text({ type: 'scene_deleted', id: 'game-night-k3x9a' })).toBe('Game night was deleted');
  });

  test('health: only when the GPU worker wakes up or goes to sleep', () => {
    const h = (alive: boolean) => ({ hpg: { online: true, user: 'x', worker: { alive } } }) as HealthInfo;
    expect(text({ type: 'health', health: h(true) })).toBeNull();
    expect(text({ type: 'health', health: h(true) }, { ...ctx, previousHealth: h(false) })).toBe('GPU worker woke up');
    expect(text({ type: 'health', health: h(false) }, { ...ctx, previousHealth: h(true) })).toBe('GPU worker went to sleep');
    expect(text({ type: 'health', health: h(true) }, { ...ctx, previousHealth: h(true) })).toBeNull();
  });

  test('unknown people get plain words, never a raw id', () => {
    const none = { personName: () => undefined };
    expect(whoIs('quest-2', none)).toBe('the headset');
    expect(whoIs('rbx-1', none)).toBe('a Roblox player');
    expect(whoIs('web-7f3a19c2', none)).toBe('a browser visitor');
  });

  test('the feed keeps the newest 20', () => {
    let feed: FeedItem[] = [];
    for (let i = 0; i < 30; i++) feed = pushFeed(feed, { kind: 'cue', text: `#${i}`, at: i });
    expect(feed.length).toBe(FEED_MAX);
    expect(feed[0]!.text).toBe('#29');
    expect(pushFeed(feed, null)).toBe(feed);
  });
});

describe('demo order', () => {
  test('three slots in skit order', () => {
    expect(SLOTS.map((s) => s.label)).toEqual(['Game night', 'Fortnite', 'Backup world']);
  });

  test('pin, move and unpin', () => {
    let p = parsePins(null);
    expect(p).toEqual([null, null, null]);
    p = pin(p, 0, 'game-night-k3x9a');
    p = pin(p, 1, 'fortnite-q8w2e');
    expect(slotOf(p, 'fortnite-q8w2e')).toBe(1);
    // pinning a world into another slot moves it
    p = pin(p, 2, 'fortnite-q8w2e');
    expect(p).toEqual(['game-night-k3x9a', null, 'fortnite-q8w2e']);
    p = unpin(p, 0);
    expect(p).toEqual([null, null, 'fortnite-q8w2e']);
    expect(parsePins(JSON.stringify(p))).toEqual(p);
  });

  test('anything broken in storage reads as an empty order', () => {
    expect(parsePins('{not json')).toEqual([null, null, null]);
    expect(parsePins(JSON.stringify(['../etc', 42, 'ok-aaaaa', 'extra-bbbbb']))).toEqual([null, null, 'ok-aaaaa']);
    expect(parsePins(JSON.stringify({ slots: ['a-aaaaa'] }))).toEqual(['a-aaaaa', null, null]);
  });

  test('storage that throws (a private window) never breaks the page', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readStored('dv.host.pins', throwing)).toBeNull();
    expect(writeStored('dv.host.pins', '[]', throwing)).toBe(false);
    expect(writeStored('dv.host.key', null, throwing)).toBe(false);
    expect(readStored('dv.host.pins', null)).toBeNull();
    const mem = new Map<string, string>();
    const ok = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    expect(writeStored('k', 'v', ok)).toBe(true);
    expect(readStored('k', ok)).toBe('v');
    expect(writeStored('k', null, ok)).toBe(true);
    expect(readStored('k', ok)).toBeNull();
  });
});

describe('progress text', () => {
  test('stage with a percentage while building', () => {
    expect(progressText({ status: 'running', stage: 'Generating the room', progress: 0.6 })).toBe('Generating the room · 60%');
    expect(progressText({ status: 'queued' })).toBe('Waiting in line');
    expect(progressText({ status: 'running', stage: 'Reading your photo', progress: 0 })).toBe('Reading your photo');
    expect(progressText({ status: 'ready', stage: 'Ready', progress: 1 })).toBe('Ready');
  });
});
