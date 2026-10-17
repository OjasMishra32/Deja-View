"""Sky completion: a 360 backdrop of everything beyond the walk area, completed where the footage never looked.

The viewer draws the splats over a backdrop at infinity (Spark's splats blend over whatever is behind them), and the
Roblox place puts a six-face Sky behind its mesh. Where the reconstruction has nothing (the night sky over an open
lawn, palm crowns above the top of every frame) that backdrop is what people see. This module makes it:

  render  (gsplat, flashworld env) six cube faces from the spawn at eye height of the splats OUTSIDE the walk box
          (world.bounds + a margin sideways, as pipeline/roblox_mesh.py's skybox), resampled to an equirect, with
          alpha, range and, per pixel, how many training cameras saw that point (in frame and not behind a surface of
          the room). Far splats no camera saw (blurred tops above every frame, glare behind the walls) and the mirror
          world under the floor (by height) count as missing. With --palms, genfill.palms crowns of palms beyond the
          box are kept whole and those of palms inside it are left out (the 3D world has them).
  fill    a prior everywhere: the night sky of the photos above the horizon, the real ground pushed out and fading to
          unlit dark below. Qwen-Image-Edit-2511 (genfill model worker) paints only a band above the real skyline
          (smoothed and tapered so its outline suggests no shape) and the gaps next to real content, seeing the
          panorama rolled so its edges fall where that band never reaches (so there is no seam; a band across the
          seam is repainted only if there is no such place), optionally with a real photo as image 2 (--ref). Joins
          are colour-corrected by a clipped push-pull of the ring difference fading into the band; leftover magenta
          and stray lights in open sky are removed; small isolated far bits and faint floaters are dropped; the
          zenith is smoothed along the azimuth so the equirect's pole does not pinch.
  faces   the completed equirect -> backdrop-sky.jpg (three.js equirectUv convention, see EQUIRECT_NOTE) and six cube
          faces in Roblox's Sky convention (sky-v3-<face>.png): the far splats rendered at face size where they
          survived, the fill sampled from the equirect elsewhere.
  check   viewer-like views from standing spots: the live splats (gsplat, transparent) over black | over the backdrop.

  python -m genfill.sky render --scene-dir IN --out OUT [--world world-filled.spz]
  python -m genfill.sky fill   --out OUT --queue Q [--candidates N] [--seed S] [--pick I] [--ref photo.jpg] [--reuse]
  python -m genfill.sky faces  --out OUT
  python -m genfill.sky check  --scene-dir IN --out OUT
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

from . import world as W

# Roblox Sky faces (pipeline/roblox_mesh.py SKY_FACES): look direction and image-up of each face, room frame
# (Y up, -Z forward). Left (+X) is to the RIGHT of front; Up's image top points to +X, Down's to -X.
FACES = {
    "front": ((0.0, 0.0, -1.0), (0.0, 1.0, 0.0)),
    "left": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "back": ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    "right": ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "up": ((0.0, 1.0, 0.0), (1.0, 0.0, 0.0)),
    "down": ((0.0, -1.0, 0.0), (-1.0, 0.0, 0.0)),
}
EQUIRECT_NOTE = ("three.js equirectUv: a world direction d (Y up, -Z forward) is at u = atan2(d.z, d.x) / 2pi + 0.5, "
                 "v = asin(d.y) / pi + 0.5 with v = 1 the top row (TextureLoader flipY). Image centre = +X, left quarter "
                 "= -Z (forward at spawn yaw 0), right quarter = +Z, left/right edge = -X. Values are sRGB. "
                 "web/src/viewer/backdrop.ts samples it with exactly this formula; scene.background with "
                 "THREE.EquirectangularReflectionMapping uses the same one.")

SCENE_TEXT = "a university campus lawn with palm trees beside a dormitory building"
SKY_PROMPT = (
    "This is a 360-degree panoramic photo of {scene}, taken in the middle of the night. Fill the solid magenta "
    "areas so that the photo is complete. Continue every structure that runs into them: palm tree trunks up into full "
    "palm crowns of fan-shaped fronds, tree tops into their full canopies, building walls up to their roof edge with "
    "the same rows of windows and lights, lamp posts up to their lamps. Buildings here are no more than four or five "
    "storeys high and most of their windows are dark. Where the magenta reaches down to the horizon with nothing "
    "above it, it is a distant dark line of trees. Everything else in the magenta is "
    "the night sky, the same very dark, almost black sky as in the rest of the photo, with no stars, no moon, no "
    "clouds and no glow. Do not add trees, palms, buildings or objects that do not grow out of what is visible. Keep "
    "the same perspective, lighting, colours and sharpness. Do not change anything outside the magenta areas. "
    "Photorealistic, no magenta or pink left.")
SEAM_PROMPT = (
    "This is a part of a panoramic photo of {scene}, taken in the middle of the night. Fill the solid magenta band "
    "so that its left and right sides join seamlessly: continue the very dark night sky and whatever trees, fronds, "
    "roof edges or lights reach the band, with the same colours, brightness and sharpness on both sides. Do not add "
    "new objects. Do not change anything outside the magenta area. Photorealistic, no magenta or pink left.")
NEGATIVE = ("magenta, pink, purple, blurry, smeared, low detail, cartoon, painting, text, watermark, people, border, "
            "frame, daylight, blue sky, sunset, twilight, sun, bright sky, clouds, stars, moon, glow, repeated pattern, "
            "tiled, duplicated trees, extra palm trees, table, seam")
REF_LINE = (" Image 2 is a real photo taken at this place at the same time, looking up past the palms: the buildings, "
            "trees and sky you paint must look like the ones in it (the same pale four-storey building with mostly "
            "dark windows, the same dark oak trees), but keep image 1's panoramic layout and do not copy image 2's "
            "palms into the magenta area.")
# the night sky in the photos (IMG_7363, the one photo that framed the crowns: median sRGB of its open sky)
SKY_TOP = (8, 10, 13)
SKY_HORIZON = (10, 12, 15)
GROUND_DARK = (16, 19, 14)  # unlit grass and paving at night, far from any light
MAGENTA = np.array([255, 0, 255], np.uint8)


def say(msg: str) -> None:
    print(f"[genfill:sky] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------------------------------------------
# Geometry: cube faces and the equirect
# --------------------------------------------------------------------------------------------------------------


def face_basis(name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    f, u = (np.asarray(x, np.float64) for x in FACES[name])
    return f, u, np.cross(f, u)


def face_c2w(name: str, eye: np.ndarray) -> np.ndarray:
    """OpenGL camera-to-world of a cube face (camera looks down its -Z = the face's look direction)."""
    f, u, r = face_basis(name)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = r, u, -f, eye
    return m


def equirect_dirs(w: int, h: int) -> np.ndarray:
    """[h, w, 3] unit directions of the pixel centres (three.js equirectUv convention, row 0 = top)."""
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    phi = (u - 0.5) * 2 * np.pi
    el = (0.5 - v) * np.pi
    P, E = np.meshgrid(phi, el)
    return np.stack([np.cos(E) * np.cos(P), np.sin(E), np.cos(E) * np.sin(P)], -1)


def elevation_deg(h: int) -> np.ndarray:
    return (0.5 - (np.arange(h) + 0.5) / h) * 180.0


def azimuth_col(az_deg: float, w: int) -> float:
    """Column (continuous) of a three.js azimuth atan2(z, x) in degrees."""
    return ((az_deg / 360.0 + 0.5) % 1.0) * w


def cube_lookup(d: np.ndarray, size: int, pad: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Directions [N,3] -> (face index, x, y): continuous pixel coordinates (centres at +0.5) in a padded face
    image of size+2*pad rendered with f = size/2."""
    names = list(FACES)
    Fw = np.array([face_basis(n)[0] for n in names])
    Uw = np.array([face_basis(n)[1] for n in names])
    Rw = np.array([face_basis(n)[2] for n in names])
    dots = d @ Fw.T
    k = dots.argmax(1)
    fd = dots[np.arange(len(d)), k]
    a = (d * Rw[k]).sum(1) / fd
    b = (d * Uw[k]).sum(1) / fd
    x = (a + 1.0) * size / 2.0 + pad
    y = (1.0 - b) * size / 2.0 + pad
    return k, x, y


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """img [H,W,C]; x, y continuous pixel coordinates with centres at +0.5."""
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    a = img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx
    b = img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def sample_cube(faces: np.ndarray, d: np.ndarray, size: int, pad: int, nearest: bool = False) -> np.ndarray:
    """faces [6, P, P, C] (padded) sampled at directions d [N,3] -> [N, C]."""
    k, x, y = cube_lookup(d, size, pad)
    out = np.zeros((len(d), faces.shape[-1]), np.float32)
    for i in range(6):
        m = k == i
        if not m.any():
            continue
        if nearest:
            xi = np.clip(np.floor(x[m]).astype(np.int64), 0, faces.shape[2] - 1)
            yi = np.clip(np.floor(y[m]).astype(np.int64), 0, faces.shape[1] - 1)
            out[m] = faces[i][yi, xi]
        else:
            out[m] = bilinear(faces[i], x[m], y[m])
    return out


def sample_equirect(img: np.ndarray, d: np.ndarray) -> np.ndarray:
    """img [H,W,C] equirect (three.js convention) sampled bilinearly at directions d [N,3], wrapping in azimuth."""
    h, w = img.shape[:2]
    u = np.arctan2(d[:, 2], d[:, 0]) / (2 * np.pi) + 0.5
    v = 0.5 - np.arcsin(np.clip(d[:, 1], -1, 1)) / np.pi
    wrap = np.concatenate([img[:, -1:], img, img[:, :1]], 1)  # one column of wrap on each side
    return bilinear(wrap, u * w + 1.0, v * h)


def face_dirs(size: int) -> np.ndarray:
    """[6, size, size, 3] unit directions of every face pixel (FACES order)."""
    c = (np.arange(size) + 0.5) / size * 2 - 1
    A, B = np.meshgrid(c, -c)
    out = []
    for n in FACES:
        f, u, r = face_basis(n)
        d = A[..., None] * r + B[..., None] * u + f
        out.append(d / np.linalg.norm(d, axis=-1, keepdims=True))
    return np.stack(out)


# --------------------------------------------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------------------------------------------


def walk_box(world: W.World, margin: float) -> tuple[np.ndarray, np.ndarray]:
    lo, hi = world.bounds
    return lo - margin, hi + margin


def render_faces(gs, eye: np.ndarray, size: int, pad: int, extra=None):
    """-> rgb [6,P,P,3] (premultiplied over black), alpha [6,P,P,1], range [6,P,P,1] (0 where alpha < 0.5) and,
    with `extra` (a per-splat value), its alpha-blended render [6,P,P,1] (else None)."""
    from .geom import Intr
    from .gpu import render

    P = size + 2 * pad
    k = Intr(size / 2.0, size / 2.0, P / 2.0, P / 2.0, P, P)
    c = (np.arange(P) + 0.5 - P / 2.0) / (size / 2.0)
    A, B = np.meshgrid(c, c)
    stretch = np.sqrt(1 + A * A + B * B).astype(np.float32)  # z-depth -> range
    rgbs, als, rngs, exs = [], [], [], []
    for n in FACES:
        r = render(gs, face_c2w(n, eye), k, extras=extra)
        rgbs.append(r["rgb"].cpu().numpy().astype(np.float32))
        als.append(r["alpha"].cpu().numpy().astype(np.float32)[..., None])
        rngs.append((r["depth"].cpu().numpy() * stretch).astype(np.float32)[..., None])
        if extra is not None:
            exs.append(r["extras"].cpu().numpy().astype(np.float32).reshape(P, P, 1))
    return np.stack(rgbs), np.stack(als), np.stack(rngs), (np.stack(exs) if exs else None)


def depth_alpha(gs, c2w: np.ndarray, k):
    """Expected depth (z) and alpha of a view, no thresholds."""
    import torch
    from gsplat import rasterization

    from .gpu import kmat, viewmat

    cols = torch.zeros((len(gs), 3), device=gs.device)
    with torch.no_grad():
        img, alpha, _ = rasterization(gs.means, gs.quats, gs.scales, gs.opac, cols, viewmat(c2w, gs.device)[None],
                                      kmat(k, gs.device)[None], k.width, k.height, sh_degree=None, render_mode="RGB+ED",
                                      near_plane=0.02, far_plane=1e4, packed=False)
    return img[0, ..., 3], alpha[0, ..., 0]


def seen_counts(gs_all, gs_near, cams, pts: np.ndarray, valid: np.ndarray, scale: float = 0.25, margin: float = 0.02,
                tol_rel: float = 0.1, tol_abs: float = 0.25, near_alpha: float = 0.35) -> np.ndarray:
    """How many training cameras saw each point: in frame (with a margin), in front, and not behind a surface of
    the room itself (splats inside the walk box with alpha >= near_alpha, by their own expected depth: the glare a
    splat world leaves behind its walls and lights is "seen" by the trainer through them, but nobody standing in
    the room sees it). The whole world's depth is not used: semi-transparent floaters pull its expected depth in
    front of real far content. The mirror world under a glossy floor is dropped by height (cmd_render). Points
    where `valid` is False get 0. gs_all is unused (kept for the signature)."""
    import torch

    from .geom import w2c_cv

    dev = gs_all.device
    P = torch.from_numpy(pts[valid].astype(np.float32)).to(dev)
    cnt = torch.zeros(len(P), dtype=torch.int32, device=dev)
    for c in cams:
        k = c.intr.scaled(scale)
        d_near, a_near = depth_alpha(gs_near, c.c2w, k)
        m = torch.from_numpy(w2c_cv(c.c2w).astype(np.float32)).to(dev)
        pc = P @ m[:3, :3].T + m[:3, 3]
        z = pc[:, 2]
        zs = z.clamp_min(1e-3)
        u = k.fx * pc[:, 0] / zs + k.cx
        v = k.fy * pc[:, 1] / zs + k.cy
        inb = (z > 0.1) & (u >= margin * k.width) & (u < (1 - margin) * k.width) & (v >= margin * k.height) & \
              (v < (1 - margin) * k.height)
        ui = u.clamp(0, k.width - 1).long()
        vi = v.clamp(0, k.height - 1).long()
        behind_near = (a_near[vi, ui] >= near_alpha) & (z > d_near[vi, ui] * (1 + tol_rel) + tol_abs)
        cnt += (inb & ~behind_near).int()
    out = np.zeros(valid.shape, np.int32)
    out[valid] = cnt.cpu().numpy()
    return out


def cmd_render(a) -> int:
    from .gpu import GS

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    world = W.load(a.scene_dir, a.world)
    tr = world.scene["world"].get("transform") or {}
    if tr and (any(abs(x) > 1e-6 for x in tr.get("position", [0, 0, 0])) or
               abs(float(tr.get("scale", 1)) - 1) > 1e-6 or
               any(abs(x - y) > 1e-6 for x, y in zip(tr.get("quaternion", [0, 0, 0, 1]), [0, 0, 0, 1]))):
        raise SystemExit("sky: only scenes whose world.transform is the identity (file frame = viewer frame)")
    floor = float(world.scene["world"].get("floorY", 0.0))
    sp = world.scene["world"].get("spawn", {}).get("position", [0, 0, 0])
    eye = np.array([sp[0], floor + a.eye_height, sp[2]], np.float64)
    lo, hi = walk_box(world, a.margin)
    s = world.splats
    m = s.means
    inside = (m[:, 0] >= lo[0]) & (m[:, 0] <= hi[0]) & (m[:, 2] >= lo[2]) & (m[:, 2] <= hi[2])
    far = ~inside
    keep = np.zeros(len(s), bool)  # generated content to keep as if seen (palm crowns of palms beyond the box)
    if a.palms:
        # genfill.palms crowns: whole palms go with their trunk (a crown cut by the box is a floating fragment)
        doc = json.loads(Path(a.palms).read_text())
        trunks = np.array([[p["trunk"]["x"], p["trunk"]["z"]] for p in doc["palms"]])
        g0 = int(doc["generatedFrom"])
        gi = np.arange(g0, len(s))
        near_t = np.argmin(((m[gi][:, None, [0, 2]] - trunks[None]) ** 2).sum(-1), 1)
        t_out = ~((trunks[:, 0] >= lo[0]) & (trunks[:, 0] <= hi[0]) & (trunks[:, 1] >= lo[2]) & (trunks[:, 1] <= hi[2]))
        far[gi] = t_out[near_t]
        keep[gi] = t_out[near_t]
        say(f"palms: {len(gi)} generated splats from {g0}; palms beyond the box {np.nonzero(t_out)[0].tolist()} "
            f"({int(keep.sum())} splats kept whole), the others' crowns left to the 3D world")
    say(f"world {world.world_file} ({world.digest}): {len(s)} splats, {int(far.sum())} beyond the box "
        f"x {lo[0]:.2f}..{hi[0]:.2f} z {lo[2]:.2f}..{hi[2]:.2f}; eye {eye.round(3).tolist()}")
    far_idx = np.nonzero(far)[0]
    gs_far = GS(s.subset(far_idx))
    gs_all = GS(s)
    # what the footage saw is judged against the world the trainer fitted to it: generated splats (genfill's
    # ceiling plane and palm crowns) were never in a photo, so they must not hide what the photos did show
    n_orig = int(doc.get("originalUpTo", doc["generatedFrom"])) if a.palms else len(s)
    orig = np.arange(len(s)) < n_orig
    gs_seen_all = GS(s.subset(np.nonzero(orig)[0]))
    gs_seen_near = GS(s.subset(np.nonzero(orig & inside)[0]))
    keep_t = None
    if keep.any():
        import torch

        keep_t = torch.from_numpy(keep[far_idx].astype(np.float32)).to(gs_far.device)
    size, pad = a.face, 2
    t0 = time.time()
    f_rgb, f_al, f_rng, f_keep = render_faces(gs_far, eye, size, pad, keep_t)
    a_rgb, a_al, _, _ = render_faces(gs_all, eye, size, pad)
    say(f"cube faces ({size} px) in {time.time() - t0:.1f}s")
    Wd, Hd = a.width, a.width // 2
    d = equirect_dirs(Wd, Hd).reshape(-1, 3)
    rgb = sample_cube(f_rgb, d, size, pad).reshape(Hd, Wd, 3)
    al = sample_cube(f_al, d, size, pad).reshape(Hd, Wd)
    rng = sample_cube(f_rng, d, size, pad, nearest=True).reshape(Hd, Wd)
    keepf = sample_cube(f_keep, d, size, pad).reshape(Hd, Wd) / np.maximum(al, 1e-3) if f_keep is not None else 0 * al
    full_rgb = sample_cube(a_rgb, d, size, pad).reshape(Hd, Wd, 3)
    full_al = sample_cube(a_al, d, size, pad).reshape(Hd, Wd)
    pts = eye + d * rng.reshape(-1, 1)
    valid = rng.reshape(-1) > 0
    t0 = time.time()
    seen = seen_counts(gs_seen_all, gs_seen_near, world.cams, pts, valid).reshape(Hd, Wd)
    # below the floor: the mirror image a glossy floor puts under it, not scenery
    under = valid.reshape(Hd, Wd) & (pts[:, 1].reshape(Hd, Wd) < floor - a.under_floor)
    seen = np.where(under, 0, seen)
    say(f"under the floor (mirror world): {float(under[al > 0.5].mean()):.1%} of the far splats' pixels")
    seen = np.where(keepf > 0.5, np.maximum(seen, 9), seen)
    say(f"seen counts from {len(world.cams)} cameras in {time.time() - t0:.1f}s: covered {float((al > 0.5).mean()):.1%}, "
        f"covered and seen by >= 1 camera {float(((al > 0.5) & (seen > 0)).mean()):.1%}")
    # the six Roblox faces at their own size (sharper than resampling the equirect): far splats only
    fs = a.face_out
    fr, fa, _, _ = render_faces(gs_far, eye, fs, 0)
    np.savez_compressed(out / "render.npz", rgb=rgb.astype(np.float16), alpha=al.astype(np.float16), range=rng,
                        seen=seen.astype(np.int16), keep=np.clip(keepf, 0, 1).astype(np.float16),
                        full_rgb=full_rgb.astype(np.float16),
                        full_alpha=full_al.astype(np.float16), face_rgb=fr.astype(np.float16),
                        face_alpha=fa.astype(np.float16), eye=eye, lo=lo, hi=hi)
    W.write_json(out / "render.json", {"world": world.world_file, "digest": world.digest, "eye": eye, "box": [lo, hi],
                                       "margin": a.margin, "farSplats": int(far.sum()), "splats": len(s),
                                       "width": Wd, "height": Hd, "cubeFace": size, "faceOut": fs,
                                       "covered": float((al > 0.5).mean()), "cameras": len(world.cams),
                                       "convention": EQUIRECT_NOTE})
    # previews
    u8 = lambda x: (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)  # noqa: E731
    over_mag = rgb + (1 - al[..., None]) * (MAGENTA / 255.0)
    W.save_jpg(out / "far.jpg", u8(over_mag), 90)
    W.save_jpg(out / "full.jpg", u8(full_rgb + (1 - full_al[..., None]) * (MAGENTA / 255.0)), 90)
    heat = np.zeros((Hd, Wd, 3), np.float32)
    sc = np.clip(seen / 4.0, 0, 1)
    heat[..., 0] = np.where(valid.reshape(Hd, Wd), 1 - sc, 0.15)
    heat[..., 1] = np.where(valid.reshape(Hd, Wd), sc, 0.15)
    heat[..., 2] = 0.15
    W.save_jpg(out / "seen.jpg", u8(0.5 * heat + 0.5 * np.clip(rgb / np.maximum(al[..., None], 1e-3), 0, 1)), 90)
    say(f"wrote {out}/render.npz and previews")
    return 0


# --------------------------------------------------------------------------------------------------------------
# fill
# --------------------------------------------------------------------------------------------------------------


def smoothstep(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def gblur(x: np.ndarray, sigma: float, wrap: bool = True) -> np.ndarray:
    from scipy import ndimage

    if sigma <= 0:
        return x
    mode = ("nearest", "wrap") if wrap else "nearest"
    if x.ndim == 3:
        return np.stack([ndimage.gaussian_filter(x[..., c], sigma, mode=mode) for c in range(x.shape[2])], -1)
    return ndimage.gaussian_filter(x, sigma, mode=mode)


def masks(R: dict, a) -> dict:
    """Effective alpha of the real far content: alpha x (seen by the footage). Far splats no training camera saw
    (blurred trunk tops, a smeared sky shell, glare behind the room's walls) are dropped, softly."""
    al = R["alpha"].astype(np.float32)
    rgb = R["rgb"].astype(np.float32)
    seen = R["seen"].astype(np.float32)
    H, Wd = al.shape
    el = elevation_deg(H)[:, None] * np.ones((1, Wd))
    seenw = np.clip(seen / a.seen_full, 0, 1)
    # no depth where alpha < 0.5: such a pixel (a splat's soft fringe) takes the verdict of the nearest pixels
    # that have one, so a dropped glare blob does not leave its halo behind
    valid = R["range"] > 0
    seenw = np.where(valid, seenw, wrap_push_pull(seenw[..., None].astype(np.float32), valid.astype(np.float32))[..., 0])
    up = smoothstep(a.unseen_from, a.unseen_from + 6.0, el)
    from scipy import ndimage

    # the edge of what the footage saw is the edge of a camera frame, a straight line: softened, so the real far
    # content fades into the painted part instead of stopping along it
    seenw = np.clip(gblur(seenw.astype(np.float32), a.seen_soft), 0, 1)
    un = ndimage.grey_dilation((1 - seenw) * up, size=(3, 3), mode=("nearest", "wrap"))
    U = np.clip(gblur(un, 1.0), 0, 1)
    A = np.clip(al * (1 - U), 0, 1)
    Rp = rgb * (1 - U)[..., None]
    hole = A < 0.5
    return {"A": A, "R": Rp, "U": U, "hole": hole, "el": el}


def best_seam(colour: np.ndarray, el: np.ndarray, region: np.ndarray) -> float:
    """Column where the seam hurts least: the fewest edge pixels of the region to fill with structure next to them
    (trunks, roof edges, lights the model has to continue), smoothed over +-10 degrees."""
    from scipy import ndimage

    edge = region & ~ndimage.binary_erosion(region, iterations=3, border_value=1)
    lum = colour.mean(-1)
    mode = ("nearest", "wrap")
    m = ndimage.uniform_filter(lum, 9, mode=mode)
    std = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, 9, mode=mode) - m * m, 0))
    cost = (edge * (0.02 + std) + 0.002 * region).sum(0)
    w = cost.shape[0]
    cost = ndimage.uniform_filter1d(cost.astype(np.float64), size=max(3, int(w * 20 / 360)), mode="wrap")
    # a column the region never reaches (with a margin) needs no seam pass at all: prefer the middle of the widest
    # run of such columns
    free = ~ndimage.maximum_filter1d(region.any(0), size=65, mode="wrap")
    if free.any() and not free.all():
        d = wrap_edt(np.repeat(free[None, :], 3, 0))[1]
        return float(np.argmax(d))
    return float(np.argmin(cost))


