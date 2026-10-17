#!/usr/bin/env python3
"""One command for a video memory (team/shivin.md Update 19, job 3).

    python pipeline/memory_job.py --clip IMG_7398.mov --start 41.5 --end 56 --world data/scenes/chess-room \
        --id chess-match --name "Giant chess" --people 2 --dry-run          # prints the plan, writes nothing
    python pipeline/memory_job.py ... --root $HPG_ROOT/jobs/memory-chess-match --submit    # on HiPerGator

Given a clip, a time window and the world it was filmed in, it plans the chain, writes one job folder with a
snapshot of the code, and submits the steps to Slurm with the right dependencies:

  cut       the window, exactly: frames first..last re-encoded with the clip's own colour tags (HDR stays HDR), the
            audio trimmed to match, and the clip's camera poses shifted to the window (CPU)
  frames    people.py frames: output frames, analysis copies, initial poses (CPU)
  register  people.py register: segmentation, depth, each pose refined against the world, room renders (GPU)
  pack      people.py pack: masks, depth, colour, tw-pack-v1 video, camera-track.json, the scene folder (CPU)
  poses     avatar run.py --steps hmr: per-frame body pose and shape (GPU)
  body      avatar run.py ground ... fill: tracks, the body, clothing volume, texture (CPU; split when long)
  photofit  avatar run.py photofit, glb: the fitted, animated people (GPU)
  install   the memory's folder: people from the clip next to its video, poses for the crossfade, checked (CPU)

The GPU steps run one at a time (register, then poses, then photofit); pack runs on a CPU beside poses. Every step
ends by checking its own outputs (`memory_job.py check`), so a step that "succeeds" without writing what the next one
reads fails there, and Slurm's afterok cancels the rest.

What it fixes from the chess memory, which took many separate steps and four fixes by hand:
  SDR clips          the HDR exposure gain is passed only when the clip is HDR (HLG or PQ); standard clips use plain
                     exposure
  pose-only runs     the pose step is its own GPU job (run.py --steps hmr) and is checked for hmr.npz alone
  missing helpers    the job runs from a snapshot of the whole pipeline/ folder, and the plan checks that every
                     local module each step imports (recursively) is in the snapshot before anything is submitted
  the 29-minute cap  each step is estimated from the window length and the number of people; a step that would run
                     past the GPU (29 min) or CPU (50 min) cap is split at its cached step boundaries, or uses its
                     own long-clip option (register --refine-every; photofit with one pass), and the plan says so

Ojasva runs the real one. `--dry-run` prints the plan and changes nothing.
"""
from __future__ import annotations

import argparse
import ast
import json
import math
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

PIPELINE = Path(__file__).resolve().parent
REPO = PIPELINE.parent

GPU_LIMIT_MIN = 29.0  # hpg/avatar.sbatch: the group's shared GPUs, every job under 30 minutes
CPU_LIMIT_MIN = 50.0  # hpg/avatar-cpu.sbatch
HEADROOM = 0.85  # plan to use at most this share of a cap

# Minutes, from the timings the scripts document (12 s, two people: pose network ~1 min, CPU steps ~15 min,
# photofit ~15 min; people.py register ~24 min for the 12.4 s foosball clip). Per second of window, per person where
# noted. Photofit has its own model below: it caps its fitting time itself.
RATES = {
    "cut": (1.0, 0.05),  # (fixed, per second)
    "frames": (2.0, 0.1),
    "register": (2.0, 1.8),
    "pack": (4.0, 0.2),
    "poses": (1.0, 1.0 / 12.0),
    "body": (2.0, 0.625),  # per person-second
    "photofit": (2.0, 0.0),  # setup; the rest is photofit_minutes()
    "install": (1.0, 0.0),
}
# pipeline/avatar/photofit.py: steps = 72 visits per frame / batch 8, bounded 1500..6000 (pass 1: two thirds, at
# least 1000); each person's pass stops at its time budget (4.5 min pass 1, 6.5 min the last). A step takes about
# 0.0012 min (the documented 15 minutes for two people and 12 s). The masks (CPU, before each pass) about 0.1 min/s.
PF_STEP_MIN = 0.0012
PF_BUDGET = (4.5, 6.5)


