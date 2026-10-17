"""Keyframes from handheld video for a static-scene reconstruction.

  scan     decode every frame once (1280x720 grey): sharpness (Laplacian variance), the image shift to
           the previous frame (phase correlation at 640x360), exposure, a 160x90 grey copy for duplicate
           checks, and a 640 px colour thumbnail every 15 frames for review. One .npz per video.
  pick     per video: split the timeline into segments of about equal camera travel (bounded in time),
           keep the sharpest frame of each, drop blurred picks and near-duplicates. Optionally every n-th
           frame of one clip (the players layer needs a pose for those). Writes picks.json.
  extract  decode again and write the picked frames at 2560 px wide (Lanczos) as JPEG q95 4:4:4 into
           images/<video stem>/f<index>.jpg, plus frames.json in the layout pipeline/recon/prep.py writes
           (one camera group per video; source, frame index, presentation time, sharpness, roles) and
           <group>-times.npy (every source frame's time, for the per-frame camera track).

Frame indices count decoded frames in presentation order (ffmpeg -fps_mode passthrough); times are the
stream's presentation timestamps in seconds from the start of the file.

CLI:
  python pipeline/recon_inputs/frames.py scan VIDEO... --out WORK
  python pipeline/recon_inputs/frames.py pick WORK [--clip IMG_9293:41.0:61.0 --clip-step 4]
  python pipeline/recon_inputs/frames.py extract WORK --videos VIDEO_DIR --out OUT [--width 2560]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.media import probe, require_ffmpeg  # noqa: E402

SCAN_W, SCAN_H = 1280, 720
FLOW_W, FLOW_H = 640, 360
TINY_W, TINY_H = 160, 90
THUMB_W, THUMB_H = 640, 360
THUMB_EVERY = 15
_SHOWINFO = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)")


# ---- decoding -----------------------------------------------------------------------------------------------

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


def _select_expr(idx: list[int]) -> str:
    """ffmpeg expression true on frame numbers in idx. A flat sum of ~100+ eq() terms exceeds the expression
    parser's depth limit, so the sum is built as a balanced tree."""
    if len(idx) <= 8:
        return "+".join(f"eq(n\\,{i})" for i in idx)
    m = len(idx) // 2
    return f"({_select_expr(idx[:m])})+({_select_expr(idx[m:])})"


def decode(path: Path, size: tuple[int, int], pix_fmt: str = "gray", flags: str = "area",
           extra_outputs: list[str] | None = None, filter_tail: str = "",
           times: list[float] | None = None, keep: list[int] | None = None) -> Iterator[np.ndarray]:
    """Every decoded frame, in presentation order, scaled to `size` (w, h), as uint8 (H,W) or (H,W,3).

    `keep` (sorted frame indices) selects frames before scaling, so only those are resampled and piped; the
    iterator then yields exactly len(keep) frames in that order. `times`, when given, is filled with each
    output frame's presentation time (from ffmpeg showinfo) once the iterator is exhausted. `extra_outputs`
    lets the same decode write side outputs (thumbnails) through a filter graph: `filter_tail` is appended
    after a split and must end in the label [x]."""
    require_ffmpeg()
    w, h = size
    channels = 1 if pix_fmt == "gray" else 3
    sel = f"select='{_select_expr([int(i) for i in keep])}'," if keep else ""
    head = f"[0:v]{sel}scale={w}:{h}:flags={flags}+accurate_rnd+full_chroma_int"
    if extra_outputs:
        # Split in YUV so a grey main output does not turn the side outputs grey too.
        graph = f"{head},format=yuv420p,split=2[m][s];[m]showinfo[o];[s]{filter_tail}"
    else:
        graph = f"{head},showinfo[o]"
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "info", "-hwaccel", "videotoolbox", "-i", str(path),
           "-filter_complex", graph, "-map", "[o]", "-an", "-sn", "-dn", "-fps_mode", "passthrough",
           "-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1"]
    if extra_outputs:
        cmd += extra_outputs
    frame_bytes = w * h * channels
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 2)
    lines: list[str] = []
    th = threading.Thread(target=_drain, args=(proc.stderr, lines), daemon=True)
    th.start()
    n, finished = 0, False
    try:
        while True:
            buf = _read_exact(proc.stdout, frame_bytes)
            if buf is None:
                finished = True
                break
            arr = np.frombuffer(buf, dtype=np.uint8)
            yield arr.reshape(h, w) if channels == 1 else arr.reshape(h, w, 3)
            n += 1
    finally:
        if not finished and proc.poll() is None:
            proc.kill()  # the caller stopped early
        proc.stdout.close()
        proc.wait()
        th.join(timeout=10)
    if proc.returncode not in (0, None) or n == 0:
        tail = "".join(lines[-8:])
        raise RuntimeError(f"ffmpeg decode of {path.name} failed ({proc.returncode}): {tail[-600:]}")
    if times is not None:
        stamps: dict[int, float] = {}
        for line in lines:
            if "showinfo" not in line:
                continue
            m = _SHOWINFO.search(line)
            if m:
                stamps.setdefault(int(m.group(1)), float(m.group(3)))
        times[:] = [stamps.get(i, float("nan")) for i in range(n)]


