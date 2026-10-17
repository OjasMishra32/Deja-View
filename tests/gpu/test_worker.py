"""Tests for hpg/worker.py with a temporary $HPG_ROOT, a fake FlashWorld and fake run_job.py scripts."""
from __future__ import annotations

import json
import os
import sys
import textwrap
import threading
import time
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

import splat_io as sio
import worker as W


def make_job(root: Path, job_id: str, mode: str = "rentfree", prompt: str | None = None, files=("00.jpg",), params=None,
             where: str = "queue", age: float = 10.0) -> Path:
    d = root / "jobs" / where / job_id
    (d / "input").mkdir(parents=True)
    for f in files:
        (d / "input" / f).write_bytes(b"\xff\xd8 fake")
    spec = {"id": job_id, "mode": mode, "params": params or {}}
    if prompt:
        spec["prompt"] = prompt
    (d / "job.json").write_text(json.dumps(spec))
    old = time.time() - age
    for p in [d, *d.rglob("*")]:
        os.utime(p, (old, old))
    return d


class FakeFW:
    """Stands in for pipeline/flashworld_run.py."""

    sio = sio

    def __init__(self, fail: str | None = None):
        self.calls = []
        self.fail = fail

    def get_model(self):
        return types.SimpleNamespace(load=lambda: None)

    def get_captioner(self):
        return types.SimpleNamespace(_load=lambda: False)

    def pick_best_image(self, paths):
        return Path(paths[0])

    def best_video_frame(self, video, out):
        Path(out).write_bytes(b"png")
        return Path(out)

    def kwargs_from_params(self, params):
        return {k: v for k, v in (params or {}).items() if k in ("seed",)}

    def generate(self, image, prompt, out_dir, progress=None, **kw):
        self.calls.append({"image": str(image) if image else None, "prompt": prompt, "out": str(out_dir), **kw})
        if callable(progress):
            progress("Generating the world", 0.5)
        elif isinstance(progress, str):
            sio.write_json_atomic(progress, {"stage": "Generating the world", "progress": 0.5})
        if self.fail:
            raise RuntimeError(self.fail)
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        res = {"world": {"file": "world.spz", "splatCount": 10, "floorY": 0.0}, "thumb": "thumb.jpg"}
        sio.write_json_atomic(Path(out_dir) / "scene.json", res)
        sio.write_json_atomic(Path(out_dir) / "flashworld.json", {"generateSeconds": 1.0, "totalSeconds": 2.0})
        return res


def make_worker(tmp_path: Path, fw=None, pipeline: Path | None = None, **kw) -> W.Worker:
    w = W.Worker(tmp_path, idle_timeout=kw.pop("idle_timeout", 0.5), poll=0.05, preload=kw.pop("preload", False),
                 pipeline_dir=pipeline or (tmp_path / "pipeline"), heartbeat_interval=kw.pop("heartbeat_interval", 0.2),
                 settle=kw.pop("settle", 0.0), **kw)
    w.fw = fw or FakeFW()
    return w


def write_run_job(pipeline: Path, body: str) -> None:
    pipeline.mkdir(parents=True, exist_ok=True)
    (pipeline / "run_job.py").write_text(textwrap.dedent(body))


# ---------------------------------------------------------------------------------------------------- claiming


def test_claim_order_skips_unready(tmp_path):
    dirs = W.JobDirs(tmp_path)
    make_job(tmp_path, "b", age=20)
    make_job(tmp_path, "a", age=30)
    make_job(tmp_path, "fresh", age=0)  # still settling
    (dirs.queue / ".uploading").mkdir()
    (dirs.queue / "nojson").mkdir()
    first = dirs.claim_next(settle=5)
    assert first == dirs.running / "a" and (first / "job.json").exists()
    assert dirs.claim_next(settle=5) == dirs.running / "b"
    assert dirs.claim_next(settle=5) is None
    assert dirs.claim_next(settle=0) == dirs.running / "fresh"


