#!/usr/bin/env python3
"""Turns a scene's splat world into a textured Roblox model: one .glb of chunked, textured meshes in studs.

  python pipeline/roblox_mesh.py --scene data/scenes/<id> [--out DIR] [--triangles N] [--texture PX] [--key K]

Writes (into the scene directory unless --out):

  roblox.glb          one node + mesh per chunk, named room_00, room_01, ... (ceiling_00, ... for an indoor lid,
                      floor_00, ... for the fill under holes in the floor), each with one textured primitive
                      (baseColor JPEG, --texture px square, 1024 by default; 512 for the floor fill).
                      Positions are studs in the room frame: metres_room x studsPerMeter, axis for axis (Y up, -Z
                      forward, floor at y = 0), the frame of the voxel map (pipeline/roblox_map.py, contracts 3.2,
                      6.2). Each node's translation is its chunk's centre, so an imported MeshPart sits at `center`.
  roblox-model.json   the sidecar: units, studsPerMeter, chunk names, kinds, triangle counts, centres and sizes,
                      bounds, spawn (studs; the voxel map's when it exists), timings.

How:
 1. Load the world the way the voxel map does (roblox_map.load_world and Mapper): same floor, crop box and headset
    spawn, so the mesh and the boxes line up exactly.
 2. Cameras: cube maps (six 90 degree faces) at standing height on a lattice of free floor points around the headset
    spawn (nearest first) and overview cameras from the corners of the standing area. (Lower side views were tried:
    seen from knee height, edges of furniture smear into sheets across the room.) Each is rendered (RGB + depth) with gsplat on the GPU (the CPU point renderer
    without one). Mostly empty views (sky) and positions inside things are dropped; pixels with little alpha or on
    a depth edge (where expected depth blends near and far) give no depth.
 3. TSDF fusion in sparse 8^3 voxel blocks around what the cameras saw. The voxel (2 to 5 cm) follows the seen
    surface area; truncation is 3 voxels. "Seen through" counts less than "seen on", so a one-sided wall of a
    generated world survives views from behind it while floaters still get carved.
 4. Marching cubes (scikit-image) in slabs, only in cells whose 8 corners were each seen at least twice.
 5. Clean-up: weld, crop to the room box, split off an indoor lid (its own chunks, so the game can leave it out like
    the voxel map does), drop the underside of an outdoor splat sky and of the ground, small and airborne pieces,
    close small holes, and lay floor tiles a little under the floor wherever the mesh's own floor leaves the ground
    open (and lower under that floor where it lies clear above them, so tears in it show ground, not the void).
 6. Quadric decimation (fast-simplification) of room and lid together to the triangle budget (default 200,000).
    Then faces left facing into the solid (folds, a thin sheet collapsed onto its other side) are turned back by the
    field, pieces the decimation cut loose in the air go, and a vertex shared by opposite sides gets a copy per side
    so their normals do not cancel.
 7. Chunks: k-d split on x/z until each chunk has at most 18,000 triangles (Roblox allows 20,000 per mesh); half that
    for the floor fill, which gets a 1 cm underside after the bake (a mesh with no thickness has no size in Roblox).
 8. UV atlas per chunk (xatlas). Each texel takes the colour of the views that see it best (depth-tested, weighted
    by the resolution they give it, (f cos / distance)^2, best views only); texels no view sees take the fused
    voxel colour, and the floor fill the floor's colour painted in from around it.
 9. GLB and sidecar, each through a temp file + rename.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import struct
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import roblox_map as rmap  # noqa: E402
import splat_io as sio  # noqa: E402

STUDS_PER_METER = rmap.STUDS_PER_METER
MODEL_VERSION = 1
GLB_FILE = "roblox.glb"
SIDECAR_FILE = "roblox-model.json"

ROBLOX_MAX_TRIANGLES = 20_000  # per mesh (Creator Hub, mesh specifications)
CHUNK_TRIANGLES = 18_000  # what a chunk may hold: a margin under the Roblox limit
ROOM_CHUNKS = 16  # the room is cut into at least this many chunks, one texture each (about 16 MB of .glb at most)
DEFAULT_TRIANGLES = 200_000
MIN_TRIANGLES = 20_000
MAX_TRIANGLES = 400_000
MAX_GLB_BYTES = 19_500_000  # Open Cloud takes one asset of up to 20 MB; the JPEGs give way first
DEFAULT_TEXTURE = 1024  # every device keeps 1024 px; 4K only streams in where the engine decides it is worth it

EYE_M = 1.6
FACE_RES = 768  # cube face size in pixels (90 degrees: about 1.2 cm per pixel at 3 m)
MAX_POSITIONS = 40
MIN_STEP_M = 0.8
MAX_RADIUS_M = 12.0  # cameras stay this close to the headset spawn (generated worlds fall apart further out)
OUTDOOR_OVERVIEW_M = 3.0  # generated worlds only hold together near the height they were generated from
MAX_DEPTH_M = 32.0
MIN_ALPHA = 0.5
EDGE_REL = 0.2  # a pixel is on a depth edge when inverse depth bends by more than this fraction of itself
EMPTY_VIEW = 0.2  # a view with less than this fraction of covered pixels is dropped (sky)
INSIDE_DEPTH_M = 0.35  # a position whose side views are mostly closer than this is inside something

VOXEL_MIN_M, VOXEL_MAX_M = 0.02, 0.05
SURFACE_CELLS = 4_000_000  # the voxel is chosen so the seen surface covers about this many voxel faces
MAX_VOXELS_GPU = 160_000_000
MAX_VOXELS_CPU = 16_000_000
BLOCK = 8
TRUNC_VOXELS = 3.0
FREE_WEIGHT = 0.3  # how much "seen through" counts against a surface, relative to "seen on" (views from behind a
#                    one-sided wall of a generated world must not erase it)
MIN_OBS = 2
SLAB_BLOCKS = 8
MIN_COMPONENT_M2 = 0.2
AIRBORNE_MIN_Y = 2.0  # a component entirely above this height ...
AIRBORNE_MAX_M2 = 8.0  # ... and smaller than this (outdoors: AIRBORNE_SKY_M2) is sky or a floater, not the room
AIRBORNE_SKY_M2 = 150.0  # outdoors the sky shell breaks into big pieces (and canopies lose their trunks)
HOLE_EDGES = 48  # holes in the fused surface whose rim has at most this many edges are closed
FLOOR_CELL_M = 0.25
FLOOR_FILL_Y = -0.05  # under the floor, so the real floor wins wherever both exist
FLOOR_BACKSTOP_Y = -0.2  # under a bumpy floor the fill runs lower: a tear in that floor shows ground, not the void
FLOOR_CLEAR_M = 0.04  # ... wherever the mesh's own floor stays at least this far above the fill
UNDERSIDE_Y = 0.25  # faces this low that face down are the far side of the ground (it fuses as a thin slab)
FLOOR_UNDERSIDE_M = 0.01  # the fill is a thin slab, not a flat sheet: Roblox wants every mesh to have some volume
SKY_MIN_Y = 4.0  # outdoors, surfaces this high that face down are the splat sky's underside, not the room
FLOOR_TEXTURE = 512
CEILING_SHARE = 0.3  # down-facing area at one height above 1.9 m, as a share of the floor, that makes a lid


class MeshError(Exception):
    """A problem with the input that a person can act on (no world, nothing to mesh)."""


def _log_noop(_msg: str) -> None:
    pass


# --------------------------------------------------------------------------------------------------------------
# The room (same frame, floor, crop and spawn as the voxel map)
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Room:
    scene: dict
    scene_dir: Path
    splats: sio.Splats  # file frame
    transform: dict
    scale: float  # file units -> metres
    floor_y: float  # scene-frame floor height subtracted to get the room frame
    lo: np.ndarray  # room box, room frame metres (x, y, z)
    hi: np.ndarray
    spawn: tuple[float, float, float]  # headset spawn, room frame metres
    spawn_yaw: float
    pos: np.ndarray  # stamped splat centres (room frame) from the voxel map's loader: free floor, floor colours
    w: np.ndarray
    lin: np.ndarray  # their linear RGB
    voxel_map: dict  # spawn, spawnYaw, ceilingY, headsetSpawn in studs (from roblox-map.json or one voxel build)


def _voxel_map_info(scene_dir: Path, world: rmap.World, mapper: rmap.Mapper) -> dict:
    """The voxel map's spawn and ceiling: from the cached default map when it was built for this floor, else from one
    build at the default budget's first voxel size (a few seconds)."""
    try:
        m = json.loads((scene_dir / "roblox-map.json").read_text())
        if abs(float(m.get("floorY", math.nan)) - world.floor_y) < 1e-3 and isinstance(m.get("spawn"), list):
            return {"spawn": m["spawn"], "spawnYaw": float(m.get("spawnYaw", 0.0)), "ceilingY": m.get("ceilingY"),
                    "headsetSpawn": m.get("headsetSpawn"), "source": "roblox-map.json"}
    except (OSError, ValueError, TypeError):
        pass
    v = rmap.quant_voxel(math.sqrt(mapper.footprint_area() * 2.4 / (0.95 * rmap.DEFAULT_MAX_PARTS)))
    b = mapper.build(v)
    S = STUDS_PER_METER
    return {"spawn": [round(float(c), 2) for c in b.spawn], "spawnYaw": round(b.spawn_yaw, 4),
            "ceilingY": round(b.ceiling_y, 2),
            "headsetSpawn": [round(world.spawn[0] * S, 2), 0.0, round(world.spawn[2] * S, 2)], "source": "voxel build"}


def load_room(scene_dir: Path | str, log: Callable[[str], None] = _log_noop) -> Room:
    scene_dir = Path(scene_dir)
    scene = rmap.read_scene(scene_dir)
    world = rmap.load_world(scene_dir, scene)
    mapper = rmap.Mapper(world)
    S = STUDS_PER_METER
    lo = np.array([mapper.lo[0] / S, -0.3, mapper.lo[1] / S])
    hi = np.array([mapper.hi[0] / S, mapper.top / S, mapper.hi[1] / S])
    path = rmap._world_file(scene_dir, scene["world"])
    s = sio.read_splats(path)
    tr = scene["world"].get("transform") or {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}
    _, _, sc = sio.transform_parts(tr)
    info = _voxel_map_info(scene_dir, world, mapper)
    log(f"room box x {lo[0]:.1f}..{hi[0]:.1f}  y ..{hi[1]:.1f}  z {lo[2]:.1f}..{hi[2]:.1f} m, floor {world.floor_y:.3f}, "
        f"{len(s)} splats, spawn from {info['source']}")
    return Room(scene, scene_dir, s, tr, abs(sc) or 1.0, world.floor_y, lo, hi, world.spawn, world.spawn_yaw,
                world.pos, world.w, world.lin, info)


