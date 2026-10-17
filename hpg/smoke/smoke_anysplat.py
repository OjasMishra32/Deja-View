#!/usr/bin/env python3
"""AnySplat end to end on one GPU, using AnySplat's own example photos (or frames of one of its example videos).

  python hpg/smoke/smoke_anysplat.py --out DIR [--images DIR | --video FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))
import anysplat_run as asr  # noqa: E402
import splat_io as sio  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--images")
    ap.add_argument("--video")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    src = Path(os.environ.get("ANYSPLAT_SRC", ""))
    images, video = args.images, args.video
    if not images and not video:
        cand = src / "examples" / "vrnerf" / "riverview"
        if cand.is_dir():
            images = str(cand)
        else:
            video = str(src / "examples" / "video" / "vrnerf_kitchen.mp4")
    summary: dict = {"images": images, "video": video}
    t0 = time.time()
    try:
        res = asr.generate(images, video, out / "photos" if images else out / "video", None, write_spz=True)
        run = out / ("photos" if images else "video")
        w = res["world"]
        s = sio.read_splats(run / w["file"])
        look = sio.look_around(s, w["transform"], eye=(0.0, 1.6, 0.0), views=12)
        sio.save_jpeg(run / "sheet.jpg", sio.contact_sheet(look["images"], cols=6))
        diag = json.loads((run / "anysplat.json").read_text())
        summary.update({"ok": True, "world": w, "holesAround": round(look["meanHoles"], 4), "diag": diag})
    except Exception as e:
        traceback.print_exc()
        summary.update({"ok": False, "error": f"{type(e).__name__}: {e}"})
    summary["seconds"] = round(time.time() - t0, 1)
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    print(json.dumps(summary, indent=2, default=str))
    print("anysplat smoke:", "ok" if summary["ok"] else "FAIL")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
