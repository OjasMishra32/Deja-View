"""Step 2 (GPU): per-frame body pose and shape of everyone in the clip, with our camera intrinsics.

    python -m pipeline.avatar.hmr --video IMG_7373.mov --poses <clip>-poses.json --work WORK/avatar [--fps 30]

Frames are decoded with every source frame kept (no frame-rate conversion, so a frame's index is its number in
the file and its time the presentation time relative to the first frame, exactly like <clip>-poses.json), HDR
tone-mapped with the pipeline's LUTs, and every n-th frame is used so the rate is about --fps. For each used
frame: the frame itself (WORK/frames/f<index>.jpg, for texturing), a person probability mask at half size
(WORK/masks/f<index>.png, the union of everyone; deeplabv3-resnet50), and the network's people.

The network input is the frame scaled so its long side is 768 and centre-padded to a multiple of 16; the
intrinsics go through the same scale and pad and are passed to the decoder (the network otherwise guesses its
own field of view). The encoder runs under autocast; the decoder and its body model run in float32 so the bone
poses saved for the glTF skin keep full precision.

Writes WORK/hmr.npz (one row per detection: frame, time, conf, shape, bone_poses, rest_bone_poses,
transl_pelvis, j2d in source pixels, v3d float16, trackfeat float16), WORK/hmr.json (counts, field of view)
and WORK/evidence/hmr-<index>.jpg overlays every 30th used frame.
"""

from __future__ import annotations

import argparse
import math
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401  (cache locations before torch.hub / anny)
from pipeline.avatar.util import log, read_json, write_json

from pipeline.avatar.util import use_pipeline_common

use_pipeline_common()  # pipeline/common: decode, HDR LUTs, person segmenter


def frame_times(video: Path) -> np.ndarray:
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time",
           "-of", "csv=p=0", str(video)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=300).stdout
    t = [float(x.strip().rstrip(",")) for x in out.splitlines() if x.strip() and x.strip() != "N/A"]
    return np.asarray(t, np.float64)


def decode(video: Path, size: tuple[int, int], keep: set[int]):
    """(index, rgb uint8) for the kept source frames, every frame counted (-fps_mode passthrough), HDR via LUTs."""
    from common.hdr import lut_file, lut_filters, rgb48_to_rgb24, scale_options
    from common.media import hdr_source

    w, h = size
    scale = f"scale={w}:{h}:flags=area+accurate_rnd+full_chroma_int"
    src = hdr_source(video)
    base = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-fps_mode", "passthrough"]
    if src is not None:
        vf = ",".join([scale + scale_options(src)] + lut_filters(src, lut_file(src.transfer, src.primaries)))
        cmd = base + ["-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"]
        nbytes = w * h * 6
        conv = lambda b: rgb48_to_rgb24(b, w, h)  # noqa: E731
    else:
        cmd = base + ["-vf", scale, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        nbytes = w * h * 3
        conv = lambda b: np.frombuffer(b, np.uint8).reshape(h, w, 3)  # noqa: E731
    last = max(keep)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=nbytes * 2)
    try:
        i = 0
        while i <= last:
            buf = b""
            while len(buf) < nbytes:
                more = proc.stdout.read(nbytes - len(buf))
                if not more:
                    break
                buf += more
            if len(buf) < nbytes:
                break
            if i in keep:
                yield i, conv(buf)
            i += 1
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def letterbox(h: int, w: int, long_side: int = 768, multiple: int = 16):
    """Scale and centre-pad offsets of the network input: (scale, pad_x, pad_y, in_w, in_h)."""
    s = long_side / max(h, w)
    wr, hr = int(round(w * s)), int(round(h * s))
    wp, hp = int(math.ceil(wr / multiple) * multiple), int(math.ceil(hr / multiple) * multiple)
    return s, (wp - wr) // 2, (hp - hr) // 2, wp, hp


def k_input(K: np.ndarray, s: float, px: int, py: int) -> np.ndarray:
    return np.array([[K[0, 0] * s, 0.0, K[0, 2] * s + px], [0.0, K[1, 1] * s, K[1, 2] * s + py], [0.0, 0.0, 1.0]])


def intrinsics_from_poses(doc: dict) -> np.ndarray:
    k = doc["intrinsics"]
    return np.array([[k["fx"], 0.0, k["cx"]], [0.0, k["fy"], k["cy"]], [0.0, 0.0, 1.0]])


