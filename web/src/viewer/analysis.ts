// Pure statistics over splat samples: floor estimation, robust bounds, colour summaries.

export type V3 = [number, number, number];

export interface Bounds {
  min: V3;
  max: V3;
}

/** Quantile of an ascending-sorted array (linear interpolation). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const t = Math.min(1, Math.max(0, q)) * (n - 1);
  const i = Math.floor(t);
  const f = t - i;
  if (i + 1 >= n) return sorted[n - 1];
  return sorted[i] * (1 - f) + sorted[i + 1] * f;
}

export function sortedFloat32(values: ArrayLike<number>): Float32Array {
  const a = Float32Array.from(values as ArrayLike<number>);
  a.sort();
  return a;
}

/** First index i with sorted[i] >= v. */
export function lowerBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface FloorEstimate {
  /** Floor height. */
  y: number;
  /** 0..1, how clearly the floor layer stands out. */
  confidence: number;
  /** Bin size used. */
  bin: number;
}

export interface FloorOptions {
  /** Histogram bin size in metres. Default adapts to the height range (>= 3 cm). */
  binSize?: number;
  /** Candidate peaks must reach this fraction of the strongest low peak. */
  minPeakRatio?: number;
  /** When set, prefer floor candidates below this height (e.g. below the capture camera). */
  below?: number;
  /** Optional per-sample weights (same length as ys). Flat, horizontal splats count more. */
  weights?: ArrayLike<number>;
}

/**
 * Finds the densest low horizontal layer of splats: a height histogram is smoothed, peaks in the
 * lower part of the range are collected, and the lowest peak that is a sizeable fraction of the
 * strongest one wins. The result is refined to the median height of samples inside the peak.
 */
export function estimateFloor(ys: ArrayLike<number>, opts: FloorOptions = {}): FloorEstimate | null {
  const n = ys.length;
  if (n < 32) return null;
  const sorted = sortedFloat32(ys);
  const lo = quantileSorted(sorted, 0.003);
  const hi = quantileSorted(sorted, 0.997);
  const range = hi - lo;
  if (!(range > 1e-4)) return { y: lo, confidence: 0, bin: 0 };

  const bin = opts.binSize ?? Math.max(0.03, range / 400);
  const nb = Math.max(3, Math.ceil(range / bin) + 1);
  const hist = new Float64Array(nb);
  const w = opts.weights;
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y < lo || y > hi) continue;
    const b = Math.min(nb - 1, Math.floor((y - lo) / bin));
    hist[b] += w ? w[i] : 1;
  }
  const s = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const a = i > 0 ? hist[i - 1] : 0;
    const c = i < nb - 1 ? hist[i + 1] : 0;
    s[i] = (a + 2 * hist[i] + c) / 4;
  }

  const median = quantileSorted(sorted, 0.5);
  let cut = Math.max(median, lo + 0.5 * range);
  const below = opts.below;
  let restrict = false;
  if (below !== undefined && below > lo + bin) {
    restrict = true;
    cut = Math.min(cut, below);
  }

  const center = (i: number) => lo + (i + 0.5) * bin;
  const pickFrom = (limit: number): number => {
    let m = 0;
    for (let i = 0; i < nb && center(i) < limit; i++) m = Math.max(m, s[i]);
    if (m <= 0) return -1;
    const ratio = opts.minPeakRatio ?? 0.35;
    for (let i = 0; i < nb && center(i) < limit; i++) {
      const left = i > 0 ? s[i - 1] : 0;
      const right = i < nb - 1 ? s[i + 1] : 0;
      if (s[i] >= left && s[i] >= right && s[i] >= ratio * m) return i;
    }
    return -1;
  };

  let peak = pickFrom(cut);
  if (peak < 0 && restrict) peak = pickFrom(Math.max(median, lo + 0.5 * range));
  if (peak < 0) return { y: lo, confidence: 0, bin };

  // refine: median of raw samples within the peak window
  const c = center(peak);
  const a = lowerBound(sorted, c - 1.5 * bin);
  const b = lowerBound(sorted, c + 1.5 * bin);
  const y = b > a ? sorted[(a + b) >> 1] : c;

  let mean = 0;
  for (let i = 0; i < nb; i++) mean += s[i];
  mean /= nb;
  const prominence = mean > 0 ? s[peak] / mean : 0;
  const confidence = Math.max(0, Math.min(1, (prominence - 1) / 6));
  return { y, confidence, bin };
}

/** Per-axis quantile bounds of xyz triples. */
export function robustBounds(xyz: ArrayLike<number>, count: number, lowQ = 0.01, highQ = 0.99, maxSamples = 200000): Bounds | null {
  if (count <= 0) return null;
  const step = Math.max(1, Math.floor(count / maxSamples));
  const m = Math.ceil(count / step);
  const ax = new Float32Array(m), ay = new Float32Array(m), az = new Float32Array(m);
  let k = 0;
  for (let i = 0; i < count && k < m; i += step, k++) {
    ax[k] = xyz[i * 3];
    ay[k] = xyz[i * 3 + 1];
    az[k] = xyz[i * 3 + 2];
  }
  const sx = ax.subarray(0, k).sort(), sy = ay.subarray(0, k).sort(), sz = az.subarray(0, k).sort();
  return {
    min: [quantileSorted(sx, lowQ), quantileSorted(sy, lowQ), quantileSorted(sz, lowQ)],
    max: [quantileSorted(sx, highQ), quantileSorted(sy, highQ), quantileSorted(sz, highQ)],
  };
}

export function expandBounds(b: Bounds, m: number | V3): Bounds {
  const e: V3 = typeof m === 'number' ? [m, m, m] : m;
  return { min: [b.min[0] - e[0], b.min[1] - e[1], b.min[2] - e[2]], max: [b.max[0] + e[0], b.max[1] + e[1], b.max[2] + e[2]] };
}

/** Smallest box containing both boxes. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Distance from a point to the box (0 inside). */
export function distanceOutside(b: Bounds, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal (xz) distance from a point to the box footprint (0 inside). */
export function distanceOutsideXZ(b: Bounds, x: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.sqrt(dx * dx + dz * dz);
}

export function insideXZ(b: Bounds, x: number, z: number): boolean {
  return x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2];
}

// ---------- colour helpers (sRGB components in 0..1) ----------

export type RGB = [number, number, number];

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return [l, l, l];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

/** Re-lights a colour: keeps its hue, scales saturation, sets lightness. */
export function tone(c: RGB, sat: number, light: number): RGB {
  const [h, s] = rgbToHsl(c);
  return hslToRgb(h, Math.min(1, s * sat), light);
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export interface SkyPalette {
  top: RGB;
  horizon: RGB;
  bottom: RGB;
}

/**
 * Builds a muted gradient from the world's average colours (upper, overall, lower parts) so the
 * background reads as an extension of the room instead of a black void.
 */
export function skyPalette(upper: RGB, all: RGB, lower: RGB): SkyPalette {
  const deep: RGB = [0.05, 0.055, 0.07];
  const top = mixRgb(tone(upper, 0.55, 0.2), deep, 0.25);
  const horizon = tone(all, 0.5, 0.36);
  const bottom = mixRgb(tone(lower, 0.5, 0.13), deep, 0.35);
  return { top, horizon, bottom };
}
