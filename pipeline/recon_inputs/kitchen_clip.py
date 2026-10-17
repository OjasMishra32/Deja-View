#!/usr/bin/env python3
"""The best stretch of the kitchen video for the 3D-person stage: the cook in view and moving, a steady camera.

  python pipeline/recon_inputs/kitchen_clip.py --work WORK --group cook --out WORK/clip.json \
      [--lengths 6 8 10 12] [--evidence EVID]

Per sampled frame (prep.py's kept frames of GROUP): registered or not, the person mask's box (masks/<image>.png,
0 = person), whether the whole body is in the picture (box clear of the top, bottom and side edges), and, when the
feet are in view, where the cook stands on the floor (the ray through the bottom middle of the box meets y = 0
in the room frame). Camera steadiness is the angle (and distance) between each camera and a smoothed copy of the
path (Gaussian over --smooth seconds): what remains is hand shake, not the intended pan.

Every window of each length (0.5 s steps) is scored:
  0.35 * in view + 0.35 * whole body + 0.30 * min(cook's floor travel / 2 m, 1) - shake penalty,
and only windows whose every sample is registered and none of whose gaps exceed 0.6 s qualify.
Writes OUT (per-frame table, every length's best window, the pick) and, with --evidence, a strip of the pick.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitchen_room import load  # noqa: E402


def rot_angle(Ra: np.ndarray, Rb: np.ndarray) -> float:
    c = (np.trace(Ra.T @ Rb) - 1.0) / 2.0
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def smooth_rotations(Rs: np.ndarray, t: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian-weighted chordal mean of the rotations around each time (SVD projection back onto SO(3))."""
    out = []
    for ti in t:
        w = np.exp(-0.5 * ((t - ti) / sigma) ** 2)
        M = np.tensordot(w, Rs, axes=(0, 0))
        U, _, Vt = np.linalg.svd(M)
        R = U @ Vt
        if np.linalg.det(R) < 0:
            U[:, -1] *= -1
            R = U @ Vt
        out.append(R)
    return np.asarray(out)


