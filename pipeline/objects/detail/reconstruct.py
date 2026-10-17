#!/usr/bin/env python3
"""High-detail object reconstruction (team/shivin-object-detail.md task 2 and 3). GPU; run it on PACE.

    python pipeline/objects/detail/reconstruct.py --scene data/scenes/kitchen --object all \
        --out data/scenes/kitchen/objects-detail

Per object it picks a class (regular, small < 0.2 m^3, flat poster or sign) and adaptive parameters
(`flat.params_for`), then:
  regular / small  object-centric orbit at >= 1024 px on four elevation rings, a 0.5-1 cm TSDF, a 2048 atlas,
                   1-2 chunks of <= 18k triangles, a minimum component scaled to the object so handles survive.
                   The room baker does the fusion, decimation and bake (`roblox_mesh.build_model` hooks).
  flat             a bevelled slab rectified from the most frontal splat render, with the ink pass on.
Then it bakes normal, AO and roughness maps next to `roblox.glb` and lists them in `detail-maps.json`.

It writes a separate set (default `<scene>/objects-detail/<id>/`) and never touches `<scene>/objects/`: the
approved fridge, its approval and the upload gate are unchanged. It uploads, approves and publishes nothing.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from objects.detail import flat, maps  # noqa: E402
from objects.detail.glb import glb_extras, read_glb, write_glb  # noqa: E402
from objects.detail.objects_io import ObjectBox, load_objects, objects_file, pick  # noqa: E402
from objects.detail.raster import look_at  # noqa: E402

GLB_FILE = "roblox.glb"
MODEL_FILE = "detail-model.json"


def orbit(centre: np.ndarray, extent: float, p: flat.Params):
    import roblox_mesh as rm

    radius = extent * 1.7 + 0.4 if p.kind != "small" else extent * 2.2 + 0.25
    f = (p.size / 2.0) / np.tan(np.deg2rad(50.0) / 2.0)
    views = []
    for k, el in enumerate(p.elevations):
        e = np.deg2rad(el)
        for i in range(p.count):
            a = 2 * np.pi * (i + 0.5 * (k % 2)) / p.count
            eye = centre + radius * np.array([np.cos(e) * np.cos(a), np.sin(e), np.cos(e) * np.sin(a)])
            if eye[1] < 0.05:  # never from under the floor
                eye[1] = 0.05
            views.append(rm.View(rm.look_at(eye, centre), float(f), int(p.size), "object"))
    views.append(rm.View(rm.look_at(centre + np.array([0.0, radius, 0.001]), centre), float(f), int(p.size), "object"))
    return views


def build_mesh(scene_dir: Path, splats, scene: dict, box: ObjectBox, p: flat.Params, out: Path, device, log) -> dict:
    import roblox_mesh as rm
    from objects import mesh as obj_mesh

    lo = box.lo + np.array([0.01, 0.02, 0.01])
    hi = box.hi - np.array([0.01, 0.0, 0.01])
    crop = obj_mesh.crop_splats(splats, lo - p.margin, hi + p.margin)
    views = orbit(box.centre, float(box.size.max()), p)
    sc = {**scene, "id": f"{scene.get('id', scene_dir.name)}-{box.id}-detail", "name": box.id}
    room = obj_mesh.object_room(crop, sc, scene_dir, lo, hi, box.centre)
    log(f"{box.id}: {p.kind}, {len(crop)} splats, voxel {p.voxel * 100:.2f} cm, {len(views)} views at {p.size} px")
    return rm.build_model(scene_dir, out, triangles=p.triangles, texture=p.texture, device=device, voxel=p.voxel,
                          room_override=room, views_override=(views, []), ink=p.ink, room_chunks=p.room_chunks,
                          chunk_triangles=p.chunk_triangles, min_component=p.min_component,
                          airborne_m2=p.airborne_m2, log=log)


def build_flat(splats, box: ObjectBox, p: flat.Params, out: Path, room_centre: np.ndarray, log) -> dict:
    import splat_io as sio
    from objects import mesh as obj_mesh
    from objects.ink import ink_array

    crop = obj_mesh.crop_splats(splats, box.lo - 0.02, box.hi + 0.02)
    centre, axes, half = flat.principal_axes(crop.means)
    right, up, normal = axes[:, 0], axes[:, 1], axes[:, 2]
    if abs(right[1]) > abs(up[1]):  # keep "up" as the more vertical in-plane axis
        right, up, half = up, right, half[[1, 0, 2]]
    if up[1] < 0:
        up = -up
    if normal @ (room_centre - centre) < 0:  # posters face into the room
        normal = -normal
    right = np.cross(up, normal)
    hw, hh = float(half[0]), float(half[1])
    thick = float(np.clip(2 * half[2], 0.01, 0.04))
    tex_w = p.texture
    tex_h = int(np.clip(round(tex_w * hh / max(hw, 1e-6)), 64, p.texture))
    dist = max(hw, hh) * 2.4 + 0.3
    fpx = 1.6 * p.size * dist / (2 * max(hw, hh) * 1.1)
    eye = centre + normal * (dist + thick / 2)
    c2w = look_at(eye, centre, up)
    r = sio.render(crop, c2w, fpx, fpx, p.size / 2, p.size / 2, p.size, p.size)
    front = flat.rectify(r.rgb, c2w, fpx, fpx, p.size / 2, p.size / 2, centre + normal * thick / 2, right, up, hw, hh,
                         tex_w, tex_h)
    if p.ink:
        front = ink_array(front, p.ink)
    prim = flat.slab(centre, right, up, normal, hw, hh, thick, front, name=box.id)
    extras = {"name": box.id, "kind": "flat", "inked": bool(p.ink), "sizeM": [2 * hw, 2 * hh, thick]}
    data = write_glb([prim], extras)
    (out / GLB_FILE).write_bytes(data)
    log(f"{box.id}: flat slab {2 * hw:.2f} x {2 * hh:.2f} x {thick:.3f} m, texture {tex_w}x{tex_h}, ink {p.ink}")
    return {"triangles": int(len(prim.F)), "bytes": len(data), "kind": "flat"}


def reconstruct(scene_dir: str | Path, wanted: list[str] | None, out_root: str | Path | None = None,
                objects: str | Path | None = None, device: str | None = None, kind: str | None = None,
                bake: bool = True, ao_into_colour: float = 0.5, log=print) -> list[dict]:
    from objects import scene as obj_scene

    scene_dir = Path(scene_dir)
    out_root = Path(out_root) if out_root else scene_dir / "objects-detail"
    if out_root.resolve() == (scene_dir / "objects").resolve():
        raise SystemExit("refusing to write over the current objects set (and the approved fridge)")
    boxes = pick(load_objects(objects_file(scene_dir, objects)), wanted)
    splats, scene = obj_scene.load_scene(scene_dir)
    room_centre = np.asarray(splats.means, np.float64).mean(axis=0)
    results = []
    for box in boxes:
        t0 = time.time()
        out = out_root / box.id
        out.mkdir(parents=True, exist_ok=True)
        inside = np.all((splats.means >= box.lo) & (splats.means <= box.hi), axis=1)
        k = kind or flat.classify(box.size, box.label, splats.means[inside] if inside.sum() >= 50 else None)
        p = flat.params_for(box.size, k)
        try:
            res = build_flat(splats, box, p, out, room_centre, log) if k == "flat" else \
                build_mesh(scene_dir, splats, scene, box, p, out, device, log)
            sidecar = None
            if bake:
                prims = read_glb(out / GLB_FILE)
                sidecar = maps.bake_maps(prims, out, ao_into_colour=ao_into_colour)
                if ao_into_colour > 0 and k != "flat":
                    # the GLB itself carries the AO-shaded colour, since Roblox has no AO slot
                    from PIL import Image

                    for ci, prim in enumerate(p_ for p_ in prims if p_.image is not None):
                        prim.image = np.asarray(Image.open(out / sidecar["chunks"][ci]["maps"]["color"]["file"]))
                    extras = {**glb_extras(out / GLB_FILE), "detailKind": k, "aoIntoColour": ao_into_colour}
                    (out / GLB_FILE).write_bytes(write_glb(prims, extras))
            rec = {"id": box.id, "label": box.label, "kind": k, "params": p.to_json(), "ok": True,
                   "seconds": round(time.time() - t0, 1), "triangles": res.get("triangles"),
                   "bytes": (out / GLB_FILE).stat().st_size, "maps": sidecar is not None}
        except Exception as e:  # one bad object must not stop the other seven
            rec = {"id": box.id, "label": box.label, "kind": k, "params": p.to_json(), "ok": False,
                   "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 1)}
            log(f"{box.id}: FAILED {rec['error']}")
        (out / MODEL_FILE).write_text(json.dumps(rec, indent=2), encoding="utf-8")
        results.append(rec)
    (out_root / "reconstruct-summary.json").write_text(json.dumps({"objects": results}, indent=2), encoding="utf-8")
    return results


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--object", action="append", default=None, help="id or label; repeat, or 'all' (default)")
    ap.add_argument("--objects", default=None, help="objects file (default objects-all.json, then objects.json)")
    ap.add_argument("--out", default=None, help="default <scene>/objects-detail")
    ap.add_argument("--device", default=None)
    ap.add_argument("--kind", choices=["regular", "small", "flat"], default=None, help="override the classifier")
    ap.add_argument("--no-maps", action="store_true")
    ap.add_argument("--ao-into-colour", type=float, default=0.5, help="0 keeps the albedo unshaded")
    args = ap.parse_args(argv)
    res = reconstruct(args.scene, args.object, args.out, args.objects, args.device, args.kind, not args.no_maps,
                      args.ao_into_colour)
    bad = [r["id"] for r in res if not r["ok"]]
    print(f"{len(res) - len(bad)}/{len(res)} objects rebuilt" + (f"; failed: {', '.join(bad)}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
