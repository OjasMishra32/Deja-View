"""Keeps fitted people out of a measured piece of furniture (the Game Lawn's foosball cabinet).

A body's distance from a single moving camera is its least certain coordinate, so a player standing at the table can
end up a few centimetres inside the cabinet. For every keyframe the posed body (every 3rd vertex, hands left out:
they hold the handles over the rim) is tested against the cabinet box (features.json foosballTable: the rim's
midline box grown by `wall`, from `bottom` up to the rim). Where it intersects, the whole body moves along its
recording camera's ray (towards the camera: the picture stays where it was, only the depth changes) by the smallest
step that clears it (+ `margin`); when the ray runs nearly along the cabinet (a step over `max_ray` would be needed),
it moves straight out of the nearest long side instead. The steps are max-filtered and smoothed over time so the
body glides instead of popping.

    python -m pipeline.avatar.keepout --work WORK [--fit photofit] --poses POSES --features features.json --out-dir OUT
        (rewrites WORK/<fit>/tracks.npz's root positions into WORK/<fit>-keepout/ and builds the GLBs from there)
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar.util import log, read_json, write_json


def cabinet_box(feat: dict, wall: float = 0.04, bottom: float = 0.45) -> dict:
    t = feat["foosballTable"]
    c = np.asarray(t["centre"], np.float64)
    ax = np.asarray(t["longAxis"], np.float64)
    ax /= np.linalg.norm(ax)
    side = np.cross([0.0, 1.0, 0.0], ax)
    side /= np.linalg.norm(side)
    corners = np.asarray(t["corners"], np.float64)
    ls = (corners - c) @ ax
    ws = (corners - c) @ side
    half_l = max(float(np.abs(ls).max()), 1.31 / 2) + wall
    half_w = max(float(np.abs(ws).max()), 0.718 / 2) + wall
    return {"centre": c, "long": ax, "side": side, "halfL": half_l, "halfW": half_w, "y0": bottom,
            "y1": float(t.get("rimHeight", 0.877))}


def inside(V: np.ndarray, box: dict) -> np.ndarray:
    d = V - box["centre"]
    return ((np.abs(d @ box["long"]) < box["halfL"]) & (np.abs(d @ box["side"]) < box["halfW"])
            & (V[:, 1] > box["y0"]) & (V[:, 1] < box["y1"]))


def clear_step(V: np.ndarray, d: np.ndarray, box: dict, smax: float, margin: float) -> float | None:
    """Smallest s in [0, smax] with no vertex of V + s d inside the box (+ margin), or None."""
    if not inside(V, box).any():
        return 0.0
    hi = smax
    if inside(V + hi * d, box).any():
        return None
    lo = 0.0
    for _ in range(20):
        mid = 0.5 * (lo + hi)
        if inside(V + mid * d, box).any():
            lo = mid
        else:
            hi = mid
    return hi + margin


def camera_positions(poses: dict, times: np.ndarray, start: float) -> np.ndarray:
    tr = poses["track"]
    t = np.array([float(s["time"]) for s in tr])
    P = np.array([s["position"] for s in tr], np.float64)
    idx = np.clip(np.searchsorted(t, times + start), 0, len(t) - 1)
    return P[idx]


def keepout(asset, tracks: dict, k: int, cams: np.ndarray, box: dict, margin: float = 0.02, max_ray: float = 0.35,
            sigma: float = 2.0, stride: int = 3) -> tuple[np.ndarray, dict]:
    from scipy.ndimage import gaussian_filter1d, maximum_filter1d

    from pipeline.avatar.body import PART_NAMES, lbs
    from pipeline.avatar.ground import forward
    from pipeline.avatar.util import quat_to_mat

    pre = f"person-{k}/"
    root_p = tracks[pre + "root_p"].astype(np.float64)
    root_q, delta_q = tracks[pre + "root_q"], tracks[pre + "delta_q"]
    hands = np.isin(asset.vert_part, [PART_NAMES.index("hand.L"), PART_NAMES.index("hand.R")])
    ids = np.nonzero(~hands)[0][::stride]
    W, J, rest = asset.weights[ids].astype(np.float64), asset.joints[ids].astype(np.int64), asset.positions[ids]
    n = len(root_p)
    step = np.zeros((n, 3))
    before = np.zeros(n, int)
    for i in range(n):
        G0 = np.eye(4)
        G0[:3, :3] = quat_to_mat(root_q[i])
        G0[:3, 3] = root_p[i]
        G = forward(quat_to_mat(delta_q[i:i + 1]), asset.rest_bone_poses, asset.bone_parents, root=G0[None])[0]
        V = lbs(rest, W, J, G, asset.rest_bone_poses)
        before[i] = int(inside(V, box).sum())
        if not before[i]:
            continue
        ray = cams[i] - root_p[i]
        ray[1] = 0.0  # stay on the floor: the horizontal part of the ray
        ray /= max(np.linalg.norm(ray), 1e-9)
        s = clear_step(V, ray, box, max_ray, margin)
        if s is not None:
            step[i] = s * ray
            continue
        sgn = np.sign((root_p[i] - box["centre"]) @ box["side"]) or 1.0
        s = clear_step(V, sgn * box["side"], box, 1.0, margin)
        step[i] = (s or 0.0) * sgn * box["side"]
    mag = np.linalg.norm(step, axis=1)
    if mag.any():
        # keep the direction of the nearest corrected keyframe, the size max-filtered then smoothed
        dirs = np.where(mag[:, None] > 0, step / np.maximum(mag[:, None], 1e-9), 0.0)
        nz = np.nonzero(mag)[0]
        near = nz[np.clip(np.searchsorted(nz, np.arange(n)), 0, len(nz) - 1)]
        prev = nz[np.clip(np.searchsorted(nz, np.arange(n)) - 1, 0, len(nz) - 1)]
        pick = np.where(np.abs(prev - np.arange(n)) < np.abs(near - np.arange(n)), prev, near)
        dirs = dirs[pick]
        m2 = gaussian_filter1d(maximum_filter1d(mag, size=int(2 * sigma + 1)), sigma)
        m2 = np.maximum(m2, mag)
        step = dirs * m2[:, None]
    new_p = root_p + step
    after = np.zeros(n, int)
    for i in np.nonzero(before)[0]:
        G0 = np.eye(4)
        G0[:3, :3] = quat_to_mat(root_q[i])
        G0[:3, 3] = new_p[i]
        G = forward(quat_to_mat(delta_q[i:i + 1]), asset.rest_bone_poses, asset.bone_parents, root=G0[None])[0]
        after[i] = int(inside(lbs(rest, W, J, G, asset.rest_bone_poses), box).sum())
    rep = {"keyframes": n, "intersectingBefore": int((before > 0).sum()), "intersectingAfter": int((after > 0).sum()),
           "verticesInsideMaxBefore": int(before.max()), "verticesInsideMaxAfter": int(after.max()),
           "stepCm": {"max": round(float(np.linalg.norm(step, axis=1).max()) * 100, 1),
                      "median": round(float(np.median(np.linalg.norm(step, axis=1))) * 100, 2),
                      "movedFraction": round(float((np.linalg.norm(step, axis=1) > 1e-4).mean()), 3)}}
    return new_p.astype(tracks[pre + "root_p"].dtype), rep


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--fit", default="photofit")
    ap.add_argument("--poses", required=True, type=Path)
    ap.add_argument("--features", required=True, type=Path)
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--start", type=float, default=0.0)
    a = ap.parse_args(argv)
    from pipeline.avatar.body import Asset
    from pipeline.avatar.run import step_glb

    src = a.work / a.fit
    dst = a.work / f"{a.fit}-keepout"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    tracks = dict(np.load(src / "tracks.npz"))
    box = cabinet_box(json.loads(a.features.read_text()))
    poses = json.loads(a.poses.read_text())
    reps = {}
    assets = []
    k = 0
    while (src / f"asset-{k}.npz").exists():
        asset = Asset.load(src / f"asset-{k}.npz")
        assets.append(asset)
        cams = camera_positions(poses, tracks[f"person-{k}/times"].astype(np.float64), a.start)
        tracks[f"person-{k}/root_p"], reps[f"person-{k}"] = keepout(asset, tracks, k, cams, box)
        log("keepout", f"person {k}: {reps[f'person-{k}']}")
        k += 1
    np.savez_compressed(dst / "tracks.npz", **tracks)
    write_json(dst / "keepout.json", {"box": {kk: (v.tolist() if isinstance(v, np.ndarray) else v) for kk, v in box.items()},
                                      "people": reps})
    run = read_json(a.out_dir / "avatar.json", {}) or {}
    meta = {kk: v for kk, v in run.items() if kk not in ("people", "sceneAddition")}
    meta["perPerson"] = [dict({kk: v for kk, v in p.items() if kk not in ("id", "file", "bytes", "vertices", "triangles",
                                                                         "joints", "animatedJoints", "tracks", "keyframes",
                                                                         "timeRange", "texture", "phenotype", "pelvisStart")},
                              keepout=reps.get(p.get("id"))) for p in run.get("people", [])]
    # the glb step reads <work>/photofit/tex-<k>.jpg for mode "photofit": point it at the copy
    work2 = a.work / f"_keepout-{a.fit}"
    work2.mkdir(exist_ok=True)
    link = work2 / "photofit"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(dst)
    step_glb(work2, a.out_dir, assets, tracks, "photofit", meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
