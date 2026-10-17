// hpg-worker and hpg-batch backends. Both share one lane: the class allocation allows one GPU at a time.
// With VULTR_HOST set (server/hpg.ts) hpg-worker drives the same warm worker on a rented box and hpg-batch is off:
// there is no Slurm there.

import { mkdir } from 'node:fs/promises';
import type { SceneMode } from '../../shared/types.ts';
import {
  HpgOfflineError,
  batchJobDir,
  cancelBatch,
  enqueueWorkerCommand,
  hpgConfig,
  jobsRoot,
  noSlurmReason,
  pollBatch,
  pollWorkerJob,
  rsyncDown,
  rsyncUp,
  run,
  runOk,
  shq,
  submitBatch,
  syncRepo,
  type BatchPoll,
  type HpgConfig,
  type WorkerPoll,
  type WorkerStatus,
} from '../hpg.ts';
import { lastLines } from '../media.ts';
import { ProductError, ResumeImpossible, sleep, throwIfAborted, type Availability, type BackendDriver, type RunContext } from './types.ts';

export interface HpgProbe {
  online(): Promise<{ online: boolean; reason?: string }>;
  worker(): Promise<WorkerStatus>;
}

export interface HpgDriverOptions {
  probe: HpgProbe;
  cfg?: () => HpgConfig;
  pollMs?: number;
  /** Worker: how long a queued job may wait to be claimed. */
  claimTimeoutMs?: number;
  /** Worker: how long a queued job may wait while the worker is still loading its models (heartbeat status). */
  loadingTimeoutMs?: number;
  /** Worker: how long to wait for the worker to move a finished job from running/ to done/. */
  settleMs?: number;
  /** Worker: how long a claimed job may go without a fresh heartbeat. */
  workerStaleMs?: number;
  /** Total wall time for one job. */
  maxJobMs?: number;
  /** Batch: how long a job may wait for a GPU before it is cancelled and the next backend is tried. */
  pendingTimeoutMs?: number;
}

const UPLOAD_EXCLUDES = ['out/', 'work/', 'space/', 'state.json', 'console.txt', 'progress.json', 'DONE', 'FAILED'];
const ALL_MODES: SceneMode[] = ['rentfree', 'thirdwheel', 'reconstruct'];

let lastRepoSync = 0;

async function syncRepoThrottled(cfg: HpgConfig, force = false): Promise<void> {
  if (!force && Date.now() - lastRepoSync < 5 * 60_000) return;
  await syncRepo(cfg);
  lastRepoSync = Date.now();
}

/** Retries transient connection errors a few times before giving up. */
async function withRetries<T>(fn: () => Promise<T>, signal: AbortSignal, what: string, site: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof HpgOfflineError)) throw e;
      await sleep(2000 * (i + 1), signal);
    }
  }
  throw new Error(`lost the connection to ${site} while ${what}: ${(last as Error)?.message ?? last}`);
}

/** The job's failure: the pipeline's product sentence (progress.json `error`) when there is one, else technical text. */
function failureFrom(p: { failText?: string; progress?: { error?: string; detail?: string }; logTail?: string }, fallback: string): Error {
  const err = p.progress?.error;
  if (err) {
    const detail = typeof p.progress?.detail === 'string' && p.progress.detail.trim() ? `${err} (${p.progress.detail.trim()})` : err;
    return new ProductError(err, detail);
  }
  if (p.failText) return new Error(lastLines(p.failText, 6));
  if (p.logTail) return new Error(`${fallback}: ${lastLines(p.logTail, 4)}`);
  return new Error(fallback);
}

/** Heartbeat states in which the worker is alive but cannot claim jobs yet. */
const WARMING = new Set(['starting', 'loading']);

async function onlineOrReason(probe: HpgProbe): Promise<Availability> {
  const o = await probe.online();
  return o.online ? { ok: true } : { ok: false, reason: o.reason ?? 'offline' };
}

