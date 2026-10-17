"""Step 7b (GPU): a generated view of a person from directly behind, for the back texels the video never saw.

    python -m pipeline.avatar.backview --work WORK --person 0 [--seeds 0,1] [--force]

1. The most frontal frame where the person is fully in frame and at least 90% unoccluded (the network's own body
   for that frame; the other people's pixels are blanked out of the crop).
2. Its crop on a white background, 1024 x 1024, into Qwen-Image-Edit-2511 (diffusers QwenImageEditPlusPipeline,
   bfloat16): "the same person seen from directly behind, same pose, same clothes, same hair, full body, plain
   white background, photo"; 40 steps, true_cfg_scale 4, one image per seed.
3. The virtual camera is the recording camera turned 180 degrees about the vertical through the pelvis: the body
   is rendered from there, and each generated image's person mask (non-white pixels) is fitted to that silhouette
   with a 2D similarity (scale + shift, searched for the best IoU). The seed whose mask fits best wins.
4. Every covered texel visible from the virtual camera with cos > 0.5 on the torso, head and upper legs takes the
   generated colour; fill.py writes it only where the video left the texel unseen.

Writes WORK/back-<k>.npz (colour, valid over the covered texels) and WORK/evidence/back-<k>-*.jpg.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar import body, raster
from pipeline.avatar.body import Asset
from pipeline.avatar.ground import camera_track
from pipeline.avatar.texture import REGIONS, bilinear, front_sign, texel_map, texel_points, texel_regions
from pipeline.avatar.util import log, read_json

PROMPT = "the same person seen from directly behind, same pose, same clothes, same hair, full body, plain white background, photo"


def axis_rotation(axis: np.ndarray, angle: float) -> np.ndarray:
    a = axis / np.linalg.norm(axis)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * K @ K


def bodies_in_frame(assets: list[Asset], tracks, hmr, frame: int) -> dict[int, np.ndarray]:
    """Person index -> the network's posed vertices (cv camera) in that frame, for everyone detected there."""
    out = {}
    for j, a in enumerate(assets):
        fr = tracks[f"person-{j}/frames"]
        i = np.nonzero(fr == frame)[0]
        if len(i) and tracks[f"person-{j}/det"][i[0]] >= 0:
            out[j] = hmr["v3d"][tracks[f"person-{j}/det"][i[0]]].astype(np.float64)[a.src_vertex]
    return out


def visibility(assets: list[Asset], bodies: dict[int, np.ndarray], k: int, K: np.ndarray, W: int, H: int,
               scale: float = 0.25):
    """Fraction of person k's own silhouette not hidden by anyone else, and the full-scale mesh-id map."""
    ks = sorted(bodies)
    r = raster.DepthRenderer(K, W, H, scale=scale)
    _, mesh_id, _, _ = r.render([(bodies[j], assets[j].tris) for j in ks])
    own = raster.silhouette(bodies[k], assets[k].tris, K, (r.h, r.w), scale=scale)
    vis = np.count_nonzero(mesh_id == ks.index(k)) / max(1, np.count_nonzero(own))
    return vis, mesh_id, ks


def pick_frame(work: Path, asset: Asset, tracks, hmr, k: int, poses_doc: dict, assets: list[Asset] | None = None) -> dict:
    """Most frontal, sharp, in-frame and unoccluded detection of person k."""
    import cv2

    K = hmr["K"]
    W, H = int(poses_doc["intrinsics"]["width"]), int(poses_doc["intrinsics"]["height"])
    cams = camera_track(poses_doc)
    pre = f"person-{k}/"
    fs = front_sign(asset)
    best = None
    for n, (f, d, ok) in enumerate(zip(tracks[pre + "frames"], tracks[pre + "det"], tracks[pre + "valid"])):
        if d < 0 or not ok or n % 2:
            continue
        V = hmr["v3d"][d].astype(np.float64)[asset.src_vertex]
        uv = raster.project(K, V)
        inside = float(((uv[:, 0] > 5) & (uv[:, 0] < W - 5) & (uv[:, 1] > 5) & (uv[:, 1] < H - 5)).mean())
        if inside < 0.98:
            continue
        # body front in the camera: the root's rotation applied to the model's front axis
        Rroot = hmr["bone_poses"][d][0, :3, :3].astype(np.float64)
        front_c = Rroot @ np.array([0.0, fs, 0.0])
        pel = hmr["transl_pelvis"][d].astype(np.float64)
        cos = float(front_c @ (-pel / np.linalg.norm(pel)))
        hpx = float(uv[:, 1].max() - uv[:, 1].min())
        score = cos * min(1.0, hpx / (0.6 * H))
        if best is not None and score <= best["score"]:
            continue
        vis = 1.0
        if assets is not None:
            vis = visibility(assets, bodies_in_frame(assets, tracks, hmr, int(f)), k, K, W, H)[0]
            if vis < 0.9:
                continue
        best = {"frame": int(f), "det": int(d), "score": score, "cos": cos, "heightPx": hpx, "n": n, "visible": vis}
    if best is None:
        raise RuntimeError(f"no fully visible frame of person {k}")
    img = cv2.imread(str(work / "frames" / f"f{best['frame']:06d}.jpg"))[:, :, ::-1]
    sharp = cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32), cv2.CV_32F).var()
    best["sharpness"] = float(sharp)
    best["T_view_cv"] = cams[best["frame"]]
    return best


