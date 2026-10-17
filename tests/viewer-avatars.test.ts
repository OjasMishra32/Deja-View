// The full-3D people of a Video memory: the media clock to animation time, clamping, the fades at track ends, the
// crossfade with the video layer, the recording camera track, and finding the files (web/src/viewer/avatar-clock.ts,
// avatar-files.ts, avatars.ts).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import {
  approach,
  AVATAR_TUNING,
  blendForDistance,
  CLIP_END_GUARD,
  clipTime,
  mediaTimeOf,
  parseCameraTrack,
  presence,
  trackIndex,
  trackPositionAt,
  trackQuaternionAt,
  type CameraSample,
} from '../web/src/viewer/avatar-clock.ts';
import { avatarSources, dirOf, joinUrl, parseAvatarDoc, selectPeople } from '../web/src/viewer/avatar-files.ts';
import { createAvatars } from '../web/src/viewer/avatars.ts';

const ROOT = resolve(import.meta.dir, '..');
const COURTS = join(ROOT, 'data', 'scenes', 'the-courts');

describe('clip time', () => {
  test('is media time minus start', () => {
    expect(clipTime(3.25, 0, 12.36)).toBeCloseTo(3.25, 9);
    expect(clipTime(5, 1.5, 12.36)).toBeCloseTo(3.5, 9);
  });

  test('clamps before the clip and holds just below its end (a looping action would wrap to 0)', () => {
    expect(clipTime(0.2, 1, 10)).toBe(0);
    expect(clipTime(-3, 0, 10)).toBe(0);
    expect(clipTime(10, 0, 10)).toBeCloseTo(10 - CLIP_END_GUARD, 9);
    expect(clipTime(42, 0, 10)).toBeLessThan(10);
    expect(clipTime(42, 0, 10)).toBeGreaterThan(10 - 1e-3);
  });

  test('holds inside the person track', () => {
    expect(clipTime(1, 0, 12, [2, 8])).toBe(2);
    expect(clipTime(5, 0, 12, [2, 8])).toBe(5);
    expect(clipTime(9, 0, 12, [2, 8])).toBe(8);
    // a track running past the clip still never reaches its end exactly
    expect(clipTime(20, 0, 12, [2, 30])).toBeCloseTo(12 - CLIP_END_GUARD, 9);
    // a bad range is ignored
    expect(clipTime(9, 0, 12, [8, 2])).toBe(9);
  });

  test('is exact and repeatable, so a paused or seeked element gives its frame', () => {
    const times = [0, 1 / 30, 2.5, 6.0333, 12.3583];
    for (const t of times) expect(clipTime(t, 0, 12.358333)).toBe(clipTime(t, 0, 12.358333));
    expect(clipTime(6.0333, 0, 12.358333)).toBe(6.0333);
  });

  test('non-finite media time reads as the start', () => {
    expect(clipTime(Number.NaN, 0, 10)).toBe(0);
    expect(mediaTimeOf({ currentTime: Number.NaN })).toBe(0);
    expect(mediaTimeOf(null)).toBe(0);
    expect(mediaTimeOf({ currentTime: 4.5 })).toBe(4.5);
  });
});

