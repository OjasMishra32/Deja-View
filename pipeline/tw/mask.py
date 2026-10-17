"""Foreground mask: (difference from the plate) united with person segmentation, then cleaned.

Missing a hand is much worse than keeping a bit of background: background pixels inside the mask
are drawn at the plate depth, i.e. on top of the matching room surface, so false positives stay
nearly invisible. Every step is therefore biased towards keeping foreground.
"""
from __future__ import annotations

import numpy as np


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def channel_gain(frame: np.ndarray, plate: np.ndarray) -> np.ndarray:
    """Per-channel gain mapping the plate to the frame's exposure (phones re-expose while filming).

    Estimated as a median ratio over pixels that are not very different, so the person does not
    bias it. Clamped to +-25%.
    """
    f = frame.reshape(-1, 3).astype(np.float32)
    p = plate.reshape(-1, 3).astype(np.float32)
    ok = (p.min(axis=1) > 20) & (p.max(axis=1) < 235)
    if ok.sum() < 100:
        return np.ones(3, np.float32)
    f, p = f[ok], p[ok]
    rough = np.abs(f - p).max(axis=1)
    sel = rough < np.percentile(rough, 60)
    if sel.sum() < 50:
        sel = np.ones(len(f), bool)
    g = np.median(f[sel] / p[sel], axis=0)
    return np.clip(g, 0.75, 1.25).astype(np.float32)


def diff_soft(frame: np.ndarray, plate: np.ndarray, floor_thresh: float = 14.0) -> tuple[np.ndarray, float]:
    """Soft change map in [0, 1] between a frame and the plate (same size, uint8 RGB).

    The threshold adapts to the clip's noise: max(floor_thresh, 2.5 x robust sigma of the
    difference). Returns (soft map, threshold used).
    """
    import cv2

    fb = cv2.GaussianBlur(frame, (5, 5), 0).astype(np.float32)
    pb = cv2.GaussianBlur(plate, (5, 5), 0).astype(np.float32)
    pb = pb * channel_gain(fb, pb)[None, None, :]
    d = np.abs(fb - pb).max(axis=2)
    sigma = 1.4826 * float(np.median(d))
    t = max(floor_thresh, 2.5 * sigma)
    return _smoothstep(0.75 * t, 1.5 * t, d).astype(np.float32), t


def fuse(diff: np.ndarray, person: np.ndarray) -> np.ndarray:
    return np.maximum(diff, person).astype(np.float32)


def remove_small_components(binary: np.ndarray, keep_near: np.ndarray | None, min_area: int) -> np.ndarray:
    """Drop connected components smaller than min_area unless they touch keep_near."""
    import cv2

    b = binary.astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(b, connectivity=8)
    if n <= 1:
        return binary.astype(bool)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    if keep_near is not None and keep_near.any():
        near_labels = np.unique(labels[keep_near & (labels > 0)])
        keep[near_labels] = True
    keep[0] = False
    return keep[labels]


def fill_small_holes(binary: np.ndarray, max_area: int) -> np.ndarray:
    """Fill background regions enclosed by foreground (not touching the border) up to max_area."""
    import cv2

    inv = (~binary.astype(bool)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    if n <= 1:
        return binary.astype(bool)
    h, w = binary.shape
    x, y, bw, bh, area = (stats[:, i] for i in range(5))
    touches = (x == 0) | (y == 0) | (x + bw >= w) | (y + bh >= h)
    fill = (~touches) & (area <= max_area)
    fill[0] = False
    return binary.astype(bool) | fill[labels]


def cleanup(binary: np.ndarray, person: np.ndarray | None, min_area_frac: float = 0.0008, hole_frac: float = 0.03, grow_px: int = 1) -> np.ndarray:
    """Morphological cleanup that keeps thin things (fingers, utensils) attached to the person."""
    import cv2

    h, w = binary.shape
    b = binary.astype(np.uint8)
    b = cv2.morphologyEx(b, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    b = cv2.morphologyEx(b, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    near = None
    if person is not None:
        near = cv2.dilate((person > 0.5).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    b = remove_small_components(b > 0, near, max(4, int(min_area_frac * h * w)))
    b = fill_small_holes(b, int(hole_frac * h * w))
    if grow_px > 0:
        b = cv2.dilate(b.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow_px + 1, 2 * grow_px + 1))) > 0
    return b


def temporal_decide(cur_soft: np.ndarray, window_soft: list[np.ndarray], weights: list[float]) -> np.ndarray:
    """Binary decision for one frame from its own soft mask and its neighbours'.

    Keeps everything the frame itself sees (fast hands) and fills short dropouts where the
    neighbourhood agrees.
    """
    acc = np.zeros_like(cur_soft, dtype=np.float32)
    wsum = 0.0
    for m, wt in zip(window_soft, weights):
        acc += wt * m.astype(np.float32)
        wsum += wt
    avg = acc / max(wsum, 1e-6)
    return (cur_soft > 0.5) | (avg > 0.5)


def feather(binary: np.ndarray, sigma: float = 1.0) -> np.ndarray:
    """uint8 alpha: 255 inside, soft fall-off over ~2 sigma outside the binary mask."""
    import cv2

    b = binary.astype(np.float32)
    soft = cv2.GaussianBlur(b, (0, 0), sigma)
    soft = np.maximum(soft * 2.0, b)  # keep the interior fully opaque, fade only outward
    return np.clip(np.rint(soft * 255.0), 0, 255).astype(np.uint8)
