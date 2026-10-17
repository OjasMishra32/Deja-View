"""Third Wheel: still-camera video -> out/tw.mp4 (tw-pack-v1) + out/plate.jpg + out/thumb.jpg.

Passes over the clip (frames are decoded by ffmpeg each time instead of being held in memory;
per-frame analysis lives in memory-mapped arrays under work/):
  A  sample ~70 frames: person segmentation, camera-motion check, background plate (never-seen
     pixels inpainted with Big LaMa, depth there filled from the surrounding background)
  B  every frame: person probability, change against the plate, monocular depth
  C  masks: temporal decision, cleanup, feathering
  D  depth: align each frame to the plate on background pixels, smooth over time, composite
  E  encode RGB + depth + mask with ffmpeg, with the original audio

CLI (without a job directory):
  python pipeline/tw/run.py VIDEO OUT_DIR [--max-seconds 60] [--fov 65] [--keep-work] [--plate-inpaint lama|mirror]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "tw"  # noqa: A001  allow relative imports when run as a script
    import tw  # noqa: F401

from common import env as _env  # noqa: F401,E402
from common.camera import IDENTITY_POSE, fov_deg, intrinsics_for  # noqa: E402
from common.device import adaptive_batch, empty_cache, pick_device  # noqa: E402
from common.media import count_frames, fit_size, iter_frames, output_fps, probe, save_jpg  # noqa: E402

from . import depthstab, mask as maskmod, motion  # noqa: E402
from .pack import LAYOUT, PackWriter, encode_inverse, pack_frame  # noqa: E402
from .plate import LamaFill, build_plate, fill_depth_holes  # noqa: E402

Progress = Callable[[str | None, float | None], None]


@dataclass
class TwConfig:
    max_seconds: float = 60.0
    start: float = 0.0
    max_long: int = 1280
    fps_cap: float = 30.0
    fov_deg: float | None = None
    focal_35mm: float | None = None  # from the upload's metadata when known
    plate_samples: int = 72
    frame_depth_model: str = "metric-indoor-small"
    plate_depth_model: str = "metric-indoor-base"
    depth_short: int = 392
    segmenter: str = "deeplabv3-mobilenet"
    seg_short: int = 368
    seg_stride: int = 2  # person segmentation on every n-th frame (the change mask covers fast motion)
    stabilize: str = "auto"  # auto | on | off
    plate_inpaint: str = "lama"  # lama (Big LaMa, mirrored-texture fallback) | mirror
    crf: int = 18
    preset: str = "medium"
    batch: int | None = None
    keep_work: bool = False
    device: str = field(default_factory=pick_device)

    @classmethod
    def for_device(cls, device: str | None = None, **overrides) -> "TwConfig":
        device = device or pick_device()
        cfg = cls(device=device)
        if device == "cuda":
            cfg.depth_short = 518
            cfg.segmenter = "deeplabv3-resnet50"
            cfg.seg_short = 520
            cfg.seg_stride = 1
            cfg.plate_samples = 96
        for k, v in overrides.items():
            if v is not None and hasattr(cfg, k):
                setattr(cfg, k, v)
        return cfg

    @classmethod
    def from_params(cls, params: dict, device: str | None = None) -> "TwConfig":
        """Job params (camelCase, all optional): maxSeconds, start, fovDeg, stabilize, crf,
        preset, depthModel, plateDepthModel, depthShort, segmenter, plateSamples, keepWork, batch,
        segStride, plateInpaint."""
        p = params or {}
        m = {
            "max_seconds": ("maxSeconds", float),
            "start": ("start", float),
            "fov_deg": ("fovDeg", float),
            "focal_35mm": ("focal35", float),
            "stabilize": ("stabilize", str),
            "crf": ("crf", int),
            "preset": ("preset", str),
            "frame_depth_model": ("depthModel", str),
            "plate_depth_model": ("plateDepthModel", str),
            "depth_short": ("depthShort", int),
            "segmenter": ("segmenter", str),
            "plate_samples": ("plateSamples", int),
            "keep_work": ("keepWork", bool),
            "batch": ("batch", int),
            "seg_stride": ("segStride", int),
            "plate_inpaint": ("plateInpaint", str),
        }
        over = {}
        for attr, (key, typ) in m.items():
            if key in p and p[key] is not None and p[key] != "":
                over[attr] = typ(p[key])
        return cls.for_device(device, **over)


def _models(cfg: TwConfig):
    """(depth estimator, person segmenter). TW_FAKE_MODELS=1 swaps in cheap stand-ins for tests."""
    if os.environ.get("TW_FAKE_MODELS") == "1":
        return _FakeDepth(), _FakeSeg()
    from common.models import DepthEstimator, PersonSegmenter

    return (
        DepthEstimator(cfg.frame_depth_model, device=cfg.device, short_side=cfg.depth_short),
        PersonSegmenter(cfg.segmenter, device=cfg.device, short_side=cfg.seg_short),
    )


def _plate_inpainter(cfg: TwConfig) -> LamaFill | None:
    """Big LaMa for the never-seen part of the plate (loaded on first use), or None for the
    mirrored-texture fill: plateInpaint=mirror, TW_PLATE_INPAINT=mirror or TW_FAKE_MODELS=1."""
    choice = (os.environ.get("TW_PLATE_INPAINT") or cfg.plate_inpaint or "lama").strip().lower()
    if choice != "lama" or os.environ.get("TW_FAKE_MODELS") == "1":
        return None
    return LamaFill(device=cfg.device)


def _plate_depth_model(cfg: TwConfig):
    if os.environ.get("TW_FAKE_MODELS") == "1":
        return _FakeDepth()
    from common.models import DepthEstimator

    return DepthEstimator(cfg.plate_depth_model, device=cfg.device, short_side=518)


class _FakeDepth:
    """Depth from image position and brightness (tests only)."""

    metric = True

    def __call__(self, frames, out_hw=None):
        import cv2

        frames = np.asarray(frames)
        outs = []
        for f in frames:
            h, w = out_hw or f.shape[:2]
            g = cv2.resize(cv2.cvtColor(f, cv2.COLOR_RGB2GRAY), (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
            rows = np.linspace(3.5, 1.5, h, dtype=np.float32)[:, None]
            outs.append(rows - 0.8 * (g - 0.5) * (g > 0.6))
        return np.stack(outs).astype(np.float32)


class _FakeSeg:
    def __call__(self, frames, out_hw=None):
        frames = np.asarray(frames)
        h, w = out_hw or frames.shape[1:3]
        return np.zeros((len(frames), h, w), np.float32)


def _batched(model, items: list[np.ndarray], bsz: int, out_hw: tuple[int, int]) -> np.ndarray:
    """Run a model over items in batches of exactly bsz (the last batch is padded by repeating
    its final item) so MPS/CUDA see one input shape and compile their kernels once."""
    outs = []
    for j in range(0, len(items), bsz):
        chunk = list(items[j : j + bsz])
        n = len(chunk)
        if n < bsz:
            chunk += [chunk[-1]] * (bsz - n)
        outs.append(model(np.stack(chunk), out_hw)[:n])
    return np.concatenate(outs) if outs else np.zeros((0,) + out_hw, np.float32)


def _bbox(mask: np.ndarray, pad: int) -> tuple[slice, slice] | None:
    rows = np.flatnonzero(mask.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(mask.any(axis=0))
    h, w = mask.shape
    return (slice(max(0, rows[0] - pad), min(h, rows[-1] + pad + 1)), slice(max(0, cols[0] - pad), min(w, cols[-1] + pad + 1)))


def _default_batch(device: str) -> int:
    if device == "cuda":
        return adaptive_batch("cuda", 600 << 20, 2, 16)
    return 4 if device == "mps" else 2


def _resize(img: np.ndarray, size: tuple[int, int], interp=None) -> np.ndarray:
    import cv2

    if img.shape[1] == size[0] and img.shape[0] == size[1]:
        return img
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA if interp is None else interp)


def process_video(
    video_path: Path | str,
    out_dir: Path | str,
    work_dir: Path | str,
    cfg: TwConfig | None = None,
    progress: Progress | None = None,
    log: Callable[[str], None] = print,
    warn: Callable[[str], None] | None = None,
    notice: Callable[..., None] | None = None,
) -> dict:
    """notice(user, detail): a warning the person should see in the scene caption (common.jobio.Job.notice);
    `detail` is the technical version for the log. Without it, notices go to `warn`."""
    import cv2

    cfg = cfg or TwConfig.for_device()
    focal_35mm = cfg.focal_35mm
    progress = progress or (lambda s, f: None)
    warn = warn or (lambda m: log(f"WARNING: {m}"))
    if notice is None:
        notice = lambda user, detail=None: warn(detail or user)  # noqa: E731
    out_dir, work_dir = Path(out_dir), Path(work_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    timings: dict[str, float] = {}
    t_all = time.time()

    # ---- probe ------------------------------------------------------------------------------
    progress("Reading the video", 0.0)
    info = probe(video_path)
    start = min(max(cfg.start, 0.0), max(0.0, info.duration - 0.5))
    dur = max(0.1, min(info.duration - start, cfg.max_seconds))
    if info.duration - start > cfg.max_seconds + 0.05:
        notice(
            f"Only {dur:.0f} seconds of the clip were used{f' (from {start:.0f} s)' if start >= 0.5 else ''}.",
            f"clip is {info.duration:.1f}s; using {dur:.1f}s from {start:.1f}s (maxSeconds={cfg.max_seconds:g})",
        )
    fps = output_fps(info.fps_fraction, cfg.fps_cap)
    W, H = fit_size(info.width, info.height, cfg.max_long, 16)
    w2, h2 = W // 2, H // 2
    focal_35mm = focal_35mm or info.focal_35mm
    K = intrinsics_for(W, H, info.width, info.height, long_fov_deg=cfg.fov_deg, focal_35mm=focal_35mm)
    hf, vf = fov_deg(K, W, H)
    n_est = count_frames(video_path, fps, dur)
    log(
        f"video: {info.width}x{info.height} {info.fps:.3f} fps {info.duration:.2f}s codec={info.codec} hdr={getattr(info, 'hdr', None) or 'no'} "
        f"audio={'yes (' + str(info.audio_codec) + ')' if info.has_audio else 'no'} rotation={info.rotation}"
    )
    log(f"output: {W}x{H} (+ {w2}x{h2} depth/mask band) at {float(fps):.3f} fps, ~{n_est} frames; "
        f"intrinsics fx={K['fx']:.1f} fy={K['fy']:.1f} (fov {hf:.1f} x {vf:.1f} deg"
        f"{', from ' + str(focal_35mm) + ' mm equivalent' if focal_35mm and cfg.fov_deg is None else ', default' if cfg.fov_deg is None else ', given'}); device={cfg.device}")

    def frames():
        return iter_frames(video_path, (W, H), fps=fps, start=start, duration=dur)

    # ---- pass A: samples, plate --------------------------------------------------------------
    t0 = time.time()
    progress("Sampling frames", 0.01)
    step = max(1, n_est // max(cfg.plate_samples, 1))
    samples, sample_idx = [], []
    N = 0
    for i, fr in enumerate(frames()):
        if i % step == 0 and len(samples) < int(cfg.plate_samples * 1.25):
            samples.append(np.array(fr))
            sample_idx.append(i)
        N += 1
        if i % 30 == 0:
            progress(None, 0.01 + 0.05 * min(1.0, i / max(n_est, 1)))
    if N < 2:
        from common.jobio import JobError

        raise JobError("This video is too short. Use a clip of at least two seconds.", f"the video has {N} frame(s)")
    samples_arr = np.stack(samples)
    timings["decodeSamples"] = time.time() - t0
    log(f"decoded {N} frames, kept {len(samples)} samples for the plate ({timings['decodeSamples']:.1f}s)")

    t0 = time.time()
    progress("Finding people", 0.06)
    depth_est, seg = _models(cfg)
    bsz = cfg.batch or _default_batch(cfg.device)
    timings["loadModels"] = time.time() - t0
    # Person probability of each sample at band resolution; build_plate and the tracker rescale it.
    person_samples = _batched(seg, [_resize(s, (w2, h2)) for s in samples_arr], bsz, (h2, w2))
    timings["samplePeople"] = time.time() - t0
    log(f"people in {len(samples_arr)} samples: {timings['samplePeople']:.1f}s (model load {timings['loadModels']:.1f}s)")

    t0 = time.time()
    progress("Checking camera motion", 0.10)
    ref = len(samples_arr) // 2
    tracker = motion.MotionTracker(samples_arr[ref], exclude=cv2.dilate((person_samples[ref] > 0.3).astype(np.uint8), np.ones((13, 13), np.uint8)) > 0)
    ests = [tracker.estimate(s) for s in samples_arr]
    summ = motion.summarize([e.displacement for e in ests if e.ok], W)
    moved = summ["p95Frac"] > 0.006
    stabilize = cfg.stabilize == "on" or (cfg.stabilize == "auto" and moved and summ["p95Frac"] < 0.12)
    if moved:
        notice(
            "The phone moved a little during the clip; prop it still next time for the steadiest result." if stabilize
            else "The phone moved a lot during this clip, so the video may not line up with the room. Prop the phone still and film again.",
            f"the camera moved during the clip (95th percentile shift {summ['p95Px']:.1f}px = {summ['p95Frac']:.1%} of the width). "
            + ("Frames are stabilised onto one view; prop the phone still for the best result." if stabilize
               else "Too much to stabilise; the room and the video may not line up well. Prop the phone still."),
        )
    else:
        log(f"camera is steady (95th percentile shift {summ['p95Px']:.2f}px)")
    if stabilize:
        samples_arr = np.stack([motion.warp(s, e.matrix) for s, e in zip(samples_arr, ests)])
        # The same similarity transform at half resolution: linear part unchanged, translation halved.
        person_samples = np.stack([motion.warp(p, e.matrix * np.array([[1, 1, 0.5], [1, 1, 0.5]], np.float32)) for p, e in zip(person_samples, ests)])
    timings["motion"] = time.time() - t0

    t0 = time.time()
    progress("Finding the room behind everyone", 0.12)
    inpainter = _plate_inpainter(cfg)
    plate, holes, plate_stats = build_plate(samples_arr, person_samples, log=log, inpaint=inpainter)
    if inpainter is not None:
        inpainter.release()
    del samples_arr, person_samples, inpainter
    save_jpg(out_dir / "plate.jpg", plate, quality=93)
    timings["plate"] = time.time() - t0

    t0 = time.time()
    progress("Measuring the room", 0.15)
    from plate_room import estimate_plate_depth, snap_depth_edges  # pipeline/ is on sys.path

    pde = _plate_depth_model(cfg)
    plate_depth = estimate_plate_depth(pde, plate) if not isinstance(pde, _FakeDepth) else pde(plate[None])[0]
    del pde
    empty_cache(cfg.device)
    if holes.any():
        # The never-seen region is where people stood: its depth comes from the background around
        # it (the depth network guesses freely on inpainted pixels), so the room and the
        # person-in-front-of-the-room test see a continuous surface there.
        td = time.time()
        try:
            plate_depth, dinfo = fill_depth_holes(plate_depth, plate, holes)
            plate_stats["depthFill"] = {**dinfo, "seconds": round(time.time() - td, 3)}
            log(f"plate depth: filled {dinfo['region']:.2%} of the plate (never seen + margin) from the surrounding background, "
                f"{dinfo['occluderPx']} boundary px treated as in front ({time.time() - td:.2f}s)")
        except Exception as e:  # keep the network's depth of the inpainted plate
            plate_stats["depthFill"] = {"error": f"{type(e).__name__}: {e}"[:300]}
            warn(f"plate depth fill failed ({e}); keeping the estimated depth in the never-seen region")
    np.save(work_dir / "plate_depth.npy", plate_depth.astype(np.float32))
    plate_inv = _resize(1.0 / np.maximum(plate_depth, 1e-3), (w2, h2)).astype(np.float32)
    plate_small = _resize(plate, (w2, h2))
    plate_edges = depthstab.depth_edges(plate_inv)
    timings["plateDepth"] = time.time() - t0
    log(f"plate depth: median {float(np.median(plate_depth)):.2f} m, range {float(np.quantile(plate_depth, 0.01)):.2f}-{float(np.quantile(plate_depth, 0.99)):.2f} m ({timings['plateDepth']:.1f}s)")

    # ---- pass B: per-frame analysis -------------------------------------------------------------
    t0 = time.time()
    progress("Lifting every frame into 3D", 0.18)
    mm = lambda name, dtype, shape: np.lib.format.open_memmap(work_dir / f"{name}.npy", mode="w+", dtype=dtype, shape=shape)  # noqa: E731
    diff_mm = mm("diff", np.uint8, (N, h2, w2))
    person_mm = mm("person", np.uint8, (N, h2, w2))
    depth_mm = mm("depth_raw", np.float16, (N, h2, w2))
    small_mm = mm("small", np.uint8, (N, h2, w2, 3))
    seg_done = np.zeros(N, bool)
    mats = np.tile(np.array([[1, 0, 0], [0, 1, 0]], np.float32), (N, 1, 1))
    tracker2 = motion.MotionTracker(plate) if stabilize else None
    diff_thresholds: list[float] = []
    stride = max(1, cfg.seg_stride)
    t_models = 0.0

    def post(i0: int, small: np.ndarray, depth: np.ndarray, person: np.ndarray | None, seg_idx: list[int]) -> None:
        """CPU work for one batch; runs on a worker thread while the GPU takes the next batch."""
        for j in range(len(small)):
            d, thr = maskmod.diff_soft(small[j], plate_small)
            diff_thresholds.append(thr)
            diff_mm[i0 + j] = np.clip(np.rint(d * 255), 0, 255).astype(np.uint8)
            depth_mm[i0 + j] = np.clip(depth[j], 1e-3, 6e4).astype(np.float16)
            small_mm[i0 + j] = small[j]
        if person is not None:
            for k, j in enumerate(seg_idx):
                person_mm[i0 + j] = np.clip(np.rint(person[k] * 255), 0, 255).astype(np.uint8)
                seg_done[i0 + j] = True

    from concurrent.futures import ThreadPoolExecutor

    pool = ThreadPoolExecutor(max_workers=1)
    pending = None
    buf: list[np.ndarray] = []
    first = 0
    last_ok = mats[0]

    def run_batch(batch: list[np.ndarray], i0: int):
        nonlocal t_models, pending
        full = np.stack(batch)
        small = np.stack([_resize(f, (w2, h2)) for f in full])
        seg_idx = [j for j in range(len(batch)) if (i0 + j) % stride == 0 or i0 + j == N - 1]
        tm = time.time()
        depth = _batched(depth_est, list(full), bsz, (h2, w2))
        person = _batched(seg, [small[j] for j in seg_idx], max(1, -(-bsz // stride)), (h2, w2)) if seg_idx else None
        t_models += time.time() - tm
        if pending is not None:
            pending.result()
        pending = pool.submit(post, i0, small, depth, person, seg_idx)

    try:
        for i, fr in enumerate(frames()):
            if i >= N:
                break
            if tracker2 is not None:
                e = tracker2.estimate(fr)
                if e.ok:
                    last_ok = e.matrix
                mats[i] = last_ok
                fr = motion.warp(fr, mats[i])
            buf.append(np.array(fr))
            if len(buf) == bsz:
                run_batch(buf, first)
                first += len(buf)
                buf = []
                progress(None, 0.18 + 0.62 * first / N)
        if buf:
            run_batch(buf, first)
            first += len(buf)
        if pending is not None:
            pending.result()
    finally:
        pool.shutdown(wait=True)
    if first < N:
        warn(f"second decode returned {first} of {N} frames; trimming")
        N = first
    # Frames skipped by the segmentation stride take the union of their neighbours.
    for i in np.flatnonzero(~seg_done[:N]):
        prv = i - 1
        while prv >= 0 and not seg_done[prv]:
            prv -= 1
        nxt = i + 1
        while nxt < N and not seg_done[nxt]:
            nxt += 1
        nb = [person_mm[k] for k in (prv, nxt) if 0 <= k < N and seg_done[k]]
        person_mm[i] = np.maximum.reduce(nb) if nb else 0
    depth_est = seg = None  # release the models before the CPU passes
    empty_cache(cfg.device)
    timings["frames"] = time.time() - t0
    timings["framesModels"] = t_models
    log(f"analysed {N} frames in {timings['frames']:.1f}s ({timings['frames'] / N:.3f} s/frame, models {t_models / N:.3f} s/frame, "
        f"segmentation every {stride} frame(s)); change threshold median {float(np.median(diff_thresholds)):.1f}")

    # ---- pass C: masks ----------------------------------------------------------------------------
    t0 = time.time()
    progress("Cutting out the people", 0.80)
    alpha_mm = mm("alpha", np.uint8, (N, h2, w2))
    tw_ = [1.0, 2.0, 3.0, 2.0, 1.0]
    coverage = np.zeros(N, np.float32)
    soft_cache: dict[int, np.ndarray] = {}

    def soft(k: int) -> np.ndarray:
        if k not in soft_cache:
            soft_cache[k] = np.maximum(diff_mm[k], person_mm[k]).astype(np.float32) / 255.0
            soft_cache.pop(k - 5, None)
        return soft_cache[k]

    for t in range(N):
        lo, hi = max(0, t - 2), min(N, t + 3)
        win = [soft(k) for k in range(lo, hi)]
        ws = [tw_[k - t + 2] for k in range(lo, hi)]
        b = maskmod.temporal_decide(soft(t), win, ws)
        b = maskmod.cleanup(b, person_mm[t].astype(np.float32) / 255.0)
        alpha_mm[t] = maskmod.feather(b)
        coverage[t] = float(b.mean())
        if t % 60 == 0:
            progress(None, 0.80 + 0.04 * t / N)
    timings["masks"] = time.time() - t0
    log(f"masks: foreground covers {float(coverage.mean()):.1%} of the frame on average (min {float(coverage.min()):.1%}, max {float(coverage.max()):.1%})")
    if float(coverage.mean()) < 0.002 and float(coverage.max()) < 0.01:
        notice(
            "We didn't find anyone moving in this clip, so only the room is shown.",
            f"foreground covers {float(coverage.mean()):.2%} on average (max {float(coverage.max()):.2%}): nobody moving",
        )

    # ---- pass D: depth ------------------------------------------------------------------------------
    t0 = time.time()
    progress("Steadying the depth", 0.84)
    A = np.ones(N)
    B = np.zeros(N)
    valid = np.zeros(N, bool)
    rms = np.full(N, np.nan)
    rng = np.random.default_rng(1)
    for t in range(N):
        x = 1.0 / np.maximum(depth_mm[t].astype(np.float32), 1e-3)
        idx = depthstab.background_samples(alpha_mm[t], plate_inv, plate_edges, rng=rng)
        if idx.size >= 400:
            try:
                A[t], B[t], rms[t] = depthstab.fit_inverse_affine(x.ravel()[idx], plate_inv.ravel()[idx])
                valid[t] = True
            except ValueError:
                pass
    if not valid.any():
        warn("no frame had enough visible background to align its depth; using raw depth")
    A_s = depthstab.smooth_series(A, valid)
    B_s = depthstab.smooth_series(B, valid)
    log(f"depth alignment: {valid.sum()}/{N} frames fitted, scale a {np.median(A_s):.3f} (range {A_s.min():.3f}-{A_s.max():.3f}), "
        f"offset b {np.median(B_s):+.4f}, residual {np.nanmedian(rms) if valid.any() else float('nan'):.1%}")

    # Only pixels under the mask carry their own depth; everything else is the plate. Work on
    # the mask's bounding box (plus a margin for the window filters).
    plate_inv16 = plate_inv.astype(np.float16)
    boxes = [_bbox(alpha_mm[t] > 0, 8) for t in range(N)]
    inv_mm = mm("inv_aligned", np.float16, (N, h2, w2))
    for t in range(N):
        inv_mm[t] = plate_inv16
        bb = boxes[t]
        if bb is None:
            continue
        x = 1.0 / np.maximum(depth_mm[t][bb].astype(np.float32), 1e-3)
        inv_fg = np.maximum(A_s[t] * x + B_s[t], 1e-3).astype(np.float32)
        a = alpha_mm[t][bb]
        # Tighten the mask: pixels the segmentation included that sit at the wall's depth, look
        # like the plate and are not confidently a person are background. Left in, the boundary
        # snap below would pull them onto the person and leave a halo around the silhouette.
        bgish = (inv_fg <= plate_inv[bb] * 1.04) & (diff_mm[t][bb] < 90) & (person_mm[t][bb] < 230)
        if bgish.any():
            keep = ((a >= 128) & ~bgish).astype(np.uint8)
            keep = cv2.morphologyEx(keep, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
            keep = maskmod.fill_small_holes(keep, int(0.01 * h2 * w2))
            a = maskmod.feather(keep)
            alpha_mm[t][bb] = a
        inv_fg = snap_depth_edges(inv_fg)  # crisp steps inside the person (hand in front of body)
        inv_fg = depthstab.snap_boundary(inv_fg, a)
        inv_fg = np.maximum(inv_fg, plate_inv[bb] * 1.01)  # never behind the room surface it covers
        inv_mm[t][bb] = np.where(a > 0, inv_fg, plate_inv[bb]).astype(np.float16)
    final_mm = mm("inv_final", np.float16, (N, h2, w2))
    tw2 = [1.0, 2.0, 4.0, 2.0, 1.0]
    inv_samples = [plate_inv.ravel()[rng.choice(plate_inv.size, 4000, replace=False)]]
    for t in range(N):
        final_mm[t] = plate_inv16
        bb = boxes[t]
        if bb is None:
            continue
        lo, hi = max(0, t - 2), min(N, t + 3)
        fil = depthstab.temporal_bilateral(
            [inv_mm[k][bb] for k in range(lo, hi)], [small_mm[k][bb] for k in range(lo, hi)], t - lo,
            time_weights=[tw2[k - t + 2] for k in range(lo, hi)],
        )
        m = alpha_mm[t][bb] > 0
        pin = plate_inv[bb]
        out = np.where(m, np.maximum(fil, pin * 1.01), pin).astype(np.float32)
        final_mm[t][bb] = out.astype(np.float16)
        fg = out[m]
        if fg.size:
            inv_samples.append(fg[rng.choice(fg.size, min(fg.size, 2000), replace=False)])
        if t % 60 == 0:
            progress(None, 0.84 + 0.06 * t / N)
    near, far = depthstab.choose_near_far(np.concatenate(inv_samples))
    timings["depth"] = time.time() - t0
    log(f"depth range: near {near:.3f} m, far {far:.3f} m")

    # ---- pass E: encode --------------------------------------------------------------------------
    t0 = time.time()
    progress("Encoding the video", 0.90)
    cand = np.flatnonzero(coverage >= 0.5 * coverage.max()) if coverage.max() > 0 else np.arange(N)
    thumb_idx = int(cand[np.argmin(np.abs(cand - N * 0.45))])
    duration = N / float(fps)
    thumb = None
    packed = None
    with PackWriter(out_dir / "tw.mp4", W, H, fps, audio_src=video_path if info.has_audio else None,
                    audio_start=start, duration=duration, crf=cfg.crf, preset=cfg.preset) as writer:
        for i, fr in enumerate(frames()):
            if i >= N:
                break
            if stabilize:
                fr = motion.warp(fr, mats[i])
            code = encode_inverse(final_mm[i].astype(np.float32), near, far)
            packed = pack_frame(fr, code, alpha_mm[i], out=packed)
            writer.write(packed)
            if i == thumb_idx:
                thumb = np.array(fr)
            if i % 30 == 0:
                progress(None, 0.90 + 0.09 * i / N)
        frames_written = writer.frames
    if frames_written != N:
        warn(f"encoded {frames_written} of {N} frames")
    if thumb is None:
        thumb = plate
    save_jpg(out_dir / "thumb.jpg", _thumb(thumb), quality=88)
    timings["encode"] = time.time() - t0
    timings["total"] = time.time() - t_all
    log(f"encoded {frames_written} frames ({(out_dir / 'tw.mp4').stat().st_size / 1e6:.1f} MB) in {timings['encode']:.1f}s; "
        f"video pipeline total {timings['total']:.1f}s = {timings['total'] / N:.3f} s/frame")

    video = {
        "file": "tw.mp4",
        "layout": LAYOUT,
        "width": W,
        "height": H,
        "fps": round(float(fps), 6),
        "duration": round(frames_written / float(fps), 4),
        "hasAudio": bool(info.has_audio),
        "intrinsics": {k: round(float(v), 4) for k, v in K.items()},
        "depth": {"encoding": "inverse", "near": near, "far": far},
        "cameraPose": json.loads(json.dumps(IDENTITY_POSE)),
        "plate": "plate.jpg",
    }
    stats = {
        "frames": int(frames_written),
        "motion": summ,
        "stabilised": bool(stabilize),
        "plate": plate_stats,
        "maskCoverageMean": float(coverage.mean()),
        "alignedFrames": int(valid.sum()),
        "timings": {k: round(v, 2) for k, v in timings.items()},
        "secondsPerFrame": round(timings["total"] / max(frames_written, 1), 4),
        "device": cfg.device,
        "config": {k: v for k, v in asdict(cfg).items()},
    }
    (work_dir / "tw_stats.json").write_text(json.dumps(stats, indent=2, default=str))
    if not cfg.keep_work:
        for name in ("diff", "person", "depth_raw", "small", "alpha", "inv_aligned", "inv_final"):
            try:
                (work_dir / f"{name}.npy").unlink()
            except OSError:
                pass
    return {
        "video": video,
        "plate_rgb": plate,
        "plate_depth": plate_depth,
        "background": ~holes,
        "K": K,
        "stats": stats,
        "info": info,
    }


def _thumb(rgb: np.ndarray, long_side: int = 640) -> np.ndarray:
    import cv2

    h, w = rgb.shape[:2]
    s = long_side / max(h, w)
    if s >= 1:
        return rgb
    return cv2.resize(rgb, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Video -> tw-pack-v1 (writes OUT_DIR/tw.mp4, plate.jpg, thumb.jpg, video.json)")
    ap.add_argument("video")
    ap.add_argument("out_dir")
    ap.add_argument("--work", help="work directory (default OUT_DIR/../work)")
    ap.add_argument("--max-seconds", type=float)
    ap.add_argument("--start", type=float)
    ap.add_argument("--fov", type=float, dest="fov_deg")
    ap.add_argument("--stabilize", choices=["auto", "on", "off"])
    ap.add_argument("--crf", type=int)
    ap.add_argument("--keep-work", action="store_true", default=None)
    ap.add_argument("--plate-inpaint", choices=["lama", "mirror"], help="fill for never-seen plate pixels (default lama)")
    args = ap.parse_args(argv)
    cfg = TwConfig.for_device(
        max_seconds=args.max_seconds, start=args.start, fov_deg=args.fov_deg, stabilize=args.stabilize, crf=args.crf, keep_work=args.keep_work,
        plate_inpaint=args.plate_inpaint,
    )
    out = Path(args.out_dir)
    work = Path(args.work) if args.work else out.parent / "work"
    res = process_video(args.video, out, work, cfg, progress=lambda s, f: s and print(f"[{(f or 0) * 100:5.1f}%] {s}", file=sys.stderr))
    (out / "video.json").write_text(json.dumps(res["video"], indent=2))
    print(json.dumps(res["video"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
