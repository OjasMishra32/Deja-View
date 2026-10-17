// GET /api/host/status aggregation (server/host.ts): each dependency up and down, a dependency that throws or hangs,
// the public-link probe and its cache, the scenes summary and who is in the open world.
import { describe, expect, test } from 'bun:test';
import type { HealthInfo, Scene } from '../shared/types.ts';
import type { WorkerStatus } from '../server/hpg.ts';
import { createHostStatus, gpuName, WARM_COMMAND, type HostDeps } from '../server/host.ts';
import type { CallResult } from '../server/integrations/config.ts';
import type { GuideStatus } from '../server/integrations/guide.ts';
import { PresenceStore } from '../server/social/presence.ts';

const NOW = Date.parse('2026-10-17T22:00:00Z');

function health(over: { online?: boolean; alive?: boolean; gpu?: string; lastBeat?: string } = {}): HealthInfo {
  return {
    ok: true,
    version: '0.1.0',
    https: true,
    lan: ['https://192.168.1.20:8787'],
    hpg: {
      online: over.online ?? true,
      user: 'someone',
      worker: { alive: over.alive ?? true, ...(over.gpu ? { gpu: over.gpu } : {}), ...(over.lastBeat ? { lastBeat: over.lastBeat } : {}) },
    },
    space: { available: false },
    local: { python: true },
  };
}

function scene(id: string, extra: Partial<Scene> = {}): Scene {
  return { id, name: id, mode: 'rentfree', status: 'ready', createdAt: '2026-10-17T20:00:00Z', updatedAt: '2026-10-17T20:00:00Z', thumb: 'thumb.jpg', ...extra };
}

const guideStatus = (over: Partial<GuideStatus> = {}): GuideStatus => ({ enabled: true, host: '127.0.0.1:8795', up: true, lastOkAt: NOW, lastError: null, lastMs: { ask: 1400 }, calls: 3, failures: 0, ...over });
const reply = (kind: CallResult['kind'], body: unknown = null, status = 200): CallResult => ({ kind, status, body, text: body === null ? null : JSON.stringify(body), ms: 12 });

function fakeGuide(r: CallResult | (() => Promise<CallResult>), enabled = true, st: Partial<GuideStatus> = {}): NonNullable<HostDeps['guide']> {
  let calls = 0;
  return {
    enabled,
    status: () => guideStatus({ enabled, ...st }),
    health: async () => {
      calls++;
      return typeof r === 'function' ? r() : r;
    },
    get calls() {
      return calls;
    },
  } as NonNullable<HostDeps['guide']> & { calls: number };
}

function dsStatus(push: { up: boolean | null; lastError?: string | null } | null, notes: { up: boolean | null; lastError?: string | null } = { up: null }) {
  const forwarder = { enabled: true, host: 'dejaview-live.app.space', up: push?.up ?? null, lastOkAt: push?.up ? NOW - 400 : null, lastError: push?.lastError ?? null, pushes: push?.up ? 120 : 0, failures: push?.up === false ? 4 : 0, skippedInFlight: 0, skippedBackoff: 0, scenes: [], inFlight: 0 };
  const n = { enabled: true, host: 'dejaview-live.app.space', up: notes.up, lastOkAt: notes.up ? NOW - 1000 : null, lastError: notes.lastError ?? null, scenes: [], polls: 4, failures: 0 };
  return { status: () => ({ enabled: !!push, host: push ? 'dejaview-live.app.space' : null, presence: forwarder, notes: n }) };
}

function base(over: Partial<HostDeps> = {}): HostDeps {
  return {
    health: async () => health({ gpu: 'NVIDIA RTX 6000 Ada Generation', lastBeat: new Date(NOW - 12_000).toISOString() }),
    worker: async () => ({ alive: true, gpu: 'NVIDIA RTX 6000 Ada Generation', host: 'c0900a-s1', lastBeat: new Date(NOW - 12_000).toISOString(), age: 12, status: 'idle' }),
    listScenes: async () => [scene('game-night-k3x9a', { name: 'Game night', mode: 'thirdwheel' })],
    guide: fakeGuide(reply('ok', { ok: true, gemini: 'ok', mock: false })),
    deepspace: dsStatus({ up: true }, { up: true }),
    publicUrl: async () => 'https://brave-otter.trycloudflare.com',
    fetch: async () => Response.json({ ok: true }),
    now: () => NOW,
    waitMs: 200,
    ...over,
  };
}

