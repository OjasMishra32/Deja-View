#!/usr/bin/env python3
"""Step 2: camera poses and sparse points with COLMAP (SIFT, exhaustive matching, incremental mapper).

  python pipeline/recon/poses.py solve  --work WORK [--colmap "colmap"] [--no-gpu] [--threads 16] [--seq-window 8]
  python pipeline/recon/poses.py export --work WORK [--model colmap/sparse/0]

`solve` reads WORK/frames.json (prep.py): one camera per group (all photos of one lens share a camera, each video
is a camera), features only where masks/<image>.png is white (people never vote for a pose), every pair matched
(guided matching), then far-apart frames of one clip are unlinked (--seq-window, see restrict_pairs) and the mapper
runs. The model with the most registered images is exported; stats.continuity flags any jump left in a clip's path.

`export` turns a COLMAP model into WORK/poses.json (cameras, every image with its pose or `registered: false`,
per-image reprojection error, the group and source frame of every image) and WORK/points.npz (xyz, rgb, error,
track length). Poses stay in COLMAP's frame: world-to-camera, OpenCV axes, quaternions wxyz.

On HiPerGator COLMAP 3.11 is a container: --colmap "apptainer exec --nv --bind /blue /apps/colmap/3.11/container.sif colmap"
(`--nv` lets SIFT and matching use the GPU).
"""
from __future__ import annotations

import argparse
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from cams import Camera, qvec_to_rotmat
from util import Work, log, read_json, write_json


def say(msg: str) -> None:
    log("poses", msg)


def run(cmd: list[str], logf: Path, cwd: Path | None = None) -> str:
    say("$ " + " ".join(shlex.quote(c) for c in cmd[-12:]))
    t0 = time.time()
    with open(logf, "a", encoding="utf-8") as f:
        f.write(f"\n$ {' '.join(cmd)}\n")
        f.flush()
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=cwd)
        f.write(p.stdout)
    if p.returncode != 0:
        tail = "\n".join(p.stdout.splitlines()[-25:])
        raise RuntimeError(f"command failed ({p.returncode}) after {time.time() - t0:.0f}s:\n{tail}")
    say(f"  done in {time.time() - t0:.1f}s")
    return p.stdout


# --------------------------------------------------------------------------------------------------------------
# Solve
# --------------------------------------------------------------------------------------------------------------


def features(work: Work, colmap: list[str], db: Path, gpu: bool, threads: int, max_features: int, camera_model: str) -> None:
    """SIFT on every image (one camera per group, masks honoured) and matching of every pair."""
    frames = read_json(work.frames)
    if not frames:
        raise SystemExit(f"{work.frames} missing: run prep.py first")
    cdir = work.colmap
    logf = cdir / "colmap.log"
    if db.exists():
        db.unlink()
    g = "1" if gpu else "0"
    by_group: dict[str, list[str]] = {}
    for im in frames["images"]:
        by_group.setdefault(im["group"], []).append(im["name"])
    for gname, names in by_group.items():
        info = frames["groups"][gname]
        lst = cdir / f"list-{gname}.txt"
        lst.write_text("\n".join(names) + "\n")
        cmd = colmap + [
            "feature_extractor",
            "--database_path", str(db),
            "--image_path", str(work.images),
            "--image_list_path", str(lst),
            "--ImageReader.single_camera", "1",
            "--ImageReader.camera_model", camera_model,
            "--ImageReader.mask_path", str(work.masks),
            "--SiftExtraction.use_gpu", g,
            "--SiftExtraction.max_num_features", str(max_features),
            "--SiftExtraction.max_image_size", str(max(info["width"], info["height"])),
            "--SiftExtraction.num_threads", str(threads),
        ]
        prior = info.get("prior")
        if prior:
            f = 0.5 * (prior["fx"] + prior["fy"])
            params = {"SIMPLE_RADIAL": [f, prior["cx"], prior["cy"], 0.0], "RADIAL": [f, prior["cx"], prior["cy"], 0.0, 0.0],
                      "OPENCV": [prior["fx"], prior["fy"], prior["cx"], prior["cy"], 0, 0, 0, 0],
                      "PINHOLE": [prior["fx"], prior["fy"], prior["cx"], prior["cy"]]}[camera_model]
            cmd += ["--ImageReader.camera_params", ",".join(f"{v:.4f}" for v in params)]
        say(f"features: {gname} ({len(names)} images, prior focal {'yes' if prior else 'no'})")
        run(cmd, logf)
    say("matching every pair")
    run(colmap + [
        "exhaustive_matcher",
        "--database_path", str(db),
        "--SiftMatching.use_gpu", g,
        "--SiftMatching.guided_matching", "1",
        "--SiftMatching.num_threads", str(threads),
    ], logf)


