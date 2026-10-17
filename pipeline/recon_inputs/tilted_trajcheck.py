#!/usr/bin/env python3
"""Checks a COLMAP model of a fly-through against the one thing the footage guarantees: the free camera moves
smoothly, at a near-constant speed, so consecutive frames of one continuous range sit close together.

  python tilted_trajcheck.py MODEL_DIR --frames frames.json [--out check.json] [--list suspects.txt]

Per range: the median speed (model units per second of video), every step that is faster than --jump x that
median (a frame placed at another spot), and runs of frames whose centres do not move at all while the video
does (a degenerate registration). A frame is suspect when both of its steps (to the previous and to the next
frame) are jumps, or when it sits in a frozen run, or when it belongs to the shorter side of a lone jump
(a block placed somewhere else). Writes the suspects' image names (one per line) for image_deleter.
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


def check(images: dict, meta: dict, jump: float, frozen_frac: float, frozen_min: int) -> dict:
    by = defaultdict(list)
    for im in images.values():
        r = meta.get(im["name"])
        if r:
            by[r["segment"]].append((r["time"], im["name"], im["center"]))
    speeds = []
    for s, v in by.items():
        v.sort()
        P = np.array([c for _, _, c in v])
        t = np.array([tt for tt, _, _ in v])
        if len(v) > 1:
            speeds += list(np.linalg.norm(np.diff(P, axis=0), axis=1) / np.maximum(np.diff(t), 0.05))
    vmed = float(np.median(speeds)) if speeds else 0.0
    report, suspects = {}, set()
    for s, v in sorted(by.items()):
        t = np.array([tt for tt, _, _ in v])
        names = [n for _, n, _ in v]
        P = np.array([c for _, _, c in v])
        n = len(v)
        if n < 2:
            report[s] = {"registered": n}
            continue
        dt = np.maximum(np.diff(t), 0.05)
        sp = np.linalg.norm(np.diff(P, axis=0), axis=1) / dt
        is_jump = sp > jump * vmed
        frozen = sp < frozen_frac * vmed
        bad = set()
        # frozen runs
        k = 0
        while k < n - 1:
            if frozen[k]:
                e = k
                while e < n - 1 and frozen[e]:
                    e += 1
                if e - k + 1 >= frozen_min:
                    bad.update(range(k, e + 1))
                k = e + 1
            else:
                k += 1
        # isolated frames: both neighbouring steps are jumps
        for i in range(1, n - 1):
            if is_jump[i - 1] and is_jump[i]:
                bad.add(i)
        # remaining lone jumps split the range: the shorter side is the misplaced block
        cuts = [i for i in range(n - 1) if is_jump[i] and i not in bad and (i + 1) not in bad]
        bounds = [0] + [c + 1 for c in cuts] + [n]
        pieces = [(bounds[q], bounds[q + 1]) for q in range(len(bounds) - 1)]
        if len(pieces) > 1:
            main = max(pieces, key=lambda ab: ab[1] - ab[0])
            for a, b in pieces:
                if (a, b) != main:
                    bad.update(range(a, b))
        for i in bad:
            suspects.add(names[i])
        report[s] = {"registered": n, "median_speed": round(float(np.median(sp)), 4),
                     "jumps": [[round(float(t[i]), 2), round(float(t[i + 1]), 2), round(float(sp[i] / vmed), 1)]
                               for i in np.nonzero(is_jump)[0]],
                     "suspect": [[names[i], round(float(t[i]), 2)] for i in sorted(bad)]}
    return {"median_speed": round(vmed, 5), "jump_factor": jump, "suspect_count": len(suspects),
            "segments": report, "suspects": sorted(suspects)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--list", type=Path)
    ap.add_argument("--jump", type=float, default=6.0)
    ap.add_argument("--frozen-frac", type=float, default=0.02)
    ap.add_argument("--frozen-min", type=int, default=4)
    a = ap.parse_args(argv)
    images = read_images(a.model / "images.bin")
    meta = {r["name"]: r for r in json.loads(a.frames.read_text())["images"]}
    doc = check(images, meta, a.jump, a.frozen_frac, a.frozen_min)
    doc["registered"] = len(images)
    if a.out:
        a.out.write_text(json.dumps(doc, indent=1))
    if a.list:
        a.list.write_text("".join(f"{n}\n" for n in doc["suspects"]))
    print(f"registered {len(images)}, median speed {doc['median_speed']}, suspects {doc['suspect_count']}")
    for s, r in doc["segments"].items():
        if r.get("jumps") or r.get("suspect"):
            print(f"  {s}: {r['registered']} reg, {len(r['jumps'])} jumps {r['jumps'][:6]}, suspect {len(r['suspect'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
