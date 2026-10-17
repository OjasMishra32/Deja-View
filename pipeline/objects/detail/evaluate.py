#!/usr/bin/env python3
"""Score object meshes against the splats from the same cameras (team/shivin-object-detail.md task 4).

    python pipeline/objects/detail/evaluate.py --scene data/scenes/kitchen \
        --current data/scenes/kitchen/objects --new data/scenes/kitchen/objects-detail \
        --method sugar=runs/sugar --method 2dgs=runs/2dgs --out data/scenes/kitchen/detail-eval

References, per object:
  views   the scene's own splat renders (`<scene>/views/views.json`, `view_XX.png`, `view_XX_depth.npy`). The
          reference silhouette is every pixel whose splat depth lands inside the object's box; pixels where other
          furniture is in front of the mesh are left out of every score.
  orbit   (--orbit, needs the splats; gsplat on PACE, the CPU point renderer anywhere) the cropped object splats
          rendered at --size px on rings around the object: the object-centric close-ups.
Each mesh (current `roblox.glb`, new `roblox.glb`, and any --method NAME=DIR holding `<id>/mesh.{glb,obj,ply}`) is
rendered from exactly those cameras by the CPU rasteriser. Per object it writes `<out>/<id>/detail.json`, a contact
sheet `<out>/<id>/sheet.jpg` (rows: views; columns: splats | current | new | methods), and copies `detail.json` next
to the new GLB so the review card can read the score. Plus `<out>/detail-summary.json`. Uploads nothing.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from objects.detail import metrics as M  # noqa: E402
from objects.detail.glb import glb_info, merged, read_mesh  # noqa: E402
from objects.detail.objects_io import ObjectBox, load_objects, objects_file, pick  # noqa: E402
from objects.detail.raster import Camera, Frame, orbit_cameras, project, render  # noqa: E402

DETAIL_FILE = "detail.json"
MIN_PIXELS = 300  # a view must see at least this much of the object to count
OCCLUSION_TOL = 0.04  # m: scene depth this much in front of the mesh means something else hides it


class Ref:
    """One reference image: splat colour, splat depth and the object's silhouette in it."""

    def __init__(self, cam: Camera, rgb: np.ndarray, depth: np.ndarray, sil: np.ndarray, kind: str):
        self.cam, self.rgb, self.depth, self.sil, self.kind = cam, rgb, depth, sil, kind


def _load_rgb(path: Path) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(path).convert("RGB"), np.float64) / 255.0


def unproject(depth: np.ndarray, cam: Camera) -> np.ndarray:
    h, w = depth.shape
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    x = (u - cam.cx) / cam.fx * depth
    y = -(v - cam.cy) / cam.fy * depth
    pc = np.stack([x, y, -depth], axis=-1)
    return pc @ cam.c2w[:3, :3].T + cam.c2w[:3, 3]


def box_silhouette(depth: np.ndarray, cam: Camera, box: ObjectBox, pad: float = 0.03) -> np.ndarray:
    P = unproject(depth, cam)
    inside = np.all((P >= box.lo - pad) & (P <= box.hi + pad), axis=-1)
    return inside & (depth > 0)


def view_refs(views_dir: Path, box: ObjectBox, max_views: int = 12, width: int | None = None) -> list[Ref]:
    meta = json.loads((views_dir / "views.json").read_text(encoding="utf-8"))
    refs = []
    for v in meta.get("views", []):
        name = v.get("file") or v.get("image")
        cam = Camera.from_view({**meta, **v}, name)
        corners = np.array([[x, y, z] for x in (box.lo[0], box.hi[0]) for y in (box.lo[1], box.hi[1])
                            for z in (box.lo[2], box.hi[2])])
        u, vv, z = project(corners, cam)
        if (z <= 0).all() or u.max() < 0 or u.min() > cam.width or vv.max() < 0 or vv.min() > cam.height:
            continue
        img, dep = views_dir / name, views_dir / v.get("depth", name.rsplit(".", 1)[0] + "_depth.npy")
        if not img.exists() or not dep.exists():
            continue
        depth = np.load(dep).astype(np.float64)
        sil = box_silhouette(depth, cam, box)
        if sil.sum() < MIN_PIXELS:
            continue
        refs.append(Ref(cam, _load_rgb(img), depth, sil, "view"))
    refs.sort(key=lambda r: -int(r.sil.sum()))
    return refs[:max_views]


