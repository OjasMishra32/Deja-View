"""Job directory I/O: job.json, progress.json (JobProgress), log.txt, DONE/FAILED markers.

Layout (docs/ARCHITECTURE.md):
  <jobdir>/job.json      {"id", "mode", "prompt"?, "params": {...}}
  <jobdir>/input/        inputs
  <jobdir>/out/          outputs; out/scene.json is a JobResult
  <jobdir>/progress.json JobProgress, rewritten as the job runs
  <jobdir>/DONE|FAILED   written last
  <jobdir>/log.txt       appended
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

# Every container the server accepts (server/media.ts VIDEO_EXT): recorded game clips are often .ts or .m2ts.
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".mts", ".m2ts", ".ts", ".mpg", ".mpeg", ".flv", ".wmv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".avif"}


def write_json_atomic(path: Path | str, data: Any) -> None:
    """Write JSON through a temp file + rename so readers never see a partial file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w") as f:
            json.dump(_jsonable(data), f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _jsonable(x: Any) -> Any:
    """Convert numpy scalars/arrays and tuples to plain JSON types; reject NaN/inf."""
    try:
        import numpy as np
    except Exception:  # pragma: no cover
        np = None
    if isinstance(x, dict):
        return {str(k): _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    if np is not None:
        if isinstance(x, np.ndarray):
            return [_jsonable(v) for v in x.tolist()]
        if isinstance(x, np.generic):
            x = x.item()
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError("non-finite number in JSON output")
        return float(round(x, 6))
    return x


def read_json(path: Path | str, default: Any = None) -> Any:
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


class JobError(RuntimeError):
    """A failure the app can explain.

    `user` is one short product sentence shown in the app (no tool, model or service names, no paths);
    `detail` is the technical cause and only goes to log.txt and progress.json `detail`. str(e) is the detail.
    """

    def __init__(self, user: str, detail: str | None = None):
        super().__init__(detail or user)
        self.user = user
        self.detail = detail or user


# What the app says when a step failed without a more specific reason (server/copy.ts GENERIC_FAILURE says the same).
GENERIC_FAILURE = {
    "rentfree": "We couldn't build this world. Try again in a minute.",
    "thirdwheel": "We couldn't turn this video into a room. Try again in a minute.",
    "reconstruct": "We couldn't reconstruct this place. Try again in a minute.",
}
OUT_OF_MEMORY = "This one needed more memory than we had. Try a shorter clip or a smaller photo."
UNREADABLE_MEDIA = "We couldn't read this file. Export it again and upload it once more."


def explain_failure(e: BaseException, mode: str = "") -> tuple[str, str]:
    """(product sentence for the app, technical detail for the log) for any exception a job can raise."""
    detail = str(e).strip() or type(e).__name__
    if isinstance(e, JobError):
        return e.user, e.detail
    if isinstance(e, MemoryError) or "out of memory" in detail.lower():
        return OUT_OF_MEMORY, detail if detail != "MemoryError" else "ran out of memory"
    user = getattr(e, "user", None)  # common.media.MediaError carries one
    if isinstance(user, str) and user.strip():
        return user.strip(), detail
    if type(e).__name__ == "MediaError":
        return UNREADABLE_MEDIA, detail
    if not isinstance(e, RuntimeError) or type(e) is not RuntimeError:
        detail = f"{type(e).__name__}: {detail}"
    return GENERIC_FAILURE.get(mode, "Something went wrong. Try again in a minute."), detail


class Job:
    """Handle on a job directory. All writers are safe to call from several threads."""

    def __init__(self, jobdir: Path | str, echo: bool = True):
        self.dir = Path(jobdir).resolve()
        if not self.dir.is_dir():
            raise JobError("We couldn't start this job. Try again.", f"job directory not found: {self.dir}")
        self.input_dir = self.dir / "input"
        self.out_dir = self.dir / "out"
        self.work_dir = self.dir / "work"
        self.progress_path = self.dir / "progress.json"
        self.log_path = self.dir / "log.txt"
        self.echo = echo
        self._lock = threading.Lock()
        self._range = (0.0, 1.0)
        self._last = {"stage": "Starting", "progress": 0.0}
        self.notices: list[str] = []
        spec = read_json(self.dir / "job.json")
        if not isinstance(spec, dict):
            raise JobError("We couldn't start this job. Try again.", f"missing or invalid job.json in {self.dir}")
        self.spec: dict = spec
        self.id: str = str(spec.get("id") or self.dir.name)
        self.mode: str = str(spec.get("mode") or "")
        self.prompt: str | None = (spec.get("prompt") or "").strip() or None
        self.params: dict = spec.get("params") or {}
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)

    # ---- inputs ---------------------------------------------------------
    def input_files(self) -> list[Path]:
        """Uploaded media in input/ (input/meta.json, written by the server, is not an input)."""
        if not self.input_dir.is_dir():
            return []
        return sorted(
            p for p in self.input_dir.iterdir() if p.is_file() and not p.name.startswith(".") and p.name != "meta.json"
        )

    def input_meta(self, name: str) -> dict:
        """Per-file facts the server recorded in input/meta.json (source name, focal35, ...)."""
        meta = read_json(self.input_dir / "meta.json", {}) or {}
        entry = meta.get(name) if isinstance(meta, dict) else None
        return entry if isinstance(entry, dict) else {}

    def input_videos(self) -> list[Path]:
        return [p for p in self.input_files() if p.suffix.lower() in VIDEO_EXTS]

    def input_images(self) -> list[Path]:
        return [p for p in self.input_files() if p.suffix.lower() in IMAGE_EXTS]

    # ---- log --------------------------------------------------------------
    def log(self, msg: str) -> None:
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        with self._lock:
            with open(self.log_path, "a") as f:
                f.write(line + "\n")
        if self.echo:
            print(line, file=sys.stderr, flush=True)

    def warn(self, msg: str) -> None:
        self.log(f"WARNING: {msg}")

    def notice(self, user: str, detail: str | None = None) -> None:
        """A warning the person should see (it ends up in the scene caption), e.g. "Nobody was found moving in this
        clip." `detail` (technical) goes to the log only."""
        self.log(f"WARNING: {detail or user}")
        with self._lock:
            if user not in self.notices:
                self.notices.append(user)

    # ---- progress ---------------------------------------------------------
    def set_range(self, lo: float, hi: float) -> None:
        """Map subsequent progress(0..1) calls into [lo, hi] of the whole job."""
        self._range = (float(lo), float(hi))

    def _write_progress(self, stage: str | None, p_abs: float | None) -> None:
        with self._lock:
            if stage is not None:
                self._last["stage"] = stage
            if p_abs is not None:
                p = min(max(float(p_abs), 0.0), 1.0)
                self._last["progress"] = max(self._last.get("progress", 0.0), round(p, 4))
            write_json_atomic(self.progress_path, dict(self._last))

    def progress(self, stage: str | None = None, frac: float | None = None) -> None:
        """Report progress of the current range: frac in 0..1 maps into [lo, hi] of the job."""
        lo, hi = self._range
        p_abs = None if frac is None else lo + (hi - lo) * min(max(float(frac), 0.0), 1.0)
        self._write_progress(stage, p_abs)

    def stage(self, stage: str, frac: float = 0.0) -> None:
        self.log(stage)
        self.progress(stage, frac)

    def subprogress(self, lo: float, hi: float) -> Callable[[str | None, float | None], None]:
        """Callback for a sub-step reporting 0..1, mapped into [lo, hi] of the current range."""
        base_lo, base_hi = self._range

        def cb(stage: str | None = None, frac: float | None = None) -> None:
            if frac is None:
                self._write_progress(stage, None)
                return
            f = lo + (hi - lo) * min(max(float(frac), 0.0), 1.0)
            self._write_progress(stage, base_lo + (base_hi - base_lo) * f)

        return cb

    # ---- results ----------------------------------------------------------
    def write_result(self, result: dict) -> None:
        write_json_atomic(self.out_dir / "scene.json", result)

    def clear_markers(self) -> None:
        for name in ("DONE", "FAILED"):
            try:
                (self.dir / name).unlink()
            except FileNotFoundError:
                pass

    def finish_ok(self, stage: str = "Done") -> None:
        with self._lock:
            self._last = {"stage": stage, "progress": 1.0, "done": True}
            write_json_atomic(self.progress_path, self._last)
        (self.dir / "DONE").write_text(time.strftime("%Y-%m-%dT%H:%M:%S%z") + "\n")

    def finish_failed(self, error: str, detail: str | None = None) -> None:
        """`error` is the product sentence the app shows; `detail` (technical) is kept next to it for the log."""
        with self._lock:
            self._last = {
                "stage": self._last.get("stage", "Failed"),
                "progress": self._last.get("progress", 0.0),
                "error": error,
                "done": True,
            }
            if detail and detail.strip() and detail.strip() != error.strip():
                self._last["detail"] = detail.strip()[:4000]
            write_json_atomic(self.progress_path, self._last)
        text = error.strip() if not detail or detail.strip() == error.strip() else f"{error.strip()}\n{detail.strip()}"
        (self.dir / "FAILED").write_text(text + "\n")


class ChildProgressRelay:
    """Polls a child process' progress.json and forwards it into the job's progress range."""

    def __init__(self, path: Path, cb: Callable[[str | None, float | None], None], prefix: str = "", interval: float = 1.0):
        self.path = Path(path)
        self.cb = cb
        self.prefix = prefix
        self.interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._seen: tuple | None = None

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)
        self._poll()

    def _poll(self) -> None:
        data = read_json(self.path)
        if not isinstance(data, dict):
            return
        key = (data.get("stage"), data.get("progress"))
        if key == self._seen:
            return
        self._seen = key
        stage = data.get("stage")
        if stage and self.prefix:
            stage = f"{self.prefix}: {stage}"
        prog = data.get("progress")
        self.cb(stage, float(prog) if isinstance(prog, (int, float)) else None)

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self._poll()
            except Exception:
                pass
