#!/usr/bin/env python3
"""Turns a scene's splat world into a Roblox map: coloured, axis-aligned boxes in studs.

  python pipeline/roblox_map.py --scene data/scenes/<id> --out <json> [--max-parts N] [--preview PNG] [--key K]
                                [--topdown JPG]

Output (team/contracts.md 6.2; every number in studs, Y up, floor at y = 0, -Z forward, no axis flips):

  { "sceneId", "name", "studsPerMeter": 3.57, "spawn": [x, 0, z],
    "parts": [[x, y, z, sx, sy, sz, r, g, b(, imagined)], ...],      centre + size, colour 0..255, bottom-up
    "ceilingY", "bounds": {"min", "max"}, "spawnYaw", "headsetSpawn", "floorY", "voxel", "imagined", "build" }

How:
 1. Read the world (SPZ or PLY, pipeline/splat_io.py), apply scene.world.transform and put the floor at y = 0:
    scene.world.floorY when set, otherwise the same weighted height histogram the headset viewer uses
    (web/src/viewer/analysis.ts estimateFloor), so the Roblox floor and the headset floor agree.
 2. Keep opaque, not-huge splats (the viewer's own thresholds), stamp large flat splats as small discs so walls
    have no holes, and crop to the room (robust percentiles).
 3. Voxelise in studs. Colours are averaged in linear light (3DGS colours are sRGB-encoded: SH DC -> 0.5 + C0 * dc,
    then the sRGB curve is undone, averaged with opacity weights, and re-encoded), smoothed once with the six
    neighbours, then quantised to a small palette in OKLab so neighbouring voxels of similar colour share a label.
 4. Drop floaters (small 26-connected components) and the ceiling (a high layer that covers the open floor).
 5. Greedy-merge equal labels into boxes (x run, then z, then y). The voxel size is searched so the part count
    lands just under the budget (default 6000, cap 12000).
 6. A solid floor slab (1 stud thick, top at y = 0) always goes first; floor patches whose colour differs from it
    (a rug) become thin tiles on top.
 7. Spawn: a free floor point about 2 m from the headset spawn, preferably in front of it, so nobody spawns
    inside the person in the headset.
 8. When the capture camera is known (scene.video.cameraPose or input_camera.json), each part carries a 10th value:
    1 = imagined (the camera never saw it), 0 = captured (visible from the camera), for the reality-check tint.

With --topdown (the map bake, contracts 4.2 and 11) it also writes the floor plan: an orthographic view from above,
ceiling cut off, covering exactly topdown.min to topdown.max in (x, z): the walkable part of the room inside
world.bounds (image right = +X, image down = +Z, about 100 px per metre, at most 1024 px on the long side), and the output gains "bake": {floorY, bounds, topdown} for the server to merge into
scene.json (floorY only when the scene has none, bounds only when missing; bounds are the viewer's own robust 1 % to
99 % box of the same splats, in the scene frame).

The voxel size is a multiple of 0.02 studs and the grid origin sits on multiples of it, so every centre and size is
exact at two decimals and neighbouring parts meet without seams.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import splat_io as sio  # noqa: E402

STUDS_PER_METER = 3.57
DEFAULT_MAX_PARTS = 6000
MAX_PARTS_CAP = 12000
MIN_PARTS = 100
MAP_VERSION = 1
DEFAULT_COLORS = 16

# The viewer's sample filters (web/src/viewer/world.ts collectSamples): opacity >= 0.35, largest axis <= 0.6 m.
MIN_OPACITY = 0.35
HUGE_LIMIT_M = 0.6
MAX_POINTS = 1_500_000
MIN_VOXEL_STUDS = 0.30  # about 8 cm: finer is pointless at Roblox scale
MAX_VOXEL_STUDS = 8.0
MAX_EXTENT_M = 48.0  # outdoor worlds are cropped to this square around the headset spawn
SLAB_STUDS = 1.0
TILE_STUDS = 0.2
FLOOR_TILE_DELTA = 0.065  # OKLab distance from the slab colour above which a floor patch becomes a tile


class MapError(Exception):
    """A problem with the input that a person can act on (no world, unreadable file)."""


# --------------------------------------------------------------------------------------------------------------
# Colour
# --------------------------------------------------------------------------------------------------------------


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(c, np.float64), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(c, np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def linear_to_oklab(c: np.ndarray) -> np.ndarray:
    """Linear sRGB [..., 3] -> OKLab [..., 3] (L in 0..1)."""
    c = np.asarray(c, np.float64)
    m1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                   [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]])
    m2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                   [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]])
    lms = np.cbrt(np.maximum(c @ m1.T, 0.0))
    return lms @ m2.T


def to_u8(lin: np.ndarray) -> np.ndarray:
    return np.clip(np.round(linear_to_srgb(lin) * 255.0), 0, 255).astype(np.int64)


def lift_dark(lin: np.ndarray, min_lum: float = 0.02) -> np.ndarray:
    """Brightens a near-black linear colour to a minimum luminance (hue kept), so a dark floor still reads as a
    floor against a dark sky instead of a hole."""
    lin = np.asarray(lin, np.float64)
    lum = float(lin @ np.array([0.2126, 0.7152, 0.0722]))
    if lum >= min_lum:
        return lin
    if lum <= 1e-6:
        return np.full(3, min_lum)
    return np.clip(lin * (min_lum / lum), 0.0, 1.0)


def kmeans(x: np.ndarray, k: int, iters: int = 14, seed: int = 0, max_samples: int = 40_000) -> np.ndarray:
    """Plain k-means (k-means++ seeding) on a subsample; returns the centroids."""
    rng = np.random.default_rng(seed)
    x = np.asarray(x, np.float64)
    if len(x) > max_samples:
        x = x[rng.choice(len(x), max_samples, replace=False)]
    k = max(1, min(k, len(x)))
    cent = [x[rng.integers(len(x))]]
    d2 = np.sum((x - cent[0]) ** 2, axis=1)
    for _ in range(1, k):
        tot = d2.sum()
        if not tot > 0:
            break
        cent.append(x[rng.choice(len(x), p=d2 / tot)])
        d2 = np.minimum(d2, np.sum((x - cent[-1]) ** 2, axis=1))
    c = np.array(cent)
    for _ in range(iters):
        lab = nearest(x, c)
        for j in range(len(c)):
            m = lab == j
            if m.any():
                c[j] = x[m].mean(axis=0)
    return c


def nearest(x: np.ndarray, c: np.ndarray) -> np.ndarray:
    d = np.sum(x * x, axis=1)[:, None] - 2 * x @ c.T + np.sum(c * c, axis=1)[None, :]
    return np.argmin(d, axis=1).astype(np.int32)


# --------------------------------------------------------------------------------------------------------------
# Floor (a port of the viewer's estimateFloor, so both sides agree)
# --------------------------------------------------------------------------------------------------------------


def _quantile_sorted(s: np.ndarray, q: float) -> float:
    n = len(s)
    t = min(1.0, max(0.0, q)) * (n - 1)
    i = int(math.floor(t))
    f = t - i
    if i + 1 >= n:
        return float(s[n - 1])
    return float(s[i] * (1 - f) + s[i + 1] * f)


def viewer_floor(ys: np.ndarray, weights: np.ndarray | None = None, below: float | None = None,
                 min_peak_ratio: float = 0.35) -> tuple[float, float] | None:
    """(floor y, confidence) from a weighted height histogram; the lowest strong low peak wins."""
    ys = np.asarray(ys, np.float32)
    n = len(ys)
    if n < 32:
        return None
    s_sorted = np.sort(ys)
    lo = _quantile_sorted(s_sorted, 0.003)
    hi = _quantile_sorted(s_sorted, 0.997)
    rng = hi - lo
    if not rng > 1e-4:
        return lo, 0.0
    bin_ = max(0.03, rng / 400)
    nb = max(3, int(math.ceil(rng / bin_)) + 1)
    m = (ys >= lo) & (ys <= hi)
    b = np.minimum(nb - 1, np.floor((ys[m] - lo) / bin_).astype(np.int64))
    w = None if weights is None else np.asarray(weights, np.float64)[m]
    hist = np.bincount(b, weights=w, minlength=nb).astype(np.float64)[:nb]
    pad = np.concatenate([[0.0], hist, [0.0]])
    s = (pad[:-2] + 2 * pad[1:-1] + pad[2:]) / 4
    median = _quantile_sorted(s_sorted, 0.5)
    cut = max(median, lo + 0.5 * rng)
    restrict = False
    if below is not None and below > lo + bin_:
        restrict = True
        cut = min(cut, below)
    centers = lo + (np.arange(nb) + 0.5) * bin_

    def pick(limit: float) -> int:
        valid = np.nonzero(centers < limit)[0]
        if len(valid) == 0:
            return -1
        mx = float(s[valid].max())
        if mx <= 0:
            return -1
        for i in valid:
            left = s[i - 1] if i > 0 else 0.0
            right = s[i + 1] if i < nb - 1 else 0.0
            if s[i] >= left and s[i] >= right and s[i] >= min_peak_ratio * mx:
                return int(i)
        return -1

    peak = pick(cut)
    if peak < 0 and restrict:
        peak = pick(max(median, lo + 0.5 * rng))
    if peak < 0:
        return lo, 0.0
    c = float(centers[peak])
    a = int(np.searchsorted(s_sorted, c - 1.5 * bin_, side="left"))
    bb = int(np.searchsorted(s_sorted, c + 1.5 * bin_, side="left"))
    y = float(s_sorted[(a + bb) >> 1]) if bb > a else c
    mean = float(s.mean())
    prominence = s[peak] / mean if mean > 0 else 0.0
    return y, float(max(0.0, min(1.0, (prominence - 1) / 6)))


# --------------------------------------------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------------------------------------------


@dataclass
class World:
    pos: np.ndarray  # [N,3] room frame metres (floor at y = 0)
    lin: np.ndarray  # [N,3] linear RGB
    w: np.ndarray  # [N] opacity weight
    floor_y: float  # scene-frame floor height that was subtracted
    floor_estimated: bool
    splats: int
    spawn: tuple[float, float, float]  # headset spawn, room frame metres
    spawn_yaw: float
    camera: dict | None  # capture camera in the room frame
    n_base: int = 0  # the first n_base rows of pos are the splat centres themselves (the rest are stamped discs)


def read_scene(scene_dir: Path) -> dict:
    p = scene_dir / "scene.json"
    try:
        scene = json.loads(p.read_text())
    except FileNotFoundError:
        raise MapError(f"{p} is missing")
    except (OSError, json.JSONDecodeError) as e:
        raise MapError(f"{p} is unreadable: {e}")
    if not isinstance(scene, dict):
        raise MapError(f"{p} is not a scene")
    return scene


def _world_file(scene_dir: Path, world: dict) -> Path:
    rel = world.get("file")
    if not isinstance(rel, str) or not rel or rel.startswith("/") or ".." in Path(rel).parts:
        raise MapError("scene.world.file is missing or unsafe")
    # a lexical check (no symlink resolution): a demo world may be a symlink to a shared file
    base = os.path.normpath(os.path.abspath(scene_dir))
    path = Path(os.path.normpath(os.path.join(base, rel)))
    if not str(path).startswith(base + os.sep):
        raise MapError("scene.world.file escapes the scene directory")
    if not path.is_file():
        raise MapError(f"the world file {rel} is missing")
    return path


def _splat_normals(quats_wxyz: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """Rotation-matrix column of each splat's smallest axis (its normal when it is a flat disc)."""
    w, x, y, z = (quats_wxyz[:, i].astype(np.float64) for i in range(4))
    cols = np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], axis=1),
        np.stack([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], axis=1),
        np.stack([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)], axis=1),
    ], axis=1)  # [N, axis, xyz]
    smin = np.argmin(scales, axis=1)
    return cols[np.arange(len(scales)), smin]


