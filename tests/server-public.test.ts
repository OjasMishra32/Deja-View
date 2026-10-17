// What the API shows the world: public mode names and the full status shape (contracts 4.1, 4.2), no cluster
// account in /api/health, and the server's listener and hot-reload settings (contracts 2.1, 2.3; docs/DEMO.md).
import { describe, expect, test } from 'bun:test';
import type { HealthInfo, Scene } from '../shared/types.ts';
import { hmrFrom, httpPortFrom } from '../server/config.ts';
import { isPipelineCaption, isVideoScene, publicMode, publicScene } from '../server/copy.ts';
import { publicHealth } from '../server/health.ts';

const base: Scene = { id: 's-aaaaa', name: 'S', mode: 'rentfree', status: 'ready', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' };

describe('publicScene', () => {
  test('mode is photo, video or sample', () => {
    expect(publicMode('rentfree')).toBe('photo');
    expect(publicMode('reconstruct')).toBe('photo');
    expect(publicMode('thirdwheel')).toBe('video');
    expect(publicMode('video')).toBe('video');
    expect(publicMode('sample')).toBe('sample');
    expect(publicScene({ ...base, mode: 'thirdwheel' }).mode).toBe('video');
  });

  test('a ready scene reads stage Ready, progress 1, error null (hand-written scene.json too)', () => {
    expect(publicScene(base)).toMatchObject({ mode: 'photo', stage: 'Ready', progress: 1, error: null });
    expect(publicScene({ ...base, status: 'queued' })).toMatchObject({ stage: 'Queued', progress: 0, error: null });
    expect(publicScene({ ...base, status: 'running', stage: 'Generating the room', progress: 0.4 })).toMatchObject({ stage: 'Generating the room', progress: 0.4, error: null });
    expect(publicScene({ ...base, status: 'failed', error: 'We could not build this.' })).toMatchObject({ stage: 'Failed', error: 'We could not build this.' });
    expect(publicScene({ ...base, status: 'failed' }).error).toBeString();
    // idempotent: mapping twice changes nothing
    const once = publicScene({ ...base, mode: 'thirdwheel' });
    expect(publicScene(once as never)).toEqual(once);
  });

  test('a Video memory is a Video memory by its mode or its video layer', () => {
    expect(isVideoScene({ ...base, mode: 'thirdwheel' })).toBe(true);
    expect(isVideoScene({ ...base, video: {} as never })).toBe(true);
    expect(isVideoScene(base)).toBe(false);
    expect(isVideoScene(null)).toBe(false);
  });

  test('pipeline captions say how a world was made, not what is in it', () => {
    expect(isPipelineCaption('The room is built from the background of your clip. 40 seconds of video with sound.')).toBe(true);
    expect(isPipelineCaption('Generated from one photo: the rest of the room was imagined.')).toBe(true);
    expect(isPipelineCaption('Sample world')).toBe(true);
    expect(isPipelineCaption("Tilted Towers' most famous house")).toBe(false);
    expect(isPipelineCaption('A small lounge with a grey couch facing a TV.')).toBe(false);
    expect(isPipelineCaption(undefined)).toBe(false);
  });
});

describe('/api/health', () => {
  test('leaves the cluster account out', () => {
    const h: HealthInfo = { ok: true, version: '1', https: true, lan: [], hpg: { online: false, user: 'someone', worker: { alive: false } }, space: { available: false }, local: { python: true } };
    const p = publicHealth(h);
    expect('user' in p.hpg).toBe(false);
    expect(p.hpg.online).toBe(false);
    expect(h.hpg.user).toBe('someone'); // the server's own copy keeps it
  });
});

describe('listeners and hot reload', () => {
  test('plain HTTP on 8788 next to https by default; HTTP_PORT moves it or turns it off', () => {
    expect(httpPortFrom({}, true, 8787)).toBe(8788);
    expect(httpPortFrom({}, false, 8787)).toBeNull();
    expect(httpPortFrom({ HTTP_PORT: '9000' }, false, 8787)).toBe(9000);
    expect(httpPortFrom({ HTTP_PORT: '0' }, true, 8787)).toBeNull();
    expect(httpPortFrom({ HTTP_PORT: 'off' }, true, 8787)).toBeNull();
    expect(httpPortFrom({ HTTP_PORT: '8787' }, true, 8787)).toBeNull();
    expect(httpPortFrom({ HTTP_PORT: 'banana' }, true, 8787)).toBeNull();
  });

  test('no hot reload in production or for the https (Quest) server unless forced', () => {
    expect(hmrFrom({}, true, false)).toBe(false);
    expect(hmrFrom({}, false, false)).toBe(true);
    expect(hmrFrom({}, false, true)).toBe(false);
    expect(hmrFrom({ THIRDWHEEL_HMR: '1' }, false, true)).toBe(true);
    expect(hmrFrom({ THIRDWHEEL_HMR: '0' }, false, false)).toBe(false);
    expect(hmrFrom({ THIRDWHEEL_HMR: '1' }, true, false)).toBe(false);
  });
});
