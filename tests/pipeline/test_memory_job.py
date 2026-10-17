"""One command for a video memory (team/shivin.md Update 19, job 3): clip facts, the window cut (frames and poses),
the plan (dependencies, one GPU at a time, splitting under the caps), the code snapshot's import check, the Slurm
scripts and submission, the output checks and the install. ffprobe, ffmpeg and sbatch are stood in for, except in the
one cut test that runs the real ffmpeg when it is installed."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from pipeline_helpers import requires_ffmpeg
import memory_job as M

HLG = {"streams": [{"codec_type": "video", "avg_frame_rate": "30/1", "duration": "20.0", "width": 1920,
                    "height": 1080, "pix_fmt": "yuv420p10le", "color_transfer": "arib-std-b67",
                    "color_primaries": "bt2020", "color_space": "bt2020nc"}, {"codec_type": "audio"}]}
SDR = {"streams": [{"codec_type": "video", "avg_frame_rate": "30000/1001", "duration": "20.0", "width": 1920,
                    "height": 1080, "pix_fmt": "yuv420p", "color_transfer": "bt709"}]}
# IMG_9291.mov, the chess clip: 4K standard colour with an AAC track (and an APAC track ffmpeg cannot decode); its
# camera was solved at 2560x1440
CHESS = {"streams": [{"codec_type": "video", "avg_frame_rate": "47152/1573", "duration": "196.55", "width": 3840,
                      "height": 2160, "pix_fmt": "yuv420p", "color_transfer": "bt709", "color_primaries": "bt709",
                      "color_space": "bt709"}, {"codec_type": "audio", "codec_name": "aac"}, {"codec_type": "audio"}]}
CHESS_CAMERA = (2560, 1440)
# what the hand-built chess memory's steps took on HiPerGator (sacct Elapsed, minutes)
CHESS_MEASURED = {"frames": 3.1, "pack": 12.1, "poses": 1.7, "body": 28.6, "photofit": 17.7}


def poses_doc(seconds=20.0, fps=30.0, key_every=5):
    n = int(seconds * fps)
    track = [{"frameIndex": i, "time": round(i / fps, 6), "position": [0, 1.5, i * 0.01],
              "quaternion": [0, 0, 0, 1], "extrapolated": False} for i in range(n)]
    keys = [dict(t) for t in track[::key_every]]
    return {"source": "IMG_7398.mov", "intrinsics": {"width": 1920, "height": 1080, "fx": 1500},
            "video": {"fps": fps, "frames": n, "duration": seconds}, "keyframes": keys, "track": track}


def plan(tmp, seconds=12.0, people=2, facts=None, camera=None):
    facts = facts or M.clip_facts(HLG)
    return M.make_plan(Path("/clips/IMG_7398.mov"), 2.0, 2.0 + seconds, Path("/scenes/chess-room"), "chess-match",
                       "Giant chess", tmp / "job", people, facts, camera)


def chess_plan(tmp):
    return M.make_plan(Path("/clips/IMG_9291.mov"), 168.5, 189.5, Path("/scenes/chess-room"), "chess-match",
                       "Giant chess match", tmp / "job", 2, M.clip_facts(CHESS), CHESS_CAMERA)


def step(p, name):
    return next(s for s in p.steps if s.name == name)


def sbatch_minutes(script: str) -> int:
    t = next(line for line in script.splitlines() if line.startswith("#SBATCH --time="))
    h, m, _ = t.split("=")[1].split(":")
    return int(h) * 60 + int(m)


def ancestors(p, name):
    by = {s.name: s for s in p.steps}
    out, todo = set(), list(by[name].after)
    while todo:
        a = todo.pop()
        if a not in out:
            out.add(a)
            todo += by[a].after
    return out


def make_world(d: Path, world_file="world.spz", collider=True):
    d.mkdir(parents=True)
    world = {"file": world_file, "topdown": {"file": "topdown.jpg"}}
    if collider:
        world["collider"] = "collider.glb"
        (d / "collider.glb").write_bytes(b"g")
    (d / world_file).write_bytes(b"s")
    (d / "topdown.jpg").write_bytes(b"j")
    (d / "scene.json").write_text(json.dumps({"id": d.name, "world": world}))
    (d / "IMG_7398-poses.json").write_text(json.dumps(poses_doc()))
    return d


def test_clip_facts_tell_hdr_from_sdr():
    h, s = M.clip_facts(HLG), M.clip_facts(SDR)
    assert h["hdr"] and h["colorTransfer"] == "arib-std-b67" and h["audio"] and h["fps"] == 30
    assert not s["hdr"] and not s["audio"] and s["fps"] == pytest.approx(29.97, abs=0.01)
    with pytest.raises(ValueError):
        M.clip_facts({"streams": [{"codec_type": "audio"}]})


def test_clip_facts_turn_a_portrait_clip_upright():
    doc = json.loads(json.dumps(SDR))
    doc["streams"][0]["side_data_list"] = [{"side_data_type": "Display Matrix", "rotation": -90}]
    f = M.clip_facts(doc)
    assert (f["width"], f["height"]) == (1080, 1920)  # what ffmpeg decodes, and what people.py compares


def test_window_poses_shift_frames_and_times():
    doc, first, last = M.window_poses(poses_doc(), 2.0, 4.0)
    assert (first, last) == (60, 119) and len(doc["track"]) == 60
    assert doc["track"][0]["frameIndex"] == 0 and doc["track"][0]["time"] == 0
    assert doc["track"][-1]["frameIndex"] == 59 and doc["track"][-1]["time"] == pytest.approx(59 / 30)
    assert [k["frameIndex"] for k in doc["keyframes"]] == list(range(0, 60, 5))
    assert doc["window"] == {"start": 2.0, "end": 4.0, "firstFrame": 60, "lastFrame": 119, "sourceTime": 2.0}
    assert doc["video"]["frames"] == 60 and doc["intrinsics"]["fx"] == 1500 and doc["registered"] == 12
    with pytest.raises(ValueError):
        M.window_poses(poses_doc(), 30.0, 31.0)  # outside the clip
    sparse = poses_doc(key_every=600)
    with pytest.raises(ValueError):
        M.window_poses(sparse, 2.0, 4.0)  # no solved keyframe in the window


def test_window_is_cut_by_presentation_time_not_by_30_fps_frame_numbers():
    # the chess clip runs at 29.9758 fps: 168.5 s is source frame 5051 (as the hand cut used), not 168.5 * 30 = 5055
    fps = 47152 / 1573
    track = [{"frameIndex": i, "time": round(i / fps, 6), "position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}
             for i in range(5000, 5800)]
    doc, first, last = M.window_poses({"track": track, "keyframes": track[::4]}, 168.5, 189.5)
    assert (first, last) == (5051, 5680) and len(doc["track"]) == 630


def test_cut_command_keeps_hdr_and_selects_exact_frames():
    h = M.cut_command(Path("in.mov"), Path("out.mov"), M.clip_facts(HLG), 60, 119, 2.0, 2.0)
    j = " ".join(h)
    assert "between(n\\,60\\,119)" in j and "-fps_mode passthrough" in j and "scale=" not in j
    assert "libx265" in j and "yuv420p10le" in j and "-color_trc arib-std-b67" in j  # HDR stays HDR
    assert "atrim=start=2.000000:duration=2.000000" in j
    s = M.cut_command(Path("in.mov"), Path("out.mov"), M.clip_facts(SDR), 0, 59, 0.0, 2.0)
    assert "libx264" in s and "yuv420p" in s and "-an" in s and "arib-std-b67" not in " ".join(s)


def test_cut_scales_the_clip_to_the_size_its_camera_was_solved_at(tmp_path):
    # people.py frames stops when the clip and its camera differ in size (the chess memory's first failure)
    c = " ".join(M.cut_command(Path("in.mov"), Path("out.mov"), M.clip_facts(CHESS), 5051, 5680, 168.503333, 21.016694,
                               CHESS_CAMERA))
    assert "between(n\\,5051\\,5680)',setpts=PTS-STARTPTS,scale=2560:1440:flags=lanczos" in c
    p = chess_plan(tmp_path)
    assert p.camera == [2560, 1440] and "3840x2160 to the camera's 2560x1440" in step(p, "cut").note
    assert "camera solved at 2560x1440" in M.describe(p)


def test_cut_maps_the_clips_first_audio_track():
    # an iPhone clip carries a second audio track (APAC) ffmpeg cannot decode, so nothing is left to stream selection
    c = M.cut_command(Path("in.mov"), Path("out.mov"), M.clip_facts(CHESS), 0, 59, 0.0, 2.0, CHESS_CAMERA)
    assert c[c.index("-map") + 1] == "0:v:0" and "0:a:0" in c and c.count("-map") == 2


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
    poses = step(p, "poses")
    assert poses.cmd[poses.cmd.index("--steps") + 1] == "hmr"  # the pose-only GPU job
    body = step(p, "body")
    assert body.cmd[body.cmd.index("--steps") + 1] == "ground,refine,body,offsets,texture,fill"
    frames = step(p, "frames")
    assert "--gain" not in frames.cmd  # people.py reads HDR or standard colour from the cut's own tags
    assert "--photofit-passes" not in step(p, "photofit").cmd  # 12 s: both passes fit


def test_long_window_is_split_under_the_caps(tmp_path):
    p = plan(tmp_path, 60.0)
    bodies = [s for s in p.steps if s.name.startswith("body")]
    assert [s.name for s in bodies] == [f"body-{k + 1}" for k in range(len(bodies))] and len(bodies) >= 2
    for s in bodies:
        assert s.minutes <= M.CPU_LIMIT_MIN * M.HEADROOM or "," not in s.note  # only a lone step may be over
    seen = [x for s in bodies for x in s.cmd[s.cmd.index("--steps") + 1].split(",")]
    assert seen == M.BODY_STEPS  # every CPU step once, in order, across the split jobs
    reg = step(p, "register")
    assert "--refine-every" in reg.cmd and reg.minutes <= M.GPU_LIMIT_MIN * M.HEADROOM
    pf = step(p, "photofit")
    assert ("--photofit-passes" in pf.cmd or "off" in pf.cmd) and pf.minutes <= M.GPU_LIMIT_MIN


def test_register_estimate_matches_the_chess_run_and_picks_a_refine_every_that_fits(tmp_path):
    # chess, 630 frames at 1280x720: every 6th refined took 17.7 min; every 3rd was on course for 30 (cancelled at
    # 121 of 211 refined poses after 15 min); the plan used to pick every 2nd at "20.9 min"
    assert M.register_minutes(630, CHESS_CAMERA, 6) == pytest.approx(17.7, abs=0.5)
    assert M.register_minutes(630, CHESS_CAMERA, 3) > M.GPU_LIMIT_MIN
    assert M.register_minutes(630, CHESS_CAMERA, 2) > M.GPU_LIMIT_MIN
    # kitchen, 1490 frames at 960x540, every 6th: 23.4 min
    assert M.register_minutes(1490, (1920, 1080), 6) == pytest.approx(23.4, rel=0.1)
    reg = step(chess_plan(tmp_path), "register")
    every = int(reg.cmd[reg.cmd.index("--refine-every") + 1])
    assert 3 < every <= 6 and reg.minutes <= M.GPU_LIMIT_MIN * M.HEADROOM
    assert M.register_minutes(630, CHESS_CAMERA, every - 1) > M.GPU_LIMIT_MIN * M.HEADROOM  # the densest that fits


def test_chess_plan_estimates_and_time_limits_cover_the_measured_runs(tmp_path):
    p = chess_plan(tmp_path)
    assert not p.warnings
    for name, measured in CHESS_MEASURED.items():
        s = step(p, name)
        assert s.minutes == pytest.approx(measured, rel=0.15, abs=0.5), name
        assert sbatch_minutes(M.sbatch_script(p, s)) >= measured * 1.2, name  # pack ran 12:04 against a 12:00 limit
    assert "--photofit-passes" in step(p, "photofit").cmd  # two passes ran into the 29-minute cap


def test_photofit_model_matches_the_chess_runs_and_its_own_caps():
    assert M.photofit_minutes(21, 2, passes=1) == pytest.approx(17.7, abs=0.5)  # job 46453770
    assert M.photofit_minutes(21, 2) > M.GPU_LIMIT_MIN  # job 46445751 timed out in pass 2
    assert 13 <= M.photofit_minutes(12, 2) <= 20  # documented: about 15 minutes for two people and 12 s
    prep = M.PF_SETUP_MIN + 2 * M.PF_PREP_MIN * 120
    assert M.photofit_minutes(120, 2) == pytest.approx(prep + 2 * (sum(M.PF_BUDGET) + 2 * M.PF_PERSON_MIN), abs=0.1)
    assert [M.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22)] == ["1st", "2nd", "3rd", "4th", "11th", "12th",
                                                                         "13th", "21st", "22nd"]


def test_body_split_follows_the_measured_step_shares():
    assert sum(M.BODY_WEIGHTS.values()) == pytest.approx(1.0)
    assert M.split_body(21, 2) == [M.BODY_STEPS]  # chess: one job, 28.6 min
    # 60 s, two people: refine alone is about 50 min, so it gets a job of its own (the old shares put ground, refine
    # and body together at "31 min", really about 55)
    assert ["refine"] in M.split_body(60, 2)
    p = M.make_plan(Path("/clips/IMG_9291.mov"), 0.0, 60.0, Path("/scenes/chess-room"), "m", "M", Path("/job"), 2,
                    M.clip_facts(CHESS), CHESS_CAMERA)
    over = [w for w in p.warnings if "CPU" in w or "50 min" in w]
    assert len(over) == 1 and "(refine)" in over[0]  # one warning per step over its cap


def test_many_people_over_a_long_window_turn_photofit_off_with_a_warning(tmp_path):
    p = plan(tmp_path, 30.0, people=4)
    pf = step(p, "photofit")
    assert pf.cmd[pf.cmd.index("--photofit") + 1] == "off"
    assert any("photofit" in w and "one pass" in w for w in p.warnings)
    p2 = plan(tmp_path, 30.0, people=2)
    assert "--photofit-passes" in step(p2, "photofit").cmd and not p2.warnings


def test_snapshot_import_check_catches_a_missing_helper(tmp_path):
    code = tmp_path / "code"
    rep = M.snapshot(code)
    assert all(v["missing"] == [] for v in rep.values()), rep
    assert rep["people"]["modules"] > 3 and rep["avatar"]["modules"] > 3  # the recursion reaches the helpers
    assert not (code / "pipeline" / "tests").exists()
    # the kitchen memory's failure: a helper module absent from the job's copy
    victim = code / "pipeline" / "avatar" / "util.py"
    assert victim.exists()
    victim.unlink()
    broken = M.check_imports(code)
    assert any("pipeline.avatar.util" in m for m in broken["avatar"]["missing"])


def test_snapshot_takes_env_sh_from_the_cluster_repo_when_the_working_copy_has_none(tmp_path, monkeypatch):
    # code-memjob/ on HiPerGator holds only pipeline/, and every step sources code/hpg/env.sh first
    work = tmp_path / "code-memjob"
    (work / "pipeline").mkdir(parents=True)
    monkeypatch.delenv("TW_REPO", raising=False)
    monkeypatch.delenv("HPG_ROOT", raising=False)
    assert M.env_script(work) is None
    with pytest.raises(SystemExit, match="env.sh"):
        M.snapshot(tmp_path / "job" / "code", src=work)
    assert not (tmp_path / "job").exists()  # refused before anything was written
    repo_env = tmp_path / "hpg-root" / "repo" / "hpg" / "env.sh"
    repo_env.parent.mkdir(parents=True)
    repo_env.write_text("tw_use_env() { :; }\n")
    monkeypatch.setenv("HPG_ROOT", str(tmp_path / "hpg-root"))
    assert M.env_script(work) == repo_env
    assert M.env_script() == M.REPO / "hpg" / "env.sh"  # a full checkout uses its own


def test_sbatch_scripts_and_submission(tmp_path):
    p = plan(tmp_path, 12.0)
    gpu = M.sbatch_script(p, step(p, "photofit"))
    assert "#SBATCH --gpus=1" in gpu and "tw_use_env avatar" in gpu
    assert "memory_job.py\" check --plan" in gpu.splitlines()[-1]
    assert sbatch_minutes(gpu) <= M.GPU_LIMIT_MIN
    cpu = M.sbatch_script(p, step(p, "frames"))
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


def test_every_step_runs_inside_an_env_with_python_and_ffmpeg(tmp_path):
    # a compute node has no python or ffmpeg of its own (the kitchen memory's first CPU job: ffmpeg not on PATH)
    p = plan(tmp_path, 12.0)
    for s in p.steps:
        script = M.sbatch_script(p, s)
        assert ("tw_use_env avatar" in script) != ("tw_use_env flashworld" in script), s.name
    assert "tw_use_env flashworld" in M.sbatch_script(p, step(p, "cut"))
    assert "tw_use_env flashworld" in M.sbatch_script(p, step(p, "install"))


def test_checks_catch_missing_and_short_outputs(tmp_path):
    p = plan(tmp_path, 12.0)
    assert M.check(p, "poses") and "hmr.npz" in M.check(p, "poses")[0]
    hmr = Path(step(p, "poses").checks["files"][0])
    hmr.parent.mkdir(parents=True)
    hmr.write_bytes(b"x")
    assert M.check(p, "poses") == []
    cut = Path(p.steps[0].checks["files"][0])
    cut.parent.mkdir(parents=True)
    cut.write_bytes(b"v")
    Path(p.steps[0].checks["files"][1]).write_text("{}")
    assert M.check(p, "cut", probe_fn=lambda f: {"duration": 12.01}) == []
    assert "long" in M.check(p, "cut", probe_fn=lambda f: {"duration": 8.0})[0]


def test_every_step_checks_what_the_next_one_reads(tmp_path):
    p = plan(tmp_path, 12.0)
    people = Path(p.root) / "work" / "people"
    (people / "small").mkdir(parents=True)
    (people / "frames.json").write_text("{}")
    for k in range(360):
        (people / "small" / f"f{k:04d}.jpg").write_bytes(b"j")
    assert M.check(p, "frames") == []
    # what frames left is not what register writes (the old check passed on any non-empty work folder)
    assert any("register.json" in x for x in M.check(p, "register"))
    (people / "gpu").mkdir()
    (people / "register.json").write_text("{}")
    for k in range(100):
        (people / "gpu" / f"f{k:04d}.npz").write_bytes(b"n")
    assert any("gpu/f*.npz: 100 found" in x for x in M.check(p, "register"))
    long = plan(tmp_path, 60.0)
    for s in long.steps:
        if s.name.startswith("body"):
            assert s.checks.get("files") or s.checks.get("globs"), s.name  # the texture/fill job too
    last = [s for s in long.steps if s.name.startswith("body")][-1]
    assert [str(Path(long.root) / "work" / "avatar"), "tex-[0-9]*.jpg", 2] in last.checks["globs"]


def test_the_world_file_comes_from_the_places_scene_json(tmp_path):
    courts = make_world(tmp_path / "the-courts", world_file="world-filled.spz")
    name, problems = M.world_inputs(courts)
    assert (name, problems) == ("world-filled.spz", [])
    p = M.make_plan(Path("/clips/IMG_7398.mov"), 2.0, 14.0, courts, "m", "M", tmp_path / "job", 2, M.clip_facts(HLG),
                    world_file=name)
    for nm in ("register", "poses", "body", "photofit"):
        s = step(p, nm)
        assert s.cmd[s.cmd.index("--world") + 1] == str(courts / "world-filled.spz"), nm
    # a folder with only scene.json and the poses (the dry run's world-chess) would fail at register and pack
    bare = tmp_path / "world-chess"
    bare.mkdir()
    (bare / "scene.json").write_text(json.dumps({"world": {"file": "world.spz", "collider": "collider.glb"}}))
    _, problems = M.world_inputs(bare)
    assert len(problems) == 2 and "world.spz is missing" in problems[0]


def test_dry_run_prints_the_plan_and_writes_nothing(tmp_path, monkeypatch, capsys):
    world = make_world(tmp_path / "chess-room")
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
    (world / "collider.glb").unlink()
    with pytest.raises(SystemExit, match="collider.glb is missing"):
        M.main(["--clip", str(clip), "--start", "2", "--end", "14", "--world", str(world), "--id", "x", "--name", "x",
                "--root", str(root), "--dry-run"])


def test_dry_run_refuses_a_clip_of_another_shape_than_its_camera(tmp_path, monkeypatch):
    world = make_world(tmp_path / "chess-room")
    clip = tmp_path / "IMG_7398.mov"
    clip.write_bytes(b"v")
    portrait = json.loads(json.dumps(HLG))
    portrait["streams"][0].update(width=1080, height=1920)
    monkeypatch.setattr(M, "probe", lambda c: M.clip_facts(portrait))
    with pytest.raises(SystemExit, match="another shape"):
        M.main(["--clip", str(clip), "--start", "2", "--end", "14", "--world", str(world), "--id", "x", "--name", "x",
                "--root", str(tmp_path / "job"), "--dry-run"])


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


def test_install_puts_the_people_beside_the_video_and_checks_the_folder(tmp_path):
    p = plan(tmp_path, 12.0)
    stage = make_stage(p)
    before = (stage / "scene.json").read_text()
    res = M.do_install(p)
    assert (stage / "avatar-1.glb").exists() and (stage / "avatar.json").exists()
    # scene.json is left as pack wrote it: the viewer finds avatar.json in the memory's own folder and the crossfade
    # follows camera-track.json (the refined camera of every packed frame), not the stage-1 window poses
    assert (stage / "scene.json").read_text() == before and not (stage / "IMG_7398-poses.json").exists()
    assert M.check(p, "install") == [] and "rsync" in res["rsync"]
    (stage / "avatar-1.glb").unlink()
    assert any("avatar-1.glb" in x for x in M.check_scene(stage))  # the folder convention is checked too


def test_install_fails_loudly_on_an_incomplete_folder(tmp_path):
    p = plan(tmp_path, 12.0)
    stage = make_stage(p)
    (stage / "camera-track.json").unlink()
    with pytest.raises(SystemExit):
        M.do_install(p)
    q = plan(tmp_path / "b", 12.0)
    make_stage(q, with_people=False)
    with pytest.raises(SystemExit, match="avatar.json"):
        M.do_install(q)


def test_cut_step_writes_the_window_poses_and_runs_ffmpeg(tmp_path):
    world = make_world(tmp_path / "chess-room")
    p = M.make_plan(Path("/clips/IMG_7398.mov"), 2.0, 4.0, world, "chess-match", "Giant chess", tmp_path / "job", 2,
                    M.clip_facts(HLG))
    (tmp_path / "job" / "input").mkdir(parents=True)
    ran = []
    M.do_cut(p, runner=lambda cmd, **kw: ran.append(cmd), count_fn=lambda f: 60)
    doc = json.loads((tmp_path / "job" / "input" / "IMG_7398-poses.json").read_text())
    assert len(doc["track"]) == 60 and ran and "between(n\\,60\\,119)" in " ".join(ran[0])
    assert doc["source"] == "IMG_7398-window.mov"
    with pytest.raises(SystemExit, match="59 frames"):  # the poses are matched to the cut's frames by number
        M.do_cut(p, runner=lambda cmd, **kw: None, count_fn=lambda f: 59)


@requires_ffmpeg
def test_cut_with_the_real_ffmpeg_is_frame_exact_and_camera_sized(tmp_path):
    clip = tmp_path / "IMG_7398.mov"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30000/1001:duration=3",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(clip)], check=True)
    world = make_world(tmp_path / "room")
    fps = 30000 / 1001
    track = [{"frameIndex": i, "time": round(i / fps, 6), "position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}
             for i in range(89)]
    (world / "IMG_7398-poses.json").write_text(json.dumps({"intrinsics": {"width": 160, "height": 90},
                                                           "track": track, "keyframes": track[::10]}))
    facts = M.probe(clip)
    p = M.make_plan(clip, 1.0, 2.0, world, "m", "M", tmp_path / "job", 2, facts, (160, 90))
    (tmp_path / "job" / "input").mkdir(parents=True)
    M.do_cut(p)
    cut = M.cut_path(tmp_path / "job", clip)
    got = M.probe(cut)
    assert M.count_frames(cut) == 30 and (got["width"], got["height"]) == (160, 90) and got["audio"]
    assert M.check(p, "cut") == []


# --- resuming a chain (--from) ---------------------------------------------------------------------------------------

def written_job(tmp_path):
    """A job folder as the first --submit leaves it: plan.json and one script per step."""
    p = plan(tmp_path, 12.0)
    root = Path(p.root)
    (root / "steps").mkdir(parents=True)
    (root / "plan.json").write_text(json.dumps(p.to_json()))
    for s in p.steps:
        (root / "steps" / f"{s.name}.sbatch").write_text("#!/bin/bash\n")
    return p, root


def finish(p, *names):
    """Writes what each named step's check looks for."""
    for n in names:
        c = next(s for s in p.steps if s.name == n).checks
        for f in c.get("files", []):
            Path(f).parent.mkdir(parents=True, exist_ok=True)
            Path(f).write_text("{}")
        for d, pattern, k in c.get("globs", []) + ([c["glob"]] if "glob" in c else []):
            target = Path(d) / pattern
            target.parent.mkdir(parents=True, exist_ok=True)
            for i in range(int(k)):
                name = target.name.replace("[0-9]*", str(i)).replace("*", str(i))
                (target.parent / name).write_text("x")