PAIR_ID_BASE = 2147483647


def restrict_pairs(work: Work, db: Path, window: int) -> dict:
    """Forgets the verified matches between frames of one video that are more than `window` samples apart.

    Two far-apart frames of one walk-around often see a symmetric object (a table-tennis table, a foosball table)
    from opposite ends; their matches are geometrically valid for the wrong pose and pull whole stretches of the
    clip onto a mirrored copy of the room. Neighbouring frames cannot be confused that way, and photos and other
    clips still connect everything."""
    import sqlite3

    frames = read_json(work.frames)
    meta = {im["name"]: im for im in frames["images"]}
    order: dict[str, int] = {}
    for gname, g in frames["groups"].items():
        if g.get("kind") != "video":
            continue
        names = sorted((im for im in frames["images"] if im["group"] == gname), key=lambda im: im["frameIndex"])
        for k, im in enumerate(names):
            order[im["name"]] = k
    con = sqlite3.connect(str(db))
    ids = {iid: name for iid, name in con.execute("SELECT image_id, name FROM images")}
    drop, kept = [], 0
    for (pid,) in con.execute("SELECT pair_id FROM two_view_geometries WHERE rows > 0").fetchall():
        a, b = pid // PAIR_ID_BASE, pid % PAIR_ID_BASE
        na, nb = ids.get(a), ids.get(b)
        ga, gb = meta.get(na, {}).get("group"), meta.get(nb, {}).get("group")
        if ga == gb and na in order and nb in order and abs(order[na] - order[nb]) > window:
            drop.append(pid)
        else:
            kept += 1
    con.executemany("DELETE FROM two_view_geometries WHERE pair_id = ?", [(p,) for p in drop])
    con.commit()
    con.close()
    say(f"pairs: dropped {len(drop)} far-apart pairs within a clip (window {window}), kept {kept}")
    return {"dropped": len(drop), "kept": kept, "window": window}


def map_model(work: Work, colmap: list[str], db: Path, out: Path, threads: int) -> Path:
    """Incremental mapper; returns the model with the most registered images."""
    logf = work.colmap / "colmap.log"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    say("mapping")
    run(colmap + [
        "mapper",
        "--database_path", str(db),
        "--image_path", str(work.images),
        "--output_path", str(out),
        "--Mapper.num_threads", str(threads),
        "--Mapper.ba_refine_focal_length", "1",
        "--Mapper.ba_refine_extra_params", "1",
    ], logf)
    models = sorted(p for p in out.iterdir() if p.is_dir())
    if not models:
        raise RuntimeError("the mapper produced no model")
    best, best_n = None, -1
    for m in models:
        txt = run(colmap + ["model_analyzer", "--path", str(m)], logf)
        hit = re.search(r"Registered images:\s*(\d+)", txt)
        n = int(hit.group(1)) if hit else 0
        say(f"model {m.name}: {n} registered images")
        if n > best_n:
            best, best_n = m, n
    return best


def solve(work: Work, colmap: list[str], gpu: bool, threads: int, max_features: int, camera_model: str,
          db: Path | None = None, reuse: bool = False, window: int = 0, tag: str = "") -> Path:
    cdir = work.colmap
    keep_db = cdir / "database.db"
    # SQLite's write-ahead log needs shared memory that network file systems (HiPerGator's /blue) do not give:
    # keep the working database on node-local disk there (--db $TMPDIR/database.db)
    db = db or keep_db
    if reuse:
        if not keep_db.exists():
            raise SystemExit(f"--reuse needs {keep_db}")
        if db != keep_db:
            shutil.copy(keep_db, db)
    else:
        if cdir.exists():
            shutil.rmtree(cdir)
        cdir.mkdir(parents=True)
        features(work, colmap, db, gpu, threads, max_features, camera_model)
        if db != keep_db:
            shutil.copy(db, keep_db)
    info = restrict_pairs(work, db, window) if window > 0 else None
    model = map_model(work, colmap, db, cdir / (f"sparse-{tag}" if tag else "sparse"), threads)
    if info:
        write_json(cdir / f"pairs{'-' + tag if tag else ''}.json", info)
    return model


# --------------------------------------------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------------------------------------------


