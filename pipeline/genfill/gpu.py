"""Splats on the GPU: rendering (RGB, depth, alpha, extra per-splat channels) and good-view counts per splat.

torch + gsplat (the flashworld env on HiPerGator).
"""
from __future__ import annotations

import math
import time

import numpy as np

from . import world as W  # noqa: F401  (puts pipeline/ on sys.path)
from .geom import Intr, w2c_cv

import splat_io as sio  # noqa: E402


def say(msg: str) -> None:
    import sys

    print(f"[genfill] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


class GS:
    """A splat set as device tensors. `new` marks generated splats (they count as confident)."""

    def __init__(self, s: sio.Splats, device: str = "cuda"):
        import torch

        self.device = device
        self.means = torch.from_numpy(np.ascontiguousarray(s.means)).to(device)
        q = torch.from_numpy(np.ascontiguousarray(s.quats)).to(device)
        self.quats = torch.nn.functional.normalize(q, dim=-1)
        self.scales = torch.from_numpy(np.ascontiguousarray(s.scales)).to(device)
        self.opac = torch.from_numpy(np.ascontiguousarray(s.opacities)).to(device)
        self.sh = torch.from_numpy(np.ascontiguousarray(s.sh_all())).to(device)
        self.deg = int(s.sh_degree)
        self.new = torch.zeros(len(s), dtype=torch.bool, device=device)
        self.region = torch.full((len(s),), -1, dtype=torch.int32, device=device)
        self.conf = torch.full((len(s),), 9999, dtype=torch.int32, device=device)  # good training views (set later)
        self.soft = torch.zeros(len(s), dtype=torch.bool, device=device)  # old splats the optimiser may fade/recolour
        self.bits = torch.full((len(s), 3), -1, dtype=torch.int64, device=device)  # directions seen well from (DirBins)
        self.best_cos = torch.ones(len(s), device=device)  # most face-on |cos| a good view saw a flat splat at
        self.normal = torch.zeros((len(s), 3), device=device)
        self.flat = torch.zeros(len(s), dtype=torch.bool, device=device)
        self.maxw = torch.zeros(len(s), device=device)  # most pixel-equivalents it paints in any training view

    def __len__(self) -> int:
        return int(self.means.shape[0])

    def to_splats(self, keep=None) -> sio.Splats:
        import torch

        idx = slice(None) if keep is None else keep
        with torch.no_grad():
            sh = self.sh[idx].cpu().numpy()
            return sio.Splats(self.means[idx].cpu().numpy(), self.scales[idx].cpu().numpy(), self.quats[idx].cpu().numpy(),
                              self.opac[idx].cpu().numpy(), sh[:, 0], sh[:, 1:] if sh.shape[1] > 1 else None)

    def append(self, means, scales, quats, rgb, opacity: float = 0.95, region: int = -1) -> tuple[int, int]:
        import torch

        n0 = len(self)
        d = self.device
        m = torch.as_tensor(np.asarray(means, np.float32), device=d)
        sc = torch.as_tensor(np.asarray(scales, np.float32), device=d)
        q = torch.nn.functional.normalize(torch.as_tensor(np.asarray(quats, np.float32), device=d), dim=-1)
        col = torch.as_tensor(np.asarray(rgb, np.float32), device=d)
        sh = torch.zeros((len(m), self.sh.shape[1], 3), device=d)
        sh[:, 0] = (col - 0.5) / sio.SH_C0
        self.means = torch.cat([self.means, m])
        self.scales = torch.cat([self.scales, sc])
        self.quats = torch.cat([self.quats, q])
        self.opac = torch.cat([self.opac, torch.full((len(m),), float(opacity), device=d)])
        self.sh = torch.cat([self.sh, sh])
        self.new = torch.cat([self.new, torch.ones(len(m), dtype=torch.bool, device=d)])
        self.region = torch.cat([self.region, torch.full((len(m),), int(region), dtype=torch.int32, device=d)])
        self.conf = torch.cat([self.conf, torch.full((len(m),), 9999, dtype=torch.int32, device=d)])
        self.soft = torch.cat([self.soft, torch.zeros(len(m), dtype=torch.bool, device=d)])
        self.bits = torch.cat([self.bits, torch.full((len(m), self.bits.shape[1]), -1, dtype=torch.int64, device=d)])
        self.best_cos = torch.cat([self.best_cos, torch.ones(len(m), device=d)])
        self.normal = torch.cat([self.normal, torch.zeros((len(m), 3), device=d)])
        self.flat = torch.cat([self.flat, torch.zeros(len(m), dtype=torch.bool, device=d)])
        self.maxw = torch.cat([self.maxw, torch.zeros(len(m), device=d)])
        return n0, len(self)

    _STATE = ("means", "scales", "quats", "opac", "sh", "new", "region", "conf", "soft", "bits", "best_cos",
              "normal", "flat", "maxw")

    def snapshot(self) -> dict:
        return {k: getattr(self, k).clone() for k in self._STATE}

    def restore(self, snap: dict) -> None:
        for k, v in snap.items():
            setattr(self, k, v)

    def remove(self, drop) -> int:
        """Drops the splats where `drop` (bool tensor) is True. Returns how many were dropped."""
        keep = ~drop
        n = int(drop.sum())
        if n:
            for k in ("means", "scales", "quats", "opac", "sh", "new", "region", "conf", "soft", "bits", "best_cos",
                      "normal", "flat", "maxw"):
                setattr(self, k, getattr(self, k)[keep])
        return n


class DirBins:
    """n directions spread evenly over the sphere (a Fibonacci lattice) and, per bin, a bit mask (words of 63
    bits) of the bins within `angle` degrees: a splat seen well from bin b counts as seen from any direction
    near b."""

    def __init__(self, angle: float = 30.0, n: int = 189, device: str = "cuda"):
        import torch

        i = np.arange(n) + 0.5
        phi = np.arccos(1 - 2 * i / n)
        theta = np.pi * (1 + 5 ** 0.5) * i
        d = np.stack([np.cos(theta) * np.sin(phi), np.cos(phi), np.sin(theta) * np.sin(phi)], 1)
        self.words = (n + 62) // 63
        near = d @ d.T >= math.cos(math.radians(angle))
        nbr = np.zeros((n, self.words), np.int64)
        for b in range(n):
            for j in np.nonzero(near[b])[0]:
                nbr[b, j // 63] |= np.int64(1) << np.int64(j % 63)
        self.dirs = torch.tensor(d, dtype=torch.float32, device=device)
        self.nbr = torch.from_numpy(nbr).to(device)
        bit = np.zeros((n, self.words), np.int64)
        for b in range(n):
            bit[b, b // 63] = np.int64(1) << np.int64(b % 63)
        self.bit = torch.from_numpy(bit).to(device)
        self.angle = angle

    def bin_of(self, dirs):
        return (dirs @ self.dirs.T).argmax(1)


def low_confidence(gs: GS, cam_pos: np.ndarray, bins: DirBins, min_views: int, face_ratio: float = 0.0,
                   face_delta: float = 0.3):
    """Per splat, for a camera at cam_pos: True when the footage never saw it well (fewer than min_views good
    views), never from a direction within bins.angle of this one, or (flat splats) never nearly as face-on as
    this camera sees it (a ceiling the footage only grazed, seen from below). Generated splats are never low."""
    import torch

    p = torch.as_tensor(np.asarray(cam_pos, np.float32), device=gs.device)
    d = torch.nn.functional.normalize(p - gs.means, dim=1)
    near = bins.nbr[bins.bin_of(d)]
    bits = gs.bits if gs.bits.shape[1] == near.shape[1] else gs.bits[:, :1].expand(-1, near.shape[1])
    low = (gs.conf < min_views) | ((bits & near) == 0).all(1)
    if face_ratio > 0:
        c = (gs.normal * d).sum(1).abs()
        low |= gs.flat & (c > face_ratio * gs.best_cos) & (c - gs.best_cos > face_delta)
    return low & ~gs.new


def viewmat(c2w_gl: np.ndarray, device: str = "cuda"):
    import torch

    return torch.from_numpy(w2c_cv(c2w_gl).astype(np.float32)).to(device)


def kmat(k: Intr, device: str = "cuda"):
    import torch

    return torch.tensor([[k.fx, 0, k.cx], [0, k.fy, k.cy], [0, 0, 1]], dtype=torch.float32, device=device)


def render(gs: GS, c2w_gl: np.ndarray, k: Intr, extras=None, bg=(0.0, 0.0, 0.0), sh: bool = True):
    """-> dict of torch tensors: rgb [H,W,3] 0..1, depth [H,W] (expected z, 0 where alpha < 0.5), alpha [H,W],
    and extras [H,W,D] (alpha-blended per-splat values, D <= 3) when given."""
    import torch
    from gsplat import rasterization

    vm = viewmat(c2w_gl, gs.device)[None]
    K = kmat(k, gs.device)[None]
    out = {}
    with torch.no_grad():
        if sh:
            colors, deg = gs.sh, gs.deg
        else:
            colors, deg = (gs.sh[:, 0] * sio.SH_C0 + 0.5).clamp(0, 1), None
        bgt = torch.tensor(list(bg), dtype=torch.float32, device=gs.device)[None]
        img, alpha, _ = rasterization(gs.means, gs.quats, gs.scales, gs.opac, colors, vm, K, k.width, k.height,
                                      sh_degree=deg, render_mode="RGB+ED", near_plane=0.02, far_plane=1e4,
                                      backgrounds=bgt, packed=False)
        a = alpha[0, ..., 0]
        out["rgb"] = img[0, ..., :3].clamp(0, 1)
        out["alpha"] = a
        out["depth"] = torch.where(a >= 0.5, img[0, ..., 3], torch.zeros_like(a))
        if extras is not None:
            ex = extras if extras.ndim == 2 else extras[:, None]
            d = ex.shape[1]
            if d < 3:
                ex = torch.cat([ex, torch.zeros(len(ex), 3 - d, device=ex.device)], 1)
            e, _, _ = rasterization(gs.means, gs.quats, gs.scales, gs.opac, ex.float(), vm, K, k.width, k.height,
                                    sh_degree=None, render_mode="RGB", near_plane=0.02, far_plane=1e4, packed=False)
            out["extras"] = e[0, ..., :d]
    return out


def to_u8(t) -> np.ndarray:
    return (t.clamp(0, 1) * 255 + 0.5).byte().cpu().numpy()


def splat_axes(gs: GS):
    """Per splat: unit normal (axis of the smallest scale), unit long axis (largest scale), and the ratios
    smallest/middle (flatness) and largest/middle (elongation)."""
    import torch

    q = gs.quats
    w, x, y, z = q.unbind(-1)
    R = torch.stack([
        torch.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
        torch.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
        torch.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
    ], -2)
    s_sorted, order = torch.sort(gs.scales, dim=1)
    n = torch.gather(R, 2, order[:, None, :1].expand(-1, 3, 1))[..., 0]
    a = torch.gather(R, 2, order[:, None, 2:3].expand(-1, 3, 1))[..., 0]
    mid = s_sorted[:, 1].clamp_min(1e-7)
    return n, a, s_sorted[:, 0] / mid, s_sorted[:, 2] / mid


def contributions(gs: GS, c2w_gl: np.ndarray, k: Intr):
    """Per-splat blending weight summed over the pixels of one view (pixel-equivalents painted): the gradient of
    the rendered image's sum with respect to each splat's colour."""
    import torch
    from gsplat import rasterization

    colors = torch.zeros((len(gs), 3), device=gs.device, requires_grad=True)
    img, _, _ = rasterization(gs.means, gs.quats, gs.scales, gs.opac, colors, viewmat(c2w_gl, gs.device)[None],
                              kmat(k, gs.device)[None], k.width, k.height, sh_degree=None, packed=False,
                              near_plane=0.02, far_plane=1e4)
    img[..., 0].sum().backward()
    return colors.grad[:, 0].detach()


def good_view_counts(gs: GS, cams, bins: DirBins | None = None, scale: float = 0.25, max_dist: float = 25.0,
                     grazing_cos: float = 0.17, min_px: float = 0.05, max_px_size: float = 0.04,
                     needle_ratio: float = 2.5, needle_cos: float = 0.8):
    """How many training cameras saw each splat well, and from which directions (sets gs.conf and gs.bits).
    A camera sees a splat well when
      - it paints at least min_px pixel-equivalents of the view at `scale` resolution (occlusion and transparency
        included: the gradient of the image's sum with respect to the splat's colour),
      - it is closer than max_dist and the view is finer than max_px_size metres per pixel there (full resolution),
      - its shape is visible: a flat splat (smallest/middle < 0.35) is not seen edge-on (|cos| > grazing_cos with
        its normal), a needle (largest/middle > needle_ratio) is not seen end-on (|cos| < needle_cos with its long
        axis).
    gs.bits gets the direction bin (splat -> camera) of every good view."""
    import torch

    bins = bins or DirBins(device=gs.device)
    counts = torch.zeros(len(gs), dtype=torch.int32, device=gs.device)
    bits = torch.zeros((len(gs), bins.words), dtype=torch.int64, device=gs.device)
    best = torch.zeros(len(gs), device=gs.device)
    maxw = torch.zeros(len(gs), device=gs.device)
    n, along, flatness, elong = splat_axes(gs)
    flat = flatness < 0.35
    needle = elong > needle_ratio
    t0 = time.time()
    for c in cams:
        k = c.intr.scaled(scale)
        wsum = contributions(gs, c.c2w, k)
        maxw = torch.maximum(maxw, wsum / (scale * scale))  # in full-resolution pixel-equivalents
        w2c = viewmat(c.c2w, gs.device)
        z = gs.means @ w2c[2, :3] + w2c[2, 3]
        vis = (wsum >= min_px) & (z > 0.05) & (z < max_dist) & ((z / c.intr.fx) < max_px_size)
        cam_pos = torch.from_numpy(c.position.astype(np.float32)).to(gs.device)
        to_cam = torch.nn.functional.normalize(cam_pos - gs.means, dim=1)
        cos_n = (n * to_cam).sum(1).abs()
        vis &= ~flat | (cos_n > grazing_cos)
        vis &= ~needle | ((along * to_cam).sum(1).abs() < needle_cos)
        counts += vis.int()
        best = torch.where(vis, torch.maximum(best, cos_n), best)
        bits |= bins.bit[bins.bin_of(to_cam)] * vis[:, None].long()
    gs.conf = counts
    gs.bits = bits
    gs.best_cos = best
    gs.maxw = maxw
    gs.normal = n
    gs.flat = flat
    say(f"good-view counts from {len(cams)} cameras in {time.time() - t0:.1f}s: "
        f"median {float(counts.float().median()):.0f}, zero {int((counts == 0).sum())}, <3 {int((counts < 3).sum())} of {len(gs)}; "
        f"needles {int(needle.sum())}, flat {int(flat.sum())}")
    return counts