def person_crop(work: Path, asset: Asset, hmr, sel: dict, size: int = 1024, margin: float = 0.08,
                other: np.ndarray | None = None):
    """The person on white, size x size, plus the crop geometry. `other`: pixels where someone else is in front."""
    import cv2

    K = hmr["K"]
    img = cv2.imread(str(work / "frames" / f"f{sel['frame']:06d}.jpg"))[:, :, ::-1]
    H, W = img.shape[:2]
    mk = cv2.imread(str(work / "masks" / f"f{sel['frame']:06d}.png"), cv2.IMREAD_GRAYSCALE)
    mk = cv2.resize((mk > 127).astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST) > 0
    V = hmr["v3d"][sel["det"]].astype(np.float64)[asset.src_vertex]
    S = raster.silhouette(V, asset.tris, K, (H, W))
    near = cv2.dilate(S.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41))) > 0
    person = mk & near
    if other is not None:
        person &= ~other
    ys, xs = np.nonzero(person | S)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * margin))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    canvas = np.full((side, side, 3), 255, np.uint8)
    src = np.where(person[..., None], img, 255).astype(np.uint8)
    sx0, sy0 = cx - side // 2, cy - side // 2
    a0, b0 = max(0, sx0), max(0, sy0)
    a1, b1 = min(W, sx0 + side), min(H, sy0 + side)
    canvas[b0 - sy0:b1 - sy0, a0 - sx0:a1 - sx0] = src[b0:b1, a0:a1]
    out = cv2.resize(canvas, (size, size), interpolation=cv2.INTER_AREA)
    return out, {"origin": (sx0, sy0), "side": side}


def generate(crop: np.ndarray, seeds: list[int], steps: int = 40, cfg: float = 4.0) -> list[np.ndarray]:
    import torch
    from diffusers import QwenImageEditPlusPipeline
    from PIL import Image

    t0 = time.time()
    pipe = QwenImageEditPlusPipeline.from_pretrained(paths.QWEN_EDIT_REPO, torch_dtype=torch.bfloat16).to("cuda")
    pipe.set_progress_bar_config(disable=True)
    log("backview", f"Qwen-Image-Edit-2511 loaded in {time.time() - t0:.0f} s")
    outs = []
    for s in seeds:
        t1 = time.time()
        with torch.inference_mode():
            r = pipe(image=[Image.fromarray(crop)], prompt=PROMPT, negative_prompt=" ", true_cfg_scale=cfg,
                     num_inference_steps=steps, guidance_scale=1.0, num_images_per_prompt=1,
                     generator=torch.Generator(device="cuda").manual_seed(s))
        outs.append(np.asarray(r.images[0].convert("RGB")))
        log("backview", f"seed {s}: {outs[-1].shape} in {time.time() - t1:.0f} s")
    del pipe
    torch.cuda.empty_cache()
    return outs


def white_mask(img: np.ndarray, thresh: float = 28.0) -> np.ndarray:
    import cv2

    d = np.linalg.norm(255.0 - img.astype(np.float32), axis=-1)
    m = (d > thresh).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        return m > 0
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == big


