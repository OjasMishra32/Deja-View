"""Ceiling completion in the ceiling's own texture space.

Why: lifting a generated perspective view into 3D (fill.py) gave flat fragments and streaks from every other standing
spot, because one view fixes neither depth nor orientation. A ceiling needs neither: it is one plane. So the fill
happens on the plane itself, and whatever it paints is in the same place from every spot by construction.

1. Plane and footprint. The ceiling height comes from the flat, downward-facing splats near the top of the room;
   the footprint is a rectangle aligned with the walls (`Footprint`, angle + extents in the wall frame), with the
   sides that are walls marked closed and the open side (the patio's front edge) marked open.
2. Texture from the footage. Every texel of the rectangle is looked up in every training image that can see it
   (a camera outside the rectangle only through an open side; the people masks are honoured). A texel's weight in a
   view is how many pixels it spans across its short (radial) side, so a grazing view counts little and a steep one
   counts a lot; texels that no view saw at a usable size stay empty. What the footage saw is kept as it saw it.
3. Complete. The empty texels are filled in the texture image (a top-down picture of the ceiling): by the edit model
   through the model worker when it is up (it sees the texture with the gap painted magenta and continues the
   ceiling and its light fittings), or by `lattice_fill` (the repeating light fittings found in the seen part are
   continued as a lattice over the unseen part, on the median ceiling colour). Either way the fill is one image, so
   neighbouring standing spots agree.
4. Replace. Old splats in the ceiling zone inside the footprint (the streaks grazing views leave) are removed; walls
   are kept by an inset; one flat Gaussian per texel is added at the ceiling height, facing down.

numpy (+ OpenCV for image I/O); no GPU needed. `python -m genfill.ceiling --help`.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import geom as G
from . import world as W

import splat_io as sio  # noqa: E402  (world puts pipeline/ on sys.path)


def say(msg: str) -> None:
    import sys

    print(f"[ceiling] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------------------------------------------
# Footprint
# --------------------------------------------------------------------------------------------------------------

SIDES = ("u0", "u1", "v0", "v1")


@dataclass
class Footprint:
    """A rectangle on the floor plane in the wall frame: u = (cos a, sin a).(x, z), v = (-sin a, cos a).(x, z)."""

    angle: float
    u0: float
    u1: float
    v0: float
    v1: float
    open_sides: tuple = ("v1",)

    def _cs(self):
        a = math.radians(self.angle)
        return math.cos(a), math.sin(a)

    def uv(self, xz: np.ndarray) -> np.ndarray:
        c, s = self._cs()
        xz = np.asarray(xz, np.float64).reshape(-1, 2)
        return np.stack([xz[:, 0] * c + xz[:, 1] * s, -xz[:, 0] * s + xz[:, 1] * c], 1)

    def xz(self, uv: np.ndarray) -> np.ndarray:
        c, s = self._cs()
        uv = np.asarray(uv, np.float64).reshape(-1, 2)
        return np.stack([uv[:, 0] * c - uv[:, 1] * s, uv[:, 0] * s + uv[:, 1] * c], 1)

    def inside(self, xz: np.ndarray, inset: float | dict = 0.0) -> np.ndarray:
        ins = inset if isinstance(inset, dict) else {k: float(inset) for k in SIDES}
        p = self.uv(xz)
        return ((p[:, 0] >= self.u0 + ins.get("u0", 0)) & (p[:, 0] <= self.u1 - ins.get("u1", 0))
                & (p[:, 1] >= self.v0 + ins.get("v0", 0)) & (p[:, 1] <= self.v1 - ins.get("v1", 0)))

    def visible_from(self, cam_xz, tex_xz: np.ndarray) -> np.ndarray:
        """True where the floor-plane segment camera -> texel (texel inside the rectangle) enters the rectangle through
        an open side, or starts inside it. Walls (closed sides) are taken as full height, the open side as open below
        the ceiling (the camera is below it, so the ray rises all the way)."""
        c = self.uv(np.asarray(cam_xz, np.float64).reshape(1, 2))[0]
        t = self.uv(tex_xz)
        d = t - c[None]
        t_in = np.full(len(t), -np.inf)
        side = np.full(len(t), -1)
        for ax, (lo, hi), names in ((0, (self.u0, self.u1), (0, 1)), (1, (self.v0, self.v1), (2, 3))):
            dd = d[:, ax]
            with np.errstate(divide="ignore", invalid="ignore"):
                ta = (lo - c[ax]) / dd
                tb = (hi - c[ax]) / dd
            enter = np.where(ta < tb, ta, tb)
            enter_side = np.where(ta < tb, names[0], names[1])
            inside_slab = (c[ax] >= lo) & (c[ax] <= hi)
            enter = np.where(np.abs(dd) < 1e-12, -np.inf if inside_slab else np.inf, enter)
            upd = enter > t_in
            side = np.where(upd, enter_side, side)
            t_in = np.where(upd, enter, t_in)
        open_ids = {SIDES.index(s) for s in self.open_sides}
        starts_inside = t_in <= 0
        return starts_inside | np.isin(side, list(open_ids))


def dominant_angle(xz: np.ndarray, weights: np.ndarray | None = None, step: float = 0.5, bin_m: float = 0.05) -> float:
    """Wall direction (degrees in [0, 90)) of a set of wall points: the angle whose projection piles the points up
    most sharply (walls at right angles give the same answer mod 90)."""
    xz = np.asarray(xz, np.float64)
    w = np.ones(len(xz)) if weights is None else np.asarray(weights, np.float64)
    c = np.median(xz, 0)
    p = xz - c
    r = float(np.percentile(np.abs(p), 99)) + 1.0
    best, best_a = -1.0, 0.0
    for a in np.arange(0.0, 90.0, step):
        t = math.radians(a)
        h1, _ = np.histogram(p[:, 0] * math.cos(t) + p[:, 1] * math.sin(t), bins=np.arange(-r, r, bin_m), weights=w)
        h2, _ = np.histogram(-p[:, 0] * math.sin(t) + p[:, 1] * math.cos(t), bins=np.arange(-r, r, bin_m), weights=w)
        sc = float((h1 ** 2).sum() + (h2 ** 2).sum()) / max(float(w.sum()) ** 2, 1e-12)
        if sc > best:
            best, best_a = sc, float(a)
    return best_a


def normals_of(s: sio.Splats) -> tuple[np.ndarray, np.ndarray]:
    """Per splat: unit normal (axis of the smallest scale) and flatness (smallest / middle scale)."""
    R = G.quats_wxyz_to_rotmats(s.quats)
    order = np.argsort(s.scales, 1)
    n = R[np.arange(len(R)), :, order[:, 0]]
    ss = np.take_along_axis(s.scales, order, 1)
    return n, ss[:, 0] / np.maximum(ss[:, 1], 1e-9)


def ceiling_height(s: sio.Splats, fp: Footprint, lo: float = 2.2, hi: float = 5.0, bin_m: float = 0.02) -> float | None:
    """Height of the ceiling over the footprint: the peak of flat, level, fairly opaque splats in [lo, hi]."""
    n, flat = normals_of(s)
    m = s.means
    sel = (fp.inside(m[:, [0, 2]], 0.3) & (m[:, 1] > lo) & (m[:, 1] < hi) & (np.abs(n[:, 1]) > 0.9) & (flat < 0.3)
           & (s.opacities > 0.3))
    if sel.sum() < 50:
        return None
    h, e = np.histogram(m[sel, 1], bins=np.arange(lo, hi + bin_m, bin_m), weights=s.opacities[sel])
    h = np.convolve(h, [0.25, 0.5, 0.25], mode="same")
    i = int(np.argmax(h))
    return float(e[i] + bin_m / 2)


# --------------------------------------------------------------------------------------------------------------
# Texture from the footage
# --------------------------------------------------------------------------------------------------------------


@dataclass
class TexGrid:
    fp: Footprint
    height: float
    texel: float
    nu: int
    nv: int

    @staticmethod
    def make(fp: Footprint, height: float, texel: float) -> "TexGrid":
        return TexGrid(fp, height, texel, int(math.ceil((fp.u1 - fp.u0) / texel)), int(math.ceil((fp.v1 - fp.v0) / texel)))

    def centers_uv(self) -> np.ndarray:
        """[nv*nu, 2] texel centres in (u, v); row r = v index, column c = u index (image layout, v down)."""
        u = self.fp.u0 + (np.arange(self.nu) + 0.5) * self.texel
        v = self.fp.v0 + (np.arange(self.nv) + 0.5) * self.texel
        uu, vv = np.meshgrid(u, v)
        return np.stack([uu.ravel(), vv.ravel()], 1)

    def centers_world(self) -> np.ndarray:
        xz = self.fp.xz(self.centers_uv())
        return np.stack([xz[:, 0], np.full(len(xz), self.height), xz[:, 1]], 1)


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """img [H,W,C] float32, x/y continuous pixel coordinates with centres at +0.5."""
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    a = img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx
    b = img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def view_weights(cam_pos: np.ndarray, pts: np.ndarray, fx: float, z: np.ndarray, texel: float, normal=(0.0, -1.0, 0.0)):
    """(radial_px, tangential_px): how many image pixels one texel spans across and along the viewing direction."""
    d = pts - cam_pos[None]
    dist = np.linalg.norm(d, axis=1)
    cos_inc = np.abs(d @ np.asarray(normal, np.float64)) / np.maximum(dist, 1e-9)
    tang = fx * texel / np.maximum(z, 1e-6)
    return tang * cos_inc, tang


def project_texture(grid: TexGrid, cams: list, load, min_px: float = 0.12, power: float = 3.0, max_level: int = 4,
                    border: float = 0.03, log_every: int = 25, gain_iters: int = 2, image_scale: float = 1.0,
                    ref_group: str = "photo", ref_boost: float = 3.0, weak_px: float = 0.02) -> dict:
    """Weighted texture of the ceiling from the training images. load(cam) -> (rgb uint8, mask bool) or (None, None).
    Weights: a view counts with (radial pixels per texel)^power, faded at the image border; the views of ref_group
    (the still photos: sharper and better exposed than video frames) count ref_boost times more.
    Exposure: after the first pass each view gets a gain (median ratio of the texture to its own samples over the
    texels it counts for), and the texture is re-blended with the gains (gain_iters times), so the seams where one
    view takes over from another do not show as light and dark wedges. The gains are scaled so that the views of
    ref_group keep their own exposure.
    Views that see a texel only at a very grazing angle (weak_px <= radial pixels < min_px) do not count for the
    texture, but are kept apart as `weak` (colour only, for the base of texels nothing else saw).
    image_scale: the images load() returns are this fraction of the cameras' resolution (a height sweep runs on
    half-size images). Returns dict(tex [nv,nu,3] float 0..1, wsum [nv,nu], best_px [nv,nu], views [nv,nu] (count),
    var [nv,nu] (weighted colour variance across views: how well the views agree on the plane), weak_tex, weak_w,
    used [names], gains {name: gain})."""
    import cv2

    pts = grid.centers_world()
    xz = pts[:, [0, 2]]
    n = len(pts)
    acc = np.zeros((n, 3))
    wsum = np.zeros(n)
    wacc = np.zeros((n, 3))
    wws = np.zeros(n)
    best = np.zeros(n)
    views = np.zeros(n, np.int32)
    used = []
    samples = []
    groups = []
    t0 = time.time()
    for ci, cam in enumerate(cams):
        pos = cam.position
        if pos[1] >= grid.height - 0.05:
            continue
        k = cam.intr if image_scale == 1.0 else cam.intr.scaled(image_scale)
        u, v, z = G.project(pts, cam.c2w, k)
        bx, by = border * k.width, border * k.height
        ok = (z > 0.05) & (u > 1) & (u < k.width - 1) & (v > 1) & (v < k.height - 1)
        if not ok.any():
            continue
        ok &= grid.fp.visible_from(pos[[0, 2]], xz)
        rad, tang = view_weights(pos, pts, k.fx, z, grid.texel)
        ok &= rad >= weak_px
        if not ok.any():
            continue
        rgb, mask = load(cam)
        if rgb is None:
            continue
        idx = np.nonzero(ok)[0]
        m_ok = mask[np.clip(v[idx].astype(int), 0, k.height - 1), np.clip(u[idx].astype(int), 0, k.width - 1)]
        idx = idx[m_ok]
        if not len(idx):
            continue
        img = rgb.astype(np.float32) / 255.0
        pyr = [img]
        for _ in range(max_level):
            pyr.append(cv2.pyrDown(pyr[-1]))
        lev = np.clip(np.floor(np.log2(np.maximum(tang[idx], 1.0))), 0, max_level).astype(int)
        col = np.zeros((len(idx), 3))
        for L in np.unique(lev):
            s = lev == L
            col[s] = _bilinear(pyr[L], u[idx][s] / (2 ** L), v[idx][s] / (2 ** L))
        edge = np.clip(np.minimum.reduce([u[idx] / bx, (k.width - u[idx]) / bx, v[idx] / by, (k.height - v[idx]) / by]), 0, 1)
        strong = rad[idx] >= min_px
        # weak tier: colour only
        wi = idx[~strong]
        if len(wi):
            ww = rad[wi] * edge[~strong]
            wacc[wi] += ww[:, None] * col[~strong]
            wws[wi] += ww
        idx, col, edge = idx[strong], col[strong], edge[strong]
        if not len(idx):
            continue
        boost = ref_boost if ref_group and str(cam.group).startswith(ref_group) else 1.0
        w = np.minimum(rad[idx], 1.5) ** power * edge * boost
        acc[idx] += w[:, None] * col
        wsum[idx] += w
        samples.append((idx.astype(np.int32), col.astype(np.float32), w.astype(np.float32)))
        best[idx] = np.maximum(best[idx], rad[idx])
        views[idx] += 1
        used.append(cam.name)
        groups.append(str(cam.group))
        if log_every and (ci + 1) % log_every == 0:
            say(f"  {ci + 1}/{len(cams)} cameras ({time.time() - t0:.0f}s), {int((wsum > 0).sum())} texels seen")
    tex = acc / np.maximum(wsum, 1e-12)[:, None]
    gains = np.ones(len(samples))
    for _ in range(gain_iters):
        for si, (idx, col, w) in enumerate(samples):
            sel = w > 0.25 * w.max()
            lt = tex[idx[sel]].mean(1)
            ls = col[sel].mean(1)
            ok = ls > 0.05
            if ok.sum() > 50:
                gains[si] = float(np.clip(np.median(lt[ok] / ls[ok]), 0.6, 1.6))
        ref = [g for g, grp in zip(gains, groups) if grp.startswith(ref_group)] if ref_group else []
        if ref:
            gains = gains / float(np.median(ref))
        acc[:] = 0
        for g, (idx, col, w) in zip(gains, samples):
            acc[idx] += w[:, None] * col * g
        tex = acc / np.maximum(wsum, 1e-12)[:, None]
    acc2 = np.zeros(n)
    for g, (idx, col, w) in zip(gains, samples):
        acc2[idx] += w * (((col * g) - tex[idx]) ** 2).sum(1)
    var = acc2 / np.maximum(wsum, 1e-12)
    sh = (grid.nv, grid.nu)
    return {"tex": np.clip(tex, 0, 1).reshape(sh + (3,)).astype(np.float32), "wsum": wsum.reshape(sh).astype(np.float32),
            "var": var.reshape(sh).astype(np.float32),
            "weak_tex": np.clip(wacc / np.maximum(wws, 1e-12)[:, None], 0, 1).reshape(sh + (3,)).astype(np.float32),
            "weak_w": wws.reshape(sh).astype(np.float32),
            "best_px": best.reshape(sh).astype(np.float32), "views": views.reshape(sh), "used": used,
            "gains": {nm: round(float(g), 3) for nm, g in zip(used, gains)}}


def sweep_height(fp: Footprint, cams: list, load, heights, texel: float = 0.04, image_scale: float = 0.5,
                 min_px: float = 0.08, bright: float = 0.62) -> list[dict]:
    """Plane sweep: for each candidate height, how well the views agree on the plane's texture (weighted colour
    variance over texels seen by two or more views; lower = the plane is where the views see it). At grazing angles
    a 10 cm height error moves a light fitting by half a metre between views, so this is sharp. Three scores: all
    texels, the bright ones (light fittings, which may hang below the ceiling) and the rest (the ceiling itself)."""
    out = []
    for hh in heights:
        g = TexGrid.make(fp, float(hh), texel)
        pr = project_texture(g, cams, load, min_px=min_px, log_every=0, gain_iters=1, image_scale=image_scale)
        sel = (pr["views"] >= 2) & (pr["wsum"] > 0)
        lum = pr["tex"].mean(-1)
        row = {"height": round(float(hh), 4), "texels": int(sel.sum())}
        for key, m in (("score", sel), ("bright", sel & (lum >= bright)), ("dark", sel & (lum < bright))):
            w = pr["wsum"][m]
            row[key] = float((pr["var"][m] * w).sum() / max(w.sum(), 1e-12)) if m.any() else float("inf")
        out.append(row)
        say(f"  sweep h={hh:.3f}: disagreement {row['score']:.5f} (fittings {row['bright']:.5f}, ceiling "
            f"{row['dark']:.5f}) over {int(sel.sum())} texels")
    return out


def fitting_centres(lat: "Lattice", grid: TexGrid, margin_m: float = 0.3) -> list[tuple[float, float]]:
    """World (x, z) of every light fitting of the lattice whose centre lies inside the footprint (less margin)."""
    t = grid.texel
    out = []
    rows = lat.rows or list(range(-2, int(grid.nv / lat.period_v) + 3))
    for k in rows:
        sh = (k % 2) * lat.stagger * lat.period_u
        for j in range(-3, int(grid.nu / lat.period_u) + 4):
            c = lat.offset_u + sh + j * lat.period_u
            r = lat.offset_v + k * lat.period_v + lat.slope * c
            if not (margin_m / t <= c < grid.nu - margin_m / t and margin_m / t <= r < grid.nv - margin_m / t):
                continue
            u = grid.fp.u0 + (c + 0.5) * t
            v = grid.fp.v0 + (r + 0.5) * t
            out.append(tuple(grid.fp.xz(np.array([[u, v]]))[0]))
    return out


def fitting_splats(centres, angle_deg: float, slope: float, length: float, width: float, bottom: float, ceiling: float,
                   colour, housing=(0.72, 0.72, 0.70), sh_rest_dim: int = 0, step: float = 0.02) -> sio.Splats:
    """Light fittings as small 3D boxes: a bright diffuser face at `bottom`, a housing up to min(bottom + 8 cm,
    ceiling), and two hanger rods when the fitting hangs lower than that."""
    a = math.radians(angle_deg)
    du = np.array([math.cos(a), math.sin(a)])  # u axis in (x, z)
    dv = np.array([-math.sin(a), math.cos(a)])
    tilt = math.atan(slope)
    ax = du * math.cos(tilt) + dv * math.sin(tilt)
    side = np.array([-ax[1], ax[0]])
    top = min(bottom + 0.08, ceiling)
    m, sc, col = [], [], []
    for cx, cz in centres:
        c = np.array([cx, cz])
        # diffuser: a grid of flat level splats
        for s_ in np.arange(-length / 2 + step / 2, length / 2, step):
            for w_ in np.arange(-width / 2 + step / 2, width / 2, step):
                p = c + ax * s_ + side * w_
                m.append([p[0], bottom, p[1]])
                sc.append([step * 0.7, 0.002, step * 0.7])
                edge = abs(w_) > width / 2 - step
                col.append(np.asarray(colour) * (0.85 if edge else 1.0))
        # housing: the two long sides and the ends, vertical, from bottom to top
        hh = np.arange(bottom + step / 2, top, step)
        for s_ in np.arange(-length / 2 + step / 2, length / 2, step):
            for sgn in (-1, 1):
                p = c + ax * s_ + side * sgn * width / 2
                for y in hh:
                    m.append([p[0], y, p[1]])
                    sc.append([step * 0.7, step * 0.7, 0.002])
                    col.append(housing)
        for sgn in (-1, 1):
            for w_ in np.arange(-width / 2 + step / 2, width / 2, step):
                p = c + ax * sgn * length / 2 + side * w_
                for y in hh:
                    m.append([p[0], y, p[1]])
                    sc.append([0.002, step * 0.7, step * 0.7])
                    col.append(housing)
        if ceiling - top > 0.03:
            for sgn in (-0.35, 0.35):
                p = c + ax * sgn * length
                for y in np.arange(top + step / 2, ceiling, step):
                    m.append([p[0], y, p[1]])
                    sc.append([0.004, step * 0.7, 0.004])
                    col.append((0.35, 0.35, 0.35))
    m = np.asarray(m, np.float64)
    sc = np.asarray(sc, np.float64)
    n = len(m)
    if not n:
        return sio.Splats(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 4)), np.zeros(0), np.zeros((0, 3)))
    # orientation: x along the fitting, z across (level splats: thin in y; side splats: thin in local z)
    yaw = -math.atan2(ax[1], ax[0])
    q0 = np.array([math.cos(yaw / 2), 0.0, math.sin(yaw / 2), 0.0])
    quats = np.tile(q0, (n, 1))
    rgb = np.clip(np.asarray(col, np.float64), 0, 1)
    rest = np.zeros((n, sh_rest_dim, 3), np.float32) if sh_rest_dim else None
    return sio.Splats(m, sc, quats, np.full(n, 0.98), (rgb - 0.5) / sio.SH_C0, rest)


# --------------------------------------------------------------------------------------------------------------
# Completion in texture space
# --------------------------------------------------------------------------------------------------------------


def seen_mask(proj: dict, min_best: float = 0.35, min_w: float = 0.02) -> np.ndarray:
    return (proj["best_px"] >= min_best) & (proj["wsum"] >= min_w)


def push_pull(tex: np.ndarray, w: np.ndarray, levels: int = 9) -> np.ndarray:
    """Fills every texel from the weighted ones by a push-pull pyramid (weighted averages pushed down to coarse
    levels, pulled back up where the weight is missing): smooth, with no hard edge where the data ends."""
    import cv2

    w = w.astype(np.float32)
    pyr = [(tex * w[..., None], w)]
    for _ in range(levels):
        a, b = pyr[-1]
        if min(b.shape) < 2:
            break
        pyr.append((cv2.pyrDown(a), cv2.pyrDown(b)))
    a, b = pyr[-1]
    est = a / np.maximum(b, 1e-6)[..., None]
    for a, b in reversed(pyr[:-1]):
        up = cv2.resize(est, (b.shape[1], b.shape[0]), interpolation=cv2.INTER_LINEAR)
        own = a / np.maximum(b, 1e-6)[..., None]
        t = np.clip(b * 4.0, 0, 1)[..., None]
        est = own * t + up * (1 - t)
    return est.astype(np.float32)


def smooth_fill(tex: np.ndarray, seen: np.ndarray, sigma_px: float) -> np.ndarray:
    """A smooth base everywhere (shading, colour drift): normalised Gaussian blur of the seen texels, with the
    texels far from any seen one filled by push-pull, so the base fades out of the data without an edge."""
    import cv2

    w = seen.astype(np.float32)
    k = int(sigma_px * 3) | 1
    num = cv2.GaussianBlur(tex * w[..., None], (k, k), sigma_px)
    den = cv2.GaussianBlur(w, (k, k), sigma_px)
    near = num / np.maximum(den, 1e-6)[..., None]
    far = push_pull(near, np.clip(den * 3.0, 0, 1))
    t = np.clip(den * 3.0, 0, 1)[..., None]
    return (near * t + far * (1 - t)).astype(np.float32)


@dataclass
class Lattice:
    """Light fittings as a lattice in texel units (row = v, col = u): fitting size along u / v, periods, offsets,
    and a small slope (rows drift by `slope` rows per column when the fittings are not exactly square to the walls)."""

    size_u: float
    size_v: float
    period_u: float
    period_v: float
    offset_u: float
    offset_v: float
    slope: float = 0.0
    stagger: float = 0.0  # shift along u of every other row, as a fraction of period_u
    colour: list = field(default_factory=lambda: [1.0, 1.0, 1.0])
    found: int = 0
    rows: list = field(default_factory=list)  # row indices (k) that hold fittings; empty = every row


def bright_blobs(tex: np.ndarray, seen: np.ndarray, base: np.ndarray, gain: float = 1.25, min_area: int = 6):
    """Connected bright regions (light fittings): returns list of dicts with centre (row, col), size along u / v."""
    import cv2

    lum = tex.mean(-1)
    blum = base.mean(-1)
    b = (lum > blum * gain) & (lum > 0.55) & seen
    n, lab, stats, cents = cv2.connectedComponentsWithStats(b.astype(np.uint8), 8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a < min_area:
            continue
        sel = lab == i
        out.append({"row": float(cents[i][1]), "col": float(cents[i][0]), "w": int(w), "h": int(h), "area": int(a),
                    "colour": np.percentile(tex[sel], 90, axis=0).tolist()})
    return out


def _cluster1d(vals: np.ndarray, tol: float) -> list[list[int]]:
    order = np.argsort(vals)
    groups, cur = [], [int(order[0])]
    for i in order[1:]:
        if vals[i] - vals[cur[-1]] < tol:
            cur.append(int(i))
        else:
            groups.append(cur)
            cur = [int(i)]
    groups.append(cur)
    return groups


def _period(vals: np.ndarray, lo: float, hi: float) -> tuple[float, float]:
    """Period in [lo, hi] and offset for 1-D positions. The positions are first merged into rows (clusters closer
    than lo / 3); the period is the LONGEST one that divides every difference between rows to within 6% (every
    whole fraction of the true period divides them too, a longer one does not). One row only: period hi."""
    vals = np.asarray(vals, np.float64)
    groups = _cluster1d(vals, lo / 3)
    if sum(len(g) >= 2 for g in groups) >= 2:  # lone positions between well-populated rows are strays
        groups = [g for g in groups if len(g) >= 2]
        vals = vals[sorted(i for g in groups for i in g)]
    c = np.array(sorted(float(np.mean(vals[g])) for g in _cluster1d(vals, lo / 3)))
    if len(c) < 2:
        return float(hi), float(c[0] % hi)
    diffs = (c[None] - c[:, None])[np.triu_indices(len(c), 1)]
    bp, best_err = None, np.inf
    for p in np.arange(lo, hi, 0.25):
        f = diffs / p
        err = float(np.abs(f - np.round(f)).max())
        if err < 0.06:
            bp = float(p)
        best_err = min(best_err, err)
    if bp is None:  # nothing divides all gaps: the most regular one
        errs = [(float(np.abs(diffs / p - np.round(diffs / p)).max()), -p) for p in np.arange(lo, hi, 0.25)]
        bp = -min(errs)[1]
    k = np.round((c - c[0]) / bp)
    if np.ptp(k) > 0:
        bp = float(np.polyfit(k, c, 1)[0])
    ph = 2 * np.pi * vals / bp
    off = (math.atan2(np.sin(ph).mean(), np.cos(ph).mean()) / (2 * np.pi) * bp) % bp
    return bp, float(off)


def fit_lattice(blobs: list[dict], texel: float, min_period_m: float = 1.0, max_period_m: float = 4.0, min_len_m: float = 0.8,
                max_width_m: float = 0.2) -> Lattice | None:
    """A lattice through the bright blobs that look like whole fittings (elongated along u, 0.6-2 m long). Rows are
    found first (blobs within 0.5 m of each other across; a blob shorter than min_len_m is a glint, not a fitting), their common slope fitted, then periods along u and v.
    The fitting width is the narrowest seen (grazing views smear fittings across), capped at max_width_m."""
    good = [b for b in blobs if min_len_m / texel <= b["w"] <= 2.0 / texel and b["h"] <= 0.6 / texel and b["w"] >= 2.5 * b["h"]]
    if len(good) < 3:
        return None
    rows = np.array([b["row"] for b in good])
    cols = np.array([b["col"] for b in good])
    groups = _cluster1d(rows, 0.5 / texel)
    multi = [g for g in groups if len(g) >= 2]
    if multi:  # a row of fittings has several; a lone bright streak between rows is a reflection
        keep = sorted(i for g in multi for i in g)
        good = [good[i] for i in keep]
        rows, cols = rows[keep], cols[keep]
        groups = _cluster1d(rows, 0.5 / texel)
    slopes = []
    for g in groups:
        if len(g) >= 2 and np.ptp(cols[g]) > 0:
            slopes.append(np.polyfit(cols[g], rows[g], 1)[0])
    slope = float(np.median(slopes)) if slopes else 0.0
    rows_d = rows - slope * cols
    pv, ov = _period(rows_d, min_period_m / texel, max_period_m / texel)
    pu, ou = _period(cols, min_period_m / texel, max_period_m / texel)
    row_id = np.round((rows_d - ov) / pv).astype(int)
    stagger = 0.0
    if (row_id % 2 == 1).sum() >= 2 and (row_id % 2 == 0).sum() >= 2:
        def phase(c):
            ph = 2 * np.pi * c / pu
            return math.atan2(np.sin(ph).mean(), np.cos(ph).mean())

        dphi = phase(cols[row_id % 2 == 1]) - phase(cols[row_id % 2 == 0])
        stagger = float(((dphi / (2 * np.pi)) + 1.0) % 1.0)
        if min(stagger, 1 - stagger) < 0.15:
            stagger = 0.0
    su = float(np.median([b["w"] for b in good]))
    sv = float(min(np.percentile([b["h"] for b in good], 20), max_width_m / texel))
    colour = np.median(np.array([b["colour"] for b in good]), 0).tolist()
    return Lattice(su, sv, pu, pv, ou, ov, slope, stagger, colour, len(good), sorted(set(int(r) for r in row_id)))


def render_lattice(shape: tuple[int, int], lat: Lattice, soft: float = 1.0, extend_rows: bool = False) -> np.ndarray:
    """[H,W] coverage (0..1) of the lattice's fittings: rectangles of the fitted size with a soft edge. Only the rows
    where fittings were found are drawn unless extend_rows (a fitting row is a row, not a pattern to repeat)."""
    hgt, wid = shape
    rr, cc = np.mgrid[0:hgt, 0:wid].astype(np.float64)
    rd = rr - lat.slope * cc
    row_id = np.round((rd - lat.offset_v) / lat.period_v)
    dv = rd - (lat.offset_v + row_id * lat.period_v)
    cshift = lat.offset_u + (row_id % 2) * lat.stagger * lat.period_u
    col_id = np.round((cc - cshift) / lat.period_u)
    du = cc - (cshift + col_id * lat.period_u)
    eu = np.clip((lat.size_u / 2 - np.abs(du)) / soft + 0.5, 0, 1)
    ev = np.clip((lat.size_v / 2 - np.abs(dv)) / soft + 0.5, 0, 1)
    cov = eu * ev
    if lat.rows and not extend_rows:
        cov = cov * np.isin(row_id, lat.rows)
    return cov.astype(np.float32)


def lattice_fill(tex: np.ndarray, seen: np.ndarray, texel: float, base_sigma_m: float = 0.6, clean: bool = False,
                 halo_m: float = 0.25, weak_tex: np.ndarray | None = None, weak_w: np.ndarray | None = None,
                 draw: bool = True) -> tuple[np.ndarray, dict]:
    """Unseen texels: the smooth base colour plus the fittings' lattice continued. Seen texels stay as seen, except
    with clean=True around the fittings (within halo_m), where the smeared fittings are redrawn crisp from the
    lattice on the base colour, so every fitting looks the same from below."""
    import cv2

    base = smooth_fill(tex, seen, base_sigma_m / texel)
    blobs = bright_blobs(tex, seen, base)
    lat = fit_lattice(blobs, texel)
    info = {"blobs": len(blobs), "lattice": asdict(lat) if lat else None}
    if lat is None:
        out = base.copy()
        out[seen] = tex[seen]
        return out.astype(np.float32), info
    # base without the fittings' glow: re-estimate it with the fitting halo excluded
    cov = render_lattice(tex.shape[:2], lat)
    core = (cov > 0.05).astype(np.uint8)
    halo = cv2.dilate(core, np.ones((int(2 * halo_m / texel) | 1,) * 2, np.uint8)) > 0
    base = smooth_fill(tex, seen & ~halo, base_sigma_m / texel)
    if weak_tex is not None and weak_w is not None:
        # texels only grazing views saw: their (blurred) colour is still better than a guess from afar
        wk = (weak_w > 0) & ~seen & ~halo
        if wk.any():
            wbase = smooth_fill(weak_tex, wk, base_sigma_m / texel)
            near = cv2.GaussianBlur(seen.astype(np.float32), (0, 0), base_sigma_m / texel)
            wkb = cv2.GaussianBlur(wk.astype(np.float32), (0, 0), base_sigma_m / texel)
            t = np.clip(wkb / np.maximum(wkb + near, 1e-6), 0, 1)[..., None] * (~seen)[..., None]
            base = base * (1 - t) + wbase * t
    # draw=False: the fittings are added as 3D boxes instead (fitting_splats); the plane gets the bare ceiling
    lit = base * (1 - cov[..., None]) + np.asarray(lat.colour, np.float32)[None, None] * cov[..., None] if draw else base
    # seen texture where it was seen (feathered at the edge of the seen area); in clean mode it also fades out
    # towards the fittings, over the halo, so the smeared fittings give way to the crisp ones without a box
    wseen = feather_seen(seen, max(2, int(0.1 / texel)))
    if clean:
        d = cv2.distanceTransform((1 - core).astype(np.uint8), cv2.DIST_L2, 3) * texel
        wseen = wseen * np.clip((d - 0.04) / max(halo_m - 0.04, 1e-3), 0, 1)
    out = tex * wseen[..., None] + lit * (1 - wseen[..., None])
    info["clean"] = bool(clean)
    return out.astype(np.float32), info


def feather_seen(seen: np.ndarray, px: int = 3) -> np.ndarray:
    """0..1 blend weight for the seen texture: 1 deep inside the seen area, ramping to 0 at its edge."""
    import cv2

    d = cv2.distanceTransform(seen.astype(np.uint8), cv2.DIST_L2, 3)
    return np.clip(d / max(px, 1), 0, 1).astype(np.float32)


EDIT_PROMPT = (
    "This is a straight-up view of {what}, as a flat texture seen from directly below. Parts of it are hidden under "
    "solid magenta. Fill the magenta area so the whole image is one clean, continuous ceiling: the same surface, colour "
    "and texture, and the light fittings continued in exactly the same regular rows, size, orientation and spacing as "
    "the visible ones. Straight top-down view, no perspective, no walls, no shadows of people. Do not change anything "
    "outside the magenta area."
)
EDIT_NEGATIVE = "magenta, pink, perspective, walls, people, furniture, text, watermark, blurry, smeared, streaks, distorted lights"


def edit_fill(tex: np.ndarray, seen: np.ndarray, client, work: Path, what: str, steps: int = 32, seed: int = 0,
              max_side: int = 1024) -> np.ndarray:
    """The edit model fills the unseen texels of the texture image (via the model worker)."""
    import cv2

    work.mkdir(parents=True, exist_ok=True)
    h, w = seen.shape
    s = max_side / max(h, w)  # the editor works best near 1024 px: small textures are scaled up
    im = (np.clip(tex, 0, 1) * 255).astype(np.uint8)
    im[~seen] = (255, 0, 255)
    small = cv2.resize(im, (int(w * s) // 16 * 16, int(h * s) // 16 * 16), interpolation=cv2.INTER_AREA)
    src = work / "tex-masked.png"
    W.save_png(src, small)
    out = work / "tex-edit.png"
    client.call("edit", image=str(src), prompt=EDIT_PROMPT.format(what=what), out=str(out), negative=EDIT_NEGATIVE,
                steps=steps, seed=seed)
    from PIL import Image

    gen = np.asarray(Image.open(out).convert("RGB").resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0
    # colour-match the generated image to the seen texture (per channel gain/offset on the seen texels)
    sm = seen & (feather_seen(seen, 4) > 0.99)
    if sm.sum() > 100:
        for c in range(3):
            a, b = np.polyfit(gen[sm, c], tex[sm, c], 1)
            a = float(np.clip(a, 0.7, 1.4))
            gen[..., c] = gen[..., c] * a + float(np.clip(b, -0.15, 0.15))
    return np.clip(gen, 0, 1).astype(np.float32)


# --------------------------------------------------------------------------------------------------------------
# Splats
# --------------------------------------------------------------------------------------------------------------


def vertical_cells(s: sio.Splats, cell: float = 0.1, band=(1.7, 2.2), min_count: int = 3) -> set:
    """Floor-plane cells (cell metres) holding something solid at head height (walls, columns, door frames): what
    rises there into the ceiling zone belongs to a structure, not to the smear."""
    m = s.means
    sel = (m[:, 1] > band[0]) & (m[:, 1] < band[1]) & (s.opacities > 0.3)
    key = np.floor(m[sel][:, [0, 2]] / cell).astype(np.int64)
    if not len(key):
        return set()
    uniq, cnt = np.unique(key, axis=0, return_counts=True)
    cells = {tuple(k) for k in uniq[cnt >= min_count]}
    grown = set()
    for (i, j) in cells:
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                grown.add((i + di, j + dj))
    return grown


def clear_zone(s: sio.Splats, fp: Footprint, height: float, y_from: float, inset: float | dict, y_to: float | None = None,
               protect: set | None = None, cell: float = 0.1) -> np.ndarray:
    """Old splats to remove: centre inside the inset footprint, between y_from and y_to (default height + 0.6): the
    streaks grazing views leave in the ceiling zone. Splats over a `protect` cell (vertical_cells) are kept."""
    m = s.means
    top = height + 0.6 if y_to is None else y_to
    drop = fp.inside(m[:, [0, 2]], inset) & (m[:, 1] > y_from) & (m[:, 1] < top)
    if protect:
        idx = np.nonzero(drop)[0]
        key = np.floor(m[idx][:, [0, 2]] / cell).astype(np.int64)
        prot = np.array([(int(a), int(b)) in protect for a, b in key], bool)
        drop[idx[prot]] = False
    return drop


def open_edge_row(tex: np.ndarray, seen: np.ndarray, frac: float = 0.6, run: int = 5) -> int | None:
    """For a ceiling whose v1 side opens to the outside: the last texel row (from v0) that still looks like ceiling.
    Walking in from the v1 end, the first row whose median brightness reaches frac x the ceiling's, and stays there
    for `run` rows, is the roof edge (beyond it the views see the night outside, projected onto the plane)."""
    lum = tex.mean(-1)
    ref = float(np.median(lum[seen])) if seen.any() else 0.0
    rows = []
    for r in range(lum.shape[0]):
        sel = seen[r]
        rows.append(float(np.median(lum[r][sel])) if sel.sum() > 10 else np.nan)
    rows = np.array(rows)
    ok = rows >= frac * ref
    for r in range(len(rows) - 1, run - 2, -1):
        if ok[r - run + 1 : r + 1].all():
            return r
    return None


def plane_splats(grid: TexGrid, tex: np.ndarray, keep: np.ndarray, sh_rest_dim: int, opacity: float = 0.98,
                 overlap: float = 0.75, thickness: float = 0.002, merge_levels: int = 2, merge_tol: float = 0.025
                 ) -> sio.Splats:
    """Flat, level Gaussians at the ceiling height: one per kept texel (sigma = overlap * texel), except that blocks of
    2x2 (then 4x4, ...) kept texels whose colours differ by less than merge_tol become one splat of twice the size:
    a plain ceiling needs far fewer splats than its light fittings (the headset renders every one)."""
    t = grid.texel
    H, Wd = keep.shape
    used = np.zeros_like(keep)
    pos_uv, size, cols = [], [], []
    for L in range(merge_levels, 0, -1):
        b = 2 ** L
        hb, wb = H // b, Wd // b
        if hb == 0 or wb == 0:
            continue
        kk = keep[: hb * b, : wb * b].reshape(hb, b, wb, b)
        uu = used[: hb * b, : wb * b].reshape(hb, b, wb, b)
        tt = tex[: hb * b, : wb * b].reshape(hb, b, wb, b, 3)
        full = kk.all(axis=(1, 3)) & ~uu.any(axis=(1, 3))
        mean = tt.mean(axis=(1, 3))
        dev = np.abs(tt - mean[:, None, :, None]).max(axis=(1, 3, 4))
        ok = full & (dev < merge_tol)
        r, c = np.nonzero(ok)
        if len(r):
            pos_uv.append(np.stack([grid.fp.u0 + (c * b + b / 2) * t, grid.fp.v0 + (r * b + b / 2) * t], 1))
            size.append(np.full(len(r), b * t))
            cols.append(mean[r, c])
            uu[r, :, c, :] = True
            used[: hb * b, : wb * b] = uu.reshape(hb * b, wb * b)
    r, c = np.nonzero(keep & ~used)
    pos_uv.append(np.stack([grid.fp.u0 + (c + 0.5) * t, grid.fp.v0 + (r + 0.5) * t], 1))
    size.append(np.full(len(r), t))
    cols.append(tex[r, c])
    uv = np.concatenate(pos_uv)
    sz = np.concatenate(size)
    rgb = np.clip(np.concatenate(cols), 0, 1)
    xz = grid.fp.xz(uv)
    n = len(xz)
    means = np.stack([xz[:, 0], np.full(n, grid.height), xz[:, 1]], 1).astype(np.float32)
    a = math.radians(grid.fp.angle)
    # rotate about y so the splat's x axis runs along u (keeps square texels square)
    q = np.array([math.cos(-a / 2), 0.0, math.sin(-a / 2), 0.0], np.float32)
    quats = np.tile(q, (n, 1))
    scales = np.stack([overlap * sz, np.full(n, thickness), overlap * sz], 1).astype(np.float32)
    sh_dc = ((rgb - 0.5) / sio.SH_C0).astype(np.float32)
    rest = np.zeros((n, sh_rest_dim, 3), np.float32) if sh_rest_dim else None
    return sio.Splats(means, scales, quats, np.full(n, opacity, np.float32), sh_dc, rest)


def to_u8(x: np.ndarray) -> np.ndarray:
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


def build_filled(s: sio.Splats, grid: TexGrid, tex: np.ndarray, inset: dict, y_from: float, protect: bool = True):
    """The filled world: old splats minus the ceiling zone, then one plane splat per texel. -> (splats, drop, n_new)"""
    prot = vertical_cells(s) if protect else None
    drop = clear_zone(s, grid.fp, grid.height, y_from, inset, protect=prot)
    kept = s.subset(~drop)
    rest_dim = 0 if s.sh_rest is None else s.sh_rest.shape[1]
    new = plane_splats(grid, tex, np.ones(tex.shape[:2], bool), rest_dim)
    return sio.concat_splats([kept, new]), drop, len(new)


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------


def parse_fp(args) -> Footprint:
    u0, u1, v0, v1 = (float(x) for x in args.rect.split(","))
    return Footprint(float(args.angle), u0, u1, v0, v1, tuple(s for s in args.open.split(",") if s))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scene-dir", required=True)
    ap.add_argument("--images", default=None, help="the recon work folder's images/ (masks/ next to it)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--angle", default=None, help="wall direction in degrees, or 'auto'")
    ap.add_argument("--rect", default=None, help="u0,u1,v0,v1 in the wall frame (metres)")
    ap.add_argument("--texture", default=None, help="rebuild from a finished texture (tex-final.png) and its ceiling.json "
                    "(--meta): no images needed; used to retune the clear zone")
    ap.add_argument("--meta", default=None, help="ceiling.json of the run that made --texture")
    ap.add_argument("--open", default="v1", help="open sides, comma separated (u0,u1,v0,v1)")
    ap.add_argument("--height", default="auto")
    ap.add_argument("--texel", type=float, default=0.025)
    ap.add_argument("--clear-from", type=float, default=None, help="remove old splats above this height (default height - 0.9)")
    ap.add_argument("--inset", default="0.12", help="metres kept clear of each wall (one value or u0,u1,v0,v1)")
    ap.add_argument("--fill", choices=["lattice", "edit", "none"], default="lattice")
    ap.add_argument("--clean", action="store_true", help="redraw the seen (smeared) light fittings crisp from the lattice")
    ap.add_argument("--fittings", choices=["paint", "boxes"], default="paint",
                    help="light fittings painted on the plane, or built as 3D boxes at their own height")
    ap.add_argument("--fitting-height", default="sweep", help="height of the fittings' diffusers ('sweep' or metres)")
    ap.add_argument("--front", default="auto", help="roof edge on the open v1 side: 'auto' (from the texture), 'none' or metres")
    ap.add_argument("--queue", default=None, help="model worker queue (for --fill edit)")
    ap.add_argument("--what", default="a white textured ceiling of a covered patio with long LED strip light fittings")
    ap.add_argument("--min-best", type=float, default=0.35)
    ap.add_argument("--project-only", action="store_true")
    a = ap.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    world = W.load(a.scene_dir)
    s = world.splats
    say(f"world {world.world_file} ({len(s)} splats, digest {world.digest}), {len(world.cams)} cameras")
    ins = [float(x) for x in a.inset.split(",")]
    inset = {k: (ins[i] if len(ins) == 4 else ins[0]) for i, k in enumerate(SIDES)}

    if a.texture:
        from PIL import Image

        meta = json.loads(Path(a.meta).read_text())
        fpd = dict(meta["footprint"])
        fpd["open_sides"] = tuple(fpd.get("open_sides", ()))
        fp = Footprint(**fpd)
        h, texel = float(meta["height"]), float(meta["texel"])
        tex = np.asarray(Image.open(a.texture).convert("RGB")).astype(np.float32) / 255.0
        grid = TexGrid(fp, h, texel, tex.shape[1], tex.shape[0])
        if meta.get("world_digest") != world.digest:
            say(f"warning: texture was made on world {meta.get('world_digest')}, this world is {world.digest}")
        info = {"fill": meta.get("fill"), "rebuilt_from": str(a.texture)}
        meta = {k: v for k, v in meta.items() if k not in ("removed", "added", "n_old_kept", "clear_from", "inset")}
        meta.update({"world": world.world_file, "world_digest": world.digest})
    else:
        if not (a.images and a.angle and a.rect):
            raise SystemExit("--images, --angle and --rect are needed (or --texture + --meta)")
        if a.angle == "auto":
            sel = (s.means[:, 1] > 0.8) & (s.means[:, 1] < 2.6) & (s.opacities > 0.3)
            a.angle = dominant_angle(s.means[sel][:, [0, 2]], s.opacities[sel])
            say(f"wall direction {a.angle:.1f} deg")
        fp = parse_fp(a)
        images = Path(a.images)
        masks = images.parent / "masks"
        sweep = None
        h_fit = None
        boxes = a.fittings == "boxes"
        if a.height.startswith("sweep") or (boxes and a.fitting_height == "sweep"):
            import cv2

            h0 = ceiling_height(s, fp) or 3.0
            parts = a.height.split(":") if a.height.startswith("sweep") else ["sweep"]
            lo, hi, st = (float(parts[1]), float(parts[2]), float(parts[3])) if len(parts) == 4 else (h0 - 0.2, h0 + 0.2, 0.02)
            cache = {}

            def load_half(cam):
                if cam.name not in cache:
                    rgb, m = W.load_image(images, cam, masks=masks)
                    if rgb is None:
                        cache[cam.name] = (None, None)
                    else:
                        hw = (rgb.shape[1] // 2, rgb.shape[0] // 2)
                        cache[cam.name] = (cv2.resize(rgb, hw, interpolation=cv2.INTER_AREA),
                                           cv2.resize(m.astype(np.uint8), hw, interpolation=cv2.INTER_NEAREST) > 0)
                return cache[cam.name]

            sweep = sweep_height(fp, world.cams, load_half, np.arange(lo, hi + 1e-6, st))
            key = "dark" if boxes else "score"
            h_sw = min(sweep, key=lambda r: r[key])["height"]
            if boxes:
                h_fit = min(sweep, key=lambda r: r["bright"])["height"]
            say(f"height sweep: ceiling {h_sw:.3f} m" + (f", fittings {h_fit:.3f} m" if boxes else "") +
                f" (flat-splat estimate {h0:.3f})")
            cache.clear()
            h = h_sw if a.height.startswith("sweep") else (ceiling_height(s, fp) if a.height == "auto" else float(a.height))
        else:
            h = ceiling_height(s, fp) if a.height == "auto" else float(a.height)
        if boxes and a.fitting_height != "sweep":
            h_fit = float(a.fitting_height)
        if boxes and h_fit is not None and h_fit > h - 0.02:
            h_fit = h - 0.02
        if h is None:
            raise SystemExit("no ceiling plane found; pass --height")
        say(f"ceiling at {h:.3f} m over u {fp.u0}..{fp.u1}, v {fp.v0}..{fp.v1} (angle {fp.angle})")
        grid = TexGrid.make(fp, h, a.texel)

        def load(cam):
            return W.load_image(images, cam, masks=masks)

        t0 = time.time()
        proj = project_texture(grid, world.cams, load)
        say(f"projected {len(proj['used'])} views in {time.time() - t0:.0f}s; {int((proj['wsum'] > 0).sum())}/{grid.nu * grid.nv} texels touched")
        seen = seen_mask(proj, a.min_best)
        np.savez_compressed(out / "projection.npz", tex=proj["tex"], wsum=proj["wsum"], best_px=proj["best_px"],
                            views=proj["views"], seen=seen)
        W.save_png(out / "tex-seen-full.png", to_u8(np.where(seen[..., None], proj["tex"], [1.0, 0.0, 1.0])))
        if a.front != "none" and "v1" in fp.open_sides:
            if a.front == "auto":
                r = open_edge_row(proj["tex"], seen)
                v1 = fp.v0 + (r + 1) * a.texel if r is not None else fp.v1
            else:
                v1 = float(a.front)
            rows = max(1, min(grid.nv, int(round((v1 - fp.v0) / a.texel))))
            fp = Footprint(fp.angle, fp.u0, fp.u1, fp.v0, fp.v0 + rows * a.texel, fp.open_sides)
            grid = TexGrid(fp, h, a.texel, grid.nu, rows)
            for k in ("tex", "wsum", "best_px", "views", "weak_tex", "weak_w", "var"):
                proj[k] = proj[k][:rows]
            seen = seen[:rows]
            say(f"roof edge (open side) at v = {fp.v1:.3f}")
        W.save_png(out / "tex-seen.png", to_u8(np.where(seen[..., None], proj["tex"], [1.0, 0.0, 1.0])))
        W.save_png(out / "tex-raw.png", to_u8(proj["tex"]))
        W.save_png(out / "tex-bestpx.png", to_u8(np.clip(proj["best_px"] / 1.5, 0, 1)[..., None].repeat(3, -1)))
        meta = {"world": world.world_file, "world_digest": world.digest, "footprint": asdict(fp), "height": h,
                "texel": a.texel, "grid": [grid.nv, grid.nu], "seen_share": float(seen.mean()),
                "views_used": len(proj["used"]), "gains": proj.get("gains"), "height_sweep": sweep}
        if a.project_only:
            W.write_json(out / "ceiling.json", meta)
            return 0
        if a.fill == "edit":
            from .models import Client

            client = Client(a.queue)
            if not client.wait_ready(["edit"], timeout=1500):
                raise SystemExit("model worker not ready")
            gen = edit_fill(proj["tex"], seen, client, out / "work", a.what)
            f = feather_seen(seen, 3)[..., None]
            tex = proj["tex"] * f + gen * (1 - f)
            info = {"fill": "edit"}
        elif a.fill == "lattice":
            tex, info = lattice_fill(proj["tex"], seen, a.texel, clean=a.clean or boxes,
                                     halo_m=0.4 if (a.clean or boxes) else 0.25,
                                     weak_tex=proj["weak_tex"], weak_w=proj["weak_w"], draw=not boxes)
            info["fill"] = "lattice"
        else:
            tex, info = np.where(seen[..., None], proj["tex"], smooth_fill(proj["tex"], seen, 0.6 / a.texel)), {"fill": "none"}
        W.save_png(out / "tex-final.png", to_u8(tex))
        if boxes:
            # the fittings where they hang: the lattice found again on a projection at their own height
            gf = TexGrid(fp, h_fit, a.texel, grid.nu, grid.nv)
            pf = project_texture(gf, world.cams, load, log_every=0)
            sf = seen_mask(pf, a.min_best)
            latf = fit_lattice(bright_blobs(pf["tex"], sf, smooth_fill(pf["tex"], sf, 0.6 / a.texel)), a.texel)
            if latf is None:
                raise SystemExit("no light fittings found at their height")
            cen = fitting_centres(latf, gf)
            length = float(np.clip(latf.size_u * a.texel * 0.92, 0.9, 1.3))
            width = float(np.clip(latf.size_v * a.texel * 0.7, 0.1, 0.15))
            rest_dim = 0 if s.sh_rest is None else s.sh_rest.shape[1]
            fits = fitting_splats(cen, fp.angle, latf.slope, length, width, h_fit, h, latf.colour, sh_rest_dim=rest_dim)
            W.save_png(out / "tex-fittings.png", to_u8(pf["tex"]))
            info["fittings"] = {"height": h_fit, "count": len(cen), "length": length, "width": width,
                                "lattice": asdict(latf), "splats": len(fits)}
            say(f"{len(cen)} light fittings at {h_fit:.3f} m ({length:.2f} x {width:.2f} m), {len(fits)} splats")

    y_from = a.clear_from if a.clear_from is not None else grid.height - 0.9
    filled, drop, n_new = build_filled(s, grid, tex, inset, y_from)
    if "fittings" in info and not a.texture:
        filled = sio.concat_splats([filled, fits])
        n_new += len(fits)
    sio.write_spz(out / "world-filled.spz", filled)
    meta.update({"removed": int(drop.sum()), "added": n_new, "n_old_kept": int(len(s) - drop.sum()), "clear_from": y_from,
                 "inset": inset, **info})
    W.write_json(out / "ceiling.json", meta)
    say(f"removed {int(drop.sum())} old splats in the ceiling zone, added {n_new} plane splats -> {out / 'world-filled.spz'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
