#!/usr/bin/env python3
"""Generative fill of one reconstructed world: world.spz in, world-filled.spz + genfill.json + evidence out.

  PYTHONPATH=pipeline python -m genfill.run --scene-dir SCENE --out OUT [--queue Q] [--images WORK/images]
         [--evidence EVID] [--gaps-only] [--max-regions 8] [--max-anchors 3] [--min-views 3] ...

The model worker (python -m genfill.models serve --queue Q) must run alongside unless --gaps-only.
Writes OUT/world-filled.spz, OUT/genfill.json, OUT/gaps.json, OUT/work/<anchor>/*.png and EVID/*.jpg:
  gaps-up-before.jpg / gaps-level-before.jpg   the worst probe views with holes (red) and smears (yellow)
  before-after-*.jpg                           the same views before | after (full SH render)
  r<region>a<anchor>.jpg                       render | mask | generated | after, per anchor
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "genfill"

from . import geom as G  # noqa: E402
from .fill import FillConfig, fill_anchor, plan_views  # noqa: E402
from .gaps import GapConfig, bins_for, contact, find, score_view, worst_views  # noqa: E402
from .gpu import GS, good_view_counts, render, say, to_u8  # noqa: E402
from .models import Client  # noqa: E402
from .optimize import Distill, OptConfig, optimize, prune, seen_psnr  # noqa: E402
from .world import label, load, load_image, save_jpg, sheet, write_json  # noqa: E402

import splat_io as sio  # noqa: E402


def gaps_json(gaps, world) -> dict:
    return {
        "world": world.world_file, "digest": world.digest, "config": gaps.cfg.__dict__,
        "spots": gaps.spots.tolist() if gaps.spots is not None else [],
        "views": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in vw.items()} for vw in gaps.views],
        "regions": gaps.regions,
        "summary": {
            "views": len(gaps.views),
            "meanHole": round(float(np.mean([v["hole"] for v in gaps.views])), 4) if gaps.views else 0,
            "meanLow": round(float(np.mean([v["low"] for v in gaps.views])), 4) if gaps.views else 0,
            "byPitch": {str(p): {"hole": round(float(np.mean([v["hole"] for v in gaps.views if v["pitch"] == p])), 4),
                                 "low": round(float(np.mean([v["low"] for v in gaps.views if v["pitch"] == p])), 4)}
                        for p in sorted({v["pitch"] for v in gaps.views})},
        },
    }


def view_scores(gs: GS, views: list[dict], k: G.Intr, gcfg: GapConfig) -> list[dict]:
    out = []
    for v in views:
        c2w = G.yaw_pitch_c2w(v["position"], v["yaw"], v["pitch"])
        _, alpha, _, hole, lowc = score_view(gs, c2w, k, gcfg)
        out.append({"hole": round(float(hole.mean()), 4), "low": round(float(lowc.mean()), 4)})
    return out


def before_after(gs0: GS, gs1: GS, views: list[dict], ids: list[int], k: G.Intr, gcfg: GapConfig, evid: Path, tag: str) -> list[dict]:
    rows, tiles = [], []
    for n, i in enumerate(ids):
        v = views[i]
        c2w = G.yaw_pitch_c2w(v["position"], v["yaw"], v["pitch"])
        b = to_u8(render(gs0, c2w, k)["rgb"])
        a = to_u8(render(gs1, c2w, k)["rgb"])
        _, _, _, h0, l0 = score_view(gs0, c2w, k, gcfg)
        _, _, _, h1, l1 = score_view(gs1, c2w, k, gcfg)
        p = v["position"]
        where = f"({p[0]:+.1f},{p[2]:+.1f}) yaw {v['yaw']:.0f} pitch {v['pitch']:+.0f}"
        pair = np.concatenate([label(b, f"BEFORE {where}  holes {h0.mean():.1%} smear {l0.mean():.1%}", 0.45),
                               np.full((b.shape[0], 6, 3), 255, np.uint8),
                               label(a, f"AFTER  holes {h1.mean():.1%} smear {l1.mean():.1%}", 0.45)], axis=1)
        name = f"before-after-{tag}-{n:02d}.jpg"
        save_jpg(evid / name, pair, quality=86)
        tiles.append(pair)
        rows.append({"view": i, "position": p, "yaw": v["yaw"], "pitch": v["pitch"], "file": name,
                     "before": {"hole": round(float(h0.mean()), 4), "low": round(float(l0.mean()), 4)},
                     "after": {"hole": round(float(h1.mean()), 4), "low": round(float(l1.mean()), 4)}})
    if tiles:
        small = [t[:: 2, :: 2] for t in tiles]
        save_jpg(evid / f"before-after-{tag}.jpg", sheet(small, cols=2), quality=84)
    return rows


def training_view_check(gs1: GS, distill: Distill) -> dict:
    """PSNR of the filled world against the original world's render from every training camera (what was seen)."""
    import torch

    ps = []
    for c2w, k, rgb8, a8 in distill.views:
        r = render(gs1, c2w, k)["rgb"]
        gt = rgb8.float() / 255.0
        mse = float(((r - gt) ** 2).mean())
        ps.append(-10 * math.log10(max(mse, 1e-10)))
    ps = np.array(ps)
    return {"views": len(ps), "meanPsnr": round(float(ps.mean()), 2), "minPsnr": round(float(ps.min()), 2),
            "p10Psnr": round(float(np.percentile(ps, 10)), 2)}


