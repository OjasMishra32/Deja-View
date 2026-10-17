#!/usr/bin/env python3
"""One command for a video memory (team/shivin.md Update 19, job 3).

    python pipeline/memory_job.py --clip IMG_9291.mov --start 168.5 --end 189.5 --world data/scenes/chess-room \
        --id chess-match --name "Giant chess match" --people 2 --dry-run      # prints the plan, writes nothing
    python pipeline/memory_job.py ... --root $HPG_ROOT/jobs/memory-chess-match --submit    # on HiPerGator

Given a clip, a time window and the world it was filmed in, it plans the chain, writes one job folder with a
snapshot of the code, and submits the steps to Slurm with the right dependencies:

  cut       the window, exactly: frames first..last at the size the clip's camera was solved at, re-encoded with the
            clip's own colour tags (HDR stays HDR), the audio trimmed to match, the camera poses shifted to it (CPU)
  frames    people.py frames: output frames, analysis copies, initial poses (CPU)
  register  people.py register: segmentation, depth, poses refined against the world, room renders (GPU)
  pack      people.py pack: masks, depth, colour, tw-pack-v1 video, camera-track.json, the scene folder (CPU)
  poses     avatar run.py --steps hmr: per-frame body pose and shape (GPU)
  body      avatar run.py ground ... fill: tracks, the body, clothing volume, texture (CPU; split when long)
  photofit  avatar run.py photofit, glb: the fitted, animated people (GPU)
  install   the memory's folder: the people from the clip next to its video, checked (CPU)

The GPU steps run one at a time (register, then poses, then photofit); pack runs on a CPU beside poses. Every step
ends by checking its own outputs (`memory_job.py check`), so a step that "succeeds" without writing what the next one
reads fails there, and Slurm's afterok cancels the rest.

What it fixes from the chess and kitchen memories, which took many separate steps and several fixes by hand:
  camera size        the cut is scaled to the size the clip's camera was solved at (the 4K chess clip against its
                     2560x1440 poses stopped people.py frames)
  SDR clips          the cut keeps the clip's colour tags, so people.py reads HDR (HLG or PQ) or standard colour from
                     the file; no exposure gain is forced on a standard clip
  pose-only runs     the pose step is its own GPU job (run.py --steps hmr) and is checked for hmr.npz alone
  missing helpers    the job runs from a snapshot of the whole pipeline/ folder, and the plan checks that every
                     local module each step imports (recursively) is in the snapshot before anything is submitted
  tools on PATH      every step runs inside a pipeline env, which has python, ffmpeg and ffprobe
  the 29-minute cap  each step is estimated from the window, the camera size and the number of people (timings
                     measured on HiPerGator); register refines every n-th pose (--refine-every) with n picked to fit,
                     photofit drops to one pass, and the avatar CPU steps are split at their cached step boundaries

Ojasva runs the real one. `--dry-run` prints the plan and changes nothing.
"""
from __future__ import annotations

import argparse
import ast
import json
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