def read_text_model(path: Path) -> tuple[dict, dict, dict]:
    cams: dict[int, Camera] = {}
    for line in (path / "cameras.txt").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        t = line.split()
        cams[int(t[0])] = Camera(t[1], int(t[2]), int(t[3]), np.array([float(v) for v in t[4:]]))
    images: dict[int, dict] = {}
    lines = [ln for ln in (path / "images.txt").read_text().splitlines() if not ln.startswith("#")]
    for k in range(0, len(lines) - 1, 2):
        t = lines[k].split()
        if not t:
            continue
        obs = lines[k + 1].split()
        xy = np.array([float(v) for v in obs[0::3]] if obs else [], np.float64)
        xy = np.stack([xy, np.array([float(v) for v in obs[1::3]])], axis=1) if obs else np.zeros((0, 2))
        pid = np.array([int(v) for v in obs[2::3]], np.int64) if obs else np.zeros(0, np.int64)
        images[int(t[0])] = {
            "qvec": np.array([float(v) for v in t[1:5]]),
            "tvec": np.array([float(v) for v in t[5:8]]),
            "camera": int(t[8]),
            "name": t[9],
            "xy": xy,
            "pid": pid,
        }
    pts: dict[int, tuple] = {}
    for line in (path / "points3D.txt").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        t = line.split()
        pts[int(t[0])] = (float(t[1]), float(t[2]), float(t[3]), int(t[4]), int(t[5]), int(t[6]), float(t[7]), (len(t) - 8) // 2)
    return cams, images, pts


def continuity(images: list[dict], factor: float = 6.0) -> dict:
    """Jumps in each video's camera path: steps between neighbouring samples much longer than the clip's usual
    step (a handheld camera moves smoothly, so a jump is a wrongly placed stretch of frames)."""
    out = {}
    groups = sorted({im.get("group") for im in images if "frameIndex" in im and im.get("registered")})
    for g in groups:
        seq = sorted((im for im in images if im.get("group") == g and im.get("registered")), key=lambda im: im["frameIndex"])
        if len(seq) < 3:
            continue
        C = np.array([im["center"] for im in seq])
        t = np.array([im["time"] for im in seq])
        step = np.linalg.norm(np.diff(C, axis=0), axis=1)
        speed = step / np.maximum(np.diff(t), 1e-3)
        med = float(np.median(speed))
        jumps = [{"from": seq[k]["name"], "to": seq[k + 1]["name"], "step": round(float(step[k]), 4),
                  "speedRatio": round(float(speed[k] / max(med, 1e-9)), 1)}
                 for k in np.nonzero(speed > factor * med)[0]]
        out[g] = {"medianSpeed": round(med, 4), "maxSpeedRatio": round(float(speed.max() / max(med, 1e-9)), 1), "jumps": jumps}
    return out


def export(work: Work, model: Path, colmap: list[str] | None) -> dict:
    txt = work.colmap / "model_txt"
    if (model / "cameras.txt").exists() and model.resolve() == txt.resolve():
        pass
    elif (model / "cameras.txt").exists():
        if txt.exists():
            shutil.rmtree(txt)
        txt.mkdir(parents=True)
        for f in ("cameras.txt", "images.txt", "points3D.txt"):
            shutil.copy(model / f, txt / f)
    else:
        if txt.exists():
            shutil.rmtree(txt)
        txt.mkdir(parents=True)
        run((colmap or ["colmap"]) + ["model_converter", "--input_path", str(model), "--output_path", str(txt), "--output_type", "TXT"],
            work.colmap / "colmap.log")
    cams, images, pts = read_text_model(txt)
    frames = read_json(work.frames, {"images": [], "groups": {}})
    meta = {im["name"]: im for im in frames["images"]}
    pid_index = {pid: i for i, pid in enumerate(sorted(pts))}
    P = np.array([pts[p][:3] for p in sorted(pts)], np.float64).reshape(-1, 3)
    out_images, by_name = [], {}
    cam_groups: dict[int, str] = {}
    for iid, im in sorted(images.items(), key=lambda kv: kv[1]["name"]):
        cam = cams[im["camera"]]
        R = qvec_to_rotmat(im["qvec"])
        ok = im["pid"] >= 0
        err = None
        if ok.any():
            X = P[[pid_index[p] for p in im["pid"][ok]]]
            Xc = X @ R.T + im["tvec"]
            uv = cam.project(Xc)
            e = np.linalg.norm(uv - (im["xy"][ok]), axis=1)
            err = float(np.mean(e))
        m = meta.get(im["name"], {})
        cam_groups.setdefault(im["camera"], m.get("group", "?"))
        rec = {
            "name": im["name"],
            "group": m.get("group"),
            "camera": str(im["camera"]),
            "registered": True,
            "qvec": [float(v) for v in im["qvec"]],
            "tvec": [float(v) for v in im["tvec"]],
            "center": [float(v) for v in (-R.T @ im["tvec"])],
            "numObservations": int(np.count_nonzero(ok)),
            "reprojError": None if err is None else round(err, 4),
        }
        for k in ("source", "frameIndex", "time", "masked"):
            if k in m:
                rec[k] = m[k]
        out_images.append(rec)
        by_name[im["name"]] = rec
    for name, m in meta.items():
        if name not in by_name:
            rec = {"name": name, "group": m.get("group"), "registered": False}
            for k in ("source", "frameIndex", "time"):
                if k in m:
                    rec[k] = m[k]
            out_images.append(rec)
    errs = np.array([pts[p][6] for p in sorted(pts)], np.float64)
    tracks = np.array([pts[p][7] for p in sorted(pts)], np.float64)
    rgb = np.array([pts[p][3:6] for p in sorted(pts)], np.uint8).reshape(-1, 3)
    np.savez_compressed(work.root / "points.npz", xyz=P.astype(np.float32), rgb=rgb, error=errs.astype(np.float32),
                        track=tracks.astype(np.int32))
    groups = {}
    for gname in frames.get("groups", {}):
        tot = sum(1 for m in meta.values() if m.get("group") == gname)
        reg = [r for r in out_images if r.get("group") == gname and r["registered"]]
        e = [r["reprojError"] for r in reg if r.get("reprojError") is not None]
        groups[gname] = {"registered": len(reg), "total": tot, "meanReprojError": round(float(np.mean(e)), 4) if e else None}
    stats = {
        "registered": sum(1 for r in out_images if r["registered"]),
        "total": len(meta) or len(images),
        "points": int(len(P)),
        "meanReprojError": round(float(np.mean(errs)), 4) if len(errs) else None,
        "meanTrackLength": round(float(np.mean(tracks)), 3) if len(tracks) else None,
        "groups": groups,
        "continuity": continuity(out_images),
        "model": str(model),
    }
    poses = {
        "frame": "colmap",
        "convention": "world-to-camera, OpenCV axes (x right, y down, z forward), qvec wxyz",
        "cameras": {str(cid): {**cam.to_json(), "group": cam_groups.get(cid)} for cid, cam in cams.items()},
        "images": out_images,
        "stats": stats,
    }
    write_json(work.poses, poses)
    say(f"registered {stats['registered']}/{stats['total']}, {stats['points']} points, mean reprojection error "
        f"{stats['meanReprojError']} px, track {stats['meanTrackLength']}; per group {groups}")
    for g, c in stats["continuity"].items():
        say(f"path of {g}: {len(c['jumps'])} jumps (max step {c['maxSpeedRatio']}x the median)"
            + "".join(f"\n    {j['from']} -> {j['to']} ({j['speedRatio']}x)" for j in c["jumps"]))
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["solve", "export"])
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--colmap", default=os.environ.get("COLMAP_CMD", "colmap"))
    ap.add_argument("--no-gpu", action="store_true")
    ap.add_argument("--threads", type=int, default=int(os.environ.get("SLURM_CPUS_PER_TASK", "8")))
    ap.add_argument("--max-features", type=int, default=8192)
    ap.add_argument("--camera-model", default="SIMPLE_RADIAL", choices=["SIMPLE_RADIAL", "RADIAL", "OPENCV", "PINHOLE"])
    ap.add_argument("--model", type=Path, default=None, help="export: the COLMAP model folder (default: the largest)")
    ap.add_argument("--db", type=Path, default=None, help="solve: working database path (default WORK/colmap/database.db)")
    ap.add_argument("--reuse", action="store_true", help="solve: keep the features and matches of the last run, map again")
    ap.add_argument("--seq-window", type=int, default=8,
                    help="solve: within a video, only frames at most this many samples apart vote for each other (0 = all); "
                         "scale it with the sampling (8 at ~5 frames/s, 16 at ~10)")
    ap.add_argument("--tag", default="", help="solve: write the models to colmap/sparse-<tag>")
    a = ap.parse_args(argv)
    work = Work(a.work)
    colmap = shlex.split(a.colmap)
    if a.cmd == "solve":
        model = solve(work, colmap, not a.no_gpu, a.threads, a.max_features, a.camera_model, a.db, a.reuse, a.seq_window, a.tag)
        export(work, model, colmap)
    else:
        model = a.model
        if model is None:
            ms = sorted((work.colmap / "sparse").iterdir())
            model = max(ms, key=lambda m: (m / "images.bin").stat().st_size if (m / "images.bin").exists() else 0)
        elif not model.exists():
            model = work.root / model
        export(work, model, colmap)
    return 0


if __name__ == "__main__":
    sys.exit(main())
