"""Silhouettes and depth of posed bodies seen through a pinhole camera.

silhouette(): every pixel centre that some projected triangle covers (no depth), for mask IoU checks. Each triangle
is tested on its own with edge functions; one cv2.fillPoly over all triangles is not a union (where the front and
the back of the body overlap, the polygon fill's crossing rule leaves holes, a third of the silhouette at full size).
DepthRenderer: Open3D ray casting (Embree, CPU) of one or more posed meshes -> per-pixel depth, which mesh and
which triangle was hit, for visibility tests when baking textures.
ambient_occlusion(): how enclosed each vertex of a mesh is (the glb step's optional shading of folds, the hem and
the gap under a backpack).
"""

from __future__ import annotations

import numpy as np

from pipeline.avatar.util import project


def silhouette(V_cv: np.ndarray, tris: np.ndarray, K: np.ndarray, hw: tuple[int, int], scale: float = 1.0,
               min_z: float = 0.05) -> np.ndarray:
    """Boolean mask (h, w) covered by the mesh V_cv (cv camera coordinates). `scale` maps source pixels to
    mask pixels (0.5 for a half-size mask). Triangles with a vertex closer than min_z are left out."""
    h, w = hw
    uv = project(K, V_cv) * scale
    ok = V_cv[:, 2] > min_z
    t = tris[ok[tris].all(1)]
    if len(t) == 0:
        return np.zeros((h, w), bool)
    return coverage(uv[t], (h, w))


def coverage(P: np.ndarray, hw: tuple[int, int], chunk: int = 4_000_000) -> np.ndarray:
    """Union of 2D triangles P (T, 3, 2) (pixel coordinates, pixel centres at i + 0.5) on an (h, w) grid: a pixel is
    set when its centre lies inside (or on the edge of) any triangle, whatever the triangles' winding."""
    h, w = hw
    out = np.zeros(h * w, bool)
    P = np.asarray(P, np.float64)
    x0 = np.maximum(np.ceil(P[..., 0].min(1) - 0.5), 0).astype(np.int64)
    x1 = np.minimum(np.floor(P[..., 0].max(1) - 0.5), w - 1).astype(np.int64)
    y0 = np.maximum(np.ceil(P[..., 1].min(1) - 0.5), 0).astype(np.int64)
    y1 = np.minimum(np.floor(P[..., 1].max(1) - 0.5), h - 1).astype(np.int64)
    nx, ny = np.maximum(x1 - x0 + 1, 0), np.maximum(y1 - y0 + 1, 0)
    n = nx * ny
    tid = np.nonzero((n > 0) & np.isfinite(P).all((1, 2)))[0]
    if len(tid) == 0:
        return out.reshape(h, w)
    ends = np.cumsum(n[tid])
    a = 0
    while a < len(tid):
        b = max(a + 1, int(np.searchsorted(ends, (ends[a - 1] if a else 0) + chunk, side="right")))
        t = tid[a:b]
        cnt = n[t]
        rep = np.repeat(np.arange(len(t)), cnt)
        local = np.arange(int(cnt.sum())) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        tt = t[rep]
        px = x0[tt] + local % nx[tt]
        py = y0[tt] + local // nx[tt]
        cx, cy = px + 0.5, py + 0.5
        A, B, C = P[tt, 0], P[tt, 1], P[tt, 2]
        e0 = (B[:, 0] - A[:, 0]) * (cy - A[:, 1]) - (B[:, 1] - A[:, 1]) * (cx - A[:, 0])
        e1 = (C[:, 0] - B[:, 0]) * (cy - B[:, 1]) - (C[:, 1] - B[:, 1]) * (cx - B[:, 0])
        e2 = (A[:, 0] - C[:, 0]) * (cy - C[:, 1]) - (A[:, 1] - C[:, 1]) * (cx - C[:, 0])
        eps = 1e-9
        inside = ((e0 >= -eps) & (e1 >= -eps) & (e2 >= -eps)) | ((e0 <= eps) & (e1 <= eps) & (e2 <= eps))
        out[(py * w + px)[inside]] = True
        a = b
    return out.reshape(h, w)


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


def ambient_occlusion(V: np.ndarray, F: np.ndarray, rays: int = 64, radius: float = 0.25, seed: int = 0,
                      offset: float = 0.002) -> np.ndarray:
    """Per-vertex ambient occlusion (0 = open, 1 = closed) of the mesh (V, F): cosine-weighted rays over each vertex's
    normal hemisphere, a hit at distance t within `radius` counting 1 - t / radius (Open3D ray casting)."""
    import open3d as o3d

    from pipeline.avatar.body import vertex_normals

    n = vertex_normals(V, F)
    rng = np.random.default_rng(seed)
    u1, u2 = rng.random(rays), rng.random(rays)
    r, phi = np.sqrt(u1), 2 * np.pi * u2
    local = np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - u1)], 1)  # cosine-weighted, z = up
    a = np.where(np.abs(n[:, :1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
    t1 = np.cross(n, a)
    t1 /= np.maximum(np.linalg.norm(t1, axis=1, keepdims=True), 1e-12)
    t2 = np.cross(n, t1)
    d = local[None, :, :1] * t1[:, None] + local[None, :, 1:2] * t2[:, None] + local[None, :, 2:] * n[:, None]
    o = np.repeat((V + offset * n)[:, None], rays, 1)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(np.ascontiguousarray(V, np.float32)), o3d.core.Tensor(np.ascontiguousarray(F, np.uint32)))
    ans = scene.cast_rays(o3d.core.Tensor(np.concatenate([o, d], -1).reshape(-1, 6).astype(np.float32)))
    t = ans["t_hit"].numpy().reshape(len(V), rays)
    occ = np.where(t < radius, 1.0 - t / radius, 0.0)
    return occ.mean(1)
