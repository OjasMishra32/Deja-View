"""Steps 2-5 for one region: anchor views, understand (caption), generate (edit or LaMa), lift, optimise.

Anchors: from the standing spots whose probe views saw the region, aim at the region and keep a greedy cover of
its points (at most --max-anchors views, the widest first). Every anchor is rendered from the CURRENT world, so a
later anchor already shows what the earlier fills put there and only paints what is still missing.

Per anchor:
  mask     bad pixels (holes + low-confidence) whose 3D point lies in the region (voxel set), cleaned and grown
  caption  Qwen2.5-VL sees the render with the mask painted magenta (plus the nearest real photo for context) and
           says what belongs there, and whether it is only open sky (then nothing is generated: the viewer's sky
           shows through)
  generate Qwen-Image-Edit-2511 fills the magenta area (prompted with the caption, told to keep the rest); the
           result is colour-matched to the render on a ring around the mask and composited inside it only.
           Small masks go to LaMa instead.
  lift     metric monocular depth of the filled view, aligned (scale + shift, Huber) to the rendered depth around
           the mask, with the residual at the mask's rim blended inward so the fill meets the existing surfaces;
           far pixels (sky) are skipped; one flat Gaussian per stride-th pixel along the depth map's normal.
           Low-confidence old splats in front of or at the new surface (the smear being replaced) are removed.
  optimise a short pass over all anchors so far + the training views (optimize.py)
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import geom as G
from .gaps import GapConfig, Gaps, bad_points, bins_for, score_view
from .gpu import GS, low_confidence, render, say, to_u8
from .models import Client, WorkerError
from .optimize import AnchorTarget, Distill, OptConfig, optimize, seen_psnr
from .world import World, label, load_image, save_jpg, save_png, sheet

CAPTION_PROMPT = (
    "Image 1 is a photo of {scene}, taken {direction}. Parts of it are hidden under solid magenta.{photo} "
    "Describe only what is hidden under the magenta, so that a painter could fill it in and make image 1 a complete, "
    "realistic photo: what runs into the magenta area from its edges and how it continues there, and what else fills "
    "it, with materials, colours and lighting at the same time of day as the rest of the photo. Do not describe the "
    "parts that are visible. Reply with JSON only: "
    '{{"fill": "<one or two sentences>", "sky_only": <true if only open sky is hidden, else false>}}'
)
PHOTO_LINE = " Image 2 is a real photo taken in the same place, for reference."
EDIT_PROMPT = (
    "This is a photo of {scene}. Fill the solid magenta area with {fill}. Continue the surrounding structures into it "
    "seamlessly, with the same perspective, time of day, lighting, colours and sharpness as the rest of the photo. Do not change anything "
    "outside the magenta area. Photorealistic, no magenta or pink left."
)
SKY_WORDS = {"a", "the", "dark", "black", "night", "sky", "clear", "starry", "stars", "with", "and", "open", "deep", "blue",
             "cloudy", "clouds", "overcast", "of", "an", "empty"}
NEGATIVE = ("magenta, pink, purple, blurry, smeared, low detail, cartoon, painting, text, watermark, people, border, frame")
NIGHT_NEGATIVE = ", daylight, blue sky, sunset, twilight, sun, bright sky, clouds"
NIGHT_LINE = " It is the middle of the night: wherever sky shows, it is a plain black night sky with no blue, no clouds and no twilight."


@dataclass
class FillConfig:
    width: int = 1024
    height: int = 768
    hfov: float = 90.0
    max_regions: int = 8
    max_anchors: int = 6
    cover_gain: float = 0.15
    min_mask: float = 0.003
    lama_max: float = 0.012
    grow: int = 6
    feather: float = 6.0
    steps: int = 32
    cfg: float = 4.0
    seed: int = 0
    retries: int = 1
    sky_factor: float = 2.5
    sky_min: float = 15.0
    max_depth: float = 30.0
    stride_small: int = 2
    stride_large: int = 3
    large_mask: float = 0.12
    replace_margin: float = 1.15
    quick_steps: int = 150
    opt_scale: float = 0.5
    region_dilate: int = 2
    context_photo: bool = True
    scene_text: str = ""
    deadline: float = 0.0       # epoch seconds; no new anchor starts after it (0 = none)
    tilts: tuple = (30.0, 55.0, 80.0)  # each anchor sequence looks up step by step
    sequences: int = 6          # how many (spot, yaw) sequences
    near_cam: float = 1.2       # anchor spots this close to where the footage walked
    level_bad: float = 0.12     # level / downward views with this much missing also get an anchor
    level_views: int = 2
    replace_above: bool = False  # also replace well-seen splats in directions the footage never looked
    from_cameras: bool = True    # anchors stand at the photo cameras (else at probe spots near the camera path)
    night: bool = False          # the capture is at night: no daylight skies, dark smooth sky is not lifted
    max_depth_err: float = 0.25  # median relative error of the depth alignment above which the fill is not lifted
    ceiling: float | None = None  # height of the room's ceiling plane (generated overhead surfaces snap to it)
    seen_stays: bool = True      # anchors repaint smear only in directions no nearby camera looked (holes anywhere)
    ceiling_mode: bool = False   # repaint the ceiling seen from below onto the ceiling plane only (and nothing else)
    steep_elev: float = 30.0     # ceiling mode: looking up more steeply than this
    ceiling_band: float = 0.3    # ceiling mode: rendered surface within this of the plane counts as ceiling
    keep_photo_splats: bool = True  # ceiling mode: splats a training view clearly shows are never removed
    accept_psnr: float = 45.0    # an anchor is reverted when the training views drift below this PSNR (mean over
    accept_min_psnr: float = 35.0  # views) or any one below this, against the original world's renders (0 = off)
    sky_dark: float = 0.13       # night: upward pixels darker than this and smooth count as sky
    min_bad: float = 0.04       # a probe view needs this share of bad pixels to become an anchor
    max_mask: float = 0.75      # more than this and the editor has no context: skip the view
    first_max: float = 0.6      # first-pass views need at least 40% seen pixels
    max_mask_later: float = 0.88  # later tilts continue from the fill below them, so they may start emptier
    blocked: float = 0.3        # skip views with more than this share closer than 0.8 m (standing against a trunk)
    spot_gap: float = 2.0       # anchors at least this far apart (or 90 degrees apart in yaw)


@dataclass
class AnchorResult:
    region: int
    index: int
    c2w: list
    yaw: float
    pitch: float
    mask_frac: float
    method: str = ""
    caption: str = ""
    sky_only: bool = False
    lifted: int = 0
    replaced: int = 0
    sky_px: int = 0
    depth_fit: dict = field(default_factory=dict)
    seconds: dict = field(default_factory=dict)
    skipped: str = ""
    files: dict = field(default_factory=dict)


def parse_caption(text: str) -> tuple[str, bool]:
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            fill = str(d.get("fill", "")).strip()
            sky = d.get("sky_only", False)
            sky = sky if isinstance(sky, bool) else str(sky).strip().lower() == "true"
            if fill:
                return fill, bool(sky)
        except json.JSONDecodeError:
            pass
    f = re.search(r'"fill"\s*:\s*"([^"]+)"', text)
    s = re.search(r'"sky_only"\s*:\s*"?(true|false)', text, re.I)
    if f:
        return f.group(1).strip(), bool(s and s.group(1).lower() == "true")
    t = " ".join(text.replace("{", " ").replace("}", " ").split())[:200]
    return t or "the surrounding surfaces, continued naturally", False


def choose_sequences(cands: list[dict], cfg: FillConfig) -> list[dict]:
    """The most incomplete candidate (spot, yaw) views first, spread out: another one only when it stands
    spot_gap metres away or looks at least 90 degrees elsewhere."""
    chosen: list[dict] = []
    for c in sorted(cands, key=lambda c: -c["bad"]):
        p = np.asarray(c["position"])
        if any(np.linalg.norm(p - np.asarray(o["position"])) < cfg.spot_gap
               and abs(((c["yaw"] - o["yaw"] + 180) % 360) - 180) < 90 for o in chosen):
            continue
        chosen.append(c)
        if len(chosen) >= cfg.sequences:
            break
    return chosen


def sequence_views(chosen: list[dict], cfg: FillConfig) -> list[dict]:
    """All sequences at the first tilt, then all at the second, ...: each step continues from the fills below."""
    return [{**c, "pitch": float(t), "tilt": n} for n, t in enumerate(cfg.tilts) for c in chosen]


def plan_views(world: World, gs: GS, gaps: Gaps, cfg: FillConfig, gcfg: GapConfig) -> list[dict]:
    """Anchor views, in fill order. Spots close to where the footage walked (near_cam metres from a training
    camera) give the cleanest context. For each spot and yaw the view at the first tilt is scored; the most
    incomplete ones (bad share between min_bad and first_max, not standing against anything) are kept, spread out.
    Each then tilts up step by step (cfg.tilts, e.g. 30, 55, 80 degrees): all first tilts, then all second tilts, so
    every step continues from the fills below it. Level and downward probe views with holes come last."""
    cams = world.cam_xz()
    k = G.intrinsics(256, 192, cfg.hfov)
    cands = []
    if cfg.from_cameras and world.cams:
        # extend the footage itself: stand where a camera stood, face where it faced, tilt up from there; the lower
        # part of every anchor is then the sharp, photo-consistent render
        pool = [c for c in world.cams if str(c.group).startswith("photo")] or world.cams
        for n_c, c in enumerate(pool):
            yaw, _ = G.yaw_pitch_of(c.c2w)
            pos = [float(v) for v in c.position]
            _, alpha, depth, hole, lowc = score_view(gs, G.yaw_pitch_c2w(pos, yaw, cfg.tilts[0]), k, gcfg)
            bad = float((hole | lowc).mean())
            near = float(((depth > 0) & (depth < gcfg.near_depth)).mean())
            if near <= cfg.blocked and cfg.min_bad <= bad <= cfg.first_max:
                cands.append({"spot": -1 - n_c, "camera": c.name, "position": pos, "yaw": float(yaw), "bad": bad})
    for s_i, (x, z) in enumerate(gaps.spots if not (cfg.from_cameras and world.cams) else []):
        if len(cams) and np.min(np.hypot(cams[:, 0] - x, cams[:, 1] - z)) > cfg.near_cam:
            continue
        for yaw in np.arange(0.0, 360.0, 360.0 / gcfg.yaws):
            pos = [float(x), gcfg.eye, float(z)]
            _, alpha, depth, hole, lowc = score_view(gs, G.yaw_pitch_c2w(pos, yaw, cfg.tilts[0]), k, gcfg)
            bad = float((hole | lowc).mean())
            near = float(((depth > 0) & (depth < gcfg.near_depth)).mean())
            if near <= cfg.blocked and cfg.min_bad <= bad <= cfg.first_max:
                cands.append({"spot": s_i, "position": pos, "yaw": float(yaw), "bad": bad})
    out = sequence_views(choose_sequences(cands, cfg), cfg)
    level = [i for i, v in enumerate(gaps.views) if v["pitch"] <= 0 and v.get("near", 0) <= cfg.blocked and v["bad"] >= cfg.level_bad
             and (not len(cams) or np.min(np.hypot(cams[:, 0] - v["position"][0], cams[:, 1] - v["position"][2])) <= cfg.near_cam)]
    level.sort(key=lambda i: -gaps.views[i]["bad"])
    for i in level[: cfg.level_views]:
        v = gaps.views[i]
        out.append({"spot": v["spot"], "position": v["position"], "yaw": v["yaw"], "pitch": v["pitch"], "bad": v["bad"], "tilt": -1})
    return out


def context_photo(world: World, images: Path | None, c2w: np.ndarray, out: Path) -> Path | None:
    if images is None or not world.cams:
        return None
    f = -c2w[:3, 2]
    p = c2w[:3, 3]
    best, score = None, -9.0
    for c in world.cams:  # facing the same way, close by; photos are sharper than clip frames
        s = float(c.forward @ f) - 0.08 * float(np.linalg.norm(c.position - p)) + (0.15 if str(c.group).startswith("photo") else 0.0)
        if s > score:
            best, score = c, s
    if best is None:
        return None
    rgb, _ = load_image(images, best, with_mask=False)
    if rgb is None:
        return None
    import cv2

    h, w = rgb.shape[:2]
    s = 768 / max(h, w)
    rgb = cv2.resize(rgb, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    save_png(out, rgb)
    return out


def anchor_view(gs: GS, c2w: np.ndarray, k: G.Intr, gcfg: GapConfig, cfg: FillConfig):
    r, alpha, depth, hole, lowc = score_view(gs, c2w, k, gcfg)
    above = r["above"]
    rgb = to_u8(render(gs, c2w, k)["rgb"])
    # repaint holes anywhere, but smear only where no nearby camera ever looked: what a photo saw stays as it is
    bad = hole | (lowc & above) if cfg.seen_stays else hole | lowc
    if cfg.ceiling_mode and cfg.ceiling is not None:
        bad |= ceiling_band(depth, alpha, c2w, k, cfg)
    mask = G.clean_mask(bad, close=2, min_frac=0.0008, grow=cfg.grow)
    return rgb, alpha, depth, hole, lowc, mask, above


def align_fill_depth(pred: np.ndarray, depth: np.ndarray, alpha: np.ndarray, hole: np.ndarray, lowc: np.ndarray,
                     mask: np.ndarray) -> tuple[np.ndarray, dict]:
    """Monocular depth -> the world's metric frame: global scale + shift fitted on trusted pixels (rim weighted),
    then the remaining error at the mask's rim blended into the mask (decays over ~48 px)."""
    from scipy import ndimage

    trusted = (alpha > 0.95) & ~mask & ~hole & ~lowc & (depth > 0)
    near = G.ring(mask, 0, 64)
    w = 1.0 + 4.0 * near
    a, b, fit = G.align_depth(pred[trusted], depth[trusted], w[trusted])
    if not fit.get("ok"):
        a, b = 1.0, 0.0
    aligned = np.maximum(a * pred + b, 0.05)
    rim = G.ring(mask, 0, 12) & trusted
    if rim.sum() > 20:
        lr = np.zeros_like(aligned)
        lr[rim] = np.log(depth[rim] / aligned[rim])
        spread = G.fill_depth_from_neighbours(lr, rim)
        spread = ndimage.gaussian_filter(spread, 6)
        dist = ndimage.distance_transform_edt(~rim)
        aligned = aligned * np.exp(np.clip(spread, -1.0, 1.0) * np.exp(-dist / 48.0))
    fit.update(scale=a, shift=b, rimPixels=int(rim.sum()), trusted=int(trusted.sum()))
    return aligned, fit


