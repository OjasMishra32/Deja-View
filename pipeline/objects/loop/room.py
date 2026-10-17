#!/usr/bin/env python3
"""The room shell without a ceiling (team/shivin-reconstruction-loop.md, deliverable 4).

    python pipeline/objects/loop/room.py --scene data/scenes/kitchen --out data/scenes/kitchen/room-shell

The room baker (`roblox_mesh.build_model`) splits an indoor lid into `ceiling_NN` chunks. This path bakes the room
with a configuration from `ROOM_SPACE`, then removes every ceiling: the `ceiling_*` chunks, and in the other chunks
any downward-facing triangle within 15 cm of the ceiling height and anything above it. Walls, floor, fixtures and
the undersides of wall cabinets (which face down but sit well below the lid) stay. It reports the ceiling triangles
left (always 0) and the Quest and mobile budgets: triangles, draw calls and texture memory.
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

from objects.detail.glb import STUDS_PER_METER, Prim, glb_extras, read_glb, write_glb  # noqa: E402
from objects.loop.space import TRIANGLES, Config  # noqa: E402

LID_BAND = 0.15  # m below the ceiling height that still counts as ceiling when it faces down
DOWN = -0.5  # normal y below this faces down
# Working targets for one room on screen, not Roblox limits (Roblox publishes none): tune them on the devices.
BUDGETS = {"quest": {"triangles": 100_000, "drawCalls": 40, "textureMB": 96},
           "mobile": {"triangles": 150_000, "drawCalls": 60, "textureMB": 128}}


def face_normals(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def ceiling_faces(V: np.ndarray, F: np.ndarray, ceiling_y: float | None) -> np.ndarray:
    """Boolean per face: part of a ceiling. Without a known ceiling height, nothing is (outdoors)."""
    if ceiling_y is None or len(F) == 0:
        return np.zeros(len(F), bool)
    n = face_normals(V, F)
    y = V[F].mean(axis=1)[:, 1]
    return ((n[:, 1] < DOWN) & (y > ceiling_y - LID_BAND)) | (y > ceiling_y + 0.3)


def strip_ceiling(prims: list[Prim], ceiling_y: float | None) -> tuple[list[Prim], int]:
    """(prims without any ceiling, triangles removed). Unused vertices are dropped; UVs and atlases stay."""
    out, removed = [], 0
    for p in prims:
        if p.name.startswith("ceiling"):
            removed += len(p.F)
            continue
        lid = ceiling_faces(p.V, p.F, ceiling_y)
        removed += int(lid.sum())
        F = p.F[~lid]
        if len(F) == 0:
            continue
        used, inv = np.unique(F, return_inverse=True)
        sub = lambda a: None if a is None else a[used]  # noqa: E731
        out.append(Prim(p.name, p.V[used], inv.reshape(-1, 3), sub(p.N), sub(p.UV), p.image, sub(p.colours)))
    return out, removed


def ceiling_triangles(prims: list[Prim], ceiling_y: float | None) -> int:
    return int(sum(len(p.F) if p.name.startswith("ceiling") else int(ceiling_faces(p.V, p.F, ceiling_y).sum())
                   for p in prims))


def budgets(prims: list[Prim]) -> dict:
    """Triangles, draw calls (one per MeshPart chunk) and texture memory (RGBA with mips) against the targets."""
    tris = int(sum(len(p.F) for p in prims))
    draws = len(prims)
    tex_mb = sum(p.image.shape[0] * p.image.shape[1] * 4 * 4 / 3 for p in prims if p.image is not None) / 2 ** 20
    out = {"triangles": tris, "drawCalls": draws, "textureMB": round(tex_mb, 1)}
    for dev, b in BUDGETS.items():
        out[dev] = {"fits": tris <= b["triangles"] and draws <= b["drawCalls"] and tex_mb <= b["textureMB"],
                    **{k: f"{out[k]}/{v}" for k, v in b.items()}}
    return out


def ceiling_height(scene_dir: Path, glb: Path) -> float | None:
    """The lid height in metres: the bake's own `ceilingY` (studs) if it found one, else the voxel map's."""
    ex = glb_extras(glb)
    for src in (ex, ex.get("model", {})):
        if isinstance(src, dict) and src.get("ceilingY") is not None:
            return float(src["ceilingY"]) / STUDS_PER_METER
    side = glb.parent / "roblox-model.json"
    if side.exists():
        d = json.loads(side.read_text())
        if d.get("ceilingY") is not None:
            return float(d["ceilingY"]) / STUDS_PER_METER
    m = scene_dir / "roblox-map.json"
    if m.exists():
        d = json.loads(m.read_text())
        if d.get("ceilingY") is not None:
            return float(d["ceilingY"]) / STUDS_PER_METER
    return None


def bake_room(scene_dir: Path, out: Path, c: Config, face_res: int = 512, atlas: int | None = None,
              device: str | None = None, log=print) -> dict:
    """Bake the room with `c` and strip the ceiling. `views` maps to standing positions (six cube faces each)."""
    import roblox_mesh as rm

    from objects.loop.bake import post_process

    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    tri = {"none": 60000, "light": 45000, "strong": 30000}[c.simplify]
    rm.build_model(scene_dir, out, triangles=tri, texture=atlas or c.atlas, voxel=c.voxel,
                   positions=max(2, c.views // 6), face_res=face_res, device=device,
                   min_component=c.min_component, log=log)
    glb = out / "roblox.glb"
    lid_y = ceiling_height(scene_dir, glb)
    prims, removed = strip_ceiling(post_process(read_glb(glb), c), lid_y)
    glb.write_bytes(write_glb(prims, {**glb_extras(glb), "ceiling": "removed", "ceilingTriangles": 0,
                                      "loopConfig": c.to_json()}))
    left = ceiling_triangles(read_glb(glb), lid_y)
    if left:
        raise RuntimeError(f"{left} ceiling triangles survived the strip")
    res = {"glb": str(glb), "ceilingY": lid_y, "ceilingRemoved": removed, "ceilingTriangles": left,
           "budgets": budgets(prims), "bakeSeconds": round(time.time() - t0, 1)}
    (out / "room-shell.json").write_text(json.dumps(res, indent=2))
    log(f"room shell: {removed} ceiling triangles removed, {res['budgets']}")
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voxel", type=float, default=0.015)
    ap.add_argument("--views", type=int, default=24)
    ap.add_argument("--atlas", type=int, default=2048)
    ap.add_argument("--face-res", type=int, default=768)
    ap.add_argument("--device", default=None)
    a = ap.parse_args(argv)
    c = Config(voxel=a.voxel, views=a.views, atlas=a.atlas, simplify="none", chunks="floor", maps="off")
    bake_room(Path(a.scene), Path(a.out), c, a.face_res, device=a.device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
