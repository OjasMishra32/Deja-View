"""Step 1, find the gaps: what the footage never really saw, seen from where people will stand.

Probe views stand on a grid in the walkable area (world.bounds, within reach of the training cameras) at eye height,
looking 8 ways at pitches -30, 0, +40, +75 degrees. Each view is rendered with gsplat twice: the world, and a
per-splat "low confidence" channel (splats fewer than --min-views training cameras saw well). A pixel is bad when the
world is see-through there (alpha < 0.5: a hole) or most of what paints it is low-confidence (a smear). Bad pixels
are lifted to 3D (rendered depth; holes take the depth of their rim) and clustered into regions in a voxel grid.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import geom as G
from .gpu import GS, DirBins, low_confidence, render, say, to_u8


@dataclass
class GapConfig:
    spacing: float = 1.2
    eye: float = 1.6
    coverage: float = 3.0
    inset: float = 0.3
    yaws: int = 8
    pitches: tuple = (-30.0, 0.0, 40.0, 75.0)
    width: int = 256
    height: int = 192
    hfov: float = 90.0
    min_views: int = 3          # a splat seen well by fewer training cameras is low-confidence
    protect_px: float = 16.0    # a splat painting this many pixel-equivalents in any training view is never removed
    view_angle: float = 40.0    # ... and so is one never seen within this angle of the viewing direction
    max_elev: float = 90.0      # highest ray elevation (deg) any training camera's frame reached (set by find())
    elev_margin: float = 5.0    # pixels looking higher than max_elev + this were never seen from anywhere
    cover_elev: float = 20.0    # above this elevation a pixel also needs a nearby camera that looked that way
    cover_radius: float = 2.5   # "nearby": training cameras within this distance of the viewpoint
    cover_margin: float = 0.03  # share of the frame border that does not count as covered
    hole_alpha: float = 0.5
    thin_alpha: float = 0.0     # see-through cue (off: layered reflections in glossy floors and glass trip it)
    low_share: float = 0.5
    incoherent: float = 99.0    # depth-spread cue (off by default, same reason)
    hole_cap: float = 12.0      # holes take their rim's depth, at most this far
    point_stride: int = 4
    voxel: float = 0.6
    min_region_px: float = 400.0
    inside_radius: float = 0.3
    inside_count: int = 40
    max_regions: int = 12
    near_depth: float = 0.8
    max_near: float = 0.3       # views with more than this share closer than near_depth are not judged


@dataclass
class Gaps:
    cfg: GapConfig
    views: list = field(default_factory=list)       # probe views with scores
    regions: list = field(default_factory=list)
    points: np.ndarray | None = None                 # [M,3] bad-pixel points
    point_view: np.ndarray | None = None             # [M] view index
    point_kind: np.ndarray | None = None             # [M] 0 = hole, 1 = low confidence
    labels: np.ndarray | None = None                 # [M] region id (-1 = none)
    spots: np.ndarray | None = None

    def region_points(self, rid: int) -> np.ndarray:
        return self.points[self.labels == rid]


_BINS: dict = {}


def bins_for(cfg: GapConfig, device: str = "cuda") -> DirBins:
    key = (cfg.view_angle, device)
    if key not in _BINS:
        _BINS[key] = DirBins(cfg.view_angle, device=device)
    return _BINS[key]


def score_view(gs: GS, c2w: np.ndarray, k: G.Intr, cfg: GapConfig):
    """Render one view and classify its pixels: (render dict, alpha, depth, hole mask, smear mask).
    hole: alpha < hole_alpha. smear: see-through (alpha < thin_alpha), mostly painted by low-confidence splats, or
    painted by layers spread over a large depth range (no coherent surface: a streaky, noisy patch)."""
    import torch

    low = low_confidence(gs, c2w[:3, 3], bins_for(cfg, gs.device), cfg.min_views).float()
    w2c = torch.from_numpy(G.w2c_cv(c2w).astype(np.float32)).to(gs.device)
    z = gs.means @ w2c[2, :3] + w2c[2, 3]
    r = render(gs, c2w, k, extras=torch.stack([low, z, z * z], 1), sh=False)
    alpha = r["alpha"].cpu().numpy()
    depth = r["depth"].cpu().numpy()
    ex = r["extras"].cpu().numpy()
    a = np.maximum(alpha, 1e-3)
    ez, ez2 = ex[..., 1] / a, ex[..., 2] / a
    spread = np.sqrt(np.maximum(ez2 - ez * ez, 0.0)) / np.maximum(ez, 1e-3)
    hole = alpha < cfg.hole_alpha
    above = unseen_directions(c2w, k, cfg)
    lowc = ~hole & ((ex[..., 0] / a > cfg.low_share) | (alpha < cfg.thin_alpha) | (spread > cfg.incoherent) | above)
    r["spread"] = spread
    r["above"] = above
    return r, alpha, depth, hole, lowc


_ELEV: dict = {}


def pixel_elevation(c2w: np.ndarray, k: G.Intr) -> np.ndarray:
    """Elevation (degrees above the horizon) of every pixel's ray."""
    j, i = G.pixel_grid(k)
    d = G.ray_dirs_world(k, c2w, j, i)
    return np.degrees(np.arcsin(np.clip(d[:, 1], -1, 1))).reshape(k.height, k.width)