describe('host status: GPU worker', () => {
  test('awake: the GPU by name, idle, heartbeat age; no warm route, the command instead', async () => {
    const st = await createHostStatus(base())();
    expect(st.checks.gpu).toEqual({ state: 'ok', text: 'Awake on RTX 6000 Ada', detail: 'idle · heartbeat 12 s ago' });
    expect(st.gpu).toMatchObject({ online: true, alive: true, gpu: 'RTX 6000 Ada', host: 'c0900a-s1', age: 12, status: 'idle', canWarm: false, warmCommand: WARM_COMMAND });
    expect(WARM_COMMAND).toBe('hpg/tw.sh start 3');
  });

  test('asleep: red, with the command to run on HiPerGator', async () => {
    const st = await createHostStatus(base({ worker: async () => ({ alive: false, lastBeat: new Date(NOW - 3 * 3600_000).toISOString(), age: 3 * 3600 }) }))();
    expect(st.checks.gpu.state).toBe('bad');
    expect(st.checks.gpu.text).toBe('Asleep');
    expect(st.checks.gpu.detail).toBe('last heartbeat 3 h ago');
    expect(st.checks.gpu.command).toBe('hpg/tw.sh start 3');
    expect(st.checks.gpu.where).toBe('on HiPerGator');
    expect(st.gpu.alive).toBe(false);
  });

  test('no HiPerGator session: red, says to log in again', async () => {
    const st = await createHostStatus(base({ health: async () => health({ online: false, alive: false }), worker: async () => ({ alive: false }) }))();
    expect(st.checks.gpu.state).toBe('bad');
    expect(st.checks.gpu.text).toContain('no HiPerGator session');
    expect(st.checks.gpu.fix).toContain('Log in to HiPerGator');
    expect(st.gpu.online).toBe(false);
  });

  test('warming up and busy', async () => {
    const warm = await createHostStatus(base({ worker: async () => ({ alive: true, gpu: 'L4', age: 3, status: 'loading' }) }))();
    expect(warm.checks.gpu).toMatchObject({ state: 'warn', text: 'Warming up', detail: 'L4 · heartbeat 3 s ago' });
    const busy = await createHostStatus(base({ worker: async () => ({ alive: true, gpu: 'L4', age: 1, status: 'busy' }) }))();
    expect(busy.checks.gpu).toEqual({ state: 'ok', text: 'Awake on L4', detail: 'building now · heartbeat 1 s ago' });
  });

  test('without the worker probe, HealthInfo alone is enough (age from lastBeat)', async () => {
    const st = await createHostStatus(base({ worker: undefined }))();
    expect(st.checks.gpu.state).toBe('ok');
    expect(st.checks.gpu.detail).toBe('heartbeat 12 s ago');
  });

  test('a health probe that throws or hangs reads "can\'t check", then keeps the last good answer', async () => {
    let mode: 'ok' | 'throw' | 'hang' = 'throw';
    const deps = base({
      worker: undefined,
      health: async () => {
        if (mode === 'throw') throw new Error('ssh exploded');
        if (mode === 'hang') return new Promise<HealthInfo>(() => {});
        return health({ alive: false });
      },
    });
    const status = createHostStatus(deps);
    const first = await status();
    expect(first.checks.gpu.state).toBe('warn');
    expect(first.checks.gpu.text).toBe("Can't check yet");
    expect(first.gpu.online).toBeNull();
    mode = 'ok';
    expect((await status()).checks.gpu.text).toBe('Asleep');
    mode = 'hang';
    const t0 = performance.now();
    const third = await status();
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(third.checks.gpu.text).toBe('Asleep');
  });

  test('gpuName trims the vendor noise', () => {
    expect(gpuName('NVIDIA B200')).toBe('B200');
    expect(gpuName('NVIDIA RTX PRO 6000 Blackwell Server Edition')).toBe('RTX PRO 6000 Blackwell Server Edition');
    expect(gpuName('')).toBeUndefined();
  });
});

