#!/usr/bin/env python3
"""Stage 2 of a reconstruction: the people of a handheld clip, lifted into the reconstructed room.

The Video mode (pipeline/tw) assumes a still camera: one pose, one background plate. Here the camera walks around the
people, but the room is already rebuilt (world.spz) and stage 1 solved the clip's camera (<clip>-poses.json), so every
frame gets its own pose, its own rendered background and its own depth scale:

  frames    (CPU)  output frames at --fps (the source frame nearest each tick), decoded from the HDR signal with the
                   clip's exposure gain, undistorted onto a pinhole camera; analysis copies at half size, initial
                   poses from the stage-1 track
  register  (GPU)  per frame: person segmentation, monocular depth, the camera pose refined photometrically against
                   the splats (people masked out), then the room's colour, depth and coverage rendered from that pose
  pack      (CPU)  people masks (segmentation, cut to the people at the play area, edges snapped to the picture),
                   depth aligned to the rendered room on the background around them (scale and shift per frame,
                   smoothed), feet checked against the floor, colours matched to the room, the tw-pack-v1 video with
                   the clip's audio, camera-track.json (one pose per output frame) and the scene folder

  python pipeline/recon/people.py frames   --work W --clip play.mov --poses SCENE/<clip>-poses.json [--gain G]
  python pipeline/recon/people.py register --work W --world SCENE/world.spz            (HiPerGator, one GPU)
  python pipeline/recon/people.py pack     --work W --clip play.mov --world-scene SCENE --scene-dir data/scenes/<id> ...

Frame code: the packed video carries its own frame number in the last rows of the depth band (FRAME_CODE below; the
mask is zero there, so nothing is drawn from them). The viewer reads it on the GPU and takes that frame's pose from
camera-track.json, so the pose always belongs to the picture on screen, even where the browser gives no exact frame
time (immersive WebXR).

Work folder: frames.json, small/fNNNN.jpg (analysis frames), gpu/fNNNN.npz (register), register.json, pack/ (masks,
depth and colour statistics, previews).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from fractions import Fraction
from pathlib import Path

import numpy as np

from cams import Camera
from util import log, read_json, write_json

import splat_io as sio  # noqa: E402  (util puts pipeline/ on sys.path)

ANALYSIS_DIV = 2
FOOT_PULL = 0.05  # metres (see cmd_pack: feet and the floor splats in front of them)

# Frame code in the depth band: CODE_BITS blocks across the band's last CODE_ROWS rows, values CODE_LO / CODE_HI.
# Block 0 is always high and the last block always low (a decoder check); the bits between hold the frame number,
# least significant first, then one even-parity bit.
FRAME_CODE = {"rows": 4, "blocks": 16, "lo": 48, "hi": 208, "bits": 13}


def say(msg: str) -> None:
    log("people", msg)


# --------------------------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------------------------


def quat_to_matrix(q) -> np.ndarray:
    return sio.quat_xyzw_to_matrix(q)


def gl_c2w(position, quaternion) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = quat_to_matrix(quaternion)
    m[:3, 3] = position
    return m


def frame_code_values(index: int) -> np.ndarray:
    """The CODE blocks for one frame number: [1, b0 .. b(bits-1), parity, 0, ...] as uint8 levels."""
    fc = FRAME_CODE
    if index < 0 or index >= 1 << fc["bits"]:
        raise ValueError(f"frame {index} does not fit {fc['bits']} bits")
    bits = [(index >> i) & 1 for i in range(fc["bits"])]
    blocks = [1] + bits + [sum(bits) & 1]
    blocks += [0] * (fc["blocks"] - len(blocks))
    if len(blocks) != fc["blocks"]:
        raise ValueError("FRAME_CODE has too few blocks")
    return np.where(np.asarray(blocks) > 0, fc["hi"], fc["lo"]).astype(np.uint8)


def read_frame_code(band_row: np.ndarray) -> int | None:
    """Frame number from one decoded row of the depth band (luma 0..255), or None when the code does not check out."""
    fc = FRAME_CODE
    w = band_row.shape[0]
    centres = ((np.arange(fc["blocks"]) + 0.5) * w / fc["blocks"]).astype(int)
    b = (band_row[centres] > (fc["lo"] + fc["hi"]) / 2).astype(int)
    bits = b[1 : 1 + fc["bits"]]
    if b[0] != 1 or b[-1] != 0 or (int(bits.sum()) & 1) != b[1 + fc["bits"]]:
        return None
    return int(sum(int(v) << i for i, v in enumerate(bits)))


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(np.asarray(x, np.float32), 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


# --------------------------------------------------------------------------------------------------------------
# frames
# --------------------------------------------------------------------------------------------------------------


def clip_camera(poses: dict) -> Camera:
    """The clip's solved camera (SIMPLE_RADIAL at full size) from <clip>-poses.json."""
    K = poses["intrinsics"]
    k1 = float((poses.get("distortion") or {}).get("k1", 0.0))
    return Camera("SIMPLE_RADIAL", int(K["width"]), int(K["height"]), np.array([K["fx"], K["cx"], K["cy"], k1], np.float64))


def pick_frames(times: np.ndarray, fps: Fraction, duration: float) -> list[tuple[int, int, float]]:
    """(output index, source index, output time) for every tick of a constant `fps` clock over `duration`: the source
    frame whose presentation time is nearest the tick."""
    n = int(math.floor(duration * float(fps) + 1e-6))
    out = []
    for k in range(n):
        t = k / float(fps)
        j = int(np.argmin(np.abs(times - t)))
        out.append((k, j, t))
    return out


def decode_linear(clip: Path, size: tuple[int, int], keep: set[int], gain: float):
    """(source index, linear BT.709 light after the exposure gain and the usual highlight roll-off, float32) for the
    kept frames of an HDR clip. This is what prep.py's hdr_to_sdr encodes to 8 bits."""
    from common import hdr
    from common.media import hdr_source
    from prep import decode_frames, hdr_linear

    src = hdr_source(clip)
    if src is None:
        # an SDR clip: undo its gamma 2.4 so encode_sdr() gives the same pixels back (gain 1)
        for i, rgb in decode_frames(clip, size, keep=keep, tonemap=False):
            yield i, (np.power(rgb.astype(np.float32) / 255.0, hdr.SDR_GAMMA) * gain).astype(np.float32)
        return
    for i, sig in decode_frames(clip, size, keep=keep, hdr_signal=True):
        lin = hdr_linear(sig, src.transfer, src.primaries) * gain
        r, g, b = hdr._rolloff(lin[..., 0], lin[..., 1], lin[..., 2])
        yield i, np.stack([np.maximum(r, 0), np.maximum(g, 0), np.maximum(b, 0)], axis=-1).astype(np.float32)