def _axes(quats_wxyz: np.ndarray) -> np.ndarray:
    """[N, 3 axes, xyz] rotation-matrix columns."""
    w, x, y, z = (quats_wxyz[:, i].astype(np.float64) for i in range(4))
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], axis=1),
        np.stack([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], axis=1),
        np.stack([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)], axis=1),
    ], axis=1)


def _camera(scene: dict, scene_dir: Path) -> dict | None:
    """The capture camera in the scene frame: c2w rotation (OpenGL), position, pinhole intrinsics, size."""
    v = scene.get("video")
    try:
        if isinstance(v, dict) and isinstance(v.get("cameraPose"), dict) and isinstance(v.get("intrinsics"), dict):
            k = v["intrinsics"]
            return {
                "R": sio.quat_xyzw_to_matrix(v["cameraPose"]["quaternion"]),
                "c": np.asarray(v["cameraPose"]["position"], np.float64),
                "fx": float(k["fx"]), "fy": float(k["fy"]), "cx": float(k["cx"]), "cy": float(k["cy"]),
                "w": int(v["width"]), "h": int(v["height"]),
            }
        cam = sio.read_json(scene_dir / "input_camera.json")
        if isinstance(cam, dict) and "fx" in cam and "position" in cam:
            return {
                "R": sio.quat_xyzw_to_matrix(cam["quaternion"]),
                "c": np.asarray(cam["position"], np.float64),
                "fx": float(cam["fx"]), "fy": float(cam["fy"]), "cx": float(cam["cx"]), "cy": float(cam["cy"]),
                "w": int(cam["width"]), "h": int(cam["height"]),
            }
    except (KeyError, TypeError, ValueError):
        return None
    return None


