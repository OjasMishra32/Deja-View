#!/usr/bin/env python3
"""COLMAP poses for the kitchen capture on CPU nodes (no GPU free): features, a chosen pair list, mapper, export.

  python pipeline/recon_inputs/kitchen_colmap.py all --work WORK --db $TMPDIR/database.db [--window 10]
  python pipeline/recon_inputs/kitchen_colmap.py map --work WORK --db $TMPDIR/database.db --tag b \
      --mapper-extra "--Mapper.init_min_num_inliers 50"

Same inputs and outputs as pipeline/recon/poses.py solve (WORK/frames.json in, WORK/colmap/, WORK/poses.json and
WORK/points.npz out, via poses.export), but matching is not exhaustive: CPU matching costs ~features^2 per pair,
and a kitchen has repeated things (two identical ranges, six identical bar tables and stools) that make far-apart
video frames match the wrong copy. Pairs:
  photo x photo   every pair (the photos see the whole room, wide baselines)
  photo x video   every pair (each video frame is anchored to the photos directly)
  video x video   only frames at most --window samples apart (the camera path stays continuous)
Features: one camera per group (photo groups get the EXIF focal prior that prep.py wrote), no features where the
person mask is 0. The mapper keeps the model with the most images; other models are merged into it when they
share images, then one global bundle adjustment.
"""
from __future__ import annotations

import argparse
import itertools
import os
import re
import shlex
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "recon"))

from poses import PAIR_ID_BASE, export, run  # noqa: E402
from util import Work, log, read_json, write_json  # noqa: E402


def say(msg: str) -> None:
    log("kitchen-colmap", msg)


def extract(work: Work, colmap: list[str], db: Path, threads: int, camera_model: str, feats: dict[str, int]) -> None:
    frames = read_json(work.frames)
    cdir = work.colmap
    logf = cdir / "colmap.log"
    if db.exists():
        db.unlink()
    by_group: dict[str, list[str]] = {}
    for im in frames["images"]:
        by_group.setdefault(im["group"], []).append(im["name"])
    for gname, names in by_group.items():
        info = frames["groups"][gname]
        lst = cdir / f"list-{gname}.txt"
        lst.write_text("\n".join(sorted(names)) + "\n")
        n_feat = feats["photo"] if info["kind"] == "photo" else feats["video"]
        cmd = colmap + [
            "feature_extractor",
            "--database_path", str(db),
            "--image_path", str(work.images),
            "--image_list_path", str(lst),
            "--ImageReader.single_camera", "1",
            "--ImageReader.camera_model", camera_model,
            "--ImageReader.mask_path", str(work.masks),
            "--SiftExtraction.use_gpu", "0",
            "--SiftExtraction.max_num_features", str(n_feat),
            "--SiftExtraction.max_image_size", str(max(info["width"], info["height"])),
            "--SiftExtraction.num_threads", str(threads),
        ]
        prior = info.get("prior")
        if prior:
            f = 0.5 * (prior["fx"] + prior["fy"])
            params = {"SIMPLE_RADIAL": [f, prior["cx"], prior["cy"], 0.0], "RADIAL": [f, prior["cx"], prior["cy"], 0.0, 0.0],
                      "OPENCV": [prior["fx"], prior["fy"], prior["cx"], prior["cy"], 0, 0, 0, 0]}[camera_model]
            cmd += ["--ImageReader.camera_params", ",".join(f"{v:.4f}" for v in params)]
        say(f"features: {gname} ({len(names)} images, {n_feat} max, prior focal {'yes' if prior else 'no'})")
        run(cmd, logf)


def pair_list(work: Work, window: int) -> list[tuple[str, str]]:
    frames = read_json(work.frames)
    photos = sorted(im["name"] for im in frames["images"] if frames["groups"][im["group"]]["kind"] == "photo")
    clips: dict[str, list[str]] = {}
    for im in sorted(frames["images"], key=lambda r: (r["group"], r.get("frameIndex", 0))):
        if frames["groups"][im["group"]]["kind"] == "video":
            clips.setdefault(im["group"], []).append(im["name"])
    pairs = list(itertools.combinations(photos, 2))
    for seq in clips.values():
        pairs += [(p, v) for p in photos for v in seq]
        for i, a in enumerate(seq):
            pairs += [(a, b) for b in seq[i + 1 : i + 1 + window]]
    return pairs  # several clips would be linked through the photos only


