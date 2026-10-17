"""People v2, prototype B: cleaner inputs into the same fusion (pipeline/avatar's ground, texture bake and glb).

    python -m pipeline.avatar_v2.clean run --base BASE --eval EVAL --new NEW --video V --poses P --world W --out-dir OUT \
        [--steps all] [--force expo,refine] [--no-expo] [--no-refine] [--no-offsets] [--frames-from DIR]

BASE is a work folder whose hmr.npz holds no held-out detections (holdout.py: v2/work-heldout); its tracks.npz names
the people, so the same detections are refined whatever ground later calls them. Steps, each cached in NEW (--force
re-runs the named ones):
  expo     exposure and white balance per frame from the static background around the people (8 to 120 px off the
           person mask at half size). Frames 1, 2 and 4 steps apart are registered on background features (RANSAC
           homography: the floor dominates, and so little time apart there is hardly any parallax); the flat
           background pixels both see give the lens's fall-off towards the frame edges (how their ratio changes with
           where they sit in each frame) and, once that is taken out, one equation between the two frames' gains.
           The least-squares gains, relative to the median frame, and the fall-off divide the frames. The held-out
           frames get the same model with gains interpolated from their neighbours (for the exposure-matched check,
           not for anything the avatars are made from). (The world's splat colours were the first choice of
           reference, but they cover about a fifth of each frame, without the floor, and follow the frames' colours
           with a slope of 0.2.)                                               -> frames/, heldout-frames/, expo.json
  refine   every detection of the tracked people nudged against its share of the person mask (the yardstick's
           partition at half size on ray-cast silhouettes): a root shift and turn plus small turns of 10 bones (spine,
           neck, upper and lower arms and legs) so that the visible vertices stay on the person's pixels (or behind
           the other player or the table) and every limb's axis runs at least its radius inside them, under a
           Gaussian prior on each turn and shift. A detection keeps its refinement only if its silhouette IoU rises.
           There is no keypoint model in the avatar env, so the masks are the only evidence. A detection whose shins
           and feet are mostly below the frame edge takes the leg turns of the nearest detection that shows them
           (the network's guess for them would steer ground's floor contact)  -> hmr.npz, refine.json
  ground   pipeline/avatar ground + body on the refined detections, with ray-cast silhouettes (raster.silhouette's
           single polygon fill leaves holes) and cut-off detections whose refined fit matches the mask counted as in
           frame, so the motion follows them instead of interpolating over seconds   -> tracks.npz, asset-<k>.npz
  offsets  clothing, hood and backpack volume: in ~150 frames every outer-rim vertex marches outward along its
           projected normal through the person's share of the mask; where it leaves the mask is the cloth's reach
           (runs that end on the other player, the table, the frame edge or the body itself say nothing). Per vertex
           a quantile over the frames (a higher one on the back, hood and hair, where the masks often leave the
           backpack or hood out; both chosen by the silhouette IoU of the check frames), clamped per region
           (backpack side of the torso 25 cm, hood and hair 15 cm, neck 12 cm, torso 10 cm, shorts 9 cm, sleeves
           8 cm, shins 4 cm; face 0.5 cm, hands and feet 2 cm), filled across unobserved vertices and smoothed over
           the mesh; kept if the ray-cast silhouette IoU rises by `min_gain`        -> offsets-<k>.npz/json
  texture  pipeline/avatar texture.bake, unchanged, on the normalised frames, projecting the bodies with their
           offsets (the shipped bake projects the bare network body even when the offsets are kept)
                                                                                -> tex_seen-<k>.png, texture-<k>.json
  fill     unseen texels from their own garment colour: the seen texels of each body region split into a few
           colour clusters (k-means in Lab, near clusters merged), every unseen texel takes the cluster most of its
           3D neighbours on the body carry and their colour, then diffuses within that cluster in the atlas; no
           mirror, no inpainting                                                 -> tex-<k>.jpg, fill-<k>.json
  glb      pipeline/avatar glb                                                   -> OUT/avatar-<k>.glb, avatar.json
"""

from __future__ import annotations

import argparse
import contextlib
import shutil
import sys
import time
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar.util import log, read_json, write_json

STEPS = ["expo", "refine", "ground", "offsets", "texture", "fill", "glb"]

# refine: the bones that turn (each with everything below it) and the limb axes that must stay inside the mask
GROUPS = ("root", "spine03", "neck01", "upperarm01.L", "lowerarm01.L", "upperarm01.R", "lowerarm01.R",
          "upperleg01.L", "lowerleg01.L", "upperleg01.R", "lowerleg01.R")
AXES = (("root", "spine03", 0.11), ("spine03", "neck01", 0.11), ("neck01", "head", 0.06),
        ("upperarm01.L", "lowerarm01.L", 0.04), ("lowerarm01.L", "wrist.L", 0.03),
        ("upperarm01.R", "lowerarm01.R", 0.04), ("lowerarm01.R", "wrist.R", 0.03),
        ("upperleg01.L", "lowerleg01.L", 0.065), ("lowerleg01.L", "foot.L", 0.045),
        ("upperleg01.R", "lowerleg01.R", 0.065), ("lowerleg01.R", "foot.R", 0.045))
SIGMA_ROOT, SIGMA_BONE, SIGMA_SHIFT, SIGMA_DEPTH = 0.06, 0.12, 0.03, 0.01  # rad, rad, m, m
W_AXIS, W_PRIOR = 0.5, 0.1

CREDITS = [
    "Multi-HMR 2 (NAVER, non-commercial licence; BEDLAM and AnnyOne terms)",
    "Anny body model (NAVER, Apache-2.0 code, CC0 assets)",
    "DINOv3 backbone code (DINOv3 License)",
    "Open3D (MIT)",
    "PyTorch (BSD-3-Clause)",
    "OpenCV (Apache-2.0)",
    "pygltflib (MIT)",
]


# ---------------------------------------------------------------------------------------------- silhouettes


def silhouette(V_cv: np.ndarray, tris: np.ndarray, K: np.ndarray, hw: tuple[int, int], scale: float = 1.0,
               min_z: float = 0.05) -> np.ndarray:
    """raster.silhouette by ray casting (Open3D) inside the body's projected box: every pixel centre whose ray hits
    the mesh. raster.silhouette fills all triangles with one polygon fill, which leaves holes where triangles
    overlap (front and back of the body)."""
    import open3d as o3d

    from pipeline.avatar.util import project

    h, w = hw
    out = np.zeros((h, w), bool)
    V = np.ascontiguousarray(V_cv, np.float32)
    t = tris[(V[tris, 2] > min_z).all(1)]
    if len(t) == 0:
        return out
    uv = project(K, V[np.unique(t)].astype(np.float64)) * scale
    x0, y0 = np.maximum(np.floor(uv.min(0)).astype(int), 0)
    x1, y1 = min(int(np.ceil(uv[:, 0].max())) + 1, w), min(int(np.ceil(uv[:, 1].max())) + 1, h)
    if x1 <= x0 or y1 <= y0:
        return out
    u, v = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    d = np.stack([(u - K[0, 2] * scale) / (K[0, 0] * scale), (v - K[1, 2] * scale) / (K[1, 1] * scale), np.ones_like(u)], -1)
    rays = np.concatenate([np.zeros_like(d), d], -1).reshape(-1, 6).astype(np.float32)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V), o3d.core.Tensor(np.ascontiguousarray(t, np.uint32)))
    hit = np.isfinite(scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy())
    out[y0:y1, x0:x1] = hit.reshape(y1 - y0, x1 - x0)
    return out


@contextlib.contextmanager
def patched(trusted: np.ndarray | None = None, hw: tuple[int, int] | None = None):
    """pipeline/avatar with ray-cast silhouettes and, for ground.solve, the detections flagged in `trusted` counted as
    in frame (cut off by the frame edge, but their refined fit agrees with the person's mask)."""
    from pipeline.avatar import ground, raster

    old_sil, old_proj = raster.silhouette, ground.project

    def project(K, X):
        uv = old_proj(K, X)
        if trusted is not None and uv.ndim == 3 and len(uv) == len(trusted) and trusted.any():
            uv[trusted] = np.clip(uv[trusted], 0, [hw[1] - 1, hw[0] - 1])
        return uv

    raster.silhouette, ground.project = silhouette, project
    try:
        yield
    finally:
        raster.silhouette, ground.project = old_sil, old_proj


def owners(U: np.ndarray, Vs: list[np.ndarray], tris: np.ndarray, K: np.ndarray, size: tuple[int, int], scale: float,
           reach_m: float = 0.30):
    """Who every pixel of the person mask U (at `scale`) belongs to (index into Vs, -1 = nobody): the front-most body
    where a body covers it, else the nearest body silhouette within reach_m at that body's depth (backpacks, hoods,
    hair); the yardstick's partition on ray-cast silhouettes. Also returns each body's silhouette and the depth and
    body-id maps of all of them. `size`: the full frame (H, W)."""
    import cv2

    from pipeline.avatar import raster

    h, w = U.shape
    owner = np.full((h, w), -1, np.int64)
    if not Vs:
        return owner, [], np.full((h, w), np.inf), np.full((h, w), -1)
    rend = raster.DepthRenderer(K, size[1], size[0], scale=scale)
    depth, mid, _, _ = rend.render([(V, tris) for V in Vs])
    owner[mid >= 0] = mid[mid >= 0]
    sils = [silhouette(V, tris, K, (h, w), scale) for V in Vs]
    D = np.full((len(Vs), h, w), np.inf, np.float32)
    for i, (V, S) in enumerate(zip(Vs, sils)):
        dt = cv2.distanceTransform((~S).astype(np.uint8), cv2.DIST_L2, 5)
        reach = reach_m * K[0, 0] * scale / max(float(np.median(V[:, 2])), 0.3)
        D[i] = np.where(dt <= reach, dt, np.inf)
    rest = U & (owner < 0) & np.isfinite(D.min(0))
    owner[rest] = np.argmin(D, 0)[rest]
    return owner, sils, depth, mid