def _project(gs: GS, c2w: np.ndarray, k: G.Intr):
    import torch

    w2c = torch.from_numpy(G.w2c_cv(c2w).astype(np.float32)).to(gs.device)
    pc = gs.means @ w2c[:3, :3].T + w2c[:3, 3]
    z = pc[:, 2]
    zs = z.clamp_min(1e-3)
    u = (k.fx * pc[:, 0] / zs + k.cx).long()
    v = (k.fy * pc[:, 1] / zs + k.cy).long()
    inview = (z > 0.05) & (u >= 0) & (u < k.width) & (v >= 0) & (v < k.height)
    return z, u.clamp(0, k.width - 1), v.clamp(0, k.height - 1), inview


def replace_old(gs: GS, c2w: np.ndarray, k: G.Intr, mask: np.ndarray, depth_new: np.ndarray, gcfg: GapConfig,
                margin: float, above: np.ndarray | None = None, protect_above: bool = False) -> int:
    """Removes the smear the fill replaces: old splats that are low-confidence from this view, were seen well by
    fewer than min_views training cameras, and project into the mask in front of or at the new surface. With
    `above` (pixels looking higher than the footage ever did), old splats there are replaced whatever their count:
    the streaks a grazing view leaves on a ceiling."""
    import torch
    from scipy import ndimage

    grown = torch.from_numpy(ndimage.binary_dilation(mask, iterations=3)).to(gs.device)
    low = low_confidence(gs, c2w[:3, 3], bins_for(gcfg, gs.device), gcfg.min_views) & (gs.conf < gcfg.min_views)
    low &= gs.maxw < gcfg.protect_px  # whatever a training view clearly shows stays
    z, u, v, inview = _project(gs, c2w, k)
    dn = torch.from_numpy(depth_new.astype(np.float32)).to(gs.device)
    drop = inview & low & grown[v, u] & (z < dn[v, u] * margin)
    if above is not None and above.any():
        ab = torch.from_numpy(ndimage.binary_dilation(mask & above, iterations=3)).to(gs.device)
        extra = inview & ~gs.new & ab[v, u] & (z < dn[v, u] * margin)
        if protect_above:
            extra &= gs.maxw < gcfg.protect_px
        drop |= extra
    return gs.remove(drop)


