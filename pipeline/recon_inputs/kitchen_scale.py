#!/usr/bin/env python3
"""Metric scale for the kitchen from objects of known size, measured in the solved COLMAP model.

  python pipeline/recon_inputs/kitchen_scale.py crops --work WORK --images photo/IMG_7388.jpg ... --out DIR
  python pipeline/recon_inputs/kitchen_scale.py measure --work WORK --picks picks.json --out WORK/scale.json

`crops` writes the named images with a labelled 50 px grid (prep resolution), so corners can be read off by eye.

`measure` reads picks.json:
  {"points": {"<label>": {"<image name>": [u, v], ...}, ...},          pixel positions at prep resolution
   "lengths": [{"name": ..., "a": "<label>", "b": "<label>", "metres": 0.762, "what": "..."}, ...],
   "heights": [{"name": ..., "a": "<label>", "metres": 0.914, "what": "..."}, ...]}
and triangulates every labelled point from its views with the solved cameras (rays through the undistorted
pixels, least-squares closest point; the per-view pixel residual is reported), in the room frame of WORK/frame.json.
Each known length or height gives a scale correction (known / measured); heights are measured above the floor
plane (y = 0 of the room frame), so they also test the floor fit. The ceiling grid (drop ceiling, 2 ft = 0.6096 m
tiles) is measured independently: sparse points within 4 cm of the ceiling plane, in wall axes, autocorrelation of
their 1 cm histograms; its strongest period between 0.35 and 1.6 m gives one more correction.
The camera height under the corrected scale is reported as a sanity check (a handheld phone: about 1.2-1.6 m).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitchen_room import load, qvec_to_rotmat, to_wall_axes, wall_yaw  # noqa: E402

TILE = 0.6096


def undistort(model: str, params: list[float], u: float, v: float) -> np.ndarray:
    p = params
    if model in ("SIMPLE_RADIAL", "RADIAL", "SIMPLE_PINHOLE"):
        fx = fy = p[0]
        cx, cy = p[1], p[2]
        k1 = p[3] if len(p) > 3 else 0.0
        k2 = p[4] if model == "RADIAL" else 0.0
        p1 = p2 = 0.0
    else:
        fx, fy, cx, cy = p[:4]
        k1, k2, p1, p2 = (p[4:8] + [0, 0, 0, 0])[:4] if len(p) > 4 else (0, 0, 0, 0)
    xd, yd = (u - cx) / fx, (v - cy) / fy
    x, y = xd, yd
    for _ in range(50):
        r2 = x * x + y * y
        rad = 1 + k1 * r2 + k2 * r2 * r2
        dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        x, y = (xd - dx) / rad, (yd - dy) / rad
    return np.array([x, y, 1.0])


def triangulate(rays: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    A = np.zeros((3, 3))
    b = np.zeros(3)
    for C, d in rays:
        d = d / np.linalg.norm(d)
        M = np.eye(3) - np.outer(d, d)
        A += M
        b += M @ C
    return np.linalg.solve(A, b)


def ceiling_grid(room, yaw: float) -> dict:
    P = room.P[(room.track >= 3) & (room.err < 2.0)]
    up = P[P[:, 1] > np.percentile(room.C[:, 1], 90) + 0.4]
    if len(up) < 100:
        return {"found": False, "reason": "too few points above the cameras"}
    h, e = np.histogram(up[:, 1], bins=np.arange(up[:, 1].min(), up[:, 1].max() + 0.01, 0.01))
    k = int(np.argmax(np.convolve(h, [1, 2, 1], mode="same")))
    y_c = 0.5 * (e[k] + e[k + 1])
    sheet = up[np.abs(up[:, 1] - y_c) < 0.04]
    uv = to_wall_axes(sheet[:, [0, 2]], yaw)
    out = {"found": True, "ceilingHeight": round(float(np.median(sheet[:, 1])), 4), "points": int(len(sheet)), "axes": {}}
    for ax_i, ax_name in ((0, "u"), (1, "v")):
        x = uv[:, ax_i]
        hist, _ = np.histogram(x, bins=np.arange(x.min(), x.max() + 0.01, 0.01))
        hist = hist - hist.mean()
        ac = np.correlate(hist, hist, mode="full")[len(hist) - 1:]
        ac = ac / max(ac[0], 1e-9)
        lags = np.arange(len(ac)) * 0.01
        sel = (lags >= 0.35) & (lags <= 1.6)
        if not sel.any():
            continue
        cand = np.nonzero(sel)[0]
        peaks = [i for i in cand if ac[i] >= ac[i - 1] and ac[i] >= ac[min(i + 1, len(ac) - 1)]]
        peaks.sort(key=lambda i: -ac[i])
        top = []
        for i in peaks[:4]:
            # parabolic refinement of the peak lag
            a_, b_, c_ = ac[i - 1], ac[i], ac[i + 1]
            den = a_ - 2 * b_ + c_
            off = 0.5 * (a_ - c_) / den if abs(den) > 1e-12 else 0.0
            top.append({"period": round(float((i + off) * 0.01), 4), "strength": round(float(ac[i]), 3)})
        out["axes"][ax_name] = top
    return out


def vertical_plane(P: np.ndarray, centre: np.ndarray, radius: float, thr: float = 0.015, iters: int = 4000,
                   hint: np.ndarray | None = None, max_angle: float = 35.0):
    """RANSAC vertical plane (normal horizontal) through the sparse points within `radius` (horizontally) of centre;
    with `hint`, only planes whose normal is within max_angle of it (the wall the camera faces, not the next one)."""
    rng = np.random.default_rng(0)
    Q = P[(np.hypot(P[:, 0] - centre[0], P[:, 2] - centre[2]) < radius) & (P[:, 1] > 0.2) & (P[:, 1] < 2.6)]
    cos_max = math.cos(math.radians(max_angle))
    best = (-1, None, 0.0)
    for _ in range(iters):
        a_, b_ = Q[rng.integers(0, len(Q), 2)]
        h = b_ - a_
        h[1] = 0.0
        if np.linalg.norm(h) < 1e-3:
            continue
        n = np.array([-h[2], 0.0, h[0]]) / np.linalg.norm(h)
        if hint is not None and abs(float(n @ hint)) < cos_max:
            continue
        d = -float(n @ a_)
        k = int(np.count_nonzero(np.abs(Q @ n + d) < thr))
        if k > best[0]:
            best = (k, n, d)
    k, n, d = best
    inl = Q[np.abs(Q @ n + d) < thr]
    if len(inl) >= 3:  # least-squares refit, kept vertical
        c = inl.mean(0)
        xz = inl[:, [0, 2]] - c[[0, 2]]
        _, _, vt = np.linalg.svd(xz)
        n = np.array([vt[1][0], 0.0, vt[1][1]])
        d = -float(n @ c)
    return n, d, k, len(Q)


def ray_room(poses: dict, by_name: dict, Rt: tuple, name: str, uv) -> tuple[np.ndarray, np.ndarray]:
    R_r, t_r, s_r = Rt
    im = by_name[name]
    cam = poses["cameras"][im["camera"]]
    Rw = qvec_to_rotmat(im["qvec"])
    C = -Rw.T @ np.asarray(im["tvec"])
    d = Rw.T @ undistort(cam["model"], cam["params"], *uv)
    return s_r * (R_r @ C) + t_r, R_r @ d


def cmd_crops(a) -> int:
    import cv2

    a.out.mkdir(parents=True, exist_ok=True)
    for name in a.images:
        img = cv2.imread(str(a.work / "images" / name))
        if img is None:
            print(f"missing {name}")
            continue
        H, W = img.shape[:2]
        if a.region:
            x0, y0, x1, y1 = a.region
        else:
            x0, y0, x1, y1 = 0, 0, W, H
        crop = img[y0:y1, x0:x1]
        s = a.width / crop.shape[1]
        crop = cv2.resize(crop, (a.width, int(round(crop.shape[0] * s))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        st = a.step
        # grid drawn after the zoom (thin lines at exact pixel positions: pixel centre u -> (u - x0 + 0.5) * s)
        for x in range((x0 // st) * st, x1 + 1, st):
            if x < x0:
                continue
            X = int(round((x - x0) * s))
            cv2.line(crop, (X, 0), (X, crop.shape[0]), (0, 255, 255) if x % (5 * st) == 0 else (0, 200, 0), 1)
        for y in range((y0 // st) * st, y1 + 1, st):
            if y < y0:
                continue
            Y = int(round((y - y0) * s))
            cv2.line(crop, (0, Y), (crop.shape[1], Y), (0, 255, 255) if y % (5 * st) == 0 else (0, 200, 0), 1)
        for x in range((x0 // (2 * st)) * 2 * st, x1, 2 * st):
            for y in range((y0 // (2 * st)) * 2 * st, y1, 2 * st):
                if x >= x0 and y >= y0:
                    cv2.putText(crop, f"{x},{y}", (int((x - x0) * s) + 2, int((y - y0) * s) + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 255), 1)
        tag = f"-{x0}-{y0}" if a.region else ""
        cv2.imwrite(str(a.out / (name.replace("/", "_").replace(".jpg", "") + tag + ".jpg")), crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return 0


def cmd_montage(a) -> int:
    """Zoomed tiles around approximate corner positions (spec lines 'image u v label'), with a fine labelled grid,
    so each corner can be read to about half a pixel."""
    import cv2

    tiles = []
    half, z = a.half, a.zoom
    for line in a.spec.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        name, u, v, label = line.split()[:4]
        img = cv2.imread(str(a.work / "images" / name))
        u0, v0 = int(round(float(u))) - half, int(round(float(v))) - half
        crop = np.zeros((2 * half, 2 * half, 3), np.uint8)
        H, W = img.shape[:2]
        x0, y0, x1, y1 = max(0, u0), max(0, v0), min(W, u0 + 2 * half), min(H, v0 + 2 * half)
        crop[y0 - v0:y1 - v0, x0 - u0:x1 - u0] = img[y0:y1, x0:x1]
        big = cv2.resize(crop, (2 * half * z, 2 * half * z), interpolation=cv2.INTER_CUBIC)
        for k in range(0, 2 * half + 1, 5):
            col = (0, 255, 255) if (u0 + k) % 10 == 0 else (0, 160, 0)
            cv2.line(big, (k * z, 0), (k * z, 2 * half * z), col, 1)
            col = (0, 255, 255) if (v0 + k) % 10 == 0 else (0, 160, 0)
            cv2.line(big, (0, k * z), (2 * half * z, k * z), col, 1)
        for k in range(0, 2 * half, 10):
            uu = u0 + k + (-u0) % 10
            if uu - u0 < 2 * half:
                cv2.putText(big, str(uu), ((uu - u0) * z + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 255), 1)
            vv = v0 + k + (-v0) % 10
            if vv - v0 < 2 * half:
                cv2.putText(big, str(vv), (2, (vv - v0) * z - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 255), 1)
        if a.mark:  # the picked position itself
            mu, mv = (float(u) - u0 + 0.5) * z, (float(v) - v0 + 0.5) * z
            cv2.drawMarker(big, (int(round(mu)), int(round(mv))), (255, 0, 255), cv2.MARKER_CROSS, 18, 2)
        cv2.rectangle(big, (0, big.shape[0] - 20), (big.shape[1], big.shape[0]), (0, 0, 0), -1)
        cv2.putText(big, f"{label} {name.split('/')[-1]}", (4, big.shape[0] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
        tiles.append(cv2.copyMakeBorder(big, 2, 2, 2, 2, cv2.BORDER_CONSTANT, value=(255, 255, 255)))
    cols = a.cols
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    sheet = np.concatenate([np.concatenate(tiles[k:k + cols], axis=1) for k in range(0, len(tiles), cols)], axis=0)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(f"wrote {a.out} ({len(tiles)} tiles)")
    return 0


def cmd_measure(a) -> int:
    room = load(a.work)
    poses = json.loads((a.work / "poses.json").read_text())
    by_name = {im["name"]: im for im in poses["images"] if im.get("registered")}
    Rt = room.frame["colmapToRoom"]
    R_r, t_r, s_r = np.asarray(Rt["R"]), np.asarray(Rt["t"]), float(Rt["scale"])
    picks = json.loads(a.picks.read_text())
    pts, report = {}, {"points": {}, "lengths": [], "heights": []}
    for label, views in picks["points"].items():
        rays, used = [], []
        for name, (u, v) in views.items():
            im = by_name.get(name)
            if im is None:
                continue
            cam = poses["cameras"][im["camera"]]
            Rw = qvec_to_rotmat(im["qvec"])
            C = -Rw.T @ np.asarray(im["tvec"])
            d = Rw.T @ undistort(cam["model"], cam["params"], u, v)
            rays.append((C, d))
            used.append((name, im, cam, u, v))
        if len(rays) < 2:
            report["points"][label] = {"views": len(rays), "error": "needs two registered views"}
            continue
        X = triangulate(rays)
        res = []
        for name, im, cam, u, v in used:
            Rw = qvec_to_rotmat(im["qvec"])
            Xc = Rw @ X + np.asarray(im["tvec"])
            xn = undistort(cam["model"], cam["params"], u, v)
            f = cam["params"][0]
            res.append(float(np.hypot(Xc[0] / Xc[2] - xn[0], Xc[1] / Xc[2] - xn[1]) * f))
        Xr = s_r * (R_r @ X) + t_r
        pts[label] = Xr
        report["points"][label] = {"room": [round(float(v), 4) for v in Xr], "views": len(rays),
                                   "residualPx": [round(r, 2) for r in res], "maxResidualPx": round(max(res), 2)}
    factors = []
    for L in picks.get("lengths", []):
        if L["a"] in pts and L["b"] in pts:
            m = float(np.linalg.norm(pts[L["a"]] - pts[L["b"]]))
            f = L["metres"] / m
            report["lengths"].append({**L, "measured": round(m, 4), "factor": round(f, 4)})
            factors.append((L["name"], f, L.get("weight", 1.0)))
    for Hh in picks.get("heights", []):
        if Hh["a"] in pts:
            m = float(pts[Hh["a"]][1])
            f = Hh["metres"] / m
            report["heights"].append({**Hh, "measured": round(m, 4), "factor": round(f, 4)})
            factors.append((Hh["name"], f, Hh.get("weight", 1.0)))
    # cues on a wall plane: each view's ray meets the plane fitted to the sparse points around an anchor point
    good_pts = room.P[(room.track >= 3) & (room.err < 2.0)]
    report["planes"] = []
    for pl in picks.get("planes", []):
        centre = pts[pl["anchor"]] if pl.get("anchor") in pts else np.asarray(pl["near"], float)
        hint, max_angle = None, 35.0
        if "wallAxis" in pl:  # the room's walls run along two axes (wall_yaw); the plane's normal is one of them
            yw = wall_yaw(good_pts)
            hint = np.array([math.cos(yw), 0.0, math.sin(yw)]) if pl["wallAxis"] == 0 else np.array([-math.sin(yw), 0.0, math.cos(yw)])
            max_angle = 10.0
        n, d, k, m = vertical_plane(good_pts, centre, pl.get("radius", 1.2), hint=hint, max_angle=max_angle)
        off = pl.get("offset", 0.0)
        rec = {"name": pl["name"], "normal": [round(float(v), 4) for v in n], "support": [k, m], "offset": off, "views": {}}
        per_cue: dict[str, list[float]] = {}
        for view, labels in pl["views"].items():
            if view not in by_name:
                continue
            X = {}
            for label, uv in labels.items():
                C, dr = ray_room(poses, by_name, (R_r, t_r, s_r), view, uv)
                nn, dd = (n, d) if (n @ C + d) > 0 else (-n, -d)  # normal towards the camera
                lam = -(nn @ C + dd - off) / (nn @ dr)
                X[label] = C + lam * dr
            vrec = {}
            for L in pl.get("lengths", []):
                if L["a"] in X and L["b"] in X:
                    meas = float(np.linalg.norm(X[L["a"]] - X[L["b"]]))
                    vrec[L["name"]] = round(meas, 4)
                    per_cue.setdefault(L["name"], []).append(L["metres"] / meas)
            for Hh in pl.get("heights", []):
                if Hh["a"] in X:
                    meas = float(X[Hh["a"]][1])
                    vrec[Hh["name"]] = round(meas, 4)
                    per_cue.setdefault(Hh["name"], []).append(Hh["metres"] / meas)
            rec["views"][view] = vrec
        for cue in pl.get("lengths", []) + pl.get("heights", []):
            fs = per_cue.get(cue["name"])
            if fs:
                f = float(np.exp(np.mean(np.log(fs))))
                rec.setdefault("cues", []).append({**cue, "factor": round(f, 4), "perView": [round(x, 4) for x in fs]})
                factors.append((cue["name"], f, cue.get("weight", 1.0)))
        report["planes"].append(rec)
    yaw = wall_yaw(good_pts)
    grid = ceiling_grid(room, yaw)
    report["ceilingGrid"] = grid
    report["wallYawDeg"] = round(math.degrees(yaw), 2)
    if a.grid_auto and grid.get("found"):
        # the 2 ft module: the strongest autocorrelation peak within the window, over both wall axes
        lo, hi = a.grid_window
        cands = [pk for ax in grid["axes"].values() for pk in ax if lo <= pk["period"] <= hi]
        if cands:
            best = max(cands, key=lambda pk: pk["strength"])
            same = [pk["period"] for pk in cands if abs(pk["period"] - best["period"]) < 0.03]
            a.grid_period = float(np.mean(same))
            report["ceilingGrid"]["autoPick"] = {"period": round(a.grid_period, 4), "from": same, "window": [lo, hi]}
    if a.grid_period:
        f = TILE / a.grid_period
        report["ceilingGrid"]["usedPeriod"] = a.grid_period
        report["ceilingGrid"]["factor"] = round(f, 4)
        factors.append(("ceiling tile 2 ft", f, a.grid_weight))
    report["checks"] = [{"cue": n_, "factor": round(f_, 4)} for n_, f_, w_ in factors if w_ <= 0]
    factors = [x for x in factors if x[2] > 0]
    if factors:
        w = np.array([x[2] for x in factors])
        fv = np.array([x[1] for x in factors])
        fac = float(np.exp((w * np.log(fv)).sum() / w.sum()))
        report["factors"] = [{"cue": n, "factor": round(f, 4), "weight": wt} for n, f, wt in factors]
        report["factor"] = round(fac, 4)
        report["spreadPct"] = round(100.0 * float((fv.max() - fv.min()) / fac), 2)
        eye_h = float(np.median(room.C[:, 1]))
        report["eyeBefore"] = round(eye_h, 4)
        report["eyeAfter"] = round(eye_h * fac, 4)
        report["frameEye"] = room.frame["scale"]["eyeHeight"] * fac
        report["summary"] = (f"x{fac:.3f} from {len(factors)} cues (spread {report['spreadPct']:.1f}%), "
                             f"camera height {eye_h * fac:.2f} m")
    a.out.write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crops")
    c.add_argument("--work", required=True, type=Path)
    c.add_argument("--images", nargs="+", required=True)
    c.add_argument("--out", required=True, type=Path)
    c.add_argument("--region", nargs=4, type=int, default=None)
    c.add_argument("--width", type=int, default=1600)
    c.add_argument("--step", type=int, default=50, help="grid spacing (prep pixels)")
    t = sub.add_parser("montage")
    t.add_argument("--work", required=True, type=Path)
    t.add_argument("--spec", required=True, type=Path)
    t.add_argument("--out", required=True, type=Path)
    t.add_argument("--half", type=int, default=30)
    t.add_argument("--zoom", type=int, default=6)
    t.add_argument("--cols", type=int, default=4)
    t.add_argument("--mark", action="store_true", help="draw a cross at the listed position")
    m = sub.add_parser("measure")
    m.add_argument("--work", required=True, type=Path)
    m.add_argument("--picks", required=True, type=Path)
    m.add_argument("--out", required=True, type=Path)
    m.add_argument("--grid-period", type=float, default=None, help="ceiling tile period (room units) to use as a cue")
    m.add_argument("--grid-weight", type=float, default=1.0)
    m.add_argument("--grid-auto", action="store_true", help="use the strongest ceiling-grid period inside --grid-window")
    m.add_argument("--grid-window", nargs=2, type=float, default=[0.45, 0.8])
    a = ap.parse_args(argv)
    return {"crops": cmd_crops, "montage": cmd_montage, "measure": cmd_measure}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