def orbit_refs(splats, box: ObjectBox, size: int = 1024, count: int = 8, margin: float = 0.03) -> list[Ref]:
    import splat_io as sio

    keep = np.all((splats.means >= box.lo - margin) & (splats.means <= box.hi + margin), axis=1)
    crop = splats.subset(np.nonzero(keep)[0])
    refs = []
    for cam in orbit_cameras(box.centre, float(box.size.max()), count=count, size=size, elevations=(10.0, 40.0)):
        r = sio.render(crop, cam.c2w, cam.fx, cam.fy, cam.cx, cam.cy, cam.width, cam.height)
        sil = (np.asarray(r.alpha) > 0.5) & (np.asarray(r.depth) > 0)
        if sil.sum() >= MIN_PIXELS:
            refs.append(Ref(cam, np.asarray(r.rgb, np.float64) / 255.0, np.asarray(r.depth, np.float64), sil, "orbit"))
    return refs


def compare(ref: Ref, frame: Frame) -> dict:
    """Scores of one mesh render against one reference."""
    occluded = (ref.depth > 0) & frame.mask & ~ref.sil & (ref.depth < frame.depth - OCCLUSION_TOL)
    pred = frame.mask & ~occluded
    both = pred & ref.sil
    lap_ref = M.laplacian_variance(ref.rgb, both)
    lap = M.laplacian_variance(frame.rgb, both)
    return {
        "iou": M.iou(ref.sil, pred),
        "depthMAE": M.depth_mae(ref.depth, frame.depth, ref.sil, pred),
        "psnr": M.psnr(ref.rgb, frame.rgb, both),
        "ssim": M.ssim(ref.rgb, frame.rgb, both),
        "lapVar": lap,
        "lapVarRef": lap_ref,
        "sharpness": (lap / lap_ref) if (lap is not None and lap_ref) else None,
        "pixels": int(both.sum()),
    }


def score(s: dict) -> float | None:
    """One 0-100 number for the review card. Shape (IoU) and structure (SSIM) count most; colour (PSNR over
    15-35 dB), sharpness against the splats (capped at 1) and depth (0 cm = 1, 5 cm = 0) fill the rest. Holes cost."""
    if s.get("iou") is None:
        return None
    psnr = 0.0 if s.get("psnr") is None else float(np.clip((s["psnr"] - 15) / 20, 0, 1))
    ssim = s.get("ssim") or 0.0
    sharp = 0.0 if s.get("sharpness") is None else float(min(1.0, s["sharpness"]))
    depth = 0.0 if s.get("depthMAE") is None else float(np.clip(1 - s["depthMAE"] / 0.05, 0, 1))
    raw = 0.35 * s["iou"] + 0.25 * max(ssim, 0) + 0.15 * psnr + 0.15 * sharp + 0.10 * depth
    holes = s.get("mesh", {}).get("holes") or 0
    return round(100 * raw - min(10, 0.5 * holes), 1)


def grade(x: float | None) -> str:
    if x is None:
        return "n/a"
    return "A" if x >= 80 else "B" if x >= 70 else "C" if x >= 60 else "D" if x >= 50 else "F"


def find_mesh(root: Path, oid: str) -> Path | None:
    for name in ("roblox.glb", "mesh.glb", "mesh.obj", "mesh.ply"):
        p = root / oid / name
        if p.exists():
            return p
    return None


def maps_present(glb: Path) -> dict:
    side = glb.parent / "detail-maps.json"
    present = {"color": True, "normal": False, "ao": False, "roughness": False}
    if side.exists():
        try:
            doc = json.loads(side.read_text(encoding="utf-8"))
            for c in doc.get("chunks", []):
                for k in c.get("maps", {}):
                    if (glb.parent / c["maps"][k]["file"]).exists():
                        present[k] = True
        except (OSError, ValueError, KeyError):
            pass
    return present


