// Frame-rate governor for the headset: splats are fill-rate bound, and a headset that drops frames
// is far worse than one that draws slightly softer splats. When frames run over budget, step down
// through cheaper splat settings; when there is headroom for a while, step back up, but never to a
// level that already failed twice. Pure logic; the app applies the levels to the renderer.

export interface SplatLevel {
  /** Gaussian cutoff in standard deviations (smaller = less overdraw). */
  maxStdDev: number;
  /** Scale on the level-of-detail splat budget (only affects worlds with a LoD tree). */
  lodSplatScale: number;
  /** Largest splat radius on screen in pixels (caps the cost of splats right in front of the eyes). */
  maxPixelRadius: number;
}

export const XR_LEVELS: readonly SplatLevel[] = [
  { maxStdDev: Math.sqrt(6), lodSplatScale: 1, maxPixelRadius: 512 },
  { maxStdDev: Math.sqrt(5), lodSplatScale: 0.8, maxPixelRadius: 320 },
  { maxStdDev: 2, lodSplatScale: 0.65, maxPixelRadius: 220 },
  { maxStdDev: Math.sqrt(3.5), lodSplatScale: 0.5, maxPixelRadius: 160 },
];

export interface GovernorOptions {
  /** Number of levels (0 = best). */
  levels: number;
  /** A frame counts as dropped when its interval exceeds the budget by this factor. */
  dropFactor?: number;
  /** Step down when more than this share of recent frames dropped. */
  dropShare?: number;
  /** Seconds of history judged at once. */
  window?: number;
  /** Seconds without drops before trying one level better. */
  recoverAfter?: number;
}

export class FrameGovernor {
  level = 0;
  private readonly opts: Required<GovernorOptions>;
  private frames: number[] = [];
  private elapsed = 0;
  private calm = 0;
  private readonly failures: number[];

  constructor(opts: GovernorOptions) {
    this.opts = { dropFactor: 1.4, dropShare: 0.1, window: 1.5, recoverAfter: 8, ...opts };
    this.failures = new Array(opts.levels).fill(0);
  }

  /** Forgets the history (after a level change, a teleport fade or a new session). */
  reset(): void {
    this.frames.length = 0;
    this.elapsed = 0;
    this.calm = 0;
  }

  /**
   * Feeds one frame interval (ms) against the frame budget (ms). Returns the new level when it
   * changed, else null.
   */
  push(intervalMs: number, budgetMs: number): number | null {
    if (!(intervalMs > 0) || !(budgetMs > 0)) return null;
    // a long stall (tab hidden, session paused) says nothing about rendering cost
    if (intervalMs > budgetMs * 8) return null;
    this.frames.push(intervalMs);
    this.elapsed += intervalMs / 1000;
    if (this.elapsed < this.opts.window) return null;
    const dropped = this.frames.filter((f) => f > budgetMs * this.opts.dropFactor).length / this.frames.length;
    const window = this.elapsed;
    this.frames.length = 0;
    this.elapsed = 0;
    if (dropped > this.opts.dropShare && this.level < this.opts.levels - 1) {
      this.failures[this.level]++;
      this.level++;
      this.calm = 0;
      return this.level;
    }
    this.calm = dropped < this.opts.dropShare / 4 ? this.calm + window : 0;
    if (this.calm >= this.opts.recoverAfter && this.level > 0 && this.failures[this.level - 1] < 2) {
      this.level--;
      this.calm = 0;
      return this.level;
    }
    return null;
  }
}