# Minutes, measured on HiPerGator: the chess memory (21 s window, camera 2560x1440, two people; jobs 46426931 frames,
# 46441943 register, 46441944 pack, 46426934 poses, 46445750 body, 46453770 photofit) and the kitchen memory (49.7 s,
# 1920x1080; 46412351 frames, 46423560 register, 46428669 pack). GPU steps on an RTX PRO 6000, CPU steps on 16 cores.
RATES = {
    "cut": (1.0, 0.05),  # (fixed, per second of window)
    "frames": (0.3, 0.15),  # 3.1 min for 21 s, 7.4 min for 49.7 s
    "poses": (1.0, 0.05),  # 1.7 min for 21 s, most of it loading the network
    "body": (0.5, 0.67),  # per person-second: 28.6 min for two people and 21 s
    "install": (1.0, 0.0),
}
# The avatar CPU steps' shares of that time: refine (which solves ground again) took 62 %, texture 28 %.
BODY_STEPS = ["ground", "refine", "body", "offsets", "texture", "fill"]
BODY_WEIGHTS = {"ground": 0.05, "refine": 0.62, "body": 0.01, "offsets": 0.01, "texture": 0.27, "fill": 0.04}
# people.py register: models and frames first, then each refined pose (7.1 s with 1280x720 analysis frames, 3.7 s with
# 960x540: about 7.7 s per megapixel), then every frame's room render (0.43 s and 0.28 s). Chess refining every 6th
# frame: 17.7 min measured, 17.8 estimated; every 3rd would have needed 30.
REG_SETUP_MIN = (0.3, 0.0006)  # fixed, per frame
REG_REFINE_S_PER_MP = 7.7
REG_RENDER_S = (0.1, 0.36)  # seconds per frame: fixed, per analysis megapixel
# people.py pack: 1.15 s per frame at 2560x1440, 0.77 s at 1920x1080 (masks, depth, colour, the encode).
PACK_S = (0.28, 0.236)  # seconds per frame: fixed, per megapixel of the full frame
# pipeline/avatar/photofit.py: steps = 72 visits per frame / batch 8, bounded 1500..6000 (pass 1: two thirds, at
# least 1000); each person's pass stops at its time budget (4.5 min pass 1, 6.5 min the last). Chess: 0.068 s a step,
# and before each pass 4.5 min of masks and clip loading. One pass: 17.7 min measured, 17.8 estimated; two passes ran
# into the cap (31 estimated).
PF_STEP_MIN = 0.00115
PF_BUDGET = (4.5, 6.5)
PF_SETUP_MIN = 0.2
PF_PREP_MIN = 0.21  # per pass, per second of window
PF_PERSON_MIN = 0.1  # per person and pass: the renders before and after the fit
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}


def photofit_minutes(seconds: float, people: int, fps: float = 30.0, passes: int = 2) -> float:
    frames = seconds * fps
    last = min(6000, max(1500, round(72 * frames / 8)))
    first = max(1000, round(last * 2 / 3))
    fits = [min(PF_BUDGET[1], last * PF_STEP_MIN)]
    if passes > 1:
        fits.insert(0, min(PF_BUDGET[0], first * PF_STEP_MIN))
    return round(PF_SETUP_MIN + passes * PF_PREP_MIN * seconds + people * sum(f + PF_PERSON_MIN for f in fits), 1)


def register_minutes(frames: int, camera: tuple[int, int], every: int = 1) -> float:
    """people.py register for `frames` output frames of a clip whose camera is `camera` (analysis frames at half
    size), refining every `every`-th pose (and the last)."""
    mp = (camera[0] // 2) * (camera[1] // 2) / 1e6
    refined = len(range(0, frames, every)) + (1 if every > 1 and (frames - 1) % every else 0)
    s = refined * REG_REFINE_S_PER_MP * mp + frames * (REG_RENDER_S[0] + REG_RENDER_S[1] * mp)
    return round(REG_SETUP_MIN[0] + REG_SETUP_MIN[1] * frames + s / 60, 1)


def pack_minutes(frames: int, camera: tuple[int, int]) -> float:
    return round(0.2 + frames * (PACK_S[0] + PACK_S[1] * camera[0] * camera[1] / 1e6) / 60, 1)


# --- clip facts --------------------------------------------------------------------------------------------------

def probe(clip: Path) -> dict:
    """ffprobe: frame rate, duration, size, colour tags, audio. Raises when the file is not a video."""
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(clip)],
                         capture_output=True, text=True, check=True).stdout
    return clip_facts(json.loads(out))


def count_frames(clip: Path) -> int:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                          "stream=nb_read_frames", "-of", "csv=p=0", str(clip)], capture_output=True, text=True,
                         check=True).stdout
    return int(out.strip().rstrip(",") or 0)


def clip_facts(doc: dict) -> dict:
    v = next((s for s in doc.get("streams", []) if s.get("codec_type") == "video"), None)
    if v is None:
        raise ValueError("no video stream")
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    dur = float(v.get("duration") or doc.get("format", {}).get("duration") or 0.0)
    trc = v.get("color_transfer") or ""
    rotation = next((sd["rotation"] for sd in v.get("side_data_list") or [] if "rotation" in sd),
                    (v.get("tags") or {}).get("rotate", 0))
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    if abs(int(round(float(rotation or 0)))) % 180 == 90:  # ffmpeg turns the frames upright when it decodes them
        w, h = h, w
    return {"fps": round(fps, 4), "duration": dur, "width": w, "height": h,
            "pixFmt": v.get("pix_fmt", ""), "colorTransfer": trc, "colorPrimaries": v.get("color_primaries", ""),
            "colorSpace": v.get("color_space", ""), "hdr": trc in HDR_TRANSFERS,
            "audio": any(s.get("codec_type") == "audio" for s in doc.get("streams", []))}


