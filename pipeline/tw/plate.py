"""Background plate: robust temporal median of sampled frames, ignoring people and moving things.

Pixels no sample ever saw (someone stood there the whole clip) are inpainted with Big LaMa
(common.models.Inpainter) when it is available, with the mirrored-texture fill as the fallback,
and the plate depth there is filled from the surrounding background (fill_depth_holes).
"""
from __future__ import annotations

import time

import numpy as np

SENTINEL = 1024  # sorts after every valid uint8 value

# Never-seen region handed to the inpainter: the holes grown by this fraction of the long side
# (~5 px at 1280), since the plate right at a person's edge still carries their halo. The fill is
# blended over the same width outside the region so no seam shows.
INPAINT_DILATE_FRAC = 0.004
INPAINT_FEATHER_FRAC = 0.004
# Context around the region's bounding box given to the inpainter (fraction of the box's long
# side, at least INPAINT_MIN_MARGIN px), and the largest long side it runs at; a bigger crop is
# resized down and the fill resized back.
INPAINT_MARGIN_FRAC = 0.5
INPAINT_MIN_MARGIN = 96
INPAINT_MAX_SIDE = 1280


def masked_temporal_median(frames: np.ndarray, exclude: np.ndarray | None = None, chunk_rows: int = 48) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel median over time of (N, H, W, C) uint8 frames, skipping excluded samples.

    exclude: (N, H, W) bool, True where a sample must not vote (a person, a moving object).
    Returns (median uint8 (H, W, C), count of valid samples (H, W) int32). Where no sample is
    valid the plain median of all samples is returned and count is 0. Excluded samples get a
    sentinel that sorts after every valid value, so the median of the valid ones sits at index
    (count - 1) // 2 of the sorted samples.
    """
    frames = np.asarray(frames)
    n, h, w = frames.shape[:3]
    c = frames.shape[3] if frames.ndim == 4 else 1
    f4 = frames.reshape(n, h, w, c)
    out = np.empty((h, w, c), np.uint8)
    counts = np.empty((h, w), np.int32)
    for r0 in range(0, h, chunk_rows):
        r1 = min(h, r0 + chunk_rows)
        # (rows, w, c, n): time on the contiguous axis makes the sort ~6x faster
        block = np.ascontiguousarray(np.moveaxis(f4[:, r0:r1], 0, -1)).astype(np.int16)
        if exclude is not None:
            ex = np.ascontiguousarray(np.moveaxis(np.asarray(exclude[:, r0:r1], bool), 0, -1))  # (rows, w, n)
            cnt = (~ex).sum(axis=-1).astype(np.int32)
            block[np.broadcast_to(ex[:, :, None, :], block.shape)] = SENTINEL
        else:
            cnt = np.full((r1 - r0, w), n, np.int32)
        block.sort(axis=-1)
        idx = np.clip((cnt - 1) // 2, 0, n - 1)
        med = np.take_along_axis(block, np.broadcast_to(idx[:, :, None, None], (r1 - r0, w, c, 1)), axis=-1)[..., 0]
        none = cnt == 0
        if none.any():
            med[none] = np.median(f4[:, r0:r1][:, none], axis=0)
        out[r0:r1] = np.clip(med, 0, 255).astype(np.uint8)
        counts[r0:r1] = cnt
    if frames.ndim == 3:
        return out[..., 0], counts
    return out, counts


def _mask_res(h: int, w: int, long_side: int = 480) -> tuple[int, int]:
    s = min(1.0, long_side / max(h, w))
    return max(8, round(w * s)), max(8, round(h * s))


def moving_exclusion(frames: np.ndarray, plate: np.ndarray, thresh: float | None = None, dilate_frac: float = 0.006) -> np.ndarray:
    """Samples that differ clearly from a first plate estimate (hands, pans, food that moved).

    Computed at ~480 px and upsampled: the result is dilated anyway.
    """
    import cv2

    n, h, w = frames.shape[:3]
    mw, mh = _mask_res(h, w)
    pb = cv2.GaussianBlur(cv2.resize(plate, (mw, mh), interpolation=cv2.INTER_AREA), (3, 3), 0).astype(np.int16)
    r = max(1, int(round(dilate_frac * max(mw, mh))))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    out = np.zeros((n, h, w), bool)
    for i in range(n):
        fb = cv2.GaussianBlur(cv2.resize(frames[i], (mw, mh), interpolation=cv2.INTER_AREA), (3, 3), 0).astype(np.int16)
        d = np.abs(fb - pb).max(axis=2).astype(np.float32)
        t = thresh if thresh is not None else max(18.0, 3.0 * 1.4826 * float(np.median(d)))
        m = (d > t).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        m = cv2.dilate(m, k)
        out[i] = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST) > 0
    return out


def mirror_fill_rows(img: np.ndarray, holes: np.ndarray) -> np.ndarray:
    """Fill each row's hole runs with the texture on either side, mirrored and cross-faded.

    People leave tall holes in front of walls, cabinets and tiles; continuing the neighbouring
    texture keeps bricks and cabinet lines plausible where a diffusion inpaint would smear.
    """
    out = img.astype(np.float32).copy()
    h, w = holes.shape
    for y in range(h):
        row = holes[y]
        if not row.any():
            continue
        d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
        starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
        src = img[y].astype(np.float32)
        for x0, x1 in zip(starts, ends):
            n = x1 - x0
            i = np.arange(n)
            has_l, has_r = x0 > 0, x1 < w
            if has_l:
                li = x0 - 1 - (i % max(x0, 1))  # mirror of the pixels left of the hole
                left = src[np.clip(li, 0, w - 1)]
            if has_r:
                ri = x1 + ((n - 1 - i) % max(w - x1, 1))  # mirror of the pixels right of the hole
                right = src[np.clip(ri, 0, w - 1)]
            if has_l and has_r:
                t = ((i + 0.5) / n)[:, None]
                out[y, x0:x1] = left * (1 - t) + right * t
            elif has_l:
                out[y, x0:x1] = left
            elif has_r:
                out[y, x0:x1] = right
    return np.clip(out, 0, 255).astype(np.uint8)


def fill_holes(plate: np.ndarray, holes: np.ndarray) -> np.ndarray:
    """Fill pixels no sample ever saw (someone stood there the whole time).

    Row-wise mirrored texture from both sides, lightly blurred vertically inside the hole so the
    rows agree, then a thin diffusion inpaint along the seam.
    """
    import cv2

    holes = np.asarray(holes, bool)
    if not holes.any():
        return plate
    hm = cv2.dilate(holes.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    out = mirror_fill_rows(plate, hm)
    soft = cv2.GaussianBlur(out, (1, 9), 0)
    out = np.where(hm[..., None], soft, out)
    ring = (cv2.dilate(hm.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0) & (cv2.erode(hm.astype(np.uint8), np.ones((7, 7), np.uint8)) == 0)
    return cv2.inpaint(out, ring.astype(np.uint8), 3, cv2.INPAINT_TELEA)


def _px(frac: float, shape: tuple[int, ...], lo: int = 1) -> int:
    return max(lo, int(round(frac * max(shape[:2]))))


def _disk_dilate(mask: np.ndarray, r: int) -> np.ndarray:
    import cv2

    if r <= 0:
        return np.asarray(mask, bool).copy()
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    return cv2.dilate(np.asarray(mask, np.uint8), k) > 0


def inpaint_region(holes: np.ndarray, dilate_px: int | None = None) -> np.ndarray:
    """The never-seen holes grown by dilate_px (default INPAINT_DILATE_FRAC of the long side)."""
    holes = np.asarray(holes, bool)
    r = _px(INPAINT_DILATE_FRAC, holes.shape) if dilate_px is None else int(dilate_px)
    return _disk_dilate(holes, r)


def feather_alpha(region: np.ndarray, feather_px: int) -> np.ndarray:
    """1 on the region, falling linearly to 0 over feather_px outside it (float32)."""
    import cv2

    region = np.asarray(region, bool)
    if feather_px <= 0 or not region.any():
        return region.astype(np.float32)
    d = cv2.distanceTransform((~region).astype(np.uint8), cv2.DIST_L2, 5)
    return np.clip(1.0 - d / float(feather_px + 1), 0.0, 1.0).astype(np.float32)


def _crop_box(mask: np.ndarray, margin_frac: float, min_margin: int) -> tuple[int, int, int, int]:
    """(y0, y1, x0, x1) around the mask's bounding box plus a margin, clipped to the image."""
    h, w = mask.shape
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    y0, y1, x0, x1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    m = max(min_margin, int(round(margin_frac * max(y1 - y0, x1 - x0))))
    return max(0, y0 - m), min(h, y1 + m), max(0, x0 - m), min(w, x1 + m)