def person_box(mask_path: Path):
    import cv2

    m = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        return None, None
    fg = (m < 128).astype(np.uint8)
    H, W = fg.shape
    if fg.sum() < 0.01 * fg.size:
        return None, (W, H)
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, w, h = (int(v) for v in st[k, :4])
    return (x, y, x + w, y + h), (W, H)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--group", default="cook")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--lengths", nargs="*", type=float, default=[6.0, 8.0, 10.0, 12.0])
    ap.add_argument("--smooth", type=float, default=0.5, help="sigma (s) of the smoothed camera path")
    ap.add_argument("--max-gap", type=float, default=0.6)
    ap.add_argument("--evidence", type=Path, default=None)
    a = ap.parse_args(argv)

    work = a.work
    frames = json.loads((work / "frames.json").read_text())
    room = load(work)
    reg_idx = {n: i for i, n in enumerate(room.names)}
    cam = next(c for c in room.cameras.values() if c.get("group") == a.group)
    f, cx, cy = cam["params"][0], cam["params"][1], cam["params"][2]
    if cam["model"] in ("PINHOLE", "OPENCV"):
        f, cx, cy = 0.5 * (cam["params"][0] + cam["params"][1]), cam["params"][2], cam["params"][3]
    recs = sorted((im for im in frames["images"] if im["group"] == a.group), key=lambda r: r["frameIndex"])
    rows = []
    for im in recs:
        box, size = person_box(work / "masks" / f"{im['name']}.png")
        r = {"name": im["name"], "frameIndex": im["frameIndex"], "time": im["time"], "sharpness": im.get("sharpness"),
             "masked": im.get("masked", 0.0), "registered": im["name"] in reg_idx}
        if box is not None:
            W, H = size
            x0, y0, x1, y1 = box
            r["box"] = [x0, y0, x1, y1]
            r["inView"] = bool(0.02 <= r["masked"] <= 0.55 and (x1 - x0) < 0.9 * W)
            r["feet"] = bool(y1 < 0.97 * H)
            r["head"] = bool(y0 > 0.01 * H)
            r["sides"] = bool(x0 > 0.01 * W and x1 < 0.99 * W)
            r["wholeBody"] = bool(r["feet"] and r["head"] and r["sides"])
        else:
            r.update(inView=False, feet=False, head=False, sides=False, wholeBody=False)
        if r["registered"]:
            k = reg_idx[im["name"]]
            r["center"] = [round(float(v), 4) for v in room.C[k]]
            if r.get("feet"):
                u, v = 0.5 * (r["box"][0] + r["box"][2]), r["box"][3]
                d_cam = np.array([(u - cx) / f, (v - cy) / f, 1.0])
                d = room.Rc2w[k] @ d_cam
                if d[1] < -1e-3:
                    s = -room.C[k][1] / d[1]
                    p = room.C[k] + s * d
                    if s < 12.0:
                        r["cookFloor"] = [round(float(p[0]), 3), round(float(p[2]), 3)]
                        r["cookDistance"] = round(float(np.hypot(*(p - room.C[k])[[0, 2]])), 3)
        rows.append(r)

    # camera shake: residual of each camera against the smoothed path (registered samples only)
    regs = [r for r in rows if r["registered"]]
    t = np.array([r["time"] for r in regs])
    Rs = np.array([room.Rc2w[reg_idx[r["name"]]] for r in regs])
    Cs = np.array([room.C[reg_idx[r["name"]]] for r in regs])
    Rsm = smooth_rotations(Rs, t, a.smooth)
    for k, r in enumerate(regs):
        w = np.exp(-0.5 * ((t - t[k]) / a.smooth) ** 2)
        c_sm = (w[:, None] * Cs).sum(0) / w.sum()
        r["shakeDeg"] = round(rot_angle(Rs[k], Rsm[k]), 3)
        r["shakeCm"] = round(100.0 * float(np.linalg.norm(Cs[k] - c_sm)), 2)
        if k > 0:
            dt = max(t[k] - t[k - 1], 1e-3)
            r["turnDegPerS"] = round(rot_angle(Rs[k - 1], Rs[k]) / dt, 2)
            r["speedMps"] = round(float(np.linalg.norm(Cs[k] - Cs[k - 1]) / dt), 3)

    times = np.array([r["time"] for r in rows])
    best_by_len = {}
    for L in a.lengths:
        best = None
        for t0 in np.arange(0.0, max(0.0, times[-1] - L) + 1e-6, 0.5):
            sel = [r for r in rows if t0 <= r["time"] <= t0 + L]
            if len(sel) < 4:
                continue
            ts = np.array([r["time"] for r in sel])
            gaps = np.diff(ts)
            all_reg = all(r["registered"] for r in sel)
            ok = all_reg and (gaps.max() if len(gaps) else 0) <= a.max_gap
            in_view = float(np.mean([r["inView"] for r in sel]))
            whole = float(np.mean([r["wholeBody"] for r in sel]))
            fl = np.array([r["cookFloor"] for r in sel if "cookFloor" in r])
            if len(fl) >= 3:
                # median-filtered floor track (single bad boxes jump), then its length
                k = 2
                med = np.array([np.median(fl[max(0, i - k): i + k + 1], axis=0) for i in range(len(fl))])
                travel = float(np.linalg.norm(np.diff(med, axis=0), axis=1).sum())
                spread = float(np.linalg.norm(med.max(0) - med.min(0)))
            else:
                travel, spread = 0.0, 0.0
            shake = float(np.median([r.get("shakeDeg", 0.0) for r in sel]))
            shake95 = float(np.percentile([r.get("shakeDeg", 0.0) for r in sel], 95))
            sharp = float(np.median([r["sharpness"] or 0 for r in sel]))
            score = 0.35 * in_view + 0.35 * whole + 0.30 * min(spread / 2.0, 1.0) - 0.05 * max(0.0, shake - 0.5) - 0.02 * max(0.0, shake95 - 2.0)
            cand = {"start": round(float(t0), 2), "end": round(float(t0 + L), 2), "length": L, "samples": len(sel),
                    "allRegistered": all_reg, "maxGap": round(float(gaps.max()) if len(gaps) else 0.0, 3), "qualifies": bool(ok),
                    "inView": round(in_view, 3), "wholeBody": round(whole, 3), "cookTravelM": round(travel, 2),
                    "cookSpreadM": round(spread, 2), "shakeDegMedian": round(shake, 3), "shakeDeg95": round(shake95, 3),
                    "sharpnessMedian": round(sharp, 1), "score": round(score, 4),
                    "frameRange": [sel[0]["frameIndex"], sel[-1]["frameIndex"]]}
            if ok and (best is None or cand["score"] > best["score"]):
                best = cand
        best_by_len[str(L)] = best
    pick = max((b for b in best_by_len.values() if b), key=lambda b: b["score"] + 0.01 * b["length"], default=None)
    out = {"group": a.group, "samples": len(rows), "registered": sum(r["registered"] for r in rows),
           "scoring": "0.35 inView + 0.35 wholeBody + 0.30 min(cook floor spread / 2 m, 1) - shake penalties; "
                      "only windows with every sample registered and gaps <= max-gap",
           "bestByLength": best_by_len, "pick": pick, "frames": rows}
    a.out.write_text(json.dumps(out, indent=1))
    print(json.dumps({"pick": pick, "bestByLength": best_by_len}, indent=1))

    if a.evidence is not None and pick:
        import cv2

        sel = [r for r in rows if pick["start"] <= r["time"] <= pick["end"]]
        idx = np.linspace(0, len(sel) - 1, min(8, len(sel))).round().astype(int)
        tiles = []
        for i in idx:
            r = sel[i]
            img = cv2.imread(str(work / "images" / r["name"]))
            m = cv2.imread(str(work / "masks" / f"{r['name']}.png"), cv2.IMREAD_GRAYSCALE)
            if m is not None:
                tint = img.copy()
                tint[m < 128] = (0.45 * tint[m < 128] + 0.55 * np.array([60, 60, 230])).astype(np.uint8)
                img = tint
            img = cv2.resize(img, (480, 270), interpolation=cv2.INTER_AREA)
            cv2.putText(img, f"t={r['time']:.2f}s f{r['frameIndex']}", (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            tiles.append(img)
        while len(tiles) % 4:
            tiles.append(np.zeros_like(tiles[0]))
        grid = np.concatenate([np.concatenate(tiles[k:k + 4], axis=1) for k in range(0, len(tiles), 4)], axis=0)
        a.evidence.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(a.evidence / "clip-pick.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
