"""Furniture in front of the people, from the reconstructed world (for texture baking).

The person masks know nothing about the foosball table: where its cabinet or rods stand between the camera and a
player's legs, the visibility ray cast (bodies only) says the leg is visible and the leg texels take the table's
colours. Here the world's splat centres (world.spz) are drawn into a coarse per-frame depth map, keeping only
splats below `max_height` (furniture, not the ceiling or the trees) and farther than `body_gap` from any detected
body in that frame (the world can hold faint copies of the people themselves). A texel sample whose point lies
more than `margin` behind that depth is hidden by furniture and is not used.

SPZ reader: gzip stream; 16-byte header (magic 'NGSP', version, point count, SH degree, fractional bits, flags,
reserved); then positions (24-bit fixed point, version >= 2), alphas (uint8), colours, scales (uint8, log scale
= v / 16 - 10), rotations, SH. Only positions, alphas and scales are read.
"""

from __future__ import annotations

import gzip
import struct
from pathlib import Path

import numpy as np


def load_spz(path: Path) -> dict:
    raw = gzip.decompress(Path(path).read_bytes())
    magic, version, n, _sh, frac, _flags, _ = struct.unpack("<IIIBBBB", raw[:16])
    if magic != 0x5053474E:
        raise ValueError(f"{path}: not an SPZ file")
    o = 16
    if version == 1:
        pos = np.frombuffer(raw, np.float16, n * 3, o).astype(np.float32).reshape(n, 3)
        o += n * 6
    else:
        b = np.frombuffer(raw, np.uint8, n * 9, o).reshape(n, 3, 3).astype(np.int32)
        o += n * 9
        v = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)
        v = np.where(v & 0x800000, v - (1 << 24), v)
        pos = (v / float(1 << frac)).astype(np.float32)
    alpha = np.frombuffer(raw, np.uint8, n, o).astype(np.float32) / 255.0
    o += n + n * 3  # alphas, colours
    scale = np.exp(np.frombuffer(raw, np.uint8, n * 3, o).reshape(n, 3).astype(np.float32) / 16.0 - 10.0)
    return {"positions": pos, "alpha": alpha, "scale": scale}


class Occluders:
    """Splats below `max_height` (viewer frame, floor y = 0, y up), with their opacities."""

    def __init__(self, spz: Path, max_height: float = 1.05, min_alpha: float = 0.02, max_size: float = 0.15):
        d = load_spz(spz)
        keep = (d["alpha"] >= min_alpha) & (d["scale"].max(1) <= max_size) & (d["positions"][:, 1] < max_height) \
            & (d["positions"][:, 1] > 0.03)
        self.points = d["positions"][keep].astype(np.float64)
        self.alpha = np.clip(d["alpha"][keep].astype(np.float64), 0.0, 0.99)

    def depth(self, T_view_cv: np.ndarray, K: np.ndarray, hw: tuple[int, int], bodies_world: list[np.ndarray],
              scale: float = 0.125, body_gap: float = 0.10, opaque: float = 0.5) -> np.ndarray:
        """Per pixel of a `scale`-sized grid, the cv z-depth at which the occluder splats (front to back, each
        drawn as a 2x2 pixel footprint) have built up `opaque` opacity; inf where they never do."""
        from scipy.spatial import cKDTree

        h, w = int(round(hw[0] * scale)), int(round(hw[1] * scale))
        R, t = T_view_cv[:3, :3], T_view_cv[:3, 3]
        Xc = (self.points - t) @ R  # world -> cv camera
        z = Xc[:, 2]
        ok = z > 0.2
        u = (K[0, 0] * Xc[:, 0] / np.where(ok, z, 1) + K[0, 2]) * scale
        v = (K[1, 1] * Xc[:, 1] / np.where(ok, z, 1) + K[1, 2]) * scale
        ok &= (u >= 0) & (u < w - 1) & (v >= 0) & (v < h - 1)
        idx = np.nonzero(ok)[0]
        if len(idx) and bodies_world:
            tree = cKDTree(np.concatenate(bodies_world))
            near, _ = tree.query(self.points[idx], distance_upper_bound=body_gap)
            idx = idx[~np.isfinite(near)]
        D = np.full(h * w, np.inf, np.float32)
        if len(idx) == 0:
            return D.reshape(h, w)
        ui, vi = u[idx].astype(np.int64), v[idx].astype(np.int64)
        pid = np.concatenate([vi * w + ui, vi * w + ui + 1, (vi + 1) * w + ui, (vi + 1) * w + ui + 1])
        zz = np.tile(z[idx], 4)
        tau = np.tile(-np.log1p(-self.alpha[idx]), 4)
        o = np.lexsort((zz, pid))
        pid, zz, tau = pid[o], zz[o], tau[o]
        cs = np.cumsum(tau)
        starts = np.r_[0, np.nonzero(np.diff(pid))[0] + 1]
        base = np.repeat(np.r_[0.0, cs[starts[1:] - 1]], np.diff(np.r_[starts, len(pid)]))
        hit = (cs - base) >= -np.log(1.0 - opaque)
        first = np.where(hit, np.arange(len(pid)), len(pid))
        firsts = np.minimum.reduceat(first, starts)
        got = firsts < len(pid)
        D[pid[starts[got]]] = zz[firsts[got]]
        return D.reshape(h, w)
