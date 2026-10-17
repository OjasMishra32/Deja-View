#!/usr/bin/env python3
"""Cross-checks the camera centres of a global COLMAP model against per-range models built only from
time-adjacent pairs (which cannot be pulled to another copy of a repeated building), and lists the frames to drop.

  python tilted_validate.py GLOBAL_MODEL --ranges SPARSE_NEAR_DIR --frames frames.json --out validate.json \
      --delete delete.txt

For every per-range model, the global centres of the same frames are fitted to it with a RANSAC similarity
(threshold --thr half-second steps of the global model). A frame is kept when both models agree on where it was;
it is dropped when they disagree. Frames that no per-range model holds are judged by the trajectory check alone
(tilted_trajcheck: jumps against the near-constant flying speed).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tilted_coverage import read_images  # noqa: E402
from tilted_merge import ransac_sim3  # noqa: E402
from tilted_trajcheck import check  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--ranges", type=Path, required=True)
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--delete", type=Path, required=True)
    ap.add_argument("--thr", type=float, default=1.5)
    a = ap.parse_args(argv)
    rng = np.random.default_rng(0)
    meta = {r["name"]: r for r in json.loads(a.frames.read_text())["images"]}
    G = read_images(a.model / "images.bin")
    gc = {im["name"]: im["center"] for im in G.values()}
    traj = check(G, meta, 6.0, 0.02, 4)
    step = traj["median_speed"] * 0.5
    verdict = {}
    fits = []
    for d in sorted(p for p in a.ranges.iterdir() if (p / "images.bin").exists()):
        L = read_images(d / "images.bin")
        lc = {im["name"]: im["center"] for im in L.values()}
        common = sorted(set(lc) & set(gc))
        if len(common) < 6:
            continue
        A = np.array([lc[n] for n in common])
        B = np.array([gc[n] for n in common])
        r = ransac_sim3(A, B, a.thr * step, 2000, rng)
        if r is None:
            continue
        s, R, t, inl = r
        err = np.linalg.norm((s * (R @ A.T)).T + t - B, axis=1) / step
        for n, e, ok in zip(common, err, inl):
            verdict[n] = {"model": d.name, "err_steps": round(float(e), 2), "agree": bool(ok)}
        segs = sorted({meta[n]["segment"] for n in common})
        fits.append({"model": d.name, "segments": segs, "common": len(common), "agree": int(inl.sum())})
        print(f"range model {d.name} {segs}: {len(common)} shared frames, {int(inl.sum())} agree", flush=True)
    suspects = set(traj["suspects"])
    drop, kept_unverified = [], []
    for n in gc:
        v = verdict.get(n)
        if v is not None:
            if not v["agree"]:
                drop.append(n)
        elif n in suspects:
            drop.append(n)
        else:
            kept_unverified.append(n)
    by = defaultdict(lambda: [0, 0])
    for n in gc:
        by[meta[n]["segment"]][0] += 1
        if n in drop:
            by[meta[n]["segment"]][1] += 1
    doc = {"model": str(a.model), "registered": len(gc), "step": step, "fits": fits, "drop": sorted(drop),
           "kept_unverified": sorted(kept_unverified), "per_segment_registered_dropped": dict(sorted(by.items())),
           "verdict": verdict}
    a.out.write_text(json.dumps(doc, indent=1))
    a.delete.write_text("".join(f"{n}\n" for n in sorted(drop)))
    print(f"global model {len(gc)} frames: drop {len(drop)}, unverified kept {len(kept_unverified)}", flush=True)
    print("per segment (registered, dropped):", dict(sorted(by.items())), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
