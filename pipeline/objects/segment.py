#!/usr/bin/env python3
"""Detect objects with Grounding DINO and segment them with SAM 2.1.

    python pipeline/objects/segment.py --views data/scenes/kitchen/views \
        --labels fridge,cabinet,counter,stove,trash,handle,door --out data/scenes/kitchen/masks

Reads `views.json` and the PNGs written by `render_views.py`. Writes one binary mask
per detection plus `detections.json`. Models load through Transformers and are pinned
in `pipeline/models.lock.json`; weights are downloaded by Hugging Face, never committed.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

DETECTIONS_FILE = "detections.json"
DEFAULT_SAM = "facebook/sam2.1-hiera-small"
DEFAULT_SAM_REV = "ee5bba1d82bb8749febdf90f45e84b687142ba03"
DEFAULT_DINO = "IDEA-Research/grounding-dino-tiny"
DEFAULT_DINO_REV = "a2bb814dd30d776dcf7e30523b00659f4f141c71"


def vocabulary(text: str) -> list[str]:
    """Comma or newline separated labels, lower case, without duplicates, in order."""
    out: list[str] = []
    for part in text.replace("\n", ",").split(","):
        label = " ".join(part.strip().lower().split())
        if label and label not in out:
            out.append(label)
    return out


def match_label(text: str, vocab: list[str]) -> str | None:
    """Map a detector phrase like 'a stainless steel fridge' onto a vocabulary label."""
    t = " ".join(str(text).lower().replace("_", " ").split())
    for label in vocab:
        if label in t:
            return label
    return None


def select_mask(masks, scores) -> np.ndarray:
    """Pick the highest-IoU mask for one box from the SAM output shapes we see."""
    m = np.asarray(masks)
    s = np.asarray(scores).reshape(-1)
    if m.ndim == 4:  # [num_masks, 1, H, W] or [1, num_masks, H, W]
        m = np.squeeze(m)
        if m.ndim == 2:
            return m.astype(bool)
        if m.shape[0] == len(s):
            return m[int(np.argmax(s))].astype(bool)
        return m.reshape(-1, m.shape[-2], m.shape[-1])[int(np.argmax(s))].astype(bool)
    if m.ndim == 3:
        if m.shape[0] == len(s):
            return m[int(np.argmax(s))].astype(bool)
        return m[0].astype(bool)
    return m.astype(bool)


def run(
    views_dir: str | Path,
    out_dir: str | Path,
    labels: list[str],
    sam_id: str = DEFAULT_SAM,
    dino_id: str = DEFAULT_DINO,
    sam_rev: str | None = DEFAULT_SAM_REV,
    dino_rev: str | None = DEFAULT_DINO_REV,
    threshold: float = 0.28,
    text_threshold: float = 0.22,
    min_box: float = 12.0,
    limit: int | None = None,
    device: str | None = None,
    log=print,
) -> dict:
    import torch
    from PIL import Image
    from transformers import (
        AutoModelForZeroShotObjectDetection,
        AutoProcessor,
        Sam2Model,
        Sam2Processor,
    )

    views_dir = Path(views_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = json.loads((views_dir / "views.json").read_text(encoding="utf-8"))
    views = meta["views"][: limit or len(meta["views"])]
    if not labels:
        raise ValueError("no labels")

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    log(f"device {dev}; DINO {dino_id}; SAM {sam_id}; {len(views)} views")
    dino_proc = AutoProcessor.from_pretrained(dino_id, revision=dino_rev)
    dino = AutoModelForZeroShotObjectDetection.from_pretrained(dino_id, revision=dino_rev).to(dev).eval()
    sam_proc = Sam2Processor.from_pretrained(sam_id, revision=sam_rev)
    sam = Sam2Model.from_pretrained(sam_id, revision=sam_rev).to(dev).eval()
    prompt = ". ".join(labels) + "."

    detections = []
    for view in views:
        image = Image.open(views_dir / view["file"]).convert("RGB")
        w, h = image.size
        inputs = dino_proc(images=image, text=prompt, return_tensors="pt").to(dev)
        with torch.inference_mode():
            outputs = dino(**inputs)
        found = dino_proc.post_process_grounded_object_detection(
            outputs,
            inputs["input_ids"],
            threshold=threshold,
            text_threshold=text_threshold,
            target_sizes=[(h, w)],
        )[0]
        scores = found["scores"].detach().cpu().numpy()
        boxes = found["boxes"].detach().cpu().numpy()
        texts = found.get("text_labels") or found.get("labels") or []
        keep = []
        for box, score, text in zip(boxes, scores, texts):
            label = match_label(text, labels)
            x0, y0, x1, y1 = [float(v) for v in box]
            if label is None or score < threshold or (x1 - x0) < min_box or (y1 - y0) < min_box:
                continue
            keep.append((label, float(score), [x0, y0, x1, y1]))
        if not keep:
            log(f"{view['file']}: no detections")
            continue
        sam_inputs = sam_proc(images=image, input_boxes=[[k[2] for k in keep]], return_tensors="pt").to(dev)
        with torch.inference_mode():
            sam_out = sam(**sam_inputs)
        masks = sam_proc.post_process_masks(
            sam_out.pred_masks.detach().cpu(),
            sam_inputs["original_sizes"].detach().cpu(),
        )[0]
        iou = sam_out.iou_scores.detach().cpu().numpy().reshape(len(keep), -1)
        for i, (label, score, box) in enumerate(keep):
            mask = select_mask(masks[i], iou[i])
            name = f"mask_{Path(view['file']).stem}_{label.replace(' ', '-')}_{i:02d}.png"
            Image.fromarray((mask.astype(np.uint8) * 255)).save(out_dir / name)
            detections.append({
                "view": view["file"],
                "label": label,
                "score": round(score, 4),
                "iou": round(float(iou[i].max()), 4),
                "box": [round(v, 2) for v in box],
                "mask": name,
                "width": w,
                "height": h,
            })
        log(f"{view['file']}: {len(keep)} detections")

    doc = {
        "version": 1,
        "sceneId": meta.get("sceneId"),
        "viewsFile": str(views_dir / "views.json"),
        "labels": labels,
        "models": {"detector": dino_id, "sam": sam_id},
        "detections": detections,
    }
    tmp = out_dir / f".{DETECTIONS_FILE}.tmp"
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    tmp.replace(out_dir / DETECTIONS_FILE)
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--views", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--sam", default=DEFAULT_SAM)
    ap.add_argument("--dino", default=DEFAULT_DINO)
    ap.add_argument("--sam-revision", default=DEFAULT_SAM_REV)
    ap.add_argument("--dino-revision", default=DEFAULT_DINO_REV)
    ap.add_argument("--threshold", type=float, default=0.28)
    ap.add_argument("--text-threshold", type=float, default=0.22)
    ap.add_argument("--min-box", type=float, default=12.0)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--device", default=None)
    args = ap.parse_args(argv)
    out = Path(args.out) if args.out else Path(args.views).parent / "masks"
    doc = run(
        args.views, out, vocabulary(args.labels), args.sam, args.dino,
        args.sam_revision, args.dino_revision,
        args.threshold, args.text_threshold, args.min_box, args.limit, args.device,
    )
    print(f"{len(doc['detections'])} detections -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
