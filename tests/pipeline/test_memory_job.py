"""One command for a video memory (team/shivin.md Update 19, job 3): clip facts, the window cut (frames and poses),
the plan (dependencies, one GPU at a time, splitting under the caps), the code snapshot's import check, the Slurm
scripts and submission, the output checks and the install. ffprobe, ffmpeg and sbatch are stood in for."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import pipeline_helpers  # noqa: F401
import memory_job as M

HLG = {"streams": [{"codec_type": "video", "avg_frame_rate": "30/1", "duration": "20.0", "width": 1920,
                    "height": 1080, "pix_fmt": "yuv420p10le", "color_transfer": "arib-std-b67",
                    "color_primaries": "bt2020", "color_space": "bt2020nc"}, {"codec_type": "audio"}]}
SDR = {"streams": [{"codec_type": "video", "avg_frame_rate": "30000/1001", "duration": "20.0", "width": 1920,
                    "height": 1080, "pix_fmt": "yuv420p", "color_transfer": "bt709"}]}


def poses_doc(seconds=20.0, fps=30.0, key_every=5):
    n = int(seconds * fps)
    track = [{"frameIndex": i, "time": round(i / fps, 6), "position": [0, 1.5, i * 0.01],
              "quaternion": [0, 0, 0, 1], "extrapolated": False} for i in range(n)]
    keys = [dict(t) for t in track[::key_every]]
    return {"source": "IMG_7398.mov", "intrinsics": {"fx": 1500}, "video": {"fps": fps, "frames": n, "duration": seconds},
            "keyframes": keys, "track": track}


def plan(tmp, seconds=12.0, people=2, facts=None):
    facts = facts or M.clip_facts(HLG)
    return M.make_plan(Path("/clips/IMG_7398.mov"), 2.0, 2.0 + seconds, Path("/scenes/chess-room"), "chess-match",
                       "Giant chess", tmp / "job", people, facts, Path("/scenes/chess-room/IMG_7398-poses.json"))


def ancestors(p, name):
    by = {s.name: s for s in p.steps}
    out, todo = set(), list(by[name].after)
    while todo:
        a = todo.pop()
        if a not in out:
            out.add(a)
            todo += by[a].after
    return out


def test_clip_facts_tell_hdr_from_sdr():
    h, s = M.clip_facts(HLG), M.clip_facts(SDR)
    assert h["hdr"] and h["colorTransfer"] == "arib-std-b67" and h["audio"] and h["fps"] == 30
    assert not s["hdr"] and not s["audio"] and s["fps"] == pytest.approx(29.97, abs=0.01)
    with pytest.raises(ValueError):
        M.clip_facts({"streams": [{"codec_type": "audio"}]})


def test_window_poses_shift_frames_and_times():
    doc, first, last = M.window_poses(poses_doc(), 2.0, 4.0)
    assert (first, last) == (60, 119) and len(doc["track"]) == 60
    assert doc["track"][0]["frameIndex"] == 0 and doc["track"][0]["time"] == 0
    assert doc["track"][-1]["frameIndex"] == 59 and doc["track"][-1]["time"] == pytest.approx(59 / 30)
    assert [k["frameIndex"] for k in doc["keyframes"]] == list(range(0, 60, 5))
    assert doc["window"] == {"start": 2.0, "end": 4.0, "firstFrame": 60, "lastFrame": 119, "sourceTime": 2.0}
    assert doc["video"]["frames"] == 60 and doc["intrinsics"] == {"fx": 1500}
    with pytest.raises(ValueError):
        M.window_poses(poses_doc(), 30.0, 31.0)  # outside the clip
    sparse = poses_doc(key_every=600)
    with pytest.raises(ValueError):
        M.window_poses(sparse, 2.0, 4.0)  # no solved keyframe in the window


def test_cut_command_keeps_hdr_and_selects_exact_frames():
    h = M.cut_command(Path("in.mov"), Path("out.mov"), M.clip_facts(HLG), 60, 119, 2.0, 2.0)
    j = " ".join(h)
    assert "between(n\\,60\\,119)" in j and "-fps_mode passthrough" in j
    assert "libx265" in j and "yuv420p10le" in j and "-color_trc arib-std-b67" in j  # HDR stays HDR
    assert "atrim=start=2.000000:duration=2.000000" in j
    s = M.cut_command(Path("in.mov"), Path("out.mov"), M.clip_facts(SDR), 0, 59, 0.0, 2.0)
    assert "libx264" in s and "yuv420p" in s and "-an" in s and "arib-std-b67" not in " ".join(s)


def test_short_window_plan(tmp_path):
    p = plan(tmp_path, 12.0)
    assert [s.name for s in p.steps] == ["cut", "frames", "register", "pack", "poses", "body", "photofit", "install"]
    assert not p.warnings and all(s.minutes <= s.limit * M.HEADROOM for s in p.steps)
    gpu = [s.name for s in p.steps if s.kind == "gpu"]
    assert gpu == ["register", "poses", "photofit"]
    for i, a in enumerate(gpu):  # one GPU at a time: every GPU step waits for the one before it
        for b in gpu[i + 1:]:
            assert a in ancestors(p, b)
    assert "pack" not in ancestors(p, "poses") and "poses" not in ancestors(p, "pack")  # CPU pack beside the GPU
    assert {"pack", "photofit"} <= ancestors(p, "install")
    poses = next(s for s in p.steps if s.name == "poses")
    assert poses.cmd[poses.cmd.index("--steps") + 1] == "hmr"  # the pose-only GPU job
    body = next(s for s in p.steps if s.name == "body")
    assert body.cmd[body.cmd.index("--steps") + 1] == "ground,refine,body,offsets,texture,fill"
    frames = next(s for s in p.steps if s.name == "frames")
    assert "--gain" not in frames.cmd  # people.py reads HDR or standard colour from the cut's own tags


def test_long_window_is_split_under_the_caps(tmp_path):
    p = plan(tmp_path, 60.0)
    names = [s.name for s in p.steps]
    assert [n for n in names if n.startswith("body")] == ["body-1", "body-2", "body-3", "body-4"][:sum(
        n.startswith("body") for n in names)] and sum(n.startswith("body") for n in names) >= 2
    for s in p.steps:
        if s.name.startswith("body-"):
            assert s.minutes <= M.CPU_LIMIT_MIN * M.HEADROOM or len(s.note.split(",")) == 1
    reg = next(s for s in p.steps if s.name == "register")
    assert "--refine-every" in reg.cmd and reg.minutes <= M.GPU_LIMIT_MIN * M.HEADROOM
    pf = next(s for s in p.steps if s.name == "photofit")
    assert ("--photofit-passes" in pf.cmd or "off" in pf.cmd) and pf.minutes <= M.GPU_LIMIT_MIN
    steps_seen = []
    for s in p.steps:
        if s.name.startswith("body"):
            steps_seen += s.cmd[s.cmd.index("--steps") + 1].split(",")
    assert steps_seen == M.BODY_STEPS  # every CPU step once, in order, across the split jobs
    one_person = plan(tmp_path, 30.0, people=1)
    assert any("--photofit-passes" in s.cmd for s in one_person.steps) or not one_person.warnings


def test_snapshot_import_check_catches_a_missing_helper(tmp_path):
    code = tmp_path / "code"
    rep = M.snapshot(code)
    assert all(v["missing"] == [] for v in rep.values()), rep
    assert rep["people"]["modules"] > 3 and rep["avatar"]["modules"] > 3  # the recursion reaches the helpers
    assert not (code / "pipeline" / "tests").exists()
    # the chess memory's failure: a helper module absent from the job's copy
    victim = code / "pipeline" / "avatar" / "util.py"
    assert victim.exists()
    victim.unlink()
    broken = M.check_imports(code)
    assert any("pipeline.avatar.util" in m for m in broken["avatar"]["missing"])


def test_sbatch_scripts_and_submission(tmp_path):
    p = plan(tmp_path, 12.0)
    gpu = M.sbatch_script(p, next(s for s in p.steps if s.name == "photofit"))
    assert "#SBATCH --gpus=1" in gpu and "tw_use_env avatar" in gpu
    assert "memory_job.py\" check --plan" in gpu.splitlines()[-1]
    t = next(l for l in gpu.splitlines() if l.startswith("#SBATCH --time="))
    h, m, _ = t.split("=")[1].split(":")
    assert int(h) * 60 + int(m) <= M.GPU_LIMIT_MIN
    cpu = M.sbatch_script(p, next(s for s in p.steps if s.name == "frames"))
    assert "--gpus" not in cpu and "tw_use_env flashworld" in cpu
    (tmp_path / "job" / "steps").mkdir(parents=True)
    calls = []

    def fake(cmd, **kw):
        calls.append(cmd)
        return type("R", (), {"stdout": f"{1000 + len(calls)};cluster\n"})()

    ids = M.submit(p, runner=fake, account="acct", qos="acct", gpu_partition="gpu-p")
    assert list(ids) == [s.name for s in p.steps] and ids["cut"] == "1001"
    by = dict(zip(ids, calls))
    assert "--partition=gpu-p" in by["register"] and "--qos=acct-b" in by["frames"]
    assert f"--dependency=afterok:{ids['pack']}:{ids['photofit']}" in by["install"]
    assert "--kill-on-invalid-dep=yes" in by["install"] and not any("--dependency" in c for c in by["cut"])
    assert json.loads((tmp_path / "job" / "submitted.json").read_text())["jobs"] == ids


def test_checks_catch_missing_and_short_outputs(tmp_path):
    p = plan(tmp_path, 12.0)
    assert M.check(p, "poses") and "hmr.npz" in M.check(p, "poses")[0]
    hmr = Path(next(s for s in p.steps if s.name == "poses").checks["files"][0])
    hmr.parent.mkdir(parents=True)
    hmr.write_bytes(b"x")
    assert M.check(p, "poses") == []
    cut = Path(p.steps[0].checks["files"][0])
    cut.parent.mkdir(parents=True)
    cut.write_bytes(b"v")
    Path(p.steps[0].checks["files"][1]).write_text("{}")
    assert M.check(p, "cut", probe_fn=lambda f: {"duration": 12.01}) == []
    assert "long" in M.check(p, "cut", probe_fn=lambda f: {"duration": 8.0})[0]


def make_stage(p, with_people=True):
    root = Path(p.root)
    stage = root / "scene" / p.id
    stage.mkdir(parents=True)
    for f in ("people.mp4", "camera-track.json", "world.spz"):
        (stage / f).write_bytes(b"x")
    (stage / "scene.json").write_text(json.dumps({"id": p.id, "world": {"file": "world.spz"},
                                                  "video": {"file": "people.mp4", "cameraTrack": "camera-track.json"}}))
    (root / "input").mkdir(parents=True, exist_ok=True)
    (root / "input" / f"{p.clip_stem}-poses.json").write_text("{}")
    out = root / "work" / "avatar-out"
    out.mkdir(parents=True)
    if with_people:
        for k in range(2):
            (out / f"avatar-{k}.glb").write_bytes(b"glb")
        (out / "avatar.json").write_text(json.dumps({"people": [{"id": f"person-{k}", "file": f"avatar-{k}.glb"}
                                                                for k in range(2)]}))
    return stage


def test_install_names_the_people_and_checks_the_folder(tmp_path):
    p = plan(tmp_path, 12.0)
    stage = make_stage(p)
    res = M.do_install(p)
    s = json.loads((stage / "scene.json").read_text())
    assert s["video"]["avatars"] == {"poses": "IMG_7398-poses.json"}  # own folder, the window's camera track
    assert (stage / "avatar-1.glb").exists() and (stage / "IMG_7398-poses.json").exists()
    assert M.check(p, "install") == [] and "rsync" in res["rsync"]
    (stage / "avatar-1.glb").unlink()
    assert any("avatar-1.glb" in x for x in M.check_scene(stage))


def test_install_fails_loudly_on_an_incomplete_folder(tmp_path):
    p = plan(tmp_path, 12.0)
    stage = make_stage(p)
    (stage / "camera-track.json").unlink()
    with pytest.raises(SystemExit):
        M.do_install(p)


def test_cut_step_writes_the_window_poses_and_runs_ffmpeg(tmp_path):
    world = tmp_path / "chess-room"
    world.mkdir()
    (world / "IMG_7398-poses.json").write_text(json.dumps(poses_doc()))
    p = M.make_plan(Path("/clips/IMG_7398.mov"), 2.0, 4.0, world, "chess-match", "Giant chess", tmp_path / "job", 2,
                    M.clip_facts(HLG), world / "IMG_7398-poses.json")
    (tmp_path / "job" / "input").mkdir(parents=True)
    ran = []
    M.do_cut(p, runner=lambda cmd, **kw: ran.append(cmd))
    doc = json.loads((tmp_path / "job" / "input" / "IMG_7398-poses.json").read_text())
    assert len(doc["track"]) == 60 and ran and "between(n\\,60\\,119)" in " ".join(ran[0])


def test_dry_run_prints_the_plan_and_writes_nothing(tmp_path, monkeypatch, capsys):
    world = tmp_path / "chess-room"
    world.mkdir()
    (world / "IMG_7398-poses.json").write_text(json.dumps(poses_doc()))
    clip = tmp_path / "IMG_7398.mov"
    clip.write_bytes(b"not really a video")
    monkeypatch.setattr(M, "probe", lambda c: M.clip_facts(HLG))
    root = tmp_path / "job"
    rc = M.main(["--clip", str(clip), "--start", "2", "--end", "14", "--world", str(world), "--id", "chess-match",
                 "--name", "Giant chess", "--root", str(root), "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0 and not root.exists()
    assert "register" in out and "GPU steps, one at a time: register -> poses -> photofit" in out
    assert "HDR (arib-std-b67)" in out and "MISSING" not in out
    with pytest.raises(SystemExit):
        M.main(["--clip", str(clip), "--start", "2", "--end", "40", "--world", str(world), "--id", "x", "--name", "x",
                "--root", str(root), "--dry-run"])  # past the end of the clip


def test_photofit_model_matches_the_documented_run_and_its_own_caps():
    assert 13 <= M.photofit_minutes(12, 2) <= 20  # documented: about 15 minutes for two people and 12 s
    assert M.photofit_minutes(120, 2) <= 2 + 0.1 * 120 * 2 + 2 * sum(M.PF_BUDGET)  # time budgets cap the fit
    assert M.photofit_minutes(30, 2, passes=1) < M.photofit_minutes(30, 2)
    assert [M.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22)] == ["1st", "2nd", "3rd", "4th", "11th", "12th",
                                                                         "13th", "21st", "22nd"]


def test_many_people_over_a_long_window_turn_photofit_off_with_a_warning(tmp_path):
    p = plan(tmp_path, 30.0, people=4)
    pf = next(s for s in p.steps if s.name == "photofit")
    assert pf.cmd[pf.cmd.index("--photofit") + 1] == "off"
    assert any("photofit" in w and "one pass" in w for w in p.warnings)
    p2 = plan(tmp_path, 30.0, people=2)
    assert "--photofit-passes" in next(s for s in p2.steps if s.name == "photofit").cmd and not p2.warnings
