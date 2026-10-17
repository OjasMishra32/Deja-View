"""Summary of a solved COLMAP model against the work folder's frames.json: registration per video and for the
players clip, reprojection error, intrinsics per camera, and how much of the room the cameras cover.

Coverage: "up" is the mean camera up vector; around the centroid of the sparse points (the middle of the
room), the camera centres' azimuths and the viewing directions' azimuths are binned in 10 degree steps.

  python pipeline/recon_inputs/report.py MODEL_TXT_DIR FRAMES_JSON [--poses poses.json] [--out report.json]

The per-point errors in points3D.txt are the mapper's (bundle_adjuster and image_registrator leave them as
they were), so with --poses (pipeline/recon/poses.py export, which re-projects every observation through
the final cameras) the observation-weighted reprojection error is reported as well.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from plot_poses import qvec_to_rotmat


def read_txt(path: Path) -> tuple[dict, dict, np.ndarray, np.ndarray, int]:
    cams = {}
    for line in (path / "cameras.txt").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            t = line.split()
            cams[int(t[0])] = {"model": t[1], "width": int(t[2]), "height": int(t[3]), "params": [float(v) for v in t[4:]]}
    images = {}
    lines = [ln for ln in (path / "images.txt").read_text().splitlines() if not ln.startswith("#")]
    n_obs = 0
    for k in range(0, len(lines) - 1, 2):
        t = lines[k].split()
        if len(t) < 10:
            continue
        obs = lines[k + 1].split()
        pids = [int(v) for v in obs[2::3]]
        n_obs += sum(1 for p in pids if p >= 0)
        R = qvec_to_rotmat(np.array([float(v) for v in t[1:5]]))
        tv = np.array([float(v) for v in t[5:8]])
        images[t[9]] = {"camera": int(t[8]), "center": -R.T @ tv, "forward": R.T @ np.array([0.0, 0, 1]),
                        "up": -(R.T @ np.array([0.0, 1, 0])), "points": sum(1 for p in pids if p >= 0)}
    xyz, err = [], []
    for line in (path / "points3D.txt").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            t = line.split()
            xyz.append([float(v) for v in t[1:4]])
            err.append(float(t[7]))
    return cams, images, np.asarray(xyz), np.asarray(err), n_obs


def report(model: Path, frames_json: Path, poses_json: Path | None = None) -> dict:
    cams, images, xyz, err, n_obs = read_txt(model)
    frames = json.loads(frames_json.read_text())
    meta = {im["name"]: im for im in frames["images"]}
    groups = {}
    for g in frames["groups"]:
        names = [n for n, m in meta.items() if m["group"] == g]
        reg = [n for n in names if n in images]
        groups[g] = {"registered": len(reg), "total": len(names)}
    clip_names = [n for n, m in meta.items() if "clip" in m.get("roles", [])]
    clip_missing = sorted(n for n in clip_names if n not in images)
    clip_frames = sorted(meta[n]["frameIndex"] for n in clip_names if n in images)
    gaps = np.diff(clip_frames) if len(clip_frames) > 1 else np.array([0])

    intr = {}
    for cid, c in cams.items():
        used = [n for n, im in images.items() if im["camera"] == cid]
        g = meta.get(used[0], {}).get("group") if used else None
        p = c["params"]
        f = p[0]
        intr[g or str(cid)] = {
            "camera_id": cid, "model": c["model"], "params": [round(v, 6) for v in p],
            "hfov_deg": round(math.degrees(2 * math.atan(c["width"] / (2 * f))), 2),
            "vfov_deg": round(math.degrees(2 * math.atan(c["height"] / (2 * f))), 2), "images": len(used),
        }

    up = np.mean([im["up"] for im in images.values()], axis=0)
    up /= np.linalg.norm(up)
    centers = np.array([im["center"] for im in images.values()])
    fwd = np.array([im["forward"] for im in images.values()])
    keep = err < np.percentile(err, 95)
    mid = np.median(xyz[keep], axis=0)

    e1 = np.cross(up, [1.0, 0, 0]) if abs(up[0]) < 0.9 else np.cross(up, [0, 1.0, 0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)

    def azimuth(v):
        h = v - np.outer(v @ up, up)
        return np.degrees(np.arctan2(h @ e2, h @ e1)) % 360

    pos_bins = np.unique((azimuth(centers - mid) // 10).astype(int))
    view_bins = np.unique((azimuth(fwd) // 10).astype(int))
    radius = np.linalg.norm((centers - mid) - np.outer((centers - mid) @ up, up), axis=1)
    out = {
        "model": str(model),
        "registered": len(images),
        "total": len(meta),
        "groups": groups,
        "clip": {
            "video": (frames.get("clip") or {}).get("video"), "frames": len(clip_names),
            "registered": len(clip_names) - len(clip_missing), "missing": clip_missing,
            "max_gap_frames": int(gaps.max()) if len(gaps) else None,
        },
        "points": int(len(xyz)),
        "observations": int(n_obs),
        "mean_track_length": round(n_obs / max(len(xyz), 1), 3),
        "mean_point_error_px_from_mapper": round(float(err.mean()), 4) if len(err) else None,
        "mean_points_per_image": round(float(np.mean([im["points"] for im in images.values()])), 1),
        "intrinsics": intr,
        "coverage": {
            "camera_azimuth_bins_10deg": int(len(pos_bins)), "of": 36,
            "view_direction_bins_10deg": int(len(view_bins)),
            "camera_distance_to_room_middle": {"min": round(float(radius.min()), 3), "median": round(float(np.median(radius)), 3),
                                               "max": round(float(radius.max()), 3), "units": "COLMAP (not metric)"},
        },
    }
    if poses_json and poses_json.is_file():
        regs = [im for im in json.loads(poses_json.read_text())["images"] if im.get("registered") and im.get("reprojError") is not None]
        w = np.array([im["numObservations"] for im in regs], np.float64)
        e = np.array([im["reprojError"] for im in regs], np.float64)
        out["mean_reprojection_error_px"] = round(float((w * e).sum() / w.sum()), 4)
        out["per_group_reprojection_error_px"] = {
            g: round(float((w[m] * e[m]).sum() / w[m].sum()), 4)
            for g in sorted({im["group"] for im in regs})
            for m in [np.array([im["group"] == g for im in regs])]
        }
        out["worst_images_px"] = sorted(((im["name"], im["reprojError"]) for im in regs), key=lambda t: -t[1])[:5]
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("frames", type=Path)
    ap.add_argument("--poses", type=Path, help="poses.json from pipeline/recon/poses.py export")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    r = report(args.model, args.frames, args.poses)
    text = json.dumps(r, indent=1)
    if args.out:
        args.out.write_text(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
