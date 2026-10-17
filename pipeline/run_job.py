#!/usr/bin/env python3
"""Run one Déjà View job directory (same entry point on HiPerGator and the Mac).

  python pipeline/run_job.py <jobdir>

Reads <jobdir>/job.json ({"id", "mode", "prompt"?, "params"}), rewrites <jobdir>/progress.json
(JobProgress) as it goes, appends <jobdir>/log.txt, writes <jobdir>/out/scene.json (JobResult,
paths relative to out/) and finally a DONE or FAILED marker.

What the app shows comes from here: progress.json `stage` (short step names), `error` (one product sentence on
failure; the technical cause is in `detail` and log.txt) and the result `caption`. None of them name tools,
models or services.

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
  rentfree     localFallback (true: build a plate-depth room locally instead of failing without a GPU),
               seed (default: the attempt number, so a retry gives a new world), trajectory, cameraHeight,
               maxSplats, shDegree
  reconstruct  maxFrames (frames sampled from a video, default 48),
               listing (true: the photos are a real-estate listing's: their watermarks and logos are cropped or
               inpainted before the rebuild, and the world gets an automatic walk zone, collider and a spawn facing
               what the photos saw; pipeline/listing.py)
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
from common.jobio import (  # noqa: E402
    GENERIC_FAILURE,
    ChildProgressRelay,
    Job,
    JobError,
    explain_failure,
    read_json,
    write_json_atomic,
)

REPO_ROOT = PIPELINE_DIR.parent
# Technical note for the log when a mode needs a GPU this machine does not have.
GPU_REQUIRED = "{what} needs a GPU backend (HiPerGator worker/batch, or the cloud GPU for photos); not here: {why}"
# The smallest photo short side the depth and world models can do anything useful with (the server rejects < 320).
MIN_PHOTO_SIDE = 64
# What the app says when a runner subprocess fails, per runner.
RUNNER_FAILURE = {
    "flashworld": "We couldn't generate this world. Try again in a minute.",
    "anysplat": "We couldn't reconstruct this place. Try again in a minute.",
}


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
        detail = f"{name} failed (exit {rc}): {err or (tail[-1] if tail else 'no output')}"
        user, _ = explain_failure(RuntimeError(detail))
        if "memory" not in user:
            user = RUNNER_FAILURE.get(name, user)
        raise JobError(user, detail)
    job.log(f"{name}: finished in {time.time() - t0:.1f}s")
    cb(None, 1.0)


def world_params(job: Job) -> dict:
    """Generation params for the world runner, as the warm worker uses them: the job's own params, and a seed that
    defaults to the attempt number so Retry gives a different world."""
    params = {k: job.params[k] for k in ("trajectory", "seed", "cameraHeight", "maxSplats", "shDegree") if job.params.get(k) is not None}
    if "seed" not in params:
        try:
            params["seed"] = int(job.params.get("attempt") or 0)
        except (TypeError, ValueError):
            params["seed"] = 0
    return params


def _flashworld(job: Job, out_dir: Path, image: Path | None, prompt: str | None, lo: float, hi: float, stage: str) -> dict:
    import flashworld_run

    out_dir.mkdir(parents=True, exist_ok=True)
    args = ["--out", str(out_dir)]
    if image is not None:
        args += ["--image", str(image)]
    if prompt:
        args += ["--prompt", prompt]
    args += flashworld_run._cli_from_params(world_params(job))
    run_runner(job, "flashworld", args, lo, hi, stage, progress_file=job.work_dir / f"flashworld-progress-{out_dir.name}.json")
    res = read_json(out_dir / "scene.json")
    if not isinstance(res, dict) or not isinstance(res.get("world"), dict):
        raise JobError(RUNNER_FAILURE["flashworld"], "flashworld did not write a world into scene.json")
    wf = out_dir / res["world"].get("file", "")
    if not wf.is_file():
        raise JobError(RUNNER_FAILURE["flashworld"], f"flashworld result is missing {res['world'].get('file')}")
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
        raise JobError(
            "These files aren't photos or a video we can use. Try a JPEG, PNG or HEIC photo, or an MP4 or MOV video.",
            f"unsupported input files: {', '.join(unknown)}",
        )
    return None


def _check_photo_size(rgb, what: str = "photo") -> None:
    """Refuses photos too small to build anything from (a 1x1 image even crashes the depth step)."""
    h, w = rgb.shape[:2]
    if min(h, w) < MIN_PHOTO_SIDE:
        raise JobError(
            f"This {what} is too small ({w}x{h}). Use one at least 320 px on the short side.",
            f"input {what} is {w}x{h}, below {MIN_PHOTO_SIDE} px",
        )


# ---------------------------------------------------------------------------- modes

PHOTO_CAPTION = "Generated from one photo: the rest of the room was imagined."
FRAME_CAPTION = "Generated from the sharpest frame of your clip: the rest of the room was imagined."
PROMPT_CAPTION = "Generated from your prompt."
DEPTH_ROOM_CAPTION = "Built from the depth in your photo: what the camera saw, in 3D."
DEPTH_FRAME_CAPTION = "Built from the depth in the sharpest frame of your clip: what the camera saw, in 3D."


def _from_clip(job: Job) -> bool:
    """Photo mode got a video (a game or phone clip) rather than photos."""
    return not job.input_images() and bool(job.input_videos())


def run_rentfree(job: Job) -> dict:
    image = pick_rentfree_input(job)
    if image is None and not job.prompt:
        raise JobError("Photo mode needs a photo, a video or a prompt.", "rentfree job without inputs or prompt")
    ok, why = runner_available("flashworld")
    if not ok:
        if image is not None and bool(job.params.get("localFallback")):
            job.warn(f"world model unavailable ({why}); building a plate-depth room from the photo instead")
            return _local_photo_room(job, image)
        if image is None:
            raise JobError(
                "Worlds from a prompt alone need a GPU, and none is free right now. Try again in a few minutes, or add a photo.",
                GPU_REQUIRED.format(what="Photo mode (prompt only)", why=why),
            )
        raise JobError(
            "No GPU is free to build this world right now. Try again in a few minutes.",
            GPU_REQUIRED.format(what="Photo mode", why=why),
        )
    res = _flashworld(job, job.out_dir, image, job.prompt, 0.05, 0.98, "Generating the world")
    if image is not None and not (job.out_dir / "thumb.jpg").exists():
        from common.media import load_image, resize_long, save_jpg

        save_jpg(job.out_dir / "thumb.jpg", resize_long(load_image(image), 640), quality=88)
        res["thumb"] = "thumb.jpg"
    res.setdefault("thumb", "thumb.jpg")
    res["caption"] = PROMPT_CAPTION if image is None else FRAME_CAPTION if _from_clip(job) else PHOTO_CAPTION
    return res


def _local_photo_room(job: Job, image: Path) -> dict:
    from common.camera import intrinsics_for
    from common.device import pick_device
    from common.media import load_image, resize_long, save_jpg
    from common.models import DEFAULT_PLATE_DEPTH, DepthEstimator
    from plate_room import build_plate_room, estimate_plate_depth

    job.stage("Measuring the depth of the photo", 0.1)
    rgb = load_image(image)
    _check_photo_size(rgb)
    rgb = resize_long(rgb, 1280)
    rgb = rgb[: rgb.shape[0] // 2 * 2, : rgb.shape[1] // 2 * 2]
    de = DepthEstimator(DEFAULT_PLATE_DEPTH, device=pick_device())
    depth = estimate_plate_depth(de, rgb)
    K = intrinsics_for(rgb.shape[1], rgb.shape[0], long_fov_deg=job.params.get("fovDeg"))
    job.stage("Building the room", 0.5)
    room = build_plate_room(rgb, depth, K, job.out_dir / "world.ply", max_splats=int(job.params.get("maxSplats", 900_000)), log=job.log)
    save_jpg(job.out_dir / "thumb.jpg", resize_long(rgb, 640), quality=88)
    world = room["world"]
    world["transform"]["quaternion"] = [0.0, 0.0, 0.0, 1.0]
    return {"world": world, "thumb": "thumb.jpg", "caption": DEPTH_FRAME_CAPTION if _from_clip(job) else DEPTH_ROOM_CAPTION}


def param_on(value) -> bool:
    """A yes/no job param as a form or JSON sends it: true, 1, "true" and "1" (any case, spaces ignored) are on;
    everything else, including "false", "0", "" and a missing param, is off."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1")
    return False