describe('host status: guide', () => {
  test('ok: Gemini answering, with the last answer time', async () => {
    const st = await createHostStatus(base())();
    expect(st.checks.guide).toEqual({ state: 'ok', text: 'OK', detail: 'Gemini answering · last answer 1.4 s' });
    expect(st.guide).toMatchObject({ enabled: true, host: '127.0.0.1:8795', reachable: true, gemini: 'ok' });
  });

  test('degraded and mock mode are amber, with what to do', async () => {
    const deg = await createHostStatus(base({ guide: fakeGuide(reply('ok', { ok: true, gemini: 'degraded' })) }))();
    expect(deg.checks.guide.state).toBe('warn');
    expect(deg.checks.guide.text).toBe('Degraded: canned answers');
    expect(deg.checks.guide.fix).toContain('key and quota');
    const mock = await createHostStatus(base({ guide: fakeGuide(reply('ok', { ok: true, gemini: 'off', mock: true })) }))();
    expect(mock.checks.guide).toMatchObject({ state: 'warn', text: 'Mock mode' });
  });

  test('down: red, says to start it', async () => {
    const st = await createHostStatus(base({ guide: fakeGuide({ ...reply('offline'), detail: 'ECONNREFUSED' }, true, { up: false, lastError: 'ECONNREFUSED' }) }))();
    expect(st.checks.guide.state).toBe('bad');
    expect(st.checks.guide.text).toBe('Down');
    expect(st.checks.guide.detail).toBe('127.0.0.1:8795 · ECONNREFUSED');
    expect(st.checks.guide.fix).toContain('port 8795');
    expect(st.guide.reachable).toBe(false);
    expect(st.guide.lastError).toBe('ECONNREFUSED');
  });

  test('an HTML page from a proxy counts as down; a 404 from the guide itself counts as reachable', async () => {
    const html = await createHostStatus(base({ guide: fakeGuide(reply('bad-response', null, 502)) }))();
    expect(html.checks.guide.state).toBe('bad');
    const http = await createHostStatus(base({ guide: fakeGuide(reply('http', { error: 'nope' }, 404)) }))();
    expect(http.checks.guide.state).toBe('ok');
  });

  test('not configured: off; no guide at all: off', async () => {
    expect((await createHostStatus(base({ guide: fakeGuide(reply('offline'), false) }))()).checks.guide).toMatchObject({ state: 'off', text: 'Off' });
    const none = await createHostStatus(base({ guide: undefined }))();
    expect(none.checks.guide.state).toBe('off');
    expect(none.guide.reachable).toBeNull();
  });

  test('the /health probe is cached for 5 s unless forced', async () => {
    const g = fakeGuide(reply('ok', { gemini: 'ok' })) as NonNullable<HostDeps['guide']> & { calls: number };
    const status = createHostStatus(base({ guide: g }));
    await status();
    await status();
    expect(g.calls).toBe(1);
    await status(true);
    expect(g.calls).toBe(2);
  });
});