def poses_camera(poses: dict) -> tuple[int, int]:
    """The size the clip's camera was solved at: people.py frames needs the clip at exactly this size."""
    k = poses.get("intrinsics") or {}
    v = poses.get("video") or {}
    return int(k.get("width") or v["width"]), int(k.get("height") or v["height"])


def world_inputs(world: Path) -> tuple[str, list[str]]:
    """The world file the place's scene.json names (register renders it, pack copies it with the collider and the
    map) and the problems with the folder (empty: fine)."""
    try:
        w = json.loads((world / "scene.json").read_text()).get("world") or {}
    except (OSError, ValueError) as e:
        return "world.spz", [f"{world}/scene.json unreadable ({e}); pack copies the world from it"]
    name = w.get("file") or ""
    if not name:
        return "world.spz", [f"{world}/scene.json has no world.file"]
    files = [name, w.get("collider"), (w.get("topdown") or {}).get("file")]
    return name, [f"{world / f} is missing (scene.json names it)" for f in files if f and not (world / f).exists()]


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
    doc["registered"] = doc["sampled"] = len(doc["keyframes"])
    doc["window"] = {"start": start, "end": end, "firstFrame": first, "lastFrame": last, "sourceTime": t0}
    if isinstance(doc.get("video"), dict):
        doc["video"] = {**doc["video"], "frames": last - first + 1, "duration": round(doc["track"][-1]["time"], 6)}
    return doc, first, last


def cut_command(clip: Path, out: Path, facts: dict, first: int, last: int, t0: float, dur: float,
                size: tuple[int, int] | None = None) -> list[str]:
    """ffmpeg: exactly source frames first..last (selected by number, timestamps restarted), scaled to `size` (the
    camera's) when the clip differs, re-encoded near-lossless with the clip's own colour tags so HDR stays HDR for
    people.py; the first audio track trimmed to the same span (phones add tracks ffmpeg cannot decode)."""
    ten_bit = "10" in facts.get("pixFmt", "") or facts.get("hdr")
    vf = f"select='between(n\\,{first}\\,{last})',setpts=PTS-STARTPTS"
    if size and tuple(size) != (facts.get("width"), facts.get("height")):
        vf += f",scale={size[0]}:{size[1]}:flags=lanczos"
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(clip), "-map", "0:v:0", "-vf", vf, "-fps_mode", "passthrough"]
    if ten_bit:
        cmd += ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-crf", "10", "-preset", "medium", "-tag:v", "hvc1"]
    else:
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", "-preset", "medium"]
    for flag, key in (("-color_primaries", "colorPrimaries"), ("-color_trc", "colorTransfer"),
                      ("-colorspace", "colorSpace")):
        if facts.get(key):
            cmd += [flag, facts[key]]
    if facts.get("audio"):
        cmd += ["-map", "0:a:0", "-af", f"atrim=start={t0:.6f}:duration={dur:.6f},asetpts=PTS-STARTPTS",
                "-c:a", "aac", "-b:a", "192k"]
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
    env: str = "recon"  # "recon" (people.py and this script: the flashworld env) or "avatar"
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
    camera: list[int] = field(default_factory=list)

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
    per = seconds * (people if name == "body" else 1)
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


# what each avatar CPU step leaves in the work folder for the next one: (file or pattern, per person)
BODY_OUTPUTS = {"ground": ("tracks.npz", False), "refine": ("refine.json", False), "body": ("asset-*.npz", True),
                "offsets": ("offsets-*.json", True), "texture": ("texture-*.json", True),
                "fill": ("tex-[0-9]*.jpg", True)}


def cut_path(root: Path, clip: Path) -> Path:
    return root / "input" / f"{clip.stem}-window{clip.suffix.lower() if clip.suffix else '.mov'}"


