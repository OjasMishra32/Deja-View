#!/usr/bin/env python3
"""Run one ThirdWheel job directory (same entry point on HiPerGator and the Mac).

  python pipeline/run_job.py <jobdir>

Reads <jobdir>/job.json ({"id", "mode", "prompt"?, "params"}), rewrites <jobdir>/progress.json
(JobProgress) as it goes, appends <jobdir>/log.txt, writes <jobdir>/out/scene.json (JobResult,
paths relative to out/) and finally a DONE or FAILED marker.

Modes
  rentfree     best photo, or the sharpest steadiest video frame, or a prompt -> flashworld_run.py
  reconstruct  photos (or frames sampled from a video) -> anysplat_run.py
  thirdwheel   video -> tw pipeline (tw.mp4, plate.jpg, thumb.jpg); room from flashworld_run.py on
               the plate when a GPU backend is available, otherwise plate_room.py

Environment
  TW_PY_FLASHWORLD / TW_PY_ANYSPLAT    interpreter for the GPU runners when they live in another
                                       environment (hpg/env.sh: envs/flashworld, envs/anysplat);
                                       FLASHWORLD_PYTHON / ANYSPLAT_PYTHON are accepted too
  TW_FW_REQUESTS                       set by hpg/worker.py: the Third Wheel room goes to the warm
                                       FlashWorld worker (flashworld_run.generate_room)
  TW_DISABLE_FLASHWORLD=1              never try FlashWorld (thirdwheel then always uses plate_room)
  TW_DEVICE=cpu|mps|cuda               force the torch device for the video pipeline

Job params (all optional)
  thirdwheel   maxSeconds, start, fovDeg, stabilize (auto|on|off), crf, room (auto|plate),
               maxSplats, cameraHeight, trajectory, seed, depthModel, plateDepthModel, segmenter,
               segStride, keepWork
  rentfree     localFallback (true: build a plate-depth room locally instead of failing without a GPU)
  reconstruct  maxFrames (frames sampled from a video, default 48)
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from common import env as _env  # noqa: E402,F401
from common.jobio import ChildProgressRelay, Job, JobError, read_json, write_json_atomic  # noqa: E402
from common.media import MediaError  # noqa: E402

REPO_ROOT = PIPELINE_DIR.parent
GPU_REQUIRED = (
    "{what} needs a GPU backend (HiPerGator worker/batch, or the FlashWorld Hugging Face Space for photos). "
    "It cannot run on this machine: {why}."
)


class Cancelled(Exception):
    pass


def _on_term(signum, frame):  # noqa: ARG001
    raise Cancelled(f"cancelled (signal {signum})")


# ---------------------------------------------------------------------------- GPU runners

def _has_cuda() -> bool:
    from common.device import has_cuda

    return has_cuda()


def runner_python(name: str) -> str | None:
    """Interpreter for a GPU runner living in another environment (hpg/env.sh: TW_PY_FLASHWORLD,
    TW_PY_ANYSPLAT; FLASHWORLD_PYTHON / ANYSPLAT_PYTHON are accepted too)."""
    for var in (f"TW_PY_{name.upper()}", f"{name.upper()}_PYTHON"):
        py = os.environ.get(var)
        if py and Path(py).exists():
            return py
    return None


def runner_available(name: str) -> tuple[bool, str]:
    """(available, reason). name: 'flashworld' or 'anysplat'."""
    script = PIPELINE_DIR / f"{name}_run.py"
    if name == "flashworld" and os.environ.get("TW_DISABLE_FLASHWORLD") == "1":
        return False, "FlashWorld disabled by TW_DISABLE_FLASHWORLD=1"
    if not script.exists():
        return False, f"pipeline/{script.name} is not installed"
    if runner_python(name):
        return True, f"{name} Python {runner_python(name)}"
    if not _has_cuda():
        return False, "no CUDA GPU is available here"
    return True, "CUDA GPU available"


def room_backend() -> tuple[bool, str]:
    """Whether flashworld_run.generate_room can reach a GPU: the warm worker (TW_FW_REQUESTS, set by
    hpg/worker.py), a FlashWorld Python, or CUDA in this process."""
    if os.environ.get("TW_DISABLE_FLASHWORLD") == "1":
        return False, "FlashWorld disabled by TW_DISABLE_FLASHWORLD=1"
    if not (PIPELINE_DIR / "flashworld_run.py").exists():
        return False, "pipeline/flashworld_run.py is not installed"
    if os.environ.get("TW_FW_REQUESTS"):
        return True, "warm GPU worker"
    if runner_python("flashworld"):
        return True, f"FlashWorld Python {runner_python('flashworld')}"
    if _has_cuda():
        return True, "CUDA GPU here"
    return False, "no GPU world model reachable (no warm worker, no CUDA here, TW_PY_FLASHWORLD unset)"


def run_runner(job: Job, name: str, args: list[str], lo: float, hi: float, stage: str, progress_file: Path | None = None) -> None:
    """Run pipeline/<name>_run.py as a subprocess, relaying its log and progress."""
    script = PIPELINE_DIR / f"{name}_run.py"
    py = runner_python(name) or sys.executable
    cmd = [py, str(script)] + args
    if progress_file is not None:
        cmd += ["--progress", str(progress_file)]
        try:
            progress_file.unlink()
        except FileNotFoundError:
            pass
    job.log(f"{name}: {' '.join(cmd[1:])}")
    job.progress(stage, 0.0)
    tail: list[str] = []
    cb = job.subprogress(lo, hi)
    relay = ChildProgressRelay(progress_file, cb) if progress_file is not None else None
    t0 = time.time()
    if relay:
        relay.__enter__()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(REPO_ROOT), bufsize=1)
        try:
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    job.log(f"{name}| {line}")
                    tail = (tail + [line])[-12:]
            rc = proc.wait()
        except BaseException:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise
    finally:
        if relay:
            relay.__exit__(None, None, None)
    if rc != 0:
        err = None
        if progress_file is not None:
            err = (read_json(progress_file) or {}).get("error")
        detail = err or (tail[-1] if tail else "no output")
        raise JobError(f"{name} failed (exit {rc}): {detail}")
    job.log(f"{name}: finished in {time.time() - t0:.1f}s")
    cb(None, 1.0)


def _flashworld(job: Job, out_dir: Path, image: Path | None, prompt: str | None, lo: float, hi: float, stage: str) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    args = ["--out", str(out_dir)]
    if image is not None:
        args += ["--image", str(image)]
    if prompt:
        args += ["--prompt", prompt]
    run_runner(job, "flashworld", args, lo, hi, stage, progress_file=job.work_dir / f"flashworld-progress-{out_dir.name}.json")
    res = read_json(out_dir / "scene.json")
    if not isinstance(res, dict) or not isinstance(res.get("world"), dict):
        raise JobError("flashworld did not write a world into scene.json")
    wf = out_dir / res["world"].get("file", "")
    if not wf.is_file():
        raise JobError(f"flashworld result is missing {res['world'].get('file')}")
    return res


# ---------------------------------------------------------------------------- inputs

def _normalise_image(src: Path, dst: Path, max_long: int = 4096) -> Path:
    """Decode any supported photo (HEIC too, EXIF orientation applied) to an RGB JPEG."""
    from common.media import load_image, resize_long, save_jpg

    rgb = resize_long(load_image(src), max_long)
    save_jpg(dst, rgb, quality=95)
    return dst


def pick_rentfree_input(job: Job) -> Path | None:
    images, videos = job.input_images(), job.input_videos()
    dst = job.work_dir / "input.jpg"
    if images:
        if len(images) == 1:
            best = images[0]
        else:
            from common.frame_pick import best_photo

            best, scores = best_photo(images)
            job.log("photo scores: " + ", ".join(f"{s['file']}={s['score']:.2f}" for s in scores))
        job.log(f"input: photo {best.name}")
        if best.suffix.lower() in (".jpg", ".jpeg"):
            return best  # keep the EXIF (orientation, 35 mm focal length) for FlashWorld's intrinsics
        return _normalise_image(best, dst)
    if videos:
        from common.media import save_jpg
        from common.frame_pick import best_video_frame

        job.progress("Picking the sharpest frame", 0.01)
        pick = best_video_frame(videos[0])
        job.log(f"input: frame at {pick.time:.2f}s of {videos[0].name} (sharpness {pick.sharpness:.1f}, motion {pick.motion:.4f})")
        save_jpg(dst, pick.image, quality=95)
        return dst
    unknown = [p.name for p in job.input_files()]
    if unknown:
        raise JobError(f"unsupported input files: {', '.join(unknown)} (use photos or a video)")
    return None


# ---------------------------------------------------------------------------- modes

def run_rentfree(job: Job) -> dict:
    image = pick_rentfree_input(job)
    if image is None and not job.prompt:
        raise JobError("Rent Free needs a photo, a video or a text prompt")
    ok, why = runner_available("flashworld")
    if not ok:
        if image is not None and bool(job.params.get("localFallback")):
            job.warn(f"FlashWorld unavailable ({why}); building a plate-depth room from the photo instead")
            return _local_photo_room(job, image)
        raise JobError(GPU_REQUIRED.format(what="Rent Free (FlashWorld)", why=why))
    res = _flashworld(job, job.out_dir, image, job.prompt, 0.05, 0.98, "Generating the world")
    if image is not None and not (job.out_dir / "thumb.jpg").exists():
        from common.media import load_image, resize_long, save_jpg

        save_jpg(job.out_dir / "thumb.jpg", resize_long(load_image(image), 640), quality=88)
        res["thumb"] = "thumb.jpg"
    res.setdefault("thumb", "thumb.jpg")
    res.setdefault("caption", "Generated from a photo" if image is not None else f"Generated from: {job.prompt}")
    return res


def _local_photo_room(job: Job, image: Path) -> dict:
    from common.camera import intrinsics_for
    from common.device import pick_device
    from common.media import load_image, resize_long, save_jpg
    from common.models import DEFAULT_PLATE_DEPTH, DepthEstimator
    from plate_room import build_plate_room, estimate_plate_depth

    job.stage("Estimating depth", 0.1)
    rgb = resize_long(load_image(image), 1280)
    rgb = rgb[: rgb.shape[0] // 2 * 2, : rgb.shape[1] // 2 * 2]
    de = DepthEstimator(DEFAULT_PLATE_DEPTH, device=pick_device())
    depth = estimate_plate_depth(de, rgb)
    K = intrinsics_for(rgb.shape[1], rgb.shape[0], long_fov_deg=job.params.get("fovDeg"))
    job.stage("Building the room", 0.5)
    room = build_plate_room(rgb, depth, K, job.out_dir / "world.ply", max_splats=int(job.params.get("maxSplats", 900_000)), log=job.log)
    save_jpg(job.out_dir / "thumb.jpg", resize_long(rgb, 640), quality=88)
    world = room["world"]
    world["transform"]["quaternion"] = [0.0, 0.0, 0.0, 1.0]
    return {"world": world, "thumb": "thumb.jpg", "caption": "Room lifted from the photo's depth (local fallback, no AI fill-in)"}


def run_reconstruct(job: Job) -> dict:
    ok, why = runner_available("anysplat")
    images, videos = job.input_images(), job.input_videos()
    if not images and not videos:
        raise JobError("Reconstruct needs 8 or more photos or a video")
    if not ok:
        raise JobError(GPU_REQUIRED.format(what="Reconstruct (AnySplat)", why=why))
    img_dir = job.work_dir / "images"
    if img_dir.exists():
        shutil.rmtree(img_dir)
    img_dir.mkdir(parents=True)
    job.stage("Preparing photos", 0.01)
    if images:
        for i, p in enumerate(images):
            _normalise_image(p, img_dir / f"{i:03d}.jpg", max_long=1920)
    else:
        n = _sample_video_frames(videos[0], img_dir, int(job.params.get("maxFrames", 48)))
        job.log(f"sampled {n} frames from {videos[0].name}")
    count = len(list(img_dir.glob("*.jpg")))
    if count < 8:
        job.warn(f"only {count} images; reconstruction quality needs 8 or more")
    run_runner(job, "anysplat", ["--images", str(img_dir), "--out", str(job.out_dir)], 0.05, 0.98, "Reconstructing",
               progress_file=job.work_dir / "anysplat-progress.json")
    res = read_json(job.out_dir / "scene.json")
    if not isinstance(res, dict) or "world" not in res:
        raise JobError("anysplat did not write a world into scene.json")
    if not (job.out_dir / "thumb.jpg").exists():
        from common.media import load_image, resize_long, save_jpg

        first = sorted(img_dir.glob("*.jpg"))[0]
        save_jpg(job.out_dir / "thumb.jpg", resize_long(load_image(first), 640), quality=88)
    res.setdefault("thumb", "thumb.jpg")
    res.setdefault("caption", f"Reconstructed from {count} views")
    return res


def _sample_video_frames(video: Path, dst: Path, max_frames: int) -> int:
    """Evenly spaced windows; the sharpest frame of each window."""
    from common.media import fit_size, iter_frames, probe, save_jpg
    from common.frame_pick import sharpness
    from fractions import Fraction

    info = probe(video)
    rate = Fraction(min(info.fps, max(1.0, 4 * max_frames / max(info.duration, 0.1)))).limit_denominator(1000)
    size = fit_size(info.width, info.height, 1600, 2)
    per = max(1, int(round(float(rate) * info.duration / max_frames)))
    best, best_s, n = None, -1.0, 0
    for i, fr in enumerate(iter_frames(video, size, fps=rate)):
        s = sharpness(fr)
        if s > best_s:
            best, best_s = fr.copy(), s
        if (i + 1) % per == 0:
            save_jpg(dst / f"{n:03d}.jpg", best, quality=94)
            n += 1
            best, best_s = None, -1.0
    if best is not None and n < max_frames:
        save_jpg(dst / f"{n:03d}.jpg", best, quality=94)
        n += 1
    return n


def run_thirdwheel(job: Job) -> dict:
    from tw.run import TwConfig, process_video

    videos = job.input_videos()
    if not videos:
        names = ", ".join(p.name for p in job.input_files()) or "nothing"
        raise JobError(f"Third Wheel needs one video (got {names})")
    if len(videos) > 1:
        job.warn(f"{len(videos)} videos uploaded; using {videos[0].name}")
    room_mode = str(job.params.get("room", "auto"))
    fw_ok, fw_why = room_backend() if room_mode != "plate" else (False, "room=plate requested")

    cfg = TwConfig.from_params(job.params)
    if cfg.focal_35mm is None:
        f35 = job.input_meta(videos[0].name).get("focal35")
        if isinstance(f35, (int, float)) and f35 > 0:
            cfg.focal_35mm = float(f35)
    job.set_range(0.0, 0.62 if fw_ok else 0.86)
    job.log(f"thirdwheel: {videos[0].name}, device {cfg.device}, room: {'FlashWorld (' + fw_why + ')' if fw_ok else 'plate (' + fw_why + ')'}")
    tw = process_video(videos[0], job.out_dir, job.work_dir, cfg, progress=job.progress, log=job.log, warn=job.warn)
    video = tw["video"]
    job.set_range(0.0, 1.0)

    world = None
    caption = None
    if fw_ok:
        try:
            world, video = _generated_room(job, tw, video)
            caption = "Room generated from the space behind your friend"
        except Exception as e:  # the plate room is always possible
            job.warn(f"generated room failed ({e}); building the room from the plate instead")
            world = None
    if world is None:
        from plate_room import build_plate_room

        job.progress("Building the room from the plate", 0.88)
        room = build_plate_room(
            tw["plate_rgb"], tw["plate_depth"], tw["K"], job.out_dir / "world.ply",
            max_splats=int(job.params.get("maxSplats", 700_000)), log=job.log,
        )
        world = room["world"]
        video["cameraPose"] = {"position": [0.0, 0.0, 0.0], "quaternion": room["levelQuaternion"]}
        caption = "Room lifted from the background plate (no GPU world model)"
    secs = video["duration"]
    caption = f"{caption}; {secs:.0f}s of video{' with sound' if video['hasAudio'] else ''}"
    return {"world": world, "video": video, "thumb": "thumb.jpg", "caption": caption}


def _generated_room(job: Job, tw: dict, video: dict) -> tuple[dict, dict]:
    """FlashWorld room from the plate (warm worker, CUDA here or a FlashWorld Python), aligned with the video."""
    import flashworld_run
    from plate_room import DEFAULT_CAMERA_HEIGHT, plate_geometry
    from tw.align import align_video_to_world

    room_dir = job.work_dir / "room"
    if room_dir.exists():
        shutil.rmtree(room_dir)
    room_dir.mkdir(parents=True)
    # The world is built for the video's own camera: same intrinsics, and the camera height
    # measured from the plate when the floor is visible (a propped phone is lower than a hand).
    geo = plate_geometry(tw["plate_depth"], tw["K"])
    cam_h = float(job.params.get("cameraHeight") or (-geo["floorY"] if geo["floorVisible"] else DEFAULT_CAMERA_HEIGHT))
    job.log(f"room: FlashWorld from the plate, camera height {cam_h:.2f} m ({geo['floorHow']}), intrinsics from the video")
    job.progress("Generating the room", 0.62)
    params = {"intrinsics": {k: float(v) for k, v in tw["K"].items()}, "cameraHeight": round(cam_h, 3)}
    for key in ("trajectory", "seed", "maxSplats", "shDegree"):
        if job.params.get(key) is not None:
            params[key] = job.params[key]
    if runner_python("flashworld") and not os.environ.get("TW_PY_FLASHWORLD"):
        os.environ["TW_PY_FLASHWORLD"] = runner_python("flashworld")
    res = flashworld_run.generate_room(str(job.out_dir / "plate.jpg"), job.prompt, str(room_dir), progress=job.subprogress(0.62, 0.95), **params)
    world = (res or {}).get("world")
    if not isinstance(world, dict) or not (room_dir / world.get("file", "")).is_file():
        raise RuntimeError("FlashWorld returned no world file")
    for name in (world["file"], "input_camera.json", "input_depth.npy"):
        if (room_dir / name).exists():
            shutil.copy2(room_dir / name, job.out_dir / name)
    job.progress("Lining the video up with the room", 0.96)
    video, info = align_video_to_world(video, tw["plate_depth"], tw["background"], job.out_dir, log=job.log)
    return world, video


MODES = {"rentfree": run_rentfree, "reconstruct": run_reconstruct, "thirdwheel": run_thirdwheel}


def run(jobdir: Path | str) -> int:
    """Run a job; returns the process exit code (0 = DONE)."""
    jobdir = Path(jobdir)
    try:
        job = Job(jobdir)
    except JobError as e:
        if jobdir.is_dir():
            (jobdir / "FAILED").write_text(f"{e}\n")
            write_json_atomic(jobdir / "progress.json", {"stage": "Failed", "error": str(e), "done": True})
        print(f"FAILED: {e}", file=sys.stderr)
        return 2
    job.clear_markers()
    t0 = time.time()
    job.log(f"job {job.id}: mode={job.mode} inputs={[p.name for p in job.input_files()]} prompt={job.prompt!r} params={job.params}")
    try:
        fn = MODES.get(job.mode)
        if fn is None:
            raise JobError(f"unknown mode {job.mode!r} (expected rentfree, thirdwheel or reconstruct)")
        result = fn(job)
        result = {k: result[k] for k in ("world", "video", "thumb", "caption") if result.get(k) is not None}
        job.write_result(result)
        job.log(f"job {job.id}: done in {time.time() - t0:.1f}s")
        job.finish_ok()
        return 0
    except (JobError, MediaError) as e:
        msg = str(e)
    except Cancelled as e:
        msg = str(e)
    except MemoryError:
        msg = "ran out of memory (try a shorter clip: params.maxSeconds)"
    except Exception as e:  # unexpected: keep the traceback in the log
        job.log(traceback.format_exc().rstrip())
        msg = f"internal error: {type(e).__name__}: {e}"
    job.log(f"FAILED: {msg}")
    job.finish_failed(msg)
    return 1


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    signal.signal(signal.SIGTERM, _on_term)
    return run(argv[0])


if __name__ == "__main__":
    raise SystemExit(main())