def match(work: Work, colmap: list[str], db: Path, threads: int, window: int) -> dict:
    pairs = pair_list(work, window)
    pf = work.colmap / "pairs.txt"
    pf.write_text("".join(f"{a} {b}\n" for a, b in pairs))
    say(f"matching {len(pairs)} pairs (photo x all, video window {window})")
    run(colmap + [
        "matches_importer",
        "--database_path", str(db),
        "--match_list_path", str(pf),
        "--match_type", "pairs",
        "--SiftMatching.use_gpu", "0",
        "--SiftMatching.guided_matching", "1",
        "--SiftMatching.num_threads", str(threads),
    ], work.colmap / "colmap.log")
    return {"pairs": len(pairs), "window": window}


MODEL_IDS = {"SIMPLE_RADIAL": 2, "RADIAL": 3, "OPENCV": 4}


def set_cameras(work: Work, db: Path, model: str, video_focal: float | None) -> dict:
    """Rewrites the camera rows of the database before mapping: one model for every group, photo groups at their
    EXIF focal prior, video groups at --video-focal (a prior, refined by bundle adjustment), no distortion.

    The first solve let the video camera start at COLMAP's default focal (1.2 x width = 2304 px) while the clip is
    the ultra-wide lens (metadata: 2.22 mm, 14 mm equivalent); the map grew on the video and the photo focal was
    dragged from 1331 to 828 px. The same phone's ultra-wide clips at the courts solved to ~877 px."""
    import sqlite3

    import numpy as np

    frames = read_json(work.frames)
    group_of = {im["name"]: im["group"] for im in frames["images"]}
    con = sqlite3.connect(str(db))
    cam_group: dict[int, str] = {}
    for name, cid in con.execute("SELECT name, camera_id FROM images"):
        cam_group.setdefault(cid, group_of.get(name, "?"))
    out = {}
    for cid, g in cam_group.items():
        info = frames["groups"][g]
        w, h = info["width"], info["height"]
        prior = info.get("prior")
        if prior:
            f, cx, cy = 0.5 * (prior["fx"] + prior["fy"]), prior["cx"], prior["cy"]
        elif video_focal:
            f, cx, cy = video_focal, w / 2.0, h / 2.0
        else:
            continue
        params = {"SIMPLE_RADIAL": [f, cx, cy, 0.0], "RADIAL": [f, cx, cy, 0.0, 0.0],
                  "OPENCV": [f, f, cx, cy, 0.0, 0.0, 0.0, 0.0]}[model]
        con.execute("UPDATE cameras SET model = ?, width = ?, height = ?, params = ?, prior_focal_length = 1 WHERE camera_id = ?",
                    (MODEL_IDS[model], w, h, np.asarray(params, np.float64).tobytes(), cid))
        out[g] = {"camera": cid, "model": model, "focal": round(f, 2)}
        say(f"camera {cid} ({g}): {model}, focal {f:.1f} px (prior)")
    con.commit()
    con.close()
    return out


def image_ids(db: Path, names: list[str]) -> list[int]:
    import sqlite3

    con = sqlite3.connect(str(db))
    ids = dict(con.execute("SELECT name, image_id FROM images"))
    con.close()
    return [ids[n] for n in names]


def analyze(colmap: list[str], model: Path, logf: Path) -> dict:
    txt = run(colmap + ["model_analyzer", "--path", str(model)], logf)
    out = {}
    for key, pat in (("images", r"Registered images:\s*(\d+)"), ("points", r"Points:\s*(\d+)"),
                     ("reproj", r"Mean reprojection error:\s*([\d.]+)")):
        m = re.search(pat, txt)
        if m:
            out[key] = float(m.group(1))
    return out