def encode_sdr(lin: np.ndarray) -> np.ndarray:
    """Linear (after roll-off) -> 8-bit with the SDR gamma, exactly as prep.py's training frames."""
    from common import hdr

    return np.clip(hdr._encode(np.clip(lin, 0, 1)) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def cmd_frames(a) -> None:
    import cv2

    from common.media import hdr_source, probe, save_jpg
    from prep import exposure_gain, decode_frames, frame_times

    work = Path(a.work)
    (work / "small").mkdir(parents=True, exist_ok=True)
    poses = read_json(a.poses)
    if not poses or "track" not in poses:
        raise SystemExit(f"{a.poses} has no per-frame track (frame.py post writes <clip>-poses.json)")
    info = probe(a.clip)
    times = frame_times(a.clip)
    times = times - times[0]
    track = {int(s["frameIndex"]): s for s in poses["track"]}
    if len(track) != len(times):
        say(f"WARNING: the track has {len(track)} frames, the clip {len(times)}; using the first {min(len(track), len(times))}")
        times = times[: min(len(track), len(times))]
    duration = float(info.duration)
    fps = Fraction(a.fps).limit_denominator(1001)
    picks = pick_frames(times, fps, duration)
    cam = clip_camera(poses)
    W, H = cam.width, cam.height
    if (info.width, info.height) != (W, H):
        raise SystemExit(f"the clip is {info.width}x{info.height} but its solved camera is {W}x{H}")
    src = hdr_source(a.clip)
    gain = a.gain
    if gain is None and src is None:
        gain = 1.0  # an SDR clip: its frames are already exposed for display
    if gain is None:
        probe_idx = {j for _, j, _ in picks[:: max(1, len(picks) // 12)]}
        gain = exposure_gain([s for _, s in decode_frames(a.clip, (W, H), keep=probe_idx, hdr_signal=True)], src.transfer, src.primaries)
    mx, my = cam.undistort_maps()
    pin = cam.pinhole()
    (fx, fy), (cx, cy) = pin.f, pin.c
    sw, sh = W // ANALYSIS_DIV, H // ANALYSIS_DIV
    say(f"{Path(a.clip).name}: {W}x{H}, {len(times)} frames over {duration:.3f} s -> {len(picks)} frames at {float(fps):.3f} fps; "
        f"exposure gain {gain:.4f}; analysis frames {sw}x{sh}")
    keep = {j for _, j, _ in picks}
    by_src: dict[int, list[int]] = {}
    for k, j, _ in picks:
        by_src.setdefault(j, []).append(k)
    t0 = time.time()
    done = 0
    for j, lin in decode_linear(Path(a.clip), (W, H), keep, gain):
        lin = cv2.remap(lin, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        small = cv2.resize(encode_sdr(lin), (sw, sh), interpolation=cv2.INTER_AREA)
        for k in by_src[j]:
            save_jpg(work / "small" / f"f{k:04d}.jpg", small, quality=95)
            done += 1
        if done % 60 < len(by_src[j]):
            say(f"  {done}/{len(picks)} frames ({time.time() - t0:.0f}s)")
    frames = []
    for k, j, t in picks:
        s = track[j]
        frames.append({"index": k, "time": round(t, 6), "source": j, "sourceTime": round(float(times[j]), 6),
                       "position": s["position"], "quaternion": s["quaternion"]})
    keys = sorted(int(kf["frameIndex"]) for kf in poses.get("keyframes", []))
    write_json(work / "frames.json", {
        "clip": Path(a.clip).name,
        "fps": [fps.numerator, fps.denominator],
        "duration": duration,
        "frames": frames,
        "width": W,
        "height": H,
        "intrinsics": {"fx": fx, "fy": fy, "cx": cx, "cy": cy},
        "distortion": cam.distortion(),
        "analysisDiv": ANALYSIS_DIV,
        "exposureGain": gain,
        "hdr": {"transfer": src.transfer, "primaries": src.primaries} if src else None,
        "keyframes": keys,
        "note": "intrinsics are of the undistorted (pinhole) frames in continuous pixel coordinates (pixel centres at "
                "i + 0.5); position/quaternion: the stage-1 track at the source frame (viewer frame, OpenGL camera)",
    })
    say(f"wrote {len(frames)} analysis frames and frames.json ({time.time() - t0:.0f}s)")


# --------------------------------------------------------------------------------------------------------------
# register (GPU)
# --------------------------------------------------------------------------------------------------------------


def _ssim(x, y):
    from train_gs import ssim_map

    return ssim_map(x.permute(2, 0, 1)[None], y.permute(2, 0, 1)[None])[0].mean(0)


def colour_solution(render, target, mask):
    """3x4 least-squares colour transform render -> target over mask (no gradient)."""
    import torch

    r = render.detach()[mask].double()
    t = target[mask].double()
    X = torch.cat([r, torch.ones_like(r[:, :1])], dim=1)
    return torch.linalg.lstsq(X, t).solution.float()


def apply_colour(render, sol):
    import torch

    return torch.cat([render, torch.ones_like(render[..., :1])], dim=-1) @ sol


def ignore_people(prob: np.ndarray, grow_frac: float = 0.04) -> np.ndarray:
    """True where a person might be: segmentation above 0.1, each blob filled to its convex hull, then dilated."""
    import cv2

    h, w = prob.shape
    m = (prob > 0.1).astype(np.uint8)
    n, lab = cv2.connectedComponents(m)
    out = np.zeros_like(m)
    for c in range(1, n):
        ys, xs = np.nonzero(lab == c)
        if xs.size < 20:
            continue
        hull = cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32))
        cv2.fillConvexPoly(out, hull, 1)
    r = max(1, int(grow_frac * min(h, w)))
    out = cv2.dilate(out, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    return out > 0


class Room:
    """world.spz on the GPU, rendered from OpenCV world-to-camera matrices."""

    def __init__(self, path: Path, device: str = "cuda"):
        import torch

        s = sio.read_spz(path)
        self.n = len(s)
        self.sh_degree = s.sh_degree
        self.means = torch.from_numpy(s.means).to(device)
        self.quats = torch.from_numpy(s.quats).to(device)
        self.scales = torch.from_numpy(s.scales).to(device)
        self.opac = torch.from_numpy(s.opacities).to(device)
        self.sh = torch.from_numpy(np.ascontiguousarray(s.sh_all())).to(device)
        self.device = device

    def render(self, w2c, K, width: int, height: int, mode: str = "RGB"):
        from gsplat import rasterization

        out, alpha, _ = rasterization(self.means, self.quats, self.scales, self.opac, self.sh, w2c[None], K[None],
                                      int(width), int(height), sh_degree=self.sh_degree, render_mode=mode,
                                      near_plane=0.01, far_plane=1e4, packed=False)
        return out[0], alpha[0, ..., 0]


def refine_pose(room: Room, w2c0, K_full, target_full, valid_full, init, levels=((2, 60, 1.0), (1, 40, 0.35))):
    """Photometric pose refinement: a camera-frame correction D (w2c' = D @ w2c0) minimising 0.8 L1 + 0.2 (1 - SSIM)
    between the render (after a per-frame colour fit) and the frame over `valid` pixels, coarse to fine. `levels`:
    (downscale of the analysis frame, iterations, learning-rate factor). Returns (6-vector, stats)."""
    import torch
    import torch.nn.functional as F

    from train_gs import pose_delta

    dev = room.device
    rot = torch.tensor(init[:3], dtype=torch.float32, device=dev, requires_grad=True)
    tr = torch.tensor(init[3:], dtype=torch.float32, device=dev, requires_grad=True)
    H, W = target_full.shape[:2]
    stats = {}
    for div, iters, lr in levels:
        h, w = H // div, W // div
        scale = w / W
        K = K_full.clone()
        K[:2] *= scale
        tgt = F.interpolate(target_full.permute(2, 0, 1)[None], size=(h, w), mode="area")[0].permute(1, 2, 0)
        val = F.interpolate(valid_full[None, None].float(), size=(h, w), mode="area")[0, 0] > 0.99
        opt = torch.optim.Adam([{"params": [rot], "lr": 1.0e-3 * lr}, {"params": [tr], "lr": 3.0e-3 * lr}])
        first = last = None
        for it in range(iters):
            D = pose_delta(torch.cat([rot, tr]))
            img, alpha = room.render(D @ w2c0, K, w, h)
            img = img.clamp(0, 1)
            m = val & (alpha.detach() > 0.95)
            if int(m.sum()) < 500:
                break
            pred = apply_colour(img, colour_solution(img, tgt, m))
            l1 = (pred - tgt).abs()[m].mean()
            loss = 0.8 * l1 + 0.2 * (1 - _ssim(pred, tgt))[m].mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            if first is None:
                first = float(loss)
            last = float(loss)
        stats[f"loss{div}"] = [round(first or 0, 5), round(last or 0, 5)]
    return np.concatenate([rot.detach().cpu().numpy(), tr.detach().cpu().numpy()]), stats


def masked_psnr(room: Room, w2c, K, target, valid) -> float:
    import torch

    with torch.no_grad():
        img, alpha = room.render(w2c, K, target.shape[1], target.shape[0])
        img = img.clamp(0, 1)
        m = valid & (alpha > 0.95)
        pred = apply_colour(img, colour_solution(img, target, m)).clamp(0, 1)
        mse = ((pred - target) ** 2)[m].mean()
        return float(-10 * torch.log10(mse))


def cmd_register(a) -> None:
    import cv2
    import torch

    from common.models import DepthEstimator, PersonSegmenter
    from train_gs import pose_delta

    work = Path(a.work)
    meta = read_json(work / "frames.json")
    frames = meta["frames"]
    if a.limit:
        frames = frames[: a.limit]
    out_dir = work / "gpu"
    out_dir.mkdir(parents=True, exist_ok=True)
    dev = "cuda"
    t_all = time.time()
    imgs = []
    for f in frames:
        bgr = cv2.imread(str(work / "small" / f"f{f['index']:04d}.jpg"), cv2.IMREAD_COLOR)
        imgs.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    h, w = imgs[0].shape[:2]
    say(f"{len(imgs)} frames at {w}x{h}")

    # people (two scales, averaged) and monocular depth, batched
    t0 = time.time()
    seg = PersonSegmenter("deeplabv3-resnet50", device=dev, short_side=520)
    probs = np.zeros((len(imgs), h, w), np.float32)
    for short in (520, 760):
        seg.short_side = short
        for i in range(0, len(imgs), 8):
            probs[i : i + 8] += seg(np.stack(imgs[i : i + 8]), (h, w)) / 2
    del seg
    est = DepthEstimator(a.depth_model, device=dev, short_side=518)
    mono = np.zeros((len(imgs), h, w), np.float16)
    for i in range(0, len(imgs), 8):
        mono[i : i + 8] = est(np.stack(imgs[i : i + 8]), (h, w)).astype(np.float16)
    del est
    torch.cuda.empty_cache()
    t_models = time.time() - t0
    say(f"segmentation (DeepLabV3-ResNet50 at 520 and 760) and depth ({a.depth_model}) in {t_models:.1f}s")

    room = Room(Path(a.world), dev)
    say(f"world: {room.n} splats, SH degree {room.sh_degree}")
    K = torch.tensor([[meta["intrinsics"]["fx"], 0, meta["intrinsics"]["cx"]], [0, meta["intrinsics"]["fy"], meta["intrinsics"]["cy"]],
                      [0, 0, 1]], dtype=torch.float32, device=dev)
    K[:2] /= meta["analysisDiv"]
    delta = np.zeros(6)
    recs = []
    t0 = time.time()
    every = max(1, int(getattr(a, "refine_every", 1) or 1))
    deltas = None
    if every > 1 and not a.no_refine:
        # long clips: refine every n-th frame (and the last), the corrections between are interpolated linearly
        picks = sorted(set(range(0, len(frames), every)) | {len(frames) - 1})
        got = {}
        rejected: list[int] = []
        for i in picks:
            f = frames[i]
            c2w0 = gl_c2w(f["position"], f["quaternion"])
            w2c0 = torch.tensor(sio.c2w_gl_to_cv_w2c(c2w0), dtype=torch.float32, device=dev)
            target = torch.from_numpy(imgs[i]).to(dev).float() / 255.0
            valid = torch.from_numpy(~ignore_people(probs[i])).to(dev)
            try:
                d_i, _ = refine_pose(room, w2c0, K, target, valid, delta)
            except Exception as e:  # a singular / NaN pose mid-optimisation (frames the person fills)
                say(f"  frame {f['index']}: refinement failed ({type(e).__name__}); keeping the stage-1 pose")
                d_i = None
            # a correction that is not finite or far beyond what interpolation errors look like is not trusted
            if d_i is None or not np.all(np.isfinite(d_i)) or np.degrees(np.linalg.norm(d_i[:3])) > 3.0 or np.linalg.norm(d_i[3:]) > 0.15:
                d_i = np.zeros(6)
                rejected.append(int(f["index"]))
            got[i] = d_i
            delta = d_i
            if len(got) % 20 == 1:
                say(f"  refined frame {f['index']} ({len(got)}/{len(picks)}, {time.time() - t0:.0f}s)")
        xs = np.array(picks, np.float64)
        ys = np.stack([got[i] for i in picks])
        deltas = np.stack([np.interp(np.arange(len(frames)), xs, ys[:, j]) for j in range(6)], 1)
        say(f"refined {len(picks)} of {len(frames)} frames (every {every}; {len(rejected)} corrections rejected: {rejected[:20]}); "
            f"the rest interpolated ({time.time() - t0:.0f}s)")
    for i, f in enumerate(frames):
        c2w0 = gl_c2w(f["position"], f["quaternion"])
        w2c0 = torch.tensor(sio.c2w_gl_to_cv_w2c(c2w0), dtype=torch.float32, device=dev)
        target = torch.from_numpy(imgs[i]).to(dev).float() / 255.0
        valid = torch.from_numpy(~ignore_people(probs[i])).to(dev)
        before = masked_psnr(room, w2c0, K, target, valid)
        if a.no_refine:
            d, st = np.zeros(6), {}
        elif deltas is not None:
            d, st = deltas[i], {"refined": bool(i % every == 0 or i == len(frames) - 1)}
        else:
            # corrections change slowly: start from the previous frame's
            d, st = refine_pose(room, w2c0, K, target, valid, delta)
            delta = d
        with torch.no_grad():
            D = pose_delta(torch.tensor(d, dtype=torch.float32, device=dev))
            w2c = D @ w2c0
            after = masked_psnr(room, w2c, K, target, valid)
            out, alpha = room.render(w2c, K, w, h, mode="RGB+ED")
        rgb = (out[..., :3].clamp(0, 1) * 255 + 0.5).byte().cpu().numpy()
        depth = out[..., 3].float().cpu().numpy()
        al = alpha.float().cpu().numpy()
        np.savez_compressed(out_dir / f"f{f['index']:04d}.npz",
                            prob=np.clip(probs[i] * 255 + 0.5, 0, 255).astype(np.uint8),
                            mono=mono[i], depth=depth.astype(np.float16), alpha=np.clip(al * 255 + 0.5, 0, 255).astype(np.uint8), rgb=rgb)
        c2w_gl = sio.c2w_cv_to_gl(np.linalg.inv(w2c.double().cpu().numpy()))
        rot_deg = float(np.degrees(np.linalg.norm(d[:3])))
        recs.append({"index": f["index"], "source": f["source"], "time": f["time"],
                     "position": [round(float(v), 6) for v in c2w_gl[:3, 3]], "quaternion": sio.matrix_to_quat_xyzw(c2w_gl[:3, :3]),
                     "psnrBefore": round(before, 3), "psnrAfter": round(after, 3), "deltaRotDeg": round(rot_deg, 4),
                     "deltaShiftCm": round(float(np.linalg.norm(c2w0[:3, 3] - c2w_gl[:3, 3])) * 100, 3), **st})
        if i % 20 == 0 or i == len(frames) - 1:
            say(f"  frame {f['index']}: PSNR {before:.2f} -> {after:.2f} dB, correction {rot_deg:.3f} deg / "
                f"{recs[-1]['deltaShiftCm']:.2f} cm ({time.time() - t0:.0f}s)")
    pb = np.array([r["psnrBefore"] for r in recs])
    pa = np.array([r["psnrAfter"] for r in recs])
    summary = {
        "frames": len(recs),
        "psnrBefore": {"mean": round(float(pb.mean()), 3), "min": round(float(pb.min()), 3)},
        "psnrAfter": {"mean": round(float(pa.mean()), 3), "min": round(float(pa.min()), 3)},
        "correctionDeg": {"median": round(float(np.median([r["deltaRotDeg"] for r in recs])), 4),
                          "max": round(float(np.max([r["deltaRotDeg"] for r in recs])), 4)},
        "correctionCm": {"median": round(float(np.median([r["deltaShiftCm"] for r in recs])), 3),
                         "max": round(float(np.max([r["deltaShiftCm"] for r in recs])), 3)},
        "seconds": {"models": round(t_models, 1), "registerAndRender": round(time.time() - t0, 1), "total": round(time.time() - t_all, 1)},
        "refineEvery": every if not a.no_refine else None,
        "depthModel": a.depth_model,
        "segmenter": "deeplabv3-resnet50 (520 + 760 short side, averaged)",
        "gpu": torch.cuda.get_device_name(0),
    }
    write_json(work / "register.json", {"summary": summary, "frames": recs})
    say(f"done: PSNR on the room (people masked) {summary['psnrBefore']['mean']} -> {summary['psnrAfter']['mean']} dB; "
        f"corrections median {summary['correctionDeg']['median']} deg, {summary['correctionCm']['median']} cm")


# --------------------------------------------------------------------------------------------------------------
# pack
# --------------------------------------------------------------------------------------------------------------


def smooth_poses(init: list[dict], refined: list[dict], sigma: float) -> tuple[list[np.ndarray], dict]:
    """Camera-to-room (OpenGL) per frame: the refined pose, its correction to the stage-1 track filtered over time.

    The correction E (refined = track @ E, in the camera frame) is a 6-vector per frame. A frame whose fit did not
    improve the match with the room, or moved the camera implausibly far (over 1.5 degrees or 5 cm), takes the
    running median of its neighbours; a Gaussian of `sigma` frames then removes the estimation noise. The track
    itself keeps its own motion (the hand's shake is real and the picture has it)."""
    from scipy.ndimage import gaussian_filter1d, median_filter
    from scipy.spatial.transform import Rotation

    C0 = [gl_c2w(f["position"], f["quaternion"]) for f in init]
    C1 = [gl_c2w(r["position"], r["quaternion"]) for r in refined]
    E = [np.linalg.inv(a) @ b for a, b in zip(C0, C1)]
    v = np.concatenate([Rotation.from_matrix([e[:3, :3] for e in E]).as_rotvec(), np.array([e[:3, 3] for e in E])], axis=1)
    med = median_filter(v, size=(9, 1), mode="nearest")
    worse = np.array([r.get("psnrAfter", 0) < r.get("psnrBefore", 0) - 0.05 for r in refined])
    bad = worse | (np.linalg.norm(v[:, :3], axis=1) > np.radians(1.5)) | (np.linalg.norm(v[:, 3:], axis=1) > 0.05)
    v = np.where(bad[:, None], med, v)
    if sigma > 0:
        v = gaussian_filter1d(v, sigma, axis=0, mode="nearest")
    out = []
    for c0, x in zip(C0, v):
        e = np.eye(4)
        e[:3, :3] = Rotation.from_rotvec(x[:3]).as_matrix()
        e[:3, 3] = x[3:]
        out.append(c0 @ e)

    def jitter(cs):
        p = np.array([c[:3, 3] for c in cs])
        return float(np.sqrt(np.mean(np.sum(np.diff(p, 2, axis=0) ** 2, axis=1))) * 1000)

    stats = {"outliersReplaced": int(bad.sum()), "sigmaFrames": sigma,
             "positionJerkMm": {"track": round(jitter(C0), 3), "refined": round(jitter(C1), 3), "final": round(jitter(out), 3)}}
    return out, stats


def guided_filter_rgb(I: np.ndarray, p: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Edge-aware smoothing of p (H, W) steered by the colour image I (H, W, 3), both 0..1: a local linear model of
    p in the colours of I, so p's edges move onto the picture's edges."""
    import cv2

    def box(x):
        return cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1), normalize=True, borderType=cv2.BORDER_REFLECT)

    I = I.astype(np.float32)
    p = p.astype(np.float32)
    mI = np.stack([box(I[..., c]) for c in range(3)], axis=-1)
    mp = box(p)
    cov = np.stack([box(I[..., c] * p) for c in range(3)], axis=-1) - mI * mp[..., None]
    S = np.empty(I.shape[:2] + (3, 3), np.float32)
    for i in range(3):
        for j in range(i, 3):
            S[..., i, j] = S[..., j, i] = box(I[..., i] * I[..., j]) - mI[..., i] * mI[..., j]
    S += eps * np.eye(3, dtype=np.float32)
    a = np.linalg.solve(S, cov[..., None])[..., 0]
    b = mp - (a * mI).sum(axis=-1)
    return (np.stack([box(a[..., c]) for c in range(3)], axis=-1) * I).sum(axis=-1) + box(b)


def camera_rays(K: dict, w: int, h: int) -> np.ndarray:
    """(h, w, 3) camera-frame (OpenGL) points at z-depth 1 for every pixel centre of a w x h image."""
    u = (np.arange(w, dtype=np.float32) + 0.5 - K["cx"]) / K["fx"]
    v = (np.arange(h, dtype=np.float32) + 0.5 - K["cy"]) / K["fy"]
    uu, vv = np.meshgrid(u, v)
    return np.stack([uu, -vv, -np.ones_like(uu)], axis=-1)


def to_room(rays: np.ndarray, z: np.ndarray, c2w: np.ndarray) -> np.ndarray:
    """Room points of pixels at z-depth z (rays from camera_rays)."""
    return (rays * z[..., None]) @ c2w[:3, :3].T + c2w[:3, 3]


def room_depth(rz: np.ndarray, rays: np.ndarray, c2w: np.ndarray, floor_y: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """The rendered room's z-depth with the floor made exact, and where the floor is.

    gsplat's expected depth weights splat centres front to back, which on a floor seen at a slant comes out up to
    ~12% short (the near edges of the flat floor splats win): floor points from it float 10-20 cm up. Where the
    render's depth is within -20%/+15% of the ray's hit with the floor plane (y = floor_y), the plane's depth is
    used instead. Tables, chairs and walls keep the render's depth."""
    k = (rays @ c2w[:3, :3].T)[..., 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        zf = np.where(k < -1e-4, (floor_y - c2w[1, 3]) / k, np.inf)
    floor = (rz > 0) & np.isfinite(zf) & (rz > 0.8 * zf) & (rz < 1.15 * zf)
    return np.where(floor, zf, rz).astype(np.float32), floor


def aac_audio(clip: Path, dst: Path) -> Path | None:
    """The clip's stereo AAC track on its own (iPhones add a spatial-audio track first that ffmpeg cannot decode)."""
    import subprocess

    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index,codec_name",
                          "-of", "csv=p=0", str(clip)], capture_output=True, text=True, check=True).stdout
    streams = [line.split(",") for line in out.split() if "," in line]
    aac = [i for i, (idx, codec) in enumerate(streams) if codec.strip() == "aac"]
    if not aac:
        return None
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(clip), "-map", f"0:a:{aac[0]}", "-c", "copy", str(dst)], check=True)
    return dst


def summarise_cm(values: list[float]) -> dict:
    v = np.asarray(values, np.float64)
    if not v.size:
        return {"n": 0}
    return {"n": int(v.size), "median": round(float(np.median(v)) * 100, 2), "p10": round(float(np.percentile(v, 10)) * 100, 2),
            "p90": round(float(np.percentile(v, 90)) * 100, 2)}


def solve_person_scale(items: list[tuple[int, dict]], sigma_contact: float = 0.03, sigma_move: float = 0.01,
                       sigma_stay: float = 0.35, sigma_prior: float = 1.0, iters: int = 5) -> np.ndarray:
    """Depth scale of one person in every frame they are in (their depth from the network, times s).

    Monocular depth gets a person's distance wrong when the clues are gone (feet hidden behind the table: a player
    leaning on the far side came out a metre too far). Each frame's person sits on rays from that frame's camera:
    at scale s their place on the floor plan is C + s D (C the camera, D the median offset of their pixels at s = 1),
    so with the camera walking around them, the person staying put (or moving smoothly) pins s down, as two eyes
    do. Least squares in metres over:
      feet         z (s - r) / sigma_contact where the feet are visible on the floor (r from foot_contact; a reading
                   far from its neighbours' is dropped),
      smoothness   |P(t) - P(t+1)| / (sigma_move sqrt(gap)) between frames up to 5 apart (players at a table
                   shift their weight but stay put: 1 cm a frame is 0.3 m/s),
      staying      |P(t) - Pbar| / sigma_stay with Pbar the person's own place (two more unknowns): people playing
                   at a table do not wander off, which stops a slow drift along the viewing rays,
      prior        z (s - 1) / sigma_prior (weak),
    reweighted (Cauchy-like, past 2 sigma) so a bad foot reading or a quick step does not drag the rest."""
    m = len(items)
    ratios = np.array([it[1]["contact"]["ratio"] if it[1]["contact"] else np.nan for it in items])
    good = np.isfinite(ratios) & (ratios > 0.6) & (ratios < 1.6)
    if good.sum() >= 3:
        from scipy.ndimage import median_filter

        idx = np.flatnonzero(good)
        med = median_filter(ratios[idx], size=min(9, idx.size | 1), mode="nearest")
        good[idx[np.abs(ratios[idx] - med) > 0.06]] = False
    rows, rhs = [], []
    for i, (_, r) in enumerate(items):
        z = r["z"]
        rows.append({i: z / sigma_prior}); rhs.append(z / sigma_prior)
        if good[i]:
            rows.append({i: z / sigma_contact}); rhs.append(z * ratios[i] / sigma_contact)
        for ax in (0, 1):
            rows.append({i: r["D"][ax] / sigma_stay, m + ax: -1.0 / sigma_stay}); rhs.append(-r["C"][ax] / sigma_stay)
    for i in range(m - 1):
        (k0, r0), (k1, r1) = items[i], items[i + 1]
        gap = k1 - k0
        if gap > 5:
            continue
        w = 1.0 / (sigma_move * math.sqrt(gap))
        for ax in (0, 1):
            rows.append({i: r0["D"][ax] * w, i + 1: -r1["D"][ax] * w}); rhs.append((r1["C"][ax] - r0["C"][ax]) * w)
    A = np.zeros((len(rows), m + 2))
    for j, row in enumerate(rows):
        for i, v in row.items():
            A[j, i] = v
    b = np.asarray(rhs)
    wts = np.ones(len(rows))
    x = np.ones(m + 2)
    for _ in range(iters):
        x = np.linalg.lstsq(A * wts[:, None], b * wts, rcond=None)[0]
        res = np.abs(A @ x - b)
        wts = np.where(res > 2.0, 2.0 / np.maximum(res, 1e-9), 1.0)
    return np.clip(x[:m], 0.5, 2.0)


def people_mask(soft: np.ndarray, inv: np.ndarray, min_extra: int, room_inv: np.ndarray | None = None) -> np.ndarray:
    """People from the soft segmentation: the confident part (> 0.5) plus what hangs on it with a weak score.

    The person class scores a backpack (dark, its own shape) at 0.03-0.4, so a plain threshold cuts the players'
    backpacks off. Weak means a score over 0.12, or over 0.03 where the depth says something stands in front of the
    room (`room_inv`: the rendered room, which has no people, 20% farther than what the camera saw). A weak region
    beyond the halo of the confident part (13 px), of a backpack's size, that joins a person through weak pixels and
    is not far behind them (inverse depth within 25%), is theirs."""
    import cv2

    def disk(r):
        return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))

    strong = soft > 0.5
    weak = soft > 0.12
    if room_inv is not None:
        weak |= (soft > 0.03) & (room_inv > 0) & (inv > 1.2 * room_inv)
    halo = cv2.dilate(strong.astype(np.uint8), disk(6)) > 0
    n, lab, st, _ = cv2.connectedComponentsWithStats((weak & ~halo).astype(np.uint8), connectivity=8)
    out = strong.copy()
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < min_extra:
            continue
        blob = lab == i
        reach = cv2.dilate(blob.astype(np.uint8), disk(7)) > 0
        joined = reach & weak
        ring = reach & strong
        if not ring.any():
            continue
        if np.median(inv[blob]) < 0.75 * np.median(inv[ring]):
            continue
        out |= joined | blob
    return out


