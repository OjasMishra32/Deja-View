"""Palm crowns where the footage cut the trees off.

The footage of a palm-lined lawn sees the trunks and almost never the crowns (a phone held level frames people, not
treetops), so the trained trunks end in blur a few metres up. A painted view cannot fix that from every standing spot;
a palm has a known shape. So the crown is built in 3D:

1. Find the trunks: floor-plane cells that hold opaque splats over many consecutive half-metre height bands (a thin,
   tall, solid column), merged into trunks; per trunk its axis, radius, colour, and the height where the
   reconstruction stops being solid (`top`). Columns inside a given footprint (the patio's own pillars) are skipped.
2. Complete each trunk: the trunk carries on from `top` to the crown as a column of bark-coloured splats, with the
   criss-cross leaf bases ("boots") of a cabbage palm over its last metre and a half.
3. Grow the crown: about thirty costapalmate fan leaves on a golden-angle spiral, young ones upright, old ones
   drooping, the oldest dry and brown; each leaf a curved petiole and a fan of ~28 folded segments whose tips hang,
   every segment a chain of thin needle splats. Colours come from the one photo that saw the crowns (the night
   uplighting makes the lower leaves brighter than the upper ones); the crown height from where that photo shows the
   leaf bases and fronds on the trunk.

Everything is deterministic for a seed. numpy only. `python -m genfill.palms --help`.
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

import splat_io as sio  # noqa: E402

GOLDEN = math.radians(137.507764)

# Colours sampled from the night photo of the court that shows the crowns (IMG_7363, see README): live fronds lit
# from below, the dry hanging ones, the leaf bases.
PALETTE = {
    "frond_dark": [0.20, 0.25, 0.16],
    "frond_lit": [0.52, 0.58, 0.44],
    "dry": [0.46, 0.37, 0.25],
    "boot": [0.46, 0.37, 0.27],
}


def say(msg: str) -> None:
    import sys

    print(f"[palms] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


@dataclass
class Trunk:
    x: float
    z: float
    radius: float
    top: float
    colour: list = field(default_factory=lambda: [0.78, 0.67, 0.55])
    lean: list = field(default_factory=lambda: [0.0, 0.0])  # metres of x/z drift per metre of height

    def axis(self, y: float) -> np.ndarray:
        return np.array([self.x + self.lean[0] * y, y, self.z + self.lean[1] * y])


# --------------------------------------------------------------------------------------------------------------
# Trunks
# --------------------------------------------------------------------------------------------------------------


def find_trunks(s: sio.Splats, cell: float = 0.15, band: float = 0.5, min_bands: int = 7, y_lo: float = 0.5,
                y_hi: float = 9.0, merge: float = 0.6, exclude=None) -> list[Trunk]:
    """Tall thin solid columns of splats. exclude(xz [N,2]) -> bool marks columns to skip (e.g. pillars inside a
    building footprint)."""
    m = s.means
    sel = (s.opacities > 0.3) & (m[:, 1] > y_lo) & (m[:, 1] < y_hi)
    key = np.floor(m[sel][:, [0, 2]] / cell).astype(np.int64)
    yb = np.floor(m[sel, 1] / band).astype(np.int64)
    if not len(key):
        return []
    k1 = key[:, 0] * 1_000_003 + key[:, 1]
    pairs = np.unique(np.stack([k1, yb], 1), axis=0)
    ck, counts = np.unique(pairs[:, 0], return_counts=True)
    tall = ck[counts >= min_bands]
    if not len(tall):
        return []
    cx = np.round(tall / 1_000_003).astype(np.int64)
    cz = tall - cx * 1_000_003
    pts = (np.stack([cx, cz], 1) + 0.5) * cell
    # merge neighbouring cells
    used = np.zeros(len(pts), bool)
    centres = []
    for i in range(len(pts)):
        if used[i]:
            continue
        g = (np.linalg.norm(pts - pts[i], axis=1) < merge) & ~used
        used |= g
        centres.append(pts[g].mean(0))
    out = []
    rgb = s.rgb()
    for c in centres:
        if exclude is not None and exclude(np.asarray(c)[None])[0]:
            continue
        near = (np.linalg.norm(m[:, [0, 2]] - c[None], axis=1) < 0.35) & (s.opacities > 0.3)
        ys = m[near, 1]
        if len(ys) < 50:
            continue
        # axis per height slice (lean) and radius
        sl = []
        for y0 in np.arange(0.5, 4.0, 0.5):
            q = near & (m[:, 1] >= y0) & (m[:, 1] < y0 + 0.5)
            if q.sum() >= 10:
                sl.append((y0 + 0.25, *np.median(m[q][:, [0, 2]], 0)))
        if len(sl) >= 3:
            a = np.array(sl)
            lx = float(np.polyfit(a[:, 0], a[:, 1], 1)[0])
            lz = float(np.polyfit(a[:, 0], a[:, 2], 1)[0])
            x0 = float(np.polyfit(a[:, 0], a[:, 1], 1)[1])
            z0 = float(np.polyfit(a[:, 0], a[:, 2], 1)[1])
        else:
            lx = lz = 0.0
            x0, z0 = float(c[0]), float(c[1])
        mid = near & (m[:, 1] > 1.0) & (m[:, 1] < 3.0)
        if mid.sum() < 10:
            continue
        ax = np.stack([x0 + lx * m[mid, 1], z0 + lz * m[mid, 1]], 1)
        r = float(np.clip(np.percentile(np.linalg.norm(m[mid][:, [0, 2]] - ax, axis=1), 70), 0.08, 0.3))
        # top: highest 0.25 m band still at >= 30% of the median density below 3 m
        h, e = np.histogram(ys, bins=np.arange(0.0, y_hi + 0.25, 0.25))
        ref = np.median(h[(e[:-1] >= 0.5) & (e[:-1] < 3.0)])
        good = np.nonzero(h >= 0.3 * ref)[0]
        top = float(e[good.max() + 1]) if len(good) else 3.0
        col = np.median(rgb[mid], 0).tolist()
        out.append(Trunk(x0, z0, r, top, [round(v, 3) for v in col], [lx, lz]))
    return out


# --------------------------------------------------------------------------------------------------------------
# Splat builders
# --------------------------------------------------------------------------------------------------------------


def _frames(axis: np.ndarray, side_hint: np.ndarray) -> np.ndarray:
    """Rotation matrices whose columns are (axis, side, normal) for each row."""
    a = axis / np.maximum(np.linalg.norm(axis, axis=1, keepdims=True), 1e-9)
    s = side_hint - (side_hint * a).sum(1, keepdims=True) * a
    bad = np.linalg.norm(s, axis=1) < 1e-6
    if bad.any():
        alt = np.where(np.abs(a[bad, 1:2]) < 0.9, np.array([[0.0, 1.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))
        s[bad] = alt - (alt * a[bad]).sum(1, keepdims=True) * a[bad]
    s /= np.linalg.norm(s, axis=1, keepdims=True)
    n = np.cross(a, s)
    return np.stack([a, s, n], 2)


class Builder:
    """Collects needle / disc splats (means, scales, quats, colours) and turns them into Splats."""

    def __init__(self):
        self.m, self.sc, self.R, self.c, self.o = [], [], [], [], []

    def needles(self, p0: np.ndarray, p1: np.ndarray, width, thick, colour, side_hint, opacity=0.92) -> None:
        p0 = np.atleast_2d(p0).astype(np.float64)
        p1 = np.atleast_2d(p1).astype(np.float64)
        d = p1 - p0
        L = np.linalg.norm(d, axis=1)
        n = len(p0)
        width = np.broadcast_to(np.asarray(width, np.float64), (n,))
        thick = np.broadcast_to(np.asarray(thick, np.float64), (n,))
        self.m.append((p0 + p1) / 2)
        self.sc.append(np.stack([np.maximum(L * 0.42, 1e-3), np.maximum(width * 0.42, 1e-3), np.maximum(thick, 5e-4)], 1))
        self.R.append(_frames(d, np.broadcast_to(np.asarray(side_hint, np.float64), (n, 3)).copy()))
        self.c.append(np.broadcast_to(np.asarray(colour, np.float64), (n, 3)))
        self.o.append(np.broadcast_to(np.asarray(opacity, np.float64), (n,)))

    def splats(self, sh_rest_dim: int = 0) -> sio.Splats:
        if not self.m:
            return sio.Splats(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 4)), np.zeros(0), np.zeros((0, 3)))
        m = np.concatenate(self.m)
        R = np.concatenate(self.R)
        q = G.rotmats_to_quats_wxyz(R)
        rgb = np.clip(np.concatenate(self.c), 0, 1)
        n = len(m)
        rest = np.zeros((n, sh_rest_dim, 3), np.float32) if sh_rest_dim else None
        return sio.Splats(m, np.concatenate(self.sc), q, np.concatenate(self.o), (rgb - 0.5) / sio.SH_C0, rest)


def _curve(p0: np.ndarray, d: np.ndarray, length: float, droop: float, k: int) -> np.ndarray:
    """k+1 points of a gently drooping curve: straight along d, sagging by droop * t^2 at the end."""
    t = np.linspace(0, 1, k + 1)[:, None]
    return p0[None] + length * t * d[None] - np.array([0.0, 1.0, 0.0])[None] * droop * t ** 2


def trunk_extension(b: Builder, tr: Trunk, y0: float, y1: float, rng: np.random.Generator, step: float = 0.06) -> int:
    """Bark from y0 to y1: rings of vertical needles around the axis."""
    n0 = sum(len(x) for x in b.m)
    ys = np.arange(y0, y1, step)
    ring = max(8, int(2 * math.pi * tr.radius / 0.05))
    col = np.asarray(tr.colour)
    for y in ys:
        a = rng.uniform(0, 2 * math.pi) + np.arange(ring) * 2 * math.pi / ring
        c = tr.axis(y)
        p0 = c[None] + np.stack([np.cos(a), np.zeros(ring), np.sin(a)], 1) * tr.radius
        p1 = p0 + np.array([0.0, step * 1.4, 0.0])
        shade = (0.8 + 0.25 * rng.random((ring, 1))) * col[None]
        b.needles(p0, p1, 2 * math.pi * tr.radius / ring * 1.3, 0.004, shade, np.stack([-np.sin(a), 0 * a, np.cos(a)], 1),
                  opacity=0.97)
    return sum(len(x) for x in b.m) - n0


def leaf_bases(b: Builder, tr: Trunk, y0: float, y1: float, rng: np.random.Generator, per_m: int = 55) -> int:
    """Criss-cross leaf bases ("boots") on the upper trunk: short wide wedges pointing out and up."""
    n0 = sum(len(x) for x in b.m)
    n = int(per_m * (y1 - y0))
    i = np.arange(n)
    phi = i * GOLDEN
    y = y0 + (y1 - y0) * (i + rng.random(n)) / n
    out = np.stack([np.cos(phi), np.zeros(n), np.sin(phi)], 1)
    base = np.stack([tr.axis(v) for v in y]) + out * tr.radius * 0.9
    up = math.radians(50)
    d = out * math.cos(up) + np.array([0, 1.0, 0]) * math.sin(up)
    L = rng.uniform(0.18, 0.32, n)
    tip = base + d * L[:, None]
    col = np.asarray(PALETTE["boot"])[None] * rng.uniform(0.75, 1.2, (n, 1))
    side = np.stack([-np.sin(phi), np.zeros(n), np.cos(phi)], 1)
    b.needles(base, tip, rng.uniform(0.08, 0.13, n), 0.006, col, side, opacity=0.97)
    return sum(len(x) for x in b.m) - n0


def crown(b: Builder, centre: np.ndarray, rng: np.random.Generator, n_fronds: int = 30, n_segments: int = 28,
          seg_pieces: int = 6, palette: dict = PALETTE, droop: float = 105.0, dry_share: float = 0.08) -> int:
    """A cabbage-palm crown at `centre`: costapalmate fan leaves on a golden-angle spiral; the youngest leaf points
    80 degrees up, the oldest live one 80 - droop; the oldest dry_share hang down, dry."""
    n0 = sum(len(x) for x in b.m)
    up = np.array([0.0, 1.0, 0.0])
    dark, lit, dry = (np.asarray(palette[k]) for k in ("frond_dark", "frond_lit", "dry"))
    for i in range(n_fronds):
        age = (i + 0.5) / n_fronds
        phi = i * GOLDEN + rng.normal(0, 0.15)
        elev = math.radians(80 - droop * age + rng.normal(0, 7))
        is_dry = age > 1.0 - dry_share
        if is_dry:
            elev = math.radians(rng.uniform(-80, -60))
        d = np.array([math.cos(phi) * math.cos(elev), math.sin(elev), math.sin(phi) * math.cos(elev)])
        # petiole
        lp = rng.uniform(0.9, 1.35) * (0.6 if is_dry else 1.0)
        pts = _curve(centre + d * 0.15, d, lp, 0.18 * lp * max(math.cos(elev), 0.2), 6)
        pc = (dry if is_dry else dark * 1.3) * rng.uniform(0.8, 1.1)
        side = np.cross(d, up)
        if np.linalg.norm(side) < 1e-3:
            side = np.array([1.0, 0.0, 0.0])
        side /= np.linalg.norm(side)
        b.needles(pts[:-1], pts[1:], 0.035, 0.01, pc, side)
        hast = pts[-1]
        bdir = pts[-1] - pts[-2]
        bdir /= np.linalg.norm(bdir)
        side = np.cross(bdir, up)
        if np.linalg.norm(side) < 1e-3:
            side = np.cross(bdir, np.array([1.0, 0.0, 0.0]))
        side /= np.linalg.norm(side)
        normal = np.cross(side, bdir)
        if normal[1] < 0:
            normal = -normal
        lb = rng.uniform(0.95, 1.3) * (0.8 if is_dry else 1.0)
        span = math.radians(115 if not is_dry else 60)
        for j in range(n_segments):
            al = -span + 2 * span * (j + 0.5) / n_segments
            fold = 0.06 * (1 if j % 2 else -1)
            q = math.cos(al) * bdir + math.sin(al) * side - (0.35 * abs(math.sin(al)) - fold) * normal
            q /= np.linalg.norm(q)
            ls = lb * (1 - 0.35 * (abs(al) / max(span, 1e-6)) ** 2) * rng.uniform(0.9, 1.08)
            seg = _curve(hast, q, ls, (0.45 if is_dry else 0.3) * ls, seg_pieces)
            w = np.linspace(0.045, 0.012, seg_pieces)
            # night uplighting: lower parts of the crown catch more light
            hy = (seg[:-1, 1] + seg[1:, 1]) / 2 - centre[1]
            light = np.clip(0.55 - 0.25 * hy + rng.normal(0, 0.08), 0.0, 1.0)[:, None]
            if is_dry:
                col = dry[None] * (0.75 + 0.4 * light) * rng.uniform(0.85, 1.1)
            else:
                col = dark[None] * (1 - light) + lit[None] * light
                col = col * rng.uniform(0.9, 1.1, 3)[None]
            b.needles(seg[:-1], seg[1:], w, 0.003, col, np.broadcast_to(side, (seg_pieces, 3)).copy(), opacity=0.9)
    return sum(len(x) for x in b.m) - n0


def palm_splats(trunks: list[Trunk], crown_y: float, boots_from: float, seed: int = 0, sh_rest_dim: int = 0,
                n_fronds: int = 30, owner: list | None = None) -> tuple[sio.Splats, list[dict]]:
    """All palms' splats. owner (a list, if given) receives each splat's palm index."""
    rng = np.random.default_rng(seed)
    b = Builder()
    report = []
    for ti, tr in enumerate(trunks):
        n_before = sum(len(x) for x in b.m)
        cy = crown_y + rng.uniform(-0.25, 0.25)
        y_ext0 = max(tr.top - 0.3, 1.5)
        n_tr = trunk_extension(b, tr, y_ext0, cy - 0.1, rng) if y_ext0 < cy - 0.2 else 0
        n_bt = leaf_bases(b, tr, min(boots_from, cy - 0.6), cy - 0.05, rng)
        n_cr = crown(b, tr.axis(cy), rng, n_fronds=n_fronds)
        report.append({"trunk": asdict(tr), "crown_y": round(cy, 3), "extension_from": round(y_ext0, 3),
                       "splats": {"trunk": n_tr, "leaf_bases": n_bt, "crown": n_cr}})
        if owner is not None:
            owner.extend([ti] * (sum(len(x) for x in b.m) - n_before))
    return b.splats(sh_rest_dim), report


def calibrate(new: sio.Splats, owner: np.ndarray, cams: list, load, min_y: float, max_dist: float = 15.0,
              lo: float = 0.25, hi: float = 1.3, min_samples: int = 200) -> list[dict]:
    """Per palm, a brightness gain from the photos that framed its crown: the crown's splat centres are projected
    into every training image that has them in frame, and the median ratio of image brightness to splat brightness
    becomes the palm's gain (a crown the photos show dark against the sky, because no light reaches it, is made
    dark; one they show lit stays lit). Splats above min_y only. Modifies `new` in place; returns the gains."""
    rgb = new.rgb()
    lum_s = rgb.mean(1)
    out = []
    for pi in np.unique(owner):
        sel = (owner == pi) & (new.means[:, 1] > min_y)
        pts = new.means[sel]
        ratios = []
        used = 0
        for cam in cams:
            if np.linalg.norm(cam.position[[0, 2]] - pts[:, [0, 2]].mean(0)) > max_dist:
                continue
            u, v, z = G.project(pts, cam.c2w, cam.intr)
            k = cam.intr
            ok = (z > 0.1) & (u >= 0) & (u < k.width) & (v >= 0) & (v < k.height)
            if ok.sum() < 50:
                continue
            img, mask = load(cam)
            if img is None:
                continue
            iu, iv = u[ok].astype(int), v[ok].astype(int)
            m = mask[iv, iu]
            li = img[iv, iu].astype(np.float64).mean(1)[m] / 255.0
            ratios.append(li / np.maximum(lum_s[sel][ok][m], 0.03))
            used += 1
        r = np.concatenate(ratios) if ratios else np.zeros(0)
        g = float(np.clip(np.median(r), lo, hi)) if len(r) >= min_samples else 1.0
        new.sh_dc[sel] = ((np.clip(rgb[sel] * g, 0, 1) - 0.5) / sio.SH_C0).astype(np.float32)
        out.append({"palm": int(pi), "gain": round(g, 3), "views": used, "samples": int(len(r))})
    return out


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scene-dir", required=True, help="scene folder (scene.json; its world unless --world)")
    ap.add_argument("--world", default=None, help="splat file to add the crowns to (e.g. the ceiling-filled world)")
    ap.add_argument("--find-in", default=None, help="splat file to find the trunks in (default: the scene's world)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--crown-height", type=float, default=6.5)
    ap.add_argument("--boots-from", type=float, default=5.0)
    ap.add_argument("--exclude-rect", default=None, help="angle,u0,u1,v0,v1: skip columns inside (pillars)")
    ap.add_argument("--min-top", type=float, default=0.0, help="only trunks whose reconstruction stops below this")
    ap.add_argument("--fronds", type=int, default=30)
    ap.add_argument("--max-cam-dist", type=float, default=8.0, help="only trunks this close (floor plane) to a training camera")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--images", default=None, help="recon images/: calibrate each crown's brightness against the photos")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    world = W.load(a.scene_dir)
    base = sio.read_splats(a.world) if a.world else world.splats
    find_in = sio.read_splats(a.find_in) if a.find_in else world.splats
    exclude = None
    if a.exclude_rect:
        from .ceiling import Footprint

        ang, u0, u1, v0, v1 = (float(x) for x in a.exclude_rect.split(","))
        fp = Footprint(ang, u0, u1, v0, v1)
        exclude = lambda xz: fp.inside(xz, -0.3)  # noqa: E731
    trunks = find_trunks(find_in, exclude=exclude)
    cams = world.cam_xz()
    skipped = []
    keep = []
    for t in trunks:
        dist = float(np.min(np.linalg.norm(cams - np.array([[t.x, t.z]]), axis=1))) if len(cams) else 0.0
        bark = t.colour[0] - t.colour[2] > 0.06 and max(t.colour) < 0.97  # tan bark, not a white pole
        (keep if dist <= a.max_cam_dist and bark else skipped).append(t)
    if skipped:
        say("skipped (far from the footage or not bark-coloured): " + ", ".join(f"({t.x:.1f},{t.z:.1f})" for t in skipped))
    trunks = keep
    if a.min_top:
        trunks = [t for t in trunks if t.top < a.min_top]
    say(f"{len(trunks)} trunks: " + ", ".join(f"({t.x:.2f},{t.z:.2f}) r {t.radius:.2f} top {t.top:.2f}" for t in trunks))
    rest_dim = 0 if base.sh_rest is None else base.sh_rest.shape[1]
    owner: list = []
    new, report = palm_splats(trunks, a.crown_height, a.boots_from, a.seed, rest_dim, a.fronds, owner=owner)
    gains = None
    if a.images:
        images = Path(a.images)
        gains = calibrate(new, np.asarray(owner), world.cams, lambda c: W.load_image(images, c, masks=images.parent / "masks"),
                          min_y=min(t.top for t in trunks) if trunks else 4.0)
        say("crown brightness from the photos: " + ", ".join(f"palm {g['palm']} x{g['gain']} ({g['views']} views)" for g in gains))
    filled = sio.concat_splats([base, new])
    sio.write_spz(out / "world-filled.spz", filled)
    meta = {"scene_world_digest": world.digest, "base": str(a.world or world.world_file), "n_base": len(base),
            "added": len(new), "crown_height": a.crown_height, "boots_from": a.boots_from, "seed": a.seed,
            "palette": PALETTE, "palms": report, "photo_gains": gains}
    W.write_json(out / "palms.json", meta)
    say(f"added {len(new)} splats for {len(trunks)} palms -> {out / 'world-filled.spz'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