# ---- scan ---------------------------------------------------------------------------------------------------

def scan_video(path: Path, work: Path) -> Path:
    import cv2

    info = probe(path)
    stem = path.stem
    thumbs = work / "thumbs" / stem
    thumbs.mkdir(parents=True, exist_ok=True)
    for old in thumbs.glob("*.jpg"):
        old.unlink()
    tail = (f"select='not(mod(n\\,{THUMB_EVERY}))',scale={THUMB_W}:{THUMB_H}:flags=area,"
            f"scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p[x]")
    extra = ["-map", "[x]", "-fps_mode", "passthrough", "-q:v", "3", "-start_number", "0",
             str(thumbs / "%05d.jpg")]
    times: list[float] = []
    sharp, shift, resp, mean, clip, tiny = [], [], [], [], [], []
    window = cv2.createHanningWindow((FLOW_W, FLOW_H), cv2.CV_32F)
    prev = None
    t0 = time.time()
    for g in decode(path, (SCAN_W, SCAN_H), "gray", extra_outputs=extra, filter_tail=tail, times=times):
        gf = g.astype(np.float32)
        sharp.append(float(cv2.Laplacian(gf, cv2.CV_32F, ksize=3).var()))
        small = cv2.resize(gf, (FLOW_W, FLOW_H), interpolation=cv2.INTER_AREA)
        if prev is None:
            shift.append((0.0, 0.0))
            resp.append(1.0)
        else:
            (dx, dy), r = cv2.phaseCorrelate(prev, small, window)
            shift.append((float(dx), float(dy)))
            resp.append(float(r))
        prev = small
        t8 = cv2.resize(g, (TINY_W, TINY_H), interpolation=cv2.INTER_AREA)
        tiny.append(t8)
        mean.append(float(t8.mean()))
        clip.append(float(np.mean((t8 < 6) | (t8 > 249))))
    n = len(sharp)
    out = work / f"{stem}.npz"
    np.savez_compressed(
        out,
        time=np.asarray(times, np.float64), sharp=np.asarray(sharp, np.float32),
        shift=np.asarray(shift, np.float32), resp=np.asarray(resp, np.float32),
        mean=np.asarray(mean, np.float32), clip=np.asarray(clip, np.float32),
        tiny=np.stack(tiny).astype(np.uint8),
    )
    meta = {"video": path.name, "frames": n, "fps": info.fps, "duration": info.duration,
            "width": info.width, "height": info.height, "codec": info.codec, "thumb_every": THUMB_EVERY,
            "seconds": round(time.time() - t0, 1)}
    (work / f"{stem}.json").write_text(json.dumps(meta, indent=2))
    print(f"scan {path.name}: {n} frames in {meta['seconds']}s ({n / max(meta['seconds'], 1e-3):.0f} fps)", flush=True)
    return out


