"""Room from a single image and its depth: a Gaussian splat PLY in the viewer frame.

Used for Third Wheel when no GPU world model is available: the background plate is lifted into
3D with its own monocular depth, so there is always a room around the person, and it lines up
with the video exactly because both come from the same camera.

Layers (all in the viewer frame: y up, metres, the plate camera at the origin looking down -Z):
  surface   one splat per pixel (at a working resolution), oriented along the local surface and
            sized from the distance to its nearest neighbour on the same surface. Depth ramps at
            object boundaries are snapped into steps (smooth slopes such as counter tops are
            left alone) and splats seen edge-on at a discontinuity are faded, so there are no
            rubber-sheet edges.
  shell     the rest of the room as a soft box: floor, walls and ceiling fitted around the
            lifted content. Where the box is seen through the camera's frame it takes the
            plate's colours (blurred more the further it is from the frame), elsewhere a calm
            floor/wall/ceiling palette taken from the plate, with darker corners. There is never
            a black void, the floor is solid everywhere you can walk, and what a sideways step
            uncovers behind an object is the soft back wall, not a hole.

If the camera was pitched or rolled (phone leaning on something), horizontal surfaces are used to
level the room; the rotation is returned so the video camera pose can carry it.

CLI:
  python pipeline/plate_room.py --plate plate.jpg [--depth depth.npy] [--fov 65] --out world.ply [--json world.json]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import env as _env  # noqa: F401,E402
from common.camera import intrinsics_for, scale_intrinsics, unproject_viewer  # noqa: E402
from common.splat_ply import quat_from_matrix, write_splat_ply  # noqa: E402

DEFAULT_CAMERA_HEIGHT = 1.25  # metres above the floor when the floor is not visible (phone propped on a counter)
MIN_CEILING = 2.6  # metres above the floor
SHELL_SPACING = 0.06  # metres between shell splats


# ---------------------------------------------------------------------------- geometry helpers

def _normalize(v: np.ndarray, eps: float = 1e-9) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), eps)


def discontinuities(inv: np.ndarray, rel: float = 0.012, contrast: float = 3.5) -> np.ndarray:
    """Pixels on a depth step rather than a smooth slope.

    A step has a gradient far larger than the surfaces on either side of it; a slope (a counter
    top seen at a grazing angle) has a large but locally uniform gradient. A pixel is a
    discontinuity when its inverse-depth gradient exceeds `rel` of its value per pixel and is
    more than `contrast` times the smallest gradient within 4 pixels.
    """
    import cv2

    x = inv.astype(np.float32)
    gx = cv2.Sobel(x, cv2.CV_32F, 1, 0, ksize=3, borderType=cv2.BORDER_REPLICATE) / 8.0
    gy = cv2.Sobel(x, cv2.CV_32F, 0, 1, ksize=3, borderType=cv2.BORDER_REPLICATE) / 8.0
    g = np.sqrt(gx * gx + gy * gy)
    g_min = cv2.erode(g, np.ones((9, 9), np.uint8))
    return (g > rel * np.maximum(x, 1e-6)) & (g > contrast * g_min + 1e-6)


def snap_depth_edges(inv: np.ndarray, rel: float = 0.012, iters: int = 2) -> np.ndarray:
    """Turn the soft ramps monocular depth puts at object boundaries into clean steps.

    Only at discontinuities (see `discontinuities`): each pixel moves to whichever extreme of its
    3x3 neighbourhood (near or far) it is closer to. Smooth slopes keep their depth.
    """
    import cv2

    out = inv.astype(np.float32).copy()
    k = np.ones((3, 3), np.uint8)
    for _ in range(iters):
        edge = discontinuities(out, rel)
        mx = cv2.dilate(out, k)
        mn = cv2.erode(out, k)
        snapped = np.where(out - mn < mx - out, mn, mx)
        out = np.where(edge, snapped, out)
    return out


def one_sided_tangents(P: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per-pixel tangent vectors along u and v using the shorter of the forward/backward steps,
    so a splat at a depth edge only spans its own surface. Returns (tu, tv, |tu|, |tv|)."""
    def side(axis: int):
        fwd = np.diff(P, axis=axis, append=np.take(P, [-1], axis=axis))
        bwd = np.diff(P, axis=axis, prepend=np.take(P, [0], axis=axis))
        nf = np.linalg.norm(fwd, axis=-1)
        nb = np.linalg.norm(bwd, axis=-1)
        # At the borders one side is zero: use the other.
        nf_ = np.where(nf > 0, nf, np.inf)
        nb_ = np.where(nb > 0, nb, np.inf)
        use_f = nf_ <= nb_
        t = np.where(use_f[..., None], fwd, bwd)
        n = np.where(use_f, nf, nb)
        return t, n

    tu, nu = side(1)
    tv, nv = side(0)
    return tu, tv, nu, nv


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Smallest rotation matrix taking unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def quat_xyzw(R: np.ndarray) -> list[float]:
    q = quat_from_matrix(np.asarray(R)[None])[0]  # w, x, y, z
    return [float(q[1]), float(q[2]), float(q[3]), float(q[0])]


