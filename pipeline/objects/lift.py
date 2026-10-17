"""Lift 2D object masks onto splats and describe each object.

This is the permissive core of the object layer: no model, no GPU. A caller supplies
splat centres, colours, one camera per keyframe, and a boolean mask per camera. The
module projects the splats, samples the masks, keeps what enough views agree on, and
returns an object record in the `objects.json` shape.

All input points are in the viewer (splat) frame, in metres. The output centre and
size are converted to studs with `studs_per_meter`, because that is the frame the
Roblox model and the object schema use.

The projection is the same pinhole projection as `pipeline/reality_split.py`.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import reality_split as rs  # noqa: E402

STUDS_PER_METER = 3.57
MIN_POINTS = 20


def sample_mask(mask: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """True where pixel (floor(u), floor(v)) is inside `mask` and inside the image."""
    m = np.asarray(mask, bool)
    if m.ndim != 2:
        raise ValueError(f"mask must be 2D, got {m.shape}")
    h, w = m.shape
    u = np.asarray(u, np.float64)
    v = np.asarray(v, np.float64)
    ok = np.isfinite(u) & np.isfinite(v)
    xi = np.floor(np.where(ok, u, 0.0)).astype(np.int64)
    yi = np.floor(np.where(ok, v, 0.0)).astype(np.int64)
    inside = ok & (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
    out = np.zeros(u.shape, bool)
    out[inside] = m[yi[inside], xi[inside]]
    return out


def mask_points(
    points: np.ndarray,
    cam: rs.InputCamera,
    mask: np.ndarray,
    depth: np.ndarray | None = None,
    abs_tol: float = rs.DEFAULT_ABS_TOL,
    rel_tol: float = rs.DEFAULT_REL_TOL,
    use_crop: bool = False,
) -> np.ndarray:
    """Splat centres that project into `mask`. With `depth`, hidden points are removed too."""
    u, v, _, in_front = rs.project_points(points, cam)
    hit = in_front & sample_mask(mask, u, v)
    if depth is not None:
        hit &= rs.classify_seen(points, cam, depth, abs_tol, rel_tol, use_crop)
    return hit


def merge_votes(votes: list[np.ndarray], min_views: int = 2) -> np.ndarray:
    """True where at least `min_views` masks agree."""
    if not votes:
        return np.zeros(0, bool)
    stack = np.stack([np.asarray(v, bool) for v in votes], axis=0)
    return stack.sum(axis=0) >= max(1, int(min_views))


def robust_bounds(points: np.ndarray, low: float = 1.0, high: float = 99.0) -> tuple[np.ndarray, np.ndarray]:
    """Percentile bounds, so a few stray splats do not inflate the box."""
    p = np.asarray(points, np.float64)
    if p.ndim != 2 or p.shape[1] != 3 or len(p) == 0:
        raise ValueError("points must be N x 3 and not empty")
    return np.percentile(p, low, axis=0), np.percentile(p, high, axis=0)


def median_color(colors: np.ndarray, scale: float = 255.0) -> list[int]:
    """Per-channel median colour, rounded and clamped to 0..255."""
    c = np.asarray(colors, np.float64)
    if c.ndim != 2 or c.shape[1] != 3 or len(c) == 0:
        raise ValueError("colors must be N x 3 and not empty")
    lo, hi = float(np.min(c)), float(np.max(c))
    if hi <= 1.0 and lo >= 0.0:
        c = c * 255.0
    out = np.clip(np.round(np.median(c, axis=0)), 0, 255).astype(int)
    return [int(v) for v in out]


def _slug(label: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in label.lower()).strip("-") or "object"


def describe_object(
    points: np.ndarray,
    colors: np.ndarray,
    label: str,
    views: list[tuple[rs.InputCamera, np.ndarray]],
    min_views: int = 2,
    min_points: int = MIN_POINTS,
    studs_per_meter: float = STUDS_PER_METER,
    shape: str = "box",
) -> dict | None:
    """Return one object record, or None when too few splats survive the masks.

    `views` is [(camera, mask), ...] in the same frame as `points`.
    """
    points = np.asarray(points, np.float64)
    colors = np.asarray(colors, np.float64)
    if len(points) != len(colors):
        raise ValueError("points and colors must have the same length")
    votes = [mask_points(points, cam, mask) for cam, mask in views]
    keep = merge_votes(votes, min_views)
    if int(keep.sum()) < int(min_points):
        return None
    p = points[keep]
    c = colors[keep]
    lo, hi = robust_bounds(p)
    centre_m = (lo + hi) / 2.0
    size_m = np.maximum(hi - lo, 1e-6)
    agreement = np.stack(votes, axis=0)[:, keep].mean(axis=0) if votes else np.ones(len(p))
    confidence = float(np.clip(agreement.mean(), 0.0, 1.0))
    return {
        "id": _slug(label),
        "label": label,
        "confidence": round(confidence, 4),
        "center": [round(float(v) * studs_per_meter, 3) for v in centre_m],
        "size": [round(float(v) * studs_per_meter, 3) for v in size_m],
        "yaw": 0.0,
        "shape": shape,
        "color": median_color(c),
        "parts": [],
        "source": {"splats": int(keep.sum())},
    }
