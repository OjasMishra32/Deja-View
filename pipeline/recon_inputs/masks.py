"""Person masks for reconstruction frames, so people who move are not baked into the static scene.

For every image in IMAGES the person probability comes from the video pipeline's segmenter
(common.models.PersonSegmenter, DeepLabV3), averaged over a horizontal flip and taken as the maximum
over two input scales (the larger one keeps thin limbs, the smaller one whole bodies close to the
camera). It is thresholded low (recall matters more than precision here: a masked background pixel
costs little, a person left in costs a ghost), small specks are dropped, gaps closed, regions the person
encloses filled (between an arm and the body), and the result dilated.

Writes, per image NAME (images/<group>/<file>.jpg, the pipeline/recon layout):
  masks/NAME.png          255 = static scene (use), 0 = person (ignore): what pipeline/recon and COLMAP's
                          feature extractor read (COLMAP keeps features only where the mask is non-zero)
  masks_person/NAME.png   the inverse, white = person, for tools that want the person itself
plus masks.json (settings, masked fraction per image) and `masked` per image in frames.json.

CLI:
  python pipeline/recon_inputs/masks.py RECON_DIR [--model deeplabv3-resnet50] [--dilate 24] [--threshold 0.3]
  # split across machines: each run takes a slice of the sorted image list, then one run collects
  python pipeline/recon_inputs/masks.py RECON_DIR --range 0:260      (Mac, MPS)
  python pipeline/recon_inputs/masks.py RECON_DIR --range 260:       (HiPerGator CPU, TW_DEVICE=cpu)
  python pipeline/recon_inputs/masks.py RECON_DIR --collect
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import env as _env  # noqa: F401,E402
from common.device import empty_cache, pick_device  # noqa: E402
from common.models import DEFAULT_SEGMENTER, PersonSegmenter  # noqa: E402


def person_probability(seg_small: PersonSegmenter, seg_large: PersonSegmenter, rgb: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    flipped = np.ascontiguousarray(rgb[:, ::-1])
    probs = []
    for seg in (seg_small, seg_large):
        p = seg(np.stack([rgb, flipped]), out_hw=(h, w))
        probs.append(0.5 * (p[0] + p[1][:, ::-1]))
    return np.maximum(probs[0], probs[1])


def clean_mask(prob: np.ndarray, threshold: float, dilate: int, min_area: float) -> np.ndarray:
    import cv2

    m = (prob >= threshold).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area * m.size
    m = keep[labels].astype(np.uint8)
    close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, close)
    if dilate > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate + 1, 2 * dilate + 1))
        m = cv2.dilate(m, k)
    # Fill what the person encloses: flood the background from a zero border; anything left unflooded is inside.
    ff = np.pad(m, 1)
    cv2.floodFill(ff, None, (0, 0), 1)
    m[ff[1:-1, 1:-1] == 0] = 1
    return m.astype(bool)


def run(recon: Path, model: str, threshold: float, dilate: int, short_small: int, short_large: int,
        min_area: float, start: int = 0, end: int | None = None) -> dict:
    from PIL import Image

    images = sorted((recon / "images").rglob("*.jpg"))
    whole = start == 0 and (end is None or end >= len(images))
    images = images[start:end]
    out_use = recon / "masks"
    out_person = recon / "masks_person"
    device = pick_device()
    seg_small = PersonSegmenter(model, device=device, short_side=short_small)
    seg_large = PersonSegmenter(model, device=device, short_side=short_large)
    seg_large.model = seg_small.model  # same weights, two input sizes
    stats = {}
    t0 = time.time()
    for i, p in enumerate(images):
        rgb = np.asarray(Image.open(p).convert("RGB"))
        prob = person_probability(seg_small, seg_large, rgb)
        m = clean_mask(prob, threshold, dilate, min_area)
        name = p.relative_to(recon / "images").as_posix()
        for root, arr in ((out_use, ~m), (out_person, m)):
            dst = root / f"{name}.png"
            dst.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(arr.astype(np.uint8) * 255).save(dst, optimize=True)
        stats[name] = round(float(m.mean()), 5)
        if (i + 1) % 25 == 0 or i + 1 == len(images):
            empty_cache(device)
            print(f"masks {i + 1}/{len(images)} ({time.time() - t0:.0f}s)", flush=True)
    doc = {
        "model": model, "device": device, "threshold": threshold, "dilate_px": dilate,
        "input_short_sides": [short_small, short_large], "flip_tta": True, "min_area": min_area,
        "convention": {"masks": "255 = use (static scene), 0 = person; COLMAP and pipeline/recon read this",
                       "masks_person": "255 = person (the inverse)"},
        "fraction": stats,
    }
    if not whole:
        (recon / f"masks.part-{start}-{start + len(images)}.json").write_text(json.dumps(doc, indent=1))
        return doc
    return write_summary(recon, doc)


def collect(recon: Path) -> dict:
    """Summarise a split run from the mask files themselves (a slice may have been stopped early once another
    machine had covered its tail), with the settings of the part files."""
    from PIL import Image

    parts = sorted(recon.glob("masks.part-*.json"))
    if not parts:
        raise SystemExit("no masks.part-*.json to collect")
    doc = json.loads(parts[0].read_text())
    doc["device"] = sorted({json.loads(p.read_text())["device"] for p in parts})
    names = sorted(p.relative_to(recon / "images").as_posix() for p in (recon / "images").rglob("*.jpg"))
    missing = [n for n in names if not (recon / "masks" / f"{n}.png").is_file()
               or not (recon / "masks_person" / f"{n}.png").is_file()]
    if missing:
        raise SystemExit(f"{len(missing)} images have no mask yet, e.g. {missing[:3]}")
    doc["fraction"] = {n: round(float(np.mean(np.asarray(Image.open(recon / "masks" / f"{n}.png")) == 0)), 5)
                       for n in names}
    out = write_summary(recon, doc)
    for p in parts:
        p.unlink()
    return out


def write_summary(recon: Path, doc: dict) -> dict:
    stats = doc["fraction"]
    (recon / "masks.json").write_text(json.dumps(doc, indent=1))
    frames = recon / "frames.json"
    if frames.is_file():
        fj = json.loads(frames.read_text())
        for rec in fj.get("images", []):
            if rec["name"] in stats:
                rec["masked"] = stats[rec["name"]]
        frames.write_text(json.dumps(fj, indent=1))
    return doc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recon", type=Path, help="folder with images/")
    ap.add_argument("--model", default=DEFAULT_SEGMENTER)
    ap.add_argument("--threshold", type=float, default=0.3)
    ap.add_argument("--dilate", type=int, default=24, help="pixels at the image's resolution")
    ap.add_argument("--short-small", type=int, default=520)
    ap.add_argument("--short-large", type=int, default=880)
    ap.add_argument("--min-area", type=float, default=2e-4, help="drop blobs smaller than this fraction of the image")
    ap.add_argument("--range", default="", help="START:END slice of the sorted image list (one machine's share)")
    ap.add_argument("--collect", action="store_true", help="merge the masks.part-*.json of a split run")
    args = ap.parse_args(argv)
    if args.collect:
        doc = collect(args.recon)
    else:
        start, end = 0, None
        if args.range:
            a, b = args.range.split(":")
            start, end = int(a or 0), (int(b) if b else None)
        doc = run(args.recon, args.model, args.threshold, args.dilate, args.short_small, args.short_large,
                  args.min_area, start, end)
    fr = np.array(list(doc["fraction"].values()))
    print(f"{len(fr)} masks, person fraction mean {fr.mean():.3f} max {fr.max():.3f}, empty {(fr == 0).sum()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
