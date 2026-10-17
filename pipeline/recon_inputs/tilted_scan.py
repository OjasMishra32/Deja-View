#!/usr/bin/env python3
"""Long game-capture video -> per-frame scan, 1 fps review thumbnails, overlay statistics.

  python tilted_scan.py scan    VIDEO --out WORK      every frame: sharpness, shift, cut score, tiny grey
  python tilted_scan.py thumbs  VIDEO --out WORK      1 frame per second at 320x180 (WORK/thumbs/%05d.jpg)
  python tilted_scan.py overlay VIDEO --out WORK      per-pixel mean/std over 1 frame every 4 s at full size,
                                                      plus a few full-size sample frames
  python tilted_scan.py sheets  WORK --per 120        contact sheets (labelled with mm:ss) from the thumbnails

Frame index = decoded frame number in presentation order (ffmpeg -fps_mode passthrough); time = that frame's
presentation timestamp in seconds (from the packet timestamps, sorted).
Self-contained (numpy, OpenCV, Pillow, ffmpeg on PATH) so it runs on a cluster node without the app.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

SCAN_W, SCAN_H = 1280, 720
FLOW_W, FLOW_H = 320, 180
TINY_W, TINY_H = 160, 90


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    a, b = s["r_frame_rate"].split("/")
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": float(a) / float(b),
            "nb_frames": int(s.get("nb_frames", 0) or 0), "duration": float(j["format"]["duration"])}


def frame_times(path: Path) -> np.ndarray:
    """Presentation times of every video frame (packet pts, sorted = presentation order)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
    t = sorted(float(x.strip().rstrip(",")) for x in out.splitlines() if x.strip() and x.strip() != "N/A")
    return np.asarray(t, np.float64)


def read_exact(stream, n: int) -> bytes | None:
    chunks, got = [], 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def decode(path: Path, vf: str, size: tuple[int, int], pix_fmt: str = "gray", threads: int = 0):
    w, h = size
    ch = 1 if pix_fmt == "gray" else 3
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-threads", str(threads), "-i", str(path), "-map", "0:v:0", "-an",
           "-sn", "-dn", "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1"]
    nb = w * h * ch
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=nb * 4)
    try:
        while True:
            buf = read_exact(proc.stdout, nb)
            if buf is None:
                break
            a = np.frombuffer(buf, np.uint8)
            yield a.reshape(h, w) if ch == 1 else a.reshape(h, w, 3)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.stdout.close()
        proc.wait()


def corner_weight(w: int, h: int) -> np.ndarray:
    """1 inside the image, 0 over generous boxes around the two corner overlays (they are static and sharp)."""
    m = np.ones((h, w), np.float32)
    m[: int(0.16 * h), int(0.76 * w):] = 0  # top-right badge
    m[int(0.88 * h):, : int(0.08 * w)] = 0  # bottom-left icon
    return m


def cmd_scan(video: Path, out: Path) -> None:
    import cv2

    cv2.setNumThreads(4)
    info = probe(video)
    times = frame_times(video)
    keep = corner_weight(SCAN_W, SCAN_H) > 0
    win = cv2.createHanningWindow((FLOW_W, FLOW_H), cv2.CV_32F)
    sharp, shift, resp, cut, mean, tiny = [], [], [], [], [], []
    prev_small, prev_tiny = None, None
    t0 = time.time()
    vf = f"scale={SCAN_W}:{SCAN_H}:flags=area"
    for i, g in enumerate(decode(video, vf, (SCAN_W, SCAN_H))):
        gf = g.astype(np.float32)
        lap = cv2.Laplacian(gf, cv2.CV_32F, ksize=3)
        sharp.append(float(lap[keep].var()))
        small = cv2.resize(gf, (FLOW_W, FLOW_H), interpolation=cv2.INTER_AREA)
        t8 = cv2.resize(g, (TINY_W, TINY_H), interpolation=cv2.INTER_AREA)
        if prev_small is None:
            shift.append((0.0, 0.0))
            resp.append(1.0)
            cut.append(0.0)
        else:
            (dx, dy), r = cv2.phaseCorrelate(prev_small, small, win)
            shift.append((float(dx), float(dy)))
            resp.append(float(r))
            cut.append(float(np.mean(np.abs(t8.astype(np.int16) - prev_tiny.astype(np.int16)))))
        prev_small, prev_tiny = small, t8
        tiny.append(t8)
        mean.append(float(t8.mean()))
        if i % 2000 == 0:
            print(f"scan {i} frames {time.time() - t0:.0f}s", flush=True)
    n = len(sharp)
    if len(times) != n:
        print(f"WARNING: {n} decoded frames, {len(times)} packet times; times trimmed/padded", flush=True)
        if len(times) > n:
            times = times[:n]
        else:
            times = np.concatenate([times, times[-1] + (np.arange(1, n - len(times) + 1) / info["fps"])])
    np.savez_compressed(out / "scan.npz", time=times, sharp=np.asarray(sharp, np.float32),
                        shift=np.asarray(shift, np.float32), resp=np.asarray(resp, np.float32),
                        cut=np.asarray(cut, np.float32), mean=np.asarray(mean, np.float32),
                        tiny=np.stack(tiny).astype(np.uint8))
    meta = {**info, "frames": n, "scan_size": [SCAN_W, SCAN_H], "flow_size": [FLOW_W, FLOW_H],
            "seconds": round(time.time() - t0, 1)}
    (out / "scan.json").write_text(json.dumps(meta, indent=1))
    print(f"scan done: {n} frames in {meta['seconds']}s", flush=True)