def fit_similarity(gen_mask: np.ndarray, target: np.ndarray) -> tuple[float, float, float, float]:
    """(scale, tx, ty, iou) mapping generated-image pixels to target pixels: x_t = s * x_g + t."""
    import cv2

    gy, gx = np.nonzero(gen_mask)
    ty, tx = np.nonzero(target)
    s0 = (ty.max() - ty.min() + 1) / max(gy.max() - gy.min() + 1, 1)
    best = (0.0, s0, 0.0, 0.0)
    Ht, Wt = target.shape
    g8 = gen_mask.astype(np.uint8)
    for ds in np.linspace(0.9, 1.1, 9):
        s = s0 * ds
        t0x = (tx.min() + tx.max()) / 2 - s * (gx.min() + gx.max()) / 2
        t0y = (ty.min() + ty.max()) / 2 - s * (gy.min() + gy.max()) / 2
        for dx in np.linspace(-0.05, 0.05, 5) * (tx.max() - tx.min()):
            for dy in np.linspace(-0.04, 0.04, 5) * (ty.max() - ty.min()):
                M = np.array([[s, 0, t0x + dx], [0, s, t0y + dy]], np.float32)
                w = cv2.warpAffine(g8, M, (Wt, Ht), flags=cv2.INTER_NEAREST) > 0
                iou = raster.iou(w, target)
                if iou > best[0]:
                    best = (iou, s, t0x + dx, t0y + dy)
    return best[1], best[2], best[3], best[0]