def run_reconstruct(job: Job) -> dict:
    ok, why = runner_available("anysplat")
    images, videos = job.input_images(), job.input_videos()
    if not images and not videos:
        raise JobError("Reconstruct needs at least 8 photos or a video.", "reconstruct job without photos or video")
    if not ok:
        raise JobError(
            "Reconstructions need a GPU, and none is free right now. Try again in a few minutes.",
            GPU_REQUIRED.format(what="Reconstruct", why=why),
        )
    img_dir = job.work_dir / "images"
    if img_dir.exists():
        shutil.rmtree(img_dir)
    img_dir.mkdir(parents=True)
    listing = param_on(job.params.get("listing")) and bool(images)
    job.stage("Preparing the photos", 0.01)
    if images:
        for i, p in enumerate(images):
            _normalise_image(p, img_dir / f"{i:03d}.jpg", max_long=1920)
        if listing:
            _clean_listing(job, img_dir)
    else:
        n = _sample_video_frames(videos[0], img_dir, int(job.params.get("maxFrames", 48)))
        job.log(f"sampled {n} frames from {videos[0].name}")
    count = len(list(img_dir.glob("*.jpg")))
    if count < 8 and not listing:  # a listing has the photos it has; asking for more would be no help
        job.notice(f"Only {count} views to work from; 8 or more give a cleaner result.", f"only {count} images; quality needs 8 or more")
    run_runner(job, "anysplat", ["--images", str(img_dir), "--out", str(job.out_dir)], 0.05, 0.9 if listing else 0.98,
               "Reconstructing", progress_file=job.work_dir / "anysplat-progress.json")
    res = read_json(job.out_dir / "scene.json")
    if not isinstance(res, dict) or "world" not in res:
        raise JobError(RUNNER_FAILURE["anysplat"], "anysplat did not write a world into scene.json")
    if not (job.out_dir / "thumb.jpg").exists():
        from common.media import load_image, resize_long, save_jpg

        first = sorted(img_dir.glob("*.jpg"))[0]
        save_jpg(job.out_dir / "thumb.jpg", resize_long(load_image(first), 640), quality=88)
    res.setdefault("thumb", "thumb.jpg")
    if listing:
        job.stage("Finding where you can walk", 0.92)
        from listing import add_walk_zone

        wz = add_walk_zone(job.out_dir, res, job.work_dir, log=job.log, reraise=(Cancelled,))
        if wz["ok"]:
            job.log(f"walk zone {wz['areaM2']} m2, spawn {wz['spawn']}")
        else:
            job.notice("We couldn't map a clear area to walk, so you start where the first photo was taken.",
                       f"walk zone failed: {wz['reason']}")
        res["caption"] = with_notices(f"Rebuilt from {count} listing photos.", job)
        return res
    res["caption"] = with_notices(f"Reconstructed from {count} {'photos' if images else 'views of your video'}.", job)
    return res


