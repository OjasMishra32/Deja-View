"""Silhouettes and depth of posed bodies seen through a pinhole camera.

silhouette(): cv2 polygon fill of every projected triangle (no depth), for mask IoU checks.
DepthRenderer: Open3D ray casting (Embree, CPU) of one or more posed meshes -> per-pixel depth, which mesh and
which triangle was hit, for visibility tests when baking textures.
"""

from __future__ import annotations

import numpy as np

from pipeline.avatar.util import project


def silhouette(V_cv: np.ndarray, tris: np.ndarray, K: np.ndarray, hw: tuple[int, int], scale: float = 1.0,
               min_z: float = 0.05) -> np.ndarray:
    """Boolean mask (h, w) covered by the mesh V_cv (cv camera coordinates). `scale` maps source pixels to
    mask pixels (0.5 for a half-size mask)."""
    import cv2

    h, w = hw
    uv = project(K, V_cv) * scale
    ok = V_cv[:, 2] > min_z
    t = tris[ok[tris].all(1)]
    m = np.zeros((h, w), np.uint8)
    if len(t) == 0:
        return m.astype(bool)
    pts = np.rint(uv[t] * 16).astype(np.int32)  # 4 bits of sub-pixel precision
    cv2.fillPoly(m, list(pts), 1, lineType=cv2.LINE_8, shift=4)
    return m.astype(bool)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    u = np.count_nonzero(a | b)
    return float(np.count_nonzero(a & b)) / u if u else 0.0


class DepthRenderer:
    """Ray casts posed triangle meshes from a pinhole camera (cv convention)."""

    def __init__(self, K: np.ndarray, width: int, height: int, scale: float = 1.0):
        self.K = np.asarray(K, np.float64).copy()
        self.K[:2] *= scale
        self.w, self.h = int(round(width * scale)), int(round(height * scale))
        u, v = np.meshgrid(np.arange(self.w) + 0.5, np.arange(self.h) + 0.5)
        d = np.stack([(u - self.K[0, 2]) / self.K[0, 0], (v - self.K[1, 2]) / self.K[1, 1], np.ones_like(u)], -1)
        self.dirs = d.astype(np.float32)  # z-component 1: ray parameter t equals z-depth

    def render(self, meshes: list[tuple[np.ndarray, np.ndarray]]):
        """meshes: [(V_cv (N,3), tris (T,3))]. Returns depth (h,w) (inf = miss), mesh id (-1 = miss), triangle id,
        barycentric (u, v) of the hit."""
        import open3d as o3d

        scene = o3d.t.geometry.RaycastingScene()
        ids = []
        for V, F in meshes:
            ids.append(scene.add_triangles(o3d.core.Tensor(np.ascontiguousarray(V, np.float32)),
                                           o3d.core.Tensor(np.ascontiguousarray(F, np.uint32))))
        rays = np.concatenate([np.zeros_like(self.dirs), self.dirs], -1).reshape(-1, 6)
        ans = scene.cast_rays(o3d.core.Tensor(rays))
        t = ans["t_hit"].numpy().reshape(self.h, self.w)
        gid = ans["geometry_ids"].numpy().astype(np.int64).reshape(self.h, self.w)
        prim = ans["primitive_ids"].numpy().astype(np.int64).reshape(self.h, self.w)
        uvb = ans["primitive_uvs"].numpy().reshape(self.h, self.w, 2)
        mesh = np.full((self.h, self.w), -1, np.int64)
        hit = np.isfinite(t)
        lut = np.full(max(ids) + 1, -1, np.int64)
        lut[np.asarray(ids, np.int64)] = np.arange(len(ids))
        if hit.any():
            mesh[hit] = lut[np.clip(gid[hit], 0, len(lut) - 1)]
        prim[~hit] = -1
        return t, mesh, prim, uvb
