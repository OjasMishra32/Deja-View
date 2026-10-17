// What the host checks found on a second look: the preflight finds a server started with `bun run https` without
// being told the address, HiPerGator turned off reads "Off" instead of "log in again", and a guide whose status()
// throws still leaves the rest of /api/host/status answering.
import { describe, expect, test } from 'bun:test';
import type { HealthInfo } from '../shared/types.ts';
import { hpgConfig } from '../server/hpg.ts';
import { createHostRoutes, createHostStatus, gpuCheck, type HostDeps } from '../server/host.ts';
import { buildChecklist, DEFAULT_BASE, exitCode, gatherPreflight, preflightOptions, type PreflightDeps } from '../scripts/preflight.ts';

const HEALTH = (online = true): HealthInfo => ({
  ok: true,
  version: '0.1.0',
  https: true,
  lan: [],
  hpg: { online, user: 'someone', worker: { alive: online, gpu: 'L4' } },
  space: { available: false },
  local: { python: true },
});

const base = (over: Partial<HostDeps> = {}): HostDeps => ({ health: async () => HEALTH(), listScenes: async () => [], waitMs: 200, ...over });

describe('GPU tile when HiPerGator is turned off', () => {
  test('off, with how to turn it back on; never "log in again"', async () => {
    const st = await createHostStatus(base({ hpgEnabled: false, health: async () => HEALTH(false) }))();
    expect(st.checks.gpu.state).toBe('off');
    expect(st.checks.gpu.text).toBe('Off');
    expect(st.checks.gpu.fix).toContain('turned off');
    expect(st.checks.gpu.fix).not.toContain('Log in');
    expect(JSON.stringify(st.checks)).not.toMatch(/thirdwheel/i);
  });

  test('on (the default): unchanged', () => {
    expect(gpuCheck(HEALTH(false), undefined, 0).text).toBe('Asleep: no HiPerGator session');
    expect(gpuCheck(HEALTH(), undefined, 0).state).toBe('ok');
  });
});

describe('a guide whose status() throws', () => {
  test('the status still answers 200, and the guide reads from its /health', async () => {
    const guide = {
      enabled: true,
      status: () => {
        throw new Error('boom');
      },
      health: async () => ({ kind: 'ok' as const, status: 200, body: { gemini: 'ok' }, text: '', ms: 5 }),
    };
    const routes = createHostRoutes(base({ guide: guide as never }));
    const r = await routes['/api/host/status']!(new Request('http://127.0.0.1/api/host/status'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.checks.guide.state).toBe('ok');
    expect(body.guide.host).toBeNull();
  });
});

describe('preflight address', () => {
  test('no BASE: localhost on PORT over http, then https; THIRDWHEEL_HTTPS=1 tries https first; a BASE is used alone', () => {
    expect(preflightOptions([], {})).toMatchObject({ base: DEFAULT_BASE, fallbacks: ['https://localhost:8787'] });
    expect(preflightOptions([], { PORT: '8790' })).toMatchObject({ base: 'http://localhost:8790', fallbacks: ['https://localhost:8790'] });
    expect(preflightOptions([], { THIRDWHEEL_HTTPS: '1' })).toMatchObject({ base: 'https://localhost:8787', fallbacks: ['http://localhost:8787'] });
    expect(preflightOptions(['https://192.168.1.20:8787'], {})).toMatchObject({ base: 'https://192.168.1.20:8787', fallbacks: [] });
  });

  function deps(answer: (url: string) => Response | Promise<Response>, asked: string[]): PreflightDeps {
    return {
      fetch: async (u) => {
        asked.push(String(u));
        return answer(String(u));
      },
      exec: async () => ({ code: 0, stderr: '' }),
      freeBytes: async () => 30 * 1024 ** 3,
      hpg: hpgConfig({ HPG_SOCKET: '/tmp/fake-cm-hpg', HPG_USER: 'someone', HPG_HOST: 'hpg.example' }),
      cloudflared: '/usr/local/bin/cloudflared',
    };
  }

  const reset = () => {
    throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  };

  test('a server started with `bun run https` is found without being told (plain http drops the line)', async () => {
    const st = await createHostStatus(base())();
    const asked: string[] = [];
    const got = await gatherPreflight(
      preflightOptions([], {}),
      deps((u) => {
        if (u.startsWith('http://')) return reset();
        return u.endsWith('/api/scenes') ? Response.json([]) : Response.json(st);
      }, asked),
    );
    expect(got.base).toBe('https://localhost:8787');
    expect(got.status.ok).toBe(true);
    expect(got.scenes).toEqual([]);
    expect(asked).toEqual(['http://localhost:8787/api/host/status', 'https://localhost:8787/api/host/status', 'https://localhost:8787/api/scenes']);
    expect(buildChecklist(got)[0]).toMatchObject({ name: 'Server', ok: true, detail: 'answers at https://localhost:8787 (0.1.0)' });
  });

  test('nothing on either: the server row fails and the preflight exits 1', async () => {
    const asked: string[] = [];
    const got = await gatherPreflight(preflightOptions([], {}), deps(reset, asked));
    expect(got.status).toEqual({ ok: false, httpStatus: 0, error: 'nothing answers there' });
    expect(got.base).toBe(DEFAULT_BASE);
    expect(exitCode(buildChecklist(got))).toBe(1);
  });

  test('a server that answers with an error is not skipped for the other scheme', async () => {
    const asked: string[] = [];
    const got = await gatherPreflight(preflightOptions([], {}), deps(() => Response.json({ error: 'Bad key' }, { status: 401 }), asked));
    expect(got.status).toEqual({ ok: false, httpStatus: 401, error: 'Bad key' });
    expect(asked.every((u) => u.startsWith('http://'))).toBe(true);
  });
});