def table_mask(occ, Tf: np.ndarray, K: np.ndarray, size: tuple[int, int], scale: float, bodies_world: list[np.ndarray],
               depth_own: np.ndarray, z_med: float, sigma: float, U: np.ndarray, margin: float = 0.10) -> np.ndarray:
    """Pixels (at `scale`, outside the person mask) where furniture stands more than `margin` in front of the body:
    the person's mask cannot reach there, so nothing about the body may be read from them."""
    import cv2

    h, w = U.shape
    furn = occ.depth(Tf, K, size, bodies_world, scale=0.125)
    furn = cv2.resize(furn, (w, h), interpolation=cv2.INTER_NEAREST)
    z = np.where(np.isfinite(depth_own), depth_own, z_med)
    T = (furn < sigma * z - margin).astype(np.uint8)
    T = cv2.dilate(T, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0
    return T & ~U


# --------------------------------------------------------------------------------------------------- expo


def background(mask_prob: np.ndarray, hw: tuple[int, int], near: int, far: int) -> tuple[np.ndarray, np.ndarray]:
    """(usable background, ring around the people) at size hw from a person probability mask: off the people by
    `near` px, within `far` px of them."""
    import cv2

    U = cv2.resize(mask_prob, (hw[1], hw[0]), interpolation=cv2.INTER_LINEAR) > 127
    u8 = U.astype(np.uint8)
    off = ~(cv2.dilate(u8, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * near + 1, 2 * near + 1))) > 0)
    ring = cv2.dilate(u8, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * far + 1, 2 * far + 1))) > 0
    return off, ring & off


def radius2(xy: np.ndarray, hw: tuple[int, int]) -> np.ndarray:
    """Squared distance from the image centre in units of half the image width."""
    return ((xy[..., 0] - hw[1] / 2) ** 2 + (xy[..., 1] - hw[0] / 2) ** 2) / (hw[1] / 2) ** 2


def pair_samples(a: dict, b: dict, matcher, min_inliers: int = 40, n: int = 3000, rng=None):
    """Log colour ratios a / b (m, 3) of the static background around the people that both frames see, with the
    pixel's squared radius in a and in b ((m, 2) each: r^2, r^4), after registering b onto a with a RANSAC homography
    of background features (the floor dominates the ring, and frames 1/30 to 1/8 s apart barely show parallax).
    Only flat pixels count (a pixel of residual misregistration then does not change the colour), and of those only
    the ones within 0.1 of the median ratio. None when the frames do not register."""
    import cv2

    if a["des"] is None or b["des"] is None or len(a["kp"]) < min_inliers or len(b["kp"]) < min_inliers:
        return None
    m = matcher.knnMatch(b["des"], a["des"], k=2)
    good = [p[0] for p in m if len(p) == 2 and p[0].distance < 0.8 * p[1].distance]
    if len(good) < min_inliers:
        return None
    pb = np.float32([b["kp"][g.queryIdx].pt for g in good])
    pa = np.float32([a["kp"][g.trainIdx].pt for g in good])
    H, inl = cv2.findHomography(pb, pa, cv2.RANSAC, 2.0)
    if H is None or int(inl.sum()) < min_inliers:
        return None
    h, w = a["img"].shape[:2]
    wb = cv2.warpPerspective(b["img"], H, (w, h), flags=cv2.INTER_LINEAR)
    wm = cv2.warpPerspective(b["off"].astype(np.uint8), H, (w, h), flags=cv2.INTER_NEAREST) > 0
    ok = a["ring"] & wm & a["flat"] & (cv2.warpPerspective(b["flat"].astype(np.uint8), H, (w, h), flags=cv2.INTER_NEAREST) > 0)
    ok &= (a["img"].min(-1) > 12) & (a["img"].max(-1) < 245) & (wb.min(-1) > 12) & (wb.max(-1) < 245)
    ys, xs = np.nonzero(ok)
    if len(ys) < 500:
        return None
    r = np.log(a["img"][ys, xs].astype(np.float32)) - np.log(wb[ys, xs].astype(np.float32))
    keep = (np.abs(r - np.median(r, 0)) < 0.1).all(1)
    if keep.sum() < 300:
        return None
    ys, xs, r = ys[keep], xs[keep], r[keep]
    if len(r) > n:
        s = (rng or np.random.default_rng(0)).choice(len(r), n, replace=False)
        ys, xs, r = ys[s], xs[s], r[s]
    q = np.stack([xs + 0.5, ys + 0.5, np.ones(len(xs))], 1) @ np.linalg.inv(H).T
    ra = radius2(np.stack([xs + 0.5, ys + 0.5], 1), (h, w))
    rb = radius2(q[:, :2] / q[:, 2:], (h, w))
    return r, np.stack([ra, ra * ra], 1), np.stack([rb, rb * rb], 1), int(keep.sum())


