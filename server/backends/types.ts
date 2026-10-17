// The interface every job backend implements. A backend turns a prepared job directory into
// <jobdir>/out/scene.json (a JobResult) plus the files it references; jobs.ts does the rest.

import type { Backend, JobProgress, Scene, SceneMode } from '../../shared/types.ts';

export interface JobSpec {
  id: string;
  mode: SceneMode;
  prompt?: string;
  params: Record<string, unknown>;
}

/** Persisted in <jobdir>/state.json so a restarted server can find the job again. */
export interface JobState {
  sceneId: string;
  jobId: string;
  attempt: number;
  backend?: Backend;
  startedAt?: string;
  /** Local backend: process id of the pipeline (process group leader). */
  pid?: number;
  /** HPG backends: the job dir on HiPerGator. */
  remoteDir?: string;
  /** hpg-batch: Slurm job id. */
  slurmId?: string;
  /** Backend restriction the job was queued with (?backend=...), kept across restarts. */
  only?: Backend;
}

export type ActiveStatus = 'queued' | 'uploading' | 'running' | 'downloading';

export interface ProgressUpdate {
  status?: ActiveStatus;
  stage?: string;
  progress?: number;
}

export interface RunContext {
  /** Scene snapshot taken when the attempt started. */
  scene: Scene;
  sceneDir: string;
  jobDir: string;
  outDir: string;
  job: JobSpec;
  state: JobState;
  signal: AbortSignal;
  /** True when re-attaching to a job that was running before a server restart. */
  resume: boolean;
  report(update: ProgressUpdate): void;
  /** Applies a JobProgress written by a pipeline. */
  reportProgress(p: JobProgress): void;
  log(message: string): void;
  /** Appends raw pipeline output to the scene log. */
  logRaw(text: string): void;
  saveState(patch: Partial<JobState>): Promise<void>;
}

export type Availability = { ok: true; note?: string } | { ok: false; reason: string };

export interface BackendDriver {
  name: Backend;
  /** Label for log lines, e.g. "HiPerGator worker". Never shown in the UI. */
  label: string;
  /** Where the job runs, as product copy for stage lines: "the HiPerGator GPU", "this computer". */
  place?: string;
  /** Jobs that share a lane run one at a time. */
  lane: string;
  supports(mode: SceneMode): boolean;
  available(): Promise<Availability>;
  run(ctx: RunContext): Promise<void>;
  /** Whether run(ctx) with ctx.resume can re-attach to work started before a restart. */
  canResume: boolean;
}

/**
 * A failure that carries a short product sentence for the UI (`user`) next to the technical detail (`message`),
 * which only goes to log.txt. Backends throw it when they know what went wrong in words a person can act on.
 */
export class ProductError extends Error {
  constructor(
    readonly user: string,
    detail?: string,
  ) {
    super(detail || user);
    this.name = 'ProductError';
  }
}

/** Thrown by run() when asked to resume but there is nothing to attach to; the runner starts over. */
export class ResumeImpossible extends Error {
  constructor(message = 'nothing to resume') {
    super(message);
    this.name = 'ResumeImpossible';
  }
}

export class AbortedError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError();
}

/** Sleeps, waking early (and throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads a progress.json if present and well formed. */
export async function readProgress(path: string): Promise<JobProgress | null> {
  try {
    const j = await Bun.file(path).json();
    if (j && typeof j === 'object' && typeof j.stage === 'string') return j as JobProgress;
  } catch {
    /* absent or mid-write */
  }
  return null;
}