def make_plan(clip: Path, start: float, end: float, world: Path, mem_id: str, name: str, root: Path, people: int,
              facts: dict, camera: tuple[int, int] | None = None, caption: str = "", fps: float = 30.0,
              world_file: str = "world.spz") -> Plan:
    """`camera`: the size the clip's camera was solved at (default: the clip's own); `world_file`: the world the
    place's scene.json names."""
    if end <= start:
        raise ValueError("the window ends before it starts")
    seconds = end - start
    camera = tuple(camera or (facts["width"], facts["height"]))
    frames_out = int(seconds * fps)
    W = root / "work"
    stage = root / "scene" / mem_id
    stem = clip.stem
    cut = cut_path(root, clip)
    cut_poses = root / "input" / f"{stem}-poses.json"
    code = root / "code"
    world_spz = world / world_file
    py = "python"
    people_py = [py, "-u", str(code / "pipeline" / "recon" / "people.py")]
    people_out = W / "avatar-out"  # copied into the scene at install: pack writes there in parallel
    avatar = [py, "-W", "ignore", "-m", "pipeline.avatar.run", "--work", str(W / "avatar"), "--video", str(cut),
              "--poses", str(cut_poses), "--out-dir", str(people_out), "--people", str(people), "--fps", str(fps),
              "--start", "0", "--max-seconds", f"{seconds + 1:.3f}", "--clip", stem, "--world", str(world_spz)]
    warnings = []
    cut_note = (f"scaled from {facts.get('width')}x{facts.get('height')} to the camera's {camera[0]}x{camera[1]}"
                if camera != (facts.get("width"), facts.get("height")) else "")
    steps = [Step("cut", "cpu", [py, str(code / "pipeline" / "memory_job.py"), "cut", "--plan", str(root / "plan.json")],
                  minutes=estimate("cut", seconds, people),
                  checks={"files": [str(cut), str(cut_poses)], "duration": [str(cut), seconds]}, note=cut_note)]
    frames = people_py + ["frames", "--work", str(W / "people"), "--clip", str(cut), "--poses", str(cut_poses),
                          "--fps", str(fps)]
    if facts.get("hdr"):
        note = "HDR clip: people.py picks the exposure gain"
    else:
        note = "standard (SDR) clip: plain exposure, no HDR gain"
    least = int(frames_out * 0.9)
    steps.append(Step("frames", "cpu", frames, ["cut"], estimate("frames", seconds, people),
                      checks={"files": [str(W / "people" / "frames.json")],
                              "globs": [[str(W / "people"), "small/f*.jpg", least]]}, note=note))
    reg = people_py + ["register", "--work", str(W / "people"), "--world", str(world_spz)]
    budget = GPU_LIMIT_MIN * HEADROOM
    every = next((n for n in range(1, frames_out + 1) if register_minutes(frames_out, camera, n) <= budget), None)
    if every is None:
        every = max(1, frames_out)
        warnings.append(f"register is estimated at {register_minutes(frames_out, camera, every)} min even refining "
                        "only the first and last pose; a shorter window keeps it under the GPU cap")
    reg_min = register_minutes(frames_out, camera, every)
    reg_note = ""
    if every > 1:
        reg += ["--refine-every", str(every)]
        reg_note = (f"long window: poses refined on every {ordinal(every)} frame, interpolated between "
                    f"(every frame: {register_minutes(frames_out, camera)} min)")
    steps.append(Step("register", "gpu", reg, ["frames"], reg_min,
                      checks={"files": [str(W / "people" / "register.json")],
                              "globs": [[str(W / "people"), "gpu/f*.npz", least]]}, note=reg_note))
    steps.append(Step("pack", "cpu", people_py + ["pack", "--work", str(W / "people"), "--clip", str(cut),
                                                  "--world-scene", str(world), "--scene-dir", str(stage), "--id", mem_id,
                                                  "--name", name, "--caption", caption],
                      ["register"], pack_minutes(frames_out, camera),
                      checks={"files": [str(stage / f) for f in ("scene.json", "camera-track.json", "people.mp4")]}))
    steps.append(Step("poses", "gpu", avatar + ["--steps", "hmr"], ["register"], estimate("poses", seconds, people),
                      env="avatar", checks={"files": [str(W / "avatar" / "hmr.npz")]},
                      note="pose step only; the CPU steps make the tracks in their own job"))
    groups = split_body(seconds, people)
    prev = "poses"
    for k, g in enumerate(groups):
        nm = "body" if len(groups) == 1 else f"body-{k + 1}"
        m = round(sum(estimate("body", seconds, people) * BODY_WEIGHTS[s] for s in g), 1)
        chk = {"files": [str(W / "avatar" / BODY_OUTPUTS[s][0]) for s in g if not BODY_OUTPUTS[s][1]],
               "globs": [[str(W / "avatar"), BODY_OUTPUTS[s][0], people] for s in g if BODY_OUTPUTS[s][1]]}
        steps.append(Step(nm, "cpu", avatar + ["--steps", ",".join(g)], [prev], m, env="avatar", checks=chk,
                          note=f"steps {', '.join(g)}"))
        prev = nm
    pf_min = photofit_minutes(seconds, people, fps)
    pf = avatar + ["--steps", "photofit,glb"]
    pf_note = ""
    if pf_min > budget:
        one = photofit_minutes(seconds, people, fps, passes=1)
        if one <= budget:
            pf += ["--photofit-passes", "1"]
            pf_note = f"long window: one photofit pass (two would take {pf_min} min)"
            pf_min = one
        else:
            pf += ["--photofit", "off"]
            pf_note = "very long window: photofit off, the people keep their baked texture"
            warnings.append(f"photofit is estimated at {one} min even with one pass (two: {pf_min}); it is turned off. "
                            "A shorter window, or fewer people, keeps it")
            pf_min = 1.0  # the GLBs alone
    steps.append(Step("photofit", "gpu", pf, [prev], pf_min, env="avatar",
                      checks={"files": [str(people_out / "avatar.json")],
                              "globs": [[str(people_out), "avatar-*.glb", people]]}, note=pf_note))
    steps.append(Step("install", "cpu", [py, str(code / "pipeline" / "memory_job.py"), "install", "--plan",
                                         str(root / "plan.json")],
                      ["pack", "photofit"], estimate("install", seconds, people),
                      checks={"files": [str(stage / "scene.json"), str(stage / "avatar.json")], "scene": [str(stage)]}))
    for s in steps:
        if s.minutes > s.limit:
            what = f" ({s.note.removeprefix('steps ')})" if s.name.startswith("body") else ""
            warnings.append(f"{s.name}{what} is estimated at {s.minutes} min, over its {s.limit:.0f} min cap")
    return Plan(mem_id, name, str(root), str(clip), str(world), start, end, people, facts, steps, warnings, stem,
                list(camera))


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