def map_models(work: Work, colmap: list[str], db: Path, threads: int, tag: str, extra: list[str]) -> Path:
    cdir = work.colmap
    logf = cdir / "colmap.log"
    sfx = f"-{tag}" if tag else ""
    out = cdir / f"sparse{sfx}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    run(colmap + [
        "mapper",
        "--database_path", str(db),
        "--image_path", str(work.images),
        "--output_path", str(out),
        "--Mapper.num_threads", str(threads),
        "--Mapper.ba_refine_focal_length", "1",
        "--Mapper.ba_refine_extra_params", "1",
        "--Mapper.ba_refine_principal_point", "0",
    ] + extra, logf)
    models = sorted(p for p in out.iterdir() if p.is_dir())
    if not models:
        raise RuntimeError("the mapper produced no model")
    stats = {m.name: analyze(colmap, m, logf) for m in models}
    for k, v in stats.items():
        say(f"model {k}: {v}")
    best = max(models, key=lambda m: stats[m.name].get("images", 0))
    final_in = best
    if len(models) > 1:
        merged = cdir / f"merged{sfx}"
        if merged.exists():
            shutil.rmtree(merged)
        shutil.copytree(best, merged)
        n_best = stats[best.name].get("images", 0)
        for m in models:
            if m == best or stats[m.name].get("images", 0) < 3:
                continue  # a two-image fragment shares nothing with the main model
            trial = cdir / f"merge-trial{sfx}"
            if trial.exists():
                shutil.rmtree(trial)
            shutil.copytree(merged, trial)
            try:
                run(colmap + ["model_merger", "--input_path1", str(trial), "--input_path2", str(m), "--output_path", str(trial)], logf)
                n = analyze(colmap, trial, logf).get("images", 0)
            except RuntimeError as e:
                say(f"could not merge model {m.name}: {str(e).splitlines()[0]}")
                continue
            if n > n_best:
                shutil.rmtree(merged)
                trial.rename(merged)
                n_best = n
                say(f"merged model {m.name} into the largest: {n} images")
            else:
                say(f"merging model {m.name} did not add images ({n}); kept the largest")
        final_in = merged
    final = cdir / f"final{sfx}"
    if final.exists():
        shutil.rmtree(final)
    final.mkdir(parents=True)
    run(colmap + ["bundle_adjuster", "--input_path", str(final_in), "--output_path", str(final),
                  "--BundleAdjustment.refine_focal_length", "1", "--BundleAdjustment.refine_extra_params", "1",
                  "--BundleAdjustment.refine_principal_point", "0"], logf)
    st = analyze(colmap, final, logf)
    write_json(cdir / f"models{sfx}.json", {"models": stats, "final": st, "best": best.name, "merged": len(models) > 1})
    say(f"final{sfx}: {st}")
    return final


def drop_images(work: Work, colmap: list[str], model: Path, names: list[str], tag: str) -> Path:
    """A copy of `model` without `names` (cameras the mapper put on the wrong copy of a repeated object)."""
    out = work.colmap / f"dropped-{tag}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    lst = work.colmap / f"drop-{tag}.txt"
    lst.write_text("\n".join(names) + "\n")
    run(colmap + ["image_deleter", "--input_path", str(model), "--output_path", str(out), "--image_names_path", str(lst)],
        work.colmap / "colmap.log")
    say(f"dropped {names}: {analyze(colmap, out, work.colmap / 'colmap.log')}")
    return out


