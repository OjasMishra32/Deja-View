#!/usr/bin/env python3
"""Export one object as a multi-view dataset for the external surface methods (task 5): SuGaR, 2DGS, Gaussian
Opacity Fields and Gaussian Grouping all read the Blender / NeRF-synthetic layout that 3DGS reads.

    python pipeline/objects/detail/export_dataset.py --scene data/scenes/kitchen --object stove \
        --out runs/stove-dataset --size 1024 --count 24

Writes `images/r_XXX.png` (RGBA: the object's splats over transparent, so the methods train on the object alone),
`transforms_train.json` / `transforms_test.json` (OpenGL camera-to-world, `camera_angle_x`; `file_path` has no extension because the 3DGS loader adds `.png`), `points3d.ply` (the
cropped splat centres and colours, an initial point cloud) and `object_mask/r_XXX.png` (for Gaussian Grouping).
The cameras are the same orbit `evaluate.py --orbit` scores against. GPU recommended; the CPU renderer works.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from objects.detail.objects_io import load_objects, objects_file, pick  # noqa: E402
from objects.detail.raster import Camera, orbit_cameras  # noqa: E402


def transforms(cams: list[Camera], names: list[str]) -> dict:
    c = cams[0]
    return {"camera_angle_x": float(2 * np.arctan(c.width / (2 * c.fx))), "fl_x": c.fx, "fl_y": c.fy, "cx": c.cx,
            "cy": c.cy, "w": c.width, "h": c.height,
            "frames": [{"file_path": f"./images/{Path(n).stem}", "transform_matrix": cam.c2w.tolist()}
                       for cam, n in zip(cams, names)]}


def write_points_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    head = ("ply\nformat binary_little_endian 1.0\n"
            f"element vertex {len(xyz)}\nproperty float x\nproperty float y\nproperty float z\n"
            "property float nx\nproperty float ny\nproperty float nz\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n").encode()
    dt = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4"),
                   ("r", "u1"), ("g", "u1"), ("b", "u1")])
    arr = np.zeros(len(xyz), dt)
    arr["x"], arr["y"], arr["z"] = xyz.T
    arr["r"], arr["g"], arr["b"] = np.clip(rgb, 0, 255).astype(np.uint8).T
    path.write_bytes(head + arr.tobytes())


def export(scene_dir, object_id: str, out, size: int = 1024, count: int = 24, margin: float = 0.03,
           test_every: int = 8, log=print) -> dict:
    import splat_io as sio
    from PIL import Image

    from objects import scene as obj_scene

    scene_dir, out = Path(scene_dir), Path(out)
    box = pick(load_objects(objects_file(scene_dir)), [object_id])[0]
    splats, _ = obj_scene.load_scene(scene_dir)
    keep = np.all((splats.means >= box.lo - margin) & (splats.means <= box.hi + margin), axis=1)
    crop = splats.subset(np.nonzero(keep)[0])
    per = max(2, count // 3)
    cams = orbit_cameras(box.centre, float(box.size.max()), count=per * 3, size=size, elevations=(5.0, 30.0, 55.0))
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "object_mask").mkdir(parents=True, exist_ok=True)
    names = []
    for i, cam in enumerate(cams):
        r = sio.render(crop, cam.c2w, cam.fx, cam.fy, cam.cx, cam.cy, cam.width, cam.height)
        a = np.clip(np.asarray(r.alpha) * 255, 0, 255).astype(np.uint8)
        name = f"r_{i:03d}.png"
        Image.fromarray(np.dstack([np.asarray(r.rgb, np.uint8), a]), "RGBA").save(out / "images" / name)
        Image.fromarray(((a > 127) * 255).astype(np.uint8)).save(out / "object_mask" / name)
        names.append(name)
    test = [i for i in range(len(cams)) if i % test_every == 0]
    train = [i for i in range(len(cams)) if i not in test]
    for split, idx in (("train", train), ("test", test)):
        (out / f"transforms_{split}.json").write_text(json.dumps(transforms([cams[i] for i in idx],
                                                                             [names[i] for i in idx]), indent=1))
    write_points_ply(out / "points3d.ply", np.asarray(crop.means, np.float64), np.asarray(crop.rgb(), np.float64))
    meta = {"object": box.id, "label": box.label, "centre": box.centre.tolist(), "sizeM": box.size.tolist(),
            "splats": int(len(crop)), "views": len(cams), "size": size, "train": len(train), "test": len(test)}
    (out / "dataset.json").write_text(json.dumps(meta, indent=2))
    log(f"{box.id}: {len(cams)} views at {size} px, {len(crop)} splats -> {out}")
    return meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--object", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--count", type=int, default=24)
    args = ap.parse_args(argv)
    export(args.scene, args.object, args.out, args.size, args.count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
