// Job orchestration: builds job directories, picks a backend (hpg-worker, hpg-batch, hf-space, local),
// mirrors progress into the Scene, merges out/scene.json, copies outputs and handles failure and retry.
//
// Scene status flow: queued -> (uploading -> running -> downloading) -> ready | failed.
// Backends that share a lane run one job at a time; other jobs wait in FIFO order.

import { appendFile, copyFile, link, mkdir, readdir, rename, rm, stat, unlink, constants as fsc } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Backend, JobProgress, JobResult, Scene, SceneMode } from '../shared/types.ts';
import { GENERIC_FAILURE, MODE_NAME, NOTHING_AVAILABLE, sentence, waitingInLine } from './copy.ts';
import { safeJoin } from './files.ts';
import { writeJsonAtomic, type SceneStore } from './store.ts';
import {
  AbortedError,
  ProductError,
  ResumeImpossible,
  type BackendDriver,
  type JobSpec,
  type JobState,
  type ProgressUpdate,
  type RunContext,
} from './backends/types.ts';

export const DEFAULT_ORDER: Backend[] = ['hpg-worker', 'hpg-batch', 'hf-space', 'local'];
export const ACTIVE_STATUSES = new Set(['queued', 'uploading', 'running', 'downloading']);

/** Parses THIRDWHEEL_BACKENDS ("local,hf-space") into an order; unknown names are ignored. */
export function parseBackendOrder(value: string | undefined): Backend[] {
  if (!value?.trim()) return DEFAULT_ORDER;
  const names = value.split(',').map((s) => s.trim()).filter((s): s is Backend => (DEFAULT_ORDER as string[]).includes(s));
  return names.length ? names : DEFAULT_ORDER;
}

interface Waiter {
  wake: () => void;
  /** Told the new number of jobs ahead whenever the line moves. */
  onAhead?: (ahead: number) => void;
}

class Lane {
  private waiters: Waiter[] = [];
  private busy = false;

  get isBusy(): boolean {
    return this.busy;
  }

  /** Jobs ahead of a newcomer: the running one plus those waiting. */
  get ahead(): number {
    return (this.busy ? 1 : 0) + this.waiters.length;
  }

  async acquire(signal: AbortSignal, onAhead?: (ahead: number) => void): Promise<() => void> {
    if (signal.aborted) throw new AbortedError();
    if (!this.busy) {
      this.busy = true;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        wake: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        onAhead,
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        this.announce();
        reject(new AbortedError());
      };
      this.waiters.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return this.releaser();
  }

  /** Tells every waiter its place: the running job plus those in front of it. */
  private announce(): void {
    this.waiters.forEach((w, i) => w.onAhead?.((this.busy ? 1 : 0) + i));
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.wake();
      else this.busy = false;
      this.announce();
    };
  }
}

/**
 * Coalesces progress writes for one scene. Status changes flush at once; stage/progress at most every
 * `intervalMs`. final() cancels anything pending so a late progress tick can never overwrite ready/failed.
 */
class Reporter {
  private pending: Partial<Scene> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  last: Partial<Scene> = {};
  /** The last stage reported while the job was actually running, kept on the scene when it fails. */
  workStage: string | undefined;

  constructor(
    private store: SceneStore,
    private id: string,
    private emit: (s: Scene) => void,
    private intervalMs: number,
  ) {}

  set(update: ProgressUpdate & { backend?: Backend }): void {
    if (this.closed) return;
    const patch: Partial<Scene> = {};
    if (update.status) patch.status = update.status;
    if (update.backend) patch.backend = update.backend;
    if (typeof update.stage === 'string' && update.stage.trim()) patch.stage = update.stage.trim().slice(0, 200);
    if (typeof update.progress === 'number' && Number.isFinite(update.progress)) {
      patch.progress = Math.round(Math.min(1, Math.max(0, update.progress)) * 1000) / 1000;
    }
    if (patch.stage && (patch.status ?? this.last.status) === 'running') this.workStage = patch.stage;
    const changed = (Object.keys(patch) as (keyof Scene)[]).some((k) => this.last[k] !== patch[k]);
    if (!changed) return;
    Object.assign(this.pending, patch);
    Object.assign(this.last, patch);
    if (patch.status || patch.backend) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): Promise<unknown> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = {};
    if (!Object.keys(p).length) return this.chain;
    this.chain = this.chain.then(async () => {
      const s = await this.store.update(this.id, p).catch(() => null);
      if (s) this.emit(s);
    });
    return this.chain;
  }

  async final(change: Partial<Scene> | ((s: Scene) => Scene)): Promise<Scene | null> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = {};
    await this.chain.catch(() => {});
    const s = await this.store.update(this.id, change as Partial<Scene>);
    if (s) this.emit(s);
    return s;
  }
}

