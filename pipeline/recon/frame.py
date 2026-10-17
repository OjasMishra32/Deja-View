#!/usr/bin/env python3
"""Steps 3 and 5: the room frame (level, metric, spawn) and the finished scene.

  python pipeline/recon/frame.py pre  --work WORK [--spawn-image photo/IMG_0001.jpg] [--eye 1.45]
  python pipeline/recon/frame.py post --work WORK --scene-dir data/scenes/<id> --id <id> --name "Name"
                                      [--splats WORK/train/splats.ply] [--sh 3] [--max-splats 1500000]

`pre` (before training, sparse points only) finds the floor (RANSAC plane under the cameras, normal near the
cameras' mean up), the metric scale and the spawn, and writes WORK/frame.json with the similarity
x_room = scale * R @ x_colmap + t. The room frame is the viewer frame: y up, metres, floor y = 0, the spawn at the
origin facing -Z. Scale comes from a reference table when one is found (default: a table-tennis table,
2.74 x 1.525 m top at 0.76 m; the blue top is picked by colour, its outline by a minimum-area rectangle on the
plane at the top's height), otherwise from the cameras standing --eye metres above the floor. The spawn is the
photo that looks most squarely at the table from a few metres away (or --spawn-image), on the floor under it.

`post` (after training, on the dense splats) re-measures the floor and the table, applies the small correction
that keeps no rotation (a floor shift and a uniform scale about the origin, so spherical harmonics stay valid),
crops (transparent, far, huge and isolated splats), and writes the scene: world.spz, scene.json, thumb.jpg rendered
from the spawn, cameras.json (every solved view in the viewer frame) and, per video, <clip>-poses.json with the
camera of every sampled frame plus a per-frame interpolated track.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from cams import Camera, qvec_to_rotmat
from util import Work, log, read_json, write_json

import splat_io as sio  # noqa: E402  (util puts pipeline/ on sys.path)

TABLE_TENNIS = (2.74, 1.525, 0.76)


def say(msg: str) -> None:
    log("frame", msg)


# --------------------------------------------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------------------------------------------


def camera_centers_and_axes(images: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Centres, up vectors (-y of the OpenCV camera) and forward vectors (+z) in the COLMAP frame."""
    C, U, F = [], [], []
    for im in images:
        R = qvec_to_rotmat(im["qvec"])
        C.append(-R.T @ np.asarray(im["tvec"]))
        U.append(-R[1])
        F.append(R[2])
    return np.array(C), np.array(U), np.array(F)


def blue_mask(rgb01: np.ndarray, hue=(195.0, 235.0), sat_min: float = 0.35, val_min: float = 0.25) -> np.ndarray:
    import cv2

    hsv = cv2.cvtColor(np.clip(rgb01 * 255, 0, 255).astype(np.uint8)[None], cv2.COLOR_RGB2HSV_FULL)[0].astype(np.float32)
    h = hsv[:, 0] * 360.0 / 256.0
    s = hsv[:, 1] / 255.0
    v = hsv[:, 2] / 255.0
    return (h >= hue[0]) & (h <= hue[1]) & (s >= sat_min) & (v >= val_min)


def largest_cluster(xz: np.ndarray, cell: float) -> np.ndarray:
    """Indices of the points in the largest 8-connected group of occupied grid cells."""
    import cv2

    if len(xz) == 0:
        return np.zeros(0, np.int64)
    lo = xz.min(0)
    ij = np.floor((xz - lo) / cell).astype(np.int64)
    w, h = ij.max(0) + 1
    if w * h > 50_000_000:
        return np.arange(len(xz))
    grid = np.zeros((h, w), np.uint8)
    grid[ij[:, 1], ij[:, 0]] = 1
    grid = cv2.dilate(grid, np.ones((3, 3), np.uint8))
    n, lab = cv2.connectedComponents(grid, connectivity=8)
    if n <= 2:
        return np.arange(len(xz))
    pl = lab[ij[:, 1], ij[:, 0]]
    counts = np.bincount(pl, minlength=n)
    counts[0] = 0
    return np.nonzero(pl == int(np.argmax(counts)))[0]


