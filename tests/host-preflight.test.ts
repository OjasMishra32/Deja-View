// scripts/preflight.ts: the checklist logic with fakes (no server, no ssh, no network). The statuses come from the
// real aggregator in server/host.ts, so the preflight and the /host page read the same checks.
import { describe, expect, test } from 'bun:test';
import type { HealthInfo, Scene } from '../shared/types.ts';
import { hpgConfig } from '../server/hpg.ts';
import { createHostStatus, type HostDeps, type HostStatus } from '../server/host.ts';
import { PresenceStore } from '../server/social/presence.ts';
import {
  buildChecklist,
  DEFAULT_BASE,
  exitCode,
  findCloudflared,
  formatChecklist,
  gatherPreflight,
  preflightOptions,
  sessionCheckArgv,
  type PreflightDeps,
  type PreflightInput,
} from '../scripts/preflight.ts';

const NOW = Date.parse('2026-10-17T22:00:00Z');
const GB = 1024 ** 3;

const HEALTH = (online = true, alive = true): HealthInfo => ({
  ok: true,
  version: '0.1.0',
  https: true,
  lan: [],
  hpg: { online, user: 'someone', worker: { alive, gpu: 'L4', lastBeat: new Date(NOW - 5000).toISOString() } },
  space: { available: false },
  local: { python: true },
});

function scene(id: string, extra: Partial<Scene> = {}): Scene {
  return {
    id,
    name: id,
    mode: 'rentfree',
    status: 'ready',
    createdAt: '2026-10-17T20:00:00Z',
    updatedAt: '2026-10-17T20:00:00Z',
    world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'flashworld' },
    ...extra,
  };
}

const SCENES = [scene('game-night-k3x9a', { name: 'Game night' }), scene('fortnite-q8w2e', { name: 'Fortnite' }), scene('backup-room-aaaaa', { name: 'Backup room' })];

async function hostStatus(over: Partial<HostDeps> = {}): Promise<HostStatus> {
  const presence = new PresenceStore({ now: () => NOW });
  presence.upsert('game-night-k3x9a', { id: 'quest-1', name: 'Judge', kind: 'vr', x: 0, y: 0, z: 0, yaw: 0 });
  return createHostStatus({
    health: async () => HEALTH(),
    listScenes: async () => SCENES,
    presence,
    guide: { enabled: true, status: () => ({ enabled: true, host: '127.0.0.1:8795', up: true, lastOkAt: NOW, lastError: null, lastMs: {}, calls: 0, failures: 0 }), health: async () => ({ kind: 'ok', status: 200, body: { gemini: 'ok' }, text: '', ms: 9 }) },
    deepspace: {
      status: () => ({
        enabled: true,
        host: 'dejaview-live.app.space',
        presence: { enabled: true, host: 'dejaview-live.app.space', up: true, lastOkAt: NOW, lastError: null, pushes: 40, failures: 0, skippedInFlight: 0, skippedBackoff: 0, scenes: [], inFlight: 0 },
        notes: { enabled: true, host: 'dejaview-live.app.space', up: true, lastOkAt: NOW, lastError: null, scenes: [], polls: 3, failures: 0 },
      }),
    },
    publicUrl: async () => 'https://brave-otter.trycloudflare.com',
    fetch: async () => Response.json({ ok: true }),
    now: () => NOW,
    waitMs: 200,
    ...over,
  })();
}

async function input(over: Partial<PreflightInput> = {}, status?: HostStatus): Promise<PreflightInput> {
  return {
    base: DEFAULT_BASE,
    status: { ok: true, value: status ?? (await hostStatus()) },
    scenes: SCENES,
    demoScenes: ['game-night-k3x9a', 'fortnite-q8w2e', 'backup-room-aaaaa'],
    hpgSession: { ok: true, detail: 'open (~/.ssh/cm-hpg)' },
    hpgLogin: 'ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=24h someone@hpg.example',
    cloudflared: '/opt/homebrew/bin/cloudflared',
    freeBytes: 40 * GB,
    dataDir: '/tmp/dv-data',
    ...over,
  };
}

const item = (items: ReturnType<typeof buildChecklist>, name: string) => items.find((i) => i.name === name)!;

