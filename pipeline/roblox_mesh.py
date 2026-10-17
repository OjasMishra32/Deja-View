#!/usr/bin/env python3
"""Turns a scene's splat world into a textured Roblox model: one .glb of chunked, textured meshes in studs.

  python pipeline/roblox_mesh.py --scene data/scenes/<id> [--out DIR] [--triangles N] [--texture PX] [--key K]
  python pipeline/roblox_mesh.py --v2 --scene data/scenes/<id> --photos <reconstruction work folder> [--out DIR]
         [--triangles 600000] [--near-margin 1.5] [--max-parts N] [--no-sky] [--flat-ceiling M]

v2 (a reconstructed world with cameras.json and its photos/frames; see "v2" below build_model) meshes only the
walkable area (world.bounds + a margin) at a finer voxel, textures it from the real photos (colour-matched to the
splats, people masked, depth-tested against the mesh), writes roblox.glb, roblox-2.glb ... (each under 20 MB) and a
six-face skybox of everything farther (sky-front.png ... in Roblox's Sky face convention). The sidecar lists `parts`
and `sky`; server/social/roblox-model.ts uploads them. What follows describes v1.

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
    f: float  # focal length in pixels (x); square pixels and the principal point at the centre unless given below
    size: int
    kind: str  # "cube", "overview" or "photo" (a training camera, rendered from the splats)
    position: int = -1  # index of the standing position (cube faces)
    w: int = 0  # image width and height (default: size x size)
    h: int = 0
    fy: float = 0.0  # focal length in pixels (y; default f)
    cx: float = -1.0  # principal point (default: the image centre)
    cy: float = -1.0

    def __post_init__(self) -> None:
        if not self.w:
            self.w = self.size
        if not self.h:
            self.h = self.size
        if not self.fy:
            self.fy = self.f
        if self.cx < 0:
            self.cx = self.w / 2.0
        if self.cy < 0:
            self.cy = self.h / 2.0


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
    alpha: Any = None  # torch [H, W] accumulated opacity (v2 keeps it: a faint ceiling is still a ceiling)
    ed: Any = None  # torch [H, W] expected depth in metres wherever alpha > 0 (depth above is zeroed below alpha 0.5)


class Renderer:
    """Renders room-frame cameras from the world's splats (file frame) with gsplat, or the CPU point renderer."""

    def __init__(self, room: Room, device: Any):
        import torch

        self.room = room
        self.device = device
        self.keep_alpha = False
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
        W0, H0 = views[0].w, views[0].h
        assert all(v.w == W0 and v.h == H0 for v in views), "one batch renders one image size"
        if self.gpu:
            from gsplat import rasterization

            vm = np.stack([sio.c2w_gl_to_cv_w2c(self.file_c2w(v.c2w)) for v in views]).astype(np.float32)
            K = np.stack([np.array([[v.f, 0, v.cx], [0, v.fy, v.cy], [0, 0, 1]], np.float32) for v in views])
            with torch.no_grad():
                out, alpha, _ = rasterization(
                    self.t["means"], self.t["quats"], self.t["scales"], self.t["opac"], self.t["sh"],
                    torch.from_numpy(vm).to(self.device), torch.from_numpy(K).to(self.device), W0, H0,
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
                    r = sio.render_points(self.room.splats, self.file_c2w(v.c2w), v.f, v.fy, v.cx, v.cy, v.w, v.h)
                except ValueError:  # nothing in view at all
                    r = sio.Render(np.zeros((v.h, v.w, 3), np.uint8), np.zeros((v.h, v.w), np.float32),
                                   np.zeros((v.h, v.w), np.float32), "points")
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
            shots.append(Shot(v, rgbs[k].float().contiguous(), d.contiguous(), valid, float((a >= 0.5).float().mean()),
                              a.contiguous() if self.keep_alpha else None,
                              depths[k].float().contiguous() if self.keep_alpha else None))
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
    pc = torch.stack([(u - v.cx) / v.f * z, -(vv - v.cy) / v.fy * z, -z], dim=1)
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
    return view.cx + view.f * pc[:, 0] / zs, view.cy - view.fy * pc[:, 1] / zs, z


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
                          airborne_m2: float = AIRBORNE_MAX_M2, keep_m2: float | None = None,
                          keep_below_y: float = 1.2) -> tuple[np.ndarray, np.ndarray, int]:
    """Drops connected pieces smaller than `min_area`, and airborne ones (entirely above AIRBORNE_MIN_Y and smaller
    than `airborne_m2`): bits of a splat sky, floaters. With `keep_m2`, a smaller piece of at least keep_m2 that
    reaches below keep_below_y stays (a chair leg, a table frame: thin things standing on the floor fall apart into
    small pieces). Returns the mesh and how many pieces went."""
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
    small = comp_area < min_area
    if keep_m2 is not None:
        small &= ~((comp_area >= keep_m2) & (low < keep_below_y))
    bad = small | ((low > AIRBORNE_MIN_Y) & (comp_area < airborne_m2))
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
              vertex_colours: list[np.ndarray] | None = None, jpegs: list[bytes] | None = None) -> bytes:
    """A glTF 2.0 binary with one node + mesh + material per chunk. Positions are relative to the node translation
    (studs); a chunk without an image is drawn with vertex colours (COLOR_0) instead of a texture. `jpegs` (one per
    chunk) are already encoded textures, used instead of encoding the chunks' images again."""
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
            data = jpegs[k] if jpegs is not None else encode_jpeg(ch.image, jpeg_quality)
            images.append({"bufferView": add_view(data), "mimeType": "image/jpeg", "name": ch.name})
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
                room_override: "Room | None" = None, views_override: "tuple[list[View], list] | None" = None,
                ink: float | None = None, room_chunks: int = ROOM_CHUNKS,
                chunk_triangles: int = CHUNK_TRIANGLES, min_component: float | None = None,
                airborne_m2: float | None = None, log: Callable[[str], None] = _log_noop) -> dict:
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
    if room_override is not None:
        room = room_override
    else:
        try:
            room = load_room(scene_dir, log)
        except rmap.MapError as e:
            raise MeshError(str(e))
    t = lap("load", t0)

    if views_override is not None:
        views, stands = views_override
    else:
        views, stands = plan_views(room, positions, face_res)
    renderer = Renderer(room, dev)
    shots, view_stats = render_views(renderer, views, log)
    if not shots:
        raise MeshError("every view of this world is empty")
    if ink:
        from objects.ink import ink_tensor
        for s in shots:
            s.rgb = ink_tensor(s.rgb, strength=float(ink))
        log(f"ink pass on {len(shots)} views (strength {ink})")
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
    min_piece = max(MIN_COMPONENT_M2 if min_component is None else float(min_component),
                    2e-4 * float(area.sum()))
    airborne = (AIRBORNE_MAX_M2 if lid_h is not None else AIRBORNE_SKY_M2) if airborne_m2 is None else float(airborne_m2)
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
        limit = CHUNK_TRIANGLES // 2 if kind == "floor" else chunk_triangles
        for k, idx in enumerate(kd_chunks(Vg, Fg, limit, room_chunks if kind == "room" else 1)):
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
# v2: a reconstructed world (photos + clips with known cameras) -> the walkable area as a photo-textured mesh, in
# several .glb parts, and everything farther as a six-face skybox
# --------------------------------------------------------------------------------------------------------------
#
# What changes against v1 (build_model):
#  - geometry only inside the walkable area (world.bounds) plus a margin; the TSDF also takes depth rendered from the
#    splats at every training camera (where the splats are most accurate), at a finer voxel, and big planes (floor,
#    walls, ceiling, table tops) are snapped flat before decimating to a bigger budget (600k triangles by default);
#  - chunks are cut by triangles AND area, so a big floor gets as many texels per metre as a cluttered corner;
#  - textures come from the real photos and frames: each one undistorted, people masked out, its colours matched to
#    the splat render from the same camera (so the room has the splat viewer's exposure), projected onto the mesh with
#    a depth test against the mesh itself (a z-buffer of the final triangles) and blended per texel by how well it
#    sees the texel (resolution x obliquity x sharpness x distance from the image or mask edge, raised to a power: the
#    best view dominates, neighbours fade in across seams). Only texels no photo sees fall back to splat renders;
#  - beyond the margin there is no geometry: six cube faces rendered from the splats outside the walkable box, from
#    the spawn at standing eye height, in Roblox's Sky face convention (sky-front.png ... sky-down.png);
#  - the model is written as several .glb files of at most PART_MAX_BYTES each (Open Cloud takes 20 MB per asset):
#    roblox.glb holds the chunks nearest the spawn, roblox-2.glb ... the rest, all in the same frame.
#
# Roblox Sky faces (Creator Hub, Environment > Skyboxes: the six SkyboxBk/Dn/Ft/Lf/Rt/Up properties and the net in
# which, seen from inside, Left, Back, Right and Front follow each other turning right), in the room frame (= Roblox
# world frame of the model: Y up, -Z forward). Checked against Roblox's own default sky (the sky512_*.tex faces the
# Sky properties default to, shipped with the Roblox app): it folds seamlessly in exactly this layout (Lf to the right
# of Ft, Up's top edge on Lf, Dn's top edge on Rt; every other side order or Up/Dn rotation leaves seams 8-20x the
# in-face gradient). Ft looking -Z (NormalId.Front) is from Roblox capture scripts; seams cannot show the absolute yaw.
# Look direction and image-up of each face:
SKY_FACES = {
    "front": ((0.0, 0.0, -1.0), (0.0, 1.0, 0.0)),  # SkyboxFt
    "left": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),  # SkyboxLf (to the RIGHT of front, per the official net)
    "back": ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),  # SkyboxBk
    "right": ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),  # SkyboxRt
    "up": ((0.0, 1.0, 0.0), (1.0, 0.0, 0.0)),  # SkyboxUp: image top toward +X (the left face)
    "down": ((0.0, -1.0, 0.0), (-1.0, 0.0, 0.0)),  # SkyboxDn: image top toward -X (the right face)
}
SKY_PROPERTY = {"front": "SkyboxFt", "back": "SkyboxBk", "left": "SkyboxLf", "right": "SkyboxRt", "up": "SkyboxUp",
                "down": "SkyboxDn"}

V2_VERSION = 2
V2_TRIANGLES = 600_000
V2_MAX_TRIANGLES = 1_200_000
V2_VOXEL_MIN_M = 0.015
V2_SURFACE_CELLS = 12_000_000
V2_POSITIONS = 24  # standing cube maps (the training cameras do most of the work now)
NEAR_MARGIN_M = 1.5  # geometry this far around world.bounds; beyond it the skybox
CHUNK_AREA_M2 = 20.0  # at most this much surface per 1024 px chunk (about 6 mm per texel)
PART_MAX_BYTES = 19_500_000  # per .glb (Open Cloud: 20 MB per asset)
PHOTO_DEPTH_SCALE = 0.5  # training cameras are rendered (and z-buffered) at this fraction of their size
PHOTO_POWER = 8.0  # blend weight = (score / best score) ** power
PHOTO_MIN_COS = 0.2
FEATHER_FRAC = 0.04  # scores fade to 0 within this fraction of the image width of the image or mask edge
MASK_GROW_FRAC = 0.006  # people masks grow by this fraction of the width (motion blur, hair)
SKY_SIZE = 1024
SKY_EYE_M = 1.6
PLANE_TOL_M = 0.025
PLANE_MIN_M2 = 1.5
KEEP_PIECE_M2 = 0.015  # small pieces this big that reach below 1.2 m stay (chair and table legs)
CEILING_MIN_M2 = 4.0  # a ceiling fill needs at least this much down-facing surface at one height
WALL_CELL_M2 = 0.25  # a 25 cm cell holds a wall when this much vertical surface stands in it under the ceiling
WALL_MIN_CELLS = 8  # ... in a run of at least this many cells (2 m) that reaches the fused ceiling (not a tree trunk)
FLAT_CEILING_KEEP_M = 0.08  # --flat-ceiling: fused faces facing down this close to the ceiling height are its flat parts
FLAT_WALL_KEEP_M = 0.25  # ... and what stands this close to the room's walls (their top, the corner with the ceiling)