def inpaint_holes(
    plate: np.ndarray,
    holes: np.ndarray,
    inpaint,
    dilate_px: int | None = None,
    feather_px: int | None = None,
    max_side: int = INPAINT_MAX_SIDE,
    margin_frac: float = INPAINT_MARGIN_FRAC,
    min_margin: int = INPAINT_MIN_MARGIN,
) -> tuple[np.ndarray, dict]:
    """Fill never-seen plate pixels with an inpainting model.

    inpaint(rgb uint8 (h,w,3), mask bool (h,w)) -> rgb uint8 (h,w,3), e.g. common.models.Inpainter.
    The holes are dilated, the model sees a crop around them (with context, resized down when its
    long side exceeds max_side), and its output is blended in with a feathered edge. Pixels
    farther than dilate_px + feather_px from a hole are returned unchanged.
    Returns (plate, info) with info = {region: inpainted fraction, crop: [x0, y0, w, h], scale}.
    """
    import cv2

    plate = np.asarray(plate, np.uint8)
    holes = np.asarray(holes, bool)
    if holes.shape != plate.shape[:2]:
        raise ValueError(f"holes {holes.shape} do not match the plate {plate.shape[:2]}")
    if not holes.any():
        return plate, {"region": 0.0, "crop": None, "scale": 1.0}
    region = inpaint_region(holes, dilate_px)
    fpx = _px(INPAINT_FEATHER_FRAC, holes.shape) if feather_px is None else int(feather_px)
    alpha = feather_alpha(region, fpx)
    y0, y1, x0, x1 = _crop_box(alpha > 0, margin_frac, min_margin)
    sub, sub_mask = plate[y0:y1, x0:x1], region[y0:y1, x0:x1]
    ch, cw = sub_mask.shape
    s = min(1.0, max_side / max(ch, cw))
    if s < 1.0:
        sw, sh = max(8, int(round(cw * s))), max(8, int(round(ch * s)))
        net_in = cv2.resize(sub, (sw, sh), interpolation=cv2.INTER_AREA)
        # Any overlap with a hole marks the low-resolution pixel (nothing unseen leaks in).
        net_mask = cv2.resize(sub_mask.astype(np.float32), (sw, sh), interpolation=cv2.INTER_AREA) > 0
        filled = np.asarray(inpaint(net_in, net_mask), np.uint8)
        filled = cv2.resize(filled, (cw, ch), interpolation=cv2.INTER_CUBIC)
    else:
        filled = np.asarray(inpaint(sub, sub_mask), np.uint8)
    if filled.shape != sub.shape:
        raise ValueError(f"inpainter returned {filled.shape}, expected {sub.shape}")
    a = alpha[y0:y1, x0:x1, None]
    out = plate.copy()
    out[y0:y1, x0:x1] = np.clip(np.rint(a * filled.astype(np.float32) + (1.0 - a) * sub.astype(np.float32)), 0, 255).astype(np.uint8)
    return out, {"region": float(region.mean()), "crop": [int(x0), int(y0), int(cw), int(ch)], "scale": round(float(s), 4)}


