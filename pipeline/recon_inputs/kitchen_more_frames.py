#!/usr/bin/env python3
"""More frames of the kitchen clip where the camera moves, added to an existing work folder (prep.py's decode).

  python pipeline/recon_inputs/kitchen_more_frames.py --work WORK --clip IMG_7410.mov --group cook \
      --track data/scenes/kitchen/IMG_7410-poses.json [--step 0.1] [--min-move 0.03] [--min-turn 2.0]

The first solve used 200 frames (one per 0.25 s window). The camera walked 17.7 m, so neighbouring frames were up
to ~20 cm apart. Here the clip is cut into --step windows; the sharpest frame of each window is a candidate
(skipped when much blurrier than the frames round it, as prep.pick_sharp); a candidate is kept when the camera
moved at least --min-move metres or turned --min-turn degrees from every frame already kept within 1 s (old frames
included, so the 200 frames stay as they are and nothing is duplicated). Motion comes from the solved per-frame
track of the clip (<clip>-poses.json `track`, room frame).

New frames are decoded exactly like the old ones: HDR signal, the group's stored exposureGain, prep.hdr_to_sdr,
JPEG 95 at the group's size; person masks with prep.person_masks (same settings) into masks/ and masks-person/
(kitchen_dynamic.py apply adds the object boxes once the frames have poses). frames.json gets the new image
records and videos.<group>.more (the selection report).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "recon"))

import prep  # noqa: E402
from util import Work, log, read_json, write_json  # noqa: E402


def say(msg: str) -> None:
    log("kitchen-more", msg)


def quat_angle_deg(q1: np.ndarray, q2: np.ndarray) -> float:
    d = abs(float(np.dot(q1 / np.linalg.norm(q1), q2 / np.linalg.norm(q2))))
    return float(np.degrees(2 * np.arccos(min(1.0, d))))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--clip", required=True, type=Path)
    ap.add_argument("--group", default="cook")
    ap.add_argument("--track", required=True, type=Path)
    ap.add_argument("--step", type=float, default=0.1)
    ap.add_argument("--min-move", type=float, default=0.03)
    ap.add_argument("--min-turn", type=float, default=2.0)
    ap.add_argument("--blur-ratio", type=float, default=0.55)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    work = Work(a.work)
    frames = read_json(work.frames)
    g = frames["groups"][a.group]
    W, H, gain = int(g["width"]), int(g["height"]), float(g["exposureGain"])
    old = {im["frameIndex"]: im for im in frames["images"] if im["group"] == a.group}
    say(f"{len(old)} frames of {a.group} already in {work.root}; gain {gain:.6f}, {W}x{H}")

    times = prep.frame_times(a.clip)
    t_rel = times - times[0]
    info = prep.probe(a.clip)
    w, h = info.width, info.height
    sw, sh = (640, int(round(640 * h / w / 2)) * 2) if w >= h else (int(round(640 * w / h / 2)) * 2, 640)
    sharp = np.array([prep.laplacian_var(fr) for _, fr in prep.decode_frames(a.clip, (sw, sh))], np.float64)
    n = min(len(sharp), len(t_rel))
    sharp, t_rel = sharp[:n], t_rel[:n]
    say(f"sharpness of {n} frames (median {np.median(sharp):.0f})")

    tr = read_json(a.track)["track"]
    P = np.array([r["position"] for r in tr], np.float64)
    Q = np.array([r["quaternion"] for r in tr], np.float64)

    edges = np.arange(0.0, t_rel[-1] + a.step, a.step)
    cands = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        idx = np.nonzero((t_rel >= lo) & (t_rel < hi))[0]
        if len(idx):
            cands.append(int(idx[np.argmax(sharp[idx])]))
    floor = 0.35 * float(np.median(sharp[cands]))
    kept = sorted(old)
    new, report = [], []
    for i in cands:
        near = np.nonzero(np.abs(t_rel - t_rel[i]) <= 0.5)[0]
        env = float(np.percentile(sharp[near], 90))
        sharp_ok = sharp[i] >= a.blur_ratio * env and sharp[i] >= floor
        rec = {"frameIndex": i, "time": round(float(t_rel[i]), 4), "sharpness": round(float(sharp[i]), 1), "sharpOk": bool(sharp_ok)}
        if i in old:
            rec["why"] = "old"
            report.append(rec)
            continue
        nb = [k for k in kept if abs(t_rel[k] - t_rel[i]) <= 1.0]
        if nb:
            mv = min(float(np.linalg.norm(P[i] - P[k])) for k in nb)
            tn = min(quat_angle_deg(Q[i], Q[k]) for k in nb)
            # distance in pose space: a frame is redundant only when it is close in both
            moved = min(max(float(np.linalg.norm(P[i] - P[k])) / a.min_move, quat_angle_deg(Q[i], Q[k]) / a.min_turn) for k in nb)
        else:
            mv, tn, moved = 9.0, 180.0, 99.0
        rec.update(moveM=round(mv, 3), turnDeg=round(tn, 2))
        if not sharp_ok:
            rec["why"] = "blurred"
        elif moved < 1.0:
            rec["why"] = "still"
        else:
            rec["why"] = "kept"
            new.append(i)
            kept.append(i)
            kept.sort()
        report.append(rec)
    say(f"{len(cands)} windows of {a.step}s: {len(new)} new frames "
        f"({sum(r['why'] == 'blurred' for r in report)} blurred, {sum(r['why'] == 'still' for r in report)} camera still)")
    if a.dry_run:
        print(json.dumps({"new": new}))
        return 0

    src = prep.hdr_source(a.clip)
    imgs = {}
    for i, sig in prep.decode_frames(a.clip, (W, H), keep=set(new), hdr_signal=True):
        imgs[i] = prep.hdr_to_sdr(sig, src.transfer, src.primaries, gain)
    order = [i for i in new if i in imgs]
    say(f"decoded {len(order)} frames (HDR {src.transfer}, gain {gain:.4f})")
    masks = prep.person_masks([imgs[i] for i in order]) if g.get("people") else [None] * len(order)
    from common.media import save_png

    recs = []
    for i, m in zip(order, masks):
        nm = f"{a.group}/f{i:06d}.jpg"
        prep.save_jpg(work.images / nm, imgs[i], quality=prep.JPEG_QUALITY)
        rec = {"name": nm, "group": a.group, "source": a.clip.name, "width": W, "height": H, "frameIndex": int(i),
               "time": round(float(t_rel[i]), 6), "sharpness": round(float(sharp[i]), 2), "added": "kitchen_more_frames"}
        if m is not None:
            save_png(work.mask_for(nm), m)
            pp = work.root / "masks-person" / f"{nm}.png"
            pp.parent.mkdir(parents=True, exist_ok=True)
            save_png(pp, m)
            rec["masked"] = round(float(np.mean(m == 0)), 4)
        recs.append(rec)
    frames["images"] += recs
    frames.setdefault("videos", {}).setdefault(a.group, {})["more"] = {
        "tool": "pipeline/recon_inputs/kitchen_more_frames.py", "step": a.step, "minMove": a.min_move, "minTurn": a.min_turn,
        "added": len(recs), "windows": report}
    write_json(work.frames, frames)
    write_json(work.root / f"{a.group}-more.json", {"new": [r["name"] for r in recs]})
    say(f"added {len(recs)} frames; {sum(1 for im in frames['images'] if im['group'] == a.group)} {a.group} frames in all")
    return 0


if __name__ == "__main__":
    sys.exit(main())
