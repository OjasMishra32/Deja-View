#!/usr/bin/env python3
"""The evaluator (team/shivin-reconstruction-loop.md, deliverable 1).

    python pipeline/objects/eval/evaluate.py --scene data/scenes/kitchen --object all
    python pipeline/objects/eval/evaluate.py --scene data/scenes/kitchen --object stove --glb runs/trial3/roblox.glb

For each object and each held-out scene view (`views/views.json`: the 16 scene cameras; the object bakes render their
own orbit, so every scene view is held out), it renders the mesh from that camera and compares it with the splat
render and the object's mask from `masks-all/` (matched by label and overlap; the object box's depth silhouette when
no mask fits). Metrics, with mean / median / worst over views (one lucky angle is not a pass):

  silhouette IoU, depth MAE and relative depth error, PSNR and SSIM inside the mask, normal consistency (splat depth
  normals vs mesh normals), and per mesh: Chamfer distance to the splat surface, texture sharpness of the baked atlas,
  holes as boundary edges per 1000 triangles, watertightness, components, triangles, atlas size and GLB bytes.

It returns one weighted score and the hard gates (`gates.py`). Writes `<out>/eval.json` (default: beside the GLB,
`objects/<id>/eval.json`) and `<out>/eval-sheet.jpg` (mesh | splat | mask | difference per view). Reads approvals,
never writes them; uploads nothing.
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

from objects.detail import metrics as M  # noqa: E402
from objects.detail.evaluate import Ref, box_silhouette, contact_sheet, unproject  # noqa: E402
from objects.detail.glb import glb_info, merged, read_mesh  # noqa: E402
from objects.detail.maps import uv_raster  # noqa: E402
from objects.detail.objects_io import ObjectBox, load_objects, objects_file, pick  # noqa: E402
from objects.detail.raster import Camera, Frame, project, render  # noqa: E402
from objects.eval import gates as G  # noqa: E402
from objects.eval.geometry import chamfer, depth_normals, normal_consistency, sample_surface  # noqa: E402

EVAL_FILE = "eval.json"
SHEET_FILE = "eval-sheet.jpg"
MIN_PIXELS = 300
OCCLUSION_TOL = 0.04
MASK_MATCH_IOU = 0.15  # a detection mask must overlap the box silhouette this much to stand for the object

WEIGHTS = {"iou": 0.25, "ssim": 0.15, "psnr": 0.10, "depth": 0.10, "chamfer": 0.10, "normals": 0.10,
           "sharpness": 0.10, "holes": 0.10}


def sha1_file(path: Path) -> str:
    import hashlib

    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --- references --------------------------------------------------------------------------------------------------

def _load_mask(path: Path, shape) -> np.ndarray:
    from PIL import Image

    im = Image.open(path).convert("L")
    if im.size != (shape[1], shape[0]):
        im = im.resize((shape[1], shape[0]), Image.NEAREST)
    return np.asarray(im) > 127


def detections(masks_dir: Path | None) -> list[dict]:
    if masks_dir is None or not (masks_dir / "detections.json").exists():
        return []
    doc = json.loads((masks_dir / "detections.json").read_text(encoding="utf-8"))
    return doc.get("detections", doc if isinstance(doc, list) else [])


def object_mask(box_sil: np.ndarray, view_file: str, label: str, dets: list[dict], masks_dir: Path | None
                ) -> tuple[np.ndarray, str]:
    """The detection mask of this label in this view that best overlaps the object's box silhouette, else the box
    silhouette itself. Returns (mask, source)."""
    best, best_iou = None, MASK_MATCH_IOU
    for d in dets:
        if d.get("view") != view_file or str(d.get("label", "")).lower() != label.lower():
            continue
        p = masks_dir / d["mask"]
        if not p.exists():
            continue
        m = _load_mask(p, box_sil.shape)
        iou = M.iou(m, box_sil)
        if iou > best_iou:
            best, best_iou = m, iou
    if best is None:
        return box_sil, "box"
    return best, "mask"


def held_out_refs(views_dir: Path, box: ObjectBox, masks_dir: Path | None = None, max_views: int = 16
                  ) -> list[tuple[Ref, str]]:
    meta = json.loads((views_dir / "views.json").read_text(encoding="utf-8"))
    dets = detections(masks_dir)
    out = []
    corners = np.array([[x, y, z] for x in (box.lo[0], box.hi[0]) for y in (box.lo[1], box.hi[1])
                        for z in (box.lo[2], box.hi[2])])
    for v in meta.get("views", []):
        name = v.get("file") or v.get("image")
        cam = Camera.from_view({**meta, **v}, name)
        u, vv, z = project(corners, cam)
        if (z <= 0).all() or u.max() < 0 or u.min() > cam.width or vv.max() < 0 or vv.min() > cam.height:
            continue
        img = views_dir / name
        dep = views_dir / v.get("depth", name.rsplit(".", 1)[0] + "_depth.npy")
        if not img.exists() or not dep.exists():
            continue
        depth = np.load(dep).astype(np.float64)
        sil = box_silhouette(depth, cam, box)
        if sil.sum() < MIN_PIXELS:
            continue
        mask, source = object_mask(sil, name, box.label, dets, masks_dir)
        from PIL import Image

        rgb = np.asarray(Image.open(img).convert("RGB"), np.float64) / 255.0
        out.append((Ref(cam, rgb, depth, mask, "view"), source))
    out.sort(key=lambda r: -int(r[0].sil.sum()))
    return out[:max_views]


# --- per view ------------------------------------------------------------------------------------------------------

def compare_view(ref: Ref, fr: Frame) -> tuple[dict, np.ndarray]:
    occluded = (ref.depth > 0) & fr.mask & ~ref.sil & (ref.depth < fr.depth - OCCLUSION_TOL)
    pred = fr.mask & ~occluded
    both = pred & ref.sil & (ref.depth > 0)
    rel = None
    if both.any():
        rel = float((np.abs(ref.depth[both] - fr.depth[both]) / np.maximum(ref.depth[both], 1e-6)).mean())
    P = unproject(ref.depth, ref.cam)
    rn, rok = depth_normals(P, ref.sil & (ref.depth > 0))
    nc = normal_consistency(rn, rok, fr.normal, fr.mask, both)
    row = {
        "iou": M.iou(ref.sil, pred),
        "depthMAE": M.depth_mae(ref.depth, fr.depth, ref.sil, pred),
        "depthRel": rel,
        "psnr": M.psnr(ref.rgb, fr.rgb, both),
        "ssim": M.ssim(ref.rgb, fr.rgb, both),
        **nc,
        "pixels": int(both.sum()),
    }
    diff = np.abs(ref.rgb - fr.rgb).mean(axis=-1)
    union = ref.sil | pred
    heat = np.zeros(ref.rgb.shape)
    heat[..., 0] = np.where(union, np.clip(diff * 3, 0, 1), 0)
    heat[..., 1] = np.where(ref.sil & ~pred, 0.6, 0)  # mask the mesh misses: green
    heat[..., 2] = np.where(pred & ~ref.sil, 0.8, 0)  # mesh outside the mask: blue
    return row, heat


def robust(rows: list[dict], key: str, worst: str) -> dict:
    vals = [r[key] for r in rows if r.get(key) is not None]
    if not vals:
        return {"mean": None, "median": None, "worst": None}
    w = min(vals) if worst == "min" else max(vals)
    return {"mean": round(float(np.mean(vals)), 4), "median": round(float(np.median(vals)), 4), "worst": round(w, 4)}


def atlas_sharpness(prims) -> float | None:
    vals = []
    for p in prims:
        if p.image is None or p.UV is None:
            continue
        size = min(p.image.shape[0], 1024)
        img = p.image
        if img.shape[0] != size:
            from PIL import Image

            img = np.asarray(Image.fromarray(img).resize((size, size), Image.BILINEAR))
        face, _ = uv_raster(p, size)
        v = M.laplacian_variance(img, face >= 0)
        if v is not None:
            vals.append(v)
    return round(float(np.mean(vals)), 2) if vals else None


# --- the score -----------------------------------------------------------------------------------------------------

def score(r: dict) -> float | None:
    """0-100. Robust terms: IoU and SSIM use the average of the mean and the worst view."""
    iou, ssim = r["iou"], r["ssim"]
    if iou["mean"] is None:
        return None

    def rob(x):
        return 0.5 * x["mean"] + 0.5 * x["worst"] if x["mean"] is not None else 0.0

    terms = {
        "iou": rob(iou),
        "ssim": max(0.0, rob(ssim)),
        "psnr": 0.0 if r["psnr"]["mean"] is None else float(np.clip((r["psnr"]["mean"] - 15) / 20, 0, 1)),
        "depth": 0.0 if r["depthMAE"]["mean"] is None else float(np.clip(1 - r["depthMAE"]["mean"] / 0.05, 0, 1)),
        "chamfer": 0.0 if r["surface"].get("chamfer") is None else float(np.clip(
            1 - max(0.0, r["surface"]["chamfer"] - (r["surface"].get("samplingFloor") or 0.0)) / 0.03, 0, 1)),
        "normals": r["normalCos"]["mean"] or 0.0,
        "sharpness": 0.0 if r["sharpness"] is None else float(min(1.0, r["sharpness"])),
        "holes": float(np.clip(1 - r["mesh"]["holesPer1000"] / 20.0, 0, 1)),
    }
    r["scoreTerms"] = {k: round(v, 4) for k, v in terms.items()}
    return round(100 * sum(WEIGHTS[k] * terms[k] for k in WEIGHTS), 2)


def evaluate_glb(glb: Path, refs: list[tuple[Ref, str]], scan: dict | None = None, sheet: Path | None = None,
                 sheet_rows: int = 4) -> dict:
    t0 = time.time()
    glb = Path(glb)
    prims = read_mesh(glb)
    V, F = merged(prims)
    rows, tiles = [], []
    area = M.mesh_stats(V, F)["areaM2"] if len(F) else 0.0
    n_samples = int(np.clip(area / 0.004 ** 2, 20000, 120000))  # about one sample per 4 mm
    mesh_pts, _ = sample_surface(V, F, n_samples)
    seen = np.zeros(len(mesh_pts), bool)  # Chamfer only over surface some held-out camera sees (no one films the base)
    for ref, source in refs:
        fr = render(prims, ref.cam)
        u, v, z = project(mesh_pts, ref.cam)
        iu, iv = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
        inb = (z > 0) & (iu >= 0) & (iu < ref.cam.width) & (iv >= 0) & (iv < ref.cam.height)
        hit = np.zeros(len(z), bool)
        hit[inb] = fr.mask[iv[inb], iu[inb]] & (np.abs(fr.depth[iv[inb], iu[inb]] - z[inb]) < 0.01 + 0.01 * z[inb])
        seen |= hit
        row, heat = compare_view(ref, fr)
        row["camera"] = ref.cam.name
        row["maskSource"] = source
        rows.append(row)
        if len(tiles) < sheet_rows:
            mesh_img = np.where(fr.mask[..., None], fr.rgb, 0.08)
            tiles.append([mesh_img, ref.rgb, np.repeat(ref.sil[..., None].astype(float), 3, axis=-1), heat])
    ref_pts = np.concatenate([unproject(r.depth, r.cam)[r.sil & (r.depth > 0)] for r, _ in refs]) if refs else \
        np.zeros((0, 3))
    if len(ref_pts) > 60000:
        ref_pts = ref_pts[np.random.default_rng(0).choice(len(ref_pts), 60000, replace=False)]
    # Both surfaces are point samples (the splats once per pixel, the mesh once per few mm), so even a perfect mesh
    # measures about 0.38 spacings each way; `samplingFloor` estimates that and the score only counts what is above it
    fps = [float((r.depth[r.sil & (r.depth > 0)] / r.cam.fx).mean()) for r, _ in refs if (r.sil & (r.depth > 0)).any()]
    footprint = round(float(np.mean(fps)), 5) if fps else None
    stats = M.mesh_stats(V, F)
    stats["holesPer1000"] = round(1000.0 * stats["boundaryEdges"] / max(stats["triangles"], 1), 3)
    info = glb_info(prims)
    lap = atlas_sharpness(prims)
    ref_lap = M.summarise([M.laplacian_variance(r.rgb, r.sil) for r, _ in refs])
    res = {
        "glb": str(glb), "sha1": sha1_file(glb), "bytes": glb.stat().st_size,
        "views": len(rows), "maskSources": sorted({r["maskSource"] for r in rows}),
        "iou": robust(rows, "iou", "min"), "depthMAE": robust(rows, "depthMAE", "max"),
        "depthRel": robust(rows, "depthRel", "max"), "psnr": robust(rows, "psnr", "min"),
        "ssim": robust(rows, "ssim", "min"), "normalCos": robust(rows, "normalCos", "min"),
        "surface": {**chamfer(mesh_pts[seen], ref_pts), "visibleShare": round(float(seen.mean()), 4),
                    "pixelFootprint": footprint,
                    "samplingFloor": round(0.19 * ((footprint or 0.0) + float(np.sqrt(area / n_samples))), 5)}, "atlasLapVar": lap, "splatLapVar": ref_lap,
        "sharpness": round(lap / ref_lap, 4) if lap is not None and ref_lap else None,
        "mesh": stats, "chunks": info["chunks"], "atlas": info["textures"], "perView": rows,
    }
    res["score"] = score(res)
    gates = {
        "codes": G.code_gate(scan),
        "texture": G.texture_gate(info["textures"]),
        "silhouette": G.silhouette_gate([r["iou"] for r in rows]),
        "approval": G.approval_gate(glb, res["sha1"]),
    }
    res["gates"] = G.combine(gates)
    res["seconds"] = round(time.time() - t0, 2)
    if sheet is not None and tiles:
        contact_sheet(tiles, ["mesh", "splat", "mask", "difference"], sheet)
        res["sheet"] = str(sheet)
    return res


def scan_glb(glb: Path, out: Path) -> dict | None:
    """The preflight code scan into a scratch folder (never the object's own preflight/, which holds approvals)."""
    try:
        from objects import preflight

        rep = preflight.preflight(glb, out / "eval-scan")
        return rep["scan"]
    except Exception as e:  # noqa: BLE001  (missing OpenCV and friends fail the gate closed, not the run)
        return {"status": "unavailable", "reason": f"{type(e).__name__}: {e}"}


def evaluate_object(scene_dir: Path, box: ObjectBox, glb: Path, out: Path | None = None, views: Path | None = None,
                    masks: Path | None = None, scan: bool = True, judge=None, log=print) -> dict:
    views = views or scene_dir / "views"
    masks = masks if masks is not None else (scene_dir / "masks-all" if (scene_dir / "masks-all").exists() else None)
    out = Path(out) if out else Path(glb).parent
    out.mkdir(parents=True, exist_ok=True)
    refs = held_out_refs(views, box, masks)
    res = evaluate_glb(glb, refs, scan_glb(glb, out) if scan else None, out / SHEET_FILE)
    res = {"id": box.id, "label": box.label, "sizeM": [round(float(x), 3) for x in box.size], **res}
    if judge is not None and res.get("sheet"):
        res["judge"] = judge(Path(res["sheet"]), box.label)
    res["card"] = card(res)
    (out / EVAL_FILE).write_text(json.dumps(res, indent=2), encoding="utf-8")
    log(f"{box.id}: score {res['score']} gates {'pass' if res['gates']['pass'] else 'FAIL ' + ','.join(res['gates']['failed'])}"
        f" IoU {res['iou']['mean']} (worst {res['iou']['worst']}) chamfer {res['surface'].get('chamfer')}")
    return res


def card(res: dict) -> dict:
    """The human-readable scorecard for the review card. Advisory: it never approves anything."""
    g = res["gates"]
    lines = [f"Score {res['score']} · {'gates pass' if g['pass'] else 'BLOCKED: ' + ', '.join(g['failed'])}",
             f"IoU {res['iou']['mean']} (worst {res['iou']['worst']}) · SSIM {res['ssim']['mean']} · "
             f"PSNR {res['psnr']['mean']}",
             f"Chamfer {res['surface'].get('chamfer')} m · normals {res['normalCos']['mean']} · "
             f"sharpness {res['sharpness']}",
             f"{res['mesh']['triangles']} tris · {res['mesh']['holesPer1000']} holes/1k · "
             f"{'watertight' if res['mesh']['watertight'] else 'open'} · {res['bytes'] / 1e6:.2f} MB",
             f"approval: {g['approval']['approval']} (sha1 {res['sha1'][:10]})"]
    j = res.get("judge")
    if j and j.get("ok"):
        s = j["scores"]
        lines.append(f"judge (advisory): shape {s.get('shape')}/5, texture {s.get('texture')}/5, scale "
                     f"{s.get('scale')}/5, artifacts {s.get('artifacts')}/5")
    return {"score": res["score"], "pass": g["pass"], "lines": lines, "advisory": True}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--object", action="append", default=None, help="id or label; repeat, or 'all' (default)")
    ap.add_argument("--objects", default=None)
    ap.add_argument("--glb", default=None, help="evaluate this file instead of objects/<id>/roblox.glb (one object)")
    ap.add_argument("--set", default="objects", help="folder under the scene holding <id>/roblox.glb")
    ap.add_argument("--out", default=None, help="write eval.json here (default: beside the GLB)")
    ap.add_argument("--views", default=None)
    ap.add_argument("--masks", default=None)
    ap.add_argument("--no-scan", action="store_true", help="skip the code scan (the codes gate then fails closed)")
    ap.add_argument("--judge", action="store_true", help="also ask the advisory VLM judge (needs GEMINI_API_KEY)")
    a = ap.parse_args(argv)
    scene = Path(a.scene)
    boxes = pick(load_objects(objects_file(scene, a.objects)), a.object)
    judge = None
    if a.judge:
        from objects.eval.judge import Judge

        judge = Judge(cache_dir=scene / "eval-judge-cache")
    bad = 0
    for box in boxes:
        glb = Path(a.glb) if a.glb else scene / a.set / box.id / "roblox.glb"
        if not glb.exists():
            print(f"{box.id}: no mesh at {glb}")
            bad += 1
            continue
        out = Path(a.out) / box.id if a.out and len(boxes) > 1 else (Path(a.out) if a.out else None)
        evaluate_object(scene, box, glb, out, Path(a.views) if a.views else None, Path(a.masks) if a.masks else None,
                        not a.no_scan, judge)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
