// The headset interface's pure parts: captions and text fitting, the palm-up gesture, the arrival card's timeline,
// the transport's scrubber and follow math, and the mode names.

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { worldModeName } from '../web/src/viewer/hud.ts';
import { ARRIVAL_TIMING, arrivalAt } from '../web/src/viewer/xr-arrival.ts';
import { palmFacing, palmWants } from '../web/src/viewer/xr-menu.ts';
import { ellipsize, shortCaption, wrapText } from '../web/src/viewer/xr-text.ts';
import { headingOffset, scrubFraction } from '../web/src/viewer/xr-transport.ts';

/** 10 px per character. */
const mono = (t: string) => t.length * 10;

describe('captions', () => {
  test('the leading repeat of the name goes and only the first clause stays', () => {
    expect(
      shortCaption(
        'Infinity Hall Game Lawn',
        'The Infinity Hall Game Lawn, rebuilt from 25 photos and two phone clips: table tennis, foosball and the lawn outside.',
      ),
    ).toBe('Rebuilt from 25 photos and two phone clips');
    expect(shortCaption('Brick House apartment', 'The Brick House apartment, rebuilt from 71 frames of a free-camera tour: kitchen, bed. Walk the middle.')).toBe(
      'Rebuilt from 71 frames of a free-camera tour',
    );
  });
  test('short or unrelated captions are kept, missing ones are empty', () => {
    expect(shortCaption('Greyscale room', 'Sample world')).toBe('Sample world');
    expect(shortCaption('Kitchen', 'Sunday pancakes with the whole family.')).toBe('Sunday pancakes with the whole family');
    expect(shortCaption('Kitchen', undefined)).toBe('');
    expect(shortCaption('Kitchen', '   ')).toBe('');
  });
});

describe('text fitting', () => {
  test('ellipsize keeps text that fits and cuts the rest with an ellipsis', () => {
    expect(ellipsize('Lawn', 100, mono)).toBe('Lawn');
    const cut = ellipsize('Infinity Hall Game Lawn', 100, mono);
    expect(cut.endsWith('…')).toBe(true);
    expect(mono(cut)).toBeLessThanOrEqual(100);
  });
  test('wrapText fills lines greedily and ends the last one with an ellipsis when text is left', () => {
    expect(wrapText('one two three', 200, 2, mono)).toEqual(['one two three']);
    expect(wrapText('one two three four', 90, 2, mono)).toEqual(['one two', 'three fo…']);
    const lines = wrapText('a very long world name that will not fit on two short lines', 120, 2, mono);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith('…')).toBe(true);
    for (const l of lines) expect(mono(l)).toBeLessThanOrEqual(120);
  });
});

describe('palm-up gesture', () => {
  const head = new THREE.Vector3(0, 1.6, 0);
  const wrist = new THREE.Vector3(-0.1, 1.2, -0.35);
  const toHead = head.clone().sub(wrist).normalize();

  test('a palm facing the eyes or the sky scores high, a palm facing the floor low', () => {
    expect(palmFacing(toHead, wrist, head)).toBeCloseTo(1, 5);
    expect(palmFacing(new THREE.Vector3(0, 1, 0), wrist, head)).toBeGreaterThan(0.9);
    expect(palmFacing(new THREE.Vector3(0, -1, 0), wrist, head)).toBeLessThan(0);
    // the controller held normally: the left palm faces right
    expect(palmFacing(new THREE.Vector3(1, 0, 0), wrist, head)).toBeLessThan(0.3);
  });

  test('opens on a clear palm-up near the eyes, closes only well past it', () => {
    expect(palmWants(false, 0.8, 0.5, 0.9)).toBe(true);
    expect(palmWants(false, 0.5, 0.5, 0.9)).toBe(false); // not clear enough to open
    expect(palmWants(true, 0.5, 0.5, 0.9)).toBe(true); // but enough to stay open
    expect(palmWants(false, 0.9, 1.2, 0.9)).toBe(false); // arm's length away
    expect(palmWants(false, 0.9, 0.5, 0.2)).toBe(false); // not looking at it
    expect(palmWants(true, 0.2, 0.5, 0.9)).toBe(false); // palm turned down
  });
});

describe('arrival card', () => {
  test('fades in, holds for three seconds, fades out and is gone', () => {
    const { in: tin, hold, out } = ARRIVAL_TIMING;
    expect(hold).toBe(3);
    expect(arrivalAt(0)!.opacity).toBe(0);
    expect(arrivalAt(tin + 0.1)!.opacity).toBeCloseTo(1, 5);
    expect(arrivalAt(tin + hold - 0.1)!.opacity).toBeCloseTo(1, 5);
    expect(arrivalAt(tin + hold + out / 2)!.opacity).toBeGreaterThan(0);
    expect(arrivalAt(tin + hold + out / 2)!.opacity).toBeLessThan(1);
    expect(arrivalAt(tin + hold + out)).toBeNull();
    expect(arrivalAt(-1)).toBeNull();
  });
  test('rises into place and drifts up as it leaves', () => {
    expect(arrivalAt(0)!.rise).toBeLessThan(0);
    expect(arrivalAt(1)!.rise).toBeCloseTo(0, 5);
    expect(arrivalAt(ARRIVAL_TIMING.in + ARRIVAL_TIMING.hold + 0.7)!.rise).toBeGreaterThan(0);
  });
});

describe('transport', () => {
  test('the scrubber maps the track to 0..1 and clamps outside it', () => {
    expect(scrubFraction(0)).toBe(0);
    expect(scrubFraction(10_000)).toBe(1);
    const mid = scrubFraction(126 + 232 / 2);
    expect(mid).toBeCloseTo(0.5, 5);
  });
  test('heading offset is signed and wraps', () => {
    const head = new THREE.Vector3(0, 1.6, 0);
    expect(headingOffset(head, 0, new THREE.Vector3(0, 1, -1))).toBeCloseTo(0, 6);
    expect(headingOffset(head, 0, new THREE.Vector3(-1, 1, -1))).toBeCloseTo(Math.PI / 4, 6);
    expect(Math.abs(headingOffset(head, Math.PI - 0.1, new THREE.Vector3(0.1, 1, 1)))).toBeLessThan(0.25);
  });
});

describe('mode names', () => {
  test('only Photo and Video', () => {
    expect(worldModeName('photo')).toBe('Photo');
    expect(worldModeName('reconstruct')).toBe('Photo');
    expect(worldModeName('sample')).toBe('Photo');
    expect(worldModeName('video')).toBe('Video');
    expect(worldModeName('thirdwheel')).toBe('Video');
    expect(worldModeName('photo', true)).toBe('Video');
    expect(worldModeName(undefined)).toBe('Photo');
  });
});