# ---- pick ---------------------------------------------------------------------------------------------------

@dataclass
class PickConfig:
    travel: float = 60.0  # px of image shift at 640 px width per segment
    min_seconds: float = 0.45
    max_seconds: float = 2.0
    blur_ratio: float = 0.55  # drop a pick whose sharpness is below this fraction of the local median
    dup_diff: float = 4.0  # mean abs grey difference (160x90) below which a pick is a near-duplicate
    dup_seconds: float = 8.0  # ...unless this long has passed since the last kept frame
    edge_seconds: float = 0.25  # ignore the very first/last frames of a recording
    floor_ratio: float = 0.3  # and any pick below this fraction of the whole video's median sharpness
    max_count: int = 0  # 0 = no limit


def rolling_median(x: np.ndarray, half: int) -> np.ndarray:
    out = np.empty_like(x)
    for i in range(len(x)):
        out[i] = np.median(x[max(0, i - half): i + half + 1])
    return out


def _speed(scan: dict) -> np.ndarray:
    s = np.hypot(scan["shift"][:, 0], scan["shift"][:, 1])
    bad = (scan["resp"] < 0.03) | (s > 120)
    if bad.any():
        good = np.where(~bad)[0]
        if len(good):
            s[bad] = np.interp(np.where(bad)[0], good, s[good])
    return s


def pick_keyframes(scan: dict, fps: float, cfg: PickConfig) -> tuple[list[dict], list[dict]]:
    """Segment by cumulative travel (bounded in time), keep the sharpest of each segment, then thin.
    Returns (kept, every segment's pick with the reason it was dropped, if it was)."""
    n = len(scan["sharp"])
    sharp = scan["sharp"].astype(np.float64)
    local = rolling_median(sharp, int(round(fps * 2)))
    rel = sharp / np.maximum(local, 1e-6)
    cum = np.concatenate([[0.0], np.cumsum(_speed(scan)[1:])])
    edge = int(round(cfg.edge_seconds * fps))
    lo, hi = min(edge, n - 1), max(n - edge, 1)
    mn, mx = max(1, int(round(cfg.min_seconds * fps))), max(2, int(round(cfg.max_seconds * fps)))
    picks = []
    s = lo
    while s < hi:
        e = s + mn
        while e < hi and e - s < mx and cum[e] - cum[s] < cfg.travel:
            e += 1
        e = min(e, hi)
        seg = np.arange(s, e)
        best = int(seg[np.argmax(sharp[seg] * (scan["clip"][seg] < 0.25))])
        picks.append({"index": best, "sharpness": float(sharp[best]), "rel": float(rel[best]),
                      "travel": float(cum[e - 1] - cum[s]), "segment": [int(s), int(e)]})
        s = e
    kept, last = [], None
    tiny = scan["tiny"].astype(np.int16)
    floor = cfg.floor_ratio * float(np.median(sharp))
    for p in picks:
        if p["rel"] < cfg.blur_ratio or p["sharpness"] < floor:
            p["dropped"] = "blurred"
            continue
        if last is not None:
            diff = float(np.mean(np.abs(tiny[p["index"]] - tiny[last["index"]])))
            p["diff_prev"] = round(diff, 2)
            gap = (p["index"] - last["index"]) / fps
            if diff < cfg.dup_diff and gap < cfg.dup_seconds:
                p["dropped"] = "duplicate"
                continue
        kept.append(p)
        last = p
    if cfg.max_count and len(kept) > cfg.max_count:
        # Keep the sharpest ones, in time order.
        best = sorted(sorted(kept, key=lambda p: -p["sharpness"])[: cfg.max_count], key=lambda p: p["index"])
        for p in kept:
            if p not in best:
                p["dropped"] = "max_count"
        kept = best
    return kept, picks