def mark_soft(gs: GS, c2w: np.ndarray, k: G.Intr, mask: np.ndarray, gcfg: GapConfig) -> int:
    """Old splats in the mask that the footage barely constrained may fade or change colour in the optimisation."""
    import torch

    z, u, v, inview = _project(gs, c2w, k)
    m = torch.from_numpy(mask).to(gs.device)
    soft = inview & m[v, u] & ~gs.new & (gs.conf < gcfg.min_views) & (gs.maxw < gcfg.protect_px)
    gs.soft |= soft
    return int(soft.sum())


def make_target(c2w: np.ndarray, k: G.Intr, img: np.ndarray, mask: np.ndarray, sky: np.ndarray, cfg: FillConfig,
                ocfg: OptConfig, device: str = "cuda") -> AnchorTarget:
    import cv2
    import torch

    ks = k.scaled(cfg.opt_scale)
    im = cv2.resize(img, (ks.width, ks.height), interpolation=cv2.INTER_AREA)
    wmap = G.feather(mask & ~sky, cfg.feather)
    wmap = np.maximum(wmap, ocfg.outside_weight)
    wmap[sky] = 0.0  # sky pixels are no target (no splats there)
    wmap = cv2.resize(wmap, (ks.width, ks.height), interpolation=cv2.INTER_AREA)
    return AnchorTarget(c2w, ks, torch.from_numpy(im).to(device).float() / 255.0, torch.from_numpy(wmap.astype(np.float32)).to(device))