def near_box(room: Room, margin: float = NEAR_MARGIN_M) -> tuple[np.ndarray, np.ndarray, str]:
    """The box the mesh covers (room frame metres): the scene's walkable bounds (world.bounds, the camera coverage of
    a reconstruction) grown by `margin` sideways and a little in height; v1's room box when there are no bounds."""
    b = (room.scene.get("world") or {}).get("bounds")
    try:
        lo = np.array([float(x) for x in b["min"]], np.float64)
        hi = np.array([float(x) for x in b["max"]], np.float64)
        if lo.shape != (3,) or hi.shape != (3,) or not np.all(hi > lo):
            raise ValueError
    except (TypeError, KeyError, ValueError):
        return room.lo.copy(), room.hi.copy(), "room box"
    lo[1] -= room.floor_y
    hi[1] -= room.floor_y
    lo = np.array([lo[0] - margin, -0.3, lo[2] - margin])
    hi = np.array([hi[0] + margin, max(hi[1] + 0.3, 2.5), hi[2] + margin])
    return lo, hi, "world.bounds"


# ---------------------------------------------------------------- the training cameras and their images


@dataclass
class PhotoCam:
    name: str
    group: str
    c2w: np.ndarray  # room frame, OpenGL (looks down -Z)
    fx: float
    fy: float
    cx: float
    cy: float
    w: int
    h: int
    dist: dict  # radial distortion of the source image (k1, k2), undone before projecting
    image: Path
    mask: Path | None  # 255 = use, 0 = a person (COLMAP mask naming: <image>.png)


def load_photo_cams(scene_dir: Path, photos: Path, floor_y: float, log: Callable[[str], None]) -> list[PhotoCam]:
    """The scene's cameras.json (every solved photo and clip frame, viewer frame) with the images of the
    reconstruction's work folder (images/<group>/<name>, masks/<group>/<name>.png)."""
    js = json.loads((scene_dir / "cameras.json").read_text())
    out, missing = [], 0
    for c in js.get("cameras", []):
        img = photos / "images" / c["name"]
        if not img.exists():
            missing += 1
            continue
        m = photos / "masks" / f"{c['name']}.png"
        c2w = np.asarray(c["c2w"], np.float64).copy()
        c2w[1, 3] -= floor_y
        k = c["intrinsics"]
        out.append(PhotoCam(str(c["name"]), str(c.get("group", "")), c2w, float(k["fx"]), float(k["fy"]), float(k["cx"]),
                            float(k["cy"]), int(k["width"]), int(k["height"]), dict(c.get("distortion") or {}), img,
                            m if m.exists() else None))
    groups: dict[str, int] = {}
    for c in out:
        groups[c.group] = groups.get(c.group, 0) + 1
    log(f"training cameras: {len(out)} with images ({groups}), {missing} without; "
        f"{sum(1 for c in out if c.mask)} with people masks")
    return out


def photo_views(cams: list[PhotoCam], scale: float = PHOTO_DEPTH_SCALE) -> list[View]:
    views = []
    for k, c in enumerate(cams):
        w, h = int(round(c.w * scale)), int(round(c.h * scale))
        views.append(View(c.c2w, c.fx * scale, max(w, h), "photo", k, w=w, h=h, fy=c.fy * scale, cx=c.cx * scale,
                          cy=c.cy * scale))
    return views


def render_photo_shots(renderer: Renderer, views: list[View], log: Callable[[str], None], batch: int = 6) -> list[Shot]:
    """Splat renders (RGB + depth) from every training camera, in batches of one image size."""
    shots: list[Shot] = []
    by_size: dict[tuple[int, int], list[View]] = {}
    for v in views:
        by_size.setdefault((v.w, v.h), []).append(v)
    for group in by_size.values():
        for i in range(0, len(group), batch):
            shots += renderer.render(group[i:i + batch])
    valid = float(np.mean([float(s.valid.float().mean()) for s in shots])) if shots else 0.0
    log(f"rendered the splats from {len(shots)} training cameras; {valid * 100:.0f}% of their pixels give depth")
    return shots


def undistort_maps(c: PhotoCam) -> tuple[np.ndarray, np.ndarray] | None:
    """cv2.remap maps from a pinhole image (same size and intrinsics) into the source image (radial k1, k2), or None
    when the camera has no distortion. Pixel centres at +0.5 (COLMAP)."""
    k1 = float(c.dist.get("k1", 0.0) or 0.0)
    k2 = float(c.dist.get("k2", 0.0) or 0.0)
    if abs(k1) < 1e-9 and abs(k2) < 1e-9:
        return None
    u, v = np.meshgrid(np.arange(c.w, dtype=np.float64) + 0.5, np.arange(c.h, dtype=np.float64) + 0.5)
    x, y = (u - c.cx) / c.fx, (v - c.cy) / c.fy
    r2 = x * x + y * y
    f = 1.0 + k1 * r2 + k2 * r2 * r2
    return (c.fx * x * f + c.cx - 0.5).astype(np.float32), (c.fy * y * f + c.cy - 0.5).astype(np.float32)