def photofit_minutes(seconds: float, people: int, fps: float = 30.0, passes: int = 2) -> float:
    frames = seconds * fps
    last = min(6000, max(1500, round(72 * frames / 8)))
    first = max(1000, round(last * 2 / 3))
    if passes == 1:
        per_person = min(PF_BUDGET[1], last * PF_STEP_MIN)
    else:
        per_person = min(PF_BUDGET[0], first * PF_STEP_MIN) + min(PF_BUDGET[1], last * PF_STEP_MIN)
    return round(RATES["photofit"][0] + 0.1 * seconds * passes + people * per_person, 1)
BODY_STEPS = ["ground", "refine", "body", "offsets", "texture", "fill"]
BODY_WEIGHTS = {"ground": 0.1, "refine": 0.2, "body": 0.1, "offsets": 0.2, "texture": 0.3, "fill": 0.1}
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}


# --- clip facts --------------------------------------------------------------------------------------------------

def probe(clip: Path) -> dict:
    """ffprobe: frame rate, duration, colour tags, audio. Raises when the file is not a video."""
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(clip)],
                         capture_output=True, text=True, check=True).stdout
    return clip_facts(json.loads(out))


def clip_facts(doc: dict) -> dict:
    v = next((s for s in doc.get("streams", []) if s.get("codec_type") == "video"), None)
    if v is None:
        raise ValueError("no video stream")
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    dur = float(v.get("duration") or doc.get("format", {}).get("duration") or 0.0)
    trc = v.get("color_transfer") or ""
    return {"fps": round(fps, 4), "duration": dur, "width": int(v.get("width", 0)), "height": int(v.get("height", 0)),
            "pixFmt": v.get("pix_fmt", ""), "colorTransfer": trc, "colorPrimaries": v.get("color_primaries", ""),
            "colorSpace": v.get("color_space", ""), "hdr": trc in HDR_TRANSFERS,
            "audio": any(s.get("codec_type") == "audio" for s in doc.get("streams", []))}


def window_poses(poses: dict, start: float, end: float) -> tuple[dict, int, int]:
    """The clip's <clip>-poses.json cut to [start, end): track and keyframes inside it, frame numbers and times
    counted from the window's first frame. Returns (poses, first source frame, last source frame)."""
    track = [t for t in poses.get("track", []) if start - 1e-6 <= t["time"] < end]
    if not track:
        raise ValueError(f"the clip's poses have no frame between {start} and {end} s")
    first = min(int(t["frameIndex"]) for t in track)
    last = max(int(t["frameIndex"]) for t in track)
    t0 = min(t["time"] for t in track if int(t["frameIndex"]) == first)

    def shift(rows):
        out = []
        for r in rows:
            if first <= int(r["frameIndex"]) <= last:
                r = dict(r)
                r["frameIndex"] = int(r["frameIndex"]) - first
                r["time"] = round(float(r["time"]) - t0, 6)
                out.append(r)
        return out

    doc = {k: v for k, v in poses.items() if k not in ("track", "keyframes")}
    doc["track"] = shift(sorted(track, key=lambda r: int(r["frameIndex"])))
    doc["keyframes"] = shift(poses.get("keyframes", []))
    if not doc["keyframes"]:
        raise ValueError("no solved keyframe inside the window; widen it")
    doc["window"] = {"start": start, "end": end, "firstFrame": first, "lastFrame": last, "sourceTime": t0}
    if isinstance(doc.get("video"), dict):
        doc["video"] = {**doc["video"], "frames": last - first + 1, "duration": round(doc["track"][-1]["time"], 6)}
    return doc, first, last