def test_concurrent_claims_never_double_claim(tmp_path):
    dirs = W.JobDirs(tmp_path)
    for i in range(40):
        make_job(tmp_path, f"job{i:02d}")
    claimed: list[Path] = []
    lock = threading.Lock()

    def grab():
        d2 = W.JobDirs(tmp_path)
        while True:
            j = d2.claim_next(settle=0)
            if j is None:
                return
            with lock:
                claimed.append(j.name)

    threads = [threading.Thread(target=grab) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(claimed) == [f"job{i:02d}" for i in range(40)]
    assert len(set(claimed)) == 40
    assert not list(dirs.queue.iterdir())


def test_finish_and_requeue(tmp_path):
    dirs = W.JobDirs(tmp_path)
    make_job(tmp_path, "x")
    run = dirs.claim_next(settle=0)
    (run / "FAILED").write_text("x")
    back = dirs.requeue(run)
    assert back == dirs.queue / "x" and not (back / "FAILED").exists()
    run = dirs.claim_next(settle=0)
    done = dirs.finish(run)
    assert done == dirs.done / "x"
    make_job(tmp_path, "x", where="running")
    dirs.finish(dirs.running / "x")  # a second result for the same id keeps the old one aside
    assert (dirs.done / "x").exists() and any(p.name.startswith(".x.old-") for p in dirs.done.iterdir())


# ---------------------------------------------------------------------------------------------------- running jobs


def test_rentfree_in_process(tmp_path):
    fw = FakeFW()
    w = make_worker(tmp_path, fw)
    make_job(tmp_path, "rf1", files=("00.jpg", "01.jpg"), params={"seed": 7})
    make_job(tmp_path, "rf2", prompt="a castle hall", files=())
    assert w.run() == 0
    for jid in ("rf1", "rf2"):
        d = tmp_path / "jobs" / "done" / jid
        assert (d / "DONE").exists(), (d / "log.txt").read_text() if (d / "log.txt").exists() else ""
        assert json.loads((d / "out" / "scene.json").read_text())["world"]["file"] == "world.spz"
        prog = json.loads((d / "progress.json").read_text())
        assert prog["done"] is True and prog["progress"] == 1.0
    assert fw.calls[0]["image"].endswith("00.jpg") and fw.calls[0]["seed"] == 7
    assert fw.calls[1]["image"] is None and fw.calls[1]["prompt"] == "a castle hall"
    assert not (tmp_path / "jobs" / "worker.json").exists()
    last = json.loads((tmp_path / "jobs" / "worker.last.json").read_text())
    assert last["status"] == "stopped" and last["jobsDone"] == 2


def test_rentfree_failure_is_reported(tmp_path):
    w = make_worker(tmp_path, FakeFW(fail="CUDA error: out of memory"))
    make_job(tmp_path, "boom")
    w.run()
    d = tmp_path / "jobs" / "done" / "boom"
    assert (d / "FAILED").exists() and not (d / "DONE").exists()
    assert "out of memory" in (d / "FAILED").read_text()
    assert json.loads((d / "progress.json").read_text())["error"]


def test_empty_job_fails_cleanly(tmp_path):
    w = make_worker(tmp_path)
    make_job(tmp_path, "empty", files=())
    w.run()
    assert "No photo" in (tmp_path / "jobs" / "done" / "empty" / "FAILED").read_text()


def test_subprocess_job_success_and_env(tmp_path):
    pipe = tmp_path / "pipeline"
    write_run_job(pipe, """
        import json, os, sys, pathlib
        d = pathlib.Path(sys.argv[1])
        (d / "out").mkdir(exist_ok=True)
        (d / "out" / "scene.json").write_text(json.dumps({"fw": os.environ.get("TW_FW_REQUESTS")}))
        print("hello from run_job")
        (d / "DONE").write_text("ok")
    """)
    w = make_worker(tmp_path, pipeline=pipe)
    make_job(tmp_path, "tw1", mode="thirdwheel", files=("video.mp4",))
    w.run()
    d = tmp_path / "jobs" / "done" / "tw1"
    assert (d / "DONE").exists()
    assert json.loads((d / "out" / "scene.json").read_text())["fw"] == str(tmp_path / "jobs" / "fw-requests")
    assert "hello from run_job" in (d / "console.txt").read_text()


def test_subprocess_crash_writes_failed_with_tail(tmp_path):
    pipe = tmp_path / "pipeline"
    write_run_job(pipe, """
        import sys
        print("loading video depth model")
        raise SystemExit("ImportError: no module named video_depth_anything")
    """)
    w = make_worker(tmp_path, pipeline=pipe)
    make_job(tmp_path, "tw2", mode="reconstruct")
    w.run()
    failed = (tmp_path / "jobs" / "done" / "tw2" / "FAILED").read_text()
    assert "exited with code 1" in failed and "video_depth_anything" in failed


def test_cancel_kills_a_running_subprocess(tmp_path):
    pipe = tmp_path / "pipeline"
    write_run_job(pipe, """
        import time
        time.sleep(60)
    """)
    w = make_worker(tmp_path, pipeline=pipe)
    make_job(tmp_path, "slow", mode="thirdwheel")

    def cancel_soon():
        run = tmp_path / "jobs" / "running" / "slow"
        for _ in range(100):
            if run.exists():
                (run / "CANCEL").touch()
                return
            time.sleep(0.05)

    th = threading.Thread(target=cancel_soon)
    th.start()
    t0 = time.time()
    w.run()
    th.join()
    assert time.time() - t0 < 30
    assert "Cancelled" in (tmp_path / "jobs" / "done" / "slow" / "FAILED").read_text()


def test_stop_requeues_a_running_subprocess(tmp_path):
    pipe = tmp_path / "pipeline"
    write_run_job(pipe, """
        import time
        time.sleep(60)
    """)
    w = make_worker(tmp_path, pipeline=pipe, idle_timeout=30)
    make_job(tmp_path, "long", mode="thirdwheel")
    threading.Timer(1.0, w.request_stop).start()
    w.run()
    assert (tmp_path / "jobs" / "queue" / "long" / "job.json").exists()
    assert not (tmp_path / "jobs" / "done" / "long").exists()


def test_unknown_mode(tmp_path):
    w = make_worker(tmp_path)
    make_job(tmp_path, "odd", mode="sample")
    w.run()
    assert "Unknown job mode" in (tmp_path / "jobs" / "done" / "odd" / "FAILED").read_text()


def test_missing_run_job_is_a_clear_error(tmp_path):
    w = make_worker(tmp_path, pipeline=tmp_path / "nope")
    make_job(tmp_path, "r1", mode="reconstruct")
    w.run()
    assert "run_job.py is missing" in (tmp_path / "jobs" / "done" / "r1" / "FAILED").read_text()


# ---------------------------------------------------------------------------------------------------- heartbeat, stop, requests


def test_heartbeat_is_fresh_while_running(tmp_path):
    w = make_worker(tmp_path, idle_timeout=1.5, heartbeat_interval=0.1)
    beats = []

    def watch():
        p = tmp_path / "jobs" / "worker.json"
        for _ in range(10):
            time.sleep(0.1)
            d = W.read_json(p)
            if d:
                beats.append(d)

    th = threading.Thread(target=watch)
    th.start()
    w.run()
    th.join()
    assert beats, "no heartbeat seen"
    b = beats[-1]
    assert {"time", "host", "gpu", "status", "pid"} <= set(b)
    t = datetime.strptime(b["time"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    assert abs((datetime.now(timezone.utc) - t).total_seconds()) < 5
    assert b["status"] in ("idle", "busy", "starting", "loading")


def test_stop_file_and_stale_stop_file(tmp_path):
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / "worker.stop").touch()  # left over from an earlier stop: ignored at start
    w = make_worker(tmp_path, idle_timeout=30)
    threading.Timer(0.5, lambda: (jobs / "worker.stop").touch()).start()
    t0 = time.time()
    w.run()
    assert time.time() - t0 < 10


def test_room_requests_are_served(tmp_path):
    fw = FakeFW()
    w = make_worker(tmp_path, fw)
    rq = tmp_path / "jobs" / "fw-requests"
    rq.mkdir(parents=True, exist_ok=True)
    d = rq / "123-1"
    d.mkdir()
    (d / "request.json").write_text(json.dumps({"image": "/x/plate.jpg", "prompt": None, "out_dir": str(tmp_path / "room"), "params": {"seed": 2}}))
    assert w.serve_fw_requests() == 1
    assert (d / "DONE").exists() and (d / "CLAIMED").exists()
    assert json.loads((d / "result.json").read_text())["world"]["file"] == "world.spz"
    assert fw.calls[0]["seed"] == 2
    assert w.serve_fw_requests() == 0  # not served twice


def test_orphans_from_a_killed_worker_are_recovered(tmp_path):
    fw = FakeFW()
    make_job(tmp_path, "orphan", where="running")
    finished = make_job(tmp_path, "finished", where="running")
    (finished / "DONE").write_text("ok")
    w = make_worker(tmp_path, fw)
    w.run()
    assert (tmp_path / "jobs" / "done" / "finished" / "DONE").exists()
    assert (tmp_path / "jobs" / "done" / "orphan" / "DONE").exists()  # requeued, then run
    assert len(fw.calls) == 1


def test_orphans_left_alone_while_another_worker_beats(tmp_path):
    make_job(tmp_path, "theirs", where="running")
    W.write_json_atomic(tmp_path / "jobs" / "worker.json", {"time": W.now_iso(), "host": "other", "pid": -1})
    w = make_worker(tmp_path)
    assert w.recover_orphans() == 0
    assert (tmp_path / "jobs" / "running" / "theirs").exists()


def test_preload_failure_exits_with_error(tmp_path):
    class Broken(FakeFW):
        def get_model(self):
            def boom():
                raise RuntimeError("gsplat is not installed")
            return types.SimpleNamespace(load=boom)

    w = make_worker(tmp_path, Broken(), preload=True)
    assert w.run() == 3
    last = json.loads((tmp_path / "jobs" / "worker.last.json").read_text())
    assert "gsplat" in last["error"]