_CAMS: list = []


def set_cameras(cams) -> None:
    """The training cameras unseen_directions() checks against (find() sets them)."""
    _CAMS[:] = list(cams)


def unseen_directions(c2w: np.ndarray, k: G.Intr, cfg: GapConfig) -> np.ndarray:
    """Pixels whose ray points where the footage never looked from around here: higher than any training frame
    reached anywhere, or above cover_elev with no training camera within cover_radius that had that direction
    inside its frame. Looking up from where people walked, this is the ceiling and the tree tops."""
    import torch

    e = pixel_elevation(c2w, k)
    out = e > cfg.max_elev + cfg.elev_margin
    cand = (e > cfg.cover_elev) & ~out
    if not cand.any():
        return out
    pos = np.asarray(c2w[:3, 3], np.float64)
    near = [c for c in _CAMS if np.linalg.norm(c.position - pos) <= cfg.cover_radius]
    if not near:
        return out | cand
    j, i = np.nonzero(cand)
    d = torch.from_numpy(G.ray_dirs_world(k, c2w, j, i).astype(np.float32)).cuda()
    covered = torch.zeros(len(j), dtype=torch.bool, device=d.device)
    for c in near:
        R = torch.from_numpy(G.w2c_cv(c.c2w)[:3, :3].astype(np.float32)).cuda()
        dc = d @ R.T
        z = dc[:, 2]
        ok = z > 1e-3
        u = c.intr.fx * dc[:, 0] / z.clamp_min(1e-3) + c.intr.cx
        v = c.intr.fy * dc[:, 1] / z.clamp_min(1e-3) + c.intr.cy
        m = cfg.cover_margin
        covered |= ok & (u > m * c.intr.width) & (u < (1 - m) * c.intr.width) & (v > m * c.intr.height) & (v < (1 - m) * c.intr.height)
    unc = (~covered).cpu().numpy()
    out = out.copy()
    out[j[unc], i[unc]] = True
    return out


def max_camera_elevation(cams) -> float:
    """The highest elevation any training camera's frame reached (anywhere on its border)."""
    best = -90.0
    for c in cams:
        k = c.intr
        xs = np.linspace(0, k.width - 1, 33).astype(int)
        ys = np.linspace(0, k.height - 1, 25).astype(int)
        j = np.concatenate([np.zeros_like(xs), np.full_like(xs, k.height - 1), ys, ys])
        i = np.concatenate([xs, xs, np.zeros_like(ys), np.full_like(ys, k.width - 1)])
        d = G.ray_dirs_world(k, c.c2w, j, i)
        best = max(best, float(np.degrees(np.arcsin(np.clip(d[:, 1], -1, 1))).max()))
    return best


def bad_points(depth: np.ndarray, alpha: np.ndarray, hole: np.ndarray, lowc: np.ndarray, c2w: np.ndarray, k: G.Intr,
               cfg: GapConfig, stride: int | None = None):
    """3D points for the bad pixels of one view (every stride-th pixel): (points [M,3], kind [M], (row, col) [M,2])."""
    stride = stride or cfg.point_stride
    valid = alpha >= cfg.hole_alpha
    if not valid.any():
        return np.zeros((0, 3)), np.zeros(0, np.int8), np.zeros((0, 2), int)
    d = G.fill_depth_from_neighbours(depth, valid & (depth > 0), cap=cfg.hole_cap)
    sel = np.zeros_like(hole)
    sel[::stride, ::stride] = (hole | lowc)[::stride, ::stride]
    j, i = np.nonzero(sel)
    pts = G.backproject(i + 0.5, j + 0.5, d[j, i], c2w, k)
    kind = np.where(hole[j, i], 0, 1).astype(np.int8)
    return pts, kind, np.stack([j, i], 1)


