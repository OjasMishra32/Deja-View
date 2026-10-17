#!/usr/bin/env python3
"""Run the reconstruction loop (team/shivin-reconstruction-loop.md, deliverable 2). GPU; run it on PACE.

    python pipeline/objects/loop/run.py --scene data/scenes/kitchen --object stove
    python pipeline/objects/loop/run.py --scene data/scenes/kitchen --object all --parallel 2 --budget 14
    python pipeline/objects/loop/run.py --scene data/scenes/kitchen --room

Per object: evaluate the current GLB (the baseline row), then 10-15 trials of bake + held-out evaluation chosen by
successive halving (512 px, then the best four at 768, then the best two at 1024 with a 2048 atlas), stopping early
after three trials without improvement. Objects run in waves of `--parallel` on one GPU; the bandit prior
(`<out>/prior.json`) is shared between waves, so later objects start from what earlier ones learned.

Writes `<out>/<id>/loop.json` (every trial: configuration, metrics, score, runtime, SHA1; the Pareto front; the
recommendation), `<out>/<id>/best/roblox.glb` with its `eval.json`, and `<out>/loop-summary.json`. Default out is
`<scene>/objects-loop`, never `<scene>/objects`: the approved fridge and every approval stay as they are. Each best
GLB is a new file with a new SHA1 and needs a person's approval before any upload.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from objects.detail.flat import classify  # noqa: E402
from objects.detail.objects_io import ObjectBox, load_objects, objects_file, pick  # noqa: E402
from objects.eval import evaluate as E  # noqa: E402
from objects.loop import search  # noqa: E402
from objects.loop.space import CURRENT_LIKE, ROOM_SPACE, SPACE, Config, legal, rung_settings  # noqa: E402

LOOP_FILE = "loop.json"
PRIOR_FILE = "prior.json"


def summarise(res: dict) -> dict:
    """The per-trial record: the robust metrics and gates without the per-view rows."""
    keep = ("score", "sha1", "bytes", "iou", "depthMAE", "psnr", "ssim", "normalCos", "surface", "sharpness",
            "scoreTerms", "atlas", "chunks", "views")
    out = {k: res.get(k) for k in keep}
    out["triangles"] = res["mesh"]["triangles"]
    out["holesPer1000"] = res["mesh"]["holesPer1000"]
    out["watertight"] = res["mesh"]["watertight"]
    out["gates"] = {k: {"pass": v["pass"], "reason": v.get("reason")} for k, v in res["gates"].items()
                    if isinstance(v, dict)}
    out["gatesPass"] = res["gates"]["pass"]
    return out


def recommend(current: dict | None, best: dict | None) -> str:
    if best is None:
        return "No trial produced a usable mesh; see the errors in the trial table."
    c = best["config"]
    diff = [f"{k} {CURRENT_LIKE[k]} -> {c[k]}" for k in c if k in CURRENT_LIKE and c[k] != CURRENT_LIKE[k]]
    lines = [f"Best: trial {best['n']} (rung {best['rung']}), score {best['score']}"
             + (f" vs current {current['score']}" if current and current.get("score") is not None else "") + "."]
    lines.append("Changed from the current bake: " + (", ".join(diff) if diff else "nothing (the current settings won)")
                 + ".")
    if current and current.get("scoreTerms") and best.get("scoreTerms"):
        d = {k: best["scoreTerms"][k] - current["scoreTerms"].get(k, 0) for k in best["scoreTerms"]}
        gains = sorted(d.items(), key=lambda kv: -kv[1])[:3]
        lines.append("Why: " + ", ".join(f"{k} {v:+.2f}" for k, v in gains if v > 0) + ".")
    weak = sorted((best.get("scoreTerms") or {}).items(), key=lambda kv: kv[1])[:2]
    fails = [f"{k}: {g['reason']}" for k, g in best.get("gates", {}).items() if not g["pass"]]
    lines.append("Still failing: " + ("; ".join(fails) if fails else "no hard gate") + "; weakest terms "
                 + ", ".join(f"{k} {v:.2f}" for k, v in weak) + f"; worst view IoU {best['iou']['worst']}.")
    lines.append(f"New file sha1 {best['sha1']}: it needs a person's approval before any upload.")
    return " ".join(lines)


def run_object(scene_dir: str, box: ObjectBox, out_root: str, prior_stats: dict, budget: int, seed: int,
               device: str | None, scan: bool, room: bool = False) -> dict:
    """One episode (runs in a worker process). Returns the loop record and the prior's updated stats."""
    from objects import scene as obj_scene
    from objects.loop.bake import bake_object
    from objects.loop.room import bake_room

    scene_dir, out_root = Path(scene_dir), Path(out_root)
    out = out_root / box.id
    out.mkdir(parents=True, exist_ok=True)
    log_lines: list[str] = []

    def log(msg: str) -> None:
        log_lines.append(msg)
        print(f"[{box.id}] {msg}", flush=True)

    refs = E.held_out_refs(scene_dir / "views", box, None if room else (scene_dir / "masks-all"
                                                                         if (scene_dir / "masks-all").exists() else None))
    current = None
    cur_glb = scene_dir / "roblox.glb" if room else scene_dir / "objects" / box.id / "roblox.glb"
    if cur_glb.exists() and refs:
        res = E.evaluate_glb(cur_glb, refs, E.scan_glb(cur_glb, out / "current") if scan else None,
                             out / "current" / E.SHEET_FILE)
        current = summarise(res)
    splats, scene = (None, None) if room else obj_scene.load_scene(scene_dir)
    if room:
        kind = "room"
    else:
        inside = np.all((splats.means >= box.lo) & (splats.means <= box.hi), axis=1)
        kind = classify(box.size, box.label, splats.means[inside] if inside.sum() >= 50 else None)
    space = ROOM_SPACE if room else SPACE

    run_id = time.strftime("%Y%m%d-%H%M%S")  # a re-run never overwrites an earlier run's trials
    count = [0]

    def trial(c: Config, rung: int) -> dict:
        size, atlas = rung_settings(rung)
        count[0] += 1
        tdir = out / "trials" / run_id / f"{count[0]:02d}"
        t0 = time.time()
        try:
            if room:
                b = bake_room(scene_dir, tdir, c, face_res=size, atlas=atlas, device=device, log=log)
            else:
                b = bake_object(scene_dir, box, c, size, atlas, tdir, kind, device, splats, scene, log)
            res = E.evaluate_glb(Path(b["glb"]), refs, E.scan_glb(Path(b["glb"]), tdir) if scan else None,
                                 tdir / E.SHEET_FILE)
            rec = {**summarise(res), "seconds": round(time.time() - t0, 1), "dir": str(tdir),
                   "bakeSeconds": b.get("bakeSeconds")}
            if room:
                rec["budgets"], rec["ceilingTriangles"] = b["budgets"], b["ceilingTriangles"]
            (tdir / E.EVAL_FILE).write_text(json.dumps(res, indent=2))
            return rec
        except Exception as e:  # noqa: BLE001  (a failed bake is a data point, not the end of the episode)
            return {"score": None, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 1),
                    "dir": str(tdir)}

    prior = search.Prior(prior_stats)
    seeds = [legal(Config(**{**CURRENT_LIKE, **({"voxel": 0.015} if room else {})}), kind, space)]
    ep = search.run_episode(trial, kind, prior, budget=budget, seed=seed, space=space, seeds=seeds, log=log)
    best = ep["best"]
    if best is not None:
        bdir = out / "best"
        if bdir.exists():
            shutil.rmtree(bdir)
        shutil.copytree(best["dir"], bdir)
        best = {**best, "glb": str(bdir / "roblox.glb")}
    record = {"id": box.id, "label": box.label, "kind": kind, "current": current, **ep, "best": best,
              "recommendation": recommend(current, best), "references": len(refs)}
    (out / LOOP_FILE).write_text(json.dumps(record, indent=2))
    return {"record": record, "prior": prior.stats}


