#!/usr/bin/env python3
"""Pose sanity sheet: each named image beside the sparse points projected through its solved camera.

  python pipeline/recon_inputs/kitchen_posecheck.py --work WORK --names photo/IMG_7403.jpg ... --out EVID/posecheck.jpg

A camera placed on the wrong copy of a repeated object (identical tables) still has small reprojection errors for
its own inliers, but the rest of the room projects nowhere near the photo; side by side, that shows at a glance.
Points are drawn far to near (2 px dots, their colours), in the image's own undistorted pinhole approximation.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from kitchen_room import qvec_to_rotmat


def main(argv=None) -> int:
    import cv2

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--names", nargs="+", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--width", type=int, default=400)
    a = ap.parse_args(argv)
    poses = json.loads((a.work / "poses.json").read_text())
    d = np.load(a.work / "points.npz")
    X, rgb = d["xyz"].astype(np.float64), d["rgb"]
    keep = d["track"] >= 3
    X, rgb = X[keep], rgb[keep]
    by = {im["name"]: im for im in poses["images"]}
    rows = []
    for name in a.names:
        im = by.get(name)
        img = cv2.imread(str(a.work / "images" / name))
        h, w = img.shape[:2]
        canvas = np.full_like(img, 24)
        label = name.split("/")[-1]
        if im and im.get("registered"):
            cam = poses["cameras"][im["camera"]]
            f, cx, cy = cam["params"][0], cam["params"][1], cam["params"][2]
            R = qvec_to_rotmat(im["qvec"])
            Xc = X @ R.T + np.asarray(im["tvec"])
            ok = Xc[:, 2] > 0.05
            uv = Xc[ok, :2] / Xc[ok, 2:3] * f + np.array([cx, cy])
            z = Xc[ok, 2]
            col = rgb[ok][:, ::-1]
            inside = (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
            order = np.argsort(-z[inside])
            for (u, v), c in zip(uv[inside][order].astype(int), col[inside][order]):
                cv2.circle(canvas, (int(u), int(v)), 3, tuple(int(x) for x in c), -1)
            label += f"  obs {im.get('numObservations')}  err {im.get('reprojError')}"
        else:
            label += "  (not registered)"
        pair = np.concatenate([img, canvas], axis=1)
        s = 2 * a.width / pair.shape[1]
        pair = cv2.resize(pair, (2 * a.width, int(pair.shape[0] * s)), interpolation=cv2.INTER_AREA)
        cv2.rectangle(pair, (0, 0), (pair.shape[1], 22), (0, 0, 0), -1)
        cv2.putText(pair, label, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        rows.append(pair)
    W = max(r.shape[1] for r in rows)
    rows = [cv2.copyMakeBorder(r, 0, 2, 0, W - r.shape[1], cv2.BORDER_CONSTANT, value=(255, 255, 255)) for r in rows]
    half = (len(rows) + 1) // 2
    left, right = rows[:half], rows[half:]
    colL = np.concatenate(left, axis=0)
    colR = np.concatenate(right, axis=0) if right else np.zeros_like(colL)
    if colR.shape[0] < colL.shape[0]:
        colR = cv2.copyMakeBorder(colR, 0, colL.shape[0] - colR.shape[0], 0, 0, cv2.BORDER_CONSTANT)
    sheet = np.concatenate([colL, np.full((colL.shape[0], 6, 3), 255, np.uint8), colR], axis=1)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