def fill_anchor(world: World, gs: GS, gaps: Gaps, j: int, v: dict, client: Client, distill: Distill,
                targets: list[AnchorTarget], cfg: FillConfig, gcfg: GapConfig, ocfg: OptConfig, work: Path,
                images: Path | None) -> AnchorResult:
    """One anchor: render the current world from view v (position, yaw, pitch) at anchor resolution, mask,
    caption, generate, lift, short optimisation."""
    c2w = G.yaw_pitch_c2w(v["position"], v["yaw"], v["pitch"])
    k = G.intrinsics(cfg.width, cfg.height, cfg.hfov)
    t0 = time.time()
    rgb, alpha, depth, hole, lowc, mask, above = anchor_view(gs, c2w, k, gcfg, cfg)
    res = AnchorResult(-1, j, np.round(c2w, 5).tolist(), round(v["yaw"], 1), round(v["pitch"], 1), round(float(mask.mean()), 4))
    res.files = {"position": v["position"], "tilt": v.get("tilt")}
    tag = f"a{j:02d}"
    near = float(((depth > 0) & (depth < 0.8)).mean())
    if near > cfg.blocked:
        res.skipped = f"blocked: {near:.0%} of the view closer than 0.8 m"
    elif mask.mean() < cfg.min_mask:
        res.skipped = "nothing left to fill"
    elif mask.mean() > (cfg.max_mask if v.get("tilt", 0) <= 0 else cfg.max_mask_later):
        res.skipped = f"mask {mask.mean():.0%}: too little context to continue from"
    if res.skipped:
        say(f"  {tag} ({v['position'][0]:+.1f},{v['position'][2]:+.1f}) yaw {v['yaw']:.0f} pitch {v['pitch']:+.0f}: skipped, {res.skipped}")
        return res
    d = work / tag
    d.mkdir(parents=True, exist_ok=True)
    mag = rgb.copy()
    mag[mask] = (255, 0, 255)
    save_png(d / "render.png", rgb)
    save_png(d / "magenta.png", mag)
    save_png(d / "mask.png", (mask * 255).astype(np.uint8))
    filled = None
    if mask.mean() < cfg.lama_max:
        res.method = "lama"
        client.call("lama", image=str(d / "render.png"), mask=str(d / "mask.png"), out=str(d / "gen.png"))
        filled = G.composite(rgb, load_rgb(d / "gen.png"), G.feather(mask, cfg.feather))
    else:
        photo = context_photo(world, images, c2w, d / "photo.png") if cfg.context_photo else None
        look = "looking up steeply" if v["pitch"] >= 60 else "looking up" if v["pitch"] >= 20 else "looking down" if v["pitch"] <= -20 else "looking straight ahead"
        prompt = CAPTION_PROMPT.format(scene=cfg.scene_text or "a real place", direction=look, photo=PHOTO_LINE if photo else "")
        ts = time.time()
        cap = client.call("caption", images=[str(d / "magenta.png")] + ([str(photo)] if photo else []), prompt=prompt)
        res.seconds["caption"] = round(time.time() - ts, 1)
        res.caption, res.sky_only = parse_caption(cap.get("text", ""))
        say(f"  {tag}: caption {res.caption!r} sky_only={res.sky_only}")
        skyish = all(w in SKY_WORDS for w in re.findall(r"[a-z]+", res.caption.lower()))
        if res.sky_only and skyish:
            res.skipped = "open sky: left to the viewer's sky"
            return res
        res.method = "edit"
        for attempt in range(cfg.retries + 1):
            ts = time.time()
            fill_text = res.caption + (NIGHT_LINE if cfg.night else "")
            client.call("edit", image=str(d / "magenta.png"), prompt=EDIT_PROMPT.format(fill=fill_text, scene=cfg.scene_text or "a real place"),
                        negative=NEGATIVE + (NIGHT_NEGATIVE if cfg.night else ""), steps=cfg.steps, cfg=cfg.cfg, seed=cfg.seed + attempt,
                        width=cfg.width, height=cfg.height, out=str(d / f"gen{attempt}.png"))
            res.seconds[f"edit{attempt}"] = round(time.time() - ts, 1)
            gen = G.colour_match(load_rgb(d / f"gen{attempt}.png"), rgb, G.ring(mask, 2, 28) & (alpha > 0.9),
                                 strength=0.6, max_offset=20.0)
            comp = G.composite(rgb, gen, G.feather(mask, cfg.feather))
            left = G.magenta_fraction(comp, mask)
            if left < 0.03:
                filled = comp
                break
            say(f"  {tag}: edit left {left:.1%} magenta (attempt {attempt})")
        if filled is None:
            res.method = "lama (edit left magenta)"
            client.call("lama", image=str(d / "render.png"), mask=str(d / "mask.png"), out=str(d / "gen.png"))
            filled = G.composite(rgb, load_rgb(d / "gen.png"), G.feather(mask, cfg.feather))
    save_png(d / "filled.png", filled)
    ts = time.time()
    client.call("depth", image=str(d / "filled.png"), out=str(d / "depth.npy"))
    pred = np.load(d / "depth.npy")
    aligned, fit = align_fill_depth(pred, depth, alpha, hole, lowc, mask)
    res.depth_fit = {kk: (round(x, 4) if isinstance(x, float) else x) for kk, x in fit.items()}
    poor = not fit.get("ok") or fit.get("medianRelErr", 1.0) > cfg.max_depth_err
    if poor and cfg.ceiling is None:
        res.skipped = f"depth fit too poor to place the fill ({fit.get('medianRelErr', 'n/a')})"
        say(f"  {tag}: {res.skipped}")
        return res
    trusted = (alpha > 0.95) & ~mask & (depth > 0)
    near_ref = depth[G.ring(mask, 0, 32) & trusted]
    ref90 = float(np.percentile(near_ref, 90)) if len(near_ref) > 20 else (float(np.percentile(depth[trusted], 90)) if trusted.any() else cfg.sky_min)
    sky = mask & ((aligned > max(cfg.sky_factor * ref90, cfg.sky_min)) | (aligned > cfg.max_depth))
    if cfg.night:
        sky |= mask & night_sky(filled, c2w, k, cfg.sky_dark)
    res.sky_px = int(sky.sum())
    snap = gs.snapshot()  # the anchor is reverted if it makes what the footage saw worse
    lift_sel = mask & ~sky
    if cfg.ceiling is not None:
        before = aligned.copy()
        aligned, moved = G.snap_to_ceiling(aligned, mask & ~sky, c2w, k, cfg.ceiling)
        res.depth_fit["ceilingSnapped"] = moved
        if poor or cfg.ceiling_mode:  # only the pixels placed on the ceiling plane are lifted
            lift_sel = lift_sel & (aligned != before)
            res.depth_fit["onlyCeiling"] = True
            if lift_sel.sum() < 0.01 * lift_sel.size:
                res.skipped = f"depth fit too poor and little ceiling ({fit.get('medianRelErr', 'n/a')})"
                say(f"  {tag}: {res.skipped}")
                return res
    stride = cfg.stride_large if mask.mean() > cfg.large_mask else cfg.stride_small
    lifted = G.lift_pixels(filled, aligned, lift_sel, c2w, k, stride=stride)
    # in sky pixels everything in front of the sky goes (streaks hanging in the air)
    res.replaced = replace_old(gs, c2w, k, mask, np.where(sky, 1e4, aligned), gcfg, cfg.replace_margin,
                               above if cfg.replace_above else None)
    if cfg.ceiling_mode and cfg.ceiling is not None:
        # the ceiling the footage only grazed: streaks between the eye and the new ceiling plane go
        res.replaced += replace_old(gs, c2w, k, lift_sel, aligned, gcfg, 1.03, lift_sel, protect_above=cfg.keep_photo_splats)
    gs.append(lifted.means, lifted.scales, lifted.quats, lifted.rgb, opacity=0.9, region=j)
    res.lifted = len(lifted)
    res.seconds["lift"] = round(time.time() - ts, 1)
    mark_soft(gs, c2w, k, mask, gcfg)
    targets.append(make_target(c2w, k, filled, mask, sky, cfg, ocfg))
    ts = time.time()
    quick = OptConfig(**{**ocfg.__dict__, "steps": cfg.quick_steps})
    optimize(gs, targets[-4:], distill, quick, seed=len(targets))
    res.seconds["optimize"] = round(time.time() - ts, 1)
    if cfg.accept_psnr > 0 and len(distill):
        now = seen_psnr(gs, distill)  # against the original world's renders: identical = unbounded
        res.depth_fit["seenPsnr"] = {"mean": round(float(-10 * np.log10(np.mean(10 ** (-now / 10)))), 2), "min": round(float(now.min()), 2)}
        if np.mean(10 ** (-now / 10)) > 10 ** (-cfg.accept_psnr / 10) or now.min() < cfg.accept_min_psnr:
            gs.restore(snap)
            targets.pop()
            res.skipped = (f"reverted: the training views would change too much ({res.depth_fit['seenPsnr']['mean']} dB "
                           f"mean, worst view {now.min():.1f} dB against the original)")
            say(f"  {tag}: {res.skipped}")
            return res
    after = to_u8(render(gs, c2w, k)["rgb"])
    save_png(d / "after.png", after)
    p = v["position"]
    panel = sheet([label(rgb, f"{tag} ({p[0]:+.1f},{p[2]:+.1f}) yaw {v['yaw']:.0f} pitch {v['pitch']:+.0f}: before"),
                   label(mag, f"to fill: {mask.mean():.0%} (holes + unseen/smeared)"),
                   label(filled, f"{res.method}: {res.caption[:70]}"),
                   label(after, f"after (3D): +{res.lifted} splats, -{res.replaced} smear splats")], cols=2)
    save_jpg(d / "panel.jpg", panel, quality=85)
    res.files["panel"] = str(d / "panel.jpg")
    res.seconds["total"] = round(time.time() - t0, 1)
    say(f"  {tag}: {res.method}, mask {mask.mean():.1%}, sky {res.sky_px} px, +{res.lifted} splats, -{res.replaced} replaced, "
        f"depth fit {res.depth_fit.get('medianRelErr', 'n/a')}, {res.seconds['total']}s")
    return res