def cut_command(clip: Path, out: Path, facts: dict, first: int, last: int, t0: float, dur: float) -> list[str]:
    """ffmpeg: exactly source frames first..last (selected by number, timestamps restarted), re-encoded near-lossless
    with the clip's own colour tags so HDR stays HDR for people.py; the audio trimmed to the same span."""
    ten_bit = "10" in facts.get("pixFmt", "") or facts.get("hdr")
    vf = f"select='between(n\\,{first}\\,{last})',setpts=PTS-STARTPTS"
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(clip), "-vf", vf, "-fps_mode", "passthrough"]
    if ten_bit:
        cmd += ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-crf", "10", "-preset", "medium", "-tag:v", "hvc1"]
    else:
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", "-preset", "medium"]
    for flag, key in (("-color_primaries", "colorPrimaries"), ("-color_trc", "colorTransfer"),
                      ("-colorspace", "colorSpace")):
        if facts.get(key):
            cmd += [flag, facts[key]]
    if facts.get("audio"):
        cmd += ["-af", f"atrim=start={t0:.6f}:duration={dur:.6f},asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]
    return cmd + [str(out)]


# --- the plan ----------------------------------------------------------------------------------------------------

@dataclass
class Step:
    name: str
    kind: str  # "cpu" or "gpu"
    cmd: list[str]
    after: list[str] = field(default_factory=list)
    minutes: float = 0.0
    env: str = "recon"  # "recon" (people.py: the flashworld env), "avatar", "plain"
    checks: dict = field(default_factory=dict)
    note: str = ""

    @property
    def limit(self) -> float:
        return GPU_LIMIT_MIN if self.kind == "gpu" else CPU_LIMIT_MIN


@dataclass
class Plan:
    id: str
    name: str
    root: str
    clip: str
    world: str
    start: float
    end: float
    people: int
    facts: dict
    steps: list[Step]
    warnings: list[str] = field(default_factory=list)
    clip_stem: str = "clip"

    def to_json(self) -> dict:
        d = asdict(self)
        d["steps"] = [asdict(s) for s in self.steps]
        return d

    @classmethod
    def from_json(cls, d: dict) -> "Plan":
        d = dict(d)
        d["steps"] = [Step(**s) for s in d["steps"]]
        return cls(**d)


def estimate(name: str, seconds: float, people: int) -> float:
    fixed, rate = RATES[name]
    per = seconds * (people if name in ("body", "photofit") else 1)
    return round(fixed + rate * per, 1)


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def split_body(seconds: float, people: int) -> list[list[str]]:
    """The avatar CPU steps in as few jobs as fit under the CPU cap (they are cached, so a job boundary between two
    steps is safe). A single step that alone is over the cap still gets its own job (and a warning)."""
    total = estimate("body", seconds, people)
    budget = CPU_LIMIT_MIN * HEADROOM
    groups: list[list[str]] = [[]]
    used = 0.0
    for s in BODY_STEPS:
        m = total * BODY_WEIGHTS[s]
        if groups[-1] and used + m > budget:
            groups.append([])
            used = 0.0
        groups[-1].append(s)
        used += m
    return groups


def make_plan(clip: Path, start: float, end: float, world: Path, mem_id: str, name: str, root: Path, people: int,
              facts: dict, poses_file: Path, caption: str = "", fps: float = 30.0) -> Plan:
    if end <= start:
        raise ValueError("the window ends before it starts")
    seconds = end - start
    W = root / "work"
    stage = root / "scene" / mem_id
    stem = clip.stem
    cut = root / "input" / f"{stem}-window{clip.suffix.lower() if clip.suffix else '.mov'}"
    cut_poses = root / "input" / f"{stem}-poses.json"
    code = root / "code"
    py = "python"
    people_py = [py, "-u", str(code / "pipeline" / "recon" / "people.py")]
    people_out = W / "avatar-out"  # copied into the scene at install: pack writes there in parallel
    avatar = [py, "-W", "ignore", "-m", "pipeline.avatar.run", "--work", str(W / "avatar"), "--video", str(cut),
              "--poses", str(cut_poses), "--out-dir", str(people_out), "--people", str(people), "--fps", str(fps),
              "--start", "0", "--max-seconds", f"{seconds + 1:.3f}", "--clip", stem, "--world", str(world / "world.spz")]
    warnings = []
    steps = [Step("cut", "cpu", [py, str(code / "pipeline" / "memory_job.py"), "cut", "--plan", str(root / "plan.json")],
                  minutes=estimate("cut", seconds, people), env="plain",
                  checks={"files": [str(cut), str(cut_poses)], "duration": [str(cut), seconds]})]
    frames = people_py + ["frames", "--work", str(W / "people"), "--clip", str(cut), "--poses", str(cut_poses),
                          "--fps", str(fps)]
    if facts.get("hdr"):
        note = "HDR clip: people.py picks the exposure gain"
    else:
        note = "standard (SDR) clip: plain exposure, no HDR gain"
    steps.append(Step("frames", "cpu", frames, ["cut"], estimate("frames", seconds, people),
                      checks={"glob": [str(W / "people"), "**/*.jpg", int(seconds * fps * 0.9)]}, note=note))
    reg_min = estimate("register", seconds, people)
    reg = people_py + ["register", "--work", str(W / "people"), "--world", str(world / "world.spz")]
    reg_note = ""
    if reg_min > GPU_LIMIT_MIN * HEADROOM:
        every = math.ceil((reg_min - RATES["register"][0]) / (GPU_LIMIT_MIN * HEADROOM - RATES["register"][0]))
        reg += ["--refine-every", str(every)]
        reg_note = (f"long window: poses refined on every {ordinal(every)} frame, interpolated between "
                    "(people.py --refine-every)")
        reg_min = round(RATES["register"][0] + (reg_min - RATES["register"][0]) / every, 1)
    steps.append(Step("register", "gpu", reg, ["frames"], reg_min, checks={"dirs": [str(W / "people")]},
                      note=reg_note))
    steps.append(Step("pack", "cpu", people_py + ["pack", "--work", str(W / "people"), "--clip", str(cut),
                                                  "--world-scene", str(world), "--scene-dir", str(stage), "--id", mem_id,
                                                  "--name", name, "--caption", caption],
                      ["register"], estimate("pack", seconds, people),
                      checks={"files": [str(stage / "scene.json"), str(stage / "camera-track.json")]}))
    steps.append(Step("poses", "gpu", avatar + ["--steps", "hmr"], ["register"], estimate("poses", seconds, people),
                      env="avatar", checks={"files": [str(W / "avatar" / "hmr.npz")]},
                      note="pose step only; the CPU steps make the tracks in their own job"))
    groups = split_body(seconds, people)
    prev = "poses"
    for k, g in enumerate(groups):
        nm = "body" if len(groups) == 1 else f"body-{k + 1}"
        m = round(sum(estimate("body", seconds, people) * BODY_WEIGHTS[s] for s in g), 1)
        chk = {"files": [str(W / "avatar" / "tracks.npz")]} if "ground" in g else {}
        if "body" in g:
            chk = {"glob": [str(W / "avatar"), "asset-*.npz", people]}
        steps.append(Step(nm, "cpu", avatar + ["--steps", ",".join(g)], [prev], m, env="avatar", checks=chk,
                          note=f"steps {', '.join(g)}"))
        if m > CPU_LIMIT_MIN:
            warnings.append(f"{nm} ({', '.join(g)}) is estimated at {m} min, over the {CPU_LIMIT_MIN:.0f} min CPU cap")
        prev = nm
    pf_min = photofit_minutes(seconds, people, fps)
    pf = avatar + ["--steps", "photofit,glb"]
    pf_note = ""
    if pf_min > GPU_LIMIT_MIN * HEADROOM:
        one = photofit_minutes(seconds, people, fps, passes=1)
        if one <= GPU_LIMIT_MIN * HEADROOM:
            pf += ["--photofit-passes", "1"]
            pf_note = "long window: one photofit pass (the second pass would run past the GPU cap)"
            pf_min = one
        else:
            pf += ["--photofit", "off"]
            pf_note = "very long window: photofit off, the people keep their baked texture"
            warnings.append(f"photofit is estimated at {one} min even with one pass (two: {pf_min}); it is turned off. "
                            "A shorter window, or fewer people, keeps it")
            pf_min = RATES["photofit"][0] + 0.1 * seconds
    steps.append(Step("photofit", "gpu", pf, [prev], pf_min, env="avatar",
                      checks={"files": [str(people_out / "avatar.json")], "glob": [str(people_out), "avatar-*.glb", people]},
                      note=pf_note))
    steps.append(Step("install", "cpu", [py, str(code / "pipeline" / "memory_job.py"), "install", "--plan",
                                         str(root / "plan.json")],
                      ["pack", "photofit"], estimate("install", seconds, people), env="plain",
                      checks={"files": [str(stage / "scene.json")], "scene": [str(stage)]}))
    for s in steps:
        if s.minutes > s.limit:
            warnings.append(f"{s.name} is estimated at {s.minutes} min, over its {s.limit:.0f} min cap")
    return Plan(mem_id, name, str(root), str(clip), str(world), start, end, people, facts, steps, warnings, stem)


# --- the code snapshot -------------------------------------------------------------------------------------------

def local_imports(entry: Path, roots: list[Path]) -> tuple[set[Path], set[str]]:
    """Every local module `entry` imports, recursively, resolved against `roots` (the folders the step puts on
    sys.path). Returns (files found, module names that look local but were not found)."""
    seen: set[Path] = set()
    missing: set[str] = set()
    todo = [entry]
    local_tops = {p.name for r in roots for p in r.iterdir() if p.is_dir() or p.suffix == ".py"} if roots else set()
    local_tops = {n[:-3] if n.endswith(".py") else n for n in local_tops}
    while todo:
        f = todo.pop()
        if f in seen or not f.exists():
            continue
        seen.add(f)
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        names = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names += [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names.append(node.module)
                names += [f"{node.module}.{a.name}" for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level:
                base = f.parent
                for _ in range(node.level - 1):
                    base = base.parent
                mod = (node.module or "").split(".") if node.module else []
                cand = base.joinpath(*mod)
                for c in (cand.with_suffix(".py"), cand / "__init__.py"):
                    if c.exists():
                        todo.append(c)
        for n in names:
            parts = n.split(".")
            if parts[0] not in local_tops:
                continue
            found = False
            for r in roots:
                cand = r.joinpath(*parts)
                for c in (cand.with_suffix(".py"), cand / "__init__.py"):
                    if c.exists():
                        todo.append(c)
                        found = True
            # "from pkg import name" where name is a function, not a module, is fine when pkg resolved
            if not found and len(parts) > 1 and any(r.joinpath(*parts[:-1]).with_suffix(".py").exists()
                                                    or (r.joinpath(*parts[:-1]) / "__init__.py").exists() for r in roots):
                continue
            if not found:
                missing.add(n)
    return seen, missing


def step_roots(code: Path, entry: str) -> tuple[Path, list[Path]]:
    """(entry file, sys.path roots) for how each step runs."""
    if entry == "avatar":
        return code / "pipeline" / "avatar" / "run.py", [code, code / "pipeline"]
    if entry == "people":
        return code / "pipeline" / "recon" / "people.py", [code / "pipeline" / "recon", code / "pipeline"]
    return code / "pipeline" / "memory_job.py", [code / "pipeline"]


def snapshot(code: Path, src: Path = REPO) -> dict:
    """Copies pipeline/ (no tests, caches or data) and hpg/env.sh into `code`, then checks every step's imports
    resolve inside the copy. The chess memory lost a step to a helper module its job copy did not have."""
    if code.exists():
        shutil.rmtree(code)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "tests", "data", "*.spz", "*.ply", "*.glb")
    shutil.copytree(src / "pipeline", code / "pipeline", ignore=ignore)
    (code / "hpg").mkdir(parents=True, exist_ok=True)
    if (src / "hpg" / "env.sh").exists():
        shutil.copyfile(src / "hpg" / "env.sh", code / "hpg" / "env.sh")
    return check_imports(code)


def check_imports(code: Path) -> dict:
    report = {}
    for entry in ("people", "avatar", "memory"):
        f, roots = step_roots(code, entry)
        files, missing = local_imports(f, roots)
        report[entry] = {"modules": len(files), "missing": sorted(missing)}
    return report


# --- running -----------------------------------------------------------------------------------------------------

def sbatch_script(plan: Plan, step: Step) -> str:
    root = Path(plan.root)
    code = root / "code"
    head = ["#!/bin/bash", f"#SBATCH --job-name=mem-{plan.id}-{step.name}", "#SBATCH --ntasks=1",
            f"#SBATCH --output={root}/logs/{step.name}-%j.log"]
    t = int(min(step.limit, max(5.0, step.minutes * 1.5)))
    head.append(f"#SBATCH --time=00:{t:02d}:00" if t < 60 else f"#SBATCH --time={t // 60:02d}:{t % 60:02d}:00")
    if step.kind == "gpu":
        head += ["#SBATCH --gpus=1", "#SBATCH --cpus-per-task=16", "#SBATCH --mem=96G"]
    else:
        head += ["#SBATCH --cpus-per-task=16", "#SBATCH --mem=64G"]
    body = ["set -euo pipefail", f'source "{code}/hpg/env.sh"', "export HF_HUB_OFFLINE=1",
            'export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-16}"']
    if step.env == "avatar":
        body += ['export ANNY_CACHE_DIR="${ANNY_CACHE_DIR:-$HPG_ROOT/models/anny}"',
                 'export MULTIHMR2_CKPT="${MULTIHMR2_CKPT:-$HPG_ROOT/models/multihmr2/multihmr2.pt}"',
                 'tw_use_env avatar || tw_die "no avatar env (bash hpg/setup-avatar.sh submit)"']
    elif step.env == "recon":
        body += ['tw_use_env flashworld || tw_die "no flashworld env (bash hpg/setup.sh)"']
    body += [f'cd "{code}"', 'tw_say "memory step ' + step.name + ' on $(hostname)"',
             " ".join(shlex.quote(c) for c in step.cmd),
             f'python "{code}/pipeline/memory_job.py" check --plan "{root}/plan.json" --step {step.name}']
    return "\n".join(head + [""] + body) + "\n"


def write_job(plan: Plan) -> dict:
    root = Path(plan.root)
    for d in ("input", "work", "scene", "logs", "steps"):
        (root / d).mkdir(parents=True, exist_ok=True)
    imports = snapshot(root / "code")
    bad = {k: v["missing"] for k, v in imports.items() if v["missing"]}
    if bad:
        raise SystemExit(f"the code snapshot is missing modules the steps import: {bad}")
    (root / "plan.json").write_text(json.dumps(plan.to_json(), indent=1))
    for s in plan.steps:
        (root / "steps" / f"{s.name}.sbatch").write_text(sbatch_script(plan, s))
    return imports


def submit(plan: Plan, sbatch: str = "sbatch", account: str | None = None, qos: str | None = None,
           gpu_partition: str | None = None, cpu_qos: str | None = None, cpu_partition: str | None = None,
           runner=subprocess.run) -> dict:
    """Submits every step with afterok dependencies on the steps it needs. Returns {step: job id}."""
    import os

    account = account or os.environ.get("HPG_ACCOUNT", "phz3152")
    qos = qos or os.environ.get("HPG_QOS", account)
    gpu_partition = gpu_partition or os.environ.get("HPG_PARTITION", "hpg-rtx6000")
    cpu_qos = cpu_qos or f"{qos}-b"
    cpu_partition = cpu_partition or "hpg-dev,hpg-default,hpg-milan,hpg-turin"
    ids: dict[str, str] = {}
    root = Path(plan.root)
    for s in plan.steps:
        cmd = [sbatch, "--parsable", f"--account={account}"]
        cmd += [f"--qos={qos}", f"--partition={gpu_partition}"] if s.kind == "gpu" else \
            [f"--qos={cpu_qos}", f"--partition={cpu_partition}"]
        deps = [ids[a] for a in s.after]
        if deps:  # a failed (or failed-check) step cancels everything after it
            cmd += ["--dependency=afterok:" + ":".join(deps), "--kill-on-invalid-dep=yes"]
        cmd.append(str(root / "steps" / f"{s.name}.sbatch"))
        out = runner(cmd, capture_output=True, text=True, check=True).stdout.strip()
        ids[s.name] = out.split(";")[0]
    (root / "submitted.json").write_text(json.dumps({"jobs": ids, "at": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=1))
    return ids


# --- the in-job commands -----------------------------------------------------------------------------------------

def do_cut(plan: Plan, runner=subprocess.run) -> None:
    root = Path(plan.root)
    poses = json.loads(Path(plan_poses_source(plan)).read_text())
    doc, first, last = window_poses(poses, plan.start, plan.end)
    out_poses = root / "input" / f"{plan.clip_stem}-poses.json"
    out_poses.write_text(json.dumps(doc, indent=None))
    cut = next(Path(c) for c in plan.steps[0].checks["files"] if not c.endswith(".json"))
    dur = doc["track"][-1]["time"] + 1.0 / max(plan.facts.get("fps", 30.0), 1.0)
    runner(cut_command(Path(plan.clip), cut, plan.facts, first, last, doc["window"]["sourceTime"], dur), check=True)


def plan_poses_source(plan: Plan) -> str:
    return str(Path(plan.world) / f"{plan.clip_stem}-poses.json")


def check(plan: Plan, step_name: str, probe_fn=probe) -> list[str]:
    """Problems with what `step_name` should have written (empty: fine)."""
    step = next(s for s in plan.steps if s.name == step_name)
    c = step.checks
    problems = []
    for f in c.get("files", []):
        if not Path(f).exists() or Path(f).stat().st_size == 0:
            problems.append(f"missing or empty: {f}")
    for d in c.get("dirs", []):
        if not Path(d).is_dir() or not any(Path(d).iterdir()):
            problems.append(f"missing or empty folder: {d}")
    if "glob" in c:
        d, pattern, n = c["glob"]
        got = len(list(Path(d).glob(pattern)))
        if got < n:
            problems.append(f"{d}/{pattern}: {got} found, {n} expected")
    if "duration" in c and not problems:
        f, want = c["duration"]
        try:
            got = probe_fn(Path(f))["duration"]
            if abs(got - want) > max(0.25, 0.02 * want):
                problems.append(f"{f} is {got:.2f} s long, the window is {want:.2f} s")
        except Exception as e:  # noqa: BLE001
            problems.append(f"cannot read {f}: {e}")
    if "scene" in c and not problems:
        problems += check_scene(Path(c["scene"][0]))
    return problems


def check_scene(stage: Path) -> list[str]:
    problems = []
    try:
        s = json.loads((stage / "scene.json").read_text())
    except (OSError, ValueError) as e:
        return [f"scene.json unreadable: {e}"]
    v = s.get("video") or {}
    w = s.get("world") or {}
    for key, f in (("video.file", v.get("file")), ("video.cameraTrack", v.get("cameraTrack")), ("world.file", w.get("file"))):
        if not f:
            problems.append(f"scene.json has no {key}")
        elif not (stage / f).exists():
            problems.append(f"{key} names {f}, which is not in the folder")
    av = v.get("avatars")
    if isinstance(av, dict) and not av.get("scene"):
        j = stage / av.get("json", "avatar.json")
        if not j.exists():
            problems.append("video.avatars has no avatar.json beside it")
        else:
            for p in json.loads(j.read_text()).get("people", []):
                if not (stage / p["file"]).exists():
                    problems.append(f"avatar.json lists {p['file']}, which is missing")
        if av.get("poses") and not (stage / av["poses"]).exists():
            problems.append(f"video.avatars.poses names {av['poses']}, which is missing")
    return problems


def do_install(plan: Plan) -> dict:
    """The memory's folder: the clip's people (avatar-<k>.glb + avatar.json, already written there by photofit) named
    in video.avatars with the window's poses for the crossfade, then checked. The result stays in the job's scene/
    folder; copying it to the server's data/scenes/ is a plain rsync (printed)."""
    root = Path(plan.root)
    stage = root / "scene" / plan.id
    poses_name = f"{plan.clip_stem}-poses.json"
    shutil.copyfile(root / "input" / poses_name, stage / poses_name)
    people_out = root / "work" / "avatar-out"
    for f in sorted(people_out.glob("avatar-*.glb")) + [people_out / "avatar.json"]:
        if f.exists():
            shutil.copyfile(f, stage / f.name)
    sj = stage / "scene.json"
    s = json.loads(sj.read_text())
    if (stage / "avatar.json").exists():
        s.setdefault("video", {})["avatars"] = {"poses": poses_name}  # this folder (no `scene`), avatar.json default
    sj.write_text(json.dumps(s, indent=2))
    problems = check_scene(stage)
    if problems:
        raise SystemExit("the memory folder is not complete: " + "; ".join(problems))
    return {"scene": str(stage), "rsync": f"rsync -a {stage}/ <server>:data/scenes/{plan.id}/"}


# --- printing ----------------------------------------------------------------------------------------------------

def describe(plan: Plan, imports: dict | None = None) -> str:
    lines = [f"Memory {plan.id!r} ({plan.name}) from {Path(plan.clip).name}, {plan.start:g}-{plan.end:g} s "
             f"({plan.end - plan.start:.1f} s, {plan.people} people) in {Path(plan.world).name}",
             f"clip: {plan.facts.get('width')}x{plan.facts.get('height')} at {plan.facts.get('fps')} fps, "
             f"{'HDR (' + plan.facts.get('colorTransfer') + ')' if plan.facts.get('hdr') else 'standard colour (SDR)'}"
             f", {'audio' if plan.facts.get('audio') else 'no audio'}",
             f"job folder: {plan.root}", "",
             f"{'step':<10} {'where':<5} {'est min':>7} {'cap':>4}  after          notes"]
    for s in plan.steps:
        lines.append(f"{s.name:<10} {s.kind:<5} {s.minutes:>7.1f} {s.limit:>4.0f}  {','.join(s.after) or '-':<14} "
                     f"{s.note}")
    gpu = [s.name for s in plan.steps if s.kind == "gpu"]
    lines += ["", f"GPU steps, one at a time: {' -> '.join(gpu)}",
              f"estimated total GPU time {sum(s.minutes for s in plan.steps if s.kind == 'gpu'):.0f} min, "
              f"CPU {sum(s.minutes for s in plan.steps if s.kind == 'cpu'):.0f} min"]
    if imports:
        lines.append("code snapshot imports: " + ", ".join(f"{k} {v['modules']} modules"
                                                           + (f" MISSING {v['missing']}" if v["missing"] else "")
                                                           for k, v in imports.items()))
    for w in plan.warnings:
        lines.append(f"WARNING: {w}")
    lines += ["", "commands:"] + [f"  {s.name}: {' '.join(shlex.quote(c) for c in s.cmd)}" for s in plan.steps]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("cut", "check", "install"):
        ap = argparse.ArgumentParser()
        ap.add_argument("cmd")
        ap.add_argument("--plan", required=True)
        ap.add_argument("--step")
        a = ap.parse_args(argv)
        plan = Plan.from_json(json.loads(Path(a.plan).read_text()))
        if a.cmd == "cut":
            do_cut(plan)
        elif a.cmd == "check":
            problems = check(plan, a.step)
            for p in problems:
                print(f"CHECK FAILED ({a.step}): {p}", file=sys.stderr)
            print(f"check {a.step}: {'ok' if not problems else 'FAILED'}")
            return 1 if problems else 0
        else:
            print(json.dumps(do_install(plan), indent=1))
        return 0
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip", required=True, type=Path)
    ap.add_argument("--start", required=True, type=float)
    ap.add_argument("--end", required=True, type=float)
    ap.add_argument("--world", required=True, type=Path, help="the place's scene folder (world.spz, <clip>-poses.json)")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--caption", default="")
    ap.add_argument("--people", type=int, default=2)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--root", type=Path, default=None, help="job folder (default $HPG_ROOT/jobs/memory-<id>)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; write and submit nothing")
    ap.add_argument("--submit", action="store_true", help="write the job folder and submit the chain")
    a = ap.parse_args(argv)
    import os

    root = a.root or Path(os.environ.get("HPG_ROOT", str(REPO / "data"))) / "jobs" / f"memory-{a.id}"
    poses_file = a.world / f"{a.clip.stem}-poses.json"
    if not poses_file.exists():
        raise SystemExit(f"{poses_file} not found: the clip must be one the place was rebuilt from (its camera poses "
                         "come from that reconstruction)")
    facts = probe(a.clip)
    if a.end > facts["duration"] + 0.05:
        raise SystemExit(f"the window ends at {a.end} s but the clip is {facts['duration']:.2f} s long")
    window_poses(json.loads(poses_file.read_text()), a.start, a.end)  # fails early on a window with no poses
    plan = make_plan(a.clip.resolve(), a.start, a.end, a.world.resolve(), a.id, a.name, root.resolve(), a.people,
                     facts, poses_file, a.caption, a.fps)
    if a.dry_run or not a.submit:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(PIPELINE, Path(tmp) / "pipeline",
                            ignore=shutil.ignore_patterns("__pycache__", "tests", "data"))
            imports = check_imports(Path(tmp))
        print(describe(plan, imports))
        if not a.dry_run:
            print("\n(nothing written: add --submit to write the job folder and submit, or --dry-run to only plan)")
        return 0
    imports = write_job(plan)
    ids = submit(plan)
    print(describe(plan, imports))
    print("\nsubmitted: " + ", ".join(f"{k} {v}" for k, v in ids.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
