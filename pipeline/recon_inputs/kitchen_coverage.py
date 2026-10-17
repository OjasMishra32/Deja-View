#!/usr/bin/env python3
"""The floor area the kitchen capture's cameras covered, in the room frame, plus the top-down evidence plot.

  python pipeline/recon_inputs/kitchen_coverage.py --work WORK --out WORK/coverage.json \
      [--radius 0.6] [--clip WORK/clip.json] [--plot EVID/topdown.png] [--scale-json WORK/scale.json]

Walls: the yaw that lines the sparse points between 0.3 and 2.2 m up with the x/z axes (kitchen_room.wall_yaw);
the room's inner rectangle is the 1st..99th percentile of those points along each wall axis (sparse points sit
on the walls, the room is a box).

Coverage: the camera centres on the floor. The video path is joined in time order (steps under 1.5 m; a longer
step would be a jump, not a walk) and swept with a disc of --radius metres on a 2 cm raster, every photo position
gets the same disc; the union is clipped to the room rectangle less 0.25 m (no walking into a wall). Reported:
area, outline polygon (x, z), bounding box, and the spawn's distance to the outline. Obstacles (cells with
sparse points between 0.15 and 1.8 m up, e.g. counters, tables) are mapped for the plot but not removed: in the
viewer you may walk through a stool.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitchen_room import from_wall_axes, load, to_wall_axes, wall_yaw  # noqa: E402


def main(argv=None) -> int:
    import cv2

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--radius", type=float, default=0.6)
    ap.add_argument("--wall-margin", type=float, default=0.25)
    ap.add_argument("--cell", type=float, default=0.02)
    ap.add_argument("--clip", type=Path, default=None)
    ap.add_argument("--plot", type=Path, default=None)
    ap.add_argument("--scale-json", type=Path, default=None)
    ap.add_argument("--exclude", nargs="*", default=[], help="camera names left out of the coverage (misregistered)")
    a = ap.parse_args(argv)

    room = load(a.work)
    good = (room.track >= 3) & (room.err < 2.0)
    P = room.P[good]
    exclude = set(a.exclude)
    keep_cam = np.array([n not in exclude for n in room.names])
    yaw = wall_yaw(P)
    wall_pts = P[(P[:, 1] > 0.3) & (P[:, 1] < 2.2)]
    uvw = to_wall_axes(wall_pts[:, [0, 2]], yaw)
    cam_uv = to_wall_axes(room.C[keep_cam][:, [0, 2]], yaw)
    lo_uv, hi_uv = np.zeros(2), np.zeros(2)
    walls = {}
    for ax in (0, 1):
        # the walls along this axis: the strongest peak of the wall-height points just beyond the cameras on each
        # side (points seen through the window or far away lie beyond the wall and are ignored by taking the peak)
        x = uvw[:, ax]
        cmin, cmax = float(cam_uv[:, ax].min()), float(cam_uv[:, ax].max())
        bins = np.arange(cmin - 4.0, cmax + 4.0 + 1e-9, 0.05)
        h, e = np.histogram(x, bins=bins)
        h = np.convolve(h, [1, 2, 3, 2, 1], mode="same").astype(float)
        mid = 0.5 * (e[:-1] + e[1:])
        below = (mid < cmin - 0.1) & (mid > cmin - 4.0)
        above = (mid > cmax + 0.1) & (mid < cmax + 4.0)
        lo_v = float(mid[below][np.argmax(h[below])]) if below.any() and h[below].max() > 0 else cmin - 1.0
        hi_v = float(mid[above][np.argmax(h[above])]) if above.any() and h[above].max() > 0 else cmax + 1.0
        lo_uv[ax], hi_uv[ax] = lo_v, hi_v
        walls[ax] = {"cameras": [round(cmin, 3), round(cmax, 3)], "walls": [round(lo_v, 3), round(hi_v, 3)],
                     "peakPoints": [int(h[below].max()) if below.any() else 0, int(h[above].max()) if above.any() else 0]}
    rect_uv = np.array([[lo_uv[0], lo_uv[1]], [hi_uv[0], lo_uv[1]], [hi_uv[0], hi_uv[1]], [lo_uv[0], hi_uv[1]]])
    rect_xz = from_wall_axes(rect_uv, yaw)

    # raster in wall axes
    cell = a.cell
    pad = a.radius + 0.5
    lo = np.minimum(lo_uv, cam_uv.min(0)) - pad
    hi = np.maximum(hi_uv, cam_uv.max(0)) + pad
    W, H = int(np.ceil((hi[0] - lo[0]) / cell)), int(np.ceil((hi[1] - lo[1]) / cell))

    def pix(uv):
        return np.round((np.asarray(uv) - lo) / cell).astype(np.int32)

    cover = np.zeros((H, W), np.uint8)
    r_px = int(round(a.radius / cell))
    C_uv = to_wall_axes(room.C[:, [0, 2]], yaw)
    groups = np.array(room.groups)
    is_photo = np.array([g.startswith("photo") for g in groups]) & keep_cam
    for k in np.nonzero(is_photo)[0]:
        cv2.circle(cover, tuple(int(v) for v in pix(C_uv[k])), r_px, 1, -1)
    paths = []
    for g in sorted(set(groups[~is_photo])):
        idx = [i for i in np.nonzero(groups == g)[0]]
        idx.sort(key=lambda i: room.meta[i].get("time", 0.0))
        seq = C_uv[idx]
        paths.append((g, np.array(idx)))
        for i in range(len(seq)):
            cv2.circle(cover, tuple(int(v) for v in pix(seq[i])), r_px, 1, -1)
            if i and np.linalg.norm(seq[i] - seq[i - 1]) < 1.5:
                cv2.line(cover, tuple(int(v) for v in pix(seq[i - 1])), tuple(int(v) for v in pix(seq[i])), 1, 2 * r_px + 1)
    inner = np.zeros_like(cover)
    m = a.wall_margin
    p0, p1 = pix(lo_uv + m), pix(hi_uv - m)
    cv2.rectangle(inner, (int(p0[0]), int(p0[1])), (int(p1[0]), int(p1[1])), 1, -1)
    walk = cover & inner
    area = float(walk.sum()) * cell * cell
    cnts, _ = cv2.findContours(walk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)
    outlines = []
    for c in cnts:
        approx = cv2.approxPolyDP(c, 0.05 / cell, True)[:, 0, :].astype(np.float64)
        uv = approx * cell + lo
        xz = from_wall_axes(uv, yaw)
        outlines.append([[round(float(x), 3), round(float(z), 3)] for x, z in xz])
    ys, xs = np.nonzero(walk)
    uv_cells = np.stack([xs, ys], 1) * cell + lo
    xz_cells = from_wall_axes(uv_cells, yaw)
    spawn_in = bool(walk[tuple(pix(to_wall_axes(np.zeros((1, 2)), yaw)[0])[::-1])])
    dist = cv2.distanceTransform(walk, cv2.DIST_L2, 5) * cell
    sp = pix(to_wall_axes(np.zeros((1, 2)), yaw)[0])
    occ = np.zeros_like(cover)
    obst = P[(P[:, 1] > 0.15) & (P[:, 1] < 1.8)]
    q = pix(to_wall_axes(obst[:, [0, 2]], yaw))
    okq = (q[:, 0] >= 0) & (q[:, 0] < W) & (q[:, 1] >= 0) & (q[:, 1] < H)
    occ[q[okq, 1], q[okq, 0]] = 1
    room_area = float(np.prod(hi_uv - lo_uv))
    # the interior the cameras surround: convex hull of every kept camera position, inside the walls (margin):
    # seen from around its edges, but nobody stood in its middle, so it is the stretch zone, not the safe one
    hull_mask = np.zeros_like(cover)
    hull = cv2.convexHull(pix(C_uv[keep_cam]).astype(np.int32))
    cv2.fillConvexPoly(hull_mask, hull, 1)
    hull_mask &= inner
    hull_area = float(hull_mask.sum()) * cell * cell
    hc, _ = cv2.findContours(hull_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull_outline = []
    if hc:
        c0 = max(hc, key=cv2.contourArea)
        ap_ = cv2.approxPolyDP(c0, 0.05 / cell, True)[:, 0, :].astype(np.float64) * cell + lo
        hull_outline = [[round(float(x), 3), round(float(z), 3)] for x, z in from_wall_axes(ap_, yaw)]
    out = {
        "frame": "room (viewer): y up, metres, floor y = 0, spawn at the origin facing -Z",
        "radius": a.radius,
        "wallMargin": m,
        "wallYawDeg": round(float(np.degrees(yaw)), 2),
        "wallsAlongAxes": walls,
        "excludedCameras": sorted(exclude),
        "roomRectangle": {"corners": [[round(float(x), 3), round(float(z), 3)] for x, z in rect_xz],
                          "size": [round(float(v), 3) for v in (hi_uv - lo_uv)], "areaM2": round(room_area, 2)},
        "walkAreaM2": round(area, 2),
        "walkArea": "union of discs of --radius around every camera position, the video path swept, inside the walls less the margin",
        "surroundedAreaM2": round(hull_area, 2),
        "surroundedOutline": hull_outline,
        "walkFractionOfRoom": round(area / max(room_area, 1e-9), 3),
        "outline": outlines[0] if outlines else [],
        "otherOutlines": outlines[1:],
        "bbox": {"min": [round(float(xz_cells[:, 0].min()), 3), 0.0, round(float(xz_cells[:, 1].min()), 3)],
                 "max": [round(float(xz_cells[:, 0].max()), 3), None, round(float(xz_cells[:, 1].max()), 3)]},
        "spawnInside": spawn_in,
        "spawnClearanceM": round(float(dist[sp[1], sp[0]]) if 0 <= sp[0] < W and 0 <= sp[1] < H else 0.0, 3),
        "cameras": {"photos": int(is_photo.sum()), "video": int(sum(1 for g in groups if not g.startswith("photo")))},
        "videoPathLengthM": {g: round(float(np.linalg.norm(np.diff(C_uv[idx], axis=0), axis=1).sum()), 2) for g, idx in paths},
    }
    ceil = P[P[:, 1] > np.percentile(room.C[:, 1], 90) + 0.4]
    if len(ceil) > 50:
        hst, edges = np.histogram(ceil[:, 1], bins=np.arange(ceil[:, 1].min(), ceil[:, 1].max() + 0.02, 0.02))
        k = int(np.argmax(hst))
        out["ceilingHeightM"] = round(float(0.5 * (edges[k] + edges[k + 1])), 3)
        out["bbox"]["max"][1] = out["ceilingHeightM"]
    a.out.write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in out.items() if k not in ("outline", "otherOutlines")}, indent=1))

    if a.plot:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Polygon

        clip = json.loads(a.clip.read_text()) if a.clip and a.clip.exists() else None
        scale = json.loads(a.scale_json.read_text()) if a.scale_json and a.scale_json.exists() else None
        fig, ax = plt.subplots(figsize=(9, 9), dpi=110)
        fig.patch.set_facecolor("#fcfcfb")
        sel = (P[:, 1] > 0.1) & (P[:, 1] < 2.4)
        ax.scatter(P[sel, 0], P[sel, 2], s=0.4, c=room.rgb[good][sel] / 255.0, alpha=0.6, linewidths=0, rasterized=True)
        ax.add_patch(Polygon(rect_xz, closed=True, fill=False, ec="#52514e", lw=1.0, ls="--", label="room rectangle (walls)"))
        if hull_outline:
            ax.add_patch(Polygon(np.array(hull_outline), closed=True, fill=False, ec="#1baf7a", lw=1.2, ls=":",
                                 label=f"surrounded by cameras {hull_area:.1f} m² (stretch zone)"))
        if outlines:
            ax.add_patch(Polygon(np.array(outlines[0]), closed=True, fc="#1baf7a", alpha=0.18, ec="#1baf7a", lw=1.5,
                                 label=f"walk area {area:.1f} m² (r = {a.radius} m)"))
        F = room.forward
        Cp = room.C[is_photo]
        ax.scatter(Cp[:, 0], Cp[:, 2], s=26, c="#eb6834", zorder=5, label=f"photos ({is_photo.sum()})")
        for k in np.nonzero(is_photo)[0]:
            f2 = F[k][[0, 2]] / max(np.linalg.norm(F[k][[0, 2]]), 1e-9)
            ax.plot([room.C[k, 0], room.C[k, 0] + 0.45 * f2[0]], [room.C[k, 2], room.C[k, 2] + 0.45 * f2[1]], c="#eb6834", lw=1)
        for g, idx in paths:
            ts = np.array([room.meta[i].get("time", 0.0) for i in idx])
            ax.plot(room.C[idx, 0], room.C[idx, 2], c="#2a78d6", lw=0.8, alpha=0.6)
            sc = ax.scatter(room.C[idx, 0], room.C[idx, 2], s=9, c=ts, cmap="Blues", vmin=-10, zorder=4,
                            label=f"video '{g}' ({len(idx)} frames, colour = time)")
            if clip and clip.get("pick"):
                pk = clip["pick"]
                inside = [i for i, t in zip(idx, ts) if pk["start"] <= t <= pk["end"]]
                ax.plot(room.C[inside, 0], room.C[inside, 2], c="#d6336c", lw=2.2, zorder=6,
                        label=f"clip for 3D people {pk['start']:.1f}-{pk['end']:.1f} s")
                fl = np.array([r["cookFloor"] for r in clip["frames"] if "cookFloor" in r and pk["start"] <= r["time"] <= pk["end"]])
                if len(fl):
                    ax.scatter(fl[:, 0], fl[:, 1], s=10, marker="x", c="#7a1fa2", zorder=6, label="cook on the floor (clip)")
        ax.annotate("", xy=(0, -0.9), xytext=(0, 0), arrowprops=dict(arrowstyle="-|>", color="#0b0b0b", lw=2))
        ax.scatter([0], [0], s=60, facecolors="white", edgecolors="#0b0b0b", zorder=7, label="spawn (faces -Z)")
        win_lo = np.minimum(rect_xz.min(0), room.C[keep_cam][:, [0, 2]].min(0)) - 0.8
        win_hi = np.maximum(rect_xz.max(0), room.C[keep_cam][:, [0, 2]].max(0)) + 0.8
        for k in np.nonzero(is_photo)[0]:
            ax.annotate(room.names[k].split("_")[-1].replace(".jpg", ""), (room.C[k, 0], room.C[k, 2]), fontsize=5.5,
                        color="#7a3a12", xytext=(3, 3), textcoords="offset points")
        for nm in exclude:
            if nm in room.names:
                k = room.names.index(nm)
                ax.scatter([room.C[k, 0]], [room.C[k, 2]], s=30, marker="x", c="#d62728", zorder=8)
                ax.annotate(nm.split("_")[-1].replace(".jpg", "") + " (dropped)", (room.C[k, 0], room.C[k, 2]), fontsize=6,
                            color="#d62728", xytext=(3, -8), textcoords="offset points")
        ax.set_xlim(win_lo[0], win_hi[0])
        ax.set_ylim(win_lo[1], win_hi[1])
        ax.set_aspect("equal")
        ax.invert_yaxis()
        ax.set_xlabel("x (m)")
        ax.set_ylabel("z (m)   (up the page = -Z = the spawn's view)")
        title = "Kitchen: cameras, walk area, spawn (room frame, top view)"
        if scale:
            title += f"\nscale: {scale.get('summary', '')}"
        ax.set_title(title, fontsize=10)
        ax.grid(True, color="#e4e3df", lw=0.6)
        ax.legend(loc="upper left", fontsize=7, framealpha=0.9)
        a.plot.parent.mkdir(parents=True, exist_ok=True)
        fig.tight_layout()
        fig.savefig(a.plot)
        print(f"wrote {a.plot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