def _clean_listing(job: Job, img_dir: Path) -> None:
    """Crops or inpaints the listing's watermarks and logos in place (pipeline/listing.py). The originals stay in
    work/listing-raw, the decisions in work/listing.json and the mask previews in work/listing-masks. If the clean-up
    fails, the rebuild gets the original photos and the caption says so: the world still ships."""
    job.stage("Removing watermarks", 0.03)
    raw = job.work_dir / "listing-raw"
    if raw.exists():
        shutil.rmtree(raw)
    shutil.move(str(img_dir), str(raw))
    try:
        from listing import clean_photos

        rep = clean_photos(sorted(raw.glob("*.jpg")), img_dir, job.work_dir / "listing-masks",
                           report_path=job.work_dir / "listing.json")
    except Cancelled:
        raise
    except Exception as e:  # the photos rebuild fine with their marks on
        job.log(traceback.format_exc().rstrip())
        if img_dir.exists():
            shutil.rmtree(img_dir)
        shutil.copytree(raw, img_dir)
        job.notice("We couldn't clean the watermarks off these photos, so some may show in the world.",
                   f"listing clean-up failed: {type(e).__name__}: {e}")
        return
    for e in rep["photos"]:
        if e["action"] != "none":
            job.log(f"listing: {e['file']}: {e['action']} ({', '.join(e['found'])})")
    job.log(f"listing: {rep['cleaned']} of {len(rep['photos'])} photos had a watermark or logo removed")


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
        raise JobError("Video mode needs one video, filmed from a still, propped-up phone.", f"thirdwheel needs one video (got {names})")
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
    tw = process_video(videos[0], job.out_dir, job.work_dir, cfg, progress=job.progress, log=job.log, warn=job.warn, notice=job.notice)
    video = tw["video"]
    job.set_range(0.0, 1.0)

    world = None
    caption = None
    if fw_ok:
        try:
            world, video = _generated_room(job, tw, video)
            caption = "The room was imagined from the space behind the people in your clip."
        except Exception as e:  # the plate room is always possible
            job.warn(f"generated room failed ({e}); building the room from the plate instead")
            world = None
    if world is None:
        from plate_room import build_plate_room

        job.progress("Building the room", 0.88)
        room = build_plate_room(
            tw["plate_rgb"], tw["plate_depth"], tw["K"], job.out_dir / "world.ply",
            max_splats=int(job.params.get("maxSplats", 700_000)), log=job.log,
        )
        world = room["world"]
        video["cameraPose"] = {"position": [0.0, 0.0, 0.0], "quaternion": room["levelQuaternion"]}
        caption = "The room is built from the background of your clip."
    secs = float(video["duration"])
    length = f"{secs:.0f} seconds" if secs >= 1.5 else "1 second"
    caption = f"{caption} {length} of video{' with sound' if video['hasAudio'] else ', no sound'}."
    return {"world": world, "video": video, "thumb": "thumb.jpg", "caption": with_notices(caption, job)}


