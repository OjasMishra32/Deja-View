"""Cameras, rays, depth alignment, Gaussians from pixels, 3D clustering and mask helpers (numpy + scipy only).

Frames follow the scene files: world = viewer frame (y up, metres, floor y = 0, spawn looks down -Z). Camera poses
are camera-to-world 4x4 matrices in the OpenGL convention (camera looks down -Z, +Y up), like cameras.json and
splat_io. Pixel (i, j) has its centre at (i + 0.5, j + 0.5); K is (fx, fy, cx, cy) in that pixel frame (gsplat's).
Depth maps are z-depth (distance along the camera's forward axis).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

# --------------------------------------------------------------------------------------------------------------
# Cameras
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Intr:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int

    def K(self) -> np.ndarray:
        return np.array([[self.fx, 0, self.cx], [0, self.fy, self.cy], [0, 0, 1]], np.float64)

    def scaled(self, s: float) -> "Intr":
        w, h = max(1, int(round(self.width * s))), max(1, int(round(self.height * s)))
        sx, sy = w / self.width, h / self.height
        return Intr(self.fx * sx, self.fy * sy, self.cx * sx, self.cy * sy, w, h)

    def to_json(self) -> dict:
        return {"fx": self.fx, "fy": self.fy, "cx": self.cx, "cy": self.cy, "width": self.width, "height": self.height}

    @staticmethod
    def from_json(d: dict) -> "Intr":
        return Intr(float(d["fx"]), float(d["fy"]), float(d["cx"]), float(d["cy"]), int(d["width"]), int(d["height"]))


def intrinsics(width: int, height: int, hfov_deg: float) -> Intr:
    f = 0.5 * width / math.tan(math.radians(hfov_deg) / 2)
    return Intr(f, f, width / 2.0, height / 2.0, int(width), int(height))


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], np.float64)


def rot_y(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], np.float64)


def yaw_pitch_c2w(position: Sequence[float], yaw_deg: float, pitch_deg: float) -> np.ndarray:
    """The viewer's camera: yaw about +Y (0 looks down -Z, positive turns left), then pitch (positive looks up)."""
    m = np.eye(4)
    m[:3, :3] = rot_y(math.radians(yaw_deg)) @ rot_x(math.radians(pitch_deg))
    m[:3, 3] = np.asarray(position, np.float64)
    return m


def look_at_c2w(eye: Sequence[float], target: Sequence[float], roll_up: Sequence[float] = (0, 1, 0)) -> np.ndarray:
    """OpenGL camera-to-world looking from eye at target, as level as possible (no roll)."""
    eye = np.asarray(eye, np.float64)
    f = np.asarray(target, np.float64) - eye
    f /= max(np.linalg.norm(f), 1e-9)
    up = np.asarray(roll_up, np.float64)
    if abs(float(f @ up)) > 0.999:  # straight up or down: keep -Z as the image's up direction
        up = np.array([0.0, 0.0, -1.0]) if f[1] > 0 else np.array([0.0, 0.0, 1.0])
    right = np.cross(f, up)
    right /= np.linalg.norm(right)
    cam_up = np.cross(right, f)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, cam_up, -f, eye
    return m


def yaw_pitch_of(c2w_gl: np.ndarray) -> tuple[float, float]:
    """(yaw, pitch) in degrees of a camera's viewing direction (the viewer's convention)."""
    f = -np.asarray(c2w_gl, np.float64)[:3, 2]
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, f[1]))))
    yaw = math.degrees(math.atan2(-f[0], -f[2]))
    return yaw, pitch


def w2c_cv(c2w_gl: np.ndarray) -> np.ndarray:
    """OpenGL camera-to-world -> OpenCV world-to-camera (gsplat's viewmat)."""
    m = np.array(c2w_gl, np.float64, copy=True)
    m[:3, 1] *= -1
    m[:3, 2] *= -1
    return np.linalg.inv(m)


