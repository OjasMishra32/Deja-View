// Sparse voxel occupancy grid built from opaque splat centres.
// Pure logic (no three.js) so it can be unit tested under bun.

const OFF = 32768;
const SPAN = 65536;

/** Packs integer cell coordinates (each in [-32768, 32767]) into one safe integer key. */
export function cellKey(ix: number, iy: number, iz: number): number {
  return ((ix + OFF) * SPAN + (iy + OFF)) * SPAN + (iz + OFF);
}

function columnKey(ix: number, iz: number): number {
  return (ix + OFF) * SPAN + (iz + OFF);
}

export interface Penetration {
  x: number;
  z: number;
  depth: number;
}

/** Shape queries shared by the voxel grid and the mesh collider. */
export interface CollisionWorld {
  /**
   * Highest walkable surface under (x, z) with height in [minY, maxY], found within a small
   * footprint radius, or null when nothing is there.
   */
  groundAt(x: number, z: number, maxY: number, minY: number): number | null;
  /**
   * Deepest overlap between a vertical cylinder (centre x,z, radius r, spanning y0..y1) and solid
   * geometry. Writes the horizontal push-out direction (unit) and depth into `out`.
   * Returns false when the cylinder is free.
   */
  penetration(x: number, z: number, r: number, y0: number, y1: number, out: Penetration): boolean;
  /** True when the point is inside solid geometry. */
  solidAt(x: number, y: number, z: number): boolean;
}

export interface VoxelGridStats {
  points: number;
  cells: number;
  occupied: number;
  minCount: number;
}

export class VoxelGrid implements CollisionWorld {
  readonly size: number;
  readonly inv: number;
  private counts = new Map<number, number>();
  private sumY = new Map<number, number>();
  private occ = new Set<number>();
  /** Occupied iy values per (ix, iz) column, sorted ascending. */
  private columns = new Map<number, Int16Array>();
  private points = 0;
  private minCountUsed = 1;
  /** Radius used when looking for ground under a point. */
  groundRadius = 0.12;
  /** Free space needed above a ground cell for it to count as walkable. */
  headroomFrom = 0.3;
  headroomTo = 1.0;

  constructor(size = 0.1) {
    this.size = size;
    this.inv = 1 / size;
  }

  cell(v: number): number {
    return Math.floor(v * this.inv);
  }

  add(x: number, y: number, z: number): void {
    const k = cellKey(this.cell(x), this.cell(y), this.cell(z));
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.sumY.set(k, (this.sumY.get(k) ?? 0) + y);
    this.points++;
  }

