#!/usr/bin/env python3
"""FlashWorld end to end on one GPU: every trajectory preset from the same photo, a text-only world, a warm rerun,
and one job through the warm worker. Writes per-preset outputs, 12-view look-around contact sheets and a summary
that ranks the presets by how complete the world is around the spawn.

  python hpg/smoke/smoke_flashworld.py --out DIR [--image photo.jpg] [--presets spin360,orbit360,pan180,forward]

Without --image it uses the room photo embedded in FlashWorld's examples/5.json.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))
sys.path.insert(0, str(REPO / "hpg"))
import flashworld_run as fw  # noqa: E402
import splat_io as sio  # noqa: E402


def example_photo(dst: Path) -> Path:
    from PIL import Image

    ex = Path(os.environ.get("FLASHWORLD_SRC", "")) / "examples" / "5.json"
    data = json.loads(ex.read_text())
    b64 = data["image_prompt"].split(",", 1)[1]
    Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB").save(dst)
    return dst


def evaluate(out: Path) -> dict:
    scene = json.loads((out / "scene.json").read_text())
    w = scene["world"]
    s = sio.read_spz(out / w["file"])
    look = sio.look_around(s, w["transform"], eye=(0.0, 1.6, 0.0), views=12, width=256, height=192)
    sio.save_jpeg(out / "sheet.jpg", sio.contact_sheet(look["images"], cols=6))
    down = sio.look_around(s, w["transform"], eye=(0.0, 1.6, 0.0), views=6, width=256, height=192, pitch_deg=-45)
    sio.save_jpeg(out / "sheet_down.jpg", sio.contact_sheet(down["images"], cols=6))
    diag = json.loads((out / "flashworld.json").read_text())
    return {
        "splats": w["splatCount"],
        "floorFound": w["floorY"] is not None,
        "scale": w["transform"]["scale"],
        "holesAround": round(look["meanHoles"], 4),
        "holesLookingDown": round(down["meanHoles"], 4),
        "holesPerView": [round(h, 3) for h in look["holes"]],
        "generateSeconds": diag.get("generateSeconds"),
        "totalSeconds": diag.get("totalSeconds"),
        "text": diag.get("text"),
        "captionSource": diag.get("captionSource"),
        "fp8Native": diag.get("fp8Native"),
        "spzMB": round((out / w["file"]).stat().st_size / 1e6, 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--image")
    ap.add_argument("--presets", default=",".join(fw.TRAJECTORIES))
    ap.add_argument("--prompt", default="A cozy wooden cabin living room with a stone fireplace, a sofa and warm lamps.")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    image = Path(args.image) if args.image else example_photo(out / "input.png")
    summary: dict = {"image": str(image), "runs": {}, "errors": {}}
    t0 = time.time()
    model = fw.get_model()
    model.load()
    summary["loadSeconds"] = round(time.time() - t0, 1)
    caption_text = None
    for i, preset in enumerate([p for p in args.presets.split(",") if p]):
        try:
            run_out = out / preset
            res = fw.generate(image, None, run_out, str(run_out / "progress.json"), trajectory_name=preset,
                              caption="auto" if caption_text is None else caption_text)
            ev = evaluate(run_out)
            caption_text = caption_text or ev["text"]
            summary["runs"][preset] = ev
            print(f"{preset}: {json.dumps(ev)}", flush=True)
        except Exception as e:
            traceback.print_exc()
            summary["errors"][preset] = f"{type(e).__name__}: {e}"
    try:  # warm rerun timing
        t1 = time.time()
        fw.generate(image, None, out / "warm", None, trajectory_name=fw.DEFAULT_TRAJECTORY, caption=caption_text or "auto", seed=1)
        summary["warmRunSeconds"] = round(time.time() - t1, 2)
    except Exception as e:
        summary["errors"]["warm"] = f"{type(e).__name__}: {e}"
    try:  # text to world
        fw.generate(None, args.prompt, out / "text", None)
        summary["runs"]["text"] = evaluate(out / "text")
    except Exception as e:
        traceback.print_exc()
        summary["errors"]["text"] = f"{type(e).__name__}: {e}"
    try:  # one job through the worker, in this process (the model is already loaded)
        import worker as W

        root = out / "worker-root"
        jd = root / "jobs" / "queue" / "smoke-job"
        (jd / "input").mkdir(parents=True, exist_ok=True)
        (jd / "input" / "00.png").write_bytes(Path(image).read_bytes())
        (jd / "job.json").write_text(json.dumps({"id": "smoke-job", "mode": "rentfree", "params": {}}))
        old = time.time() - 10
        os.utime(jd, (old, old))
        w = W.Worker(root, idle_timeout=5, poll=0.5, preload=False, settle=0)
        w.run(once=True)
        done = root / "jobs" / "done" / "smoke-job"
        summary["worker"] = {"done": (done / "DONE").exists(), "failed": (done / "FAILED").read_text() if (done / "FAILED").exists() else None,
                             "outputs": sorted(p.name for p in (done / "out").iterdir()) if (done / "out").exists() else []}
    except Exception as e:
        traceback.print_exc()
        summary["errors"]["worker"] = f"{type(e).__name__}: {e}"
    ranked = sorted((r["holesAround"], k) for k, r in summary["runs"].items() if k in fw.TRAJECTORIES)
    summary["rankedByCompleteness"] = [k for _, k in ranked]
    summary["totalSeconds"] = round(time.time() - t0, 1)
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "runs"}, indent=2))
    ok = bool(summary["runs"]) and not summary["errors"] and summary.get("worker", {}).get("done")
    print("flashworld smoke:", "ok" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