def estimate_up(normals: np.ndarray, weights: np.ndarray, max_tilt_deg: float = 32.0) -> tuple[np.ndarray, float]:
    """Dominant upward-facing normal among horizontal-ish surfaces. Returns (up, support)."""
    n = normals.reshape(-1, 3)
    w = weights.reshape(-1)
    cand = (n[:, 1] > math.cos(math.radians(max_tilt_deg))) & (w > 0)
    if cand.sum() < 50:
        return np.array([0.0, 1.0, 0.0]), 0.0
    up = _normalize((n[cand] * w[cand, None]).sum(0))
    # Shrinking cone: creases (floor meeting a wall) smear normals over a wide range of angles;
    # a tight final cone keeps the estimate on the dominant flat surfaces.
    for cone in (15, 10, 6, 4, 4):
        sel = cand & ((n @ up) > math.cos(math.radians(cone)))
        if sel.sum() < 50:
            break
        up = _normalize((n[sel] * w[sel, None]).sum(0))
    support = float(w[cand & ((n @ up) > math.cos(math.radians(8)))].sum() / max(w.sum(), 1e-9))
    return up, support


MIN_CAMERA_HEIGHT = 0.85  # a horizontal surface closer than this below the camera is a table or counter


def estimate_floor(points: np.ndarray, normals: np.ndarray, weights: np.ndarray) -> tuple[float, str]:
    """Floor height: the lowest well-supported horizontal layer at least MIN_CAMERA_HEIGHT below
    the camera, else DEFAULT_CAMERA_HEIGHT below the camera (or lower if the scene goes lower).

    Phones filming someone cooking usually stand on the counter, so the counter top is the most
    visible horizontal surface; it must not be mistaken for the floor."""
    y = points[..., 1].reshape(-1)
    ny = normals[..., 1].reshape(-1)
    w = weights.reshape(-1)
    horiz = (ny > 0.9) & (y < -MIN_CAMERA_HEIGHT) & (w > 0)
    total = float(w.sum())
    if horiz.any():
        bins = np.arange(-3.0, -MIN_CAMERA_HEIGHT + 1e-6, 0.05)
        hist, edges = np.histogram(y[horiz], bins=bins, weights=w[horiz])
        for i in range(len(hist)):
            if hist[i] / max(total, 1e-9) > 0.01:
                lo, hi = edges[max(i - 1, 0)], edges[min(i + 2, len(edges) - 1)]
                sel = horiz & (y >= lo) & (y <= hi)
                fy = float(np.median(y[sel]))
                return fy, f"visible floor ({hist[i] / total:.1%} of the image)"
    p_low = float(np.quantile(y[w > 0], 0.005)) if (w > 0).any() else -DEFAULT_CAMERA_HEIGHT
    fy = min(-DEFAULT_CAMERA_HEIGHT, p_low - 0.02)
    return fy, "assumed (floor not visible)"