export function hpgWorkerDriver(opts: HpgDriverOptions): BackendDriver {
  const cfgOf = opts.cfg ?? (() => hpgConfig());
  const pollMs = opts.pollMs ?? 2000;
  const claimTimeout = opts.claimTimeoutMs ?? 3 * 60_000;
  const loadingTimeout = opts.loadingTimeoutMs ?? 12 * 60_000;
  const settleMs = opts.settleMs ?? 20_000;
  const staleMs = opts.workerStaleMs ?? 3 * 60_000;
  const maxJob = opts.maxJobMs ?? 45 * 60_000;

  async function available(): Promise<Availability> {
    const o = await onlineOrReason(opts.probe);
    if (!o.ok) return o;
    const w = await opts.probe.worker();
    if (!w.alive) return { ok: false, reason: w.lastBeat ? `the GPU worker is not running (last heartbeat ${w.lastBeat})` : 'the GPU worker is not running' };
    return { ok: true };
  }

  async function run_(ctx: RunContext): Promise<void> {
    const cfg = cfgOf();
    const jobId = ctx.state.jobId;
    const jr = jobsRoot(cfg);
    if (ctx.resume) {
      if (!ctx.state.remoteDir) throw new ResumeImpossible(`the job never reached ${cfg.site}`);
      // Queued before a switch between HiPerGator and the backup box (VULTR_HOST): it is not here, so start over.
      if (!ctx.state.remoteDir.startsWith(`${jr}/`)) throw new ResumeImpossible(`the job was queued under ${ctx.state.remoteDir}, not on ${cfg.site}`);
    } else {
      ctx.report({ status: 'uploading', stage: 'Sending to the GPU cluster', progress: 0 });
      await withRetries(() => syncRepoThrottled(cfg), ctx.signal, 'syncing the pipeline', cfg.site);
      await withRetries(() => runOk(`mkdir -p ${shq(`${jr}/incoming`)}`, 'mkdir', { cfg }), ctx.signal, 'preparing the job', cfg.site);
      await withRetries(
        () => rsyncUp(ctx.jobDir, `${jr}/incoming/${jobId}`, { cfg, exclude: UPLOAD_EXCLUDES }),
        ctx.signal,
        'uploading the inputs',
        cfg.site,
      );
      await withRetries(() => runOk(enqueueWorkerCommand(cfg, jobId), 'enqueue', { cfg }), ctx.signal, 'queueing the job', cfg.site);
      await ctx.saveState({ remoteDir: `${jr}/queue/${jobId}` });
      ctx.log(`queued for the ${cfg.site} worker as ${jobId}`);
    }

    const t0 = Date.now();
    let lastFresh = Date.now();
    let sawJob = false;
    let missing = 0;
    /** Queue time that counts against the claim timeout: time spent while the worker was warming up does not. */
    let claimClock = Date.now();
    let doneSince: number | null = null;
    let p: WorkerPoll;
    ctx.report({ status: 'queued', stage: 'Waiting for a GPU' });
    const cancel = async () => {
      // Unclaimed: take it back. Claimed: leave a CANCEL marker the worker can honour.
      await run(
        `rm -rf ${shq(`${jr}/queue/${jobId}`)} ${shq(`${jr}/incoming/${jobId}`)}; [ -d ${shq(`${jr}/running/${jobId}`)} ] && touch ${shq(`${jr}/running/${jobId}/CANCEL`)}; true`,
        { cfg, timeoutMs: 15_000 },
      ).catch(() => {});
    };
    try {
      while (true) {
        p = await withRetries(() => pollWorkerJob(jobId, cfg), ctx.signal, 'checking the job', cfg.site);
        if (p.worker.alive) lastFresh = Date.now();
        if (p.where === 'missing') {
          if (sawJob || ++missing > 3) throw new Error(`the job disappeared from the ${cfg.site} job folders`);
        } else {
          sawJob = true;
          missing = 0;
          const dir = `${jr}/${p.where}/${jobId}`;
          if (dir !== ctx.state.remoteDir) await ctx.saveState({ remoteDir: dir });
        }
        if (p.failed) throw failureFrom(p, 'the GPU job failed');
        if (p.done) {
          // The worker writes DONE inside running/<id>/ and moves the folder to done/ right after. Downloading from
          // running/ in that window loses the result, so wait for the move (bounded, in case the worker died).
          if (p.where !== 'running') break;
          doneSince ??= Date.now();
          if (Date.now() - doneSince > settleMs) break;
          await sleep(Math.min(pollMs, 500), ctx.signal);
          continue;
        }
        if (p.where === 'queue') {
          const warming = WARMING.has(p.worker.status ?? '');
          ctx.report({ status: 'queued', stage: warming ? 'Waiting for the GPU to warm up' : 'Waiting for a GPU' });
          if (warming && Date.now() - t0 < loadingTimeout) claimClock = Date.now();
          if (Date.now() - claimClock > claimTimeout) {
            await cancel();
            throw new Error(
              warming
                ? `the worker was still loading its models after ${Math.round(loadingTimeout / 60_000)} min`
                : `the worker did not pick up the job within ${Math.round(claimTimeout / 60_000)} min`,
            );
          }
        } else if (p.where === 'running') {
          if (p.progress) {
            ctx.report({ status: 'running' });
            ctx.reportProgress(p.progress);
          } else ctx.report({ status: 'running', stage: 'Running on the GPU cluster' });
        }
        if (Date.now() - lastFresh > staleMs) {
          throw new Error(`the ${cfg.site} worker stopped sending heartbeats (${Math.round((Date.now() - lastFresh) / 1000)} s)`);
        }
        if (Date.now() - t0 > maxJob) {
          await cancel();
          throw new Error(`the GPU job took longer than ${Math.round(maxJob / 60_000)} min`);
        }
        await sleep(pollMs, ctx.signal);
      }
    } catch (e) {
      if (ctx.signal.aborted) await cancel();
      throw e;
    }

    ctx.report({ status: 'downloading', stage: 'Downloading the world', progress: 1 });
    await mkdir(ctx.outDir, { recursive: true });
    let where = p.where === 'missing' ? 'done' : p.where;
    for (let i = 0; ; i++) {
      try {
        await withRetries(() => rsyncDown(`${jr}/${where}/${jobId}/out`, ctx.outDir, { cfg }), ctx.signal, 'downloading the result', cfg.site);
        break;
      } catch (e) {
        // The folder may have moved (running/ -> done/) between the last poll and rsync: find it and try again.
        if (i >= 2 || ctx.signal.aborted) throw e;
        const again = await withRetries(() => pollWorkerJob(jobId, cfg), ctx.signal, 'finding the result', cfg.site);
        if (again.where === 'missing' || again.where === where) throw e;
        ctx.log(`the finished job moved to ${again.where}/; downloading from there`);
        where = again.where;
      }
    }
    if (p.logTail) ctx.logRaw(p.logTail);
  }

  return {
    name: 'hpg-worker',
    label: `${cfgOf().site} worker`,
    place: 'the GPU cluster',
    lane: 'hpg',
    canResume: true,
    supports: (m) => ALL_MODES.includes(m),
    available,
    run: run_,
  };
}

