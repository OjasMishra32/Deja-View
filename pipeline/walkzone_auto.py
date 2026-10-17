#!/usr/bin/env python3
"""Automatic walk zones from view quality (team/shivin.md Update 19, job 1).

    python pipeline/walkzone_auto.py --scene data/scenes/kitchen
    python pipeline/walkzone_auto.py --scene data/scenes/old-house-kitchen --install

Today a world's walkable area is drawn by hand. This finds it from how good the world looks from each place:

1. Candidate spots on a 0.5 m grid over the world's bounds, at eye height (1.6 m). A spot needs floor under it and
   nothing solid within the walker's radius (the same 0.1 m occupancy columns the collider is made of).
2. From each spot, 8 views (every 45 degrees, 8 degrees down, 80 degrees wide). Each view is scored:
     coverage   share of the frame the splats cover (holes and the void behind the capture are uncovered)
     near       share of the frame closer than 0.45 m (floaters in your face)
     sharpness  variance of the Laplacian against a render from the nearest real camera pose (the best the splats
                ever look), capped at 1
   plus, per spot, the floater mass within 0.35 m of the eye. A view is good when coverage >= 0.9, near <= 0.03 and
   sharpness >= 0.35; a spot passes when at least 5 of its 8 views are good and its eye floater mass is small.
3. The passing spots become a mask (each covers its 0.5 m cell), the connected piece holding the best spot is kept,
   and it grows by the walker's radius (0.22 m, web/src/viewer/physics.ts) so the walker's centre reaches every good
   spot. Its outline, simplified, is the fence polygon.
4. The collider, in the format of `data/scenes/kitchen/collider.glb` (one mesh in the splat file's frame): a floor at
   y = 0, the fence (walls along the outline, 0 to 2.7 m), a roof at 2.7 m, and solid 0.1 m furniture columns
   (0 to 2.2 m) inside the zone, so `scripts/collider-clear-path.ts` still works on it.
5. The spawn: the passing spot with the best views and the most room around it, facing its best of 16 directions.

Writes `<scene>/walkzone/`: `walkzone.json` (fence loops, every spot and its scores, the spawn, the thresholds, and
the comparison with the hand-made collider when there is one), `collider.glb` and `topdown.png`. `--install` also
copies the collider to `<scene>/collider.glb` (the old one archived under `data/archive/colliders/`, as
collider-clear-path does) and sets `world.collider` and `world.spawn` in scene.json. GPU renders through gsplat; the
CPU point renderer works for small tests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

WALKER_RADIUS = 0.22  # web/src/viewer/physics.ts DEFAULT_BODY
EYE = 1.6
CELL = 0.1  # collider column grid (pipeline/recon/frame.py, scripts/collider-clear-path.ts)
MASK = 0.05  # walk-zone raster
FENCE_TOP = 2.7  # above 2.6 so collider-clear-path never reads the roof as a furniture top
COLUMN_TOP = 2.2
OUT_DIR = "walkzone"


@dataclass
class Thresholds:
    spacing: float = 0.5
    directions: int = 8
    pitch_deg: float = -8.0
    hfov_deg: float = 80.0
    width: int = 192
    height: int = 120
    coverage: float = 0.90
    near_m: float = 0.45
    near_share: float = 0.03
    sharpness: float = 0.35
    good_views: int = 5
    eye_radius: float = 0.35
    eye_floater_mass: float = 1.0
    floor_radius: float = 0.5
    floor_mass: float = 0.5
    min_column_mass: float = 1.5
    simplify: float = 0.04


# --- geometry helpers ------------------------------------------------------------------------------------------------

def view_c2w(x: float, z: float, yaw: float, eye: float = EYE, pitch_deg: float = -8.0) -> np.ndarray:
    """OpenGL camera-to-world at (x, eye, z) facing yaw (the viewer's convention: forward = (-sin, 0, -cos))."""
    cy, sy = math.cos(yaw), math.sin(yaw)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    p = math.radians(pitch_deg)
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    m = np.eye(4)
    m[:3, :3] = Ry @ Rx
    m[:3, 3] = [x, eye, z]
    return m


def intrinsics(t: Thresholds) -> tuple[float, float, float, float]:
    f = 0.5 * t.width / math.tan(math.radians(t.hfov_deg) / 2)
    return f, f, t.width / 2, t.height / 2


def occupancy(means: np.ndarray, opac: np.ndarray, scales: np.ndarray, lo: np.ndarray, hi: np.ndarray,
              min_mass: float = 1.5) -> tuple[np.ndarray, np.ndarray, tuple[float, float]]:
    """(solid columns, floor mass) on the 0.1 m grid over lo..hi (x, z), as pipeline/recon/frame.py builds columns:
    opacity summed between 0.15 and 2.2 m, closed by one cell, specks under 4 cells dropped. Floor mass is the opacity
    within 15 cm of y = 0. Returns (solid [H, W] bool, floor [H, W] float, (x0, z0))."""
    from scipy import ndimage

    x0, z0 = float(lo[0]), float(lo[1])
    W = max(1, int(math.ceil((hi[0] - x0) / CELL)))
    H = max(1, int(math.ceil((hi[1] - z0) / CELL)))
    u = np.floor((means[:, 0] - x0) / CELL).astype(np.int64)
    v = np.floor((means[:, 2] - z0) / CELL).astype(np.int64)
    inb = (u >= 0) & (u < W) & (v >= 0) & (v < H)
    small = np.max(scales, axis=1) < 1.0
    body = inb & small & (opac > 0.05) & (means[:, 1] > 0.15) & (means[:, 1] < COLUMN_TOP)
    mass = np.zeros((H, W))
    np.add.at(mass, (v[body], u[body]), opac[body].astype(np.float64))
    solid = ndimage.binary_closing(mass >= min_mass, structure=np.ones((3, 3), bool))
    lab, n = ndimage.label(solid, structure=np.ones((3, 3), bool))
    if n:
        sizes = ndimage.sum(solid, lab, range(1, n + 1))
        for k, sz in enumerate(sizes, start=1):
            if sz < 4:
                solid[lab == k] = False
    fl = inb & (np.abs(means[:, 1]) < 0.15) & (opac > 0.05)
    floor = np.zeros((H, W))
    np.add.at(floor, (v[fl], u[fl]), opac[fl].astype(np.float64))
    return solid, floor, (x0, z0)


# --- scoring ---------------------------------------------------------------------------------------------------------

def lap_var(rgb: np.ndarray, mask: np.ndarray | None = None) -> float | None:
    g = np.asarray(rgb, np.float64)
    if g.ndim == 3:
        g = g[..., :3] @ np.array([0.299, 0.587, 0.114])
    if g.max() <= 1.5:
        g = g * 255.0
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    if mask is not None:
        m = mask[1:-1, 1:-1] & mask[:-2, 1:-1] & mask[2:, 1:-1] & mask[1:-1, :-2] & mask[1:-1, 2:]
        if m.sum() < 32:
            return None
        lap = lap[m]
    return float(lap.var())


def score_view(rgb: np.ndarray, alpha: np.ndarray, depth: np.ndarray, ref_lap: float | None,
               t: Thresholds) -> dict:
    covered = alpha > 0.5
    coverage = float(covered.mean())
    near = float(((depth > 0) & (depth < t.near_m) & covered).mean())
    lv = lap_var(rgb, covered)
    sharp = None if lv is None or not ref_lap else min(1.0, lv / ref_lap)
    good = coverage >= t.coverage and near <= t.near_share and (sharp is None or sharp >= t.sharpness)
    value = coverage * max(0.0, 1.0 - near / 0.1) * (1.0 if sharp is None else sharp)
    return {"coverage": round(coverage, 4), "near": round(near, 4),
            "sharpness": None if sharp is None else round(sharp, 4), "good": bool(good), "value": round(value, 4)}


@dataclass
class Spot:
    x: float
    z: float
    views: list = field(default_factory=list)
    eye_floaters: float = 0.0
    passed: bool = False
    score: float = 0.0
    reason: str = ""

    def good_views(self) -> int:
        return sum(1 for v in self.views if v["good"])


RenderFn = Callable[[np.ndarray, float, float, float, float, int, int], tuple[np.ndarray, np.ndarray, np.ndarray]]


def splat_renderer(splats) -> RenderFn:
    import splat_io as sio

    def render(c2w, fx, fy, cx, cy, w, h):
        r = sio.render(splats, c2w, fx, fy, cx, cy, w, h)
        return np.asarray(r.rgb), np.asarray(r.alpha), np.asarray(r.depth)

    return tolerant(render)


def tolerant(render: RenderFn) -> RenderFn:
    """A view with no splats in it at all (looking out into the void) is an empty frame, not an error: the CPU point
    renderer raises on it."""
    def wrapped(c2w, fx, fy, cx, cy, w, h):
        try:
            return render(c2w, fx, fy, cx, cy, w, h)
        except ValueError:
            return np.zeros((h, w, 3), np.uint8), np.zeros((h, w), np.float32), np.zeros((h, w), np.float32)

    return wrapped


def reference_sharpness(render: RenderFn, cameras: list[dict], t: Thresholds) -> list[tuple[np.ndarray, float]]:
    """(position xz, Laplacian variance) of a render from each real camera pose, at the same size and field of view
    as the spot views: the sharpest the splats get, which is what a spot's views are measured against."""
    fx, fy, cx, cy = intrinsics(t)
    out = []
    for c in cameras:
        m = np.asarray(c["c2w"], np.float64)
        rgb, alpha, _ = render(m, fx, fy, cx, cy, t.width, t.height)
        lv = lap_var(rgb, alpha > 0.5)
        if lv:
            out.append((m[[0, 2], 3], lv))
    return out


def nearest_ref(refs: list[tuple[np.ndarray, float]], x: float, z: float) -> float | None:
    if not refs:
        return None
    d = [float(np.hypot(p[0] - x, p[1] - z)) for p, _ in refs]
    return refs[int(np.argmin(d))][1]


def candidate_spots(solid: np.ndarray, floor: np.ndarray, origin: tuple[float, float], lo, hi,
                    t: Thresholds) -> tuple[list[Spot], list[dict]]:
    """Spots on the grid with floor under them and nothing solid within the walker's radius. Returns (kept,
    rejected with reasons)."""
    from scipy import ndimage

    x0, z0 = origin
    free = ndimage.distance_transform_edt(~solid) * CELL  # metres to the nearest solid cell centre
    H, W = solid.shape
    r = int(math.ceil(t.floor_radius / CELL))
    kept, rejected = [], []
    for z in np.arange(lo[1] + t.spacing / 2, hi[1], t.spacing):
        for x in np.arange(lo[0] + t.spacing / 2, hi[0], t.spacing):
            u, v = int((x - x0) / CELL), int((z - z0) / CELL)
            if not (0 <= u < W and 0 <= v < H):
                continue
            if free[v, u] < WALKER_RADIUS + CELL / 2:
                rejected.append({"x": round(float(x), 3), "z": round(float(z), 3), "reason": "solid within reach"})
                continue
            fm = floor[max(0, v - r):v + r + 1, max(0, u - r):u + r + 1].sum()
            if fm < t.floor_mass:
                rejected.append({"x": round(float(x), 3), "z": round(float(z), 3), "reason": "no floor"})
                continue
            kept.append(Spot(round(float(x), 3), round(float(z), 3)))
    return kept, rejected


def eye_floater_mass(means: np.ndarray, opac: np.ndarray, x: float, z: float, t: Thresholds) -> float:
    d = np.linalg.norm(means - np.array([x, EYE, z]), axis=1)
    return float(opac[d < t.eye_radius].sum())


def score_spots(spots: list[Spot], render: RenderFn, refs, means, opac, t: Thresholds, log=print) -> None:
    fx, fy, cx, cy = intrinsics(t)
    for i, s in enumerate(spots):
        ref = nearest_ref(refs, s.x, s.z)
        s.eye_floaters = round(eye_floater_mass(means, opac, s.x, s.z, t), 3)
        s.views = []
        for k in range(t.directions):
            yaw = 2 * math.pi * k / t.directions
            rgb, alpha, depth = render(view_c2w(s.x, s.z, yaw, EYE, t.pitch_deg), fx, fy, cx, cy, t.width, t.height)
            s.views.append({"yaw": round(yaw, 4), **score_view(rgb, alpha, depth, ref, t)})
        g = s.good_views()
        s.score = round(float(np.mean([v["value"] for v in s.views])), 4)
        s.passed = g >= t.good_views and s.eye_floaters <= t.eye_floater_mass
        s.reason = "ok" if s.passed else (f"{g}/{t.directions} good views" if g < t.good_views
                                          else f"floaters at eye height ({s.eye_floaters})")
        if (i + 1) % 25 == 0:
            log(f"scored {i + 1}/{len(spots)} spots")


# --- zone, fence, collider -------------------------------------------------------------------------------------------

def zone_mask(spots: list[Spot], seed: Spot, lo, hi, t: Thresholds) -> tuple[np.ndarray, tuple[float, float]]:
    """The walkable mask on the 0.05 m raster: each passing spot covers its grid cell, the piece holding `seed` is
    kept, then grown by the walker's radius."""
    from scipy import ndimage

    pad = 1.0
    x0, z0 = float(lo[0]) - pad, float(lo[1]) - pad
    W = int(math.ceil((hi[0] - lo[0] + 2 * pad) / MASK))
    H = int(math.ceil((hi[1] - lo[1] + 2 * pad) / MASK))
    m = np.zeros((H, W), bool)
    half = t.spacing / 2 + 1e-6
    for s in spots:
        if not s.passed:
            continue
        u0, u1 = int(round((s.x - half - x0) / MASK)), int(round((s.x + half - x0) / MASK))
        v0, v1 = int(round((s.z - half - z0) / MASK)), int(round((s.z + half - z0) / MASK))
        m[max(0, v0):v1, max(0, u0):u1] = True
    lab, _ = ndimage.label(m)
    k = lab[int((seed.z - z0) / MASK), int((seed.x - x0) / MASK)]
    m = lab == k if k else m
    r = int(round(WALKER_RADIUS / MASK))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    m = ndimage.binary_dilation(m, structure=(xx * xx + yy * yy) <= r * r)
    return m, (x0, z0)


def trace_loops(mask: np.ndarray, origin: tuple[float, float], cell: float = MASK) -> list[np.ndarray]:
    """Outline loops of a binary raster as (x, z) polygons along cell edges. Outer loops and holes wind oppositely:
    an outer loop has a negative (x, z) shoelace area, a hole a positive one. Exact before simplification."""
    H, W = mask.shape
    p = np.pad(mask, 1)
    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(a, b):
        edges.setdefault(a, []).append(b)

    vs, us = np.nonzero(mask)
    for v, u in zip(vs, us):
        pv, pu = v + 1, u + 1
        # corners in grid units: (u, v) .. (u+1, v+1); walk each cell's open sides keeping the cell on one side
        if not p[pv - 1, pu]:
            add((u + 1, v), (u, v))
        if not p[pv + 1, pu]:
            add((u, v + 1), (u + 1, v + 1))
        if not p[pv, pu - 1]:
            add((u, v), (u, v + 1))
        if not p[pv, pu + 1]:
            add((u + 1, v + 1), (u + 1, v))
    loops = []
    while edges:
        start = next(iter(edges))
        loop = [start]
        cur = start
        prev_dir = None
        while True:
            nxts = edges[cur]
            if len(nxts) == 1:
                nxt = nxts.pop()
            else:  # a pinch point (two cells touching at a corner): turn consistently
                def turn(n):
                    d = (n[0] - cur[0], n[1] - cur[1])
                    if prev_dir is None:
                        return 0
                    return prev_dir[0] * d[1] - prev_dir[1] * d[0]
                nxt = max(nxts, key=turn)
                nxts.remove(nxt)
            if not nxts:
                del edges[cur]
            prev_dir = (nxt[0] - cur[0], nxt[1] - cur[1])
            cur = nxt
            if cur == start:
                break
            loop.append(cur)
        pts = np.array(loop, np.float64) * cell + np.array(origin)
        loops.append(pts)
    return loops


def simplify(poly: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker on a closed polygon."""
    if len(poly) < 4:
        return poly

    def rdp(pts):
        a, b = pts[0], pts[-1]
        ab = b - a
        n = np.linalg.norm(ab)
        if n < 1e-12:
            d = np.linalg.norm(pts - a, axis=1)
        else:
            d = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / n
        i = int(np.argmax(d))
        if d[i] > tol and 0 < i < len(pts) - 1:
            return np.vstack([rdp(pts[:i + 1])[:-1], rdp(pts[i:])])
        return np.vstack([a, b])

    far = int(np.argmax(np.linalg.norm(poly - poly[0], axis=1)))
    ring = np.vstack([poly, poly[:1]])
    first = rdp(ring[:far + 1])
    second = rdp(ring[far:])
    out = np.vstack([first[:-1], second[:-1]])
    return out


def polygon_area(poly: np.ndarray) -> float:
    x, z = poly[:, 0], poly[:, 1]
    return 0.5 * float(np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1)))


def collider_mesh(loops: list[np.ndarray], solid: np.ndarray, origin: tuple[float, float], zone: np.ndarray,
                  zone_origin: tuple[float, float], spawn: tuple[float, float] | None = None,
                  clear_radius: float = 0.45) -> tuple[np.ndarray, np.ndarray, dict]:
    """Floor, fence, roof and the furniture columns inside the zone, in the room frame (floor y = 0)."""
    verts: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    nv = [0]

    def quad(c):
        c = np.asarray(c, np.float64).reshape(-1, 4, 3)
        k = len(c)
        q = nv[0] + np.arange(k)[:, None] * 4
        verts.append(c.reshape(-1, 3))
        faces.append(np.concatenate([q + [0, 1, 2], q + [0, 2, 3]]))
        nv[0] += 4 * k

    allp = np.vstack(loops)
    (xa, za), (xb, zb) = allp.min(0) - 0.3, allp.max(0) + 0.3
    quad([[xa, 0, za], [xa, 0, zb], [xb, 0, zb], [xb, 0, za]])  # floor, facing up
    quad([[xa, FENCE_TOP, za], [xb, FENCE_TOP, za], [xb, FENCE_TOP, zb], [xa, FENCE_TOP, zb]])  # roof, facing down
    fence = 0
    for loop in loops:
        a = loop
        b = np.roll(loop, -1, axis=0)
        n = len(a)
        quad(np.stack([np.c_[a[:, 0], np.zeros(n), a[:, 1]], np.c_[b[:, 0], np.zeros(n), b[:, 1]],
                       np.c_[b[:, 0], np.full(n, FENCE_TOP), b[:, 1]], np.c_[a[:, 0], np.full(n, FENCE_TOP), a[:, 1]]],
                      axis=1))
        fence += 2 * n
    # furniture columns: solid cells whose centre lies in the (grown) zone, away from the spawn
    x0, z0 = origin
    zx0, zz0 = zone_origin
    vv, uu = np.nonzero(solid)
    cxs, czs = x0 + (uu + 0.5) * CELL, z0 + (vv + 0.5) * CELL
    zu = np.clip(((cxs - zx0) / MASK).astype(np.int64), 0, zone.shape[1] - 1)
    zv = np.clip(((czs - zz0) / MASK).astype(np.int64), 0, zone.shape[0] - 1)
    inside = zone[zv, zu]
    if spawn is not None:
        inside &= np.hypot(cxs - spawn[0], czs - spawn[1]) >= clear_radius
    keep = set(zip(vv[inside].tolist(), uu[inside].tolist()))
    cols = 0
    for v, u in keep:
        xa_, xb_ = x0 + u * CELL, x0 + (u + 1) * CELL
        za_, zb_ = z0 + v * CELL, z0 + (v + 1) * CELL
        T = COLUMN_TOP
        quad([[xa_, T, za_], [xa_, T, zb_], [xb_, T, zb_], [xb_, T, za_]])
        if (v, u - 1) not in keep:
            quad([[xa_, 0, za_], [xa_, 0, zb_], [xa_, T, zb_], [xa_, T, za_]])
        if (v, u + 1) not in keep:
            quad([[xb_, 0, zb_], [xb_, 0, za_], [xb_, T, za_], [xb_, T, zb_]])
        if (v - 1, u) not in keep:
            quad([[xb_, 0, za_], [xa_, 0, za_], [xa_, T, za_], [xb_, T, za_]])
        if (v + 1, u) not in keep:
            quad([[xa_, 0, zb_], [xb_, 0, zb_], [xb_, T, zb_], [xa_, T, zb_]])
        cols += 1
    V = np.concatenate(verts)
    F = np.concatenate(faces)
    return V, F, {"triangles": int(len(F)), "fenceTriangles": fence, "columns": cols}


def write_collider(path: Path, V: np.ndarray, F: np.ndarray) -> None:
    """The one-mesh GLB the viewer and collider-clear-path read: positions and uint32 indices, the layout of
    pipeline/recon/frame.py write_glb (not imported: that module expects pipeline/recon on the path)."""
    import struct

    verts = np.ascontiguousarray(V, np.float32)
    pos = verts.tobytes()
    idx = np.ascontiguousarray(F, np.uint32).reshape(-1).tobytes()
    pos_pad = pos + b"\0" * (-len(pos) % 4)
    binary = pos_pad + idx + b"\0" * (-len(idx) % 4)
    doc = {
        "asset": {"version": "2.0", "generator": "Deja View walkzone_auto"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "collider"}],
        "meshes": [{"name": "collider", "primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": int(len(verts)), "type": "VEC3",
             "min": [float(v) for v in verts.min(0)], "max": [float(v) for v in verts.max(0)]},
            {"bufferView": 1, "componentType": 5125, "count": int(np.asarray(F).size), "type": "SCALAR"},
        ],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
                        {"buffer": 0, "byteOffset": len(pos_pad), "byteLength": len(idx), "target": 34963}],
        "buffers": [{"byteLength": len(binary)}],
    }
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
                     + struct.pack("<II", len(binary), 0x004E4942) + binary)


def read_collider(path: Path) -> tuple[np.ndarray, np.ndarray]:
    import struct

    data = path.read_bytes()
    jl = struct.unpack_from("<I", data, 12)[0]
    g = json.loads(data[20:20 + jl])
    b0 = 20 + jl + 8
    Vs, Fs, base = [], [], 0
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16}
    for mesh in g["meshes"]:
        for p in mesh["primitives"]:
            def acc(i):
                a = g["accessors"][i]
                bv = g["bufferViews"][a["bufferView"]]
                k = 3 if a["type"] == "VEC3" else 1
                return np.frombuffer(data, dt[a["componentType"]], a["count"] * k,
                                     b0 + bv.get("byteOffset", 0) + a.get("byteOffset", 0)).reshape(-1, k)
            V = acc(p["attributes"]["POSITION"]).astype(np.float64)
            F = acc(p["indices"]).reshape(-1, 3).astype(np.int64)
            Vs.append(V)
            Fs.append(F + base)
            base += len(V)
    return np.concatenate(Vs), np.concatenate(Fs)


def walkable_from_collider(V: np.ndarray, F: np.ndarray, start: tuple[float, float], lo, hi,
                           cell: float = MASK) -> tuple[np.ndarray, tuple[float, float]]:
    """Where a walker can get to inside a collider: the raster cells crossed by any wall (a triangle between 0.1 and
    1.6 m that is not flat) are blocked, and a flood fill from `start` gives the reachable area. For comparing the
    automatic zone with a hand-made collider."""
    from scipy import ndimage

    x0, z0 = float(lo[0]) - 1, float(lo[1]) - 1
    W = int(math.ceil((hi[0] - lo[0] + 2) / cell))
    H = int(math.ceil((hi[1] - lo[1] + 2) / cell))
    blocked = np.zeros((H, W), bool)
    T = V[F]
    ys = T[:, :, 1]
    wall = (ys.max(1) - ys.min(1) > 1e-3) & (ys.max(1) > 0.1) & (ys.min(1) < 1.6)
    for tri in T[wall]:
        # sample the triangle's footprint densely enough to mark every cell it crosses
        a, b, c = tri[:, [0, 2]]
        n = int(max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)) / (cell / 2)) + 2
        w = np.linspace(0, 1, n)
        pts = np.concatenate([a + np.outer(w, b - a), a + np.outer(w, c - a), b + np.outer(w, c - b)])
        u = ((pts[:, 0] - x0) / cell).astype(np.int64)
        v = ((pts[:, 1] - z0) / cell).astype(np.int64)
        ok = (u >= 0) & (u < W) & (v >= 0) & (v < H)
        blocked[v[ok], u[ok]] = True
    flat_top = (ys.max(1) - ys.min(1) <= 1e-3) & (ys.min(1) > 0.1) & (ys.min(1) < 1.6)  # column tops
    for tri in T[flat_top]:
        a, b, c = tri[:, [0, 2]]
        lo_, hi_ = np.minimum(np.minimum(a, b), c), np.maximum(np.maximum(a, b), c)
        blocked[max(0, int((lo_[1] - z0) / cell)):int((hi_[1] - z0) / cell) + 1,
                max(0, int((lo_[0] - x0) / cell)):int((hi_[0] - x0) / cell) + 1] = True
    lab, _ = ndimage.label(~blocked)
    su, sv = int((start[0] - x0) / cell), int((start[1] - z0) / cell)
    k = lab[np.clip(sv, 0, H - 1), np.clip(su, 0, W - 1)]
    reach = (lab == k) if k else np.zeros_like(blocked)
    if reach[0, :].any() or reach[-1, :].any() or reach[:, 0].any() or reach[:, -1].any():
        return np.zeros_like(blocked), (x0, z0)  # not enclosed: no comparable zone
    return reach, (x0, z0)


def compare_masks(auto: np.ndarray, auto_o, hand: np.ndarray, hand_o, cell: float = MASK) -> dict:
    """IoU and coverage between two rasters with possibly different origins."""
    pa = np.argwhere(auto) * cell + np.array([auto_o[1], auto_o[0]])
    ph = np.argwhere(hand) * cell + np.array([hand_o[1], hand_o[0]])
    if len(pa) == 0 or len(ph) == 0:
        return {"handArea": round(len(ph) * cell * cell, 3), "autoArea": round(len(pa) * cell * cell, 3), "iou": None,
                "handCovered": None}
    ka = set(map(tuple, np.round(pa / cell).astype(np.int64).tolist()))
    kh = set(map(tuple, np.round(ph / cell).astype(np.int64).tolist()))
    inter = len(ka & kh)
    return {"handArea": round(len(kh) * cell * cell, 3), "autoArea": round(len(ka) * cell * cell, 3),
            "iou": round(inter / len(ka | kh), 4), "handCovered": round(inter / len(kh), 4),
            "autoInsideHand": round(inter / len(ka), 4)}


def pick_spawn(spots: list[Spot], zone: np.ndarray, zone_o) -> Spot | None:
    """The passing spot with the best views and the most room around it (distance to the zone's edge, up to 1 m)."""
    from scipy import ndimage

    ok = [s for s in spots if s.passed]
    if not ok:
        return None
    room = ndimage.distance_transform_edt(zone) * MASK

    def clearance(s):
        u = int((s.x - zone_o[0]) / MASK)
        v = int((s.z - zone_o[1]) / MASK)
        return float(room[np.clip(v, 0, room.shape[0] - 1), np.clip(u, 0, room.shape[1] - 1)])

    return max(ok, key=lambda s: s.score + 0.25 * min(1.0, clearance(s)))


def best_yaw(spot: Spot, render: RenderFn, refs, t: Thresholds, steps: int = 16) -> tuple[float, dict]:
    fx, fy, cx, cy = intrinsics(t)
    ref = nearest_ref(refs, spot.x, spot.z)
    best = (0.0, {"value": -1})
    for k in range(steps):
        yaw = 2 * math.pi * k / steps
        rgb, alpha, depth = render(view_c2w(spot.x, spot.z, yaw, EYE, t.pitch_deg), fx, fy, cx, cy, t.width, t.height)
        sc = score_view(rgb, alpha, depth, ref, t)
        # prefer depth in front: a view of a wall 0.6 m away is technically complete but a poor first look
        valid = depth[alpha > 0.5]
        sc["value"] = round(sc["value"] * min(1.0, float(np.median(valid)) / 2.0 if valid.size else 0.0), 4)
        if sc["value"] > best[1]["value"]:
            best = (yaw, sc)
    return best


# --- frames ----------------------------------------------------------------------------------------------------------

def room_to_file(P: np.ndarray, world: dict) -> np.ndarray:
    """Room frame (load_scene: transform applied, floor at y = 0) -> the splat file's frame the collider lives in."""
    import splat_io as sio

    tr = world.get("transform") or {}
    R, t, s = sio.transform_parts({"quaternion": tr.get("quaternion") or [0, 0, 0, 1],
                                   "position": tr.get("position") or [0, 0, 0], "scale": tr.get("scale") or 1.0})
    floor = float(world.get("floorY") or 0.0)
    viewer = np.asarray(P, np.float64) + np.array([0.0, floor, 0.0])
    return ((viewer - t) @ R) / s


def room_cameras(scene_dir: Path, world: dict) -> list[dict]:
    """cameras.json (viewer frame) as room-frame c2w matrices, when the world has one."""
    p = scene_dir / "cameras.json"
    if not p.exists():
        return []
    import splat_io as sio

    floor = float(world.get("floorY") or 0.0)
    out = []
    for c in json.loads(p.read_text()).get("cameras", []):
        if "position" not in c or "quaternion" not in c:
            continue
        m = np.eye(4)
        m[:3, :3] = sio.quat_xyzw_to_matrix(c["quaternion"])
        m[:3, 3] = np.asarray(c["position"], np.float64) - [0, floor, 0]
        out.append({"name": c.get("name") or c.get("file"), "c2w": m})
    return out


# --- the run ---------------------------------------------------------------------------------------------------------

def search_area(means: np.ndarray, opac: np.ndarray, world: dict, cap: float = 30.0) -> tuple[np.ndarray, np.ndarray]:
    """(lo, hi) in x, z: where the splats are (2-98 percentile of the opaque ones near floor-to-head height), joined
    with the world's bounds. Not the bounds alone: on a world whose bounds are a hand-drawn box (the old house
    kitchen's camera box) the automatic zone must be free to come out bigger or smaller than it."""
    keep = (opac > 0.3) & (means[:, 1] > -0.2) & (means[:, 1] < 2.5)
    pts = means[keep][:, [0, 2]] if keep.sum() > 100 else means[:, [0, 2]]
    lo, hi = np.percentile(pts, 2, axis=0), np.percentile(pts, 98, axis=0)
    b = world.get("bounds") or {}
    if b.get("min") and b.get("max"):
        lo = np.minimum(lo, [b["min"][0], b["min"][2]])
        hi = np.maximum(hi, [b["max"][0], b["max"][2]])
    centre = (lo + hi) / 2
    half = np.minimum((hi - lo) / 2, cap / 2)  # a stray far splat must not make the grid enormous
    return centre - half, centre + half


def bounds_box_mask(world: dict, lo, hi) -> tuple[np.ndarray, tuple[float, float]] | None:
    """The world's bounds as a walk mask: the hand-made limit of worlds that have no collider (a camera box)."""
    b = world.get("bounds") or {}
    if not (b.get("min") and b.get("max")):
        return None
    x0, z0 = float(lo[0]) - 1, float(lo[1]) - 1
    W_ = int(math.ceil((hi[0] - lo[0] + 2) / MASK))
    H_ = int(math.ceil((hi[1] - lo[1] + 2) / MASK))
    m = np.zeros((H_, W_), bool)
    u0, u1 = int((b["min"][0] - x0) / MASK), int((b["max"][0] - x0) / MASK)
    v0, v1 = int((b["min"][2] - z0) / MASK), int((b["max"][2] - z0) / MASK)
    m[max(0, v0):v1, max(0, u0):u1] = True
    return m, (x0, z0)


def build(splats, world: dict, cameras: list[dict], out: Path, t: Thresholds | None = None,
          render: RenderFn | None = None, hand_collider: Path | None = None, hand_spawn=None, log=print) -> dict:
    """Everything after loading: spots, scores, zone, fence, collider, spawn. `splats` in the room frame."""
    t = t or Thresholds()
    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    render = tolerant(render) if render else splat_renderer(splats)
    means = np.asarray(splats.means, np.float64)
    opac = np.asarray(splats.opacities, np.float64)
    lo, hi = search_area(means, opac, world)
    solid, floor, origin = occupancy(means, opac, np.asarray(splats.scales), lo - 1, hi + 1, t.min_column_mass)
    spots, rejected = candidate_spots(solid, floor, origin, lo, hi, t)
    log(f"{len(spots)} candidate spots ({len(rejected)} rejected: no floor or solid within reach)")
    refs = reference_sharpness(render, cameras, t)
    score_spots(spots, render, refs, means, opac, t, log)
    passed = [s for s in spots if s.passed]
    log(f"{len(passed)}/{len(spots)} spots pass")
    if not passed:
        raise SystemExit("no spot passes; the thresholds or the world need a look (see walkzone.json)")
    seed = max(passed, key=lambda s: s.score)
    zone, zone_o = zone_mask(spots, seed, lo, hi, t)
    spawn_spot = pick_spawn([s for s in spots if s.passed], zone, zone_o)
    yaw, yaw_view = best_yaw(spawn_spot, render, refs, t)
    loops = [simplify(l, t.simplify) for l in trace_loops(zone, zone_o)]
    loops = [l for l in loops if abs(polygon_area(l)) > 0.01]
    V, F, cinfo = collider_mesh(loops, solid, origin, zone, zone_o, (spawn_spot.x, spawn_spot.z))
    write_collider(out / "collider.glb", room_to_file(V, world), F)
    area = float(zone.sum()) * MASK * MASK
    floor_y = float(world.get("floorY") or 0.0)
    doc = {
        "version": 1,
        "frame": "room (y up, metres, floor y = 0); spawn is also given in the viewer frame (floorY added); "
                 "collider.glb is in the splat file's frame like every collider",
        "thresholds": asdict(t),
        "walkerRadius": WALKER_RADIUS,
        "areaM2": round(area, 3),
        "fence": [[[round(float(x), 3), round(float(z), 3)] for x, z in l] for l in loops],
        "spawn": {"room": [spawn_spot.x, 0.0, spawn_spot.z], "position": [spawn_spot.x, floor_y, spawn_spot.z],
                  "yaw": round(yaw, 4), "view": yaw_view},
        "collider": {"file": "collider.glb", **cinfo},
        "spots": [{"x": s.x, "z": s.z, "passed": s.passed, "score": s.score, "goodViews": s.good_views(),
                   "eyeFloaters": s.eye_floaters, "reason": s.reason, "views": s.views} for s in spots],
        "rejected": rejected,
        "references": len(refs),
        "seconds": round(time.time() - t0, 1),
    }
    if hand_collider is not None and hand_collider.exists():
        Vh, Fh = read_collider(hand_collider)
        tr = world.get("transform") or {}
        import splat_io as sio

        R, tt, sc = sio.transform_parts({"quaternion": tr.get("quaternion") or [0, 0, 0, 1],
                                         "position": tr.get("position") or [0, 0, 0], "scale": tr.get("scale") or 1.0})
        Vh_room = (Vh * sc) @ R.T + tt - [0, floor_y, 0]  # the collider lives in the splat file's frame
        start = hand_spawn if hand_spawn is not None else (spawn_spot.x, spawn_spot.z)
        hand, hand_o = walkable_from_collider(Vh_room, Fh, start, lo, hi)
        doc["handMade"] = {"source": "collider.glb", **compare_masks(zone, zone_o, hand, hand_o)}
    else:
        box = bounds_box_mask(world, lo, hi)
        if box is not None:
            doc["handMade"] = {"source": "world.bounds (camera box)", **compare_masks(zone, zone_o, *box)}
    if "handMade" in doc:
        log(f"vs the hand-made limit: {doc['handMade']}")
    (out / "walkzone.json").write_text(json.dumps(doc, indent=1))
    topdown(out / "topdown.png", spots, rejected, loops, spawn_spot, yaw, lo, hi)
    log(f"walk zone {area:.1f} m2, {len(loops)} fence loop(s), spawn ({spawn_spot.x}, {spawn_spot.z}) yaw "
        f"{math.degrees(yaw):.0f} deg, collider {cinfo['triangles']} triangles")
    return doc


def topdown(path: Path, spots, rejected, loops, spawn, yaw, lo, hi, px: int = 60) -> None:
    """A plan view: spots coloured by score (red fails, green passes), rejected spots grey, the fence, the spawn."""
    from PIL import Image, ImageDraw

    pad = 1.0
    W, H = int((hi[0] - lo[0] + 2 * pad) * px), int((hi[1] - lo[1] + 2 * pad) * px)
    im = Image.new("RGB", (max(W, 50), max(H, 50)), (24, 24, 28))
    d = ImageDraw.Draw(im)

    def P(x, z):
        return ((x - lo[0] + pad) * px, (z - lo[1] + pad) * px)

    for r in rejected:
        x, y = P(r["x"], r["z"])
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(90, 90, 90))
    for s in spots:
        x, y = P(s.x, s.z)
        c = (60, 200, 90) if s.passed else (210, 70, 60)
        r = 3 + 4 * s.score
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)
    for l in loops:
        d.line([P(x, z) for x, z in l] + [P(*l[0])], fill=(240, 240, 120), width=2)
    sx, sy = P(spawn.x, spawn.z)
    d.ellipse([sx - 6, sy - 6, sx + 6, sy + 6], outline=(255, 255, 255), width=2)
    d.line([sx, sy, sx - 20 * math.sin(yaw), sy - 20 * math.cos(yaw)], fill=(255, 255, 255), width=3)
    im.save(path)


def install(scene_dir: Path, out: Path, doc: dict) -> dict:
    """Make it the world's collider and spawn. The old collider is archived first (as collider-clear-path does)."""
    sj = scene_dir / "scene.json"
    scene = json.loads(sj.read_text())
    world = scene.setdefault("world", {})
    old = scene_dir / "collider.glb"
    archived = None
    if old.exists():
        sha = hashlib.sha1(old.read_bytes()).hexdigest()[:10]
        arch = scene_dir.parent.parent / "archive" / "colliders"
        arch.mkdir(parents=True, exist_ok=True)
        archived = arch / f"{scene_dir.name}-{sha}.glb"
        shutil.copyfile(old, archived)
    shutil.copyfile(out / "collider.glb", old)
    world["collider"] = "collider.glb"
    world["spawn"] = {"position": doc["spawn"]["position"], "yaw": doc["spawn"]["yaw"]}
    world["walkZone"] = {"file": f"{OUT_DIR}/walkzone.json", "areaM2": doc["areaM2"], "auto": True}
    sj.write_text(json.dumps(scene, indent=2))
    return {"collider": str(old), "archived": str(archived) if archived else None}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out", default=None, help=f"default <scene>/{OUT_DIR}")
    ap.add_argument("--spacing", type=float, default=0.5)
    ap.add_argument("--size", default="192x120", help="view render size")
    ap.add_argument("--install", action="store_true", help="make it the world's collider and spawn (archives the old)")
    a = ap.parse_args(argv)
    from objects import scene as obj_scene

    scene_dir = Path(a.scene)
    splats, scene = obj_scene.load_scene(scene_dir)
    world = scene.get("world") or {}
    w, h = (int(v) for v in a.size.lower().split("x"))
    t = Thresholds(spacing=a.spacing, width=w, height=h)
    out = Path(a.out) if a.out else scene_dir / OUT_DIR
    sp = world.get("spawn", {}).get("position")
    doc = build(splats, world, room_cameras(scene_dir, world), out, t, hand_collider=scene_dir / "collider.glb",
                hand_spawn=(sp[0], sp[2]) if sp else None)
    if a.install:
        print(json.dumps(install(scene_dir, out, doc)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
