"""Step 7: texels the video never saw.

Default (method "garment"): every unseen texel takes its own garment's colour. The seen texels of each body region
(skin, hair, torso, arms, legs, shoes) are split into a few colour clusters (k-means in Lab, near clusters merged); an
unseen texel takes the cluster most of its 3D neighbours on the body carry and their colour, then diffuses inside
that cluster in the atlas. A generated view from behind (backview.py), when there is one, is written into unseen
back-facing texels first and counts as seen. No mirroring and no inpainting: a mirrored or inpainted shin carries
the table's or the other leg's colours.

Method "lama" (the first version), in order of preference for every unseen texel:
  (a) the mirrored texel (left <-> right across the body's sagittal plane, matched on the rest-pose surface with a
      k-d tree, within 1 cm) when that one was seen;
  (b) a generated view from directly behind (backview.py, Qwen-Image-Edit-2511) when the back is mostly unseen,
      written only into unseen back-facing texels of the torso, head and upper legs;
  (c) Big LaMa inpainting per UV island (context: a push-pull fill of the island).
Either way, then an 8 px gutter around every island (push-pull) so mipmaps never pull in black, and a JPEG at
quality 90.
"""

from __future__ import annotations

import io

import numpy as np

from pipeline.avatar.body import Asset
from pipeline.avatar.texture import TexelMap, texel_points
from pipeline.avatar.util import log


def mirror_sources(asset: Asset, tm: TexelMap, axis: int = 0, max_dist: float = 0.01) -> np.ndarray:
    """For every covered texel, the index (into the covered texels) of its mirror image, or -1."""
    from scipy.spatial import cKDTree

    P = texel_points(asset.positions, asset, tm)
    Q = P.copy()
    Q[:, axis] *= -1
    d, i = cKDTree(P).query(Q, k=1, workers=-1)
    i[d > max_dist] = -1
    return i.astype(np.int64)