def run(video: Path, poses: Path, work: Path, fps: float = 30.0, max_seconds: float = 60.0, start: float = 0.0,
        conf: float = 0.3, nms: float = 0.25, ckpt: Path | None = None, overlay_every: int = 30) -> dict:
    import cv2
    import torch

    import multihmr2
    from common.models import PersonSegmenter

    work.mkdir(parents=True, exist_ok=True)
    (work / "frames").mkdir(exist_ok=True)
    (work / "masks").mkdir(exist_ok=True)
    (work / "evidence").mkdir(exist_ok=True)
    doc = read_json(poses)
    K = intrinsics_from_poses(doc)
    W, H = int(doc["intrinsics"]["width"]), int(doc["intrinsics"]["height"])
    times = frame_times(video)
    t_rel = times - times[0]
    src_fps = (len(t_rel) - 1) / max(t_rel[-1], 1e-6)
    step = max(1, int(round(src_fps / fps)))
    sel = [i for i in range(0, len(t_rel), step) if start - 1e-6 <= t_rel[i] <= start + max_seconds + 1e-6]
    log("hmr", f"{video.name}: {len(t_rel)} frames at {src_fps:.2f} fps; using every {step} -> {len(sel)} frames; "
               f"K fx={K[0, 0]:.1f} cx={K[0, 2]:.1f} cy={K[1, 2]:.1f} ({W}x{H})")

    t0 = time.time()
    sess = multihmr2.init_hmr_session(str(ckpt or paths.MULTIHMR2_CKPT))
    dev = sess.device
    seg = PersonSegmenter("deeplabv3-resnet50", device=str(dev))
    log("hmr", f"network ready in {time.time() - t0:.1f} s on {dev}")

    rows: dict[str, list] = {k: [] for k in ("frame", "time", "conf", "shape", "bone_poses", "rest_bone_poses",
                                             "transl_pelvis", "j2d", "v3d", "trackfeat")}
    per_frame = []
    fov_pred = []
    s = px = py = None
    tic = time.time()
    for n, (i, rgb) in enumerate(decode(video, (W, H), set(sel))):
        h, w = rgb.shape[:2]
        cv2.imwrite(str(work / "frames" / f"f{i:06d}.jpg"), rgb[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 93])
        prob = seg(rgb[None], out_hw=(h // 2, w // 2))[0]
        cv2.imwrite(str(work / "masks" / f"f{i:06d}.png"), np.clip(prob * 255 + 0.5, 0, 255).astype(np.uint8))
        x = sess.preprocessor(rgb).unsqueeze(0).to(dev)
        hp, wp = x.shape[-2:]
        s, px, py, wq, hq = letterbox(h, w)
        if (wq, hq) != (wp, hp):
            raise RuntimeError(f"network input {wp}x{hp} differs from the expected {wq}x{hq}")
        Kin = torch.from_numpy(k_input(K, s, px, py)).float().unsqueeze(0).to(dev)
        with torch.inference_mode():
            with torch.amp.autocast(device_type="cuda", enabled=sess.use_cuda):
                z = sess.model.encoder(x)
            try:
                z.feat = z.feat.float()
            except Exception:
                pass
            with torch.amp.autocast(device_type="cuda", enabled=False):
                pred = sess.model.full_body_decoder(z, K=Kin, conf_thresh=conf, dist_thresh_nms=nms)[0]
        fov_pred.append(math.degrees(2 * math.atan((w * s / 2) / float(z.K[0, 0, 0]))))
        p = pred.persons
        npers = int(p.num_person)
        per_frame.append({"frame": int(i), "time": round(float(t_rel[i]), 6), "people": npers,
                          "conf": [round(float(c), 3) for c in p.conf.flatten()]})
        for k in range(npers):
            j2d = p.j2d[k].float().cpu().numpy()
            rows["frame"].append(i)
            rows["time"].append(t_rel[i])
            rows["conf"].append(float(p.conf[k].flatten()[0]))
            rows["shape"].append(p.shape[k].float().cpu().numpy())
            rows["bone_poses"].append(p.bone_poses[k].float().cpu().numpy())
            rows["rest_bone_poses"].append(p.rest_bone_poses[k].float().cpu().numpy())
            rows["transl_pelvis"].append(p.transl_pelvis[k].reshape(3).float().cpu().numpy())
            rows["j2d"].append(np.stack([(j2d[:, 0] - px) / s, (j2d[:, 1] - py) / s], 1))
            rows["v3d"].append(p.v3d[k].float().cpu().numpy().astype(np.float16))
            tf = p.trackfeat[k].float().cpu().numpy() if p.trackfeat is not None else np.zeros(1, np.float32)
            rows["trackfeat"].append(tf.astype(np.float16))
        if n % overlay_every == 0:
            overlay(rgb, prob, p, K, work / "evidence" / f"hmr-{i:06d}.jpg")
        if n % 50 == 0:
            log("hmr", f"frame {i} ({n + 1}/{len(sel)}): {npers} people {per_frame[-1]['conf']} "
                       f"[{(time.time() - tic) / (n + 1):.2f} s/frame]")
    arrays = {k: np.asarray(v) for k, v in rows.items()}
    arrays["frame"] = arrays["frame"].astype(np.int64)
    arrays["K"] = K
    arrays["used_frames"] = np.asarray(sel, np.int64)
    arrays["used_times"] = t_rel[sel]
    arrays["all_times"] = t_rel
    np.savez(work / "hmr.npz", **arrays)
    counts = np.bincount([f["people"] for f in per_frame])
    report = {
        "video": str(video), "frames": len(per_frame), "sourceFrames": int(len(t_rel)), "sourceFps": round(src_fps, 4),
        "step": step, "detections": int(len(arrays["frame"])),
        "peoplePerFrame": {str(k): int(c) for k, c in enumerate(counts)},
        "hfovOursDeg": round(math.degrees(2 * math.atan((W / 2) / K[0, 0])), 2),
        "hfovPredictedDeg": {"median": round(float(np.median(fov_pred)), 2), "p10": round(float(np.percentile(fov_pred, 10)), 2),
                             "p90": round(float(np.percentile(fov_pred, 90)), 2)},
        "seconds": round(time.time() - t0, 1),
        "perFrame": per_frame,
    }
    if torch.cuda.is_available():
        report["maxGpuMemGB"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
    write_json(work / "hmr.json", report)
    log("hmr", f"{report['detections']} detections in {report['frames']} frames; people/frame {report['peoplePerFrame']}; "
               f"hfov ours {report['hfovOursDeg']} vs predicted {report['hfovPredictedDeg']}")
    return report


def overlay(rgb: np.ndarray, prob: np.ndarray, p, K: np.ndarray, out: Path) -> None:
    import cv2

    from pipeline.avatar.util import project

    vis = rgb[:, :, ::-1].copy()
    m = cv2.resize((prob > 0.5).astype(np.uint8), (vis.shape[1], vis.shape[0]), interpolation=cv2.INTER_NEAREST)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(vis, cnts, -1, (255, 255, 255), 2)
    colours = [(0, 200, 255), (255, 120, 0), (80, 255, 80), (255, 0, 200)]
    for k in range(int(p.num_person)):
        v = p.v3d[k].float().cpu().numpy()[::7]
        uv = project(K, v)
        c = colours[k % len(colours)]
        for u, vv in uv.astype(int):
            if 0 <= u < vis.shape[1] and 0 <= vv < vis.shape[0]:
                vis[vv, u] = c
        top = uv[np.argmin(uv[:, 1])]
        cv2.putText(vis, f"#{k} {float(p.conf[k].flatten()[0]):.2f} z={float(p.transl_pelvis[k].flatten()[2]):.2f}m",
                    (int(max(0, top[0] - 80)), int(max(30, top[1] - 20))), cv2.FONT_HERSHEY_SIMPLEX, 1.0, c, 2)
    cv2.imwrite(str(out), cv2.resize(vis, (vis.shape[1] // 2, vis.shape[0] // 2)), [cv2.IMWRITE_JPEG_QUALITY, 85])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--poses", required=True, help="<clip>-poses.json from pipeline/recon/frame.py post")
    ap.add_argument("--work", required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--max-seconds", type=float, default=60.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--conf", type=float, default=0.3)
    ap.add_argument("--nms", type=float, default=0.25)
    a = ap.parse_args(argv)
    run(Path(a.video), Path(a.poses), Path(a.work), a.fps, a.max_seconds, a.start, a.conf, a.nms)
    return 0


if __name__ == "__main__":
    sys.exit(main())
