#!/usr/bin/env python3
"""Cuts a window out of a long clip together with its stage-1 camera track, so a Video memory can be built from
just the part where the people are (the chess match is 21 s of a 196 s walk round the room).

The cut is frame-exact: frames [first, first + count) of the source (decode order, the track's frameIndex), the
audio from that frame's presentation time for the same length, re-encoded so the new clip starts on that frame, at
the size the camera was solved at (the poses' video width and height), since people.py checks the two match.
The poses file is sliced to match: frameIndex and time restart at 0, everything else (frame, intrinsics, positions)
is kept, so pipeline/recon/people.py and pipeline/avatar treat the cut like any other clip of that room.

    python clip_window.py --clip IMG_9291.mov --poses IMG_9291-poses.json --first 5051 --count 630 \
        --out-clip chess-match.mov --out-poses chess-match-poses.json [--ffmpeg ffmpeg] [--crf 14]
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip", required=True, type=Path)
    ap.add_argument("--poses", required=True, type=Path)
    ap.add_argument("--first", required=True, type=int, help="first source frame (the track's frameIndex)")
    ap.add_argument("--count", required=True, type=int, help="frames to keep")
    ap.add_argument("--out-clip", required=True, type=Path)
    ap.add_argument("--out-poses", required=True, type=Path)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--crf", type=int, default=14)
    a = ap.parse_args()

    poses = json.loads(a.poses.read_text())
    track = {int(s["frameIndex"]): s for s in poses["track"]}
    f0, f1 = a.first, a.first + a.count
    if f0 not in track or (f1 - 1) not in track:
        raise SystemExit(f"frames {f0}..{f1 - 1} are not all in the track (0..{max(track)})")
    t0 = float(track[f0]["time"])
    t1 = float(track[f1 - 1]["time"])
    fps = (f1 - 1 - f0) / (t1 - t0) if f1 - 1 > f0 else float(poses["video"]["fps"])
    dur = a.count / fps

    vw, vh = int(poses["video"]["width"]), int(poses["video"]["height"])
    vf = f"trim=start_frame={f0}:end_frame={f1},setpts=PTS-STARTPTS,scale={vw}:{vh}:flags=lanczos"
    af = f"atrim=start={t0:.6f}:duration={dur:.6f},asetpts=PTS-STARTPTS"
    cmd = [a.ffmpeg, "-y", "-v", "error", "-i", str(a.clip), "-vf", vf, "-af", af, "-map", "0:v:0", "-map", "0:a:0?",
           "-fps_mode", "passthrough", "-c:v", "libx264", "-crf", str(a.crf), "-preset", "medium", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(a.out_clip)]
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    n = int(subprocess.run([a.ffmpeg.replace("ffmpeg", "ffprobe"), "-v", "error", "-select_streams", "v:0", "-count_frames",
                            "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(a.out_clip)],
                           check=True, capture_output=True, text=True).stdout.strip() or 0)
    if n != a.count:
        raise SystemExit(f"the cut has {n} frames, expected {a.count}")

    def shift(s: dict) -> dict:
        s = dict(s)
        s["frameIndex"] = int(s["frameIndex"]) - f0
        s["time"] = round(float(s["time"]) - t0, 6)
        return s

    out = dict(poses)
    out["source"] = a.out_clip.name
    out["keyframes"] = [shift(k) for k in poses["keyframes"] if f0 <= int(k["frameIndex"]) < f1]
    out["track"] = [shift(track[i]) for i in range(f0, f1)]
    out["video"] = dict(poses["video"], frames=a.count, duration=round(dur, 6))
    out["registered"] = out["sampled"] = len(out["keyframes"])
    out["window"] = {"source": a.clip.name, "firstFrame": f0, "count": a.count, "startTime": round(t0, 6)}
    a.out_poses.write_text(json.dumps(out, indent=1))
    print(f"cut {a.clip.name} frames {f0}..{f1 - 1} ({t0:.3f} s + {dur:.3f} s) -> {a.out_clip.name}, "
          f"{len(out['keyframes'])} solved poses in the window", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