def inside_geometry(gs: GS, spots_xyz: np.ndarray, radius: float, count: int) -> np.ndarray:
    """True for spots with many opaque splats within `radius` (standing inside furniture or a wall)."""
    from scipy.spatial import cKDTree

    m = gs.means[gs.opac > 0.3].cpu().numpy()
    if len(m) == 0 or len(spots_xyz) == 0:
        return np.zeros(len(spots_xyz), bool)
    tree = cKDTree(m)
    n = np.array([len(x) for x in tree.query_ball_point(spots_xyz, radius)])
    return n >= count


def reachable(gs: GS, spots_xyz: np.ndarray, cam_pos: np.ndarray, coverage: float, near: int = 5) -> np.ndarray:
    """A spot counts when the straight line to one of its nearest training cameras (within `coverage`) is clear:
    a narrow render from the spot towards the camera shows nothing opaque before it. Spots behind walls (inside
    the bounds box, but never walked) are dropped."""
    k = G.intrinsics(9, 9, 4.0)
    out = np.zeros(len(spots_xyz), bool)
    for i, p in enumerate(spots_xyz):
        d = np.linalg.norm((cam_pos - p)[:, [0, 2]], axis=1)
        for j in np.argsort(d)[:near]:
            if d[j] > coverage:
                break
            dist = float(np.linalg.norm(cam_pos[j] - p))
            if dist < 0.3:
                out[i] = True
                break
            r = render(gs, G.look_at_c2w(p, cam_pos[j]), k, sh=False)
            a = float(r["alpha"][4, 4])
            z = float(r["depth"][4, 4])
            if a < 0.6 or z > dist - 0.25:
                out[i] = True
                break
    return out


def find(world, gs: GS, cfg: GapConfig) -> Gaps:
    bmin, bmax = world.bounds
    if world.cams:
        set_cameras(world.cams)
        cfg.max_elev = max_camera_elevation(world.cams)
        say(f"the footage looked up to {cfg.max_elev:.0f} deg above the horizon")
    spots = G.probe_positions(bmin, bmax, world.cam_xz(), cfg.spacing, cfg.coverage, cfg.inset)
    eye_xyz = np.stack([spots[:, 0], np.full(len(spots), cfg.eye), spots[:, 1]], 1) if len(spots) else np.zeros((0, 3))
    inside = inside_geometry(gs, eye_xyz, cfg.inside_radius, cfg.inside_count)
    cams = np.array([c.position for c in world.cams]) if world.cams else np.zeros((0, 3))
    reach = reachable(gs, eye_xyz, cams, cfg.coverage) if len(cams) else np.ones(len(spots), bool)
    keep = ~inside & reach
    spots = spots[keep]
    views = G.probe_views(spots, cfg.eye, cfg.yaws, cfg.pitches)
    say(f"{len(spots)} standing spots ({int(inside.sum())} inside things, {int((~reach & ~inside).sum())} behind walls dropped), "
        f"{len(views)} probe views")
    k = G.intrinsics(cfg.width, cfg.height, cfg.hfov)
    P, V, KND = [], [], []
    for vi, v in enumerate(views):
        c2w = G.yaw_pitch_c2w(v["position"], v["yaw"], v["pitch"])
        _, alpha, depth, hole, lowc = score_view(gs, c2w, k, cfg)
        v["hole"] = float(hole.mean())
        v["low"] = float(lowc.mean())
        v["bad"] = v["hole"] + v["low"]
        v["near"] = float(((depth > 0) & (depth < cfg.near_depth)).mean())  # standing against a wall or trunk
        pts, kind, _ = bad_points(depth, alpha, hole, lowc, c2w, k, cfg)
        if len(pts):
            P.append(pts)
            V.append(np.full(len(pts), vi, np.int32))
            KND.append(kind)
    gaps = Gaps(cfg, views, spots=spots)
    if not P:
        gaps.points, gaps.point_view, gaps.point_kind, gaps.labels = np.zeros((0, 3)), np.zeros(0, np.int32), np.zeros(0, np.int8), np.zeros(0, int)
        return gaps
    pts, pv, pk = np.concatenate(P), np.concatenate(V), np.concatenate(KND)
    px_per_point = cfg.point_stride ** 2
    labels, regions = G.voxel_regions(pts, np.full(len(pts), float(px_per_point)), cfg.voxel, cfg.min_region_px)
    gaps.points, gaps.point_view, gaps.point_kind, gaps.labels = pts, pv, pk, labels
    pitches = np.array([v["pitch"] for v in views])
    for r in regions:
        m = labels == r["id"]
        vids, cnt = np.unique(pv[m], return_counts=True)
        order = np.argsort(-cnt)
        r["views"] = [{"view": int(vids[o]), "px": int(cnt[o]) * px_per_point} for o in order[:40]]
        r["holeShare"] = float((pk[m] == 0).mean())
        r["meanPitch"] = float(np.average(pitches[pv[m]]))
        c = np.asarray(r["centroid"])
        r["kind"] = guess_kind(c, r["meanPitch"], r["holeShare"], bmax)
    gaps.regions = regions
    say(f"{len(pts)} bad-pixel points -> {len(regions)} regions; top: " +
        ", ".join(f"#{r['id']} {r['kind']} {r['mass']:.0f}px y={r['centroid'][1]:.1f}" for r in regions[:8]))
    return gaps


