"""Surface metrics against the splats: Chamfer distance and normal consistency. Pure numpy (+ scipy's KD-tree)."""
from __future__ import annotations

import numpy as np


def sample_surface(V: np.ndarray, F: np.ndarray, count: int = 20000, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Area-weighted points on a triangle mesh and their face normals."""
    V = np.asarray(V, np.float64)
    F = np.asarray(F, np.int64).reshape(-1, 3)
    if len(F) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3))
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    cr = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cr, axis=1)
    if area.sum() <= 0:
        return np.zeros((0, 3)), np.zeros((0, 3))
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(F), size=count, p=area / area.sum())
    r1, r2 = rng.random(count), rng.random(count)
    s = np.sqrt(r1)
    P = (1 - s)[:, None] * a[idx] + (s * (1 - r2))[:, None] * b[idx] + (s * r2)[:, None] * c[idx]
    n = cr[idx] / np.maximum(np.linalg.norm(cr[idx], axis=1, keepdims=True), 1e-12)
    return P, n


def _nearest(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    from scipy.spatial import cKDTree

    d, i = cKDTree(dst).query(src, k=1)
    return d, i


def chamfer(mesh_pts: np.ndarray, ref_pts: np.ndarray, clip: float = 0.25) -> dict:
    """One-sided and symmetric Chamfer distances in metres (means of nearest-neighbour distances, each clipped at
    `clip` so one stray fragment can't dominate), plus the 90th percentile mesh -> splat distance."""
    if len(mesh_pts) == 0 or len(ref_pts) == 0:
        return {"meshToSplat": None, "splatToMesh": None, "chamfer": None, "p90MeshToSplat": None}
    d_ms, _ = _nearest(mesh_pts, ref_pts)
    d_sm, _ = _nearest(ref_pts, mesh_pts)
    a, b = float(np.minimum(d_ms, clip).mean()), float(np.minimum(d_sm, clip).mean())
    return {"meshToSplat": round(a, 5), "splatToMesh": round(b, 5), "chamfer": round((a + b) / 2, 5),
            "p90MeshToSplat": round(float(np.percentile(d_ms, 90)), 5)}


def depth_normals(points: np.ndarray, valid: np.ndarray, step: int = 2) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel normals from an unprojected depth map ([h, w, 3] world points) by central differences `step` pixels
    apart (splat depth is noisy at one pixel). Returns (normals [h, w, 3], ok mask). Orientation is arbitrary; compare
    with |cos|."""
    k = int(step)
    P = points
    h, w = valid.shape
    dx = np.zeros_like(P)
    dy = np.zeros_like(P)
    okx = np.zeros_like(valid)
    oky = np.zeros_like(valid)
    dx[:, k:w - k] = P[:, 2 * k:] - P[:, :w - 2 * k]
    dy[k:h - k] = P[2 * k:] - P[:h - 2 * k]
    okx[:, k:w - k] = valid[:, 2 * k:] & valid[:, :w - 2 * k]
    oky[k:h - k] = valid[2 * k:] & valid[:h - 2 * k]
    ok = valid & okx & oky
    n = np.cross(dx, dy)
    ln = np.linalg.norm(n, axis=-1)
    ok &= ln > 1e-12
    n = n / np.maximum(ln, 1e-12)[..., None]
    return n, ok


def normal_consistency(ref_n: np.ndarray, ref_ok: np.ndarray, mesh_n: np.ndarray, mesh_ok: np.ndarray,
                       max_jump: np.ndarray | None = None) -> dict:
    """Mean |cos| between splat-depth normals and mesh normals where both exist, and the share within 30 degrees."""
    both = ref_ok & mesh_ok
    if max_jump is not None:
        both &= max_jump
    if both.sum() < 16:
        return {"normalCos": None, "normalWithin30": None}
    c = np.abs((ref_n[both] * mesh_n[both]).sum(axis=-1))
    return {"normalCos": round(float(c.mean()), 4), "normalWithin30": round(float((c > np.cos(np.deg2rad(30))).mean()), 4)}
