// ThirdWheel server: pages (Bun HTML imports), JSON API, scene assets with Range, WebSocket events, job runner.
//
//   bun run dev     http on :8787 with HMR
//   bun run https   https (certs/ from `bun run cert`), needed by the Quest for WebXR over the LAN

import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'bun';
import type { ServerEvent } from '../shared/types.ts';
import indexPage from '../web/index.html';
import capturePage from '../web/capture.html';
import viewPage from '../web/view.html';
import { createApp } from './app.ts';
import { hpgBatchDriver, hpgWorkerDriver } from './backends/hpg.ts';
import { localDriver } from './backends/local.ts';
import { spaceDriver, spaceStatus } from './backends/space.ts';
import {
  CERTS_DIR,
  FLASHWORLD_PY,
  HTTPS,
  JOBS_DIR,
  LOCAL_PYTHON,
  MAX_UPLOAD_BYTES,
  PORT,
  PRODUCTION,
  ROOT,
  RUN_JOB_PY,
  SCENES_DIR,
  VERSION,
} from './config.ts';
import { CORS_HEADERS } from './files.ts';
import { HealthMonitor } from './health.ts';
import { hpgConfig } from './hpg.ts';
import { JobRunner, parseBackendOrder } from './jobs.ts';
import { SceneStore } from './store.ts';

const TOPIC = 'events';

interface Core {
  store: SceneStore;
  health: HealthMonitor;
  runner: JobRunner;
  publish: (e: ServerEvent) => void;
  server?: Server<undefined>;
  lastHealth?: string;
  healthTimer?: ReturnType<typeof setInterval>;
}

// State that must survive `bun --hot` re-evaluation lives on globalThis: one runner, one server.
const g = globalThis as typeof globalThis & { __thirdwheel?: Core };

async function publishHealthIfChanged(core: Core): Promise<void> {
  try {
    const h = await core.health.info();
    const s = JSON.stringify(h);
    if (s !== core.lastHealth) {
      core.lastHealth = s;
      core.publish({ type: 'health', health: h });
    }
  } catch {
    /* next tick */
  }
}

async function createCore(): Promise<Core> {
  await mkdir(SCENES_DIR, { recursive: true });
  await mkdir(JOBS_DIR, { recursive: true });
  const store = new SceneStore(SCENES_DIR);
  const local = localDriver({ python: LOCAL_PYTHON, script: RUN_JOB_PY, cwd: ROOT });
  const space = spaceDriver({
    status: () => health.space.get(),
    pipeline: { python: LOCAL_PYTHON, script: FLASHWORLD_PY, cwd: ROOT },
    onBlocked: () => void health.space.get(true).then(() => publishHealthIfChanged(core)),
  });
  const health: HealthMonitor = new HealthMonitor({
    version: VERSION,
    https: HTTPS,
    port: PORT,
    hpg: () => hpgConfig(),
    space: async () => {
      const blocked = space.blockedReason();
      return blocked ? { available: false, reason: blocked } : spaceStatus();
    },
    local: async () => (await local.available()).ok,
  });
  const probe = {
    online: () => health.hpgOnline.get(),
    worker: () => health.worker.get(),
  };
  const core: Core = {
    store,
    health,
    publish: (e) => core.server?.publish(TOPIC, JSON.stringify(e)),
    runner: undefined as unknown as JobRunner,
  };
  core.runner = new JobRunner({
    store,
    jobsDir: JOBS_DIR,
    order: parseBackendOrder(process.env.THIRDWHEEL_BACKENDS),
    drivers: [
      hpgWorkerDriver({ probe }),
      hpgBatchDriver({ probe }),
      space,
      local,
    ],
    emit: (scene) => core.publish({ type: 'scene', scene }),
  });
  return core;
}

const firstBoot = !g.__thirdwheel;
const core = (g.__thirdwheel ??= await createCore());

