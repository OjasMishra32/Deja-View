"""Background plate: robust temporal median of sampled frames, ignoring people and moving things."""
from __future__ import annotations

import numpy as np

SENTINEL = 1024  # sorts after every valid uint8 value


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


def build_plate(
    frames: np.ndarray,
    person: np.ndarray | None,
    person_thresh: float = 0.3,
    person_dilate_frac: float = 0.02,
    min_votes: int = 2,
    log=None,
) -> tuple[np.ndarray, np.ndarray, dict]:
    """Two-pass plate: exclude people, then also exclude whatever still moves against pass one.

    frames: (N, H, W, 3) uint8 samples; person: (N, H, W) person probability or None.
    Returns (plate uint8, holes bool, stats).
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
    if holes.any():
        plate = fill_holes(plate, holes)
    if log:
        log(f"plate: {n} samples, people {stats['personFrac']:.1%}, moving {stats['movingFrac']:.1%}, never seen {stats['holeFrac']:.2%}")
    return plate, holes, stats
