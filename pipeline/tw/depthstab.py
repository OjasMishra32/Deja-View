"""Temporal stabilisation of per-frame monocular depth against the background plate.

Each frame's inverse depth x = 1/d_frame is mapped to the plate's inverse depth y = 1/d_plate with
y = a x + b, fitted robustly on static background pixels. (a, b) are smoothed over time so the
person does not breathe in and out of the room. Background pixels then take the plate depth
exactly, foreground pixels keep their aligned depth, and a motion-aware temporal filter removes
the remaining per-pixel flicker.
"""
from __future__ import annotations

import numpy as np


def fit_inverse_affine(x: np.ndarray, y: np.ndarray, iters: int = 4, keep: float = 0.8) -> tuple[float, float, float]:
    """Robust least squares for y = a x + b (trimmed: refit on the best `keep` fraction).

    Returns (a, b, rms of the kept residuals relative to mean y). Falls back to a pure scale
    (b = 0) when the affine fit is degenerate (a <= 0).
    """
    x = np.asarray(x, np.float64).ravel()
    y = np.asarray(y, np.float64).ravel()
    ok = np.isfinite(x) & np.isfinite(y) & (x > 0) & (y > 0)
    x, y = x[ok], y[ok]
    if x.size < 16:
        raise ValueError("too few samples for depth alignment")
    sel = np.ones(x.size, bool)
    a, b = 1.0, 0.0
    for _ in range(iters):
        xs, ys = x[sel], y[sel]
        A = np.stack([xs, np.ones_like(xs)], 1)
        sol, *_ = np.linalg.lstsq(A, ys, rcond=None)
        a, b = float(sol[0]), float(sol[1])
        r = np.abs(a * x + b - y)
        cut = np.quantile(r, keep)
        sel = r <= cut
    if not (a > 1e-3) or not np.isfinite(a):
        a = float(np.median(y / x))
        b = 0.0
        r = np.abs(a * x - y)
        sel = r <= np.quantile(r, keep)
    rms = float(np.sqrt(np.mean((a * x[sel] + b - y[sel]) ** 2)) / max(np.mean(y), 1e-9))
    return a, b, rms


def smooth_series(values: np.ndarray, valid: np.ndarray, median_win: int = 9, mean_win: int = 5) -> np.ndarray:
    """Fill invalid entries by linear interpolation, then a running median and a running mean."""
    from scipy.ndimage import median_filter, uniform_filter1d

    v = np.asarray(values, np.float64).copy()
    valid = np.asarray(valid, bool)
    n = len(v)
    if n == 0:
        return v
    if not valid.any():
        return np.ones(n) * (np.nanmedian(v) if np.isfinite(v).any() else 1.0)
    idx = np.arange(n)
    v = np.interp(idx, idx[valid], v[valid])
    if n >= 3:
        v = median_filter(v, size=min(median_win, n | 1), mode="nearest")
        v = uniform_filter1d(v, size=min(mean_win, n), mode="nearest")
    return v


def background_samples(alpha: np.ndarray, plate_inv: np.ndarray, edge_mask: np.ndarray, max_samples: int = 20000, rng: np.random.Generator | None = None) -> np.ndarray:
    """Indices (flat) of background pixels usable for alignment: outside the (dilated) mask and
    away from plate depth edges."""
    import cv2

    fg = cv2.dilate((alpha > 0).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    ok = (~fg) & (~edge_mask) & np.isfinite(plate_inv) & (plate_inv > 0)
    idx = np.flatnonzero(ok)
    if idx.size > max_samples:
        rng = rng or np.random.default_rng(0)
        idx = rng.choice(idx, max_samples, replace=False)
    return idx


def depth_edges(inv: np.ndarray, rel_thresh: float = 0.06) -> np.ndarray:
    """Pixels near inverse-depth discontinuities (relative change over a 5x5 window)."""
    import cv2

    k = np.ones((5, 5), np.uint8)
    mx = cv2.dilate(inv.astype(np.float32), k)
    mn = cv2.erode(inv.astype(np.float32), k)
    return (mx - mn) > rel_thresh * np.maximum(mx, 1e-6)


def snap_boundary(inv_fg: np.ndarray, alpha: np.ndarray, band_px: int = 4) -> np.ndarray:
    """Give pixels on and just inside the mask boundary the foreground's own (nearest) depth.

    Monocular depth blurs object edges into ramps; without this the person's silhouette would be
    smeared back towards the wall. Takes the local maximum of inverse depth over the binary
    foreground, for pixels within band_px of the binary mask edge and the feathered outer ring.
    """
    import cv2

    binary = alpha >= 128
    if not binary.any():
        return inv_fg
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band_px + 1, 2 * band_px + 1))
    fg_only = np.where(binary, inv_fg, 0).astype(np.float32)
    near_max = cv2.dilate(fg_only, k)
    inner = cv2.erode(binary.astype(np.uint8), k) > 0
    region = (alpha > 0) & ~inner
    out = inv_fg.copy()
    out[region] = np.maximum(inv_fg[region], near_max[region])
    return out


def temporal_bilateral(inv: list[np.ndarray], rgb: list[np.ndarray], center: int, sigma_rgb: float = 14.0, time_weights: list[float] | None = None) -> np.ndarray:
    """Motion-aware temporal filter: neighbours count only where the colour did not change."""
    n = len(inv)
    if time_weights is None:
        time_weights = [1.0] * n
    c_rgb = rgb[center].astype(np.float32)
    acc = np.zeros_like(inv[center], dtype=np.float32)
    wsum = np.zeros_like(acc)
    inv_s2 = 1.0 / (2.0 * sigma_rgb * sigma_rgb)
    for i in range(n):
        if i == center:
            w = np.full(acc.shape, time_weights[i], np.float32)
        else:
            d2 = ((rgb[i].astype(np.float32) - c_rgb) ** 2).sum(axis=2) / 3.0
            w = time_weights[i] * np.exp(-d2 * inv_s2)
        acc += w * inv[i].astype(np.float32)
        wsum += w
    return acc / np.maximum(wsum, 1e-6)


def choose_near_far(inv_samples: np.ndarray, lo_q: float = 0.001, hi_q: float = 0.999) -> tuple[float, float]:
    """near/far (metres) from robust percentiles of inverse depth, with margins."""
    v = np.asarray(inv_samples, np.float64)
    v = v[np.isfinite(v) & (v > 0)]
    if v.size == 0:
        return 0.3, 10.0
    inv_near = float(np.quantile(v, hi_q))
    inv_far = float(np.quantile(v, lo_q))
    near = max(0.05, 0.92 / inv_near)
    far = min(200.0, 1.08 / max(inv_far, 1e-6))
    if far < near * 1.5:
        far = near * 1.5
    return round(near, 4), round(far, 4)
