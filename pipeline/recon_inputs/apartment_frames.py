#!/usr/bin/env python3
"""Frames of one room from a long game-capture tour -> the image set pipeline/recon reads.

  python apartment_frames.py VIDEO --segments segments.json --out WORK [--per-second 4]

segments.json lists the frame ranges where the camera is inside the room ({"segments": [{"name", "start_frame",
"end_frame"}, ...]}, inclusive). Only those frames are decoded, at full size. Each segment is cut into windows
of fps/per-second frames and the sharpest frame of each window is kept (sharpness = variance of the Laplacian
of the grey frame, overlay boxes left out). A pick is dropped when it is blurred next to its neighbours (below
`blur_ratio` of the 90th percentile within +-0.5 s) or below `floor_ratio` of the median pick, or when it is a
near-duplicate of the previous kept frame (mean absolute grey difference at 160x90 below `dup_diff`).

The capture carries the same static overlays on every frame (a creator badge top-right, an icon bottom-left).
They are masked with fixed boxes (x0, y0, x1, y1; x1/y1 exclusive), the same mask for every image.

Writes, in pipeline/recon's layout (one camera group = the video):
  WORK/images/<stem>/f<frame:06d>.jpg       full size, JPEG q95 4:4:4
  WORK/masks/<stem>/f<frame:06d>.jpg.png    255 = use, 0 = overlay (COLMAP's mask naming and convention)
  WORK/frames.json                          per image: frame index, time, sharpness, segment
  WORK/picks.json                           every window's pick and why it was dropped, if it was
Self-contained (numpy, OpenCV, Pillow, ffmpeg on PATH) so it runs on a cluster node without the app.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

# Measured on this capture from the per-pixel standard deviation over the whole tour (1 frame every 4 s):
# badge x 1616-1901, y 7-120; icon x 20-87, y 992-1058. Padded by 12 px and snapped to the frame edge.
OVERLAY_BOXES = [[1604, 0, 1920, 133], [0, 980, 100, 1080]]
TINY_W, TINY_H = 160, 90
_SHOWINFO = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)")


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    a, b = s["r_frame_rate"].split("/")
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": float(a) / float(b),
            "nb_frames": int(s.get("nb_frames", 0) or 0), "duration": float(j["format"]["duration"])}


def _drain(stream, sink: list[str]) -> None:
    for raw in iter(stream.readline, b""):
        sink.append(raw.decode(errors="replace"))


def _read_exact(stream, n: int) -> bytes | None:
    chunks, got = [], 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def decode_ranges(path: Path, ranges: list[tuple[int, int]], size: tuple[int, int]):
    """Yields (frame index, pts seconds, rgb uint8) for every frame in the inclusive ranges, in order.
    The index is the decoded frame number in presentation order (ffmpeg select's n); the time comes from
    showinfo once the stream ends, so it is checked against the index afterwards by the caller."""
    w, h = size
    sel = "+".join(f"between(n\\,{a}\\,{b})" for a, b in ranges)
    want = [i for a, b in ranges for i in range(a, b + 1)]
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "info", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
           "-vf", f"select='{sel}',showinfo", "-fps_mode", "passthrough", "-frames:v", str(len(want)),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    nb = w * h * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=nb * 2)
    lines: list[str] = []
    th = threading.Thread(target=_drain, args=(proc.stderr, lines), daemon=True)
    th.start()
    frames = []
    try:
        for i in want:
            buf = _read_exact(proc.stdout, nb)
            if buf is None:
                break
            frames.append((i, np.frombuffer(buf, np.uint8).reshape(h, w, 3)))
    finally:
        proc.stdout.close()
        proc.wait()
        th.join(timeout=10)
    if len(frames) != len(want):
        raise RuntimeError(f"decoded {len(frames)} of {len(want)} frames: {''.join(lines[-6:])[-600:]}")
    stamps = {}
    for line in lines:
        m = _SHOWINFO.search(line) if "showinfo" in line else None
        if m:
            stamps.setdefault(int(m.group(1)), float(m.group(3)))
    return [(i, stamps.get(k, float("nan")), rgb) for k, (i, rgb) in enumerate(frames)]


def overlay_mask(w: int, h: int, boxes: list[list[int]]) -> np.ndarray:
    m = np.full((h, w), 255, np.uint8)
    for x0, y0, x1, y1 in boxes:
        m[max(0, y0):min(h, y1), max(0, x0):min(w, x1)] = 0
    return m


def sharpness(rgb: np.ndarray, use: np.ndarray) -> float:
    import cv2

    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    lap = cv2.Laplacian(g, cv2.CV_32F, ksize=3)
    return float(lap[use].var())


def tiny(rgb: np.ndarray, use_tiny: np.ndarray) -> np.ndarray:
    import cv2

    t = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (TINY_W, TINY_H), interpolation=cv2.INTER_AREA)
    return np.where(use_tiny, t, 0).astype(np.int16)


def pick(seg_frames: list[int], sharp: dict[int, float], tinies: dict[int, np.ndarray], fps: float, per_second: float,
         blur_ratio: float, floor_ratio: float, dup_diff: float, last: int | None) -> tuple[list[dict], int | None]:
    step = max(1, int(round(fps / per_second)))
    half = int(round(0.5 * fps))
    seg = np.asarray(seg_frames)
    s = np.asarray([sharp[i] for i in seg_frames])
    windows = [seg[k:k + step] for k in range(0, len(seg), step)]
    best = [int(w[np.argmax([sharp[i] for i in w])]) for w in windows]
    floor = floor_ratio * float(np.median([sharp[i] for i in best]))
    out = []
    for w, i in zip(windows, best):
        near = s[np.abs(seg - i) <= half]
        env = float(np.percentile(near, 90))
        rec = {"frame": i, "window": [int(w[0]), int(w[-1])], "sharpness": round(sharp[i], 2), "envelope": round(env, 2)}
        if sharp[i] < blur_ratio * env or sharp[i] < floor:
            rec["dropped"] = "blurred"
        elif last is not None:
            diff = float(np.mean(np.abs(tinies[i] - tinies[last])))
            rec["diff_prev"] = round(diff, 2)
            if diff < dup_diff:
                rec["dropped"] = "duplicate"
        if "dropped" not in rec:
            last = i
        out.append(rec)
    return out, last


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--segments", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--per-second", type=float, default=4.0)
    ap.add_argument("--blur-ratio", type=float, default=0.55)
    ap.add_argument("--floor-ratio", type=float, default=0.35)
    ap.add_argument("--dup-diff", type=float, default=2.0)
    ap.add_argument("--quality", type=int, default=95)
    a = ap.parse_args(argv)
    from PIL import Image
    import cv2

    t0 = time.time()
    info = probe(a.video)
    fps, W, H = info["fps"], info["width"], info["height"]
    seg_doc = json.loads(a.segments.read_text())
    segs = seg_doc["segments"]
    boxes = seg_doc.get("overlay", {}).get("boxes", OVERLAY_BOXES)
    mask = overlay_mask(W, H, boxes)
    use = mask > 0
    use_tiny = cv2.resize(mask, (TINY_W, TINY_H), interpolation=cv2.INTER_NEAREST) > 0
    ranges = [(int(s["start_frame"]), int(s["end_frame"])) for s in segs]
    decoded = decode_ranges(a.video, ranges, (W, H))
    print(f"decoded {len(decoded)} frames in {time.time() - t0:.0f}s", flush=True)
    rgb, times, sharp, tinies = {}, {}, {}, {}
    worst = 0.0
    for i, t, fr in decoded:
        rgb[i] = fr
        times[i] = t
        worst = max(worst, abs(t - i / fps)) if t == t else worst
        sharp[i] = sharpness(fr, use)
        tinies[i] = tiny(fr, use_tiny)
    if worst > 0.5 / fps:
        raise RuntimeError(f"frame index and presentation time disagree by {worst:.3f}s")
    stem = a.video.stem
    (a.out / "images" / stem).mkdir(parents=True, exist_ok=True)
    (a.out / "masks" / stem).mkdir(parents=True, exist_ok=True)
    images, report, last = [], {}, None
    for s, (lo, hi) in zip(segs, ranges):
        recs, last = pick(list(range(lo, hi + 1)), sharp, tinies, fps, a.per_second, a.blur_ratio, a.floor_ratio,
                          a.dup_diff, last)
        report[s["name"]] = recs
        for r in recs:
            if "dropped" in r:
                continue
            i = r["frame"]
            name = f"{stem}/f{i:06d}.jpg"
            Image.fromarray(rgb[i]).save(a.out / "images" / name, quality=a.quality, subsampling=0)
            Image.fromarray(mask).save(a.out / "masks" / f"{name}.png", optimize=True)
            images.append({"name": name, "group": stem, "source": a.video.name, "width": W, "height": H,
                           "frameIndex": i, "time": round(i / fps, 6), "ptsTime": round(times[i], 6),
                           "sharpness": round(sharp[i], 2), "segment": s["name"], "masked": round(float(np.mean(~use)), 4)})
        kept = sum("dropped" not in r for r in recs)
        print(f"segment {s['name']}: frames {lo}-{hi} ({(hi - lo + 1) / fps:.2f}s), {len(recs)} windows, kept {kept}", flush=True)
    doc = {
        "version": 1,
        "groups": {stem: {"kind": "video", "width": W, "height": H, "prior": None, "hasPriorFocal": False,
                          "source": a.video.name, "fps": fps, "frames": info["nb_frames"], "duration": info["duration"],
                          "hdr": None, "people": False}},
        "images": images,
        "videos": {stem: {"picked": f"sharpest frame per {1 / a.per_second:.2f}s window inside the room segments "
                                     "(pipeline/recon_inputs/apartment_frames.py)",
                          "segments": segs, "overlayBoxes": boxes,
                          "config": {"perSecond": a.per_second, "blurRatio": a.blur_ratio, "floorRatio": a.floor_ratio,
                                     "dupDiff": a.dup_diff}}},
        "jpegQuality": a.quality,
        "frameIndex": "decoded frames in presentation order, 0-based (ffmpeg select n)",
        "time": "frame index / fps in seconds from the start of the source file (constant frame rate)",
    }
    (a.out / "frames.json").write_text(json.dumps(doc, indent=1))
    (a.out / "picks.json").write_text(json.dumps(report, indent=1))
    print(f"wrote {len(images)} images to {a.out / 'images' / stem} in {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
