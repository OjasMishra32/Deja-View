"""Room from a single image and its depth: a Gaussian splat PLY in the viewer frame.

Used for Third Wheel when no GPU world model is available: the background plate is lifted into
3D with its own monocular depth, so there is always a room around the person, and it lines up
with the video exactly because both come from the same camera.

Layers (all in the viewer frame: y up, metres, the plate camera at the origin looking down -Z):
  surface   one splat per pixel (at a working resolution), oriented along the local surface and
            sized from the distance to its nearest neighbour on the same surface. Depth steps are
            found relative to depth and against a local plane fit (so a counter top seen at a
            grazing angle is a slope, not a step), and the soft ramp a depth network draws across
            each step is moved onto the near or the far surface by colour. Splats at a step are
            pixel-sized and never lie along the view ray, and the far side's thin band next to a
            foreground object (a blend of both colours) takes the far surface's colour, so no
            curtain of splats joins an object to the wall behind it.
  behind    what a step to the side uncovers behind narrow foreground objects (a blender, a
            bottle): the background around them continued across, at the background's depth and
            with its colours, instead of the object's own colours smeared onto the wall.
  skirts    surfaces cut off at the bottom of the frame or by a nearer object below them (counter
            fronts, cabinets, the fridge) continue straight down to the floor, so nothing floats.
  shell     the rest of the room as a soft box: floor, walls and ceiling fitted around the
            lifted content, in the plate's own palette at about the plate's brightness, with
            gentle low-frequency variation and soft corners. Seen through the camera's frame it
            takes the colours of the plate's far surfaces only (never of a foreground object),
            and outside the frame those colours fade into the palette. There is never a black
            void and the floor is solid everywhere you can walk.

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
import warnings
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
STEP_REL = 0.12  # a depth change of 12% or more within a few pixels is a step between two surfaces
SKIRT_SPACING = 0.02  # metres between splats of the surfaces continued down to the floor
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


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


def _disk(r: int) -> np.ndarray:
    import cv2

    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def plane_residual(inv: np.ndarray, r: int) -> np.ndarray:
    """Relative RMS residual of a plane fitted to inverse depth in each (2r+1)^2 window.

    The inverse depth of any plane is an affine function of the pixel coordinates, so a surface
    seen at a grazing angle (a counter top, the floor) leaves no residual however steep its
    gradient, while a step between two surfaces, or the ramp a depth network draws there, does.
    """
    import cv2

    r = max(1, int(r))
    n = 2 * r + 1
    x = cv2.copyMakeBorder(inv.astype(np.float64), r, r, r, r, cv2.BORDER_REFLECT)
    hp, wp = x.shape
    U = np.ascontiguousarray(np.broadcast_to(np.arange(wp, dtype=np.float64)[None, :], (hp, wp)))
    V = np.ascontiguousarray(np.broadcast_to(np.arange(hp, dtype=np.float64)[:, None], (hp, wp)))

    def mean(a):
        return cv2.boxFilter(np.ascontiguousarray(a), cv2.CV_64F, (n, n), normalize=True, borderType=cv2.BORDER_REFLECT)[r:-r, r:-r]

    m = mean(x)
    cu = mean(U * x) - U[r:-r, r:-r] * m  # covariance of the column offset and inverse depth
    cv_ = mean(V * x) - V[r:-r, r:-r] * m
    var_off = r * (r + 1) / 3.0  # variance of the offsets -r..r
    res = mean(x * x) - m * m - (cu * cu + cv_ * cv_) / var_off
    return (np.sqrt(np.maximum(res, 0.0)) / np.maximum(m, 1e-9)).astype(np.float32)


def depth_steps(inv: np.ndarray, rel: float = STEP_REL, radius: int | None = None, planar: float = 0.2) -> np.ndarray:
    """Pixels on a depth step, robust to the wide soft ramps monocular depth draws at object edges.

    A pixel is on a step when depth changes by more than `rel` (relative, so one threshold works
    near and far) within `radius` pixels and a plane does not explain that change (plane residual
    above `planar` * rel). Smooth slopes, however steep, are never steps.
    """
    import cv2

    x = np.maximum(inv.astype(np.float32), 1e-6)
    r = radius or max(2, int(round(max(x.shape) / 400)))
    L = np.log(x)
    k = _disk(r)
    span = cv2.dilate(L, k) - cv2.erode(L, k)
    return (span > math.log1p(rel)) & (plane_residual(x, r) > planar * rel)


def resolve_depth_steps(inv: np.ndarray, rgb: np.ndarray | None = None, rel: float = STEP_REL,
                        band: int | None = None, halo: int | None = None, passes: int = 3) -> dict:
    """Remove the ramps monocular depth puts across depth steps.

    Within `band` pixels of a step (see `depth_steps`), pixels on the near or the far plateau keep
    their depth; pixels on the ramp between them move onto one of the two surfaces: the one whose
    colour they match (else the one they are nearer to in depth), over `passes` passes.
    Foreground objects keep their silhouettes and nothing is left hanging between the two
    surfaces.

    Returns a dict:
      inv     resolved inverse depth
      step    step pixels (before resolution)
      zone    the band examined around them
      ramp    pixels moved onto the near or the far surface
      near    silhouette pixels of the nearer surface (a much farther pixel next to them)
      far     pixels of the farther surface within `halo` pixels of a much nearer one
      colour  (only with rgb; float 0..1) rgb where the `far` pixels, usually a blend of both
              surfaces' colours, take the colour of the far surface just beyond them
    """
    import cv2

    x = np.maximum(inv.astype(np.float32), 1e-6)
    h, w = x.shape
    B = band or max(3, int(round(max(h, w) / 160)))
    hw = halo or max(2, int(round(max(h, w) / 320)))
    step_l = math.log1p(rel)
    kB = _disk(B)
    n = 2 * B + 1

    def bsum(a):
        return cv2.boxFilter(np.ascontiguousarray(a, dtype=np.float32), -1, (n, n), normalize=False, borderType=cv2.BORDER_REFLECT)

    c = None if rgb is None else rgb.astype(np.float32) / (255.0 if rgb.dtype == np.uint8 else 1.0)
    L = np.log(x)
    core = None
    zone_all = np.zeros((h, w), bool)
    ramp_all = np.zeros((h, w), bool)
    # A ramp wider than the band (or a thin object such as a handle, where the bands of two steps
    # overlap) is only partly resolved by one pass; the next pass sees what is left of it next to
    # a plateau and finishes it.
    for _ in range(passes):
        steps = depth_steps(np.exp(L), rel)
        core = steps if core is None else core
        zone = cv2.dilate(steps.astype(np.uint8), kB) > 0
        Lmax, Lmin = cv2.dilate(L, kB), cv2.erode(L, kB)
        span = Lmax - Lmin
        tol = np.minimum(0.25 * span, 0.5 * step_l)
        near_p = zone & (Lmax - L <= tol)
        far_p = zone & (L - Lmin <= tol)
        ramp = zone & ~near_p & ~far_p & (span > step_l)
        if not ramp.any():
            zone_all |= zone
            break
        wn, wf = bsum(near_p), bsum(far_p)
        Ln = np.where(wn > 0.5, bsum(L * near_p) / np.maximum(wn, 1e-6), Lmax)
        Lf = np.where(wf > 0.5, bsum(L * far_p) / np.maximum(wf, 1e-6), Lmin)
        to_near = (L - Lmin) >= 0.5 * span
        if c is not None:
            cn = bsum(c * near_p[..., None]) / np.maximum(wn, 1e-6)[..., None]
            cf = bsum(c * far_p[..., None]) / np.maximum(wf, 1e-6)[..., None]
            dn = ((c - cn) ** 2).sum(-1)
            df = ((c - cf) ** 2).sum(-1)
            by_colour = (wn > 0.5) & (wf > 0.5) & (((cn - cf) ** 2).sum(-1) > 0.003)
            to_near = np.where(by_colour, dn < df, to_near)
        L = np.where(ramp, np.where(to_near, Ln, Lf), L).astype(np.float32)
        zone_all |= zone
        ramp_all |= ramp
    Lr, zone, ramp = L.astype(np.float32), zone_all, ramp_all

    kh = _disk(hw)
    around = cv2.dilate(zone.astype(np.uint8), kh) > 0
    far = around & (cv2.dilate(Lr, kh) - Lr > step_l)
    near = around & ~far & (Lr - cv2.erode(Lr, np.ones((3, 3), np.uint8)) > step_l)
    out = {"inv": np.exp(Lr).astype(np.float32), "step": core, "zone": zone, "ramp": ramp, "near": near, "far": far}
    if c is not None:
        # The far surface just beyond the band: same depth as the far plateau, not in the band.
        src = (around & ~far & (Lr - cv2.erode(Lr, kB) <= 0.5 * step_l)).astype(np.float32)
        m2 = 4 * hw + 1
        num = cv2.boxFilter(c * src[..., None], -1, (m2, m2), normalize=False, borderType=cv2.BORDER_REFLECT)
        den = cv2.boxFilter(src, -1, (m2, m2), normalize=False, borderType=cv2.BORDER_REFLECT)
        clean = num / np.maximum(den, 1e-6)[..., None]
        out["colour"] = np.where((far & (den > 0.5))[..., None], clean, c).astype(np.float32)
    return out


def narrow_foreground(inv: np.ndarray, rel: float = STEP_REL, max_width: float = 0.16) -> np.ndarray:
    """Objects in front of the background that are narrower than `max_width` of the frame (a
    blender, bottles, a glass): pixels much nearer than a horizontal opening of inverse depth,
    which removes near structures narrower than the opening and keeps wide ones (counters, walls,
    a fridge) and every slope."""
    import cv2

    x = np.maximum(inv.astype(np.float32), 1e-6)
    lw = max(31, int(round(x.shape[1] * max_width))) | 1
    line = np.ones((1, lw), np.uint8)
    opened = cv2.dilate(cv2.erode(x, line), line)
    fg = np.log(x) - np.log(np.maximum(opened, 1e-6)) > math.log1p(rel)
    return cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0


def fill_behind(inv: np.ndarray, rgb: np.ndarray, hole: np.ndarray, rel: float = STEP_REL) -> tuple[np.ndarray, np.ndarray]:
    """Inverse depth and colour of what lies behind the `hole` pixels. Depth continues along each
    row from the nearest pixels outside the hole on either side: where the two sides are at
    similar depths it interpolates between them, otherwise it continues the farther side (the
    background), so a nearer surface never spreads into it; colour comes from the same side.
    Outside the hole the inputs are returned unchanged. rgb is float (H, W, 3)."""
    import cv2

    inv = inv.astype(np.float32)
    rgb = rgb.astype(np.float32)
    h, w = inv.shape
    valid = ~hole
    if hole.sum() == 0 or valid.sum() == 0:
        return inv.copy(), rgb.copy()
    idx = np.broadcast_to(np.arange(w)[None, :], (h, w))
    left = np.maximum.accumulate(np.where(valid, idx, -1), axis=1)
    right = np.minimum.accumulate(np.where(valid, idx, w)[:, ::-1], axis=1)[:, ::-1]
    has_l, has_r = left >= 0, right < w
    rows = np.broadcast_to(np.arange(h)[:, None], (h, w))
    li, ri = np.clip(left, 0, w - 1), np.clip(right, 0, w - 1)
    # Sources: a short average along the row so a single noisy pixel does not streak across.
    vf = valid.astype(np.float32)
    k = np.ones((1, 5), np.float32)
    den = cv2.filter2D(vf, -1, k, borderType=cv2.BORDER_REFLECT)
    inv_s = np.where(den > 0, cv2.filter2D(inv * vf, -1, k, borderType=cv2.BORDER_REFLECT) / np.maximum(den, 1e-6), inv)
    col_s = np.where((den > 0)[..., None], cv2.filter2D(rgb * vf[..., None], -1, k, borderType=cv2.BORDER_REFLECT) / np.maximum(den, 1e-6)[..., None], rgb)
    il, ir = inv_s[rows, li], inv_s[rows, ri]
    cl, cr = col_s[rows, li], col_s[rows, ri]
    both = has_l & has_r
    similar = np.abs(np.log(np.maximum(il, 1e-6) / np.maximum(ir, 1e-6))) < math.log1p(rel)
    frac = ((idx - left) / np.maximum(right - left, 1)).astype(np.float32)
    use_r = has_r & (~has_l | (~similar & (ir < il)))
    f = np.where(both & similar, frac, np.where(use_r, 1.0, 0.0)).astype(np.float32)
    fill = hole & (has_l | has_r)
    inv_f = np.where(fill, il * (1 - f) + ir * f, inv)
    col_f = np.where(fill[..., None], cl * (1 - f)[..., None] + cr * f[..., None], rgb)
    # Neighbouring rows can pick different sides; a median down the columns (inside the hole)
    # keeps the majority without blurring a real step into a ramp (a ramp would become splats
    # stretched along the view ray). Colour is blurred down the columns to soften the rows.
    r = max(2, int(round(h / 120)))
    pad = np.pad(np.where(fill, np.log(np.maximum(inv_f, 1e-6)), np.nan), ((r, r), (0, 0)), constant_values=np.nan)
    stack = np.stack([pad[i : i + h] for i in range(2 * r + 1)])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN windows outside the hole
        med = np.nanmedian(stack, axis=0)
    inv_f = np.where(fill & np.isfinite(med), np.exp(med), inv_f).astype(np.float32)
    sig = max(2.0, h / 180.0)
    gk = cv2.getGaussianKernel(2 * int(3 * sig) + 1, sig).astype(np.float32)
    one = np.ones((1, 1), np.float32)
    hm = fill.astype(np.float32)
    dn = cv2.sepFilter2D(hm, -1, one, gk, borderType=cv2.BORDER_REFLECT)
    col_b = cv2.sepFilter2D(col_f * hm[..., None], -1, one, gk, borderType=cv2.BORDER_REFLECT) / np.maximum(dn, 1e-6)[..., None]
    inv_out = np.where(fill, inv_f, inv).astype(np.float32)
    col_out = np.where(fill[..., None], col_b, rgb).astype(np.float32)
    return inv_out, col_out


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


_REMAP_COLS = 4096  # cv2.remap needs both map sides under SHRT_MAX (32767): samples go in as a grid this wide
_REMAP_ROWS = 8192


def _sample_bilinear(img: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Bilinear samples of `img` at pixel coordinates (u, v), edges replicated. Any number of points: they are laid
    out as a grid at most _REMAP_COLS wide (a 1 x N map fails for N >= 32767 in OpenCV), in chunks if needed."""
    import cv2

    src = img.astype(np.float32)
    ch = img.shape[2] if img.ndim == 3 else 1
    u = np.asarray(u, np.float32).reshape(-1)
    v = np.asarray(v, np.float32).reshape(-1)
    n = int(u.size)
    out = np.empty((n, ch), np.float32)
    step = _REMAP_COLS * _REMAP_ROWS
    for s in range(0, n, step):
        e = min(n, s + step)
        m = e - s
        cols = min(_REMAP_COLS, m)
        rows = -(-m // cols)
        pad = rows * cols - m
        mx = np.pad(u[s:e], (0, pad)).reshape(rows, cols)
        my = np.pad(v[s:e], (0, pad)).reshape(rows, cols)
        r = cv2.remap(src, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        out[s:e] = r.reshape(-1, ch)[:m]
    return out if img.ndim == 3 else out.reshape(-1)


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

def _pixel_splats(P: np.ndarray, foot: np.ndarray, rgb: np.ndarray, edge: np.ndarray, Rf: np.ndarray, keep: np.ndarray,
                  floor_y: float, cap: float = 25.0, size: float = 0.62, alpha: float = 0.97) -> tuple[dict, int]:
    """One splat per kept pixel of a point map P (camera frame), returned in the levelled frame.

    Splats span the real spacing to their neighbour on the same surface (one-sided tangents), so
    surfaces seen at a grazing angle (counter tops, floors) stay closed when you look down at
    them; at depth steps (`edge`) the extent is limited to about a pixel, and a splat there that
    the camera saw nearly edge-on, which would lie along the view ray across the step, faces the
    camera instead. Returns (layer, number of splats turned to face the camera)."""
    tu, tv, nu, nv = one_sided_tangents(P)
    n = _normalize(np.cross(tu, tv))
    to_cam = -_normalize(P)
    n[(n * to_cam).sum(-1) < 0] *= -1
    cos_view = np.abs((n * to_cam).sum(-1))
    capm = np.where(edge, 1.5, cap) * foot
    su = np.clip(nu, 0.5 * foot, capm) * size
    sv = np.clip(nv, 0.5 * foot, capm) * size
    # Thicker discs where the camera saw the surface edge-on, so they still read as a surface from above.
    sn = np.where(cos_view < 0.25, 0.35, 0.15) * np.minimum(su, sv)
    turn = edge & (cos_view < 0.3)
    n = np.where(turn[..., None], to_cam, n)
    sp = np.minimum(np.minimum(su, sv), size * 1.25 * foot)
    su, sv, sn = np.where(turn, sp, su), np.where(turn, sp, sv), np.where(turn, 0.15 * sp, sn)
    e1 = tu - (tu * n).sum(-1, keepdims=True) * n
    bad = np.linalg.norm(e1, axis=-1) < 1e-9
    if bad.any():
        e1[bad] = np.cross(np.array([0.0, 1.0, 0.0], np.float32), n[bad])
    Pl = P[keep] @ Rf.T
    e3 = n[keep] @ Rf.T
    e1 = _normalize(e1[keep] @ Rf.T)
    e2 = _normalize(np.cross(e3, e1))
    e1 = np.cross(e2, e3)
    Pl[:, 1] = np.maximum(Pl[:, 1], floor_y)  # depth noise under the floor is lifted onto it
    layer = {
        "xyz": Pl.astype(np.float32),
        "rgb": np.clip(rgb[keep], 0, 1).astype(np.float32),
        "alpha": np.full(int(keep.sum()), alpha, np.float32),
        "sigma": np.stack([su, sv, sn], -1)[keep].astype(np.float32),
        "quat": quat_from_matrix(np.stack([e1, e2, e3], axis=-1)),
    }
    return layer, int((turn & keep).sum())


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

    # ---- frame: levelling and floor, exactly as plate_geometry() measures them -------------
    g = _surface_geometry(inv, Kw)
    R_level, level_info, floor_y, floor_how = _level_and_floor(g["P"], g["nb"], g["weights"], level)
    log(f"plate room: {level_info}")
    log(f"plate room: floor at y={floor_y:.2f} m ({floor_how})")
    Rf = R_level.astype(np.float32)

    # ---- depth steps -------------------------------------------------------------------------
    st = resolve_depth_steps(inv, rgbf)
    inv_r, colour = st["inv"], st["colour"]
    edge = cv2.dilate((st["near"] | st["far"] | st["ramp"]).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    # Smooth within surfaces only: monocular depth has millimetre ripples that turn surfaces seen
    # at a grazing angle into ridged rows of splats; the range term keeps steps sharp.
    Ls = cv2.bilateralFilter(np.log(inv_r), 7, 0.03, 2.5)
    inv_sm = np.where(st["near"] | st["far"], inv_r, np.exp(Ls)).astype(np.float32)

    # ---- surface layer -----------------------------------------------------------------------
    d = 1.0 / np.maximum(inv_sm, 1e-6)
    P = unproject_viewer(d, Kw)
    surf, turned = _pixel_splats(P, d / Kw["fx"], colour, edge, Rf, np.ones((h, w), bool), floor_y)
    log(
        f"plate room: surface {len(surf['xyz'])} splats at {w}x{h}; depth steps: {int(st['step'].sum())} step px, "
        f"{int(st['ramp'].sum())} ramp px moved onto a surface, {int(st['far'].sum())} far-side px recoloured, "
        f"{turned} edge splats facing the camera"
    )

    # ---- behind narrow foreground objects ----------------------------------------------------
    hw = max(2, int(round(max(h, w) / 320)))
    fg = narrow_foreground(inv_r)
    hole = cv2.dilate(fg.astype(np.uint8), _disk(hw)) > 0
    inv_bg, col_bg = fill_behind(inv_r, colour, hole)
    # Only where the background is well behind the object (a blender in front of the wall, not
    # fruit lying on the counter), and only coherent regions of it.
    behind = (hole & (inv_bg < inv_r / 1.25)).astype(np.uint8)
    behind = cv2.morphologyEx(behind, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n_cc, lab, stats, _ = cv2.connectedComponentsWithStats(behind, connectivity=8)
    big = np.zeros(n_cc, bool)
    big[1:] = stats[1:, cv2.CC_STAT_AREA] >= max(50, (h * w) // 4000)
    behind = big[lab]
    d_bg = 1.0 / np.maximum(inv_bg, 1e-6)
    # Steps inside the fill (where it switches between surfaces) get the same treatment as steps
    # in the surface layer: small splats facing the camera, never stretched along the view ray.
    Lb = np.log(np.maximum(inv_bg, 1e-6))
    bg_step = (cv2.dilate(Lb, np.ones((3, 3), np.uint8)) - cv2.erode(Lb, np.ones((3, 3), np.uint8))) > math.log1p(STEP_REL)
    back, _ = _pixel_splats(unproject_viewer(d_bg, Kw), d_bg / Kw["fx"], col_bg, bg_step, Rf, behind,
                            floor_y, cap=8.0, size=0.7)
    log(f"plate room: behind narrow objects {len(back['xyz'])} splats ({fg.mean():.1%} of the frame)")

    # ---- surfaces continued down to the floor --------------------------------------------------
    skirt, cols = _skirts(inv_bg, col_bg, Kw, Rf, floor_y)
    log(f"plate room: {cols} columns continued down to the floor ({len(skirt['xyz'])} splats)")

    # ---- shell: floor, walls, ceiling around the content ---------------------------------------
    floor_rgb = None
    if floor_how.startswith("visible"):
        on_floor = np.abs((P @ Rf.T)[..., 1] - floor_y) < 0.05
        if on_floor.sum() > 100:
            floor_rgb = np.median(colour[on_floor], axis=0)
    shell, box = _shell(colour, d, Kw, Rf, surf["xyz"], floor_y, floor_rgb, log)

    layers = [L for L in (surf, back, skirt, shell) if len(L["xyz"])]
    cat = {k_: np.concatenate([L[k_] for L in layers], 0) for k_ in ("xyz", "rgb", "alpha", "sigma", "quat")}
    if len(cat["xyz"]) > max_splats:
        log(f"plate room: {len(cat['xyz'])} splats is over the budget of {max_splats}")
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


def _masked_running(values: np.ndarray, valid: np.ndarray, k: int, how: str = "median") -> tuple[np.ndarray, np.ndarray]:
    """Median (or mean) of the valid entries of a 1D series (N, C) in a window of +-k, and the
    fraction of valid entries in each window."""
    n = len(values)
    out = np.zeros_like(values)
    frac = np.zeros(n, np.float32)
    for i in range(n):
        a, b = max(0, i - k), min(n, i + k + 1)
        m = valid[a:b]
        frac[i] = m.mean()
        if m.any():
            out[i] = np.median(values[a:b][m], axis=0) if how == "median" else values[a:b][m].mean(axis=0)
    return out, frac


def _skirts(inv: np.ndarray, rgb: np.ndarray, Kw: dict, Rf: np.ndarray, floor_y: float, rel: float = STEP_REL) -> tuple[dict, int]:
    """Surfaces cut off by the bottom of the frame, or by a much nearer structure standing at the
    bottom of the frame (a counter in front), continued straight down to the floor: counter
    fronts, the cabinets and the fridge behind a counter. Per image column the edge is the frame's
    bottom row and the lowest step to a much nearer surface below; both edges are smoothed along
    the row (depth by a median, colour by a mean) and columns that disagree with their
    neighbours are skipped, so the result is a continuous sheet, not a row of drips.
    Returns (layer, number of columns)."""
    h, w = inv.shape
    L = np.log(np.maximum(inv, 1e-6))
    step_l = math.log1p(rel)
    below_min = np.full((h, w), np.inf, np.float32)
    below_min[:-1] = np.minimum.accumulate(L[::-1], axis=0)[::-1][1:]  # farthest point below each pixel
    cut = np.zeros((h, w), bool)
    cut[:-1] = (L[1:] - L[:-1] > step_l) & (below_min[:-1] - L[:-1] > 0.5 * step_l)
    lowest = np.where(cut, np.arange(h)[:, None], -1).max(axis=0)
    d = 1.0 / np.maximum(inv, 1e-6)
    P = unproject_viewer(d, Kw) @ Rf.T
    xs_all = np.arange(w)
    k_med, k_col = max(3, w // 120), max(5, w // 60)
    tops, cols, foots = [], [], []
    for rows in (np.full(w, h - 1), lowest):
        valid = rows >= 0
        r = np.clip(rows, 0, h - 1)
        top = P[r, xs_all]
        z = d[r, xs_all]
        col = np.mean([rgb[np.clip(r - k, 0, h - 1), xs_all] for k in range(4)], axis=0)
        # A horizontal surface cut off here (a counter top) does not show its front: darker.
        up = P[np.clip(r - 3, 0, h - 1), xs_all] - top
        flat = np.abs(up[:, 1]) < 0.5 * np.linalg.norm(up, axis=1)
        col = col * np.where(flat, 0.6, 1.0)[:, None]
        z_med, frac = _masked_running(z[:, None], valid, k_med)
        z_med = z_med[:, 0]
        keep = valid & (frac > 0.5) & (np.abs(z - z_med) < 0.08 * np.maximum(z_med, 1e-6))
        col_s, _ = _masked_running(col, keep, k_col, how="mean")
        # Smoothed edge: each point moves along its camera ray to the median depth.
        top = top * (z_med / np.maximum(z, 1e-6))[:, None]
        foot = z_med / Kw["fx"]
        stride = np.maximum(1, np.round(SKIRT_SPACING / np.maximum(foot, 1e-6))).astype(int)
        keep &= (xs_all % stride) == 0
        keep &= top[:, 1] - floor_y > 0.08
        tops.append(top[keep])
        cols.append(col_s[keep])
        foots.append(foot[keep] * stride[keep])
    top = np.concatenate(tops).astype(np.float32)
    col = np.concatenate(cols).astype(np.float32)
    span = np.concatenate(foots).astype(np.float32)  # horizontal distance to the next column
    if len(top) == 0:
        return {"xyz": np.zeros((0, 3), np.float32), "rgb": np.zeros((0, 3), np.float32), "alpha": np.zeros(0, np.float32),
                "sigma": np.zeros((0, 3), np.float32), "quat": np.zeros((0, 4), np.float32)}, 0
    tall = top[:, 1] - floor_y
    nper = np.maximum(1, np.ceil(tall / SKIRT_SPACING)).astype(int)
    rep = np.repeat(np.arange(len(top)), nper)
    k = np.arange(rep.size) - np.repeat(np.cumsum(nper) - nper, nper)
    y = top[rep, 1] - (k + 1) * (tall[rep] / nper[rep])
    xyz = np.stack([top[rep, 0], y, top[rep, 2]], -1).astype(np.float32)
    frac = np.clip((y - floor_y) / tall[rep], 0.0, 1.0)
    shade = 0.55 + 0.45 * frac**0.7  # darker towards the floor
    nrm = np.stack([-top[rep, 0], np.zeros(rep.size, np.float32), -top[rep, 2]], -1)
    nrm[np.linalg.norm(nrm, axis=1) < 1e-6] = (0.0, 0.0, 1.0)
    sz = SKIRT_SPACING
    su = np.maximum(0.75 * sz, 0.75 * span[rep])
    sigma = np.stack([su, np.full(rep.size, 0.75 * sz), np.full(rep.size, 0.12 * sz)], -1).astype(np.float32)
    # _facing_quats puts local x horizontal for a vertical sheet: su spans along the row.
    layer = {
        "xyz": xyz,
        "rgb": np.clip(col[rep] * shade[:, None], 0, 1).astype(np.float32),
        "alpha": np.full(rep.size, 0.97, np.float32),
        "sigma": sigma,
        "quat": _facing_quats(nrm),
    }
    return layer, int(len(top))


def _luma(c) -> np.ndarray:
    return np.asarray(c, np.float32) @ LUMA


def _at_luma(c, target: float) -> np.ndarray:
    """Colour c scaled to the luminance `target`, keeping its hue as far as 0..1 allows."""
    c = np.asarray(c, np.float32)
    lum = float(_luma(c))
    grey = np.full(3, target, np.float32)
    if lum < 1e-4:
        return grey
    out = c * (target / lum)
    for a in np.linspace(0.0, 1.0, 11):
        m = out * (1 - a) + grey * a
        if m.max() <= 1.0:
            return m.astype(np.float32)
    return grey


def _rgb_str(c) -> str:
    return "#" + "".join(f"{int(round(float(x) * 255)):02x}" for x in np.clip(c, 0, 1))


def _desaturate(c, k: float) -> np.ndarray:
    c = np.asarray(c, np.float32)
    return c * (1 - k) + float(_luma(c)) * k


def _shell(rgbf: np.ndarray, d: np.ndarray, Kw: dict, Rf: np.ndarray, content: np.ndarray, floor_y: float,
           floor_rgb: np.ndarray | None = None, log=print):
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

    # Palette from the plate, at about the plate's own brightness. The walls take the colour of
    # the plate's far surfaces (the background: the farthest surface around each pixel).
    lum_plate = float(_luma(rgbf.reshape(-1, 3)).mean())
    far = d >= 0.85 * cv2.dilate(d, _disk(max(3, w // 16)))
    rows = np.repeat(np.arange(h)[:, None], w, 1)
    upper_far = far & (rows < 0.7 * h)
    wall_raw = np.median(rgbf[upper_far], axis=0) if upper_far.sum() > 50 else np.median(rgbf.reshape(-1, 3), axis=0)
    low_raw = np.median(rgbf[rows > 0.6 * h], axis=0)
    top_raw = np.median(rgbf[rows < 0.2 * h], axis=0)
    wall_c = _at_luma(_desaturate(wall_raw, 0.15), float(np.clip(_luma(wall_raw), 1.0 * lum_plate, 1.2 * lum_plate)))
    if floor_rgb is not None:
        floor_c = _at_luma(floor_rgb, max(float(_luma(floor_rgb)), 0.6 * lum_plate))
    else:
        # Unseen floor: a calmer, slightly darker tone of the room's colours, so the floor line reads.
        floor_c = _at_luma(_desaturate(0.5 * wall_raw + 0.5 * low_raw, 0.4), 0.72 * lum_plate)
    ceil_c = _at_luma(_desaturate(0.5 * top_raw + 0.5 * wall_raw, 0.5), 0.95 * lum_plate)

    # Gentle low-frequency variation (a few long waves in 3D), so no face is one flat colour.
    rng = np.random.default_rng(11)
    waves = []
    for lam in (3.2, 2.1, 1.4, 0.95):
        kv = rng.normal(size=3)
        waves.append(((kv / np.linalg.norm(kv) * (2 * math.pi / lam)).astype(np.float32), float(rng.uniform(0, 2 * math.pi))))
    tints = []
    for lam in (2.6, 1.7):
        kv = rng.normal(size=3)
        tints.append(((kv / np.linalg.norm(kv) * (2 * math.pi / lam)).astype(np.float32), float(rng.uniform(0, 2 * math.pi))))

    def wave(pts, ws):
        return sum(np.cos(pts @ k + ph) for k, ph in ws) / math.sqrt(len(ws) / 2.0)

    # Plate colours for the parts of the box seen through (or just outside) the camera's frame:
    # far surfaces only, so a foreground object is never painted onto the walls behind it.
    pad = max(w, h) // 4
    fw = far.astype(np.float32)

    def far_blur(sig):
        num = cv2.GaussianBlur(cv2.copyMakeBorder(rgbf * fw[..., None], pad, pad, pad, pad, cv2.BORDER_REFLECT_101), (0, 0), sig)
        den = cv2.GaussianBlur(cv2.copyMakeBorder(fw, pad, pad, pad, pad, cv2.BORDER_REFLECT_101), (0, 0), sig)
        num, den = num[pad:-pad, pad:-pad], den[pad:-pad, pad:-pad]
        return num / np.maximum(den, 1e-4)[..., None], den

    far_s, den_s = far_blur(max(w, h) * 0.015)
    far_l, den_l = far_blur(max(w, h) * 0.1)
    far_s = np.where((den_s > 0.05)[..., None], far_s, far_l)
    far_l = np.where((den_l > 0.01)[..., None], far_l, wall_c)
    blur_floor = cv2.GaussianBlur(rgbf, (0, 0), max(w, h) * 0.01)

    layer_xyz, layer_rgb, layer_norm = [], [], []
    for origin, au, av, lu, lv, nrm, kind in faces:
        pts, eu, ev = _grid_plane(origin, au, av, float(lu), float(lv), st)
        hgt = np.clip((pts[:, 1] - y0) / max(y1 - y0, 1e-3), 0, 1)
        if kind == "floor":
            base = np.repeat(floor_c[None], len(pts), 0)
        elif kind == "ceiling":
            base = np.repeat(ceil_c[None], len(pts), 0)
        else:
            sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))  # noqa: E731
            shade = (0.8 + 0.2 * sm(0.0, 0.3, hgt)) * (1 - 0.06 * sm(0.8, 1.0, hgt))
            base = wall_c[None] * shade[:, None]
        var = 1.0 + 0.06 * np.clip(wave(pts, waves), -2.5, 2.5)
        tint = 1.0 + 0.025 * np.clip(wave(pts, tints), -2.5, 2.5)[:, None] * np.array([[1.0, 0.0, -1.0]], np.float32)
        edge = np.minimum(eu, ev)
        ao = 1.0 - 0.14 * np.exp(-edge / 0.35)  # soft corners
        col = base * (var * ao)[:, None] * tint

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
            if kind == "floor":
                # Only where the plate there really shows the floor; elsewhere keep the floor tone.
                dz = _sample_bilinear(d[..., None], uc, vc).reshape(-1)
                match = (t == 0) & (np.abs(dz - zc) < 0.1 * np.maximum(zc, 1e-3))
                plate_col = _sample_bilinear(blur_floor, uc, vc)
                wgt = (match * 0.85)[:, None]
            else:
                cs = _sample_bilinear(far_s, uc, vc)
                cl = _sample_bilinear(far_l, uc, vc)
                kk = np.clip(t / 0.08, 0, 1)[:, None]
                plate_col = cs * (1 - kk) + cl * kk
                wgt = (np.clip(1.0 - t / 0.4, 0.0, 1.0) ** 1.5)[:, None] * front[:, None]
            col = plate_col * wgt + col * (1 - wgt)
        layer_xyz.append(pts)
        layer_rgb.append(col)
        layer_norm.append(np.repeat(nrm[None], len(pts), 0))
    xyz = np.concatenate(layer_xyz)
    nrm = np.concatenate(layer_norm)
    rgb_all = np.clip(np.concatenate(layer_rgb), 0, 1).astype(np.float32)
    layer = {
        "xyz": xyz,
        "rgb": rgb_all,
        "alpha": np.full(len(xyz), 0.98, np.float32),
        "sigma": np.tile(np.array([[st * 0.75, st * 0.75, st * 0.08]], np.float32), (len(xyz), 1)),
        "quat": _facing_quats(nrm),
    }
    log(f"plate room: shell {len(xyz)} splats, brightness {float(_luma(rgb_all).mean()) / max(lum_plate, 1e-6):.0%} of the plate "
        f"(wall {_rgb_str(wall_c)}, floor {_rgb_str(floor_c)}, ceiling {_rgb_str(ceil_c)})")
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
