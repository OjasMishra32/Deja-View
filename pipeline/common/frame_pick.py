"""Pick the best still: the sharpest photo, or the sharpest, steadiest frame of a video."""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import numpy as np

from .media import fit_size, iter_frames, load_image, probe


def _gray(rgb: np.ndarray, long_side: int = 640) -> np.ndarray:
    import cv2

    h, w = rgb.shape[:2]
    s = min(1.0, long_side / max(h, w))
    if s < 1.0:
        rgb = cv2.resize(rgb, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)


def sharpness(rgb: np.ndarray) -> float:
    """Variance of the Laplacian at a fixed working resolution (higher = sharper)."""
    import cv2

    g = _gray(rgb)
    return float(cv2.Laplacian(g, cv2.CV_32F, ksize=3).var())


def exposure_penalty(rgb: np.ndarray) -> float:
    """0 for a well exposed image, up to 1 when most pixels are clipped black or white."""
    g = _gray(rgb, 256)
    clipped = float(np.mean((g < 8) | (g > 247)))
    return min(1.0, clipped * 2.0)


def best_photo(paths: list[Path]) -> tuple[Path, list[dict]]:
    scores = []
    for p in paths:
        try:
            img = load_image(p)
        except Exception as e:
            scores.append({"file": p.name, "error": str(e), "score": -1.0})
            continue
        s = sharpness(img)
        res = min(1.0, (img.shape[0] * img.shape[1]) / (1280 * 720))
        score = np.log1p(s) * (1.0 - 0.5 * exposure_penalty(img)) * (0.7 + 0.3 * res)
        scores.append({"file": p.name, "sharpness": round(s, 2), "score": float(score)})
    valid = [(sc["score"], p) for sc, p in zip(scores, paths) if sc["score"] >= 0]
    if not valid:
        raise ValueError("none of the photos could be read")
    return max(valid, key=lambda t: t[0])[1], scores


@dataclass
class FramePick:
    time: float
    index: int
    score: float
    sharpness: float
    motion: float
    image: np.ndarray


def best_video_frame(path: Path, samples_per_second: float = 4.0, max_samples: int = 240, motion_weight: float = 4.0) -> FramePick:
    """Score sampled frames by log Laplacian variance minus a penalty for frame-to-frame change.

    Motion is the mean absolute difference to the neighbouring samples (0..1 scale); a blurred,
    moving frame loses to a sharp, still one. The chosen frame is decoded again at full size.
    """
    info = probe(path)
    dur = max(info.duration, 1e-3)
    rate = min(samples_per_second, max_samples / dur, info.fps)
    rate_frac = Fraction(rate).limit_denominator(1000)
    aw, ah = fit_size(info.width, info.height, 480, 2)
    grays, sharp = [], []
    for fr in iter_frames(path, (aw, ah), fps=rate_frac):
        grays.append(_gray(fr, 480))
        sharp.append(sharpness(fr) if max(aw, ah) >= 640 else _lap_var(grays[-1]))
        if len(grays) >= max_samples:
            break
    n = len(grays)
    motion = np.zeros(n, dtype=np.float32)
    for i in range(n):
        d = []
        if i > 0:
            d.append(float(np.mean(np.abs(grays[i] - grays[i - 1]))) / 255.0)
        if i + 1 < n:
            d.append(float(np.mean(np.abs(grays[i + 1] - grays[i]))) / 255.0)
        motion[i] = float(np.mean(d)) if d else 0.0
    sharp_arr = np.asarray(sharp, dtype=np.float32)
    # Ignore the first/last 3% (fades, phone handling at the start and end of a recording).
    lo, hi = int(n * 0.03), max(int(n * 0.97), 1)
    idx = np.arange(n)
    valid = (idx >= lo) & (idx < hi) if n > 10 else np.ones(n, bool)
    score = np.log1p(sharp_arr) - motion_weight * motion * 10.0
    score[~valid] = -np.inf
    best = int(np.argmax(score))
    t = best / float(rate_frac)
    full = next(iter_frames(path, (info.width - info.width % 2, info.height - info.height % 2), start=t, max_frames=1))
    return FramePick(time=t, index=best, score=float(score[best]), sharpness=float(sharp_arr[best]), motion=float(motion[best]), image=full)


def _lap_var(gray: np.ndarray) -> float:
    import cv2

    return float(cv2.Laplacian(gray, cv2.CV_32F, ksize=3).var())