def cmd_thumbs(video: Path, out: Path) -> None:
    d = out / "thumbs"
    d.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(video), "-map", "0:v:0", "-an",
                    "-vf", "fps=1,scale=320:180:flags=area", "-q:v", "4", "-start_number", "0", str(d / "%05d.jpg")],
                   check=True)
    print(f"thumbs: {len(list(d.glob('*.jpg')))}", flush=True)


def cmd_overlay(video: Path, out: Path, every: float = 4.0, samples=(30, 120, 300, 480, 700, 900, 1100, 1300, 1500)) -> None:
    import cv2

    info = probe(video)
    w, h = info["width"], info["height"]
    s1 = np.zeros((h, w, 3), np.float64)
    s2 = np.zeros((h, w, 3), np.float64)
    g1 = np.zeros((h, w), np.float64)  # mean gradient magnitude (static edges stay strong in the mean image)
    n = 0
    for fr in decode(video, f"fps=1/{every}", (w, h), "rgb24"):
        f = fr.astype(np.float64)
        s1 += f
        s2 += f * f
        gr = cv2.cvtColor(fr, cv2.COLOR_RGB2GRAY).astype(np.float32)
        g1 += np.hypot(cv2.Sobel(gr, cv2.CV_32F, 1, 0), cv2.Sobel(gr, cv2.CV_32F, 0, 1))
        n += 1
    mean = s1 / n
    std = np.sqrt(np.maximum(s2 / n - mean * mean, 0)).mean(axis=2)
    np.savez_compressed(out / "overlay_stats.npz", mean=mean.astype(np.float32), std=std.astype(np.float32),
                        grad=(g1 / n).astype(np.float32), n=n)
    cv2.imwrite(str(out / "overlay_mean.png"), cv2.cvtColor(np.clip(mean, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(out / "overlay_std.png"), np.clip(std * 2, 0, 255).astype(np.uint8))
    sd = out / "samples"
    sd.mkdir(exist_ok=True)
    for t in samples:
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", str(t), "-i", str(video), "-frames:v", "1",
                        str(sd / f"t{t:05d}.png")], check=True)
    print(f"overlay: {n} frames averaged", flush=True)


def cmd_sheets(work: Path, per: int, cols: int, tw: int) -> None:
    from PIL import Image, ImageDraw

    thumbs = sorted((work / "thumbs").glob("*.jpg"))
    od = work / "sheets"
    od.mkdir(exist_ok=True)
    th = tw * 9 // 16
    lab = 14
    for s0 in range(0, len(thumbs), per):
        chunk = thumbs[s0: s0 + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (tw + 2), rows * (th + lab + 2)), (0, 0, 0))
        dr = ImageDraw.Draw(sheet)
        for k, p in enumerate(chunk):
            t = int(p.stem)
            im = Image.open(p).convert("RGB").resize((tw, th), Image.BILINEAR)
            x, y = (k % cols) * (tw + 2), (k // cols) * (th + lab + 2)
            sheet.paste(im, (x, y + lab))
            dr.text((x + 2, y + 1), f"{t // 60:02d}:{t % 60:02d} ({t})", fill=(255, 255, 0))
        name = od / f"sheet_{s0:05d}.jpg"
        sheet.save(name, quality=80)
        print(name, sheet.size, flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["scan", "thumbs", "overlay", "sheets"])
    ap.add_argument("src", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--per", type=int, default=120)
    ap.add_argument("--cols", type=int, default=12)
    ap.add_argument("--tw", type=int, default=192)
    a = ap.parse_args(argv)
    if a.cmd == "sheets":
        cmd_sheets(a.src, a.per, a.cols, a.tw)
        return 0
    a.out.mkdir(parents=True, exist_ok=True)
    {"scan": cmd_scan, "thumbs": cmd_thumbs, "overlay": cmd_overlay}[a.cmd](a.src, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
