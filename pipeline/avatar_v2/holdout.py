"""The baseline without the held-out frames: the fair reference for prototypes that never see them.

    python -m pipeline.avatar_v2.holdout --work WORK --eval EVAL --new-work NEW --video V --poses P --out-dir OUT [--world W]

NEW gets WORK's frames/ and masks/ (links) and a copy of hmr.npz without the detections of the held-out frames
(EVAL/heldout.json), so pipeline/avatar/run.py, unchanged, interpolates the motion over those frames and never
textures from them. Then run.py runs every step after the pose network (ground ... glb) into OUT.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np

from pipeline.avatar.util import log, read_json

PER_DETECTION = ("frame", "time", "conf", "shape", "bone_poses", "rest_bone_poses", "transl_pelvis", "j2d", "v3d", "trackfeat")


def make_work(work: Path, eval_dir: Path, new: Path) -> dict:
    new.mkdir(parents=True, exist_ok=True)
    for name in ("frames", "masks"):
        if not (new / name).exists():
            (new / name).symlink_to((work / name).resolve())
    if (work / "hmr.json").exists():
        shutil.copy(work / "hmr.json", new / "hmr.json")
    held = set(read_json(eval_dir / "heldout.json")["frames"])
    h = dict(np.load(work / "hmr.npz"))
    keep = ~np.isin(h["frame"], list(held))
    out = {k: (v[keep] if k in PER_DETECTION else v) for k, v in h.items()}
    np.savez(new / "hmr.npz", **out)
    rep = {"heldOutFrames": len(held), "detectionsDropped": int((~keep).sum()), "detectionsKept": int(keep.sum())}
    log("holdout", f"{new}: {rep}")
    return rep


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--eval", required=True)
    ap.add_argument("--new-work", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--poses", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--world", default=None)
    a = ap.parse_args(argv)
    make_work(Path(a.work), Path(a.eval), Path(a.new_work))
    from pipeline.avatar import run

    args = ["--work", a.new_work, "--video", a.video, "--poses", a.poses, "--out-dir", a.out_dir, "--people", "2",
            "--backview", "auto", "--fps", "30", "--start", "0", "--clip", "play",
            "--steps", "ground,body,offsets,texture,backview,fill,glb"]
    if a.world:
        args += ["--world", a.world]
    return run.main(args)


if __name__ == "__main__":
    sys.exit(main())