def room_box(scene_dir: Path) -> ObjectBox:
    """The room as an evaluation box: the walk area, floor to 15 cm under the ceiling (so ceiling pixels never count)."""
    import roblox_mesh as rm

    from objects.loop.room import LID_BAND

    r = rm.load_room(scene_dir)
    S = 3.57
    ceil = (r.voxel_map.get("ceilingY") or r.hi[1] * S) / S
    lo = np.array([r.lo[0], -0.05, r.lo[2]])
    hi = np.array([r.hi[0], ceil - LID_BAND, r.hi[2]])
    return ObjectBox("room", "room", (lo + hi) / 2, (hi - lo) / 2, {})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--object", action="append", default=None)
    ap.add_argument("--objects", default=None)
    ap.add_argument("--room", action="store_true", help="run the loop on the room shell (no ceilings)")
    ap.add_argument("--out", default=None, help="default <scene>/objects-loop")
    ap.add_argument("--budget", type=int, default=14)
    ap.add_argument("--parallel", type=int, default=1, help="objects at once on the GPU")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default=None)
    ap.add_argument("--no-scan", action="store_true")
    a = ap.parse_args(argv)
    scene = Path(a.scene)
    out_root = Path(a.out) if a.out else scene / "objects-loop"
    if out_root.resolve() == (scene / "objects").resolve():
        raise SystemExit("refusing to write into the current objects set")
    out_root.mkdir(parents=True, exist_ok=True)
    boxes = [room_box(scene)] if a.room else pick(load_objects(objects_file(scene, a.objects)), a.object)
    prior = search.Prior.load(out_root / PRIOR_FILE)
    records = []
    for i in range(0, len(boxes), max(1, a.parallel)):
        wave = boxes[i:i + max(1, a.parallel)]
        args = [(str(scene), b, str(out_root), json.loads(json.dumps(prior.stats)), a.budget, a.seed + i + k, a.device, not a.no_scan, a.room)
                for k, b in enumerate(wave)]
        if len(wave) == 1:
            results = [run_object(*args[0])]
        else:
            with ProcessPoolExecutor(max_workers=len(wave)) as pool:
                results = list(pool.map(run_object, *zip(*args)))
        base = json.loads(json.dumps(prior.stats))  # what every worker in this wave started from
        for r in results:
            records.append(r["record"])
            for ctx, knobs in r["prior"].items():  # add each worker's new trials on top
                for knob, vals in knobs.items():
                    for v, (n, s) in vals.items():
                        b = base.get(ctx, {}).get(knob, {}).get(v, [0, 0.0])
                        arm = prior.arm(ctx, knob, json.loads(v))
                        arm[0] += n - b[0]
                        arm[1] += s - b[1]
        prior.save(out_root / PRIOR_FILE)
    summary = [{"id": r["id"], "kind": r["kind"], "current": (r["current"] or {}).get("score"),
                "best": (r["best"] or {}).get("score"), "bestTrial": (r["best"] or {}).get("n"),
                "trials": len(r["trials"]), "stopped": r["stopped"], "recommendation": r["recommendation"]}
               for r in records]
    (out_root / "loop-summary.json").write_text(json.dumps(summary, indent=2))
    for s in summary:
        print(f"{s['id']:<14} current {s['current']} -> best {s['best']} (trial {s['bestTrial']}, {s['trials']} trials, "
              f"{s['stopped']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
