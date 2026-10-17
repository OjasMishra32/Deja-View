"""One trial's bake: the existing object bake (`roblox_mesh.build_model` through the `objects.mesh` hooks) with a
configuration from the space, then the post-steps the room baker has no switch for: dropping the floor fill (chunk
policy "one"), Taubin smoothing, and the detail maps. GPU for the bake itself; the post-steps are pure numpy."""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from objects.detail.glb import Prim, glb_extras, read_glb, vertex_normals, write_glb
from objects.loop.space import MAPS, SMOOTH_ITERS, TRIANGLES, Config


def weld(V: np.ndarray, tol: float = 1e-6) -> tuple[np.ndarray, np.ndarray]:
    """(unique positions, index of each vertex in them): the bakers split vertices at UV seams."""
    q = np.round(V / tol).astype(np.int64)
    _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    return np.asarray(V, np.float64)[first], inv.reshape(-1)


def taubin(V: np.ndarray, F: np.ndarray, iterations: int, lam: float = 0.5, mu: float = -0.53) -> np.ndarray:
    """Taubin smoothing (shrink-free Laplacian) on welded positions, so UV seams stay closed. Boundary vertices are
    held so open rims don't creep inward."""
    if iterations <= 0 or len(F) == 0:
        return V
    P, inv = weld(V)
    Fw = inv[F]
    e = np.concatenate([Fw[:, [0, 1]], Fw[:, [1, 2]], Fw[:, [2, 0]]])
    es = np.sort(e, axis=1)
    uniq, counts = np.unique(es, axis=0, return_counts=True)
    fixed = np.zeros(len(P), bool)
    fixed[uniq[counts == 1].ravel()] = True
    a, b = uniq[:, 0], uniq[:, 1]
    deg = np.bincount(np.concatenate([a, b]), minlength=len(P)).astype(np.float64)
    P = P.copy()
    for _ in range(int(iterations)):
        for f in (lam, mu):
            acc = np.zeros_like(P)
            np.add.at(acc, a, P[b])
            np.add.at(acc, b, P[a])
            lap = acc / np.maximum(deg, 1)[:, None] - P
            lap[fixed | (deg == 0)] = 0
            P = P + f * lap
    return P[inv]


def post_process(prims: list[Prim], c: Config) -> list[Prim]:
    out = []
    for p in prims:
        if c.chunks == "one" and p.name.startswith("floor"):
            continue
        if SMOOTH_ITERS[c.simplify]:
            V = taubin(p.V, p.F, SMOOTH_ITERS[c.simplify])
            p = Prim(p.name, V, p.F, vertex_normals(V, p.F), p.UV, p.image, p.colours)
        out.append(p)
    if not out:
        raise ValueError("nothing left after the chunk policy")
    return out


def finish(glb: Path, c: Config, out: Path, kind: str) -> Path:
    """Apply the post-steps and the maps to a baked GLB in place."""
    from PIL import Image

    from objects.detail import maps

    extras = glb_extras(glb)
    prims = post_process(read_glb(glb), c)
    m = MAPS[c.maps]
    if m:
        side = maps.bake_maps(prims, out, size=min(c.atlas, 2048), ao_directions=32, **m)
        textured = [p for p in prims if p.image is not None]
        for ci, p in enumerate(textured):
            p.image = np.asarray(Image.open(out / side["chunks"][ci]["maps"]["color"]["file"]))
    glb.write_bytes(write_glb(prims, {**extras, "loopConfig": c.to_json(), "detailKind": kind}))
    return glb


def bake_object(scene_dir: Path, box, c: Config, rung_size: int, rung_atlas: int | None, out: Path, kind: str,
                device: str | None = None, splats=None, scene: dict | None = None, log=print) -> dict:
    """Bake one configuration into `out/roblox.glb`. `splats`/`scene` can be passed in to skip re-reading the world
    for every trial."""
    import roblox_mesh as rm

    from objects import mesh as obj_mesh
    from objects import scene as obj_scene

    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    if splats is None:
        splats, scene = obj_scene.load_scene(scene_dir)
    lo = box.lo + np.array([0.01, 0.02, 0.01])
    hi = box.hi - np.array([0.01, 0.0, 0.01])
    margin = 0.08 if kind == "small" else 0.12
    crop = obj_mesh.crop_splats(splats, lo - margin, hi + margin)
    rings = (0.0, 25.0, 50.0) if c.views < 48 else (-15.0, 10.0, 35.0, 60.0)
    per = max(4, c.views // len(rings))
    views = []
    for el in rings:
        views += obj_mesh.orbit_views(box.centre, radius=float(box.size.max()) * 1.7 + 0.4, count=per, size=rung_size,
                                      elevations=(el,))[:-1]  # orbit_views appends a top view per call
    views += obj_mesh.orbit_views(box.centre, float(box.size.max()) * 1.7 + 0.4, 1, rung_size, elevations=(0.0,))[-1:]
    sc = {**(scene or {}), "id": f"{(scene or {}).get('id', scene_dir.name)}-{box.id}-loop", "name": box.id}
    room = obj_mesh.object_room(crop, sc, scene_dir, lo, hi, box.centre)
    atlas = rung_atlas or c.atlas
    rm.build_model(scene_dir, out, triangles=TRIANGLES[c.simplify], texture=atlas, device=device, voxel=c.voxel,
                   room_override=room, views_override=(views, []), ink=1.2 if c.ink else None, room_chunks=1,
                   chunk_triangles=TRIANGLES[c.simplify], min_component=c.min_component, airborne_m2=0.0, log=log)
    finish(out / "roblox.glb", c.with_(atlas=atlas), out, kind)
    return {"glb": str(out / "roblox.glb"), "bakeSeconds": round(time.time() - t0, 1), "views": len(views),
            "viewSize": rung_size, "atlas": atlas}
