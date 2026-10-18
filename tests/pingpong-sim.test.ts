// The headset's ping pong physics against the Roblox original: one rally's numbers from
// roblox/src/shared/PingPongSim.luau (run under Lune; Roblox vectors are 32-bit, hence the tolerance).
import { describe, expect, test } from 'bun:test';
import { assistReturn, flyTo, newState, step, v3 } from '../web/src/viewer/social/pingpong-sim.ts';

describe('ping pong physics port', () => {
  test('the assist return matches the Luau one', () => {
    const v = assistReturn(v3(0.3, 1.2, -5.5), 'B', 0.4, 0.7, 9.78, 5.44);
    expect(v.x).toBeCloseTo(0.897142828, 4);
    expect(v.y).toBeCloseTo(10.75, 4);
    expect(v.z).toBeCloseTo(13.985714912, 4);
  });

  test('a spinning rally bounces on the same step and ends in the same place', () => {
    const p0 = v3(0.3, 1.2, -5.5);
    const st = newState(p0, assistReturn(p0, 'B', 0.4, 0.7, 9.78, 5.44), 100, v3(20, 0, 5));
    const events: string[] = [];
    for (let i = 1; i <= 300; i++) {
      const ev = step(st, 1 / 240, 9.78, 5.44);
      if (ev.table || ev.net || ev.dead) events.push(`${i} ${ev.table ?? 'nil'} ${ev.net ?? 'nil'} ${ev.dead ?? 'nil'}`);
    }
    expect(events).toEqual(['162 B nil nil']);
    expect(st.p.x).toBeCloseTo(1.158445716, 2);
    expect(st.p.y).toBeCloseTo(0.571678221, 2);
    expect(st.p.z).toBeCloseTo(9.18264389, 2);
    expect(st.live).toBe(true);
  });

  test('flyTo stops at the time asked and reports the bounce', () => {
    const p0 = v3(0.3, 1.2, -5.5);
    const st = newState(p0, assistReturn(p0, 'B', 0.4, 0.7, 9.78, 5.44), 0);
    const evs = flyTo(st, 1.0, 9.78, 5.44);
    expect(st.t).toBeCloseTo(1.0, 6);
    expect(evs.some((e) => e.table === 'B')).toBe(true);
  });
});