def fill_person_holes(binary: np.ndarray, inv: np.ndarray, max_area: int) -> np.ndarray:
    """Fill holes in the people mask that are the person (segmentation misses: same depth as the person around
    them, within -20%/+25% in inverse depth), but not the gaps between an arm and the body where the room shows
    through (much farther), nor a table leg or rod in front of them (much nearer: the room has it)."""
    import cv2

    n, lab, st, _ = cv2.connectedComponentsWithStats((~binary).astype(np.uint8), connectivity=4)
    h, w = binary.shape
    out = binary.copy()
    ring_k = np.ones((7, 7), np.uint8)
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area > max_area or x == 0 or y == 0 or x + bw >= w or y + bh >= h:
            continue
        sl = (slice(max(0, y - 4), min(h, y + bh + 4)), slice(max(0, x - 4), min(w, x + bw + 4)))
        hole = lab[sl] == i
        ring = (cv2.dilate(hole.astype(np.uint8), ring_k) > 0) & binary[sl]
        if not ring.any():
            continue
        r = np.median(inv[sl][hole]) / max(float(np.median(inv[sl][ring])), 1e-6)
        if 0.8 <= r <= 1.25:
            out[sl] |= hole
    return out


def layer_step(near: np.ndarray, far: np.ndarray, inv: np.ndarray) -> float:
    """How far the far part sits behind the near part where they meet (median relative jump in inverse depth from
    far pixels 2-4 px off the near part to the nearest near value within 4 px): ~0 across a smooth surface (a
    backpack into the shoulders), large across an occlusion (one person in front of another)."""
    import cv2

    nb = near.astype(np.uint8)
    ring = far & (cv2.dilate(nb, np.ones((9, 9), np.uint8)) > 0) & ~(cv2.dilate(nb, np.ones((3, 3), np.uint8)) > 0)
    if ring.sum() < 10:
        return 0.0
    near_max = cv2.dilate(np.where(near, inv, 0).astype(np.float32), np.ones((9, 9), np.uint8))
    return float(np.median(near_max[ring] / np.maximum(inv[ring], 1e-6) - 1.0))