export interface JobRunnerOptions {
  store: SceneStore;
  jobsDir: string;
  drivers: BackendDriver[];
  emit: (scene: Scene) => void;
  order?: Backend[];
  /** Minimum time between progress writes per scene. */
  reportIntervalMs?: number;
}

export interface EnqueueOptions {
  /** Re-attach to the backend recorded in state.json (after a restart). */
  resume?: boolean;
  /** Restrict to one backend. */
  only?: Backend;
}

export interface Note {
  /** Backend label, for the log. */
  label: string;
  /** Technical reason, for the log. */
  reason: string;
  /** Product sentence for the UI, when the failing step gave one. */
  user?: string;
}

type AttemptOutcome =
  | { kind: 'ok' }
  | { kind: 'aborted' }
  | { kind: 'resume-impossible' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string; user?: string };

function errMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+$/g, '').slice(0, 1200) || 'unknown error';
}

/** Groups identical reasons: "HiPerGator worker and HiPerGator batch: offline ...". */
function mergeNotes(notes: Note[]): string {
  const groups = new Map<string, string[]>();
  for (const n of notes) groups.set(n.reason, [...(groups.get(n.reason) ?? []), n.label]);
  return [...groups].map(([reason, labels]) => sentence(`${labels.join(' and ')}: ${reason}`)).join(' ');
}

/** The technical account of a failed job, for log.txt: every backend that failed or was skipped, and why. */
export function composeError(failures: Note[], skipped: Note[]): string {
  if (failures.length) {
    let msg = failures.map((f) => sentence(`${f.label} failed: ${f.reason}`)).join(' ');
    if (skipped.length) msg += ` Not available: ${mergeNotes(skipped)}`;
    return msg;
  }
  if (skipped.length) return `No backend could run this job. ${mergeNotes(skipped)}`;
  return 'No backend could run this job.';
}

/**
 * The one sentence a person sees for a failed job. The latest failure that came with product copy (the pipeline's
 * own reason, a known cloud GPU condition) wins; otherwise a plain sentence for the mode.
 */
export function userError(mode: SceneMode, failures: Note[], skipped: Note[]): string {
  for (let i = failures.length - 1; i >= 0; i--) {
    const u = failures[i]!.user?.trim();
    if (u) return sentence(u);
  }
  if (failures.length) return GENERIC_FAILURE[mode];
  if (skipped.length) return NOTHING_AVAILABLE;
  return GENERIC_FAILURE[mode];
}

const MODE_REQUIREMENT: Record<SceneMode, (r: JobResult) => string | null> = {
  rentfree: (r) => (r.world ? null : 'the result has no world'),
  reconstruct: (r) => (r.world ? null : 'the result has no world'),
  thirdwheel: (r) => (r.video ? null : 'the result has no video layer'),
  sample: () => null,
};

/** Files from out/ that are never copied into the scene directory. */
const OUT_SKIP = new Set(['scene.json', 'log.txt', 'progress.json', 'DONE', 'FAILED']);

export class JobRunner {
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private lanes = new Map<string, Lane>();
  private readonly order: Backend[];

  constructor(private opts: JobRunnerOptions) {
    this.order = opts.order ?? DEFAULT_ORDER;
  }