def project(points: np.ndarray, c2w_gl: np.ndarray, k: Intr) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """World points [N,3] -> (u, v, z): pixel coordinates (continuous, centres at +0.5) and z-depth (> 0 in front)."""
    w2c = w2c_cv(c2w_gl)
    pc = np.asarray(points, np.float64) @ w2c[:3, :3].T + w2c[:3, 3]
    z = pc[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = k.fx * pc[:, 0] / z + k.cx
        v = k.fy * pc[:, 1] / z + k.cy
    return u, v, z


def backproject(u: np.ndarray, v: np.ndarray, z: np.ndarray, c2w_gl: np.ndarray, k: Intr) -> np.ndarray:
    """Pixels (continuous coordinates) with z-depth -> world points [N,3]."""
    x = (np.asarray(u, np.float64) - k.cx) / k.fx * z
    y = (np.asarray(v, np.float64) - k.cy) / k.fy * z
    pc = np.stack([x, y, np.asarray(z, np.float64)], axis=1)
    c2w_cv = np.linalg.inv(w2c_cv(c2w_gl))
    return pc @ c2w_cv[:3, :3].T + c2w_cv[:3, 3]


def pixel_grid(k: Intr, stride: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Integer pixel indices (row j, column i) of every stride-th pixel."""
    j, i = np.mgrid[0 : k.height : stride, 0 : k.width : stride]
    return j.reshape(-1), i.reshape(-1)


def ray_dirs_world(k: Intr, c2w_gl: np.ndarray, j: np.ndarray, i: np.ndarray) -> np.ndarray:
    """Unit world directions through pixel centres."""
    x = (i + 0.5 - k.cx) / k.fx
    y = (j + 0.5 - k.cy) / k.fy
    d = np.stack([x, y, np.ones_like(x)], axis=1)
    c2w_cv = np.linalg.inv(w2c_cv(c2w_gl))
    d = d @ c2w_cv[:3, :3].T
    return d / np.linalg.norm(d, axis=1, keepdims=True)


# --------------------------------------------------------------------------------------------------------------
# Probe views
# --------------------------------------------------------------------------------------------------------------


def probe_positions(bmin: Sequence[float], bmax: Sequence[float], cam_xz: np.ndarray, spacing: float = 1.2,
                    coverage: float = 3.0, inset: float = 0.3) -> np.ndarray:
    """Standing spots [P,2] (x, z) on a spacing grid inside the bounds box (inset from its walls) and within
    `coverage` metres of some training camera (the area the footage walked through)."""
    x0, z0 = float(bmin[0]) + inset, float(bmin[2]) + inset
    x1, z1 = float(bmax[0]) - inset, float(bmax[2]) - inset
    if x1 <= x0 or z1 <= z0:
        return np.zeros((0, 2))
    nx = max(1, int(math.floor((x1 - x0) / spacing)) + 1)
    nz = max(1, int(math.floor((z1 - z0) / spacing)) + 1)
    # centre the lattice in the box
    ox = x0 + 0.5 * ((x1 - x0) - (nx - 1) * spacing)
    oz = z0 + 0.5 * ((z1 - z0) - (nz - 1) * spacing)
    gx, gz = np.meshgrid(ox + spacing * np.arange(nx), oz + spacing * np.arange(nz), indexing="ij")
    pts = np.stack([gx.reshape(-1), gz.reshape(-1)], axis=1)
    cam_xz = np.asarray(cam_xz, np.float64).reshape(-1, 2)
    if len(cam_xz) and coverage > 0:
        d = np.sqrt(((pts[:, None, :] - cam_xz[None, :, :]) ** 2).sum(-1)).min(1)
        pts = pts[d <= coverage]
    return pts


def probe_views(positions_xz: np.ndarray, eye: float = 1.6, yaws: int = 8,
                pitches: Iterable[float] = (-30.0, 0.0, 40.0, 75.0)) -> list[dict]:
    out = []
    for p, (x, z) in enumerate(np.asarray(positions_xz, np.float64).reshape(-1, 2)):
        for pitch in pitches:
            for k in range(yaws):
                yaw = 360.0 * k / yaws
                out.append({"spot": p, "position": [float(x), float(eye), float(z)], "yaw": yaw, "pitch": float(pitch)})
    return out


# --------------------------------------------------------------------------------------------------------------
# Depth alignment, normals, Gaussians from pixels
# --------------------------------------------------------------------------------------------------------------


def align_depth(pred: np.ndarray, ref: np.ndarray, weight: np.ndarray | None = None, iters: int = 8,
                delta: float = 0.05) -> tuple[float, float, dict]:
    """Scale + shift taking a monocular depth `pred` onto the rendered depth `ref` (both [M]): a RANSAC start, then
    iteratively reweighted least squares with a Cauchy weight on the relative residual (scale*pred + shift - ref) / ref."""
    pred = np.asarray(pred, np.float64).reshape(-1)
    ref = np.asarray(ref, np.float64).reshape(-1)
    w0 = np.ones_like(ref) if weight is None else np.asarray(weight, np.float64).reshape(-1)
    ok = np.isfinite(pred) & np.isfinite(ref) & (ref > 0) & (w0 > 0)
    pred, ref, w0 = pred[ok], ref[ok], w0[ok]
    if len(ref) < 8:
        return 1.0, 0.0, {"points": int(len(ref)), "ok": False}
    inv = 1.0 / ref
    # robust start: RANSAC over point pairs (relative residual below 5% = inlier), then IRLS from its inliers
    rng = np.random.default_rng(0)
    best, a, b = -1.0, 1.0, 0.0
    for _ in range(200):
        i, j = rng.integers(len(ref), size=2)
        if abs(pred[i] - pred[j]) < 1e-6:
            continue
        aa = (ref[i] - ref[j]) / (pred[i] - pred[j])
        if aa <= 0:
            continue
        bb = ref[i] - aa * pred[i]
        score = float((w0 * (np.abs((aa * pred + bb - ref) * inv) < 0.05)).sum())
        if score > best:
            best, a, b = score, aa, bb
    w = w0 * (np.abs((a * pred + b - ref) * inv) < 0.15) if best > 0 else w0.copy()
    for _ in range(iters):
        sw = np.sqrt(w) * inv  # relative residuals
        A = np.stack([pred * sw, sw], axis=1)
        sol, *_ = np.linalg.lstsq(A, ref * sw, rcond=None)
        a, b = float(sol[0]), float(sol[1])
        r = np.abs((a * pred + b - ref) * inv)
        w = w0 / (1.0 + (r / delta) ** 2)  # Cauchy: far outliers stop pulling
    r = (a * pred + b - ref) * inv
    if a <= 0:  # degenerate fit: fall back to a pure scale (median ratio)
        a, b = float(np.median(ref / np.maximum(pred, 1e-6))), 0.0
        r = (a * pred + b - ref) * inv
    return a, b, {"points": int(len(ref)), "ok": True, "medianRelErr": float(np.median(np.abs(r))),
                  "p90RelErr": float(np.percentile(np.abs(r), 90))}


def depth_normals(depth: np.ndarray, k: Intr) -> np.ndarray:
    """Camera-frame (OpenCV) unit normals [H,W,3] from a z-depth map, facing the camera (n . ray < 0)."""
    h, w = depth.shape
    j, i = np.mgrid[0:h, 0:w]
    z = depth.astype(np.float64)
    X = np.stack([(i + 0.5 - k.cx) / k.fx * z, (j + 0.5 - k.cy) / k.fy * z, z], axis=-1)
    dx = np.zeros_like(X)
    dy = np.zeros_like(X)
    dx[:, 1:-1] = X[:, 2:] - X[:, :-2]
    dx[:, 0], dx[:, -1] = X[:, 1] - X[:, 0], X[:, -1] - X[:, -2]
    dy[1:-1] = X[2:] - X[:-2]
    dy[0], dy[-1] = X[1] - X[0], X[-1] - X[-2]
    n = np.cross(dx, dy)
    norm = np.linalg.norm(n, axis=-1, keepdims=True)
    n = np.where(norm > 1e-12, n / np.maximum(norm, 1e-12), np.array([0.0, 0.0, -1.0]))
    flip = (n * X).sum(-1) > 0
    n[flip] *= -1
    return n


def frames_from_normals(n: np.ndarray) -> np.ndarray:
    """Rotation matrices [N,3,3] whose third column is the given unit normal."""
    n = np.asarray(n, np.float64).reshape(-1, 3)
    helper = np.where(np.abs(n[:, 1:2]) < 0.9, np.array([[0.0, 1.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))
    t = np.cross(helper, n)
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    b = np.cross(n, t)
    return np.stack([t, b, n], axis=2)


def rotmats_to_quats_wxyz(R: np.ndarray) -> np.ndarray:
    """[N,3,3] rotation matrices -> [N,4] unit quaternions (w, x, y, z), w >= 0."""
    R = np.asarray(R, np.float64).reshape(-1, 3, 3)
    m00, m11, m22 = R[:, 0, 0], R[:, 1, 1], R[:, 2, 2]
    tr = m00 + m11 + m22
    q = np.zeros((len(R), 4))
    c0 = tr > 0
    s = np.sqrt(np.maximum(tr[c0] + 1.0, 1e-12)) * 2
    q[c0] = np.stack([0.25 * s, (R[c0, 2, 1] - R[c0, 1, 2]) / s, (R[c0, 0, 2] - R[c0, 2, 0]) / s, (R[c0, 1, 0] - R[c0, 0, 1]) / s], 1)
    c1 = ~c0 & (m00 > m11) & (m00 > m22)
    s = np.sqrt(np.maximum(1.0 + m00[c1] - m11[c1] - m22[c1], 1e-12)) * 2
    q[c1] = np.stack([(R[c1, 2, 1] - R[c1, 1, 2]) / s, 0.25 * s, (R[c1, 0, 1] + R[c1, 1, 0]) / s, (R[c1, 0, 2] + R[c1, 2, 0]) / s], 1)
    c2 = ~c0 & ~c1 & (m11 > m22)
    s = np.sqrt(np.maximum(1.0 + m11[c2] - m00[c2] - m22[c2], 1e-12)) * 2
    q[c2] = np.stack([(R[c2, 0, 2] - R[c2, 2, 0]) / s, (R[c2, 0, 1] + R[c2, 1, 0]) / s, 0.25 * s, (R[c2, 1, 2] + R[c2, 2, 1]) / s], 1)
    c3 = ~c0 & ~c1 & ~c2
    s = np.sqrt(np.maximum(1.0 + m22[c3] - m00[c3] - m11[c3], 1e-12)) * 2
    q[c3] = np.stack([(R[c3, 1, 0] - R[c3, 0, 1]) / s, (R[c3, 0, 2] + R[c3, 2, 0]) / s, (R[c3, 1, 2] + R[c3, 2, 1]) / s, 0.25 * s], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    return q


def quats_wxyz_to_rotmats(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, np.float64).reshape(-1, 4)
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], 1),
        np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], 1),
        np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], 1),
    ], 1)


@dataclass
class Lifted:
    means: np.ndarray      # [N,3] world
    scales: np.ndarray     # [N,3] linear
    quats: np.ndarray      # [N,4] wxyz
    rgb: np.ndarray        # [N,3] 0..1
    pixels: np.ndarray     # [N,2] (row, col) in the anchor image

    def __len__(self) -> int:
        return int(len(self.means))


def lift_pixels(rgb: np.ndarray, depth: np.ndarray, select: np.ndarray, c2w_gl: np.ndarray, k: Intr, stride: int = 2,
                footprint: float = 0.75, thickness: float = 0.15, max_stretch: float = 3.0) -> Lifted:
    """One flat Gaussian per stride-th selected pixel: centre on the pixel's ray at its depth, oriented along the
    surface normal of the depth map, in-plane size from the pixel footprint (stretched where the surface is seen at a
    slant, up to max_stretch), colour from the image."""
    h, w = depth.shape
    sel = np.zeros_like(select, bool)
    sel[::stride, ::stride] = select[::stride, ::stride]
    sel &= np.isfinite(depth) & (depth > 0)
    j, i = np.nonzero(sel)
    z = depth[j, i].astype(np.float64)
    pts = backproject(i + 0.5, j + 0.5, z, c2w_gl, k)
    n_cam = depth_normals(depth, k)[j, i]
    c2w_cv = np.linalg.inv(w2c_cv(c2w_gl))
    n_world = n_cam @ c2w_cv[:3, :3].T
    rays = ray_dirs_world(k, c2w_gl, j, i)
    cos = np.clip(np.abs((n_world * rays).sum(1)), 1.0 / max_stretch, 1.0)
    lat = footprint * stride * z / k.fx
    R = frames_from_normals(n_world)
    # stretch along the in-plane axis closest to the ray's slant direction: approximate with a uniform stretch
    s_in = lat / np.sqrt(cos)
    scales = np.stack([s_in, s_in, np.maximum(thickness * lat, 1e-4)], axis=1)
    col = rgb[j, i].astype(np.float64) / (255.0 if rgb.dtype == np.uint8 else 1.0)
    return Lifted(pts.astype(np.float32), scales.astype(np.float32), rotmats_to_quats_wxyz(R).astype(np.float32),
                  col.astype(np.float32), np.stack([j, i], 1))


# --------------------------------------------------------------------------------------------------------------
# 3D clustering
# --------------------------------------------------------------------------------------------------------------


def voxel_regions(points: np.ndarray, weights: np.ndarray | None = None, voxel: float = 0.6, min_mass: float = 0.0,
                  dilate: int = 0) -> tuple[np.ndarray, list[dict]]:
    """Connected components (26-neighbour) of the voxels the points fall in. Returns a region label per point (-1 =
    in a component lighter than min_mass) and per-region summaries, heaviest first (labels 0, 1, ...)."""
    from scipy import ndimage

    P = np.asarray(points, np.float64).reshape(-1, 3)
    wts = np.ones(len(P)) if weights is None else np.asarray(weights, np.float64).reshape(-1)
    if len(P) == 0:
        return np.zeros(0, int), []
    lo = P.min(0) - voxel * (1 + dilate)
    ijk = np.floor((P - lo) / voxel).astype(np.int64)
    dims = ijk.max(0) + 2 + dilate
    occ = np.zeros(tuple(dims), bool)
    occ[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    grown = ndimage.binary_dilation(occ, structure=np.ones((3, 3, 3), bool), iterations=dilate) if dilate > 0 else occ
    lab, n = ndimage.label(grown, structure=np.ones((3, 3, 3), bool))
    pl = lab[ijk[:, 0], ijk[:, 1], ijk[:, 2]] - 1
    mass = np.bincount(pl, weights=wts, minlength=n)
    order = np.argsort(-mass)
    remap = -np.ones(n, np.int64)
    regions = []
    for rank_src in order:
        if mass[rank_src] < min_mass or mass[rank_src] <= 0:
            continue
        new = len(regions)
        remap[rank_src] = new
        m = pl == rank_src
        Q, ww = P[m], wts[m]
        c = (Q * ww[:, None]).sum(0) / max(ww.sum(), 1e-12)
        regions.append({"id": new, "mass": float(mass[rank_src]), "points": int(m.sum()), "centroid": c.tolist(),
                        "min": Q.min(0).tolist(), "max": Q.max(0).tolist()})
    labels = np.where(pl >= 0, remap[np.maximum(pl, 0)], -1)
    return labels, regions


class VoxelSet:
    """Membership test for the voxels of a point set (used to tell which pixels belong to a region)."""

    def __init__(self, points: np.ndarray, voxel: float, dilate: int = 1):
        self.voxel = float(voxel)
        P = np.asarray(points, np.float64).reshape(-1, 3)
        base = np.floor(P / self.voxel).astype(np.int64)
        offs = np.array([(a, b, c) for a in range(-dilate, dilate + 1) for b in range(-dilate, dilate + 1)
                         for c in range(-dilate, dilate + 1)], np.int64)
        keys = (base[:, None, :] + offs[None]).reshape(-1, 3)
        self.keys = np.unique(self._key(keys))

    @staticmethod
    def _key(ijk: np.ndarray) -> np.ndarray:
        ijk = ijk + (1 << 20)
        return (ijk[:, 0] << 42) | (ijk[:, 1] << 21) | ijk[:, 2]

    def contains(self, points: np.ndarray) -> np.ndarray:
        P = np.asarray(points, np.float64).reshape(-1, 3)
        if len(P) == 0 or len(self.keys) == 0:
            return np.zeros(len(P), bool)
        k = self._key(np.floor(P / self.voxel).astype(np.int64))
        pos = np.minimum(np.searchsorted(self.keys, k), len(self.keys) - 1)
        return self.keys[pos] == k


# --------------------------------------------------------------------------------------------------------------
# Masks and compositing
# --------------------------------------------------------------------------------------------------------------


def fill_depth_from_neighbours(depth: np.ndarray, valid: np.ndarray, cap: float | None = None) -> np.ndarray:
    """Every invalid pixel takes the depth of its nearest valid pixel (holes get the depth of their rim)."""
    from scipy import ndimage

    if valid.all():
        out = depth.astype(np.float64).copy()
    elif not valid.any():
        out = np.full(depth.shape, cap if cap else 0.0)
    else:
        _, (jj, ii) = ndimage.distance_transform_edt(~valid, return_indices=True)
        out = depth[jj, ii].astype(np.float64)
    if cap is not None:
        out = np.minimum(out, cap)
    return out


def clean_mask(mask: np.ndarray, close: int = 3, min_frac: float = 0.0005, grow: int = 0) -> np.ndarray:
    """Close small gaps, drop specks smaller than min_frac of the image, grow by `grow` pixels."""
    from scipy import ndimage

    m = np.asarray(mask, bool)
    if close > 0:
        st = np.ones((3, 3), bool)
        m = ndimage.binary_closing(m, structure=st, iterations=close, border_value=0) | m
    lab, n = ndimage.label(m)
    if n:
        sizes = np.bincount(lab.reshape(-1), minlength=n + 1)
        keep = sizes >= max(1, int(min_frac * m.size))
        keep[0] = False
        m = keep[lab]
    if grow > 0:
        m = ndimage.binary_dilation(m, structure=np.ones((3, 3), bool), iterations=grow)
    return m


def feather(mask: np.ndarray, px: float) -> np.ndarray:
    """Soft alpha: 1 inside the mask, falling to 0 over `px` pixels outside it."""
    from scipy import ndimage

    if px <= 0:
        return mask.astype(np.float32)
    d = ndimage.distance_transform_edt(~mask)
    return np.clip(1.0 - d / px, 0.0, 1.0).astype(np.float32)


def ring(mask: np.ndarray, inner: int, outer: int) -> np.ndarray:
    """Pixels between `inner` and `outer` pixels outside the mask."""
    from scipy import ndimage

    d = ndimage.distance_transform_edt(~mask)
    return (d > inner) & (d <= outer)


def colour_match(gen: np.ndarray, ref: np.ndarray, region: np.ndarray, strength: float = 1.0,
                 max_offset: float = 255.0) -> np.ndarray:
    """Per-channel gain + offset taking `gen` onto `ref` over `region` (both uint8 [H,W,3]); returns uint8.
    max_offset bounds the shift at mid-grey, so a bright ring cannot lift a dark sky."""
    g = gen.astype(np.float64)
    if region.sum() < 50:
        return gen
    out = g.copy()
    for c in range(3):
        x, y = g[..., c][region], ref[..., c][region].astype(np.float64)
        sx, sy = x.std(), y.std()
        a = np.clip(sy / sx, 0.5, 2.0) if sx > 1e-3 else 1.0
        b = y.mean() - a * x.mean()
        a = 1.0 + strength * (a - 1.0)
        b = strength * b
        shift = (a - 1.0) * 128.0 + b  # change at mid-grey
        if abs(shift) > max_offset:
            b -= shift - np.sign(shift) * max_offset
        out[..., c] = a * g[..., c] + b
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def composite(base: np.ndarray, fill: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    a = alpha[..., None].astype(np.float64)
    return np.clip(base.astype(np.float64) * (1 - a) + fill.astype(np.float64) * a + 0.5, 0, 255).astype(np.uint8)


def magenta_fraction(rgb: np.ndarray, mask: np.ndarray) -> float:
    """Share of the masked pixels that still look like the magenta marker (the editor left them)."""
    if mask.sum() == 0:
        return 0.0
    x = rgb[mask].astype(np.int32)
    mag = (x[:, 0] > 170) & (x[:, 2] > 170) & (x[:, 1] < 90)
    return float(mag.mean())


def ceiling_height(means: np.ndarray, normals: np.ndarray, opacity: np.ndarray, flat: np.ndarray, xz_min, xz_max,
                   above: float, bin_m: float = 0.05, min_mass: float = 50.0) -> float | None:
    """Height of the dominant horizontal overhead surface: the 5 cm layer above `above` holding the most opacity of
    flat splats whose normal is vertical, inside the xz box. None when there is no clear one (open sky)."""
    m = np.asarray(means, np.float64)
    n = np.asarray(normals, np.float64)
    sel = (np.asarray(flat, bool) & (np.abs(n[:, 1]) > 0.9) & (np.asarray(opacity) > 0.3) & (m[:, 1] > above)
           & (m[:, 0] > xz_min[0]) & (m[:, 0] < xz_max[0]) & (m[:, 2] > xz_min[1]) & (m[:, 2] < xz_max[1]))
    if sel.sum() < 20:
        return None
    y = m[sel, 1]
    w = np.asarray(opacity, np.float64)[sel]
    edges = np.arange(above, y.max() + bin_m, bin_m)
    if len(edges) < 2:
        return None
    hist, _ = np.histogram(y, bins=edges, weights=w)
    hist = np.convolve(hist, np.ones(3), mode="same")
    i = int(np.argmax(hist))
    if hist[i] < min_mass:
        return None
    return float(edges[i] + bin_m / 2)


def snap_to_ceiling(depth: np.ndarray, select: np.ndarray, c2w_gl: np.ndarray, k: Intr, height: float,
                    tol: float = 0.8, min_up: float = 0.3) -> tuple[np.ndarray, int]:
    """Moves selected pixels that land within `tol` below the ceiling plane y = height, or above it (impossible
    inside the room: the ray meets the ceiling first), and look up enough to hit it, exactly onto the plane, so
    every anchor puts the generated ceiling at the same height. Returns the new depth and how many pixels moved."""
    j, i = np.nonzero(select & np.isfinite(depth) & (depth > 0))
    if len(j) == 0:
        return depth, 0
    d = ray_dirs_world(k, c2w_gl, j, i)
    cam = np.asarray(c2w_gl, np.float64)[:3, 3]
    pts = backproject(i + 0.5, j + 0.5, depth[j, i], c2w_gl, k)
    ok = (d[:, 1] > min_up) & (pts[:, 1] > height - tol) & (height > cam[1])
    if not ok.any():
        return depth, 0
    t = (height - cam[1]) / d[ok, 1]  # distance along the unit ray
    fwd = -np.asarray(c2w_gl, np.float64)[:3, 2]
    z = t * (d[ok] @ fwd)  # z-depth
    out = depth.copy()
    out[j[ok], i[ok]] = z
    return out, int(ok.sum())