def restrict_partners(db: Path, rules: list[str]) -> dict:
    """rules 'photo/IMG_7403.jpg=photo/IMG_7400.jpg,photo/IMG_7401.jpg': that image keeps its verified matches with
    the listed images only (a close-up of one of six identical tables also matches the other five)."""
    import sqlite3

    con = sqlite3.connect(str(db))
    ids = dict(con.execute("SELECT name, image_id FROM images"))
    out = {}
    for rule in rules:
        name, partners = rule.split("=", 1)
        keep = {ids[p] for p in partners.split(",") if p}
        a = ids[name]
        rows = con.execute("SELECT pair_id FROM two_view_geometries WHERE rows > 0").fetchall()
        drop = []
        for (pid,) in rows:
            i, j = pid // PAIR_ID_BASE, pid % PAIR_ID_BASE
            if a in (i, j) and (j if i == a else i) not in keep:
                drop.append(pid)
        con.executemany("DELETE FROM two_view_geometries WHERE pair_id = ?", [(d,) for d in drop])
        out[name] = {"kept": sorted(partners.split(",")), "droppedPairs": len(drop)}
        say(f"{name}: kept matches with {len(keep)} images, dropped {len(drop)} pairs")
    con.commit()
    con.close()
    return out


def register_more(work: Work, colmap: list[str], db: Path, model: Path, threads: int, tag: str, extra: list[str],
                  retriangulate: bool = False, passes: int = 1) -> Path:
    """Registers the images a finished model is missing (relaxed absolute-pose thresholds, given in `extra`),
    triangulates their points, then one global bundle adjustment."""
    cdir = work.colmap
    logf = cdir / "colmap.log"
    reg = cdir / f"registered-{tag}"
    if reg.exists():
        shutil.rmtree(reg)
    reg.mkdir(parents=True)
    before = analyze(colmap, model, logf)
    src = model

    def retri(inp: Path, k: int) -> Path:
        # the incremental mapper drops two-view tracks, and image_registrator does not triangulate for the images
        # it adds: a photo whose overlap with the model is seen by only one registered image (the ceiling shots)
        # then has no 2D-3D matches. Re-triangulate with two-view tracks kept before every registration pass.
        tri = cdir / f"retri-{tag}-{k}"
        if tri.exists():
            shutil.rmtree(tri)
        tri.mkdir(parents=True)
        run(colmap + ["point_triangulator", "--database_path", str(db), "--image_path", str(work.images),
                      "--input_path", str(inp), "--output_path", str(tri), "--Mapper.num_threads", str(threads),
                      "--Mapper.tri_ignore_two_view_tracks", "0", "--Mapper.ba_refine_focal_length", "0",
                      "--Mapper.ba_refine_extra_params", "0", "--Mapper.ba_refine_principal_point", "0"], logf)
        say(f"re-triangulated with two-view tracks (pass {k + 1}): {analyze(colmap, tri, logf)}")
        return tri

    for k in range(passes):
        if retriangulate:
            src = retri(src, k)
        out = reg if k == passes - 1 else cdir / f"registered-{tag}-pass{k}"
        if out.exists() and out != reg:
            shutil.rmtree(out)
        out.mkdir(parents=True, exist_ok=True)
        run(colmap + ["image_registrator", "--database_path", str(db), "--input_path", str(src), "--output_path", str(out),
                      "--Mapper.num_threads", str(threads), "--Mapper.ba_refine_focal_length", "1",
                      "--Mapper.ba_refine_extra_params", "1", "--Mapper.ba_refine_principal_point", "0",
                      "--Mapper.tri_ignore_two_view_tracks", "0" if retriangulate else "1"] + extra, logf)
        say(f"image_registrator pass {k + 1}: {analyze(colmap, out, logf)}")
        src = out
    mid = analyze(colmap, reg, logf)
    final = cdir / f"final-{tag}"
    if final.exists():
        shutil.rmtree(final)
    final.mkdir(parents=True)
    run(colmap + ["bundle_adjuster", "--input_path", str(reg), "--output_path", str(final),
                  "--BundleAdjustment.refine_focal_length", "1", "--BundleAdjustment.refine_extra_params", "1",
                  "--BundleAdjustment.refine_principal_point", "0"], logf)
    st = analyze(colmap, final, logf)
    write_json(cdir / f"models-{tag}.json", {"input": str(model), "before": before, "registered": mid, "final": st, "extra": extra})
    say(f"register-more {tag}: {before.get('images')} -> {mid.get('images')} images; after BA {st}")
    return final


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["all", "match", "map", "register"])
    ap.add_argument("--model", type=Path, default=None, help="register: the model to add the missing images to")
    ap.add_argument("--retriangulate", action="store_true", help="register: keep two-view tracks (point_triangulator) first")
    ap.add_argument("--passes", type=int, default=1, help="register: image_registrator passes")
    ap.add_argument("--drop", nargs="*", default=[], help="register: remove these images from the model first")
    ap.add_argument("--only-pairs", nargs="*", default=[], help="register: NAME=A,B,... keep NAME's matches with A,B,... only")
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--db", required=True, type=Path, help="working database on node-local disk")
    ap.add_argument("--colmap", default=os.environ.get("COLMAP_CMD", "colmap"))
    ap.add_argument("--threads", type=int, default=int(os.environ.get("SLURM_CPUS_PER_TASK", "8")))
    ap.add_argument("--camera-model", default="RADIAL", choices=["SIMPLE_RADIAL", "RADIAL", "OPENCV"])
    ap.add_argument("--photo-features", type=int, default=8192)
    ap.add_argument("--video-features", type=int, default=6000)
    ap.add_argument("--window", type=int, default=10)
    ap.add_argument("--tag", default="")
    ap.add_argument("--mapper-extra", default="")
    ap.add_argument("--no-export", action="store_true")
    ap.add_argument("--map-camera-model", default=None, choices=["SIMPLE_RADIAL", "RADIAL", "OPENCV"],
                    help="map: rewrite every camera to this model at its focal prior before mapping")
    ap.add_argument("--video-focal", type=float, default=None, help="map: focal prior (px) for video groups")
    ap.add_argument("--init-pair", nargs=2, default=None, help="map: two image names to start the map from")
    a = ap.parse_args(argv)
    work = Work(a.work)
    colmap = shlex.split(a.colmap)
    keep_db = work.colmap / "database.db"
    if a.stage in ("all", "match"):
        if work.colmap.exists():
            shutil.rmtree(work.colmap)
        work.colmap.mkdir(parents=True)
        extract(work, colmap, a.db, a.threads, a.camera_model, {"photo": a.photo_features, "video": a.video_features})
        shutil.copy(a.db, keep_db)
        info = match(work, colmap, a.db, a.threads, a.window)
        shutil.copy(a.db, keep_db)
        write_json(work.colmap / "pairs.json", info)
    if a.stage == "register":
        if not a.db.exists():
            shutil.copy(keep_db, a.db)
        if a.map_camera_model:
            set_cameras(work, a.db, a.map_camera_model, a.video_focal)
        model = a.model
        if a.drop:
            model = drop_images(work, colmap, model, a.drop, a.tag or "reg")
        if a.only_pairs:
            write_json(work.colmap / f"partners-{a.tag or 'reg'}.json", restrict_partners(a.db, a.only_pairs))
        final = register_more(work, colmap, a.db, model, a.threads, a.tag or "reg", shlex.split(a.mapper_extra),
                              a.retriangulate, a.passes)
        if not a.no_export:
            export(work, final, colmap)
        return 0
    if a.stage in ("all", "map"):
        if not a.db.exists():
            shutil.copy(keep_db, a.db)
        extra = shlex.split(a.mapper_extra)
        if a.map_camera_model:
            cams = set_cameras(work, a.db, a.map_camera_model, a.video_focal)
            write_json(work.colmap / f"cameras-set{'-' + a.tag if a.tag else ''}.json", cams)
        if a.init_pair:
            i1, i2 = image_ids(a.db, a.init_pair)
            extra += ["--Mapper.init_image_id1", str(i1), "--Mapper.init_image_id2", str(i2)]
            say(f"init pair {a.init_pair} = ids {i1}, {i2}")
        final = map_models(work, colmap, a.db, a.threads, a.tag, extra)
        if not a.no_export:
            export(work, final, colmap)
    return 0


if __name__ == "__main__":
    sys.exit(main())