def load_world(scene_dir: Path, scene: dict, seed: int = 0) -> World:
    world = scene.get("world")
    if not isinstance(world, dict):
        raise MapError("this scene has no world")
    path = _world_file(scene_dir, world)
    try:
        s = sio.read_splats(path)
    except Exception as e:  # noqa: BLE001 - any parse failure is a bad input
        raise MapError(f"could not read {path.name}: {e}")
    if len(s) == 0:
        raise MapError("the world has no splats")
    tr = world.get("transform") or {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}
    R, t, sc = sio.transform_parts(tr)
    sc = abs(sc) or 1.0
    means = (s.means.astype(np.float64) * sc) @ R.T + t
    smax = s.scales.max(axis=1).astype(np.float64) * sc
    ok = np.all(np.isfinite(means), axis=1) & np.isfinite(smax) & (s.opacities >= MIN_OPACITY) & (smax <= HUGE_LIMIT_M)
    idx = np.nonzero(ok)[0]
    if len(idx) < 50:
        raise MapError("this world has almost no solid splats")
    rng = np.random.default_rng(seed)
    if len(idx) > MAX_POINTS:
        idx = np.sort(rng.choice(idx, MAX_POINTS, replace=False))
    pos = means[idx]
    op = s.opacities[idx].astype(np.float64)
    rgb = s.rgb()[idx]
    scales = s.scales[idx].astype(np.float64) * sc
    quats = s.quats[idx]

    # Floor: the scene's own, else the viewer's estimate (flat horizontal splats weigh 3x).
    floor_given = world.get("floorY")
    if isinstance(floor_given, (int, float)) and math.isfinite(floor_given):
        floor_y, estimated = float(floor_given), False
    else:
        up_file = R[1, :]  # world up in file coordinates
        n = _splat_normals(quats, s.scales[idx])
        ssort = np.sort(s.scales[idx], axis=1)
        flat = ssort[:, 0] < 0.4 * ssort[:, 1]
        horiz = np.abs(n @ up_file) > 0.85
        weights = np.where(flat & horiz, 3.0, 1.0)
        lo = np.quantile(pos, 0.02, axis=0)
        hi = np.quantile(pos, 0.98, axis=0)
        origin_inside = lo[0] < 0 < hi[0] and lo[2] < 0 < hi[2] and lo[1] < 0
        est = viewer_floor(pos[:, 1], weights, below=-0.3 if origin_inside else None)
        floor_y = est[0] if est else float(lo[1])
        estimated = True
    pos[:, 1] -= floor_y

    # Stamp big splats as discs (+-1 sigma along their two largest axes) so walls made of a few large splats
    # still fill every voxel they cover.
    big = np.nonzero(scales.max(axis=1) >= 0.045)[0]
    extra_pos = [pos]
    extra_rgb = [rgb]
    extra_w = [op]
    if len(big):
        ax = _axes(quats[big])
        order = np.argsort(-scales[big], axis=1)
        for j in (0, 1):
            a = order[:, j]
            vec = ax[np.arange(len(big)), a] * scales[big, a][:, None]
            for sign in (1.0, -1.0):
                extra_pos.append(pos[big] + sign * vec)
                extra_rgb.append(rgb[big])
                extra_w.append(op[big] * 0.6)
    pos = np.concatenate(extra_pos)
    rgb = np.concatenate(extra_rgb)
    w = np.concatenate(extra_w)

    # Headset spawn in the room frame (the viewer stands there; scene.world.spawn, else the video camera).
    sx = sz = 0.0
    yaw = 0.0
    sp = world.get("spawn")
    cam = _camera(scene, scene_dir)
    if isinstance(sp, dict) and isinstance(sp.get("position"), list) and len(sp["position"]) == 3:
        sx, sz = float(sp["position"][0]), float(sp["position"][2])
        yaw = float(sp.get("yaw") or 0.0)
    elif cam is not None:
        f = cam["R"] @ np.array([0.0, 0.0, -1.0])
        sx, sz = float(cam["c"][0]), float(cam["c"][2])
        yaw = math.atan2(-f[0], -f[2])
    if cam is not None:
        cam = dict(cam)
        cam["c"] = cam["c"] - np.array([0.0, floor_y, 0.0])
    return World(pos, srgb_to_linear(rgb), w, floor_y, estimated, len(s), (sx, 0.0, sz), yaw, cam, len(idx))


# --------------------------------------------------------------------------------------------------------------
# Voxels and boxes
# --------------------------------------------------------------------------------------------------------------


def greedy_boxes_3d(L: np.ndarray) -> list[tuple[int, int, int, int, int, int, int]]:
    """Greedy box cover of a label grid indexed [y, z, x] (-1 = empty). Consumes L. Boxes are
    (x0, y0, z0, x1, y1, z1, label), half-open, in scan order (bottom-up)."""
    ny, nz, nx = L.shape
    out = []
    for y0, z0, x0 in np.argwhere(L >= 0).tolist():
        lab = L[y0, z0, x0]
        if lab < 0:
            continue
        neq = L[y0, z0, x0:] != lab
        run = int(neq.argmax())
        x1 = x0 + (run if run > 0 else nx - x0)
        z1 = z0 + 1
        while z1 < nz and (L[y0, z1, x0:x1] == lab).all():
            z1 += 1
        y1 = y0 + 1
        while y1 < ny and (L[y1, z0:z1, x0:x1] == lab).all():
            y1 += 1
        L[y0:y1, z0:z1, x0:x1] = -1
        out.append((x0, y0, z0, x1, y1, z1, int(lab)))
    return out