class LamaFill:
    """Lazily loaded Big LaMa (common.models.Inpainter) for inpaint_holes: the weights load on the
    first call, so a plate without holes costs nothing. release() frees the model."""

    def __init__(self, device: str | None = None, name: str | None = None):
        self.device = device
        self.name = name
        self.model = None
        self.load_seconds = 0.0

    def __call__(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        if self.model is None:
            from common.models import DEFAULT_INPAINTER, Inpainter

            t0 = time.time()
            self.model = Inpainter(self.name or DEFAULT_INPAINTER, device=self.device)
            self.load_seconds = time.time() - t0
        out = self.model(rgb, mask)
        self.device = self.model.device  # may have moved from MPS to the CPU
        return out

    def release(self) -> None:
        if self.model is not None:
            dev = self.model.device
            self.model = None
            try:
                from common.device import empty_cache

                empty_cache(dev)
            except Exception:
                pass


def fill_depth_holes(
    depth: np.ndarray,
    rgb: np.ndarray,
    holes: np.ndarray,
    dilate_px: int | None = None,
    sigma_color: float = 10.0,
    floor_weight: float = 1e-3,
    occluder_rel: float = 0.15,
    occluder_weight: float = 1e-3,
    inner_band: tuple[float, float] = (0.01, 0.03),
) -> tuple[np.ndarray, dict]:
    """Replace depth in the never-seen region with a smooth fill from the background around it.

    The region is the one inpaint_holes repaints (the holes dilated by dilate_px). Inverse depth
    there solves a Laplace equation with the known depth around it as the boundary; neighbour
    weights fall off with the colour difference of the inpainted plate (CIELAB, sigma_color), so
    the fill follows the inpainted edges (a wall and a counter top below it are continued
    separately). On evenly coloured areas planes stay planes (an affine function of the pixel is
    harmonic), and the fill always stays within the range of its boundary (maximum principle).
    Someone stood in front of the region the whole clip, so it lies behind them. A boundary pixel
    clearly nearer (by more than occluder_rel in inverse depth) than the depth just inside the
    region is an object in front of where they stood (a blender, the front edge of a counter), not
    background continuing behind them, and pulls on the fill with only occluder_weight of its
    normal weight. "Just inside" is the input depth (the network's estimate on the inpainted
    plate) inner_band (fractions of the long side) into the region; it is used only for that
    comparison.
    rgb is resized to depth's size when they differ. Returns (depth float32, info).
    """
    import cv2
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve

    depth = np.asarray(depth, np.float32)
    h, w = depth.shape
    holes = np.asarray(holes, bool)
    if holes.shape != (h, w):
        holes = cv2.resize(holes.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
    if not holes.any():
        return depth, {"region": 0.0, "occluderPx": 0}
    region = inpaint_region(holes, dilate_px)
    if region.all():
        return depth, {"region": 1.0, "occluderPx": 0, "skipped": "no known depth"}
    rgb = np.asarray(rgb, np.uint8)
    if rgb.shape[:2] != (h, w):
        rgb = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(cv2.GaussianBlur(rgb, (3, 3), 0), cv2.COLOR_RGB2LAB).astype(np.float32)
    lab[..., 0] *= 100.0 / 255.0  # 8-bit L runs 0-255; a and b are already ~1 unit per step
    inv = (1.0 / np.maximum(depth, 1e-4)).astype(np.float32)

    cross = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], np.uint8)
    boundary = (cv2.dilate(region.astype(np.uint8), cross) > 0) & ~region
    # Depth 1-3% of the long side into the region (past the soft ramp the network draws at an
    # edge, and past the few pixels of an object the inpainter may have extended), averaged
    # around each boundary pixel.
    d_in = cv2.distanceTransform(region.astype(np.uint8), cv2.DIST_L2, 3)
    a = _px(inner_band[0], (h, w), 2)
    b = max(a + 2, _px(inner_band[1], (h, w), 4))
    inner = (region & (d_in >= a) & (d_in <= b)).astype(np.float32)
    k = (2 * b + 1, 2 * b + 1)
    den = cv2.boxFilter(inner, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    num = cv2.boxFilter(inv * inner, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    inside = num / np.maximum(den, 1e-6)
    occluder = boundary & (den > 0.5) & (inv > inside * (1.0 + occluder_rel))

    ys, xs = np.nonzero(region)
    n = ys.size
    idx = np.full((h, w), -1, np.int64)
    idx[ys, xs] = np.arange(n)
    diag = np.zeros(n, np.float64)
    rhs = np.zeros(n, np.float64)
    rows, cols, vals = [], [], []
    inv_s2 = 1.0 / (2.0 * sigma_color * sigma_color)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        ny, nx = ys + dy, xs + dx
        ok = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
        i = np.flatnonzero(ok)
        py, px_, qy, qx = ys[ok], xs[ok], ny[ok], nx[ok]
        d2 = ((lab[py, px_] - lab[qy, qx]) ** 2).sum(axis=1)
        wt = np.exp(-d2 * inv_s2) + floor_weight
        j = idx[qy, qx]
        unk = j >= 0
        wt = np.where(~unk & occluder[qy, qx], wt * occluder_weight, wt)
        diag[i] += wt
        rows.append(i[unk])
        cols.append(j[unk])
        vals.append(-wt[unk])
        known = ~unk
        np.add.at(rhs, i[known], wt[known] * inv[qy[known], qx[known]])
    rows.append(np.arange(n))
    cols.append(np.arange(n))
    vals.append(diag)
    A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsc()
    sol = spsolve(A, rhs)
    sol = np.clip(sol, float(inv[boundary].min()), float(inv[boundary].max()))
    out = depth.copy()
    out[ys, xs] = (1.0 / np.maximum(sol, 1e-6)).astype(np.float32)
    return out, {"region": float(region.mean()), "occluderPx": int(occluder.sum())}


def build_plate(
    frames: np.ndarray,
    person: np.ndarray | None,
    person_thresh: float = 0.3,
    person_dilate_frac: float = 0.02,
    min_votes: int = 2,
    log=None,
    inpaint=None,
) -> tuple[np.ndarray, np.ndarray, dict]:
    """Two-pass plate: exclude people, then also exclude whatever still moves against pass one.

    frames: (N, H, W, 3) uint8 samples; person: (N, H, W) person probability or None.
    inpaint: model for the never-seen holes (inpaint_holes; e.g. LamaFill), None for the
    mirrored-texture fill, which is also the fallback when the model fails to load or run.
    Returns (plate uint8, holes bool, stats); stats["inpaint"] says how the holes were filled.
    """
    import cv2

    n, h, w = frames.shape[:3]
    ex = np.zeros((n, h, w), bool)
    if person is not None:
        # Dilate at ~480 px (cheap), then upsample; person maps may come at any resolution.
        mw, mh = _mask_res(h, w)
        r = max(1, int(round(person_dilate_frac * max(mw, mh))))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        for i in range(n):
            pm = cv2.resize(np.asarray(person[i], np.float32), (mw, mh), interpolation=cv2.INTER_LINEAR)
            m = cv2.dilate((pm > person_thresh).astype(np.uint8), k)
            ex[i] = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST) > 0
    plate1, cnt1 = masked_temporal_median(frames, ex)
    moving = moving_exclusion(frames, plate1)
    ex2 = ex | moving
    plate2, cnt2 = masked_temporal_median(frames, ex2)
    # Where pass two leaves too few votes, keep pass one (it still excludes people).
    weak = cnt2 < min_votes
    plate = np.where(weak[..., None] & (cnt1 >= min_votes)[..., None], plate1, plate2)
    holes = (cnt1 < min_votes) & weak
    stats = {
        "samples": int(n),
        "personFrac": float(ex.mean()),
        "movingFrac": float(moving.mean()),
        "holeFrac": float(holes.mean()),
    }
    if log:
        log(f"plate: {n} samples, people {stats['personFrac']:.1%}, moving {stats['movingFrac']:.1%}, never seen {stats['holeFrac']:.2%}")
    if holes.any():
        plate, stats["inpaint"] = fill_never_seen(plate, holes, inpaint, log=log)
    return plate, holes, stats


def fill_never_seen(plate: np.ndarray, holes: np.ndarray, inpaint=None, log=None) -> tuple[np.ndarray, dict]:
    """Inpaint the never-seen holes with `inpaint` (see inpaint_holes), falling back to the
    mirrored-texture fill when it is None or fails. Returns (plate, info) and logs the method,
    the inpainted fraction and the time."""
    t0 = time.time()
    holes = np.asarray(holes, bool)
    info: dict = {"method": "mirror", "holeFrac": float(holes.mean())}
    if inpaint is not None:
        try:
            out, extra = inpaint_holes(plate, holes, inpaint)
            load = float(getattr(inpaint, "load_seconds", 0.0) or 0.0)
            info.update(extra, method="lama", device=getattr(inpaint, "device", None), seconds=round(time.time() - t0, 3), loadSeconds=round(load, 3))
            if log:
                crop = info["crop"]
                log(f"plate inpaint: LaMa on {info['device']} filled {info['region']:.2%} of the plate (never seen {info['holeFrac']:.2%} + "
                    f"{_px(INPAINT_DILATE_FRAC, holes.shape)} px) in {info['seconds']:.2f}s incl. {load:.2f}s model load; "
                    f"crop {crop[2]}x{crop[3]} at ({crop[0]},{crop[1]}), scale {info['scale']:.2f}")
            return out, info
        except Exception as e:  # missing weights, offline, out of memory: the old fill still works
            info["error"] = f"{type(e).__name__}: {e}"[:300]
            if log:
                log(f"plate inpaint: LaMa unavailable ({info['error']}); using the mirrored-texture fill")
    t1 = time.time()
    out = fill_holes(plate, holes)
    info["seconds"] = round(time.time() - t1, 3)
    if log:
        log(f"plate inpaint: mirrored-texture fill of {info['holeFrac']:.2%} never seen in {info['seconds']:.2f}s")
    return out, info
