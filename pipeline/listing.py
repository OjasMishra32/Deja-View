#!/usr/bin/env python3
"""Your old home from listing photos (team/shivin.md Update 19, job 2).

Real-estate listing photos carry overlays: the site's or the agent's logo and text in a corner, sometimes a big
translucent mark across the middle. The reconstruction would bake them into the world as floating smears. This finds
them, removes them, and after the rebuild gives the world a walk zone and a spawn facing what the photos saw.

    python pipeline/listing.py clean --photos data/inputs/old-house-kitchen --out /tmp/clean     # preview the clean-up
    (the job) run_job.py with mode "reconstruct" and params {"listing": true}

Finding the overlay. A listing's photos share their overlay, in the same place on every photo, while the room
behind it changes from photo to photo. So the overlay is where every photo has a strong edge and nearly the same
brightness: the per-pixel minimum of the normalised edge maps, gated by a low brightness spread across the photos.
A lone photo, or a mark on only some of them, is caught by the corner check: text and logos in a corner band are a
dense patch of fine, high-contrast strokes that the rest of the photo doesn't have.

Removing it. A mark confined to a border band (a bottom or top strip, the usual place) is cropped off with the band,
which leaves the photo's real pixels untouched for the reconstruction. Anything else (a mark across the middle) is
inpainted. Every decision is written to `listing.json` with a mask preview per photo.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

WORK = 768  # long side of the analysis size
BAND = 0.2  # a mark whose box lies within this share of the height (or width) from an edge is cropped off
EDGE_T = 0.35  # normalised edge strength every photo must reach for a pixel to be overlay
SPREAD_T = 0.10  # max spread of brightness (0..1) across photos at an overlay pixel
CORNER_W, CORNER_H = 0.34, 0.18
MIN_PIXELS = 40  # smaller marks are noise


@dataclass
class Overlay:
    mask: np.ndarray  # bool, at the photo's own size
    source: list = field(default_factory=list)  # "shared", "corner"
    box: tuple | None = None  # x0, y0, x1, y1 in pixels


def _gray(img: np.ndarray) -> np.ndarray:
    a = np.asarray(img, np.float64)
    if a.ndim == 3:
        a = a[..., :3] @ np.array([0.299, 0.587, 0.114])
    return a / 255.0 if a.max() > 1.5 else a


def _resize(a: np.ndarray, w: int, h: int, nearest: bool = False) -> np.ndarray:
    import cv2

    return cv2.resize(a, (w, h), interpolation=cv2.INTER_NEAREST if nearest else cv2.INTER_AREA)


EDGE_FULL = 1.6  # Sobel magnitude on 0..1 brightness that counts as a full-strength edge (a crisp letter outline)


def edge_map(gray: np.ndarray) -> np.ndarray:
    """Absolute edge strength 0..1 after a light blur: overlays are crisp, high-contrast strokes, so the scale is
    fixed rather than per photo (a per-photo percentile lets sensor noise count as edges in flat photos)."""
    import cv2

    g = cv2.GaussianBlur(gray, (0, 0), 0.8)
    gx = cv2.Sobel(g, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_64F, 0, 1, ksize=3)
    return np.clip(np.hypot(gx, gy) / EDGE_FULL, 0, 1)


MAX_MARK = 0.2  # a "mark" whose box covers more of the photo than this is the scene, not an overlay


def _drop_small(u8: np.ndarray, min_pixels: int) -> np.ndarray:
    import cv2

    n, lab, stats, _ = cv2.connectedComponentsWithStats(u8, connectivity=8)
    keep = np.zeros_like(u8)
    for k in range(1, n):
        if stats[k, cv2.CC_STAT_AREA] >= min_pixels:
            keep[lab == k] = 1
    return keep


def _clean_mask(m: np.ndarray, grow: int = 3, min_pixels: int = MIN_PIXELS) -> np.ndarray:
    """Drop stray pixels, close strokes into blobs, drop specks and anything too big to be an overlay, then grow a
    little so the inpainting covers anti-aliased edges."""
    import cv2

    u8 = _drop_small(m.astype(np.uint8), 6)  # isolated pixels never become a blob by closing
    u8 = cv2.morphologyEx(u8, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(u8, connectivity=8)
    keep = np.zeros_like(u8)
    H, W = u8.shape
    for k in range(1, n):
        big = stats[k, cv2.CC_STAT_WIDTH] * stats[k, cv2.CC_STAT_HEIGHT] > MAX_MARK * H * W
        if stats[k, cv2.CC_STAT_AREA] >= min_pixels and not big:
            keep[lab == k] = 1
    if grow:
        keep = cv2.dilate(keep, np.ones((2 * grow + 1, 2 * grow + 1), np.uint8))
    return keep.astype(bool)


def shared_overlay(images: list[np.ndarray]) -> np.ndarray | None:
    """The overlay every photo shares, at WORK size (aspect of the first photo), or None with fewer than 3 photos
    (two photos agree on too much by chance)."""
    if len(images) < 3:
        return None
    h0, w0 = images[0].shape[:2]
    s = WORK / max(h0, w0)
    W, H = int(round(w0 * s)), int(round(h0 * s))
    grays = [_resize(_gray(im), W, H) for im in images]
    edges = np.stack([edge_map(g) for g in grays])
    common = edges.min(axis=0)
    spread = np.stack(grays).std(axis=0)
    m = (common > EDGE_T) & (spread < SPREAD_T)
    # the photos' own frames (a black border, a straight horizon all of them share) are long straight lines, not marks
    m[:2, :] = m[-2:, :] = m[:, :2] = m[:, -2:] = False
    return _clean_mask(m)


def stroke_density(gray: np.ndarray) -> np.ndarray:
    """Fine high-contrast strokes (letters, logo lines): top-hat plus black-hat with a small kernel, thresholded."""
    import cv2

    k = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    g = (gray * 255).astype(np.uint8)
    th = cv2.morphologyEx(g, cv2.MORPH_TOPHAT, k)
    bh = cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, k)
    return np.maximum(th, bh) > 60


def corner_overlay(image: np.ndarray, ratio: float = 3.0, min_density: float = 0.035) -> np.ndarray:
    """Text or a logo in one of the four corner bands, at WORK size: the corner's stroke density is far above the
    photo body's (median of the body's tiles of the same size)."""
    h0, w0 = image.shape[:2]
    s = WORK / max(h0, w0)
    W, H = int(round(w0 * s)), int(round(h0 * s))
    g = _resize(_gray(image), W, H)
    st = stroke_density(g)
    cw, ch = int(W * CORNER_W), int(H * CORNER_H)
    corners = {"bottom-right": (H - ch, H, W - cw, W), "bottom-left": (H - ch, H, 0, cw),
               "top-right": (0, ch, W - cw, W), "top-left": (0, ch, 0, cw)}
    body = [st[y:y + ch, x:x + cw].mean() for y in range(ch, H - 2 * ch + 1, ch // 2 or 1)
            for x in range(0, W - cw + 1, cw // 2 or 1)]
    ref = float(np.median(body)) if body else float(st.mean())
    out = np.zeros((H, W), bool)
    for y0, y1, x0, x1 in corners.values():
        d = float(st[y0:y1, x0:x1].mean())
        if d >= min_density and d >= ratio * max(ref, 1e-3):
            out[y0:y1, x0:x1] |= st[y0:y1, x0:x1]
    return _clean_mask(out, grow=4)


def detect(images: list[np.ndarray]) -> list[Overlay]:
    """One Overlay per photo (an empty mask where there is nothing to remove)."""
    shared = shared_overlay(images)
    out = []
    for im in images:
        h, w = im.shape[:2]
        src = []
        m = np.zeros((h, w), bool)
        if shared is not None and shared.any():
            m |= _resize(shared.astype(np.uint8), w, h, nearest=True).astype(bool)
            src.append("shared")
        c = corner_overlay(im)
        if c.any():
            m |= _resize(c.astype(np.uint8), w, h, nearest=True).astype(bool)
            src.append("corner")
        box = None
        if m.any():
            ys, xs = np.nonzero(m)
            box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        out.append(Overlay(m, src, box))
    return out


def remove(image: np.ndarray, ov: Overlay, band: float = BAND) -> tuple[np.ndarray, dict]:
    """(clean image, what was done). A mark inside a border band is cropped off with the band; otherwise inpainted."""
    import cv2

    if ov.box is None:
        return image, {"action": "none"}
    h, w = image.shape[:2]
    x0, y0, x1, y1 = ov.box
    pad = max(2, int(0.01 * h))
    if y0 >= h * (1 - band):
        return image[:max(1, y0 - pad)], {"action": "crop", "side": "bottom", "pixels": int(h - y0 + pad)}
    if y1 <= h * band:
        return image[y1 + pad:], {"action": "crop", "side": "top", "pixels": int(y1 + pad)}
    if x0 >= w * (1 - band) and (y1 - y0) < 0.6 * h:
        return image[:, :max(1, x0 - pad)], {"action": "crop", "side": "right", "pixels": int(w - x0 + pad)}
    if x1 <= w * band and (y1 - y0) < 0.6 * h:
        return image[:, x1 + pad:], {"action": "crop", "side": "left", "pixels": int(x1 + pad)}
    u8 = np.ascontiguousarray(np.asarray(image, np.uint8)[..., :3])
    clean = cv2.inpaint(u8, ov.mask.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
    return clean, {"action": "inpaint", "pixels": int(ov.mask.sum()), "share": round(float(ov.mask.mean()), 4)}


def clean_photos(paths: list[Path], out_dir: Path, preview_dir: Path | None = None,
                 report_path: Path | None = None) -> dict:
    """Detects and removes the overlays of a listing's photos. Writes the clean photos to `out_dir` under the same
    names (JPEG), optional mask previews, and returns the report (also written to `report_path`, by default
    `out_dir/listing.json`; a job keeps it out of the image folder the rebuild reads)."""
    from PIL import Image

    out_dir.mkdir(parents=True, exist_ok=True)
    imgs = [np.asarray(Image.open(p).convert("RGB")) for p in paths]
    overlays = detect(imgs)
    report = {"photos": []}
    for p, im, ov in zip(paths, imgs, overlays):
        clean, act = remove(im, ov)
        dst = out_dir / (p.stem + ".jpg")
        Image.fromarray(clean).save(dst, quality=95)
        entry = {"file": p.name, "out": dst.name, "size": [im.shape[1], im.shape[0]],
                 "outSize": [clean.shape[1], clean.shape[0]], "found": ov.source, "box": ov.box, **act}
        if preview_dir is not None and ov.box is not None:
            preview_dir.mkdir(parents=True, exist_ok=True)
            pv = im.copy()
            pv[ov.mask] = (0.4 * pv[ov.mask] + 0.6 * np.array([255, 0, 200])).astype(np.uint8)
            Image.fromarray(pv).save(preview_dir / f"{p.stem}-mask.jpg", quality=85)
            entry["preview"] = f"{p.stem}-mask.jpg"
        report["photos"].append(entry)
    report["cleaned"] = sum(1 for e in report["photos"] if e["action"] != "none")
    (report_path or out_dir / "listing.json").write_text(json.dumps(report, indent=2))
    return report


# --- after the rebuild ---------------------------------------------------------------------------------------------

def add_walk_zone(out_dir: Path, result: dict, work_dir: Path, render=None, log=print) -> dict:
    """Walk zone, collider and a spawn facing what the photos saw, for the world the rebuild wrote into `out_dir`.
    Files go to the top of out/ (the server copies only top-level files and the ones scene.json names). On any
    failure the rebuild's own spawn stays and the reason is returned, so the world still ships. Only the contract's
    own fields change (world.collider, world.spawn); walkzone.json is a file next to the world."""
    import walkzone_auto as W
    from objects import scene as obj_scene

    try:
        splats, scene = obj_scene.load_scene(out_dir)
        world = scene.get("world") or result.get("world") or {}
        cams = W.room_cameras(out_dir, world)
        doc = W.build(splats, world, cams, work_dir / "walkzone", W.Thresholds(), render=render, log=log,
                      spawn_facing="captured")
    except SystemExit as e:  # no spot passed
        return {"ok": False, "reason": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"{type(e).__name__}: {e}"}
    src = work_dir / "walkzone"
    shutil.copyfile(src / "collider.glb", out_dir / "collider.glb")
    shutil.copyfile(src / "walkzone.json", out_dir / "walkzone.json")
    shutil.copyfile(src / "topdown.png", out_dir / "walkzone-topdown.png")
    w = result.setdefault("world", {})
    w["collider"] = "collider.glb"
    w["spawn"] = {"position": doc["spawn"]["position"], "yaw": doc["spawn"]["yaw"]}
    return {"ok": True, "areaM2": doc["areaM2"], "spawn": w["spawn"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("clean", help="find and remove the overlays of a folder of listing photos")
    c.add_argument("--photos", required=True)
    c.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    photos = sorted(p for p in Path(a.photos).iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
    rep = clean_photos(photos, Path(a.out), Path(a.out) / "masks")
    for e in rep["photos"]:
        print(f"{e['file']}: {e['action']}" + (f" ({', '.join(e['found'])})" if e["found"] else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