def pick(work: Path, cfgs: dict[str, PickConfig], clip: tuple[str, float, float] | None, clip_step: int) -> dict:
    result = {"videos": {}, "clip": None}
    for npz in sorted(work.glob("*.npz")):
        stem = npz.stem
        meta = json.loads((work / f"{stem}.json").read_text())
        scan = dict(np.load(npz))
        fps = float(meta["fps"])
        cfg = cfgs.get(stem, cfgs.get("*", PickConfig()))
        keys, segments = pick_keyframes(scan, fps, cfg)
        times = scan["time"]
        for k in segments:
            k["time"] = float(times[k["index"]])
        drops: dict[str, int] = {}
        for k in segments:
            if "dropped" in k:
                drops[k["dropped"]] = drops.get(k["dropped"], 0) + 1
        entry = {"frames": meta["frames"], "fps": fps, "config": cfg.__dict__, "segments": len(segments),
                 "dropped": drops, "keyframes": keys}
        if clip and clip[0] == stem:
            t = times
            i0 = int(np.searchsorted(t, clip[1]))
            i1 = int(np.searchsorted(t, clip[2]))
            # Align the clip start to the step so the clip frames are frames i0, i0+step, ...
            idx = list(range(i0, min(i1, len(t)), clip_step))
            entry["clip"] = [{"index": i, "time": float(t[i]), "sharpness": float(scan["sharp"][i])} for i in idx]
            # Inside the clip, a keyframe moves to the sharpest clip frame within half a step, so the clip
            # frames double as keyframes there instead of adding near-copies next to them.
            grid = np.asarray(idx)
            for k in keys:
                if idx[0] - clip_step // 2 <= k["index"] <= idx[-1] + clip_step // 2:
                    near = grid[np.abs(grid - k["index"]) <= clip_step // 2]
                    if len(near):
                        j = int(near[np.argmax(scan["sharp"][near])])
                        if j != k["index"]:
                            k["snapped_from"] = k["index"]
                            k.update(index=j, time=float(t[j]), sharpness=float(scan["sharp"][j]))
            result["clip"] = {"video": stem, "start_index": i0, "end_index": idx[-1], "step": clip_step,
                              "start": float(t[i0]), "end": float(t[idx[-1]]), "count": len(idx)}
        result["videos"][stem] = entry
    (work / "picks.json").write_text(json.dumps(result, indent=1))
    return result


# ---- extract ------------------------------------------------------------------------------------------------

def frame_name(stem: str, index: int) -> str:
    """Image name inside the work folder: one folder (= one camera) per video, like pipeline/recon/prep.py."""
    return f"{stem}/f{index:06d}.jpg"


def extract(work: Path, video_dir: Path, out: Path, width: int, quality: int = 95) -> dict:
    """Write the picked frames and frames.json in the layout pipeline/recon reads (images/<group>/..., one
    camera group per video). Extra fields: per image `roles` (key = reconstruction keyframe, clip = every
    n-th frame of the players clip), top-level `clip` and `videos` (how the frames were picked)."""
    from PIL import Image

    picks = json.loads((work / "picks.json").read_text())
    images_dir = out / "images"
    groups, images, videos = {}, [], {}
    for stem, entry in picks["videos"].items():
        meta = json.loads((work / f"{stem}.json").read_text())
        scan = dict(np.load(work / f"{stem}.npz"))
        roles: dict[int, set[str]] = {}
        for k in entry["keyframes"]:
            roles.setdefault(k["index"], set()).add("key")
        for c in entry.get("clip") or []:
            roles.setdefault(c["index"], set()).add("clip")
        if not roles:
            continue
        video = next(p for p in video_dir.iterdir() if p.stem == stem)
        height = int(round(width * meta["height"] / meta["width"] / 2)) * 2
        want = sorted(roles)
        (images_dir / stem).mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        got = 0
        for i, rgb in zip(want, decode(video, (width, height), "rgb24", flags="lanczos", keep=want)):
            name = frame_name(stem, i)
            Image.fromarray(rgb).save(images_dir / name, quality=quality, subsampling=0)
            images.append({
                "name": name, "group": stem, "source": video.name, "width": width, "height": height,
                "frameIndex": int(i), "time": round(float(scan["time"][i]), 6),
                "sharpness": round(float(scan["sharp"][i]), 2), "roles": sorted(roles[i]),
            })
            got += 1
        if got != len(want):
            raise RuntimeError(f"{video.name}: decoded {got} of {len(want)} picked frames")
        print(f"extract {video.name}: {got} frames at {width}x{height} in {time.time() - t0:.0f}s", flush=True)
        # Every source frame's presentation time (s from the first frame), the file pipeline/recon/frame.py
        # interpolates the per-frame camera track over (<group>-times.npy, as prep.py writes it).
        np.save(out / f"{stem}-times.npy", scan["time"] - scan["time"][0])
        groups[stem] = {
            "kind": "video", "width": width, "height": height, "prior": None, "hasPriorFocal": False,
            "source": video.name, "fps": meta["fps"], "frames": meta["frames"], "duration": meta["duration"],
            "hdr": None, "people": True,
        }
        videos[stem] = {
            "picked": "sharpest frame per segment of ~equal camera travel (scan + pick in pipeline/recon_inputs/frames.py)",
            "segments": entry.get("segments"), "dropped": entry.get("dropped"), "config": entry.get("config"),
            "keyframes": len(entry["keyframes"]), "clipFrames": len(entry.get("clip") or []),
        }
    images.sort(key=lambda r: r["name"])
    doc = {
        "version": 1,
        "groups": groups,
        "images": images,
        "videos": videos,
        "clip": picks.get("clip"),
        "jpegQuality": quality,
        "frameIndex": "decoded frames in presentation order, 0-based (ffmpeg -fps_mode passthrough)",
        "time": "presentation timestamp in seconds from the start of the source file",
    }
    (out / "frames.json").write_text(json.dumps(doc, indent=1))
    return doc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("scan")
    a.add_argument("videos", nargs="+", type=Path)
    a.add_argument("--out", type=Path, required=True)
    b = sub.add_parser("pick")
    b.add_argument("work", type=Path)
    b.add_argument("--config", type=Path, help="JSON {video stem or '*': PickConfig fields}")
    b.add_argument("--clip", help="STEM:START:END (seconds) of the players clip")
    b.add_argument("--clip-step", type=int, default=4)
    c = sub.add_parser("extract")
    c.add_argument("work", type=Path)
    c.add_argument("--videos", type=Path, required=True)
    c.add_argument("--out", type=Path, required=True)
    c.add_argument("--width", type=int, default=2560)
    c.add_argument("--quality", type=int, default=95)
    args = ap.parse_args(argv)
    if args.cmd == "scan":
        args.out.mkdir(parents=True, exist_ok=True)
        for v in args.videos:
            scan_video(v, args.out)
    elif args.cmd == "pick":
        cfgs = {"*": PickConfig()}
        if args.config:
            for k, v in json.loads(args.config.read_text()).items():
                cfgs[k] = PickConfig(**{**PickConfig().__dict__, **v})
        clip = None
        if args.clip:
            stem, s, e = args.clip.split(":")
            clip = (stem, float(s), float(e))
        res = pick(args.work, cfgs, clip, args.clip_step)
        for stem, entry in res["videos"].items():
            print(f"{stem}: {len(entry['keyframes'])} keyframes of {entry['segments']} segments, dropped {entry['dropped']}"
                  + (f", clip {len(entry['clip'])}" if entry.get("clip") else ""))
    else:
        doc = extract(args.work, args.videos, args.out, args.width, args.quality)
        print(f"{len(doc['images'])} frames -> {args.out / 'images'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
