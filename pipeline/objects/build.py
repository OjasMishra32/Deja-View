#!/usr/bin/env python3
"""Lift the segmentation masks onto the splats and write objects.json.

    python pipeline/objects/build.py --scene data/scenes/kitchen \
        --views data/scenes/kitchen/views --masks data/scenes/kitchen/masks

Each detection becomes a 3D candidate. Candidates of the same label are clustered by
their 3D centre and box overlap, so two cabinets become two objects instead of one
giant box. Every cluster is lifted with `objects.lift.describe_object`, which takes
the robust bounds and median colour and writes the schema in `docs/object-layer.md`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import reality_split as rs  # noqa: E402
from objects import lift  # noqa: E402
from objects import scene as obj_scene  # noqa: E402

OBJECTS_FILE = "objects.json"
DEFAULT_STUDS = 3.57


def bbox_iou(a: tuple[np.ndarray, np.ndarray], b: tuple[np.ndarray, np.ndarray]) -> float:
    lo = np.maximum(a[0], b[0])
    hi = np.minimum(a[1], b[1])
    inter = np.maximum(hi - lo, 0.0).prod()
    va = np.maximum(a[1] - a[0], 0.0).prod()
    vb = np.maximum(b[1] - b[0], 0.0).prod()
    denom = va + vb - inter
    return float(inter / denom) if denom > 0 else 0.0


def cluster_candidates(items: list[dict], centroid_dist: float = 0.35, iou_min: float = 0.2) -> list[list[dict]]:
    """Group candidates that are the same physical object seen from different views."""
    clusters: list[list[dict]] = []
    for item in items:
        best = None
        best_d = float("inf")
        for cluster in clusters:
            c = cluster[0]
            d = float(np.linalg.norm(item["centroid"] - c["centroid"]))
            iou = bbox_iou(item["bounds"], c["bounds"])
            if (d <= centroid_dist or iou >= iou_min) and d < best_d:
                best, best_d = cluster, d
        if best is None:
            clusters.append([item])
        else:
            best.append(item)
            # keep the cluster centre stable: mean of the members' centres
            pts = np.stack([m["centroid"] for m in best])
            best[0]["centroid"] = pts.mean(axis=0)
    return clusters


def _camera(view: dict) -> rs.InputCamera:
    return rs.InputCamera(
        int(view["width"]), int(view["height"]), float(view["fx"]), float(view["fy"]),
        float(view["cx"]), float(view["cy"]), np.asarray(view["c2w"], np.float64), "render",
    )


def _mask(path: Path) -> np.ndarray:
    from PIL import Image
    return np.asarray(Image.open(path).convert("L")) > 127


def build(scene_dir: str | Path, views_dir: str | Path, masks_dir: str | Path, out: str | Path | None = None,
          labels: list[str] | None = None, min_score: float = 0.3, min_views: int = 2,
          min_splats: int = 200, max_size_m: float = 5.0, max_volume_m3: float = 30.0, log=print) -> dict:
    scene_dir = Path(scene_dir)
    views_dir = Path(views_dir)
    masks_dir = Path(masks_dir)
    splats, scene = obj_scene.load_scene(scene_dir)
    points = np.asarray(splats.means, np.float64)
    colors = np.asarray(splats.rgb(), np.float64)
    meta = json.loads((views_dir / "views.json").read_text(encoding="utf-8"))
    view_by_file = {v["file"]: v for v in meta["views"]}
    dets = json.loads((masks_dir / "detections.json").read_text(encoding="utf-8"))["detections"]
    labels = labels or sorted({d["label"] for d in dets})
    world = scene.get("world") if isinstance(scene.get("world"), dict) else {}
    studs = float(world.get("studsPerMeter") or DEFAULT_STUDS)

    objects = []
    for label in labels:
        candidates = []
        for det in dets:
            if det["label"] != label or det["score"] < min_score:
                continue
            view = view_by_file.get(det["view"])
            if view is None:
                continue
            cam = _camera(view)
            mask = _mask(masks_dir / det["mask"])
            if mask.shape != (cam.height, cam.width):
                log(f"skip {det['mask']}: mask {mask.shape} vs view {(cam.height, cam.width)}")
                continue
            depth = None
            if view.get("depth"):
                depth_file = views_dir / view["depth"]
                if depth_file.exists():
                    depth = np.load(depth_file)
            keep = lift.mask_points(points, cam, mask, depth=depth)
            if int(keep.sum()) < lift.MIN_POINTS:
                continue
            lo, hi = lift.robust_bounds(points[keep])
            candidates.append({
                "view": view, "mask": mask, "depth": depth, "score": float(det["score"]),
                "centroid": (lo + hi) / 2.0, "bounds": (lo, hi),
            })
        clusters = cluster_candidates(candidates)
        made = 0
        for cluster in clusters:
            if len(cluster) < min_views:
                continue
            views = [(_camera(c["view"]), c["mask"], c["depth"]) for c in cluster]
            obj = lift.describe_object(points, colors, label, views, min_views=min_views,
                                       min_points=min_splats, studs_per_meter=studs)
            if obj is None:
                continue
            dims = [v / studs for v in obj["size"]]
            volume = dims[0] * dims[1] * dims[2]
            if max(dims) > max_size_m or volume > max_volume_m3:
                log(f"skip {obj['id']}: {dims[0]:.1f} x {dims[1]:.1f} x {dims[2]:.1f} m is too large")
                continue
            made += 1
            obj["id"] = obj["id"] if len(clusters) == 1 else f"{obj['id']}-{made}"
            obj["confidence"] = round(float(np.mean([c["score"] for c in cluster])), 4)
            obj["source"] = {
                **(obj.get("source") or {}),
                "views": len(cluster),
                "detections": len(cluster),
                "score": round(float(max(c["score"] for c in cluster)), 4),
            }
            objects.append(obj)
            log(f"{obj['id']}: {obj['source']['splats']} splats, {len(cluster)} views, colour {obj['color']}")
        log(f"{label}: {len(candidates)} candidates -> {len(objects)} objects so far")

    doc = {
        "version": 1,
        "sceneId": scene.get("id") or scene_dir.name,
        "units": "studs",
        "studsPerMeter": studs,
        "frame": "room frame x studsPerMeter, Y up, -Z forward, floor at y = 0",
        "style": "flat",
        "objects": objects,
    }
    dest = Path(out) if out else scene_dir / OBJECTS_FILE
    tmp = dest.with_name(f".{dest.name}.tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    tmp.replace(dest)
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--views", required=True)
    ap.add_argument("--masks", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--labels", default=None)
    ap.add_argument("--min-score", type=float, default=0.3)
    ap.add_argument("--min-views", type=int, default=2)
    ap.add_argument("--min-splats", type=int, default=200)
    ap.add_argument("--max-size-m", type=float, default=5.0)
    ap.add_argument("--max-volume-m3", type=float, default=30.0)
    args = ap.parse_args(argv)
    labels = [s.strip().lower() for s in args.labels.split(",") if s.strip()] if args.labels else None
    doc = build(args.scene, args.views, args.masks, args.out, labels, args.min_score, args.min_views,
                args.min_splats, args.max_size_m, args.max_volume_m3)
    print(f"{len(doc['objects'])} objects -> {args.out or Path(args.scene) / OBJECTS_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