def find_table(P: np.ndarray, rgb01: np.ndarray, m_per_unit: float, top=TABLE_TENNIS, trim: float = 0.0,
               opacity: np.ndarray | None = None) -> dict | None:
    """Finds a coloured rectangular table top in levelled points (y up, floor at y = 0, any units).

    m_per_unit is a rough guess of the metres per unit (for the search windows only). Returns the top's height,
    length, width (in the input units), centre, axis angle and corners, or None."""
    L0, W0, H0 = top
    keep = blue_mask(rgb01)
    if opacity is not None:
        keep &= opacity >= 0.5
    y_m = P[:, 1] * m_per_unit
    keep &= (y_m > 0.45) & (y_m < 1.15)
    B = P[keep]
    if len(B) < 30:
        return None
    # the top is a thin horizontal sheet: the sharpest peak of the heights of blue points
    bins = np.arange(0.45, 1.15 + 1e-9, 0.01) / m_per_unit
    hist, edges = np.histogram(B[:, 1], bins=bins)
    hist = np.convolve(hist, [1, 2, 3, 2, 1], mode="same")
    k = int(np.argmax(hist))
    y_top = 0.5 * (edges[k] + edges[k + 1])
    band = 0.025 / m_per_unit
    sheet = B[np.abs(B[:, 1] - y_top) < band]
    if len(sheet) < 20:
        return None
    y_top = float(np.median(sheet[:, 1]))
    sheet = B[np.abs(B[:, 1] - y_top) < band]
    sel = largest_cluster(sheet[:, [0, 2]], 0.06 / m_per_unit)
    sheet = sheet[sel]
    import cv2

    (cx, cz), (a, b), ang = cv2.minAreaRect(sheet[:, [0, 2]].astype(np.float32))
    theta = math.radians(ang) if a >= b else math.radians(ang + 90.0)
    u = np.array([math.cos(theta), math.sin(theta)])
    v = np.array([-u[1], u[0]])
    # the white edge lines belong to the top too: take every point of the sheet's plane over the blue rectangle
    near = np.abs(P[:, 1] - y_top) < band
    if opacity is not None:
        near &= opacity >= 0.5
    Q = P[near][:, [0, 2]] - np.array([cx, cz])
    qu, qv = Q @ u, Q @ v
    hu, hv = 0.5 * max(a, b) + 0.05 / m_per_unit, 0.5 * min(a, b) + 0.05 / m_per_unit
    inside = (np.abs(qu) <= hu) & (np.abs(qv) <= hv)
    qu, qv = qu[inside], qv[inside]
    blue_u, blue_v = (sheet[:, [0, 2]] - np.array([cx, cz])) @ u, (sheet[:, [0, 2]] - np.array([cx, cz])) @ v
    lo, hi = trim, 100.0 - trim
    u0, u1 = np.percentile(np.concatenate([qu, blue_u]), [lo, hi])
    v0, v1 = np.percentile(np.concatenate([qv, blue_v]), [lo, hi])
    L, W = float(u1 - u0), float(v1 - v0)
    centre = np.array([cx, cz]) + u * 0.5 * (u0 + u1) + v * 0.5 * (v0 + v1)
    corners = [centre + su * 0.5 * L * u + sv * 0.5 * W * v for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return {
        "height": y_top,
        "length": L,
        "width": W,
        "blueLength": float(blue_u.max() - blue_u.min()),
        "blueWidth": float(blue_v.max() - blue_v.min()),
        "aspect": L / max(W, 1e-9),
        "centre": [float(centre[0]), y_top, float(centre[1])],
        "axis": [float(u[0]), 0.0, float(u[1])],
        "corners": [[float(c[0]), y_top, float(c[1])] for c in corners],
        "points": int(len(sheet)),
        "edgePoints": int(len(qu)),
    }


def rot_y_to(forward: np.ndarray) -> np.ndarray:
    """Rotation about +Y that turns a horizontal forward vector onto -Z."""
    f = np.array([forward[0], 0.0, forward[2]])
    f /= max(np.linalg.norm(f), 1e-12)
    yaw = sio.yaw_of_forward(f)
    return sio.rot_y(-yaw)


def apply(Rt: dict, X: np.ndarray) -> np.ndarray:
    R = np.asarray(Rt["R"], np.float64)
    return Rt["scale"] * (np.asarray(X, np.float64) @ R.T) + np.asarray(Rt["t"], np.float64)


# --------------------------------------------------------------------------------------------------------------
# pre
# --------------------------------------------------------------------------------------------------------------


def frame_pre(work: Work, spawn_image: str | None, eye: float, evidence: Path | None) -> dict:
    poses = read_json(work.poses)
    regs = [im for im in poses["images"] if im.get("registered")]
    C, U, F = camera_centers_and_axes(regs)
    d = np.load(work.root / "points.npz")
    good = (d["track"] >= 3) & (d["error"] < 2.0)
    P = d["xyz"][good].astype(np.float64)
    rgb = d["rgb"][good].astype(np.float64) / 255.0
    up0 = U.sum(0)
    up0 /= np.linalg.norm(up0)
    fit = sio.estimate_floor(P, None, camera=np.median(C, axis=0), up=up0, max_tilt_deg=25.0, iters=2000)
    say(f"floor: {fit.reason}; tilt from the cameras' up {fit.tilt_deg:.1f} deg, support {fit.support:.3f}, below {fit.below:.3f}")
    if not fit.found:
        raise SystemExit(f"no floor found: {fit.reason}")
    n = fit.normal / np.linalg.norm(fit.normal)
    R_l = sio.rotation_between(n, [0.0, 1.0, 0.0])
    lift = np.array([0.0, fit.offset, 0.0])  # n.x + offset = 0 on the floor -> levelled y = n.x + offset

    def level(X):
        return np.asarray(X, np.float64) @ R_l.T + lift

    PL, CL = level(P), level(C)
    cam_h = CL[:, 1]
    groups = [im.get("group", "") for im in regs]
    med_h = float(np.median(cam_h))
    guess = eye / med_h
    table = find_table(PL, rgb, guess)
    scale_eye = guess
    method = "eye"
    s = scale_eye
    if table:
        s_l, s_w = TABLE_TENNIS[0] / table["length"], TABLE_TENNIS[1] / table["width"]
        s_t = math.sqrt(s_l * s_w)
        ok = abs(table["aspect"] / (TABLE_TENNIS[0] / TABLE_TENNIS[1]) - 1) < 0.15 and abs(table["height"] * s_t - TABLE_TENNIS[2]) < 0.15
        say(f"table in sparse points: {table['points']} blue + {table['edgePoints']} plane points, L/W {table['aspect']:.3f} "
            f"(2.74/1.525 = 1.797), scale from table {s_t:.4f} vs from eye height {scale_eye:.4f}; "
            f"top at {table['height'] * s_t:.3f} m -> {'use the table' if ok else 'not trusted'}")
        if ok:
            s, method = s_t, "table"
    else:
        say("no table top found in the sparse points; scale from eye height")
    # spawn: a photo that looks squarely at the table from a few metres away
    photo_idx = [i for i, g in enumerate(groups) if str(g).startswith("photo")] or list(range(len(regs)))
    target = np.array(table["centre"]) if table else np.median(PL, axis=0)
    if spawn_image:
        names = [im["name"] for im in regs]
        if spawn_image not in names:
            raise SystemExit(f"--spawn-image {spawn_image} is not a registered image")
        k_sp = names.index(spawn_image)
    else:
        best, k_sp = -1e9, photo_idx[0]
        FL = F @ R_l.T
        for i in photo_idx:
            to = target - CL[i]
            to[1] = 0
            dist = np.linalg.norm(to) * s
            f = FL[i].copy()
            f[1] = 0
            cosang = float(np.dot(to, f) / max(np.linalg.norm(to) * np.linalg.norm(f), 1e-9))
            score = cosang - 0.15 * abs(dist - 4.0) - (2.0 if not 2.0 <= dist <= 7.0 else 0.0)
            if score > best:
                best, k_sp = score, i
    fwd = R_l @ F[k_sp]
    R_y = rot_y_to(fwd)
    p0 = CL[k_sp].copy()
    p0[1] = 0.0
    R = R_y @ R_l
    t = s * (R_y @ (lift - p0))
    Rt = {"R": R.tolist(), "t": t.tolist(), "scale": s}
    CR = apply(Rt, C)
    out = {
        "colmapToRoom": Rt,
        "frame": "viewer: y up, metres, floor y = 0, spawn at the origin facing -Z",
        "floor": fit.to_json(),
        "up": up0.tolist(),
        "scale": {
            "method": method,
            "value": s,
            "fromEyeHeight": scale_eye,
            "eyeHeight": eye,
            "cameraHeight": {"median": float(np.median(cam_h) * s), "min": float(cam_h.min() * s), "max": float(cam_h.max() * s)},
        },
        "spawn": {"image": regs[k_sp]["name"], "position": [0.0, 0.0, 0.0], "yaw": 0.0, "eye": float(CR[k_sp][1])},
    }
    if table:
        tr = dict(table)
        for k in ("height", "length", "width", "blueLength", "blueWidth"):
            tr[k] = table[k] * s
        tr["centre"] = apply(Rt, np.linalg.solve(R_l, np.array(table["centre"]) - lift)[None])[0].tolist()
        tr["corners"] = apply(Rt, (np.array(table["corners"]) - lift) @ R_l)[:, :].tolist()
        out["table"] = tr
        say(f"table after scaling: {tr['length']:.3f} x {tr['width']:.3f} m, top at {tr['height']:.3f} m "
            f"(real 2.74 x 1.525, 0.76)")
    write_json(work.frame, out)
    say(f"scale {s:.4f} ({method}); cameras {out['scale']['cameraHeight']['median']:.2f} m above the floor (median); "
        f"spawn {regs[k_sp]['name']}")
    if evidence is not None:
        FR = F @ np.asarray(Rt["R"]).T
        topdown(evidence / "frame-topdown.jpg", apply(Rt, P), rgb, CR, FR, [im["name"] for im in regs], out.get("table"))
    return out


def topdown(path: Path, P: np.ndarray, rgb: np.ndarray, C: np.ndarray, F: np.ndarray, names: list[str], table: dict | None,
            px: float = 0.015, margin: float = 6.0) -> None:
    """Top view (x right, -z up) of the points between 0.15 and 3 m, the cameras with their headings (photos
    yellow, videos blue and red by clip) and the table outline, for checking the frame by eye."""
    import cv2

    lo = C[:, [0, 2]].min(0) - margin
    hi = C[:, [0, 2]].max(0) + margin
    W, H = int((hi[0] - lo[0]) / px), int((hi[1] - lo[1]) / px)
    img = np.full((H, W, 3), 16, np.uint8)

    def pix(x, z):
        return int((x - lo[0]) / px), int((z - lo[1]) / px)

    for k in range(int(np.floor(lo[0])), int(np.ceil(hi[0])) + 1):
        cv2.line(img, pix(k, lo[1]), pix(k, hi[1]), (48, 48, 48), 1)
    for k in range(int(np.floor(lo[1])), int(np.ceil(hi[1])) + 1):
        cv2.line(img, pix(lo[0], k), pix(hi[0], k), (48, 48, 48), 1)
    sel = (P[:, 1] > 0.15) & (P[:, 1] < 3.0)
    blue = blue_mask(rgb[sel])
    uv = np.array([pix(x, z) for x, _, z in P[sel]]).reshape(-1, 2)
    ok = (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    col = np.where(blue[:, None], np.array([255, 90, 0], np.uint8), (rgb[sel][:, ::-1] * 255).astype(np.uint8))
    img[uv[ok, 1], uv[ok, 0]] = col[ok]
    groups = sorted({n.split("/")[0] for n in names if not n.startswith("photo")})
    palette = [(255, 160, 60), (60, 60, 255), (80, 220, 80), (220, 80, 220)]
    for (x, _, z), f, nm in zip(C, F, names):
        g = nm.split("/")[0]
        colr = (0, 200, 255) if g.startswith("photo") else palette[groups.index(g) % len(palette)]
        u, v = pix(x, z)
        cv2.circle(img, (u, v), 4, colr, -1)
        cv2.line(img, (u, v), pix(x + 0.4 * f[0], z + 0.4 * f[2]), colr, 1)
    if table:
        cv2.polylines(img, [np.array([pix(c[0], c[2]) for c in table["corners"]], np.int32)], True, (0, 255, 0), 1)
    cv2.circle(img, pix(0, 0), 7, (255, 255, 255), 2)
    cv2.line(img, pix(0, 0), pix(0, -0.8), (255, 255, 255), 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 90])


# --------------------------------------------------------------------------------------------------------------
# post
# --------------------------------------------------------------------------------------------------------------


def floor_refine(s: sio.Splats, radius: float = 6.0) -> dict:
    """Height of the floor near the origin from flat, opaque splats close to y = 0, and its residual tilt."""
    m = s.means
    near = (np.hypot(m[:, 0], m[:, 2]) < radius) & (np.abs(m[:, 1]) < 0.12) & (s.opacities > 0.6)
    sc = np.sort(s.scales, axis=1)
    near &= sc[:, 0] < 0.3 * sc[:, 1]
    P = m[near].astype(np.float64)
    if len(P) < 500:
        return {"found": False, "points": int(len(P))}
    fit = sio.estimate_floor(P + np.array([0, 0.0, 0]), None, camera=(0.0, 1.5, 0.0), up=(0, 1, 0), max_tilt_deg=10, iters=800)
    if fit.found:
        y0 = -fit.offset / fit.normal[1]
        return {"found": True, "y": float(y0), "tiltDeg": float(fit.tilt_deg), "support": float(fit.support), "points": int(len(P))}
    return {"found": False, "y": float(np.median(P[:, 1])), "points": int(len(P)), "reason": fit.reason}


def isolated(means: np.ndarray, opac: np.ndarray, cell: float, min_neighbours: float) -> np.ndarray:
    """Splats whose 3x3x3 voxel neighbourhood holds less than min_neighbours of opacity in total."""
    ij = np.floor(means / cell).astype(np.int64)
    ij -= ij.min(0) - 1
    dims = ij.max(0) + 2
    key = (ij[:, 0] * dims[1] + ij[:, 1]) * dims[2] + ij[:, 2]
    uk, inv = np.unique(key, return_inverse=True)
    mass = np.bincount(inv, weights=opac)
    total = np.zeros(len(means))
    for a in (-1, 0, 1):
        for b in (-1, 0, 1):
            for c in (-1, 0, 1):
                k2 = key + (a * dims[1] + b) * dims[2] + c
                pos = np.minimum(np.searchsorted(uk, k2), len(uk) - 1)
                hit = uk[pos] == k2
                total += np.where(hit, mass[pos], 0.0)
    return total < min_neighbours


def load_pose_deltas(train_dir: Path | None) -> dict:
    """The per-view pose corrections train_gs.py learned (pose_deltas.json, or the torch file), name -> [6]."""
    if train_dir is None:
        return {}
    js = read_json(train_dir / "pose_deltas.json")
    if js:
        return {k: np.asarray(v, np.float64) for k, v in js["deltas"].items()}
    pt = train_dir / "pose_deltas.pt"
    if pt.exists():
        import torch

        d = torch.load(pt, map_location="cpu")
        return {n: d["delta"][k].double().numpy() for k, n in enumerate(d["names"]) if float(d["delta"][k].abs().sum()) > 0}
    return {}


def delta_matrix(d: np.ndarray) -> np.ndarray:
    """[6] (axis-angle, translation) -> the 4x4 camera-frame correction train_gs.py applies (w2c' = D @ w2c)."""
    from scipy.spatial.transform import Rotation

    D = np.eye(4)
    D[:3, :3] = Rotation.from_rotvec(d[:3]).as_matrix()
    D[:3, 3] = d[3:]
    return D


def room_cameras(work: Work, Rt: dict, post: dict | None = None, deltas: dict | None = None) -> list[dict]:
    """Every registered view in the viewer frame (OpenGL camera: looks down -Z, +Y up), with pinhole intrinsics.
    `deltas` (load_pose_deltas) are the training's refinements of the clip frames, applied when given."""
    poses = read_json(work.poses)
    cams = {cid: Camera.from_json(c) for cid, c in poses["cameras"].items()}
    out = []
    for im in poses["images"]:
        if not im.get("registered"):
            continue
        R = qvec_to_rotmat(im["qvec"])
        C = -R.T @ np.asarray(im["tvec"])
        c2w = np.eye(4)
        c2w[:3, :3] = np.asarray(Rt["R"]) @ R.T
        c2w[:3, 3] = apply(Rt, C[None])[0]
        if deltas and im["name"] in deltas:
            c2w = np.linalg.inv(delta_matrix(deltas[im["name"]]) @ np.linalg.inv(c2w))
        if post:
            c2w[:3, 3] = (c2w[:3, 3] + np.array([0.0, post["dy"], 0.0])) * post["scale"]
        gl = sio.c2w_cv_to_gl(c2w)
        cam = cams[im["camera"]]
        rec = {k: im[k] for k in ("name", "group", "source", "frameIndex", "time") if k in im}
        rec.update({
            "position": [round(float(v), 6) for v in gl[:3, 3]],
            "quaternion": sio.matrix_to_quat_xyzw(gl[:3, :3]),
            "c2w": [[round(float(v), 7) for v in row] for row in gl],
            "intrinsics": {k: round(v, 4) if isinstance(v, float) else v for k, v in cam.to_json().items() if k in ("fx", "fy", "cx", "cy", "width", "height")},
            "distortion": cam.distortion(),
            "reprojError": im.get("reprojError"),
        })
        out.append(rec)
    return out


def interpolate_track(keys: list[dict], times: np.ndarray) -> list[dict]:
    """Per-frame camera poses between keyframes: positions linear, rotations slerped; clamped at the ends."""
    from scipy.spatial.transform import Rotation, Slerp

    kt = np.array([k["time"] for k in keys])
    order = np.argsort(kt)
    kt = kt[order]
    pos = np.array([keys[i]["position"] for i in order])
    rot = Rotation.from_quat([keys[i]["quaternion"] for i in order])
    sl = Slerp(kt, rot)
    tt = np.clip(times, kt[0], kt[-1])
    P = np.stack([np.interp(tt, kt, pos[:, j]) for j in range(3)], axis=1)
    Q = sl(tt).as_quat()
    return [{"frameIndex": int(i), "time": round(float(t), 6), "position": [round(float(v), 5) for v in p],
             "quaternion": [round(float(v), 7) for v in q], "extrapolated": bool(t < kt[0] or t > kt[-1])}
            for i, (t, p, q) in enumerate(zip(times, P, Q))]


def frame_post(a) -> dict:
    work = Work(a.work)
    frame = read_json(work.frame)
    scene_dir = Path(a.scene_dir)
    scene_dir.mkdir(parents=True, exist_ok=True)
    s = sio.read_splats(a.splats or work.train / "splats.ply")
    n0 = len(s)
    say(f"{n0} splats from {a.splats or work.train / 'splats.ply'}")
    # 1. floor: shift so the dense floor is exactly y = 0
    fl = floor_refine(s)
    dy = -fl["y"] if fl.get("found") and abs(fl["y"]) < 0.25 else 0.0
    if a.fixed_frame is not None:  # keep an earlier run's room frame exactly (its floor shift, no table rescale)
        dy = float(a.fixed_frame)
    say(f"floor near the origin: {fl}; shift {dy:+.4f} m")
    s = sio.transform_splats(s, np.eye(3), (0.0, dy, 0.0), 1.0)
    # 2. table: measure on the dense splats, correct the scale about the origin
    tab = find_table(s.means.astype(np.float64), s.rgb().astype(np.float64), 1.0, trim=0.5, opacity=s.opacities)
    corr = 1.0
    measured = None
    if tab and a.fixed_frame is None:
        c_l, c_w = TABLE_TENNIS[0] / tab["length"], TABLE_TENNIS[1] / tab["width"]
        c = math.sqrt(c_l * c_w)
        measured = {"before": {"length": tab["length"], "width": tab["width"], "height": tab["height"]}, "points": tab["points"]}
        say(f"table in the splats: {tab['length']:.3f} x {tab['width']:.3f} m, top at {tab['height']:.3f} m "
            f"(blue {tab['blueLength']:.3f} x {tab['blueWidth']:.3f}); correction {c:.4f}")
        if abs(c - 1) > 0.004 and abs(c - 1) < 0.2:
            corr = c
    if corr != 1.0:
        s = sio.transform_splats(s, np.eye(3), (0.0, 0.0, 0.0), corr)
        tab = find_table(s.means.astype(np.float64), s.rgb().astype(np.float64), 1.0, trim=0.5, opacity=s.opacities)
    if tab and measured is not None:
        measured["after"] = {"length": tab["length"], "width": tab["width"], "height": tab["height"],
                             "centre": tab["centre"], "corners": tab["corners"]}
        measured["errorCm"] = {"length": round(100 * (tab["length"] - TABLE_TENNIS[0]), 1),
                               "width": round(100 * (tab["width"] - TABLE_TENNIS[1]), 1),
                               "height": round(100 * (tab["height"] - TABLE_TENNIS[2]), 1)}
        say(f"table now {tab['length']:.3f} x {tab['width']:.3f} m, top at {tab['height']:.3f} m; error (cm) {measured['errorCm']}")
    post = {"dy": dy, "scale": corr}
    deltas = load_pose_deltas(Path(a.splats).parent if a.splats else work.train)
    cams = room_cameras(work, frame["colmapToRoom"], post, deltas)
    if deltas:
        say(f"applied the training's pose refinements to {len(deltas)} clip frames")
    C = np.array([c["position"] for c in cams])
    quality = {}
    if sio.gsplat_available():
        quality["beforeCrop"] = photo_psnr(work, s, cams, a.test_every, a.test_names)
        say(f"photos rendered from the trained splats: {quality['beforeCrop']['mean']}")
    # 3. crop
    m = s.means.astype(np.float64)
    r_h = np.hypot(m[:, 0], m[:, 2])
    keep = np.isfinite(m).all(1) & (s.opacities >= a.min_opacity)
    keep &= (r_h < a.keep_radius) & (m[:, 1] > -a.below) & (m[:, 1] < a.ceiling)
    lo_c, hi_c = C[:, [0, 2]].min(0) - a.margin, C[:, [0, 2]].max(0) + a.margin
    inner = (m[:, 0] > lo_c[0]) & (m[:, 0] < hi_c[0]) & (m[:, 2] > lo_c[1]) & (m[:, 2] < hi_c[1])
    # Both of these are off by default: on the patio capture, dropping the mirror images under the glossy floor
    # cost 2.3 dB and the isolated-splat test 1.3 dB on the photos, for floaters that were barely visible.
    below_inner = inner & (m[:, 1] < -a.below_inner) if a.below_inner is not None else np.zeros(len(m), bool)
    keep &= ~below_inner
    alone = isolated(m, s.opacities.astype(np.float64), a.floater_cell, a.floater_mass) if a.floater_mass > 0 else np.zeros(len(m), bool)
    keep &= ~(alone & inner & (m[:, 1] > 0.05))
    stats = {"start": n0, "opacity": int(np.count_nonzero(s.opacities < a.min_opacity)),
             "outside": int(np.count_nonzero((r_h >= a.keep_radius) | (m[:, 1] <= -a.below) | (m[:, 1] >= a.ceiling))),
             "belowFloorInside": int(np.count_nonzero(below_inner)),
             "isolated": int(np.count_nonzero(alone & inner & (m[:, 1] > 0.05)))}
    s = s.subset(np.nonzero(keep)[0])
    idx = sio.prune_indices(s, max_count=a.max_splats, min_opacity=a.min_opacity, cameras=C, far_factor=1e6, max_angular_size=a.max_angular)
    stats["huge"] = int(len(s) - len(idx))
    s = s.subset(idx)
    stats["kept"] = int(len(s))
    say(f"crop: {stats}")
    s = s.with_sh_degree(a.sh)
    if sio.gsplat_available():
        # what the viewer gets: SPZ quantisation included
        sio.write_spz(work.root / ".export-check.spz", s)
        quality["exported"] = photo_psnr(work, sio.read_spz(work.root / ".export-check.spz"), cams, a.test_every, a.test_names)
        (work.root / ".export-check.spz").unlink()
        say(f"photos rendered from the exported world.spz: {quality['exported']['mean']}")
    sio.write_spz(scene_dir / "world.spz", s)
    say(f"wrote world.spz: {len(s)} splats, SH degree {s.sh_degree}, {(scene_dir / 'world.spz').stat().st_size / 1e6:.1f} MB")
    # 4. bounds: the walkable area around the cameras, up to the ceiling of what was seen
    mm = s.means.astype(np.float64)
    near = (mm[:, 0] > lo_c[0]) & (mm[:, 0] < hi_c[0]) & (mm[:, 2] > lo_c[1]) & (mm[:, 2] < hi_c[1]) & (s.opacities > 0.5)
    bounds = sio.robust_bounds(mm[near], 0.5, 99.5)
    bounds["min"][1] = 0.0
    # 5. thumbnail from the spawn, the cameras, the per-video tracks
    eye = 1.6
    render_spawn(s, scene_dir / "thumb.jpg", eye)
    collider = None
    if a.collider:
        V, F, cinfo = collider_mesh(s, bounds)
        write_glb(scene_dir / "collider.glb", V, F)
        collider = "collider.glb"
        say(f"collider.glb: floor plane + {cinfo['cells']} solid {cinfo['cell']} m columns, {cinfo['triangles']} triangles")
    write_json(scene_dir / "cameras.json", {"frame": "viewer (y up, metres, floor y = 0); OpenGL cameras", "cameras": cams})
    frames = read_json(work.frames, {})
    tracks = {}
    for gname, g in frames.get("groups", {}).items():
        if g.get("kind") != "video":
            continue
        keys = [c for c in cams if c.get("group") == gname]
        if not keys:
            continue
        src = Path(g["source"]).stem
        times = np.arange(int(g["frames"])) / float(g["fps"])
        times_file = work.root / f"{gname}-times.npy"
        if times_file.exists():
            times = np.load(times_file)
        total = sum(1 for im in frames["images"] if im["group"] == gname)
        doc = {
            "source": g["source"],
            "frame": "viewer (y up, metres, floor y = 0, same frame as world.spz with the identity transform); "
                     "OpenGL cameras (look down -Z, +Y up), quaternion xyzw",
            "video": {"width": g["width"], "height": g["height"], "fps": g["fps"], "frames": g["frames"], "duration": g["duration"]},
            "intrinsics": keys[0]["intrinsics"],
            "distortion": keys[0]["distortion"],
            "registered": len(keys),
            "sampled": total,
            "keyframes": sorted(keys, key=lambda k: k["frameIndex"]),
            "track": interpolate_track(keys, times),
            "note": "keyframes are solved poses (frameIndex = frame number in the file, time = presentation time in s from the "
                    "first frame), refined during training when the trainer learned corrections; track interpolates them for "
                    "every frame (positions linear, rotations slerp; clamped before the first and after the last keyframe). "
                    "intrinsics are in pixels of the full frame; distortion k1 is radial on normalized coordinates "
                    "(x_d = x (1 + k1 r^2)), and the splats were trained on frames undistorted with it.",
        }
        write_json(scene_dir / f"{src}-poses.json", doc, indent=None)
        tracks[gname] = {"file": f"{src}-poses.json", "registered": len(keys), "sampled": total}
        say(f"{src}-poses.json: {len(keys)}/{total} keyframes, {len(doc['track'])} interpolated frames")
    now = datetime.now(timezone.utc).isoformat()
    old = read_json(scene_dir / "scene.json", {}) or {}
    scene = {
        "id": a.id,
        "name": a.name,
        "mode": "reconstruct",
        "status": "ready",
        "createdAt": old.get("createdAt", now),
        "updatedAt": now,
        "backend": "hpg-batch",
        "thumb": "thumb.jpg",
        "world": {
            "file": "world.spz",
            "transform": {"position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0], "scale": 1.0},
            "floorY": 0.0,
            "spawn": {"position": [0.0, 0.0, 0.0], "yaw": 0.0},
            "bounds": bounds,
            "source": "other",
            "splatCount": int(len(s)),
            **({"collider": collider} if collider else {}),
        },
        "caption": a.caption,
    }
    if a.inputs:
        scene["input"] = {"files": a.inputs}
    write_json(scene_dir / "scene.json", scene, indent=2)
    report = {"floor": fl, "floorShift": dy, "scaleCorrection": corr, "table": measured, "crop": stats, "bounds": bounds,
              "splats": int(len(s)), "shDegree": int(s.sh_degree), "tracks": tracks, "photoQuality": quality}
    write_json(work.root / "post.json", report)
    say(f"scene written to {scene_dir}")
    if a.evidence:
        compare_views(work, s, cams, Path(a.evidence), a.compare)
    return report


def photo_psnr(work: Work, s: sio.Splats, cams: list[dict], test_every: int = 8, test_names: list[str] | None = None) -> dict:
    """PSNR / SSIM-free check of a splat set against every photo (undistorted like the trainer sees them, people
    masked), split into the held-out photos (every test_every-th) and the trained ones."""
    import cv2
    import torch

    poses = read_json(work.poses)
    cmodels = {cid: Camera.from_json(c) for cid, c in poses["cameras"].items()}
    cam_of = {im["name"]: im["camera"] for im in poses["images"] if im.get("registered")}
    photos = sorted(c["name"] for c in cams if str(c.get("group", "")).startswith("photo"))
    test = set(photos[::test_every]) if test_every > 0 else set()
    if test_names:
        test = set(test_names)
    by_name = {c["name"]: c for c in cams}
    tensors: dict = {}
    rows = []
    for nm in photos:
        c = by_name[nm]
        k = c["intrinsics"]
        r = sio.render_gsplat(s, np.asarray(c["c2w"]), k["fx"], k["fy"], k["cx"], k["cy"], int(k["width"]), int(k["height"]), tensors=tensors)
        real = cv2.cvtColor(cv2.imread(str(work.images / nm)), cv2.COLOR_BGR2RGB)
        mp = work.mask_for(nm)
        mask = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE) if mp.exists() else np.full(real.shape[:2], 255, np.uint8)
        cam = cmodels[cam_of[nm]]
        if not cam.is_pinhole():
            mx, my = cam.undistort_maps()
            real = cv2.remap(real, mx, my, cv2.INTER_LINEAR)
            mask = cv2.remap(mask, mx, my, cv2.INTER_NEAREST, borderValue=0)
        ok = mask > 127
        mse = float(np.mean((r.rgb.astype(np.float64)[ok] - real.astype(np.float64)[ok]) ** 2)) / 255.0 ** 2
        rows.append({"name": nm, "test": nm in test, "psnr": round(-10 * math.log10(max(mse, 1e-10)), 3)})
    del tensors
    torch.cuda.empty_cache()
    mean = {
        "heldOut": round(float(np.mean([r["psnr"] for r in rows if r["test"]])), 3) if test else None,
        "trained": round(float(np.mean([r["psnr"] for r in rows if not r["test"]])), 3),
    }
    return {"mean": mean, "views": rows}


def compare_views(work: Work, s: sio.Splats, cams: list[dict], out: Path, which: str) -> None:
    """Real photo | render from the same camera (the exported splats, no per-image colour), side by side."""
    import cv2

    out.mkdir(parents=True, exist_ok=True)
    sel = [c for c in cams if str(c.get("group", "")).startswith("photo")]
    if which and which != "photos":
        names = set(which.split(","))
        sel = [c for c in cams if c["name"] in names or Path(c["name"]).stem in names]
    tensors: dict = {}
    for c in sel:
        k = c["intrinsics"]
        r = sio.render(s, np.asarray(c["c2w"]), k["fx"], k["fy"], k["cx"], k["cy"], int(k["width"]), int(k["height"]), tensors=tensors)
        real = cv2.cvtColor(cv2.imread(str(work.images / c["name"])), cv2.COLOR_BGR2RGB)
        pair = np.concatenate([real, r.rgb], axis=1)
        h = 540
        pair = cv2.resize(pair, (int(pair.shape[1] * h / pair.shape[0]), h), interpolation=cv2.INTER_AREA)
        sio.save_jpeg(out / f"compare-{Path(c['name']).stem}.jpg", pair, quality=88)
    say(f"compared {len(sel)} views with the real images in {out}")


def collider_mesh(s: sio.Splats, bounds: dict, cell: float = 0.1, y_lo: float = 0.15, y_hi: float = 2.2,
                  min_mass: float = 1.5, min_cells: int = 4, clear_radius: float = 0.45) -> tuple[np.ndarray, np.ndarray, dict]:
    """A walking collider for the viewer: a flat floor at y = 0 over the walkable area plus solid columns
    (cell x cell, y_lo to y_hi) wherever splats between those heights add up to min_mass of opacity: tables,
    chairs, walls, tree trunks.

    The glossy floor is a stack of splats and mirror images a few centimetres deep, so the viewer's own splat
    collider makes the ground dip by up to 20 cm away from the spawn; the measured floor plane does not. Trained
    walls are thin stacks of half-transparent splats, so the occupancy is summed per column and closed by one cell
    to seal the gaps; specks smaller than min_cells cells are dropped (floaters)."""
    import cv2

    b0, b1 = np.asarray(bounds["min"], np.float64), np.asarray(bounds["max"], np.float64)
    pad = 1.0
    x0, z0, x1, z1 = b0[0] - pad, b0[2] - pad, b1[0] + pad, b1[2] + pad
    W, H = int(np.ceil((x1 - x0) / cell)), int(np.ceil((z1 - z0) / cell))
    m = s.means.astype(np.float64)
    pick = (s.opacities > 0.05) & (np.max(s.scales, axis=1) < 1.0) & (m[:, 1] > y_lo) & (m[:, 1] < y_hi)
    u = np.floor((m[pick, 0] - x0) / cell).astype(np.int64)
    v = np.floor((m[pick, 2] - z0) / cell).astype(np.int64)
    ok = (u >= 0) & (u < W) & (v >= 0) & (v < H)
    mass = np.zeros((H, W), np.float64)
    np.add.at(mass, (v[ok], u[ok]), s.opacities[pick][ok].astype(np.float64))
    solid = (mass >= min_mass).astype(np.uint8)
    solid = cv2.morphologyEx(solid, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    for k in range(1, n):
        if stats[k, cv2.CC_STAT_AREA] < min_cells:
            solid[lab == k] = 0
    cu = (np.arange(W) + 0.5) * cell + x0
    cv = (np.arange(H) + 0.5) * cell + z0
    solid[np.hypot(cu[None, :], cv[:, None]) < clear_radius] = 0
    vv, uu = np.nonzero(solid)
    verts, faces = [], []
    nv = 0

    def quad(corners: np.ndarray) -> None:
        nonlocal nv
        k = len(corners)
        q = nv + np.arange(k)[:, None] * 4
        verts.append(corners.reshape(-1, 3))
        faces.append(np.concatenate([q + [0, 1, 2], q + [0, 2, 3]]))
        nv += k * 4

    xa, xb = x0 + uu * cell, x0 + (uu + 1) * cell
    za, zb = z0 + vv * cell, z0 + (vv + 1) * cell
    ya, yb = np.full(len(uu), y_lo * 0 + 0.0), np.full(len(uu), y_hi)
    quad(np.stack([np.stack([xa, yb, za], 1), np.stack([xa, yb, zb], 1), np.stack([xb, yb, zb], 1), np.stack([xb, yb, za], 1)], 1))
    padded = np.pad(solid, 1)
    for du, dv in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        open_side = padded[vv + 1 + dv, uu + 1 + du] == 0
        if not open_side.any():
            continue
        i = np.nonzero(open_side)[0]
        if du == 1:
            a, b = np.stack([xb[i], za[i]], 1), np.stack([xb[i], zb[i]], 1)
        elif du == -1:
            a, b = np.stack([xa[i], zb[i]], 1), np.stack([xa[i], za[i]], 1)
        elif dv == 1:
            a, b = np.stack([xb[i], zb[i]], 1), np.stack([xa[i], zb[i]], 1)
        else:
            a, b = np.stack([xa[i], za[i]], 1), np.stack([xb[i], za[i]], 1)
        y0, y1 = ya[i], yb[i]
        quad(np.stack([np.stack([a[:, 0], y0, a[:, 1]], 1), np.stack([b[:, 0], y0, b[:, 1]], 1),
                       np.stack([b[:, 0], y1, b[:, 1]], 1), np.stack([a[:, 0], y1, a[:, 1]], 1)], 1))
    quad(np.array([[[x0, 0.0, z0], [x0, 0.0, z1], [x1, 0.0, z1], [x1, 0.0, z0]]]))
    V = np.concatenate(verts).astype(np.float32)
    F = np.concatenate(faces).astype(np.uint32)
    return V, F, {"cells": int(len(uu)), "cell": cell, "triangles": int(len(F)), "floor": [x0, z0, x1, z1],
                  "minMass": min_mass, "solid": solid}


def write_glb(path: Path, verts: np.ndarray, faces: np.ndarray) -> None:
    """Minimal glTF 2.0 binary: one mesh, positions and uint32 indices."""
    import json as _json
    import struct

    pos = np.ascontiguousarray(verts, np.float32).tobytes()
    idx = np.ascontiguousarray(faces, np.uint32).reshape(-1).tobytes()
    pos_pad = pos + b"\0" * (-len(pos) % 4)
    binary = pos_pad + idx + b"\0" * (-len(idx) % 4)
    doc = {
        "asset": {"version": "2.0", "generator": "Deja View recon"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "collider"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": int(len(verts)), "type": "VEC3",
             "min": [float(v) for v in verts.min(0)], "max": [float(v) for v in verts.max(0)]},
            {"bufferView": 1, "componentType": 5125, "count": int(faces.size), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_pad), "byteLength": len(idx), "target": 34963},
        ],
        "buffers": [{"byteLength": len(binary)}],
    }
    js = _json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(out)