def split_by_depth(c: np.ndarray, inv: np.ndarray, min_area: int, merged: bool) -> list[np.ndarray]:
    """One segmentation blob -> the people in it, split where its depth has two layers with an occlusion between them.

    Two players overlapping in the picture, or a passer-by behind a player, come out of the segmentation as one blob.
    The split is on log inverse depth at the best two-class threshold, and only where the layers meet at a real
    depth step (layer_step), never across a smooth surface:
      merged   (the blob covers two people of the frame before): a step of 15%, each layer at least 5% of the blob;
      else     someone small far behind: a step of 25%, layers 50% apart, the far layer 3-50% of the blob.
    A near layer in front of the body (a hand, a rod) stays with it."""
    import cv2

    v = np.log(np.maximum(inv[c], 1e-4))
    if v.size < 400:
        return [c]
    lo, hi = np.percentile(v, [3, 97])
    if hi - lo < math.log(1.15):
        return [c]
    hist, edges = np.histogram(v, 64, range=(lo, hi))
    centres = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centres) / np.maximum(w0, 1)
    m1 = (np.sum(hist * centres) - np.cumsum(hist * centres)) / np.maximum(w1, 1)
    j = int(np.argmax(w0 * w1 * (m1 - m0) ** 2))
    far = c & (np.log(np.maximum(inv, 1e-4)) < edges[j + 1])
    near = c & ~far
    frac_far = far.sum() / v.size
    gap = math.exp(m1[j] - m0[j]) - 1
    if merged:
        ok = min(frac_far, 1 - frac_far) >= 0.05 and layer_step(near, far, inv) >= 0.15
    else:
        ok = gap >= 0.5 and 0.03 <= frac_far <= 0.5 and layer_step(near, far, inv) >= 0.25
    if not ok:
        return [c]
    out = []
    for part in (near, far):
        part = cv2.morphologyEx(part.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        out += components(part, max(1, min_area // 4))
    return out or [c]


def components(binary: np.ndarray, min_area: int) -> list[np.ndarray]:
    import cv2

    n, lab, st, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    return [lab == c for c in range(1, n) if st[c, cv2.CC_STAT_AREA] >= min_area]


def foot_contact(comp: np.ndarray, z: np.ndarray, floor: np.ndarray, rays: np.ndarray, c2w: np.ndarray, frac: float = 0.02) -> dict | None:
    """Where a person's lowest visible pixels meet the floor, if they do.

    The bottom `frac` of the person's rows (at least 3) are the soles. They count only when the person does not run
    off the bottom of the frame and the room right under them (the render, which has no people) is floor (y ~ 0):
    otherwise the feet are hidden (by the table, by the frame edge) and the lowest pixels say nothing about the
    floor. `floor`: where the room render shows floor (room_depth). Returns the soles' height above the floor with
    the person's depth z and the depth ratio that would put them on it."""
    h = comp.shape[0]
    rows = np.flatnonzero(comp.any(axis=1))
    top, bottom = rows[0], rows[-1]
    if bottom >= h - 6:
        return None
    band = max(3, int(round(frac * (bottom - top + 1))))
    sole = comp & (np.arange(h)[:, None] > bottom - band)
    ys, xs = np.nonzero(sole)
    below_y = np.minimum(ys + 4, h - 1)
    if np.mean(floor[below_y, xs]) < 0.7:
        return None
    pts = to_room(rays[ys, xs], z[ys, xs], c2w)
    # the depth at which each sole ray meets y = 0
    d_dir = rays[ys, xs] @ c2w[:3, :3].T
    ok = d_dir[:, 1] < -1e-3
    if ok.sum() < 3:
        return None
    z_floor = -c2w[1, 3] / d_dir[ok, 1]
    return {"height": float(np.median(pts[:, 1])), "ratio": float(np.median(z_floor / z[ys, xs][ok])),
            "x": float(np.median(pts[:, 0])), "z": float(np.median(pts[:, 2]))}


def fit_colour(frames_lin: list[np.ndarray], renders_lin: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """One 3x4 linear-light colour transform (clip -> room) from background samples [N, 3] of every frame, trimmed
    least squares."""
    X = np.concatenate(frames_lin)
    Y = np.concatenate(renders_lin)
    A = np.concatenate([X, np.ones((len(X), 1), np.float32)], axis=1).astype(np.float64)
    sel = np.ones(len(X), bool)
    for _ in range(4):
        sol, *_ = np.linalg.lstsq(A[sel], Y[sel], rcond=None)
        r = np.abs(A @ sol - Y).sum(axis=1)
        sel = r <= np.quantile(r, 0.8)
    return sol[:3].T.astype(np.float32), sol[3].astype(np.float32)


def psnr8(a: np.ndarray, b: np.ndarray, m: np.ndarray) -> float:
    d = (a.astype(np.float32) - b.astype(np.float32))[m]
    return float(10 * np.log10(255.0 ** 2 / max(float(np.mean(d * d)), 1e-6)))


def write_code_rows(depth_band: np.ndarray, mask_band: np.ndarray, index: int) -> None:
    """The frame number into the last rows of the depth band; the mask is zero there."""
    fc = FRAME_CODE
    h, w = depth_band.shape
    vals = frame_code_values(index)
    edges = np.round(np.arange(fc["blocks"] + 1) * w / fc["blocks"]).astype(int)
    for i in range(fc["blocks"]):
        depth_band[h - fc["rows"] :, edges[i] : edges[i + 1]] = vals[i]
    mask_band[h - fc["rows"] :, :] = 0


def cmd_pack(a) -> None:
    import cv2

    from plate_room import snap_depth_edges
    from tw import depthstab, mask as maskmod
    from tw.pack import PackWriter, encode_inverse, pack_frame

    work = Path(a.work)
    meta = read_json(work / "frames.json")
    reg = read_json(work / "register.json")
    if not meta or not reg:
        raise SystemExit("frames.json and register.json are needed (people.py frames, then register)")
    frames = meta["frames"]
    n = len(reg["frames"])
    frames = frames[:n]
    pk = work / "pack"
    pk.mkdir(parents=True, exist_ok=True)
    ev = Path(a.evidence) if a.evidence else None
    if ev:
        ev.mkdir(parents=True, exist_ok=True)
    stats: dict = {"frames": n}
    t_all = time.time()
    fps = Fraction(*meta["fps"])
    W, H = int(meta["width"]), int(meta["height"])
    div = int(meta["analysisDiv"])
    w2, h2 = W // div, H // div
    Kf = meta["intrinsics"]
    Kb = {k: v / div for k, v in Kf.items()}
    rays = camera_rays(Kb, w2, h2)

    # ---- poses ----------------------------------------------------------------------------------------------
    c2ws, st = smooth_poses(frames, reg["frames"], a.pose_sigma)
    stats["poses"] = {**st, "register": reg["summary"]}
    say(f"poses: {st['outliersReplaced']} corrections replaced, jerk (mm/frame^2) track {st['positionJerkMm']['track']}, "
        f"refined {st['positionJerkMm']['refined']}, final {st['positionJerkMm']['final']}")

    def load(k: int) -> dict:
        d = np.load(work / "gpu" / f"f{k:04d}.npz")
        bgr = cv2.imread(str(work / "small" / f"f{k:04d}.jpg"), cv2.IMREAD_COLOR)
        return {"prob": d["prob"].astype(np.float32) / 255.0, "mono": d["mono"].astype(np.float32), "rz": d["depth"].astype(np.float32),
                "alpha": d["alpha"].astype(np.float32) / 255.0, "render": d["rgb"], "frame": cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)}

    # ---- pass 1: depth scale, people, feet ---------------------------------------------------------------------
    t0 = time.time()
    A = np.ones(n)
    B = np.zeros(n)
    valid = np.zeros(n, bool)
    rms = np.full(n, np.nan)
    rng = np.random.default_rng(1)
    soft_mm = np.lib.format.open_memmap(pk / "soft.npy", mode="w+", dtype=np.uint8, shape=(n, h2, w2))
    col_f, col_r, col_m = [], [], []
    for k in range(n):
        d = load(k)
        ignore = ignore_people(d["prob"])
        x = 1.0 / np.maximum(d["mono"], 1e-3)
        rz, _ = room_depth(d["rz"], rays, c2ws[k])
        y = np.where(rz > 0, 1.0 / np.maximum(rz, 1e-3), 0.0).astype(np.float32)
        edges = cv2.dilate(depthstab.depth_edges(y).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        ok = (~ignore) & (~edges) & (d["alpha"] > 0.97) & (rz > 0.3) & (rz < 8.0)
        idx = np.flatnonzero(ok)
        if idx.size > 20000:
            idx = rng.choice(idx, 20000, replace=False)
        if idx.size >= 400:
            try:
                A[k], B[k], rms[k] = depthstab.fit_inverse_affine(x.ravel()[idx], y.ravel()[idx])
                valid[k] = True
            except ValueError:
                pass
        # people: segmentation snapped to the picture's edges
        guide = d["frame"].astype(np.float32) / 255.0
        q = np.clip(guided_filter_rgb(guide, d["prob"], 6, 2e-3), 0, 1)
        soft_mm[k] = np.clip(q * 255 + 0.5, 0, 255).astype(np.uint8)
        # colour samples (every 4th frame): background the render covers well, away from edges, not clipped
        if k % 4 == 0:
            fl = np.power(d["frame"].astype(np.float32) / 255.0, 2.4)  # the SDR gamma of the analysis frames
            rl = srgb_to_linear(d["render"].astype(np.float32) / 255.0)
            gx = cv2.Sobel(cv2.cvtColor(d["render"], cv2.COLOR_RGB2GRAY).astype(np.float32), cv2.CV_32F, 1, 1, ksize=3)
            cm = ok & (d["alpha"] > 0.99) & (np.abs(gx) < 20) & (fl.max(-1) < 0.85) & (rl.max(-1) < 0.85) & (fl.min(-1) > 0.002)
            sel = np.flatnonzero(cm)
            if sel.size > 4000:
                sel = rng.choice(sel, 4000, replace=False)
            col_f.append(fl.reshape(-1, 3)[sel])
            col_r.append(rl.reshape(-1, 3)[sel])
            col_m.append(k)
        if k % 60 == 0:
            say(f"  pass 1: frame {k}/{n} ({time.time() - t0:.0f}s)")
    if not valid.any():
        raise SystemExit("no frame had enough room around the people to scale its depth")
    A_s = depthstab.smooth_series(A, valid)
    B_s = depthstab.smooth_series(B, valid)
    stats["depthAlign"] = {"fitted": int(valid.sum()), "a": [round(float(np.median(A_s)), 4), round(float(A_s.min()), 4), round(float(A_s.max()), 4)],
                           "b": [round(float(np.median(B_s)), 5), round(float(B_s.min()), 5), round(float(B_s.max()), 5)],
                           "residualRel": round(float(np.nanmedian(rms)), 4)}
    say(f"depth: {valid.sum()}/{n} frames scaled to the room, 1/z = a/z_mono + b with a median {np.median(A_s):.3f} "
        f"({A_s.min():.3f}-{A_s.max():.3f}), b {np.median(B_s):+.4f}; residual {np.nanmedian(rms):.1%} of 1/z")

    # colour: one 3x4 transform clip -> room for the whole clip, then a smoothed per-frame gain
    M, off = fit_colour(col_f, col_r)
    stats["colour"] = {"matrix": np.round(M, 4).tolist(), "offset": np.round(off, 5).tolist()}
    say(f"colour: clip -> room matrix {np.round(M, 3).tolist()}, offset {np.round(off, 4).tolist()}")

    # people: the segmentation's components, followed through the clip by their overlap with the frame before
    min_area = int(0.002 * h2 * w2)
    lab_mm = np.lib.format.open_memmap(pk / "people.npy", mode="w+", dtype=np.uint8, shape=(n, h2, w2))
    inv_mm = np.lib.format.open_memmap(pk / "inv.npy", mode="w+", dtype=np.float32, shape=(n, h2, w2))
    seen: list[list[dict]] = []
    n_tracks = 0
    prev_lab, prev_recs = None, []
    for k in range(n):
        d = load(k)
        soft = soft_mm[k].astype(np.float32) / 255.0
        z = 1.0 / np.maximum(A_s[k] / np.maximum(d["mono"], 1e-3) + B_s[k], 1e-3)
        rz, floor = room_depth(d["rz"], rays, c2ws[k])
        room_inv = np.where((rz > 0) & (d["alpha"] > 0.9), 1.0 / np.maximum(rz, 1e-3), 0.0)
        binary = fill_person_holes(people_mask(soft, 1.0 / z, int(0.001 * h2 * w2), room_inv), 1.0 / z, int(0.01 * h2 * w2))
        inv_mm[k] = 1.0 / z
        cam = c2ws[k][:3, 3]
        lab = np.zeros((h2, w2), np.uint8)
        recs, taken = [], set()
        blobs = []
        for c in components(binary, min_area):
            # a blob over two people of the frame before is two people that now overlap in the picture
            over = {p["track"] for p in prev_recs if p["area"] >= 0.01 * h2 * w2
                    and np.count_nonzero(c & (prev_lab == p["label"])) > 0.3 * p["area"]}
            blobs += split_by_depth(c, 1.0 / z, min_area, merged=len(over) >= 2)
        for i, c in enumerate(sorted(blobs, key=lambda c: -int(c.sum()))[:250]):
            lab[c] = i + 1
            pts = to_room(rays[c], z[c], c2ws[k])
            ys, xs = np.nonzero(c)
            rec = {"label": i + 1, "area": int(c.sum()), "C": [float(cam[0]), float(cam[2])],
                   "D": [float(np.median(pts[:, 0]) - cam[0]), float(np.median(pts[:, 2]) - cam[2])],
                   "z": float(np.median(z[c])), "centre": [float(xs.mean()), float(ys.mean())], "split": len(blobs),
                   "contact": foot_contact(c, z, floor, rays, c2ws[k])}
            best, biou = None, 0.2
            for p in prev_recs:
                if p["track"] in taken:
                    continue
                pm = prev_lab == p["label"]
                inter = np.count_nonzero(pm & c)
                if inter:
                    iou = inter / np.count_nonzero(pm | c)
                    if iou > biou:
                        best, biou = p, iou
            rec["track"] = best["track"] if best else n_tracks
            n_tracks += best is None
            taken.add(rec["track"])
            recs.append(rec)
        lab_mm[k] = lab
        seen.append(recs)
        prev_lab, prev_recs = lab, recs
        if k % 60 == 0:
            say(f"  people: frame {k}/{n}, {len(recs)} found")
    if not any(seen):
        raise SystemExit("nobody found in the clip")
    write_json(pk / "people.json", {"frames": seen}, indent=None)

    # one depth scale per person per frame (feet on the floor, a place in the room that moves smoothly)
    tracks: dict[int, list[tuple[int, dict]]] = {}
    for k, recs in enumerate(seen):
        for r in recs:
            tracks.setdefault(r["track"], []).append((k, r))
    big = {t for t, items in tracks.items() if len(items) >= 8 and np.median([r["area"] for _, r in items]) >= 0.01 * h2 * w2}
    heights = [r["contact"]["height"] for recs in seen for r in recs if r["contact"] and r["track"] in big]
    stats["feetBefore"] = summarise_cm(heights)
    say(f"feet before the per-person scale (cm): {stats['feetBefore']}")
    where: dict[int, np.ndarray] = {}
    for t in big:
        items = tracks[t]
        s = solve_person_scale(items) if a.contact else np.ones(len(items))
        for (k, r), sk in zip(items, s):
            r["scale"] = float(sk)
        where[t] = np.array([[r["C"][0] + r["scale"] * r["D"][0], r["C"][1] + r["scale"] * r["D"][1]] for _, r in items])
    write_json(pk / "people.json", {"frames": seen}, indent=None)
    # the play area: the centre of the people, weighted by how long and how large they are in the picture
    P = np.array([p for t in big for p in where[t]])
    wts = np.array([r["area"] for t in big for _, r in tracks[t]], np.float64)
    cx, cz = np.average(P, axis=0, weights=wts)
    for _ in range(5):  # a passer-by far away does not pull it
        near_ = np.hypot(P[:, 0] - cx, P[:, 1] - cz) < max(a.play_radius, 1.5)
        if not near_.any():
            break
        cx, cz = np.average(P[near_], axis=0, weights=wts[near_])
    keep_tracks = {t for t in big if np.hypot(*(np.median(where[t], axis=0) - [cx, cz])) <= a.play_radius}
    stats["playArea"] = {"centre": [round(float(cx), 3), round(float(cz), 3)], "radius": a.play_radius}
    stats["playArea"]["kept"] = sorted(int(t) for t in keep_tracks)
    stats["people"] = []
    for t in sorted(big, key=lambda t: -len(tracks[t])):
        items = tracks[t]
        s = np.array([r["scale"] for _, r in items])
        stats["people"].append({
            "track": t, "kept": t in keep_tracks, "frames": [items[0][0], items[-1][0]], "count": len(items),
            "feetVisible": sum(1 for _, r in items if r["contact"]),
            "scale": [round(float(s.min()), 3), round(float(np.median(s)), 3), round(float(s.max()), 3)],
            "roomXZ": np.round(np.median(where[t], axis=0), 3).tolist(), "roomXZStdCm": np.round(where[t].std(axis=0) * 100, 1).tolist(),
        })
    say(f"people mostly at x {cx:+.2f}, z {cz:+.2f} m; {len(keep_tracks)} of {len(big)} tracks kept: "
        + "; ".join(f"#{p['track']} {p['count']} frames, scale {p['scale']}, at {p['roomXZ']} +- {p['roomXZStdCm']} cm"
                    + ("" if p["kept"] else " (dropped)") for p in stats["people"]))

    # per-frame colour gain, smoothed
    gains = np.ones((n, 3))
    gok = np.zeros(n, bool)
    for fl, rl, k in zip(col_f, col_r, col_m):
        pred = fl @ M.T + off
        good = (pred > 0.01).all(axis=1)
        if good.sum() > 200:
            gains[k] = np.median(rl[good] / pred[good], axis=0)
            gok[k] = True
    gains = np.stack([depthstab.smooth_series(gains[:, c], gok, median_win=5, mean_win=5) for c in range(3)], axis=1)
    stats["colour"]["gain"] = [round(float(gains[:, c].min()), 4) for c in range(3)] + [round(float(gains[:, c].max()), 4) for c in range(3)]

    # pass 1c: masks of the kept people, their depth, the room's own depth around them
    alpha_mm = np.lib.format.open_memmap(pk / "alpha.npy", mode="w+", dtype=np.uint8, shape=(n, h2, w2))
    near_far_samples, after, clamped, dropped, room_px, occl_px = [], [], 0, 0, 0, 0
    for k in range(n):
        d = load(k)
        lab = np.asarray(lab_mm[k])
        inv = np.array(inv_mm[k])
        rz, floor = room_depth(d["rz"], rays, c2ws[k])
        y = np.where(rz > 0, 1.0 / np.maximum(rz, 1e-3), 0.0).astype(np.float32)
        recs = seen[k]
        main = [r for r in recs if r["track"] in keep_tracks]
        keep = np.zeros((h2, w2), bool)
        gone = np.zeros((h2, w2), bool)
        room_inv = np.where((rz > 0) & (d["alpha"] > 0.9), y, 0.0)
        for r in recs:
            c = lab == r["label"]
            if r["track"] in keep_tracks:
                s = r["scale"]
            elif r["track"] not in big and main:
                # a piece (a hand split off by a rod): with the nearest kept person, at their scale
                near_r = min(main, key=lambda m: math.hypot(m["centre"][0] - r["centre"][0], m["centre"][1] - r["centre"][1]))
                # (a piece far behind the person is someone or something else)
                if math.hypot(near_r["centre"][0] - r["centre"][0], near_r["centre"][1] - r["centre"][1]) > 0.25 * w2 or r["z"] > near_r["z"] * 1.3:
                    dropped += r["area"]
                    gone |= c
                    continue
                s = near_r["scale"]
            else:
                dropped += r["area"]
                gone |= c
                continue
            keep |= c
            reg_ = cv2.dilate(c.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            inv = np.where(reg_, inv / s, inv)
            # thin parts (a backpack strap) where the depth network saw the wall: no farther than the person
            core = cv2.erode(c.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
            if core.sum() > 50:
                lo = float(np.percentile(inv[core], 2)) / 1.15
                clamp = reg_ & (inv < lo)
                inv = np.where(clamp, lo, inv)
                clamped += int(clamp.sum())
            if r["contact"] and r["track"] in keep_tracks:
                fc = foot_contact(c, 1.0 / np.maximum(inv, 1e-3), floor, rays, c2ws[k])
                if fc:
                    after.append(fc["height"])
            # feet: floor splats just in front of a shoe have their centres nearer than it and are drawn over it (a
            # grey wash over the shoes). The lowest 25 cm of a person come up to FOOT_PULL metres toward the camera
            # (tapering in by 5 cm above the floor), which keeps them behind the shoe; from the side that is ~2 cm.
            low = reg_
            if low.any():
                zc = 1.0 / np.maximum(inv[low], 1e-3)
                t = np.clip((0.25 - to_room(rays[low], zc, c2ws[k])[:, 1]) / 0.2, 0.0, 1.0)
                inv[low] = 1.0 / np.maximum(zc - FOOT_PULL * t * t * (3 - 2 * t), 0.1)
        # the room itself caught in the people (the table's corner in front of a leg): where the camera saw what the
        # room render shows, in depth (8%) and in colour (after the colour match), where the segmentation is unsure
        # (anywhere under 0.5; in the outer 12 px under 0.95, with a tighter colour match). Drawn, it would double
        # the splat table and tear when seen from aside.
        ring = keep & ~(cv2.erode(keep.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))) > 0)
        if keep.any():
            look = np.power(d["frame"].astype(np.float32) / 255.0, 2.4) @ M.T + off
            look = linear_to_srgb(look * gains[k])
            diff = np.abs(cv2.blur(look, (5, 5)) - cv2.blur(d["render"].astype(np.float32) / 255.0, (5, 5))).max(axis=-1)
            same_depth = (room_inv > 0) & (np.abs(inv / np.maximum(room_inv, 1e-6) - 1.0) < 0.08)
            room_like = same_depth & ((ring & (diff < 0.06) & (d["prob"] < 0.95)) | (keep & (diff < 0.1) & (d["prob"] < 0.5)))
            room_like = cv2.morphologyEx(room_like.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
            keep &= ~room_like
            gone |= room_like
            room_px += int(room_like.sum())
        # light cleanup only (holes were decided above by depth): specks off, one-pixel notches closed
        before = keep
        keep = cv2.morphologyEx(keep.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))) > 0
        keep = maskmod.remove_small_components(keep, None, max(4, int(0.0005 * h2 * w2))) & ~gone & cv2.dilate(before.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        keep[h2 - FRAME_CODE["rows"] :, :] = False
        al = maskmod.feather(keep)
        alpha_mm[k] = al
        out = y.copy()
        fg = al > 0
        if fg.any():
            bb = np.nonzero(fg)
            r0, r1 = max(0, bb[0].min() - 8), min(h2, bb[0].max() + 9)
            c0, c1 = max(0, bb[1].min() - 8), min(w2, bb[1].max() + 9)
            sl = (slice(r0, r1), slice(c0, c1))
            # where something of the room is in front of a person (the table in front of a leg) the network's depth
            # ramps from the person onto it: those outline pixels take the person's own depth from inside instead,
            # and the outline snap below (which pulls the outline onto the nearest surface) cannot reach the table
            m_c = al[sl] > 0
            inside = cv2.erode(m_c.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
            den = cv2.GaussianBlur(inside.astype(np.float32), (0, 0), 4)
            ref = cv2.GaussianBlur(np.where(inside, inv[sl], 0).astype(np.float32), (0, 0), 4) / np.maximum(den, 1e-6)
            occluder = ~m_c & (room_inv[sl] > ref * 1.1) & (den > 0.01)
            occl_ring = (cv2.dilate(occluder.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0) & m_c & ~inside & (den > 0.01)
            inv_fg = np.where(occl_ring, ref, inv[sl])
            # the room in front of a person inside their outline (foosball rods across a leg): the segmentation is
            # unsure there, the room render has something about as near, and it stands out from the person around
            # it by a step. It takes the person's depth (the splat rods stay in front), so no torn step is left.
            cand = m_c & (d["prob"][sl] < 0.5) & (room_inv[sl] > 0) & (room_inv[sl] >= 0.85 * inv_fg)
            if cand.any():
                base = m_c & ~cand
                den2 = cv2.GaussianBlur(base.astype(np.float32), (0, 0), 4)
                ref2 = cv2.GaussianBlur(np.where(base, inv_fg, 0).astype(np.float32), (0, 0), 4) / np.maximum(den2, 1e-6)
                occl_in = cand & (inv_fg > 1.15 * ref2) & (den2 > 0.05)
                inv_fg = np.where(occl_in, ref2, inv_fg)
                occl_px += int(occl_in.sum())
            inv_fg = snap_depth_edges(inv_fg)
            inv_fg = depthstab.snap_boundary(inv_fg, al[sl])
            # never behind the room surface it covers (except at an occluder's edge, where the render's blur lies)
            inv_fg = np.where(occl_ring, inv_fg, np.maximum(inv_fg, y[sl] * 1.01))
            occl_px += int(occl_ring.sum())
            out[sl] = np.where(al[sl] > 0, inv_fg, y[sl])
            vals = inv_fg[al[sl] > 0]
            near_far_samples.append(vals[rng.choice(vals.size, min(vals.size, 2000), replace=False)])
            # around the people the band carries their own depth, blurred outwards (the viewer never draws it):
            # no step at the outline for the encoder to ring on
            m = fg.astype(np.float32)
            den = cv2.GaussianBlur(m, (0, 0), 6)
            ext = cv2.GaussianBlur(out * m, (0, 0), 6) / np.maximum(den, 1e-6)
            out = np.where((den > 0.002) & ~fg, ext, out)
        inv_mm[k] = out
        if k % 60 == 0:
            say(f"  masks and depth: frame {k}/{n}")
    stats["feetAfter"] = summarise_cm(after)
    stats["farOutliersClamped"] = clamped
    stats["droppedPixels"] = dropped
    stats["roomPixelsCut"] = room_px
    stats["occluderEdgePixels"] = occl_px
    say(f"feet after (cm): {stats['feetAfter']}")
    near, far = depthstab.choose_near_far(np.concatenate(near_far_samples) if near_far_samples else np.array([0.5]))
    stats["depthRange"] = {"near": near, "far": far}
    say(f"depth range of the people: near {near} m, far {far} m (pass 1 {time.time() - t0:.0f}s)")

    # ---- pass 2: encode ----------------------------------------------------------------------------------------
    t0 = time.time()
    clip = Path(a.clip)
    out_dir = Path(a.scene_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cam = Camera("SIMPLE_RADIAL", W, H, np.array([Kf["fx"], Kf["cx"], Kf["cy"], meta["distortion"].get("k1", 0.0)], np.float64))
    mx, my = cam.undistort_maps()
    by_src: dict[int, list[int]] = {}
    for f in frames:
        by_src.setdefault(int(f["source"]), []).append(int(f["index"]))
    duration = n / float(fps)
    psnr_before, psnr_after = [], []
    thumb_k = int(np.argmax([sum(r["area"] for r in recs if r["track"] in keep_tracks) * (0.3 < k / n < 0.7) for k, recs in enumerate(seen)]))
    thumb = None
    packed = None
    previews = []
    audio = aac_audio(clip, pk / "audio.m4a")
    stats["hasAudio"] = audio is not None
    with PackWriter(out_dir / "people.mp4", W, H, fps, audio_src=audio, duration=duration, crf=a.crf, preset=a.preset) as writer:
        pending: dict[int, np.ndarray] = {}
        nxt = 0
        for j, lin in decode_linear(clip, (W, H), set(by_src), float(meta["exposureGain"])):
            lin = cv2.remap(lin, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            for k in by_src[j]:
                if k >= n:
                    continue
                rgb_lin = (lin @ M.T + off) * gains[k]
                pending[k] = np.clip(linear_to_srgb(rgb_lin) * 255.0 + 0.5, 0, 255).astype(np.uint8)
            while nxt in pending:
                k = nxt
                rgb = pending.pop(k)
                band_d = encode_inverse(inv_mm[k], near, far)
                band_m = np.array(alpha_mm[k])
                write_code_rows(band_d, band_m, k)
                packed = pack_frame(rgb, band_d, band_m, out=packed)
                writer.write(packed)
                if k % 8 == 0:
                    d = load(k)
                    small = cv2.resize(rgb, (w2, h2), interpolation=cv2.INTER_AREA)
                    m = ~ignore_people(d["prob"]) & (d["alpha"] > 0.98)
                    psnr_before.append(psnr8(d["frame"], d["render"], m))
                    psnr_after.append(psnr8(small, d["render"], m))
                if k == thumb_k:
                    thumb = rgb.copy()
                if k in (0, n // 4, n // 2, 3 * n // 4, n - 1):
                    previews.append((k, rgb.copy()))
                nxt += 1
        frames_written = writer.frames
    if frames_written != n:
        raise SystemExit(f"encoded {frames_written} of {n} frames")
    stats["colour"]["psnrToRoom"] = {"before": round(float(np.mean(psnr_before)), 3), "after": round(float(np.mean(psnr_after)), 3)}
    stats["encode"] = {"seconds": round(time.time() - t0, 1), "bytes": (out_dir / "people.mp4").stat().st_size}
    say(f"encoded {n} frames ({stats['encode']['bytes'] / 1e6:.1f} MB) in {time.time() - t0:.0f}s; colour vs the room "
        f"{stats['colour']['psnrToRoom']['before']} -> {stats['colour']['psnrToRoom']['after']} dB")

    # ---- decode check: frame codes and bands as the viewer will see them -------------------------------------
    stats["decodeCheck"] = check_packed(out_dir / "people.mp4", W, H, n, near, far, inv_mm, alpha_mm)
    say(f"decode check: {stats['decodeCheck']}")

    # ---- camera track, scene ---------------------------------------------------------------------------------
    write_track(out_dir / "camera-track.json", meta, frames, c2ws, fps, n, Kf, W, H)
    write_scene(a, out_dir, meta, c2ws[0], fps, n, Kf, W, H, near, far, thumb, previews, stats)
    stats["seconds"] = round(time.time() - t_all, 1)
    write_json(pk / "stats.json", stats)
    if ev:
        write_json(ev / "pack-stats.json", stats)
        for k, rgb in previews:
            save_preview(ev / f"band-f{k:04d}.jpg", rgb, alpha_mm[k], inv_mm[k], near, far)
    say(f"pack done in {stats['seconds']}s")


def check_packed(path: Path, W: int, H: int, n: int, near: float, far: float, inv_mm, alpha_mm) -> dict:
    """Decode the packed file like a browser would and read every frame's code and bands back."""
    import subprocess

    from tw.pack import decode_inverse_depth, packed_size, unpack_frame

    pw, ph = packed_size(W, H)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    codes, derr, merr = [], [], []
    k = 0
    while True:
        buf = proc.stdout.read(pw * ph * 3)
        if not buf or len(buf) < pw * ph * 3:
            break
        fr = np.frombuffer(buf, np.uint8).reshape(ph, pw, 3)
        _, dband, mband = unpack_frame(fr, W, H)
        codes.append(read_frame_code(dband[-FRAME_CODE["rows"] // 2]))
        if k < n and k % 10 == 0:
            m = alpha_mm[k][: -FRAME_CODE["rows"]] > 200
            if m.any():
                z0 = 1.0 / np.clip(inv_mm[k][: -FRAME_CODE["rows"]][m], 1 / far, 1 / near)
                z1 = decode_inverse_depth(dband[: -FRAME_CODE["rows"]][m], near, far)
                derr.append(float(np.median(np.abs(z1 - z0) / z0)))
            merr.append(float(np.mean(np.abs(mband[: -FRAME_CODE["rows"]] - alpha_mm[k][: -FRAME_CODE["rows"]]) > 64)))
        k += 1
    proc.wait()
    right = sum(1 for i, c in enumerate(codes) if c == i)
    return {"framesDecoded": len(codes), "codesRight": right, "codesUnreadable": sum(c is None for c in codes),
            "depthRelErrMedian": round(float(np.median(derr)), 4) if derr else None,
            "maskPixelsOff": round(float(np.mean(merr)), 5) if merr else None}


def write_track(path: Path, meta: dict, frames: list[dict], c2ws: list[np.ndarray], fps: Fraction, n: int, Kf: dict, W: int, H: int) -> None:
    track = []
    for f, c in zip(frames, c2ws):
        track.append({"frame": int(f["index"]), "time": round(f["index"] / float(fps), 6), "sourceFrame": int(f["source"]),
                      "sourceTime": f["sourceTime"], "position": [round(float(v), 5) for v in c[:3, 3]],
                      "quaternion": [round(float(v), 7) for v in sio.matrix_to_quat_xyzw(c[:3, :3])]})
    write_json(path, {
        "version": 1,
        "clip": meta["clip"],
        "fps": round(float(fps), 6),
        "frames": n,
        "duration": round(n / float(fps), 6),
        "frame": "viewer (y up, metres, floor y = 0), the room's own frame; OpenGL camera (looks down -Z, +Y up), quaternion xyzw",
        "intrinsics": {"width": W, "height": H, "fx": round(Kf["fx"], 4), "fy": round(Kf["fy"], 4),
                       "cx": round(Kf["cx"] - 0.5, 4), "cy": round(Kf["cy"] - 0.5, 4)},
        "frameCode": {"band": "depth", **FRAME_CODE},
        "note": "track[k] is the camera of packed frame k (presented at time k / fps). The packed frame carries k in the last "
                "frameCode.rows rows of its depth band (blocks across the band: block 0 high, then the bits least significant "
                "first, an even-parity bit, the rest low; lo/hi are the grey levels). intrinsics: pixel centres at integers "
                "(the viewer's convention).",
        "track": track,
    }, indent=None)


def write_scene(a, out_dir: Path, meta: dict, c2w0: np.ndarray, fps: Fraction, n: int, Kf: dict, W: int, H: int,
                near: float, far: float, thumb: np.ndarray | None, previews: list, stats: dict) -> None:
    import shutil
    from datetime import datetime, timezone

    from common.media import save_jpg
    from tw.pack import LAYOUT

    src = read_json(Path(a.world_scene) / "scene.json")
    if not src or not src.get("world"):
        raise SystemExit(f"{a.world_scene}/scene.json has no world")
    world = json.loads(json.dumps(src["world"]))
    for key in ("file", "collider"):
        if world.get(key):
            shutil.copy2(Path(a.world_scene) / world[key], out_dir / world[key])
    if world.get("topdown", {}).get("file"):
        shutil.copy2(Path(a.world_scene) / world["topdown"]["file"], out_dir / world["topdown"]["file"])
    if thumb is not None:
        import cv2

        s = 640 / max(thumb.shape[:2])
        save_jpg(out_dir / "thumb.jpg", cv2.resize(thumb, (round(thumb.shape[1] * s), round(thumb.shape[0] * s)), interpolation=cv2.INTER_AREA), quality=88)
    prev = read_json(out_dir / "scene.json") or {}
    now = datetime.now(timezone.utc).isoformat()
    video = {
        "file": "people.mp4",
        "layout": LAYOUT,
        "width": W,
        "height": H,
        "fps": round(float(fps), 6),
        "duration": round(n / float(fps), 4),
        "hasAudio": bool(stats.get("hasAudio", True)),
        "intrinsics": {"fx": round(Kf["fx"], 4), "fy": round(Kf["fy"], 4), "cx": round(Kf["cx"] - 0.5, 4), "cy": round(Kf["cy"] - 0.5, 4)},
        "depth": {"encoding": "inverse", "near": near, "far": far},
        "cameraPose": {"position": [round(float(v), 5) for v in c2w0[:3, 3]], "quaternion": sio.matrix_to_quat_xyzw(c2w0[:3, :3])},
        "cameraTrack": "camera-track.json",
    }
    scene = {
        "id": a.id,
        "name": a.name,
        "mode": "thirdwheel",
        "status": "ready",
        "createdAt": prev.get("createdAt", now),
        "updatedAt": now,
        "backend": "hpg-batch",
        "thumb": "thumb.jpg",
        "world": world,
        "video": video,
        "caption": a.caption,
    }
    write_json(out_dir / "scene.json", scene)


def save_preview(path: Path, rgb: np.ndarray, alpha: np.ndarray, inv: np.ndarray, near: float, far: float) -> None:
    import cv2

    from common.media import save_jpg

    h2, w2 = alpha.shape
    small = cv2.resize(rgb, (w2, h2), interpolation=cv2.INTER_AREA)
    a = alpha.astype(np.float32)[..., None] / 255.0
    cut = (small * a + np.array([40, 40, 40]) * (1 - a)).astype(np.uint8)
    v = np.clip((inv - 1 / far) / (1 / near - 1 / far), 0, 1)
    depth = cv2.cvtColor(cv2.applyColorMap((v * 255).astype(np.uint8), cv2.COLORMAP_TURBO), cv2.COLOR_BGR2RGB)
    depth = (depth * a + 30 * (1 - a)).astype(np.uint8)
    save_jpg(path, np.concatenate([small, cut, depth], axis=1), quality=88)


# --------------------------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["frames", "register", "pack"])
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--clip", type=Path)
    ap.add_argument("--poses", type=Path, help="frames: <clip>-poses.json from stage 1")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--gain", type=float, default=None, help="frames: HDR exposure gain (default: the one prep.py would pick)")
    ap.add_argument("--world", type=Path, help="register: world.spz")
    ap.add_argument("--depth-model", default="metric-indoor-base")
    ap.add_argument("--limit", type=int, default=0, help="register: only the first N frames (tests)")
    ap.add_argument("--no-refine", action="store_true", help="register: keep the stage-1 track")
    ap.add_argument("--refine-every", type=int, default=1,
                    help="register: refine every n-th frame's pose only and interpolate the corrections between (long clips)")
    ap.add_argument("--world-scene", type=Path, help="pack: the reconstructed room's scene folder (world.spz, collider, map)")
    ap.add_argument("--scene-dir", type=Path, help="pack: the scene folder to write")
    ap.add_argument("--id")
    ap.add_argument("--name")
    ap.add_argument("--caption", default="")
    ap.add_argument("--evidence", type=Path, default=None, help="pack: previews and statistics go here too")
    ap.add_argument("--play-radius", type=float, default=2.2,
                    help="pack: keep people within this many metres (floor distance) of where the people mostly are")
    ap.add_argument("--pose-sigma", type=float, default=1.0, help="pack: temporal smoothing of the pose corrections (frames)")
    ap.add_argument("--contact", action=argparse.BooleanOptionalAction, default=True,
                    help="pack: rescale each person's depth so their feet meet the floor where the feet are visible")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="slow")
    a = ap.parse_args(argv)
    t0 = time.time()
    if a.cmd == "frames":
        if not (a.clip and a.poses):
            raise SystemExit("frames needs --clip and --poses")
        cmd_frames(a)
    elif a.cmd == "register":
        if not a.world:
            raise SystemExit("register needs --world")
        cmd_register(a)
    else:
        if not (a.clip and a.world_scene and a.scene_dir and a.id and a.name):
            raise SystemExit("pack needs --clip, --world-scene, --scene-dir, --id and --name")
        cmd_pack(a)
    say(f"done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