def sky_layer(el: np.ndarray, seed: int = 0) -> np.ndarray:
    """The open night sky: the colour of the sky in the photos (very dark, a little blue), a touch lighter low
    down, dithered so an 8-bit JPEG does not band."""
    top = np.array(SKY_TOP, np.float32) / 255.0
    hor = np.array(SKY_HORIZON, np.float32) / 255.0
    t = smoothstep(0.0, 45.0, el)[..., None]
    c = hor * (1 - t) + top * t
    rng = np.random.default_rng(seed)
    return (c + rng.normal(0, 0.5 / 255.0, c.shape)).astype(np.float32)


def wrap_push_pull(img: np.ndarray, w: np.ndarray) -> np.ndarray:
    from .ceiling import push_pull

    Wd, C = img.shape[1], img.shape[2]
    x = np.repeat(img, 3, 2) if C == 1 else img  # cv2's pyramid drops a single channel axis
    t = push_pull(np.concatenate([x, x, x], 1).astype(np.float32), np.concatenate([w, w, w], 1))
    return t[:, Wd:2 * Wd, :C]


def wrap_edt(mask: np.ndarray) -> np.ndarray:
    """Distance (px) to the nearest False pixel of `mask`, wrapping in azimuth."""
    from scipy import ndimage

    Wd = mask.shape[1]
    t = ndimage.distance_transform_edt(np.concatenate([mask, mask, mask], 1))
    return t[:, Wd:2 * Wd]