const app = createApp({
  store: core.store,
  runner: core.runner,
  health: core.health,
  publish: core.publish,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  publicDir: join(ROOT, 'web', 'public'),
});

async function tlsOptions() {
  if (!HTTPS) return undefined;
  const cert = join(CERTS_DIR, 'cert.pem');
  const key = join(CERTS_DIR, 'key.pem');
  try {
    await access(cert);
    await access(key);
  } catch {
    console.error(`THIRDWHEEL_HTTPS=1 but ${cert} / ${key} are missing. Run: bun run cert`);
    process.exit(1);
  }
  return { cert: Bun.file(cert), key: Bun.file(key) };
}

const handlers = {
  routes: {
    '/': indexPage,
    '/capture': capturePage,
    '/view': viewPage,
  },
  async fetch(req: Request, server: Server<undefined>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return undefined;
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (/^\/(capture|view)\/+$/.test(url.pathname)) {
      return new Response(null, { status: 301, headers: { Location: `${url.pathname.replace(/\/+$/, '')}${url.search}` } });
    }
    try {
      const res = await app.handle(req);
      if (res) return res;
    } catch (e) {
      console.error(`[http] ${req.method} ${url.pathname}:`, e);
      return Response.json({ error: `Server error: ${(e as Error).message}` }, { status: 500, headers: CORS_HEADERS });
    }
    return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS });
  },
  websocket: {
    async open(ws: Bun.ServerWebSocket<undefined>) {
      ws.subscribe(TOPIC);
      try {
        ws.send(JSON.stringify({ type: 'health', health: await core.health.info() } satisfies ServerEvent));
      } catch {
        /* closed already */
      }
    },
    message() {
      /* clients only listen */
    },
    close(ws: Bun.ServerWebSocket<undefined>) {
      ws.unsubscribe(TOPIC);
    },
  },
  error(e: Error) {
    console.error('[http]', e);
    return Response.json({ error: `Server error: ${e.message}` }, { status: 500, headers: CORS_HEADERS });
  },
};

if (core.server) {
  core.server.reload(handlers as any);
} else {
  core.server = Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    maxRequestBodySize: MAX_UPLOAD_BYTES + 16 * 1024 * 1024,
    idleTimeout: 120,
    development: PRODUCTION ? false : { hmr: true, console: true },
    tls: await tlsOptions(),
    ...handlers,
  } as any) as Server<undefined>;
}

if (firstBoot) {
  const proto = HTTPS ? 'https' : 'http';
  const lan = core.health.lanUrls();
  console.log(`\nThirdWheel ${VERSION} ${PRODUCTION ? '(production)' : '(development, HMR)'}`);
  console.log(`  Local:  ${proto}://localhost:${PORT}`);
  for (const u of lan) console.log(`  LAN:    ${u}`);
  if (HTTPS) console.log('  Quest 3S: open a LAN https URL above in the Quest Browser and accept the certificate once.');
  else console.log('  Quest 3S needs HTTPS for WebXR over the LAN: bun run cert, then bun run https');
  console.log(`  Data:   ${SCENES_DIR}`);

  const resumed = await core.runner.recover();
  if (resumed.length) console.log(`  Resuming ${resumed.length} job(s): ${resumed.join(', ')}`);

  void core.health.info().then((h) => {
    core.lastHealth = JSON.stringify(h);
    const parts = [
      h.hpg.online ? `HiPerGator online${h.hpg.worker.alive ? ` (worker on ${h.hpg.worker.host ?? '?'})` : ''}` : 'HiPerGator offline',
      h.space.available ? 'FlashWorld Space reachable' : 'FlashWorld Space unavailable',
      h.local.python ? 'local pipeline ready' : 'local pipeline not installed',
    ];
    console.log(`  Backends: ${parts.join(' · ')}\n`);
  });

  core.healthTimer = setInterval(() => void publishHealthIfChanged(core), 30_000);

  const shutdown = () => {
    core.server?.stop(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
