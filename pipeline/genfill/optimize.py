"""Step 5: a short gsplat optimisation of the generated splats (and only low-confidence old ones).

Targets:
  - filled anchor views: the generated image inside the fill mask (weight 1, feathered), the rest at a low weight;
  - the training cameras: the ORIGINAL world's render from each of them (rendered once before any change). Whatever
    the footage saw stays as it was: a generated splat that would show in front of seen content in a training view
    is pushed transparent, then pruned.

Trainable: position, size, rotation, opacity and colour of generated splats; opacity and base colour of
low-confidence old splats inside the regions being filled. Everything else is frozen (its gradient is zeroed, so
Adam never moves it).
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

from .geom import Intr
from .gpu import GS, kmat, render, say, viewmat


@dataclass
class OptConfig:
    steps: int = 1200
    anchor_share: float = 0.5
    lr_means: float = 4e-4
    lr_scales: float = 5e-3
    lr_quats: float = 1e-3
    lr_opac: float = 3e-2
    lr_color: float = 5e-3
    outside_weight: float = 0.2
    ssim_weight: float = 0.2
    scale_cap: float = 0.25        # metres; larger generated splats are penalised
    prune_opacity: float = 0.03
    max_scale: float = 0.6


@dataclass
class AnchorTarget:
    c2w: np.ndarray
    k: Intr
    image: "object"   # torch [H,W,3] 0..1
    weight: "object"  # torch [H,W] (feathered fill mask, plus outside_weight elsewhere)


class Distill:
    """The original world's render from every training camera at reduced resolution (the 'keep what was seen'
    targets), cached on the GPU as uint8."""

    def __init__(self, gs: GS, cams, scale: float = 0.33, max_cams: int | None = None):
        import torch

        sel = cams if not max_cams or len(cams) <= max_cams else [cams[i] for i in np.linspace(0, len(cams) - 1, max_cams).astype(int)]
        self.views = []
        t0 = time.time()
        for c in sel:
            k = c.intr.scaled(scale)
            r = render(gs, c.c2w, k)
            self.views.append((c.c2w, k, (r["rgb"] * 255 + 0.5).byte(), (r["alpha"] * 255 + 0.5).byte()))
        say(f"cached {len(self.views)} training-view targets in {time.time() - t0:.1f}s")
        self._torch = torch

    def __len__(self) -> int:
        return len(self.views)


def ssim(x, y, window: int = 11, sigma: float = 1.5):
    import torch
    import torch.nn.functional as F

    g = torch.exp(-((torch.arange(window, device=x.device, dtype=x.dtype) - window // 2) ** 2) / (2 * sigma * sigma))
    g = g / g.sum()
    w = (g[:, None] @ g[None, :])[None, None].repeat(3, 1, 1, 1)
    pad = window // 2
    xp = F.pad(x, (pad, pad, pad, pad), mode="reflect")
    yp = F.pad(y, (pad, pad, pad, pad), mode="reflect")
    mx, my = F.conv2d(xp, w, groups=3), F.conv2d(yp, w, groups=3)
    sxx = F.conv2d(xp * xp, w, groups=3) - mx ** 2
    syy = F.conv2d(yp * yp, w, groups=3) - my ** 2
    sxy = F.conv2d(xp * yp, w, groups=3) - mx * my
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx ** 2 + my ** 2 + c1) * (sxx + syy + c2))


def optimize(gs: GS, anchors: list[AnchorTarget], distill: Distill, cfg: OptConfig, seed: int = 0) -> dict:
    """Optimises gs in place (gs.soft marks old splats whose opacity and colour may change)."""
    import torch
    from gsplat import rasterization

    n = len(gs)
    geo = gs.new.clone()
    app = gs.new | gs.soft
    if int(app.sum()) == 0 or (not anchors and not len(distill)):
        return {"steps": 0}
    eps = 1e-6
    P = {
        "means": torch.nn.Parameter(gs.means.clone()),
        "scales": torch.nn.Parameter(torch.log(gs.scales.clamp_min(1e-6))),
        "quats": torch.nn.Parameter(gs.quats.clone()),
        "opac": torch.nn.Parameter(torch.logit(gs.opac.clamp(eps, 1 - eps))),
        "sh0": torch.nn.Parameter(gs.sh[:, :1].clone()),
    }
    shN = gs.sh[:, 1:].detach()
    lrs = {"means": cfg.lr_means, "scales": cfg.lr_scales, "quats": cfg.lr_quats, "opac": cfg.lr_opac, "sh0": cfg.lr_color}
    opt = torch.optim.Adam([{"params": [P[k]], "lr": lrs[k], "name": k} for k in P], eps=1e-15)
    masks = {"means": geo, "scales": geo, "quats": geo, "opac": app, "sh0": app}
    rng = np.random.default_rng(seed)
    hist = []
    t0 = time.time()
    for step in range(cfg.steps):
        use_anchor = anchors and (not len(distill) or rng.random() < cfg.anchor_share)
        if use_anchor:
            a = anchors[int(rng.integers(len(anchors)))]
            c2w, k, gt, wmap = a.c2w, a.k, a.image, a.weight
        else:
            c2w, k, gt8, _ = distill.views[int(rng.integers(len(distill)))]
            gt, wmap = gt8.float() / 255.0, None
        colors = torch.cat([P["sh0"], shN], 1)
        img, _, _ = rasterization(P["means"], torch.nn.functional.normalize(P["quats"], dim=-1), torch.exp(P["scales"]),
                                  torch.sigmoid(P["opac"]), colors, viewmat(c2w)[None], kmat(k)[None], k.width, k.height,
                                  sh_degree=gs.deg, packed=False, near_plane=0.02, far_plane=1e4)
        pred = img[0].clamp(0, 1)
        if wmap is None:
            l1 = (pred - gt).abs().mean()
            ds = 1 - ssim(pred.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None]).mean()
        else:
            wsum = wmap.sum().clamp_min(1.0)
            l1 = ((pred - gt).abs().mean(-1) * wmap).sum() / wsum
            sm = ssim(pred.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])[0].mean(0)
            ds = ((1 - sm) * wmap).sum() / wsum
        loss = (1 - cfg.ssim_weight) * l1 + cfg.ssim_weight * ds
        sc = torch.exp(P["scales"][geo])
        if len(sc):
            loss = loss + 0.05 * torch.relu(sc - cfg.scale_cap).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        for key, p in P.items():
            if p.grad is not None:
                p.grad[~masks[key]] = 0
        opt.step()
        if step % 200 == 0 or step == cfg.steps - 1:
            hist.append({"step": step, "loss": round(float(loss.detach()), 5), "anchor": bool(use_anchor)})
    with torch.no_grad():
        gs.means = P["means"].detach()
        gs.scales = torch.exp(P["scales"].detach())
        gs.quats = torch.nn.functional.normalize(P["quats"].detach(), dim=-1)
        gs.opac = torch.sigmoid(P["opac"].detach())
        gs.sh = torch.cat([P["sh0"].detach(), shN], 1)
    say(f"optimised {int(geo.sum())} generated + {int((app & ~geo).sum())} soft splats for {cfg.steps} steps "
        f"in {time.time() - t0:.1f}s (last loss {hist[-1]['loss'] if hist else 'n/a'})")
    return {"steps": cfg.steps, "seconds": round(time.time() - t0, 1), "history": hist}


def prune(gs: GS, cfg: OptConfig) -> dict:
    """Drops generated splats that went (almost) transparent or grew huge, and soft old splats that faded out."""
    drop = gs.new & ((gs.opac < cfg.prune_opacity) | (gs.scales.max(1).values > cfg.max_scale))
    drop |= gs.soft & ~gs.new & (gs.opac < 0.01)
    n_new = int((drop & gs.new).sum())
    n_old = int((drop & ~gs.new).sum())
    gs.remove(drop)
    say(f"pruned {n_new} generated and {n_old} faded old splats")
    return {"generated": n_new, "old": n_old}


def seen_psnr(gs: GS, distill: Distill):
    """PSNR of the current world against the original world's render from every training camera (numpy [V])."""
    import torch

    out = []
    with torch.no_grad():
        for c2w, k, rgb8, _ in distill.views:
            r = render(gs, c2w, k)["rgb"]
            mse = float(((r - rgb8.float() / 255.0) ** 2).mean())
            out.append(-10 * math.log10(max(mse, 1e-10)))
    return np.array(out)