def push_pull(img: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Fills every pixel where mask is False from the masked pixels (pyramid average down, then up)."""
    import cv2

    levels = []
    c = img.astype(np.float32) * mask[..., None]
    w = mask.astype(np.float32)
    while True:
        levels.append((c, w))
        h, wd = w.shape
        if h <= 1 or wd <= 1:
            break
        nh, nw = (h + 1) // 2, (wd + 1) // 2
        c2 = cv2.resize(np.pad(c, ((0, nh * 2 - h), (0, nw * 2 - wd), (0, 0))), (nw, nh), interpolation=cv2.INTER_AREA) * 4
        w2 = cv2.resize(np.pad(w, ((0, nh * 2 - h), (0, nw * 2 - wd))), (nw, nh), interpolation=cv2.INTER_AREA) * 4
        c, w = c2, w2
    filled = None
    for c, w in reversed(levels):
        cur = c / np.maximum(w, 1e-6)[..., None]
        if filled is not None:
            up = cv2.resize(filled, (w.shape[1], w.shape[0]), interpolation=cv2.INTER_LINEAR)
            a = np.clip(w, 0, 1)[..., None]
            cur = cur * a + up * (1 - a)
        filled = cur
    out = img.astype(np.float32).copy()
    out[~mask] = filled[~mask]
    return out


def inpaint_islands(tex: np.ndarray, known: np.ndarray, island: np.ndarray, inpainter=None, max_side: int = 1024,
                    margin: int = 16) -> tuple[np.ndarray, dict]:
    """Big LaMa per UV island on the holes (island & ~known); context is a push-pull fill. Returns the texture and
    a small report."""
    import cv2

    base = push_pull(tex, known)
    out = base.copy()
    n, lab = cv2.connectedComponents(island.astype(np.uint8), connectivity=8)
    rep = {"islands": int(n - 1), "inpainted": 0, "pushPullOnly": 0}
    for i in range(1, n):
        isl = lab == i
        holes = isl & ~known
        if not holes.any():
            continue
        if inpainter is None or holes.sum() < 30:
            rep["pushPullOnly"] += 1
            continue
        ys, xs = np.nonzero(isl)
        y0, y1 = max(0, ys.min() - margin), min(tex.shape[0], ys.max() + margin + 1)
        x0, x1 = max(0, xs.min() - margin), min(tex.shape[1], xs.max() + margin + 1)
        crop = np.clip(base[y0:y1, x0:x1], 0, 255).astype(np.uint8)
        hm = cv2.dilate(holes[y0:y1, x0:x1].astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        s = min(1.0, max_side / max(crop.shape[:2]))
        if s < 1.0:
            small = cv2.resize(crop, (int(crop.shape[1] * s), int(crop.shape[0] * s)), interpolation=cv2.INTER_AREA)
            sm = cv2.resize(hm.astype(np.uint8), (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
            res = inpainter(small, sm)
            res = cv2.resize(res, (crop.shape[1], crop.shape[0]), interpolation=cv2.INTER_CUBIC)
        else:
            res = inpainter(crop, hm)
        reg = out[y0:y1, x0:x1]
        hh = holes[y0:y1, x0:x1]
        reg[hh] = res[hh]
        rep["inpainted"] += 1
    return out, rep


def finish(tex: np.ndarray, island: np.ndarray, gutter: int = 8, quality: int = 90) -> tuple[np.ndarray, bytes]:
    """Gutter around islands (and a smooth fill everywhere else), then JPEG bytes."""
    from PIL import Image

    full = push_pull(tex, island)
    img = np.clip(full + 0.5, 0, 255).astype(np.uint8)
    b = io.BytesIO()
    Image.fromarray(img).save(b, "JPEG", quality=quality, subsampling=0)
    return img, b.getvalue()


def garment_fill(asset: Asset, tm: TexelMap, tex_seen: np.ndarray, seen: np.ndarray, n_colours: int = 4,
                 merge_de: float = 14.0, min_share: float = 0.03, knn: int = 16, radius: float = 0.10, iters: int = 60,
                 seed: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Unseen texels from their own garment colour (see the module docstring). tex_seen (S, S, 3), seen (N,) over the
    covered texels. Returns (image float32 (S, S, 3), cluster label per covered texel (-1 = none), cluster colours
    (C, 3) RGB, report)."""
    import cv2
    from scipy.spatial import cKDTree

    from pipeline.avatar.texture import REGIONS, texel_regions

    rng = np.random.default_rng(seed)
    reg, _ = texel_regions(asset, tm)
    col = tex_seen[tm.ys, tm.xs].astype(np.float32)
    lab = cv2.cvtColor((np.clip(col, 0, 255) / 255.0).reshape(-1, 1, 3).astype(np.float32), cv2.COLOR_RGB2Lab).reshape(-1, 3)
    P = texel_points(asset.positions, asset, tm)
    label = np.full(len(col), -1, np.int64)
    centres: list[np.ndarray] = []
    rep: dict = {"seen": round(float(seen.mean()), 4), "regions": {}}
    for r, name in enumerate(REGIONS):
        sel = np.nonzero(seen & (reg == r))[0]
        if len(sel) < 200:
            continue
        ctr, cnt = colour_clusters(lab[sel], n_colours, merge_de, min_share, rng)
        a = np.argmin(((lab[sel, None, :] - np.asarray(ctr)[None]) ** 2).sum(-1), 1)
        label[sel] = len(centres) + a
        rgb = [cv2.cvtColor(c.astype(np.float32).reshape(1, 1, 3), cv2.COLOR_Lab2RGB).reshape(3) * 255 for c in ctr]
        rep["regions"][name] = [{"rgb": [int(round(x)) for x in rgb[i]], "share": round(float((a == i).mean()), 3)}
                                for i in range(len(ctr))]
        centres.extend(rgb)
    out = col.copy()
    todo = np.nonzero(~seen)[0]
    fallback = 0
    seen_idx = np.nonzero(seen)[0]
    if len(seen_idx) == 0:
        S = tm.size
        img = np.zeros((S, S, 3), np.float32)
        img[tm.ys, tm.xs] = out
        return img, label, np.zeros((0, 3)), dict(rep, filled=1.0, clusters=0)
    tree_all = cKDTree(P[seen_idx])
    k_all = min(knn, len(seen_idx))
    for r in range(len(REGIONS)):
        q = todo[reg[todo] == r]
        if not len(q):
            continue
        ref = seen_idx[reg[seen_idx] == r]
        dist = np.full((len(q), knn), np.inf)
        nb = np.full((len(q), knn), -1)
        far = np.ones(len(q), bool)
        if len(ref) >= knn:
            d1, n1 = cKDTree(P[ref]).query(P[q], k=knn, distance_upper_bound=radius, workers=-1)
            far = ~np.isfinite(d1[:, 0])
            dist, nb = d1, np.where(np.isfinite(d1), ref[np.minimum(n1, len(ref) - 1)], -1)
        if far.any():
            d2, n2 = tree_all.query(P[q[far]], k=k_all, workers=-1)
            d2, n2 = d2.reshape(int(far.sum()), k_all), n2.reshape(int(far.sum()), k_all)
            dist[far] = np.inf
            nb[far] = -1
            dist[far, :k_all], nb[far, :k_all] = d2, seen_idx[n2]
            fallback += int(far.sum())
        wgt = np.where(nb >= 0, 1.0 / (np.where(np.isfinite(dist), dist, 1.0) + 0.01), 0.0)
        nl = np.where(nb >= 0, label[np.maximum(nb, 0)], -1)
        votes = np.zeros((len(q), max(len(centres), 1)))
        for j in range(knn):
            okj = nl[:, j] >= 0
            np.add.at(votes, (np.nonzero(okj)[0], nl[okj, j]), wgt[okj, j])
        win = np.argmax(votes, 1)
        none = votes.sum(1) <= 0  # no clustered neighbour: plain distance-weighted colour, no cluster
        win[none] = -1
        wsel = np.where(none[:, None], wgt, wgt * (nl == win[:, None]))
        out[q] = (col[np.maximum(nb, 0)] * wsel[..., None]).sum(1) / np.maximum(wsel.sum(1, keepdims=True), 1e-9)
        label[q] = win
    S = tm.size
    img = np.zeros((S, S, 3), np.float32)
    img[tm.ys, tm.xs] = out
    lim = np.full((S, S), -1, np.int64)
    lim[tm.ys, tm.xs] = label
    free = np.zeros((S, S), bool)
    free[tm.ys[~seen], tm.xs[~seen]] = True
    for _ in range(iters):  # diffusion inside each colour cluster; seen texels stay as they are
        acc = np.zeros_like(img)
        cnt = np.zeros((S, S), np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb_l = np.roll(lim, (dy, dx), (0, 1))
            same = (nb_l == lim) & (lim >= 0)
            acc += np.roll(img, (dy, dx), (0, 1)) * same[..., None]
            cnt += same
        upd = free & (cnt > 0)
        img[upd] = acc[upd] / cnt[upd, None]
    rep.update({"filled": round(float((~seen).mean()), 4), "filledOutsideRegion": fallback, "clusters": len(centres),
                "method": "garment colour clusters, 3D neighbours + diffusion"})
    return img, label, np.asarray(centres).reshape(-1, 3), rep


def colour_clusters(lab: np.ndarray, n: int, merge_de: float, min_share: float, rng) -> tuple[list[np.ndarray], list[float]]:
    """A few colour clusters (Lab centres and sizes) of the samples lab (N, 3): k-means++ with n centres, then the
    two nearest merged while they are closer than merge_de, and clusters under min_share of the samples merged into
    their nearest."""
    import cv2

    sub = lab[rng.choice(len(lab), min(60000, len(lab)), replace=False)] if len(lab) > 60000 else lab
    kk = min(n, len(sub))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.2)
    cv2.setRNGSeed(int(rng.integers(1 << 30)))
    _, _, ctr = cv2.kmeans(sub.astype(np.float32), kk, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    ctr = [c.astype(np.float64) for c in ctr]
    a = np.argmin(((lab[:, None, :] - np.asarray(ctr)[None]) ** 2).sum(-1), 1)
    cnt = [float((a == i).sum()) for i in range(len(ctr))]
    while len(ctr) > 1:
        d = np.array([[np.linalg.norm(ctr[i] - ctr[j]) if i != j else np.inf for j in range(len(ctr))] for i in range(len(ctr))])
        i, j = np.unravel_index(np.argmin(d), d.shape)
        small = int(np.argmin(cnt))
        if d[i, j] >= merge_de and cnt[small] >= min_share * len(lab):
            break
        if d[i, j] >= merge_de:
            i, j = small, int(np.argmin(d[small]))
        ctr[j] = (ctr[i] * cnt[i] + ctr[j] * cnt[j]) / max(cnt[i] + cnt[j], 1.0)
        cnt[j] += cnt[i]
        del ctr[i], cnt[i]
    return ctr, cnt


def fill(asset: Asset, tm: TexelMap, tex_seen: np.ndarray, seen_texel: np.ndarray, inpainter=None,
         back: dict | None = None, axis: int = 0, method: str = "garment") -> tuple[np.ndarray, bytes, dict]:
    """tex_seen (S,S,3) uint8, seen_texel (N,) bool over the covered texels. `back`: optional generated back
    {"colour": (N,3) float, "valid": (N,) bool} from backview.py. method: "garment" or "lama" (module docstring).
    Returns (image, jpeg bytes, report)."""
    S = tm.size
    col = tex_seen[tm.ys, tm.xs].astype(np.float32)
    known = seen_texel.copy()
    rep = {"method": method, "seen": round(float(seen_texel.mean()), 4)}
    if method == "lama":
        src = mirror_sources(asset, tm, axis)
        use = ~known & (src >= 0)
        use[use] &= seen_texel[src[use]]
        col[use] = col[src[use]]
        known |= use
        rep["mirrored"] = round(float(use.mean()), 4)
    if back is not None:
        b = ~known & back["valid"]
        col[b] = back["colour"][b]
        known |= b
        rep["generatedBack"] = round(float(b.mean()), 4)
    img = np.zeros((S, S, 3), np.float32)
    img[tm.ys, tm.xs] = col
    island = tm.tri >= 0
    rep["beforeFill"] = round(float(known.mean()), 4)
    if method == "garment":
        out, _, _, grep = garment_fill(asset, tm, img, known)
        rep.update({k: v for k, v in grep.items() if k not in ("seen", "method")})
    else:
        kmask = np.zeros((S, S), bool)
        kmask[tm.ys, tm.xs] = known
        out, irep = inpaint_islands(img, kmask, island, inpainter)
        rep.update(irep)
    final, jpeg = finish(out, island)
    rep["jpegBytes"] = len(jpeg)
    log("fill", f"{ {k: v for k, v in rep.items() if k != 'regions'} }")
    return final, jpeg, rep