def greedy_rects_2d(L: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """Greedy rectangles of a label grid indexed [z, x]; (x0, z0, x1, z1, label)."""
    boxes = greedy_boxes_3d(L[None, :, :])
    return [(x0, z0, x1, z1, lab) for x0, _, z0, x1, _, z1, lab in boxes]


def hull_mask(cols: np.ndarray, margin: float = 1.0) -> np.ndarray:
    """Cells [z, x] whose centre lies inside the convex hull of the occupied cells' centres, grown by `margin`
    cells. The floor follows the room's outline (a rotated room gets a rotated floor), not its bounding box."""
    nz, nx = cols.shape
    zi, xi = np.nonzero(cols)
    if len(zi) < 3:
        return np.ones((nz, nx), bool)
    pts = np.stack([xi + 0.5, zi + 0.5], axis=1).astype(np.float64)
    try:
        from scipy.spatial import ConvexHull

        eq = ConvexHull(pts).equations  # a x + b z + c <= 0 inside, (a, b) unit length
    except Exception:  # noqa: BLE001 - collinear columns: fall back to the bounding box
        out = np.zeros((nz, nx), bool)
        out[max(0, zi.min() - 1):zi.max() + 2, max(0, xi.min() - 1):xi.max() + 2] = True
        return out
    gz, gx = np.mgrid[0:nz, 0:nx]
    q = np.stack([gx.ravel() + 0.5, gz.ravel() + 0.5], axis=1)
    inside = np.all(q @ eq[:, :2].T + eq[:, 2] <= margin, axis=1)
    return inside.reshape(nz, nx)


def block_any(mask: np.ndarray, k: int) -> np.ndarray:
    """Downsamples a [z, x] mask by k: a coarse cell is set when any fine cell in it is."""
    if k <= 1:
        return mask.copy()
    nz, nx = mask.shape
    pz, px = (-nz) % k, (-nx) % k
    m = np.pad(mask, ((0, pz), (0, px)))
    return m.reshape(m.shape[0] // k, k, m.shape[1] // k, k).any(axis=(1, 3))


def quant_voxel(v: float) -> float:
    """Voxel size in studs, a multiple of 0.02: with the grid origin on a multiple of it, every size is a multiple
    of 0.02 and every centre a multiple of 0.01, so two decimals are exact and neighbours meet without seams."""
    return round(max(MIN_VOXEL_STUDS, min(MAX_VOXEL_STUDS, round(v / 0.02) * 0.02)), 2)


def _smooth(colour: np.ndarray, occ: np.ndarray) -> np.ndarray:
    """One pass of 6-neighbour averaging over occupied voxels (centre counts twice)."""
    acc = colour * occ[..., None] * 2.0
    cnt = occ.astype(np.float64) * 2.0
    for axis in range(3):
        for shift in (1, -1):
            o = np.roll(occ, shift, axis=axis)
            c = np.roll(colour, shift, axis=axis)
            # np.roll wraps around: blank the wrapped slice
            sl = [slice(None)] * 3
            sl[axis] = slice(0, 1) if shift == 1 else slice(-1, None)
            o = o.copy()
            o[tuple(sl)] = False
            acc += c * o[..., None]
            cnt += o
    out = acc / np.maximum(cnt, 1e-9)[..., None]
    return np.where(occ[..., None], out, 0.0)


def _visibility(cam: dict, pts: np.ndarray, radius_m: float) -> np.ndarray:
    """True where a point (room frame metres) is the first surface the capture camera sees (z-buffer test)."""
    ds = max(1.0, cam["w"] / 192.0)
    bw, bh = int(math.ceil(cam["w"] / ds)), int(math.ceil(cam["h"] / ds))
    pc = (pts - cam["c"]) @ cam["R"]
    depth = -pc[:, 2]
    good = depth > 0.05
    d = np.where(good, depth, 1.0)
    u = (cam["fx"] * pc[:, 0] / d + cam["cx"]) / ds
    v = (cam["fy"] * (-pc[:, 1]) / d + cam["cy"]) / ds
    inside = good & (u >= 0) & (u < bw) & (v >= 0) & (v < bh)
    zb = np.full(bh * bw, np.inf)
    ui = np.floor(u).astype(np.int64)
    vi = np.floor(v).astype(np.int64)
    rad = (cam["fx"] / ds) * radius_m / d
    rmax = 8
    sel_all = np.nonzero(good)[0]
    for dy in range(-rmax, rmax + 1):
        for dx in range(-rmax, rmax + 1):
            r = math.hypot(dx, dy)
            if r > rmax:
                continue
            s = sel_all[rad[sel_all] >= r - 0.5] if r > 0 else sel_all
            if len(s) == 0:
                continue
            uu = ui[s] + dx
            vv = vi[s] + dy
            ok = (uu >= 0) & (uu < bw) & (vv >= 0) & (vv < bh)
            if not ok.any():
                continue
            np.minimum.at(zb, vv[ok] * bw + uu[ok], depth[s][ok])
    cell = np.clip(vi, 0, bh - 1) * bw + np.clip(ui, 0, bw - 1)
    # depth from one view is noisy: a surface a few voxels thick still counts as seen
    tol = np.maximum(6.0 * radius_m, 0.08 * depth)
    return inside & (depth <= zb[cell] + tol)


@dataclass
class Build:
    voxel: float  # studs
    parts: list[list[float]]
    slab_parts: int  # the first parts are the floor slab pieces
    voxels: int
    boxes: int
    tiles: int
    ceiling_y: float
    bounds: dict
    spawn: list[float]
    spawn_yaw: float
    imagined: bool
    floor_rgb: list[int]


class Mapper:
    """Holds the room in studs and builds the part list at a given voxel size."""

    def __init__(self, world: World, colors: int = DEFAULT_COLORS):
        self.world = world
        self.colors = colors
        P = world.pos * STUDS_PER_METER
        y = P[:, 1]
        keep = y >= -0.25 * STUDS_PER_METER
        P, lin, w = P[keep], world.lin[keep], world.w[keep]
        # Horizontal crop: robust percentiles of what stands between the floor and head height.
        band = (P[:, 1] > 0.05 * STUDS_PER_METER) & (P[:, 1] < 2.6 * STUDS_PER_METER)
        src = P[band] if band.sum() > 2000 else P
        lo = np.percentile(src[:, [0, 2]], 0.5, axis=0) - 0.15 * STUDS_PER_METER
        hi = np.percentile(src[:, [0, 2]], 99.5, axis=0) + 0.15 * STUDS_PER_METER
        half = 0.5 * MAX_EXTENT_M * STUDS_PER_METER
        cxz = np.array([world.spawn[0], world.spawn[2]]) * STUDS_PER_METER
        lo = np.maximum(lo, cxz - half)
        hi = np.minimum(hi, cxz + half)
        top = min(float(np.percentile(P[:, 1], 99.8)) + 0.05 * STUDS_PER_METER, 15.0 * STUDS_PER_METER)
        m = (P[:, 0] >= lo[0]) & (P[:, 0] <= hi[0]) & (P[:, 2] >= lo[1]) & (P[:, 2] <= hi[1]) & (P[:, 1] <= top)
        if m.sum() < 50:
            raise MapError("nothing is left of the world after cropping it to the room")
        self.P, self.lin, self.w = P[m], lin[m], w[m]
        self.lo, self.hi, self.top = lo, hi, max(top, 0.5)
        self.centroids: np.ndarray | None = None

    def footprint_area(self) -> float:
        return float(np.prod(self.hi - self.lo))

    def build(self, v: float) -> Build:
        S = STUDS_PER_METER
        P, lin, w = self.P, self.lin, self.w
        ox = math.floor(self.lo[0] / v) * v
        oz = math.floor(self.lo[1] / v) * v
        nx = int(math.ceil((self.hi[0] - ox) / v)) + 1
        nz = int(math.ceil((self.hi[1] - oz) / v)) + 1
        ny = int(math.ceil(self.top / v)) + 1
        ix = np.floor((P[:, 0] - ox) / v).astype(np.int64)
        iz = np.floor((P[:, 2] - oz) / v).astype(np.int64)
        band_top = min(0.08 * S, 0.5 * v)
        fl = P[:, 1] < band_top
        iy = np.floor(P[:, 1] / v).astype(np.int64)
        inb = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)

        # --- 3D grid (above the floor band), indexed [y, z, x] ---
        m3 = inb & ~fl & (iy >= 0) & (iy < ny)
        key = (iy[m3] * nz + iz[m3]) * nx + ix[m3]
        ww = w[m3] * np.where(iy[m3] == 0, v / max(v - band_top, 0.5 * v), 1.0)
        size = ny * nz * nx
        W = np.bincount(key, weights=ww, minlength=size)
        C = np.stack([np.bincount(key, weights=ww * lin[m3, c], minlength=size) for c in range(3)], axis=1)
        nzW = W[W > 0]
        thr = max(0.5, 0.1 * float(np.median(nzW))) if len(nzW) else 1.0
        occ = (W >= thr).reshape(ny, nz, nx)
        colour = (C / np.maximum(W, 1e-9)[:, None]).reshape(ny, nz, nx, 3)

        # --- floaters: drop small 26-connected components ---
        from scipy import ndimage  # scipy is in requirements-local.txt

        lab, ncomp = ndimage.label(occ, structure=np.ones((3, 3, 3), bool))
        if ncomp:
            counts = np.bincount(lab.ravel())
            total = int(occ.sum())
            min_size = max(4, int(0.002 * total))
            small = counts < min_size
            small[0] = False
            occ &= ~small[lab]

        # --- 2D floor grid, indexed [z, x] ---
        mf = inb & fl
        key2 = iz[mf] * nx + ix[mf]
        W2 = np.bincount(key2, weights=w[mf], minlength=nz * nx)
        C2 = np.stack([np.bincount(key2, weights=w[mf] * lin[mf, c], minlength=nz * nx) for c in range(3)], axis=1)
        nzW2 = W2[W2 > 0]
        thr2 = max(0.5, 0.1 * float(np.median(nzW2))) if len(nzW2) else 1.0
        focc = (W2 >= thr2).reshape(nz, nx)
        fcol = (C2 / np.maximum(W2, 1e-9)[:, None]).reshape(nz, nx, 3)

        # --- ceiling: the lowest high layer that covers most of the open floor ---
        mid_lo, mid_hi = int(1.0 * S / v), max(int(1.0 * S / v) + 1, int(math.ceil(1.6 * S / v)))
        mid = occ[mid_lo:mid_hi].any(axis=0) if mid_hi <= ny else np.zeros((nz, nx), bool)
        any_col = occ.any(axis=0) | focc
        open_cols = any_col & ~mid
        n_open = int(open_cols.sum())
        cut = ny
        if n_open >= 16:
            k0 = int(math.ceil(1.9 * S / v))
            win = max(2, int(math.ceil(0.3 * S / v)))
            for k in range(k0, ny):
                cov = int((occ[k:k + win].any(axis=0) & open_cols).sum()) / n_open
                if cov >= 0.35:
                    cut = k
                    break
        if cut < ny:
            occ[cut:] = False
        ceiling_layers = cut
        ys_occ = np.nonzero(occ.any(axis=(1, 2)))[0]
        top_layer = int(ys_occ.max()) + 1 if len(ys_occ) else 1
        ceiling_y = (ceiling_layers if cut < ny else top_layer) * v

        # --- colours and labels ---
        smooth = _smooth(colour, occ)
        flat_idx = np.nonzero(occ.ravel())[0]
        vox_lab = linear_to_oklab(smooth.reshape(-1, 3)[flat_idx])
        f_idx = np.nonzero(focc.ravel())[0]
        f_lab = linear_to_oklab(fcol.reshape(-1, 3)[f_idx])
        if self.centroids is None:
            pool = np.concatenate([vox_lab, f_lab]) if len(f_lab) else vox_lab
            if len(pool) == 0:
                raise MapError("the world turned into no blocks at all")
            self.centroids = kmeans(pool, self.colors)
        cent = self.centroids

        # --- imagined flag (capture camera visibility) ---
        cam = self.world.camera
        flags3 = np.zeros(len(flat_idx), np.int32)
        flags2 = np.zeros(len(f_idx), np.int32)
        if cam is not None:
            yy, zz, xx = np.unravel_index(flat_idx, occ.shape)
            c3 = np.stack([ox + (xx + 0.5) * v, (yy + 0.5) * v, oz + (zz + 0.5) * v], axis=1) / S
            fz, fx_ = np.unravel_index(f_idx, focc.shape)
            c2 = np.stack([ox + (fx_ + 0.5) * v, np.zeros(len(f_idx)), oz + (fz + 0.5) * v], axis=1) / S
            vis = _visibility(cam, np.concatenate([c3, c2]), 0.5 * v / S)
            flags3 = (~vis[: len(c3)]).astype(np.int32)
            flags2 = (~vis[len(c3):]).astype(np.int32)

        L = np.full(occ.size, -1, np.int32)
        L[flat_idx] = nearest(vox_lab, cent) * 2 + flags3 if len(flat_idx) else 0
        L = L.reshape(occ.shape)
        boxes = greedy_boxes_3d(L)

        # --- floor slab (follows the room outline) + tiles ---
        floor_mask = hull_mask(any_col, 1.0)
        kz = max(1, int(round(1.2 / v)))  # slab pieces on a ~1.2 stud grid: few parts, walls hide the steps
        coarse = block_any(floor_mask, kz)
        slab_rects = greedy_rects_2d(np.where(coarse, 0, -1).astype(np.int32))
        if len(f_idx):
            slab_lab = np.median(f_lab, axis=0)
            slab_lin = np.median(fcol.reshape(-1, 3)[f_idx], axis=0)
            slab_lin = lift_dark(slab_lin)
            slab_flag = int(np.mean(flags2) > 0.5) if cam is not None else 0
        else:
            low = smooth[0][occ[0]] if occ[0].any() else np.array([[0.16, 0.13, 0.11]])
            slab_lin = lift_dark(np.median(low, axis=0))
            slab_lab = linear_to_oklab(slab_lin[None])[0]
            slab_flag = 0
        tiles: list[tuple[int, int, int, int, int]] = []
        if len(f_idx):
            delta = np.linalg.norm(f_lab - slab_lab, axis=1)
            under = occ[0].ravel()[f_idx]
            want = (delta > FLOOR_TILE_DELTA) & ~under
            T = np.full(nz * nx, -1, np.int32)
            sel = f_idx[want]
            if len(sel):
                T[sel] = nearest(f_lab[want], cent) * 2 + flags2[want]
                T = T.reshape(nz, nx)
                tl, nt = ndimage.label(T >= 0)
                if nt:
                    cnt = np.bincount(tl.ravel())
                    tiny = cnt < 3
                    tiny[0] = False
                    T[tiny[tl]] = -1
                tiles = greedy_rects_2d(T)

        with_flag = cam is not None
        parts: list[list[float]] = []
        rgb = to_u8(slab_lin).tolist()
        bmin = [math.inf, -SLAB_STUDS, math.inf]
        bmax = [-math.inf, max(ceiling_y, TILE_STUDS), -math.inf]
        for cx0, cz0, cx1, cz1, _ in slab_rects:
            x0, x1 = ox + cx0 * kz * v, ox + min(cx1 * kz, nx) * v
            z0, z1 = oz + cz0 * kz * v, oz + min(cz1 * kz, nz) * v
            slab = [(x0 + x1) / 2, -SLAB_STUDS / 2, (z0 + z1) / 2, x1 - x0, SLAB_STUDS, z1 - z0, *rgb]
            if with_flag:
                slab.append(slab_flag)
            parts.append(slab)
            bmin[0], bmin[2] = min(bmin[0], x0), min(bmin[2], z0)
            bmax[0], bmax[2] = max(bmax[0], x1), max(bmax[2], z1)
        n_slab = len(parts)
        tile_parts = []
        Cf = fcol
        for x0, z0, x1, z1, lab_ in tiles:
            mean = Cf[z0:z1, x0:x1].reshape(-1, 3).mean(axis=0)
            p = [ox + (x0 + x1) / 2 * v, TILE_STUDS / 2, oz + (z0 + z1) / 2 * v, (x1 - x0) * v, TILE_STUDS, (z1 - z0) * v,
                 *to_u8(mean).tolist()]
            if with_flag:
                p.append(lab_ & 1)
            tile_parts.append(p)
        box_parts = []
        for x0, y0, z0, x1, y1, z1, lab_ in boxes:
            mean = colour[y0:y1, z0:z1, x0:x1].reshape(-1, 3).mean(axis=0)
            p = [ox + (x0 + x1) / 2 * v, (y0 + y1) / 2 * v, oz + (z0 + z1) / 2 * v,
                 (x1 - x0) * v, (y1 - y0) * v, (z1 - z0) * v, *to_u8(mean).tolist()]
            if with_flag:
                p.append(lab_ & 1)
            box_parts.append(p)
        parts.extend(tile_parts)
        parts.extend(box_parts)

        for p in box_parts:
            bmin[0], bmin[2] = min(bmin[0], p[0] - p[3] / 2), min(bmin[2], p[2] - p[5] / 2)
            bmax[0], bmax[2] = max(bmax[0], p[0] + p[3] / 2), max(bmax[2], p[2] + p[5] / 2)
        spawn, spawn_yaw = self._spawn(occ, focc, v, ox, oz, floor_mask)
        return Build(v, parts, n_slab, int(occ.sum()), len(boxes), len(tiles), ceiling_y,
                     {"min": bmin, "max": bmax}, spawn, spawn_yaw, with_flag, rgb)

    def _spawn(self, occ: np.ndarray, focc: np.ndarray, v: float, ox: float, oz: float,
               floor_mask: np.ndarray) -> tuple[list[float], float]:
        """A free floor point about 2 m from the headset spawn, preferably in front of it."""
        from scipy import ndimage

        S = STUDS_PER_METER
        ny, nz, nx = occ.shape
        y0, y1 = int(0.15 * S / v), max(int(0.15 * S / v) + 1, int(math.ceil(2.0 * S / v)))
        blocked = occ[y0:min(y1, ny)].any(axis=0)
        r = max(1, int(math.ceil(0.45 * S / v)))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        disk = (xx * xx + yy * yy) <= r * r
        blocked = ndimage.binary_dilation(blocked, structure=disk)
        # keep away from the floor's edge too, so nobody lands on the rim
        inside = ndimage.binary_erosion(floor_mask, structure=disk)
        free = inside & ~blocked
        hx, hz = self.world.spawn[0] * S, self.world.spawn[2] * S
        yaw = self.world.spawn_yaw
        fwd = np.array([-math.sin(yaw), -math.cos(yaw)])
        zi, xi = np.nonzero(free)
        if len(zi):
            px = ox + (xi + 0.5) * v
            pz = oz + (zi + 0.5) * v
            dx, dz = px - hx, pz - hz
            d = np.hypot(dx, dz) / S
            cosang = (dx * fwd[0] + dz * fwd[1]) / np.maximum(np.hypot(dx, dz), 1e-9)
            seen = focc[zi, xi]
            score = np.abs(d - 2.0) + 0.8 * (1 - cosang) / 2 + np.where(seen, 0.0, 0.4) + np.where(d < 1.0, 5.0, 0.0)
            j = int(np.argmin(score))
            sx, sz = float(px[j]), float(pz[j])
        else:
            sx, sz = hx + fwd[0] * 1.5 * S, hz + fwd[1] * 1.5 * S
        # face the headset spawn, so a Roblox player sees the person in the headset
        syaw = math.atan2(-(hx - sx), -(hz - sz)) if math.hypot(hx - sx, hz - sz) > 1e-6 else yaw
        return [sx, 0.0, sz], syaw


# --------------------------------------------------------------------------------------------------------------
# The floor plan (topdown.jpg)
# --------------------------------------------------------------------------------------------------------------

TOPDOWN_PPM = 100.0  # pixels per metre when the room is small enough
TOPDOWN_MAX_SIDE = 1024
TOPDOWN_CUT_M = 2.2  # nothing above this height (room frame) is drawn: a plan, not a picture of the ceiling
TOPDOWN_BG = (17, 17, 20)


def robust_bounds(world: World) -> dict:
    """The viewer's own box (web/src/viewer/analysis.ts robustBounds: 1 % to 99 % per axis of the opaque splats) in
    the scene frame (y includes floorY), so writing it into scene.json leaves the headset's walk area as it was."""
    base = world.pos[: world.n_base] if world.n_base else world.pos
    lo = np.quantile(base, 0.01, axis=0)
    hi = np.quantile(base, 0.99, axis=0)
    r4 = lambda v: round(float(v), 4) + 0.0  # noqa: E731
    return {"min": [r4(lo[0]), r4(lo[1] + world.floor_y), r4(lo[2])],
            "max": [r4(hi[0]), r4(hi[1] + world.floor_y), r4(hi[2])]}


def topdown_extent(world: World, bounds: dict) -> tuple[tuple[float, float], tuple[float, float]]:
    """The (x, z) box the plan covers: what stands between the floor and head height (1 % to 99 %, plus 0.5 m), the
    headset spawn always inside, never beyond world.bounds. Generated outdoor worlds reach 100 m out but people only
    walk near the spawn, so the plan is not mostly empty."""
    P = world.pos
    band = (P[:, 1] > 0.05) & (P[:, 1] < TOPDOWN_CUT_M)
    src = P[band] if band.sum() > 2000 else P
    lo = np.quantile(src[:, [0, 2]], 0.01, axis=0) - 0.5
    hi = np.quantile(src[:, [0, 2]], 0.99, axis=0) + 0.5
    sx, sz = world.spawn[0], world.spawn[2]
    lo = np.minimum(lo, [sx - 1.0, sz - 1.0])
    hi = np.maximum(hi, [sx + 1.0, sz + 1.0])
    bx0, bz0, bx1, bz1 = bounds["min"][0], bounds["min"][2], bounds["max"][0], bounds["max"][2]
    x0, z0 = max(float(lo[0]), bx0), max(float(lo[1]), bz0)
    x1, z1 = min(float(hi[0]), bx1), min(float(hi[1]), bz1)
    if x1 - x0 < 1.0 or z1 - z0 < 1.0:  # the bounds and the content disagree: trust the bounds
        return (bx0, bz0), (bx1, bz1)
    return (x0, z0), (x1, z1)


def render_topdown(world: World, xz_min: tuple[float, float], xz_max: tuple[float, float], path: Path | str,
                   ceiling_m: float | None = None) -> dict:
    """Orthographic view from above of everything below the cut, covering exactly xz_min..xz_max (room-frame metres).
    Each pixel takes the colour of the highest splat below the cut (a height map), small holes are filled from their
    neighbours, and height adds a little shade so furniture reads against the floor. Returns the topdown record."""
    from PIL import Image
    from scipy import ndimage

    x0, z0 = float(xz_min[0]), float(xz_min[1])
    x1, z1 = float(xz_max[0]), float(xz_max[1])
    dx, dz = max(x1 - x0, 1e-3), max(z1 - z0, 1e-3)
    ppm = min(TOPDOWN_PPM, TOPDOWN_MAX_SIDE / max(dx, dz))
    W = max(1, min(TOPDOWN_MAX_SIDE, int(round(dx * ppm))))
    H = max(1, min(TOPDOWN_MAX_SIDE, int(round(dz * ppm))))
    sx, sz = W / dx, H / dz

    cut = TOPDOWN_CUT_M
    if ceiling_m is not None and math.isfinite(ceiling_m) and ceiling_m > 0.6:
        cut = min(cut, ceiling_m - 0.15)
    P, lin = world.pos, world.lin
    m = (P[:, 1] < cut) & (P[:, 1] > -0.3) & (world.w > 0.2)
    u = np.floor((P[m, 0] - x0) * sx).astype(np.int64)
    v = np.floor((P[m, 2] - z0) * sz).astype(np.int64)
    inb = (u >= 0) & (u < W) & (v >= 0) & (v < H)
    u, v = u[inb], v[inb]
    y = P[m, 1][inb]
    col = lin[m][inb]
    rgb = np.zeros((H * W, 3), np.float64)
    height = np.full(H * W, np.nan)
    if len(u):
        pix = v * W + u
        order = np.lexsort((y, pix))  # by pixel, then height: the last of each run is the highest
        ps = pix[order]
        last = np.r_[ps[1:] != ps[:-1], True]
        top = order[last]
        rgb[pix[top]] = col[top]
        height[pix[top]] = y[top]
    have = ~np.isnan(height)
    hmap = np.where(have, height, 0.0).reshape(H, W)
    rgb = rgb.reshape(H, W, 3)
    have2 = have.reshape(H, W)
    # fill holes up to a few pixels from the nearest drawn pixel (sparse splats at 1 cm per pixel)
    if have2.any() and not have2.all():
        dist, (iy, ix) = ndimage.distance_transform_edt(~have2, return_indices=True)
        near = dist <= max(2.0, 0.06 * min(sx, sz))
        rgb = np.where(near[..., None], rgb[iy, ix], rgb)
        hmap = np.where(near, hmap[iy, ix], hmap)
        have2 = have2 | near
    # shade: higher is a little brighter, and a soft light from the top left marks edges (walls, table tops)
    hn = np.clip(hmap / max(cut, 0.5), 0.0, 1.0)
    gy, gx = np.gradient(hmap * min(sx, sz) / 100.0)
    relief = np.clip(1.0 - 0.35 * (gx + gy), 0.6, 1.25)
    shade = (0.78 + 0.32 * hn) * relief
    out = linear_to_srgb(np.clip(rgb * shade[..., None], 0.0, 1.0)) * 255.0
    img = np.where(have2[..., None], out, np.array(TOPDOWN_BG, np.float64))
    im = Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8), "RGB")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".jpg", dir=str(path.parent))
    os.close(fd)
    try:
        im.save(tmp, "JPEG", quality=86, optimize=True)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    r4 = lambda v: round(float(v), 4) + 0.0  # noqa: E731
    return {"file": path.name, "min": [r4(x0), r4(z0)], "max": [r4(x1), r4(z1)], "px": [W, H],
            "pxPerMeter": round(ppm, 2), "cutY": round(cut, 3), "coverage": round(float(have2.mean()), 3)}


