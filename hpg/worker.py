#!/usr/bin/env python3
"""Warm GPU worker for HiPerGator: keeps FlashWorld loaded and runs jobs from $HPG_ROOT/jobs/queue/.

  python hpg/worker.py [--root $HPG_ROOT] [--idle-timeout 1200] [--job-timeout 2400]

Protocol (shared with server/hpg.ts):
  jobs/incoming/<id>/   the server uploads here, then `mv`s the directory into queue/ (atomic, same filesystem)
  jobs/queue/<id>/      waiting; the worker claims a job by renaming it into running/
  jobs/running/<id>/    progress.json is rewritten while it runs; a CANCEL file asks the worker to stop it
  jobs/done/<id>/       DONE or FAILED (with the error text) is written last, then the directory moves here
  jobs/worker.json      heartbeat {time, host, gpu, ...} every 30 s; removed when the worker exits
  jobs/worker.stop      touch it to make the worker exit after the current job
  jobs/fw-requests/     room requests from other pipelines (flashworld_run.submit_to_worker)

rentfree jobs run in this process with the warm model (seconds). thirdwheel and reconstruct jobs run
`pipeline/run_job.py <jobdir>` in their own environment; while they run, the worker answers their room requests,
so Third Wheel also gets the warm FlashWorld. The worker exits after --idle-timeout seconds without work so it
does not hold one of the class's two GPUs.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PIPELINE = REPO / "pipeline"
HEARTBEAT_SECONDS = 30.0
SETTLE_SECONDS = 2.0
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".mts", ".m2ts", ".ts", ".mpg", ".mpeg", ".flv", ".wmv"}
# Product sentences the app shows (progress.json `error`); the technical cause goes to `detail` and log.txt.
GENERIC_FAILURE = {
    "rentfree": "We couldn't build this world. Try again in a minute.",
    "thirdwheel": "We couldn't turn this video into a room. Try again in a minute.",
    "reconstruct": "We couldn't reconstruct this place. Try again in a minute.",
}
CANCELLED = "Cancelled."
TOO_LONG = "This took too long on the GPU and was stopped. Try a shorter clip."
UNSUPPORTED = "This kind of scene isn't supported."


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def log(msg: str) -> None:
    print(f"[worker] {time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def write_json_atomic(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    os.replace(tmp, path)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def gpu_name() -> str:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=20)
        line = out.stdout.strip().splitlines()[0] if out.stdout.strip() else ""
        if line:
            return line.replace(", ", " ")
    except Exception:
        pass
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return "unknown"


# --------------------------------------------------------------------------------------------------------------
# Heartbeat
# --------------------------------------------------------------------------------------------------------------


class Heartbeat:
    def __init__(self, path: Path, interval: float = HEARTBEAT_SECONDS, **fields: Any):
        self.path = path
        self.interval = interval
        self.fields: dict = {"host": socket.gethostname(), "pid": os.getpid(), "startedAt": now_iso(),
                             "slurmJobId": os.environ.get("SLURM_JOB_ID"), **fields}
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, name="heartbeat", daemon=True)

    def update(self, **fields: Any) -> None:
        with self._lock:
            self.fields.update(fields)
        self.beat()

    def beat(self) -> None:
        with self._lock:
            data = {"time": now_iso(), **self.fields}
        try:
            write_json_atomic(self.path, data)
        except OSError as e:
            log(f"heartbeat write failed: {e}")

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self.beat()

    def start(self) -> "Heartbeat":
        self.beat()
        self._thread.start()
        return self

    def stop(self, final_status: str = "stopped") -> None:
        """Stops beating and removes worker.json so the server stops routing jobs here at once."""
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5)
        with self._lock:
            data = {"time": now_iso(), **self.fields, "status": final_status}
        try:
            write_json_atomic(self.path.with_name("worker.last.json"), data)
            self.path.unlink(missing_ok=True)
        except OSError:
            pass


# --------------------------------------------------------------------------------------------------------------
# Job directories
# --------------------------------------------------------------------------------------------------------------


class JobDirs:
    def __init__(self, root: Path):
        self.jobs = root / "jobs"
        self.incoming = self.jobs / "incoming"
        self.queue = self.jobs / "queue"
        self.running = self.jobs / "running"
        self.done = self.jobs / "done"
        self.fw_requests = self.jobs / "fw-requests"
        self.stop_file = self.jobs / "worker.stop"
        for d in (self.incoming, self.queue, self.running, self.done, self.fw_requests):
            d.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _ready(d: Path, settle: float) -> bool:
        if not (d / "job.json").is_file():
            return False
        newest = d.stat().st_mtime
        for p in d.iterdir():
            try:
                newest = max(newest, p.stat().st_mtime)
            except FileNotFoundError:
                pass
        return time.time() - newest >= settle

    def candidates(self, settle: float = SETTLE_SECONDS) -> list[Path]:
        """Ready jobs, oldest first. Another worker may take any of them at any moment, so every filesystem
        call here tolerates the directory disappearing."""
        out: list[tuple[float, str, Path]] = []
        for d in self.queue.iterdir():
            if d.name.startswith(".") or d.name.endswith((".tmp", ".partial")):
                continue
            try:
                if d.is_dir() and self._ready(d, settle):
                    out.append((d.stat().st_mtime, d.name, d))
            except (FileNotFoundError, NotADirectoryError):
                continue
        return [d for _, _, d in sorted(out)]

    def claim_next(self, settle: float = SETTLE_SECONDS) -> Path | None:
        """Atomically moves the oldest ready job from queue/ to running/. Safe against other workers."""
        for d in self.candidates(settle):
            target = self.running / d.name
            if target.exists():
                self._set_aside(target)
            try:
                os.rename(d, target)
            except (FileNotFoundError, OSError):
                continue  # someone else took it (or it vanished)
            return target
        return None

    def _set_aside(self, path: Path) -> None:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        try:
            os.rename(path, path.with_name(f".{path.name}.old-{stamp}"))
        except OSError:
            shutil.rmtree(path, ignore_errors=True)

    def finish(self, run_dir: Path) -> Path:
        target = self.done / run_dir.name
        if target.exists():
            self._set_aside(target)
        os.rename(run_dir, target)
        return target

    def requeue(self, run_dir: Path) -> Path:
        target = self.queue / run_dir.name
        for marker in ("DONE", "FAILED", "CANCEL"):
            (run_dir / marker).unlink(missing_ok=True)
        os.rename(run_dir, target)
        return target


class MiniJob:
    """The subset of pipeline/common/jobio.Job the in-process path uses, for when that module is unavailable."""

    def __init__(self, jobdir: Path):
        self.dir = Path(jobdir)
        self.input_dir = self.dir / "input"
        self.out_dir = self.dir / "out"
        self.work_dir = self.dir / "work"
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.spec = read_json(self.dir / "job.json", {}) or {}
        self.id = str(self.spec.get("id") or self.dir.name)
        self.mode = str(self.spec.get("mode") or "")
        self.prompt = (self.spec.get("prompt") or "").strip() or None
        self.params = self.spec.get("params") or {}
        self._last = {"stage": "Starting", "progress": 0.0}
        self._lock = threading.Lock()

    def input_files(self) -> list[Path]:
        if not self.input_dir.is_dir():
            return []
        return sorted(p for p in self.input_dir.iterdir() if p.is_file() and not p.name.startswith("."))

    def input_images(self) -> list[Path]:
        return [p for p in self.input_files() if p.suffix.lower() in IMAGE_EXTS]

    def input_videos(self) -> list[Path]:
        return [p for p in self.input_files() if p.suffix.lower() in VIDEO_EXTS]

    def log(self, msg: str) -> None:
        with self._lock, open(self.dir / "log.txt", "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
        log(f"{self.id}: {msg}")

    def progress(self, stage: str | None = None, frac: float | None = None) -> None:
        with self._lock:
            if stage is not None:
                self._last["stage"] = stage
            if frac is not None:
                self._last["progress"] = max(self._last["progress"], round(min(max(float(frac), 0.0), 1.0), 4))
            write_json_atomic(self.dir / "progress.json", dict(self._last))

    def stage(self, stage: str, frac: float = 0.0) -> None:
        self.log(stage)
        self.progress(stage, frac)

    def clear_markers(self) -> None:
        for m in ("DONE", "FAILED"):
            (self.dir / m).unlink(missing_ok=True)

    def finish_ok(self, stage: str = "Done") -> None:
        write_json_atomic(self.dir / "progress.json", {"stage": stage, "progress": 1.0, "done": True})
        (self.dir / "DONE").write_text(time.strftime("%Y-%m-%dT%H:%M:%S%z") + "\n")

    def finish_failed(self, error: str, detail: str | None = None) -> None:
        prog = {**self._last, "error": error, "done": True}
        if detail and detail.strip() != error.strip():
            prog["detail"] = detail.strip()[:4000]
        write_json_atomic(self.dir / "progress.json", prog)
        (self.dir / "FAILED").write_text(error.strip() + (f"\n{detail.strip()}" if "detail" in prog else "") + "\n")


def open_job(jobdir: Path):
    try:
        from common.jobio import Job  # same semantics as pipeline/run_job.py

        return Job(jobdir)
    except Exception:
        return MiniJob(jobdir)


# --------------------------------------------------------------------------------------------------------------
# Worker
# --------------------------------------------------------------------------------------------------------------


class Worker:
    def __init__(
        self,
        root: Path,
        idle_timeout: float = 1200.0,
        job_timeout: float = 2400.0,
        poll: float = 2.0,
        preload: bool = True,
        pipeline_dir: Path = DEFAULT_PIPELINE,
        heartbeat_interval: float = HEARTBEAT_SECONDS,
        settle: float = SETTLE_SECONDS,
        rentfree_inprocess: bool = True,
    ):
        self.root = Path(root)
        self.dirs = JobDirs(self.root)
        self.idle_timeout = idle_timeout
        self.job_timeout = job_timeout
        self.poll = poll
        self.preload = preload
        self.pipeline_dir = Path(pipeline_dir)
        self.settle = settle
        self.rentfree_inprocess = rentfree_inprocess
        self.stopping = False
        self.jobs_done = 0
        self.fw = None  # flashworld_run module, imported lazily
        self.model_error: str | None = None
        self.heartbeat = Heartbeat(self.dirs.jobs / "worker.json", heartbeat_interval, gpu="unknown", status="starting",
                                   jobsDone=0, job=None, modelLoaded=False)
        if str(self.pipeline_dir) not in sys.path:
            sys.path.insert(0, str(self.pipeline_dir))

    # ---- lifecycle -----------------------------------------------------------------------------------------
    def request_stop(self, *_: Any) -> None:
        if not self.stopping:
            log("stop requested")
        self.stopping = True

    def _flashworld(self):
        if self.fw is None:
            import flashworld_run  # noqa: WPS433 (pipeline/ is on sys.path)

            self.fw = flashworld_run
        return self.fw

    def load_model(self) -> None:
        self.heartbeat.update(status="loading")
        t0 = time.time()
        fw = self._flashworld()
        fw.get_model().load()
        if os.environ.get("TW_PRELOAD_CAPTIONER", "1") == "1":
            fw.get_captioner()._load()
        self.heartbeat.update(modelLoaded=True, loadSeconds=round(time.time() - t0, 1))
        log(f"FlashWorld loaded in {time.time() - t0:.1f}s")

    def recover_orphans(self) -> int:
        """Jobs left in running/ by a worker that was killed (e.g. SIGKILL at the time limit) go back to the queue,
        or to done/ if they had finished. Skipped while another worker's heartbeat is fresh."""
        hb = read_json(self.dirs.jobs / "worker.json")
        if isinstance(hb, dict):
            try:
                age = time.time() - datetime.fromisoformat(str(hb.get("time", "")).replace("Z", "+00:00")).timestamp()
            except ValueError:
                age = float("inf")
            if age < 90 and hb.get("pid") != os.getpid():
                log(f"another worker looks alive ({hb.get('host')}, pid {hb.get('pid')}); not touching running/")
                return 0
        n = 0
        for d in sorted(self.dirs.running.iterdir()):
            if not d.is_dir() or d.name.startswith("."):
                continue
            try:
                if (d / "DONE").exists() or (d / "FAILED").exists():
                    self.dirs.finish(d)
                else:
                    self.dirs.requeue(d)
                    log(f"requeued {d.name}, left running by an earlier worker")
                n += 1
            except OSError as e:
                log(f"could not recover {d.name}: {e}")
        return n

    def run(self, once: bool = False) -> int:
        self.dirs.stop_file.unlink(missing_ok=True)
        self.recover_orphans()
        os.environ["TW_FW_REQUESTS"] = str(self.dirs.fw_requests)
        self.heartbeat.fields["gpu"] = gpu_name()
        self.heartbeat.start()
        log(f"worker on {self.heartbeat.fields['host']} ({self.heartbeat.fields['gpu']}), root {self.root}")
        code = 0
        try:
            if self.preload:
                try:
                    self.load_model()
                except Exception as e:
                    self.model_error = f"{type(e).__name__}: {e}"
                    traceback.print_exc()
                    log(f"FlashWorld failed to load: {self.model_error}")
                    self.heartbeat.update(status="error", error=self.model_error)
                    return 3
            last_work = time.time()
            self.heartbeat.update(status="idle", idleSince=now_iso())
            while not self.stopping:
                if self.dirs.stop_file.exists():
                    log("found worker.stop")
                    break
                worked = self.serve_fw_requests() > 0
                job = self.dirs.claim_next(self.settle)
                if job is not None:
                    self.handle(job)
                    worked = True
                if worked:
                    last_work = time.time()
                    self.heartbeat.update(status="idle", idleSince=now_iso(), job=None, jobsDone=self.jobs_done)
                    if once:
                        break
                    continue
                if time.time() - last_work > self.idle_timeout:
                    log(f"idle for {self.idle_timeout:.0f}s, exiting to free the GPU")
                    break
                time.sleep(self.poll)
        finally:
            self.heartbeat.stop("stopped")
            log(f"worker exiting after {self.jobs_done} job(s)")
        return code

    # ---- jobs -------------------------------------------------------------------------------------------------
    def handle(self, run_dir: Path) -> None:
        spec = read_json(run_dir / "job.json", {}) or {}
        job_id, mode = run_dir.name, str(spec.get("mode") or "")
        log(f"claimed {job_id} ({mode})")
        self.heartbeat.update(status="busy", job=job_id, mode=mode)
        t0 = time.time()
        requeued = False
        try:
            for m in ("DONE", "FAILED"):
                (run_dir / m).unlink(missing_ok=True)
            if (run_dir / "CANCEL").exists():
                self._fail(run_dir, CANCELLED, "Cancelled before it started")
            elif mode == "rentfree" and self.rentfree_inprocess and self.model_error is None:
                self.run_rentfree(run_dir)
            elif mode in ("rentfree", "thirdwheel", "reconstruct"):
                requeued = self.run_subprocess(run_dir, mode)
            else:
                self._fail(run_dir, UNSUPPORTED, f"Unknown job mode {mode!r}")
        except Exception as e:
            traceback.print_exc()
            self._fail(run_dir, GENERIC_FAILURE.get(mode, GENERIC_FAILURE["rentfree"]), f"Worker error: {type(e).__name__}: {e}")
        finally:
            if requeued:
                log(f"{job_id} returned to the queue")
            else:
                if not ((run_dir / "DONE").exists() or (run_dir / "FAILED").exists()):
                    self._fail(run_dir, GENERIC_FAILURE.get(mode, GENERIC_FAILURE["rentfree"]), "The job ended without a result")
                self.dirs.finish(run_dir)
                self.jobs_done += 1
                ok = (self.dirs.done / job_id / "DONE").exists()
                log(f"{job_id} {'done' if ok else 'failed'} in {time.time() - t0:.1f}s")

    @staticmethod
    def _fail(run_dir: Path, error: str, detail: str | None = None) -> None:
        """`error` is the product sentence the app shows; `detail` is the technical cause (log and progress.json)."""
        prog = read_json(run_dir / "progress.json", {}) or {}
        out = {"stage": prog.get("stage", "Failed"), "progress": prog.get("progress", 0.0), "error": error, "done": True}
        if detail and detail.strip() != error.strip():
            out["detail"] = detail.strip()[:4000]
        write_json_atomic(run_dir / "progress.json", out)
        (run_dir / "FAILED").write_text(error.strip() + (f"\n{detail.strip()}" if "detail" in out else "") + "\n")
        with open(run_dir / "log.txt", "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] FAILED: {detail or error}\n")

    def run_rentfree(self, run_dir: Path) -> None:
        """Runs a Rent Free job in this process with the warm model."""
        fw = self._flashworld()
        job = open_job(run_dir)
        job.clear_markers()
        try:
            job.stage("Starting on the GPU", 0.01)
            images, videos = job.input_images(), job.input_videos()
            image = None
            if images:
                image = fw.pick_best_image(images)
                job.log(f"input photo: {image.name} (of {len(images)})")
            elif videos:
                job.progress("Picking the best frame of the video", 0.03)
                image = fw.best_video_frame(videos[0], job.work_dir / "frame.png")
                job.log(f"input frame from {videos[0].name}")
            prompt = job.prompt
            if image is None and not prompt:
                raise _ProductError("Photo mode needs a photo, a video or a prompt.", "No photo, video or prompt in the job")
            kw = fw.kwargs_from_params(job.params)
            if "seed" not in kw:
                kw["seed"] = int(job.params.get("attempt") or 0)
            prog = fw.sio.Progress(lambda stage, value: job.progress(stage, value))
            result = fw.generate(image, prompt, job.out_dir, prog, **kw)
            if not images and videos:  # a frame of a clip, not a photo: say so in the gallery caption
                result["caption"] = "Generated from the sharpest frame of your clip: the rest of the room was imagined."
                write_json_atomic(job.out_dir / "scene.json", result)
            self.reality_parts(job)
            diag = read_json(job.out_dir / "flashworld.json", {}) or {}
            job.log(f"world: {result['world']['splatCount']} splats, floor {'found' if result['world']['floorY'] is not None else 'not found'}, "
                    f"generation {diag.get('generateSeconds')}s, total {diag.get('totalSeconds')}s")
            job.finish_ok()
        except Exception as e:
            traceback.print_exc()
            job.log(traceback.format_exc())
            user, detail = _explain(e, "rentfree")
            try:
                job.finish_failed(user, detail)
            except TypeError:  # an older Job without a detail argument
                job.finish_failed(f"{user}\n{detail}")

    @staticmethod
    def reality_parts(job) -> bool:
        """Reality check parts next to the world (out/world-seen.spz, out/world-imagined.spz, out/reality.json), the
        same step pipeline/run_job.py runs. Reads out/scene.json, so it runs after the result is written. Never fails
        the job: without the parts the viewer only says there is no reality map."""
        try:
            import reality_split  # noqa: WPS433 (pipeline/ is on sys.path)

            reality_split.split_scene(job.out_dir, log=job.log)
            return True
        except Exception as e:
            job.log(f"reality split skipped: {type(e).__name__}: {e}")
            for name in ("world-seen.spz", "world-imagined.spz", "reality.json"):
                (job.out_dir / name).unlink(missing_ok=True)
            return False

    def python_for(self, mode: str) -> str:
        env = {"thirdwheel": "TW_PY_VIDEO", "reconstruct": "TW_PY_ANYSPLAT", "rentfree": "TW_PY_FLASHWORLD"}.get(mode)
        py = os.environ.get(env or "", "")
        return py if py and Path(py).exists() else sys.executable

    def run_subprocess(self, run_dir: Path, mode: str) -> bool:
        """Runs pipeline/run_job.py for the job. Returns True if the job was put back in the queue."""
        script = self.pipeline_dir / "run_job.py"
        if not script.exists():
            self._fail(run_dir, GENERIC_FAILURE.get(mode, GENERIC_FAILURE["rentfree"]), f"{script} is missing on HiPerGator (sync the repo)")
            return False
        cmd = [self.python_for(mode), "-u", str(script), str(run_dir)]
        env = dict(os.environ, PYTHONUNBUFFERED="1", TW_FW_REQUESTS=str(self.dirs.fw_requests))
        console = open(run_dir / "console.txt", "ab")
        log(f"running {' '.join(cmd)}")
        proc = subprocess.Popen(cmd, cwd=str(self.pipeline_dir), stdout=console, stderr=subprocess.STDOUT, env=env,
                                start_new_session=True)
        t0 = time.time()
        reason = None
        user = GENERIC_FAILURE.get(mode, GENERIC_FAILURE["rentfree"])
        try:
            while proc.poll() is None:
                self.serve_fw_requests()
                if (run_dir / "CANCEL").exists():
                    reason = "Cancelled"
                elif time.time() - t0 > self.job_timeout:
                    reason = f"Timed out after {self.job_timeout / 60:.0f} min on the worker"
                    user = TOO_LONG
                elif self.stopping:
                    reason = "requeue"
                if reason:
                    _kill_group(proc)
                    break
                time.sleep(0.5)
        finally:
            console.close()
        if reason == "requeue":
            self.dirs.requeue(run_dir)
            return True
        if reason:
            self._fail(run_dir, CANCELLED if reason == "Cancelled" else user, reason)
            return False
        if not ((run_dir / "DONE").exists() or (run_dir / "FAILED").exists()):
            tail = _tail(run_dir / "console.txt", 12)
            self._fail(run_dir, GENERIC_FAILURE.get(mode, GENERIC_FAILURE["rentfree"]),
                       f"run_job.py exited with code {proc.returncode} without a result\n{tail}")
        return False

    # ---- room requests from other pipelines ---------------------------------------------------------------------
    def serve_fw_requests(self) -> int:
        n = 0
        try:
            entries = sorted(self.dirs.fw_requests.iterdir())
        except FileNotFoundError:
            return 0
        for d in entries:
            if not d.is_dir() or d.name.startswith("."):
                continue
            if any((d / m).exists() for m in ("CLAIMED", "DONE", "FAILED")):
                if time.time() - d.stat().st_mtime > 86400:
                    shutil.rmtree(d, ignore_errors=True)
                continue
            try:
                (d / "CLAIMED").touch(exist_ok=False)
            except FileExistsError:
                continue
            n += 1
            req = read_json(d / "request.json", {}) or {}
            log(f"room request {d.name}")
            prev = self.heartbeat.fields.get("status")
            self.heartbeat.update(status="busy", request=d.name)
            try:
                if self.model_error:
                    raise RuntimeError(f"FlashWorld is not available on this worker: {self.model_error}")
                fw = self._flashworld()
                kw = fw.kwargs_from_params(req.get("params") or {})
                result = fw.generate(req.get("image"), req.get("prompt"), req["out_dir"], str(d / "progress.json"), **kw)
                write_json_atomic(d / "result.json", result)
                (d / "DONE").touch()
            except Exception as e:
                traceback.print_exc()
                (d / "FAILED").write_text(_user_error(e) + "\n")
            finally:
                self.heartbeat.update(status=prev, request=None)
        return n