def render_spawn(s: sio.Splats, path: Path, eye: float, width: int = 960, height: int = 600, hfov: float = 80.0) -> None:
    f = 0.5 * width / math.tan(math.radians(hfov) / 2)
    c2w = sio.pose_matrix(sio.rot_x(math.radians(-8.0)), [0.0, eye, 0.0])
    r = sio.render(s, c2w, f, f, width / 2, height / 2, width, height)
    sio.save_jpeg(path, r.rgb, quality=88)
    say(f"thumb.jpg rendered with {r.backend}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["pre", "post"])
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--spawn-image", default=None)
    ap.add_argument("--eye", type=float, default=1.45, help="pre: camera height above the floor when no table is found")
    ap.add_argument("--evidence", type=Path, default=None)
    ap.add_argument("--splats", type=Path, default=None)
    ap.add_argument("--scene-dir", type=Path)
    ap.add_argument("--id")
    ap.add_argument("--name")
    ap.add_argument("--caption", default="")
    ap.add_argument("--inputs", nargs="*", default=None)
    ap.add_argument("--sh", type=int, default=1,
                    help="SH degree to export: SPZ keeps degrees 2-3 at 4 bits, which shows as colour mottling in the viewer")
    ap.add_argument("--max-splats", type=int, default=1_500_000)
    ap.add_argument("--min-opacity", type=float, default=0.005)
    ap.add_argument("--test-every", type=int, default=8, help="post: which photos were held out (as train_gs.py)")
    ap.add_argument("--test-names", nargs="*", default=None, help="post: the held-out photos by name (as train_gs.py)")
    ap.add_argument("--fixed-frame", type=float, default=None,
                    help="post: use this floor shift (m) and no table rescale, so the room frame matches an earlier run")
    ap.add_argument("--keep-radius", type=float, default=150.0)
    ap.add_argument("--below", type=float, default=3.0, help="drop everything this far below the floor")
    ap.add_argument("--below-inner", type=float, default=None, help="... and this far below it inside the captured area (off)")
    ap.add_argument("--ceiling", type=float, default=30.0)
    ap.add_argument("--margin", type=float, default=2.5, help="captured area = camera positions plus this margin (m)")
    ap.add_argument("--floater-cell", type=float, default=0.12)
    ap.add_argument("--floater-mass", type=float, default=0.0, help="drop splats with less opacity than this around them (0 = off)")
    ap.add_argument("--max-angular", type=float, default=2.0, help="drop splats larger than this times their distance to the nearest camera")
    ap.add_argument("--collider", action=argparse.BooleanOptionalAction, default=True,
                    help="post: write collider.glb (flat floor + voxelised furniture) for walking in the viewer")
    ap.add_argument("--compare", default="photos", help="post: photos | comma-separated image names to render next to the real ones")
    a = ap.parse_args(argv)
    work = Work(a.work)
    t0 = time.time()
    if a.cmd == "pre":
        frame_pre(work, a.spawn_image, a.eye, a.evidence)
    else:
        if not (a.scene_dir and a.id and a.name):
            raise SystemExit("post needs --scene-dir, --id and --name")
        frame_post(a)
    say(f"done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
