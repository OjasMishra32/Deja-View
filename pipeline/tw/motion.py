"""Camera motion check and optional stabilisation for "propped phone" clips.

Background corners of a reference image are tracked into each frame (pyramidal Lucas-Kanade,
forward-backward checked) and a similarity transform frame -> reference is fitted with RANSAC.
The displacement of the image corners under that transform measures how much the phone moved.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def _gray_small(rgb: np.ndarray, long_side: int) -> tuple[np.ndarray, float]:
    import cv2

    h, w = rgb.shape[:2]
    s = min(1.0, long_side / max(h, w))
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if s < 1.0:
        g = cv2.resize(g, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return g, s


@dataclass
class MotionEstimate:
    matrix: np.ndarray  # 2x3 affine, frame -> reference, full-resolution pixels
    displacement: float  # mean corner displacement in full-resolution pixels
    inliers: int
    ok: bool


class MotionTracker:
    def __init__(self, ref_rgb: np.ndarray, exclude: np.ndarray | None = None, long_side: int = 480, max_corners: int = 500):
        import cv2

        self.full_hw = ref_rgb.shape[:2]
        self.ref, self.s = _gray_small(ref_rgb, long_side)
        mask = None
        if exclude is not None:
            ex = cv2.resize(exclude.astype(np.uint8), (self.ref.shape[1], self.ref.shape[0]), interpolation=cv2.INTER_NEAREST)
            mask = ((1 - ex) * 255).astype(np.uint8)
        pts = cv2.goodFeaturesToTrack(self.ref, maxCorners=max_corners, qualityLevel=0.01, minDistance=7, mask=mask, blockSize=7)
        self.p0 = pts.reshape(-1, 2).astype(np.float32) if pts is not None else np.zeros((0, 2), np.float32)
        h, w = self.full_hw
        self.corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)

    def estimate(self, rgb: np.ndarray) -> MotionEstimate:
        import cv2

        ident = np.array([[1, 0, 0], [0, 1, 0]], np.float32)
        if len(self.p0) < 12:
            return MotionEstimate(ident, 0.0, 0, False)
        g, _ = _gray_small(rgb, int(round(max(self.ref.shape) )))
        if g.shape != self.ref.shape:
            g = cv2.resize(g, (self.ref.shape[1], self.ref.shape[0]), interpolation=cv2.INTER_AREA)
        lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
        p1, st, _ = cv2.calcOpticalFlowPyrLK(self.ref, g, self.p0.reshape(-1, 1, 2), None, **lk)
        p0r, st2, _ = cv2.calcOpticalFlowPyrLK(g, self.ref, p1, None, **lk)
        fb = np.linalg.norm(p0r.reshape(-1, 2) - self.p0, axis=1)
        good = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < 1.0)
        if good.sum() < 10:
            return MotionEstimate(ident, 0.0, int(good.sum()), False)
        src = p1.reshape(-1, 2)[good] / self.s  # frame, full-res
        dst = self.p0[good] / self.s  # reference, full-res
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.0 / self.s, maxIters=2000, confidence=0.995)
        if M is None:
            return MotionEstimate(ident, 0.0, 0, False)
        n_in = int(inl.sum()) if inl is not None else 0
        moved = (self.corners @ M[:, :2].T) + M[:, 2]
        disp = float(np.linalg.norm(moved - self.corners, axis=1).mean())
        return MotionEstimate(M.astype(np.float32), disp, n_in, n_in >= 8)


def warp(rgb: np.ndarray, M: np.ndarray) -> np.ndarray:
    import cv2

    h, w = rgb.shape[:2]
    return cv2.warpAffine(rgb, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def summarize(displacements: list[float], width: int) -> dict:
    d = np.asarray(displacements, np.float64) if displacements else np.zeros(1)
    return {
        "medianPx": float(np.median(d)),
        "p95Px": float(np.quantile(d, 0.95)),
        "maxPx": float(d.max()),
        "p95Frac": float(np.quantile(d, 0.95) / max(width, 1)),
    }