describe('preflight checklist', () => {
  test('everything green: every row ✓, exit 0', async () => {
    const items = buildChecklist(await input());
    expect(items.map((i) => i.name)).toEqual([
      'Server',
      'GPU worker',
      'HiPerGator session',
      'Guide',
      'DeepSpace',
      'Public link',
      'cloudflared',
      'Demo world 1',
      'Demo world 2',
      'Demo world 3',
      'Free disk',
      'Headset in a world',
    ]);
    expect(items.every((i) => i.ok)).toBe(true);
    expect(exitCode(items)).toBe(0);
    const text = formatChecklist(items);
    expect(text).toContain('✓ GPU worker');
    expect(text).not.toContain('✗');
    expect(text).toContain('Everything is ready.');
  });

  test('GPU asleep + guide down + no tunnel: three blockers, each with its one-line fix', async () => {
    const st = await hostStatus({
      health: async () => HEALTH(true, false),
      guide: { enabled: true, status: () => ({ enabled: true, host: '127.0.0.1:8795', up: false, lastOkAt: null, lastError: 'ECONNREFUSED', lastMs: {}, calls: 1, failures: 1 }), health: async () => ({ kind: 'offline', status: 0, body: null, text: null, ms: 1, detail: 'ECONNREFUSED' }) },
      publicUrl: async () => null,
    });
    const items = buildChecklist(await input({}, st));
    const failed = items.filter((i) => !i.ok);
    expect(failed.map((i) => i.name)).toEqual(['GPU worker', 'Guide', 'Public link']);
    expect(failed.every((i) => i.blocker && i.fix)).toBe(true);
    expect(item(items, 'GPU worker')).toMatchObject({ command: 'hpg/tw.sh start 3', where: 'on HiPerGator' });
    expect(item(items, 'Public link')).toMatchObject({ command: 'bun run tunnel' });
    expect(exitCode(items)).toBe(1);
    const text = formatChecklist(items);
    expect(text).toContain('✗ GPU worker');
    expect(text).toMatch(/→ Start the warm worker on HiPerGator.*on HiPerGator: hpg\/tw\.sh start 3/);
    expect(text).toContain('3 blockers to fix before the demo');
    // one line per fix
    expect(text.split('\n').filter((l) => l.includes('→')).length).toBe(3);
  });

  test('a degraded guide, no headset yet and a low disk are ✗ but do not block', async () => {
    const st = await hostStatus({
      presence: new PresenceStore({ now: () => NOW }),
      guide: { enabled: true, status: () => ({ enabled: true, host: 'g', up: true, lastOkAt: NOW, lastError: null, lastMs: {}, calls: 1, failures: 0 }), health: async () => ({ kind: 'ok', status: 200, body: { gemini: 'degraded' }, text: '', ms: 3 }) },
    });
    const items = buildChecklist(await input({ freeBytes: 6 * GB }, st));
    expect(item(items, 'Guide')).toMatchObject({ ok: false, blocker: false });
    expect(item(items, 'Headset in a world')).toMatchObject({ ok: false, blocker: false });
    expect(item(items, 'Free disk')).toMatchObject({ ok: false, blocker: false });
    expect(exitCode(items)).toBe(0);
    const text = formatChecklist(items);
    expect(text).toContain('(can wait)');
    expect(text).toContain('Ready to go.');
  });

  test('under 2 GB free blocks', async () => {
    const items = buildChecklist(await input({ freeBytes: 1.5 * GB }));
    expect(item(items, 'Free disk')).toMatchObject({ ok: false, blocker: true });
    expect(item(items, 'Free disk').detail).toContain('1.5 GB free');
    expect(exitCode(items)).toBe(1);
  });

  test('HiPerGator session closed and cloudflared missing: blockers with the commands', async () => {
    const items = buildChecklist(await input({ hpgSession: { ok: false, detail: 'Control socket connect(/x): No such file or directory' }, cloudflared: null }));
    expect(item(items, 'HiPerGator session')).toMatchObject({ ok: false, blocker: true, where: 'on this Mac' });
    expect(item(items, 'HiPerGator session').command).toContain('ControlPersist=24h');
    expect(item(items, 'cloudflared')).toMatchObject({ ok: false, blocker: true, command: 'brew install cloudflared' });
    expect(exitCode(items)).toBe(1);
  });

  test('demo worlds: one missing, one still building, one failed', async () => {
    const scenes = [
      scene('game-night-k3x9a', { name: 'Game night' }),
      scene('fortnite-q8w2e', { name: 'Fortnite', status: 'running', progress: 0.6, world: undefined }),
      scene('backup-room-aaaaa', { name: 'Backup room', status: 'failed', error: "We couldn't build this world. Try again in a minute.", world: undefined }),
    ];
    const items = buildChecklist(await input({ scenes, demoScenes: ['game-night-k3x9a', 'fortnite-q8w2e', 'backup-room-aaaaa', 'nope-zzzzz'] }));
    expect(item(items, 'Demo world 1')).toMatchObject({ ok: true, detail: 'Game night (game-night-k3x9a) is ready' });
    expect(item(items, 'Demo world 2')).toMatchObject({ ok: false, blocker: true, detail: 'Fortnite (fortnite-q8w2e) is still building (60%)' });
    expect(item(items, 'Demo world 3').detail).toContain('failed: We couldn');
    expect(item(items, 'Demo world 4')).toMatchObject({ ok: false, detail: 'nope-zzzzz not found' });
    expect(exitCode(items)).toBe(1);
  });

  test('DEMO_SCENES unset: the ready worlds are listed; none ready blocks', async () => {
    const listed = buildChecklist(await input({ demoScenes: [] }));
    const ready = item(listed, 'Ready worlds');
    expect(ready.ok).toBe(true);
    expect(ready.detail).toStartWith('3 ready: Game night (game-night-k3x9a), Fortnite (fortnite-q8w2e)');
    expect(ready.detail).toContain('DEMO_SCENES');
    const none = buildChecklist(await input({ demoScenes: [], scenes: [scene('x-aaaaa', { status: 'failed' })] }));
    expect(item(none, 'Ready worlds')).toMatchObject({ ok: false, blocker: true });
  });

  test('server down: the server rows say to fix it first; 401 asks for DV_KEY', async () => {
    const down = buildChecklist(await input({ status: { ok: false, httpStatus: 0, error: 'nothing answers there' }, scenes: null }));
    expect(item(down, 'Server')).toMatchObject({ ok: false, blocker: true });
    expect(item(down, 'Server').fix).toContain('bun run https');
    // one "Demo worlds" row instead of one per world: there is no list to check them against
    for (const n of ['GPU worker', 'Guide', 'DeepSpace', 'Public link', 'Demo worlds']) expect(item(down, n)).toMatchObject({ ok: false, fix: 'Fix the server first.' });
    // the local checks still ran
    expect(item(down, 'HiPerGator session').ok).toBe(true);
    expect(item(down, 'cloudflared').ok).toBe(true);
    const key = buildChecklist(await input({ status: { ok: false, httpStatus: 401, error: 'Bad key' } }));
    expect(item(key, 'Server').fix).toContain('DV_KEY');
  });

  test('colour only when asked (a TTY)', async () => {
    const items = buildChecklist(await input({ cloudflared: null }));
    expect(formatChecklist(items)).not.toContain('\x1b[');
    expect(formatChecklist(items, { color: true })).toContain('\x1b[');
  });
});

