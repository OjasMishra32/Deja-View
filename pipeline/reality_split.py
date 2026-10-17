"""Reality check: split a world into what the input camera SAW and what the world model IMAGINED.

A splat is SEEN when it projects inside the input camera's view (the part of the photo the world
model was given) and nothing in front of it hides it from that camera: its depth along the camera
axis is no further than the reference depth there, plus a tolerance. Everything else (behind the
camera, outside the frame, or hidden behind something the camera did see) was IMAGINED.

Writes, next to the world (or into --out):
  world-seen.spz       the SEEN splats, same file frame as the world (the scene transform applies)
  world-imagined.spz   the IMAGINED splats, same frame
  reality.json         {version, world, seen:{file,count}, imagined:{file,count}, total, seenFraction,
                        camera:{source, ...}, depth, tolerance, seconds}

Which camera (first match wins):
  1. input_camera.json (+ input_depth.npy): FlashWorld and AnySplat outputs (docs/FLASHWORLD.md section 5).
     The depth map is the world rendered at that camera; pixels without data fall back to our own z-buffer.
     Only the `crop` window counts as seen (that is the part of the photo the model saw), unless --no-crop.
  2. scene.video (Video plate rooms): the plate camera IS the video camera, so its intrinsics (pixels of the
     RGB region) and cameraPose (viewer frame) are the input camera. There is no stored depth: the reference
     depth is a z-buffer of the world's own splats seen from that camera (the lifted plate surface is in front,
     the generated shell behind it).
  3. assumed (bundled samples, raw worlds): a camera at the file origin in the viewer frame (transform.position),
     facing spawn.yaw (0 = down -Z), 65 degree long-side field of view, 4:3 landscape, with the z-buffer depth.
     reality.json says "source": "assumed" so the viewer can say so.

All positions are compared in the viewer frame before the floor shift (the frame `WorldAsset.transform` maps
into, and the frame input_camera.json and VideoLayer.cameraPose use).

CLI:
  python pipeline/reality_split.py SCENE_OR_OUTPUT_DIR [--out DIR] [--tol 0.08] [--rel-tol 0.06] [--no-crop]
Importable: split_scene(scene_dir, out_dir=None, ...) -> report dict; classify_seen(...) -> bool mask.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import splat_io as sio  # noqa: E402

REALITY_VERSION = 1
SEEN_FILE = "world-seen.spz"
IMAGINED_FILE = "world-imagined.spz"
REPORT_FILE = "reality.json"
DEFAULT_ABS_TOL = 0.08  # metres (viewer units) behind the reference surface that still count as that surface
DEFAULT_REL_TOL = 0.06  # plus this fraction of the reference depth (depth maps get coarser with distance)
NEAR = 0.05  # metres in front of the camera
ASSUMED_LONG_FOV_DEG = 65.0
ASSUMED_SIZE = (1024, 768)
ZBUFFER_LONG_SIDE = 512


@dataclass
class InputCamera:
    """A pinhole camera in the viewer frame. Intrinsics in pixels of width x height (pixel i spans [i, i+1))."""

    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    c2w: np.ndarray  # 4x4 OpenGL camera-to-world (looks down -Z, +Y up), viewer frame
    source: str  # input_camera | video | assumed
    crop: dict | None = None  # {x, y, w, h} window of the image that counts as seen
    depth: np.ndarray | None = None  # [dh, dw] z-depth covering the whole width x height image; 0 = no data
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        R = self.c2w[:3, :3]
        return {
            "source": self.source,
            "width": int(self.width),
            "height": int(self.height),
            "fx": round(float(self.fx), 4),
            "fy": round(float(self.fy), 4),
            "cx": round(float(self.cx), 4),
            "cy": round(float(self.cy), 4),
            "position": [round(float(v), 5) + 0.0 for v in self.c2w[:3, 3]],
            "quaternion": sio.matrix_to_quat_xyzw(R),
            "crop": self.crop,
            "notes": self.notes,
        }


def _read_json(path: Path) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def load_world(scene_dir: Path) -> tuple[dict, dict]:
    """Returns (world asset dict, scene dict). Works for a scene dir (Scene) and a job out/ dir (JobResult)."""
    scene = _read_json(scene_dir / "scene.json") or {}
    world = scene.get("world") if isinstance(scene.get("world"), dict) else None
    if world is None or not world.get("file"):
        for name in ("world.spz", "world.ply"):
            if (scene_dir / name).is_file():
                world = {"file": name, "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}}
                break
    if world is None:
        raise FileNotFoundError(f"{scene_dir}: no scene.json world and no world.spz / world.ply")
    world = dict(world)
    world.setdefault("transform", {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1})
    return world, scene


def _pose_c2w(position, quaternion_xyzw) -> np.ndarray:
    return sio.pose_matrix(sio.quat_xyzw_to_matrix(quaternion_xyzw or [0, 0, 0, 1]), position or [0, 0, 0])


def find_camera(scene_dir: Path, scene: dict, world: dict) -> InputCamera:
    """The input camera, from input_camera.json, the scene's video, or the documented assumption."""
    cam = _read_json(scene_dir / "input_camera.json")
    if cam and all(k in cam for k in ("width", "height", "fx", "fy", "cx", "cy")):
        c = InputCamera(
            width=int(cam["width"]), height=int(cam["height"]),
            fx=float(cam["fx"]), fy=float(cam["fy"]), cx=float(cam["cx"]), cy=float(cam["cy"]),
            c2w=_pose_c2w(cam.get("position"), cam.get("quaternion")),
            source="input_camera",
            crop=cam.get("crop") if isinstance(cam.get("crop"), dict) else None,
        )
        dpath = scene_dir / "input_depth.npy"
        if dpath.is_file():
            try:
                d = np.load(dpath).astype(np.float32)
                if d.ndim == 2 and d.size > 0:
                    d[~np.isfinite(d)] = 0.0
                    c.depth = d
                else:
                    c.notes.append("input_depth.npy has the wrong shape; using the z-buffer")
            except (OSError, ValueError):
                c.notes.append("input_depth.npy unreadable; using the z-buffer")
        return c
    video = scene.get("video") if isinstance(scene.get("video"), dict) else None
    if video and isinstance(video.get("intrinsics"), dict) and video.get("width") and video.get("height"):
        k = video["intrinsics"]
        pose = video.get("cameraPose") or {}
        return InputCamera(
            width=int(video["width"]), height=int(video["height"]),
            fx=float(k["fx"]), fy=float(k["fy"]), cx=float(k.get("cx", video["width"] / 2)), cy=float(k.get("cy", video["height"] / 2)),
            c2w=_pose_c2w(pose.get("position"), pose.get("quaternion")),
            source="video",
            notes=["Video plate room: the plate camera is the video camera"],
        )
    # assumed: the camera stood at the file origin (every generator we use builds around its input camera)
    w, h = ASSUMED_SIZE
    f = (max(w, h) / 2.0) / math.tan(math.radians(ASSUMED_LONG_FOV_DEG) / 2.0)
    pos = list((world.get("transform") or {}).get("position") or [0, 0, 0])
    yaw = float(((world.get("spawn") or {}).get("yaw")) or 0.0)
    c2w = sio.pose_matrix(sio.rot_y(yaw), pos)
    return InputCamera(
        width=w, height=h, fx=f, fy=f, cx=w / 2.0, cy=h / 2.0, c2w=c2w, source="assumed",
        notes=[f"No input camera stored: assumed one at the world origin facing yaw {yaw:.2f}, {ASSUMED_LONG_FOV_DEG:.0f} degree view"],
    )