describe('presence at the ends of a track', () => {
  const F = AVATAR_TUNING.edgeFade;

  test('a track covering the whole media never fades (the clip loops)', () => {
    for (const t of [0, 0.01, 0.1, 6, 12.3, 12.3583, 12.3867]) expect(presence(t, 0, [0, 12.3583], 12.3583)).toBe(1);
    expect(presence(5, 0, null, 12)).toBe(1);
  });

  test('fades in over edgeFade after a late start', () => {
    const r: [number, number] = [4, 12];
    expect(presence(3.9, 0, r, 12)).toBe(0);
    expect(presence(4, 0, r, 12)).toBe(0);
    const mid = presence(4 + F / 2, 0, r, 12);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(presence(4 + F, 0, r, 12)).toBe(1);
    expect(presence(4 + F + 0.01, 0, r, 12)).toBe(1);
  });

  test('fades out over edgeFade before an early end', () => {
    const r: [number, number] = [0, 7];
    expect(presence(7 - F - 0.01, 0, r, 12)).toBe(1);
    expect(presence(7 - F / 2, 0, r, 12)).toBeGreaterThan(0.3);
    expect(presence(7 - F / 2, 0, r, 12)).toBeLessThan(0.7);
    expect(presence(7, 0, r, 12)).toBe(0);
    expect(presence(9, 0, r, 12)).toBe(0);
  });

  test('ramps are monotonic', () => {
    let last = -1;
    for (let t = 3.9; t <= 4.5; t += 0.01) {
      const p = presence(t, 0, [4, 12], 12);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  test('is measured on the animation clock (media time - start)', () => {
    // animation t = 3 + F/2: half way in
    expect(presence(5 + F / 2, 2, [3, 10], 10)).toBeCloseTo(0.5, 6);
    expect(presence(4.9, 2, [3, 10], 10)).toBe(0);
    expect(presence(5 + F, 2, [3, 10], 10)).toBe(1);
  });

  test('without a known media end, the end of a track fades', () => {
    expect(presence(12, 0, [0, 12], null)).toBe(0);
    expect(presence(12 - F - 0.01, 0, [0, 12], null)).toBe(1);
  });

  test('slack: an end within it of the media end counts as the media end', () => {
    expect(presence(12.3867, 0, [0, 12.3583], 12.3867, F, 0.05)).toBe(1);
    expect(presence(12.3867, 0, [0, 12.2], 12.3867, F, 0.05)).toBe(0);
  });
});

describe('crossfade with the video layer', () => {
  test('no people near the recording camera, all of them far from it', () => {
    expect(blendForDistance(0)).toBe(0);
    expect(blendForDistance(0.4)).toBe(0);
    expect(blendForDistance(0.8)).toBeCloseTo(0.5, 6);
    expect(blendForDistance(1.2)).toBe(1);
    expect(blendForDistance(7)).toBe(1);
    expect(blendForDistance(Infinity)).toBe(1);
    expect(blendForDistance(Number.NaN)).toBe(1);
  });

  test('rises monotonically between near and far', () => {
    let last = -1;
    for (let d = 0; d <= 1.6; d += 0.05) {
      const b = blendForDistance(d);
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
  });

  test('approach steps toward a target without overshoot', () => {
    expect(approach(0, 1, 0.25)).toBe(0.25);
    expect(approach(0.9, 1, 0.25)).toBe(1);
    expect(approach(1, 0, 0.4)).toBeCloseTo(0.6, 9);
    expect(approach(0.5, 0.5, 0.1)).toBe(0.5);
  });
});

describe('recording camera track', () => {
  const q0 = [0, 0, 0, 1];
  const qy = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]; // 90 deg about +Y
  const track: CameraSample[] = [
    { time: 0, position: [0, 1.6, 0], quaternion: q0 },
    { time: 1, position: [1, 1.6, 0], quaternion: qy },
    { time: 2, position: [1, 1.6, -2], quaternion: qy },
  ];

  test('index brackets the time', () => {
    expect(trackIndex(track, -1)).toBe(0);
    expect(trackIndex(track, 0)).toBe(0);
    expect(trackIndex(track, 0.5)).toBe(0);
    expect(trackIndex(track, 1)).toBe(1);
    expect(trackIndex(track, 1.99)).toBe(1);
    expect(trackIndex(track, 5)).toBe(2);
  });

  test('positions are linear between samples and held outside', () => {
    const v = { x: 0, y: 0, z: 0 };
    expect(trackPositionAt(track, 0.25, v)).toEqual({ x: 0.25, y: 1.6, z: 0 });
    trackPositionAt(track, 1.5, v);
    expect([v.x, v.y, v.z]).toEqual([1, 1.6, -1]);
    trackPositionAt(track, -3, v);
    expect([v.x, v.y, v.z]).toEqual([0, 1.6, 0]);
    trackPositionAt(track, 9, v);
    expect([v.x, v.y, v.z]).toEqual([1, 1.6, -2]);
  });

  test('orientation interpolates along the shorter arc and stays unit length', () => {
    const q = { x: 0, y: 0, z: 0, w: 1 };
    trackQuaternionAt(track, 0.5, q);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
    expect(2 * Math.atan2(q.y, q.w)).toBeCloseTo(Math.PI / 4, 1);
    // the same rotation with the opposite sign is not a detour through 360 degrees
    const flipped: CameraSample[] = [track[0], { ...track[1], quaternion: qy.map((c) => -c) }];
    const r = { x: 0, y: 0, z: 0, w: 1 };
    trackQuaternionAt(flipped, 0.5, r);
    expect(Math.abs(2 * Math.atan2(Math.abs(r.y), Math.abs(r.w)))).toBeCloseTo(Math.PI / 4, 1);
  });

  test('parses <clip>-poses.json, dropping malformed samples', () => {
    expect(parseCameraTrack(null)).toBeNull();
    expect(parseCameraTrack({ track: [] })).toBeNull();
    const t = parseCameraTrack({
      track: [
        { time: 1, position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
        { time: 0, position: [0, 2, 3], quaternion: [0, 0, 0, 1] },
        { time: 2, position: [1, 2], quaternion: [0, 0, 0, 1] },
        { time: 'x', position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
      ],
    });
    expect(t?.map((s) => s.time)).toEqual([0, 1]);
  });

  test("the-courts IMG_7373 track covers the clip at about the video's frame rate", () => {
    const doc = JSON.parse(readFileSync(join(COURTS, 'IMG_7373-poses.json'), 'utf8'));
    const t = parseCameraTrack(doc)!;
    expect(t.length).toBeGreaterThan(300);
    expect(t[0].time).toBeLessThanOrEqual(0.05);
    expect(t[t.length - 1].time).toBeGreaterThan(12);
    const v = trackPositionAt(t, 6, { x: 0, y: 0, z: 0 });
    // a handheld phone at standing height
    expect(v.y).toBeGreaterThan(1.2);
    expect(v.y).toBeLessThan(2);
  });
});

describe('finding the files', () => {
  test('joins relative files and passes absolute ones through', () => {
    expect(joinUrl('/data/scenes/a/', 'avatar-0.glb')).toBe('/data/scenes/a/avatar-0.glb');
    expect(joinUrl('/data/scenes/a', './avatar-0.glb')).toBe('/data/scenes/a/avatar-0.glb');
    expect(joinUrl('/data/scenes/a/', '/data/scenes/b/x.glb')).toBe('/data/scenes/b/x.glb');
    expect(joinUrl('/x/', 'https://cdn.example/y.glb')).toBe('https://cdn.example/y.glb');
    expect(dirOf('/data/scenes/a/people/avatar.json?v=2')).toBe('/data/scenes/a/people/');
  });

  test("a scene without the field: avatar.json in its own folder (the-courts)", () => {
    const s = avatarSources({ id: 'the-courts' })!;
    expect(s.base).toBe('/data/scenes/the-courts/');
    expect(s.json).toBe('/data/scenes/the-courts/avatar.json');
    expect(s.people).toBeNull();
    expect(s.poses).toBeNull();
    expect(s.start).toBeNull();
    expect(s.explicit).toBe(false);
  });

  test("a Video memory pointing at its place's folder (courts-foosball -> the-courts)", () => {
    const s = avatarSources({ id: 'courts-foosball', video: { avatars: { scene: 'the-courts', poses: 'IMG_7373-poses.json' } } })!;
    expect(s.base).toBe('/data/scenes/the-courts/');
    expect(s.json).toBe('/data/scenes/the-courts/avatar.json');
    expect(s.poses).toBe('/data/scenes/the-courts/IMG_7373-poses.json');
    expect(s.explicit).toBe(true);
  });

  test('a Video memory with its own files, a subset of people and a start override', () => {
    const s = avatarSources(
      { id: 'kitchen-cooking', video: { avatars: { json: 'people/avatar.json', people: [{ file: 'people/avatar-1.glb', id: 'person-1' }], start: 0.5 } } },
      '/data/scenes',
    )!;
    expect(s.base).toBe('/data/scenes/kitchen-cooking/');
    expect(s.json).toBe('/data/scenes/kitchen-cooking/people/avatar.json');
    expect(s.people).toEqual([{ url: '/data/scenes/kitchen-cooking/people/avatar-1.glb', id: 'person-1' }]);
    expect(s.start).toBe(0.5);
  });

  test("the list form avatar.json's sceneAddition writes: GLBs in the scene's own folder", () => {
    const s = avatarSources({ id: 'the-courts', video: { avatars: [{ file: 'avatar-0.glb', id: 'person-0' }, { file: 'avatar-1.glb' }] } })!;
    expect(s.json).toBe('/data/scenes/the-courts/avatar.json');
    expect(s.people).toEqual([
      { url: '/data/scenes/the-courts/avatar-0.glb', id: 'person-0' },
      { url: '/data/scenes/the-courts/avatar-1.glb', id: null },
    ]);
    expect(s.explicit).toBe(true);
  });

  test("a handheld memory's own camera track is the recording camera unless video.avatars.poses names one", () => {
    const own = avatarSources({ id: 'courts-foosball', video: { cameraTrack: 'camera-track.json', avatars: { scene: 'the-courts' } } })!;
    expect(own.base).toBe('/data/scenes/the-courts/');
    expect(own.poses).toBe('/data/scenes/courts-foosball/camera-track.json');
    const named = avatarSources({ id: 'courts-foosball', video: { cameraTrack: 'camera-track.json', avatars: { scene: 'the-courts', poses: 'IMG_7373-poses.json' } } })!;
    expect(named.poses).toBe('/data/scenes/the-courts/IMG_7373-poses.json');
    expect(avatarSources({ id: 'courts-foosball', video: { cameraTrack: '../x/camera-track.json' } })!.poses).toBeNull();
  });

  test('never leaves the scene folders', () => {
    expect(avatarSources({ id: 'x', video: { avatars: { scene: '../etc' } } })).toBeNull();
    expect(avatarSources({ id: 'x', video: { avatars: { scene: 'Bad Id' } } })).toBeNull();
    const s = avatarSources({ id: 'x', video: { avatars: { json: '../y/avatar.json', people: [{ file: '../../secret.glb' }, { file: 'ok.glb' }], poses: '../p.json' } } })!;
    expect(s.json).toBe('/data/scenes/x/avatar.json');
    expect(s.people).toEqual([{ url: '/data/scenes/x/ok.glb', id: null }]);
    expect(s.poses).toBeNull();
  });

  test("reads the-courts avatar.json: two people over the whole clip, start 0, credits", () => {
    const raw = JSON.parse(readFileSync(join(COURTS, 'avatar.json'), 'utf8'));
    const doc = parseAvatarDoc(raw, '/data/scenes/the-courts/avatar.json');
    expect(doc.start).toBe(0);
    expect(doc.mediaDuration).toBeCloseTo(12.3583, 4);
    expect(doc.fps).toBeGreaterThan(29);
    expect(doc.people.map((p) => p.id)).toEqual(['person-0', 'person-1']);
    expect(doc.people.map((p) => p.url)).toEqual(['/data/scenes/the-courts/avatar-0.glb', '/data/scenes/the-courts/avatar-1.glb']);
    for (const p of doc.people) {
      expect(p.timeRange).toEqual([0, 12.3583]);
      // whole-clip tracks: never faded
      for (const t of [0, 3, 12.3583, 12.3867]) expect(presence(t, doc.start, p.timeRange, doc.mediaDuration! - doc.start, AVATAR_TUNING.edgeFade, 2 / doc.fps!)).toBe(1);
    }
    expect(doc.credits.length).toBeGreaterThan(3);
  });

  test('tolerates a sparse or broken avatar.json', () => {
    const doc = parseAvatarDoc({ people: [{ file: 'a.glb' }, { file: 'a2.glb', id: 'p', timeRange: [3, 1] }, { id: 'nofile' }, null], start: 'x' }, '/s/avatar.json');
    expect(doc.start).toBe(0);
    expect(doc.mediaDuration).toBeNull();
    expect(doc.people).toEqual([
      { id: 'person-0', url: '/s/a.glb', timeRange: null },
      { id: 'p', url: '/s/a2.glb', timeRange: null },
    ]);
    expect(parseAvatarDoc(null, '/s/avatar.json').people).toEqual([]);
  });

  test("a named list takes its time ranges from avatar.json, and loads without it", () => {
    const doc = parseAvatarDoc({ people: [{ id: 'person-0', file: 'avatar-0.glb', timeRange: [1, 5] }, { id: 'person-1', file: 'avatar-1.glb', timeRange: [0, 9] }] }, '/data/scenes/c/avatar.json');
    const src = avatarSources({ id: 'c', video: { avatars: [{ file: 'avatar-1.glb' }, { file: 'other.glb', id: 'person-0' }] } })!;
    expect(selectPeople(src, doc)).toEqual([
      { id: 'person-1', url: '/data/scenes/c/avatar-1.glb', timeRange: [0, 9] },
      { id: 'person-0', url: '/data/scenes/c/other.glb', timeRange: [1, 5] },
    ]);
    expect(selectPeople(src, null)).toEqual([
      { id: 'person-0', url: '/data/scenes/c/avatar-1.glb', timeRange: null },
      { id: 'person-0', url: '/data/scenes/c/other.glb', timeRange: null },
    ]);
    expect(selectPeople(avatarSources({ id: 'c' })!, doc).length).toBe(2);
    expect(selectPeople(avatarSources({ id: 'c' })!, null)).toEqual([]);
  });
});

describe('createAvatars without files', () => {
  test('missing files: ready resolves, nothing drawn, the video layer keeps full opacity', async () => {
    const parent = new THREE.Group();
    const renderer = { capabilities: { getMaxAnisotropy: () => 1 } } as unknown as THREE.WebGLRenderer;
    const clock = { currentTime: 3 };
    const warn = console.warn, info = console.info;
    const logs: unknown[][] = [];
    console.warn = (...a: unknown[]) => logs.push(a);
    console.info = (...a: unknown[]) => logs.push(a);
    try {
      const h = createAvatars({ scene: { id: 'no-such-scene' }, video: clock, parent, renderer, root: 'http://127.0.0.1:9/data/scenes/' });
      expect(parent.children).toContain(h.object);
      await h.ready;
      expect(h.count).toBe(0);
      h.setBlend(5);
      h.update(1 / 72);
      expect(h.coverage).toBe(0);
      expect(h.recordingCamera(new THREE.Vector3())).toBeNull();
      expect(h.debug().people).toEqual([]);
      // a second handle for the same scene does not log again
      const n = logs.length;
      const h2 = createAvatars({ scene: { id: 'no-such-scene' }, video: clock, parent, renderer, root: 'http://127.0.0.1:9/data/scenes/' });
      await h2.ready;
      expect(logs.length).toBe(n);
      h.dispose();
      h2.dispose();
      expect(parent.children.length).toBe(0);
      h.update(0.1);
    } finally {
      console.warn = warn;
      console.info = info;
    }
  });
});
