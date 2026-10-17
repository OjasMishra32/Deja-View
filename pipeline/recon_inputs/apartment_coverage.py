#!/usr/bin/env python3
"""A COLMAP sparse model of one room -> floor plane, the floor area the camera moved through, a top-down plot.

  python apartment_coverage.py MODEL_TXT_DIR --frames frames.json --out coverage.json --plot path.png
      [--storey 3.84] [--radius-m 0.5]

Up: a game free camera never rolls, so every camera's x axis is horizontal; up is the direction most
perpendicular to all of them (smallest eigenvector of sum x x^T), signed to agree with the cameras' -y.
Floor: RANSAC over the sparse points below the cameras for planes whose normal is within 12 degrees of up, the
plane with the most inliers wins, then a least-squares refit on its inliers (its normal becomes up). The
ceiling is fitted the same way above the cameras. Metric scale (an estimate) comes from the floor-to-ceiling
distance taken as --storey metres (one storey of a game building).

Coverage: camera centres projected on the floor, joined in time order inside each segment, swept with a disc of
--radius-m (in metres via the scale estimate) on a raster; area, outline and path length are reported in model
units and metres. The floor frame: origin at the mean projected camera centre, z up, x/y turned so the walls run
along them (the angle that makes the histograms of the wall points' x and y the most peaked).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np


def qvec_to_rotmat(q) -> np.ndarray:
    w, x, y, z = np.asarray(q, np.float64) / np.linalg.norm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def read_model(d: Path):
    cams = {}
    for line in (d / "cameras.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            p = line.split()
            cams[int(p[0])] = {"model": p[1], "width": int(p[2]), "height": int(p[3]), "params": [float(v) for v in p[4:]]}
    images = []
    lines = [l for l in (d / "images.txt").read_text().splitlines() if not l.startswith("#")]
    for k in range(0, len(lines) - 1, 2):
        p = lines[k].split()
        if not p:
            continue
        R = qvec_to_rotmat([float(v) for v in p[1:5]])
        t = np.array([float(v) for v in p[5:8]])
        obs = lines[k + 1].split()
        n_obs = sum(1 for j in range(2, len(obs), 3) if obs[j] != "-1")
        images.append({"id": int(p[0]), "name": p[9], "camera": int(p[8]), "R": R, "t": t, "C": -R.T @ t, "nObs": n_obs})
    pts, err, track = [], [], []
    for line in (d / "points3D.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            p = line.split()
            pts.append([float(v) for v in p[1:4]] + [int(v) for v in p[4:7]])
            err.append(float(p[7]))
            track.append((len(p) - 8) // 2)
    P = np.asarray(pts, np.float64).reshape(-1, 6)
    return cams, sorted(images, key=lambda r: r["name"]), P[:, :3], P[:, 3:6].astype(np.uint8), np.asarray(err), np.asarray(track)


def ransac_plane(X: np.ndarray, up: np.ndarray, tol: float, max_angle_deg: float, iters: int, rng) -> tuple[np.ndarray, float, np.ndarray]:
    """Plane n.x = d with n within max_angle of up, most inliers within tol. Returns (n, d, inlier mask)."""
    best = (None, 0.0, np.zeros(len(X), bool))
    if len(X) < 3:
        return best
    cos_max = math.cos(math.radians(max_angle_deg))
    for _ in range(iters):
        a, b, c = X[rng.choice(len(X), 3, replace=False)]
        n = np.cross(b - a, c - a)
        nn = np.linalg.norm(n)
        if nn < 1e-12:
            continue
        n /= nn
        if n @ up < 0:
            n = -n
        if n @ up < cos_max:
            continue
        d = n @ a
        inl = np.abs(X @ n - d) < tol
        if inl.sum() > best[2].sum():
            best = (n, d, inl)
    n, d, inl = best
    if n is None:
        return best
    # least-squares refit on the inliers, then inliers again
    for _ in range(2):
        Y = X[inl]
        mu = Y.mean(0)
        _, _, vt = np.linalg.svd(Y - mu)
        n = vt[2] if vt[2] @ up > 0 else -vt[2]
        d = n @ mu
        inl = np.abs(X @ n - d) < tol
    return n, float(d), inl


def sweep_area(paths: list[np.ndarray], radius: float, cell: float, lo: np.ndarray, hi: np.ndarray):
    """Raster of the union of discs of `radius` along each polyline (2D). Returns (mask, origin, cell)."""
    import cv2

    origin = lo - radius - 2 * cell
    size = np.ceil((hi + radius + 2 * cell - origin) / cell).astype(int) + 1
    m = np.zeros((size[1], size[0]), np.uint8)
    r = max(1, int(round(radius / cell)))
    for p in paths:
        q = np.round((p - origin) / cell).astype(np.int32)
        if len(q) == 1:
            cv2.circle(m, tuple(int(v) for v in q[0]), r, 1, -1)
        else:
            cv2.polylines(m, [q.reshape(-1, 1, 2)], False, 1, thickness=2 * r + 1, lineType=cv2.LINE_8)
            for v in q:
                cv2.circle(m, (int(v[0]), int(v[1])), r, 1, -1)
    return m, origin


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--plot", type=Path)
    ap.add_argument("--storey", type=float, default=3.84, help="assumed floor-to-ceiling distance in metres")
    ap.add_argument("--radius-m", type=float, default=0.5, help="half-width of the walkable band around the path")
    a = ap.parse_args(argv)
    import cv2

    rng = np.random.default_rng(0)
    cams, imgs, X, rgb, err, track = read_model(a.model)
    meta = {r["name"]: r for r in json.loads(a.frames.read_text())["images"]}
    C = np.array([r["C"] for r in imgs])
    xs = np.array([r["R"][0] for r in imgs])
    ys = np.array([r["R"][1] for r in imgs])
    zs = np.array([r["R"][2] for r in imgs])

    # up from the roll-free camera x axes
    w, v = np.linalg.eigh(xs.T @ xs)
    up = v[:, 0]
    if (-ys @ up).mean() < 0:
        up = -up
    roll_resid = float(np.degrees(np.arcsin(np.clip(np.abs(xs @ up), 0, 1))).max())

    # robust scene scale for tolerances: median camera-to-point distance
    good = (err < 2.0) & (track >= 3)
    Xg = X[good]
    med_dist = float(np.median(np.linalg.norm(Xg[:, None, :] - C[None, ::max(1, len(C) // 8), :], axis=2)))
    tol = 0.012 * med_dist
    h_cam = C @ up
    hp = Xg @ up
    below = Xg[hp < h_cam.min() - 0.02 * med_dist]
    above = Xg[hp > h_cam.max() + 0.02 * med_dist]
    nf, df, inl_f = ransac_plane(below, up, tol, 12.0, 4000, rng)
    if nf is None:
        raise SystemExit("no floor plane found below the cameras")
    nc, dc, inl_c = ransac_plane(above, nf, tol, 12.0, 4000, rng)
    up = nf
    floor_pts = below[inl_f]
    cam_h = C @ up - df  # camera height above the floor (model units)
    storey = float(dc - df) if nc is not None and inl_c.sum() >= 30 else None
    ceiling_tilt = float(np.degrees(np.arccos(np.clip(nc @ nf, -1, 1)))) if nc is not None else None
    scale = a.storey / storey if storey else None  # metres per model unit

    # floor frame: any horizontal basis first, then turned so the walls run along x and y
    origin = C.mean(0) - (C.mean(0) @ up - df) * up
    a0 = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = a0 - (a0 @ up) * up
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    base2 = lambda P: np.stack([(P - origin) @ e1, (P - origin) @ e2], axis=1)  # noqa: E731
    fl0 = base2(floor_pts)
    flo, fhi = np.percentile(fl0, 0.5, axis=0), np.percentile(fl0, 99.5, axis=0)
    hg = Xg @ up - df
    wall0 = base2(Xg)
    inside = np.all((wall0 > flo - 0.5) & (wall0 < fhi + 0.5), axis=1)  # drop what was seen through the windows
    wall0 = wall0[inside & (hg > 0.12 * (storey or 1)) & (hg < 0.88 * (storey or 1e9))]
    best = (-1.0, 0.0)
    for th in np.radians(np.arange(0.0, 90.0, 0.25)):
        c, s = math.cos(th), math.sin(th)
        q = wall0 @ np.array([[c, -s], [s, c]])  # coordinates along the turned axes
        score = 0.0
        for k in range(2):
            hist, _ = np.histogram(q[:, k], bins=max(10, int(np.ptp(q[:, k]) / (0.01 * med_dist))))
            p = hist / max(1, hist.sum())
            score += float((p * p).sum())
        if score > best[0]:
            best = (score, th)
    th = best[1]
    e1, e2 = math.cos(th) * e1 + math.sin(th) * e2, -math.sin(th) * e1 + math.cos(th) * e2
    to2 = lambda P: np.stack([(P - origin) @ e1, (P - origin) @ e2], axis=1)  # noqa: E731
    cam2 = to2(C)
    fwd2 = np.stack([zs @ e1, zs @ e2], axis=1)
    fl2 = to2(floor_pts)
    lo_f, hi_f = np.percentile(fl2, 0.5, axis=0), np.percentile(fl2, 99.5, axis=0)

    # coverage
    segs: dict[str, list[int]] = {}
    for k, r in enumerate(imgs):
        segs.setdefault(meta.get(r["name"], {}).get("segment", "?"), []).append(k)
    unit_m = scale if scale else None
    radius = a.radius_m / scale if scale else 0.05 * float(np.max(hi_f - lo_f))
    paths = [cam2[sorted(ix, key=lambda k: meta.get(imgs[k]["name"], {}).get("frameIndex", k))] for ix in segs.values()]
    lo = np.minimum(cam2.min(0), lo_f)
    hi = np.maximum(cam2.max(0), hi_f)
    cell = float(np.max(hi - lo)) / 600
    sweep, sorigin = sweep_area(paths, radius, cell, lo, hi)
    area = float(sweep.sum()) * cell * cell
    contours, _ = cv2.findContours(sweep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline = [[[round(float(sorigin[0] + (p[0][0] + 0.5) * cell), 4), round(float(sorigin[1] + (p[0][1] + 0.5) * cell), 4)]
                for p in cv2.approxPolyDP(c, 1.5, True)] for c in contours]
    hull = cv2.convexHull(cam2.astype(np.float32))
    hull_area = float(cv2.contourArea(hull))
    plen = float(sum(np.linalg.norm(np.diff(p, axis=0), axis=1).sum() for p in paths))
    floor_rect = float(np.prod(hi_f - lo_f))

    def m(x, p=2):
        return None if unit_m is None or x is None else round(float(x) * unit_m ** p, 3)

    cam_rows = []
    for k, r in enumerate(imgs):
        mm = meta.get(r["name"], {})
        cam_rows.append({"name": r["name"], "frame": mm.get("frameIndex"), "time": mm.get("time"), "segment": mm.get("segment"),
                         "xy": [round(float(cam2[k, 0]), 4), round(float(cam2[k, 1]), 4)], "height": round(float(cam_h[k]), 4),
                         "heightM": m(cam_h[k], 1), "yawDeg": round(float(np.degrees(np.arctan2(fwd2[k, 1], fwd2[k, 0]))), 1),
                         "pitchDeg": round(float(np.degrees(np.arcsin(np.clip(zs[k] @ up, -1, 1)))), 1), "observations": r["nObs"]})
    doc = {
        "model": str(a.model),
        "units": "COLMAP model units unless a key ends in M (metres, from the scale estimate)",
        "registered": len(imgs),
        "points": int(len(X)),
        "up": {"colmap": [round(float(v), 6) for v in up], "fromCameraXAxesMaxRollDeg": round(roll_resid, 2)},
        "floor": {"plane": {"normal": [round(float(v), 6) for v in nf], "d": round(df, 6), "form": "normal . X = d (COLMAP frame)"},
                  "inliers": int(inl_f.sum()), "candidates": int(len(below)), "toleranceUnits": round(tol, 5),
                  "extentXY": [[round(float(v), 4) for v in lo_f], [round(float(v), 4) for v in hi_f]],
                  "extentM": [m(hi_f[0] - lo_f[0], 1), m(hi_f[1] - lo_f[1], 1)], "extentAreaM2": m(floor_rect)},
        "ceiling": None if nc is None else {"normal": [round(float(v), 6) for v in nc], "d": round(dc, 6), "inliers": int(inl_c.sum()),
                                             "tiltFromFloorDeg": round(ceiling_tilt, 2), "floorToCeiling": round(storey, 5) if storey else None},
        "scale": {"metresPerUnit": None if scale is None else round(scale, 6),
                  "assumption": f"floor-to-ceiling = {a.storey} m (one storey of a game building); an estimate, not measured"},
        "floorFrame": {"origin": [round(float(v), 6) for v in origin], "x": [round(float(v), 6) for v in e1],
                       "y": [round(float(v), 6) for v in e2], "z": [round(float(v), 6) for v in up],
                       "note": "2D coordinates below are (X - origin) . x, (X - origin) . y"},
        "cameraHeight": {"min": round(float(cam_h.min()), 4), "median": round(float(np.median(cam_h)), 4), "max": round(float(cam_h.max()), 4),
                         "minM": m(cam_h.min(), 1), "medianM": m(np.median(cam_h), 1), "maxM": m(cam_h.max(), 1)},
        "coverage": {"radius": round(radius, 4), "radiusM": a.radius_m if scale else None, "area": round(area, 5), "areaM2": m(area),
                     "convexHullOfCameras": round(hull_area, 5), "convexHullM2": m(hull_area),
                     "pathLength": round(plen, 4), "pathLengthM": m(plen, 1),
                     "fractionOfFloorExtent": round(area / floor_rect, 3) if floor_rect > 0 else None,
                     "outline": outline, "segments": {k: len(v) for k, v in segs.items()}},
        "cameras": cam_rows,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1))
    print(json.dumps({k: doc[k] for k in ("registered", "points", "up", "scale", "cameraHeight")}, indent=1))
    print(json.dumps({k: v for k, v in doc["coverage"].items() if k != "outline"}, indent=1))
    print("floor", json.dumps({k: v for k, v in doc["floor"].items() if k != "plane"}), "ceiling", doc["ceiling"])

    if a.plot:
        plot(a.plot, cam2, fwd2, cam_rows, fl2, to2(Xg), Xg @ up - df, rgb[good], sweep, sorigin, cell, scale, storey, paths, segs, imgs, meta,
             lo_f=lo_f, hi_f=hi_f)
    return 0


def plot(path: Path, cam2, fwd2, rows, fl2, all2, allh, allrgb, sweep, sorigin, cell, scale, storey, paths, segs, imgs, meta,
         lo_f=None, hi_f=None):
    """Top-down view in the floor frame: floor points, wall/furniture points, the walkable band, the camera path."""
    from PIL import Image, ImageDraw

    S, pad, top, bottom = 1000, 50, 64, 46
    lo_v = np.minimum(cam2.min(0), lo_f) - 0.6
    hi_v = np.maximum(cam2.max(0), hi_f) + 0.6
    k = (S - 2 * pad) / float(np.max(hi_v - lo_v))
    W = int((hi_v[0] - lo_v[0]) * k + 2 * pad)
    Hh = int((hi_v[1] - lo_v[1]) * k + 2 * pad)
    H = Hh + top + bottom
    P = lambda q: (float((q[0] - lo_v[0]) * k + pad), float(top + (hi_v[1] - q[1]) * k + pad))  # noqa: E731

    # density layers rendered on a pixel grid
    def density(pts):
        u = ((pts[:, 0] - lo_v[0]) * k + pad).astype(int)
        v = (top + (hi_v[1] - pts[:, 1]) * k + pad).astype(int)
        ok = (u >= 0) & (u < W) & (v >= 0) & (v < H)
        d = np.zeros((H, W), np.float32)
        np.add.at(d, (v[ok], u[ok]), 1.0)
        return d

    import cv2

    base = np.full((H, W, 3), (247, 246, 242), np.float32)
    # walkable band from the sweep raster
    gy, gx = np.mgrid[0:H, 0:W].astype(np.float32)
    wx = (gx - pad) / k + lo_v[0]
    wy = hi_v[1] - (gy - top - pad) / k
    ix = np.floor((wx - sorigin[0]) / cell).astype(int)
    iy = np.floor((wy - sorigin[1]) / cell).astype(int)
    ok = (ix >= 0) & (ix < sweep.shape[1]) & (iy >= 0) & (iy < sweep.shape[0])
    band = np.zeros((H, W), bool)
    band[ok] = sweep[iy[ok], ix[ok]] > 0
    base[band] = base[band] * 0.55 + np.array([255, 205, 90], np.float32) * 0.45
    edge = cv2.morphologyEx(band.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    base[edge] = (214, 160, 40)
    # floor points (blue) and points between floor and ceiling (walls, furniture: dark)
    hmax = storey if storey else float(np.percentile(allh, 99))
    mid = (allh > 0.04 * hmax) & (allh < 0.96 * hmax)
    for pts, col, gain in ((fl2, np.array([60, 110, 200], np.float32), 1.2), (all2[mid], np.array([40, 40, 46], np.float32), 0.6)):
        d = cv2.GaussianBlur(density(pts), (0, 0), 0.8)
        a = np.clip(d * gain, 0, 0.85)[..., None]
        base = base * (1 - a) + col * a
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    dr = ImageDraw.Draw(im, "RGBA")
    colours = {"A": (205, 55, 35), "B": (25, 135, 70)}
    for name, ix_ in segs.items():
        col = colours.get(name, (90, 60, 160))
        order = sorted(ix_, key=lambda j: meta.get(imgs[j]["name"], {}).get("frameIndex", j))
        line = [P(cam2[j]) for j in order]
        if len(line) > 1:
            dr.line(line, fill=col + (255,), width=3)
        for n, j in enumerate(order):
            x, y = P(cam2[j])
            f = fwd2[j] / (np.linalg.norm(fwd2[j]) + 1e-9)
            dr.line((x, y, x + f[0] * 22, y - f[1] * 22), fill=col + (200,), width=2)
            dr.ellipse((x - 4, y - 4, x + 4, y + 4), fill=col + (255,), outline=(255, 255, 255, 255))
            if n == 0 or n == len(order) - 1:
                t = meta.get(imgs[j]["name"], {}).get("time")
                label = f"{name} {'start' if n == 0 else 'end'} {t:.1f}s" if t is not None else name
                dr.text((x + 7, y + 5), label, fill=col + (255,))
    ink = (25, 25, 25)
    dr.text((pad, 10), "Brick House apartment - camera path from above (COLMAP sparse model, floor frame, walls along x/y)", fill=ink)
    dr.text((pad, 28), "red: segment A 65.8-70.5 s   green: segment B 84.4-86.5 s   ticks: view direction   "
                       "yellow: band 0.5 m around the path", fill=(70, 70, 70))
    dr.text((pad, 44), "blue: floor points (dense on the carpet, sparse on the checkered tiles)   dark: walls and furniture",
            fill=(70, 70, 70))
    if scale:
        L = 1.0 / scale * k
        y0 = H - 26
        dr.line((pad, y0, pad + L, y0), fill=ink, width=3)
        dr.line((pad, y0 - 5, pad, y0 + 5), fill=ink, width=2)
        dr.line((pad + L, y0 - 5, pad + L, y0 + 5), fill=ink, width=2)
        dr.text((pad + L + 10, y0 - 6), "1 m  (scale is an estimate: floor-to-ceiling taken as one 3.84 m storey)", fill=ink)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, optimize=True)
    print("plot", path, im.size)


if __name__ == "__main__":
    sys.exit(main())