def to_viewer(splats: sio.Splats, transform: dict) -> sio.Splats:
    R, t, s = sio.transform_parts(transform)
    return sio.transform_splats(splats, R, t, s)


def _filter3(d: np.ndarray, op) -> np.ndarray:
    """3x3 min or max filter of a depth map where 0 or inf (no data) counts as infinitely far."""
    x = np.where(d > 0, d, np.inf).astype(np.float32)
    out = x.copy()
    h, w = x.shape
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            ys, yd = slice(max(dy, 0), h + min(dy, 0)), slice(max(-dy, 0), h + min(-dy, 0))
            xs, xd = slice(max(dx, 0), w + min(dx, 0)), slice(max(-dx, 0), w + min(-dx, 0))
            op(out[yd, xd], x[ys, xs], out=out[yd, xd])
    return out


def _max3(d: np.ndarray) -> np.ndarray:
    """Edge leniency: a splat just behind a silhouette is compared with the far side of the edge."""
    return _filter3(d, np.maximum)


def close_see_through(d: np.ndarray) -> np.ndarray:
    """Morphological closing of the near surface (3x3 min, then 3x3 max): a z-buffer of discrete splats has
    pinholes where farther splats show through a surface; this fills them and keeps object outlines."""
    out = _filter3(_filter3(d, np.minimum), np.maximum)
    out[~np.isfinite(out)] = 0.0
    return out


