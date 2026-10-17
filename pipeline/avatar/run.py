"""Déjà View avatars, end to end: a clip with people + its camera track -> avatar-<k>.glb per person.

    python -m pipeline.avatar.run --work WORK --video IMG_7373.mov --poses IMG_7373-poses.json --out-dir OUT \
        [--people 2] [--backview auto|on|off] [--fps 30] [--start 0] [--max-seconds 60] [--steps all] [--force x,y]
        [--world SCENE/world.spz] [--refine full|legs|off] [--fill garment|lama] [--photofit on|off]
        [--backpack auto|on|off] [--holdout heldout.json]

Steps (each cached in WORK; --force re-runs the named ones, and a step that runs makes every later step run too):
  hmr      per-frame pose + shape with our intrinsics (GPU)                    -> hmr.npz, frames/, masks/
  ground   identities, outliers, constant bone lengths, floor, smoothing    -> tracks.npz, ground.json
  refine   detections aligned to the person masks (smoothed along each track), hidden legs borrowed from the
           nearest frame that shows them, cut-off detections that match the mask trusted; ground again
                                                                            -> hmr-refined.npz, refine.json, tracks.npz
  body     canonical mesh per person at its median phenotype                -> asset-<k>.npz
  offsets  clothing/hair/backpack volume from the silhouettes (photofit's starting point; the bake keeps them only
           if IoU rises by --offsets-min-gain)                              -> offsets-<k>.npz, offsets-<k>.json
  texture  real pixels into a 2048 atlas (furniture from --world hides)    -> tex_seen-<k>.png, texture-<k>.json
  backview generated back for persons whose back is mostly unseen (GPU)     -> back-<k>.npz
  fill     garment colours (or mirror + LaMa) for unseen texels, gutter     -> tex-<k>.jpg (+ tex-f1-<k>.jpg)
  photofit texture, clothing volume, alignment and colour gains fitted to every frame by differentiable rendering,
           two passes (GPU, about 15 minutes for two people and 12 s)      -> photofit/ (asset, tex, pose per person)
  glb      skinned, textured, animated GLB per person + avatar.json (--ao: folds and the gap under a backpack
           shaded by the rest mesh's ambient occlusion)                    -> OUT/avatar-<k>.glb, OUT/avatar.json

The GLBs come from photofit when it ran (texture "photofit"), else from the baked texture ("texture"). If texturing
fails, they carry one flat colour per body region (fallback F1) and avatar.json says so. --holdout names frames
(heldout.json, pipeline/avatar_v2/yardstick.py) the photofit never fits, for measuring on frames it never saw; build
WORK with pipeline/avatar_v2/holdout.py so the other steps never see them either.
"""

from __future__ import annotations

import argparse

import sys
import time
import traceback
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar.util import log, read_json, use_pipeline_common, write_json

STEPS = ["hmr", "ground", "refine", "body", "offsets", "texture", "backview", "fill", "photofit", "glb"]

CREDITS = [
    "Multi-HMR 2 (NAVER, non-commercial licence; BEDLAM and AnnyOne terms)",
    "Anny body model (NAVER, Apache-2.0 code, CC0 assets)",
    "DINOv3 backbone code (DINOv3 License)",
    "Qwen-Image-Edit-2511 (Apache-2.0)",
    "Big LaMa (Apache-2.0)",
    "Open3D (MIT)",
    "PyTorch (BSD-3-Clause)",
    "OpenCV (Apache-2.0)",
    "pygltflib (MIT)",
]


def _anny():
    from pipeline.avatar import body

    m = body.build_anny()
    return m, body.anny_static(m)


def step_body(work: Path, tracks, static) -> list:
    from pipeline.avatar import body

    assets = []
    k = 0
    while f"person-{k}/rest_vertices" in tracks:
        a = body.build_asset(static, tracks[f"person-{k}/rest_vertices"], tracks[f"person-{k}/rest_bone_poses"])
        a.save(work / f"asset-{k}.npz")
        assets.append(a)
        log("body", f"person {k}: {len(a.positions)} vertices, {len(a.tris)} triangles")
        k += 1
    return assets


