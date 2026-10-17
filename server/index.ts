// Déjà View server: pages (Bun HTML imports), JSON API, scene assets with Range, WebSocket events, job runner,
// plus the live layer (team/contracts.md): presence and Roblox (server/social), the DeepSpace and guide relays
// (server/integrations), host cues (server/cue.ts) and the reality-check parts (server/reality.ts).
//
//   bun run dev     http on :8787 with HMR (desktop development only)
//   bun run https   the demo: https on :8787 (certs/ from `bun run cert`, needed by the Quest for WebXR over the LAN)
//                   plus plain http on :8788 (HTTP_PORT) for teammates, curl and the tunnel; no HMR, so a restart or
//                   a dropped socket never reloads a page (a reload would throw the Quest out of VR)
//
// Everything live degrades on its own: without DS_URL there is no DeepSpace push and notes stay empty, without
// GUIDE_URL the guide answers with its canned lines and uploads use the world model's own captioner.
//
// The sponsor pieces are off or harmless without their env: the Solana devnet scoreboard (server/scores, /scores,
// SOLANA_SCOREBOARD=1), the tab in Capital One's Nessie sandbox (server/bank, /tab; an in-memory bank without
// NESSIE_API_KEY), replays recorded into Tiger Data (server/replay, TIGER_DATA_URL) and Auth0 sign-in in front of
// the routes that add, delete or drive things (server/auth, AUTH0_*).