def reference_depth(splats_viewer: sio.Splats, cam: InputCamera, long_side: int = ZBUFFER_LONG_SIDE) -> tuple[np.ndarray, str]:
    """Depth the input camera saw: the stored depth map, with holes filled from a z-buffer of the splats."""
    if cam.depth is not None:
        dh, dw = cam.depth.shape
    else:
        s = min(1.0, long_side / max(cam.width, cam.height))
        dw, dh = max(8, int(round(cam.width * s))), max(8, int(round(cam.height * s)))
    sx, sy = dw / cam.width, dh / cam.height
    z = sio.render_points(splats_viewer, cam.c2w, cam.fx * sx, cam.fy * sy, cam.cx * sx, cam.cy * sy, dw, dh,
                          min_opacity=0.3, max_radius=5, fill_holes=True).depth
    z = close_see_through(z.astype(np.float32))
    if cam.depth is None:
        return z, "zbuffer"
    d = cam.depth.copy()
    holes = d <= 0
    if holes.any():
        d[holes] = z[holes]
        return d, "input_depth+zbuffer"
    return d, "input_depth"


def project_points(means_viewer: np.ndarray, cam: InputCamera) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Pinhole projection into `cam` pixels. Returns (u, v, z, in_front), z positive along the view axis.

    Pixels use the same convention as InputCamera: pixel i spans [i, i + 1), and u = width is off the right edge.
    `in_front` only excludes points at or behind the near plane; callers apply their own crop and depth test.
    """
    P = np.asarray(means_viewer, np.float64)
    w2c = np.linalg.inv(cam.c2w)
    pc = P @ w2c[:3, :3].T + w2c[:3, 3]
    z = -pc[:, 2]
    in_front = np.isfinite(z) & (z > NEAR)
    zs = np.where(in_front, z, 1.0)
    u = cam.cx + cam.fx * pc[:, 0] / zs
    v = cam.cy - cam.fy * pc[:, 1] / zs
    in_front &= np.isfinite(u) & np.isfinite(v)
    return u, v, z, in_front


def classify_seen(
    means_viewer: np.ndarray,
    cam: InputCamera,
    depth: np.ndarray,
    abs_tol: float = DEFAULT_ABS_TOL,
    rel_tol: float = DEFAULT_REL_TOL,
    use_crop: bool = True,
) -> np.ndarray:
    """Boolean mask: True where the splat centre is SEEN by `cam` given the reference `depth` (covering the image)."""
    u, v, z, ok = project_points(means_viewer, cam)
    x0, y0, x1, y1 = 0.0, 0.0, float(cam.width), float(cam.height)
    if use_crop and cam.crop:
        x0 = float(cam.crop.get("x", 0))
        y0 = float(cam.crop.get("y", 0))
        x1 = x0 + float(cam.crop.get("w", cam.width))
        y1 = y0 + float(cam.crop.get("h", cam.height))
    ok &= (u >= x0) & (u < x1) & (v >= y0) & (v < y1)
    dh, dw = depth.shape
    col = np.clip(np.floor(np.where(ok, u, 0) * dw / cam.width), 0, dw - 1).astype(np.int64)
    row = np.clip(np.floor(np.where(ok, v, 0) * dh / cam.height), 0, dh - 1).astype(np.int64)
    far = _max3(depth)[row, col].astype(np.float64)
    limit = far * (1.0 + rel_tol) + abs_tol  # inf where nothing was in the way
    return ok & (z <= limit)


def _write_part(path: Path, s: sio.Splats, sh_degree: int) -> None:
    if len(s) == 0:
        # an empty file is not a valid world for every reader: one invisible splat at the origin
        s = sio.Splats.from_rgb(np.zeros((1, 3)), [0.5, 0.5, 0.5], 1e-4, opacities=0.0)
    sio.write_spz(path, s, sh_degree=sh_degree)


def split_scene(
    scene_dir: str | Path,
    out_dir: str | Path | None = None,
    abs_tol: float = DEFAULT_ABS_TOL,
    rel_tol: float = DEFAULT_REL_TOL,
    use_crop: bool = True,
    log=print,
) -> dict:
    """Classifies every splat of the scene's world and writes world-seen.spz, world-imagined.spz, reality.json."""
    t0 = time.time()
    scene_dir = Path(scene_dir)
    out = Path(out_dir) if out_dir else scene_dir
    out.mkdir(parents=True, exist_ok=True)
    world, scene = load_world(scene_dir)
    src = scene_dir / world["file"]
    splats = sio.read_splats(src)
    cam = find_camera(scene_dir, scene, world)
    sv = to_viewer(splats, world["transform"])
    depth, depth_how = reference_depth(sv, cam)
    seen = classify_seen(sv.means, cam, depth, abs_tol, rel_tol, use_crop)
    del sv
    n_seen = int(seen.sum())
    n_all = len(splats)
    deg = min(splats.sh_degree, 3)
    _write_part(out / SEEN_FILE, splats.subset(np.nonzero(seen)[0]), deg)
    _write_part(out / IMAGINED_FILE, splats.subset(np.nonzero(~seen)[0]), deg)
    report = {
        "version": REALITY_VERSION,
        "world": world["file"],
        "seen": {"file": SEEN_FILE, "count": n_seen},
        "imagined": {"file": IMAGINED_FILE, "count": n_all - n_seen},
        "total": n_all,
        "seenFraction": round(n_seen / max(1, n_all), 4),
        "camera": cam.to_json(),
        "depth": depth_how,
        "tolerance": {"abs": abs_tol, "rel": rel_tol, "crop": bool(use_crop and cam.crop)},
        "seconds": round(time.time() - t0, 2),
    }
    sio.write_json_atomic(out / REPORT_FILE, report)
    log(f"reality: {n_seen}/{n_all} splats seen ({report['seenFraction'] * 100:.1f}%), camera {cam.source}, depth {depth_how}, {report['seconds']}s")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Split a world into what the camera saw and what was imagined.")
    ap.add_argument("scene_dir", help="a data/scenes/<id> dir or a FlashWorld output dir")
    ap.add_argument("--out", default=None, help="where to write the parts (default: next to the world)")
    ap.add_argument("--tol", type=float, default=DEFAULT_ABS_TOL, help="absolute depth tolerance (m)")
    ap.add_argument("--rel-tol", type=float, default=DEFAULT_REL_TOL, help="relative depth tolerance")
    ap.add_argument("--no-crop", action="store_true", help="count the whole photo as seen, not just the crop the model saw")
    args = ap.parse_args(argv)
    try:
        report = split_scene(args.scene_dir, args.out, args.tol, args.rel_tol, not args.no_crop)
    except (FileNotFoundError, ValueError) as e:
        print(f"reality: {e}", file=sys.stderr)
        return 2
    print(json.dumps({k: report[k] for k in ("seen", "imagined", "seenFraction", "depth")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