def hmr_file(work: Path, refine: str = "full") -> str:
    """The detections the steps after ground read: the refine step's when it ran (and is not switched off)."""
    return "hmr-refined.npz" if refine != "off" and (work / "hmr-refined.npz").exists() else "hmr.npz"


def step_texture(work: Path, assets, tracks, size: int, world: str | None = None, poses: str | None = None,
                 hmr_name: str = "hmr.npz") -> list[dict]:
    import cv2

    from pipeline.avatar import texture

    hmr = np.load(work / hmr_name)
    occ = cams = None
    if world and poses and Path(world).exists():
        from pipeline.avatar import ground
        from pipeline.avatar.world import Occluders

        occ = Occluders(Path(world))
        cams = ground.camera_track(read_json(Path(poses)))
        log("texture", f"furniture occluders: {len(occ.points)} splats below 1.05 m from {world}")
    res = texture.bake(work, assets, tracks, hmr, size=size, occluders=occ, cams=cams)
    (work / "evidence").mkdir(exist_ok=True)
    out = []
    for k, r in enumerate(res):
        cv2.imwrite(str(work / f"tex_seen-{k}.png"), r["tex"][:, :, ::-1])
        cv2.imwrite(str(work / f"seen-{k}.png"), r["seen"])
        cov = texture.coverage_image(r["texel_map"], r["weight"])
        cv2.imwrite(str(work / "evidence" / f"coverage-{k}.png"), cv2.resize(cov, (1024, 1024))[:, :, ::-1])
        cv2.imwrite(str(work / "evidence" / f"tex_seen-{k}.jpg"), cv2.resize(r["tex"], (1024, 1024))[:, :, ::-1])
        info = {"coverage": r["coverage"], "regions": r["regions"]}
        write_json(work / f"texture-{k}.json", info)
        out.append(info)
    return out


def step_fill(work: Path, assets, size: int, use_lama: bool, backs: dict, method: str = "garment") -> list[dict]:
    import cv2

    from pipeline.avatar import fill, texture

    inpainter = None
    if use_lama and method == "lama":
        try:
            use_pipeline_common()
            from common.models import Inpainter

            inpainter = Inpainter("big-lama")
        except Exception as e:  # LaMa missing: holes get the push-pull fill only
            log("fill", f"LaMa unavailable ({e}); holes get the push-pull fill")
    reps = []
    for k, a in enumerate(assets):
        tm = texture.texel_map(a, size)
        tex_seen = cv2.imread(str(work / f"tex_seen-{k}.png"))[:, :, ::-1]
        seen = cv2.imread(str(work / f"seen-{k}.png"), cv2.IMREAD_GRAYSCALE)[tm.ys, tm.xs] > 127
        img, jpeg, rep = fill.fill(a, tm, tex_seen, seen, inpainter, backs.get(k), method=method)
        (work / f"tex-{k}.jpg").write_bytes(jpeg)
        write_json(work / f"fill-{k}.json", rep)
        cv2.imwrite(str(work / "evidence" / f"tex-{k}.jpg"), cv2.resize(img, (1024, 1024))[:, :, ::-1])
        # flat-colour fallback texture (F1)
        info = read_json(work / f"texture-{k}.json", {})
        reg, _ = texture.texel_regions(a, tm)
        f1 = texture.region_texture(tm, reg, info.get("regions", texture.DEFAULT_REGION_COLOURS))
        _, f1_jpeg = fill.finish(f1.astype(np.float32), tm.tri >= 0)
        (work / f"tex-f1-{k}.jpg").write_bytes(f1_jpeg)
        reps.append(rep)
    return reps


