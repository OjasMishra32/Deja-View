"""What the footage saw must not get worse: every training view of a filled world against the real image.

For each training camera (people masked), PSNR of the original world and of each candidate against the real image,
over the whole frame and over its top third (where ceilings and treetops are). Reports means, the per-view change and
the worst views, and saves photo | before | after panels of the views that changed most (both directions).

gsplat (flashworld env on HiPerGator):
  python -m genfill.evaluate --scene-dir <in> --images <work>/images --out <dir> --base world.spz \
         --cand ceiling=<a.spz> --cand palms=<b.spz> [--scale 0.5]
"""
from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

import numpy as np

from . import world as W
from .geom import Intr
from .gpu import GS, render, to_u8

import splat_io as sio  # noqa: E402


def psnr(a: np.ndarray, b: np.ndarray, m: np.ndarray) -> float:
    if m.sum() < 16:
        return float("nan")
    mse = float(np.mean((a[m].astype(np.float64) - b[m].astype(np.float64)) ** 2)) / 255.0 ** 2
    return -10 * math.log10(max(mse, 1e-10))


def main(argv=None) -> int:
    import cv2

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scene-dir", required=True)
    ap.add_argument("--images", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", required=True, help="the original world (path)")
    ap.add_argument("--cand", action="append", default=[], help="name=path of a candidate world")
    ap.add_argument("--scale", type=float, default=0.5)
    ap.add_argument("--panels", type=int, default=4)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    world = W.load(a.scene_dir)
    images = Path(a.images)
    worlds = {"base": GS(sio.read_splats(a.base))}
    for c in a.cand:
        name, path = c.split("=", 1)
        worlds[name] = GS(sio.read_splats(path))
    rows = []
    t0 = time.time()
    keep_imgs = {}
    for cam in world.cams:
        rgb, m = W.load_image(images, cam, masks=images.parent / "masks")
        if rgb is None:
            continue
        k: Intr = cam.intr.scaled(a.scale)
        gt = cv2.resize(rgb, (k.width, k.height), interpolation=cv2.INTER_AREA)
        mk = cv2.resize(m.astype(np.uint8), (k.width, k.height), interpolation=cv2.INTER_NEAREST) > 0
        top = np.zeros_like(mk)
        top[: k.height // 3] = True
        row = {"name": cam.name, "group": cam.group}
        rend = {}
        for name, gs in worlds.items():
            r = to_u8(render(gs, cam.c2w, k)["rgb"])
            rend[name] = r
            row[name] = round(psnr(r, gt, mk), 3)
            row[name + "_top"] = round(psnr(r, gt, mk & top), 3)
        rows.append(row)
        keep_imgs[cam.name] = (gt, rend)
        if len(keep_imgs) > 400:
            break
    say_t = time.time() - t0
    summary = {"views": len(rows), "seconds": round(say_t, 1), "scale": a.scale}
    for name in worlds:
        for suf in ("", "_top"):
            v = np.array([r[name + suf] for r in rows], np.float64)
            summary[name + suf] = round(float(np.nanmean(v)), 3)
        if name != "base":
            d = np.array([r[name] - r["base"] for r in rows])
            dt = np.array([r[name + "_top"] - r["base_top"] for r in rows])
            summary[name + "_delta"] = {"mean": round(float(np.nanmean(d)), 3), "min": round(float(np.nanmin(d)), 3),
                                        "p10": round(float(np.nanpercentile(d, 10)), 3), "max": round(float(np.nanmax(d)), 3),
                                        "top_mean": round(float(np.nanmean(dt)), 3), "top_min": round(float(np.nanmin(dt)), 3),
                                        "worse_by_0.5dB": int((d < -0.5).sum()), "better_by_0.5dB": int((d > 0.5).sum())}
            order = np.argsort(d)
            picks = list(order[: a.panels]) + list(order[::-1][: a.panels])
            for i in picks:
                r = rows[i]
                gt, rend = keep_imgs[r["name"]]
                pan = np.concatenate([W.label(gt, f"photo {r['name']}"),
                                      W.label(rend["base"], f"before {r['base']:.2f} dB"),
                                      W.label(rend[name], f"{name} {r[name]:.2f} dB")], 1)
                tag = "worst" if i in order[: a.panels] else "best"
                W.save_jpg(out / f"{name}-{tag}-{r['name'].replace('/', '_')}", pan, quality=80)
    W.write_json(out / "evaluate.json", {"summary": summary, "rows": rows})
    print(summary, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