# --------------------------------------------------------------------------------------------------------------
# Budget search and output
# --------------------------------------------------------------------------------------------------------------


def clamp_max_parts(n: Any) -> int:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return DEFAULT_MAX_PARTS
    return max(MIN_PARTS, min(MAX_PARTS_CAP, n))


def _trim(parts: list[list[float]], n_head: int, max_parts: int) -> list[list[float]]:
    """Hard cap: keep the floor slab pieces and the largest other parts."""
    if len(parts) <= max_parts:
        return parts
    head, rest = parts[:n_head], parts[n_head:]
    room = max(0, max_parts - len(head))
    vol = np.array([p[3] * p[4] * p[5] for p in rest])
    keep = np.sort(np.argsort(-vol, kind="stable")[:room])
    return (head + [rest[i] for i in keep])[:max_parts]


def build_map(scene_dir: Path | str, max_parts: int = DEFAULT_MAX_PARTS, colors: int = DEFAULT_COLORS, log=None,
              topdown: Path | str | None = None) -> dict:
    t0 = time.time()
    scene_dir = Path(scene_dir)
    scene = read_scene(scene_dir)
    max_parts = clamp_max_parts(max_parts)
    world = load_world(scene_dir, scene)
    t_load = time.time() - t0
    mapper = Mapper(world, colors=colors)
    target = 0.95 * max_parts
    v = quant_voxel(math.sqrt(mapper.footprint_area() * 2.4 / max(target, 1)))
    best: Build | None = None
    over: Build | None = None
    tried: dict[float, int] = {}
    for _ in range(10):
        b = mapper.build(v)
        n = len(b.parts)
        tried[v] = n
        if log:
            log(f"voxel {v:.2f} studs ({v / STUDS_PER_METER * 100:.1f} cm): {n} parts")
        if n <= max_parts:
            if best is None or n > len(best.parts):
                best = b
            if n >= 0.86 * max_parts or v <= MIN_VOXEL_STUDS:
                break
        elif over is None or n < len(over.parts):
            over = b
        feas = [s for s, c in tried.items() if c <= max_parts]
        infeas = [s for s, c in tried.items() if c > max_parts]
        if feas and infeas and min(feas) > max(infeas):
            # bisect between the finest size that fits and the coarsest that does not
            a, c = max(infeas), min(feas)
            nv = quant_voxel((a + c) / 2)
            if nv in tried:
                break
        else:
            # parts scale roughly with 1 / voxel^2
            ratio = math.sqrt(n / target) if n > 0 else 0.5
            nv = quant_voxel(v * min(1.6, max(0.62, ratio)))
            if nv == v:
                nv = quant_voxel(v + (0.02 if n > max_parts else -0.02))
            if nv in tried:
                break
        v = nv
    if best is None:
        best = over
        assert best is not None
    parts = _trim(best.parts, best.slab_parts, max_parts)
    # bottom-up: the floor slab first, then by bottom height, then by centre height
    n_head = min(best.slab_parts, len(parts))
    head, rest = parts[:n_head], parts[n_head:]
    rest.sort(key=lambda p: (round(p[1] - p[4] / 2, 4), p[1], p[0], p[2]))
    parts = head + rest

    def r2(x: float) -> float:
        return round(float(x), 2) + 0.0

    out_parts = []
    for p in parts:
        q = [r2(c) for c in p[:6]] + [int(c) for c in p[6:9]]
        if len(p) > 9:
            q.append(int(p[9]))
        out_parts.append(q)
    hs = [r2(world.spawn[0] * STUDS_PER_METER), 0.0, r2(world.spawn[2] * STUDS_PER_METER)]
    result = {
        "sceneId": str(scene.get("id") or scene_dir.name),
        "name": str(scene.get("name") or scene.get("id") or scene_dir.name)[:80],
        "studsPerMeter": STUDS_PER_METER,
        "spawn": [r2(c) for c in best.spawn],
        "spawnYaw": round(best.spawn_yaw, 4),
        "headsetSpawn": hs,
        "ceilingY": r2(best.ceiling_y),
        "bounds": {"min": [r2(c) for c in best.bounds["min"]], "max": [r2(c) for c in best.bounds["max"]]},
        "floorY": round(world.floor_y, 4),
        "voxel": best.voxel,
        "imagined": best.imagined,
        "parts": out_parts,
        "build": {
            "version": MAP_VERSION,
            "parts": len(out_parts),
            "maxParts": max_parts,
            "voxels": best.voxels,
            "boxes": best.boxes,
            "tiles": best.tiles,
            "slab": best.slab_parts,
            "splats": world.splats,
            "floorEstimated": world.floor_estimated,
            "tried": {f"{k:.2f}": c for k, c in sorted(tried.items())},
            "loadSeconds": round(t_load, 2),
            "seconds": round(time.time() - t0, 2),
        },
    }
    if topdown:
        wd = scene.get("world") or {}
        given = wd.get("bounds") if isinstance(wd.get("bounds"), dict) else None
        try:
            bounds = {"min": [float(c) for c in given["min"]][:3], "max": [float(c) for c in given["max"]][:3]} if given else None
            if bounds and (len(bounds["min"]) != 3 or len(bounds["max"]) != 3 or not all(map(math.isfinite, bounds["min"] + bounds["max"]))):
                bounds = None
        except (KeyError, TypeError, ValueError):
            bounds = None
        computed = bounds is None
        if computed:
            bounds = robust_bounds(world)
        tmin, tmax = topdown_extent(world, bounds)
        td = render_topdown(world, tmin, tmax, topdown, ceiling_m=best.ceiling_y / STUDS_PER_METER)
        result["bake"] = {
            "floorY": round(world.floor_y, 4),
            "floorEstimated": world.floor_estimated,
            "bounds": bounds,
            "boundsComputed": computed,
            "topdown": td,
        }
        result["build"]["seconds"] = round(time.time() - t0, 2)
        if log:
            log(f"topdown {td['px'][0]}x{td['px'][1]} px ({td['pxPerMeter']} px/m), coverage {td['coverage']:.0%}")
    return result