def magenta_left(img: np.ndarray) -> np.ndarray:
    """Pixels that still look like the magenta marker, or a dark or pale fringe of it."""
    a = img * 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r - g > 35) & (b - g > 35) & (np.abs(r - b) < 0.45 * np.maximum(r, b))


def correct(gen: np.ndarray, ref: np.ndarray, region: np.ndarray, decay: float, clip: float = 0.03) -> np.ndarray:
    """Removes the colour step where generated pixels meet given ones: the difference on a thin ring outside
    `region` is spread into it (push-pull) and faded with the distance from its edge, so the joins vanish while the
    inside keeps the generated colours."""
    ringm = (wrap_edt(~region) > 0) & (wrap_edt(~region) <= 6)  # outside, within 6 px
    # clipped: next to a lamp or a lit trunk the editor's copy differs a lot, and spreading that would haze the sky
    diff = np.where(ringm[..., None], np.clip(ref - gen, -clip, clip), 0).astype(np.float32)
    field = wrap_push_pull(diff, ringm.astype(np.float32))
    w = np.exp(-wrap_edt(region) / decay)[..., None]
    return np.where(region[..., None], gen + field * w, gen).astype(np.float32)


def edit_call(client, img_u8: np.ndarray, work: Path, tag: str, prompt: str, gen_w: int, steps: int, seed: int,
              cfg: float, refs: list[str] | None = None, reuse: bool = False) -> np.ndarray:
    from PIL import Image

    import hashlib

    src = work / f"{tag}-in.png"
    dst = work / f"{tag}-gen.png"
    h, w = img_u8.shape[:2]
    gen_h = int(round(gen_w * h / w / 16)) * 16
    key = hashlib.sha1(img_u8.tobytes() + f"{prompt}|{NEGATIVE}|{steps}|{cfg}|{seed}|{gen_w}x{gen_h}|{refs}".encode()).hexdigest()
    keyf = work / f"{tag}.key"
    if dst.exists() and keyf.exists() and keyf.read_text() == key:
        say(f"  edit {tag}: reusing {dst.name} (same input, prompt and seed)")
    elif dst.exists() and reuse:
        say(f"  edit {tag}: reusing {dst.name} (--reuse; the input differs from the one it was made from "
            f"by {float(np.abs(np.asarray(__import__('PIL.Image').Image.open(src).convert('RGB'), np.int16) - img_u8).mean()):.2f} levels)"
            if src.exists() else f"  edit {tag}: reusing {dst.name} (--reuse)")
    else:
        W.save_png(src, img_u8)
        t0 = time.time()
        res = client.call("edit", image=str(src), prompt=prompt, negative=NEGATIVE, steps=steps, cfg=cfg, seed=seed,
                          width=gen_w, height=gen_h, out=str(dst), timeout=1200, refs=refs or None)
        keyf.write_text(key)
        say(f"  edit {tag}: {gen_w}x{gen_h}, {res.get('seconds')}s (wall {time.time() - t0:.0f}s)")
    g = Image.open(dst).convert("RGB").resize((w, h), Image.LANCZOS)
    return np.asarray(g).astype(np.float32) / 255.0


