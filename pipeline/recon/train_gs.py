#!/usr/bin/env python3
"""Step 4: train Gaussian splats with gsplat on the solved cameras, in the room frame.

  python pipeline/recon/train_gs.py --work WORK [--steps 30000] [--cap 1300000] [--sh 1] [--depth-reg 0.1]
                                    [--test-every 8] [--out WORK/train] [--no-appearance] [--no-pose-opt]

Reads WORK/poses.json + WORK/points.npz (poses.py) and WORK/frame.json (frame.py pre), so the splats come out
levelled, metric and centred on the spawn (y up, floor y = 0); the scene transform stays the identity and no
spherical harmonics ever need rotating.

- Images whose camera has lens distortion are resampled onto a pinhole camera with the same focal length;
  pixels that fall outside the source and pixels under masks/<image>.png (people) carry no loss.
- Initialisation from the sparse points (colour, size from the 3 nearest neighbours), densification and
  relocation with gsplat's MCMC strategy capped at --cap splats (a Quest-sized budget).
- Loss: 0.8 L1 + 0.2 (1 - SSIM) over the unmasked pixels, plus MCMC's opacity and scale regularisers.
- --appearance (on): a colour transform applied to the render (then clipped) absorbs each clip frame's exposure,
  white balance and gamut (HDR video is tone-mapped differently from the photos): one 3x3 per clip times a per-frame
  gain per channel, plus an offset (--appearance-mode frame: a free 3x3 per frame). Photos keep the identity
  (unless --photo-appearance), so the exported colours are the photos' colours.
- --photo-weight: photos are sharper than clip frames, so they are drawn more often than their share.
- --pose-opt: a small rotation + translation per clip frame is learned with the splats (rolling shutter and
  stabilisation make those poses the least exact); photos stay fixed and anchor the frame.
- --depth-reg: the rendered inverse depth must correlate, tile by tile, with a monocular depth estimate of the same
  view (scale and shift free). It keeps textureless surfaces (ceiling, white walls) where they are instead of
  smeared along the viewing rays, which is what shows as streaks once you walk away from the cameras.
- --needle-reg: a penalty on splats much longer than their middle axis (needles streak from new viewpoints).
- Every --test-every-th photo is held out; metrics.json reports PSNR/SSIM on them (plain, and after fitting one
  colour transform per held-out image, since a held-out view has no learned exposure).

Writes OUT/splats.ply (standard 3DGS PLY), OUT/ckpt.pt, OUT/metrics.json, OUT/renders/*.jpg (held-out views:
photo | render).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

from cams import Camera, qvec_to_rotmat
from util import Work, log, read_json, write_json

SH_C0 = 0.28209479177387814


def say(msg: str) -> None:
    log("train", msg)


# --------------------------------------------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------------------------------------------


def similarity(frame: dict) -> tuple[np.ndarray, np.ndarray, float]:
    t = frame["colmapToRoom"]
    return np.asarray(t["R"], np.float64), np.asarray(t["t"], np.float64), float(t["scale"])


def room_w2c(qvec, tvec, R_s: np.ndarray, t_s: np.ndarray, s: float) -> np.ndarray:
    """A COLMAP world-to-camera pose -> world-to-camera in the room frame (OpenCV camera axes)."""
    R = qvec_to_rotmat(qvec)
    C = -R.T @ np.asarray(tvec, np.float64)
    c2w = np.eye(4)
    c2w[:3, :3] = R_s @ R.T
    c2w[:3, 3] = s * (R_s @ C) + t_s
    return np.linalg.inv(c2w)


class Views:
    """Every registered image on the GPU (uint8), its mask, pinhole K and room-frame view matrix."""

    def __init__(self, work: Work, test_every: int, device: str, max_long: int | None = None,
                 test_names: list[str] | None = None):
        import cv2
        import torch

        poses = read_json(work.poses)
        frame = read_json(work.frame)
        if not poses or not frame:
            raise SystemExit("poses.json and frame.json are needed (poses.py, then frame.py pre)")
        R_s, t_s, s = similarity(frame)
        cams = {cid: Camera.from_json(c) for cid, c in poses["cameras"].items()}
        regs = [im for im in poses["images"] if im.get("registered")]
        regs.sort(key=lambda im: im["name"])
        photos = [im["name"] for im in regs if str(im.get("group", "")).startswith("photo")]
        test = set(photos[::test_every]) if test_every > 0 else set()
        if test_names:  # an explicit held-out set (keeps runs comparable when the registered photos change)
            test = set(test_names)
        maps = {}
        self.names, self.groups, self.split = [], [], []
        self.images, self.masks, self.K, self.viewmats, self.sizes = [], [], [], [], []
        for im in regs:
            cam = cams[im["camera"]]
            bgr = cv2.imread(str(work.images / im["name"]), cv2.IMREAD_COLOR)
            if bgr is None:
                say(f"WARNING: cannot read {im['name']}, skipped")
                continue
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            mp = work.mask_for(im["name"])
            mask = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE) if mp.exists() else np.full(rgb.shape[:2], 255, np.uint8)
            if rgb.shape[:2] != (cam.height, cam.width):
                raise SystemExit(f"{im['name']} is {rgb.shape[1]}x{rgb.shape[0]}, its camera {cam.width}x{cam.height}")
            if not cam.is_pinhole():
                if im["camera"] not in maps:
                    maps[im["camera"]] = cam.undistort_maps()
                mx, my = maps[im["camera"]]
                rgb = cv2.remap(rgb, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
                mask = cv2.remap(mask, mx, my, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            K = cam.pinhole().K()
            if max_long and max(rgb.shape[:2]) > max_long:
                f = max_long / max(rgb.shape[:2])
                rgb = cv2.resize(rgb, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
                mask = cv2.resize(mask, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
                K[:2] *= f
            self.names.append(im["name"])
            self.groups.append(str(im.get("group", "")))
            self.split.append("test" if im["name"] in test else "train")
            self.images.append(torch.from_numpy(np.ascontiguousarray(rgb)).to(device))
            self.masks.append(torch.from_numpy(mask > 127).to(device))
            self.K.append(torch.tensor(K, dtype=torch.float32, device=device))
            self.viewmats.append(torch.tensor(room_w2c(im["qvec"], im["tvec"], R_s, t_s, s), dtype=torch.float32, device=device))
            self.sizes.append((rgb.shape[1], rgb.shape[0]))
        self.train_idx = [i for i, sp in enumerate(self.split) if sp == "train"]
        self.test_idx = [i for i, sp in enumerate(self.split) if sp == "test"]
        centers = np.stack([np.linalg.inv(v.cpu().numpy())[:3, 3] for v in self.viewmats])
        self.centers = centers
        self.extent = float(np.max(np.linalg.norm(centers - centers.mean(0), axis=1))) * 1.1
        say(f"{len(self.names)} views ({len(self.train_idx)} train, {len(self.test_idx)} test), camera extent {self.extent:.2f} m, "
            f"undistorted cameras: {sorted(maps)}")

    def __len__(self) -> int:
        return len(self.names)


def load_points(work: Work, frame: dict) -> tuple[np.ndarray, np.ndarray]:
    d = np.load(work.root / "points.npz")
    R_s, t_s, s = similarity(frame)
    ok = (d["track"] >= 2) & (d["error"] < 2.5)
    xyz = (s * (d["xyz"][ok].astype(np.float64) @ R_s.T)) + t_s
    return xyz.astype(np.float32), d["rgb"][ok].astype(np.float32) / 255.0


# --------------------------------------------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------------------------------------------


def knn_scale(xyz: np.ndarray, k: int = 3) -> np.ndarray:
    from scipy.spatial import cKDTree

    d, _ = cKDTree(xyz).query(xyz, k=k + 1)
    return np.sqrt(np.mean(d[:, 1:] ** 2, axis=1))


def init_params(xyz: np.ndarray, rgb: np.ndarray, sh_degree: int, extent: float, device: str):
    import torch

    n = len(xyz)
    dist = np.clip(knn_scale(xyz), 1e-4, 0.1 * extent)
    params = {
        "means": torch.tensor(xyz, dtype=torch.float32),
        "scales": torch.log(torch.tensor(dist, dtype=torch.float32))[:, None].repeat(1, 3),
        "quats": torch.nn.functional.normalize(torch.randn(n, 4), dim=-1),
        "opacities": torch.logit(torch.full((n,), 0.1)),
        "sh0": torch.tensor((rgb - 0.5) / SH_C0, dtype=torch.float32)[:, None, :],
        "shN": torch.zeros(n, (sh_degree + 1) ** 2 - 1, 3),
    }
    return torch.nn.ParameterDict({k: torch.nn.Parameter(v.to(device)) for k, v in params.items()})


def make_optimizers(params, extent: float, batch: int = 1):
    import torch

    lrs = {"means": 1.6e-4 * extent, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    bs = math.sqrt(batch)
    return {k: torch.optim.Adam([{"params": params[k], "lr": lr * bs, "name": k}], eps=1e-15 / bs, betas=(1 - batch * (1 - 0.9), 1 - batch * (1 - 0.999)))
            for k, lr in lrs.items()}


def ssim_map(x, y, window: int = 11, sigma: float = 1.5):
    """SSIM per pixel for [B,3,H,W] images in 0..1 (gaussian window, valid padding replaced by reflect)."""
    import torch
    import torch.nn.functional as F

    g = torch.exp(-((torch.arange(window, device=x.device, dtype=x.dtype) - window // 2) ** 2) / (2 * sigma * sigma))
    g = (g / g.sum())
    w = (g[:, None] @ g[None, :])[None, None].repeat(3, 1, 1, 1)
    pad = window // 2
    xp = F.pad(x, (pad, pad, pad, pad), mode="reflect")
    yp = F.pad(y, (pad, pad, pad, pad), mode="reflect")
    mu_x = F.conv2d(xp, w, groups=3)
    mu_y = F.conv2d(yp, w, groups=3)
    sxx = F.conv2d(xp * xp, w, groups=3) - mu_x ** 2
    syy = F.conv2d(yp * yp, w, groups=3) - mu_y ** 2
    sxy = F.conv2d(xp * yp, w, groups=3) - mu_x * mu_y
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return ((2 * mu_x * mu_y + c1) * (2 * sxy + c2)) / ((mu_x ** 2 + mu_y ** 2 + c1) * (sxx + syy + c2))


def fit_color(render, target, mask):
    """Least-squares 3x4 colour transform taking render [H,W,3] onto target over mask (held-out evaluation)."""
    import torch

    r = render[mask].double()
    t = target[mask].double()
    X = torch.cat([r, torch.ones_like(r[:, :1])], dim=1)
    sol = torch.linalg.lstsq(X, t).solution
    return (torch.cat([render.double(), torch.ones_like(render[..., :1]).double()], dim=-1) @ sol).float().clamp(0, 1)


# --------------------------------------------------------------------------------------------------------------
# Training
# --------------------------------------------------------------------------------------------------------------


def mono_disparity(views: Views, device: str, div: int, model: str) -> list:
    """Monocular inverse depth of every view at 1/div resolution (only its shape matters: the loss is a
    correlation), from the depth model in common/models.py."""
    import torch

    from common.models import DepthEstimator

    est = DepthEstimator(model, device=device)
    out = []
    for i in range(len(views)):
        img = views.images[i].cpu().numpy()
        h, w = img.shape[:2]
        d = est(img[None], out_hw=(h // div, w // div))[0]
        out.append(torch.from_numpy(1.0 / np.maximum(d, 0.05)).to(device=device, dtype=torch.float16))
    del est
    torch.cuda.empty_cache()
    return out


def patch_pearson(a, b, valid, patch: int = 16):
    """1 - mean Pearson correlation of a and b over patch x patch tiles (tiles at least half valid)."""
    import torch
    import torch.nn.functional as F

    A = F.unfold(a[None, None], patch, stride=patch)[0]
    B = F.unfold(b[None, None], patch, stride=patch)[0]
    M = F.unfold(valid[None, None].float(), patch, stride=patch)[0]
    n = M.sum(0)
    keep = n > 0.5 * patch * patch
    if not bool(keep.any()):
        return a.sum() * 0
    A, B, M, n = A[:, keep], B[:, keep], M[:, keep], n[keep]
    ma = (A * M).sum(0) / n
    mb = (B * M).sum(0) / n
    da, db = (A - ma) * M, (B - mb) * M
    corr = (da * db).sum(0) / torch.sqrt((da * da).sum(0) * (db * db).sum(0) + 1e-12)
    return (1 - corr).mean()


def render(params, view: int, views: Views, sh_degree: int, bg=None, viewmat=None, **kw):
    import torch
    from gsplat import rasterization

    w, h = views.sizes[view]
    colors = torch.cat([params["sh0"], params["shN"]], dim=1)
    vm = views.viewmats[view] if viewmat is None else viewmat
    out, alpha, info = rasterization(
        params["means"], torch.nn.functional.normalize(params["quats"], dim=-1), torch.exp(params["scales"]),
        torch.sigmoid(params["opacities"]), colors, vm[None], views.K[view][None], w, h,
        sh_degree=sh_degree, packed=False, backgrounds=bg, near_plane=0.01, far_plane=1e4, **kw,
    )
    return out[0], alpha[0], info


def evaluate(params, views: Views, idx: list[int], sh_degree: int, out_dir: Path | None, appearance=None, tag: str = "",
             pose=None) -> dict:
    import torch

    res = []
    with torch.no_grad():
        for i in idx:
            img, _, _ = render(params, i, views, sh_degree, viewmat=None if pose is None else pose(i))
            img = img.clamp(0, 1)
            gt = views.images[i].float() / 255.0
            m = views.masks[i]
            if appearance is not None:
                img = appearance(img, i)
            fitted = fit_color(img, gt, m)
            row = {"name": views.names[i]}
            for key, pred in (("", img), ("Fit", fitted)):
                mse = ((pred - gt) ** 2)[m].mean()
                psnr = float(-10 * torch.log10(mse))
                sm = ssim_map(pred.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])[0].mean(0)
                row[f"psnr{key}"] = round(psnr, 3)
                row[f"ssim{key}"] = round(float(sm[m].mean()), 4)
            res.append(row)
            if out_dir is not None:
                import cv2

                out_dir.mkdir(parents=True, exist_ok=True)
                pair = torch.cat([gt, img], dim=1).mul(255).add(0.5).clamp(0, 255).byte().cpu().numpy()
                cv2.imwrite(str(out_dir / f"{tag}{Path(views.names[i]).stem}.jpg"), cv2.cvtColor(pair, cv2.COLOR_RGB2BGR),
                            [cv2.IMWRITE_JPEG_QUALITY, 88])
    summary = {k: round(float(np.mean([r[k] for r in res])), 4) for k in ("psnr", "ssim", "psnrFit", "ssimFit")} if res else {}
    return {"mean": summary, "views": res}


def skew(w):
    import torch

    z = torch.zeros_like(w[..., 0])
    return torch.stack([torch.stack([z, -w[..., 2], w[..., 1]], -1),
                        torch.stack([w[..., 2], z, -w[..., 0]], -1),
                        torch.stack([-w[..., 1], w[..., 0], z], -1)], -2)


def pose_delta(d):
    """[6] (axis-angle, translation) -> 4x4 correction applied in the camera frame (w2c' = D @ w2c)."""
    import torch

    D = torch.eye(4, device=d.device, dtype=d.dtype)
    D = D.clone()
    D[:3, :3] = torch.linalg.matrix_exp(skew(d[:3]))
    D[:3, 3] = d[3:]
    return D


def train(a) -> dict:
    import torch
    from gsplat.strategy import MCMCStrategy

    torch.manual_seed(0)
    np.random.seed(0)
    device = "cuda"
    work = Work(a.work)
    out = Path(a.out) if a.out else work.train
    out.mkdir(parents=True, exist_ok=True)
    frame = read_json(work.frame)
    t0 = time.time()
    views = Views(work, a.test_every, device, a.max_long, a.test_names)
    xyz, rgb = load_points(work, frame)
    say(f"{len(xyz)} sparse points to start from; loading took {time.time() - t0:.1f}s")
    params = init_params(xyz, rgb, a.sh, views.extent, device)
    opts = make_optimizers(params, views.extent)
    sched = torch.optim.lr_scheduler.ExponentialLR(opts["means"], gamma=0.01 ** (1.0 / a.steps))
    strategy = MCMCStrategy(cap_max=a.cap, refine_start_iter=500, refine_stop_iter=int(a.steps * 0.83), refine_every=100,
                            min_opacity=0.005, verbose=False)
    strategy.check_sanity(params, opts)
    state = strategy.initialize_state()

    n_views = len(views)
    is_photo = [g.startswith("photo") for g in views.groups]
    app = None
    app_opt = None
    if a.appearance:
        # per-image colour for the clips (and the photos only with --photo-appearance): photos fix the colours.
        # 'frame': a full 3x3 + offset per image. 'clip': one 3x3 per clip (its tone mapping and gamut) times a
        # per-image gain per channel, plus an offset (exposure and white balance drift), which leaves less room
        # for hue to wander between frames.
        groups = sorted(set(views.groups))
        gidx = torch.tensor([groups.index(g) for g in views.groups], device=device)
        A = torch.nn.Parameter(torch.eye(3, device=device).repeat(n_views if a.appearance_mode == "frame" else len(groups), 1, 1))
        gain = torch.nn.Parameter(torch.ones(n_views, 3, device=device))
        b = torch.nn.Parameter(torch.zeros(n_views, 3, device=device))
        app_opt = torch.optim.Adam([A, gain, b], lr=a.appearance_lr)
        learn = torch.tensor([a.photo_appearance or not ph for ph in is_photo], device=device)
        reg_w = torch.tensor([a.photo_reg if ph else a.video_reg for ph in is_photo], device=device)

        def colour_matrix(i):
            if a.appearance_mode == "frame":
                return A[i]
            return gain[i][:, None] * A[gidx[i]]

        def app(img, i):
            if not bool(learn[i]):
                return img.clamp(0, 1)
            return (img @ colour_matrix(i).T + b[i]).clamp(0, 1)

    pose = None
    pose_opt = None
    if a.pose_opt:
        # small pose corrections for clip frames (rolling shutter and stabilisation make their solved poses the
        # least exact); the photos stay put and anchor the frame
        dpose = torch.nn.Parameter(torch.zeros(n_views, 6, device=device))
        pose_opt = torch.optim.Adam([dpose], lr=a.pose_lr)
        movable = [not ph for ph in is_photo]

        def pose(i):
            if not movable[i]:
                return views.viewmats[i]
            return pose_delta(dpose[i]) @ views.viewmats[i]

    mono = None
    if a.depth_reg > 0:
        t_d = time.time()
        mono = mono_disparity(views, device, a.depth_div, a.depth_model)
        say(f"monocular depth for {len(mono)} views in {time.time() - t_d:.1f}s ({a.depth_model})")

    photos_train = [i for i in views.train_idx if is_photo[i]]
    others_train = [i for i in views.train_idx if not is_photo[i]]
    rng = np.random.default_rng(0)
    lam = 0.2
    hist = []
    order: list[int] = []
    t_train = time.time()
    for step in range(a.steps):
        if photos_train and others_train and a.photo_weight > 0:
            pool = photos_train if rng.random() < a.photo_weight else others_train
            i = int(pool[rng.integers(len(pool))])
        else:
            if not order:
                order = list(rng.permutation(views.train_idx))
            i = int(order.pop())
        deg = min(a.sh, step // 1000)
        use_pose = pose is not None and step >= a.pose_start
        use_depth = mono is not None and step >= a.depth_start
        img, alpha, info = render(params, i, views, deg, viewmat=pose(i) if use_pose else None, absgrad=False,
                                  render_mode="RGB+ED" if use_depth else "RGB")
        depth = img[..., 3] if use_depth else None
        img = img[..., :3]
        gt = views.images[i].float() / 255.0
        m = views.masks[i]
        pred = img.clamp(0, 1) if app is None else app(img, i)
        mf = m.float()[..., None]
        denom = mf.sum().clamp_min(1.0) * 3
        l1 = (torch.abs(pred - gt) * mf).sum() / denom
        sm = ssim_map(pred.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])[0]
        dssim = 1.0 - (sm * m.float()[None]).sum() / (m.float().sum().clamp_min(1.0) * 3)
        loss = (1 - lam) * l1 + lam * dssim
        loss = loss + a.opacity_reg * torch.sigmoid(params["opacities"]).mean() + a.scale_reg * torch.exp(params["scales"]).mean()
        if a.needle_reg > 0:
            # needles (one axis much longer than the other two) look fine from the training views and streak
            # from every other one; flat discs (surfaces) stay free
            sc = torch.sort(params["scales"], dim=1).values
            loss = loss + a.needle_reg * torch.relu(sc[:, 2] - sc[:, 1] - math.log(a.needle_ratio)).mean()
        if app is not None and bool(learn[i]):
            loss = loss + reg_w[i] * (((colour_matrix(i) - torch.eye(3, device=device)) ** 2).sum() + (b[i] ** 2).sum())
        if use_pose and movable[i]:
            loss = loss + a.pose_reg * (dpose[i] ** 2).sum()
        if use_depth:
            # geometry where the photos say little (ceiling, white walls, glass): the rendered inverse depth must
            # follow the shape of the monocular one, tile by tile (scale and shift free)
            import torch.nn.functional as F

            k = a.depth_div
            ok = (alpha[..., 0] > 0.5) & m
            disp = torch.where(ok, 1.0 / depth.clamp_min(0.05), torch.zeros_like(depth))
            disp_s = F.avg_pool2d(disp[None, None], k)[0, 0]
            ok_s = F.avg_pool2d(ok.float()[None, None], k)[0, 0] > 0.99
            md = mono[i].float()
            hh, ww = min(md.shape[0], disp_s.shape[0]), min(md.shape[1], disp_s.shape[1])
            w_d = a.depth_reg * max(0.1, 1.0 - step / a.steps)
            loss = loss + w_d * patch_pearson(disp_s[:hh, :ww], md[:hh, :ww], ok_s[:hh, :ww])
        loss.backward()
        for o in opts.values():
            o.step()
            o.zero_grad(set_to_none=True)
        if app_opt is not None:
            if step >= a.appearance_start:
                app_opt.step()
            app_opt.zero_grad(set_to_none=True)
        if pose_opt is not None:
            if use_pose:
                pose_opt.step()
            pose_opt.zero_grad(set_to_none=True)
        sched.step()
        strategy.step_post_backward(params, opts, state, step, info, lr=sched.get_last_lr()[0])
        if step % 500 == 0 or step == a.steps - 1:
            with torch.no_grad():
                psnr = float(-10 * torch.log10(((pred - gt) ** 2)[m].mean()))
            el = time.time() - t_train
            extra = ""
            if pose is not None:
                with torch.no_grad():
                    dp = dpose.detach()
                    extra = f"  pose dR {float(dp[:, :3].norm(dim=1).max()) * 57.3:.3f} deg dt {float(dp[:, 3:].norm(dim=1).max()) * 100:.2f} cm"
            hist.append({"step": step, "loss": round(float(loss.detach()), 5), "psnr": round(psnr, 3), "splats": int(len(params["means"])), "elapsed": round(el, 1)})
            say(f"step {step:6d}  loss {float(loss.detach()):.4f}  psnr {psnr:6.2f}  splats {len(params['means']):8d}  sh {deg}  {el:7.1f}s{extra}")
        if a.eval_at and step + 1 in a.eval_at and step + 1 != a.steps:
            ev = evaluate(params, views, views.test_idx, a.sh, None)
            say(f"held-out at step {step + 1}: {ev['mean']}")
            hist.append({"step": step + 1, "test": ev["mean"]})
    train_s = time.time() - t_train
    torch.save({"params": {k: v.detach().cpu() for k, v in params.items()}, "sh": a.sh,
                "appearance": None if app is None else {"A": A.detach().cpu(), "gain": gain.detach().cpu(), "b": b.detach().cpu(),
                                                        "mode": a.appearance_mode, "names": views.names}},
               out / "ckpt.pt")
    test = evaluate(params, views, views.test_idx, a.sh, out / "renders", tag="test-")
    train_photos = evaluate(params, views, photos_train, a.sh, out / "renders", appearance=app, tag="train-")
    train_ev = evaluate(params, views, others_train[:: max(1, len(others_train) // 10)], a.sh, out / "renders", appearance=app,
                        tag="train-", pose=pose)
    test_sh1 = None
    if a.sh > 1:
        p1 = {k: v for k, v in params.items()}
        p1 = dict(p1)
        p1["shN"] = params["shN"][:, :3]
        test_sh1 = evaluate(p1, views, views.test_idx, 1, None)["mean"]
    write_splats(params, out / "splats.ply")
    metrics = {
        "steps": a.steps,
        "trainSeconds": round(train_s, 1),
        "splats": int(len(params["means"])),
        "views": {"train": len(views.train_idx), "test": len(views.test_idx), "testNames": [views.names[i] for i in views.test_idx]},
        "test": test,
        "testShDegree1": test_sh1,
        "trainPhotos": train_photos["mean"],
        "trainClipSample": train_ev["mean"],
        "history": hist,
        "options": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(a).items()},
    }
    if pose is not None:
        dp = dpose.detach().cpu().numpy()
        metrics["poseCorrections"] = [{"name": views.names[k], "rotDeg": round(float(np.linalg.norm(dp[k, :3]) * 57.2958), 4),
                                       "transCm": round(float(np.linalg.norm(dp[k, 3:]) * 100), 3)} for k in range(n_views) if movable[k]]
        torch.save({"names": views.names, "delta": dpose.detach().cpu()}, out / "pose_deltas.pt")
        write_json(out / "pose_deltas.json", {
            "convention": "per view [rx, ry, rz, tx, ty, tz]: axis-angle and translation (room frame metres) of a camera-frame "
                          "correction, world-to-camera' = D @ world-to-camera (OpenCV axes)",
            "deltas": {views.names[k]: [float(v) for v in dp[k]] for k in range(n_views) if movable[k]},
        })
    if app is not None:
        with torch.no_grad():
            metrics["appearance"] = [{"name": views.names[k], "M": colour_matrix(k).cpu().numpy().round(4).tolist(),
                                      "b": b[k].cpu().numpy().round(4).tolist()} for k in range(n_views) if bool(learn[k])]
    write_json(out / "metrics.json", metrics)
    say(f"trained {a.steps} steps in {train_s / 60:.1f} min, {len(params['means'])} splats; held-out {test['mean']}"
        + (f"; at SH degree 1 {test_sh1}" if test_sh1 else ""))
    return metrics


def write_splats(params, path: Path) -> None:
    import torch

    import splat_io as sio

    with torch.no_grad():
        s = sio.Splats(
            params["means"].cpu().numpy(),
            torch.exp(params["scales"]).cpu().numpy(),
            torch.nn.functional.normalize(params["quats"], dim=-1).cpu().numpy(),
            torch.sigmoid(params["opacities"]).cpu().numpy(),
            params["sh0"][:, 0].cpu().numpy(),
            params["shN"].cpu().numpy() if params["shN"].shape[1] > 0 else None,
        )
    sio.write_ply(path, s)
    say(f"wrote {path} ({len(s)} splats)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--cap", type=int, default=1_300_000)
    ap.add_argument("--sh", type=int, default=1, help="SH degree (1: what the SPZ export keeps cleanly)")
    ap.add_argument("--test-every", type=int, default=8)
    ap.add_argument("--test-names", nargs="*", default=None, help="hold out exactly these images (overrides --test-every)")
    ap.add_argument("--max-long", type=int, default=None, help="downscale training images to this long side")
    ap.add_argument("--appearance", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--appearance-lr", type=float, default=1e-3)
    ap.add_argument("--appearance-start", type=int, default=500)
    ap.add_argument("--photo-appearance", action="store_true", help="learn a colour transform for the photos too")
    ap.add_argument("--appearance-mode", choices=["clip", "frame"], default="clip")
    ap.add_argument("--photo-weight", type=float, default=0.3, help="chance that a step trains on a photo (0 = uniform)")
    ap.add_argument("--pose-opt", action=argparse.BooleanOptionalAction, default=True, help="refine the clip frames' poses while training")
    ap.add_argument("--pose-lr", type=float, default=2e-5)
    ap.add_argument("--pose-reg", type=float, default=1e-4)
    ap.add_argument("--pose-start", type=int, default=1000)
    ap.add_argument("--photo-reg", type=float, default=0.05)
    ap.add_argument("--video-reg", type=float, default=0.0005)
    ap.add_argument("--opacity-reg", type=float, default=0.01)
    ap.add_argument("--scale-reg", type=float, default=0.01)
    ap.add_argument("--depth-reg", type=float, default=0.1, help="weight of the monocular depth correlation loss (0 = off)")
    ap.add_argument("--depth-model", default="metric-indoor-base")
    ap.add_argument("--depth-div", type=int, default=4, help="compare depth at 1/N resolution")
    ap.add_argument("--depth-start", type=int, default=500)
    ap.add_argument("--needle-reg", type=float, default=0.05, help="penalty on splats longer than --needle-ratio x their middle axis")
    ap.add_argument("--needle-ratio", type=float, default=5.0)
    ap.add_argument("--eval-at", type=int, nargs="*", default=[7000, 15000])
    a = ap.parse_args(argv)
    train(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