  /** Adds xyz triples from a flat array. */
  addPoints(xyz: ArrayLike<number>, count = Math.floor(xyz.length / 3)): void {
    for (let i = 0; i < count; i++) this.add(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
  }

  /**
   * Turns raw counts into occupancy. Cells with fewer than `minCount` points are treated as
   * floaters and ignored. Pass minCount <= 0 to pick it from the data.
   */
  finalize(minCount = 0): VoxelGridStats {
    if (minCount <= 0) minCount = autoMinCount(this.counts);
    this.minCountUsed = minCount;
    this.occ.clear();
    for (const [k, c] of this.counts) if (c >= minCount) this.occ.add(k);
    this.rebuildColumns();
    return this.stats();
  }

  stats(): VoxelGridStats {
    return { points: this.points, cells: this.counts.size, occupied: this.occ.size, minCount: this.minCountUsed };
  }

  private rebuildColumns(): void {
    const cols = new Map<number, number[]>();
    for (const k of this.occ) {
      const iz = (k % SPAN) - OFF;
      const rest = Math.floor(k / SPAN);
      const iy = (rest % SPAN) - OFF;
      const ix = Math.floor(rest / SPAN) - OFF;
      const ck = columnKey(ix, iz);
      let a = cols.get(ck);
      if (!a) cols.set(ck, (a = []));
      a.push(iy);
    }
    this.columns.clear();
    for (const [ck, a] of cols) {
      a.sort((p, q) => p - q);
      this.columns.set(ck, Int16Array.from(a));
    }
  }

  get occupiedCount(): number {
    return this.occ.size;
  }

  occupied(ix: number, iy: number, iz: number): boolean {
    return this.occ.has(cellKey(ix, iy, iz));
  }

  solidAt(x: number, y: number, z: number): boolean {
    return this.occ.has(cellKey(this.cell(x), this.cell(y), this.cell(z)));
  }

  /** Mean height of the points that fell into a cell (sub-voxel surface height). */
  surfaceY(ix: number, iy: number, iz: number): number {
    const k = cellKey(ix, iy, iz);
    const c = this.counts.get(k);
    if (!c) return (iy + 0.5) * this.size;
    return (this.sumY.get(k) ?? 0) / c;
  }

  forEachOccupied(cb: (ix: number, iy: number, iz: number) => void): void {
    for (const k of this.occ) {
      const iz = (k % SPAN) - OFF;
      const rest = Math.floor(k / SPAN);
      const iy = (rest % SPAN) - OFF;
      const ix = Math.floor(rest / SPAN) - OFF;
      cb(ix, iy, iz);
    }
  }

  /** Removes occupancy inside a vertical cylinder (used to clear floaters around the spawn). */
  clearCylinder(x: number, z: number, r: number, y0: number, y1: number): number {
    let removed = 0;
    const i0 = this.cell(x - r), i1 = this.cell(x + r);
    const k0 = this.cell(z - r), k1 = this.cell(z + r);
    const j0 = this.cell(y0), j1 = this.cell(y1);
    const h = this.size * 0.5;
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = k0; iz <= k1; iz++) {
        const cx = (ix + 0.5) * this.size, cz = (iz + 0.5) * this.size;
        const dx = Math.max(Math.abs(cx - x) - h, 0), dz = Math.max(Math.abs(cz - z) - h, 0);
        if (dx * dx + dz * dz > r * r) continue;
        for (let iy = j0; iy <= j1; iy++) {
          if (this.occ.delete(cellKey(ix, iy, iz))) removed++;
        }
      }
    }
    if (removed) this.rebuildColumns();
    return removed;
  }

  /** True when the column has no occupied cell with index in [a, b]. */
  private columnFree(col: Int16Array, a: number, b: number): boolean {
    // first index >= a
    let lo = 0, hi = col.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (col[mid] < a) lo = mid + 1;
      else hi = mid;
    }
    return lo >= col.length || col[lo] > b;
  }

  groundAt(x: number, z: number, maxY: number, minY: number): number | null {
    const r = this.groundRadius;
    const i0 = this.cell(x - r), i1 = this.cell(x + r);
    const k0 = this.cell(z - r), k1 = this.cell(z + r);
    const jMax = this.cell(maxY);
    const jMin = this.cell(minY);
    const hFrom = Math.max(1, Math.round(this.headroomFrom * this.inv));
    const hTo = Math.max(hFrom, Math.round(this.headroomTo * this.inv));
    let best: number | null = null;
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = k0; iz <= k1; iz++) {
        const col = this.columns.get(columnKey(ix, iz));
        if (!col) continue;
        // walk from the top down to find the highest cell <= jMax with headroom
        for (let n = col.length - 1; n >= 0; n--) {
          const iy = col[n];
          if (iy > jMax) continue;
          if (iy < jMin) break;
          if (!this.columnFree(col, iy + hFrom, iy + hTo)) continue;
          const s = this.surfaceY(ix, iy, iz);
          if (s > maxY || s < minY) continue;
          if (best === null || s > best) best = s;
          break;
        }
      }
    }
    return best;
  }

  penetration(x: number, z: number, r: number, y0: number, y1: number, out: Penetration): boolean {
    const s = this.size;
    const i0 = this.cell(x - r), i1 = this.cell(x + r);
    const k0 = this.cell(z - r), k1 = this.cell(z + r);
    const j0 = this.cell(y0), j1 = this.cell(y1);
    let found = false;
    out.depth = 0;
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = k0; iz <= k1; iz++) {
        const col = this.columns.get(columnKey(ix, iz));
        if (!col || this.columnFree(col, j0, j1)) continue;
        const bx0 = ix * s, bx1 = bx0 + s, bz0 = iz * s, bz1 = bz0 + s;
        const cx = x < bx0 ? bx0 : x > bx1 ? bx1 : x;
        const cz = z < bz0 ? bz0 : z > bz1 ? bz1 : z;
        let dx = x - cx, dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let depth: number, nx: number, nz: number;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          depth = r - d;
          nx = dx / d;
          nz = dz / d;
        } else {
          // centre inside the cell: push out through the nearest face
          const toL = x - bx0, toR = bx1 - x, toB = z - bz0, toF = bz1 - z;
          const m = Math.min(toL, toR, toB, toF);
          if (m === toL) { nx = -1; nz = 0; } else if (m === toR) { nx = 1; nz = 0; } else if (m === toB) { nx = 0; nz = -1; } else { nx = 0; nz = 1; }
          depth = r + m;
          dx = nx; dz = nz;
        }
        if (depth > out.depth) {
          out.depth = depth;
          out.x = nx;
          out.z = nz;
          found = true;
        }
      }
    }
    return found;
  }
}

/**
 * Picks a floater threshold from the count distribution: dense surfaces put many splats in a cell,
 * stray floaters put one or two. Uses a small fraction of the median occupied-cell count.
 */
export function autoMinCount(counts: Map<number, number>): number {
  if (counts.size === 0) return 1;
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(counts.size / 20000));
  let i = 0;
  for (const c of counts.values()) {
    if (i++ % step === 0) sample.push(c);
  }
  sample.sort((a, b) => a - b);
  const median = sample[Math.floor(sample.length / 2)];
  return Math.max(1, Math.min(4, Math.round(median * 0.25)));
}