def shade_ao(asset, jpeg: bytes, strength: float, size: int = 2048) -> tuple[bytes, dict]:
    """The texture darkened by the rest-pose mesh's ambient occlusion (folds, the hem, under a backpack): times
    1 - strength * occlusion."""
    import cv2

    from pipeline.avatar import fill, raster, texture

    nv = int(asset.src_vertex.max()) + 1
    mv = np.zeros((nv, 3))
    mv[asset.src_vertex] = asset.positions
    occ = raster.ambient_occlusion(mv, asset.src_vertex[asset.tris])[asset.src_vertex]
    tm = texture.texel_map(asset, size)
    F = asset.tris[tm.tid]
    ot = (tm.bary * occ[F]).sum(1)
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)[:, :, ::-1].astype(np.float32)
    if img.shape[0] != size:
        img = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)
    img[tm.ys, tm.xs] *= (1.0 - strength * ot)[:, None]
    _, out = fill.finish(img, tm.tri >= 0)
    return out, {"strength": strength, "occlusionP50": round(float(np.median(ot)), 3), "occlusionP95": round(float(np.percentile(ot, 95)), 3)}


def step_glb(work: Path, out_dir: Path, assets, tracks, mode: str, meta: dict, ao: float = 0.0) -> dict:
    """mode: "photofit" (WORK/photofit's textures; assets and tracks are its too), "texture" or "f1". ao: strength
    of the ambient-occlusion shading baked into the texture (0 = none)."""
    from pipeline.avatar import glb

    out_dir.mkdir(parents=True, exist_ok=True)
    people = []
    checks = []
    for k, a in enumerate(assets):
        pre = f"person-{k}/"
        tex_file = {"photofit": work / "photofit" / f"tex-{k}.jpg", "texture": work / f"tex-{k}.jpg"}.get(mode, work / f"tex-f1-{k}.jpg")
        jpeg = tex_file.read_bytes()
        ao_rep = None
        if ao > 0 and mode != "f1":
            jpeg, ao_rep = shade_ao(a, jpeg, ao)
            log("glb", f"person {k}: ambient occlusion {ao_rep}")
        times = tracks[pre + "times"]
        g = glb.build(a, times, tracks[pre + "delta_q"], tracks[pre + "root_q"], tracks[pre + "root_p"], jpeg,
                      name=f"person-{k}", extras={"texture": mode})
        path = out_dir / f"avatar-{k}.glb"
        nbytes = glb.write(g, path)
        js = glb.read_glb_json(path)
        ch = js["animations"][0]["channels"]
        people.append({
            "id": f"person-{k}", "file": path.name, "bytes": nbytes, "vertices": int(len(a.positions)),
            "triangles": int(len(a.tris)), "joints": int(len(a.bone_parents)),
            "animatedJoints": len({c["target"]["node"] for c in ch if c["target"]["path"] == "rotation"}),
            "tracks": len(ch), "keyframes": int(len(times)), "timeRange": [round(float(times[0]), 4), round(float(times[-1]), 4)],
            "texture": mode, "phenotype": [round(float(x), 4) for x in tracks[pre + "phenotype"]],
            "pelvisStart": [round(float(x), 3) for x in tracks[pre + "root_p"][0]],
        })
        if ao_rep:
            people[-1]["ambientOcclusion"] = ao_rep
        log("glb", f"{path.name}: {nbytes / 1e6:.2f} MB, {people[-1]}")
        keys = (0, len(times) // 3, (2 * len(times)) // 3, len(times) - 1)
        checks.append({"file": path.name, "checks": glb.check_points(a, times, tracks[pre + "delta_q"], tracks[pre + "root_q"],
                                                                   tracks[pre + "root_p"], keys)})
    doc = dict(meta)
    doc["people"] = [dict(p, **meta.get("perPerson", [{}] * len(people))[k]) if k < len(meta.get("perPerson", [])) else p
                     for k, p in enumerate(people)]
    doc.pop("perPerson", None)
    doc["sceneAddition"] = {"video.avatars": [{"file": p["file"], "id": p["id"]} for p in people]}
    write_json(work / "avatar-check.json", {"people": checks}, indent=None)
    write_json(out_dir / "avatar.json", doc, indent=1)
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--poses", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--clip", default="play")
    ap.add_argument("--people", type=int, default=2)
    ap.add_argument("--backview", choices=["auto", "on", "off"], default="auto")
    ap.add_argument("--back-threshold", type=float, default=0.6)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--max-seconds", type=float, default=60.0)
    ap.add_argument("--texture-size", type=int, default=2048)
    ap.add_argument("--steps", default="all")
    ap.add_argument("--force", default="")
    ap.add_argument("--no-lama", action="store_true")
    ap.add_argument("--world", default=None, help="the scene's world.spz: furniture in front of the people")
    ap.add_argument("--fallback", choices=["auto", "f1"], default="auto", help="f1: ship flat region colours")
    ap.add_argument("--refine", choices=["full", "legs", "off"], default="full",
                    help="align detections to the masks (full), only borrow hidden legs and trust cut-off fits (legs), or not")
    ap.add_argument("--refine-smooth", type=float, default=1.5, help="refine: Gaussian smoothing of the nudges (frames)")
    ap.add_argument("--offsets-min-gain", type=float, default=0.05, help="IoU gain for the bake to keep the silhouette offsets")
    ap.add_argument("--fill", choices=["garment", "lama"], default="garment", help="unseen texels: garment colours or mirror + LaMa")
    ap.add_argument("--photofit", choices=["on", "off"], default="on")
    ap.add_argument("--photofit-passes", type=int, default=2)
    ap.add_argument("--photofit-steps", type=int, default=None, help="last pass's steps (default: about 72 visits per frame)")
    ap.add_argument("--backpack", choices=["auto", "on", "off"], default="auto", help="photofit: the upper back's backpack allowance")
    ap.add_argument("--holdout", default=None, help="heldout.json: frames photofit never fits (for the yardstick)")
    ap.add_argument("--workers", type=int, default=8, help="processes for the photofit masks")
    ap.add_argument("--ao", type=float, default=0.0, help="glb: ambient-occlusion shading baked into the texture (0..1)")
    a = ap.parse_args(argv)
    work, out_dir = Path(a.work), Path(a.out_dir)
    work.mkdir(parents=True, exist_ok=True)
    steps = STEPS if a.steps == "all" else [s for s in a.steps.split(",") if s]
    force = set(s for s in a.force.split(",") if s)
    t0 = time.time()
    status: dict = {"steps": {}}
    write_json(work / "inputs.json", {"video": str(Path(a.video).resolve()), "poses": str(Path(a.poses).resolve()),
                                      "start": a.start, "fps": a.fps, "people": a.people})

    ran: list[str] = []  # steps that ran in this call: every later step's cache is stale

    def due(name: str, output: Path) -> bool:
        return name in steps and (name in force or not output.exists() or bool(ran))

    if due("hmr", work / "hmr.npz"):
        from pipeline.avatar import hmr

        status["steps"]["hmr"] = {k: v for k, v in hmr.run(Path(a.video), Path(a.poses), work, a.fps, a.max_seconds, a.start).items()
                                  if k != "perFrame"}
        ran.append("hmr")
    m = static = None
    world = Path(a.world) if a.world and Path(a.world).exists() else None

    def solve_ground() -> dict:
        from pipeline.avatar import ground

        hf = hmr_file(work, a.refine)
        trusted = np.load(work / "refine.npz")["trusted"] if hf != "hmr.npz" and (work / "refine.npz").exists() else None
        return ground.solve(work, Path(a.poses), a.people, a.start, a.max_seconds, anny_model=m, hmr_file=hf, trusted=trusted)

    if due("ground", work / "tracks.npz"):
        m, static = _anny()
        status["steps"]["ground"] = solve_ground()
        ran.append("ground")
    if a.refine != "off" and due("refine", work / "refine.json"):
        from pipeline.avatar import refine

        if m is None:
            m, static = _anny()
        (work / "hmr-refined.npz").unlink(missing_ok=True)
        rr = refine.refine(work, Path(a.poses), world, a.refine, smooth=a.refine_smooth)
        status["steps"]["refine"] = {k: v for k, v in rr.items() if k != "perDetection"}
        status["steps"]["ground"] = solve_ground()
        ran.append("refine")
    hf = hmr_file(work, a.refine)
    if not (work / "tracks.npz").exists() and not set(steps) - {"hmr"}:
        # a GPU job for the pose step alone (hpg/avatar.sbatch STEPS=hmr): the CPU steps run next, in their own job
        log("run", f"hmr done in {time.time() - t0:.1f} s; tracks come from the ground step")
        return 0
    tracks = dict(np.load(work / "tracks.npz"))
    n_people = sum(1 for k in tracks if k.endswith("/rest_vertices"))
    from pipeline.avatar.body import Asset

    if any(due("body", work / f"asset-{k}.npz") for k in range(n_people)):
        if static is None:
            m, static = _anny()
        assets = step_body(work, tracks, static)
    else:
        assets = [Asset.load(work / f"asset-{k}.npz") for k in range(n_people)]
    if any(due("offsets", work / f"offsets-{k}.json") for k in range(n_people)):
        from pipeline.avatar import offsets

        hmr_np = np.load(work / hf)
        for k in range(n_people):
            try:
                others = [x if j != k else None for j, x in enumerate(assets)]
                off, rep = offsets.estimate(work, assets[k], k, tracks, hmr_np, others)
                rep["accepted"] = bool(rep.get("iouGain") is not None and rep["iouGain"] >= a.offsets_min_gain
                                       and rep["spikeCm"] < 1.0)
                np.savez_compressed(work / f"offsets-{k}.npz", offset=off)
                write_json(work / f"offsets-{k}.json", rep)
            except Exception as e:
                log("run", f"offsets for person {k} failed ({e}); skipped")
                write_json(work / f"offsets-{k}.json", {"accepted": False, "error": str(e)})
    for k in range(n_people):
        orep = read_json(work / f"offsets-{k}.json", {})
        if orep.get("accepted") and (work / f"offsets-{k}.npz").exists():
            from pipeline.avatar import offsets

            offsets.apply(assets[k], tracks[f"person-{k}/rest_vertices"], np.load(work / f"offsets-{k}.npz")["offset"])
            log("run", f"person {k}: silhouette offsets applied ({orep.get('offsetCm')})")
    mode = "texture" if a.fallback == "auto" else "f1"
    try:
        if any(due("texture", work / f"texture-{k}.json") for k in range(n_people)):
            status["steps"]["texture"] = step_texture(work, assets, tracks, a.texture_size, a.world, a.poses, hf)
            ran.append("texture")
        tex_info = [read_json(work / f"texture-{k}.json") for k in range(n_people)]
        backs = {}
        if "backview" in steps and a.backview != "off":
            for k in range(n_people):
                cov = tex_info[k]["coverage"]["back"]
                if a.backview == "on" or cov < a.back_threshold:
                    try:
                        from pipeline.avatar import backview

                        backs[k] = backview.back_for_person(work, assets, tracks, k, a.texture_size,
                                                            force="backview" in force, poses=Path(a.poses))
                    except Exception as e:
                        log("run", f"generated back for person {k} failed: {e}")
                        traceback.print_exc()
        if any(due("fill", work / f"tex-{k}.jpg") for k in range(n_people)) or backs:
            status["steps"]["fill"] = step_fill(work, assets, a.texture_size, not a.no_lama, backs, a.fill)
            ran.append("fill")
    except Exception as e:
        log("run", f"texturing failed ({e}); shipping flat region colours (F1)")
        traceback.print_exc()
        mode = "f1"
        if not all((work / f"tex-f1-{k}.jpg").exists() for k in range(n_people)):
            from pipeline.avatar import fill, texture

            for k, asset in enumerate(assets):
                tm = texture.texel_map(asset, a.texture_size)
                reg, _ = texture.texel_regions(asset, tm)
                img = texture.region_texture(tm, reg, texture.DEFAULT_REGION_COLOURS)
                (work / f"tex-f1-{k}.jpg").write_bytes(fill.finish(img.astype(np.float32), tm.tri >= 0)[1])
    fit_dir = work / "photofit"
    if mode == "texture" and a.photofit == "on":
        try:
            if due("photofit", fit_dir / "photofit.json"):
                from pipeline.avatar import photofit

                pf = photofit.run(work, Path(a.poses), world, Path(a.holdout) if a.holdout else None, passes=a.photofit_passes,
                                  steps=a.photofit_steps, backpack=a.backpack, workers=a.workers, hmr_file=hf)
                status["steps"]["photofit"] = {"seconds": pf["seconds"], "passes": [
                    {kk: v for kk, v in p.items() if kk != "people"} for p in pf["passes"]]}
                ran.append("photofit")
            if all((fit_dir / f"asset-{k}.npz").exists() and (fit_dir / f"tex-{k}.jpg").exists() for k in range(n_people)):
                mode = "photofit"
                assets = [Asset.load(fit_dir / f"asset-{k}.npz") for k in range(n_people)]
                tracks = dict(np.load(fit_dir / "tracks.npz"))
        except Exception as e:
            log("run", f"photofit failed ({e}); shipping the baked texture")
            traceback.print_exc()
    if "glb" in steps:
        g = read_json(work / "ground.json", {})
        per = []
        for k in range(n_people):
            p = {"ground": (g.get("people") or [{}] * n_people)[k] if k < len(g.get("people", [])) else {}}
            ti = read_json(work / f"texture-{k}.json")
            if ti:
                p["textureCoverage"] = ti["coverage"]
                p["regionColours"] = ti["regions"]
            fr = read_json(work / f"fill-{k}.json")
            if fr:
                p["fill"] = fr
            orep = read_json(work / f"offsets-{k}.json")
            if orep:
                p["offsets"] = orep
            if mode == "photofit":
                fr = read_json(fit_dir / f"photofit-{k}.json", {})
                p["photofit"] = {kk: fr.get(kk) for kk in ("fittedFrames", "downWeightedFrames", "steps", "offsetCm", "poseCorrection",
                                                           "gains", "seenTexels", "hands", "before", "after")}
            rf = read_json(work / "refine.json")
            if rf and a.refine != "off":
                p["refine"] = rf.get("people", {}).get(f"person-{k}")
            per.append(p)
        hj = read_json(work / "hmr.json", {})
        meta = {
            "version": 1, "clip": a.clip, "source": Path(a.video).name, "start": a.start,
            "mediaDuration": g.get("mediaDuration"), "fps": g.get("fps"),
            "frame": "viewer (y up, metres, floor y = 0); GLB at identity under the video layer's parent",
            "clock": "animation 'video' keyed in seconds of the played media element (presentation time - start)",
            "texture": mode, "hmr": {k: hj.get(k) for k in ("frames", "detections", "peoplePerFrame", "hfovOursDeg", "hfovPredictedDeg")},
            "checks": {k: g.get(k) for k in ("bothFoundFraction", "pelvisDistanceM", "tracksFound")},
            "credits": CREDITS, "perPerson": per,
        }
        status["glb"] = step_glb(work, out_dir, assets, tracks, mode, meta, a.ao)
    status["seconds"] = round(time.time() - t0, 1)
    write_json(work / "run.json", status)
    log("run", f"done in {status['seconds']} s; texture mode {mode}; outputs in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
