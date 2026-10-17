#!/usr/bin/env python3
"""Finds the flat tops in a rebuilt room (counters, cooktops, tables) from its splats, for scene features.json.

Splats that are solid (opacity above --min-opacity), lie flat (their thinnest axis points up) and sit between --y0 and
--y1 metres above the floor are binned by height; each height peak is rasterised on a --cell grid in the room's own
wall directions (--yaw: the angle of one wall from +x towards +z, so tops come out as rectangles along the walls),
closed, and split into connected pieces. Each piece reports its centre, its size along and across the wall, its
height and how dark it is (a black glass cooktop against a white counter). A top-down PNG draws them numbered.

    python pipeline/surfaces.py --world data/scenes/kitchen/world.spz --yaw 66.5 --out surfaces.json [--png top.png]

It only measures; which piece is the stove or the counter is decided by a person looking at the PNG.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import splat_io as sio  # noqa: E402


def flat_up(quats_wxyz: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """|y| of each splat's thinnest axis (1 = lying flat)."""
    w, x, y, z = (quats_wxyz[:, i] for i in range(4))
    # rotation matrix columns are the local axes in world space
    cols = np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], -1),
        np.stack([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], -1),
        np.stack([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)], -1),
    ], 1)  # [N, axis, xyz]
    thin = np.argmin(scales, axis=1)
    axis = cols[np.arange(len(thin)), thin]
    return np.abs(axis[:, 1]) / np.maximum(np.linalg.norm(axis, axis=1), 1e-9)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--world", required=True, type=Path)
    ap.add_argument("--yaw", type=float, default=0.0, help="degrees: a wall's direction from +x towards +z")
    ap.add_argument("--y0", type=float, default=0.7)
    ap.add_argument("--y1", type=float, default=1.2)
    ap.add_argument("--cell", type=float, default=0.02)
    ap.add_argument("--min-opacity", type=float, default=0.3)
    ap.add_argument("--min-area", type=float, default=0.06, help="m2: smaller pieces are dropped")
    ap.add_argument("--band", type=float, default=0.025, help="m: half height of each peak's slab")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--png", type=Path)
    a = ap.parse_args()
    from scipy import ndimage

    s = sio.read_splats(a.world)
    keep = (s.opacities > a.min_opacity) & (s.means[:, 1] > a.y0) & (s.means[:, 1] < a.y1)
    keep &= flat_up(s.quats, s.scales) > 0.85
    p = s.means[keep]
    rgb = np.clip(s.rgb()[keep], 0, 1)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    t = math.radians(a.yaw)
    u = p[:, 0] * math.cos(t) + p[:, 2] * math.sin(t)
    v = -p[:, 0] * math.sin(t) + p[:, 2] * math.cos(t)

    hist, edges = np.histogram(p[:, 1], bins=np.arange(a.y0, a.y1 + 0.01, 0.01))
    sm = np.convolve(hist, [1, 2, 3, 2, 1], "same")
    peaks = [i for i in range(1, len(sm) - 1) if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > 0.15 * sm.max()]
    pieces = []
    for i in peaks:
        h = float((edges[i] + edges[i + 1]) / 2)
        m = np.abs(p[:, 1] - h) < a.band
        print(f"peak {h:.3f} m: {int(m.sum())} flat splats", flush=True)
        if m.sum() < 200:
            continue
        uu, vv = u[m], v[m]
        u0, v0 = uu.min(), vv.min()
        nu, nv = int((uu.max() - u0) / a.cell) + 2, int((vv.max() - v0) / a.cell) + 2
        grid = np.zeros((nu, nv), np.int32)
        np.add.at(grid, (((uu - u0) / a.cell).astype(int), ((vv - v0) / a.cell).astype(int)), 1)
        occ = ndimage.binary_closing(grid >= 1, iterations=2)
        occ = ndimage.binary_opening(occ, iterations=1)
        lab, n = ndimage.label(occ)
        ci = ((uu - u0) / a.cell).astype(int), ((vv - v0) / a.cell).astype(int)
        lab_pts = lab[ci]
        for k in range(1, n + 1):
            cells = np.argwhere(lab == k)
            area = len(cells) * a.cell * a.cell
            if area < a.min_area:
                continue
            # the piece's extent along the walls, trimmed to its 2nd..98th percentiles
            cu = u0 + (cells[:, 0] + 0.5) * a.cell
            cv = v0 + (cells[:, 1] + 0.5) * a.cell
            ulo, uhi = np.percentile(cu, [2, 98])
            vlo, vhi = np.percentile(cv, [2, 98])
            sel = lab_pts == k
            cu_, cv_ = (ulo + uhi) / 2, (vlo + vhi) / 2
            pieces.append({
                "height": round(float(np.median(p[m][sel][:, 1])) if sel.any() else h, 3),
                "centre": [round(cu_ * math.cos(t) - cv_ * math.sin(t), 3), round(cu_ * math.sin(t) + cv_ * math.cos(t), 3)],
                "alongWall": round(float(uhi - ulo), 3),
                "acrossWall": round(float(vhi - vlo), 3),
                "areaM2": round(area, 3),
                "fill": round(area / max((uhi - ulo) * (vhi - vlo), 1e-6), 2),
                "luminance": round(float(np.median(lum[m][sel])) if sel.any() else -1, 3),
                "uv": [round(float(ulo), 3), round(float(uhi), 3), round(float(vlo), 3), round(float(vhi), 3)],
            })
    pieces.sort(key=lambda q: -q["areaM2"])
    for i, q in enumerate(pieces):
        q["id"] = i
    out = {"world": str(a.world), "yawDeg": a.yaw, "frame": "x/z in the world's frame (floor y = 0); uv = along/across the wall at --yaw",
           "heightPeaks": [round(float((edges[i] + edges[i + 1]) / 2), 3) for i in peaks], "pieces": pieces}
    a.out.write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in out.items() if k != "pieces"}))
    for q in pieces:
        print(q["id"], q["height"], q["centre"], q["alongWall"], "x", q["acrossWall"], "area", q["areaM2"], "lum", q["luminance"])

    if a.png:
        import cv2

        allp = s.means[(s.opacities > a.min_opacity) & (s.means[:, 1] < 2.4)]
        x0, z0 = allp[:, 0].min(), allp[:, 2].min()
        S = 100  # px per metre
        W_, H_ = int((allp[:, 0].max() - x0) * S) + 20, int((allp[:, 2].max() - z0) * S) + 20
        img = np.full((H_, W_, 3), 245, np.uint8)
        xs = ((allp[:, 0] - x0) * S + 10).astype(int)
        zs = ((allp[:, 2] - z0) * S + 10).astype(int)
        img[zs.clip(0, H_ - 1), xs.clip(0, W_ - 1)] = (170, 170, 170)
        for q in pieces:
            ulo, uhi, vlo, vhi = q["uv"]
            corners = []
            for uu_, vv_ in ((ulo, vlo), (uhi, vlo), (uhi, vhi), (ulo, vhi)):
                cx, cz = uu_ * math.cos(t) - vv_ * math.sin(t), uu_ * math.sin(t) + vv_ * math.cos(t)
                corners.append([int((cx - x0) * S + 10), int((cz - z0) * S + 10)])
            col = (40, 40, 40) if q["luminance"] < 0.25 else (40, 140, 230)
            cv2.polylines(img, [np.array(corners, np.int32)], True, col, 2)
            c = np.array(corners).mean(0).astype(int)
            cv2.putText(img, f"{q['id']} {q['height']:.2f}", (int(c[0]) - 20, int(c[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
        cv2.imwrite(str(a.png), img)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
