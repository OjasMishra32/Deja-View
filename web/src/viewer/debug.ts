// Debug view of the voxel collider (key V): occupied cells as instanced boxes coloured by height.

import * as THREE from 'three';
import type { VoxelGrid } from './voxels.ts';

export function makeVoxelView(grid: VoxelGrid, maxCells = 120000): THREE.InstancedMesh {
  const n = Math.min(grid.occupiedCount, maxCells);
  const s = grid.size;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(s * 0.92, s * 0.92, s * 0.92),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
    Math.max(1, n),
  );
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  let i = 0;
  let lo = Infinity, hi = -Infinity;
  grid.forEachOccupied((_x, iy) => {
    lo = Math.min(lo, iy);
    hi = Math.max(hi, iy);
  });
  const stride = Math.max(1, Math.ceil(grid.occupiedCount / maxCells));
  let k = 0;
  grid.forEachOccupied((ix, iy, iz) => {
    if (i >= n || k++ % stride !== 0) return;
    m.makeTranslation((ix + 0.5) * s, (iy + 0.5) * s, (iz + 0.5) * s);
    mesh.setMatrixAt(i, m);
    const t = hi > lo ? (iy - lo) / (hi - lo) : 0;
    c.setHSL(0.62 - 0.55 * t, 0.85, 0.55);
    mesh.setColorAt(i, c);
    i++;
  });
  mesh.count = i;
  mesh.frustumCulled = false;
  mesh.renderOrder = 500;
  mesh.name = 'voxels';
  return mesh;
}