def read_photo(c: PhotoCam) -> tuple[np.ndarray, np.ndarray]:
    """(sRGB uint8 [h, w, 3] undistorted, usable mask [h, w] bool): people (grown a little) and pixels the
    undistortion pulls from outside the image are not usable."""
    import cv2

    img = cv2.imread(str(c.image), cv2.IMREAD_COLOR)
    if img is None:
        raise MeshError(f"cannot read {c.image}")
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    if img.shape[0] != c.h or img.shape[1] != c.w:
        img = cv2.resize(img, (c.w, c.h), interpolation=cv2.INTER_AREA)
    if c.mask is not None:
        m = cv2.imread(str(c.mask), cv2.IMREAD_GRAYSCALE)
        m = cv2.resize(m, (c.w, c.h), interpolation=cv2.INTER_NEAREST) if m.shape != (c.h, c.w) else m
        ok = m > 127
        r = max(2, int(round(MASK_GROW_FRAC * c.w)))
        if not ok.all():
            ok = cv2.erode(ok.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0
    else:
        ok = np.ones((c.h, c.w), bool)
    maps = undistort_maps(c)
    if maps is not None:
        mx, my = maps
        img = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        inside = (mx >= 0) & (mx <= c.w - 1) & (my >= 0) & (my <= c.h - 1)
        ok = (cv2.remap(ok.astype(np.uint8), mx, my, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0) & inside
    return img, ok


def colour_match(photo_lin: np.ndarray, ok: np.ndarray, target_lin: np.ndarray, target_ok: np.ndarray,
                 ridge: float = 0.02) -> tuple[np.ndarray, dict]:
    """A 4x3 affine colour transform (linear RGB, rows: r, g, b, 1) taking the photo to the splat render from the same
    camera, fitted on pixels both trust (twice, dropping the worst fifth the second time), pulled toward a per-channel
    gain so it stays plausible where the fit has little to go on. Identity when too few pixels agree."""
    m = ok & target_ok & (photo_lin.max(axis=2) < 0.95) & (photo_lin.max(axis=2) > 0.002)
    n = int(m.sum())
    if n < 2000:
        return np.vstack([np.eye(3), np.zeros((1, 3))]), {"pixels": n, "fit": False}
    X = np.concatenate([photo_lin[m], np.ones((n, 1))], axis=1).astype(np.float64)
    Y = target_lin[m].astype(np.float64)
    keep = np.ones(n, bool)
    A = None
    for _ in range(2):
        Xk, Yk = X[keep], Y[keep]
        g = (Yk.mean(axis=0) + 1e-4) / (Xk[:, :3].mean(axis=0) + 1e-4)
        A0 = np.vstack([np.diag(np.clip(g, 0.2, 5.0)), np.zeros((1, 3))])
        lam = ridge * float(np.trace(Xk.T @ Xk)) / 4.0
        A = np.linalg.solve(Xk.T @ Xk + lam * np.eye(4), Xk.T @ Yk + lam * A0)
        res = np.abs(X @ A - Y).sum(axis=1)
        keep = res <= np.quantile(res, 0.8)
    err0 = float(np.abs(X[:, :3] - Y).mean())
    err1 = float(np.abs(X @ A - Y)[keep].mean())
    return A, {"pixels": n, "fit": True, "gain": [round(float(A[i, i]), 3) for i in range(3)],
               "errBefore": round(err0, 4), "errAfter": round(err1, 4)}


def sharpness(gray: np.ndarray, ok: np.ndarray) -> float:
    """Variance of the Laplacian over the usable pixels (any scale; compared between a photo and its splat render)."""
    import cv2

    lap = cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F, ksize=3)
    okm = cv2.erode(ok.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return float(lap[okm].var()) if okm.sum() > 100 else 0.0


# ---------------------------------------------------------------- a z-buffer of the mesh itself


def zbuffer(T: Any, c2w: np.ndarray, fx: float, fy: float, cx: float, cy: float, W: int, H: int,
            near: float = 0.05, box: int = 8, max_levels: int = 12) -> Any:
    """Z-depth of the nearest triangle at each pixel centre (flattened [H * W], inf where nothing), perspective
    correct, for triangles T [m, 3, 3] (room frame) seen by an OpenGL camera. Triangles that cover more than box x box
    pixels, or cross the near plane, are split in four (in 3D) until they do not."""
    import torch

    dev = T.device
    R = torch.as_tensor(c2w[:3, :3], dtype=torch.float32, device=dev)
    t = torch.as_tensor(c2w[:3, 3], dtype=torch.float32, device=dev)
    zb = torch.full((H * W,), float("inf"), device=dev)
    ar = torch.arange(box, device=dev)
    oy, ox = torch.meshgrid(ar, ar, indexing="ij")
    ox, oy = ox.reshape(-1), oy.reshape(-1)
    tris = T
    for _ in range(max_levels):
        if tris.shape[0] == 0:
            break
        pc = (tris - t) @ R
        z = -pc[..., 2]
        front = (z > near).all(dim=1)
        anyf = (z > near).any(dim=1)
        zs = z.clamp(min=1e-6)
        u = cx + fx * pc[..., 0] / zs
        v = cy - fy * pc[..., 1] / zs
        umin, umax = u.min(dim=1).values, u.max(dim=1).values
        vmin, vmax = v.min(dim=1).values, v.max(dim=1).values
        on = (umax >= 0) & (umin <= W) & (vmax >= 0) & (vmin <= H)
        i0 = torch.ceil(umin - 0.5)
        j0 = torch.ceil(vmin - 0.5)
        bw = torch.floor(umax - 0.5) - i0 + 1
        bh = torch.floor(vmax - 0.5) - j0 + 1
        ok = front & on
        small = ok & (bw <= box) & (bh <= box)
        e = torch.stack([(tris[:, 1] - tris[:, 0]).norm(dim=1), (tris[:, 2] - tris[:, 1]).norm(dim=1),
                         (tris[:, 0] - tris[:, 2]).norm(dim=1)], dim=1).max(dim=1).values
        split = (ok & ~small) | (anyf & ~front & on & (e > 0.02))
        sel = torch.nonzero(small & (bw > 0) & (bh > 0)).squeeze(1)
        for s0 in range(0, sel.numel(), 200_000):
            k = sel[s0:s0 + 200_000]
            px = (i0[k, None] + ox[None]).long()
            py = (j0[k, None] + oy[None]).long()
            pu, pv = px.float() + 0.5, py.float() + 0.5
            u0, u1, u2 = u[k, 0, None], u[k, 1, None], u[k, 2, None]
            v0, v1, v2 = v[k, 0, None], v[k, 1, None], v[k, 2, None]
            area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)
            area = torch.where(area.abs() < 1e-9, torch.full_like(area, 1e-9), area)
            b1 = ((pu - u0) * (v2 - v0) - (u2 - u0) * (pv - v0)) / area
            b2 = ((u1 - u0) * (pv - v0) - (pu - u0) * (v1 - v0)) / area
            b0 = 1.0 - b1 - b2
            eps = -1e-4
            inside = (b0 >= eps) & (b1 >= eps) & (b2 >= eps) & (px >= 0) & (px < W) & (py >= 0) & (py < H)
            iz = b0 / z[k, 0, None] + b1 / z[k, 1, None] + b2 / z[k, 2, None]
            zp = 1.0 / iz.clamp(min=1e-9)
            pix = (py * W + px)[inside]
            zb.scatter_reduce_(0, pix, zp[inside], reduce="amin")
        if not bool(split.any()):
            break
        s = tris[split]
        a, b, c = s[:, 0], s[:, 1], s[:, 2]
        ab, bc, ca = (a + b) / 2, (b + c) / 2, (c + a) / 2
        tris = torch.cat([torch.stack([a, ab, ca], 1), torch.stack([ab, b, bc], 1), torch.stack([ca, bc, c], 1),
                          torch.stack([ab, bc, ca], 1)])
        if tris.shape[0] > 40_000_000:  # a pathological view; what is left stays out of the z-buffer
            break
    return zb


# ---------------------------------------------------------------- planes and chunks


def snap_planes(V: np.ndarray, F: np.ndarray, log: Callable[[str], None], tol: float = PLANE_TOL_M,
                min_area: float = PLANE_MIN_M2) -> tuple[np.ndarray, dict]:
    """Flattens the big planes the fused surface wobbles around (the floor, walls, ceiling, table tops): horizontal
    planes from the height histogram of up- and down-facing faces, vertical ones from the azimuth histogram of
    upright faces and then their offsets. Every vertex of a face lying on a plane (normal within 25 degrees, within
    `tol`) moves onto it; a vertex on two planes ends on both (their edge). Returns the vertices and what was found."""
    fn, area = face_normals(V, F)
    c = V[F].mean(axis=1)
    planes: list[tuple[np.ndarray, float, float]] = []

    def peaks(x: np.ndarray, w: np.ndarray, step: float, need: float, spread: int = 2) -> list[float]:
        if len(x) == 0:
            return []
        bins = np.arange(x.min() - step, x.max() + 2 * step, step)
        hist, _ = np.histogram(x, bins, weights=w)
        win = np.convolve(hist, np.ones(2 * spread + 1), mode="same")
        out, taken = [], np.zeros(len(win), bool)
        for i in np.argsort(-win):
            if win[i] < need:
                break
            if taken[max(0, i - 3 * spread):i + 3 * spread + 1].any():
                continue
            taken[i] = True
            centre = bins[i] + step / 2
            near = np.abs(x - centre) < (spread + 0.5) * step
            if w[near].sum() > 0:
                o = np.argsort(x[near])
                cw = np.cumsum(w[near][o])
                out.append(float(x[near][o][np.searchsorted(cw, cw[-1] / 2)]))  # weighted median
        return out

    for sign in (1.0, -1.0):
        sel = fn[:, 1] * sign > 0.9
        for y0 in peaks(c[sel, 1], area[sel], 0.01, min_area):
            n = np.array([0.0, sign, 0.0])
            planes.append((n, sign * y0, 0.0))
    up = np.abs(fn[:, 1]) < 0.15
    if up.any():
        az = np.degrees(np.arctan2(fn[up, 2], fn[up, 0])) % 360.0
        a_up, c_up = area[up], c[up]
        for th in peaks(az, a_up, 1.0, 2 * min_area, spread=2):
            n = np.array([math.cos(math.radians(th)), 0.0, math.sin(math.radians(th))])
            dd = (az - th + 180.0) % 360.0 - 180.0
            on = np.abs(dd) < 6.0
            for d0 in peaks(c_up[on] @ n, a_up[on], 0.01, min_area):
                planes.append((n, d0, th))
    Vn = V.copy()
    moved = 0
    used = []
    for n, d, th in planes:
        fsel = (fn @ n > 0.9) & (np.abs(c @ n - d) < tol)
        a = float(area[fsel].sum())
        if a < min_area:
            continue
        # refit the plane to its faces (area-weighted): the histograms only find it to a degree and a centimetre
        w = area[fsel] / a
        mu = (c[fsel] * w[:, None]).sum(axis=0)
        X = (c[fsel] - mu) * np.sqrt(w)[:, None]
        n2 = np.linalg.svd(X, full_matrices=False)[2][-1]
        n2 = n2 if n2 @ n > 0 else -n2
        if n2 @ n > 0.995:  # within about 6 degrees: keep the refit
            n, d = n2, float(n2 @ mu)
            fsel = (fn @ n > 0.9) & (np.abs(c @ n - d) < tol)
        vids = np.unique(F[fsel])
        dist = Vn[vids] @ n - d
        ok = np.abs(dist) < 2 * tol
        Vn[vids[ok]] -= dist[ok, None] * n[None]
        moved += int(ok.sum())
        used.append({"normal": [round(float(x), 3) for x in n], "offset": round(float(d), 3), "m2": round(a, 1)})
    log(f"planes: {len(used)} snapped flat ({sum(p['m2'] for p in used):.0f} m2, {moved} vertices moved)")
    return Vn, {"planes": used, "verticesMoved": moved}


def ceiling_plan(V: np.ndarray, F: np.ndarray, room: Room, cell: float = FLOOR_CELL_M) -> dict | None:
    """The ceiling ceiling_fill closes, or None: its height (where down-facing surfaces above 2 m add up to the most
    area), the [z, x] cells of the room box's grid its fused faces cover there (`cover` m2, `covered`), its outline
    (closed, holes filled, with the splats at that height that join it) and the room its walls enclose (`room_cells`,
    `planes`: ceiling_room)."""
    from scipy import ndimage

    n, area = face_normals(V, F)
    c = V[F].mean(axis=1)
    down = (n[:, 1] < -0.7) & (c[:, 1] > 2.0) & (c[:, 1] < float(room.hi[1]))
    if area[down].sum() < CEILING_MIN_M2:
        return None
    bins = np.arange(2.0, float(room.hi[1]) + 0.05, 0.05)
    hist, _ = np.histogram(c[down, 1], bins, weights=area[down])
    win = np.convolve(hist, np.ones(3), mode="same")
    k = int(np.argmax(win))
    if win[k] < CEILING_MIN_M2:
        return None
    h = float(bins[k] + 0.025)
    at = down & (np.abs(c[:, 1] - h) < 0.15)
    ox, oz = float(room.lo[0]), float(room.lo[2])
    nx = max(1, int(math.ceil((room.hi[0] - ox) / cell)))
    nz = max(1, int(math.ceil((room.hi[2] - oz) / cell)))
    ix = np.clip(np.floor((c[at, 0] - ox) / cell).astype(np.int64), 0, nx - 1)
    iz = np.clip(np.floor((c[at, 2] - oz) / cell).astype(np.int64), 0, nz - 1)
    cover = np.bincount(iz * nx + ix, weights=area[at], minlength=nz * nx).reshape(nz, nx)
    covered = cover > 0.2 * cell * cell
    # where the splats have something at that height too (a ceiling seen by few cameras may be a few big splats the
    # fusion missed), as long as it joins the fused ceiling: a tree canopy elsewhere is not part of it
    sp = np.abs(room.pos[:, 1] - h) < 0.3
    sx = np.floor((room.pos[sp, 0] - ox) / cell).astype(np.int64)
    sz = np.floor((room.pos[sp, 2] - oz) / cell).astype(np.int64)
    inb = (sx >= 0) & (sx < nx) & (sz >= 0) & (sz < nz)
    Ws = np.bincount(sz[inb] * nx + sx[inb], weights=room.w[sp][inb], minlength=nz * nx).reshape(nz, nx)
    splat_cells = Ws > (0.1 * float(np.median(Ws[Ws > 0])) if (Ws > 0).any() else np.inf)
    union = ndimage.binary_closing(covered | splat_cells, structure=np.ones((3, 3), bool), iterations=2)
    lab, nlab = ndimage.label(union)
    keep = np.unique(lab[covered & (lab > 0)])
    outline = ndimage.binary_fill_holes(np.isin(lab, keep) & (lab > 0))
    # the room the ceiling belongs to: the convex hull of the fused ceiling and the walls that run into it. Under a
    # ceiling the cameras looked ahead, not up, so a ceiling fuses in a band along the walls they faced and stays
    # open over the rest of the room; the renders cannot confirm it there either (a faint ceiling, glare above it).
    room_cells, planes = ceiling_room(V, F, covered, h, ox, oz, cell, nx, nz)
    return {"h": h, "cover": cover, "covered": covered, "outline": outline, "room_cells": room_cells, "planes": planes,
            "ox": ox, "oz": oz, "nx": nx, "nz": nz, "cell": cell}


def ceiling_folds(V: np.ndarray, F: np.ndarray, plan: dict, drop_m: float) -> np.ndarray:
    """Faces (bool per face) of a ceiling the splats only smeared: when the cameras never looked up, the fused ceiling
    is not a torn sheet (ceiling_fill closes those) but folds and curtains hanging up to most of a metre under it.
    Under the ceiling's outline: everything within `drop_m` under the ceiling height or above it, except its flat
    parts (facing down within FLAT_CEILING_KEEP_M of the height) and, in a room its walls enclose (ceiling_room), what
    stands within FLAT_WALL_KEEP_M of those walls or behind them: the top of the walls and the corner they make with
    the ceiling, which the fill (cut to the room through the cells the walls stand in) does not reach."""
    h, ox, oz, cell, nx, nz = plan["h"], plan["ox"], plan["oz"], plan["cell"], plan["nx"], plan["nz"]
    n, area = face_normals(V, F)
    c = V[F].mean(axis=1)
    ix = np.floor((c[:, 0] - ox) / cell).astype(np.int64)
    iz = np.floor((c[:, 2] - oz) / cell).astype(np.int64)
    inb = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    region = plan["outline"] | plan["room_cells"]
    out = np.zeros(len(F), bool)
    out[inb] = region[iz[inb], ix[inb]]
    out &= (c[:, 1] > h - drop_m) & ~((n[:, 1] < -0.7) & (np.abs(c[:, 1] - h) < FLAT_CEILING_KEEP_M))
    planes = plan["planes"]
    if planes is not None:
        # depth inside the room: the distance to its nearest side (a*x + b*z + c <= 0 inside, unit normals)
        inside = -(c[:, [0, 2]] @ planes[:, :2].T + planes[:, 2]).max(axis=1)
        out &= inside > FLAT_WALL_KEEP_M
    return out


def ceiling_colour(room: Room, plan: dict) -> np.ndarray | None:
    """The colour (sRGB bytes) the splats give a ceiling: the weighted median, per channel, of the splats within 20 cm
    of its height over its outline and room (ceiling_plan); None when there are too few."""
    h, ox, oz, cell, nx, nz = plan["h"], plan["ox"], plan["oz"], plan["cell"], plan["nx"], plan["nz"]
    idx = np.nonzero(np.abs(room.pos[:, 1] - h) < 0.2)[0]
    ix = np.floor((room.pos[idx, 0] - ox) / cell).astype(np.int64)
    iz = np.floor((room.pos[idx, 2] - oz) / cell).astype(np.int64)
    ok = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    idx, ix, iz = idx[ok], ix[ok], iz[ok]
    idx = idx[(plan["outline"] | plan["room_cells"])[iz, ix]]
    if len(idx) < 50:
        return None
    w = room.w[idx].astype(np.float64)
    out = []
    for k in range(3):
        v = room.lin[idx, k].astype(np.float64)
        o = np.argsort(v)
        cw = np.cumsum(w[o])
        out.append(v[o[min(len(o) - 1, int(np.searchsorted(cw, 0.5 * cw[-1])))]])
    return np.clip(np.round(linear_to_srgb_np(np.array(out)) * 255.0), 0, 255).astype(np.uint8)


def ceiling_fill(V: np.ndarray, F: np.ndarray, room: Room, log: Callable[[str], None],
                 cell: float = FLOOR_CELL_M, shots: list[Shot] | None = None, plan: dict | None = None,
                 flat: bool = False) -> tuple[np.ndarray, np.ndarray, float | None, float]:
    """Tiles (at most 1 m square, facing down) a few centimetres above a ceiling wherever the mesh's own ceiling is
    open inside its outline (ceiling_plan, from V, F unless `plan` is given). A ceiling is seen by few cameras (they
    look ahead, not up), so it fuses torn, and through a tear a player would see the sky. With `flat` (its folds were
    taken out: ceiling_folds) the tiles span the whole outline and room. Returns (vertices, faces, height, open m2)."""
    empty = (np.zeros((0, 3)), np.zeros((0, 3), np.int64), None, 0.0)
    if plan is None:
        plan = ceiling_plan(V, F, room, cell)
    if plan is None:
        return empty
    h, cover, outline, room_cells, planes = plan["h"], plan["cover"], plan["outline"], plan["room_cells"], plan["planes"]
    ox, oz, cell = plan["ox"], plan["oz"], plan["cell"]
    missing = outline | room_cells
    if not flat:
        missing &= cover < 0.7 * cell * cell
    n_outline = int(missing.sum())
    if shots and (missing & ~room_cells).any():
        missing &= room_cells | ceiling_seen(missing & ~room_cells, ox, oz, cell, h, shots)
    if not missing.any():
        return empty
    y = h + 0.03  # above the real ceiling: where both exist, the real one is what a player sees
    kk = max(1, int(round(1.0 / cell)))
    verts, faces = [], []
    filled = {"room": 0.0, "seen": 0.0}
    # tiles of at most 1 m; inside the walls each is cut to the room's outline, so its edge runs along the walls
    # (a room at 45 degrees gets a straight edge, not a staircase of cells)
    for key, cells, clip in (("room", missing & room_cells, planes), ("seen", missing & ~room_cells, None)):
        for x0, z0, x1, z1, _lab in rmap.greedy_rects_2d(np.where(cells, 0, -1).astype(np.int32)):
            for a in range(x0, x1, kk):
                for b in range(z0, z1, kk):
                    xa, xb = ox + a * cell, ox + min(a + kk, x1) * cell
                    za, zb = oz + b * cell, oz + min(b + kk, z1) * cell
                    poly = [(xa, za), (xa, zb), (xb, zb), (xb, za)]
                    if clip is not None:
                        poly = _clip_convex(poly, clip)
                    if len(poly) < 3:
                        continue
                    xs, zs = np.array([q[0] for q in poly]), np.array([q[1] for q in poly])
                    area2 = float(np.dot(xs, np.roll(zs, -1)) - np.dot(zs, np.roll(xs, -1)))  # twice the signed area
                    if abs(area2) < 1e-6:
                        continue
                    if area2 < 0:  # wound so the fan below faces down (clockwise seen from above)
                        poly = poly[::-1]
                    n0 = len(verts)
                    verts += [(px, y, pz) for px, pz in poly]
                    faces += [(n0, n0 + k, n0 + k + 1) for k in range(1, len(poly) - 1)]
                    filled[key] += abs(area2) / 2
    open_m2 = filled["room"] + filled["seen"]
    log(f"ceiling at {h:.2f} m: {float(outline.sum()) * cell * cell:.1f} m2 outline, room under it (walls) "
        f"{float(room_cells.sum()) * cell * cell:.1f} m2, {n_outline * cell * cell:.1f} m2 open, {open_m2:.1f} m2 filled "
        f"({filled['room']:.1f} m2 inside the walls, {filled['seen']:.1f} m2 where the splats have a surface at that "
        f"height) -> {len(faces)} fill triangles")
    return np.asarray(verts, np.float64).reshape(-1, 3), np.asarray(faces, np.int64).reshape(-1, 3), h, open_m2


def _clip_convex(poly: list[tuple[float, float]], planes: np.ndarray) -> list[tuple[float, float]]:
    """A polygon (x, z) cut to the half-planes a*x + b*z + c <= 0 (rows of `planes`), Sutherland-Hodgman."""
    for a, b, c in planes:
        out = []
        for i in range(len(poly)):
            p, q = poly[i], poly[(i + 1) % len(poly)]
            fp, fq = a * p[0] + b * p[1] + c, a * q[0] + b * q[1] + c
            if fp <= 1e-9:
                out.append(p)
            if (fp <= 1e-9) != (fq <= 1e-9):
                t = fp / (fp - fq)
                out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
        poly = out
        if len(poly) < 3:
            return []
    return poly


def ceiling_room(V: np.ndarray, F: np.ndarray, covered: np.ndarray, h: float, ox: float, oz: float, cell: float,
                 nx: int, nz: int) -> tuple[np.ndarray, np.ndarray | None]:
    """The room under a ceiling at height h: the convex hull of the fused ceiling's cells and of the walls that reach
    it (vertical surface between 0.8 m and the ceiling, WALL_CELL_M2 per cell, runs of at least WALL_MIN_CELLS cells
    that touch the ceiling's cells grown by 50 cm; a tree trunk on a patio is too short or too far), through the cell
    centres. Returns the [z, x] cells that overlap it and its half-planes in metres (rows a, b, c: a*x + b*z + c <= 0
    inside), or no cells and None when no wall reaches the ceiling: an open roof edge is not a room."""
    from scipy import ndimage
    from scipy.spatial import ConvexHull, QhullError

    none = (np.zeros((nz, nx), bool), None)
    n, area = face_normals(V, F)
    c = V[F].mean(axis=1)
    w = (np.abs(n[:, 1]) < 0.3) & (c[:, 1] > 0.8) & (c[:, 1] < h - 0.3)
    if not w.any() or not covered.any():
        return none
    ix = np.clip(np.floor((c[w, 0] - ox) / cell).astype(np.int64), 0, nx - 1)
    iz = np.clip(np.floor((c[w, 2] - oz) / cell).astype(np.int64), 0, nz - 1)
    wa = np.bincount(iz * nx + ix, weights=area[w], minlength=nz * nx).reshape(nz, nx)
    walls = wa > WALL_CELL_M2 * (cell / 0.25) ** 2
    lab, nlab = ndimage.label(walls, structure=np.ones((3, 3), bool))
    if nlab == 0:
        return none
    near = ndimage.binary_dilation(covered, structure=np.ones((3, 3), bool), iterations=max(1, int(round(0.5 / cell))))
    sizes = np.bincount(lab.ravel(), minlength=nlab + 1)
    touch = np.unique(lab[near & (lab > 0)])
    keep = touch[sizes[touch] >= WALL_MIN_CELLS]
    if len(keep) == 0:
        return none
    zi, xi = np.nonzero(covered | np.isin(lab, keep))
    pts = np.stack([ox + (xi + 0.5) * cell, oz + (zi + 0.5) * cell], axis=1)
    try:
        hull = ConvexHull(pts)
    except QhullError:
        return none
    planes = hull.equations  # rows (a, b, c) with a*x + b*z + c <= 0 inside, metres
    # a cell overlaps the hull when its centre or a corner is inside
    gx = ox + np.arange(nx + 1) * cell
    gz = oz + np.arange(nz + 1) * cell
    X, Z = np.meshgrid(gx, gz)
    corner_in = np.all(np.stack([X.ravel(), Z.ravel()], 1) @ planes[:, :2].T + planes[:, 2] <= 1e-9, axis=1).reshape(nz + 1, nx + 1)
    Xc, Zc = np.meshgrid(gx[:-1] + cell / 2, gz[:-1] + cell / 2)
    centre_in = np.all(np.stack([Xc.ravel(), Zc.ravel()], 1) @ planes[:, :2].T + planes[:, 2] <= 1e-9, axis=1).reshape(nz, nx)
    overlap = centre_in | corner_in[:-1, :-1] | corner_in[1:, :-1] | corner_in[:-1, 1:] | corner_in[1:, 1:]
    return overlap, planes


def ceiling_seen(cells: np.ndarray, ox: float, oz: float, cell: float, h: float, shots: list[Shot]) -> np.ndarray:
    """[z, x] cells where the splat renders put a surface at the ceiling height: views that see the cell's centre at
    height h with a valid depth there vote for it when that depth lands within 15 cm (or 5%) of it, and against it
    when they see nothing there or clearly past it (sky, a tree beyond the roof's edge). A cell needs more votes for
    than against."""
    import torch

    zi, xi = np.nonzero(cells)
    pts = np.stack([ox + (xi + 0.5) * cell, np.full(len(xi), h), oz + (zi + 0.5) * cell], axis=1)
    dev = shots[0].depth.device
    P = torch.as_tensor(pts, dtype=torch.float32, device=dev)
    yes = torch.zeros(len(P), device=dev)
    no = torch.zeros(len(P), device=dev)
    for s in shots:
        u, v, z = project(P, s.view)
        H, W = s.depth.shape
        ui, vi = torch.floor(u).long(), torch.floor(v).long()
        inb = (z > 0.2) & (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
        k = torch.nonzero(inb).squeeze(1)
        if k.numel() == 0:
            continue
        pix = vi[k] * W + ui[k]
        zz = z[k]
        tol = torch.clamp(0.05 * zz, min=0.15)
        if s.alpha is not None and s.ed is not None:
            a = s.alpha.reshape(-1)[pix]
            d = s.ed.reshape(-1)[pix]
            yes[k] += ((a > 0.2) & ((d - zz).abs() < tol)).float()
            no[k] += ((a < 0.05) | ((a > 0.2) & (d > zz + 2 * tol))).float()
        else:
            d = s.depth.reshape(-1)[pix]
            yes[k] += ((d > 0) & ((d - zz).abs() < tol)).float()
            no[k] += ((d <= 0) | (d > zz + 2 * tol)).float()
    ok = (yes > no).cpu().numpy()
    out = np.zeros_like(cells)
    out[zi[ok], xi[ok]] = True
    return out


def kd_chunks_area(V: np.ndarray, F: np.ndarray, max_tris: int = CHUNK_TRIANGLES, max_area: float = CHUNK_AREA_M2,
                   min_chunks: int = 1) -> list[np.ndarray]:
    """Like kd_chunks, but a chunk is also split while it holds more than `max_area` m2 (each chunk is one texture of
    the same size, so this keeps the texel density even), along the longest axis at the weighted median."""
    if len(F) == 0:
        return []
    c = V[F].mean(axis=1)
    _, a = face_normals(V, F)
    wt = 1.0 / max_tris + a / max_area
    out = [np.arange(len(F))]

    def load(idx: np.ndarray) -> float:
        return max(len(idx) / max_tris, float(a[idx].sum()) / max_area)

    loads = [load(out[0])]
    while True:
        k = int(np.argmax(loads))
        idx = out[k]
        if len(idx) < 2 or (loads[k] <= 1.0 and len(out) >= min_chunks):
            break
        cc = c[idx]
        ax = int(np.argmax(cc.max(axis=0) - cc.min(axis=0)))
        order = np.argsort(cc[:, ax], kind="stable")
        cw = np.cumsum(wt[idx][order])
        half = int(np.clip(np.searchsorted(cw, cw[-1] / 2), 1, len(idx) - 1))
        lo_i, hi_i = idx[order[:half]], idx[order[half:]]
        out[k:k + 1] = [lo_i, hi_i]
        loads[k:k + 1] = [load(lo_i), load(hi_i)]
    out.sort(key=lambda i: (round(float(c[i, 2].mean()), 3), round(float(c[i, 0].mean()), 3)))
    return out


# ---------------------------------------------------------------- the photo bake


def _splat_fill(P: Any, Nn: Any, shots: list[Shot], tol_abs: float) -> tuple[Any, Any]:
    """v1's splat-render bake for some texels: (linear colour [n, 3], seen [n]) from the views within half of each
    texel's best (f cos / distance)^2, depth-tested against the splat depth."""
    import torch
    import torch.nn.functional as F

    dev = P.device
    M = len(P)

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
        return sel, (v.f * cos / dist.clamp(min=0.3)) ** 2, u[sel], vv[sel]

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
        img = srgb_to_linear_t(s.rgb.float()).permute(2, 0, 1)[None]
        col = F.grid_sample(img, grid, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
        acc[sel] += col * w[:, None]
        wsum[sel] += w
    return acc / wsum.clamp(min=1e-9)[:, None], wsum > 0


def _splat_mesh_fill(P: Any, Nn: Any, T: Any, shots: list[Shot], power: float) -> tuple[Any, Any]:
    """Splat renders as a fallback texture source, with the same visibility test as the photos (the mesh's own
    z-buffer) and the same best-view blend: (linear colour [n, 3], seen [n])."""
    import torch
    import torch.nn.functional as F

    dev = P.device
    M = len(P)
    best = torch.zeros(M, device=dev)
    acc = torch.zeros(M, 3, device=dev)
    wsum = torch.zeros(M, device=dev)
    for s in shots:
        v = s.view
        W, H = v.w, v.h
        zb = zbuffer(T, v.c2w, v.f, v.fy, v.cx, v.cy, W, H)
        R = torch.as_tensor(v.c2w[:3, :3], dtype=torch.float32, device=dev)
        t = torch.as_tensor(v.c2w[:3, 3], dtype=torch.float32, device=dev)
        pc = (P - t) @ R
        z = -pc[:, 2]
        zsafe = torch.where(z > 1e-3, z, torch.ones_like(z))
        u = v.cx + v.f * pc[:, 0] / zsafe
        vv = v.cy - v.fy * pc[:, 1] / zsafe
        inb = (z > 0.05) & (u >= 0) & (u < W) & (vv >= 0) & (vv < H)
        sel = torch.nonzero(inb).squeeze(1)
        if sel.numel() == 0:
            continue
        us, vs, zz = u[sel], vv[sel], z[sel]
        to_eye = t - P[sel]
        dd = to_eye.norm(dim=1).clamp(min=1e-6)
        cos = (Nn[sel] * to_eye).sum(dim=1) / dd
        pix = torch.floor(vs).long().clamp(0, H - 1) * W + torch.floor(us).long().clamp(0, W - 1)
        tol = 0.015 + 2.0 * zz / v.f / cos.clamp(min=0.15) + 0.004 * zz
        ok = (zz <= zb[pix] + tol) & (cos > PHOTO_MIN_COS) & s.valid.reshape(-1)[pix]
        sel, us, vs, cos, dd = sel[ok], us[ok], vs[ok], cos[ok], dd[ok]
        if sel.numel() == 0:
            continue
        score = (v.f / dd) * cos.pow(1.5)
        img = srgb_to_linear_t(s.rgb.float()).permute(2, 0, 1)[None]
        g = torch.stack([us / W * 2 - 1, vs / H * 2 - 1], dim=1)[None, None]
        col = F.grid_sample(img, g, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
        old = best[sel]
        newb = torch.maximum(old, score)
        r_old = torch.where(old > 0, (old / newb).pow(power), torch.zeros_like(old))
        r_new = (score / newb).pow(power)
        acc[sel] = acc[sel] * r_old[:, None] + col * r_new[:, None]
        wsum[sel] = wsum[sel] * r_old + r_new
        best[sel] = newb
    return acc / wsum.clamp(min=1e-9)[:, None], wsum > 0


def bake_photos(chunks: list[Chunk], cams: list[PhotoCam], photo_shots: list[Shot], fill_shots: list[Shot],
                tsdf: Tsdf, room: Room, log: Callable[[str], None], power: float = PHOTO_POWER,
                splat_only: set[str] | None = None) -> dict:
    """Fills each chunk's image from the real photos and frames (see the v2 notes above). Texels no photo sees take
    the splat renders (fill_shots), then the fused voxel colour, then (on the floor) the floor colour painted in.
    Chunks named in `splat_only` (the ceiling fill: tiles where the fusion found no surface, so a photo may well show
    what lies beyond them) take the splat renders only."""
    import cv2
    import torch
    import torch.nn.functional as F

    dev = tsdf.device
    parts = [texels(ch) for ch in chunks]
    P = torch.as_tensor(np.concatenate([p[2] for p in parts]), dtype=torch.float32, device=dev)
    Nn = torch.as_tensor(np.concatenate([p[3] for p in parts]), dtype=torch.float32, device=dev)
    M = len(P)
    photo_ok = torch.as_tensor(np.concatenate([np.full(len(p[0]), ch.name not in (splat_only or set()))
                                               for ch, p in zip(chunks, parts)]), device=dev)
    # texel size in metres, per chunk (surface area / covered texels)
    tsz = []
    for ch, p in zip(chunks, parts):
        _, a = face_normals(ch.V, ch.F)
        tsz.append(np.full(len(p[0]), math.sqrt(float(a.sum()) / max(1, len(p[0]))), np.float32))
    tsz_t = torch.as_tensor(np.concatenate(tsz), device=dev)
    T = torch.as_tensor(np.concatenate([ch.V[ch.F] for ch in chunks]).astype(np.float32), device=dev)

    # pass 1: colour transforms (photo -> splat render from the same camera) and sharpness against that render
    shot_of = {s.view.position: s for s in photo_shots}
    fits, sharp = [], []
    for k, c in enumerate(cams):
        s = shot_of.get(k)
        try:
            img, ok = read_photo(c)
        except MeshError as e:
            log(str(e))
            fits.append(None)
            sharp.append(0.0)
            continue
        if s is None:
            fits.append((np.vstack([np.eye(3), np.zeros((1, 3))]), {"fit": False}))
            sharp.append(1.0)
            continue
        h, w = s.depth.shape
        small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
        ok_s = cv2.resize(ok.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
        tgt = s.rgb.float().clamp(0, 1).cpu().numpy()
        tvalid = s.valid.cpu().numpy()
        A, st = colour_match(rmap.srgb_to_linear(small.astype(np.float64) / 255.0), ok_s,
                             rmap.srgb_to_linear(tgt.astype(np.float64)), tvalid)
        g_p = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        g_r = cv2.cvtColor((tgt * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        both = ok_s & tvalid
        sp, sr = sharpness(g_p, both), sharpness(g_r, both)
        st["sharpness"] = round(sp / max(sr, 1e-9), 3) if sr > 0 else None
        fits.append((A, st))
        sharp.append(sp / max(sr, 1e-9) if sr > 0 else 1.0)
    sh = np.array(sharp, np.float64)
    ref = float(np.median(sh[sh > 0])) if (sh > 0).any() else 1.0
    sharp_w = np.clip(sh / max(ref, 1e-9), 0.4, 1.6)
    log(f"colour transforms fitted for {sum(1 for f in fits if f and f[1].get('fit'))}/{len(cams)} cameras; sharpness "
        f"(photo / splat render) median {ref:.2f}, range {sh.min():.2f}..{sh.max():.2f}")

    # pass 2: project
    best = torch.zeros(M, device=dev)
    acc = torch.zeros(M, 3, device=dev)
    wsum = torch.zeros(M, device=dev)
    winner = torch.full((M,), -1, dtype=torch.int32, device=dev)
    per_cam = []
    for k, c in enumerate(cams):
        if fits[k] is None:
            continue
        A, _ = fits[k]
        img, ok = read_photo(c)
        At = torch.as_tensor(A, dtype=torch.float32, device=dev)
        lin_t = srgb_to_linear_t(torch.as_tensor(img, device=dev).float() / 255.0)
        lin_t = (lin_t.reshape(-1, 3) @ At[:3] + At[3]).clamp(0.0, 1.0).reshape(lin_t.shape)
        # usable-pixel feather: distance to the image border or a mask edge, at half size
        hw, hh = max(1, c.w // 2), max(1, c.h // 2)
        okh = cv2.resize(ok.astype(np.uint8), (hw, hh), interpolation=cv2.INTER_NEAREST)
        okh[0, :] = okh[-1, :] = 0
        okh[:, 0] = okh[:, -1] = 0
        dist = cv2.distanceTransform(okh, cv2.DIST_L2, 5)
        feather = torch.as_tensor(np.clip(dist / max(1.0, FEATHER_FRAC * hw), 0.0, 1.0), device=dev).reshape(-1)
        okt = torch.as_tensor(ok, device=dev).reshape(-1)
        # z-buffer of the mesh at half size
        zs = 0.5
        zb = zbuffer(T, c.c2w, c.fx * zs, c.fy * zs, c.cx * zs, c.cy * zs, hw, hh)
        R = torch.as_tensor(c.c2w[:3, :3], dtype=torch.float32, device=dev)
        t = torch.as_tensor(c.c2w[:3, 3], dtype=torch.float32, device=dev)
        pc = (P - t) @ R
        z = -pc[:, 2]
        zsafe = torch.where(z > 1e-3, z, torch.ones_like(z))
        u = c.cx + c.fx * pc[:, 0] / zsafe
        v = c.cy - c.fy * pc[:, 1] / zsafe
        inb = (z > 0.05) & (u >= 0) & (u < c.w) & (v >= 0) & (v < c.h)
        sel = torch.nonzero(inb).squeeze(1)
        if sel.numel() == 0:
            per_cam.append({"name": c.name, "texels": 0})
            continue
        us, vs, zz = u[sel], v[sel], z[sel]
        to_eye = t - P[sel]
        dd = to_eye.norm(dim=1).clamp(min=1e-6)
        cos = (Nn[sel] * to_eye).sum(dim=1) / dd
        hp = (torch.floor(vs * zs).long().clamp(0, hh - 1) * hw + torch.floor(us * zs).long().clamp(0, hw - 1))
        tol = 0.015 + 2.0 * zz / (c.fx * zs) / cos.clamp(min=0.15) + 0.004 * zz
        vis = (zz <= zb[hp] + tol) & (cos > PHOTO_MIN_COS)
        fp = torch.floor(vs).long() * c.w + torch.floor(us).long()
        vis &= okt[fp] & photo_ok[sel]
        fe = feather[hp]
        vis &= fe > 0
        sel, us, vs, zz, cos, dd, fe = sel[vis], us[vis], vs[vis], zz[vis], cos[vis], dd[vis], fe[vis]
        if sel.numel() == 0:
            per_cam.append({"name": c.name, "texels": 0})
            continue
        score = (c.fx / dd) * cos.pow(1.5) * float(sharp_w[k]) * fe
        # sample: a pyramid level matched to the texel footprint (no aliasing from a far photo)
        img_t = lin_t.permute(2, 0, 1)[None]
        pyr = [img_t]
        for _ in range(3):
            pyr.append(F.avg_pool2d(pyr[-1], 2, ceil_mode=True))
        foot = tsz_t[sel] * c.fx / zz.clamp(min=1e-3)
        lvl = torch.clamp(torch.floor(torch.log2(foot.clamp(min=1e-6))), 0, 3).long()
        col = torch.zeros(len(sel), 3, device=dev)
        for L in range(4):
            m = lvl == L
            if not bool(m.any()):
                continue
            g = torch.stack([us[m] / c.w * 2 - 1, vs[m] / c.h * 2 - 1], dim=1)[None, None]
            col[m] = F.grid_sample(pyr[L], g, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
        old = best[sel]
        newb = torch.maximum(old, score)
        r_old = torch.where(old > 0, (old / newb).pow(power), torch.zeros_like(old))
        r_new = (score / newb).pow(power)
        acc[sel] = acc[sel] * r_old[:, None] + col * r_new[:, None]
        wsum[sel] = wsum[sel] * r_old + r_new
        best[sel] = newb
        won = score >= newb
        winner[sel[won]] = k
        per_cam.append({"name": c.name, "texels": int(sel.numel())})
        del img_t, pyr, zb, lin_t
    from_photos = wsum > 0
    lin = acc / wsum.clamp(min=1e-9)[:, None]
    n_photo = int(from_photos.sum())
    # texels no photo saw: splat renders (mesh visibility, then splat-depth visibility), voxel colours, the floor map
    miss = torch.nonzero(~from_photos).squeeze(1)
    n_splat = 0
    seen = from_photos.clone()
    if miss.numel() and fill_shots:
        for s0 in range(0, miss.numel(), 8_000_000):
            mm = miss[s0:s0 + 8_000_000]
            col, got = _splat_mesh_fill(P[mm], Nn[mm], T, fill_shots, power)
            lin[mm[got]] = col[got]
            seen[mm[got]] = True
            n_splat += int(got.sum())
        miss = torch.nonzero(~seen).squeeze(1)
        for s0 in range(0, miss.numel(), 4_000_000):
            mm = miss[s0:s0 + 4_000_000]
            col, got = _splat_fill(P[mm], Nn[mm], fill_shots, 3.0 * tsdf.v)
            lin[mm[got]] = col[got]
            seen[mm[got]] = True
            n_splat += int(got.sum())
    miss = torch.nonzero(~seen).squeeze(1)
    n_vox = 0
    if miss.numel():
        fill = torch.full((miss.numel(), 3), float("nan"), device=dev)
        for off in (0.0, 1.0, -1.0, 2.0):
            todo = torch.isnan(fill[:, 0])
            if not bool(todo.any()):
                break
            q = P[miss[todo]] + Nn[miss[todo]] * (off * tsdf.v)
            _, _, cv = tsdf.lookup(q)
            fill[todo] = cv
        got = ~torch.isnan(fill[:, 0])
        lin[miss[got]] = fill[got]
        seen[miss[got]] = True
        n_vox = int(got.sum())
    flo = seen & (P[:, 1].abs() < 0.15) & (Nn[:, 1] > 0.5)
    if int(flo.sum()) >= 200:
        fimg, ox, oz, cell = paint_floor_map(P[flo].cpu().numpy(), lin[flo].cpu().numpy(), np.ones(int(flo.sum())), room)
    else:
        fimg, ox, oz, cell = floor_colours(room)
    miss = torch.nonzero(~seen & (P[:, 1] < 0.15) & (P[:, 1] > FLOOR_BACKSTOP_Y - 0.05) & (Nn[:, 1] > 0.5)).squeeze(1)
    n_floor = int(miss.numel())
    if n_floor:
        fm = torch.as_tensor(fimg, dtype=torch.float32, device=dev).permute(2, 0, 1)[None]
        h, w = fimg.shape[:2]
        gx = (P[miss, 0] - ox) / (cell * w) * 2 - 1
        gz = (P[miss, 2] - oz) / (cell * h) * 2 - 1
        lin[miss] = F.grid_sample(fm, torch.stack([gx, gz], dim=1)[None, None], mode="bilinear", padding_mode="border",
                                  align_corners=False)[0, :, 0].T
        seen[miss] = True
    lin_np, seen_np, fp_np = lin.cpu().numpy(), seen.cpu().numpy(), from_photos.cpu().numpy()
    o = 0
    for ch, (rows, cols, _, _) in zip(chunks, parts):
        n = len(rows)
        T_ = ch.size
        im = np.zeros((T_, T_, 3), np.float32)
        have = np.zeros((T_, T_), bool)
        ok = seen_np[o:o + n]
        im[rows[ok], cols[ok]] = lin_np[o:o + n][ok]
        have[rows[ok], cols[ok]] = True
        ch.stats.update({"texels": int(n), "fromPhotos": round(float(fp_np[o:o + n].mean()) if n else 0.0, 3)})
        ch.image = finish_image(im, have)
        o += n
    wins = torch.bincount(winner[winner >= 0].long(), minlength=len(cams)).cpu().numpy()
    by_group: dict[str, int] = {}
    for k, c in enumerate(cams):
        by_group[c.group] = by_group.get(c.group, 0) + int(wins[k])
    log(f"baked {M} texels: {n_photo / max(M, 1) * 100:.1f}% from photos/frames (best view by group {by_group}), "
        f"{n_splat / max(M, 1) * 100:.1f}% from splat renders, {n_vox / max(M, 1) * 100:.1f}% from voxel colours, "
        f"{n_floor / max(M, 1) * 100:.1f}% from the floor map")
    fit_stats = [f[1] for f in fits if f is not None]
    return {"texels": M, "fromPhotos": round(n_photo / max(M, 1), 4), "fromSplatRenders": round(n_splat / max(M, 1), 4),
            "fromVoxels": round(n_vox / max(M, 1), 4), "fromFloorMap": round(n_floor / max(M, 1), 4),
            "bestViewByGroup": by_group, "cameras": len(cams), "power": power,
            "colourFit": {"fitted": sum(1 for f in fit_stats if f.get("fit")),
                          "meanErrBefore": round(float(np.mean([f["errBefore"] for f in fit_stats if f.get("fit")] or [0])), 4),
                          "meanErrAfter": round(float(np.mean([f["errAfter"] for f in fit_stats if f.get("fit")] or [0])), 4)},
            "sharpnessMedian": round(ref, 3)}


# ---------------------------------------------------------------- the skybox


def sky_c2w(face: str, eye: np.ndarray) -> np.ndarray:
    fwd, up = (np.asarray(x, np.float64) for x in SKY_FACES[face])
    right = np.cross(fwd, up)
    return sio.pose_matrix(np.stack([right, up, -fwd], axis=1), eye)


def render_skybox(room: Room, lo: np.ndarray, hi: np.ndarray, eye: np.ndarray, size: int, out_dir: Path,
                  device: Any, log: Callable[[str], None]) -> dict:
    """Six cube faces (Roblox's Sky convention, SKY_FACES) from `eye` (room frame), of the splats OUTSIDE the mesh box
    [lo, hi] only: the near room is geometry, everything farther is drawn at infinity. Where no far splat covers a
    pixel, the sky is the colour the far splats have at that elevation (a seamless fill). Writes sky-<face>.png."""
    import torch
    from PIL import Image

    import dataclasses

    s = room.splats
    P = sio.apply_transform(s.means, room.transform)
    P[:, 1] -= room.floor_y
    # beyond the walkable box sideways: what lies above it (glare a splat world puts behind its ceiling lights, tree
    # tops overhead) or below it (mirror images in a glossy floor) is either hidden by the mesh or not real
    far = ~((P[:, 0] >= lo[0]) & (P[:, 0] <= hi[0]) & (P[:, 2] >= lo[2]) & (P[:, 2] <= hi[2]))
    sub = s.subset(np.nonzero(far)[0])
    renderer = Renderer(dataclasses.replace(room, splats=sub), device)
    names = list(SKY_FACES)
    views = [View(sky_c2w(n, eye), size / 2.0, size, "sky") for n in names]
    imgs, alphas = [], []
    if renderer.gpu:
        from gsplat import rasterization

        vm = np.stack([sio.c2w_gl_to_cv_w2c(renderer.file_c2w(v.c2w)) for v in views]).astype(np.float32)
        K = np.stack([np.array([[v.f, 0, v.cx], [0, v.fy, v.cy], [0, 0, 1]], np.float32) for v in views])
        with torch.no_grad():
            out, alpha, _ = rasterization(
                renderer.t["means"], renderer.t["quats"], renderer.t["scales"], renderer.t["opac"], renderer.t["sh"],
                torch.from_numpy(vm).to(device), torch.from_numpy(K).to(device), size, size, sh_degree=sub.sh_degree,
                render_mode="RGB", near_plane=0.01, far_plane=1e5, backgrounds=torch.zeros(len(views), 3, device=device))
        rgb = out[..., :3].clamp(0, 1).cpu().numpy()
        al = alpha[..., 0].clamp(0, 1).cpu().numpy()
    else:
        rgb, al = [], []
        for v in views:
            r = sio.render_points(sub, renderer.file_c2w(v.c2w), v.f, v.f, v.cx, v.cy, size, size)
            rgb.append(r.rgb.astype(np.float32) / 255.0)
            al.append(r.alpha)
        rgb, al = np.stack(rgb), np.stack(al)
    # elevation of every pixel's ray
    uu, vv = np.meshgrid(np.arange(size) + 0.5, np.arange(size) + 0.5)
    x, y = (uu - size / 2) / (size / 2), -(vv - size / 2) / (size / 2)
    elev = []
    for v in views:
        d = np.stack([x, y, -np.ones_like(x)], axis=-1) @ v.c2w[:3, :3].T
        elev.append(np.degrees(np.arcsin(np.clip(d[..., 1] / np.linalg.norm(d, axis=-1), -1, 1))))
    elev = np.stack(elev)
    # the fill: alpha-weighted mean colour (of covered pixels, un-premultiplied) per degree of elevation
    bins = np.clip(np.floor(elev + 90).astype(np.int64), 0, 179)
    covered = al > 0.6
    wts = al[covered]
    col = rgb[covered] / np.maximum(al[covered], 1e-3)[:, None]
    lin = rmap.srgb_to_linear(np.clip(col, 0, 1))
    Wb = np.bincount(bins[covered], weights=wts, minlength=180)
    Cb = np.stack([np.bincount(bins[covered], weights=wts * lin[:, i], minlength=180) for i in range(3)], axis=1)
    have = Wb > 50
    prof = np.zeros((180, 3))
    if have.any():
        prof[have] = Cb[have] / Wb[have, None]
        idx = np.arange(180)
        for i in range(3):
            prof[:, i] = np.interp(idx, idx[have], prof[have, i])
        k = np.ones(7) / 7
        prof = np.stack([np.convolve(np.pad(prof[:, i], 3, mode="edge"), k, mode="valid") for i in range(3)], axis=1)
    else:
        prof[:] = 0.02
    fill = linear_to_srgb_np(prof)  # sRGB per elevation degree
    files = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = {}
    for i, n in enumerate(names):
        e = np.clip(elev[i] + 90, 0, 179.999)
        f0 = np.floor(e).astype(np.int64)
        t = (e - f0)[..., None]
        bg = fill[f0] * (1 - t) + fill[np.minimum(f0 + 1, 179)] * t
        img = rgb[i] + (1.0 - al[i])[..., None] * bg
        u8 = np.clip(np.round(img * 255), 0, 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(u8).save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
        fname = f"sky-{n}.png"
        write_atomic(out_dir / fname, data)
        files[n] = {"file": fname, "sha1": hashlib.sha1(data).hexdigest(), "bytes": len(data),
                    "property": SKY_PROPERTY[n]}
        stats[n] = round(float((al[i] > 0.6).mean()), 3)
    log(f"skybox: {int(far.sum())} far splats (of {len(s)}), 6 faces of {size} px from ({eye[0]:.2f}, {eye[1]:.2f}, "
        f"{eye[2]:.2f}); covered by splats: {stats}")
    return {"faces": files, "coverage": stats, "farSplats": int(far.sum())}


# ---------------------------------------------------------------- parts


def pack_parts(chunks: list[Chunk], centres: list[np.ndarray], jpegs: list[bytes], spawn_studs: np.ndarray,
               extras: dict, max_bytes: int = PART_MAX_BYTES) -> list[tuple[list[int], bytes]]:
    """Chunks nearest the spawn first, as many per .glb as fit in max_bytes; returns (chunk indices, glb) per part."""
    order = sorted(range(len(chunks)), key=lambda k: float(np.linalg.norm((centres[k] - spawn_studs)[[0, 2]])))
    est = [len(jpegs[k]) + 32 * len(ch.V) + (6 if len(ch.V) < 65536 else 12) * len(ch.F) + 400 for k, ch in enumerate(chunks)]
    groups: list[list[int]] = [[]]
    size = 0
    for k in order:
        if groups[-1] and size + est[k] > 0.97 * max_bytes:
            groups.append([])
            size = 0
        groups[-1].append(k)
        size += est[k]
    out = []
    pending = list(groups)
    while pending:
        g = pending.pop(0)
        ex = dict(extras, part=len(out) + 1)
        data = glb_bytes([chunks[k] for k in g], [centres[k] for k in g], ex, jpegs=[jpegs[k] for k in g])
        if len(data) > max_bytes and len(g) > 1:
            pending.insert(0, g[-1:] + (pending.pop(0) if pending else []))
            pending.insert(0, g[:-1])
            continue
        out.append((g, data))
    return out


def part_file(i: int) -> str:
    return GLB_FILE if i == 0 else f"roblox-{i + 1}.glb"


# ---------------------------------------------------------------- the whole v2 build


def build_model_v2(scene_dir: Path | str, out_dir: Path | str | None = None, photos: Path | str | None = None,
                   triangles: int = V2_TRIANGLES, texture: int = DEFAULT_TEXTURE, voxel: float | None = None,
                   margin: float = NEAR_MARGIN_M, positions: int = V2_POSITIONS, face_res: int = FACE_RES,
                   sky: bool = True, sky_size: int = SKY_SIZE, power: float = PHOTO_POWER, device: str | None = None,
                   workers: int = 8, key: str | None = None, hole_edges: int = HOLE_EDGES,
                   log: Callable[[str], None] = _log_noop, max_cams: int = 0, jpeg_quality: int = 88,
                   max_parts: int = 0, flat_ceiling: float = 0.0) -> dict:
    t0 = time.time()
    timings: dict[str, float] = {}

    def lap(name: str, since: float) -> float:
        now = time.time()
        timings[name] = round(now - since, 2)
        return now

    import dataclasses

    import torch

    scene_dir = Path(scene_dir)
    out_dir = Path(out_dir) if out_dir else scene_dir
    triangles = int(max(MIN_TRIANGLES, min(V2_MAX_TRIANGLES, triangles)))
    texture = int(max(128, min(4096, texture)))
    dev = _device(device)
    try:
        room0 = load_room(scene_dir, log)
    except rmap.MapError as e:
        raise MeshError(str(e))
    lo, hi, box_src = near_box(room0, margin)
    room = dataclasses.replace(room0, lo=lo, hi=hi)
    log(f"mesh box ({box_src} + {margin:.1f} m): x {lo[0]:.1f}..{hi[0]:.1f}  y {lo[1]:.1f}..{hi[1]:.1f}  "
        f"z {lo[2]:.1f}..{hi[2]:.1f} m (v1 room box x {room0.lo[0]:.1f}..{room0.hi[0]:.1f} z {room0.lo[2]:.1f}..{room0.hi[2]:.1f})")
    cams: list[PhotoCam] = []
    if photos:
        if not (scene_dir / "cameras.json").exists():
            raise MeshError("the scene has no cameras.json: photo textures need the reconstruction's cameras")
        cams = load_photo_cams(scene_dir, Path(photos), room.floor_y, log)
        if max_cams and len(cams) > max_cams:
            cams = cams[:: int(math.ceil(len(cams) / max_cams))]
    t = lap("load", t0)

    renderer = Renderer(room, dev)
    renderer.keep_alpha = True
    views, stands = plan_views(room, positions, face_res)
    cube_shots, view_stats = render_views(renderer, views, log)
    photo_shots = render_photo_shots(renderer, photo_views(cams), log) if cams else []
    shots = cube_shots + photo_shots
    if not shots:
        raise MeshError("every view of this world is empty")
    del renderer
    t = lap("render", t)

    v = voxel or float(np.clip(math.sqrt(max(1.0, _seen_area(shots, room)) / V2_SURFACE_CELLS), V2_VOXEL_MIN_M, VOXEL_MAX_M))
    v = round(v, 4)
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
    V, F = compact(V, F[np.all((c >= room.lo) & (c <= room.hi), axis=1)])
    if len(F) == 0:
        raise MeshError("nothing of the surface is inside the walkable area")
    fn, _ = face_normals(V, F)
    cc = V[F].mean(axis=1)
    pick = np.linspace(0, len(F) - 1, min(len(F), 20000)).astype(np.int64)
    Pc = torch.as_tensor(cc[pick], dtype=torch.float32, device=dev)
    Nc = torch.as_tensor(fn[pick], dtype=torch.float32, device=dev)
    ahead, _, _ = tsdf.lookup(Pc + Nc * (1.5 * tsdf.v))
    behind, _, _ = tsdf.lookup(Pc - Nc * (1.5 * tsdf.v))
    if float((ahead > behind).float().mean()) < 0.5:
        F = F[:, [0, 2, 1]]
    room_idx, lid_idx, lid_h = split_ceiling(V, F, log)
    keep = np.concatenate([room_idx, lid_idx])
    fn, _ = face_normals(V, F[keep])
    underside = (V[F[keep]].mean(axis=1)[:, 1] < UNDERSIDE_Y) & (fn[:, 1] < -0.5)
    n_underside = int(underside.sum())
    keep = keep[~underside]
    n_sky = 0
    if lid_h is None:
        fn, _ = face_normals(V, F[keep])
        skyf = (V[F[keep]].mean(axis=1)[:, 1] > SKY_MIN_Y) & (fn[:, 1] < -0.35)
        n_sky = int(skyf.sum())
        keep = keep[~skyf]
    Vr, Fr = compact(V, F[keep])
    _, area = face_normals(Vr, Fr)
    min_piece = max(MIN_COMPONENT_M2, 2e-4 * float(area.sum()))
    airborne = AIRBORNE_MAX_M2 if lid_h is not None else AIRBORNE_SKY_M2
    Vr, Fr, n_small = drop_small_components(Vr, Fr, min_piece, airborne, keep_m2=KEEP_PIECE_M2)
    if len(Fr) == 0:
        raise MeshError("nothing is left of the room after cleaning it up")
    Vr, Fr, n_holes = fill_holes(Vr, Fr, hole_edges)
    Vr, plane_stats = snap_planes(Vr, Fr, log)
    log(f"clean-up: {n_small} small or airborne pieces, {n_sky} sky faces and {n_underside} faces under the ground "
        f"dropped, {n_holes} holes closed")
    t = lap("clean", t)

    Vf, Ff, open_m2 = floor_fill(Vr, Fr, room)
    fill_m2 = float(face_normals(Vf, Ff)[1].sum()) if len(Ff) else 0.0
    # a ceiling the splats only smeared (flat_ceiling > 0, metres): the fill spans it, and its folds go after the
    # first decimation pass (whose normals tell a wall going on up from a fold, unlike the dense surface's), so the
    # second pass spends the budget on the rest; without the airborne rule from then on, as the top of a wall may
    # stand apart from its foot once the folds that joined them are gone
    plan = ceiling_plan(Vr, Fr, room) if flat_ceiling > 0 else None
    folds = None
    Vc, Fc, ceil_h, ceil_open = ceiling_fill(Vr, Fr, room, log, shots=shots, plan=plan, flat=plan is not None)
    rim_before = boundary_edges(Fr)
    target = triangles - 2 * len(Ff) - 2 * len(Fc)
    n_turned = n_late = 0
    for k_pass, budget in enumerate((int(target * 1.4), target)):
        if len(Fr) > budget:
            Vr, Fr = decimate(Vr, Fr, budget)
            Fr, turned = orient_faces(Vr, Fr, tsdf)
            Vr, Fr, late = drop_small_components(Vr, Fr, min_piece, 0.0 if folds else airborne, keep_m2=KEEP_PIECE_M2)
            n_turned, n_late = n_turned + turned, n_late + late
        if plan is not None and k_pass == 0:
            drop = ceiling_folds(Vr, Fr, plan, flat_ceiling)
            folds = {"dropM": flat_ceiling, "height": round(plan["h"], 3), "faces": int(drop.sum()),
                     "m2": round(float(face_normals(Vr, Fr[drop])[1].sum()) if drop.any() else 0.0, 2)}
            Vr, Fr = compact(Vr, Fr[~drop])
            Vr, Fr, folds["piecesLeft"] = drop_small_components(Vr, Fr, min_piece, 0.0, keep_m2=KEEP_PIECE_M2)
            log(f"flat ceiling at {plan['h']:.2f} m: {folds['faces']} faces ({folds['m2']:.1f} m2) of folds within "
                f"{flat_ceiling:.2f} m under it dropped (its flat parts and the walls stay), then {folds['piecesLeft']} "
                f"pieces they held")
    rim_after = boundary_edges(Fr)
    Vr, Fr, n_split = split_opposed(Vr, Fr)
    Nr = vertex_normals(Vr, Fr)
    log(f"decimated to {len(Fr)} triangles: {n_turned} faces turned, {n_late} loose pieces dropped, {n_split} vertices "
        f"split; boundary edges {rim_before} -> {rim_after}; floor fill {len(Ff) // 2} tiles ({fill_m2:.1f} m2)")
    lid = np.zeros(len(Fr), bool)
    if lid_h is not None:
        n_, _ = face_normals(Vr, Fr)
        lid = (n_[:, 1] < -0.5) & (Vr[Fr].mean(axis=1)[:, 1] > lid_h - 0.15)
    groups = [("room", Vr, Fr[~lid], Nr, texture)]
    if lid.any():
        groups.append(("ceiling", Vr, Fr[lid], Nr, texture))
    if len(Ff):
        groups.append(("floor", Vf, Ff, vertex_normals(Vf, Ff), min(texture, FLOOR_TEXTURE)))
    if len(Fc):
        groups.append(("ceilingfill", Vc, Fc, vertex_normals(Vc, Fc), min(texture, FLOOR_TEXTURE)))
    t = lap("decimate", t)

    parts_ = []
    fill_names: set[str] = set()
    for kind, Vg, Fg, Ng, size in groups:
        fill = kind in ("floor", "ceilingfill")
        limit = CHUNK_TRIANGLES // 2 if fill else CHUNK_TRIANGLES
        area_cap = CHUNK_AREA_M2 * (size / 1024.0) ** 2 * (4.0 if fill else 1.0)
        # the ceiling fill is ceiling: the game may leave "ceiling" chunks out (top-down views), like v1's lid
        label = "ceiling" if kind == "ceilingfill" else kind
        base = sum(1 for p in parts_ if p.kind == label)
        for k, idx in enumerate(kd_chunks_area(Vg, Fg, limit, area_cap, 1)):
            used, inv = np.unique(Fg[idx], return_inverse=True)
            parts_.append(Part(f"{label}_{base + k:02d}", label, Vg[used], inv.reshape(-1, 3), Ng[used], size))
            if kind == "ceilingfill":
                fill_names.add(parts_[-1].name)
    chunks = build_atlases(parts_, workers)
    t = lap("atlas", t)

    if cams:
        bake_stats = bake_photos(chunks, cams, photo_shots, cube_shots + photo_shots, tsdf, room, log, power,
                                 splat_only=fill_names)
    else:
        bake_stats = bake(chunks, shots, tsdf, room, log)
    if plan is not None and fill_names:
        # the flat ceiling: one colour, the one the splats give it, not the smear the splat renders show of a ceiling
        # nobody filmed (it moves with the eye, so painted on a plane it looks like stains)
        plain = ceiling_colour(room, plan)
        if plain is not None:
            for ch in chunks:
                if ch.name in fill_names and ch.image is not None:
                    ch.image[:] = plain
            folds["colour"] = [int(x) for x in plain]
    for ch in chunks:
        if ch.kind == "floor":
            add_underside(ch)
        elif ch.kind == "ceiling" and ch.name in fill_names:
            add_underside(ch, -FLOOR_UNDERSIDE_M)  # a thin slab: its back faces up, a centimetre higher
    t = lap("bake", t)

    S = STUDS_PER_METER
    eye = np.array([room.spawn[0], SKY_EYE_M, room.spawn[2]])
    sky_info = None
    if sky:
        del shots, cube_shots, photo_shots
        if dev.type == "cuda":
            torch.cuda.empty_cache()
        sky_info = render_skybox(room, lo, hi, eye, sky_size, out_dir, dev, log)
        t = lap("sky", t)

    centres, chunk_meta = [], []
    allV = np.concatenate([ch.V for ch in chunks]) * S
    for ch in chunks:
        lo_s, hi_s = ch.V.min(axis=0) * S, ch.V.max(axis=0) * S
        centre = np.round((lo_s + hi_s) / 2, 3)
        centres.append(centre)
        chunk_meta.append({"name": ch.name, "kind": ch.kind, "triangles": int(len(ch.F)), "vertices": int(len(ch.V)),
                           "center": [float(x) for x in centre], "size": [round(float(x), 3) for x in hi_s - lo_s],
                           **ch.stats})
    vm = room.voxel_map
    name = str(room.scene.get("name") or room.scene.get("id") or scene_dir.name)[:80]
    extras = {"sceneId": str(room.scene.get("id") or scene_dir.name), "name": name, "units": "studs", "studsPerMeter": S}
    spawn_s = np.array(vm.get("headsetSpawn") or [room.spawn[0] * S, 0.0, room.spawn[2] * S], np.float64)
    # with max_parts (e.g. 1 for a server that uploads one file), the textures give way until the model fits
    for q in [jpeg_quality] + [x for x in (80, 74, 68, 62, 56, 50) if x < jpeg_quality]:
        jpegs = [encode_jpeg(ch.image, q) for ch in chunks]
        packed = pack_parts(chunks, centres, jpegs, spawn_s, extras)
        if not max_parts or len(packed) <= max_parts:
            break
        log(f"{len(packed)} parts at JPEG quality {q}; more than {max_parts}, trying lower")
    jpeg_quality = q
    parts_meta = []
    for i, (g, data) in enumerate(packed):
        fname = part_file(i)
        write_atomic(out_dir / fname, data)
        for k in g:
            chunk_meta[k]["part"] = i + 1
        parts_meta.append({"file": fname, "sha1": hashlib.sha1(data).hexdigest(), "bytes": len(data),
                           "triangles": int(sum(len(chunks[k].F) for k in g)), "chunks": [chunks[k].name for k in g]})
    # a v1 model left in the folder from before must not be mistaken for a part
    for i in range(len(packed), 32):
        stale = out_dir / part_file(i)
        if i > 0 and stale.exists():
            stale.unlink()
    n_room = sum(m["triangles"] for m in chunk_meta if m["kind"] == "room")
    n_lid = sum(m["triangles"] for m in chunk_meta if m["kind"] == "ceiling")
    n_fill = sum(m["triangles"] for m in chunk_meta if m["kind"] == "floor")
    first = parts_meta[0]
    result = {
        "version": V2_VERSION,
        "sceneId": extras["sceneId"],
        "name": name,
        "file": first["file"],
        "bytes": first["bytes"],
        "sha1": first["sha1"],
        "parts": parts_meta,
        "units": "studs",
        "studsPerMeter": S,
        "frame": "room frame x studsPerMeter, axis for axis: Y up, -Z forward, floor at y = 0 (the voxel map's frame)",
        "import": {"scaleUnit": "Stud", "note": "Positions are already studs: keep the importer's Scale Unit on Stud. "
                   "Every part is in the same frame: parent them all where they load, without moving them."},
        "spawn": vm.get("spawn"),
        "spawnYaw": vm.get("spawnYaw"),
        "headsetSpawn": vm.get("headsetSpawn"),
        "ceilingY": round((lid_h or ceil_h) * S, 2) if (lid_h or ceil_h) else vm.get("ceilingY"),
        "hasCeiling": bool(n_lid),
        "ceilingFillM2": round(ceil_open, 2),
        "floorY": round(room.floor_y, 4),
        "bounds": {"min": [round(float(x), 2) for x in allV.min(axis=0)],
                   "max": [round(float(x), 2) for x in allV.max(axis=0)]},
        "meshBox": {"min": [round(float(x) * S, 2) for x in lo], "max": [round(float(x) * S, 2) for x in hi],
                    "source": box_src, "marginM": margin},
        "triangles": n_room + n_lid + n_fill,
        "roomTriangles": n_room,
        "ceilingTriangles": n_lid,
        "floorFillTriangles": n_fill,
        "floorFillM2": round(fill_m2, 2),
        "floorOpenM2": round(open_m2, 2),
        "textureSize": texture,
        "jpegQuality": jpeg_quality,
        "maxTrianglesPerChunk": CHUNK_TRIANGLES,
        "chunks": chunk_meta,
        "build": {
            "version": V2_VERSION,
            "device": f"{dev.type}{' gsplat' if sio.gsplat_available() and dev.type == 'cuda' else ''}",
            "positions": len(stands),
            "standing": stands,
            "views": view_stats,
            "trainingCameras": len(cams),
            "voxel": tsdf.v,
            "truncation": round(tsdf.trunc, 4),
            "blocks": int(len(tsdf.blocks)),
            "denseTriangles": int(dense),
            "smallComponentsDropped": n_small,
            "skyFacesDropped": n_sky,
            "undersideFacesDropped": n_underside,
            "holesClosed": n_holes,
            "planes": plane_stats,
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
    if sky_info:
        result["sky"] = {n: {"file": f["file"], "sha1": f["sha1"], "bytes": f["bytes"]} for n, f in sky_info["faces"].items()}
        result["skyInfo"] = {
            "size": sky_size,
            "eye": [round(float(x) * S, 2) for x in eye],
            "properties": SKY_PROPERTY,
            "faces": {n: {"look": list(SKY_FACES[n][0]), "imageUp": list(SKY_FACES[n][1])} for n in SKY_FACES},
            "frame": "the model's frame (studs, Y up, -Z forward): rotate Sky.SkyboxOrientation by the same yaw if the "
                     "model is placed turned",
            "coverage": sky_info["coverage"],
            "farSplats": sky_info["farSplats"],
        }
    if folds:
        result["build"]["flatCeiling"] = folds
    if key:
        result["build"]["key"] = key
    result["build"]["seconds"]["write"] = round(time.time() - t, 2)
    result["build"]["seconds"]["total"] = round(time.time() - t0, 2)
    write_atomic(out_dir / SIDECAR_FILE, json.dumps(result, indent=1).encode("utf-8"))
    sizes = ", ".join("%.1f MB" % (p["bytes"] / 1e6) for p in parts_meta)
    log(f"{len(chunks)} chunks in {len(parts_meta)} parts ({sizes}), "
        f"{n_room} room + {n_lid} ceiling + {n_fill} floor fill triangles in {time.time() - t0:.1f} s")
    return result


def _seen_area(shots: list[Shot], room: Room) -> float:
    """m2 of distinct 10 cm cells hit by back-projected pixels inside the room box."""
    import torch

    lo = torch.as_tensor(room.lo, dtype=torch.float32, device=shots[0].depth.device)
    hi = torch.as_tensor(room.hi, dtype=torch.float32, device=shots[0].depth.device)
    keys = []
    for s in shots:
        p = backproject(s, 4)
        p = p[((p >= lo) & (p <= hi)).all(dim=1)]
        c = torch.floor((p - lo) / 0.1).long()
        keys.append(torch.unique((c[:, 0] * 4096 + c[:, 1]) * 4096 + c[:, 2]))
    return float(torch.unique(torch.cat(keys)).numel()) * 0.01 if keys else 0.0


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
    ap.add_argument("--v2", action="store_true", help="v2: the walkable area only, photo textures, parts, skybox")
    ap.add_argument("--photos", help="v2: the reconstruction's work folder (images/, masks/) for photo textures")
    ap.add_argument("--near-margin", type=float, default=NEAR_MARGIN_M, help="v2: metres of geometry around world.bounds")
    ap.add_argument("--no-sky", action="store_true", help="v2: no skybox")
    ap.add_argument("--sky-size", type=int, default=SKY_SIZE, help="v2: skybox face size (px)")
    ap.add_argument("--power", type=float, default=PHOTO_POWER, help="v2: photo blend sharpness")
    ap.add_argument("--max-cams", type=int, default=0, help="v2: use at most this many training cameras (smoke tests)")
    ap.add_argument("--jpeg-quality", type=int, default=88, help="v2: texture JPEG quality")
    ap.add_argument("--max-parts", type=int, default=0, help="v2: lower the JPEG quality until the model fits this many files")
    ap.add_argument("--flat-ceiling", type=float, default=0.0, metavar="M",
                    help="v2: a ceiling the cameras never looked at fuses into folds hanging under it: inside its walls, "
                         "drop what lies within M metres under it (not its flat parts or the walls) and close it flat")
    args = ap.parse_args(argv)
    log = _log_noop if args.quiet else (lambda m: print(f"[roblox_mesh] {m}", file=sys.stderr, flush=True))
    try:
        if args.v2 or args.photos:
            tri = args.triangles if args.triangles != DEFAULT_TRIANGLES else V2_TRIANGLES
            pos = args.positions if args.positions != MAX_POSITIONS else V2_POSITIONS
            r = build_model_v2(args.scene, args.out, args.photos, tri, args.texture, args.voxel, args.near_margin, pos,
                               args.face_res, not args.no_sky, args.sky_size, args.power, args.device, args.workers,
                               args.key, args.hole_edges, log, max_cams=args.max_cams, jpeg_quality=args.jpeg_quality,
                               max_parts=args.max_parts, flat_ceiling=args.flat_ceiling)
        else:
            r = build_model(args.scene, args.out, args.triangles, args.texture, args.voxel, args.positions,
                            args.face_res, not args.no_texture, args.device, args.workers, args.key, args.sheet,
                            args.hole_edges, log)
    except MeshError as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        print(f"roblox_mesh: {e}", file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "triangles": r["triangles"], "chunks": len(r["chunks"]), "bytes": r["bytes"],
                      "parts": [p["file"] for p in r.get("parts", [])] or [GLB_FILE], "sky": bool(r.get("sky")),
                      "seconds": r["build"]["seconds"]["total"], "out": str(Path(args.out or args.scene) / GLB_FILE)}),
          flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
