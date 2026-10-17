#!/usr/bin/env python3
"""Independent check of a prepared kitchen work folder (pipeline/recon steps 1-3) before training.

  python pipeline/recon_inputs/kitchen_verify.py --work WORK --out WORK/verify.json

Reads the COLMAP model named in poses.json (binary, read here, not through poses.py) and compares it with the
exported poses.json / points.npz, then checks in the room frame (frame.json): the floor (global peak and per 1 m
cell), horizontal surfaces between 0.5 and 1.4 m (counters, cooktops), the camera heights and roll, the sharpness
and exposure of every prepared video frame (recomputed from the saved images), the person masks, and the spawn.
Needs numpy and opencv only.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitchen_room import load, qvec_to_rotmat  # noqa: E402


# ---------------------------------------------------------------------------------------------------------------
# COLMAP binary model (cameras.bin, images.bin, points3D.bin)
# ---------------------------------------------------------------------------------------------------------------

CAM_NPARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}


def read_model(d: Path) -> tuple[dict, dict, dict]:
    cams, imgs, pts = {}, {}, {}
    with open(d / "cameras.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            cid, model, w, h = struct.unpack("<iiQQ", f.read(24))
            k = CAM_NPARAMS[model]
            cams[cid] = {"model": model, "w": w, "h": h, "params": struct.unpack(f"<{k}d", f.read(8 * k))}
    with open(d / "images.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            iid = struct.unpack("<i", f.read(4))[0]
            q = struct.unpack("<4d", f.read(32))
            t = struct.unpack("<3d", f.read(24))
            (cid,) = struct.unpack("<i", f.read(4))
            name = b""
            while (c := f.read(1)) != b"\0":
                name += c
            (np2,) = struct.unpack("<Q", f.read(8))
            raw = np.frombuffer(f.read(24 * np2), dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("p", "<i8")]))
            imgs[iid] = {"q": q, "t": t, "cam": cid, "name": name.decode(), "nobs": int((raw["p"] != -1).sum()),
                         "n2d": int(np2)}
    with open(d / "points3D.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        xyz = np.zeros((n, 3))
        err = np.zeros(n)
        tl = np.zeros(n, np.int64)
        for i in range(n):
            pid, x, y, z, r, g, b, e = struct.unpack("<Q3d3Bd", f.read(43))
            (L,) = struct.unpack("<Q", f.read(8))
            f.seek(8 * L, 1)
            xyz[i] = (x, y, z)
            err[i] = e
            tl[i] = L
        pts = {"xyz": xyz, "err": err, "track": tl}
    return cams, imgs, pts


def check_model(work: Path, poses: dict) -> dict:
    mdir = Path(poses["stats"]["model"])
    cams, imgs, pts = read_model(mdir)
    by_name = {im["name"]: im for im in poses["images"] if im.get("registered")}
    dc = []
    for im in imgs.values():
        R = qvec_to_rotmat(im["q"])
        c = -R.T @ np.asarray(im["t"])
        p = by_name.get(im["name"])
        dc.append(np.linalg.norm(c - np.asarray(p["center"])) if p else np.inf)
    d = np.load(work / "points.npz")
    groups: dict = {}
    for im in imgs.values():
        g = im["name"].split("/")[0]
        groups.setdefault(g, []).append(im["nobs"])
    return {
        "modelDir": str(mdir),
        "images": len(imgs),
        "cameras": {cid: {"model": c["model"], "size": [c["w"], c["h"]], "params": [round(v, 4) for v in c["params"]]}
                    for cid, c in cams.items()},
        "points": int(len(pts["err"])),
        "meanReprojErrorPoints": round(float(pts["err"].mean()), 4),
        "meanTrackLength": round(float(pts["track"].mean()), 3),
        "twoViewPointsPct": round(100 * float((pts["track"] == 2).mean()), 1),
        "pointsTrack3Err2": int(((pts["track"] >= 3) & (pts["err"] < 2.0)).sum()),
        "pointsUsedForSeeding": int(((pts["track"] >= 2) & (pts["err"] < 2.5)).sum()),
        "posesJsonMatchesModel": bool(len(by_name) == len(imgs) and max(dc) < 1e-6),
        "pointsNpzMatchesModel": bool(len(d["xyz"]) == len(pts["err"])),
        "observationsPerImage": {g: {"min": int(min(v)), "median": int(np.median(v))} for g, v in groups.items()},
        "unregistered": [im["name"] for im in poses["images"] if not im.get("registered")],
    }


# ---------------------------------------------------------------------------------------------------------------


def peak(y: np.ndarray, lo: float, hi: float, bin_m: float = 0.01) -> tuple[float, int]:
    h, e = np.histogram(y, bins=np.arange(lo, hi + bin_m, bin_m))
    k = int(np.argmax(h))
    return float(0.5 * (e[k] + e[k + 1])), int(h[k])


def check_room(work: Path) -> dict:
    room = load(work)
    good = (room.track >= 3) & (room.err < 2.0)
    P = room.P[good]
    out: dict = {}
    # floor: global peak, robust spread, and the local floor per 1 m cell
    near = P[np.abs(P[:, 1]) < 0.3]
    pk, _ = peak(near[:, 1], -0.3, 0.3)
    flo = near[np.abs(near[:, 1] - pk) < 0.05][:, 1]
    cells = []
    ix = np.floor(near[:, [0, 2]] / 1.0).astype(int)
    for key in {tuple(k) for k in ix}:
        sel = np.all(ix == key, axis=1) & (np.abs(near[:, 1]) < 0.12)
        if sel.sum() >= 30:
            cells.append({"cell": [key[0] + 0.5, key[1] + 0.5], "n": int(sel.sum()), "medianY": round(float(np.median(near[sel, 1])), 4)})
    cells.sort(key=lambda c: -c["n"])
    allP = room.P
    out["floor"] = {
        "peakY": round(pk, 4),
        "spreadIqrM": round(float(np.subtract(*np.percentile(flo, [75, 25]))), 4),
        "pointsWithin5cm": int(len(flo)),
        "cells1m": cells[:20],
        "cellMedianRange": [min(c["medianY"] for c in cells), max(c["medianY"] for c in cells)] if cells else None,
        "pctPointsBelowMinus10cm": round(100 * float((allP[:, 1] < -0.10).mean()), 2),
    }
    # horizontal surfaces 0.5-1.4 m: histogram peaks with their footprint
    mid = P[(P[:, 1] > 0.5) & (P[:, 1] < 1.4)]
    h, e = np.histogram(mid[:, 1], bins=np.arange(0.5, 1.41, 0.01))
    peaks = []
    for k in np.argsort(-h)[:12]:
        if any(abs(k - p) <= 2 for p in [pp["_k"] for pp in peaks]):
            continue
        y0 = 0.5 * (e[k] + e[k + 1])
        sel = np.abs(mid[:, 1] - y0) < 0.01
        xz = mid[sel][:, [0, 2]]
        peaks.append({"_k": int(k), "y": round(float(y0), 3), "n": int(h[k]), "centreXZ": np.round(xz.mean(0), 2).tolist(),
                      "spanXZ": np.round(np.percentile(xz, 90, axis=0) - np.percentile(xz, 10, axis=0), 2).tolist()})
    for p in peaks:
        p.pop("_k")
    out["surfaces0p5to1p4"] = peaks[:6]
    # around the cooktop corner measured by kitchen_scale (if present)
    sc = work / "scale.json"
    if sc.exists():
        s = json.loads(sc.read_text())
        loc = {}
        for key in ("range30-cooktop-FL", "door-leaf-TL"):
            if key in s.get("points", {}):
                c = np.asarray(s["points"][key]["room"])
                sel = np.hypot(P[:, 0] - c[0], P[:, 2] - c[2]) < 0.7
                loc[key] = {"pointRoomY": round(float(c[1]), 4), "nearbyPoints": int(sel.sum()),
                            "nearbyFloorPeakY": round(peak(P[sel & (np.abs(P[:, 1]) < 0.25), 1], -0.25, 0.25)[0], 4)
                            if (sel & (np.abs(P[:, 1]) < 0.25)).sum() > 20 else None}
        out["scaleCueSurroundings"] = loc
        out["scaleCues"] = {f["cue"]: f["factor"] for f in s.get("factors", [])}
        out["scaleChecks"] = {f["cue"]: f["factor"] for f in s.get("checks", [])}
    # cameras
    ups = room.up
    roll = np.degrees(np.arccos(np.clip(ups[:, 1], -1, 1)))
    hs = {}
    for g in sorted(set(room.groups)):
        sel = np.array([x == g for x in room.groups])
        hs[g] = {"heightMedian": round(float(np.median(room.C[sel, 1])), 3), "heightMin": round(float(room.C[sel, 1].min()), 3),
                 "heightMax": round(float(room.C[sel, 1].max()), 3), "upTiltMedianDeg": round(float(np.median(roll[sel])), 1)}
    out["cameras"] = hs
    out["scale"] = room.scale
    # spawn: what is around the origin
    r = np.hypot(P[:, 0], P[:, 2])
    out["spawn"] = {"image": room.frame.get("spawn", {}).get("image"),
                    "obstaclePointsWithin0p4m": int(((r < 0.4) & (P[:, 1] > 0.15) & (P[:, 1] < 1.8)).sum()),
                    "nearestCameraM": round(float(np.min(np.hypot(room.C[:, 0], room.C[:, 2]))), 3)}
    return out


def check_frames(work: Path, frames: dict) -> dict:
    import cv2

    out = {}
    for gname, g in frames["groups"].items():
        recs = sorted([im for im in frames["images"] if im["group"] == gname], key=lambda r: r.get("frameIndex", r["name"]))
        sh, lum, hi, lo, masked = [], [], [], [], []
        for r in recs:
            img = cv2.imread(str(work / "images" / r["name"]))
            gray = cv2.cvtColor(cv2.resize(img, (640, int(round(640 * img.shape[0] / img.shape[1]))), interpolation=cv2.INTER_AREA),
                                cv2.COLOR_BGR2GRAY)
            sh.append(float(cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F, ksize=3).var()))
            lum.append(float(gray.mean()))
            hi.append(float((img.max(axis=2) >= 250).mean()))
            lo.append(float((gray <= 8).mean()))
            mp = work / "masks" / f"{r['name']}.png"
            if mp.exists():
                m = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE)
                masked.append(float((m < 128).mean()))
            else:
                masked.append(0.0)
        sh_a = np.asarray(sh)
        rel = np.array([sh_a[i] / np.median(sh_a[max(0, i - 4): i + 5]) for i in range(len(sh_a))])
        worst = np.argsort(rel)[:5]
        d = {
            "images": len(recs),
            "sharpness640": {"min": round(float(sh_a.min()), 1), "median": round(float(np.median(sh_a)), 1)},
            "sharpRelToNeighbours": {"min": round(float(rel.min()), 3), "below0p6": int((rel < 0.6).sum()),
                                     "worst": [{"name": recs[i]["name"], "rel": round(float(rel[i]), 3)} for i in worst]},
            "meanLuma": {"min": round(min(lum), 1), "median": round(float(np.median(lum)), 1), "max": round(max(lum), 1)},
            "clippedPct": {"median": round(100 * float(np.median(hi)), 2), "max": round(100 * max(hi), 2)},
            "crushedPct": {"median": round(100 * float(np.median(lo)), 2), "max": round(100 * max(lo), 2)},
            "masked": {"withMask": int(sum(m > 0 for m in masked)), "min": round(min(masked), 4),
                       "median": round(float(np.median(masked)), 4), "max": round(max(masked), 4)},
        }
        if g.get("kind") == "video":
            win = frames["videos"][gname]["windows"]
            ratio = np.array([w["sharpness"] / w["envelope"] for w in win if "envelope" in w])
            d["prepWindows"] = {"windows": len(win), "kept": int(sum(w["kept"] for w in win)),
                                "sharpOverEnvelopeMin": round(float(ratio.min()), 3) if len(ratio) else None,
                                "maxGapS": round(float(np.max(np.diff([r["time"] for r in recs]))), 3)}
        out[gname] = d
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args(argv)
    poses = json.loads((a.work / "poses.json").read_text())
    frames = json.loads((a.work / "frames.json").read_text())
    rep = {"posesStats": {k: v for k, v in poses["stats"].items()}, "model": check_model(a.work, poses),
           "room": check_room(a.work), "frames": check_frames(a.work, frames), "maskSettings": frames.get("masks")}
    cov = a.work / "coverage.json"
    if cov.exists():
        c = json.loads(cov.read_text())
        rep["coverage"] = {k: c.get(k) for k in ("walkAreaM2", "surroundedAreaM2", "spawnInside", "spawnClearanceM", "bbox",
                                                  "ceilingHeightM", "cameras")}
    a.out.write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