def write_map(path: Path | str, data: dict) -> int:
    """Compact JSON through a temp file + rename. Returns the byte size."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(data, separators=(",", ":")).encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return len(raw)


# --------------------------------------------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------------------------------------------


def render_preview(data: dict, path: Path | str, size: int = 640) -> None:
    """Top-down and isometric views of the parts side by side, plus a reality-check view (imagined parts tinted
    magenta) when the parts carry the imagined flag. Dark background, lime markers."""
    from PIL import Image, ImageDraw

    bg = (11, 11, 15)
    lime = (198, 255, 61)
    parts = data["parts"]
    if not parts:
        return
    arr = np.array([p[:9] for p in parts], np.float64)
    flags = np.array([p[9] if len(p) > 9 else 0 for p in parts], np.int64)
    n_slab = max(1, int(data.get("build", {}).get("slab", 1)))
    x0 = float((arr[:, 0] - arr[:, 3] / 2).min())
    x1 = float((arr[:, 0] + arr[:, 3] / 2).max())
    z0 = float((arr[:, 2] - arr[:, 5] / 2).min())
    z1 = float((arr[:, 2] + arr[:, 5] / 2).max())
    pad = 24
    panels = 3 if data.get("imagined") else 2
    img = Image.new("RGB", (size * panels + pad * (panels + 1), size + pad * 2 + 30), bg)
    dr = ImageDraw.Draw(img)
    top_y = pad + 30

    # --- top-down: image right = +X, image down = +Z (forward, -Z, is up); low parts first ---
    sc = (size - 1) / max(x1 - x0, z1 - z0, 1e-6)
    ymax = max(float((arr[:, 1] + arr[:, 4] / 2).max()), 1.0)
    for i in np.argsort(arr[:, 1] + arr[:, 4] / 2, kind="stable"):
        cx, cy, cz, sx, sy, sz, r, g, b = arr[i]
        shade = 0.55 + 0.45 * max(0.0, min(1.0, (cy + sy / 2) / ymax))
        col = tuple(int(min(255, c * shade)) for c in (r, g, b))
        a = (pad + (cx - sx / 2 - x0) * sc, top_y + (cz - sz / 2 - z0) * sc)
        bb = (pad + (cx + sx / 2 - x0) * sc, top_y + (cz + sz / 2 - z0) * sc)
        dr.rectangle([a, (max(a[0], bb[0] - 1), max(a[1], bb[1] - 1))], fill=col)

    def mark(p, colr, label):
        u = pad + (p[0] - x0) * sc
        w = top_y + (p[2] - z0) * sc
        dr.ellipse([u - 7, w - 7, u + 7, w + 7], outline=colr, width=3)
        dr.text((u + 10, w - 6), label, fill=colr)

    mark(data.get("headsetSpawn", [0, 0, 0]), lime, "headset")
    mark(data["spawn"], (255, 255, 255), "roblox spawn")

    # --- isometric from (+x, +y, +z), painter's order back to front ---
    c30, s30 = math.cos(math.radians(30)), math.sin(math.radians(30))
    lo = arr[:, :3] - arr[:, 3:6] / 2
    hi = arr[:, :3] + arr[:, 3:6] / 2
    us = np.concatenate([(lo[:, 0] - hi[:, 2]) * c30, (hi[:, 0] - lo[:, 2]) * c30])
    vs = np.concatenate([(lo[:, 0] + lo[:, 2]) * s30 - hi[:, 1], (hi[:, 0] + hi[:, 2]) * s30 - lo[:, 1]])
    u0, u1, v0, v1 = us.min(), us.max(), vs.min(), vs.max()
    isc = (size - 1) / max(u1 - u0, v1 - v0, 1e-6)
    depth = arr[:, 0] + arr[:, 2] + arr[:, 1]
    depth[:n_slab] = -np.inf  # the floor slab is behind everything
    order = np.argsort(depth, kind="stable")

    def iso(offx: int, tint: bool) -> None:
        def P(x, y, z):
            return (offx + ((x - z) * c30 - u0) * isc, top_y + ((x + z) * s30 - y - v0) * isc)

        for i in order:
            cx, cy, cz, sx, sy, sz, r, g, b = arr[i]
            if tint and flags[i]:
                r, g, b = 0.45 * r + 0.55 * 220, 0.45 * g + 0.55 * 60, 0.45 * b + 0.55 * 200
            xa, xb, ya, yb, za, zb = cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2
            dr.polygon([P(xb, ya, za), P(xb, yb, za), P(xb, yb, zb), P(xb, ya, zb)], fill=(int(r * .72), int(g * .72), int(b * .72)))
            dr.polygon([P(xa, ya, zb), P(xb, ya, zb), P(xb, yb, zb), P(xa, yb, zb)], fill=(int(r * .86), int(g * .86), int(b * .86)))
            dr.polygon([P(xa, yb, za), P(xb, yb, za), P(xb, yb, zb), P(xa, yb, zb)], fill=(int(r), int(g), int(b)))

    iso(pad * 2 + size, False)
    if panels == 3:
        iso(pad * 3 + size * 2, True)
        dr.text((pad * 3 + size * 2, top_y - 16), f"reality check: {int(flags.sum())} of {len(flags)} parts imagined",
                fill=(230, 120, 220))
    b = data.get("build", {})
    title = (f"{data.get('name', '')}  |  {len(parts)} parts  |  voxel {data.get('voxel', 0):.2f} studs  |  "
             f"{b.get('seconds', 0):.1f} s  |  ceiling {data.get('ceilingY', 0):.1f} studs")
    dr.text((pad, 10), title, fill=lime)
    img.save(str(path))


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scene splat world -> Roblox map (coloured boxes in studs)")
    ap.add_argument("--scene", required=True, help="scene directory (holds scene.json)")
    ap.add_argument("--out", required=True, help="output JSON path")
    ap.add_argument("--max-parts", type=int, default=DEFAULT_MAX_PARTS)
    ap.add_argument("--colors", type=int, default=DEFAULT_COLORS, help="palette size used to decide which voxels merge")
    ap.add_argument("--key", help="cache key the server stores in build.key")
    ap.add_argument("--preview", help="also write a PNG preview (top-down + isometric)")
    ap.add_argument("--topdown", help="also write the floor plan JPEG here and add \"bake\" to the output")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    log = None if args.quiet else (lambda m: print(m, file=sys.stderr, flush=True))
    try:
        data = build_map(args.scene, args.max_parts, colors=max(4, min(64, args.colors)), log=log, topdown=args.topdown)
        if args.key:
            data["build"]["key"] = args.key
        nbytes = write_map(args.out, data)
        if args.preview:
            render_preview(data, args.preview)
    except MapError as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        print(f"roblox_map: {e}", file=sys.stderr)
        return 2
    b = data["build"]
    print(json.dumps({"ok": True, "parts": b["parts"], "voxel": data["voxel"], "bytes": nbytes,
                      "seconds": b["seconds"], "out": str(args.out)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