def evaluate_mesh(path: Path, refs: list[Ref]) -> tuple[dict, list[np.ndarray]]:
    t0 = time.time()
    prims = read_mesh(path)
    V, F = merged(prims)
    per_view, frames = [], []
    for ref in refs:
        fr = render(prims, ref.cam)
        c = compare(ref, fr)
        c["camera"] = ref.cam.name
        c["ref"] = ref.kind
        per_view.append(c)
        frames.append(np.where(fr.mask[..., None], fr.rgb, 0.08))
    summary = {k: M.summarise([v[k] for v in per_view])
               for k in ("iou", "depthMAE", "psnr", "ssim", "lapVar", "lapVarRef", "sharpness")}
    summary["mesh"] = M.mesh_stats(V, F)
    info = glb_info(prims)
    summary["texture"] = info["textures"]
    summary["chunks"] = info["chunks"]
    summary["maps"] = maps_present(path) if path.suffix == ".glb" else {"color": False}
    summary["file"] = str(path)
    summary["bytes"] = path.stat().st_size
    summary["score"] = score(summary)
    summary["grade"] = grade(summary["score"])
    summary["views"] = per_view
    summary["seconds"] = round(time.time() - t0, 1)
    return summary, frames


def _tile(img: np.ndarray, h: int) -> np.ndarray:
    from PIL import Image

    im = Image.fromarray(np.clip(img * 255, 0, 255).astype(np.uint8))
    w = max(1, round(im.width * h / im.height))
    return np.asarray(im.resize((w, h), Image.BILINEAR))


def contact_sheet(rows: list[list[np.ndarray]], labels: list[str], out: Path, tile_h: int = 220) -> None:
    from PIL import Image, ImageDraw

    tiles = [[_tile(img, tile_h) for img in row] for row in rows]
    if not tiles:
        return
    tw = max(t.shape[1] for row in tiles for t in row)
    pad, head = 4, 22
    cols = max(len(r) for r in tiles)
    sheet = np.full((head + len(tiles) * (tile_h + pad) + pad, cols * (tw + pad) + pad, 3), 24, np.uint8)
    for r, row in enumerate(tiles):
        for c, t in enumerate(row):
            y, x = head + pad + r * (tile_h + pad), pad + c * (tw + pad)
            sheet[y:y + t.shape[0], x:x + t.shape[1]] = t
    im = Image.fromarray(sheet)
    d = ImageDraw.Draw(im)
    for c, lab in enumerate(labels[:cols]):
        d.text((pad + c * (tw + pad) + 4, 4), lab, fill=(230, 230, 230))
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "JPEG", quality=85)