def step_expo(base: Path, new: Path, held: set, scale: float = 0.5, near: int = 8, far: int = 120,
              gaps: tuple[int, ...] = (1, 2, 4)) -> dict:
    """Per-frame exposure and white balance, and the lens's fall-off towards the frame edges, from the static
    background around the people (see the module docstring). Every registered pair of frames gives, per pixel,
    log a - log b = (g_a - g_b) + v(r_a) - v(r_b) with v(r) = c1 r^2 + c2 r^4 per channel: the fall-off comes from how
    the ratio varies inside each pair (the gains are constant there), then each pair's mean corrected ratio is one
    equation between two gains; the least-squares gains are relative to the median frame. Frames are divided by
    their gain and by the fall-off."""
    import cv2
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import lsqr

    h = np.load(base / "hmr.npz")
    times = {int(f): float(t) for f, t in zip(h["used_frames"], h["used_times"])}
    frames = [int(f) for f in h["used_frames"] if int(f) not in held and (base / "frames" / f"f{int(f):06d}.jpg").exists()]
    orb = cv2.ORB_create(3000, fastThreshold=12)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    rng = np.random.default_rng(0)
    data = []
    hw = None
    for f in frames:
        img = cv2.imread(str(base / "frames" / f"f{f:06d}.jpg"))
        mk = cv2.imread(str(base / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        hw = (int(round(img.shape[0] * scale)), int(round(img.shape[1] * scale)))
        small = cv2.resize(img, (hw[1], hw[0]), interpolation=cv2.INTER_AREA)
        off, ring = background(mk, hw, near, far)
        g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gb = cv2.GaussianBlur(g, (5, 5), 1.2).astype(np.float32)
        flat = np.hypot(cv2.Sobel(gb, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(gb, cv2.CV_32F, 0, 1, ksize=3)) < 48.0  # ~12 levels/px
        kp, des = orb.detectAndCompute(g, off.astype(np.uint8) * 255)
        data.append({"img": cv2.GaussianBlur(small, (3, 3), 0)[:, :, ::-1], "off": off, "ring": ring, "flat": flat,
                     "kp": kp, "des": des})
    pairs = []
    for gap in gaps:
        for i in range(len(frames) - gap):
            r = pair_samples(data[i], data[i + gap], matcher, rng=rng)
            if r is not None:
                pairs.append((i, i + gap) + r)
        log("expo", f"frames {gap} apart: {sum(1 for p in pairs if p[1] - p[0] == gap)} pairs registered")
    del data
    # the lens fall-off: within each pair, ratio - its mean against (r_a - r_b) - its mean
    Xs = np.concatenate([(p[3] - p[4]) - (p[3] - p[4]).mean(0) for p in pairs])
    Ys = np.concatenate([p[2] - p[2].mean(0) for p in pairs])
    vig = np.zeros((2, 3))
    for c in range(3):
        coef = np.linalg.lstsq(Xs, Ys[:, c], rcond=None)[0]
        ok = np.abs(Ys[:, c] - Xs @ coef) < 0.06
        vig[:, c] = np.linalg.lstsq(Xs[ok], Ys[ok, c], rcond=None)[0]
    rows, cols, vals, rhs, meas = [], [], [], [], []
    for e, (i, j, r, Da, Db, npx) in enumerate(pairs):
        ratio = (r - (Da - Db) @ vig).mean(0)
        w = float(np.sqrt(min(npx, 20000) / 1000.0)) / (j - i)
        rows += [e, e]
        cols += [i, j]
        vals += [w, -w]
        rhs.append(w * ratio)
        meas.append((i, j, ratio))
    n, e = len(frames), len(rhs)
    # gauge: a weak pull of every frame to 0 (the solution is then re-centred on the median frame)
    rows += list(range(e, e + n))
    cols += list(range(n))
    vals += [1e-3] * n
    A = coo_matrix((vals, (rows, cols)), shape=(e + n, n)).tocsr()
    B = np.concatenate([np.asarray(rhs).reshape(-1, 3), np.zeros((n, 3))])
    x = np.stack([lsqr(A, B[:, c], atol=1e-10, btol=1e-10)[0] for c in range(3)], 1)
    x -= np.median(x, 0)
    g = np.exp(np.clip(x, np.log(0.6), np.log(1.6)))
    resid = np.array([np.abs(ratio - (x[i] - x[j])).max() for i, j, ratio in meas]) if meas else np.zeros(1)
    H, W = cv2.imread(str(base / "frames" / f"f{frames[0]:06d}.jpg")).shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    r2 = radius2(np.stack([(xx + 0.5) * scale, (yy + 0.5) * scale], -1), hw)
    fall = np.exp(np.stack([vig[0, c] * r2 + vig[1, c] * r2 * r2 for c in range(3)], -1))[:, :, ::-1].astype(np.float32)
    # the held-out frames get the same camera model, with gains interpolated from their neighbours in time (none of
    # their own pixels is used), for the exposure-matched check of the yardstick (--frames NEW/heldout-frames)
    t_used = np.array([times[f] for f in frames])
    held_f = sorted(f for f in held if f in times)
    g_held = np.exp(np.stack([np.interp([times[f] for f in held_f], t_used, np.log(g[:, c])) for c in range(3)], 1))
    for folder, fs, gs in (("frames", frames, g), ("heldout-frames", held_f, g_held)):
        out = new / folder
        out.mkdir(parents=True, exist_ok=True)
        for f, gf in zip(fs, gs):
            img = cv2.imread(str(base / "frames" / f"f{f:06d}.jpg")).astype(np.float32)
            img /= gf[::-1][None, None, :] * fall
            cv2.imwrite(str(out / f"f{f:06d}.jpg"), np.clip(img + 0.5, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])
    lum = g @ np.array([0.299, 0.587, 0.114])
    linked = np.zeros(n, np.int64)
    for i, j, _ in meas:
        linked[i] += 1
        linked[j] += 1
    corner = float(np.exp((vig[:, 1] * [1.3125, 1.3125 ** 2]).sum()))  # 16:9 corner, green
    edge = float(np.exp((vig[:, 1] * [1.0, 1.0]).sum()))
    rep = {"frames": n, "pairs": len(pairs), "framesWithoutPairs": int((linked == 0).sum()),
           "falloff": {"c1": [round(float(v), 4) for v in vig[0]], "c2": [round(float(v), 4) for v in vig[1]],
                       "greenAtSideEdge": round(edge, 3), "greenAtCorner": round(corner, 3)},
           "pairResidual": {"median": round(float(np.median(resid)), 4), "p95": round(float(np.percentile(resid, 95)), 4)},
           "gain": {"lumP5": round(float(np.percentile(lum, 5)), 3), "lumP50": round(float(np.median(lum)), 3),
                    "lumP95": round(float(np.percentile(lum, 95)), 3), "lumMin": round(float(lum.min()), 3), "lumMax": round(float(lum.max()), 3),
                    "redOverBlueP5": round(float(np.percentile(g[:, 0] / g[:, 2], 5)), 3),
                    "redOverBlueP95": round(float(np.percentile(g[:, 0] / g[:, 2], 95)), 3)},
           "perFrame": [{"frame": f, "time": round(times[f], 4), "gain": [round(float(v), 4) for v in g[i]], "pairs": int(linked[i])}
                        for i, f in enumerate(frames)]}
    write_json(new / "expo.json", rep)
    draw_gain(new / "evidence" / "expo-gain.png", [times[f] for f in frames], g)
    log("expo", f"{ {k: v for k, v in rep.items() if k != 'perFrame'} }")
    return rep


def draw_gain(path: Path, t: list[float], g: np.ndarray, w: int = 1100, h: int = 360) -> None:
    import cv2

    path.parent.mkdir(parents=True, exist_ok=True)
    img = np.full((h, w, 3), 255, np.uint8)
    t1 = max(t) if t else 1.0
    lo, hi = np.log(0.5), np.log(1.6)

    def px(tt, gg):
        return int(40 + tt / max(t1, 1e-6) * (w - 60)), int(h - 30 - (np.log(gg) - lo) / (hi - lo) * (h - 60))

    for gv in (0.6, 0.8, 1.0, 1.25, 1.5):
        y = px(0, gv)[1]
        cv2.line(img, (40, y), (w - 20, y), (225, 225, 225), 1)
        cv2.putText(img, f"{gv:.2f}", (2, y + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (90, 90, 90), 1, cv2.LINE_AA)
    for s in range(int(t1) + 1):
        cv2.putText(img, f"{s}s", (px(s, 1)[0] - 6, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (90, 90, 90), 1, cv2.LINE_AA)
    for c, col in enumerate([(40, 40, 220), (40, 160, 40), (220, 90, 30)]):  # BGR for the R, G, B gains
        cv2.polylines(img, [np.array([px(tt, gg) for tt, gg in zip(t, g[:, c])], np.int32).reshape(-1, 1, 2)], False, col, 2)
    cv2.putText(img, "per frame: exposure and white-balance gain from the background around the people, relative to the "
                     "median frame (red, green, blue)", (10, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1, cv2.LINE_AA)
    cv2.imwrite(str(path), img)


# ------------------------------------------------------------------------------------------------- refine


class Rig:
    """The refinement's few moving parts on the full skeleton: every bone follows its nearest ancestor in GROUPS
    (or itself), so the skinned body moves as sum_g W_g(v) D_g v with one rigid transform D_g per group. Exact for
    rigid parts, within 2 mm of the body model's own skinning for turns under 10 degrees."""

    def __init__(self, labels, parents: np.ndarray, weights: np.ndarray, indices: np.ndarray, stride: int = 3):
        lab = [str(x) for x in labels]
        gid = {lab.index(g): i for i, g in enumerate(GROUPS)}
        grp = np.zeros(len(lab), np.int64)
        for j in range(len(lab)):
            p = j
            while p not in gid:
                p = int(parents[p])
            grp[j] = gid[p]
        self.grp = grp
        self.joint = np.array([lab.index(g) for g in GROUPS])
        self.gparent = np.array([-1] + [int(grp[parents[lab.index(g)]]) for g in GROUPS[1:]])
        nv = len(weights)
        self.GW = np.zeros((nv, len(GROUPS)))
        np.add.at(self.GW, (np.repeat(np.arange(nv), weights.shape[1]), grp[indices].ravel()), weights.ravel())
        self.sub = np.arange(0, nv, stride)
        s = np.array([0.15, 0.35, 0.5, 0.65, 0.85])
        self.ax_from = np.repeat([lab.index(a) for a, _, _ in AXES], len(s))
        self.ax_to = np.repeat([lab.index(b) for _, b, _ in AXES], len(s))
        self.ax_s = np.tile(s, len(AXES))
        self.ax_r = np.repeat([r for _, _, r in AXES], len(s))
        self.ax_group = grp[self.ax_from]

    def axis_points(self, J: np.ndarray) -> np.ndarray:
        """Points along the limb axes from camera-space joint positions J (bones, 3)."""
        s = self.ax_s[:, None]
        return (1 - s) * J[self.ax_from] + s * J[self.ax_to]

    def compose(self, w, t, C):
        """Per group rigid transforms (B, G, 3, 3), (B, G, 3) from turn vectors w (B, G, 3) about the groups' joints
        C (B, G, 3) and the root shift t (B, 3); a group's transform includes its ancestors'."""
        import torch

        R = rotvec(w)
        Rs, Ts = [], []
        for g in range(len(GROUPS)):
            Rg = R[:, g]
            Tg = C[:, g] - (Rg @ C[:, g, :, None])[..., 0]
            if g == 0:
                Tg = Tg + t
            else:
                p = int(self.gparent[g])
                Tg = (Rs[p] @ Tg[..., None])[..., 0] + Ts[p]
                Rg = Rs[p] @ Rg
            Rs.append(Rg)
            Ts.append(Tg)
        return torch.stack(Rs, 1), torch.stack(Ts, 1)

    def apply(self, V: np.ndarray, R: np.ndarray, T: np.ndarray) -> np.ndarray:
        """numpy: vertices V (N, 3) moved by group transforms R (G, 3, 3), T (G, 3) with the full weights."""
        return np.einsum("ng,gij,nj->ni", self.GW, R, V) + self.GW @ T


def rotvec(w):
    """Rotation matrices (..., 3, 3) of turn vectors (..., 3) (Rodrigues; first-order exact at zero)."""
    import torch

    th = w.norm(dim=-1, keepdim=True).clamp_min(1e-8)
    k = w / th
    z = torch.zeros_like(k[..., 0])
    Kx = torch.stack([z, -k[..., 2], k[..., 1], k[..., 2], z, -k[..., 0], -k[..., 1], k[..., 0], z], -1).reshape(k.shape[:-1] + (3, 3))
    s, c = torch.sin(th)[..., None], torch.cos(th)[..., None]
    return torch.eye(3, dtype=w.dtype) + s * Kx + (1 - c) * (Kx @ Kx)


def sample_map(m, uv, hw):
    """Bilinear samples of maps m (B, 1, h, w) at pixel coordinates uv (B, N, 2) (pixel centres at i + 0.5)."""
    import torch
    import torch.nn.functional as F

    h, w = hw
    grid = torch.stack([uv[..., 0] * 2.0 / w - 1.0, uv[..., 1] * 2.0 / h - 1.0], -1)[:, :, None, :]
    return F.grid_sample(m, grid, mode="bilinear", padding_mode="border", align_corners=False)[:, 0, :, 0]


def fit_batch(items: list[dict], rig: Rig, Kh: np.ndarray, hw: tuple[int, int], iters: int = 60) -> list[tuple[np.ndarray, np.ndarray]]:
    """Refines a batch of detections at once; returns per item (R (G,3,3), T (G,3)) and fills item['loss']."""
    import torch
    import torch.nn.functional as F

    f32 = torch.float32
    V = torch.tensor(np.stack([it["V"][rig.sub] for it in items]), dtype=f32)
    C = torch.tensor(np.stack([it["J"][rig.joint] for it in items]), dtype=f32)
    AX = torch.tensor(np.stack([rig.axis_points(it["J"]) for it in items]), dtype=f32)
    RAD = torch.tensor(np.stack([it["rad"] for it in items]), dtype=f32)
    VIS = torch.tensor(np.stack([it["vis"] for it in items]), dtype=f32)
    Dout = torch.tensor(np.stack([it["dout"] for it in items])[:, None], dtype=f32)
    Din = torch.tensor(np.stack([it["din"] for it in items])[:, None], dtype=f32)
    GW = torch.tensor(rig.GW[rig.sub], dtype=f32)
    ga = torch.tensor(rig.ax_group)
    fx, fy, cx, cy = (float(Kh[0, 0]), float(Kh[1, 1]), float(Kh[0, 2]), float(Kh[1, 2]))
    h, w = hw
    B, G = len(items), len(GROUPS)
    wv = torch.zeros(B, G, 3, dtype=f32, requires_grad=True)
    tv = torch.zeros(B, 3, dtype=f32, requires_grad=True)
    opt = torch.optim.Adam([{"params": [wv], "lr": 0.01}, {"params": [tv], "lr": 0.003}])
    sig = torch.full((G,), SIGMA_BONE, dtype=f32)
    sig[0] = SIGMA_ROOT

    def proj(X):
        z = X[..., 2].clamp_min(0.1)
        return torch.stack([fx * X[..., 0] / z + cx, fy * X[..., 1] / z + cy], -1)

    def inside(uv):
        return ((uv[..., 0] >= 0) & (uv[..., 0] < w) & (uv[..., 1] >= 0) & (uv[..., 1] < h)).to(f32)

    def losses():
        R, T = rig.compose(wv, tv, C)
        Vd = torch.einsum("ng,bgij,bnj->bni", GW, R, V) + torch.matmul(GW, T)
        uv = proj(Vd)
        m = VIS * inside(uv)
        do = sample_map(Dout, uv, hw)
        lo = (F.huber_loss(do, torch.zeros_like(do), reduction="none", delta=2.0) * m).sum(1) / m.sum(1).clamp_min(1)
        Ax = torch.einsum("bnij,bnj->bni", R[:, ga], AX) + T[:, ga]
        ua = proj(Ax)
        ma = inside(ua)
        la = (torch.relu(RAD - sample_map(Din, ua, hw)) * ma).sum(1) / ma.sum(1).clamp_min(1)
        pr = ((wv / sig[None, :, None]) ** 2).sum((1, 2)) + (tv[:, :2] ** 2).sum(1) / SIGMA_SHIFT ** 2 + tv[:, 2] ** 2 / SIGMA_DEPTH ** 2
        return lo, la, pr, R, T

    with torch.no_grad():
        lo0, la0, _, _, _ = losses()
    for _ in range(iters):
        lo, la, pr, _, _ = losses()
        loss = (lo + W_AXIS * la + W_PRIOR * pr).sum()
        opt.zero_grad()
        loss.backward()
        opt.step()
    with torch.no_grad():
        lo, la, pr, R, T = losses()
    out = []
    for b, it in enumerate(items):
        it["loss"] = {"outsidePx": [round(float(lo0[b]), 3), round(float(lo[b]), 3)],
                      "axisPx": [round(float(la0[b]), 3), round(float(la[b]), 3)], "prior": round(float(pr[b]), 3),
                      "turnDeg": [round(float(np.degrees(x)), 2) for x in wv[b].norm(dim=-1).detach().numpy()],
                      "shiftCm": [round(100 * float(x), 2) for x in tv[b].detach().numpy()]}
        out.append((R[b].double().numpy(), T[b].double().numpy()))
    return out


def iou_in(S: np.ndarray, M: np.ndarray, valid: np.ndarray) -> tuple[float, float, float]:
    from pipeline.avatar.ground import padded_box

    box = padded_box(S | M) & valid
    inter = np.count_nonzero(S & M & box)
    return (inter / max(1, np.count_nonzero((S | M) & box)), inter / max(1, np.count_nonzero(S & box)),
            inter / max(1, np.count_nonzero(M & box)))


def step_refine(base: Path, new: Path, poses: Path, world: Path | None, scale: float = 0.5, batch: int = 24,
                iters: int = 60, evidence: int = 8, only: set | None = None) -> dict:
    """`only`: refine these frames alone (a quick look at the weights)."""
    import cv2
    import torch

    from pipeline.avatar import body
    from pipeline.avatar.body import Asset
    from pipeline.avatar.ground import camera_track
    from pipeline.avatar.util import project

    torch.set_num_threads(max(1, int(__import__("os").environ.get("OMP_NUM_THREADS", "8"))))
    h = dict(np.load(base / "hmr.npz"))
    tr = np.load(base / "tracks.npz")
    doc = read_json(poses)
    W, H = int(doc["intrinsics"]["width"]), int(doc["intrinsics"]["height"])
    K = h["K"].astype(np.float64)
    Kh = K.copy()
    Kh[:2] *= scale
    hh, wh = int(round(H * scale)), int(round(W * scale))
    a0 = Asset.load(base / "asset-0.npz")
    tris = a0.src_vertex[a0.tris]
    labels = [str(x) for x in tr["bone_labels"]]
    parents = tr["bone_parents"]
    m = body.build_anny()
    st = body.anny_static(m)
    rig = Rig(labels, parents, st["weights"].astype(np.float64), st["indices"].astype(np.int64))
    v3d = h["v3d"].astype(np.float64)
    G = h["bone_poses"].astype(np.float64)
    tp = h["transl_pelvis"].astype(np.float64)
    frame_of = h["frame"]
    n_people = sum(1 for k in tr.files if k.endswith("/rest_vertices"))
    person_of, sigma = {}, {}
    for k in range(n_people):
        for d in tr[f"person-{k}/det"]:
            if d >= 0:
                person_of[int(d)] = k
        sigma[k] = float(tr.get(f"person-{k}/body_scale", 1.0))
    cams = camera_track(doc)
    occ = None
    if world is not None and Path(world).exists():
        from pipeline.avatar.world import Occluders

        occ = Occluders(Path(world))
    se3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    newV, newG, newT = v3d.copy(), G.copy(), tp.copy()
    j2d = h["j2d"].astype(np.float64).copy()
    rows: dict[int, dict] = {}
    shots = []
    pending: list[dict] = []

    def flush():
        if not pending:
            return
        res = fit_batch(pending, rig, Kh, (hh, wh), iters)
        for it, (R, T) in zip(pending, res):
            d = it["det"]
            Vn = rig.apply(v3d[d], R, T)
            S0 = silhouette(v3d[d], tris, K, (hh, wh), scale)
            S1 = silhouette(Vn, tris, K, (hh, wh), scale)
            i0, i1 = iou_in(S0, it["M"], it["valid"]), iou_in(S1, it["M"], it["valid"])
            keep = i1[0] > i0[0] + 0.002
            Jc = tp[d] + G[d, :, :3, 3]
            if keep:
                gr = rig.grp
                newV[d] = Vn
                Gc = G[d].copy()
                Gc[:, :3, 3] = Jc
                Rg, Tg = R[gr], T[gr]
                Gn = Gc.copy()
                Gn[:, :3, :3] = Rg @ Gc[:, :3, :3]
                Gn[:, :3, 3] = np.einsum("jab,jb->ja", Rg, Jc) + Tg
                newT[d] = Gn[0, :3, 3]
                Gn[:, :3, 3] -= newT[d]
                newG[d] = Gn
                j2d[d] += project(K, Gn[:, :3, 3] + newT[d]) - project(K, Jc)
            uvd = project(K, (newV[d] if keep else v3d[d])[::4])
            in_frame = float(((uvd[:, 0] >= 0) & (uvd[:, 0] < W) & (uvd[:, 1] >= 0) & (uvd[:, 1] < H)).mean())
            rows[d] = {"det": d, "frame": int(frame_of[d]), "person": person_of[d], "kept": bool(keep),
                       "iou": [round(i0[0], 4), round(i1[0], 4)], "precision": [round(i0[1], 4), round(i1[1], 4)],
                       "recall": [round(i0[2], 4), round(i1[2], 4)], "inFrame": round(in_frame, 3), **it["loss"]}
            shots.append((i1[0] - i0[0], d, it["M"], it["valid"], S0, S1))
        pending.clear()

    used = [int(f) for f in h["used_frames"]]
    t0 = time.time()
    for n, f in enumerate(used):
        dets = np.nonzero(frame_of == f)[0]
        mine = [int(d) for d in dets if int(d) in person_of]
        if not mine or (only is not None and f not in only):
            continue
        mk = cv2.imread(str(base / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if mk is None:
            continue
        U = cv2.resize(mk, (wh, hh), interpolation=cv2.INTER_LINEAR) > 127
        Vs = [v3d[d] for d in dets]
        owner, _, depth, mid = owners(U, Vs, tris, K, (H, W), scale)
        bodies = None
        if occ is not None and f in cams:
            Tf = cams[f]
            bodies = [(sigma.get(person_of.get(int(o), -1), 1.0) * v3d[o][::4]) @ Tf[:3, :3].T + Tf[:3, 3] for o in dets]
        for d in mine:
            i = int(np.nonzero(dets == d)[0][0])
            M = U & (owner == i)
            O = U & ~M
            T = np.zeros_like(U)
            if bodies is not None:
                T = table_mask(occ, cams[f], K, (H, W), scale, bodies, np.where(mid == i, depth, np.inf),
                               float(np.median(v3d[d][:, 2])), sigma[person_of[d]], U)
            allowed = M | O | T
            if M.sum() < 200:
                continue
            dout = cv2.distanceTransform((~allowed).astype(np.uint8), cv2.DIST_L2, 5)
            din = cv2.distanceTransform(cv2.erode(allowed.astype(np.uint8), se3), cv2.DIST_L2, 5)
            Vsub = v3d[d][rig.sub]
            uv = project(Kh, Vsub)
            x = np.clip(uv[:, 0].astype(np.int64), 0, wh - 1)
            y = np.clip(uv[:, 1].astype(np.int64), 0, hh - 1)
            vis = (depth[y, x] >= Vsub[:, 2] - 0.03).astype(np.float32)
            J = tp[d] + G[d, :, :3, 3]
            ax = rig.axis_points(J)
            rad = rig.ax_r * Kh[0, 0] / np.maximum(ax[:, 2], 0.3)
            pending.append({"det": d, "V": v3d[d], "J": J, "vis": vis, "dout": dout, "din": din, "rad": rad,
                            "M": M, "valid": ~O & ~T})
            if len(pending) >= batch:
                flush()
        if n % 40 == 0:
            log("refine", f"frame {f} ({n + 1}/{len(used)}), {len(rows)} detections refined, {time.time() - t0:.0f} s")
    flush()
    borrowed = borrow_legs(m, st, labels, parents, h, newV, newG, newT, j2d, person_of, K, (H, W))
    out = dict(h)
    out["v3d"] = newV.astype(np.float16)
    out["bone_poses"] = newG.astype(np.float32)
    out["transl_pelvis"] = newT.astype(np.float32)
    out["j2d"] = j2d.astype(np.float32)
    np.savez(new / "hmr.npz", **out)
    det_ids = np.array(sorted(rows), np.int64)
    in_frame = np.array([rows[d]["inFrame"] for d in det_ids])
    iou_after = np.array([rows[d]["iou"][1] if rows[d]["kept"] else rows[d]["iou"][0] for d in det_ids])
    trusted = np.zeros(len(h["frame"]), bool)
    trusted[det_ids] = (in_frame < 0.9) & (in_frame >= 0.5) & (iou_after >= 0.6)
    np.savez(new / "refine.npz", det=det_ids, trusted=trusted, iou_after=iou_after, in_frame=in_frame)
    rep: dict = {"detections": len(rows), "seconds": round(time.time() - t0, 1), "legsBorrowed": borrowed, "people": {}}
    for k in range(n_people):
        rs = [r for r in rows.values() if r["person"] == k]
        if not rs:
            continue
        kept = [r for r in rs if r["kept"]]
        rep["people"][f"person-{k}"] = {
            "detections": len(rs), "kept": round(len(kept) / len(rs), 3),
            "iouBefore": round(float(np.median([r["iou"][0] for r in rs])), 4),
            "iouAfter": round(float(np.median([r["iou"][1] if r["kept"] else r["iou"][0] for r in rs])), 4),
            "precisionAfter": round(float(np.median([r["precision"][1] if r["kept"] else r["precision"][0] for r in rs])), 4),
            "recallAfter": round(float(np.median([r["recall"][1] if r["kept"] else r["recall"][0] for r in rs])), 4),
            "turnDegMedian": round(float(np.median([np.max(r["turnDeg"]) for r in kept])), 2) if kept else None,
            "shiftCmMedian": round(float(np.median([np.linalg.norm(r["shiftCm"]) for r in kept])), 2) if kept else None,
            "cutOffTrusted": int(trusted[[r["det"] for r in rs]].sum()),
            "cutOff": int(sum(1 for r in rs if r["inFrame"] < 0.9))}
    rep["perDetection"] = [rows[d] for d in det_ids]
    write_json(new / "refine.json", rep)
    draw_refine(base, new / "evidence", shots, frame_of, scale, evidence)
    log("refine", f"{ {k: v for k, v in rep.items() if k != 'perDetection'} }")
    return rep


def borrow_legs(m, st: dict, labels: list[str], parents: np.ndarray, h: dict, V: np.ndarray, G: np.ndarray, T: np.ndarray,
                j2d: np.ndarray, person_of: dict, K: np.ndarray, size: tuple[int, int], out_min: float = 0.5,
                in_min: float = 0.9, max_gap: float = 2.0) -> dict:
    """Legs below the frame edge are the network's guess, and ground's floor contact follows that guess (a bent
    guessed leg slides the whole body along its ray). A detection whose shins and feet are mostly outside the frame
    takes the leg turns (local rotations; its own bone lengths) of the nearest detection of the same person, within
    `max_gap` seconds, that shows them; its vertices are skinned again by the body model. Edits V, G, j2d in place."""
    from pipeline.avatar import body
    from pipeline.avatar.ground import topo_order
    from pipeline.avatar.util import project, rigid_inv

    leg = np.array([any(lab.startswith(p) for p in ("upperleg", "lowerleg", "foot", "toe")) for lab in labels])
    low = np.array([any(lab.startswith(p) for p in ("lowerleg", "foot", "toe")) for lab in labels])
    nv = V.shape[1]
    shin = low[st["indices"][np.arange(nv), np.argmax(st["weights"], 1)]]  # vertices whose main bone is below the knee
    H, W = size
    frac = {}
    for d in person_of:
        uv = project(K, V[d][shin])
        frac[d] = float(((uv[:, 0] < 0) | (uv[:, 0] >= W) | (uv[:, 1] < 0) | (uv[:, 1] >= H)).mean())
    n_ph = len(st["phenotype_labels"])
    order = [j for j in topo_order(parents) if leg[j]]
    done = {}
    for d, f_out in frac.items():
        if f_out < out_min:
            continue
        k = person_of[d]
        src = [s for s, f in frac.items() if person_of[s] == k and f <= 1 - in_min and abs(h["time"][s] - h["time"][d]) <= max_gap]
        if not src:
            continue
        s = min(src, key=lambda x: abs(h["time"][x] - h["time"][d]))
        Gd = G[d].copy()
        for j in order:
            p = int(parents[j])
            loc_s = rigid_inv(G[s][p]) @ G[s][j]
            loc_d = rigid_inv(G[d][p]) @ G[d][j]
            loc = loc_d.copy()
            loc[:3, :3] = loc_s[:3, :3]
            Gd[j] = Gd[p] @ loc
        Vn = body.anny_posed(m, h["shape"][d, :n_ph].astype(np.float64)[None], Gd[None])[0] + T[d]
        j2d[d, leg] += project(K, Gd[leg, :3, 3] + T[d]) - project(K, G[d][leg, :3, 3] + T[d])
        G[d], V[d] = Gd, Vn
        done[int(d)] = int(s)
    log("refine", f"legs borrowed for {len(done)} cut-off detections")
    return {"detections": len(done), "pairs": [[d, s] for d, s in sorted(done.items())][:400]}


def draw_refine(base: Path, ev: Path, shots: list, frame_of: np.ndarray, scale: float, n: int) -> None:
    """The detections whose IoU rose most: the person's share of the mask (red), the network body (yellow outline)
    and the refined body (green outline)."""
    import cv2

    from pipeline.avatar_v2 import yardstick as ys

    ev.mkdir(parents=True, exist_ok=True)
    shots = sorted(shots, key=lambda s: -s[0])
    pick = shots[: n // 2] + shots[len(shots) // 2: len(shots) // 2 + n - n // 2]
    tiles = []
    for gain, d, M, valid, S0, S1 in pick:
        img = cv2.imread(str(base / "frames" / f"f{int(frame_of[d]):06d}.jpg"))
        img = cv2.resize(img, (M.shape[1], M.shape[0]), interpolation=cv2.INTER_AREA)
        ov = img.copy()
        ov[M] = (40, 40, 220)
        ov[~valid] = (90, 90, 90)
        vis = cv2.addWeighted(img, 0.55, ov, 0.45, 0)
        for S, col in ((S0, (0, 230, 255)), (S1, (60, 220, 60))):
            c, _ = cv2.findContours(S.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(vis, c, -1, col, 1)
        box = ys.box_of(M | S0, pad=0.08, aspect=0.75)
        if box is None:
            continue
        t = ys.crop(vis, box, (240, 320), fill=40)
        ys.label(t, f"f{int(frame_of[d])} iou {gain:+.3f}", scale=0.45)
        tiles.append(t)
    if tiles:
        sheet = np.concatenate(tiles, 1)
        bar = np.full((24, sheet.shape[1], 3), 30, np.uint8)
        cv2.putText(bar, "red: the person's share of the mask; grey: other people and the table; yellow: network body; "
                         "green: refined body (left: largest IoU gains, right: typical)", (6, 16), cv2.FONT_HERSHEY_SIMPLEX,
                    0.42, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imwrite(str(ev / "refine.jpg"), np.concatenate([bar, sheet], 0), [cv2.IMWRITE_JPEG_QUALITY, 88])


# ------------------------------------------------------------------------------------------------ offsets


def vertex_caps(asset, rest_v: np.ndarray, labels: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Per body-model vertex: its clothing region (torso, back, head, face, neck, arms, upper legs, lower legs, hands
    and feet) and how far the cloth may stand off the body there (metres)."""
    from pipeline.avatar import body
    from pipeline.avatar.body import PART_NAMES
    from pipeline.avatar.texture import front_sign

    nv = len(rest_v)
    src_tris = asset.src_vertex[asset.tris]
    vpart = np.full(nv, -1, np.int64)
    for j in range(3):
        vpart[src_tris[:, j]] = asset.tri_part
    dom = np.zeros(nv, np.int64)
    dom[asset.src_vertex] = asset.joints[np.arange(len(asset.joints)), np.argmax(asset.weights, 1)]
    name = np.array([labels[j] for j in dom])
    n = body.vertex_normals(rest_v, src_tris)
    fwd = n[:, 1] * front_sign(asset)
    has = lambda s: np.char.find(name.astype(str), s) >= 0  # noqa: E731
    region = np.zeros(nv, np.int64)
    region[has("arm") | has("shoulder")] = 5
    region[has("upperleg") | has("pelvis")] = 6
    region[has("lowerleg")] = 7
    region[has("neck")] = 4
    torso = vpart == PART_NAMES.index("body")
    region[torso & (fwd < -0.2) & (has("spine") | has("clavicle") | has("shoulder") | has("neck") | has("breast"))] = 1
    head = vpart == PART_NAMES.index("head")
    region[head] = 2
    z = rest_v[:, 2]
    z_eye = np.percentile(z[head], 70) if head.any() else 0.0
    region[head & (fwd > 0.25) & (z < z_eye)] = 3
    region[np.isin(vpart, [PART_NAMES.index(p) for p in ("hand.L", "hand.R", "foot.L", "foot.R")])] = 8
    cap = np.array([0.10, 0.25, 0.15, 0.005, 0.12, 0.08, 0.09, 0.04, 0.02])[region]
    cap[vpart < 0] = 0.0
    return region, cap


def estimate_offsets(new: Path, asset, k: int, tracks, hmr, poses: Path, occ=None, n_frames: int = 150, scale: float = 0.5,
                     min_obs: int = 3, rim_cos: float = 0.3, max_m: float = 0.30, fill_iters: int = 80, smooth_iters: int = 20,
                     min_gain: float = 0.01, quantiles=((0.5, 0.5), (0.5, 0.75), (0.65, 0.65), (0.65, 0.85))) -> tuple[np.ndarray, dict]:
    """Clothing volume of person k (see the module docstring); returns (offset per body-model vertex in metres, report)."""
    import cv2

    from pipeline.avatar import body
    from pipeline.avatar.ground import camera_track
    from pipeline.avatar.offsets import neighbours
    from pipeline.avatar.util import project

    doc = read_json(poses)
    W, H = int(doc["intrinsics"]["width"]), int(doc["intrinsics"]["height"])
    hh, wh = int(round(H * scale)), int(round(W * scale))
    K = hmr["K"].astype(np.float64)
    Kh = K.copy()
    Kh[:2] *= scale
    v3d, frame_of = hmr["v3d"], hmr["frame"]
    nv = int(v3d.shape[1])
    src_tris = asset.src_vertex[asset.tris]
    used = np.unique(src_tris)
    pre = f"person-{k}/"
    frames, dets, valid = tracks[pre + "frames"], tracks[pre + "det"], tracks[pre + "valid"]
    sigma = float(tracks.get(pre + "body_scale", 1.0))
    cams = camera_track(doc)
    cand = [i for i in range(len(frames)) if dets[i] >= 0 and valid[i]]
    pick = cand[:: max(1, len(cand) // n_frames)]
    obs: list[list[float]] = [[] for _ in range(nv)]
    stats = {"rim": 0, "measured": 0, "zero": 0, "censored": 0}
    samples = []
    steps = np.arange(1, 200)
    for i in pick:
        f, d = int(frames[i]), int(dets[i])
        mk = cv2.imread(str(new / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if mk is None:
            continue
        U = cv2.resize(mk, (wh, hh), interpolation=cv2.INTER_LINEAR) > 127
        fdets = np.nonzero(frame_of == f)[0]
        Vs = [v3d[o].astype(np.float64) for o in fdets]
        me = int(np.nonzero(fdets == d)[0][0])
        owner, sils, depth, mid = owners(U, Vs, src_tris, K, (H, W), scale)
        M = U & (owner == me)
        O = U & ~M
        V = Vs[me]
        S = sils[me]
        Soth = np.zeros_like(S)
        for j, Sj in enumerate(sils):
            if j != me:
                Soth |= Sj
        T = np.zeros_like(U)
        if occ is not None and f in cams:
            Tf = cams[f]
            bodies = [(sigma if o == d else 1.0) * v3d[o][::4].astype(np.float64) @ Tf[:3, :3].T + Tf[:3, 3] for o in fdets]
            own = np.where(mid == me, depth, np.inf)
            T = table_mask(occ, Tf, K, (H, W), scale, bodies, own, float(np.median(V[:, 2])), sigma, U)
        n = body.vertex_normals(V, src_tris)
        view = -V / np.linalg.norm(V, axis=1, keepdims=True)
        cos = (n * view).sum(1)
        rim = used[np.abs(cos[used]) < rim_cos]
        p = project(Kh, V[rim])
        q = project(Kh, V[rim] + 0.01 * n[rim])
        dirn = q - p
        ln = np.linalg.norm(dirn, axis=1)
        ok = ln > 1e-3
        rim, p, dirn = rim[ok], p[ok], dirn[ok] / ln[ok, None]
        # outer contour only: 2 px outward is off this body and off everybody else
        x2, y2 = np.rint(p + 2 * dirn - 0.5).astype(int).T
        ok = (x2 >= 0) & (y2 >= 0) & (x2 < wh) & (y2 < hh)
        ok[ok] &= ~S[y2[ok], x2[ok]] & ~Soth[y2[ok], x2[ok]]
        rim, p, dirn = rim[ok], p[ok], dirn[ok]
        stats["rim"] += len(rim)
        if not len(rim):
            continue
        # walk outward: 1 = still on the person, 0 = background (the cloth ends), 2 = says nothing
        base_cls = np.full((hh, wh), 2, np.uint8)  # under the body's own edge: what lies beneath it
        base_cls[~U & ~T] = 0
        base_cls[M] = 1
        base_cls[O | T | Soth] = 2
        cls = base_cls.copy()
        cls[S] = 2  # running back into the body (an arm next to the torso) says nothing
        px = p[:, None, :] + steps[None, :, None] * dirn[:, None, :]
        xi, yi = np.floor(px[..., 0]).astype(int), np.floor(px[..., 1]).astype(int)
        inb = (xi >= 0) & (yi >= 0) & (xi < wh) & (yi < hh)
        c = np.full(xi.shape, 2, np.uint8)
        c[inb] = cls[yi[inb], xi[inb]]
        c0 = inb[:, 0]
        c[c0, 0] = base_cls[yi[c0, 0], xi[c0, 0]]  # the first pixel may still be the body's own edge
        not_on = c != 1
        first = np.where(not_on.any(1), np.argmax(not_on, 1), len(steps) - 1)
        end = c[np.arange(len(rim)), first]
        z = V[rim, 2]
        metres = (steps[first] - 0.5) * z / Kh[0, 0]
        good = (end == 0) & (metres <= max_m)
        stats["measured"] += int(good.sum())
        stats["zero"] += int((good & (first == 0)).sum())
        stats["censored"] += int((~good).sum())
        for r, mm in zip(rim[good], metres[good]):
            obs[r].append(float(mm))
        samples.append((V, M, ~O & ~T))
    seen = np.array([len(o) >= min_obs for o in obs])
    labels = [str(x) for x in tracks["bone_labels"]]
    region, cap0 = vertex_caps(asset, tracks[pre + "rest_vertices"], labels)
    L = neighbours(src_tris, nv)
    cap = cap0.copy()
    for _ in range(10):  # caps change smoothly across region borders (torso to backpack, sleeve to torso)
        cap = 0.5 * cap + 0.5 * (L @ cap)
    strict = np.isin(region, [3, 8])  # the face, hands and feet keep their own caps (no cloth there)
    cap[strict] = cap0[strict]
    loose = np.isin(region, [1, 2, 4])  # backpack, hood and hair: where the masks most often miss the cloth
    checks = samples[::3]
    normals = [body.vertex_normals(V, src_tris) for V, _, _ in checks]
    S0 = [silhouette(V, src_tris, K, (hh, wh), scale) for V, _, _ in checks]
    before = [iou_in(S, M, vd) for S, (_, M, vd) in zip(S0, checks)]
    # the masks miss cloth (a backpack in some frames, not in others) more often than they add to it, so the
    # quantile of each vertex's observations is chosen by the silhouette IoU of the frames kept for the check
    trials = []
    for q, q_loose in quantiles:
        off = np.zeros(nv)
        off[seen] = [np.quantile(obs[i], q_loose if loose[i] else q) for i in np.nonzero(seen)[0]]
        off = np.minimum(off, cap)
        for _ in range(fill_iters):  # unobserved vertices take their neighbours' (harmonic fill)
            off[~seen] = (L @ off)[~seen]
        for _ in range(smooth_iters):
            off = 0.5 * off + 0.5 * (L @ off)
        off = np.minimum(off, cap)
        for _ in range(5):
            off = 0.5 * off + 0.5 * (L @ off)
        after = [iou_in(silhouette(V + off[:, None] * n, src_tris, K, (hh, wh), scale), M, vd)
                 for (V, M, vd), n in zip(checks, normals)]
        trials.append((float(np.median([x[0] for x in after])), (q, q_loose), off, after))
        log("offsets", f"person {k}: quantiles {q} / {q_loose}: IoU {np.median([x[0] for x in before]):.4f} -> {trials[-1][0]:.4f}")
    _, q, off, after = max(trials, key=lambda t: t[0])
    lap = np.abs(off - L @ off)
    u = used
    names = ("torso", "back", "head", "face", "neck", "arms", "upper legs", "lower legs", "hands, feet")
    rep = {"frames": len(samples), "verticesObserved": int(seen.sum()), "rim": stats,
           "quantile": {"elsewhere": q[0], "backHoodHair": q[1]},
           "quantileIoU": {f"{t[1][0]}/{t[1][1]}": round(t[0], 4) for t in trials},
           "offsetCm": {"median": round(100 * float(np.median(off[u])), 2), "p95": round(100 * float(np.percentile(off[u], 95)), 2),
                        "max": round(100 * float(off.max()), 2), "atCap": round(float((off[u] >= cap[u] - 1e-3).mean()), 4)},
           "byRegionCm": {nm: {"median": round(100 * float(np.median(off[u][region[u] == r])), 2),
                               "p90": round(100 * float(np.percentile(off[u][region[u] == r], 90)), 2),
                               "observedMedian": round(100 * float(np.median([np.median(obs[i]) for i in u[(region[u] == r) & seen[u]]])), 2)
                               if ((region[u] == r) & seen[u]).any() else None}
                          for r, nm in enumerate(names) if (region[u] == r).any()},
           "spikeCm": round(100 * float(lap.max()), 3), "spikeCmP999": round(100 * float(np.percentile(lap[u], 99.9)), 3),
           "iouBefore": round(float(np.median([x[0] for x in before])), 4), "iouAfter": round(float(np.median([x[0] for x in after])), 4),
           "precision": [round(float(np.median([x[1] for x in before])), 4), round(float(np.median([x[1] for x in after])), 4)],
           "recall": [round(float(np.median([x[2] for x in before])), 4), round(float(np.median([x[2] for x in after])), 4)],
           "silhouette": "ray cast", "minGain": min_gain}
    rep["iouGain"] = round(rep["iouAfter"] - rep["iouBefore"], 4)
    rep["accepted"] = bool(rep["iouGain"] >= min_gain and rep["spikeCm"] < 2.0)
    log("offsets", f"person {k}: {rep}")
    return off, rep


def draw_offsets(rest_v: np.ndarray, off: np.ndarray, src_tris: np.ndarray, front: float, path: Path, title: str,
                 size: tuple[int, int] = (300, 450), dist: float = 3.2, top: float = 0.25) -> None:
    """The rest body with its offsets from the front, both sides and behind, coloured by how far the cloth stands
    off the body (turbo, 0 to `top` metres) and shaded by the surface's turn away from the viewer."""
    import cv2

    from pipeline.avatar import body, raster
    from pipeline.avatar_v2 import yardstick as ys

    V = rest_v + off[:, None] * body.vertex_normals(rest_v, src_tris)
    n = body.vertex_normals(V, src_tris)
    c = 0.5 * (V.min(0) + V.max(0))
    w, h = size
    fx = 0.9 * h * dist / max(float(np.ptp(V[:, 2])), 1e-3)
    K = np.array([[fx, 0, w / 2], [0, fx, h / 2], [0, 0, 1.0]])
    col = cv2.applyColorMap(np.clip(off / top * 255, 0, 255).astype(np.uint8)[:, None], cv2.COLORMAP_TURBO)[:, 0].astype(np.float32)
    tiles = []
    for yaw, name in ((0, "front"), (90, "side"), (180, "back"), (270, "side")):
        a = np.radians(yaw)
        d = np.array([np.sin(a), front * np.cos(a), 0.0])
        T = ys.look_at(c + dist * d, c, up=np.array([0.0, 0.0, 1.0]))
        Vc = (V - T[:3, 3]) @ T[:3, :3]
        _, _, prim, _ = raster.DepthRenderer(K, w, h).render([(Vc, src_tris)])
        img = np.full((h, w, 3), 40, np.uint8)
        hit = prim >= 0
        tri = src_tris[prim[hit]]
        shade = np.abs((n[tri].mean(1) * d[None]).sum(1))[:, None]
        img[hit] = np.clip(col[tri].mean(1) * (0.35 + 0.65 * shade), 0, 255).astype(np.uint8)
        tiles.append(ys.label(img, name, scale=0.45))
    sheet = np.concatenate(tiles, 1)
    bar = np.full((24, sheet.shape[1], 3), 30, np.uint8)
    cv2.putText(bar, f"{title}: cloth offset 0 (blue) to {int(top * 100)} cm (red)", (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                (255, 255, 255), 1, cv2.LINE_AA)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), np.concatenate([bar, sheet], 0), [cv2.IMWRITE_JPEG_QUALITY, 88])


def offset_vertices(v3d: np.ndarray, off: np.ndarray, src_tris: np.ndarray) -> np.ndarray:
    from pipeline.avatar import body

    return v3d + off[:, None] * body.vertex_normals(v3d, src_tris)


# --------------------------------------------------------------------------------------------------- fill


def garment_fill(asset, tm, tex_seen: np.ndarray, seen: np.ndarray, n_colours: int = 4, merge_de: float = 14.0,
                 min_share: float = 0.03, knn: int = 16, radius: float = 0.10, iters: int = 60, seed: int = 0):
    """Unseen texels from their own garment colour (see the module docstring). Returns (image float32 (S, S, 3),
    label per covered texel, cluster colours, report)."""
    import cv2
    from scipy.spatial import cKDTree

    from pipeline.avatar.texture import REGIONS, texel_points, texel_regions

    rng = np.random.default_rng(seed)
    reg, _ = texel_regions(asset, tm)
    col = tex_seen[tm.ys, tm.xs].astype(np.float32)
    lab = cv2.cvtColor((col / 255.0).reshape(-1, 1, 3), cv2.COLOR_RGB2Lab).reshape(-1, 3)
    P = texel_points(asset.positions, asset, tm)
    label = np.full(len(col), -1, np.int64)
    centres: list[np.ndarray] = []
    rep: dict = {"seen": round(float(seen.mean()), 4), "regions": {}}
    for r, name in enumerate(REGIONS):
        sel = np.nonzero(seen & (reg == r))[0]
        if len(sel) < 200:
            continue
        sub = sel[rng.choice(len(sel), min(60000, len(sel)), replace=False)]
        kk = min(n_colours, len(sub))
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.2)
        _, _, ctr = cv2.kmeans(lab[sub].astype(np.float32), kk, None, crit, 3, cv2.KMEANS_PP_CENTERS)
        ctr = [c.astype(np.float64) for c in ctr]
        a = np.argmin(((lab[sel, None, :] - np.asarray(ctr)[None]) ** 2).sum(-1), 1)
        cnt = [float((a == i).sum()) for i in range(len(ctr))]
        while len(ctr) > 1:  # merge near clusters, then the smallest into its nearest
            d = np.array([[np.linalg.norm(ctr[i] - ctr[j]) if i != j else np.inf for j in range(len(ctr))] for i in range(len(ctr))])
            i, j = np.unravel_index(np.argmin(d), d.shape)
            small = int(np.argmin(cnt))
            if d[i, j] >= merge_de and cnt[small] >= min_share * len(sel):
                break
            if d[i, j] >= merge_de:
                i, j = small, int(np.argmin(d[small]))
            ctr[j] = (ctr[i] * cnt[i] + ctr[j] * cnt[j]) / max(cnt[i] + cnt[j], 1.0)
            cnt[j] += cnt[i]
            del ctr[i], cnt[i]
        a = np.argmin(((lab[sel, None, :] - np.asarray(ctr)[None]) ** 2).sum(-1), 1)
        label[sel] = len(centres) + a
        rgb = [cv2.cvtColor(c.astype(np.float32).reshape(1, 1, 3), cv2.COLOR_Lab2RGB).reshape(3) * 255 for c in ctr]
        rep["regions"][name] = [{"rgb": [int(round(x)) for x in rgb[i]], "share": round(float((a == i).mean()), 3)} for i in range(len(ctr))]
        centres.extend(rgb)
    out = col.copy()
    todo = np.nonzero(~seen)[0]
    fallback = 0
    seen_idx = np.nonzero(seen)[0]
    tree_all = cKDTree(P[seen_idx])
    for r in range(len(REGIONS)):
        q = todo[reg[todo] == r]
        if not len(q):
            continue
        ref = seen_idx[reg[seen_idx] == r]
        if len(ref) >= knn:
            dist, nb = cKDTree(P[ref]).query(P[q], k=knn, distance_upper_bound=radius, workers=-1)
            far = ~np.isfinite(dist[:, 0])
            nb = np.where(np.isfinite(dist), ref[np.minimum(nb, len(ref) - 1)], -1)
        else:
            far = np.ones(len(q), bool)
            dist = np.full((len(q), knn), np.inf)
            nb = np.full((len(q), knn), -1)
        if far.any():
            d2, n2 = tree_all.query(P[q[far]], k=knn, workers=-1)
            dist[far], nb[far] = d2, seen_idx[n2]
            fallback += int(far.sum())
        wgt = np.where(nb >= 0, 1.0 / (np.where(np.isfinite(dist), dist, 1.0) + 0.01), 0.0)
        nl = np.where(nb >= 0, label[np.maximum(nb, 0)], -1)
        votes = np.zeros((len(q), max(len(centres), 1)))
        for j in range(knn):
            okj = nl[:, j] >= 0
            np.add.at(votes, (np.nonzero(okj)[0], nl[okj, j]), wgt[okj, j])
        win = np.argmax(votes, 1)
        none = votes.sum(1) <= 0  # no clustered neighbour: plain distance-weighted colour, no cluster
        win[none] = -1
        wsel = np.where(none[:, None], wgt, wgt * (nl == win[:, None]))
        out[q] = (col[np.maximum(nb, 0)] * wsel[..., None]).sum(1) / np.maximum(wsel.sum(1, keepdims=True), 1e-9)
        label[q] = win
    S = tm.size
    img = np.zeros((S, S, 3), np.float32)
    img[tm.ys, tm.xs] = out
    lim = np.full((S, S), -1, np.int64)
    lim[tm.ys, tm.xs] = label
    free = np.zeros((S, S), bool)
    free[tm.ys[~seen], tm.xs[~seen]] = True
    for _ in range(iters):  # diffusion inside each colour cluster; seen texels stay as they are
        acc = np.zeros_like(img)
        cnt = np.zeros((S, S), np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb_l = np.roll(lim, (dy, dx), (0, 1))
            same = (nb_l == lim) & (lim >= 0)
            acc += np.roll(img, (dy, dx), (0, 1)) * same[..., None]
            cnt += same
        upd = free & (cnt > 0)
        img[upd] = acc[upd] / cnt[upd, None]
    rep.update({"filled": round(float((~seen).mean()), 4), "filledOutsideRegion": fallback, "clusters": len(centres),
                "method": "garment colour clusters, 3D neighbours + diffusion"})
    return img, label, np.asarray(centres), rep


# ------------------------------------------------------------------------------------------------- driver


def link(src: Path, dst: Path) -> None:
    if dst.is_symlink() or dst.exists():
        return
    dst.symlink_to(Path(src).resolve())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--base", required=True)
    r.add_argument("--eval", required=True)
    r.add_argument("--new", required=True)
    r.add_argument("--video", required=True)
    r.add_argument("--poses", required=True)
    r.add_argument("--world", default=None)
    r.add_argument("--out-dir", required=True)
    r.add_argument("--people", type=int, default=2)
    r.add_argument("--texture-size", type=int, default=2048)
    r.add_argument("--steps", default="all")
    r.add_argument("--force", default="")
    r.add_argument("--no-expo", action="store_true")
    r.add_argument("--no-refine", action="store_true")
    r.add_argument("--no-offsets", action="store_true")
    r.add_argument("--frames-from", default=None, help="normalised frames of an earlier run (skips expo)")
    r.add_argument("--min-gain", type=float, default=0.01, help="offsets: silhouette IoU gain to keep them")
    a = ap.parse_args(argv)
    import cv2

    base, new, out_dir = Path(a.base), Path(a.new), Path(a.out_dir)
    new.mkdir(parents=True, exist_ok=True)
    (new / "evidence").mkdir(exist_ok=True)
    steps = STEPS if a.steps == "all" else [s for s in a.steps.split(",") if s]
    force = set(s for s in a.force.split(",") if s)
    world = Path(a.world) if a.world else None
    poses = Path(a.poses)
    held = set(read_json(Path(a.eval) / "heldout.json")["frames"])
    doc = read_json(poses)
    hw = (int(doc["intrinsics"]["height"]), int(doc["intrinsics"]["width"]))
    t0 = time.time()
    times: dict[str, float] = {}

    def due(name: str, output: Path) -> bool:
        return name in steps and (name in force or not output.exists())

    link(base / "masks", new / "masks")
    for name in ("hmr.json", "inputs.json"):
        if (base / name).exists() and not (new / name).exists():
            shutil.copy(base / name, new / name)
    # expo
    if a.frames_from or a.no_expo:
        link(Path(a.frames_from) if a.frames_from else base / "frames", new / "frames")
    elif due("expo", new / "expo.json"):
        tt = time.time()
        if (new / "frames").is_symlink():
            (new / "frames").unlink()
        step_expo(base, new, held)
        times["expo"] = time.time() - tt
    # refine
    if a.no_refine:
        if not (new / "hmr.npz").exists():
            shutil.copy(base / "hmr.npz", new / "hmr.npz")
    elif due("refine", new / "refine.json"):
        tt = time.time()
        step_refine(base, new, poses, world)
        times["refine"] = time.time() - tt
    if not any(s in steps for s in STEPS[2:]):
        return 0
    trusted = None
    if (new / "refine.npz").exists():
        trusted = np.load(new / "refine.npz")["trusted"]
    # ground + body
    from pipeline.avatar import run
    from pipeline.avatar.body import Asset

    if due("ground", new / "tracks.npz"):
        tt = time.time()
        from pipeline.avatar import ground

        m, static = run._anny()
        with patched(trusted, hw):
            ground.solve(new, poses, a.people, 0.0, 60.0, anny_model=m)
        tracks = dict(np.load(new / "tracks.npz"))
        run.step_body(new, tracks, static)
        times["ground"] = time.time() - tt
        force |= {"offsets", "texture", "fill"}
    tracks = dict(np.load(new / "tracks.npz"))
    n_people = sum(1 for k in tracks if k.endswith("/rest_vertices"))
    assets = [Asset.load(new / f"asset-{k}.npz") for k in range(n_people)]
    hmr = dict(np.load(new / "hmr.npz"))
    occ = None
    if world is not None and world.exists():
        from pipeline.avatar.world import Occluders

        occ = Occluders(world)
    # offsets
    if any(due("offsets", new / f"offsets-{k}.json") for k in range(n_people)):
        tt = time.time()
        for k in range(n_people):
            if a.no_offsets:
                write_json(new / f"offsets-{k}.json", {"accepted": False, "skipped": True})
                continue
            with patched():
                off, rep = estimate_offsets(new, assets[k], k, tracks, hmr, poses, occ, min_gain=a.min_gain)
            np.savez_compressed(new / f"offsets-{k}.npz", offset=off)
            write_json(new / f"offsets-{k}.json", rep)
            from pipeline.avatar.texture import front_sign

            draw_offsets(tracks[f"person-{k}/rest_vertices"], off, assets[k].src_vertex[assets[k].tris], front_sign(assets[k]),
                         new / "evidence" / f"offsets-{k}.jpg",
                         f"person-{k} ({'kept' if rep['accepted'] else 'rejected'}, IoU {rep['iouBefore']} -> {rep['iouAfter']})")
        times["offsets"] = time.time() - tt
        force |= {"texture", "fill"}
    offs = {}
    for k in range(n_people):
        orep = read_json(new / f"offsets-{k}.json", {})
        if orep.get("accepted") and (new / f"offsets-{k}.npz").exists():
            from pipeline.avatar import offsets

            offs[k] = np.load(new / f"offsets-{k}.npz")["offset"]
            offsets.apply(assets[k], tracks[f"person-{k}/rest_vertices"], offs[k])
            log("clean", f"person {k}: offsets applied ({orep.get('offsetCm')}, IoU {orep.get('iouBefore')} -> {orep.get('iouAfter')})")
    # texture (the shipped bake, on offset bodies)
    if any(due("texture", new / f"texture-{k}.json") for k in range(n_people)):
        tt = time.time()
        from pipeline.avatar import ground, texture

        hm = dict(hmr)
        if offs:
            v = hmr["v3d"].astype(np.float64)
            for k, off in offs.items():
                src_tris = assets[k].src_vertex[assets[k].tris]
                for d in tracks[f"person-{k}/det"]:
                    if d >= 0:
                        v[d] = offset_vertices(v[d], off, src_tris)
            hm["v3d"] = v
        cams = ground.camera_track(doc) if occ is not None else None
        with patched():
            res = texture.bake(new, assets, tracks, hm, size=a.texture_size, occluders=occ, cams=cams)
        for k, rr in enumerate(res):
            cv2.imwrite(str(new / f"tex_seen-{k}.png"), rr["tex"][:, :, ::-1])
            cv2.imwrite(str(new / f"seen-{k}.png"), rr["seen"])
            cv2.imwrite(str(new / "evidence" / f"tex_seen-{k}.jpg"), cv2.resize(rr["tex"], (1024, 1024))[:, :, ::-1])
            write_json(new / f"texture-{k}.json", {"coverage": rr["coverage"], "regions": rr["regions"]})
        times["texture"] = time.time() - tt
        force |= {"fill"}
    # fill
    if any(due("fill", new / f"tex-{k}.jpg") for k in range(n_people)):
        tt = time.time()
        from pipeline.avatar import fill, texture

        for k, asset in enumerate(assets):
            tm = texture.texel_map(asset, a.texture_size)
            tex_seen = cv2.imread(str(new / f"tex_seen-{k}.png"))[:, :, ::-1]
            seen = cv2.imread(str(new / f"seen-{k}.png"), cv2.IMREAD_GRAYSCALE)[tm.ys, tm.xs] > 127
            img, label, centres, rep = garment_fill(asset, tm, tex_seen, seen)
            final, jpeg = fill.finish(img, tm.tri >= 0)
            (new / f"tex-{k}.jpg").write_bytes(jpeg)
            rep["jpegBytes"] = len(jpeg)
            write_json(new / f"fill-{k}.json", rep)
            cv2.imwrite(str(new / "evidence" / f"tex-{k}.jpg"), cv2.resize(final, (1024, 1024))[:, :, ::-1])
            lab_img = np.zeros((a.texture_size, a.texture_size, 3), np.uint8)
            if len(centres):
                lab_img[tm.ys, tm.xs] = np.clip(centres[np.maximum(label, 0)], 0, 255).astype(np.uint8)
                lab_img[tm.ys[~seen], tm.xs[~seen]] //= 2
            cv2.imwrite(str(new / "evidence" / f"fill-clusters-{k}.jpg"), cv2.resize(lab_img, (1024, 1024), interpolation=cv2.INTER_NEAREST)[:, :, ::-1])
            log("fill", f"person {k}: {rep}")
        times["fill"] = time.time() - tt
    # glb
    if "glb" in steps:
        tt = time.time()
        g = read_json(new / "ground.json", {})
        per = []
        for k in range(n_people):
            p = {"ground": g.get("people", [{}] * n_people)[k] if k < len(g.get("people", [])) else {}}
            for key, name in (("textureCoverage", "texture"), ("fill", "fill"), ("offsets", "offsets")):
                js = read_json(new / f"{name}-{k}.json")
                if js:
                    p[key] = js["coverage"] if key == "textureCoverage" else js
            per.append(p)
        hj = read_json(new / "hmr.json", {})
        meta = {
            "version": 1, "clip": "play", "source": Path(a.video).name, "start": 0.0, "variant": "people-v2 prototype B (clean inputs)",
            "mediaDuration": g.get("mediaDuration"), "fps": g.get("fps"),
            "frame": "viewer (y up, metres, floor y = 0); GLB at identity under the video layer's parent",
            "clock": "animation 'video' keyed in seconds of the played media element (presentation time - start)",
            "texture": "texture", "hmr": {kk: hj.get(kk) for kk in ("frames", "detections", "peoplePerFrame", "hfovOursDeg", "hfovPredictedDeg")},
            "checks": {kk: g.get(kk) for kk in ("bothFoundFraction", "pelvisDistanceM", "tracksFound")},
            "credits": CREDITS, "perPerson": per,
        }
        run.step_glb(new, out_dir, assets, tracks, "texture", meta)
        times["glb"] = time.time() - tt
    rep = {"seconds": round(time.time() - t0, 1), "steps": {k: round(v, 1) for k, v in times.items()}}
    prev = read_json(new / "clean.json", {})
    prev.setdefault("runs", []).append(rep)
    write_json(new / "clean.json", prev)
    log("clean", f"done in {rep['seconds']} s: {rep['steps']}; outputs in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