import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'bun';
import type { Scene, ServerEvent } from '../shared/types.ts';
import indexPage from '../web/index.html';
import capturePage from '../web/capture.html';
import hostPage from '../web/host.html';
import scoresPage from '../web/scores.html';
import tabPage from '../web/tab.html';
import viewPage from '../web/view.html';
import { createApp } from './app.ts';
import { auth0ConfigFromEnv, createAuth0Verifier, createAuthRoutes, signInRequired, type Auth0Verifier } from './auth/auth0.ts';
import { nessieFromEnv } from './bank/nessie.ts';
import { createTab, type TabService } from './bank/tab.ts';
import { createCueRoute } from './cue.ts';
import { hpgBatchDriver, hpgWorkerDriver } from './backends/hpg.ts';
import { localDriver } from './backends/local.ts';
import { spaceDriver, spaceStatus } from './backends/space.ts';
import {
  CERTS_DIR,
  DATA_DIR,
  FLASHWORLD_PY,
  HMR,
  HTTP_PORT,
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
import { BodyTooLarge, MESSAGES } from './app.ts';
import { isPipelineCaption, isVideoScene, publicScene } from './copy.ts';
import { CORS_HEADERS } from './files.ts';
import { guardOptionsFromEnv, hasApiToken } from './guard.ts';
import { HealthMonitor, publicHealth } from './health.ts';
import { createHostRoutes } from './host.ts';
import { hpgConfig } from './hpg.ts';
import { readPublicUrl } from './integrations/config.ts';
import { clipForScene } from './integrations/describe.ts';
import { createIntegrations, presenceFromGetter, type Integrations } from './integrations/routes.ts';
import { JobRunner, parseBackendOrder, type PrepareContext } from './jobs.ts';
import { acquireDataLock, DataDirLocked, type DataLock } from './lock.ts';
import { RealitySplitter } from './reality.ts';
import { createReplay, type Replay } from './replay/routes.ts';
import { createScoreboard, type Scoreboard } from './scores/scoreboard.ts';
import { isLocalRequest, keyRejected, type RequestIpSource } from './social/http.ts';
import { robloxWsMessage } from './social/presence.ts';
import type { MapBake } from './social/roblox.ts';
import { createRobloxModelRoutes, RobloxModelService, uploaderFromEnv, uploadScenesFromEnv } from './social/roblox-model.ts';
import { createSocial, type Social } from './social/routes.ts';
import { SceneStore } from './store.ts';

const TOPIC = 'events';
/** contracts 2.2: when set, /api/roblox/* and /api/host/* from other machines need x-dejaview-key. */
const DV_KEY = process.env.DV_KEY?.trim() || null;
const GUARD = guardOptionsFromEnv();
/** The scene changes that need a signed-in person once sign-in is on: add, rebuild and delete a memory. */
const SIGN_IN_SCENE_ROUTES: [string, RegExp][] = [
  ['POST', /^\/api\/scenes\/?$/],
  ['POST', /^\/api\/scenes\/[^/]+\/retry\/?$/],
  ['DELETE', /^\/api\/scenes\/[^/]+\/?$/],
];

interface Core {
  store: SceneStore;
  health: HealthMonitor;
  runner: JobRunner;
  publish: (e: ServerEvent) => void;
  server?: Server<undefined>;
  /** The plain-HTTP listener (HTTP_PORT, contracts 2.1): same handlers, same /ws topic. */
  httpServer?: Server<undefined>;
  lastHealth?: string;
  healthTimer?: ReturnType<typeof setInterval>;
  lock?: DataLock;
  /** THIRDWHEEL_READONLY=1 and another server owns the data folder: show scenes, run nothing. */
  readOnly?: boolean;
  /** Presence store, Roblox maps and their routes. */
  social?: Social;
  /** DeepSpace push + notes relay, guide relay, /describe and the narrate warm-up. */
  integrations?: Integrations;
  /** Background reality split for worlds that arrived without their parts. */
  reality?: RealitySplitter;
  /** The textured Roblox room (contracts 6.2b): roblox.glb + roblox-model.json per scene, optional Open Cloud upload. */
  models?: RobloxModelService;
  /** Scenes whose missing guide caption is being written (the describe backfill), one at a time. */
  describing?: Set<string>;
  describeChain?: Promise<void>;
  /** Scene id -> updatedAt of the last ready scene handled, so each finished build is handled once. */
  readySeen?: Map<string, string>;
  liveStarted?: boolean;
  /** The Solana devnet scoreboard: one signed memo per Roblox match, GET /api/scores. */
  scores?: Scoreboard;
  /** The tab of each memory in Capital One's Nessie sandbox (server/bank). */
  tab?: TabService;
  /** Presence and Roblox moments recorded into Tiger Data for /api/replay (off without TIGER_DATA_URL). */
  replay?: Replay;
  /** Auth0 access-token checks; null when sign-in is off (no AUTH0_* env). */
  auth?: Auth0Verifier | null;
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
  // One server per data folder: a second one would resume and double-run the first one's jobs.
  let lock: DataLock | undefined;
  let readOnly = false;
  try {
    lock = acquireDataLock(DATA_DIR, PORT);
  } catch (e) {
    if (!(e instanceof DataDirLocked)) throw e;
    if (process.env.THIRDWHEEL_READONLY !== '1') {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    readOnly = true;
    console.warn(`\nRead-only: pid ${e.holder.pid} owns ${DATA_DIR}; this server shows scenes and runs no jobs.\n`);
  }
  if (lock) process.on('exit', () => lock.release());
  const unlisted = (process.env.THIRDWHEEL_UNLISTED ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const store = new SceneStore(SCENES_DIR, unlisted);
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
    lock,
    readOnly,
    publish: (e) => {
      // what goes out is what the API returns: public mode names, no cluster account
      const out = e.type === 'scene' ? { ...e, scene: publicScene(e.scene) } : e.type === 'health' ? { ...e, health: publicHealth(e.health) } : e;
      const msg = JSON.stringify(out);
      core.server?.publish(TOPIC, msg);
      core.httpServer?.publish(TOPIC, msg);
    },
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
    emit: (scene) => {
      core.publish({ type: 'scene', scene });
      onSceneChanged(core, scene);
    },
    prepare: (scene, ctx) => describeUpload(core, scene, ctx),
  });
  return core;
}

/** Builds the live layer once per process (it survives `bun --hot` with the rest of the core). */
function attachLive(core: Core): void {
  const store = core.store;
  if (!core.social) {
    const social = createSocial({
      getScene: (id) => store.get(id),
      sceneDir: (id) => store.sceneDir(id),
      root: ROOT,
      python: LOCAL_PYTHON,
      dvKey: DV_KEY,
      // the map bake (contracts 11): topdown.jpg + floor + bounds into scene.json; a read-only server changes nothing
      maps: core.readOnly ? {} : { onBaked: (id, bake, key) => storeBake(core, id, bake, key) },
    });
    // Roblox moments (tag, round) go to the headsets on /ws (contracts 6.4)
    social.presence.onEvent((sceneId, event) => core.publish(robloxWsMessage(sceneId, event)));
    core.social = social;
  }
  const social = core.social;
  core.integrations ??= createIntegrations({
    store,
    // the forwarder pulls snapshots at 4 Hz; the store's own onPresence is not wired as well (it would push twice)
    presence: presenceFromGetter({
      scenes: () => social.presence.activeScenes(),
      get: (id) => social.presence.snapshot(id),
    }),
    publish: (m) => core.publish(m),
  });
  core.reality ??= new RealitySplitter({
    python: LOCAL_PYTHON,
    script: join(ROOT, 'pipeline', 'reality_split.py'),
    cwd: ROOT,
    sceneDir: (id) => store.sceneDir(id),
  });
  core.readySeen ??= new Map();
  core.describing ??= new Set();
  core.models ??= new RobloxModelService({ sceneDir: (id) => store.sceneDir(id), uploader: uploaderFromEnv(), uploadScenes: uploadScenesFromEnv() });
  if (core.auth === undefined) {
    let config = null;
    try {
      config = auth0ConfigFromEnv();
    } catch (e) {
      console.warn(`  Sign-in is off: ${(e as Error).message}`);
    }
    core.auth = config ? createAuth0Verifier({ config }) : null;
  }
  // each one starts where it is made (all three are no-ops without their env), so a hot reload into a server made
  // before they existed starts them too; a read-only server signs, pays and records nothing
  if (!core.scores) {
    core.scores = createScoreboard({
      onEvent: (fn) => social.presence.onEvent(fn),
      getScene: (id) => store.get(id),
      dataDir: DATA_DIR,
      rpcUrl: process.env.SOLANA_RPC_URL,
      enabled: process.env.SOLANA_SCOREBOARD === '1' && !core.readOnly,
    });
    core.scores.start();
  }
  if (!core.tab) {
    core.tab = createTab({
      getScene: (id) => store.get(id),
      dataDir: DATA_DIR,
      nessie: nessieFromEnv(),
      onEvent: (fn) => social.presence.onEvent(fn),
      guard: GUARD,
      authorize: (req, server) => signInGate(core, req, server),
      readOnly: core.readOnly,
    });
    core.tab.start();
  }
  if (!core.replay) {
    core.replay = createReplay({
      url: process.env.TIGER_DATA_URL,
      // every Roblox moment (tag, round, game.result) is a dv_moments row next to the positions
      presence: core.readOnly ? { onPresence: () => () => {}, onEvent: () => () => {} } : social.presence,
      getScene: (id) => store.get(id),
    });
    core.replay.start();
  }
}

/** Callers the sign-in check never asks: the API token or DV_KEY already lets them through. */
function trustedCaller(req: Request): boolean {
  return hasApiToken(req, GUARD) || (!!DV_KEY && keyRejected(req, DV_KEY, null) === null);
}

/** Sign-in (server/auth) in front of a route that adds, deletes or drives things: null to go ahead, else the 401. */
function signInGate(core: Core, req: Request, server?: RequestIpSource): Promise<Response | null> {
  if (!core.auth) return Promise.resolve(null);
  return signInRequired(req, core.auth, { local: isLocalRequest(req, server), trusted: trustedCaller(req) });
}

/**
 * The map bake's results into scene.json (contracts 4.2, 11): world.topdown always, world.floorY when it was null,
 * world.bounds when missing. Then the cached map is kept under the scene's new key (the room did not change), and
 * the scene goes out on /ws so map pages pick up the floor plan.
 */
async function storeBake(core: Core, id: string, bake: MapBake, key: string): Promise<void> {
  const next = await core.store.update(id, (s) => {
    if (!s.world) return s;
    const w = { ...s.world, topdown: { file: bake.topdown.file, min: bake.topdown.min, max: bake.topdown.max } };
    if ((w.floorY === null || w.floorY === undefined) && Number.isFinite(bake.floorY)) w.floorY = bake.floorY;
    if (!w.bounds && bake.bounds) w.bounds = bake.bounds;
    return { ...s, world: w };
  });
  if (!next) return;
  // this change is the bake itself, not a new build: do not run the ready hooks for it again
  if (core.readySeen?.has(id)) core.readySeen.set(id, next.updatedAt);
  await core.social?.maps.adopt(id, key);
  core.publish({ type: 'scene', scene: next });
  const t = bake.topdown;
  console.log(`[map] ${id}: floor plan ${t.px ? `${t.px[0]}x${t.px[1]} px` : ''} covering x ${t.min[0]}..${t.max[0]}, z ${t.min[1]}..${t.max[1]} m`);
}

/** Starts the timers of the live layer and builds what ready worlds still lack (Roblox maps, reality parts). */
async function startLive(core: Core): Promise<void> {
  if (core.liveStarted) return;
  core.liveStarted = true;
  core.integrations!.start();
  const ds = core.integrations!.config.deepspace.url;
  const guide = core.integrations!.config.guide.url;
  console.log(`  Live:   DeepSpace ${ds ? 'on' : 'off (DS_URL unset)'} · guide ${guide ? 'on' : 'off (GUIDE_URL unset)'} · Roblox key ${DV_KEY ? 'required off this machine' : 'not required'}`);
  const bank = process.env.NESSIE_API_KEY?.trim() ? 'Nessie sandbox' : 'demo bank (NESSIE_API_KEY unset)';
  console.log(
    `  Extras: scoreboard ${core.scores?.enabled ? 'on (Solana devnet)' : 'off'} · tab ${bank} · replay ${core.replay?.enabled ? 'on' : 'off (TIGER_DATA_URL unset)'}` +
      ` · sign-in ${core.auth ? `on (${core.auth.config.domain})` : 'off'}`,
  );
  if (core.readOnly) return;
  for (const s of await core.store.list()) onSceneChanged(core, s, { boot: true });
}

/**
 * A scene changed (the job runner reports every step). When a build has just finished: prewarm its Roblox map
 * (contracts 12.1: within 10 s of ready), split it for the reality check if the job did not, and warm the guide's
 * greeting for Photo worlds. At boot only the map and the reality parts are made, for every ready world.
 */
function onSceneChanged(core: Core, scene: Scene, opts: { boot?: boolean } = {}): void {
  if (scene.status !== 'ready' || !scene.world || !core.social || core.readOnly) return;
  const seen = core.readySeen!;
  if (seen.get(scene.id) === scene.updatedAt) return;
  seen.set(scene.id, scene.updatedAt);
  // every ready world (Video too: the DeepSpace map needs its floor plan); the map route itself answers Photo only
  void core.social.maps.prewarm(scene.id);
  void core.reality?.ensure(scene).catch((e) => console.warn(`[reality] ${scene.id}: ${(e as Error).message}`));
  void describeBackfill(core, scene);
  if (!opts.boot && !isVideoScene(scene)) {
    void core.integrations?.narrateWarmup(scene.id).then((ok) => ok && console.log(`[guide] greeting cached for ${scene.id}`));
  }
}

/**
 * A ready world whose caption only says how it was made (a Video upload described before this existed, an upload
 * whose /describe timed out): the guide describes its thumbnail once (a Video memory: frames from its clip), in the
 * background, so /ask and /narrate get the place and not the pipeline's sentence. Hand-written captions are kept.
 */
async function describeBackfill(core: Core, scene: Scene): Promise<void> {
  const integrations = core.integrations;
  if (!integrations?.config.guide.url || scene.captionSource === 'guide' || scene.mode === 'sample') return;
  if (scene.caption && !isPipelineCaption(scene.caption)) return;
  const clip = isVideoScene(scene) ? clipForScene(scene, core.store.sceneDir(scene.id)) : null;
  if ((!scene.thumb && !clip) || core.describing!.has(scene.id)) return;
  core.describing!.add(scene.id);
  // one at a time: at boot several worlds may need it, and the guide's model has a rate limit
  const turn = (core.describeChain ?? Promise.resolve()).catch(() => {});
  let done!: () => void;
  core.describeChain = new Promise<void>((r) => (done = r));
  await turn;
  try {
    const thumb = scene.thumb ? join(core.store.sceneDir(scene.id), scene.thumb) : undefined;
    const caption = clip
      ? await integrations.describeClipForJob(clip.path, scene, { imagePath: thumb, packed: clip.packed })
      : await integrations.describeForJob(thumb!);
    if (!caption) return;
    const next = await core.store.update(scene.id, (s) =>
      s.captionSource === 'guide' || (s.caption && !isPipelineCaption(s.caption)) ? s : { ...s, caption, captionSource: 'guide' },
    );
    if (!next || next.caption !== caption) return;
    if (core.readySeen?.has(scene.id)) core.readySeen.set(scene.id, next.updatedAt);
    core.publish({ type: 'scene', scene: next });
    console.log(`[describe] ${scene.id} (backfill): ${caption}`);
  } catch (e) {
    console.warn(`[describe] ${scene.id}: ${(e as Error).message}`);
  } finally {
    core.describing!.delete(scene.id);
    done();
  }
}

/** A deleted scene: drop its cached maps and anything queued for it. */
function onSceneDeleted(core: Core, id: string): void {
  core.social?.maps.forget(id);
  core.reality?.forget(id);
  core.readySeen?.delete(id);
}

/** The photo the guide describes: the first uploaded photo, else the thumbnail (for a clip, a frame from its first
 * second: the empty spot, contracts 4.1 and 8). */
function describeImage(core: Core, scene: Scene): string | null {
  const files = scene.input?.files ?? [];
  if (!files.length) return null; // a prompt alone: nothing to look at
  const photo = files.find((f) => /\.(jpe?g|png)$/i.test(f) && f.startsWith('input/'));
  const rel = photo ?? (scene.thumb ? scene.thumb : null);
  return rel ? join(core.store.sceneDir(scene.id), rel) : null;
}

/**
 * contracts 8 (/describe): right after any upload is accepted, before its job starts, the guide describes the photo
 * in one or two sentences. A Video memory sends up to 8 frames from its clip instead (with the thumbnail as `image`),
 * and the caption says what happens in it, so "who won?" has an answer. The caption becomes the world model's prompt
 * (after the upload's own prompt) and scene.caption, which is also what /ask and /narrate get as the place. No guide,
 * a slow guide or an error: the job runs with the built-in captioner (both calls never throw; a photo stays within
 * 5 s, a clip within GUIDE_DESCRIBE_CLIP_TIMEOUT_MS, 12 s).
 */
async function describeUpload(core: Core, scene: Scene, ctx: PrepareContext): Promise<Scene | null> {
  const integrations = core.integrations;
  if (scene.mode === 'sample' || scene.captionSource === 'guide' || !integrations?.config.guide.url) return null;
  const image = describeImage(core, scene);
  const clip = isVideoScene(scene) ? clipForScene(scene, core.store.sceneDir(scene.id)) : null;
  if (!image && !clip) return null;
  ctx.report(isVideoScene(scene) ? 'Looking at your clip' : 'Reading your photo');
  const t0 = Date.now();
  const caption = clip
    ? await integrations.describeClipForJob(clip.path, scene, { imagePath: image ?? undefined, packed: clip.packed })
    : await integrations.describeForJob(image!);
  const ms = Date.now() - t0;
  if (ctx.signal.aborted) return null;
  if (!caption) {
    ctx.log(`describe: no caption after ${ms} ms; the world model's own captioner runs`);
    return null;
  }
  ctx.log(`describe (${ms} ms): ${caption}`);
  console.log(`[describe] ${scene.id} (${ms} ms): ${caption}`);
  return core.store.update(scene.id, { caption, captionSource: 'guide' });
}

const firstBoot = !g.__thirdwheel;
const core = (g.__thirdwheel ??= await createCore());
attachLive(core);

const app = createApp({
  store: core.store,
  runner: core.runner,
  health: core.health,
  publish: (e) => {
    core.publish(e);
    if (e.type === 'scene_deleted') onSceneDeleted(core, e.id);
  },
  maxUploadBytes: MAX_UPLOAD_BYTES,
  publicDir: join(ROOT, 'web', 'public'),
  guard: guardOptionsFromEnv(),
  readOnly: core.readOnly,
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

const cueRoute = createCueRoute({ getScene: (id) => core.store.get(id), publish: core.publish, dvKey: DV_KEY, guard: guardOptionsFromEnv() });

// GET /api/host/status (contracts 11, 13.4): GPU, guide, DeepSpace, tunnel, worlds and people for the /host page.
const hostRoutes = createHostRoutes({
  health: (force) => core.health.info(force),
  worker: (force) => core.health.worker.get(force),
  hpgEnabled: hpgConfig().enabled,
  listScenes: async () => (await core.store.list()).filter((s) => !s.unlisted),
  presence: core.social!.presence,
  guide: core.integrations!.guideClient,
  deepspace: core.integrations!.deepspace,
  publicUrl: () => readPublicUrl(core.integrations!.config.publicUrlFile),
  dvKey: DV_KEY,
  guard: guardOptionsFromEnv(),
  readOnly: core.readOnly,
});

// GET /api/roblox/:id/model and model.glb (contracts 6.2b): the textured room, Photo worlds only.
const modelRoutes = createRobloxModelRoutes({ getScene: (id) => core.store.get(id), models: core.models!, dvKey: DV_KEY });

// GET /api/auth/config (what the pages need to sign in, {enabled:false} when off) and GET /api/auth/me.
const authRoutes = createAuthRoutes(core.auth ?? null);

/** A headset cue from the /host remote is driving the headset: sign-in first, then the cue's own key rules. */
const signedCueRoute = async (req: Request, server?: RequestIpSource): Promise<Response> =>
  (req.method === 'POST' && (await signInGate(core, req, server))) || cueRoute(req, server);

/** An upload declared bigger than this is refused with JSON before its body is read (contracts 3.4, 4.1). */
const DECLARED_BODY_MAX = MAX_UPLOAD_BYTES + 16 * 1024 * 1024;

/** The same request with a body that errors (BodyTooLarge) after `max` bytes. */
function cappedBody(req: Request, max: number): Request {
  let n = 0;
  const body = req.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n += chunk.byteLength;
        if (n > max) ctl.error(new BodyTooLarge());
        else ctl.enqueue(chunk);
      },
    }),
  );
  return new Request(req.url, { method: req.method, headers: req.headers, body, signal: req.signal, duplex: 'half' } as RequestInit);
}