def ceiling_band(depth: np.ndarray, alpha: np.ndarray, c2w: np.ndarray, k: G.Intr, cfg: FillConfig) -> np.ndarray:
    """Pixels showing the ceiling (the rendered surface within band of the ceiling plane, or nothing) seen more
    steeply than steep_elev: the footage only grazed the ceiling, so from below it is streaks."""
    from .gaps import pixel_elevation

    e = pixel_elevation(c2w, k)
    out = np.zeros(depth.shape, bool)
    cand = e > cfg.steep_elev
    if not cand.any():
        return out
    j, i = np.nonzero(cand)
    d = np.where(alpha[j, i] >= 0.5, depth[j, i], 0.0)
    pts = G.backproject(i + 0.5, j + 0.5, np.maximum(d, 1e-3), c2w, k)
    rays = G.ray_dirs_world(k, c2w, j, i)
    cam_y = float(c2w[1, 3])
    hits_plane = (rays[:, 1] > 0.2) & (cfg.ceiling > cam_y)
    near = hits_plane & ((d <= 0) | (np.abs(pts[:, 1] - cfg.ceiling) < cfg.ceiling_band) | (pts[:, 1] > cfg.ceiling))
    out[j[near], i[near]] = True
    return out


def night_sky(rgb: np.ndarray, c2w: np.ndarray, k: G.Intr, dark: float) -> np.ndarray:
    """Night sky in a filled view: above the horizon, smooth (no fronds, edges or lights) and darker than a lit
    surface, or bluish (a twilight sky the editor slipped in); grown into the dark or bluish fringe around it."""
    from scipy import ndimage

    from .gaps import pixel_elevation

    f = rgb.astype(np.float32) / 255.0
    lum = f @ np.array([0.299, 0.587, 0.114], np.float32)
    mean = ndimage.uniform_filter(lum, 9)
    std = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, 9) - mean * mean, 0.0))
    up = pixel_elevation(c2w, k) > 5.0
    blue = (f[..., 2] > f[..., 0] + 0.04) & (f[..., 2] >= f[..., 1] - 0.02)
    sky = up & (std < 0.04) & ((mean < max(dark, 0.4)) | blue)
    fringe = up & (blue | (lum < 0.2))
    for _ in range(4):
        sky |= ndimage.binary_dilation(sky) & fringe
    return sky


def load_rgb(path: Path) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(path).convert("RGB"))