class _ProductError(RuntimeError):
    """A failure with a product sentence (`user`) for the app and a technical message for the log."""

    def __init__(self, user: str, detail: str):
        super().__init__(detail)
        self.user = user


def _explain(e: BaseException, mode: str) -> tuple[str, str]:
    """(product sentence, technical detail) of a failure; the pipeline's own explain_failure when importable."""
    try:
        from common.jobio import explain_failure  # pipeline/ is on sys.path

        return explain_failure(e, mode)
    except ImportError:
        detail = str(e).strip() or type(e).__name__
        user = getattr(e, "user", None)
        if "out of memory" in detail.lower():
            user = "This one needed more memory than we had. Try a shorter clip or a smaller photo."
        return (user or GENERIC_FAILURE.get(mode, GENERIC_FAILURE["rentfree"])), detail


def _user_error(e: BaseException) -> str:
    msg = str(e).strip() or type(e).__name__
    if "out of memory" in msg.lower():
        return f"The GPU ran out of memory ({msg.splitlines()[0][:200]})"
    return msg if len(msg) < 2000 else msg[:2000] + "..."


def _kill_group(proc: subprocess.Popen, grace: float = 10.0) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait(timeout=5)


def _tail(path: Path, n: int) -> str:
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-n:])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ThirdWheel warm GPU worker")
    ap.add_argument("--root", default=os.environ.get("HPG_ROOT", "/blue/phz3152/sbernalorta/thirdwheel"))
    ap.add_argument("--idle-timeout", type=float, default=float(os.environ.get("TW_WORKER_IDLE", "1200")),
                    help="exit after this many seconds without work")
    ap.add_argument("--job-timeout", type=float, default=float(os.environ.get("TW_JOB_TIMEOUT", "2400")))
    ap.add_argument("--poll", type=float, default=2.0)
    ap.add_argument("--no-preload", action="store_true", help="load FlashWorld on the first rentfree job instead of at start")
    ap.add_argument("--once", action="store_true", help="exit after the first job (testing)")
    args = ap.parse_args(argv)
    w = Worker(Path(args.root), args.idle_timeout, args.job_timeout, args.poll, preload=not args.no_preload)
    signal.signal(signal.SIGTERM, w.request_stop)
    signal.signal(signal.SIGINT, w.request_stop)
    if hasattr(signal, "SIGUSR1"):
        signal.signal(signal.SIGUSR1, w.request_stop)  # sbatch --signal=USR1@120 before the time limit
    return w.run(once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
