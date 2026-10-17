#!/usr/bin/env python3
"""Chosen time ranges of a long game-capture video -> sharp full-size frames, a static overlay mask per frame,
and frames.json in the layout pipeline/recon reads (WORK/images/<group>/*.jpg, WORK/masks/<group>/*.jpg.png).

  python tilted_pick.py pick    SCAN_DIR --segments segments.json --out WORK [--target 800]
  python tilted_pick.py masks   SCAN_DIR --out WORK --mask overlay_mask.png --banner-mask overlay_mask_banner.png
  python tilted_pick.py extract SCAN_DIR --video VIDEO --mask overlay_mask.png [--banner-mask overlay_mask_banner.png]
                                --out WORK [--group tilted]

pick: inside each range, windows of 1/rate s (rate chosen so the whole set lands near --target, clamped to
      2-4 per second); the sharpest frame of each window is kept unless it is blurred against the frames
      around it, or nearly the same view as the previous kept frame (camera at rest).
extract: decodes the video once (every source frame, no frame-rate conversion, so frame indices match the
      scan) and writes the picked frames at full size as JPEG q95 4:4:4.

overlay_mask.png is white where the burnt-in overlays are (ignore). Per-frame masks are written in the
COLMAP / pipeline convention: 255 = use, 0 = ignore.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np


def load_scan(d: Path) -> tuple[dict, dict]:
    return dict(np.load(d / "scan.npz")), json.loads((d / "scan.json").read_text())


def rolling_pct(x: np.ndarray, half: int, q: float) -> np.ndarray:
    out = np.empty_like(x)
    for i in range(len(x)):
        out[i] = np.percentile(x[max(0, i - half): i + half + 1], q)
    return out


def cmd_pick(scan_dir: Path, segments: Path, out: Path, target: int, rate_min: float, rate_max: float,
             blur_ratio: float, dup_diff: float, dup_shift: float) -> None:
    scan, meta = load_scan(scan_dir)
    fps = float(meta["fps"])
    t = scan["time"]
    sharp = scan["sharp"].astype(np.float64)
    shift = np.hypot(scan["shift"][:, 0], scan["shift"][:, 1]).astype(np.float64)
    shift[(scan["resp"] < 0.03) | (shift > 80)] = 0.0  # unreliable correlation: do not count as travel
    tiny = scan["tiny"].astype(np.int16)
    segs = json.loads(segments.read_text())["segments"]
    total = sum(s["end"] - s["start"] for s in segs)
    rate = float(np.clip(target / max(total, 1e-6), rate_min, rate_max))
    win = 1.0 / rate
    local = rolling_pct(sharp, int(round(fps * 0.75)), 90)
    picks, report = [], []
    for si, s in enumerate(segs):
        i0, i1 = int(np.searchsorted(t, s["start"])), int(np.searchsorted(t, s["end"]))
        seg_picks = []
        edges = np.arange(t[i0], t[i1 - 1] + 1e-9, win)
        last = None
        drops = {"blurred": 0, "duplicate": 0}
        for a in edges:
            idx = np.nonzero((t >= a) & (t < a + win) & (np.arange(len(t)) >= i0) & (np.arange(len(t)) < i1))[0]
            if len(idx) == 0:
                continue
            b = int(idx[np.argmax(sharp[idx])])
            if sharp[b] < blur_ratio * local[b]:
                drops["blurred"] += 1
                continue
            if last is not None:
                diff = float(np.mean(np.abs(tiny[b] - tiny[last])))
                travel = float(shift[last + 1: b + 1].sum())
                if diff < dup_diff and travel < dup_shift:
                    drops["duplicate"] += 1
                    continue
            seg_picks.append(b)
            last = b
        for b in seg_picks:
            picks.append({"frameIndex": b, "time": round(float(t[b]), 4), "sharpness": round(float(sharp[b]), 2),
                          "segment": s["id"]})
        report.append({"id": s["id"], "start": s["start"], "end": s["end"], "kept": len(seg_picks), **drops})
        print(f"segment {s['id']} {s['start']:.1f}-{s['end']:.1f}s: kept {len(seg_picks)} "
              f"(blurred {drops['blurred']}, duplicate {drops['duplicate']})", flush=True)
    out.mkdir(parents=True, exist_ok=True)
    doc = {"rate": rate, "window_s": win, "total_s": total, "count": len(picks), "segments": report, "picks": picks}
    (out / "picks.json").write_text(json.dumps(doc, indent=1))
    print(f"rate {rate:.2f}/s over {total:.0f}s -> {len(picks)} frames", flush=True)


def read_exact(stream, n: int) -> bytes | None:
    chunks, got = [], 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


BANNER_FILL = np.array([168, 206, 220], np.int16)  # RGB of the lower-third bar
BANNER_PROBE = (1000, 1046, 110, 430)  # y0, y1, x0, x1: always covered by the bar's first element when it is out


def banner_score(rgb: np.ndarray) -> float:
    y0, y1, x0, x1 = BANNER_PROBE
    band = rgb[y0:y1, x0:x1].astype(np.int16)
    return float((np.abs(band - BANNER_FILL).max(-1) < 28).mean())


def write_masks(out: Path, images: list[dict], mask_path: Path, banner_mask: Path | None, banner_thresh: float,
                banner_pad_s: float) -> None:
    """Per-frame masks (255 = use, 0 = ignore): the static overlays on every frame, plus the lower-third bar on the
    frames that show it and on frames within banner_pad_s of one in the same range (it slides in and out)."""
    from PIL import Image

    ignore = np.asarray(Image.open(mask_path).convert("L")) > 127
    ignore_b = (ignore | (np.asarray(Image.open(banner_mask).convert("L")) > 127)) if banner_mask else ignore
    hits = [r for r in images if r["bannerScore"] >= banner_thresh]
    for r in images:
        r["banner"] = bool(banner_mask) and any(
            q["segment"] == r["segment"] and abs(q["time"] - r["time"]) <= banner_pad_s for q in hits)
        m = ignore_b if r["banner"] else ignore
        dst = out / "masks" / f"{r['name']}.png"
        dst.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.where(m, 0, 255).astype(np.uint8)).save(dst, optimize=True)
        r["masked"] = round(float(m.mean()), 5)
    print(f"masks: {len(images)} written, lower-third bar masked on {sum(r['banner'] for r in images)}", flush=True)


def cmd_masks(out: Path, mask_path: Path, banner_mask: Path | None, banner_thresh: float, banner_pad_s: float) -> None:
    doc = json.loads((out / "frames.json").read_text())
    write_masks(out, doc["images"], mask_path, banner_mask, banner_thresh, banner_pad_s)
    doc["groups"][next(iter(doc["groups"]))]["bannerRule"] = {"threshold": banner_thresh, "pad_s": banner_pad_s}
    (out / "frames.json").write_text(json.dumps(doc, indent=1))


def cmd_extract(scan_dir: Path, video: Path, mask_path: Path, out: Path, group: str, segments: Path | None,
                banner_mask: Path | None = None, banner_thresh: float = 0.02, banner_pad_s: float = 1.2) -> None:
    from PIL import Image

    scan, meta = load_scan(scan_dir)
    doc = json.loads((out / "picks.json").read_text())
    picks = {p["frameIndex"]: p for p in doc["picks"]}
    w, h = int(meta["width"]), int(meta["height"])
    ignore = np.asarray(Image.open(mask_path).convert("L")) > 127
    assert ignore.shape == (h, w), (ignore.shape, (h, w))
    img_dir, mask_dir = out / "images" / group, out / "masks" / group
    img_dir.mkdir(parents=True, exist_ok=True)
    mask_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-map", "0:v:0", "-an", "-sn", "-dn",
           "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    nb = w * h * 3
    last = max(picks)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=nb * 2)
    images = []
    t0 = time.time()
    try:
        i = 0
        while i <= last:
            buf = read_exact(proc.stdout, nb)
            if buf is None:
                break
            if i in picks:
                p = picks[i]
                name = f"{group}/f{i:06d}.jpg"
                rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                Image.fromarray(rgb).save(out / "images" / name, quality=95, subsampling=0)
                images.append({"name": name, "group": group, "source": video.name, "width": w, "height": h,
                               "frameIndex": i, "time": p["time"], "sharpness": p["sharpness"],
                               "segment": p["segment"], "bannerScore": round(banner_score(rgb), 3)})
            i += 1
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.stdout.close()
        proc.wait()
    write_masks(out, images, mask_path, banner_mask, banner_thresh, banner_pad_s)
    seg_doc = json.loads(segments.read_text()) if segments else None
    frames = {
        "version": 1,
        "groups": {group: {"kind": "video", "width": w, "height": h, "prior": None, "hasPriorFocal": False,
                           "source": video.name, "fps": meta["fps"], "frames": meta["frames"],
                           "duration": meta["duration"], "hdr": False, "people": False,
                           "staticMask": "overlay_mask.png (white = ignore); masks/ use 255 = use, 0 = ignore",
                           "bannerMask": banner_mask.name if banner_mask else None}},
        "images": images,
        "videos": {group: {"rate": doc["rate"], "window_s": doc["window_s"], "segments": doc["segments"],
                           "segmentInfo": seg_doc["segments"] if seg_doc else None}},
        "time": "presentation time in seconds from the start of the source video",
        "frameIndex": "decoded frame number in presentation order, 0-based (ffmpeg -fps_mode passthrough)",
    }
    (out / "frames.json").write_text(json.dumps(frames, indent=1))
    print(f"extract: {len(images)} frames in {time.time() - t0:.0f}s", flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["pick", "extract", "masks"])
    ap.add_argument("scan", type=Path)
    ap.add_argument("--segments", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--target", type=int, default=800)
    ap.add_argument("--rate-min", type=float, default=2.0)
    ap.add_argument("--rate-max", type=float, default=4.0)
    ap.add_argument("--blur-ratio", type=float, default=0.55)
    ap.add_argument("--dup-diff", type=float, default=2.5)
    ap.add_argument("--dup-shift", type=float, default=6.0)
    ap.add_argument("--video", type=Path)
    ap.add_argument("--mask", type=Path)
    ap.add_argument("--group", default="tilted")
    ap.add_argument("--banner-mask", type=Path, help="white = ignore, used on frames that show the lower-third bar")
    ap.add_argument("--banner-thresh", type=float, default=0.02)
    ap.add_argument("--banner-pad", type=float, default=1.2)
    a = ap.parse_args(argv)
    if a.cmd == "pick":
        cmd_pick(a.scan, a.segments, a.out, a.target, a.rate_min, a.rate_max, a.blur_ratio, a.dup_diff, a.dup_shift)
    elif a.cmd == "masks":
        cmd_masks(a.out, a.mask, a.banner_mask, a.banner_thresh, a.banner_pad)
    else:
        cmd_extract(a.scan, a.video, a.mask, a.out, a.group, a.segments, a.banner_mask, a.banner_thresh, a.banner_pad)
    return 0


if __name__ == "__main__":
    sys.exit(main())