  get store(): SceneStore {
    return this.opts.store;
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  jobDir(sceneId: string): string {
    return join(this.opts.jobsDir, sceneId);
  }

  /** Drivers for a mode in backend order. */
  driversFor(mode: SceneMode, only?: Backend): BackendDriver[] {
    const byName = new Map(this.opts.drivers.map((d) => [d.name, d]));
    return this.order
      .map((n) => byName.get(n))
      .filter((d): d is BackendDriver => !!d && d.supports(mode) && (!only || d.name === only));
  }

  /** Starts (or queues) the job for a scene. Returns false when it is already active. */
  enqueue(sceneId: string, opts: EnqueueOptions = {}): boolean {
    if (this.active.has(sceneId)) return false;
    const abort = new AbortController();
    const done = this.runScene(sceneId, abort.signal, opts)
      .catch((e) => console.error(`[jobs] ${sceneId}: ${errMessage(e)}`))
      .finally(() => this.active.delete(sceneId));
    this.active.set(sceneId, { abort, done });
    return true;
  }

  /** Re-runs a failed (or finished) scene from scratch, optionally in another mode (the caller checked the inputs fit). */
  async retry(sceneId: string, only?: Backend, mode?: SceneMode): Promise<Scene | null> {
    if (this.active.has(sceneId)) return this.opts.store.get(sceneId);
    const before = await this.opts.store.get(sceneId);
    if (!before) return null;
    const switching = !!mode && mode !== before.mode && mode !== 'sample';
    const s = await this.opts.store.update(sceneId, {
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      error: undefined,
      ...(switching ? { mode, world: undefined, video: undefined, caption: undefined } : {}),
    });
    if (!s) return null;
    this.opts.emit(s);
    await this.appendLog(
      sceneId,
      `retry requested${only ? ` (backend ${only})` : ''}${switching ? ` (mode ${before.mode} -> ${mode})` : ''}`,
    );
    this.enqueue(sceneId, { only });
    return s;
  }

  /** Cancels a running or queued job and waits briefly for the backend to stop. */
  async cancel(sceneId: string): Promise<void> {
    const a = this.active.get(sceneId);
    if (!a) return;
    a.abort.abort();
    await Promise.race([a.done, new Promise((r) => setTimeout(r, 15_000))]);
  }

  /** Waits until no job is active (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** On startup: re-attach or restart scenes that were mid-flight when the server stopped. */
  async recover(): Promise<string[]> {
    const resumed: string[] = [];
    for (const s of await this.opts.store.list()) {
      if (s.mode === 'sample' || !ACTIVE_STATUSES.has(s.status)) continue;
      // Keep the backend restriction the job was queued with (state.json survives the restart).
      const state = await this.readState(this.jobDir(s.id));
      const only = state?.only && (DEFAULT_ORDER as string[]).includes(state.only) ? state.only : undefined;
      if (this.enqueue(s.id, { resume: s.status !== 'queued', only })) resumed.push(s.id);
    }
    return resumed;
  }

  private lane(name: string): Lane {
    let l = this.lanes.get(name);
    if (!l) this.lanes.set(name, (l = new Lane()));
    return l;
  }

  private logChains = new Map<string, Promise<void>>();

  /** Appends to the scene log; writes for one scene stay in call order. */
  private appendLog(sceneId: string, msg: string, raw = false): Promise<void> {
    const line = raw ? (msg.endsWith('\n') ? msg : msg + '\n') : `[${new Date().toISOString()}] ${msg}\n`;
    const prev = this.logChains.get(sceneId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await appendFile(join(this.opts.store.sceneDir(sceneId), 'log.txt'), line);
      } catch {
        /* scene deleted */
      }
    });
    this.logChains.set(sceneId, next);
    void next.then(() => {
      if (this.logChains.get(sceneId) === next) this.logChains.delete(sceneId);
    });
    return next;
  }

  private async readState(jobDir: string): Promise<JobState | null> {
    try {
      return (await Bun.file(join(jobDir, 'state.json')).json()) as JobState;
    } catch {
      return null;
    }
  }

  /** Fresh job dir: job.json + input/ (hard links to the scene inputs) + out/. */
  private async prepareJobDir(scene: Scene, prev: JobState | null, only?: Backend): Promise<{ job: JobSpec; state: JobState }> {
    const jobDir = this.jobDir(scene.id);
    const sceneDir = this.opts.store.sceneDir(scene.id);
    await rm(jobDir, { recursive: true, force: true });
    await mkdir(join(jobDir, 'input'), { recursive: true });
    await mkdir(join(jobDir, 'out'), { recursive: true });
    const files = scene.input?.files ?? [];
    const extras = (await Bun.file(join(sceneDir, 'input', 'meta.json')).exists()) ? ['input/meta.json'] : [];
    for (const rel of [...files, ...extras]) {
      const src = safeJoin(sceneDir, rel);
      const dst = safeJoin(jobDir, rel);
      if (!src || !dst) throw new Error(`bad input path ${rel}`);
      if (!(await Bun.file(src).exists())) throw new Error(`input file ${rel} is missing from the scene`);
      await mkdir(dirname(dst), { recursive: true });
      await link(src, dst).catch(() => copyFile(src, dst));
    }
    const attempt = (prev?.attempt ?? 0) + 1;
    const state: JobState = { sceneId: scene.id, jobId: `${scene.id}-a${attempt}`, attempt, ...(only ? { only } : {}) };
    const job: JobSpec = {
      id: state.jobId,
      mode: scene.mode,
      ...(scene.input?.prompt ? { prompt: scene.input.prompt } : {}),
      params: { sceneId: scene.id, name: scene.name, inputs: files, attempt },
    };
    await writeJsonAtomic(join(jobDir, 'job.json'), job);
    await writeJsonAtomic(join(jobDir, 'state.json'), state);
    return { job, state };
  }

  /** Clears outputs of a previous backend attempt and records the backend in job.json. */
  private async resetAttempt(jobDir: string, job: JobSpec, backend: Backend): Promise<void> {
    for (const d of ['out', 'work', 'space']) await rm(join(jobDir, d), { recursive: true, force: true });
    await mkdir(join(jobDir, 'out'), { recursive: true });
    for (const f of ['progress.json', 'DONE', 'FAILED', 'console.txt']) await unlink(join(jobDir, f)).catch(() => {});
    job.params.backend = backend;
    // The local backend is the last resort: for Rent Free it builds a plate-depth room from the photo rather than
    // failing outright for want of a GPU (THIRDWHEEL_LOCAL_FALLBACK=0 turns that off).
    if (backend === 'local' && job.mode === 'rentfree' && process.env.THIRDWHEEL_LOCAL_FALLBACK !== '0') job.params.localFallback = true;
    else delete job.params.localFallback;
    await writeJsonAtomic(join(jobDir, 'job.json'), job);
  }

  private async runScene(sceneId: string, signal: AbortSignal, opts: EnqueueOptions): Promise<void> {
    const store = this.opts.store;
    const scene0 = await store.get(sceneId);
    if (!scene0) return;
    const reporter = new Reporter(store, sceneId, this.opts.emit, this.opts.reportIntervalMs ?? 250);
    const log = (m: string) => void this.appendLog(sceneId, m);
    const jobDir = this.jobDir(sceneId);
    const sceneDir = store.sceneDir(sceneId);

    /** `user` is the sentence on the scene; `detail` (technical) only goes to log.txt. */
    const fail = async (user: string, detail = user) => {
      log(`FAILED: ${detail}`);
      // Keep the last real step ("Stopped at: Generating the world") rather than overwriting it with "Failed".
      await reporter.final({ status: 'failed', stage: reporter.workStage ?? 'Failed', error: sentence(user) });
    };

    if (scene0.mode === 'sample') return;
    const drivers = this.driversFor(scene0.mode, opts.only);
    if (!drivers.length) {
      await fail(
        opts.only ? `That backend can't build ${MODE_NAME[scene0.mode]} scenes.` : `This server can't build ${MODE_NAME[scene0.mode]} scenes.`,
        opts.only ? `Backend ${opts.only} cannot run ${scene0.mode} jobs.` : `No backend is configured for ${scene0.mode} jobs.`,
      );
      return;
    }

    const failures: Note[] = [];
    const skipped: Note[] = [];
    const prevState = await this.readState(jobDir);
    let job: JobSpec | null = null;
    let state: JobState | null = null;
    let startIndex = 0;

    const makeCtx = (resume: boolean): RunContext => ({
      scene: scene0,
      sceneDir,
      jobDir,
      outDir: join(jobDir, 'out'),
      job: job!,
      state: state!,
      signal,
      resume,
      report: (u) => reporter.set(u),
      reportProgress: (p: JobProgress) => reporter.set({ stage: p.stage, progress: p.progress }),
      log,
      logRaw: (text) => {
        if (text) void this.appendLog(sceneId, text, true);
      },
      saveState: async (patch) => {
        Object.assign(state!, patch);
        await writeJsonAtomic(join(jobDir, 'state.json'), state);
      },
    });

    try {
      // After a restart, try to pick up the job where it was.
      if (opts.resume && prevState?.backend) {
        const idx = drivers.findIndex((d) => d.name === prevState.backend);
        const d = drivers[idx];
        const jobJson = await Bun.file(join(jobDir, 'job.json')).json().catch(() => null);
        if (d && d.canResume && jobJson) {
          job = jobJson as JobSpec;
          state = prevState;
          log(`server restarted; re-attaching to the ${d.label} job`);
          const out = await this.attempt(d, makeCtx(true), reporter, true);
          if (out.kind === 'ok' || out.kind === 'aborted') return;
          if (out.kind === 'failed') {
            failures.push({ label: d.label, reason: out.reason, user: out.user });
            log(`${d.label} failed: ${out.reason}`);
            startIndex = idx + 1;
          } else {
            log(`could not re-attach (${out.kind === 'skipped' ? out.reason : 'nothing to resume'}); starting over`);
          }
        } else {
          log(`server restarted while the job was ${scene0.status}; starting it again`);
        }
      }

      if (!job || !state || startIndex === 0) {
        try {
          ({ job, state } = await this.prepareJobDir(scene0, prevState, opts.only));
        } catch (e) {
          await fail("This scene's uploaded files are missing. Upload them again.", `Could not prepare the job: ${errMessage(e)}`);
          return;
        }
      }

      const rest = drivers.slice(startIndex);
      for (const [i, d] of rest.entries()) {
        if (signal.aborted) return;
        const avail = await d.available().catch((e) => ({ ok: false as const, reason: errMessage(e) }));
        if (!avail.ok) {
          skipped.push({ label: d.label, reason: avail.reason });
          log(`${d.label}: skipped (${avail.reason})`);
          continue;
        }
        const out = await this.attempt(d, makeCtx(false), reporter, false);
        if (out.kind === 'ok' || out.kind === 'aborted') return;
        if (out.kind === 'skipped') {
          skipped.push({ label: d.label, reason: out.reason });
          continue;
        }
        if (out.kind === 'failed') {
          failures.push({ label: d.label, reason: out.reason, user: out.user });
          log(`${d.label} failed: ${out.reason}`);
          const next = rest[i + 1];
          if (next) reporter.set({ status: 'queued', stage: next.place ? `Trying again on ${next.place}` : 'Trying again', progress: 0 });
        }
      }
      if (signal.aborted) return;
      await fail(userError(scene0.mode, failures, skipped), composeError(failures, skipped));
    } catch (e) {
      if (signal.aborted || e instanceof AbortedError) return;
      await fail(GENERIC_FAILURE[scene0.mode], `Internal error: ${errMessage(e)}`);
    }
  }

  private async attempt(d: BackendDriver, ctx: RunContext, reporter: Reporter, resume: boolean): Promise<AttemptOutcome> {
    const lane = this.lane(d.lane);
    const waited = lane.isBusy;
    if (waited) {
      reporter.set({ status: 'queued', stage: waitingInLine(lane.ahead) });
    }
    let release: () => void;
    try {
      release = await lane.acquire(ctx.signal, (ahead) => reporter.set({ status: 'queued', stage: waitingInLine(ahead) }));
    } catch {
      return { kind: 'aborted' };
    }
    try {
      if (waited && !resume) {
        const avail = await d.available().catch((e) => ({ ok: false as const, reason: errMessage(e) }));
        if (!avail.ok) return { kind: 'skipped', reason: avail.reason };
      }
      if (!resume) {
        await this.resetAttempt(ctx.jobDir, ctx.job, d.name);
        await ctx.saveState({ backend: d.name, startedAt: new Date().toISOString(), pid: undefined, remoteDir: undefined, slurmId: undefined });
        reporter.set({ status: 'running', backend: d.name, stage: d.place ? `Starting on ${d.place}` : 'Starting', progress: 0 });
        ctx.log(`running on ${d.label} (job ${ctx.state.jobId})`);
      } else {
        reporter.set({ backend: d.name });
      }
      await d.run(ctx);
      if (ctx.signal.aborted) return { kind: 'aborted' };
      reporter.set({ status: 'downloading', stage: 'Saving the world', progress: 1 });
      await reporter.flush();
      const merged = await this.ingest(ctx);
      ctx.log(`ready (${d.label})`);
      await reporter.final(merged);
      // Intermediate frames are only useful while the job runs; job.json, logs and out/ stay for debugging.
      await rm(join(ctx.jobDir, 'work'), { recursive: true, force: true }).catch(() => {});
      return { kind: 'ok' };
    } catch (e) {
      if (ctx.signal.aborted || e instanceof AbortedError) return { kind: 'aborted' };
      if (e instanceof ResumeImpossible) return { kind: 'resume-impossible' };
      return { kind: 'failed', reason: errMessage(e), ...(e instanceof ProductError ? { user: e.user } : {}) };
    } finally {
      release();
    }
  }

  /** Reads out/scene.json, copies outputs into the scene dir and returns the scene mutator. */
  private async ingest(ctx: RunContext): Promise<(s: Scene) => Scene> {
    const resultPath = join(ctx.outDir, 'scene.json');
    let result: JobResult;
    try {
      result = (await Bun.file(resultPath).json()) as JobResult;
    } catch {
      throw new Error('the job finished without writing out/scene.json');
    }
    if (!result || typeof result !== 'object') throw new Error('out/scene.json is not a JobResult object');
    const need = MODE_REQUIREMENT[ctx.scene.mode](result);
    if (need) throw new Error(need);

    const refs = [result.world?.file, result.world?.collider, result.video?.file, result.video?.plate, result.thumb].filter(
      (f): f is string => typeof f === 'string' && f.length > 0,
    );
    if (result.world && typeof result.world.file !== 'string') throw new Error('world.file is missing in out/scene.json');
    if (result.video && typeof result.video.file !== 'string') throw new Error('video.file is missing in out/scene.json');
    const toCopy = new Set<string>();
    for (const rel of refs) {
      const p = safeJoin(ctx.outDir, rel);
      if (!p) throw new Error(`out/scene.json has an unsafe path: ${rel}`);
      if (rel.split('/')[0] === 'input' || OUT_SKIP.has(rel)) throw new Error(`out/scene.json uses a reserved name: ${rel}`);
      if (!(await stat(p).then((s) => s.isFile() && s.size > 0, () => false))) throw new Error(`the job did not produce ${rel}`);
      toCopy.add(rel);
    }
    for (const ent of await readdir(ctx.outDir, { withFileTypes: true })) {
      if (ent.isFile() && !OUT_SKIP.has(ent.name) && !ent.name.startsWith('.') && !/\.(tmp|part)$/.test(ent.name)) toCopy.add(ent.name);
    }
    for (const rel of toCopy) {
      const src = safeJoin(ctx.outDir, rel)!;
      const dst = safeJoin(ctx.sceneDir, rel);
      if (!dst) continue;
      await mkdir(dirname(dst), { recursive: true });
      const part = `${dst}.part`;
      await copyFile(src, part, fsc.COPYFILE_FICLONE);
      await rename(part, dst);
    }
    ctx.log(`outputs: ${[...toCopy].join(', ')}`);
    return (s: Scene): Scene => {
      const next: Scene = { ...s, status: 'ready', stage: 'Ready', progress: 1 };
      delete next.error;
      if (result.world) next.world = result.world;
      else delete next.world;
      if (result.video) next.video = result.video;
      else delete next.video;
      if (result.thumb) next.thumb = result.thumb;
      if (result.caption) next.caption = result.caption;
      return next;
    };
  }
}
