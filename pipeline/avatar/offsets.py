"""Step 5 (optional): clothing, hair and backpack volume from the silhouettes.

The body model is a fitted naked body; the person masks also hold hoodies, hair and backpacks. In ~150 keyframes
each rim vertex (surface seen edge-on, |cos(normal, view)| < 0.25, not covered by the other person) is projected
into the person mask, and the distance from there to the mask's edge (a distance transform, so roughly how far
the mask reaches past the body's outline) becomes metres at that depth. Per model vertex the median over the
frames that saw it (at least 3), clamped to 0..6 cm (10 cm on the head, 2 cm on hands and feet), Laplacian-smoothed
10 times over the mesh, is the outward offset along the rest-pose normal. The offsets are kept only if they raise
the median silhouette IoU against the masks by at least `min_gain` and stay smooth (no spikes).
"""

from __future__ import annotations

import numpy as np

from pipeline.avatar import body, raster
from pipeline.avatar.body import PART_NAMES, Asset
from pipeline.avatar.util import log


def neighbours(tris: np.ndarray, n: int):
    """Sparse row-normalised adjacency of the mesh (for Laplacian smoothing)."""
    from scipy.sparse import coo_matrix

    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    A = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel()
    deg[deg == 0] = 1
    from scipy.sparse import diags

    return diags(1.0 / deg) @ A


def estimate(work, asset: Asset, k: int, tracks, hmr, others: list[Asset], n_frames: int = 150, clamp: float = 0.06,
             clamp_head: float = 0.10, clamp_ends: float = 0.02, iters: int = 10, min_obs: int = 3) -> tuple[np.ndarray, dict]:
    """Returns (offset per model vertex in metres, report)."""
    import cv2

    K = hmr["K"]
    v3d = hmr["v3d"]
    nv = int(v3d.shape[1])
    src_tris = asset.src_vertex[asset.tris]
    pre = f"person-{k}/"
    frames, dets, valid = tracks[pre + "frames"], tracks[pre + "det"], tracks[pre + "valid"]
    cand = [i for i in range(len(frames)) if dets[i] >= 0 and valid[i]]
    pick = cand[:: max(1, len(cand) // n_frames)]
    obs: list[list[float]] = [[] for _ in range(nv)]
    ious_before, ious_after = [], []
    samples = []
    for i in pick:
        f = int(frames[i])
        mk = cv2.imread(str(work / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if mk is None:
            continue
        M = mk > 127
        h, w = M.shape
        s = w / (2 * K[0, 2])
        V = v3d[dets[i]].astype(np.float64)
        S = raster.silhouette(V, src_tris, K, (h, w), scale=s)
        # the other people's silhouettes this frame: their pixels are not ours
        other = np.zeros_like(M)
        for kk, oa in enumerate(others):
            if oa is None:
                continue
            fo = tracks[f"person-{kk}/frames"]
            j = np.nonzero(fo == f)[0]
            if len(j) and tracks[f"person-{kk}/det"][j[0]] >= 0:
                Vo = v3d[tracks[f"person-{kk}/det"][j[0]]].astype(np.float64)
                other |= raster.silhouette(Vo, oa.src_vertex[oa.tris], K, (h, w), scale=s)
        Mp = M & ~(other & ~S)
        dist = cv2.distanceTransform(Mp.astype(np.uint8), cv2.DIST_L2, 5)
        n = body.vertex_normals(V, src_tris)
        view = -V / np.linalg.norm(V, axis=1, keepdims=True)
        cos = (n * view).sum(1)
        used = np.unique(src_tris)
        rim = used[np.abs(cos[used]) < 0.25]
        uv = raster.project(K, V[rim]) * s
        x, y = np.rint(uv[:, 0]).astype(int), np.rint(uv[:, 1]).astype(int)
        ok = (x >= 0) & (y >= 0) & (x < w) & (y < h)
        rim, x, y = rim[ok], x[ok], y[ok]
        ok = ~(other[y, x] & ~S[y, x])
        rim, x, y = rim[ok], x[ok], y[ok]
        metres = dist[y, x] * V[rim, 2] / (K[0, 0] * s)
        for r, m in zip(rim, metres):
            obs[r].append(float(m))
        samples.append((V, M, S, Mp))
    off = np.zeros(nv)
    seen = np.array([len(o) >= min_obs for o in obs])
    off[seen] = [np.median(obs[i]) for i in np.nonzero(seen)[0]]
    # per-part clamps (head allows hair volume; hands and feet stay close to the skin)
    vpart = np.zeros(nv, np.int64)
    for j in range(3):
        vpart[src_tris[:, j]] = asset.tri_part
    cap = np.full(nv, clamp)
    cap[vpart == PART_NAMES.index("head")] = clamp_head
    cap[np.isin(vpart, [PART_NAMES.index(p) for p in ("hand.L", "hand.R", "foot.L", "foot.R")])] = clamp_ends
    off = np.clip(off, 0.0, cap)
    L = neighbours(src_tris, nv)
    for _ in range(iters):
        off = 0.5 * off + 0.5 * (L @ off)
    off = np.clip(off, 0.0, cap)
    # check: silhouette IoU with and without the offsets (along the posed normals)
    for V, M, S, Mp in samples[::3]:
        n = body.vertex_normals(V, src_tris)
        S2 = raster.silhouette(V + off[:, None] * n, src_tris, K, M.shape, scale=M.shape[1] / (2 * K[0, 2]))
        from pipeline.avatar.ground import padded_box

        box = padded_box(S | S2)
        ious_before.append(raster.iou(S, Mp & box))
        ious_after.append(raster.iou(S2, Mp & box))
    lap = np.abs(off - L @ off)
    rep = {"frames": len(samples), "verticesObserved": int(seen.sum()),
           "offsetCm": {"median": round(100 * float(np.median(off[np.unique(src_tris)])), 2),
                        "p95": round(100 * float(np.percentile(off[np.unique(src_tris)], 95)), 2),
                        "max": round(100 * float(off.max()), 2)},
           "spikeCm": round(100 * float(lap.max()), 3),
           "iouBefore": round(float(np.median(ious_before)), 4) if ious_before else None,
           "iouAfter": round(float(np.median(ious_after)), 4) if ious_after else None}
    rep["iouGain"] = round(rep["iouAfter"] - rep["iouBefore"], 4) if ious_before else None
    log("offsets", f"person {k}: {rep}")
    return off, rep


def apply(asset: Asset, rest_vertices: np.ndarray, off: np.ndarray) -> Asset:
    """Moves the asset's rest positions out along the (unsplit, seam-safe) rest normals."""
    src_tris = asset.src_vertex[asset.tris]
    n = body.vertex_normals(rest_vertices, src_tris)
    moved = rest_vertices + off[:, None] * n
    asset.positions = moved[asset.src_vertex]
    asset.normals = body.vertex_normals(moved, src_tris)[asset.src_vertex]
    return asset