def with_notices(caption: str, job: Job) -> str:
    """The caption plus the warnings the person should see (job.notice), each its own sentence."""
    notes = [n.strip() for n in getattr(job, "notices", []) if n and n.strip()]
    return " ".join([caption.strip(), *notes]).strip()


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
        raise RuntimeError("the world model returned no world file")
    for name in (world["file"], "input_camera.json", "input_depth.npy"):
        if (room_dir / name).exists():
            shutil.copy2(room_dir / name, job.out_dir / name)
    job.progress("Lining the video up with the room", 0.96)
    video, info = align_video_to_world(video, tw["plate_depth"], tw["background"], job.out_dir, log=job.log)
    return world, video


MODES = {"rentfree": run_rentfree, "reconstruct": run_reconstruct, "thirdwheel": run_thirdwheel}
# Modes whose world comes from one input camera (the photo, the video's plate): the reality check applies.
REALITY_MODES = ("rentfree", "thirdwheel")


def reality_parts(job: Job, result: dict) -> bool:
    """Reality check: split the finished world into what the input camera saw and what the world model imagined
    (pipeline/reality_split.py writes out/world-seen.spz, out/world-imagined.spz and out/reality.json; the server
    copies every out/ file into the scene). Needs out/scene.json written first. Never fails the job."""
    if job.mode not in REALITY_MODES or not isinstance(result.get("world"), dict):
        return False
    try:
        import reality_split

        reality_split.split_scene(job.out_dir, log=job.log)
        return True
    except Exception as e:  # the world is fine without it: the viewer then says there is no reality map
        job.log(f"reality split skipped: {type(e).__name__}: {e}")
        for name in ("world-seen.spz", "world-imagined.spz", "reality.json"):
            try:
                (job.out_dir / name).unlink()
            except FileNotFoundError:
                pass
        return False


def run(jobdir: Path | str) -> int:
    """Run a job; returns the process exit code (0 = DONE)."""
    jobdir = Path(jobdir)
    try:
        job = Job(jobdir)
    except JobError as e:
        if jobdir.is_dir():
            (jobdir / "FAILED").write_text(f"{e.user}\n{e.detail}\n")
            write_json_atomic(jobdir / "progress.json", {"stage": "Failed", "error": e.user, "detail": e.detail, "done": True})
        print(f"FAILED: {e.detail}", file=sys.stderr)
        return 2
    job.clear_markers()
    t0 = time.time()
    job.log(f"job {job.id}: mode={job.mode} inputs={[p.name for p in job.input_files()]} prompt={job.prompt!r} params={job.params}")
    try:
        fn = MODES.get(job.mode)
        if fn is None:
            raise JobError("This kind of scene isn't supported.", f"unknown mode {job.mode!r} (expected rentfree, thirdwheel or reconstruct)")
        result = fn(job)
        result = {k: result[k] for k in ("world", "video", "thumb", "caption") if result.get(k) is not None}
        job.write_result(result)
        reality_parts(job, result)
        job.log(f"job {job.id}: done in {time.time() - t0:.1f}s")
        job.finish_ok()
        return 0
    except Cancelled as e:
        user, detail = "Cancelled.", str(e)
    except MemoryError:
        user, detail = explain_failure(MemoryError(), job.mode)
        detail = "ran out of memory (try a shorter clip: params.maxSeconds)"
    except Exception as e:  # JobError and MediaError carry their own product sentence; anything else is unexpected
        if not isinstance(e, JobError) and type(e).__name__ != "MediaError":
            job.log(traceback.format_exc().rstrip())
        user, detail = explain_failure(e, job.mode)
        if user == GENERIC_FAILURE.get(job.mode) and not isinstance(e, JobError):
            detail = f"internal error: {detail}"
    job.log(f"FAILED: {detail}")
    job.finish_failed(user, detail)
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
