#!/usr/bin/env python3
"""Extract one object's own mesh and texture from a scene's splats.

    python pipeline/objects/mesh.py --scene data/scenes/kitchen --object fridge \
        --out data/scenes/kitchen/objects/fridge

This is the real object, not a box: it crops the splats to the object bounds, renders an
orbit around the object, fuses a TSDF, extracts the surface, decimates it, bakes the
captured colour, and writes `roblox.glb` plus its sidecar. It reuses the room baker's
mesh and texture machinery through the `room_override` and `views_override` hooks.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import roblox_mesh as rm  # noqa: E402
import splat_io as sio  # noqa: E402
from objects import scene as obj_scene  # noqa: E402

GLB_FILE = "roblox.glb"
SIDECAR_FILE = "roblox-model.json"


def crop_splats(splats: sio.Splats, lo: np.ndarray, hi: np.ndarray) -> sio.Splats:
    keep = np.all((splats.means >= lo) & (splats.means <= hi), axis=1)
    if int(keep.sum()) < 32:
        raise ValueError(f"only {int(keep.sum())} splats inside the object bounds")
    return splats.subset(np.nonzero(keep)[0])


def orbit_views(centre: np.ndarray, radius: float, count: int = 12, size: int = 512,
                fov_deg: float = 50.0, elevations: tuple[float, ...] = (0.0, 25.0, 50.0)) -> list[rm.View]:
    """Cameras on a sphere around the object, all looking at its centre."""
    f = (size / 2.0) / np.tan(np.deg2rad(fov_deg) / 2.0)
    views = []
    for elev in elevations:
        e = np.deg2rad(float(elev))
        for i in range(count):
            a = 2.0 * np.pi * i / count
            pos = np.asarray(centre, np.float64) + radius * np.array([np.cos(e) * np.cos(a), np.sin(e), np.cos(e) * np.sin(a)])
            views.append(rm.View(rm.look_at(pos, np.asarray(centre, np.float64)), float(f), int(size), "object"))
    # straight down, for the top face
    top = np.asarray(centre, np.float64) + np.array([0.0, radius, 0.001])
    views.append(rm.View(rm.look_at(top, np.asarray(centre, np.float64)), float(f), int(size), "object"))
    return views


def object_room(splats: sio.Splats, scene: dict, scene_dir: Path, lo: np.ndarray, hi: np.ndarray,
                centre: np.ndarray) -> rm.Room:
    rgb = np.asarray(splats.rgb(), np.float64)
    return rm.Room(
        scene=scene,
        scene_dir=scene_dir,
        splats=splats,
        transform={"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1},
        scale=1.0,
        floor_y=0.0,
        lo=np.asarray(lo, np.float64),
        hi=np.asarray(hi, np.float64),
        spawn=(float(centre[0]), 0.0, float(centre[2] + 1.0)),
        spawn_yaw=0.0,
        pos=np.asarray(splats.means, np.float64),
        w=np.ones(len(splats), np.float64),
        lin=np.clip(rgb / 255.0, 0, 1) ** 2.2,
        voxel_map={"spawn": [0, 0, 0], "spawnYaw": 0, "ceilingY": float(hi[1])},
    )


def build_object(scene_dir: str | Path, object_id: str, out_dir: str | Path, triangles: int = 20000,
                 texture: int = 1024, margin: float = 0.12, size: int = 512, count: int = 12,
                 device: str | None = None, ink: float | None = None, log=print) -> dict:
    scene_dir = Path(scene_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = json.loads((scene_dir / "objects.json").read_text(encoding="utf-8"))
    obj = next((o for o in doc["objects"] if o["id"] == object_id or o["label"] == object_id), None)
    if obj is None:
        raise ValueError(f"{object_id} is not in objects.json")
    studs = float(doc.get("studsPerMeter") or 3.57)
    centre = np.asarray(obj["center"], np.float64) / studs
    half = np.asarray(obj["size"], np.float64) / studs / 2.0
    splats, scene = obj_scene.load_scene(scene_dir)
    # The reconstruction volume is the object itself. The camera crop is wider so the orbit still
    # sees the whole object, but the TSDF must not absorb the wall and the floor around it.
    lo = centre - half + np.array([0.01, 0.02, 0.01])
    hi = centre + half - np.array([0.01, 0.0, 0.01])
    crop_lo = lo - margin
    crop_hi = hi + margin
    crop = crop_splats(splats, crop_lo, crop_hi)
    views = orbit_views(centre, radius=float(max(obj["size"]) / studs) * 1.7 + 0.4, count=count, size=size)
    scene = {**scene, "id": f"{scene.get('id', scene_dir.name)}-{object_id}", "name": object_id}
    room = object_room(crop, scene, scene_dir, lo, hi, centre)
    log(f"{object_id}: {len(crop)} splats, bounds {np.round(lo, 2)}..{np.round(hi, 2)} m, {len(views)} views")
    result = rm.build_model(
        scene_dir, out_dir, triangles=triangles, texture=texture, device=device,
        room_override=room, views_override=(views, []), ink=ink, log=log,
    )
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--object", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--triangles", type=int, default=20000)
    ap.add_argument("--texture", type=int, default=1024)
    ap.add_argument("--margin", type=float, default=0.12)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--count", type=int, default=12)
    ap.add_argument("--device", default=None)
    ap.add_argument("--ink", type=float, default=None, help="ink/smooth the texture for signs and posters")
    args = ap.parse_args(argv)
    result = build_object(args.scene, args.object, args.out, args.triangles, args.texture, args.margin,
                          args.size, args.count, args.device, args.ink)
    print(f"{result['triangles']} triangles, {result['bytes'] / 1e6:.1f} MB -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
