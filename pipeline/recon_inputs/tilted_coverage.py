#!/usr/bin/env python3
"""A COLMAP sparse model of a fly-through -> ground plane, the ground area the cameras moved through, a top-down plot.

  python tilted_coverage.py MODEL_DIR --frames frames.json --out coverage.json --plot topdown.png [--radius-k 1.5]

World up: the camera right vectors of a level game camera are horizontal, so up is the direction most orthogonal
to all of them (smallest eigenvector of their scatter), signed to agree with the cameras' up vectors.
Ground: the strongest horizontal layer of sparse points below the cameras (histogram along up, lowest dominant
peak), refined by a RANSAC plane through the points near that layer with the normal kept within 12 degrees of up.
Coverage: camera centres projected on that plane; each time-ordered run of cameras (one per video range) is drawn
as a path buffered by a radius tied to the street-level camera height, and the union is traced into polygons.
Two variants: every camera, and only cameras near street level (rooftop orbits project onto building footprints,
which are not walkable from the street).

Everything is in COLMAP units (the model has no metric scale). Reads the binary model (cameras/images/points3D.bin).
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

CAM_NPARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}
CAM_NAMES = {0: "SIMPLE_PINHOLE", 1: "PINHOLE", 2: "SIMPLE_RADIAL", 3: "RADIAL", 4: "OPENCV"}


def read_cameras(p: Path) -> dict:
    out = {}
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            cid, model, w, h = struct.unpack("<iiQQ", f.read(24))
            k = CAM_NPARAMS[model]
            params = struct.unpack(f"<{k}d", f.read(8 * k))
            out[cid] = {"model": CAM_NAMES.get(model, str(model)), "width": w, "height": h, "params": list(params)}
    return out


def qvec2rot(q):
    w, x, y, z = q
    return np.array([[1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
                     [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
                     [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y]])


def read_images(p: Path) -> dict:
    out = {}
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            iid = struct.unpack("<I", f.read(4))[0]
            q = struct.unpack("<4d", f.read(32))
            t = struct.unpack("<3d", f.read(24))
            cid = struct.unpack("<I", f.read(4))[0]
            name = b""
            while (c := f.read(1)) != b"\x00":
                name += c
            npts = struct.unpack("<Q", f.read(8))[0]
            buf = f.read(24 * npts)
            ids = np.frombuffer(buf, dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("id", "<i8")]))["id"]
            R = qvec2rot(q)
            out[iid] = {"name": name.decode(), "R": R, "t": np.array(t), "camera": cid,
                        "center": -R.T @ np.array(t), "n2d": int(npts), "n3d": int((ids >= 0).sum())}
    return out


def read_points(p: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    xyz, rgb, err, tl = [], [], [], []
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            _pid, x, y, z, r, g, b, e, L = struct.unpack("<Q3d3BdQ", f.read(51))
            f.seek(8 * L, 1)
            xyz.append((x, y, z))
            rgb.append((r, g, b))
            err.append(e)
            tl.append(L)
    return np.array(xyz), np.array(rgb, np.uint8), np.array(err), np.array(tl)


def fit_up(images: dict) -> np.ndarray:
    rights = np.array([im["R"][0] for im in images.values()])  # camera x axis in world = first row of R
    ups = np.array([-im["R"][1] for im in images.values()])  # camera -y axis in world
    w, v = np.linalg.eigh(rights.T @ rights)
    n = v[:, 0]
    if np.mean(ups @ n) < 0:
        n = -n
    return n / np.linalg.norm(n)


def fit_ground(xyz: np.ndarray, n: np.ndarray, cam_h: np.ndarray, rng: np.random.Generator) -> dict:
    h = xyz @ n
    lo, hi = np.percentile(h, [0.5, 99.5])
    keep = (h >= lo) & (h <= hi)
    hk = h[keep]
    bins = np.linspace(lo, hi, 201)
    cnt, _ = np.histogram(hk, bins)
    sm = np.convolve(cnt, np.ones(5) / 5, mode="same")
    centres = 0.5 * (bins[1:] + bins[:-1])
    below = centres < np.median(cam_h)
    # lowest dominant peak below the cameras: the first local max reaching 50% of the biggest one there
    cand = np.nonzero(below)[0]
    peak_val = sm[cand].max()
    pk = next(i for i in cand if sm[i] >= 0.5 * peak_val and sm[i] == sm[max(0, i - 3): i + 4].max())
    h0 = centres[pk]
    band = 4 * (bins[1] - bins[0])
    sel = np.nonzero(np.abs(h - h0) < band)[0]
    P = xyz[sel]
    best, best_in = None, -1
    thr = 0.5 * band
    for _ in range(2000):
        a, b, c = P[rng.choice(len(P), 3, replace=False)]
        nn = np.cross(b - a, c - a)
        if np.linalg.norm(nn) < 1e-12:
            continue
        nn /= np.linalg.norm(nn)
        if nn @ n < 0:
            nn = -nn
        if nn @ n < np.cos(np.radians(12)):
            continue
        d = -nn @ a
        inl = np.abs(P @ nn + d) < thr
        if inl.sum() > best_in:
            best_in, best = int(inl.sum()), (nn, d, inl)
    nn, d, inl = best
    Q = P[inl]
    c = Q.mean(0)
    _, _, vt = np.linalg.svd(Q - c, full_matrices=False)
    nf = vt[2] if vt[2] @ n > 0 else -vt[2]
    df = -nf @ c
    res = Q @ nf + df
    return {"normal": nf, "d": float(df), "inliers": int(inl.sum()), "band_points": int(len(P)), "peak_height": float(h0),
            "residual_rms": float(np.sqrt(np.mean(res ** 2))), "tilt_from_camera_up_deg": float(np.degrees(np.arccos(np.clip(nf @ n, -1, 1))))}


def plane_basis(nf: np.ndarray, d: float, hint: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    o = -d * nf  # the point of the plane closest to the origin
    e1 = hint - (hint @ nf) * nf
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(nf, e1)
    return o, e1, e2


def trace_polygons(paths: list[np.ndarray], radius: float, res: float, lo: np.ndarray, size: tuple[int, int],
                   simplify: float) -> tuple[list[np.ndarray], float]:
    import cv2

    W, H = size
    img = np.zeros((H, W), np.uint8)
    rpx = max(1, int(round(radius / res)))
    for p in paths:
        pix = np.round((p - lo) / res).astype(np.int32)
        if len(pix) == 1:
            cv2.circle(img, tuple(pix[0]), rpx, 255, -1)
        else:
            cv2.polylines(img, [pix.reshape(-1, 1, 2)], False, 255, thickness=2 * rpx + 1, lineType=cv2.LINE_8)
            for q in pix:
                cv2.circle(img, tuple(q), rpx, 255, -1)
    cnts, hier = cv2.findContours(img, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    if hier is not None:
        hier = hier[0]
        outer = [i for i in range(len(cnts)) if hier[i][3] < 0]
        for i in sorted(outer, key=lambda i: cv2.contourArea(cnts[i]), reverse=True):
            c = cv2.approxPolyDP(cnts[i], simplify / res, True).reshape(-1, 2).astype(np.float64)
            holes = []
            for j in range(len(cnts)):
                if hier[j][3] == i and cv2.contourArea(cnts[j]) * res * res > (2 * radius) ** 2:
                    h = cv2.approxPolyDP(cnts[j], simplify / res, True).reshape(-1, 2).astype(np.float64)
                    holes.append(h * res + lo)
            polys.append((c * res + lo, holes))
    area = float((img > 0).sum()) * res * res
    return polys, area, img


def poly_area(p: np.ndarray) -> float:
    x, y = p[:, 0], p[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def main(argv=None) -> int:
    import cv2

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--plot", type=Path, required=True)
    ap.add_argument("--radius-k", type=float, default=1.5, help="buffer radius = k x street-level camera height")
    ap.add_argument("--street-k", type=float, default=2.5, help="street level = height below k x street camera height")
    ap.add_argument("--exclude", type=Path, help="image names (one per line) whose poses are not trusted: left out")
    ap.add_argument("--mask-out", type=Path, help="PNG raster of the walkable area (see walkable.mask in the JSON)")
    a = ap.parse_args(argv)
    rng = np.random.default_rng(0)

    cams = read_cameras(a.model / "cameras.bin")
    images = read_images(a.model / "images.bin")
    excluded = set(a.exclude.read_text().split()) if a.exclude else set()
    n_all = len(images)
    images = {k: v for k, v in images.items() if v["name"] not in excluded}
    xyz, rgb, err, tl = read_points(a.model / "points3D.bin")
    frames = json.loads(a.frames.read_text())
    meta = {r["name"]: r for r in frames["images"]}

    n_up = fit_up(images)
    names = sorted(im["name"] for im in images.values())
    by_name = {im["name"]: im for im in images.values()}
    C = np.array([by_name[nm]["center"] for nm in names])
    g = fit_ground(xyz, n_up, C @ n_up, rng)
    nf, d = g["normal"], g["d"]
    cam_h = C @ nf + d  # height of each camera above the ground plane
    # street-level camera height: the low end of the camera heights (the free camera often skims the street)
    street_h = float(np.percentile(cam_h, 20))
    radius = a.radius_k * street_h
    street = cam_h < a.street_k * street_h

    # plane axes: e1 along the main horizontal spread of the cameras
    Cp = C - np.outer(cam_h, nf)
    cc = Cp - Cp.mean(0)
    _, _, vt = np.linalg.svd(cc - np.outer(cc @ nf, nf), full_matrices=False)
    o, e1, e2 = plane_basis(nf, d, vt[0])
    uv = np.stack([(C - o) @ e1, (C - o) @ e2], 1)
    ph = xyz @ nf + d
    puv = np.stack([(xyz - o) @ e1, (xyz - o) @ e2], 1)

    segs = [meta.get(nm, {}).get("segment", "?") for nm in names]
    times = [meta.get(nm, {}).get("time") for nm in names]

    def runs(mask: np.ndarray) -> list[np.ndarray]:
        out, cur, last_seg = [], [], None
        for i, nm in enumerate(names):
            if not mask[i]:
                if cur:
                    out.append(np.array(cur))
                cur = []
                continue
            if last_seg is not None and segs[i] != last_seg and cur:
                out.append(np.array(cur))
                cur = []
            cur.append(uv[i])
            last_seg = segs[i]
        if cur:
            out.append(np.array(cur))
        return out

    allpts = np.vstack([uv, puv[(ph > -radius) & (ph < 20 * street_h)]]) if len(puv) else uv
    lo = uv.min(0) - 3 * radius
    hi = uv.max(0) + 3 * radius
    span = float(max(hi - lo))
    res = span / 2000.0
    size = (int(np.ceil((hi - lo)[0] / res)) + 1, int(np.ceil((hi - lo)[1] / res)) + 1)
    polys_all, area_all, mask_all = trace_polygons(runs(np.ones(len(names), bool)), radius, res, lo, size, 0.25 * radius)
    polys_st, area_st, _ = trace_polygons(runs(street), radius, res, lo, size, 0.25 * radius)
    if a.mask_out:
        cv2.imwrite(str(a.mask_out), mask_all)
    hull = cv2.convexHull(uv.astype(np.float32)).reshape(-1, 2).astype(np.float64)

    def lift(p2: np.ndarray) -> list:
        return [[round(float(v), 4) for v in (o + x * e1 + y * e2)] for x, y in p2]

    def r2(p):
        return [[round(float(x), 4), round(float(y), 4)] for x, y in p]

    def pack(polys):
        return [{"uv": r2(p), "colmap_xyz": lift(p), "holes_uv": [r2(h) for h in holes],
                 "area": round(poly_area(p) - sum(poly_area(h) for h in holes), 4)} for p, holes in polys]

    seg_stats = {}
    for s in sorted(set(segs)):
        m = np.array([q == s for q in segs])
        seg_stats[s] = {"registered": int(m.sum()), "height_median": round(float(np.median(cam_h[m])), 4),
                        "uv_min": np.round(uv[m].min(0), 3).tolist(), "uv_max": np.round(uv[m].max(0), 3).tolist()}
    main_poly, main_holes = polys_all[0] if polys_all else (hull, [])
    doc = {
        "walkable": {
            "polygon_uv": r2(main_poly),
            "holes_uv": [r2(h) for h in main_holes],
            "polygon_colmap_xyz": lift(main_poly),
            "holes_colmap_xyz": [lift(h) for h in main_holes],
            "area": round(poly_area(main_poly) - sum(poly_area(h) for h in main_holes), 4),
            "raster_area": round(area_all, 4),
            "other_polygons": max(0, len(polys_all) - 1),
            "mask": {"file": a.mask_out.name if a.mask_out else None, "uv_min": np.round(lo, 6).tolist(),
                     "resolution": res, "size_px": list(size),
                     "pixel": "column = (u - uv_min[0]) / resolution, row = (v - uv_min[1]) / resolution; 255 = walkable"},
            "rule": "every trusted camera centre projected on the ground plane, each continuous range's path "
                    "buffered by buffer_radius; holes are blocks the paths go around but never enter; "
                    "uv in plane_frame, xyz on the plane in COLMAP coordinates",
        },
        "units": "COLMAP units of the model (no metric scale)",
        "model": str(a.model),
        "registered_images": n_all,
        "cameras_used": len(images),
        "cameras_excluded": sorted(excluded & {im["name"] for im in read_images(a.model / "images.bin").values()}),
        "points3D": int(len(xyz)),
        "camera": cams,
        "up_from_cameras": np.round(n_up, 6).tolist(),
        "ground_plane": {"normal": np.round(nf, 6).tolist(), "d": round(d, 6),
                         "equation": "normal . X + d = 0 (X in COLMAP coordinates); height = normal . X + d",
                         "inliers": g["inliers"], "points_in_band": g["band_points"],
                         "residual_rms": round(g["residual_rms"], 5),
                         "tilt_from_camera_up_deg": round(g["tilt_from_camera_up_deg"], 3)},
        "plane_frame": {"origin": np.round(o, 6).tolist(), "e1": np.round(e1, 6).tolist(), "e2": np.round(e2, 6).tolist(),
                        "note": "uv = ((X - origin) . e1, (X - origin) . e2); X = origin + u e1 + v e2 on the plane"},
        "camera_height": {"min": round(float(cam_h.min()), 4), "p20_street": round(street_h, 4),
                          "median": round(float(np.median(cam_h)), 4), "max": round(float(cam_h.max()), 4)},
        "buffer_radius": round(radius, 4),
        "buffer_rule": f"radius = {a.radius_k} x 20th-percentile camera height above ground",
        "bbox_uv": {"min": np.round(uv.min(0), 4).tolist(), "max": np.round(uv.max(0), 4).tolist()},
        "convex_hull_uv": np.round(hull, 4).tolist(),
        "convex_hull_area": round(poly_area(hull), 4),
        "coverage_all": {"cameras": len(names), "area": round(area_all, 4), "polygons": pack(polys_all),
                         "note": "every registered camera projected to the ground, path buffered by buffer_radius"},
        "coverage_street": {"cameras": int(street.sum()), "height_max": round(a.street_k * street_h, 4),
                            "area": round(area_st, 4), "polygons": pack(polys_st),
                            "note": "only cameras near street level (rooftop and high orbits left out): the walkable candidate"},
        "segments": seg_stats,
        "cameras_uv": [{"name": nm, "segment": segs[i], "time": times[i], "uv": [round(float(uv[i, 0]), 4), round(float(uv[i, 1]), 4)],
                        "height": round(float(cam_h[i]), 4)} for i, nm in enumerate(names)],
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1))

    # ---- top-down plot ------------------------------------------------------------------------------------
    P = 1600
    pad = 70
    view_lo = np.minimum(uv.min(0), np.percentile(puv, 1, axis=0)) - radius
    view_hi = np.maximum(uv.max(0), np.percentile(puv, 99, axis=0)) + radius
    sc = (P - 2 * pad) / float(max(view_hi - view_lo))
    Wd = int((view_hi - view_lo)[0] * sc) + 2 * pad
    Hd = int((view_hi - view_lo)[1] * sc) + 2 * pad + 60

    def px(q):
        q = np.atleast_2d(q)
        return np.stack([(q[:, 0] - view_lo[0]) * sc + pad, Hd - 60 - ((q[:, 1] - view_lo[1]) * sc + pad)], 1).astype(np.int32)

    img = np.full((Hd, Wd, 3), 250, np.uint8)
    order = np.argsort(ph)
    sel = order[(ph[order] > -2 * radius) & (ph[order] < np.percentile(ph, 99))]
    if len(sel) > 150000:
        sel = sel[:: int(np.ceil(len(sel) / 150000))]
    hn = np.clip((ph[sel] - 0) / max(np.percentile(ph, 97), 1e-6), 0, 1)
    pp = px(puv[sel])
    ok = (pp[:, 0] >= 0) & (pp[:, 0] < Wd) & (pp[:, 1] >= 0) & (pp[:, 1] < Hd)
    shade = (200 - 150 * hn).astype(np.uint8)
    img[pp[ok, 1], pp[ok, 0]] = np.stack([shade[ok]] * 3, 1)
    for p, holes in polys_st:
        for q in [p] + holes:
            cv2.polylines(img, [px(q).reshape(-1, 1, 2)], True, (170, 170, 170), 1, cv2.LINE_AA)
    for p, holes in polys_all:
        for q in [p] + holes:
            cv2.polylines(img, [px(q).reshape(-1, 1, 2)], True, (20, 20, 20), 2, cv2.LINE_AA)
    palette = [(31, 119, 180), (255, 127, 14), (44, 160, 44), (214, 39, 40), (148, 103, 189), (140, 86, 75),
               (227, 119, 194), (127, 127, 127), (188, 189, 34), (23, 190, 207)]
    seg_ids = sorted(set(segs))
    for k, s in enumerate(seg_ids):
        col = palette[k % len(palette)][::-1]
        m = np.array([q == s for q in segs])
        q = px(uv[m])
        cv2.polylines(img, [q.reshape(-1, 1, 2)], False, col, 2, cv2.LINE_AA)
        for j, pt in enumerate(q):
            r = 2 if street[np.nonzero(m)[0][j]] else 4
            cv2.circle(img, tuple(int(v) for v in pt), r, col, -1 if r == 2 else 1, cv2.LINE_AA)
        cv2.putText(img, s, tuple(int(v) + 4 for v in q[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2, cv2.LINE_AA)
    txt = (f"top-down on the fitted ground plane, COLMAP units | {len(images)} cameras, {len(xyz)} points | "
           f"black: walkable (all cameras, r={radius:.3g}), grey: street-level cameras only | hollow dots: high cameras")
    cv2.putText(img, txt, (10, Hd - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (30, 30, 30), 1, cv2.LINE_AA)
    sb = 10 ** np.floor(np.log10(span / 8))
    x0, y0 = pad, Hd - 45
    cv2.line(img, (x0, y0), (x0 + int(sb * sc), y0), (0, 0, 0), 2)
    cv2.putText(img, f"{sb:g} units", (x0 + int(sb * sc) + 6, y0 + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)
    a.plot.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.plot), img)
    print(json.dumps({k: doc[k] for k in ("registered_images", "points3D", "ground_plane", "camera_height", "buffer_radius",
                                          "convex_hull_area")}, indent=1))
    print("coverage_all area", doc["coverage_all"]["area"], "polygons", len(polys_all),
          "| street area", doc["coverage_street"]["area"], "polygons", len(polys_st), "cameras", int(street.sum()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