def test_from_photofit_plans_photofit_and_install_only(tmp_path, capsys):
    p, root = written_job(tmp_path)
    finish(p, "pack", *[s.name for s in p.steps if s.name.startswith("body")])
    part, problems = M.resume_plan(p, "photofit")
    assert problems == [] and [s.name for s in part.steps] == ["photofit", "install"]
    assert part.steps[0].after == [] and part.steps[1].after == ["photofit"]  # done steps drop out of the deps
    assert M.main(["--from", "photofit", "--root", str(root), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "resuming chess-match at photofit: photofit, install" in out
    assert "\nregister " not in out and "\ncut " not in out


def test_from_refuses_when_earlier_outputs_are_missing(tmp_path):
    p, root = written_job(tmp_path)
    finish(p, *[s.name for s in p.steps if s.name.startswith("body")])  # pack never finished
    part, problems = M.resume_plan(p, "photofit")
    assert problems and all(x.startswith("pack:") for x in problems)
    with pytest.raises(SystemExit) as e:
        M.main(["--from", "photofit", "--root", str(root), "--dry-run"])
    assert "pack" in str(e.value)
    with pytest.raises(SystemExit):
        M.resume_plan(p, "nonsense")
    with pytest.raises(SystemExit):
        M.main(["--from", "photofit", "--root", str(tmp_path / "nowhere"), "--dry-run"])


def test_from_submits_only_the_rest_and_keeps_the_first_record(tmp_path):
    p, root = written_job(tmp_path)
    (root / "submitted.json").write_text('{"jobs": {"cut": "1"}}')
    finish(p, "pack", *[s.name for s in p.steps if s.name.startswith("body")])
    calls = []

    def fake(cmd, **kw):
        calls.append(cmd)
        return type("R", (), {"stdout": f"{500 + len(calls)}\n"})()

    assert M.resume_main(["--from", "photofit", "--root", str(root), "--submit"], runner=fake) == 0
    assert [c[-1].rsplit("/", 1)[-1] for c in calls] == ["photofit.sbatch", "install.sbatch"]
    assert not any("--dependency" in x for x in calls[0]) and "--dependency=afterok:501" in calls[1]
    assert json.loads((root / "submitted.json").read_text()) == {"jobs": {"cut": "1"}}  # the first run's record stays
    assert len(list(root.glob("submitted-from-photofit-*.json"))) == 1