def back_for_person(work: Path, assets: list[Asset], tracks, k: int, size: int = 2048, force: bool = False,
                    seeds: tuple[int, ...] = (0, 1), poses: Path | None = None) -> dict:
    import cv2

    out_npz = work / f"back-{k}.npz"
    if out_npz.exists() and not force:
        d = np.load(out_npz)
        return {"colour": d["colour"], "valid": d["valid"]}
    asset = assets[k]
    hmr = np.load(work / "hmr.npz")
    poses = poses or Path(read_json(work / "inputs.json", {}).get("poses", ""))
    doc = read_json(poses)
    sel = pick_frame(work, asset, tracks, hmr, k, doc, assets)
    log("backview", f"person {k}: frame {sel['frame']} (cos {sel['cos']:.2f}, {sel['heightPx']:.0f} px tall, "
                    f"{sel['visible']:.2f} unoccluded)")
    W0, H0 = int(doc["intrinsics"]["width"]), int(doc["intrinsics"]["height"])
    bodies = bodies_in_frame(assets, tracks, hmr, sel["frame"])
    _, mid, ks = visibility(assets, bodies, k, hmr["K"], W0, H0, scale=1.0)
    other = (mid >= 0) & (mid != ks.index(k))
    other = cv2.dilate(other.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    crop, geo = person_crop(work, asset, hmr, sel, other=other)
    ev = work / "evidence"
    ev.mkdir(exist_ok=True)
    cv2.imwrite(str(ev / f"back-{k}-input.jpg"), crop[:, :, ::-1])
    gens = generate(crop, list(seeds))
    # the body turned 180 degrees about the vertical through its pelvis, seen from the recording camera
    K = hmr["K"]
    W, H = int(doc["intrinsics"]["width"]), int(doc["intrinsics"]["height"])
    V = hmr["v3d"][sel["det"]].astype(np.float64)[asset.src_vertex]
    pel = hmr["transl_pelvis"][sel["det"]].astype(np.float64)
    up_c = sel["T_view_cv"][:3, :3].T @ np.array([0.0, 1.0, 0.0])
    R180 = axis_rotation(up_c, np.pi)
    Vb = (V - pel) @ R180.T + pel
    # silhouette in crop pixels (the generated image's frame before the fit)
    gh, gw = gens[0].shape[:2]
    scale_c = gw / geo["side"]
    uvb = raster.project(K, Vb)
    uvc = (uvb - np.array(geo["origin"], np.float64)) * scale_c
    target = np.zeros((gh, gw), np.uint8)
    pts = np.rint(uvc[asset.tris] * 16).astype(np.int32)
    cv2.fillPoly(target, list(pts), 1, shift=4)
    target = target > 0
    fits = []
    for g in gens:
        m = white_mask(g)
        fits.append(fit_similarity(m, target) if m.any() else (1.0, 0.0, 0.0, 0.0))
    best = int(np.argmax([f[3] for f in fits]))
    s, tx, ty, iou = fits[best]
    log("backview", f"person {k}: mask IoU per seed {[round(f[3], 3) for f in fits]}; using seed {seeds[best]}")
    for i, g in enumerate(gens):
        cv2.imwrite(str(ev / f"back-{k}-seed{seeds[i]}.jpg"), g[:, :, ::-1])
    gen = gens[best]
    # texels visible from the virtual camera
    tm = texel_map(asset, size)
    reg, _ = texel_regions(asset, tm)
    labels = [str(b) for b in asset.bone_labels]
    dom = asset.joints[np.arange(len(asset.joints)), np.argmax(asset.weights, 1)]
    upper_leg = np.array([labels[j].startswith("upperleg") for j in dom])[asset.tris[tm.tid][:, 0]]
    allowed = np.isin(reg, [REGIONS.index("torso"), REGIONS.index("hair")]) | upper_leg
    P = texel_points(Vb, asset, tm)
    renderer = raster.DepthRenderer(K, W, H)
    depth, mesh_id, _, _ = renderer.render([(Vb, asset.tris)])
    u = K[0, 0] * P[:, 0] / P[:, 2] + K[0, 2]
    v = K[1, 1] * P[:, 1] / P[:, 2] + K[1, 2]
    ui, vi = np.clip(np.floor(u).astype(int), 0, W - 1), np.clip(np.floor(v).astype(int), 0, H - 1)
    vis = (np.abs(depth[vi, ui] - P[:, 2]) < 0.015) & (mesh_id[vi, ui] == 0)
    nrm = body.vertex_normals(Vb, asset.tris)
    F = asset.tris[tm.tid]
    tn = tm.bary[:, :1] * nrm[F[:, 0]] + tm.bary[:, 1:2] * nrm[F[:, 1]] + tm.bary[:, 2:3] * nrm[F[:, 2]]
    tn /= np.maximum(np.linalg.norm(tn, axis=1, keepdims=True), 1e-9)
    cos = (tn * (-P / np.linalg.norm(P, axis=1, keepdims=True))).sum(1)
    # virtual-camera pixel -> crop pixel -> generated pixel (inverse of the fitted similarity)
    xc = (u - geo["origin"][0]) * scale_c
    yc = (v - geo["origin"][1]) * scale_c
    xg, yg = (xc - tx) / s, (yc - ty) / s
    gm = white_mask(gen)
    inside = (xg >= 0) & (yg >= 0) & (xg < gw - 1) & (yg < gh - 1)
    xi, yi = np.clip(xg.astype(int), 0, gw - 1), np.clip(yg.astype(int), 0, gh - 1)
    valid = vis & (cos > 0.5) & allowed & inside & gm[yi, xi]
    colour = np.zeros((len(tm.tid), 3), np.float32)
    colour[valid] = bilinear(gen, xg[valid] + 0.5, yg[valid] + 0.5)
    np.savez_compressed(out_npz, colour=colour, valid=valid, seed=seeds[best], iou=iou, frame=sel["frame"])
    # evidence: the fitted silhouette over the chosen generation
    vis_img = gen.copy()
    M = np.array([[1 / s, 0, -tx / s], [0, 1 / s, -ty / s]], np.float32)
    tg = cv2.warpAffine(target.astype(np.uint8), M, (gw, gh), flags=cv2.INTER_NEAREST) > 0
    c, _ = cv2.findContours(tg.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    vis_img = np.ascontiguousarray(vis_img[:, :, ::-1])
    cv2.drawContours(vis_img, c, -1, (0, 0, 255), 2)
    cv2.imwrite(str(ev / f"back-{k}-fit.jpg"), vis_img)
    log("backview", f"person {k}: generated back covers {valid.mean():.3f} of the texels (IoU {iou:.3f})")
    return {"colour": colour, "valid": valid, "iou": iou, "seed": seeds[best], "frame": sel["frame"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--poses", required=True)
    ap.add_argument("--person", type=int, default=0)
    ap.add_argument("--seeds", default="0,1")
    ap.add_argument("--size", type=int, default=2048)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    work = Path(a.work)
    tracks = dict(np.load(work / "tracks.npz"))
    n = sum(1 for key in tracks if key.endswith("/rest_vertices"))
    assets = [Asset.load(work / f"asset-{k}.npz") for k in range(n)]
    back_for_person(work, assets, tracks, a.person, a.size, a.force, tuple(int(x) for x in a.seeds.split(",")),
                    Path(a.poses))
    return 0


if __name__ == "__main__":
    sys.exit(main())
