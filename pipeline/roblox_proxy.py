"""A painted box room for Roblox, for a place whose scan is too thin to stand in as a mesh (an open patio at night).

The floor is rendered straight down from the splats in tiles (leaving out what hangs above head height: a roof, the
lights, tree crowns), so every table and chair sits on its own footprint. The walls are flat panels on the edge of the
room, each rendered from one eye point in the middle with the camera square to the panel, so the panel shows exactly
what lies beyond it from there. Roblox shows them as Decals on thin parts; the game adds the real tables in 3D.

    python pipeline/roblox_proxy.py --scene data/scenes/the-courts --out out/proxy --eye 0.3,-3.3

Writes floor-<i>-<j>.png and wall-<k>.png (all `--size` px square) and proxy.json: the eye, and per tile its file,
kind, centre and size in metres (room frame: floor at y = 0), and for walls the inward normal.
"""
from __future__ import annotations

import argparse
import dataclasses
import io
import json
from pathlib import Path

import numpy as np

import roblox_mesh as rm
import splat_io as sio


def _c2w(right, up, back, pos) -> np.ndarray:
    return sio.pose_matrix(np.stack([np.asarray(right, float), np.asarray(up, float), np.asarray(back, float)], axis=1), pos)


def build(scene: Path, out: Path, eye_xz: tuple[float, float], tiles: int = 3, size: int = 1024, cut: float = 1.2,
          margin: float = 1.0, wall_h: float = 4.5, walls_per_side: int = 3, height: float = 30.0,
          log=print) -> dict:
    import torch
    from PIL import Image

    room = rm.load_room(scene, log)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    P = sio.apply_transform(room.splats.means, room.transform)
    P[:, 1] -= room.floor_y
    # the place's own walkable box (scene.json world.bounds) when it has one; the map's extent reaches far past it
    wb = (room.scene.get("world") or {}).get("bounds") or {}
    if wb.get("min") and wb.get("max"):
        lo = np.array([wb["min"][0] - margin, wb["min"][2] - margin])
        hi = np.array([wb["max"][0] + margin, wb["max"][2] + margin])
    else:
        lo = np.array([room.lo[0] - margin, room.lo[2] - margin])
        hi = np.array([room.hi[0] + margin, room.hi[2] + margin])
    out.mkdir(parents=True, exist_ok=True)
    tiles_out = []

    def save(img, name: str) -> str:
        u8 = (np.clip(img, 0, 1) * 255).round().astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(u8).save(buf, format="PNG", optimize=True)
        (out / name).write_bytes(buf.getvalue())
        return name

    def render(renderer, views):
        return [s.rgb.clamp(0, 1).cpu().numpy() if hasattr(s.rgb, "cpu") else s.rgb for s in renderer.render(views)]

    # the floor: straight down, only what stands up to table height inside the box (wall bottoms and tree trunks
    # seen from above are streaks), and where nothing covers it, the floor's own typical colour
    inside = (P[:, 0] >= lo[0]) & (P[:, 0] <= hi[0]) & (P[:, 2] >= lo[1]) & (P[:, 2] <= hi[1])
    low = room.splats.subset(np.nonzero((P[:, 1] < cut) & inside)[0])
    floor_r = rm.Renderer(dataclasses.replace(room, splats=low), dev)
    floor_r.keep_alpha = True
    tw, td = (hi[0] - lo[0]) / tiles, (hi[1] - lo[1]) / tiles
    floor_shots = []
    for i in range(tiles):
        for j in range(tiles):
            cx, cz = lo[0] + (i + 0.5) * tw, lo[1] + (j + 0.5) * td
            # image top toward -Z, image right toward +X
            c2w = _c2w([1, 0, 0], [0, 0, -1], [0, 1, 0], [cx, height, cz])
            v = rm.View(c2w, size * height / tw, size, "overview", fy=size * height / td)
            shot = floor_r.render([v])[0]
            rgb = shot.rgb.clamp(0, 1).cpu().numpy()
            al = shot.alpha.clamp(0, 1).cpu().numpy() if shot.alpha is not None else np.ones(rgb.shape[:2])
            floor_shots.append((i, j, cx, cz, rgb, al))


    # the floor's typical colour (well covered pixels), then every tile composited over it
    solid = np.concatenate([rgb[al > 0.9] for *_, rgb, al in floor_shots])
    base = np.median(solid, axis=0) if len(solid) else np.array([0.55, 0.52, 0.48])
    for i, j, cx, cz, rgb, al in floor_shots:
        a = np.clip((al - 0.35) / 0.5, 0, 1)[..., None]
        name = save(rgb / np.maximum(al[..., None], 1e-3) * a + base * (1 - a), f"floor-{i}-{j}.png")
        tiles_out.append({"file": name, "kind": "floor", "centre": [cx, 0.0, cz], "size": [tw, td]})

    # the walls: panels on the rectangle's edge, each seen square-on from the eye
    full_r = rm.Renderer(room, dev)
    eye = np.array([eye_xz[0], rm.SKY_EYE_M, eye_xz[1]])
    sides = [  # (fixed axis, value, inward normal, run axis from, to)
        ("z", lo[1], (0, 0, 1), lo[0], hi[0]),
        ("x", hi[0], (-1, 0, 0), lo[1], hi[1]),
        ("z", hi[1], (0, 0, -1), hi[0], lo[0]),
        ("x", lo[0], (1, 0, 0), hi[1], lo[1]),
    ]
    k = 0
    for axis, value, inward, a0, a1 in sides:
        n = np.asarray(inward, float)
        look = -n  # from the eye toward the panel
        up = np.array([0.0, 1.0, 0.0])
        right = np.cross(look, up)
        for s in range(walls_per_side):
            t0, t1 = a0 + (a1 - a0) * s / walls_per_side, a0 + (a1 - a0) * (s + 1) / walls_per_side
            mid = (t0 + t1) / 2
            centre = np.array([mid, wall_h / 2, value]) if axis == "z" else np.array([value, wall_h / 2, mid])
            width = abs(t1 - t0)
            d = float(np.dot(centre - eye, look))  # distance from the eye to the panel's plane
            off_r = float(np.dot(centre - eye, right))
            off_u = float(np.dot(centre - eye, up))
            fx, fy = size * d / width, size * d / wall_h
            c2w = _c2w(right, up, n, eye)  # camera looks along -n (the panel), image plane parallel to it
            v = rm.View(c2w, fx, size, "overview", fy=fy, cx=size / 2 - off_r * fx / d, cy=size / 2 + off_u * fy / d)
            name = save(render(full_r, [v])[0], f"wall-{k:02d}.png")
            tiles_out.append({"file": name, "kind": "wall", "centre": centre.round(4).tolist(), "size": [width, wall_h],
                              "inward": list(inward)})
            k += 1
    doc = {"version": 1, "eye": eye.round(4).tolist(), "studsPerMeter": rm.STUDS_PER_METER, "floorCut": cut,
           "tiles": tiles_out}
    (out / "proxy.json").write_text(json.dumps(doc, indent=1))
    log(f"proxy: {sum(t['kind'] == 'floor' for t in tiles_out)} floor and {k} wall tiles of {size} px in {out}")
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scene", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--eye", required=True, help="x,z in metres (room frame): where the walls are seen from")
    ap.add_argument("--tiles", type=int, default=3)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--cut", type=float, default=1.2)
    ap.add_argument("--wall-height", type=float, default=4.5)
    args = ap.parse_args()
    ex, ez = (float(v) for v in args.eye.split(","))
    build(args.scene, args.out, (ex, ez), args.tiles, args.size, args.cut, wall_h=args.wall_height)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