def guess_kind(centroid: np.ndarray, mean_pitch: float, hole_share: float, bmax: np.ndarray) -> str:
    """A first label before the captioner looks at it (only used in logs and evidence names)."""
    y = float(centroid[1])
    if mean_pitch >= 30 and y > 2.2:
        return "overhead"
    if mean_pitch <= -15 and y < 0.5:
        return "floor"
    return "wall" if hole_share < 0.5 else "opening"


def overlay(rgb: np.ndarray, hole: np.ndarray, lowc: np.ndarray, alpha: float = 0.55) -> np.ndarray:
    out = rgb.astype(np.float32).copy()
    out[hole] = out[hole] * (1 - alpha) + np.array([255, 40, 40]) * alpha
    out[lowc] = out[lowc] * (1 - alpha) + np.array([255, 220, 0]) * alpha
    return np.clip(out, 0, 255).astype(np.uint8)


def worst_views(gaps: Gaps, n: int, pitch_min: float | None = None, pitch_max: float | None = None,
                min_spacing: float = 1.0) -> list[int]:
    """The n views with the most bad pixels (optionally within a pitch range), at most one per spot and yaw sector,
    spots at least min_spacing apart for variety."""
    idx = [i for i, v in enumerate(gaps.views)
           if (pitch_min is None or v["pitch"] >= pitch_min) and (pitch_max is None or v["pitch"] <= pitch_max)
           and v.get("near", 0.0) <= gaps.cfg.max_near]
    idx.sort(key=lambda i: -gaps.views[i]["bad"])
    out, used = [], []
    for i in idx:
        p = np.asarray(gaps.views[i]["position"])
        if any(np.linalg.norm(p - q) < min_spacing for q in used):
            continue
        out.append(i)
        used.append(p)
        if len(out) >= n:
            break
    return out


def contact(gs: GS, gaps: Gaps, ids: list[int], k: G.Intr, cfg: GapConfig, title: str = "") -> np.ndarray:
    from .world import label, sheet

    tiles = []
    for i in ids:
        v = gaps.views[i]
        c2w = G.yaw_pitch_c2w(v["position"], v["yaw"], v["pitch"])
        r, alpha, depth, hole, lowc = score_view(gs, c2w, k, cfg)
        rgb = to_u8(render(gs, c2w, k)["rgb"])
        t = overlay(rgb, hole, lowc)
        p = v["position"]
        tiles.append(label(t, f"{title}({p[0]:+.1f},{p[2]:+.1f}) yaw {v['yaw']:.0f} pitch {v['pitch']:+.0f} hole {hole.mean():.2f} low {lowc.mean():.2f}", 0.4))
    return sheet(tiles, cols=4) if tiles else np.zeros((8, 8, 3), np.uint8)
