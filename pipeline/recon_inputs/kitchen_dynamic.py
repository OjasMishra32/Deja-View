#!/usr/bin/env python3
"""Masks for things that move in the kitchen video but are not people: an open fridge door, a carried jug.

The person segmentation only knows people. An object that is in one place in some frames and elsewhere (or gone)
in the others ends up half-transparent in the splats. Here each such object gets a box in the room frame (y up,
metres) and a list of time windows of the clip; every pixel of a frame in a window whose ray passes through the box
is set to "ignore" (0) in that frame's mask, on top of the person mask. The static room behind the box comes from
the photos and from the frames outside the windows (the training loss and pose refinement skip masked pixels).

  python pipeline/recon_inputs/kitchen_dynamic.py probe --work WORK --image photo/IMG_7395.jpg --poly 10,20 300,20 ...
      the room-frame points COLMAP observed in that image inside the polygon (pixels of the prepared image), with
      their extent in the wall axes (kitchen_room.wall_yaw): to size a box
  python pipeline/recon_inputs/kitchen_dynamic.py apply --work WORK --boxes boxes.json [--sheet out.jpg]
      boxes.json: [{"name": "...", "centre": [x, y, z], "size": [sx, sy, sz], "yawDeg": a, "group": "cook",
                    "times": [[t0, t1], ...]}]  (size along the box's own x, y, z; yawDeg turns it about +y)

`apply` keeps the person masks in WORK/masks-person/ (copied from WORK/masks/ the first time) and rebuilds
WORK/masks/<image>.png = person mask AND box masks, so it can be rerun with other boxes. The box-only masks go to
WORK/masks-dynamic/. frames.json gets each image's new `masked` fraction and an `extraMasks` record.
NOTE: prep.py --redo-masks rewrites WORK/masks/ from scratch; rerun `apply` after it.
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitchen_room import load, qvec_to_rotmat, to_wall_axes, wall_yaw  # noqa: E402


def image_point_ids(model: Path, name: str) -> tuple[np.ndarray, np.ndarray]:
    """(xy (N, 2), point3D ids (N,)) of the observations of one image that have a 3D point."""
    with open(model / "images.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            f.read(4 + 32 + 24 + 4)
            nm = b""
            while (c := f.read(1)) != b"\0":
                nm += c
            (np2,) = struct.unpack("<Q", f.read(8))
            raw = np.frombuffer(f.read(24 * np2), dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("p", "<i8")]))
            if nm.decode() == name:
                ok = raw["p"] != -1
                return np.stack([raw["x"][ok], raw["y"][ok]], 1), raw["p"][ok].astype(np.int64)
    raise SystemExit(f"{name} not in {model}")


def points_by_id(model: Path) -> dict[int, np.ndarray]:
    out = {}
    with open(model / "points3D.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            pid, x, y, z = struct.unpack("<Q3d", f.read(32))
            f.read(11)
            (L,) = struct.unpack("<Q", f.read(8))
            f.seek(8 * L, 1)
            out[pid] = np.array([x, y, z])
    return out


def probe(a) -> int:
    import cv2

    room = load(a.work)
    poses = json.loads((a.work / "poses.json").read_text())
    model = Path(poses["stats"]["model"])
    xy, ids = image_point_ids(model, a.image)
    poly = np.array([[float(v) for v in p.split(",")] for p in a.poly], np.float32)
    inside = np.array([cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0 for x, y in xy])
    pts = points_by_id(model)
    Rt = room.frame["colmapToRoom"]
    R, t, s = np.asarray(Rt["R"]), np.asarray(Rt["t"]), float(Rt["scale"])
    X = np.array([s * (R @ pts[i]) + t for i in ids[inside]])
    good = (room.track >= 3) & (room.err < 2.0)
    yaw = wall_yaw(room.P[good])
    uv = to_wall_axes(X[:, [0, 2]], yaw)
    pc = lambda v: [round(float(q), 3) for q in np.percentile(v, [2, 10, 50, 90, 98])]  # noqa: E731
    rep = {"image": a.image, "points": int(len(X)), "wallYawDeg": round(float(np.degrees(yaw)), 2),
           "percentiles": "2 10 50 90 98", "x": pc(X[:, 0]), "y": pc(X[:, 1]), "z": pc(X[:, 2]),
           "u": pc(uv[:, 0]), "v": pc(uv[:, 1])}
    cam = room.C[room.index(a.image)] if a.image in room.names else None
    if cam is not None:
        rep["cameraRoom"] = np.round(cam, 3).tolist()
        rep["cameraUV"] = np.round(to_wall_axes(cam[None, [0, 2]], yaw)[0], 3).tolist()
    print(json.dumps(rep, indent=1))
    if a.out:
        np.save(a.out, X)
    return 0


def locate(a) -> int:
    """Pixel of a prepared image -> the room point where its ray meets the horizontal plane y = --plane-y."""
    room = load(a.work)
    poses = json.loads((a.work / "poses.json").read_text())
    good = (room.track >= 3) & (room.err < 2.0)
    yaw = wall_yaw(room.P[good])
    for spec in a.at:
        name, px = spec.split("@")
        u, v = (float(q) for q in px.split(","))
        k = room.index(name)
        cam = poses["cameras"][room.meta[k]["camera"]]
        d = room.Rc2w[k] @ np.array([(u - cam["cx"]) / cam["fx"], (v - cam["cy"]) / cam["fy"], 1.0])
        t = (a.plane_y - room.C[k][1]) / d[1]
        X = room.C[k] + t * d
        uv = to_wall_axes(X[None, [0, 2]], yaw)[0]
        print(f"{name} ({u:.0f}, {v:.0f}) -> room {np.round(X, 3).tolist()}  wall u,v {np.round(uv, 3).tolist()}  "
              f"distance {t * np.linalg.norm(d):.2f} m")
    return 0


def box_hits(C: np.ndarray, Rc2w: np.ndarray, K: np.ndarray, size: tuple[int, int], box: dict, div: int = 4) -> np.ndarray:
    """bool (H, W): pixels whose ray from camera centre C hits the box (at positive depth)."""
    import cv2

    W, H = size
    w, h = W // div, H // div
    u, v = np.meshgrid((np.arange(w) + 0.5) * div, (np.arange(h) + 0.5) * div)
    d_cam = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
    d = d_cam @ Rc2w.T
    a = np.radians(box.get("yawDeg", 0.0))
    Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    o = Ry.T @ (C - np.asarray(box["centre"], np.float64))
    dl = d @ Ry
    half = 0.5 * np.asarray(box["size"], np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = (-half - o) / dl
        t2 = (half - o) / dl
    tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
    tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
    hit = (tmax >= np.maximum(tmin, 0.0)).astype(np.uint8)
    hit = cv2.resize(hit, (W, H), interpolation=cv2.INTER_NEAREST)
    hit = cv2.dilate(hit, np.ones((2 * div + 1, 2 * div + 1), np.uint8))
    return hit > 0


def resolve_box(b: dict, yaw: float) -> dict:
    """A box given in the wall axes ({"u": [lo, hi], "v": [lo, hi], "y": [lo, hi]}) -> centre, size, yawDeg."""
    if "u" not in b:
        return b
    u0, u1 = b["u"]
    v0, v1 = b["v"]
    y0, y1 = b["y"]
    uc, vc = 0.5 * (u0 + u1), 0.5 * (v0 + v1)
    c, s_ = np.cos(yaw), np.sin(yaw)
    out = dict(b)
    # box x along the u axis (room xz direction (cos, sin)), box z along v ((-sin, cos)); rotation about +y by -yaw
    out["centre"] = [uc * c - vc * s_, 0.5 * (y0 + y1), uc * s_ + vc * c]
    out["size"] = [u1 - u0, y1 - y0, v1 - v0]
    out["yawDeg"] = -float(np.degrees(yaw))
    return out


def apply(a) -> int:
    import cv2

    work = a.work
    frames = json.loads((work / "frames.json").read_text())
    poses = json.loads((work / "poses.json").read_text())
    room = load(work)
    good = (room.track >= 3) & (room.err < 2.0)
    yaw = wall_yaw(room.P[good])
    boxes = [resolve_box(b, yaw) for b in json.loads(a.boxes.read_text())]
    times = {im["name"]: im.get("time") for im in frames["images"]}
    for b in boxes:
        a_ = np.radians(b["yawDeg"])
        Ry = np.array([[np.cos(a_), 0, np.sin(a_)], [0, 1, 0], [-np.sin(a_), 0, np.cos(a_)]])
        loc = (room.C - np.asarray(b["centre"])) @ Ry
        inside = np.all(np.abs(loc) <= 0.5 * np.asarray(b["size"]), axis=1)
        live = [room.names[i] for i in np.nonzero(inside)[0] if room.groups[i] == b.get("group", "cook")
                and times.get(room.names[i]) is not None and any(t0 <= times[room.names[i]] <= t1 for t0, t1 in b["times"])]
        print(f"box {b['name']}: centre {np.round(b['centre'], 3).tolist()} size {np.round(b['size'], 3).tolist()} "
              f"yaw {b['yawDeg']:.1f}; frames in its windows with the camera inside (would be masked whole): {live}")
    person = work / "masks-person"
    if not person.exists():
        shutil.copytree(work / "masks", person)
        print(f"person masks kept in {person}")
    dyn_dir = work / "masks-dynamic"
    if dyn_dir.exists():
        shutil.rmtree(dyn_dir)
    stats = []
    sheet = []
    for im in frames["images"]:
        name = im["name"]
        pm_path = person / f"{name}.png"
        out_path = work / "masks" / f"{name}.png"
        hit_any = None
        hits = []
        if name in room.names:
            k = room.index(name)
            cam = poses["cameras"][room.meta[k]["camera"]]
            K = np.array([[cam["fx"], 0, cam["cx"]], [0, cam["fy"], cam["cy"]], [0, 0, 1.0]])
            for b in boxes:
                if b.get("group", "cook") != im["group"] or "time" not in im:
                    continue
                if not any(t0 <= im["time"] <= t1 for t0, t1 in b["times"]):
                    continue
                hb = box_hits(room.C[k], room.Rc2w[k], K, (cam["width"], cam["height"]), b)
                if hb.any():
                    hits.append(b["name"])
                    hit_any = hb if hit_any is None else (hit_any | hb)
        pm = cv2.imread(str(pm_path), cv2.IMREAD_GRAYSCALE) if pm_path.exists() else None
        if hit_any is None:
            # no box here: the person mask as it is (or none)
            if pm is not None:
                shutil.copyfile(pm_path, out_path)
            elif out_path.exists():
                out_path.unlink()
            im["masked"] = round(float((pm < 128).mean()), 4) if pm is not None else 0.0
            im.pop("dynamic", None)
            continue
        if pm is None:
            pm = np.full(hit_any.shape, 255, np.uint8)
        m = np.where(hit_any, 0, pm).astype(np.uint8)
        dyn = np.where(hit_any, 0, 255).astype(np.uint8)
        (dyn_dir / name).parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(dyn_dir / f"{name}.png"), dyn)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), m)
        im["masked"] = round(float((m < 128).mean()), 4)
        im["dynamic"] = hits
        stats.append({"name": name, "time": im.get("time"), "boxes": hits, "boxPct": round(100 * float(hit_any.mean()), 1),
                      "maskedPct": round(100 * im["masked"], 1)})
        sheet.append((name, im.get("time"), m))
    frames["extraMasks"] = {"tool": "pipeline/recon_inputs/kitchen_dynamic.py", "boxes": boxes,
                            "note": "masks/ = masks-person/ AND masks-dynamic/; rerun after prep.py --redo-masks"}
    (work / "frames.json").write_text(json.dumps(frames, indent=1) + "\n")
    print(json.dumps(stats, indent=0))
    print(f"{len(stats)} frames got box masks")
    if a.sheet and sheet:
        tiles = []
        pick = [sheet[i] for i in np.linspace(0, len(sheet) - 1, min(a.n, len(sheet))).round().astype(int)]
        for name, t, m in pick:
            img = cv2.imread(str(work / "images" / name))
            sel = m < 128
            img[sel] = (0.45 * img[sel] + 0.55 * np.array([235, 120, 40])).astype(np.uint8)
            img = cv2.resize(img, (480, int(round(480 * img.shape[0] / img.shape[1]))), interpolation=cv2.INTER_AREA)
            cv2.rectangle(img, (0, 0), (480, 24), (0, 0, 0), -1)
            cv2.putText(img, f"t={t:.1f}s {name.split('/')[-1]}", (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1,
                        cv2.LINE_AA)
            tiles.append(img)
        while len(tiles) % 4:
            tiles.append(np.zeros_like(tiles[0]))
        rows = [np.concatenate(tiles[k:k + 4], axis=1) for k in range(0, len(tiles), 4)]
        a.sheet.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(a.sheet), np.concatenate(rows, 0), [cv2.IMWRITE_JPEG_QUALITY, 82])
        print(f"wrote {a.sheet}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--work", required=True, type=Path)
    p.add_argument("--image", required=True)
    p.add_argument("--poly", nargs="+", required=True)
    p.add_argument("--out", type=Path, default=None)
    q = sub.add_parser("apply")
    q.add_argument("--work", required=True, type=Path)
    q.add_argument("--boxes", required=True, type=Path)
    q.add_argument("--sheet", type=Path, default=None)
    q.add_argument("--n", type=int, default=16)
    r = sub.add_parser("locate")
    r.add_argument("--work", required=True, type=Path)
    r.add_argument("--plane-y", type=float, required=True)
    r.add_argument("--at", nargs="+", required=True, help="image@u,v (pixels of the prepared image)")
    a = ap.parse_args(argv)
    return {"probe": probe, "apply": apply, "locate": locate}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
