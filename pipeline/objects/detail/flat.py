"""Object classes and their reconstruction parameters, and the flat path for posters and signs.

A TSDF shell around a poster is a lumpy pillow with the picture smeared over its edges. A poster is a rectangle:
`slab()` makes a thin bevelled box whose front face carries the poster rectified from the best frontal view.
Rectified sign textures go through the ink pass by default (Roblox moderation, docs/object-layer.md section 14).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from objects.detail.glb import Prim

SMALL_M3 = 0.2  # brief: objects under 0.2 m^3 get a finer voxel and a smaller minimum component
FLAT_RATIO = 0.12  # thinnest extent / middle extent
FLAT_MAX_M = 0.08  # and no thicker than 8 cm
FLAT_LABELS = {"poster", "sign", "picture", "painting", "frame", "whiteboard", "board", "calendar", "menu", "map",
               "clock", "mirror", "tv", "television", "screen", "monitor"}


@dataclass
class Params:
    kind: str  # "regular", "small" or "flat"
    voxel: float  # metres
    size: int  # orbit render resolution
    count: int  # views per elevation ring
    elevations: tuple[float, ...]
    texture: int
    room_chunks: int
    chunk_triangles: int
    triangles: int
    min_component: float  # m^2 of surface below which a fragment is dropped
    airborne_m2: float
    margin: float
    ink: float | None

    def to_json(self) -> dict:
        d = asdict(self)
        d["elevations"] = list(self.elevations)
        return d


def principal_axes(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(centre, axes [3x3] columns sorted longest first, half extents) from robust (2-98 percentile) PCA."""
    P = np.asarray(points, np.float64)
    c = np.median(P, axis=0)
    _, _, vt = np.linalg.svd(P - c, full_matrices=False)
    axes = vt.T
    proj = (P - c) @ axes
    lo, hi = np.percentile(proj, 2, axis=0), np.percentile(proj, 98, axis=0)
    centre = c + axes @ ((lo + hi) / 2)
    half = (hi - lo) / 2
    order = np.argsort(-half)
    axes, half = axes[:, order], half[order]
    if np.linalg.det(axes) < 0:
        axes[:, 2] *= -1
    return centre, axes, half


def classify(size_m: np.ndarray, label: str = "", points: np.ndarray | None = None) -> str:
    """'flat', 'small' or 'regular' from the object's box (metres) and, when given, its splat centres."""
    ext = np.sort(np.asarray(size_m, np.float64))
    if points is not None and len(points) >= 50:
        _, _, half = principal_axes(points)
        pext = np.sort(half * 2)
        if pext[0] < FLAT_MAX_M and pext[0] < FLAT_RATIO * pext[1]:
            return "flat"
    elif ext[0] < FLAT_MAX_M and ext[0] < FLAT_RATIO * ext[1]:
        return "flat"
    if label.lower() in FLAT_LABELS and ext[0] < 0.15:
        return "flat"
    return "small" if float(np.prod(ext)) < SMALL_M3 else "regular"


def params_for(size_m: np.ndarray, kind: str) -> Params:
    """Adaptive parameters from the brief: 0.5-1 cm voxels scaled to the object, >=1024 px object-centric views,
    a 2048 atlas, 1-2 chunks and a minimum component scaled to the object so thin parts (handles, knobs) survive."""
    ext = float(np.max(size_m))
    voxel = float(np.clip(ext / 256.0, 0.005, 0.01))
    min_component = float(np.clip((0.02 * ext) ** 2, 2e-5, 1e-3))
    if kind == "small":
        voxel = float(np.clip(ext / 320.0, 0.004, 0.006))
        min_component = float(np.clip((0.01 * ext) ** 2, 5e-6, 2e-4))
    tri = 18000
    chunks = 2 if (kind == "regular" and ext > 1.2) else 1
    return Params(kind=kind, voxel=voxel, size=1024 if kind != "small" else 1280, count=16,
                  elevations=(-15.0, 10.0, 35.0, 60.0), texture=2048, room_chunks=chunks, chunk_triangles=tri,
                  triangles=tri * chunks, min_component=min_component, airborne_m2=0.0,
                  margin=0.08 if kind == "small" else 0.12, ink=1.2 if kind == "flat" else None)