def photo_check(gs0: GS, gs1: GS, world, images: Path | None, max_photos: int = 40) -> dict | None:
    """PSNR against the real photos (people masked), before and after."""
    if images is None:
        return None
    photos = [c for c in world.cams if str(c.group).startswith("photo")][:max_photos]
    if not photos:
        photos = world.cams[:: max(1, len(world.cams) // 20)]
    rows = []
    for c in photos:
        rgb, m = load_image(images, c)
        if rgb is None:
            continue
        gt = rgb.astype(np.float64)
        row = {"name": c.name}
        for key, g in (("before", gs0), ("after", gs1)):
            r = to_u8(render(g, c.c2w, c.intr)["rgb"]).astype(np.float64)
            mse = float(np.mean((r[m] - gt[m]) ** 2)) / 255.0 ** 2
            row[key] = round(-10 * math.log10(max(mse, 1e-10)), 3)
        rows.append(row)
    if not rows:
        return None
    return {"photos": len(rows), "before": round(float(np.mean([r["before"] for r in rows])), 3),
            "after": round(float(np.mean([r["after"] for r in rows])), 3),
            "worstDrop": round(float(min(r["after"] - r["before"] for r in rows)), 3), "views": rows}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene-dir", required=True, type=Path)
    ap.add_argument("--world-file", default=None)
    ap.add_argument("--cameras", type=Path, default=None)
    ap.add_argument("--images", type=Path, default=None, help="training images (the recon work folder's images/)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--evidence", type=Path, default=None)
    ap.add_argument("--queue", type=Path, default=None)
    ap.add_argument("--gaps-only", action="store_true")
    ap.add_argument("--scene-text", default=None, help="what the place is (else the scene caption)")
    ap.add_argument("--min-views", type=int, default=3)
    ap.add_argument("--grazing-cos", type=float, default=0.17)
    ap.add_argument("--view-angle", type=float, default=40.0, help="a splat counts as seen only within this angle of a good view")
    ap.add_argument("--spacing", type=float, default=1.2)
    ap.add_argument("--eye", type=float, default=1.6)
    ap.add_argument("--coverage", type=float, default=3.0)
    ap.add_argument("--max-regions", type=int, default=8)
    ap.add_argument("--max-anchors", type=int, default=6)
    ap.add_argument("--steps", type=int, default=32, help="editor sampling steps")
    ap.add_argument("--quick-steps", type=int, default=150)
    ap.add_argument("--final-steps", type=int, default=1200)
    ap.add_argument("--distill-scale", type=float, default=0.33)
    ap.add_argument("--max-distill", type=int, default=200)
    ap.add_argument("--no-photo", action="store_true")
    ap.add_argument("--tilts", default="30,55,80", help="pitches each anchor sequence steps through")
    ap.add_argument("--sequences", type=int, default=8)
    ap.add_argument("--near-cam", type=float, default=1.2)
    ap.add_argument("--replace-above", action="store_true", help="replace every old splat the fill covers where the footage never looked")
    ap.add_argument("--from-spots", action="store_true", help="anchors at probe spots near the camera path instead of at the cameras")
    ap.add_argument("--night", action="store_true", help="the capture is at night (no daylight skies; dark sky is left to the viewer)")
    ap.add_argument("--ceiling", default="none", help="none | auto (the dominant overhead plane) | a height in metres")
    ap.add_argument("--ceiling-mode", action="store_true", help="repaint only the ceiling, onto its plane (needs --ceiling)")
    ap.add_argument("--replace-photo-splats", action="store_true", help="ceiling mode: also remove streaks the photos show")
    ap.add_argument("--time-budget", type=float, default=2700.0, help="stop starting new regions after this many seconds")
    a = ap.parse_args(argv)
    T0 = time.time()
    out = a.out
    out.mkdir(parents=True, exist_ok=True)
    evid = a.evidence or out / "evidence"
    evid.mkdir(parents=True, exist_ok=True)

    world = load(a.scene_dir, a.world_file, a.cameras)
    say(f"{world.scene.get('id')}: {len(world.splats)} splats from {world.world_file} (digest {world.digest}), {len(world.cams)} training cameras")
    gs = GS(world.splats)
    gcfg = GapConfig(spacing=a.spacing, eye=a.eye, coverage=a.coverage, min_views=a.min_views, view_angle=a.view_angle)
    good_view_counts(gs, world.cams, bins_for(gcfg), grazing_cos=a.grazing_cos)
    gs0 = GS(world.splats)
    for key in ("conf", "bits", "best_cos", "normal", "flat", "maxw"):
        setattr(gs0, key, getattr(gs, key).clone())
    gaps = find(world, gs, gcfg)
    write_json(out / "gaps.json", gaps_json(gaps, world))
    np.savez_compressed(out / "gaps-points.npz", points=gaps.points.astype(np.float32), view=gaps.point_view,
                        kind=gaps.point_kind, label=gaps.labels)
    kev = G.intrinsics(640, 480, 90.0)
    up_ids = worst_views(gaps, 8, pitch_min=30)
    level_ids = worst_views(gaps, 8, pitch_max=10)
    save_jpg(evid / "gaps-up-before.jpg", contact(gs, gaps, up_ids, G.intrinsics(480, 360, 90.0), gcfg), quality=84)
    save_jpg(evid / "gaps-level-before.jpg", contact(gs, gaps, level_ids, G.intrinsics(480, 360, 90.0), gcfg), quality=84)
    say(f"gaps done in {time.time() - T0:.0f}s: {gaps_json(gaps, world)['summary']}")
    if a.gaps_only:
        return 0

    client = Client(a.queue or out / "queue")
    t_wait = time.time()
    if not client.wait_ready(["caption", "edit", "depth", "lama"], timeout=1500):
        say(f"model worker not ready: {client.status()}")
        return 2
    say(f"model worker ready (waited {time.time() - t_wait:.0f}s)")
    distill = Distill(gs, world.cams, a.distill_scale, a.max_distill)
    scene_text = a.scene_text or world.scene.get("caption") or world.scene.get("name") or "a real place"
    fcfg = FillConfig(max_regions=a.max_regions, max_anchors=a.max_anchors, steps=a.steps, quick_steps=a.quick_steps,
                      tilts=tuple(float(t) for t in a.tilts.split(",")), sequences=a.sequences, near_cam=a.near_cam,
                      replace_above=a.replace_above, from_cameras=not a.from_spots, night=a.night,
                      ceiling_mode=a.ceiling_mode, keep_photo_splats=not a.replace_photo_splats,
                      context_photo=not a.no_photo, scene_text=scene_text, deadline=T0 + a.time_budget)
    if a.ceiling == "auto":
        bmin, bmax = world.bounds
        cx = world.cam_xz()
        lo = np.minimum([bmin[0], bmin[2]], cx.min(0) if len(cx) else [bmin[0], bmin[2]]) - 2.0
        hi = np.maximum([bmax[0], bmax[2]], cx.max(0) if len(cx) else [bmax[0], bmax[2]]) + 2.0
        fcfg.ceiling = G.ceiling_height(gs.means.cpu().numpy(), gs.normal.cpu().numpy(), gs.opac.cpu().numpy(),
                                        gs.flat.cpu().numpy(), lo, hi, gcfg.eye + 0.5)
    elif a.ceiling not in ("", "none"):
        fcfg.ceiling = float(a.ceiling)
    say(f"ceiling plane: {fcfg.ceiling}")
    ocfg = OptConfig(steps=a.final_steps)
    targets, results = [], []
    plan = plan_views(world, gs, gaps, fcfg, gcfg)
    say(f"{len(plan)} anchor views planned: " + ", ".join(f"({v['position'][0]:+.1f},{v['position'][2]:+.1f}) y{v['yaw']:.0f} p{v['pitch']:+.0f}" for v in plan))
    for j, v in enumerate(plan):
        if time.time() > fcfg.deadline:
            say(f"time budget reached; {len(plan) - j} anchors left")
            break
        try:
            results.append(fill_anchor(world, gs, gaps, j, v, client, distill, targets, fcfg, gcfg, ocfg, out / "work", a.images))
        except Exception as e:  # one anchor failing must not lose the others
            import traceback

            traceback.print_exc()
            results.append({"anchor": j, "view": v, "error": f"{type(e).__name__}: {e}"})
    final = {}
    if targets:
        snap = gs.snapshot()
        before_final = seen_psnr(gs, distill)
        final["optimize"] = optimize(gs, targets, distill, ocfg, seed=7)
        final["prune"] = prune(gs, ocfg)
        after_final = seen_psnr(gs, distill)
        mse_b, mse_a = np.mean(10 ** (-before_final / 10)), np.mean(10 ** (-after_final / 10))
        if fcfg.accept_psnr > 0 and (mse_a > max(mse_b, 10 ** (-fcfg.accept_psnr / 10)) or after_final.min() < min(before_final.min(), fcfg.accept_min_psnr)):
            gs.restore(snap)  # the joint pass made the seen views worse: keep the per-anchor result
            final["reverted"] = True
    # old splats first, generated ones after them (genfill.json says where they start)
    import torch

    order = torch.cat([torch.nonzero(~gs.new)[:, 0], torch.nonzero(gs.new)[:, 0]])
    filled = gs.to_splats(order)
    n_old = int((~gs.new).sum())
    sio.write_spz(out / "world-filled.spz", filled)
    say(f"wrote {out / 'world-filled.spz'}: {len(filled)} splats ({len(filled) - n_old} generated), "
        f"{(out / 'world-filled.spz').stat().st_size / 1e6:.1f} MB")
    gs1 = GS(sio.read_spz(out / "world-filled.spz"))  # exactly what the viewer gets (SPZ quantisation included)
    for key in ("conf", "bits", "best_cos", "normal", "flat", "maxw"):
        getattr(gs1, key)[:n_old] = getattr(gs, key)[order[:n_old]]
    gs1.new[n_old:] = True
    checks = {"trainingViews": training_view_check(gs1, distill)}
    checks["photos"] = photo_check(gs0, gs1, world, a.images)
    rows_up = before_after(gs0, gs1, gaps.views, up_ids, kev, gcfg, evid, "up")
    rows_level = before_after(gs0, gs1, gaps.views, level_ids, kev, gcfg, evid, "level")
    after_all = view_scores(gs1, gaps.views, G.intrinsics(gcfg.width, gcfg.height, gcfg.hfov), gcfg)
    for r in results:
        if not isinstance(r, dict) and r.files.get("panel"):
            src = Path(r.files["panel"])
            if src.exists():
                (evid / f"anchor-{r.index:02d}.jpg").write_bytes(src.read_bytes())

    def mean(key, rows):
        return round(float(np.mean([x[key] for x in rows])), 4) if rows else 0.0

    report = {
        "scene": world.scene.get("id"), "source": {"file": world.world_file, "digest": world.digest, "splats": len(world.splats)},
        "output": {"file": "world-filled.spz", "splats": len(filled), "generated": {"first": n_old, "count": len(filled) - n_old},
                   "removedOld": len(world.splats) - n_old},
        "probeViews": {"count": len(gaps.views),
                       "before": {"hole": mean("hole", gaps.views), "low": mean("low", gaps.views)},
                       "after": {"hole": mean("hole", after_all), "low": mean("low", after_all)},
                       "byPitch": {str(p): {"before": {"hole": mean("hole", [v for v in gaps.views if v["pitch"] == p]),
                                                       "low": mean("low", [v for v in gaps.views if v["pitch"] == p])},
                                            "after": {"hole": mean("hole", [s for s, v in zip(after_all, gaps.views) if v["pitch"] == p]),
                                                      "low": mean("low", [s for s, v in zip(after_all, gaps.views) if v["pitch"] == p])}}
                                   for p in gcfg.pitches}},
        "worstViews": {"up": rows_up, "level": rows_level},
        "checks": checks,
        "regions": [{k: v for k, v in r.items() if k in ("id", "kind", "mass", "centroid", "holeShare", "meanPitch")} for r in gaps.regions],
        "anchors": [r if isinstance(r, dict) else r.__dict__ for r in results],
        "final": final,
        "config": {"gaps": gcfg.__dict__, "fill": fcfg.__dict__, "optimize": ocfg.__dict__},
        "seconds": round(time.time() - T0, 1),
        "models": {"caption": "Qwen/Qwen2.5-VL-3B-Instruct", "edit": "Qwen/Qwen-Image-Edit-2511 (bf16)",
                   "depth": "depth-anything/Depth-Anything-V2-Metric-Indoor-Base-hf", "inpaint": "Big LaMa"},
    }
    write_json(out / "genfill.json", report)
    say(f"done in {report['seconds']:.0f}s: probe views hole {report['probeViews']['before']['hole']:.3f} -> {report['probeViews']['after']['hole']:.3f}, "
        f"smear {report['probeViews']['before']['low']:.3f} -> {report['probeViews']['after']['low']:.3f}; training views {checks['trainingViews']}; "
        f"photos {None if not checks['photos'] else {k: checks['photos'][k] for k in ('before', 'after', 'worstDrop')}}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
