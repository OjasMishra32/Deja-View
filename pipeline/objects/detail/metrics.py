"""Image and mesh metrics for the detail report. All numpy; images are float 0..1."""
from __future__ import annotations

import numpy as np


def iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.asarray(a, bool), np.asarray(b, bool)
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 1.0


def depth_mae(d_ref: np.ndarray, d: np.ndarray, m_ref: np.ndarray, m: np.ndarray) -> float | None:
    """Mean |z difference| in metres where both have a surface."""
    both = np.asarray(m_ref, bool) & np.asarray(m, bool) & (d_ref > 0) & (d > 0)
    return float(np.abs(d_ref[both] - d[both]).mean()) if both.any() else None


def psnr(ref: np.ndarray, img: np.ndarray, mask: np.ndarray | None = None) -> float | None:
    diff = (np.asarray(ref, np.float64) - np.asarray(img, np.float64)) ** 2
    if mask is not None:
        m = np.asarray(mask, bool)
        if not m.any():
            return None
        diff = diff[m]
    mse = float(diff.mean())
    return 99.0 if mse <= 1e-12 else float(10 * np.log10(1.0 / mse))


def _gauss_filter(x: np.ndarray, sigma: float = 1.5) -> np.ndarray:
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(x, ((r, r), (r, r)), mode="reflect")
    tmp = np.zeros((pad.shape[0], x.shape[1]))
    for i, w in enumerate(k):
        tmp += w * pad[:, i:i + x.shape[1]]
    out = np.zeros(x.shape)
    for i, w in enumerate(k):
        out += w * tmp[i:i + x.shape[0], :]
    return out


def gray(img: np.ndarray) -> np.ndarray:
    img = np.asarray(img, np.float64)
    if img.dtype == np.uint8 or img.max() > 1.5:
        img = img / 255.0
    return img if img.ndim == 2 else img[..., :3] @ np.array([0.299, 0.587, 0.114])


def ssim(ref: np.ndarray, img: np.ndarray, mask: np.ndarray | None = None) -> float | None:
    """Gaussian-window SSIM on luminance (Wang et al. 2004), averaged over `mask` if given."""
    x, y = gray(ref), gray(img)
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mx, my = _gauss_filter(x), _gauss_filter(y)
    sxx = _gauss_filter(x * x) - mx * mx
    syy = _gauss_filter(y * y) - my * my
    sxy = _gauss_filter(x * y) - mx * my
    s = ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))
    if mask is not None:
        m = np.asarray(mask, bool)
        return float(s[m].mean()) if m.any() else None
    return float(s.mean())


def laplacian_variance(img: np.ndarray, mask: np.ndarray | None = None) -> float | None:
    """Variance of the 4-neighbour Laplacian of luminance (x255, the usual blur score). Higher is sharper.

    With a mask, only pixels whose whole 3x3 neighbourhood is inside count, so the silhouette edge is not scored."""
    g = gray(img) * 255.0
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    if mask is not None:
        m = np.asarray(mask, bool)
        inner = m[1:-1, 1:-1] & m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
        if inner.sum() < 16:
            return None
        lap = lap[inner]
    return float(lap.var())


def mesh_stats(V: np.ndarray, F: np.ndarray) -> dict:
    """Triangles, boundary edges, hole loops, non-manifold edges, watertightness, components and area.

    Vertices are welded by position first (the bakers split vertices at UV seams and chunk borders)."""
    V = np.asarray(V, np.float64)
    F = np.asarray(F, np.int64).reshape(-1, 3)
    if len(F) == 0:
        return {"triangles": 0, "vertices": int(len(V)), "boundaryEdges": 0, "holes": 0, "nonManifoldEdges": 0,
                "watertight": False, "components": 0, "areaM2": 0.0}
    q = np.round(V / 1e-5).astype(np.int64)
    _, weld = np.unique(q, axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    Fw = weld[F]
    good = (Fw[:, 0] != Fw[:, 1]) & (Fw[:, 1] != Fw[:, 2]) & (Fw[:, 0] != Fw[:, 2])
    Fw = Fw[good]
    e = np.concatenate([Fw[:, [0, 1]], Fw[:, [1, 2]], Fw[:, [2, 0]]])
    es = np.sort(e, axis=1)
    uniq, counts = np.unique(es, axis=0, return_counts=True)
    boundary = uniq[counts == 1]
    nonmanifold = int((counts > 2).sum())
    holes = _loops(boundary)
    comps = _components(Fw, int(weld.max()) + 1)
    area = 0.5 * np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1).sum()
    return {
        "triangles": int(len(F)),
        "vertices": int(len(V)),
        "boundaryEdges": int(len(boundary)),
        "holes": holes,
        "nonManifoldEdges": nonmanifold,
        "watertight": bool(len(boundary) == 0 and nonmanifold == 0),
        "components": comps,
        "areaM2": round(float(area), 4),
    }


def _find(parent: np.ndarray, i: int) -> int:
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


def _union_count(pairs: np.ndarray, n: int, nodes: np.ndarray) -> int:
    parent = np.arange(n)
    for a, b in pairs:
        ra, rb = _find(parent, int(a)), _find(parent, int(b))
        if ra != rb:
            parent[ra] = rb
    return len({_find(parent, int(i)) for i in nodes})


def _loops(boundary: np.ndarray) -> int:
    """Connected loops of boundary edges, i.e. holes (an open sheet counts its rim as one)."""
    if len(boundary) == 0:
        return 0
    nodes, inv = np.unique(boundary, return_inverse=True)
    pairs = inv.reshape(-1, 2)
    return _components(np.concatenate([pairs, pairs[:, :1]], axis=1), len(nodes))


def _components(F: np.ndarray, n: int) -> int:
    if len(F) == 0:
        return 0
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components

        e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]]])
        g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
        _, labels = connected_components(g, directed=False)
        return int(len(np.unique(labels[np.unique(F)])))
    except ImportError:
        pairs = np.concatenate([F[:, [0, 1]], F[:, [1, 2]]])
        return _union_count(pairs, n, np.unique(F))


def summarise(values: list[float | None]) -> float | None:
    vals = [v for v in values if v is not None and np.isfinite(v)]
    return round(float(np.mean(vals)), 4) if vals else None