describe('preflight gathering', () => {
  const cfg = hpgConfig({ HPG_SOCKET: '/tmp/fake-cm-hpg', HPG_USER: 'someone', HPG_HOST: 'hpg.example', HPG_SSH_BIN: 'ssh' });

  function deps(over: Partial<PreflightDeps> & { calls?: string[][]; urls?: Array<{ url: string; key: string | null }> } = {}): PreflightDeps {
    const calls = over.calls ?? [];
    const urls = over.urls ?? [];
    return {
      fetch: async (u, init) => {
        const url = String(u);
        urls.push({ url, key: new Headers(init?.headers).get('x-dejaview-key') });
        if (url.endsWith('/api/host/status')) return Response.json(await hostStatus());
        if (url.endsWith('/api/scenes')) return Response.json(SCENES);
        return Response.json({ error: 'Not found.' }, { status: 404 });
      },
      exec: async (argv) => {
        calls.push(argv);
        return { code: 0, stderr: '' };
      },
      freeBytes: async () => 30 * GB,
      hpg: cfg,
      cloudflared: '/usr/local/bin/cloudflared',
      ...over,
    };
  }

  test('the only command it runs is ssh -O check on the control socket', async () => {
    expect(sessionCheckArgv(cfg)).toEqual(['ssh', '-O', 'check', '-o', 'ControlPath=/tmp/fake-cm-hpg', 'someone@hpg.example']);
    const calls: string[][] = [];
    const got = await gatherPreflight(preflightOptions([], { DEMO_SCENES: 'game-night-k3x9a, fortnite-q8w2e' }), deps({ calls }));
    expect(calls).toEqual([['ssh', '-O', 'check', '-o', 'ControlPath=/tmp/fake-cm-hpg', 'someone@hpg.example']]);
    expect(got.hpgSession.ok).toBe(true);
    expect(got.demoScenes).toEqual(['game-night-k3x9a', 'fortnite-q8w2e']);
    expect(got.status.ok).toBe(true);
    expect(exitCode(buildChecklist(got))).toBe(0);
  });

  test('BASE from the argument; DV_KEY is sent as x-dejaview-key', async () => {
    const urls: Array<{ url: string; key: string | null }> = [];
    const opts = preflightOptions(['https://brave-otter.trycloudflare.com/'], { DV_KEY: 'k3y' });
    expect(opts.base).toBe('https://brave-otter.trycloudflare.com');
    await gatherPreflight(opts, deps({ urls }));
    expect(urls.map((u) => u.url).sort()).toEqual(['https://brave-otter.trycloudflare.com/api/host/status', 'https://brave-otter.trycloudflare.com/api/scenes']);
    expect(urls.every((u) => u.key === 'k3y')).toBe(true);
    expect(preflightOptions([], {}).base).toBe(DEFAULT_BASE);
  });

  test('a closed session reports ssh\'s own last line; a server that is down or answers HTML is a failed row', async () => {
    const closed = await gatherPreflight(preflightOptions([], {}), deps({ exec: async () => ({ code: 255, stderr: 'Control socket connect(/tmp/fake-cm-hpg): No such file or directory\n' }) }));
    expect(closed.hpgSession).toEqual({ ok: false, detail: 'Control socket connect(/tmp/fake-cm-hpg): No such file or directory' });
    const refused = await gatherPreflight(preflightOptions([], {}), deps({ fetch: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } }));
    expect(refused.status).toEqual({ ok: false, httpStatus: 0, error: 'nothing answers there' });
    expect(refused.scenes).toBeNull();
    const html = await gatherPreflight(preflightOptions([], {}), deps({ fetch: async () => new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }) }));
    expect(html.status.ok).toBe(false);
    const unauthorized = await gatherPreflight(preflightOptions([], {}), deps({ fetch: async () => Response.json({ error: 'Bad key' }, { status: 401 }) }));
    expect(unauthorized.status).toEqual({ ok: false, httpStatus: 401, error: 'Bad key' });
  });

  test('cloudflared: a CLOUDFLARED_BIN that does not exist counts as missing', () => {
    expect(findCloudflared({ CLOUDFLARED_BIN: '/nonexistent/cloudflared', PATH: '' })).toBeNull();
    expect(findCloudflared({ CLOUDFLARED_BIN: '/usr/bin/true', PATH: '' })).toBe('/usr/bin/true');
    expect(findCloudflared({ PATH: '' })).toBeNull();
  });

  test('HiPerGator turned off: nothing is run, the row fails', async () => {
    const calls: string[][] = [];
    const off = await gatherPreflight(preflightOptions([], {}), deps({ calls, hpg: hpgConfig({ THIRDWHEEL_HPG: 'off' }) }));
    expect(calls).toEqual([]);
    expect(off.hpgSession.ok).toBe(false);
    expect(off.hpgSession.detail).toContain('turned off');
  });
});