// Bun matches `routes` before `fetch`; the live routes answer their own OPTIONS, CORS and errors.
const handlers = {
  routes: {
    ...core.integrations!.routes,
    ...core.social!.routes,
    ...modelRoutes,
    ...hostRoutes,
    ...authRoutes,
    ...core.scores!.routes,
    ...core.tab!.routes,
    ...core.replay!.routes,
    '/api/host/cue': signedCueRoute,
    '/': indexPage,
    '/capture': capturePage,
    '/host': hostPage,
    '/view': viewPage,
    '/scores': scoresPage,
    '/tab': tabPage,
  },
  async fetch(req: Request, server: Server<undefined>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > DECLARED_BODY_MAX) {
      return Response.json({ error: MESSAGES.tooLarge(Math.round(MAX_UPLOAD_BYTES / 1024 ** 3) || 1) }, { status: 413, headers: { Connection: 'close' } });
    }
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return undefined;
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (/^\/(capture|view|host|scores|tab)\/+$/.test(url.pathname)) {
      return new Response(null, { status: 301, headers: { Location: `${url.pathname.replace(/\/+$/, '')}${url.search}` } });
    }
    // adding, rebuilding or deleting a memory needs a signed-in person once sign-in is on (a read-only server
    // refuses every change itself)
    if (core.auth && !core.readOnly && SIGN_IN_SCENE_ROUTES.some(([m, re]) => m === req.method && re.test(url.pathname))) {
      const denied = await signInGate(core, req, server);
      if (denied) return denied;
    }
    // a body sent without a length (chunked) is cut off where a declared one would have been refused
    if (req.body && !req.headers.get('content-length')) {
      req = cappedBody(req, url.pathname.startsWith('/api/scenes') ? DECLARED_BODY_MAX : 16 * 1024 * 1024);
    }
    try {
      const res = await app.handle(req);
      if (res) return res;
    } catch (e) {
      console.error(`[http] ${req.method} ${url.pathname}:`, e);
      return Response.json({ error: MESSAGES.serverError }, { status: 500 });
    }
    return Response.json({ error: MESSAGES.notFound }, { status: 404, headers: CORS_HEADERS });
  },
  websocket: {
    async open(ws: Bun.ServerWebSocket<undefined>) {
      ws.subscribe(TOPIC);
      try {
        ws.send(JSON.stringify({ type: 'health', health: publicHealth(await core.health.info()) } satisfies ServerEvent));
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
    return Response.json({ error: MESSAGES.serverError }, { status: 500 });
  },
};

/**
 * Listens on both IPv4 and IPv6 ('::' is dual-stack on macOS), so `localhost` (which tries ::1 first) always reaches
 * this server and never another process on [::1]:<port>. Falls back to IPv4 only if the IPv6 side is taken.
 */
function listen(port: number, tls: Awaited<ReturnType<typeof tlsOptions>>): Server<undefined> {
  const opts = {
    port,
    // the app refuses declared bodies over DECLARED_BODY_MAX itself, with a JSON error; Bun's own limit (a bare 413)
    // only stops absurd ones. Every route caps what it reads.
    maxRequestBodySize: 64 * 1024 ** 3,
    idleTimeout: 120,
    development: PRODUCTION ? false : { hmr: HMR, console: true },
    tls,
    ...handlers,
  };
  try {
    return Bun.serve({ ...opts, hostname: '::' } as any) as Server<undefined>;
  } catch (e) {
    const s = Bun.serve({ ...opts, hostname: '0.0.0.0' } as any) as Server<undefined>;
    console.warn(`  Port ${port}: IPv6 is taken (${(e as Error).message}); listening on IPv4 only. Use 127.0.0.1, not localhost.`);
    return s;
  }
}

if (core.server) {
  core.server.reload(handlers as any);
  core.httpServer?.reload(handlers as any);
} else {
  core.server = listen(PORT, await tlsOptions());
  // contracts 2.1: plain http on HTTP_PORT (8788 next to https), same process, data and /ws, for teammates and the tunnel
  if (HTTP_PORT) {
    try {
      core.httpServer = listen(HTTP_PORT, undefined);
    } catch (e) {
      console.warn(`  Plain HTTP on :${HTTP_PORT} is not available (${(e as Error).message}); teammates use the https address with curl -k.`);
    }
  }
}

if (firstBoot) {
  const proto = HTTPS ? 'https' : 'http';
  const lan = core.health.lanUrls();
  console.log(`\nDéjà View ${VERSION} ${PRODUCTION ? '(production)' : HMR ? '(development, HMR)' : '(development, no HMR)'}`);
  console.log(`  Local:  ${proto}://localhost:${PORT}`);
  for (const u of lan) console.log(`  LAN:    ${u}`);
  if (core.httpServer) {
    console.log(`  HTTP:   http://localhost:${HTTP_PORT} (teammates, curl, the tunnel)`);
    for (const u of lan) console.log(`          ${u.replace(/^https:/, 'http:').replace(/:\d+$/, `:${HTTP_PORT}`)}`);
  }
  console.log(`  Host:   ${proto}://localhost:${PORT}/host`);
  if (HTTPS) console.log('  Quest 3S: open a LAN https URL above in the Quest Browser and accept the certificate once.');
  else console.log('  Quest 3S needs HTTPS for WebXR over the LAN: bun run cert, then bun run https');
  console.log(`  Data:   ${SCENES_DIR}`);

  const resumed = core.readOnly ? [] : await core.runner.recover();
  if (resumed.length) console.log(`  Resuming ${resumed.length} job(s): ${resumed.join(', ')}`);
  await startLive(core);

  void core.health.info().then((h) => {
    core.lastHealth = JSON.stringify(h);
    const parts = [
      h.hpg.online ? `HiPerGator online${h.hpg.worker.alive ? ` (worker on ${h.hpg.worker.host ?? '?'})` : ''}` : 'HiPerGator offline',
      h.space.available ? 'cloud GPU reachable' : 'cloud GPU unavailable',
      h.local.python ? 'local pipeline ready' : 'local pipeline not installed',
    ];
    console.log(`  Backends: ${parts.join(' · ')}\n`);
  });

  core.healthTimer = setInterval(() => void publishHealthIfChanged(core), 30_000);

  const shutdown = async () => {
    try {
      core.integrations?.stop();
      core.social?.stop();
      core.reality?.stop();
      core.scores?.stop();
    } catch (e) {
      console.warn('[shutdown]', e);
    }
    // the game result the tab has in hand and the last second of positions, for at most 2 s
    await Promise.race([Promise.allSettled([core.tab?.stop(), core.replay?.stop()]), Bun.sleep(2000)]);
    core.server?.stop(true);
    core.httpServer?.stop(true);
    core.lock?.release();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  // a hot reload into a core made before the live layer existed
  void startLive(core);
}