def env_script(src: Path = REPO) -> Path | None:
    """hpg/env.sh, which every step sources first: beside pipeline/, else the cluster's repo copy ($TW_REPO or
    $HPG_ROOT/repo; a working copy such as code-memjob/ holds only pipeline/)."""
    import os

    found = [src / "hpg" / "env.sh"]
    for base in (os.environ.get("TW_REPO"), os.environ.get("HPG_ROOT") and f"{os.environ['HPG_ROOT']}/repo"):
        if base:
            found.append(Path(base) / "hpg" / "env.sh")
    return next((f for f in found if f.exists()), None)


def snapshot(code: Path, src: Path = REPO) -> dict:
    """Copies pipeline/ (no tests, caches or data) and hpg/env.sh into `code`, then checks every step's imports
    resolve inside the copy. The kitchen memory's pack lost a run to a helper module its job copy did not have."""
    env = env_script(src)
    if env is None:
        raise SystemExit(f"no hpg/env.sh in {src} or $HPG_ROOT/repo: every step sources it first")
    if code.exists():
        shutil.rmtree(code)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "tests", "data", "*.spz", "*.ply", "*.glb")
    shutil.copytree(src / "pipeline", code / "pipeline", ignore=ignore)
    (code / "hpg").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(env, code / "hpg" / "env.sh")
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
    t = int(min(step.limit, max(10.0, step.minutes * 1.5)))
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
    else:  # python, ffmpeg and ffprobe: a compute node has none of them on its own PATH
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


