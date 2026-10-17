// Reality check parts for worlds that arrived without them. The pipelines split every Photo and Video world into
// world-seen.spz / world-imagined.spz / reality.json themselves (pipeline/run_job.py, hpg/worker.py); a world built
// another way (the cloud GPU path, an older build) gets them here, in the background, one at a time, with the
// local .venv: `python pipeline/reality_split.py data/scenes/<id>` (about a second per million splats).
//
// Never fatal: a failed split only means the viewer says "No reality map for this world".

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';

export const REALITY_REPORT = 'reality.json';

export interface RealityOptions {
  python: string;
  /** pipeline/reality_split.py */
  script: string;
  cwd: string;
  sceneDir: (id: string) => string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Worlds the split makes sense for: one input camera (a photo, a video's plate). Samples and reconstructions are all captured or unknown. */
export function wantsReality(scene: Scene): boolean {
  return scene.status === 'ready' && !!scene.world && (scene.mode === 'rentfree' || scene.mode === 'thirdwheel');
}

export class RealitySplitter {
  private queue: string[] = [];
  private running: string | null = null;
  private failed = new Map<string, number>();
  private child: ReturnType<typeof spawn> | null = null;
  private stopped = false;
  private readonly log: (msg: string) => void;

  constructor(private opts: RealityOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** Queues a split when the scene has a world and no reality.json yet. */
  async ensure(scene: Scene): Promise<void> {
    if (this.stopped || !wantsReality(scene)) return;
    const id = scene.id;
    if (this.running === id || this.queue.includes(id)) return;
    if ((this.failed.get(id) ?? 0) > Date.now() - 10 * 60_000) return;
    if (await Bun.file(join(this.opts.sceneDir(id), REALITY_REPORT)).exists()) return;
    this.queue.push(id);
    this.next();
  }

  /** Forgets a scene (deleted). */
  forget(id: string): void {
    this.queue = this.queue.filter((q) => q !== id);
    this.failed.delete(id);
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.child?.kill('SIGTERM');
  }

  get busy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  private next(): void {
    if (this.running || this.stopped) return;
    const id = this.queue.shift();
    if (!id) return;
    this.running = id;
    const t0 = Date.now();
    void this.run(id)
      .then(
        (out) => this.log(`[reality] ${id}: ${out || 'done'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`),
        (e) => {
          this.failed.set(id, Date.now());
          this.log(`[reality] ${id}: skipped (${(e as Error).message})`);
        },
      )
      .finally(() => {
        this.running = null;
        this.child = null;
        this.next();
      });
  }

  private run(id: string): Promise<string> {
    const { python, script, cwd } = this.opts;
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, this.opts.sceneDir(id)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      this.child = child;
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout = (stdout + d).slice(-2000)));
      child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      const timer = setTimeout(() => child.kill('SIGKILL'), this.opts.timeoutMs ?? 180_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim().split('\n').pop() ?? '');
        else reject(new Error(`exit ${code ?? signal}: ${(stderr.trim().split('\n').pop() ?? '').slice(0, 300)}`));
      });
    });
  }
}