/** Human stage for a pending or running Slurm job. */
export function batchStage(p: BatchPoll): string {
  if (p.state === 'PENDING' || p.state === 'CONFIGURING') {
    const r = p.reason;
    if (!r || r === 'None') return 'Waiting for a GPU';
    if (/Priority|Resources/i.test(r)) return `Waiting for a GPU (${r === 'Priority' ? 'other jobs first' : 'all busy'})`;
    if (/QOS|Assoc/i.test(r)) return 'Waiting for a GPU (group limit reached)';
    return 'Waiting for a GPU';
  }
  if (p.state === 'RUNNING' || p.state === 'COMPLETING') return 'Running on the GPU cluster';
  return 'Finishing up on the GPU cluster';
}

export function hpgBatchDriver(opts: HpgDriverOptions): BackendDriver {
  const cfgOf = opts.cfg ?? (() => hpgConfig());
  const pollMs = opts.pollMs ?? 5000;
  const maxJob = opts.maxJobMs ?? 3 * 60 * 60_000;
  const pendingTimeout = opts.pendingTimeoutMs ?? Number(process.env.HPG_PENDING_TIMEOUT_MIN || 15) * 60_000;

  async function run_(ctx: RunContext): Promise<void> {
    const cfg = cfgOf();
    if (!cfg.slurm) {
      // A Slurm job from before the switch cannot be followed from a box without Slurm: the runner starts over.
      if (ctx.resume) throw new ResumeImpossible(noSlurmReason(cfg));
      throw new Error(noSlurmReason(cfg));
    }
    const jobId = ctx.state.jobId;
    let slurmId = ctx.state.slurmId;
    let remoteDir = ctx.state.remoteDir;
    if (ctx.resume) {
      if (!slurmId || !remoteDir) throw new ResumeImpossible('the batch job was never submitted');
      ctx.log(`re-attached to Slurm job ${slurmId}`);
    } else {
      remoteDir = batchJobDir(cfg, jobId);
      ctx.report({ status: 'uploading', stage: 'Sending to the GPU cluster', progress: 0 });
      await withRetries(() => syncRepoThrottled(cfg, true), ctx.signal, 'syncing the pipeline', cfg.site);
      await withRetries(() => rsyncUp(ctx.jobDir, remoteDir!, { cfg, exclude: UPLOAD_EXCLUDES }), ctx.signal, 'uploading the inputs', cfg.site);
      throwIfAborted(ctx.signal);
      slurmId = await withRetries(() => submitBatch(remoteDir!, `tw-${ctx.scene.id}`, cfg), ctx.signal, 'submitting', cfg.site);
      await ctx.saveState({ remoteDir, slurmId });
      ctx.log(`submitted Slurm job ${slurmId} (${cfg.partition || 'default partition'})`);
    }

    const t0 = Date.now();
    let unknownSince: number | null = null;
    let pendingSince: number | null = null;
    let p: BatchPoll;
    try {
      while (true) {
        p = await withRetries(() => pollBatch(slurmId!, remoteDir!, cfg), ctx.signal, 'checking the job', cfg.site);
        if (p.state === 'UNKNOWN') {
          unknownSince ??= Date.now();
          if (Date.now() - unknownSince > 3 * 60_000) throw new Error(`Slurm does not know job ${slurmId}`);
        } else unknownSince = null;
        if (p.state === 'PENDING' || p.state === 'CONFIGURING') {
          ctx.report({ status: 'queued', stage: batchStage(p) });
          pendingSince ??= Date.now();
          if (Date.now() - pendingSince > pendingTimeout) {
            await cancelBatch(slurmId!, cfg);
            throw new ProductError(
              'No GPU became free in time. Try again in a few minutes.',
              `no HiPerGator GPU became free within ${Math.round(pendingTimeout / 60_000)} min (Slurm: ${p.reason ?? 'pending'}); the request was cancelled`,
            );
          }
        } else if (p.state === 'RUNNING' || p.state === 'COMPLETING') {
          ctx.report({ status: 'running' });
          if (p.progress) ctx.reportProgress(p.progress);
          else ctx.report({ stage: batchStage(p) });
        }
        if (p.failed) throw failureFrom(p, `the GPU job failed (Slurm ${p.state})`);
        if (p.terminal) {
          if (p.state === 'COMPLETED' && p.done) break;
          const why = p.state === 'TIMEOUT' ? 'hit its time limit' : p.state === 'OUT_OF_MEMORY' ? 'ran out of memory' : `ended as ${p.state}`;
          throw failureFrom(p, `Slurm job ${slurmId} ${why}${p.exitCode ? ` (exit ${p.exitCode})` : ''}`);
        }
        if (p.done && p.state === 'UNKNOWN') break;
        if (Date.now() - t0 > maxJob) {
          await cancelBatch(slurmId!, cfg);
          throw new Error(`the batch job took longer than ${Math.round(maxJob / 60_000)} min and was cancelled`);
        }
        await sleep(pollMs, ctx.signal);
      }
    } catch (e) {
      if (ctx.signal.aborted && slurmId) await cancelBatch(slurmId, cfg);
      throw e;
    }

    ctx.report({ status: 'downloading', stage: 'Downloading the world', progress: 1 });
    await mkdir(ctx.outDir, { recursive: true });
    await withRetries(() => rsyncDown(`${remoteDir}/out`, ctx.outDir, { cfg }), ctx.signal, 'downloading the result', cfg.site);
    if (p.logTail) ctx.logRaw(p.logTail);
  }

  return {
    name: 'hpg-batch',
    label: 'HiPerGator batch',
    place: 'the GPU cluster',
    lane: 'hpg',
    canResume: true,
    supports: (m) => ALL_MODES.includes(m),
    available: async () => {
      // Checked before any probe, so a box without Slurm never even gets an ssh call from this backend.
      const cfg = cfgOf();
      if (!cfg.slurm) return { ok: false, reason: noSlurmReason(cfg) };
      const o = await onlineOrReason(opts.probe);
      if (!o.ok) return o;
      // The warm worker already holds the group's GPU; a batch job would take the second one.
      const w = await opts.probe.worker();
      if (w.alive) return { ok: false, reason: 'the warm GPU worker is running, so no second GPU job is started' };
      return o;
    },
    run: run_,
  };
}

