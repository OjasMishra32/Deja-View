"""Step 7: texels the video never saw.

Order of preference for every unseen texel:
  (a) the mirrored texel (left <-> right across the body's sagittal plane, matched on the rest-pose surface with a
      k-d tree, within 1 cm) when that one was seen;
  (b) a generated view from directly behind (backview.py, Qwen-Image-Edit-2511) when the back is mostly unseen,
      written only into unseen back-facing texels of the torso, head and upper legs;
  (c) Big LaMa inpainting per UV island (context: a push-pull fill of the island);
then an 8 px gutter around every island (push-pull) so mipmaps never pull in black, and a JPEG at quality 90.
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


def fill(asset: Asset, tm: TexelMap, tex_seen: np.ndarray, seen_texel: np.ndarray, inpainter=None,
         back: dict | None = None, axis: int = 0) -> tuple[np.ndarray, bytes, dict]:
    """tex_seen (S,S,3) uint8, seen_texel (N,) bool over the covered texels. `back`: optional generated back
    {"colour": (N,3) float, "valid": (N,) bool} from backview.py. Returns (image, jpeg bytes, report)."""
    S = tm.size
    col = tex_seen[tm.ys, tm.xs].astype(np.float32)
    known = seen_texel.copy()
    src = mirror_sources(asset, tm, axis)
    use = ~known & (src >= 0)
    use[use] &= seen_texel[src[use]]
    col[use] = col[src[use]]
    known |= use
    rep = {"seen": round(float(seen_texel.mean()), 4), "mirrored": round(float(use.mean()), 4)}
    if back is not None:
        b = ~known & back["valid"]
        col[b] = back["colour"][b]
        known |= b
        rep["generatedBack"] = round(float(b.mean()), 4)
    img = np.zeros((S, S, 3), np.float32)
    img[tm.ys, tm.xs] = col
    kmask = np.zeros((S, S), bool)
    kmask[tm.ys, tm.xs] = known
    island = tm.tri >= 0
    rep["beforeInpaint"] = round(float(known.mean()), 4)
    out, irep = inpaint_islands(img, kmask, island, inpainter)
    rep.update(irep)
    final, jpeg = finish(out, island)
    rep["jpegBytes"] = len(jpeg)
    log("fill", f"{rep}")
    return final, jpeg, rep