def evaluate(scene_dir: str | Path, current: str | Path | None = None, new: str | Path | None = None,
             methods: dict[str, str] | None = None, out: str | Path | None = None, objects: str | Path | None = None,
             wanted: list[str] | None = None, views_dir: str | Path | None = None, orbit: bool = False,
             size: int = 1024, max_views: int = 12, sheet_rows: int = 4, publish_card: bool = True,
             log=print) -> dict:
    scene_dir = Path(scene_dir)
    current = Path(current) if current else scene_dir / "objects"
    new = Path(new) if new else scene_dir / "objects-detail"
    out = Path(out) if out else scene_dir / "detail-eval"
    views_dir = Path(views_dir) if views_dir else scene_dir / "views"
    sets = {"current": current, "new": new, **{k: Path(v) for k, v in (methods or {}).items()}}
    boxes = pick(load_objects(objects_file(scene_dir, objects)), wanted)
    splats = None
    if orbit:
        from objects import scene as obj_scene

        splats, _ = obj_scene.load_scene(scene_dir)
    rows = []
    for box in boxes:
        refs: list[Ref] = []
        if (views_dir / "views.json").exists():
            refs += view_refs(views_dir, box, max_views)
        if splats is not None:
            refs += orbit_refs(splats, box, size)
        rec: dict = {"id": box.id, "label": box.label, "sizeM": [round(float(x), 3) for x in box.size],
                     "references": {"views": sum(r.kind == "view" for r in refs),
                                    "orbit": sum(r.kind == "orbit" for r in refs)}, "meshes": {}}
        sheet_cols = [[r.rgb for r in refs[:sheet_rows]]]
        labels = ["splats"]
        for name, root in sets.items():
            path = find_mesh(root, box.id)
            if path is None:
                rec["meshes"][name] = {"missing": True}
                continue
            if not refs:
                rec["meshes"][name] = {"file": str(path), "error": "no reference view sees this object"}
                continue
            try:
                summary, frames = evaluate_mesh(path, refs)
            except Exception as e:  # a broken mesh is a result, not a crash
                rec["meshes"][name] = {"file": str(path), "error": f"{type(e).__name__}: {e}"}
                continue
            rec["meshes"][name] = summary
            sheet_cols.append(frames[:sheet_rows])
            labels.append(f"{name} {summary['score']}")
            log(f"{box.id} {name}: score {summary['score']} IoU {summary['iou']} SSIM {summary['ssim']} "
                f"PSNR {summary['psnr']} sharp {summary['sharpness']} ({summary['seconds']} s)")
        scored = {k: v["score"] for k, v in rec["meshes"].items() if v.get("score") is not None}
        rec["best"] = max(scored, key=scored.get) if scored else None
        cur, nw = rec["meshes"].get("current", {}), rec["meshes"].get("new", {})
        rec["card"] = {
            "score": nw.get("score"), "grade": nw.get("grade"), "currentScore": cur.get("score"),
            "delta": round(nw["score"] - cur["score"], 1) if nw.get("score") is not None and cur.get("score")
            is not None else None,
            "line": card_line(nw, cur),
        }
        d = out / box.id
        d.mkdir(parents=True, exist_ok=True)
        n = min(len(c) for c in sheet_cols) if sheet_cols else 0
        if n:
            contact_sheet([[c[i] for c in sheet_cols] for i in range(n)], labels, d / "sheet.jpg")
            rec["sheet"] = str(d / "sheet.jpg")
        (d / DETAIL_FILE).write_text(json.dumps(rec, indent=2), encoding="utf-8")
        if publish_card and (new / box.id).is_dir():
            shutil.copyfile(d / DETAIL_FILE, new / box.id / DETAIL_FILE)  # beside the new GLB, for the card
        rows.append(rec)
    doc = {"version": 1, "scene": scene_dir.name, "sets": {k: str(v) for k, v in sets.items()},
           "objects": [{k: r[k] for k in ("id", "label", "best", "card")} | {"scores": {
               m: v.get("score") for m, v in r["meshes"].items()}} for r in rows]}
    out.mkdir(parents=True, exist_ok=True)
    (out / "detail-summary.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return doc


def card_line(new: dict, cur: dict) -> str:
    if new.get("score") is None:
        return "not scored"
    parts = [f"Detail {new['score']} ({new['grade']})"]
    if cur.get("score") is not None:
        parts.append(f"was {cur['score']}")
    if new.get("iou") is not None:
        parts.append(f"IoU {new['iou']:.2f}")
    if new.get("ssim") is not None:
        parts.append(f"SSIM {new['ssim']:.2f}")
    m = new.get("mesh", {})
    if m:
        parts.append(f"{m.get('triangles')} tris, {m.get('holes')} holes")
    return " · ".join(parts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--current", default=None, help="default <scene>/objects")
    ap.add_argument("--new", default=None, help="default <scene>/objects-detail")
    ap.add_argument("--method", action="append", default=[], help="NAME=DIR with <id>/mesh.{glb,obj,ply}")
    ap.add_argument("--out", default=None, help="default <scene>/detail-eval")
    ap.add_argument("--objects", default=None)
    ap.add_argument("--object", action="append", default=None)
    ap.add_argument("--views", default=None, help="default <scene>/views")
    ap.add_argument("--orbit", action="store_true", help="also render object-centric splat references")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--max-views", type=int, default=12)
    ap.add_argument("--no-card", action="store_true", help="do not copy detail.json beside the new GLB")
    args = ap.parse_args(argv)
    methods = dict(m.split("=", 1) for m in args.method)
    doc = evaluate(args.scene, args.current, args.new, methods, args.out, args.objects, args.object, args.views,
                   args.orbit, args.size, args.max_views, publish_card=not args.no_card)
    for o in doc["objects"]:
        print(f"{o['id']:<16} best {o['best'] or '-':<8} {o['card']['line']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