# --------------------------------------------------------------------------------------------------------------
# Cameras
# --------------------------------------------------------------------------------------------------------------


@dataclass
class View:
    c2w: np.ndarray  # 4x4 OpenGL camera-to-world (looks down -Z, +Y up), room frame metres
    f: float  # focal length in pixels (square pixels, principal point at the centre)
    size: int
    kind: str  # "cube" or "overview"
    position: int = -1  # index of the standing position (cube faces)


CUBE_FACES = [(0.0, 0.0), (90.0, 0.0), (180.0, 0.0), (270.0, 0.0), (0.0, 90.0), (0.0, -90.0)]  # (yaw, pitch) degrees


def look_at(eye: np.ndarray, target: np.ndarray) -> np.ndarray:
    f = np.asarray(target, np.float64) - eye
    f /= max(np.linalg.norm(f), 1e-9)
    z = -f
    up = np.array([0.0, 1.0, 0.0]) if abs(f[1]) < 0.98 else np.array([0.0, 0.0, -1.0])
    x = np.cross(up, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return sio.pose_matrix(np.stack([x, y, z], axis=1), eye)


def free_floor(room: Room, cell: float = 0.25) -> tuple[np.ndarray, float, float]:
    """[z, x] cells where a person could stand: floor under them, nothing solid from knee to head height within
    0.35 m. Returns (mask, x origin, z origin)."""
    from scipy import ndimage

    P, w = room.pos, room.w
    ox, oz = float(room.lo[0]), float(room.lo[2])
    nx = max(1, int(math.ceil((room.hi[0] - ox) / cell)))
    nz = max(1, int(math.ceil((room.hi[2] - oz) / cell)))
    ix = np.floor((P[:, 0] - ox) / cell).astype(np.int64)
    iz = np.floor((P[:, 2] - oz) / cell).astype(np.int64)
    inb = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    y = P[:, 1]
    fl = inb & (np.abs(y) < 0.12)
    ob = inb & (y > 0.3) & (y < 1.9)
    Wf = np.bincount(iz[fl] * nx + ix[fl], weights=w[fl], minlength=nz * nx).reshape(nz, nx)
    Wo = np.bincount(iz[ob] * nx + ix[ob], weights=w[ob], minlength=nz * nx).reshape(nz, nx)
    thr_f = 0.05 * float(np.median(Wf[Wf > 0])) if (Wf > 0).any() else 1.0
    thr_o = 0.25 * float(np.median(Wo[Wo > 0])) if (Wo > 0).any() else 1.0
    floor = ndimage.binary_closing(Wf > thr_f, structure=np.ones((3, 3), bool))
    r = max(1, int(math.ceil(0.35 / cell)))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    blocked = ndimage.binary_dilation(Wo > thr_o, structure=(xx * xx + yy * yy) <= r * r)
    return floor & ~blocked, ox, oz


def plan_views(room: Room, max_positions: int = MAX_POSITIONS, size: int = FACE_RES) -> tuple[list[View], list[list[float]]]:
    """Cube maps on a lattice of free floor points through the headset spawn (nearest first, the spawn itself always),
    plus overview cameras from the corners of that area looking down at its middle."""
    free, ox, oz = free_floor(room)
    cell = 0.25
    hx, hz = room.spawn[0], room.spawn[2]
    zi, xi = np.nonzero(free)
    px, pz = ox + (xi + 0.5) * cell, oz + (zi + 0.5) * cell
    near = np.hypot(px - hx, pz - hz) <= MAX_RADIUS_M
    area = float(near.sum()) * cell * cell
    step = max(MIN_STEP_M, math.sqrt(area / max(1, max_positions)))
    pts: list[tuple[float, float]] = [(hx, hz)]
    span = int(math.ceil(MAX_RADIUS_M / step))
    lattice = []
    for i in range(-span, span + 1):
        for j in range(-span, span + 1):
            if i == 0 and j == 0:
                continue
            x, z = hx + i * step, hz + j * step
            cx, cz = int(math.floor((x - ox) / cell)), int(math.floor((z - oz) / cell))
            if not (0 <= cx < free.shape[1] and 0 <= cz < free.shape[0]) or not free[cz, cx]:
                continue
            if math.hypot(x - hx, z - hz) > MAX_RADIUS_M:
                continue
            lattice.append((math.hypot(x - hx, z - hz), i, j, x, z))
    lattice.sort()
    pts += [(x, z) for _, _, _, x, z in lattice[: max_positions - 1]]

    f = size / 2.0  # 90 degrees
    views: list[View] = []
    for k, (x, z) in enumerate(pts):
        for yaw, pitch in CUBE_FACES:
            R = sio.rot_y(math.radians(yaw)) @ sio.rot_x(math.radians(pitch))
            views.append(View(sio.pose_matrix(R, [x, EYE_M, z]), f, size, "cube", k))

    # overviews from the corners of the standing area: indoors just under the voxel map's ceiling, outdoors a little
    # above head height (a generated world falls apart when seen from much higher than it was generated from)
    ceil_m = room.voxel_map.get("ceilingY")
    ceil_m = float(ceil_m) / STUDS_PER_METER if isinstance(ceil_m, (int, float)) else float(room.hi[1])
    indoor = ceil_m < 0.8 * float(room.hi[1]) or ceil_m < 4.0
    h = min(max(ceil_m - 0.3, 1.9), 2.6) if indoor else OUTDOOR_OVERVIEW_M
    arr = np.array(pts)
    lo = arr.min(axis=0) - 0.25 * step
    hi = arr.max(axis=0) + 0.25 * step
    mid = np.array([(lo[0] + hi[0]) / 2, 0.0, (lo[1] + hi[1]) / 2])
    for cx, cz in ((lo[0], lo[1]), (hi[0], lo[1]), (lo[0], hi[1]), (hi[0], hi[1])):
        views.append(View(look_at(np.array([cx, h, cz]), mid), f, size, "overview"))
    return views, [[round(x, 3), round(z, 3)] for x, z in pts]


# --------------------------------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Shot:
    view: View
    rgb: Any  # torch [H, W, 3] float 0..1 (sRGB)
    depth: Any  # torch [H, W] z-depth in metres, 0 = nothing
    valid: Any  # torch [H, W] bool: solid, not on a depth edge, within MAX_DEPTH_M
    coverage: float


class Renderer:
    """Renders room-frame cameras from the world's splats (file frame) with gsplat, or the CPU point renderer."""

    def __init__(self, room: Room, device: Any):
        import torch

        self.room = room
        self.device = device
        self.gpu = device.type == "cuda" and sio.gsplat_available()
        self.t: dict = {}
        if self.gpu:
            s = room.splats
            self.t = {
                "means": torch.from_numpy(s.means).to(device),
                "quats": torch.from_numpy(s.quats).to(device),
                "scales": torch.from_numpy(s.scales).to(device),
                "opac": torch.from_numpy(s.opacities).to(device),
                "sh": torch.from_numpy(np.ascontiguousarray(s.sh_all())).to(device),
            }

    def file_c2w(self, c2w_room: np.ndarray) -> np.ndarray:
        c2w_viewer = np.array(c2w_room, np.float64, copy=True)
        c2w_viewer[1, 3] += self.room.floor_y
        return sio.viewer_camera_in_file(self.room.transform, c2w_viewer)

    def render(self, views: list[View]) -> list[Shot]:
        import torch

        if not views:
            return []
        size = views[0].size
        if self.gpu:
            from gsplat import rasterization

            vm = np.stack([sio.c2w_gl_to_cv_w2c(self.file_c2w(v.c2w)) for v in views]).astype(np.float32)
            K = np.stack([np.array([[v.f, 0, v.size / 2], [0, v.f, v.size / 2], [0, 0, 1]], np.float32) for v in views])
            with torch.no_grad():
                out, alpha, _ = rasterization(
                    self.t["means"], self.t["quats"], self.t["scales"], self.t["opac"], self.t["sh"],
                    torch.from_numpy(vm).to(self.device), torch.from_numpy(K).to(self.device), size, size,
                    sh_degree=self.room.splats.sh_degree, render_mode="RGB+ED", near_plane=0.01, far_plane=1e4,
                    backgrounds=torch.zeros(len(views), 3, device=self.device),
                )
            rgbs = out[..., :3].clamp(0, 1)
            depths = out[..., 3] * self.room.scale
            alphas = alpha[..., 0]
        else:
            rgbs, depths, alphas = [], [], []
            for v in views:
                try:
                    r = sio.render_points(self.room.splats, self.file_c2w(v.c2w), v.f, v.f, v.size / 2, v.size / 2, v.size, v.size)
                except ValueError:  # nothing in view at all
                    r = sio.Render(np.zeros((v.size, v.size, 3), np.uint8), np.zeros((v.size, v.size), np.float32),
                                   np.zeros((v.size, v.size), np.float32), "points")
                rgbs.append(torch.from_numpy(r.rgb.astype(np.float32) / 255.0))
                depths.append(torch.from_numpy(r.depth * self.room.scale))
                alphas.append(torch.from_numpy(r.alpha))
            rgbs, depths, alphas = torch.stack(rgbs), torch.stack(depths), torch.stack(alphas)
        shots = []
        for k, v in enumerate(views):
            d = depths[k].float()
            a = alphas[k].float()
            d = torch.where(a >= 0.5, d, torch.zeros_like(d))
            valid = (a >= MIN_ALPHA) & (d > 0.05) & (d < MAX_DEPTH_M) & ~depth_edges(d)
            shots.append(Shot(v, rgbs[k].float().contiguous(), d.contiguous(), valid, float((a >= 0.5).float().mean())))
        return shots


def depth_edges(d: Any, rel: float = EDGE_REL) -> Any:
    """Pixels on or next to a depth discontinuity (between near and far, or next to empty sky): expected depth there
    blends both surfaces and lies on neither, and the blend ramps over a few pixels (a sheet from the near edge to the
    far wall once fused). On any plane, inverse depth is affine in the pixel coordinates, so its second difference
    is about zero even at grazing angles (a far floor); across a ramp it is not. Steps of 1, 2 and 4 pixels catch
    ramps up to about 8 pixels wide."""
    import torch
    import torch.nn.functional as F

    inv = torch.where(d > 0, 1.0 / d.clamp(min=1e-6), torch.zeros_like(d))
    e = torch.zeros_like(d, dtype=torch.bool)
    for k in (1, 2, 4):
        ref = inv[k:-k, :] * rel
        e[k:-k, :] |= (inv[:-2 * k, :] - 2 * inv[k:-k, :] + inv[2 * k:, :]).abs() > ref
        ref = inv[:, k:-k] * rel
        e[:, k:-k] |= (inv[:, :-2 * k] - 2 * inv[:, k:-k] + inv[:, 2 * k:]).abs() > ref
    return F.max_pool2d(e[None, None].float(), 3, 1, 1)[0, 0] > 0


def render_views(renderer: Renderer, views: list[View], log: Callable[[str], None]) -> tuple[list[Shot], dict]:
    """Renders every view (cube faces six at a time) and drops empty views and positions inside things."""
    shots: list[Shot] = []
    dropped_inside = dropped_empty = 0
    groups: dict[Any, list[View]] = {}
    for v in views:
        groups.setdefault((v.kind, v.position) if v.kind != "overview" else ("overview", id(v)), []).append(v)
    for key, group in groups.items():
        got = renderer.render(group)
        if key[0] == "cube":
            sides = [s for s in got if abs(s.view.c2w[1, 2]) < 0.5]
            near = []
            for s in sides:
                dv = s.depth[s.depth > 0]
                near.append(float((dv < INSIDE_DEPTH_M).float().mean()) if dv.numel() else 0.0)
            if near and float(np.mean(near)) > 0.5:
                dropped_inside += 1
                continue
        for s in got:
            if s.coverage < EMPTY_VIEW:
                dropped_empty += 1
                continue
            shots.append(s)
    valid = float(np.mean([float(s.valid.float().mean()) for s in shots])) if shots else 0.0
    log(f"rendered {len(views)} views, kept {len(shots)} ({dropped_empty} mostly empty, {dropped_inside} positions inside "
        f"something); {valid * 100:.0f}% of their pixels give depth")
    return shots, {"views": len(views), "kept": len(shots), "empty": dropped_empty, "insidePositions": dropped_inside,
                   "validFraction": round(valid, 3)}


def backproject(shot: Shot, stride: int = 2) -> Any:
    """Room-frame points of a shot's valid pixels (every `stride`-th pixel)."""
    import torch

    v = shot.view
    d = shot.depth[::stride, ::stride]
    ok = shot.valid[::stride, ::stride]
    H, W = d.shape
    dev = d.device
    vs, us = torch.meshgrid(torch.arange(H, device=dev), torch.arange(W, device=dev), indexing="ij")
    u = us[ok].float() * stride + stride / 2.0
    vv = vs[ok].float() * stride + stride / 2.0
    z = d[ok]
    c = v.size / 2.0
    pc = torch.stack([(u - c) / v.f * z, -(vv - c) / v.f * z, -z], dim=1)
    R = torch.as_tensor(v.c2w[:3, :3], dtype=torch.float32, device=dev)
    t = torch.as_tensor(v.c2w[:3, 3], dtype=torch.float32, device=dev)
    return pc @ R.T + t


def project(P: Any, view: View) -> tuple[Any, Any, Any]:
    """(u, v, z) of room-frame points in a view: continuous pixel coordinates (pixel i spans [i, i+1)) and z-depth."""
    import torch

    R = torch.as_tensor(view.c2w[:3, :3], dtype=torch.float32, device=P.device)
    t = torch.as_tensor(view.c2w[:3, 3], dtype=torch.float32, device=P.device)
    pc = (P - t) @ R
    z = -pc[:, 2]
    zs = torch.where(z > 1e-3, z, torch.ones_like(z))
    c = view.size / 2.0
    return c + view.f * pc[:, 0] / zs, c - view.f * pc[:, 1] / zs, z


# --------------------------------------------------------------------------------------------------------------
# TSDF in sparse blocks
# --------------------------------------------------------------------------------------------------------------


def choose_voxel(shots: list[Shot], room: Room, voxel: float | None, log: Callable[[str], None]) -> float:
    """From the seen surface area (distinct 10 cm cells hit by back-projected pixels) unless given."""
    import torch

    if voxel:
        return float(voxel)
    lo = torch.as_tensor(room.lo, dtype=torch.float32, device=shots[0].depth.device)
    hi = torch.as_tensor(room.hi, dtype=torch.float32, device=shots[0].depth.device)
    keys = []
    for s in shots:
        p = backproject(s, 4)
        p = p[((p >= lo) & (p <= hi)).all(dim=1)]
        c = torch.floor((p - lo) / 0.1).long()
        keys.append(torch.unique((c[:, 0] * 4096 + c[:, 1]) * 4096 + c[:, 2]))
    n = int(torch.unique(torch.cat(keys)).numel()) if keys else 0
    area = n * 0.01
    v = float(np.clip(math.sqrt(area / SURFACE_CELLS), VOXEL_MIN_M, VOXEL_MAX_M))
    v = round(v, 3)
    log(f"seen surface about {area:.0f} m2 -> voxel {v * 100:.1f} cm")
    return v


class Tsdf:
    """A truncated signed distance field (metres, room frame) stored in 8^3 blocks that cover the seen surfaces.

    Voxel k of block b sits at origin + (8 * blocks[b] + local(k) + 0.5) * voxel, local(k) = (k // 64, k // 8 % 8, k % 8).
    tsdf is distance / trunc clamped to [-1, 1] (positive = free space), weight the summed observation weight, nobs
    the number of views that saw the voxel within the truncation band, colour the band-weighted linear RGB sum."""

    def __init__(self, shots: list[Shot], room: Room, voxel: float, max_voxels: int, log: Callable[[str], None]):
        import torch

        dev = shots[0].depth.device
        self.device = dev
        for _ in range(4):
            self.v = voxel
            self.origin = np.array(room.lo, np.float64)
            self.dims = np.ceil((room.hi - room.lo) / voxel).astype(np.int64) + 1
            self.nb = (self.dims + BLOCK - 1) // BLOCK
            blocks = self._allocate(shots, room)
            if len(blocks) * BLOCK ** 3 <= max_voxels:
                break
            voxel = round(voxel * math.sqrt(len(blocks) * BLOCK ** 3 / max_voxels) * 1.05, 4)
            log(f"too many voxels at {self.v * 100:.1f} cm; trying {voxel * 100:.1f} cm")
        self.trunc = TRUNC_VOXELS * self.v
        self.blocks = blocks  # [K, 3] long
        K = len(blocks)
        nbx, nby, nbz = (int(n) for n in self.nb)
        self.block_map = torch.full((nbx * nby * nbz,), -1, dtype=torch.int64, device=dev)
        self.block_map[(blocks[:, 0] * nby + blocks[:, 1]) * nbz + blocks[:, 2]] = torch.arange(K, device=dev)
        local = torch.stack(torch.meshgrid(*(torch.arange(BLOCK, device=dev),) * 3, indexing="ij"), dim=-1).reshape(-1, 3)
        self.local = local
        o = torch.as_tensor(self.origin, dtype=torch.float32, device=dev)
        ijk = (blocks[:, None, :] * BLOCK + local[None]).reshape(-1, 3)
        self.centres = o + (ijk.float() + 0.5) * self.v
        del ijk
        n = K * BLOCK ** 3
        self.tsdf = torch.ones(n, device=dev)
        self.weight = torch.zeros(n, device=dev)
        self.nobs = torch.zeros(n, dtype=torch.int16, device=dev)
        self.colour = torch.zeros(n, 3, device=dev)
        self.cweight = torch.zeros(n, device=dev)
        log(f"tsdf: voxel {self.v * 100:.1f} cm, {K} blocks ({n / 1e6:.1f} M voxels), truncation {self.trunc * 100:.1f} cm")

    def _allocate(self, shots: list[Shot], room: Room) -> Any:
        import torch

        dev = self.device
        o = torch.as_tensor(self.origin, dtype=torch.float32, device=dev)
        nb = torch.as_tensor(self.nb, device=dev)
        keys = []
        for s in shots:
            p = backproject(s, 2)
            b = torch.floor((p - o) / (self.v * BLOCK)).long()
            b = b[((b >= 0) & (b < nb)).all(dim=1)]
            keys.append(torch.unique((b[:, 0] * nb[1] + b[:, 1]) * nb[2] + b[:, 2]))
        if not keys:
            raise MeshError("no view saw anything solid")
        k = torch.unique(torch.cat(keys))
        b = torch.stack([k // (nb[1] * nb[2]), (k // nb[2]) % nb[1], k % nb[2]], dim=1)
        # grow by one block in every direction, so the truncation band around a surface is always allocated
        off = torch.stack(torch.meshgrid(*(torch.arange(-1, 2, device=dev),) * 3, indexing="ij"), dim=-1).reshape(-1, 3)
        g = (b[:, None, :] + off[None]).reshape(-1, 3)
        g = g[((g >= 0) & (g < nb)).all(dim=1)]
        k = torch.unique((g[:, 0] * nb[1] + g[:, 1]) * nb[2] + g[:, 2])
        return torch.stack([k // (nb[1] * nb[2]), (k // nb[2]) % nb[1], k % nb[2]], dim=1)

    def integrate(self, shot: Shot, chunk: int = 8_000_000) -> None:
        import torch

        view = shot.view
        H, W = shot.depth.shape
        depth = shot.depth.reshape(-1)
        valid = shot.valid.reshape(-1)
        lin = srgb_to_linear_t(shot.rgb).reshape(-1, 3)
        tr = self.trunc
        for s0 in range(0, len(self.tsdf), chunk):
            P = self.centres[s0:s0 + chunk]
            u, vv, z = project(P, view)
            ui = torch.floor(u).long()
            vi = torch.floor(vv).long()
            inb = (z > 0.05) & (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
            sel = torch.nonzero(inb).squeeze(1)
            if sel.numel() == 0:
                continue
            pix = vi[sel] * W + ui[sel]
            ok = valid[pix]
            sel, pix = sel[ok], pix[ok]
            d = depth[pix]
            sdf = d - z[sel]
            keep = sdf > -tr
            sel, pix, d, sdf = sel[keep], pix[keep], d[keep], sdf[keep]
            if sel.numel() == 0:
                continue
            gi = sel + s0
            t = torch.clamp(sdf / tr, max=1.0)
            w = torch.clamp(2.0 / d, max=1.0) ** 2  # far observations count less
            w = torch.where(sdf > tr, w * FREE_WEIGHT, w)
            w0 = self.weight[gi]
            self.tsdf[gi] = (self.tsdf[gi] * w0 + t * w) / (w0 + w)
            self.weight[gi] = w0 + w
            band = sdf.abs() < tr
            gb = gi[band]
            self.nobs[gb] += 1
            wc = w[band] * (1.0 - sdf[band].abs() / tr)
            self.colour[gb] += lin[pix[band]] * wc[:, None]
            self.cweight[gb] += wc

    def lookup(self, P: Any) -> tuple[Any, Any, Any]:
        """(tsdf, nobs, linear colour or NaN) of the voxel holding each room-frame point; outside: (1, 0, NaN)."""
        import torch

        o = torch.as_tensor(self.origin, dtype=torch.float32, device=P.device)
        ijk = torch.floor((P - o) / self.v).long()
        b = ijk // BLOCK
        nb = torch.as_tensor(self.nb, device=P.device)
        inb = ((b >= 0) & (b < nb)).all(dim=1)
        bid = torch.full((len(P),), -1, dtype=torch.int64, device=P.device)
        bb = b[inb]
        bid[inb] = self.block_map[(bb[:, 0] * nb[1] + bb[:, 1]) * nb[2] + bb[:, 2]]
        has = bid >= 0
        l = ijk - b * BLOCK
        k = bid * BLOCK ** 3 + (l[:, 0] * BLOCK + l[:, 1]) * BLOCK + l[:, 2]
        k = torch.where(has, k, torch.zeros_like(k))
        t = torch.where(has, self.tsdf[k], torch.ones_like(P[:, 0]))
        n = torch.where(has, self.nobs[k], torch.zeros_like(self.nobs[k]))
        cw = torch.where(has, self.cweight[k], torch.zeros_like(P[:, 0]))
        col = self.colour[k] / cw.clamp(min=1e-9)[:, None]
        col = torch.where((cw > 0)[:, None], col, torch.full_like(col, float("nan")))
        return t, n, col

    def surface(self, log: Callable[[str], None]) -> tuple[np.ndarray, np.ndarray]:
        """Marching cubes over x-slabs of blocks (each slab cropped to its own y/z extent), only in cells whose eight
        corners were each seen at least MIN_OBS times. Vertices are room-frame metres, welded across slabs; faces
        wind counter-clockwise seen from free space."""
        import torch
        from skimage.measure import marching_cubes

        B = BLOCK
        verts_all, faces_all = [], []
        nv = 0
        bx = self.blocks[:, 0]
        nbx = int(self.nb[0])
        for b0 in range(0, nbx, SLAB_BLOCKS):
            b1 = min(b0 + SLAB_BLOCKS, nbx)  # exclusive; the slab also takes the first voxel layer of block b1
            in_slab = torch.nonzero((bx >= b0) & (bx <= b1)).squeeze(1)
            if in_slab.numel() == 0:
                continue
            blk = self.blocks[in_slab]
            ylo, zlo = int(blk[:, 1].min()), int(blk[:, 2].min())
            yhi, zhi = int(blk[:, 1].max()) + 1, int(blk[:, 2].max()) + 1
            X = (b1 - b0) * B + (1 if b1 < nbx else 0)
            Y, Z = (yhi - ylo) * B, (zhi - zlo) * B
            dense_t = torch.ones((X, Y, Z), device=self.device)
            dense_n = torch.zeros((X, Y, Z), dtype=torch.int16, device=self.device)
            ijk = (blk[:, None, :] * B + self.local[None]).reshape(-1, 3)
            vidx = (in_slab[:, None] * B ** 3 + torch.arange(B ** 3, device=self.device)[None]).reshape(-1)
            lx = ijk[:, 0] - b0 * B
            keep = lx < X
            ijk, vidx, lx = ijk[keep], vidx[keep], lx[keep]
            ly, lz = ijk[:, 1] - ylo * B, ijk[:, 2] - zlo * B
            dense_t[lx, ly, lz] = self.tsdf[vidx]
            dense_n[lx, ly, lz] = self.nobs[vidx]
            seen = dense_n >= MIN_OBS
            m = seen[:-1, :-1, :-1].clone()
            for dx in (0, 1):
                for dy in (0, 1):
                    for dz in (0, 1):
                        if dx or dy or dz:
                            m &= seen[dx:X - 1 + dx, dy:Y - 1 + dy, dz:Z - 1 + dz]
            if not bool(m.any()):
                continue
            # scikit-image processes the cell with base corner (x, y, z) when mask[x + 1, y + 1, z + 1] is set
            mask = torch.zeros((X, Y, Z), dtype=torch.bool, device=self.device)
            mask[1:, 1:, 1:] = m
            vol = dense_t.cpu().numpy()
            try:
                v, f, _, _ = marching_cubes(vol, 0.0, mask=mask.cpu().numpy(), allow_degenerate=False)
            except (ValueError, RuntimeError):
                continue  # no zero crossing in the seen cells
            if len(f) == 0:
                continue
            v = v.astype(np.float64) + np.array([b0 * B, ylo * B, zlo * B], np.float64)
            verts_all.append(v)
            faces_all.append(f.astype(np.int64) + nv)
            nv += len(v)
        if not faces_all:
            raise MeshError("the views agree on no surface at all")
        V = np.concatenate(verts_all)
        F = np.concatenate(faces_all)
        # slabs share their boundary layer and compute those vertices identically: weld them
        q = np.round(V * 4096.0).astype(np.int64)
        _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
        F = inv.reshape(-1)[F]
        V = self.origin + (V[first] + 0.5) * self.v
        log(f"marching cubes: {len(V)} vertices, {len(F)} triangles")
        return V, F


def srgb_to_linear_t(c: Any) -> Any:
    import torch

    c = c.clamp(0, 1)
    return torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb_np(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


# --------------------------------------------------------------------------------------------------------------
# Mesh clean-up, decimation and chunks
# --------------------------------------------------------------------------------------------------------------


def face_normals(V: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(unit normals, areas) of each face."""
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    a = np.linalg.norm(n, axis=1)
    return n / np.maximum(a, 1e-12)[:, None], 0.5 * a


def vertex_normals(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    """Unit normals (area-weighted); a vertex whose faces cancel out gets +Y."""
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])  # area-weighted
    out = np.zeros_like(V)
    for k in range(3):
        np.add.at(out, F[:, k], n)
    ln = np.linalg.norm(out, axis=1)
    flat = ln < 1e-12
    out[flat] = [0.0, 1.0, 0.0]
    ln[flat] = 1.0
    return out / ln[:, None]


def split_opposed(V: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    """Gives a vertex shared by faces that point opposite ways (the two sides of a thin sheet that decimation merged,
    a fold) a second copy for the faces that disagree with its largest face, so each side gets its own normal instead
    of the two cancelling out (a wrongly lit, often black, patch in Roblox). Returns the mesh and how many vertices
    were split."""
    fn, area = face_normals(V, F)
    n = len(V)
    corner_v = F.reshape(-1)
    corner_f = np.repeat(np.arange(len(F)), 3)
    vsum = np.zeros_like(V)
    np.add.at(vsum, corner_v, fn[corner_f] * area[corner_f, None])
    # the largest face at each vertex is its reference side
    order = np.lexsort((-area[corner_f], corner_v))
    first = np.ones(len(order), bool)
    first[1:] = corner_v[order][1:] != corner_v[order][:-1]
    ref = np.zeros_like(V)
    ref[corner_v[order][first]] = fn[corner_f[order][first]]
    other = np.einsum("ij,ij->i", fn[corner_f], ref[corner_v]) < 0.0
    if not other.any():
        return V, F, 0
    moved, new_id = np.unique(corner_v[other], return_inverse=True)
    F2 = F.reshape(-1).copy()
    F2[np.nonzero(other)[0]] = n + new_id
    return np.concatenate([V, V[moved]]), F2.reshape(-1, 3), len(moved)


def compact(V: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Drops unused vertices and degenerate faces."""
    good = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])
    F = F[good]
    _, area = face_normals(V, F)
    F = F[area > 1e-12]
    used, inv = np.unique(F, return_inverse=True)
    return V[used], inv.reshape(-1, 3)


def drop_small_components(V: np.ndarray, F: np.ndarray, min_area: float,
                          airborne_m2: float = AIRBORNE_MAX_M2) -> tuple[np.ndarray, np.ndarray, int]:
    """Drops connected pieces smaller than `min_area`, and airborne ones (entirely above AIRBORNE_MIN_Y and smaller
    than `airborne_m2`): bits of a splat sky, floaters. Returns the mesh and how many pieces went."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    n = len(V)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    g = coo_matrix((np.ones(len(e), np.int8), (e[:, 0], e[:, 1])), shape=(n, n))
    ncomp, lab = connected_components(g, directed=False)
    fl = lab[F[:, 0]]
    _, area = face_normals(V, F)
    comp_area = np.bincount(fl, weights=area, minlength=ncomp)
    low = np.full(ncomp, np.inf)
    np.minimum.at(low, lab, V[:, 1])
    bad = (comp_area < min_area) | ((low > AIRBORNE_MIN_Y) & (comp_area < airborne_m2))
    V2, F2 = compact(V, F[~bad[fl]])
    return V2, F2, int(bad.sum())


def fill_holes(V: np.ndarray, F: np.ndarray, max_edges: int = HOLE_EDGES) -> tuple[np.ndarray, np.ndarray, int]:
    """Closes small holes: each loop of boundary edges (edges with a face on one side only) of at most `max_edges`
    edges gets a fan of triangles around its centroid, wound like its neighbours. Loops through a vertex that lies on
    more than one boundary are left open, and so is a loop whose fan would face away from the faces around it (the
    outer rim of a small piece, not a hole in it). Returns the mesh and how many holes were closed."""
    n = len(V)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    fwd = e[:, 0] * n + e[:, 1]
    rev = e[:, 1] * n + e[:, 0]
    is_b = ~np.isin(rev, fwd)
    b = e[is_b]
    if len(b) == 0:
        return V, F, 0
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    side = dict(zip(b[:, 0].tolist(), (np.nonzero(is_b)[0] % len(F)).tolist()))  # boundary vertex -> its face
    starts, counts = np.unique(b[:, 0], return_counts=True)
    shared = set(starts[counts > 1].tolist())
    nxt = dict(zip(b[:, 0].tolist(), b[:, 1].tolist()))
    seen: set[int] = set()
    loops = []
    for a0 in b[:, 0].tolist():
        if a0 in seen or a0 in shared:
            continue
        loop = [a0]
        seen.add(a0)
        a = nxt.get(a0)
        ok = True
        while a is not None and a != a0:
            if a in shared or a in seen or len(loop) > max_edges:
                ok = False
                break
            loop.append(a)
            seen.add(a)
            a = nxt.get(a)
        if ok and a == a0 and 3 <= len(loop) <= max_edges:
            loops.append(loop)
    new_v: list[np.ndarray] = []
    new_f = []
    for loop in loops:
        ring = np.asarray(loop)
        centre = V[ring].mean(axis=0)
        # boundary half-edge a -> b belongs to an existing face; the fan face takes b -> a
        a, b2 = V[ring], V[np.roll(ring, -1)]
        fan = np.cross(a - b2, centre - b2).sum(axis=0)
        around = fn[[side[v] for v in loop]].sum(axis=0)
        if float(fan @ around) <= 0:
            continue
        c = n + len(new_v)
        new_v.append(centre)
        new_f.append(np.stack([np.roll(ring, -1), ring, np.full(len(ring), c)], axis=1))
    if not new_v:
        return V, F, 0
    return np.concatenate([V, np.asarray(new_v)]), np.concatenate([F, np.concatenate(new_f)]), len(new_v)


def floor_fill(V: np.ndarray, F: np.ndarray, room: Room) -> tuple[np.ndarray, np.ndarray, float]:
    """Tiles (at most 1 m square) under the floor, over the convex hull of the cells where the mesh comes near the
    floor: a little under it (FLOOR_FILL_Y) wherever the mesh's own floor does not cover the ground or lies clear above
    that, and lower (FLOOR_BACKSTOP_Y) under a bumpier floor that still clears it, so a tear in the floor shows the
    ground's colour instead of the void. A generated world often has no ground right under the camera it was made
    from, and its ground is torn wherever it was only seen at a grazing angle; Roblox players would look into holes
    there. Returns the tiles and the area (m2) where the floor was open."""
    cell = FLOOR_CELL_M
    ox, oz = float(room.lo[0]), float(room.lo[2])
    nx = max(1, int(math.ceil((room.hi[0] - ox) / cell)))
    nz = max(1, int(math.ceil((room.hi[2] - oz) / cell)))

    def cells(pts: np.ndarray) -> np.ndarray:
        ix = np.clip(np.floor((pts[:, 0] - ox) / cell).astype(np.int64), 0, nx - 1)
        iz = np.clip(np.floor((pts[:, 2] - oz) / cell).astype(np.int64), 0, nz - 1)
        return iz * nx + ix

    near = np.zeros(nz * nx, bool)
    near[cells(V[np.abs(V[:, 1]) < 0.35])] = True
    near = near.reshape(nz, nx)
    if near.sum() < 8:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64), 0.0
    n, area = face_normals(V, F)
    c = V[F].mean(axis=1)
    fl = (np.abs(c[:, 1]) < 0.2) & (n[:, 1] > 0.6)
    where = cells(c[fl])
    cover = np.bincount(where, weights=area[fl], minlength=nz * nx).reshape(nz, nx)
    low = np.full(nz * nx, np.inf)
    np.minimum.at(low, where, V[F[fl]][:, :, 1].min(axis=1))
    hull = rmap.hull_mask(near, 1.0)
    low = low.reshape(nz, nx)
    missing = hull & (cover < 0.7 * cell * cell)
    shallow = missing | (hull & (low > FLOOR_FILL_Y + FLOOR_CLEAR_M))
    deep = hull & ~shallow & (low > FLOOR_BACKSTOP_Y + FLOOR_CLEAR_M)
    k = max(1, int(round(1.0 / cell)))
    verts, faces = [], []
    for x0, z0, x1, z1, lab in rmap.greedy_rects_2d(np.where(shallow, 0, np.where(deep, 1, -1)).astype(np.int32)):
        y = FLOOR_FILL_Y if lab == 0 else FLOOR_BACKSTOP_Y
        for a in range(x0, x1, k):
            for b in range(z0, z1, k):
                xa, xb = ox + a * cell, ox + min(a + k, x1) * cell
                za, zb = oz + b * cell, oz + min(b + k, z1) * cell
                n0 = len(verts)
                verts += [(xa, y, za), (xa, y, zb), (xb, y, zb), (xb, y, za)]
                faces += [(n0, n0 + 1, n0 + 2), (n0, n0 + 2, n0 + 3)]  # counter-clockwise seen from above
    return (np.asarray(verts, np.float64).reshape(-1, 3), np.asarray(faces, np.int64).reshape(-1, 3),
            float(missing.sum()) * cell * cell)


def floor_colours(room: Room, cell: float = 0.1) -> tuple[np.ndarray, float, float, float]:
    """The floor's colour seen from above (linear RGB per `cell`) from the splats in the floor band, gaps painted in."""
    m = np.abs(room.pos[:, 1]) < 0.12
    return paint_floor_map(room.pos[m], room.lin[m], room.w[m], room, cell)


def paint_floor_map(P: np.ndarray, lin: np.ndarray, w: np.ndarray, room: Room,
                    cell: float = 0.1) -> tuple[np.ndarray, float, float, float]:
    """A top-down colour map of points on the floor (weighted mean per `cell`), with the gaps painted in from around
    them: (linear RGB image [z, x, 3], x origin, z origin, cell)."""
    import cv2

    ox, oz = float(room.lo[0]), float(room.lo[2])
    nx = max(1, int(math.ceil((room.hi[0] - ox) / cell)))
    nz = max(1, int(math.ceil((room.hi[2] - oz) / cell)))
    ix = np.floor((P[:, 0] - ox) / cell).astype(np.int64)
    iz = np.floor((P[:, 2] - oz) / cell).astype(np.int64)
    m = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    key = iz[m] * nx + ix[m]
    W = np.bincount(key, weights=w[m], minlength=nz * nx)
    C = np.stack([np.bincount(key, weights=w[m] * lin[m, c], minlength=nz * nx) for c in range(3)], axis=1)
    have = W > 0
    img = np.zeros((nz * nx, 3))
    img[have] = C[have] / W[have, None]
    if not have.any():
        img[:] = 0.03
        return img.reshape(nz, nx, 3).astype(np.float32), ox, oz, cell
    u8 = np.clip(np.round(linear_to_srgb_np(img) * 255), 0, 255).astype(np.uint8).reshape(nz, nx, 3)
    hole = (~have).reshape(nz, nx).astype(np.uint8)
    u8 = cv2.inpaint(u8, hole, 4, cv2.INPAINT_TELEA)
    out = rmap.srgb_to_linear(u8.astype(np.float64) / 255.0)
    return out.astype(np.float32), ox, oz, cell


def split_ceiling(V: np.ndarray, F: np.ndarray, log: Callable[[str], None]) -> tuple[np.ndarray, np.ndarray, float | None]:
    """(room faces, ceiling faces, ceiling height) by face index. A lid is a height above 1.9 m where down-facing
    surfaces cover at least CEILING_SHARE of the floor area; anything higher than 0.3 m above it (the outside of the
    lid, junk) is dropped."""
    n, area = face_normals(V, F)
    c = V[F].mean(axis=1)
    y = c[:, 1]
    up = (n[:, 1] > 0.7) & (y < 0.2)
    down = (n[:, 1] < -0.7) & (y > 1.9) & (y < 6.0)
    floor_area = float(area[up].sum())
    all_idx = np.arange(len(F))
    if floor_area <= 0 or not down.any():
        return all_idx, np.zeros(0, np.int64), None
    bins = np.arange(1.9, 6.0 + 0.05, 0.05)
    hist, _ = np.histogram(y[down], bins=bins, weights=area[down])
    win = np.convolve(hist, np.ones(5), mode="same")  # +-10 cm
    k = int(np.argmax(win))
    if win[k] < CEILING_SHARE * floor_area:
        return all_idx, np.zeros(0, np.int64), None
    h = float(bins[k] + 0.025)
    lid = (n[:, 1] < -0.5) & (y > h - 0.15)
    above = y > h + 0.3
    log(f"ceiling at {h:.2f} m ({win[k]:.1f} m2 facing down, floor {floor_area:.1f} m2)")
    return all_idx[~lid & ~above], all_idx[lid & ~above], h


def orient_faces(V: np.ndarray, F: np.ndarray, tsdf: Tsdf) -> tuple[np.ndarray, int]:
    """Turns faces that face into the solid toward free space, face by face (folds that decimation leaves, the far side
    of a thin sheet collapsed onto the near one): the field one and two voxels along a face's normal should be freer
    than as far against it. Only faces with both sides observed and a clear answer are turned. Roblox draws one side
    of a mesh, so a face turned the wrong way is a hole there. Returns the faces and how many were turned."""
    import torch

    fn, _ = face_normals(V, F)
    dev = tsdf.device
    flip = np.zeros(len(F), bool)
    step = 500_000
    for s0 in range(0, len(F), step):
        P = torch.as_tensor(V[F[s0:s0 + step]].mean(axis=1), dtype=torch.float32, device=dev)
        N = torch.as_tensor(fn[s0:s0 + step], dtype=torch.float32, device=dev)
        score = torch.zeros(len(P), device=dev)
        seen = torch.ones(len(P), dtype=torch.bool, device=dev)
        for k in (1.0, 2.0):
            ahead, na, _ = tsdf.lookup(P + N * (k * tsdf.v))
            behind, nb, _ = tsdf.lookup(P - N * (k * tsdf.v))
            score += ahead - behind
            seen &= (na > 0) & (nb > 0)
        flip[s0:s0 + step] = (seen & (score < -0.5)).cpu().numpy()
    F = F.copy()
    F[flip] = F[flip][:, [0, 2, 1]]
    return F, int(flip.sum())


def boundary_edges(F: np.ndarray) -> int:
    """Edges with a face on one side only (the rims of holes and of the surface)."""
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e = np.sort(e, axis=1)
    _, counts = np.unique(e[:, 0] * (int(F.max()) + 1) + e[:, 1], return_counts=True)
    return int((counts == 1).sum())


def decimate(V: np.ndarray, F: np.ndarray, target: int) -> tuple[np.ndarray, np.ndarray]:
    if len(F) <= target:
        return V, F
    import fast_simplification

    for agg in (7.0, 9.0, 12.0):  # a more aggressive pass when the first stops short of the target
        v2, f2 = fast_simplification.simplify(V.astype(np.float32), F.astype(np.int64), target_count=int(target), agg=agg)
        if len(f2) <= 1.01 * target:
            break
    return compact(np.asarray(v2, np.float64), np.asarray(f2, np.int64))


def kd_chunks(V: np.ndarray, F: np.ndarray, max_tris: int = CHUNK_TRIANGLES, min_chunks: int = 1) -> list[np.ndarray]:
    """Face index sets: the biggest set is halved along the longer of x / z at its median face centre until each
    fits and there are at least `min_chunks` (each chunk is one texture, so this sets the texel budget); ordered by
    centre (z, then x) so names are stable."""
    c = V[F].mean(axis=1)
    out = [np.arange(len(F))]
    while True:
        k = max(range(len(out)), key=lambda i: len(out[i]))
        idx = out[k]
        if len(idx) < 2 or (len(idx) <= max_tris and len(out) >= min_chunks):
            break
        cc = c[idx]
        ext = cc.max(axis=0) - cc.min(axis=0)
        ax = 0 if ext[0] >= ext[2] else 2
        order = np.argsort(cc[:, ax], kind="stable")
        half = len(idx) // 2
        out[k:k + 1] = [idx[order[:half]], idx[order[half:]]]
    out.sort(key=lambda i: (round(float(c[i, 2].mean()), 3), round(float(c[i, 0].mean()), 3)))
    return out


# --------------------------------------------------------------------------------------------------------------
# UV atlas and texture bake
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Chunk:
    name: str
    kind: str  # "room", "ceiling" or "floor" (the fill under holes in the floor)
    V: np.ndarray  # [n, 3] room frame metres (atlas-split vertices)
    N: np.ndarray  # [n, 3] unit normals
    UV: np.ndarray  # [n, 2] glTF texture coordinates (0, 0 = top left)
    F: np.ndarray  # [m, 3]
    size: int  # texture size (px, square)
    image: np.ndarray | None = None  # [size, size, 3] uint8
    stats: dict = field(default_factory=dict)


@dataclass
class Part:
    """A chunk before its atlas: room-frame vertices, faces and normals, and the texture size it gets."""

    name: str
    kind: str
    V: np.ndarray
    F: np.ndarray
    N: np.ndarray
    size: int


def _atlas(args: tuple) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, float]:
    """xatlas for one chunk (runs in a worker process): (vertex map, faces, uvs 0..1, atlas count, utilisation)."""
    import xatlas

    V, F, N, res, padding = args
    atlas = xatlas.Atlas()
    atlas.add_mesh(V.astype(np.float32), F.astype(np.uint32), N.astype(np.float32))
    po = xatlas.PackOptions()
    po.resolution = int(res)
    po.padding = int(padding)
    po.bilinear = True
    po.blockAlign = False
    co = xatlas.ChartOptions()
    co.max_cost = 8.0  # bigger charts: fewer seams, so fewer split vertices in the file
    atlas.generate(co, po)
    vmap, idx, uv = atlas[0]
    return vmap.astype(np.int64), idx.astype(np.int64), uv.astype(np.float32), int(atlas.atlas_count), float(atlas.utilization)


def build_atlases(parts: list[Part], workers: int) -> list[Chunk]:
    """UV atlases in worker processes (spawned: the parent holds a CUDA context). A caller that imports this module
    from a script needs the usual `if __name__ == "__main__"` guard for that; without one the pool breaks and the
    atlases are made here, one after the other."""
    jobs = [(p.V, p.F, p.N, p.size, max(2, p.size // 256)) for p in parts]
    results = None
    if workers > 1 and len(jobs) > 1:
        import multiprocessing as mp
        from concurrent.futures.process import BrokenProcessPool

        try:
            with ProcessPoolExecutor(max_workers=min(workers, len(jobs)), mp_context=mp.get_context("spawn")) as ex:
                results = list(ex.map(_atlas, jobs))
        except BrokenProcessPool:
            results = None
    if results is None:
        results = [_atlas(j) for j in jobs]
    chunks = []
    for p, (vmap, idx, uv, count, util) in zip(parts, results):
        if count != 1:
            raise MeshError(f"{p.name}: the UV atlas needs {count} pages")
        chunks.append(Chunk(p.name, p.kind, p.V[vmap], p.N[vmap], uv, idx.reshape(-1, 3), p.size,
                            stats={"atlasUse": round(util, 3)}))
    return chunks


def texels(ch: Chunk) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Covered texels of a chunk's atlas: (rows, cols, 3D positions, normals). Each triangle is drawn into a face-id
    image; a texel centre's barycentric coordinates (clamped onto its triangle) give its position and normal."""
    import cv2

    T = ch.size
    uvp = ch.UV.astype(np.float64) * T - 0.5  # texel centres at integers
    ids = np.full((T, T), -1, np.int32)
    tri = np.round(uvp[ch.F] * 16.0).astype(np.int32)  # 4 fractional bits
    for k in range(len(ch.F)):
        cv2.fillConvexPoly(ids, tri[k], int(k), lineType=cv2.LINE_8, shift=4)
    rows, cols = np.nonzero(ids >= 0)
    f = ids[rows, cols]
    a, b, c = (uvp[ch.F[f, i]] for i in range(3))
    p = np.stack([cols, rows], axis=1).astype(np.float64)
    v0, v1, v2 = b - a, c - a, p - a
    d00 = np.sum(v0 * v0, 1)
    d01 = np.sum(v0 * v1, 1)
    d11 = np.sum(v1 * v1, 1)
    d20 = np.sum(v2 * v0, 1)
    d21 = np.sum(v2 * v1, 1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) < 1e-12, 1e-12, den)
    w1 = (d11 * d20 - d01 * d21) / den
    w2 = (d00 * d21 - d01 * d20) / den
    bary = np.clip(np.stack([1 - w1 - w2, w1, w2], axis=1), 0.0, None)
    bary /= np.maximum(bary.sum(axis=1, keepdims=True), 1e-12)
    P = np.einsum("nk,nkd->nd", bary, ch.V[ch.F[f]])
    N = np.einsum("nk,nkd->nd", bary, ch.N[ch.F[f]])
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    return rows, cols, P, N


def bake(chunks: list[Chunk], shots: list[Shot], tsdf: Tsdf, room: Room, log: Callable[[str], None]) -> dict:
    """Fills each chunk's image. Pass 1 finds every texel's best view weight; pass 2 averages (in linear light) the
    views within half of it. A view counts for a texel when the texel faces it, falls on a valid pixel and lies on
    the depth that view saw there. Texels no view saw take the fused voxel colour, then (on the floor) the floor's
    colour painted in from around them."""
    import torch
    import torch.nn.functional as F

    dev = tsdf.device
    parts = [texels(ch) for ch in chunks]
    P = torch.as_tensor(np.concatenate([p[2] for p in parts]), dtype=torch.float32, device=dev)
    Nn = torch.as_tensor(np.concatenate([p[3] for p in parts]), dtype=torch.float32, device=dev)
    M = len(P)
    tol_abs = 3.0 * tsdf.v

    def weights(s: Shot) -> tuple[Any, Any, Any, Any]:
        v = s.view
        u, vv, z = project(P, v)
        H, W = s.depth.shape
        ui, vi = torch.floor(u).long(), torch.floor(vv).long()
        inb = (z > 0.05) & (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
        sel = torch.nonzero(inb).squeeze(1)
        pix = vi[sel] * W + ui[sel]
        ok = s.valid.reshape(-1)[pix]
        d = s.depth.reshape(-1)[pix]
        zz = z[sel]
        ok &= (zz - d).abs() < torch.clamp(0.03 * d, min=tol_abs)
        eye = torch.as_tensor(v.c2w[:3, 3], dtype=torch.float32, device=dev)
        to_eye = eye - P[sel]
        dist = to_eye.norm(dim=1).clamp(min=1e-6)
        cos = (Nn[sel] * to_eye).sum(dim=1) / dist
        ok &= cos > 0.15
        sel, cos, dist = sel[ok], cos[ok], dist[ok]
        w = (v.f * cos / dist.clamp(min=0.3)) ** 2
        return sel, w, u[sel], vv[sel]

    best = torch.zeros(M, device=dev)
    for s in shots:
        sel, w, _, _ = weights(s)
        best[sel] = torch.maximum(best[sel], w)
    acc = torch.zeros(M, 3, device=dev)
    wsum = torch.zeros(M, device=dev)
    for s in shots:
        sel, w, u, vv = weights(s)
        good = w >= 0.5 * best[sel]
        sel, w, u, vv = sel[good], w[good], u[good], vv[good]
        if sel.numel() == 0:
            continue
        H, W = s.depth.shape
        grid = torch.stack([u / W * 2 - 1, vv / H * 2 - 1], dim=1)[None, None]
        img = srgb_to_linear_t(s.rgb).permute(2, 0, 1)[None]
        col = F.grid_sample(img, grid, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
        acc[sel] += col * w[:, None]
        wsum[sel] += w
    from_views = wsum > 0
    seen = from_views.clone()
    lin = acc / wsum.clamp(min=1e-9)[:, None]
    # texels no view saw: the voxel colour there (or one voxel out along the normal, then in)
    miss = torch.nonzero(~seen).squeeze(1)
    n_vox = 0
    if miss.numel():
        fill = torch.full((miss.numel(), 3), float("nan"), device=dev)
        for off in (0.0, 1.0, -1.0, 2.0):
            todo = torch.isnan(fill[:, 0])
            if not bool(todo.any()):
                break
            q = P[miss[todo]] + Nn[miss[todo]] * (off * tsdf.v)
            _, _, col = tsdf.lookup(q)
            fill[todo] = col
        got = ~torch.isnan(fill[:, 0])
        lin[miss[got]] = fill[got]
        n_vox = int(got.sum())
        seen[miss[got]] = True
    # floor texels still without a colour (the fill under holes): the floor as the views saw it from above, painted
    # in across the holes (the splats' own floor colours when the views saw too little floor)
    flo = from_views & (P[:, 1].abs() < 0.15) & (Nn[:, 1] > 0.5)
    if int(flo.sum()) >= 200:
        img, ox, oz, cell = paint_floor_map(P[flo].cpu().numpy(), lin[flo].cpu().numpy(), np.ones(int(flo.sum())), room)
    else:
        img, ox, oz, cell = floor_colours(room)
    miss = torch.nonzero(~seen & (P[:, 1] < 0.15) & (P[:, 1] > FLOOR_BACKSTOP_Y - 0.05) & (Nn[:, 1] > 0.5)).squeeze(1)
    n_floor = int(miss.numel())
    if n_floor:
        fm = torch.as_tensor(img, dtype=torch.float32, device=dev).permute(2, 0, 1)[None]
        h, w = img.shape[:2]
        gx = (P[miss, 0] - ox) / (cell * w) * 2 - 1
        gz = (P[miss, 2] - oz) / (cell * h) * 2 - 1
        col = F.grid_sample(fm, torch.stack([gx, gz], dim=1)[None, None], mode="bilinear", padding_mode="border",
                            align_corners=False)[0, :, 0].T
        lin[miss] = col
        seen[miss] = True
    lin_np = lin.cpu().numpy()
    seen_np = seen.cpu().numpy()
    fv_np = from_views.cpu().numpy()
    o = 0
    for ch, (rows, cols, _, _) in zip(chunks, parts):
        n = len(rows)
        T = ch.size
        im = np.zeros((T, T, 3), np.float32)
        have = np.zeros((T, T), bool)
        ok = seen_np[o:o + n]
        im[rows[ok], cols[ok]] = lin_np[o:o + n][ok]
        have[rows[ok], cols[ok]] = True
        ch.stats.update({"texels": int(n), "fromViews": round(float(fv_np[o:o + n].mean()) if n else 0.0, 3)})
        ch.image = finish_image(im, have)
        o += n
    nv = int(fv_np.sum())
    log(f"baked {M} texels: {nv / max(M, 1) * 100:.1f}% from views, {n_vox / max(M, 1) * 100:.1f}% from voxel colours, "
        f"{n_floor / max(M, 1) * 100:.1f}% from the floor map")
    return {"texels": M, "fromViews": round(nv / max(M, 1), 4), "fromVoxels": round(n_vox / max(M, 1), 4),
            "fromFloorMap": round(n_floor / max(M, 1), 4)}


def add_underside(ch: Chunk, depth: float = FLOOR_UNDERSIDE_M) -> None:
    """Closes a flat chunk (the floor fill) into a thin slab: a copy of its faces `depth` lower, facing down, on the
    same texels. A mesh with no thickness at all has a zero-height size in Roblox."""
    n = len(ch.V)
    ch.V = np.concatenate([ch.V, ch.V - np.array([0.0, depth, 0.0])])
    ch.N = np.concatenate([ch.N, -ch.N])
    ch.UV = np.concatenate([ch.UV, ch.UV])
    ch.F = np.concatenate([ch.F, ch.F[:, [0, 2, 1]] + n])


def finish_image(lin: np.ndarray, have: np.ndarray, grow: int = 12) -> np.ndarray:
    """Grows the baked texels outward (so filtering and mip levels never pull in black), fills the rest with the
    mean, and encodes to sRGB bytes."""
    import cv2

    img = lin.copy()
    m = have.astype(np.float32)
    mean = img[have].mean(axis=0) if have.any() else np.array([0.2, 0.2, 0.2], np.float32)
    for _ in range(grow):
        if m.all():
            break
        s = cv2.blur(img * m[..., None], (3, 3), borderType=cv2.BORDER_REPLICATE)
        c = cv2.blur(m, (3, 3), borderType=cv2.BORDER_REPLICATE)
        new = (m == 0) & (c > 0)
        img[new] = s[new] / c[new][:, None]
        m[new] = 1.0
    img[m == 0] = mean
    return np.clip(np.round(linear_to_srgb_np(img) * 255.0), 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------------------------------------------
# GLB
# --------------------------------------------------------------------------------------------------------------


def encode_jpeg(img: np.ndarray, quality: int = 85) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def glb_bytes(chunks: list[Chunk], centres: list[np.ndarray], extras: dict, jpeg_quality: int = 85,
              vertex_colours: list[np.ndarray] | None = None) -> bytes:
    """A glTF 2.0 binary with one node + mesh + material per chunk. Positions are relative to the node translation
    (studs); a chunk without an image is drawn with vertex colours (COLOR_0) instead of a texture."""
    S = STUDS_PER_METER
    bin_parts: list[bytes] = []
    offset = 0
    views, accessors, meshes, nodes, materials, textures, images = [], [], [], [], [], [], []

    def add_view(data: bytes, target: int | None = None) -> int:
        nonlocal offset
        pad = (-offset) % 4
        if pad:
            bin_parts.append(b"\0" * pad)
            offset += pad
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        views.append(bv)
        bin_parts.append(data)
        offset += len(data)
        return len(views) - 1

    def add_accessor(arr: np.ndarray, ctype: int, kind: str, target: int, minmax: bool = False) -> int:
        acc = {"bufferView": add_view(arr.tobytes(), target), "componentType": ctype, "count": int(len(arr)), "type": kind}
        if minmax:
            acc["min"] = [float(x) for x in arr.min(axis=0)]
            acc["max"] = [float(x) for x in arr.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    for k, ch in enumerate(chunks):
        pos = ((ch.V * S) - centres[k]).astype(np.float32)
        attrs = {
            "POSITION": add_accessor(pos, 5126, "VEC3", 34962, minmax=True),
            "NORMAL": add_accessor(ch.N.astype(np.float32), 5126, "VEC3", 34962),
        }
        mat: dict[str, Any] = {"name": ch.name, "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 1.0}}
        if ch.image is not None:
            attrs["TEXCOORD_0"] = add_accessor(ch.UV.astype(np.float32), 5126, "VEC2", 34962)
            images.append({"bufferView": add_view(encode_jpeg(ch.image, jpeg_quality)), "mimeType": "image/jpeg", "name": ch.name})
            textures.append({"sampler": 0, "source": len(images) - 1})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(textures) - 1}
        elif vertex_colours is not None:
            attrs["COLOR_0"] = add_accessor(vertex_colours[k].astype(np.float32), 5126, "VEC3", 34962)
        materials.append(mat)
        idx = ch.F.reshape(-1)
        if len(ch.V) < 65536:
            ia = add_accessor(idx.astype(np.uint16), 5123, "SCALAR", 34963)
        else:
            ia = add_accessor(idx.astype(np.uint32), 5125, "SCALAR", 34963)
        meshes.append({"name": ch.name, "primitives": [{"attributes": attrs, "indices": ia, "material": k, "mode": 4}]})
        nodes.append({"name": ch.name, "mesh": k, "translation": [round(float(c), 4) for c in centres[k]]})

    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "Déjà View roblox_mesh", "extras": extras},
        "scene": 0,
        "scenes": [{"name": extras.get("name", "room"), "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": offset}],
    }
    if images:
        gltf["images"] = images
        gltf["textures"] = textures
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    js = json.dumps(gltf, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(bin_parts)
    binary += b"\0" * ((-len(binary)) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------------------------------------------
# The whole build
# --------------------------------------------------------------------------------------------------------------


def _device(name: str | None) -> Any:
    import torch

    if name:
        return torch.device(name)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def build_model(scene_dir: Path | str, out_dir: Path | str | None = None, triangles: int = DEFAULT_TRIANGLES,
                texture: int = DEFAULT_TEXTURE, voxel: float | None = None, positions: int = MAX_POSITIONS,
                face_res: int = FACE_RES, textured: bool = True, device: str | None = None, workers: int = 8,
                key: str | None = None, sheet: Path | str | None = None, hole_edges: int = HOLE_EDGES,
                log: Callable[[str], None] = _log_noop) -> dict:
    t0 = time.time()
    timings: dict[str, float] = {}

    def lap(name: str, since: float) -> float:
        now = time.time()
        timings[name] = round(now - since, 2)
        return now

    import torch

    scene_dir = Path(scene_dir)
    out_dir = Path(out_dir) if out_dir else scene_dir
    triangles = int(max(MIN_TRIANGLES, min(MAX_TRIANGLES, triangles)))
    texture = int(max(128, min(4096, texture)))
    dev = _device(device)
    try:
        room = load_room(scene_dir, log)
    except rmap.MapError as e:
        raise MeshError(str(e))
    t = lap("load", t0)

    views, stands = plan_views(room, positions, face_res)
    renderer = Renderer(room, dev)
    shots, view_stats = render_views(renderer, views, log)
    if not shots:
        raise MeshError("every view of this world is empty")
    if sheet:
        write_sheet(shots, Path(sheet))
    del renderer
    t = lap("render", t)

    v = choose_voxel(shots, room, voxel, log)
    tsdf = Tsdf(shots, room, v, MAX_VOXELS_GPU if dev.type == "cuda" else MAX_VOXELS_CPU, log)
    for s in shots:
        tsdf.integrate(s)
    if dev.type == "cuda":
        torch.cuda.synchronize()
    t = lap("fuse", t)

    V, F = tsdf.surface(log)
    t = lap("surface", t)

    dense = len(F)
    V, F = compact(V, F)
    c = V[F].mean(axis=1)
    inside = np.all((c >= room.lo) & (c <= room.hi), axis=1)
    V, F = compact(V, F[inside])
    if len(F) == 0:
        raise MeshError("nothing of the surface is inside the room")
    # faces wind counter-clockwise seen from free space: the field one voxel along the normal should be freer than
    # one voxel against it (a safety check of the marching cubes convention)
    fn, _ = face_normals(V, F)
    cc = V[F].mean(axis=1)
    pick = np.linspace(0, len(F) - 1, min(len(F), 20000)).astype(np.int64)
    Pc = torch.as_tensor(cc[pick], dtype=torch.float32, device=dev)
    Nc = torch.as_tensor(fn[pick], dtype=torch.float32, device=dev)
    ahead, _, _ = tsdf.lookup(Pc + Nc * (1.5 * tsdf.v))
    behind, _, _ = tsdf.lookup(Pc - Nc * (1.5 * tsdf.v))
    if float((ahead > behind).float().mean()) < 0.5:
        F = F[:, [0, 2, 1]]
        log("faces flipped to face free space")
    room_idx, lid_idx, lid_h = split_ceiling(V, F, log)
    keep = np.concatenate([room_idx, lid_idx])
    n_sky = 0
    if lid_h is None:
        # outdoors: the underside of a splat sky (high, facing down) is not part of the place
        fn, _ = face_normals(V, F[keep])
        sky = (V[F[keep]].mean(axis=1)[:, 1] > SKY_MIN_Y) & (fn[:, 1] < -0.35)
        n_sky = int(sky.sum())
        keep = keep[~sky]
    # the far side of the ground: only someone under the floor would see it, and it costs triangles
    fn, _ = face_normals(V, F[keep])
    underside = (V[F[keep]].mean(axis=1)[:, 1] < UNDERSIDE_Y) & (fn[:, 1] < -0.5)
    n_underside = int(underside.sum())
    keep = keep[~underside]
    Vr, Fr = compact(V, F[keep])
    _, area = face_normals(Vr, Fr)
    min_piece = max(MIN_COMPONENT_M2, 2e-4 * float(area.sum()))
    airborne = AIRBORNE_MAX_M2 if lid_h is not None else AIRBORNE_SKY_M2
    Vr, Fr, n_small = drop_small_components(Vr, Fr, min_piece, airborne)
    if len(Fr) == 0:
        raise MeshError("nothing is left of the room after cleaning it up")
    Vr, Fr, n_holes = fill_holes(Vr, Fr, hole_edges)
    log(f"clean-up: {n_small} small or airborne pieces, {n_sky} sky faces and {n_underside} faces under the ground "
        f"dropped, {n_holes} holes closed")
    t = lap("clean", t)

    Vf, Ff, open_m2 = floor_fill(Vr, Fr, room)
    fill_m2 = float(face_normals(Vf, Ff)[1].sum()) if len(Ff) else 0.0
    if len(Ff):
        log(f"floor fill: {len(Ff) // 2} tiles, {fill_m2:.1f} m2 ({open_m2:.1f} m2 where the floor is open)")
    # room and lid are decimated as one mesh (no cracks where they meet), then the lid is split off again; the floor
    # fill gets an underside later, so it counts twice
    rim_before = boundary_edges(Fr)
    target = triangles - 2 * len(Ff)
    n_turned = n_late = 0
    # decimation cuts thin bridges: pieces of sky or canopy that hung on the room by one are airborne after it. So
    # first to a little over the budget, drop what came loose, then to the budget (the dropped part costs nothing)
    for budget in (int(target * 1.4), target):
        if len(Fr) <= budget:
            continue
        Vr, Fr = decimate(Vr, Fr, budget)
        Fr, turned = orient_faces(Vr, Fr, tsdf)
        Vr, Fr, late = drop_small_components(Vr, Fr, min_piece, airborne)
        n_turned, n_late = n_turned + turned, n_late + late
    rim_after = boundary_edges(Fr)
    Vr, Fr, n_split = split_opposed(Vr, Fr)
    Nr = vertex_normals(Vr, Fr)  # before the lid split, so room and lid shade alike where they meet
    log(f"decimated: {n_turned} faces turned toward free space, {n_late} pieces cut loose and dropped, {n_split} "
        f"vertices split between opposite sides; boundary edges {rim_before} -> {rim_after}")
    lid = np.zeros(len(Fr), bool)
    if lid_h is not None:
        n, _ = face_normals(Vr, Fr)
        lid = (n[:, 1] < -0.5) & (Vr[Fr].mean(axis=1)[:, 1] > lid_h - 0.15)
    groups = [("room", Vr, Fr[~lid], Nr, texture)]
    if lid.any():
        groups.append(("ceiling", Vr, Fr[lid], Nr, texture))
    if len(Ff):
        groups.append(("floor", Vf, Ff, vertex_normals(Vf, Ff), min(texture, FLOOR_TEXTURE)))
    t = lap("decimate", t)

    parts = []
    for kind, Vg, Fg, Ng, size in groups:
        limit = CHUNK_TRIANGLES // 2 if kind == "floor" else CHUNK_TRIANGLES
        for k, idx in enumerate(kd_chunks(Vg, Fg, limit, ROOM_CHUNKS if kind == "room" else 1)):
            used, inv = np.unique(Fg[idx], return_inverse=True)
            parts.append(Part(f"{kind}_{k:02d}", kind, Vg[used], inv.reshape(-1, 3), Ng[used], size))
    chunks = build_atlases(parts, workers)
    t = lap("atlas", t)

    bake_stats: dict = {}
    vcols = None
    if textured:
        bake_stats = bake(chunks, shots, tsdf, room, log)
    else:
        vcols = []
        for ch in chunks:
            _, _, col = tsdf.lookup(torch.as_tensor(ch.V, dtype=torch.float32, device=dev))
            col = col.cpu().numpy()
            col = np.where(np.isnan(col), 0.2, col)
            vcols.append(linear_to_srgb_np(col))
            ch.image = None
    for k, ch in enumerate(chunks):
        if ch.kind == "floor":
            add_underside(ch)
            if vcols is not None:
                vcols[k] = np.concatenate([vcols[k], vcols[k]])
    t = lap("bake", t)

    S = STUDS_PER_METER
    centres = []
    chunk_meta = []
    allV = np.concatenate([ch.V for ch in chunks]) * S
    for ch in chunks:
        lo_s, hi_s = ch.V.min(axis=0) * S, ch.V.max(axis=0) * S
        centre = np.round((lo_s + hi_s) / 2, 3)
        centres.append(centre)
        chunk_meta.append({
            "name": ch.name, "kind": ch.kind, "triangles": int(len(ch.F)), "vertices": int(len(ch.V)),
            "center": [float(x) for x in centre], "size": [round(float(x), 3) for x in hi_s - lo_s], **ch.stats,
        })
    vm = room.voxel_map
    name = str(room.scene.get("name") or room.scene.get("id") or scene_dir.name)[:80]
    extras = {"sceneId": str(room.scene.get("id") or scene_dir.name), "name": name, "units": "studs",
              "studsPerMeter": S}
    for quality in (85, 75, 65, 55):
        glb = glb_bytes(chunks, centres, extras, jpeg_quality=quality, vertex_colours=vcols)
        if len(glb) <= MAX_GLB_BYTES:
            break
    if len(glb) > MAX_GLB_BYTES:
        log(f"the model is {len(glb) / 1e6:.1f} MB even at JPEG quality {quality}: too big for one Roblox upload")
    sha1 = hashlib.sha1(glb).hexdigest()
    n_room = sum(m["triangles"] for m in chunk_meta if m["kind"] == "room")
    n_lid = sum(m["triangles"] for m in chunk_meta if m["kind"] == "ceiling")
    n_fill = sum(m["triangles"] for m in chunk_meta if m["kind"] == "floor")
    result = {
        "version": MODEL_VERSION,
        "sceneId": extras["sceneId"],
        "name": name,
        "file": GLB_FILE,
        "bytes": len(glb),
        "sha1": sha1,
        "units": "studs",
        "studsPerMeter": S,
        "frame": "room frame x studsPerMeter, axis for axis: Y up, -Z forward, floor at y = 0 (the voxel map's frame)",
        "import": {"scaleUnit": "Stud", "note": "Positions are already studs: keep the importer's Scale Unit on Stud."},
        "spawn": vm.get("spawn"),
        "spawnYaw": vm.get("spawnYaw"),
        "headsetSpawn": vm.get("headsetSpawn"),
        "ceilingY": round(lid_h * S, 2) if lid_h else vm.get("ceilingY"),
        "hasCeiling": bool(n_lid),
        "floorY": round(room.floor_y, 4),
        "bounds": {"min": [round(float(x), 2) for x in allV.min(axis=0)],
                   "max": [round(float(x), 2) for x in allV.max(axis=0)]},
        "triangles": n_room + n_lid + n_fill,
        "roomTriangles": n_room,
        "ceilingTriangles": n_lid,
        "floorFillTriangles": n_fill,
        "floorFillM2": round(fill_m2, 2),
        "floorOpenM2": round(open_m2, 2),
        "textureSize": texture if textured else 0,
        "jpegQuality": quality if textured else None,
        "maxTrianglesPerChunk": CHUNK_TRIANGLES,
        "chunks": chunk_meta,
        "build": {
            "version": MODEL_VERSION,
            "device": f"{dev.type}{' gsplat' if sio.gsplat_available() and dev.type == 'cuda' else ''}",
            "positions": len(stands),
            "standing": stands,
            "views": view_stats,
            "voxel": tsdf.v,
            "truncation": round(tsdf.trunc, 4),
            "blocks": int(len(tsdf.blocks)),
            "denseTriangles": int(dense),
            "smallComponentsDropped": n_small,
            "skyFacesDropped": n_sky,
            "undersideFacesDropped": n_underside,
            "holesClosed": n_holes,
            "holeEdges": hole_edges,
            "facesTurned": n_turned,
            "piecesCutLoose": n_late,
            "verticesSplit": n_split,
            "boundaryEdges": {"beforeDecimation": rim_before, "afterDecimation": rim_after},
            "bake": bake_stats,
            "splats": len(room.splats),
            "spawnSource": vm.get("source"),
            "seconds": timings,
        },
    }
    if key:
        result["build"]["key"] = key
    write_atomic(out_dir / GLB_FILE, glb)
    result["build"]["seconds"]["write"] = round(time.time() - t, 2)
    result["build"]["seconds"]["total"] = round(time.time() - t0, 2)
    write_atomic(out_dir / SIDECAR_FILE, json.dumps(result, indent=1).encode("utf-8"))
    log(f"{len(chunks)} chunks, {n_room} room + {n_lid} ceiling + {n_fill} floor fill triangles, {len(glb) / 1e6:.1f} MB "
        f"in {time.time() - t0:.1f} s")
    return result


def write_sheet(shots: list[Shot], path: Path, cols: int = 6, size: int = 192) -> None:
    """A contact sheet of the first standing position's faces and the overviews (debugging): each view, then the
    same view with the pixels that give no depth painted magenta."""
    import torch
    import torch.nn.functional as F

    pick = [s for s in shots if s.view.kind == "cube" and s.view.position == 0] + [s for s in shots if s.view.kind == "overview"]
    imgs = []
    for s in pick[:12]:
        x = F.interpolate(s.rgb.permute(2, 0, 1)[None], size=(size, size), mode="area")[0].permute(1, 2, 0)
        m = F.interpolate(s.valid[None, None].float(), size=(size, size), mode="area")[0, 0, :, :, None]
        bad = torch.tensor([0.9, 0.1, 0.8], device=x.device)
        imgs.append((x.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
        imgs.append(((x * m + bad * (1 - m)).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
    if imgs:
        sheet = sio.contact_sheet(imgs, cols=cols)
        path.parent.mkdir(parents=True, exist_ok=True)
        from PIL import Image

        Image.fromarray(sheet).save(str(path))


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scene splat world -> textured Roblox model (.glb in studs + sidecar)")
    ap.add_argument("--scene", required=True, help="scene directory (holds scene.json)")
    ap.add_argument("--out", help="output directory (default: the scene directory)")
    ap.add_argument("--triangles", type=int, default=DEFAULT_TRIANGLES, help="total triangle budget")
    ap.add_argument("--texture", type=int, default=DEFAULT_TEXTURE, help="texture size per chunk (px, square)")
    ap.add_argument("--voxel", type=float, help="TSDF voxel in metres (default: from the seen surface area)")
    ap.add_argument("--hole-edges", type=int, default=HOLE_EDGES, help="close holes whose rim has at most this many edges")
    ap.add_argument("--positions", type=int, default=MAX_POSITIONS, help="standing positions for cube maps")
    ap.add_argument("--face-res", type=int, default=FACE_RES, help="cube face size in pixels")
    ap.add_argument("--no-texture", action="store_true", help="vertex colours only (no atlas images)")
    ap.add_argument("--device", help="torch device (default: cuda when available)")
    ap.add_argument("--workers", type=int, default=8, help="processes for the UV atlases")
    ap.add_argument("--key", help="cache key stored in build.key")
    ap.add_argument("--sheet", help="also write a contact sheet PNG of some rendered views")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    log = _log_noop if args.quiet else (lambda m: print(f"[roblox_mesh] {m}", file=sys.stderr, flush=True))
    try:
        r = build_model(args.scene, args.out, args.triangles, args.texture, args.voxel, args.positions, args.face_res,
                        not args.no_texture, args.device, args.workers, args.key, args.sheet, args.hole_edges, log)
    except MeshError as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        print(f"roblox_mesh: {e}", file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "triangles": r["triangles"], "chunks": len(r["chunks"]), "bytes": r["bytes"],
                      "seconds": r["build"]["seconds"]["total"], "out": str(Path(args.out or args.scene) / GLB_FILE)}),
          flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
