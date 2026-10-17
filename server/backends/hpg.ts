// hpg-worker and hpg-batch backends. Both share one lane: the class allocation allows one GPU at a time.

import { mkdir } from 'node:fs/promises';
import type { SceneMode } from '../../shared/types.ts';
import {
  HpgOfflineError,
  batchJobDir,
  cancelBatch,
  enqueueWorkerCommand,
  hpgConfig,
  jobsRoot,
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
import { ResumeImpossible, sleep, throwIfAborted, type Availability, type BackendDriver, type RunContext } from './types.ts';

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
async function withRetries<T>(fn: () => Promise<T>, signal: AbortSignal, what: string, tries = 4): Promise<T> {
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
  throw new Error(`lost the connection to HiPerGator while ${what}: ${(last as Error)?.message ?? last}`);
}

function failureFrom(p: { failText?: string; progress?: { error?: string }; logTail?: string }, fallback: string): string {
  if (p.progress?.error) return p.progress.error;
  if (p.failText) return lastLines(p.failText, 6);
  if (p.logTail) return `${fallback}: ${lastLines(p.logTail, 4)}`;
  return fallback;
}

async function onlineOrReason(probe: HpgProbe): Promise<Availability> {
  const o = await probe.online();
  return o.online ? { ok: true } : { ok: false, reason: o.reason ?? 'offline' };
}

export function hpgWorkerDriver(opts: HpgDriverOptions): BackendDriver {
  const cfgOf = opts.cfg ?? (() => hpgConfig());
  const pollMs = opts.pollMs ?? 2000;
  const claimTimeout = opts.claimTimeoutMs ?? 3 * 60_000;
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
      if (!ctx.state.remoteDir) throw new ResumeImpossible('the job never reached HiPerGator');
    } else {
      ctx.report({ status: 'uploading', stage: 'Sending to HiPerGator', progress: 0 });
      await withRetries(() => syncRepoThrottled(cfg), ctx.signal, 'syncing the pipeline');
      await withRetries(() => runOk(`mkdir -p ${shq(`${jr}/incoming`)}`, 'mkdir', { cfg }), ctx.signal, 'preparing the job');
      await withRetries(
        () => rsyncUp(ctx.jobDir, `${jr}/incoming/${jobId}`, { cfg, exclude: UPLOAD_EXCLUDES }),
        ctx.signal,
        'uploading the inputs',
      );
      await withRetries(() => runOk(enqueueWorkerCommand(cfg, jobId), 'enqueue', { cfg }), ctx.signal, 'queueing the job');
      await ctx.saveState({ remoteDir: `${jr}/queue/${jobId}` });
      ctx.log(`queued for the HiPerGator worker as ${jobId}`);
    }

    const t0 = Date.now();
    let lastFresh = Date.now();
    let sawJob = false;
    let missing = 0;
    let p: WorkerPoll;
    ctx.report({ status: 'queued', stage: 'Waiting for the HiPerGator worker' });
    const cancel = async () => {
      // Unclaimed: take it back. Claimed: leave a CANCEL marker the worker can honour.
      await run(
        `rm -rf ${shq(`${jr}/queue/${jobId}`)} ${shq(`${jr}/incoming/${jobId}`)}; [ -d ${shq(`${jr}/running/${jobId}`)} ] && touch ${shq(`${jr}/running/${jobId}/CANCEL`)}; true`,
        { cfg, timeoutMs: 15_000 },
      ).catch(() => {});
    };
    try {
      while (true) {
        p = await withRetries(() => pollWorkerJob(jobId, cfg), ctx.signal, 'checking the job');
        if (p.worker.alive) lastFresh = Date.now();
        if (p.where === 'missing') {
          if (sawJob || ++missing > 3) throw new Error('the job disappeared from the HiPerGator job folders');
        } else {
          sawJob = true;
          missing = 0;
          const dir = `${jr}/${p.where}/${jobId}`;
          if (dir !== ctx.state.remoteDir) await ctx.saveState({ remoteDir: dir });
        }
        if (p.failed) throw new Error(failureFrom(p, 'the GPU job failed'));
        if (p.done) break;
        if (p.where === 'queue') {
          ctx.report({ status: 'queued', stage: 'Waiting for the HiPerGator worker' });
          if (Date.now() - t0 > claimTimeout) {
            await cancel();
            throw new Error(`the worker did not pick up the job within ${Math.round(claimTimeout / 60_000)} min`);
          }
        } else if (p.where === 'running') {
          if (p.progress) {
            ctx.report({ status: 'running' });
            ctx.reportProgress(p.progress);
          } else ctx.report({ status: 'running', stage: 'Running on the HiPerGator GPU' });
        }
        if (Date.now() - lastFresh > staleMs) {
          throw new Error(`the HiPerGator worker stopped sending heartbeats (${Math.round((Date.now() - lastFresh) / 1000)} s)`);
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
    const remoteOut = `${jr}/${p.where === 'missing' ? 'done' : p.where}/${jobId}/out`;
    await withRetries(() => rsyncDown(remoteOut, ctx.outDir, { cfg }), ctx.signal, 'downloading the result');
    if (p.logTail) ctx.logRaw(p.logTail);
  }

  return {
    name: 'hpg-worker',
    label: 'HiPerGator worker',
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
    if (!r || r === 'None') return 'Waiting for a HiPerGator GPU';
    if (/Priority|Resources/i.test(r)) return `Waiting for a HiPerGator GPU (${r === 'Priority' ? 'other jobs first' : 'GPUs busy'})`;
    if (/QOS|Assoc/i.test(r)) return `Waiting for a HiPerGator GPU (group limit: ${r})`;
    return `Waiting for a HiPerGator GPU (${r})`;
  }
  if (p.state === 'RUNNING' || p.state === 'COMPLETING') return 'Running on the HiPerGator GPU';
  return `HiPerGator job ${p.state.toLowerCase()}`;
}

export function hpgBatchDriver(opts: HpgDriverOptions): BackendDriver {
  const cfgOf = opts.cfg ?? (() => hpgConfig());
  const pollMs = opts.pollMs ?? 5000;
  const maxJob = opts.maxJobMs ?? 3 * 60 * 60_000;
  const pendingTimeout = opts.pendingTimeoutMs ?? Number(process.env.HPG_PENDING_TIMEOUT_MIN || 15) * 60_000;

  async function run_(ctx: RunContext): Promise<void> {
    const cfg = cfgOf();
    const jobId = ctx.state.jobId;
    let slurmId = ctx.state.slurmId;
    let remoteDir = ctx.state.remoteDir;
    if (ctx.resume) {
      if (!slurmId || !remoteDir) throw new ResumeImpossible('the batch job was never submitted');
      ctx.log(`re-attached to Slurm job ${slurmId}`);
    } else {
      remoteDir = batchJobDir(cfg, jobId);
      ctx.report({ status: 'uploading', stage: 'Sending to HiPerGator', progress: 0 });
      await withRetries(() => syncRepoThrottled(cfg, true), ctx.signal, 'syncing the pipeline');
      await withRetries(() => rsyncUp(ctx.jobDir, remoteDir!, { cfg, exclude: UPLOAD_EXCLUDES }), ctx.signal, 'uploading the inputs');
      throwIfAborted(ctx.signal);
      slurmId = await withRetries(() => submitBatch(remoteDir!, `tw-${ctx.scene.id}`, cfg), ctx.signal, 'submitting');
      await ctx.saveState({ remoteDir, slurmId });
      ctx.log(`submitted Slurm job ${slurmId} (${cfg.partition || 'default partition'})`);
    }

    const t0 = Date.now();
    let unknownSince: number | null = null;
    let pendingSince: number | null = null;
    let p: BatchPoll;
    try {
      while (true) {
        p = await withRetries(() => pollBatch(slurmId!, remoteDir!, cfg), ctx.signal, 'checking the job');
        if (p.state === 'UNKNOWN') {
          unknownSince ??= Date.now();
          if (Date.now() - unknownSince > 3 * 60_000) throw new Error(`Slurm does not know job ${slurmId}`);
        } else unknownSince = null;
        if (p.state === 'PENDING' || p.state === 'CONFIGURING') {
          ctx.report({ status: 'queued', stage: batchStage(p) });
          pendingSince ??= Date.now();
          if (Date.now() - pendingSince > pendingTimeout) {
            await cancelBatch(slurmId!, cfg);
            throw new Error(
              `no HiPerGator GPU became free within ${Math.round(pendingTimeout / 60_000)} min (Slurm: ${p.reason ?? 'pending'}); the request was cancelled`,
            );
          }
        } else if (p.state === 'RUNNING' || p.state === 'COMPLETING') {
          ctx.report({ status: 'running' });
          if (p.progress) ctx.reportProgress(p.progress);
          else ctx.report({ stage: batchStage(p) });
        }
        if (p.failed) throw new Error(failureFrom(p, `the GPU job failed (Slurm ${p.state})`));
        if (p.terminal) {
          if (p.state === 'COMPLETED' && p.done) break;
          const why = p.state === 'TIMEOUT' ? 'hit its time limit' : p.state === 'OUT_OF_MEMORY' ? 'ran out of memory' : `ended as ${p.state}`;
          throw new Error(failureFrom(p, `Slurm job ${slurmId} ${why}${p.exitCode ? ` (exit ${p.exitCode})` : ''}`));
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
    await withRetries(() => rsyncDown(`${remoteDir}/out`, ctx.outDir, { cfg }), ctx.signal, 'downloading the result');
    if (p.logTail) ctx.logRaw(p.logTail);
  }

  return {
    name: 'hpg-batch',
    label: 'HiPerGator batch',
    lane: 'hpg',
    canResume: true,
    supports: (m) => ALL_MODES.includes(m),
    available: async () => {
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