def _sample_bilinear(img: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    import cv2

    mx = u.astype(np.float32).reshape(1, -1)
    my = v.astype(np.float32).reshape(1, -1)
    out = cv2.remap(img.astype(np.float32), mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return out.reshape(-1, img.shape[2]) if img.ndim == 3 else out.reshape(-1)


def _facing_quats(normals: np.ndarray) -> np.ndarray:
    """Quaternions (w,x,y,z) whose local z axis is the given normal."""
    n = _normalize(np.asarray(normals, np.float64))
    helper = np.where(np.abs(n[:, 1:2]) < 0.9, np.array([[0.0, 1.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))
    e1 = _normalize(np.cross(helper, n))
    e2 = np.cross(n, e1)
    R = np.stack([e1, e2, n], axis=2)
    return quat_from_matrix(R)


def _grid_plane(origin: np.ndarray, ax_u: np.ndarray, ax_v: np.ndarray, len_u: float, len_v: float, step: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Points on a rectangle origin + a*ax_u + b*ax_v, plus their distances to the rectangle's edges."""
    nu = max(2, int(math.ceil(len_u / step)) + 1)
    nv = max(2, int(math.ceil(len_v / step)) + 1)
    a = np.linspace(0, len_u, nu, dtype=np.float32)
    b = np.linspace(0, len_v, nv, dtype=np.float32)
    A, B = np.meshgrid(a, b)
    pts = origin[None] + A.reshape(-1, 1) * ax_u[None] + B.reshape(-1, 1) * ax_v[None]
    edge_u = np.minimum(A, len_u - A).reshape(-1)
    edge_v = np.minimum(B, len_v - B).reshape(-1)
    return pts.astype(np.float32), edge_u, edge_v


# ---------------------------------------------------------------------------- shared geometry

def _surface_geometry(inv: np.ndarray, Kw: dict) -> dict:
    """Snapped + edge-aware smoothed depth, points, one-sided tangents, normals and pixel areas."""
    import cv2

    inv_s = snap_depth_edges(inv)
    # Edge-aware smoothing: monocular depth has millimetre ripples that turn surfaces seen at a
    # grazing angle (counter tops) into ridged rows of splats. Blur within surfaces only
    # (normalised convolution that ignores pixels next to depth steps).
    steps_s = cv2.dilate(discontinuities(inv_s).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    m = (~steps_s).astype(np.float32)
    num = cv2.GaussianBlur(inv_s * m, (0, 0), 2.5)
    den = cv2.GaussianBlur(m, (0, 0), 2.5)
    inv_s = np.where(steps_s | (den < 0.25), inv_s, num / np.maximum(den, 1e-6)).astype(np.float32)
    d = 1.0 / np.maximum(inv_s, 1e-6)
    P = unproject_viewer(d, Kw)  # camera frame == viewer frame before levelling
    tu, tv, nu, nv = one_sided_tangents(P)
    n = _normalize(np.cross(tu, tv))
    to_cam = -_normalize(P)
    n[(n * to_cam).sum(-1) < 0] *= -1
    cos_view = np.abs((n * to_cam).sum(-1))
    # Normals from a smoothed depth are steadier for levelling and floor detection.
    inv_blur = cv2.GaussianBlur(inv_s, (0, 0), 2.0)
    Pb = unproject_viewer(1.0 / np.maximum(inv_blur, 1e-6), Kw)
    tub, tvb, _, _ = one_sided_tangents(Pb)
    nb = _normalize(np.cross(tub, tvb))
    nb[(nb * -_normalize(Pb)).sum(-1) < 0] *= -1
    foot = d / Kw["fx"]  # size of one pixel at that depth
    weights = (foot**2) * (cos_view > 0.2)  # metric area per pixel, ignoring grazing ones
    return {"inv_s": inv_s, "d": d, "P": P, "tu": tu, "nu": nu, "nv": nv, "n": n, "cos_view": cos_view,
            "nb": nb, "foot": foot, "weights": weights}


def _level_and_floor(P: np.ndarray, nb: np.ndarray, weights: np.ndarray, level: bool = True):
    """(R_level, description, floor_y, floor description) for points/normals in the camera frame."""
    h = P.shape[0]
    R_level = np.eye(3)
    level_info = "camera orientation kept (levelling off)"
    if level:
        lower = np.zeros(P.shape[:2], bool)
        lower[int(h * 0.35) :] = True
        up, support = estimate_up(nb, weights * lower)
        tilt = math.degrees(math.acos(min(1.0, max(-1.0, float(up[1])))))
        if support > 0.03 and 2.0 <= tilt <= 30.0:
            R_level = rotation_between(up, np.array([0.0, 1.0, 0.0]))
            level_info = f"levelled by {tilt:.1f} deg from horizontal surfaces ({support:.0%} support)"
        else:
            level_info = f"kept camera orientation (tilt estimate {tilt:.1f} deg, support {support:.0%})"
    Rf = R_level.astype(np.float32)
    floor_y, floor_how = estimate_floor(P @ Rf.T, nb @ Rf.T, weights)
    return R_level, level_info, floor_y, floor_how


def plate_geometry(depth: np.ndarray, K: dict, long_side: int = 512, level: bool = True) -> dict:
    """Quick look at a plate's depth without building splats: level rotation and floor height.

    Returns {"levelQuaternion", "floorY", "floorVisible", "floorHow", "level"}; floorY is relative to
    the camera (so -floorY is the camera height above the floor).
    """
    import cv2

    H, W = depth.shape
    s = min(1.0, long_side / max(H, W))
    w, h = max(8, round(W * s)), max(8, round(H * s))
    inv = cv2.resize(1.0 / np.maximum(depth.astype(np.float32), 1e-3), (w, h), interpolation=cv2.INTER_AREA)
    g = _surface_geometry(inv, scale_intrinsics(K, w / W, h / H))
    R, info, floor_y, how = _level_and_floor(g["P"], g["nb"], g["weights"], level)
    return {"levelQuaternion": quat_xyzw(R), "floorY": float(floor_y), "floorVisible": how.startswith("visible"),
            "floorHow": how, "level": info}


# ---------------------------------------------------------------------------- main builder

def build_plate_room(
    plate_rgb: np.ndarray,
    depth: np.ndarray,
    K: dict,
    out_path: Path | str,
    max_splats: int = 700_000,
    level: bool = True,
    log=print,
) -> dict:
    """Write the splat room and return {"world": WorldAsset dict, "levelQuaternion": [x,y,z,w], ...}.

    plate_rgb (H, W, 3) uint8, depth (H, W) z-depth in metres for the same pixels, K intrinsics
    for that image (pixel centres at +0.5).
    """
    import cv2

    t0 = time.time()
    H, W = depth.shape
    if plate_rgb.shape[:2] != (H, W):
        plate_rgb = cv2.resize(plate_rgb, (W, H), interpolation=cv2.INTER_AREA)

    # Working grid: about 75% of the budget for the surface layer.
    s = min(1.0, math.sqrt(0.75 * max_splats / (H * W)))
    w, h = max(8, int(round(W * s))), max(8, int(round(H * s)))
    rgb = cv2.resize(plate_rgb, (w, h), interpolation=cv2.INTER_AREA) if s < 1 else plate_rgb.copy()
    inv_full = 1.0 / np.maximum(depth.astype(np.float32), 1e-3)
    inv = cv2.resize(inv_full, (w, h), interpolation=cv2.INTER_AREA) if s < 1 else inv_full.copy()
    Kw = scale_intrinsics(K, w / W, h / H)
    rgbf = rgb.astype(np.float32) / 255.0

    # ---- surface layer -------------------------------------------------------------------
    g = _surface_geometry(inv, Kw)
    inv_s, d, P, tu, nu, nv, n, cos_view, nb, foot, weights = (
        g[k] for k in ("inv_s", "d", "P", "tu", "nu", "nv", "n", "cos_view", "nb", "foot", "weights")
    )
    R_level, level_info, floor_y, floor_how = _level_and_floor(P, nb, weights, level)
    log(f"plate room: {level_info}")
    log(f"plate room: floor at y={floor_y:.2f} m ({floor_how})")
    Rf = R_level.astype(np.float32)
    P = P @ Rf.T
    n = n @ Rf.T

    # Splat shape: tangent frame from the one-sided steps.
    e1 = _normalize(tu @ Rf.T)
    e3 = n
    e2 = _normalize(np.cross(e3, e1))
    e1 = np.cross(e2, e3)
    # Splats span the real spacing to their neighbour so surfaces seen at a grazing angle (counter
    # tops, floors) stay closed when you look down at them; only at depth steps is the extent
    # limited, so nothing bridges the gap between foreground and background.
    near_edge = cv2.dilate(discontinuities(inv).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    cap = np.where(near_edge, 2.0, 25.0) * foot
    su = np.clip(nu, 0.5 * foot, cap) * 0.62
    sv = np.clip(nv, 0.5 * foot, cap) * 0.62
    # Thicker discs where the camera saw the surface edge-on, so they still read as a surface
    # from above.
    sn = np.where(cos_view < 0.25, 0.35, 0.15) * np.minimum(su, sv)
    alpha = np.full((h, w), 0.97, np.float32)
    # Fade what is left of the depth ramps: surfaces seen nearly edge-on next to a depth step.
    fade = np.clip((cos_view - 0.05) / (0.25 - 0.05), 0.0, 1.0) ** 1.5
    alpha = np.where(near_edge, alpha * fade, alpha)
    # Points under the floor (depth noise at the image bottom) are lifted onto it.
    P[..., 1] = np.maximum(P[..., 1], floor_y)
    keep = alpha > 0.03

    R_s = np.stack([e1, e2, e3], axis=-1)[keep]  # columns = local axes
    surf = {
        "xyz": P[keep],
        "rgb": rgbf[keep],
        "alpha": alpha[keep],
        "sigma": np.stack([su, sv, sn], -1)[keep],
        "quat": quat_from_matrix(R_s),
    }
    log(f"plate room: surface {int(keep.sum())} splats at {w}x{h} ({int((~keep).sum())} edge pixels hidden)")

    # ---- shell: floor, walls, ceiling around the content ---------------------------------
    shell, box = _shell(rgbf, d, Kw, Rf, surf["xyz"], floor_y, log)

    layers = [L for L in (surf, shell) if len(L["xyz"])]
    cat = {k_: np.concatenate([L[k_] for L in layers], 0) for k_ in ("xyz", "rgb", "alpha", "sigma", "quat")}
    count = write_splat_ply(out_path, cat["xyz"], cat["rgb"], cat["alpha"], cat["sigma"], cat["quat"])

    world = {
        "file": Path(out_path).name,
        "transform": {"position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0], "scale": 1.0},
        "floorY": round(float(floor_y), 4),
        "spawn": {"position": [0.0, round(float(floor_y), 4), 0.0], "yaw": 0.0},
        "bounds": {"min": [round(float(x), 4) for x in box[0]], "max": [round(float(x), 4) for x in box[1]]},
        "source": "plate-depth",
        "splatCount": int(count),
    }
    log(f"plate room: wrote {count} splats to {Path(out_path).name} in {time.time() - t0:.1f}s")
    return {
        "world": world,
        "levelQuaternion": quat_xyzw(R_level),
        "levelMatrix": R_level.tolist(),
        "floorHow": floor_how,
        "level": level_info,
    }


def _shell(rgbf: np.ndarray, d: np.ndarray, Kw: dict, Rf: np.ndarray, content: np.ndarray, floor_y: float, log=print):
    """Box around the lifted content: returns (splat layer dict, (box_min, box_max))."""
    import cv2

    h, w = d.shape
    x_lo, x_hi = np.quantile(content[:, 0], [0.003, 0.997])
    z_far = float(np.quantile(content[:, 2], 0.002))
    y_top = float(np.quantile(content[:, 1], 0.997))
    z_back = max(min(z_far * 1.03 - 0.1, -2.0), -15.0)
    x_l = min(float(x_lo) - 0.25, -1.5)
    x_r = max(float(x_hi) + 0.25, 1.5)
    y0 = floor_y
    y1 = max(floor_y + MIN_CEILING, y_top + 0.2)
    z_front = max(1.8, 0.45 * abs(z_back))
    lo = np.array([x_l, y0, z_back], np.float32)
    hi = np.array([x_r, y1, z_front], np.float32)
    size = hi - lo
    log(f"plate room: shell {size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} m (x {x_l:.1f}..{x_r:.1f}, z {z_back:.1f}..{z_front:.1f})")

    X, Y, Z = (np.array(v, np.float32) for v in ([1, 0, 0], [0, 1, 0], [0, 0, 1]))
    st = SHELL_SPACING
    faces = [
        # origin, axis u, axis v, len u, len v, inward normal, kind
        (lo, X, Z, size[0], size[2], Y, "floor"),
        (np.array([x_l, y1, z_back], np.float32), X, Z, size[0], size[2], -Y, "ceiling"),
        (np.array([x_l, y0, z_back], np.float32), X, Y, size[0], size[1], Z, "wall"),  # back
        (np.array([x_l, y0, z_front], np.float32), X, Y, size[0], size[1], -Z, "wall"),  # behind the viewer
        (np.array([x_l, y0, z_back], np.float32), Z, Y, size[2], size[1], X, "wall"),  # left
        (np.array([x_r, y0, z_back], np.float32), Z, Y, size[2], size[1], -X, "wall"),  # right
    ]

    # Palette from the plate.
    small = cv2.resize(rgbf, (64, max(8, int(64 * h / w))), interpolation=cv2.INTER_AREA)
    rows = small.shape[0]
    top_c = np.median(small[: max(1, rows // 5)].reshape(-1, 3), axis=0)
    mid_c = np.median(small[rows // 5 : rows * 3 // 5].reshape(-1, 3), axis=0)
    low_c = np.median(small[-max(1, rows // 5) :].reshape(-1, 3), axis=0)
    wall_c = 0.7 * mid_c + 0.3 * top_c
    floor_c = 0.8 * low_c
    ceil_c = np.clip(0.85 * top_c + 0.15 * wall_c + 0.02, 0, 1)

    # Extending the frame: border-replicated colours would streak radially, so the extension
    # uses strongly blurred copies (padded first, so the blur reaches past the border) and
    # fades into the palette within ~a third of a frame width.
    pad = max(w, h) // 4
    padded = cv2.copyMakeBorder(rgbf, pad, pad, pad, pad, cv2.BORDER_REFLECT_101)
    blur_s = cv2.GaussianBlur(padded, (0, 0), max(w, h) * 0.015)[pad:-pad, pad:-pad]
    blur_l = cv2.GaussianBlur(padded, (0, 0), max(w, h) * 0.12)[pad:-pad, pad:-pad]
    layer_xyz, layer_rgb, layer_alpha, layer_norm = [], [], [], []
    for origin, au, av, lu, lv, nrm, kind in faces:
        pts, eu, ev = _grid_plane(origin, au, av, float(lu), float(lv), st)
        # Height along the wall for the vertical gradient (0 floor .. 1 ceiling).
        hgt = np.clip((pts[:, 1] - y0) / max(y1 - y0, 1e-3), 0, 1)
        if kind == "floor":
            base = np.repeat(floor_c[None], len(pts), 0)
        elif kind == "ceiling":
            base = np.repeat(ceil_c[None], len(pts), 0)
        else:
            g = hgt[:, None]
            base = np.where(g < 0.15, floor_c * 0.6 + wall_c * 0.4, wall_c * (1 - 0.35 * g) + ceil_c * (0.35 * g))
        # Darker towards the box's edges and corners (soft ambient occlusion).
        edge = np.minimum(eu, ev)
        ao = 1.0 - 0.28 * np.exp(-edge / 0.4)
        col = base * ao[:, None]

        # Through the camera's frame: plate colours, blurred more with distance from the frame.
        cam = pts @ Rf  # viewer -> camera frame (R^T)
        zc = -cam[:, 2]
        front = zc > 0.05
        u = np.where(front, cam[:, 0] / np.maximum(zc, 1e-6) * Kw["fx"] + Kw["cx"], 0.0)
        v = np.where(front, -cam[:, 1] / np.maximum(zc, 1e-6) * Kw["fy"] + Kw["cy"], 0.0)
        out_u = np.maximum(np.maximum(-u, u - w), 0) / w
        out_v = np.maximum(np.maximum(-v, v - h), 0) / w
        t = np.where(front, np.sqrt(out_u**2 + out_v**2), 9.0)
        uc, vc = np.clip(u, 0, w - 1), np.clip(v, 0, h - 1)
        if front.any():
            cs = _sample_bilinear(blur_s, uc, vc)
            cl = _sample_bilinear(blur_l, uc, vc)
            k = np.clip(t / 0.08, 0, 1)[:, None]
            plate_col = cs * (1 - k) + cl * k
            wgt = (np.clip(1.0 - t / 0.33, 0.0, 1.0) ** 1.5)[:, None] * front[:, None]
            if kind == "floor":
                # Only where the plate there really shows the floor; elsewhere keep the floor tone.
                dz = _sample_bilinear(d[..., None], uc, vc).reshape(-1)
                inside = t == 0
                match = np.abs(dz - zc) < 0.1 * np.maximum(zc, 1e-3)
                wgt = wgt * np.where(inside, match, 1.0)[:, None] * 0.85
            col = plate_col * wgt + col * (1 - wgt)
        layer_xyz.append(pts)
        layer_rgb.append(col * 0.92)
        layer_alpha.append(np.full(len(pts), 0.98, np.float32))
        layer_norm.append(np.repeat(nrm[None], len(pts), 0))
    xyz = np.concatenate(layer_xyz)
    nrm = np.concatenate(layer_norm)
    layer = {
        "xyz": xyz,
        "rgb": np.clip(np.concatenate(layer_rgb), 0, 1).astype(np.float32),
        "alpha": np.concatenate(layer_alpha),
        "sigma": np.tile(np.array([[st * 0.75, st * 0.75, st * 0.08]], np.float32), (len(xyz), 1)),
        "quat": _facing_quats(nrm),
    }
    log(f"plate room: shell {len(xyz)} splats")
    return layer, (lo, hi)


# ---------------------------------------------------------------------------- CLI

def estimate_plate_depth(estimator, rgb: np.ndarray) -> np.ndarray:
    """Depth of a single image with horizontal-flip test-time augmentation (less noise)."""
    d0 = estimator(rgb[None])[0]
    d1 = estimator(np.ascontiguousarray(rgb[:, ::-1])[None])[0][:, ::-1]
    inv = 0.5 * (1.0 / np.maximum(d0, 1e-3) + 1.0 / np.maximum(d1, 1e-3))
    return (1.0 / inv).astype(np.float32)


def main(argv=None) -> int:
    from common.media import load_image

    ap = argparse.ArgumentParser(description="Lift an image (and its depth) into a splat room PLY.")
    ap.add_argument("--plate", required=True, help="image (jpg/png)")
    ap.add_argument("--depth", help="z-depth .npy in metres at the image size; estimated when omitted")
    ap.add_argument("--fov", type=float, default=None, help="long-side field of view in degrees (default 65)")
    ap.add_argument("--intrinsics", help="fx,fy,cx,cy in image pixels (overrides --fov)")
    ap.add_argument("--out", required=True, help="output .ply")
    ap.add_argument("--json", help="also write the result (WorldAsset + level rotation) here")
    ap.add_argument("--max-splats", type=int, default=700_000)
    ap.add_argument("--no-level", action="store_true")
    args = ap.parse_args(argv)

    rgb = load_image(args.plate)
    H, W = rgb.shape[:2]
    if args.intrinsics:
        fx, fy, cx, cy = (float(x) for x in args.intrinsics.split(","))
        K = {"fx": fx, "fy": fy, "cx": cx, "cy": cy}
    else:
        K = intrinsics_for(W, H, long_fov_deg=args.fov)
    if args.depth:
        depth = np.load(args.depth).astype(np.float32)
        if depth.shape != (H, W):
            import cv2

            depth = 1.0 / cv2.resize(1.0 / np.maximum(depth, 1e-3), (W, H), interpolation=cv2.INTER_LINEAR)
    else:
        from common.models import DEFAULT_PLATE_DEPTH, DepthEstimator

        depth = estimate_plate_depth(DepthEstimator(DEFAULT_PLATE_DEPTH), rgb)
    res = build_plate_room(rgb, depth, K, args.out, max_splats=args.max_splats, level=not args.no_level)
    if args.json:
        Path(args.json).write_text(json.dumps(res, indent=2))
    print(json.dumps(res["world"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