describe('host status: DeepSpace', () => {
  test('up: pushes and notes synced', async () => {
    const st = await createHostStatus(base())();
    expect(st.checks.deepspace.state).toBe('ok');
    expect(st.checks.deepspace.detail).toBe('120 pushes · notes synced · last ok 0 s ago');
    expect(st.deepspace.push).toMatchObject({ up: true, pushes: 120 });
  });

  test('nobody in a world yet: standing by, not red', async () => {
    const st = await createHostStatus(base({ deepspace: dsStatus({ up: null }, { up: null }) }))();
    expect(st.checks.deepspace).toMatchObject({ state: 'idle', text: 'Standing by' });
  });

  test('a refused key is called out; an unreachable app says where to look', async () => {
    const key = await createHostStatus(base({ deepspace: dsStatus({ up: false, lastError: 'HTTP 401: DeepSpace refused the key (check DS_KEY)' }, { up: true }) }))();
    expect(key.checks.deepspace).toMatchObject({ state: 'bad', text: 'Push failing' });
    expect(key.checks.deepspace.fix).toContain('DS_KEY');
    const gone = await createHostStatus(base({ deepspace: dsStatus({ up: false, lastError: 'ECONNREFUSED' }, { up: false, lastError: 'ECONNREFUSED' }) }))();
    expect(gone.checks.deepspace.text).toBe('Down');
    expect(gone.checks.deepspace.fix).toContain('dejaview-live.app.space');
    const notes = await createHostStatus(base({ deepspace: dsStatus({ up: true }, { up: false, lastError: 'timed out' }) }))();
    expect(notes.checks.deepspace.text).toBe('Notes failing');
  });

  test('DS_URL unset: off; a status() that throws: off too', async () => {
    expect((await createHostStatus(base({ deepspace: dsStatus(null) }))()).checks.deepspace).toMatchObject({ state: 'off' });
    const broken = { status: () => { throw new Error('boom'); } };
    expect((await createHostStatus(base({ deepspace: broken as never }))()).checks.deepspace.state).toBe('off');
  });
});

describe('host status: public link', () => {
  test('live: answers, host and time', async () => {
    const asked: string[] = [];
    const st = await createHostStatus(base({ fetch: async (u) => (asked.push(String(u)), Response.json({ ok: true })) }))();
    expect(asked).toEqual(['https://brave-otter.trycloudflare.com/api/health']);
    expect(st.tunnel).toMatchObject({ url: 'https://brave-otter.trycloudflare.com', reachable: true });
    expect(st.checks.tunnel.state).toBe('ok');
    expect(st.checks.tunnel.text).toBe('Live');
    expect(st.checks.tunnel.detail).toStartWith('brave-otter.trycloudflare.com · ');
  });

  test('no tunnel running: red, with the command', async () => {
    const st = await createHostStatus(base({ publicUrl: async () => null }))();
    expect(st.tunnel).toEqual({ url: null, reachable: null });
    expect(st.checks.tunnel).toMatchObject({ state: 'bad', text: 'No public link', command: 'bun run tunnel', where: 'on this Mac' });
  });

  test("a Cloudflare error page (HTML, 530) or a refused connection: not answering", async () => {
    const html = await createHostStatus(base({ fetch: async () => new Response('<html>530</html>', { status: 530, headers: { 'Content-Type': 'text/html' } }) }))();
    expect(html.tunnel.reachable).toBe(false);
    expect(html.checks.tunnel).toMatchObject({ state: 'bad', text: 'Not answering' });
    const refused = await createHostStatus(base({ fetch: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } }))();
    expect(refused.checks.tunnel.state).toBe('bad');
  });

  test('the probe is cached per address for 15 s; a new address is probed at once; refresh forces it', async () => {
    let url = 'https://a-a.trycloudflare.com';
    const asked: string[] = [];
    const status = createHostStatus(base({ publicUrl: async () => url, fetch: async (u) => (asked.push(String(u)), Response.json({ ok: true })) }));
    await status();
    await status();
    expect(asked.length).toBe(1);
    url = 'https://b-b.trycloudflare.com';
    await status();
    expect(asked.length).toBe(2);
    await status(true);
    expect(asked.length).toBe(3);
  });
});