def resume_plan(plan: Plan, from_step: str, probe_fn=probe) -> tuple[Plan, list[str]]:
    """The part of `plan` from `from_step` on (that step and every step after it in the plan), for a chain that
    stopped part way. Steps it waits for that came before it are not run again, so their outputs must be there:
    each one's own check runs now (only the steps it reads from directly: a finished step's own inputs may be gone,
    and are not needed). Returns (the plan to submit, problems). Dependencies on steps already done drop out; the
    rest keep their afterok order."""
    names = [s.name for s in plan.steps]
    if from_step not in names:
        raise SystemExit(f"--from {from_step}: not a step of this plan ({', '.join(names)})")
    chosen = plan.steps[names.index(from_step):]
    keep = {s.name for s in chosen}
    needed = sorted({a for s in chosen for a in s.after if a not in keep}, key=names.index)
    problems = [f"{n}: {p}" for n in needed for p in check(plan, n, probe_fn)]
    steps = [Step(**{**asdict(s), "after": [a for a in s.after if a in keep]}) for s in chosen]
    rest = {k: v for k, v in asdict(plan).items() if k != "steps"}
    return Plan(**rest, steps=steps), problems


def submit(plan: Plan, sbatch: str = "sbatch", account: str | None = None, qos: str | None = None,
           gpu_partition: str | None = None, cpu_qos: str | None = None, cpu_partition: str | None = None,
           runner=subprocess.run, record: str = "submitted.json") -> dict:
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
    (root / record).write_text(json.dumps({"jobs": ids, "at": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=1))
    return ids


# --- the in-job commands -----------------------------------------------------------------------------------------

def do_cut(plan: Plan, runner=subprocess.run, count_fn=count_frames) -> None:
    root = Path(plan.root)
    poses = json.loads(Path(plan_poses_source(plan)).read_text())
    doc, first, last = window_poses(poses, plan.start, plan.end)
    cut = cut_path(root, Path(plan.clip))
    doc["source"] = cut.name
    out_poses = root / "input" / f"{plan.clip_stem}-poses.json"
    out_poses.write_text(json.dumps(doc, indent=None))
    dur = doc["track"][-1]["time"] + 1.0 / max(plan.facts.get("fps", 30.0), 1.0)
    runner(cut_command(Path(plan.clip), cut, plan.facts, first, last, doc["window"]["sourceTime"], dur,
                       tuple(plan.camera) or None), check=True)
    n = count_fn(cut)
    if n != last - first + 1:  # the poses are matched to the cut's frames by number
        raise SystemExit(f"the cut has {n} frames, the window {last - first + 1} (source frames {first}..{last})")


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
    for d, pattern, n in c.get("globs", []):
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
    av = {"people": av} if isinstance(av, list) else av if isinstance(av, dict) else {}
    if not av.get("scene"):  # the people are in this folder (named, or avatar.json by the folder convention)
        j = stage / (av.get("json") or "avatar.json")
        if j.exists():
            for p in json.loads(j.read_text()).get("people", []) + list(av.get("people") or []):
                if not (stage / p["file"]).exists():
                    problems.append(f"{j.name} lists {p['file']}, which is missing")
        elif av:
            problems.append(f"video.avatars names people but {j.name} is missing")
        if av.get("poses") and not (stage / av["poses"]).exists():
            problems.append(f"video.avatars.poses names {av['poses']}, which is missing")
    return problems


def do_install(plan: Plan) -> dict:
    """The memory's folder: the clip's people (avatar-<k>.glb + avatar.json from photofit) beside its video, then
    checked. scene.json stays as pack wrote it: the viewer finds avatar.json in the memory's own folder, and the
    crossfade follows its camera-track.json, the refined camera of every packed frame (web/src/viewer/avatar-files.ts).
    The result stays in the job's scene/ folder; copying it to the server's data/scenes/ is a plain rsync (printed)."""
    root = Path(plan.root)
    stage = root / "scene" / plan.id
    people_out = root / "work" / "avatar-out"
    for f in sorted(people_out.glob("avatar-*.glb")) + [people_out / "avatar.json"]:
        if f.exists():
            shutil.copyfile(f, stage / f.name)
    problems = [] if (stage / "avatar.json").exists() else ["no avatar.json from the photofit step"]
    problems += check_scene(stage)
    if problems:
        raise SystemExit("the memory folder is not complete: " + "; ".join(problems))
    return {"scene": str(stage), "rsync": f"rsync -a {stage}/ <server>:data/scenes/{plan.id}/"}


# --- printing ----------------------------------------------------------------------------------------------------

def describe(plan: Plan, imports: dict | None = None) -> str:
    cam = f", camera solved at {plan.camera[0]}x{plan.camera[1]}" if plan.camera else ""
    lines = [f"Memory {plan.id!r} ({plan.name}) from {Path(plan.clip).name}, {plan.start:g}-{plan.end:g} s "
             f"({plan.end - plan.start:.1f} s, {plan.people} people) in {Path(plan.world).name}",
             f"clip: {plan.facts.get('width')}x{plan.facts.get('height')} at {plan.facts.get('fps')} fps{cam}, "
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
    if "--from" in argv:
        return resume_main(argv)
    ap.add_argument("--clip", required=True, type=Path)
    ap.add_argument("--start", required=True, type=float)
    ap.add_argument("--end", required=True, type=float)
    ap.add_argument("--world", required=True, type=Path,
                    help="the place's scene folder (scene.json, its world file, collider and map, <clip>-poses.json)")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--caption", default="")
    ap.add_argument("--people", type=int, default=2)
    ap.add_argument("--fps", type=float, default=30.0, help="the packed video's rate (the viewer plays 30)")
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
    world_file, problems = world_inputs(a.world)
    if problems:
        raise SystemExit("the world folder is not complete: " + "; ".join(problems))
    facts = probe(a.clip)
    if a.end > facts["duration"] + 0.05:
        raise SystemExit(f"the window ends at {a.end} s but the clip is {facts['duration']:.2f} s long")
    poses = json.loads(poses_file.read_text())
    window_poses(poses, a.start, a.end)  # fails early on a window with no poses
    camera = poses_camera(poses)
    if abs(camera[0] / camera[1] - facts["width"] / facts["height"]) > 0.01:
        raise SystemExit(f"the clip is {facts['width']}x{facts['height']} but its camera was solved at "
                         f"{camera[0]}x{camera[1]}, another shape")
    plan = make_plan(a.clip.resolve(), a.start, a.end, a.world.resolve(), a.id, a.name, root.resolve(), a.people,
                     facts, camera, a.caption, a.fps, world_file)
    if env_script() is None:
        plan.warnings.append(f"no hpg/env.sh beside {PIPELINE.name}/ or in $HPG_ROOT/repo: --submit would stop")
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


def resume_main(argv: list[str], probe_fn=probe, runner=subprocess.run) -> int:
    """`--from <step> --root <job folder> [--dry-run | --submit]`: picks up a chain from its job folder (plan.json,
    the code snapshot and the step scripts the first --submit wrote) at that step, after checking the outputs of
    the steps before it that it needs."""
    ap = argparse.ArgumentParser(prog="memory_job.py --from")
    ap.add_argument("--from", dest="from_step", required=True)
    ap.add_argument("--root", required=True, type=Path, help="the job folder of the earlier --submit")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--submit", action="store_true")
    a, _ = ap.parse_known_args(argv)
    pj = a.root / "plan.json"
    if not pj.exists():
        raise SystemExit(f"{pj} not found: --from picks up a chain an earlier --submit wrote")
    plan = Plan.from_json(json.loads(pj.read_text()))
    part, problems = resume_plan(plan, a.from_step, probe_fn)
    if problems:
        raise SystemExit(f"cannot start at {a.from_step}; the steps before it are not done:\n  " + "\n  ".join(problems))
    print(f"resuming {plan.id} at {a.from_step}: {', '.join(s.name for s in part.steps)}\n")
    print(describe(part))
    if not a.submit or a.dry_run:
        if not a.dry_run:
            print("\n(nothing submitted: add --submit)")
        return 0
    missing = [s.name for s in part.steps if not (a.root / "steps" / f"{s.name}.sbatch").exists()]
    if missing:
        raise SystemExit(f"step scripts missing in {a.root / 'steps'}: {', '.join(missing)}")
    ids = submit(part, runner=runner, record=f"submitted-from-{a.from_step}-{time.strftime('%Y%m%d-%H%M%S')}.json")
    print("\nsubmitted: " + ", ".join(f"{k} {v}" for k, v in ids.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