def rectify(image: np.ndarray, c2w: np.ndarray, fx: float, fy: float, cx: float, cy: float, centre: np.ndarray,
            right: np.ndarray, up: np.ndarray, half_w: float, half_h: float, width: int, height: int) -> np.ndarray:
    """Resample the rectangle (centre +- right*half_w +- up*half_h) seen in a pinhole image into a
    width x height texture (row 0 at the top). Bilinear; texels that project off-image are clamped."""
    from objects.detail.raster import _sample

    s = (np.arange(width) + 0.5) / width * 2 - 1
    t = 1 - (np.arange(height) + 0.5) / height * 2
    S, T = np.meshgrid(s, t)
    P = centre + S[..., None] * half_w * right + T[..., None] * half_h * up
    R, tr = c2w[:3, :3], c2w[:3, 3]
    pc = (P.reshape(-1, 3) - tr) @ R
    z = np.maximum(-pc[:, 2], 1e-6)
    u = cx + fx * pc[:, 0] / z
    v = cy - fy * pc[:, 1] / z
    h, w = image.shape[:2]
    out = _sample(image, np.stack([u / w, v / h], axis=1))
    return np.clip(out * 255, 0, 255).astype(np.uint8).reshape(height, width, 3)


def slab(centre: np.ndarray, right: np.ndarray, up: np.ndarray, normal: np.ndarray, half_w: float, half_h: float,
         thickness: float, front: np.ndarray, bevel: float | None = None, name: str = "poster") -> Prim:
    """A thin box with a chamfered front edge. The front face shows `front` (uint8 HxWx3); bevel, sides and back
    use the poster's mean border colour from a strip at the bottom of the atlas. ~28 triangles."""
    right, up, normal = (np.asarray(a, np.float64) / np.linalg.norm(a) for a in (right, up, normal))
    centre = np.asarray(centre, np.float64)
    bevel = min(bevel if bevel is not None else min(thickness * 0.6, 0.006), 0.45 * min(half_w, half_h))
    d = thickness / 2
    hfront, wfront = front.shape[:2]
    strip = max(8, hfront // 16)
    border = np.concatenate([front[:2].reshape(-1, 3), front[-2:].reshape(-1, 3), front[:, :2].reshape(-1, 3),
                             front[:, -2:].reshape(-1, 3)]).mean(axis=0)
    atlas = np.concatenate([front, np.broadcast_to(border.astype(np.uint8), (strip, wfront, 3))], axis=0)
    vmax = hfront / (hfront + strip)  # front face uses v in [0, vmax]
    edge_uv = np.array([0.5, (vmax + 1) / 2])

    def P(sx, sy, sz, inset=0.0):
        return centre + right * sx * (half_w - inset) + up * sy * (half_h - inset) + normal * sz * d

    V, UV, N, F = [], [], [], []

    def quad(pts, uvs, n):
        b = len(V)
        V.extend(pts)
        UV.extend(uvs)
        N.extend([n] * 4)
        F.extend([[b, b + 1, b + 2], [b, b + 2, b + 3]])

    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]  # counter-clockwise seen from the front
    # front face, inset by the bevel; texture fills it edge to edge
    quad([P(sx, sy, 1, bevel) for sx, sy in corners], [((sx + 1) / 2, (1 - sy) / 2 * vmax) for sx, sy in corners],
         normal)
    # chamfer ring and sides
    for k in range(4):
        a, b = corners[k], corners[(k + 1) % 4]
        out_dir = right * (a[0] + b[0]) / 2 + up * (a[1] + b[1]) / 2
        out_dir /= np.linalg.norm(out_dir)
        n_bev = (out_dir + normal) / np.linalg.norm(out_dir + normal)
        quad([P(*a, 1 - 2 * bevel / thickness if thickness > 2 * bevel else 0.0), P(*b, 1 - 2 * bevel / thickness
              if thickness > 2 * bevel else 0.0), P(*b, 1, bevel), P(*a, 1, bevel)], [edge_uv] * 4, n_bev)
        z0 = 1 - 2 * bevel / thickness if thickness > 2 * bevel else 0.0
        quad([P(*a, -1), P(*b, -1), P(*b, z0), P(*a, z0)], [edge_uv] * 4, out_dir)
    # back
    quad([P(sx, sy, -1) for sx, sy in reversed(corners)], [edge_uv] * 4, -normal)
    return Prim(name, np.asarray(V), np.asarray(F, np.int64), np.asarray(N), np.asarray(UV, np.float64),
                np.ascontiguousarray(atlas))


def frontal_view(normal: np.ndarray, centre: np.ndarray, cameras: list[dict]) -> int | None:
    """Index of the camera that sees the front of a flat object most squarely (and from in front of it)."""
    best, score = None, -1.0
    for i, cam in enumerate(cameras):
        c2w = np.asarray(cam["c2w"], np.float64)
        to_cam = c2w[:3, 3] - centre
        dist = np.linalg.norm(to_cam)
        if dist < 1e-6:
            continue
        facing = float(to_cam @ normal) / dist
        looking = float(-c2w[:3, 2] @ (centre - c2w[:3, 3])) / dist
        s = facing * max(looking, 0.0) / (1 + 0.15 * dist)
        if facing > 0.3 and looking > 0.5 and s > score:
            best, score = i, s
    return best