describe('host status: worlds and people', () => {
  test('scenes: newest first, counts, public mode names, thumbnail paths, progress', async () => {
    const st = await createHostStatus(
      base({
        listScenes: async () => [
          scene('old-photo-aaaaa', { name: 'Old', createdAt: '2026-10-17T10:00:00Z' }),
          scene('judge-photo-bbbbb', { name: "Judge's photo", status: 'running', stage: 'Generating the room', progress: 0.6, createdAt: '2026-10-17T21:59:00Z', thumb: 'thumb.jpg' }),
          scene('game-night-k3x9a', { name: 'Game night', mode: 'thirdwheel', createdAt: '2026-10-17T18:00:00Z' }),
          scene('broken-ccccc', { status: 'failed', error: "We couldn't build this world. Try again in a minute.", createdAt: '2026-10-17T19:00:00Z' }),
          scene('sample-greyscale-room', { mode: 'sample', thumb: undefined, createdAt: '2026-10-17T00:00:00Z' }),
        ],
      }),
    )();
    expect(st.scenes).toMatchObject({ total: 5, ready: 3, building: 1, failed: 1 });
    expect(st.scenes.list.map((s) => s.id)).toEqual(['judge-photo-bbbbb', 'broken-ccccc', 'game-night-k3x9a', 'old-photo-aaaaa', 'sample-greyscale-room']);
    expect(st.scenes.list[0]).toMatchObject({ mode: 'photo', status: 'running', stage: 'Generating the room', progress: 0.6, thumb: '/data/scenes/judge-photo-bbbbb/thumb.jpg' });
    expect(st.scenes.list[2]!.mode).toBe('video');
    expect(st.scenes.list[4]).toMatchObject({ mode: 'sample', thumb: null });
    expect(JSON.stringify(st)).not.toContain('thirdwheel');
  });

  test('people: the open world is where the headset is; Roblox players and browsers counted there', async () => {
    let t = NOW;
    const presence = new PresenceStore({ now: () => t });
    const p = (id: string, name: string, kind: 'vr' | 'roblox' | 'web') => ({ id, name, kind, x: 0, y: 0, z: 0, yaw: 0 });
    presence.upsert('game-night-k3x9a', p('quest-1', 'Judge', 'vr'));
    presence.upsert('game-night-k3x9a', p('rbx-12345', 'shivin', 'roblox'));
    presence.upsert('game-night-k3x9a', p('rbx-67890', 'brianna', 'roblox'));
    // a busier world elsewhere does not win over the headset's
    for (let i = 0; i < 4; i++) presence.upsert('fortnite-q8w2e', p(`web-0000000${i}`, `Visitor ${i}`, 'web'));
    presence.publishEvent('game-night-k3x9a', { type: 'round', state: 'start', duration: 25 });
    const st = await createHostStatus(base({ presence, listScenes: async () => [scene('game-night-k3x9a', { name: 'Game night' })] }))();
    expect(st.presence).toMatchObject({ sceneId: 'game-night-k3x9a', sceneName: 'Game night', headset: true, people: 3, vr: 1, roblox: 2, web: 0 });
    expect(st.presence.round).toMatchObject({ state: 'start', duration: 25 });
    expect(st.presence.scenes).toContainEqual({ sceneId: 'fortnite-q8w2e', people: 4, roblox: 0 });
    expect(st.checks.roblox).toEqual({ state: 'ok', text: '2 in the world', detail: 'shivin, brianna' });
    expect(st.checks.people).toEqual({ state: 'ok', text: '3 here', detail: '1 headset · 2 Roblox in Game night' });

    // everyone silent for 3 s is gone
    t += 3500;
    const later = await createHostStatus(base({ presence }))();
    expect(later.presence.people).toBe(0);
    expect(later.checks.people).toMatchObject({ state: 'idle', text: 'Nobody in a world' });
    expect(later.checks.roblox).toMatchObject({ state: 'idle', text: 'No players yet' });
  });

  test('people but no headset: amber, with how to open the world on the Quest', async () => {
    const presence = new PresenceStore({ now: () => NOW });
    presence.upsert('game-night-k3x9a', { id: 'rbx-1', name: 'shivin', kind: 'roblox', x: 0, y: 0, z: 0, yaw: 0 });
    const st = await createHostStatus(base({ presence }))();
    expect(st.presence.sceneId).toBe('game-night-k3x9a');
    expect(st.checks.people.state).toBe('warn');
    expect(st.checks.people.fix).toContain('follow=1');
  });

  test('no presence layer: both off; every part still answers', async () => {
    const st = await createHostStatus(base({ presence: undefined, guide: undefined, deepspace: undefined, publicUrl: undefined, worker: undefined }))();
    expect(st.ok).toBe(true);
    expect(st.checks.roblox.state).toBe('off');
    expect(st.checks.people.state).toBe('off');
    expect(st.presence.people).toBe(0);
    expect(st.lan).toEqual(['https://192.168.1.20:8787']);
    expect(st.t).toBe(NOW / 1000);
  });
});