def zenith_smooth(img: np.ndarray, start: float = 55.0, full: float = 84.0) -> np.ndarray:
    """Near the pole an equirect row is one small circle: blur each row along the azimuth by 1/cos(elevation) (so
    the blur is the same angle on the sphere) and blend into the row mean at the top, so nothing pinches."""
    from scipy import ndimage

    out = img.copy()
    H = img.shape[0]
    e = elevation_deg(H)
    for j in range(H):
        if e[j] <= start:
            continue
        sig = min(6.0 / max(math.cos(math.radians(e[j])), 1e-3), img.shape[1] / 4)
        row = np.stack([ndimage.gaussian_filter1d(img[j, :, c], sig, mode="wrap") for c in range(3)], -1)
        t = float(smoothstep(start, full, e[j]))
        blur_w = min(1.0, (e[j] - start) / 8.0)
        row = img[j] * (1 - blur_w) + row * blur_w
        out[j] = row * (1 - t) + img[j].mean(0, keepdims=True) * t
    return out


def cmd_fill(a) -> int:
    from scipy import ndimage

    from .models import Client

    out = Path(a.out)
    work = out / "fill"
    work.mkdir(parents=True, exist_ok=True)
    R = dict(np.load(out / "render.npz"))
    M = masks(R, a)
    A, Rp, hole, el = M["A"], M["R"], M["hole"], M["el"]
    H, Wd = A.shape
    # small isolated bits above the horizon (glare blobs, floaters) are not scenery: drop them
    # far below the horizon the floor (viewer) or the floor mesh (Roblox) always covers the backdrop: real bits
    # there (glare on a path) only make the panorama look broken, so the ground prior takes over
    low = smoothstep(a.ground_deg + 7.0, a.ground_deg + 13.0, el)
    A = A * low
    Rp = Rp * low[..., None]
    real0 = A > 0.5
    lab, n = ndimage.label(np.concatenate([real0, real0], 1))
    lab = lab[:, :Wd]  # components wrap across the seam through the doubled copy
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    kept0 = (R["keep"].astype(np.float32) > 0.5) if "keep" in R else np.zeros_like(real0)
    small = (sizes[lab] < a.min_blob) & real0 & ~kept0
    if small.any():
        A = np.where(small, 0.0, A)
        Rp = np.where(small[..., None], 0.0, Rp)
        hole = A < 0.5
    # what is left of the far splats is kept only on and right around substantial real content: faint isolated
    # floaters (alpha < 0.5, so in no component) would otherwise stay as ghosts over the painted sky
    sub = ndimage.binary_dilation(A > 0.5, iterations=6)
    sub = np.clip(gblur(sub.astype(np.float32), 2.0), 0, 1)
    A = A * sub
    Rp = Rp * sub[..., None]
    hole = A < 0.5
    real = A > 0.5
    # generated palms kept whole (genfill.palms crowns beyond the box) are complete: nothing grows out of them
    kept = (R["keep"].astype(np.float32) > 0.5) if "keep" in R else np.zeros_like(real)
    seed = real & ~kept
    colour = np.clip(Rp / np.maximum(A, 1e-3)[..., None], 0, 1)
    # what is given: the real far content, the open sky (photo colour) above the horizon, a smooth ground below
    sky = sky_layer(el, a.seed)
    gmask = real & (el < 3.0)
    ground = wrap_push_pull(colour, gmask.astype(np.float32))
    gd = wrap_edt(~gmask)  # px from real ground: far from it the ground is unlit, dark grass and paving at night
    tg = np.exp(-gd / a.ground_fade)[..., None]
    ground = (ground * tg + (np.array(GROUND_DARK, np.float32) / 255.0) * (1 - tg)).astype(np.float32)
    gs = smoothstep(-1.5, 1.5, el)[..., None]
    prior = (ground * (1 - gs) + sky * gs).astype(np.float32)
    base = np.where(real[..., None], colour, prior)
    # what the model paints: a band over the real skyline, where trunks, tree tops, roofs and lights run into the
    # gap; the rest of the sky stays the photos' sky. Per column the skyline is the highest real pixel, spread
    # sideways so crowns and roofs have room. The band reaches from the horizon to band_px above the skyline (the
    # gaps beside and between real content are painted too); toward the ends of the skyline it sinks to a sliver
    # at the horizon, so a building or a tree line ends the way it would and not along a vertical cut; its upper
    # edge is smoothed, since a blocky magenta outline reads as a building and the editor fills it with towers
    top = np.where(seed.any(0), seed.argmax(0), H)
    top = ndimage.minimum_filter1d(top, size=int(a.spread_px) * 2 + 1, mode="wrap")
    has = (top < H).astype(np.float64)
    hor = float(np.searchsorted(-elevation_deg(H), 2.0))  # row of el = -2 deg
    ends = wrap_edt(np.repeat((top < H)[None, :], 3, 0))[1]
    taper = np.clip(ends / a.taper_px, 0, 1)
    taper = taper * taper * (3 - 2 * taper)
    full = np.minimum(top.astype(np.float64) - a.band_px, hor)
    edge = hor - (hor - full) * taper
    sig = max(1.0, a.band_px / 3.0)
    num = ndimage.gaussian_filter1d(edge * has, sig, mode="wrap")
    den = ndimage.gaussian_filter1d(has, sig, mode="wrap")
    edge = np.where(has > 0, num / np.maximum(den, 1e-6), H)
    rr = np.arange(H)[:, None]
    above = (rr >= edge[None, :]) & (rr <= hor) & (has[None, :] > 0)
    near = wrap_edt(~seed) <= a.near_px
    region = hole & ((above & (el > -2.0)) | (near & (el > -10.0)) | (np.abs(el) < a.horizon_band))
    # not on or right next to a kept crown (the editor would redraw it): the sky prior goes there
    if kept.any():
        region &= wrap_edt(~kept) > 12
    rows = int(np.searchsorted(-elevation_deg(H), -a.ground_deg))
    region[rows:] = False
    seam = int(round(azimuth_col(a.seam_az, Wd) if a.seam_az is not None else best_seam(colour, el, region))) % Wd
    shift = (-seam) % Wd  # roll so the cheapest seam column lands on the image edge
    say(f"gap {float(hole.mean()):.1%} of the sphere; model region {float(region.mean()):.1%}; unseen dropped "
        f"{float((M['U'][R['alpha'] > 0.5] > 0.5).mean()):.1%} of the far splats' pixels; seam at column {seam} (azimuth {(seam / Wd - 0.5) * 360:.0f} deg)")
    client = Client(a.queue, timeout=1500)
    if not client.wait_ready(["edit"], timeout=1500):
        raise SystemExit("sky: the model worker did not load the editor")

    def roll(x, n):
        return np.roll(x, n, axis=1)

    u8 = lambda x: (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)  # noqa: E731
    inp = u8(base)
    inp[ndimage.binary_dilation(region, iterations=3)] = MAGENTA  # the editor's pink halo falls outside the region
    prompt = SKY_PROMPT.format(scene=a.scene_text) + (REF_LINE if a.ref else "")
    refs = [str(Path(r)) for r in a.ref] if a.ref else None
    gens, left = [], []
    for i in range(a.candidates):
        g = roll(edit_call(client, roll(inp, shift)[:rows], work, f"pass1-s{a.seed + i}", prompt, a.gen_width,
                           a.steps, a.seed + i, a.cfg, refs, a.reuse), -shift)
        full = base.copy()
        full[:rows] = g
        lm = magenta_left(full) & region
        left.append(float(lm.sum() / max(region.sum(), 1)))
        gens.append(full)
        say(f"  candidate {i}: magenta left {left[-1]:.2%}")
    pick = int(a.pick) if a.pick is not None else int(np.argmin(left))
    G = gens[pick]
    lm = ndimage.binary_dilation(magenta_left(G), iterations=2) & region
    if lm.any():  # magenta the editor left: filled from the generated pixels around it
        G[lm] = wrap_push_pull(G, (~lm).astype(np.float32))[lm]
    # stray lights in open sky (a moon, a star the editor slipped in despite the prompt): small bright blobs well
    # above the horizon and away from real content go back to the sky
    lum = G.mean(-1)
    bright = region & (lum > 0.35) & (el > 8.0) & (wrap_edt(~real) > 30)
    blab, nb = ndimage.label(ndimage.binary_dilation(bright, iterations=2))
    if nb:
        bs = np.bincount(blab.ravel(), minlength=nb + 1)
        # ... and only where what surrounds them is sky (the lit windows of a painted building are not strays)
        dark = (~ndimage.binary_dilation(bright, iterations=3)).astype(np.float32)
        mode = ("nearest", "wrap")
        bg = ndimage.uniform_filter(lum * dark, 41, mode=mode) / np.maximum(ndimage.uniform_filter(dark, 41, mode=mode), 1e-3)
        bgm = np.bincount(blab.ravel(), weights=bg.ravel(), minlength=nb + 1) / np.maximum(bs, 1)
        stray = (blab > 0) & (bs[blab] < a.stray_px) & (bgm[blab] < 0.07)
        stray = ndimage.binary_dilation(stray, iterations=4) & region
        G[stray] = prior[stray]
        say(f"  stray lights removed from the sky: {int(stray.sum())} px")
    G = correct(G, base, region, a.decay)
    # lift anything darker than the night sky to it (the editor's sky is pure black)
    G = np.where((el > 0)[..., None], G + np.maximum(sky - G, 0) * 0.9, G)
    # the editor's content fades into the prior over a few pixels outside the region (its trees do not stop at the
    # region's edge, and a hard cut there would draw the band's outline into the sky)
    soft = np.clip(2.0 * gblur(region.astype(np.float32), a.feather), 0, 1)[..., None]
    F = np.where(region[..., None], G, G * soft + prior * (1 - soft))
    if kept.any():
        # the ring kept clear around a kept crown would show the prior's sky through its fronds as a dark halo
        # where the painted band lies behind it: it takes the colours of the band around it instead
        ring = hole & ~region & (wrap_edt(~kept) <= 14) & ndimage.binary_dilation(region, iterations=16)
        if ring.any():
            F[ring] = wrap_push_pull(F, region.astype(np.float32))[ring]
    comp = Rp + (1 - A)[..., None] * F
    # pass 2: the seam rolled to the middle, a band across it painted again with both sides as context
    half = int(a.seam_band)
    s2 = (Wd // 2 - seam) % Wd
    reg_r = roll(region, s2)
    band = np.zeros((H, Wd), bool)
    band[:, Wd // 2 - half: Wd // 2 + half] = True
    band2 = band & reg_r
    fit2 = None
    if band2.sum() > 50:  # (the seam is put where the region does not reach whenever there is such a place)
        comp_r = roll(comp, s2)
        inp2 = u8(comp_r)
        inp2[ndimage.binary_dilation(band2, iterations=3)] = MAGENTA
        cw = min(Wd, int(a.seam_crop))
        c0 = Wd // 2 - cw // 2
        g2 = edit_call(client, inp2[:rows, c0:c0 + cw], work, f"pass2-s{a.seed}", SEAM_PROMPT.format(scene=a.scene_text),
                       cw // 16 * 16, a.steps, a.seed + 100, a.cfg)
        G2 = comp_r.copy()
        G2[:rows, c0:c0 + cw] = g2
        lm2 = magenta_left(G2) & band2
        G2[lm2] = roll(F, s2)[lm2]
        G2 = correct(G2, comp_r, band2, a.decay)
        G2 = np.where((el > 0)[..., None], G2 + np.maximum(sky - G2, 0) * 0.9, G2)
        x = np.abs(np.arange(Wd) - Wd / 2 + 0.5)
        wband = (1 - smoothstep(half * 0.45, half * 0.95, x))[None, :] * np.clip(gblur(band2.astype(np.float32), 1.5), 0, 1)
        F_r = roll(F, s2)
        F_r = F_r * (1 - wband[..., None]) + G2 * wband[..., None]
        F = roll(F_r, -s2)
        fit2 = {"band": int(band2.sum()), "magentaLeft": float(lm2.sum() / band2.sum())}
        W.save_jpg(out / "pass2-input.jpg", inp2, 90)
    mg = magenta_left(F) & (1 - A > 0.2)
    if mg.any():
        mg = ndimage.binary_dilation(mg, iterations=2)
        F[mg] = wrap_push_pull(F, (~mg).astype(np.float32))[mg]
    say(f"  magenta-like pixels filled from around them: {int(mg.sum())}")
    final = np.clip(Rp + (1 - A)[..., None] * F, 0, 1)
    final = zenith_smooth(final, start=70.0, full=86.0)
    # how much of each far splat pixel survived (unseen, small blobs, far below the horizon, isolated floaters):
    # the faces apply the same to their own sharper renders
    keep = np.clip(A / np.maximum(R["alpha"].astype(np.float32), 1e-3), 0, 1)
    keep = np.where(R["alpha"].astype(np.float32) > 1e-3, keep, 0.0)
    np.savez_compressed(out / "fill.npz", fill=F.astype(np.float16), final=final.astype(np.float16),
                        A=A.astype(np.float16), U=M["U"].astype(np.float16), keep=keep.astype(np.float16),
                        region=region)
    W.save_jpg(out / "pass1-input.jpg", roll(inp, shift), 90)
    for i, g in enumerate(gens):
        W.save_jpg(out / f"pass1-gen{i}.jpg", u8(roll(g, shift)), 90)
    W.save_jpg(out / "final-equirect.jpg", u8(final), 92)
    W.write_json(out / "fill.json", {"hole": float(hole.mean()), "region": float(region.mean()),
                                     "unseenDropped": float((M["U"][R["alpha"] > 0.5] > 0.5).mean()), "seamColumn": seam,
                                     "seamAzimuthDeg": (seam / Wd - 0.5) * 360, "roll": shift, "rows": rows,
                                     "groundDeg": a.ground_deg, "bandPx": a.band_px, "spreadPx": a.spread_px, "nearPx": a.near_px,
                                     "horizonBand": a.horizon_band, "minBlob": a.min_blob,
                                     "magentaLeft": left, "pick": pick, "seamPass": fit2, "prompt": prompt,
                                     "seamPrompt": SEAM_PROMPT.format(scene=a.scene_text), "negative": NEGATIVE,
                                     "steps": a.steps, "cfg": a.cfg, "seed": a.seed, "genWidth": a.gen_width, "refs": a.ref,
                                     "sky": {"top": SKY_TOP, "horizon": SKY_HORIZON}})
    say(f"wrote {out}/final-equirect.jpg (candidate {pick})")
    return 0


# --------------------------------------------------------------------------------------------------------------
# faces
# --------------------------------------------------------------------------------------------------------------


# The night floor of pipeline/backdrop.py (night_floor: SKY_FLOOR_ZENITH, _FROM, _FULL), so the viewer's sky keeps the
# tone it already has: no pixel darker than a dark blue-grey that ramps in from 5 to 35 degrees of elevation (the
# horizon keeps the photos' own colours). Pure photo colours (~(9, 11, 13)) read as a void in the headset.
NIGHT_FLOOR = (18.0, 22.0, 29.0)
NIGHT_FLOOR_FROM, NIGHT_FLOOR_FULL = 5.0, 35.0


def night_floor(el: np.ndarray) -> np.ndarray:
    t = smoothstep(NIGHT_FLOOR_FROM, NIGHT_FLOOR_FULL, el)
    return (t[..., None] * (np.array(NIGHT_FLOOR, np.float32) / 255.0)).astype(np.float32)


def cmd_faces(a) -> int:
    from PIL import Image

    out = Path(a.out)
    R = dict(np.load(out / "render.npz"))
    F = dict(np.load(out / "fill.npz"))
    final = F["final"].astype(np.float32)
    G = F["fill"].astype(np.float32)
    K = F["keep"].astype(np.float32) if "keep" in F else 1 - F["U"].astype(np.float32)
    H, Wd = final.shape[:2]
    floor_on = a.night_floor != "off"
    if floor_on:
        final = np.maximum(final, night_floor(elevation_deg(H)[:, None] * np.ones((1, Wd))))
    # the equirect for the viewer
    eq = (np.clip(final, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(eq).save(out / "backdrop-sky.jpg", quality=a.jpeg_quality, optimize=True, progressive=True)
    # faces: the far splats rendered at face size where they are real and seen, the fill elsewhere
    fs = R["face_rgb"].shape[1]
    dirs = face_dirs(fs)
    fr = R["face_rgb"].astype(np.float32)
    fa = R["face_alpha"].astype(np.float32)[..., 0]
    names = list(FACES)
    stats = {}
    for i, n in enumerate(names):
        d = dirs[i].reshape(-1, 3)
        g = sample_equirect(G, d).reshape(fs, fs, 3)
        k = np.clip(sample_equirect(K[..., None], d).reshape(fs, fs), 0, 1)
        fin = sample_equirect(final, d).reshape(fs, fs, 3)
        A = fa[i] * k
        img = fr[i] * k[..., None] + (1 - A)[..., None] * g
        # where the equirect was smoothed at the pole, follow it
        el = np.degrees(np.arcsin(np.clip(d[:, 1], -1, 1))).reshape(fs, fs)
        t = smoothstep(70.0, 86.0, el)[..., None]
        img = img * (1 - t) + fin * t
        if floor_on:
            img = np.maximum(img, night_floor(el))
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out / f"sky-v3-{n}.png", optimize=True)
        stats[n] = {"realShare": round(float((A > 0.5).mean()), 3)}
    W.write_json(out / "faces.json", {"faces": {n: f"sky-v3-{n}.png" for n in names}, "size": fs, "stats": stats,
                                      "convention": "Roblox Sky (pipeline/roblox_mesh.py SKY_FACES)",
                                      "equirect": "backdrop-sky.jpg", "equirectConvention": EQUIRECT_NOTE,
                                      "nightFloor": {"zenith": NIGHT_FLOOR, "fromDeg": NIGHT_FLOOR_FROM,
                                                     "fullDeg": NIGHT_FLOOR_FULL} if floor_on else None})
    say(f"faces: {stats}")
    return 0


# --------------------------------------------------------------------------------------------------------------
# check: viewer-like views (splats over the backdrop)
# --------------------------------------------------------------------------------------------------------------


def look_c2w(pos, az_deg: float, pitch_deg: float) -> np.ndarray:
    """OpenGL c2w looking along three.js azimuth az (atan2(z, x)) and pitch."""
    az, p = math.radians(az_deg), math.radians(pitch_deg)
    f = np.array([math.cos(p) * math.cos(az), math.sin(p), math.cos(p) * math.sin(az)])
    upw = np.array([0.0, 1.0, 0.0]) if abs(f[1]) < 0.99 else np.array([math.cos(az), 0.0, math.sin(az)])
    r = np.cross(f, upw)
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = r, u, -f, pos
    return m


def cmd_check(a) -> int:
    from .geom import intrinsics
    from .gpu import GS, render

    out = Path(a.out)
    world = W.load(a.scene_dir, a.world)
    gs = GS(world.splats)
    from PIL import Image

    back = np.asarray(Image.open(out / "backdrop-sky.jpg").convert("RGB"), np.float32) / 255.0
    views = json.loads(a.views) if a.views else DEFAULT_VIEWS
    k = intrinsics(960, 640, a.hfov)
    c = np.stack(np.meshgrid((np.arange(960) + 0.5 - k.cx) / k.fx, -(np.arange(640) + 0.5 - k.cy) / k.fy), -1)
    tiles = []
    for v in views:
        c2w = look_c2w(np.array(v["pos"], np.float64), v["az"], v["pitch"])
        r = render(gs, c2w, k)
        rgb = r["rgb"].cpu().numpy()
        al = r["alpha"].cpu().numpy()[..., None]
        d = np.concatenate([c, -np.ones((640, 960, 1))], -1) @ c2w[:3, :3].T
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        bg = sample_equirect(back, d.reshape(-1, 3)).reshape(640, 960, 3)
        before = rgb  # over black: the void the viewer shows today where no splat is
        after = rgb + (1 - al) * bg
        u8 = lambda x: (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)  # noqa: E731
        tiles.append(W.label(u8(before), f"{v['name']}: before (splats only)"))
        tiles.append(W.label(u8(after), f"{v['name']}: after (splats over backdrop), backdrop shows {float((1 - al).mean()):.0%}"))
    W.save_jpg(out / "check.jpg", W.sheet(tiles, 2), 88)
    say(f"wrote {out}/check.jpg ({len(views)} views)")
    return 0


DEFAULT_VIEWS = [
    {"name": "spawn, toward the lawn (+Z), up 35", "pos": [0, 1.6, 0], "az": 90, "pitch": 35},
    {"name": "spawn, toward -X, up 35", "pos": [0, 1.6, 0], "az": 180, "pitch": 35},
    {"name": "lawn (-3.1,-0.7), up 60 toward -X", "pos": [-3.06, 1.6, -0.67], "az": 180, "pitch": 60},
    {"name": "lawn (-3.1,-0.7), up 60 toward +Z", "pos": [-3.06, 1.6, -0.67], "az": 90, "pitch": 60},
    {"name": "lawn (-3.1,-0.7), straight up", "pos": [-3.06, 1.6, -0.67], "az": 135, "pitch": 89},
    {"name": "lawn (-3.1,-0.7), level toward +Z", "pos": [-3.06, 1.6, -0.67], "az": 90, "pitch": 10},
    {"name": "lawn edge (-5.5,1.5), toward -X up 20", "pos": [-5.5, 1.6, 1.5], "az": 170, "pitch": 20},
    {"name": "spawn, toward +X (patio side) up 25", "pos": [0, 1.6, 0], "az": 20, "pitch": 25},
]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("--scene-dir", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--world", default=None)
    r.add_argument("--eye-height", type=float, default=1.6)
    r.add_argument("--margin", type=float, default=1.5)
    r.add_argument("--width", type=int, default=2048)
    r.add_argument("--face", type=int, default=1024, help="cube face size the equirect is resampled from")
    r.add_argument("--face-out", type=int, default=1024, help="Roblox face size")
    r.add_argument("--under-floor", type=float, default=0.4, help="far points this far below the floor are mirror images")
    r.add_argument("--palms", default=None, help="JSON {originalUpTo, generatedFrom, palms: [{trunk: {x, z}}]}: the "
                   "splats before originalUpTo are the trained ones, those from generatedFrom genfill.palms crowns")
    f = sub.add_parser("fill")
    f.add_argument("--out", required=True)
    f.add_argument("--queue", required=True)
    f.add_argument("--scene-text", default=SCENE_TEXT)
    f.add_argument("--steps", type=int, default=32)
    f.add_argument("--cfg", type=float, default=4.0)
    f.add_argument("--seed", type=int, default=0)
    f.add_argument("--candidates", type=int, default=1)
    f.add_argument("--ref", action="append", default=None, help="a real photo of the place the editor sees as image 2")
    f.add_argument("--pick", type=int, default=None)
    f.add_argument("--reuse", action="store_true", help="use the edits already in <out>/fill whatever their input")
    f.add_argument("--gen-width", type=int, default=2048)
    f.add_argument("--ground-deg", type=float, default=-25.0, help="the model sees the panorama down to here")
    f.add_argument("--seen-full", type=float, default=2.0, help="cameras for a point to count as fully seen")
    f.add_argument("--seen-soft", type=float, default=8.0, help="px (sigma) the seen/unseen edge is softened over")
    f.add_argument("--unseen-from", type=float, default=-30.0, help="unseen far content is dropped above this elevation")
    f.add_argument("--band-px", type=int, default=170, help="the model paints this far above the skyline")
    f.add_argument("--spread-px", type=int, default=80, help="... the skyline spread sideways by this much")
    f.add_argument("--near-px", type=float, default=24.0, help="... and this close to any real content")
    f.add_argument("--horizon-band", type=float, default=0.0, help="... and within this many degrees of the horizon "
                   "(0: only next to real content; elsewhere the sky meets the dark ground)")
    f.add_argument("--taper-px", type=float, default=160.0, help="the band tapers to nothing over this many px at "
                   "the ends of the skyline")
    f.add_argument("--stray-px", type=int, default=600, help="bright blobs in open sky smaller than this go")
    f.add_argument("--min-blob", type=int, default=6000, help="real bits above the horizon smaller than this (px) "
                   "are dropped")
    f.add_argument("--feather", type=float, default=5.0, help="px (sigma) the fill fades over outside its region")
    f.add_argument("--decay", type=float, default=35.0, help="px over which the colour join correction fades")
    f.add_argument("--ground-fade", type=float, default=90.0, help="px over which the ground prior darkens away "
                   "from real ground")
    f.add_argument("--seam-band", type=int, default=128, help="half width (px) of the band refilled across the seam")
    f.add_argument("--seam-crop", type=int, default=1024)
    f.add_argument("--seam-az", type=float, default=None, help="put the seam at this azimuth (deg, atan2(z, x))")
    g = sub.add_parser("faces")
    g.add_argument("--out", required=True)
    g.add_argument("--jpeg-quality", type=int, default=90)
    g.add_argument("--night-floor", default="on", choices=["on", "off"], help="pipeline/backdrop.py's night floor")
    c = sub.add_parser("check")
    c.add_argument("--scene-dir", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--world", default=None)
    c.add_argument("--views", default=None)
    c.add_argument("--hfov", type=float, default=90.0)
    a = ap.parse_args(argv)
    return {"render": cmd_render, "fill": cmd_fill, "faces": cmd_faces, "check": cmd_check}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
