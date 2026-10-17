#!/usr/bin/env python3
"""Render a ring of RGB views from a scene's splat world.

    python pipeline/objects/render_views.py --scene data/scenes/kitchen --out data/scenes/kitchen/views

Writes `view_XX.png` and `views.json` (camera-to-world, intrinsics, size). The same
camera model is used by `build.py`, so a mask lifted from a view lands on the right
splats. With a GPU, gsplat renders; elsewhere the CPU point renderer is the fallback.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import splat_io as sio  # noqa: E402
from objects import scene as obj_scene  # noqa: E402

VIEWS_FILE = "views.json"


def render_scene(
    scene_dir: str | Path,
    out_dir: str | Path,
    count: int = 12,
    width: int = 640,
    height: int = 480,
    fov: float = 60.0,
    prefer_gpu: bool = True,
    log=print,
) -> dict:
    scene_dir = Path(scene_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    splats, scene = obj_scene.load_scene(scene_dir)
    lo, hi = obj_scene.room_bounds(scene, splats)
    cameras = obj_scene.camera_ring(lo, hi, count=count)
    fx, fy, cx, cy = obj_scene.intrinsics(width, height, fov)
    views = []
    for i, cam in enumerate(cameras):
        c2w = np.asarray(cam["c2w"], np.float64)
        r = sio.render(splats, c2w, fx, fy, cx, cy, width, height, prefer_gpu=prefer_gpu)
        name = f"view_{i:02d}.png"
        sio.save_jpeg(out_dir / name.replace(".png", ".jpg"), r.rgb, quality=92)
        # PNG for lossless masks later; the JPEG is the quick look
        from PIL import Image
        Image.fromarray(np.asarray(r.rgb, np.uint8)).save(out_dir / name)
        views.append({
            "file": name,
            "jpg": name.replace(".png", ".jpg"),
            "position": cam["position"],
            "target": cam["target"],
            "c2w": cam["c2w"],
            "width": width,
            "height": height,
            "fx": fx,
            "fy": fy,
            "cx": cx,
            "cy": cy,
        })
        log(f"rendered {name} ({r.rgb.shape[1]}x{r.rgb.shape[0]})")
    doc = {
        "version": 1,
        "sceneId": scene.get("id") or scene_dir.name,
        "source": scene_dir.name,
        "width": width,
        "height": height,
        "fx": fx,
        "fy": fy,
        "cx": cx,
        "cy": cy,
        "views": views,
    }
    tmp = out_dir / f".{VIEWS_FILE}.tmp"
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    tmp.replace(out_dir / VIEWS_FILE)
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--count", type=int, default=12)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--fov", type=float, default=60.0)
    ap.add_argument("--cpu", action="store_true", help="use the CPU point renderer")
    args = ap.parse_args(argv)
    out = Path(args.out) if args.out else Path(args.scene) / "views"
    doc = render_scene(args.scene, out, args.count, args.width, args.height, args.fov, not args.cpu)
    print(f"{len(doc['views'])} views -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
