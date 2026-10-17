"""Step 9 (GPU): every person's texture, clothing volume, alignment and colour gains fitted to the clip's frames by
differentiable rendering, starting from the baked texture, the silhouette offsets and the grounded motion.

    python -m pipeline.avatar.photofit run --work WORK --poses POSES [--world WORLD] [--holdout heldout.json]
    python -m pipeline.avatar.photofit masks --work WORK --poses POSES --out DIR [--world W] [--occluders FIT]

The baked texture picks each texel's colour from a few of the best views, so the street lights' bright and dark
sides of one grey hoodie end up next to each other as patches, the backpacks are painted onto the bare body, and the
body has no clothes, hair or backpack volume. Here the whole person is fitted to every frame at once instead.

masks (CPU, per frame and person): the person mask shared between the detected bodies (a pixel a body covers goes to
  the front-most body, any other mask pixel to the nearest body within 30 cm at its depth: backpacks, hoods, hair),
  M = person k's share, E = M eroded by 3 px minus the table, V = the pixels that count (not another person's, not
  the table in front of the legs), F = the table's rods and handles inside the person mask (table-height splats of
  the world 10 cm or more in front of the body, dilated 7 px). With an earlier fit as occluders, mask pixels where
  another fitted person (backpack included) stands in front count for nobody: the split by bare bodies hands the near
  player's backpack to the player behind. Each (frame, person) also gets a weight: frames where much of the mask is
  contested (claimed by the other person's reach as well, or covered by the other fitted person) count less, down to
  a quarter, so the fit does not chase the other player's backpack.
fit (GPU, per person, Adam):
  - the 2048 UV texture (a free texel grid, sampled through a mip pyramid with one level per triangle, as the viewer
    does),
  - one offset per body-model vertex (clothes, hair, hood, backpack) along its rest normal, turned towards the back
    on the upper back (a backpack is a box behind the back), bounded per body region: arms and legs 5 cm, torso 6 cm,
    head 8 cm, feet 3 cm, face and hands 1 cm; the upper back up to 22 cm when there is a backpack, tapered to 3 cm
    from the middle of the back down to the waist so the bulge ends where the bag does;
  - three colour gains per frame (log-gains bounded to +-0.3, pulled to 0 and to a zero clip mean, so the texture
    keeps the clip's mean exposure);
  - a pose correction per frame (root: 5 degrees, 15 cm across the floor, 2 cm in height; 12 main bones: 6 degrees),
    smooth over time; frames that are not fitted (held out) get theirs from the smoothness term alone;
  against
  - photometric: 0.8 L1 + 0.2 (1 - SSIM) between the render (times the frame's gain) and the frame over the pixels of
    E the render covers, F left out; clipped pixels (any channel >= 250) count a fifth, so a lamp-lit white shirt keeps
    the shading its unclipped views show; its gradient reaches the geometry at a quarter of its strength;
  - silhouette (quarter resolution): surface points outside M (other people and the table allowed) are pulled in
    along the distance transform (2.5 times as hard on the front and sides of the torso and the hips, where a fit
    spills past the person most), and pixels of M the render misses pull their three nearest vertices out, both in
    metres at the point's depth;
  - floor: the lowest point of the feet stays on the floor (y = 0) in every frame;
  - smoothness: Laplacian and normal consistency of the offsets, total variation of the texture's change inside each
    UV chart, second differences of the pose corrections over time, magnitudes of corrections and gains.
  Afterwards a texel counts as seen when the frames' (weighted) pixels fed it enough (the gradient of the summed render
  with respect to the texture); unseen texels keep the fill step's garment colours, re-coloured by the change of their
  seen neighbours in the same UV chart, and the hands take one skin tone from the face (whatever colour the fit gave
  them comes mostly from the foosball handles they hold).
run: two passes. Pass 1 (two thirds of the steps) fits on the masks split by bare bodies; its people then serve as
  occluders for new masks, and pass 2 continues from pass 1 at half the learning rates. With --backpack auto, pass 2
  keeps the upper back's backpack allowance only when pass 1 used it (a tenth or more of the upper back pushed out
  past 8 cm, further than any other region may go); otherwise the back is bounded like the rest of the torso.

Outputs WORK/photofit/ (pass 2; pass 1 in WORK/photofit-1/): asset-<k>.npz (offsets applied), tex-<k>.jpg,
offsets-<k>.npz, pose-<k>.npz (refined rotations, root positions, corrections, gains), tracks.npz (the refined
motion), photofit-<k>.json, photofit.json, evidence/texture-<k>.jpg. The glb step builds the GLBs from them.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar.util import box_of, label, log, read_json, write_json

ERODE_PX, REACH_M, TABLE_MARGIN = 3, 0.30, 0.10  # the yardstick's mask settings
BIT_M, BIT_E, BIT_V, BIT_F = 1, 2, 4, 8
LOW_FURNITURE_M, LOW_FURNITURE_GAP, ROD_DILATE = 0.95, 0.10, 15  # table height; gap in front of the body; px
POSE_BONES = ("spine04", "spine02", "neck01", "head", "upperarm01.L", "upperarm01.R", "lowerarm01.L", "lowerarm01.R",
              "upperleg01.L", "upperleg01.R", "lowerleg01.L", "lowerleg01.R")
TEX = 2048
CLIPPED = 250.0 / 255.0


# ------------------------------------------------------------------------------------------- pure helpers


def colour_gains(log_g, max_log_gain: float):
    """Per-frame colour gains from the free parameters: exp(max * tanh(x)), so each stays in exp(+-max)."""
    import torch

    return torch.exp(max_log_gain * torch.tanh(log_g))


def pixel_weights(real, clipped: float = CLIPPED, w_clipped: float = 0.2):
    """Photometric weight per pixel (n,) of the frame's colours (n, 3) in 0..1: clipped pixels count w_clipped."""
    import torch

    return torch.where((real >= clipped).any(-1), torch.full_like(real[:, 0], w_clipped), torch.ones_like(real[:, 0]))


def frame_weight(contested: float, in_front: float, slope: float = 1.5, floor: float = 0.25) -> float:
    """Weight of one person in one frame from the shares of its mask that are contested (also in the other person's
    reach) or covered by the other fitted person in front."""
    return float(np.clip(1.0 - slope * (contested + in_front), floor, 1.0))


def smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def back_cap(z: np.ndarray, z_lo: float, z_hi: float, low: float = 0.03, high: float = 0.22) -> np.ndarray:
    """The backpack allowance along the back by height z (model space, z up): `high` from z_hi (the middle of the back)
    up, `low` from z_lo (just above the seat) down, a smooth ramp between."""
    return low + (high - low) * smoothstep((np.asarray(z, np.float64) - z_lo) / max(z_hi - z_lo, 1e-6))


def auto_steps(n_frames: int, batch: int, visits: int = 72, lo: int = 1500, hi: int = 6000) -> int:
    """Adam steps so every training frame is drawn about `visits` times (bounded)."""
    return int(np.clip(round(visits * n_frames / max(batch, 1)), lo, hi))


def offset_bounds(a, rest_v: np.ndarray, n0: np.ndarray, src_tris: np.ndarray, pack: bool = True,
                  pack_bias: float = 3.0, smooth: int = 4) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Per body-model vertex (lo, hi) of the outward offset in metres, by body region (module docstring), the
    direction each vertex moves along (its rest normal, turned towards the back on the upper back), and region masks.
    Caps are blended over `smooth` rings of the mesh so regions meet without steps.
    Returns (lo, hi, direction (nv, 3), info)."""
    from pipeline.avatar import offsets as offs
    from pipeline.avatar import texture
    from pipeline.avatar.body import PART_NAMES

    nv = len(rest_v)
    labels = [str(b) for b in a.bone_labels]
    dom = a.joints[np.arange(len(a.joints)), np.argmax(a.weights, 1)].astype(np.int64)
    name = np.array([labels[j] for j in dom])
    part = np.full(nv, -1, np.int64)
    part[a.src_vertex] = a.vert_part
    bone = np.full(nv, "", dtype=object)
    bone[a.src_vertex] = name
    bone = bone.astype(str)
    fwd = n0[:, 1] * texture.front_sign(a)
    z = rest_v[:, 2]
    arm = np.char.find(bone, "arm") >= 0
    leg = np.char.find(bone, "leg") >= 0
    head = part == PART_NAMES.index("head")
    hands = np.isin(part, [PART_NAMES.index("hand.L"), PART_NAMES.index("hand.R")])
    feet = np.isin(part, [PART_NAMES.index("foot.L"), PART_NAMES.index("foot.R")])
    z_eye = np.percentile(z[head], 70) if head.any() else np.inf
    face = head & (fwd > 0.25) & (z < z_eye)
    zb = {b: float(a.rest_bone_poses[labels.index(b), 2, 3]) for b in ("spine05", "spine03", "neck01")}
    torso = ~arm & ~leg & ~head & ~hands & ~feet & (part >= 0)
    back = torso & (fwd < -0.3) & (z > zb["spine05"] - 0.06) & (z < zb["neck01"])
    hi = np.full(nv, 0.06)
    hi[arm | leg] = 0.05
    hi[head] = 0.08
    hi[face] = 0.01
    hi[feet] = 0.03
    hi[hands] = 0.01
    if pack:
        hi[back] = np.maximum(0.06, back_cap(z[back], zb["spine05"] + 0.02, zb["spine03"]))
    L = offs.neighbours(src_tris, nv)
    for _ in range(smooth):
        hi = 0.5 * hi + 0.5 * (L @ hi)
    hi[hands] = 0.01
    hi[face] = np.minimum(hi[face], 0.01)
    hi = np.maximum(hi, 0.01)
    lo = np.full(nv, -0.01)
    lo[hands | face] = -0.004
    # the upper back moves mostly straight backwards (a backpack is a box behind the back, not a swelling along the
    # back's normals, which on the sides of the back point sideways)
    upper = back & (z > zb["spine03"])
    pk = (upper if pack else np.zeros(nv, bool)).astype(np.float64)
    for _ in range(12):
        pk = 0.5 * pk + 0.5 * (L @ pk)
    bdir = np.array([0.0, -texture.front_sign(a), 0.0])
    u = n0 + pack_bias * pk[:, None] * bdir
    u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9)
    # the front and sides of the torso and the hips (not the backpack): spill past the mask is pulled in harder there
    spill = torso & ~(back & (z > zb["spine05"] + 0.02))
    return lo, hi, u, {"backVertices": int(back.sum()), "upperBackVertices": int(upper.sum()), "headVertices": int(head.sum()),
                       "faceVertices": int(face.sum()), "pack": bool(pack), "spill": spill, "upper": upper,
                       "backCapCm": round(100 * float(hi[upper].max()), 2) if upper.any() else None}


def pack_evidence(offset: np.ndarray, upper: np.ndarray, beyond: float = 0.08, share: float = 0.10) -> tuple[bool, float]:
    """Whether a fit used the backpack allowance: at least `share` of the upper back's vertices pushed out further than
    `beyond` (past every other region's bound). Returns (used, that share)."""
    if not upper.any():
        return False, 0.0
    s = float((offset[upper] > beyond).mean())
    return s >= share, s


def skin_hands(tex: np.ndarray, asset, tm, tone: np.ndarray | None = None) -> tuple[np.ndarray, dict]:
    """Hands in one skin tone (in place on a float (S, S, 3) texture in 0..1): the median of the face's texels unless
    `tone` is given. Returns (texture, report)."""
    from pipeline.avatar import texture
    from pipeline.avatar.body import PART_NAMES

    reg, _ = texture.texel_regions(asset, tm)
    part = asset.tri_part[tm.tid]
    hand = np.isin(part, [PART_NAMES.index("hand.L"), PART_NAMES.index("hand.R")])
    face = (part == PART_NAMES.index("head")) & (reg == texture.REGIONS.index("skin"))
    if tone is None:
        if face.sum() < 100:
            return tex, {"hands": 0}
        tone = np.median(tex[tm.ys[face], tm.xs[face]], 0)
    tex[tm.ys[hand], tm.xs[hand]] = tone
    return tex, {"hands": int(hand.sum()), "tone": [round(float(x) * 255) for x in tone]}


def recolour_unseen(tex_fit: np.ndarray, tex0: np.ndarray, seen: np.ndarray, lab: np.ndarray) -> tuple[np.ndarray, dict]:
    """Texels the fit never saw: the starting texture (the fill step's) plus the colour change of the seen texels of the
    same UV chart (lab: chart per texel, 0 = outside; push-pull); charts with nothing seen take the atlas-wide
    push-pull."""
    from scipy import ndimage

    from pipeline.avatar.fill import push_pull

    delta = (tex_fit - tex0).astype(np.float32)
    out = tex_fit.copy()
    isl = lab > 0
    glob = push_pull(delta, seen & isl)
    boxes = ndimage.find_objects(lab)
    rep = {"charts": int(sum(b is not None for b in boxes)), "chartsAllUnseen": 0, "unseenTexels": int((isl & ~seen).sum())}
    for i, sl in enumerate(boxes, start=1):
        if sl is None:
            continue
        me = lab[sl] == i
        hole = me & ~seen[sl]
        if not hole.any():
            continue
        known = me & seen[sl]
        if known.sum() < 20:
            fill = glob[sl]
            rep["chartsAllUnseen"] += 1
        else:
            fill = push_pull(delta[sl], known)
        o = out[sl]
        o[hole] = tex0[sl][hole] + fill[hole]
    return np.clip(out, 0, 1), rep


# --------------------------------------------------------------------------------------------------- masks

_P: dict = {}  # what the mask workers read (filled before the pool forks)


def partition(U: np.ndarray, Vs: list[np.ndarray], tris: np.ndarray, K: np.ndarray, rend, reach_m: float = REACH_M):
    """Owner (index into Vs, -1 = nobody) of every pixel of the person mask U: a pixel a body covers belongs to the
    front-most body there (rend: a raster.DepthRenderer at full size), any other mask pixel to the nearest body
    silhouette within reach_m at that body's depth. Also returns the body-id map and each body's reach (distance map,
    inf beyond reach)."""
    import cv2

    from pipeline.avatar import raster

    H, W = U.shape
    owner = np.full((H, W), -1, np.int64)
    if not Vs:
        return owner, owner.copy(), np.zeros((0, H, W), np.float32)
    _, mid, _, _ = rend.render([(V, tris) for V in Vs])
    owner[mid >= 0] = mid[mid >= 0]
    D = np.full((len(Vs), H, W), np.inf, np.float32)
    for i, V in enumerate(Vs):
        S = raster.silhouette(V, tris, K, (H, W))
        dt = cv2.distanceTransform((~S).astype(np.uint8), cv2.DIST_L2, 5)
        reach = reach_m * K[0, 0] / max(float(np.median(V[:, 2])), 0.3)
        D[i] = np.where(dt <= reach, dt, np.inf)
    rest = U & (owner < 0) & np.isfinite(D.min(0))
    owner[rest] = np.argmin(D, 0)[rest]
    return owner, mid, D


class Fitted:
    """A fitted person (FIT/asset-<k>.npz and pose-<k>.npz): world vertices at a track index (numpy LBS, the same
    skinning as its GLB)."""

    def __init__(self, fit_dir: Path, k: int, parents: np.ndarray):
        from pipeline.avatar.body import Asset

        self.a = Asset.load(fit_dir / f"asset-{k}.npz")
        po = np.load(fit_dir / f"pose-{k}.npz")
        self.delta_q, self.root_q, self.root_p = po["delta_q"], po["root_q"], po["root_p"]
        self.parents = parents
        self.F = self.a.tris

    def pose(self, i: int) -> np.ndarray:
        from pipeline.avatar.body import lbs
        from pipeline.avatar.ground import forward
        from pipeline.avatar.util import quat_to_mat

        Groot = np.eye(4)
        Groot[:3, :3] = quat_to_mat(self.root_q[i])
        Groot[:3, 3] = self.root_p[i]
        G = forward(quat_to_mat(self.delta_q[i:i + 1]), self.a.rest_bone_poses, self.parents, root=Groot[None])[0]
        return lbs(self.a.positions, self.a.weights.astype(np.float64), self.a.joints.astype(np.int64), G, self.a.rest_bone_poses)


def _mask_frame(f: int):
    import cv2

    from pipeline.avatar import raster

    g = _P
    K, v3d, det_frame, tris, tr, sigma = g["K"], g["v3d"], g["det_frame"], g["tris"], g["tracks"], g["sigma"]
    H, W = g["hw"]
    prob = cv2.imread(str(g["work"] / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
    row = {"frame": int(f), "people": {}}
    if prob is None:
        return int(f), {}, row
    rend = raster.DepthRenderer(K, W, H, scale=1.0)
    U = cv2.resize(prob, (W, H), interpolation=cv2.INTER_LINEAR) > 127
    dets = np.nonzero(det_frame == f)[0]
    Vs = [v3d[d].astype(np.float64) for d in dets]
    owner, mid, D = partition(U, Vs, tris, K, rend, REACH_M)
    furn = furn_low = None
    occ, cams = g["occ"], g["cams"]
    if occ is not None and int(f) in cams:
        Tf = cams[int(f)]
        sig_of = {}
        for k in range(g["people"]):
            i = np.nonzero(tr[f"person-{k}/frames"] == f)[0]
            if len(i) and tr[f"person-{k}/det"][i[0]] >= 0:
                sig_of[int(tr[f"person-{k}/det"][i[0]])] = sigma[k]
        bodies = [(sig_of.get(int(o), 1.0) * v3d[o][::4].astype(np.float64)) @ Tf[:3, :3].T + Tf[:3, 3] for o in dets]
        furn = cv2.resize(occ.depth(Tf, K, (H, W), bodies, scale=0.25), (W, H), interpolation=cv2.INTER_NEAREST)
        if g["occ_low"] is not None:
            furn_low = cv2.resize(g["occ_low"].depth(Tf, K, (H, W), bodies, scale=0.25), (W, H), interpolation=cv2.INTER_NEAREST)
    # an earlier fit's people (clothes and backpacks included) as occluders: which of them is front-most per pixel
    fitted = None
    if g["fits"] is not None and int(f) in cams:
        Tf = cams[int(f)]
        meshes, ids = [], []
        for j, fp in enumerate(g["fits"]):
            i = np.nonzero(tr[f"person-{j}/frames"] == f)[0]
            if fp is None or not len(i):
                continue
            Vw = fp.pose(int(i[0]))
            meshes.append(((Vw - Tf[:3, 3]) @ Tf[:3, :3], fp.F))
            ids.append(j)
        if meshes:
            _, fmid, _, _ = rend.render(meshes)
            fitted = np.where(fmid >= 0, np.asarray(ids)[np.clip(fmid, 0, None)], -1)
    se_d = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * ERODE_PX + 1, 2 * ERODE_PX + 1))
    se_t = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    se_r = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (g["rod_dilate"], g["rod_dilate"]))
    se_o = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    arrays = {}
    for k in range(g["people"]):
        i = np.nonzero(tr[f"person-{k}/frames"] == f)[0]
        d = int(tr[f"person-{k}/det"][i[0]]) if len(i) else -1
        if d < 0 or d not in set(dets.tolist()):
            row["people"][str(k)] = None
            continue
        ik = int(np.nonzero(dets == d)[0][0])
        M = U & (owner == ik)
        # contested: given to this person by reach, but within another body's reach as well
        others_reach = np.zeros((H, W), bool)
        for j in range(len(Vs)):
            if j != ik:
                others_reach |= np.isfinite(D[j])
        contested = M & (mid != ik) & others_reach
        Oc = np.zeros((H, W), bool)
        if fitted is not None:
            # mask pixels where another person's fitted body (with its backpack) stands in front: the split gives
            # them to whoever's body is behind, so they count for nobody here
            Oc = (cv2.dilate(((fitted >= 0) & (fitted != k)).astype(np.uint8), se_o) > 0) & M
            M = M & ~Oc
        others = U & ~M
        T = np.zeros((H, W), bool)
        Fin = np.zeros((H, W), bool)
        if furn is not None:
            dk, _, _, _ = rend.render([(Vs[ik], tris)])
            zmap = np.where(np.isfinite(dk), dk, float(np.median(Vs[ik][:, 2])))
            T = (cv2.dilate((furn < sigma[k] * zmap - TABLE_MARGIN).astype(np.uint8), se_t) > 0) & ~U
            if furn_low is not None:
                # the table's rods and handles in front of the thighs sit inside the person mask: for the photometric
                # loss only, table-height splats well in front of the body
                Fin = (cv2.dilate((furn_low < sigma[k] * zmap - g["rod_gap"]).astype(np.uint8), se_r) > 0) & M
        E = (cv2.erode(M.astype(np.uint8), se_d) > 0) & ~T
        valid = ~others & ~T
        arrays[f"f{int(f)}/p{k}"] = (M.astype(np.uint8) * BIT_M | E.astype(np.uint8) * BIT_E | valid.astype(np.uint8) * BIT_V
                                     | Fin.astype(np.uint8) * BIT_F)
        box = box_of(M | E)
        n_m = max(1, int(M.sum()))
        c_share, f_share = int(contested.sum()) / n_m, int(Oc.sum()) / max(1, n_m + int(Oc.sum()))
        row["people"][str(k)] = {"det": d, "index": int(i[0]), "trackValid": bool(tr[f"person-{k}/valid"][i[0]]),
                                 "maskPx": int(M.sum()), "evalPx": int(E.sum()), "tablePx": int((T & U).sum()),
                                 "tableInMaskPx": int(Fin.sum()), "otherInFrontPx": int(Oc.sum()),
                                 "contested": round(c_share, 4), "weight": round(frame_weight(c_share, f_share), 3),
                                 "box": list(box) if box else None}
    return int(f), arrays, row


def masks(work: Path, poses: Path, world: Path | None, out: Path, hmr_file: str = "hmr.npz", holdout: set | None = None,
          occluders: Path | None = None, workers: int = 8, rod_gap: float = LOW_FURNITURE_GAP, rod_dilate: int = ROD_DILATE) -> dict:
    """M / E / V / F masks and weights for every fitted frame -> OUT/train.npz (one uint8 bit image per frame and
    person: 1 = M, 2 = E, 4 = V, 8 = the table inside the person mask) and OUT/train.json. occluders: an earlier fit's
    folder (asset-<k>.npz, pose-<k>.npz). holdout: frames never used."""
    import multiprocessing as mp

    from pipeline.avatar.body import Asset
    from pipeline.avatar.ground import camera_track

    out.mkdir(parents=True, exist_ok=True)
    held = set(holdout or ())
    h = np.load(work / hmr_file)
    tr = dict(np.load(work / "tracks.npz"))
    doc = read_json(poses)
    n_people = sum(1 for k in tr if k.endswith("/rest_vertices"))
    a0 = Asset.load(work / "asset-0.npz")
    occ = occ_low = None
    if world is not None and Path(world).exists():
        from pipeline.avatar.world import Occluders

        occ = Occluders(Path(world))
        occ_low = Occluders(Path(world), max_height=LOW_FURNITURE_M)
    used = [int(f) for f in h["used_frames"]]
    frames = [f for f in used if f not in held]
    fits = None
    if occluders is not None:
        fits = [Fitted(occluders, k, tr["bone_parents"]) if (occluders / f"pose-{k}.npz").exists() else None
                for k in range(n_people)]
    _P.update(work=work, K=h["K"].astype(np.float64), v3d=h["v3d"], det_frame=h["frame"], tris=a0.src_vertex[a0.tris],
              tracks=tr, sigma=[float(tr[f"person-{k}/body_scale"]) if f"person-{k}/body_scale" in tr else 1.0
                                for k in range(n_people)],
              hw=(int(doc["intrinsics"]["height"]), int(doc["intrinsics"]["width"])), occ=occ, occ_low=occ_low,
              cams=camera_track(doc), fits=fits, people=n_people, rod_gap=rod_gap, rod_dilate=int(rod_dilate))
    t0 = time.time()
    arrays: dict[str, np.ndarray] = {}
    rows = []
    with mp.get_context("fork").Pool(workers) as pool:
        for n, (f, arr, row) in enumerate(pool.imap_unordered(_mask_frame, frames, chunksize=2)):
            arrays.update(arr)
            rows.append(row)
            if n % 50 == 0:
                log("photofit", f"masks {n + 1}/{len(frames)} (frame {f}) {time.time() - t0:.0f} s")
    rows.sort(key=lambda r: r["frame"])
    np.savez_compressed(out / "train.npz", **arrays)
    wts = [p["weight"] for r in rows for p in r["people"].values() if p]
    meta = {"work": str(work), "hmr": hmr_file, "poses": str(poses), "world": str(world) if world else None,
            "heldOut": sorted(held), "frames": [r["frame"] for r in rows], "people": n_people,
            "width": _P["hw"][1], "height": _P["hw"][0], "K": _P["K"].tolist(), "erodePx": ERODE_PX, "reachM": REACH_M,
            "tableMarginM": TABLE_MARGIN, "rodGapM": rod_gap, "rodDilatePx": int(rod_dilate),
            "occluders": str(occluders) if occluders else None,
            "downWeighted": int(sum(1 for w in wts if w < 1.0)), "rows": rows, "seconds": round(time.time() - t0, 1)}
    write_json(out / "train.json", meta)
    log("photofit", f"masks: {len(rows)} frames in {meta['seconds']} s, {meta['downWeighted']} person-frames down-weighted -> {out}")
    return meta


# ---------------------------------------------------------------------------------------------- rendering


def _cross2(u, v):
    return u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0]


def edge_bary(a, b, c, p):
    """Screen-space barycentrics (n, 3) of points p in triangles (a, b, c) (all (n, 2)), and twice the signed area."""
    import torch

    area = _cross2(b - a, c - a)
    s = torch.where(area.abs() < 1e-12, torch.full_like(area, 1e-12), area)
    w0 = _cross2(b - p, c - p) / s
    w1 = _cross2(c - p, a - p) / s
    return torch.stack([w0, w1, 1.0 - w0 - w1], 1), area


def rasterize(xy, z, F, h: int, w: int, near: float = 0.05, max_px: int = 60_000):
    """Front-most triangle per pixel (h, w) (-1 = none) of a mesh projected to pixel coordinates xy (N, 2) (pixel
    centres at i + 0.5) with camera depth z (N,). Every triangle's box of pixel centres is tested with edge
    functions; the nearest perspective-correct depth wins through one scatter-min over (depth, triangle) keys.
    Double-sided, no gradient (the caller recomputes barycentrics differentiably)."""
    import torch

    dev = xy.device
    out = torch.full((h * w,), torch.iinfo(torch.int64).max, dtype=torch.int64, device=dev)
    with torch.no_grad():
        t_xy, t_z = xy[F], z[F]
        x0 = torch.ceil(t_xy[..., 0].min(1).values - 0.5).clamp(min=0)
        x1 = torch.floor(t_xy[..., 0].max(1).values - 0.5).clamp(max=w - 1)
        y0 = torch.ceil(t_xy[..., 1].min(1).values - 0.5).clamp(min=0)
        y1 = torch.floor(t_xy[..., 1].max(1).values - 0.5).clamp(max=h - 1)
        nx, ny = (x1 - x0 + 1).clamp(min=0), (y1 - y0 + 1).clamp(min=0)
        n = nx * ny
        ok = (t_z > near).all(1) & (n > 0) & (n <= max_px) & torch.isfinite(t_xy).all(2).all(1)
        tid = torch.nonzero(ok).squeeze(1)
        if len(tid) == 0:
            return torch.full((h, w), -1, dtype=torch.int64, device=dev)
        cnt = n[tid].long()
        t = torch.repeat_interleave(tid, cnt)
        start = torch.cumsum(cnt, 0) - cnt
        local = torch.arange(int(cnt.sum()), device=dev) - torch.repeat_interleave(start, cnt)
        nxt = nx[t].long()
        px = x0[t].long() + local % nxt
        py = y0[t].long() + local // nxt
        p = torch.stack([px.to(xy.dtype) + 0.5, py.to(xy.dtype) + 0.5], 1)
        tri = t_xy[t]
        bw, area = edge_bary(tri[:, 0], tri[:, 1], tri[:, 2], p)
        inside = (bw >= -1e-6).all(1) & (area.abs() > 1e-10)
        zinv = (bw / t_z[t]).sum(1)
        inside &= zinv > 0
        depth = 1.0 / zinv.clamp(min=1e-6)
        key = (depth * 1e4).long().clamp(0, 2 ** 40) * (2 ** 20) + t
        pix = py * w + px
        out.scatter_reduce_(0, pix[inside], key[inside], reduce="amin", include_self=True)
        empty = out == torch.iinfo(torch.int64).max
        tri_img = torch.where(empty, torch.full_like(out, -1), out % (2 ** 20))
    return tri_img.view(h, w)


def interp(xy, z, F, uv, tri_img):
    """For every covered pixel: (py, px, triangle, perspective-correct UV (n, 2), twice the screen area of its
    triangle). Differentiable in xy, z and uv."""
    import torch

    py, px = torch.nonzero(tri_img >= 0, as_tuple=True)
    t = tri_img[py, px]
    f = F[t]
    p = torch.stack([px.to(xy.dtype) + 0.5, py.to(xy.dtype) + 0.5], 1)
    bw, area = edge_bary(xy[f[:, 0]], xy[f[:, 1]], xy[f[:, 2]], p)
    q = bw / z[f]
    b = q / q.sum(1, keepdim=True)
    return py, px, t, (b[..., None] * uv[f]).sum(1), area


def pyramid(tex):
    """(S, S, 3) texture -> mip levels [(1, 3, S, S), (1, 3, S/2, S/2), ... (1, 3, 1, 1)] (2 x 2 means)."""
    import torch.nn.functional as Fn

    lv = [tex.permute(2, 0, 1)[None]]
    while min(lv[-1].shape[-2:]) > 1:
        lv.append(Fn.avg_pool2d(lv[-1], 2))
    return lv


def sample_mip(pyr, uv, lev):
    """Trilinear samples (n, 3) at glTF UVs (n, 2), mip level per sample (n,) (clamp-to-edge)."""
    import torch
    import torch.nn.functional as Fn

    L = lev.clamp(0, len(pyr) - 1)
    l0 = L.floor().long()
    fr = (L - l0)[:, None]
    grid = (uv * 2.0 - 1.0).view(1, 1, -1, 2)
    out = torch.zeros(len(uv), 3, device=uv.device, dtype=pyr[0].dtype)
    for lvl in torch.unique(l0).tolist():
        s = torch.nonzero(l0 == lvl).squeeze(1)
        g = grid[:, :, s]
        c0 = Fn.grid_sample(pyr[lvl], g, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].t()
        l1 = min(lvl + 1, len(pyr) - 1)
        c1 = c0 if l1 == lvl else Fn.grid_sample(pyr[l1], g, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].t()
        out = out.index_put((s,), c0 * (1 - fr[s]) + c1 * fr[s])
    return out


def ssim_map(A, B, kernel):
    """SSIM map (1, 3, h, w) of two (1, 3, h, w) images in 0..1 (Gaussian 11 x 11, sigma 1.5, reflected borders)."""
    import torch.nn.functional as Fn

    C1, C2 = 0.01 ** 2, 0.03 ** 2

    def g(x):
        return Fn.conv2d(Fn.pad(x, (5, 5, 5, 5), mode="reflect"), kernel, groups=3)

    ma, mb = g(A), g(B)
    saa, sbb, sab = g(A * A) - ma * ma, g(B * B) - mb * mb, g(A * B) - ma * mb
    return ((2 * ma * mb + C1) * (2 * sab + C2)) / ((ma * ma + mb * mb + C1) * (saa + sbb + C2))


def gauss_kernel(dev):
    import torch

    x = torch.arange(11, dtype=torch.float32, device=dev) - 5
    g = torch.exp(-x * x / (2 * 1.5 ** 2))
    g = g / g.sum()
    return (g[:, None] * g[None, :]).expand(3, 1, 11, 11).contiguous()


def rodrigues(w):
    """Axis-angle (..., 3) -> rotation matrices (..., 3, 3); series coefficients (the corrections stay < 0.3 rad)."""
    import torch

    th2 = (w * w).sum(-1)[..., None, None]
    a = 1 - th2 / 6 + th2 * th2 / 120
    b = 0.5 - th2 / 24 + th2 * th2 / 720
    z = torch.zeros_like(w[..., 0])
    Kx = torch.stack([torch.stack([z, -w[..., 2], w[..., 1]], -1), torch.stack([w[..., 2], z, -w[..., 0]], -1),
                      torch.stack([-w[..., 1], w[..., 0], z], -1)], -2)
    eye = torch.eye(3, device=w.device, dtype=w.dtype).expand(Kx.shape)
    return eye + a * Kx + b * (Kx @ Kx)


def project(X, K, s: float):
    import torch

    z = X[:, 2]
    zc = z.clamp(min=1e-3)
    return torch.stack([K[0, 0] * s * X[:, 0] / zc + K[0, 2] * s, K[1, 1] * s * X[:, 1] / zc + K[1, 2] * s], 1), z


# ------------------------------------------------------------------------------------------------- the data


class Clip:
    """The fitted frames (at the photometric scale) and every person's masks and weights, on the device."""

    def __init__(self, prep_dir: Path, poses: Path, frames_dir: Path, scale: float, sil_scale: float, dev, people):
        import cv2
        import torch

        from pipeline.avatar.ground import camera_track

        meta = read_json(prep_dir / "train.json")
        data = np.load(prep_dir / "train.npz")
        self.meta, self.dev = meta, dev
        self.H, self.W = meta["height"], meta["width"]
        self.K = np.asarray(meta["K"], np.float64)
        self.s, self.q = scale, sil_scale
        self.Hs, self.Ws = int(round(self.H * scale)), int(round(self.W * scale))
        self.Hq, self.Wq = int(round(self.H * sil_scale)), int(round(self.W * sil_scale))
        cams = camera_track(read_json(poses))
        self.cam: dict = {}
        self.img: dict = {}
        self.bits: dict = {}
        self.dt: dict = {}
        self.need: dict = {}
        self.dontcare: dict = {}
        self.rows = {r["frame"]: r for r in meta["rows"]}

        def area(m: np.ndarray, hw: tuple[int, int]) -> np.ndarray:
            if m.shape == hw:
                return m.astype(np.float32)
            return cv2.resize(m.astype(np.float32), (hw[1], hw[0]), interpolation=cv2.INTER_AREA)

        t0 = time.time()
        for f, row in self.rows.items():
            mine = [k for k in people if row["people"].get(str(k))]
            if not mine or f not in cams:
                continue
            im = cv2.imread(str(frames_dir / f"f{f:06d}.jpg"))
            if im is None:
                continue
            if (self.Hs, self.Ws) != im.shape[:2]:
                im = cv2.resize(im, (self.Ws, self.Hs), interpolation=cv2.INTER_AREA)
            self.img[f] = torch.from_numpy(np.ascontiguousarray(im[:, :, ::-1])).to(dev)
            T = cams[f]
            self.cam[f] = (torch.tensor(T[:3, :3], dtype=torch.float32, device=dev),
                           torch.tensor(T[:3, 3], dtype=torch.float32, device=dev))
            for k in mine:
                b = data[f"f{f}/p{k}"]
                M, E, V = (b & BIT_M) > 0, ((b & BIT_E) > 0) & ((b & BIT_F) == 0), (b & BIT_V) > 0
                hs = (self.Hs, self.Ws)
                bs = ((area(M, hs) > 0.5).astype(np.uint8) * BIT_M | (area(E, hs) > 0.999).astype(np.uint8) * BIT_E
                      | (area(V, hs) > 0.5).astype(np.uint8) * BIT_V)
                self.bits[(f, k)] = torch.from_numpy(bs).to(dev)
                hq = (self.Hq, self.Wq)
                allowed = area(M | ~V, hq) > 0
                dt = cv2.distanceTransform((~allowed).astype(np.uint8), cv2.DIST_L2, 5)
                self.dt[(f, k)] = torch.from_numpy(dt.astype(np.float32)).to(dev)
                self.need[(f, k)] = torch.from_numpy(area(M & V, hq) > 0.5).to(dev)
                self.dontcare[(f, k)] = torch.from_numpy(area(~V, hq) > 0.5).to(dev)
        log("photofit", f"clip: {len(self.img)} frames, {len(self.bits)} person masks at scale {scale} "
                        f"({self.Ws} x {self.Hs}), silhouettes at {sil_scale}; {time.time() - t0:.0f} s")

    def frames_of(self, k: int, min_px: int = 800) -> list[int]:
        return [f for f in sorted(self.img) if (f, k) in self.bits and self.rows[f]["people"][str(k)]["maskPx"] >= min_px]

    def weight(self, f: int, k: int) -> float:
        return float(self.rows[f]["people"][str(k)].get("weight", 1.0))

    def to_camera(self, f: int, Vw):
        R, t = self.cam[f]
        return (Vw - t) @ R


class Person:
    """One person's parameters (texture, offsets, gains, pose corrections) and the differentiable posed mesh."""

    def __init__(self, work: Path, k: int, dev, tex_path: Path, max_root_deg: float = 5.0, max_root_m: float = 0.15,
                 max_root_up_m: float = 0.02, max_bone_deg: float = 6.0, max_log_gain: float = 0.3, pack: bool = True,
                 pack_bias: float = 3.0, spill: float = 2.5):
        import cv2
        import torch

        from pipeline.avatar import body
        from pipeline.avatar.body import PART_NAMES, Asset
        from pipeline.avatar.ground import rest_locals, topo_order
        from pipeline.avatar.texture import texel_map
        from pipeline.avatar.util import quat_to_mat, rigid_inv

        f32 = dict(dtype=torch.float32, device=dev)
        self.k, self.dev = k, dev
        a = Asset.load(work / f"asset-{k}.npz")
        tr = np.load(work / "tracks.npz")
        pre = f"person-{k}/"
        rest_v = tr[pre + "rest_vertices"].astype(np.float64)
        src_tris = a.src_vertex[a.tris]
        n0 = body.vertex_normals(rest_v, src_tris)
        lo, hi, udir, info = offset_bounds(a, rest_v, n0, src_tris, pack, pack_bias)
        self.upper = info.pop("upper")
        spill_v = info.pop("spill")
        self.region_info = info
        op = work / f"offsets-{k}.npz"
        d0 = np.load(op)["offset"].astype(np.float64) if op.exists() else np.zeros(len(rest_v))
        u = np.clip((np.clip(d0, lo, hi) - lo) / (hi - lo), 0.02, 0.98)
        self.asset, self.rest_np, self.n0_np, self.src_tris_np = a, rest_v, n0, src_tris
        self.lo, self.hi = torch.tensor(lo, **f32), torch.tensor(hi, **f32)
        self.theta = torch.tensor(np.log(u / (1 - u)), **f32).requires_grad_(True)
        self.rest = torch.tensor(rest_v, **f32)
        self.n0 = torch.tensor(udir, **f32)  # displacement direction (rest normal; backwards on the upper back)
        self.udir_np = udir
        self.src = torch.tensor(a.src_vertex, dtype=torch.int64, device=dev)
        self.F = torch.tensor(a.tris, dtype=torch.int64, device=dev)
        self.uv = torch.tensor(a.uv, **f32)
        self.joints = torch.tensor(a.joints.astype(np.int64), device=dev)
        w = a.weights.astype(np.float64)
        self.weights = torch.tensor(w / w.sum(1, keepdims=True), **f32)
        self.inv_rest = torch.tensor(rigid_inv(a.rest_bone_poses), **f32)
        uvp = a.uv[a.tris] * TEX
        self.a_uv = torch.tensor(0.5 * np.abs(np.cross(uvp[:, 1] - uvp[:, 0], uvp[:, 2] - uvp[:, 0])), **f32)
        feet = np.isin(a.vert_part, [PART_NAMES.index("foot.L"), PART_NAMES.index("foot.R")])
        self.feet = torch.tensor(np.nonzero(feet)[0], dtype=torch.int64, device=dev)
        # skeleton: per-frame local transforms rl_j @ delta_j of the tracks; the root is rebuilt from root_q / root_p
        self.parents = a.bone_parents.astype(np.int64)
        self.order = topo_order(self.parents)
        labels = [str(b) for b in a.bone_labels]
        self.cb = [labels.index(b) for b in POSE_BONES]
        self.delta_q = tr[pre + "delta_q"].astype(np.float64)
        self.root_q = tr[pre + "root_q"].astype(np.float64)
        self.root_p_np = tr[pre + "root_p"].astype(np.float64)
        T = len(self.delta_q)
        rl = rest_locals(a.rest_bone_poses, self.parents)
        D = np.zeros((T, len(labels), 4, 4))
        D[..., :3, :3] = quat_to_mat(self.delta_q)
        D[..., 3, 3] = 1.0
        self.L = torch.tensor(rl[None] @ D, **f32)
        self.root_R = torch.tensor(quat_to_mat(self.root_q), **f32)
        self.root_p = torch.tensor(self.root_p_np, **f32)
        self.frames = tr[pre + "frames"].astype(np.int64)
        self.index_of = {int(f): i for i, f in enumerate(self.frames)}
        self.max_root = np.radians(max_root_deg)
        self.max_t = torch.tensor([max_root_m, max_root_up_m, max_root_m], **f32)
        self.max_bone = np.radians(max_bone_deg)
        self.max_lg = max_log_gain
        self.w_root = torch.zeros(T, 3, **f32).requires_grad_(True)
        self.t_root = torch.zeros(T, 3, **f32).requires_grad_(True)
        self.w_bone = torch.zeros(T, len(self.cb), 3, **f32).requires_grad_(True)
        self.log_g = torch.zeros(T, 3, **f32).requires_grad_(True)
        # texture: the fill step's atlas (the reference of the texture's change and of the unseen texels)
        tex = cv2.imread(str(tex_path))[:, :, ::-1].astype(np.float32) / 255.0
        if tex.shape[:2] != (TEX, TEX):
            tex = cv2.resize(tex, (TEX, TEX), interpolation=cv2.INTER_AREA)
        self.tex0 = tex
        self.tex = torch.tensor(tex, **f32).requires_grad_(True)
        self.tex0_t = torch.tensor(tex, **f32)
        self.tm = texel_map(a, TEX)
        self.island = self.tm.tri >= 0
        # UV charts: triangles joined through shared split vertices (atlas pixels of different charts can touch)
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components

        ns = len(a.positions)
        e = np.concatenate([a.tris[:, [0, 1]], a.tris[:, [1, 2]]])
        _, comp = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(ns, ns)), directed=False)
        lab = np.where(self.island, comp[a.tris[np.clip(self.tm.tri, 0, None), 0]] + 1, 0).astype(np.int32)
        self.island_lab = lab
        lab_t = torch.tensor(lab, dtype=torch.int32, device=dev)
        # surface area per split vertex (a third of each adjacent triangle), for area-weighted silhouette terms; the
        # front and sides of the torso and the hips pull in harder when they spill past the mask
        P0 = a.positions
        ta = 0.5 * np.linalg.norm(np.cross(P0[a.tris[:, 1]] - P0[a.tris[:, 0]], P0[a.tris[:, 2]] - P0[a.tris[:, 0]]), axis=1)
        va = np.zeros(ns)
        for j in range(3):
            np.add.at(va, a.tris[:, j], ta / 3)
        self.v_area = torch.tensor(va / va.sum(), **f32)
        self.v_out = torch.tensor(va / va.sum() * np.where(spill_v[a.src_vertex], spill, 1.0), **f32)
        self.tv_x = ((lab_t[:, 1:] == lab_t[:, :-1]) & (lab_t[:, 1:] > 0)).float()
        self.tv_y = ((lab_t[1:] == lab_t[:-1]) & (lab_t[1:] > 0)).float()
        # mesh regularisers on the model vertices
        nv = len(rest_v)
        used = np.zeros(nv, bool)
        used[src_tris.reshape(-1)] = True
        self.used = torch.tensor(used, device=dev)
        e = np.concatenate([src_tris[:, [0, 1]], src_tris[:, [1, 2]], src_tris[:, [2, 0]]])
        e = np.unique(np.sort(e, 1), axis=0)
        e = np.concatenate([e, e[:, ::-1]])
        deg = np.bincount(e[:, 0], minlength=nv).astype(np.float64)
        vals = 1.0 / np.maximum(deg[e[:, 0]], 1)
        self.Lap = torch.sparse_coo_tensor(torch.tensor(e.T, device=dev), torch.tensor(vals, **f32), (nv, nv)).coalesce()
        # face pairs sharing an edge (normal consistency)
        fe = np.concatenate([np.sort(src_tris[:, [0, 1]], 1), np.sort(src_tris[:, [1, 2]], 1), np.sort(src_tris[:, [2, 0]], 1)])
        fid = np.tile(np.arange(len(src_tris)), 3)
        key = fe[:, 0] * nv + fe[:, 1]
        o = np.argsort(key, kind="stable")
        key, fid = key[o], fid[o]
        same = np.nonzero(key[1:] == key[:-1])[0]
        single = np.ones(len(same), bool)
        if len(same) > 1:
            single[1:] = same[1:] != same[:-1] + 1
        self.fpairs = torch.tensor(np.stack([fid[same], fid[same + 1]], 1)[single], dtype=torch.int64, device=dev)
        self.Fm = torch.tensor(src_tris, dtype=torch.int64, device=dev)
        with torch.no_grad():
            self.nc0 = self.normal_cos(self.rest)

    def warm_start(self, fit_dir: Path) -> dict:
        """Continue from an earlier fit of the same person: texture, offsets, pose corrections, gains (the starting
        texture stays the reference of the texture's change and of the unseen texels)."""
        import cv2
        import torch

        k = self.k
        got = {}
        with torch.no_grad():
            tp = fit_dir / f"tex-{k}.jpg"
            if tp.exists():
                t = cv2.imread(str(tp))[:, :, ::-1].astype(np.float32) / 255.0
                self.tex.copy_(torch.tensor(t, device=self.dev))
                got["tex"] = True
            op = fit_dir / f"offsets-{k}.npz"
            if op.exists():
                d = np.load(op)["offset"]
                lo, hi = self.lo.cpu().numpy(), self.hi.cpu().numpy()
                u = np.clip((np.clip(d, lo, hi) - lo) / (hi - lo), 0.005, 0.995)
                self.theta.copy_(torch.tensor(np.log(u / (1 - u)), dtype=torch.float32, device=self.dev))
                got["offsets"] = True
            pp = fit_dir / f"pose-{k}.npz"
            if pp.exists():
                po = np.load(pp)

                def raw(x, m):
                    m = np.asarray(m, np.float64)
                    return np.arctanh(np.clip(x / np.where(m > 0, m, 1.0), -0.995, 0.995)) * (m > 0)

                self.w_root.copy_(torch.tensor(raw(po["w_root"], self.max_root), dtype=torch.float32, device=self.dev))
                self.t_root.copy_(torch.tensor(raw(po["t_root"], self.max_t.cpu().numpy()), dtype=torch.float32, device=self.dev))
                self.w_bone.copy_(torch.tensor(raw(po["w_bone"], self.max_bone), dtype=torch.float32, device=self.dev))
                self.log_g.copy_(torch.tensor(raw(np.log(po["gains"]), self.max_lg), dtype=torch.float32, device=self.dev))
                got["pose"] = got["gains"] = True
        log("photofit", f"person {k}: warm start from {fit_dir}: {got}")
        return got

    # -------- parameters -> geometry

    def offsets(self):
        import torch

        return self.lo + (self.hi - self.lo) * torch.sigmoid(self.theta)

    def gains(self, idx):
        return colour_gains(self.log_g[idx], self.max_lg)

    def corrections(self, idx=None):
        import torch

        s = slice(None) if idx is None else idx
        return (self.max_root * torch.tanh(self.w_root[s]), self.max_t * torch.tanh(self.t_root[s]),
                self.max_bone * torch.tanh(self.w_bone[s]))

    def bone_poses(self, idx):
        """World bone poses (B, J, 4, 4) at track indices idx (LongTensor), corrections applied."""
        import torch

        wr, tr, wb = self.corrections(idx)
        B = len(idx)
        L = self.L[idx]
        bottom = torch.tensor([0.0, 0.0, 0.0, 1.0], device=self.dev).expand(B, 1, 4)
        Rr = rodrigues(wr) @ self.root_R[idx]
        root = torch.cat([torch.cat([Rr, (self.root_p[idx] + tr)[:, :, None]], 2), bottom], 1)
        Rb = rodrigues(wb)
        corr = {j: n for n, j in enumerate(self.cb)}
        G: list = [None] * len(self.parents)
        for j in self.order:
            p = int(self.parents[j])
            if p < 0:
                G[j] = root
                continue
            Lj = L[:, j]
            if j in corr:
                Lj = torch.cat([torch.cat([Lj[:, :3, :3] @ Rb[:, corr[j]], Lj[:, :3, 3:]], 2), Lj[:, 3:]], 1)
            G[j] = G[p] @ Lj
        return torch.stack(G, 1)

    def model_vertices(self):
        return self.rest + self.offsets()[:, None] * self.n0

    def posed(self, idx):
        """World positions (B, N, 3) of the split mesh at track indices idx."""
        V = self.model_vertices()[self.src]
        A = self.bone_poses(idx) @ self.inv_rest
        Aw = (self.weights[None, :, :, None, None] * A[:, self.joints]).sum(2)
        return (Aw[..., :3, :3] @ V[None, :, :, None])[..., 0] + Aw[..., :3, 3]

    def normal_cos(self, Vm):
        import torch

        f = self.Fm
        n = torch.cross(Vm[f[:, 1]] - Vm[f[:, 0]], Vm[f[:, 2]] - Vm[f[:, 0]], dim=1)
        n = n / n.norm(dim=1, keepdim=True).clamp(min=1e-12)
        return (n[self.fpairs[:, 0]] * n[self.fpairs[:, 1]]).sum(1)

    # -------- regularisers

    def reg_terms(self, train_idx):
        import torch

        d = self.offsets()
        lap = (d - torch.sparse.mm(self.Lap, d[:, None])[:, 0])[self.used]
        nc = torch.relu((1 - self.normal_cos(self.model_vertices())) - (1 - self.nc0)).mean()
        tex = self.tex - self.tex0_t  # the change is smooth; the starting texture's own detail is not penalised
        cx = torch.sqrt((tex[:, 1:] - tex[:, :-1]).pow(2).sum(-1) + 1e-6)
        cy = torch.sqrt((tex[1:] - tex[:-1]).pow(2).sum(-1) + 1e-6)
        tv = (cx * self.tv_x).sum() / self.tv_x.sum() + (cy * self.tv_y).sum() / self.tv_y.sum()
        lg = self.max_lg * torch.tanh(self.log_g[train_idx])
        wr, tr, wb = self.corrections()
        deg = 180.0 / np.pi

        def dd(x):
            return (x[2:] - 2 * x[1:-1] + x[:-2]).pow(2).mean()

        smooth = dd(wr * deg) + dd(tr * 100) + dd(wb * deg)
        mag = (wr * deg).pow(2).mean() + (tr * 100).pow(2).mean() + (wb * deg).pow(2).mean()
        return {"lap": (100 * lap).pow(2).mean(), "nc": nc, "tv": tv, "gain": lg.pow(2).mean(), "gainMean": lg.mean(0).pow(2).sum(),
                "poseSmooth": smooth, "poseMag": mag, "offsetMean": (100 * d[self.used]).mean()}


# ------------------------------------------------------------------------------------------------- losses


def photo_terms(P: Person, clip: Clip, f: int, X, pyr, gain, kernel, geo_grad: float = 0.25, want_obs: bool = False,
                w_clipped: float = 0.2):
    """Photometric loss of person P in frame f (camera-space vertices X), or None when too little of E is covered."""
    import torch

    k = P.k
    row = clip.rows[f]["people"][str(k)]
    s = clip.s
    xy, z = project(X, clip.K, s)
    with torch.no_grad():
        okz = z > 0.05
        bx = xy[okz]
        x0, y0 = bx.min(0).values.tolist() if len(bx) else (0, 0)
        x1, y1 = bx.max(0).values.tolist() if len(bx) else (0, 0)
    if row["box"]:
        by0, by1, bx0, bx1 = row["box"]
        x0, x1, y0, y1 = min(x0, bx0 * s), max(x1, bx1 * s), min(y0, by0 * s), max(y1, by1 * s)
    cx0, cy0 = max(0, int(np.floor(x0)) - 4), max(0, int(np.floor(y0)) - 4)
    cx1, cy1 = min(clip.Ws, int(np.ceil(x1)) + 4), min(clip.Hs, int(np.ceil(y1)) + 4)
    h, w = cy1 - cy0, cx1 - cx0
    if h < 16 or w < 16:
        return None
    off = torch.tensor([cx0, cy0], dtype=xy.dtype, device=xy.device)
    xyc = xy - off
    tri = rasterize(xyc.detach(), z.detach(), P.F, h, w)
    xyg = xyc.detach() + geo_grad * (xyc - xyc.detach())
    zg = z.detach() + geo_grad * (z - z.detach())
    py, px, t, uvp, area = interp(xyg, zg, P.F, P.uv, tri)
    if len(py) < 50:
        return None
    with torch.no_grad():
        lev = 0.5 * torch.log2((P.a_uv[t] / (0.5 * area.abs()).clamp(min=1e-9)).clamp(min=1.0))
    col = sample_mip(pyr, uvp, lev)
    bits = clip.bits[(f, k)][cy0:cy1, cx0:cx1]
    E = (bits & BIT_E) > 0
    inP = E[py, px]
    n = int(inP.sum())
    if n < 50:
        return None
    I = clip.img[f][cy0:cy1, cx0:cx1].float() / 255.0
    real = I[py, px]
    wpx = pixel_weights(real[inP], w_clipped=w_clipped)
    if want_obs:
        return (col[inP] * wpx[:, None]).sum(), n
    pred = col * gain[None]
    l1 = ((pred - real).abs()[inP].mean(1) * wpx).sum() / wpx.sum().clamp(min=1e-6)
    pyP, pxP = py[inP], px[inP]
    Pm = torch.zeros(h, w, dtype=torch.bool, device=I.device)
    Pm[pyP, pxP] = True
    fill = real[inP].mean(0)
    A = torch.where(Pm[..., None], I, fill)
    Bimg = fill.view(1, 1, 3).repeat(h, w, 1).index_put((pyP, pxP), pred[inP])
    sm = ssim_map(A.permute(2, 0, 1)[None], Bimg.permute(2, 0, 1)[None], kernel)[0].mean(0)
    ssim = sm[Pm].mean()
    with torch.no_grad():
        mse = ((pred - real)[inP] * 255).pow(2).mean()
    return {"photo": 0.8 * l1 + 0.2 * (1 - ssim), "l1": l1.detach(), "ssim": ssim.detach(), "mse": mse, "px": n,
            "cover": n / max(1, int(E.sum()))}


def sil_terms(P: Person, clip: Clip, f: int, X, gen, n_pull: int = 2000):
    """Silhouette losses of person P in frame f at the silhouette scale (module docstring)."""
    import torch
    import torch.nn.functional as Fn

    k = P.k
    q = clip.q
    xy, z = project(X, clip.K, q)
    fq = float(clip.K[0, 0] * q)
    tri = rasterize(xy.detach(), z.detach(), P.F, clip.Hq, clip.Wq)
    cov = tri >= 0
    dt = clip.dt[(f, k)]
    need = clip.need[(f, k)]
    g = torch.stack([xy[:, 0] / clip.Wq * 2 - 1, xy[:, 1] / clip.Hq * 2 - 1], 1).view(1, 1, -1, 2)
    dv = Fn.grid_sample(dt[None, None], g, mode="bilinear", padding_mode="zeros", align_corners=False).view(-1)
    l_out = (P.v_out * dv * z.clamp(min=0.1) / fq).sum()
    unc = need & ~cov
    n_need = int(need.sum())
    yy, xx = torch.nonzero(unc, as_tuple=True)
    n_unc = len(yy)
    l_unc = torch.zeros((), device=xy.device)
    if n_unc and n_need:
        if n_unc > n_pull:
            sel = torch.randperm(n_unc, generator=gen, device="cpu")[:n_pull].to(xy.device)
            yy, xx = yy[sel], xx[sel]
        p = torch.stack([xx.float() + 0.5, yy.float() + 0.5], 1)
        with torch.no_grad():
            nn = torch.cdist(p, xy.detach()).topk(3, dim=1, largest=False).indices
        dist = (xy[nn] - p[:, None]).norm(dim=-1) * z[nn].clamp(min=0.1) / fq
        l_unc = dist.mean(1).sum() * (n_unc / len(yy)) / n_need
    with torch.no_grad():
        care = ~clip.dontcare[(f, k)]
        iou = (cov & need).sum().float() / ((cov | need) & care).sum().clamp(min=1).float()
    return {"out": l_out, "unc": l_unc, "iou": iou, "uncFrac": n_unc / max(1, n_need)}


def floor_term(P: Person, Vw):
    """Mean over the batch of (lowest foot point's height in cm)^2: the feet stay on the floor (y = 0)."""
    ymin = Vw[:, P.feet, 1].min(1).values
    return (100 * ymin).pow(2).mean(), ymin.detach()


# ---------------------------------------------------------------------------------------------------- fit


def evaluate(P: Person, clip: Clip, frames: list[int], idx_all: list[int], kernel, gen, obs: bool = False,
             w_clipped: float = 0.2):
    """Per fitted frame: PSNR / SSIM over E (with the frame's gain), cover, silhouette IoU at the silhouette scale,
    lowest foot point. With obs, also every texel's observation weight (the gradient of the summed, weighted render
    over E with respect to the texture: how much of the frames' pixels it fed)."""
    import torch

    dev = P.dev
    texd = P.tex.detach().clone()
    probe = torch.zeros_like(texd, requires_grad=True) if obs else None
    rows = []
    for i0 in range(0, len(frames), 8):
        chunk = list(range(i0, min(len(frames), i0 + 8)))
        idx = torch.tensor([idx_all[i] for i in chunk], dtype=torch.int64, device=dev)
        with torch.no_grad():
            Vw = P.posed(idx)
            gains = P.gains(idx)
            _, ymin = floor_term(P, Vw)
        for b, i in enumerate(chunk):
            f = frames[i]
            X = clip.to_camera(f, Vw[b])
            if obs:
                o = photo_terms(P, clip, f, X, pyramid(texd + probe), gains[b], kernel, want_obs=True, w_clipped=w_clipped)
                if o is not None:
                    o[0].backward()
            with torch.no_grad():
                ph = photo_terms(P, clip, f, X, pyramid(texd), gains[b], kernel, w_clipped=w_clipped)
                st = sil_terms(P, clip, f, X, gen)
            r = {"frame": f, "silIoUq": round(float(st["iou"]), 4), "gain": [round(float(x), 4) for x in gains[b]],
                 "footCm": round(100 * float(ymin[b]), 2), "weight": clip.weight(f, P.k)}
            if ph is not None:
                r.update(psnrGain=round(float(10 * np.log10(255 ** 2 / max(float(ph["mse"]), 1e-6))), 3),
                         ssim=round(float(ph["ssim"]), 4), cover=round(ph["cover"], 4))
            rows.append(r)
    ob = None
    if obs:
        ob = probe.grad.sum(-1).detach().cpu().numpy() if probe.grad is not None else np.zeros((TEX, TEX), np.float32)

    def mean(key):
        v = [r[key] for r in rows if key in r]
        return round(float(np.mean(v)), 4) if v else None

    foot = np.array([r["footCm"] for r in rows]) if rows else np.zeros(1)
    return ({"psnrWithGain": mean("psnrGain"), "ssim": mean("ssim"), "cover": mean("cover"), "silIoUquarter": mean("silIoUq"),
             "footCmMedianAbs": round(float(np.median(np.abs(foot))), 2), "footCmMin": round(float(foot.min()), 2)},
            rows, ob)


def fit_person(P: Person, clip: Clip, out: Path, held: set, steps: int, batch: int, budget_s: float, w: dict,
               lr: dict, warm_frac: float, seed: int, geo_grad: float) -> dict:
    import cv2
    import torch

    from pipeline.avatar import fill as fillmod

    dev = P.dev
    k = P.k
    frames = [f for f in clip.frames_of(k) if f in P.index_of]
    bad = [f for f in frames if f in held]
    if bad:
        raise RuntimeError(f"held-out frames among the fitted frames: {bad}")
    idx_all = [P.index_of[f] for f in frames]
    fw = np.array([clip.weight(f, k) for f in frames])
    train_idx = torch.tensor(idx_all, dtype=torch.int64, device=dev)
    log("photofit", f"person {k}: {len(frames)} frames ({int((fw < 1).sum())} down-weighted), {steps} steps, regions {P.region_info}")
    groups = [{"params": [P.tex], "lr": lr["tex"], "name": "tex"}, {"params": [P.theta], "lr": lr["offset"], "name": "offset"},
              {"params": [P.log_g], "lr": lr["gain"], "name": "gain"},
              {"params": [P.w_root, P.t_root, P.w_bone], "lr": lr["pose"], "name": "pose"}]
    opt = torch.optim.Adam(groups, betas=(0.9, 0.99))
    base_lr = [g["lr"] for g in opt.param_groups]
    kernel = gauss_kernel(dev)
    rng = np.random.default_rng(seed + k)
    gen = torch.Generator().manual_seed(seed + k)
    warm = int(warm_frac * steps)
    before, _, _ = evaluate(P, clip, frames, idx_all, kernel, gen, w_clipped=w["clipped"])
    log("photofit", f"person {k} before: {before}")
    t0 = time.time()
    hist = []
    it = 0
    for it in range(steps):
        if time.time() - t0 > budget_s:
            log("photofit", f"person {k}: time budget reached at step {it}")
            break
        frac = it / max(1, steps - 1)
        for g, b in zip(opt.param_groups, base_lr):
            g["lr"] = b * (0.1 + 0.9 * 0.5 * (1 + np.cos(np.pi * frac)))
            if g["name"] == "tex" and it < warm:
                g["lr"] = 0.0
        pick = rng.choice(len(frames), size=min(batch, len(frames)), replace=False)
        idx = torch.tensor([idx_all[i] for i in pick], dtype=torch.int64, device=dev)
        Vw = P.posed(idx)
        pyr = pyramid(P.tex) if it >= warm else None
        gains = P.gains(idx)
        loss = torch.zeros((), device=dev)
        stats = {"photo": [], "l1": [], "ssim": [], "out": [], "unc": [], "iou": [], "uncFrac": []}
        for b, i in enumerate(pick):
            f = frames[i]
            wf = float(fw[i]) / len(pick)
            X = clip.to_camera(f, Vw[b])
            st = sil_terms(P, clip, f, X, gen)
            loss = loss + w["sil"] * wf * (st["out"] + w["unc"] * st["unc"])
            for key in ("out", "unc", "iou", "uncFrac"):
                stats[key].append(float(st[key]))
            if pyr is not None:
                ph = photo_terms(P, clip, f, X, pyr, gains[b], kernel, geo_grad=geo_grad, w_clipped=w["clipped"])
                if ph is not None:
                    loss = loss + w["photo"] * wf * ph["photo"]
                    for key in ("photo", "l1", "ssim"):
                        stats[key].append(float(ph[key]))
        lf, _ = floor_term(P, Vw)
        r = P.reg_terms(train_idx)
        reg = (w["lap"] * r["lap"] + w["nc"] * r["nc"] + w["tv"] * r["tv"] + w["gain"] * r["gain"] + w["gainMean"] * r["gainMean"]
               + w["poseSmooth"] * r["poseSmooth"] + w["poseMag"] * r["poseMag"] + w["floor"] * lf)
        loss = loss + reg
        opt.zero_grad(set_to_none=True)
        loss.backward()
        if it < warm:
            P.tex.grad = None
        opt.step()
        with torch.no_grad():
            P.tex.clamp_(0.0, 1.0)
        if it % 50 == 0 or it == steps - 1:
            row = {"step": it, "s": round(time.time() - t0, 1), "loss": round(float(loss), 5), "floor": round(float(lf), 4)}
            row.update({kk: round(float(np.mean(v)), 5) for kk, v in stats.items() if v})
            row.update({kk: round(float(v), 5) for kk, v in r.items()})
            hist.append(row)
            if it % 500 == 0 or it == steps - 1:
                log("photofit", f"person {k} step {it}: {row}")
    steps_done = it + 1
    fit_s = time.time() - t0
    after, per_frame, obs = evaluate(P, clip, frames, idx_all, kernel, gen, obs=True, w_clipped=w["clipped"])
    seen = (obs > w["seenObs"]) & P.island
    tex_fit = P.tex.detach().cpu().numpy()
    tex_rec, rrep = recolour_unseen(tex_fit, P.tex0, seen, P.island_lab)
    tex_rec, hrep = skin_hands(tex_rec, P.asset, P.tm)
    img, jpeg = fillmod.finish(tex_rec * 255.0, P.island)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"tex-{k}.jpg").write_bytes(jpeg)
    with torch.no_grad():
        d = P.offsets().cpu().numpy().astype(np.float64)
        wr, tr, wb = [x.cpu().numpy().astype(np.float64) for x in P.corrections()]
        g_all = P.gains(torch.arange(len(P.frames), device=dev)).cpu().numpy()
    np.savez_compressed(out / f"offsets-{k}.npz", offset=d, direction=P.udir_np, displacement=d[:, None] * P.udir_np,
                        lo=P.lo.cpu().numpy(), hi=P.hi.cpu().numpy(), upper=P.upper)
    # refined pose for every key (keys without a fitted frame carry the smoothness term's values)
    from pipeline.avatar.util import mat_to_quat, quat_to_mat

    Rr = rodrigues(torch.tensor(wr)).numpy()
    Rb = rodrigues(torch.tensor(wb)).numpy()
    delta = quat_to_mat(P.delta_q)
    for n, j in enumerate(P.cb):
        delta[:, j] = delta[:, j] @ Rb[:, n]
    root_R = Rr @ quat_to_mat(P.root_q)
    np.savez_compressed(out / f"pose-{k}.npz", delta_q=mat_to_quat(delta), root_q=mat_to_quat(root_R), root_p=P.root_p_np + tr,
                        w_root=wr, t_root=tr, w_bone=wb, gains=g_all, frames=P.frames)
    # evidence: the texture before / after, and what the fit saw
    small = 768
    t_before = cv2.resize((P.tex0 * 255).astype(np.uint8), (small, small), interpolation=cv2.INTER_AREA)
    t_after = cv2.resize(img, (small, small), interpolation=cv2.INTER_AREA)
    sv = np.zeros((TEX, TEX, 3), np.uint8)
    sv[P.island] = (60, 60, 60)
    sv[seen] = (230, 230, 230)
    sv = cv2.resize(sv, (small, small), interpolation=cv2.INTER_AREA)
    ev = np.concatenate([t_before, t_after, sv], 1)[:, :, ::-1].copy()
    label(ev, f"person-{k}: starting texture | fitted texture | texels the fit saw (white)", scale=0.5)
    (out / "evidence").mkdir(exist_ok=True)
    cv2.imwrite(str(out / "evidence" / f"texture-{k}.jpg"), ev, [cv2.IMWRITE_JPEG_QUALITY, 85])
    used = P.used.cpu().numpy()
    deg = 180 / np.pi
    tf = np.isin(np.arange(len(P.frames)), idx_all)
    up = P.upper & used
    rep = {
        "person": k, "fittedFrames": len(frames), "downWeightedFrames": int((fw < 1).sum()), "steps": steps_done,
        "fitSeconds": round(fit_s, 1),
        "offsetCm": {"median": round(100 * float(np.median(d[used])), 2), "p95": round(100 * float(np.percentile(d[used], 95)), 2),
                     "max": round(100 * float(d[used].max()), 2), "min": round(100 * float(d[used].min()), 2),
                     "upperBackP75": round(100 * float(np.percentile(d[up], 75)), 2) if up.any() else None},
        "poseCorrection": {"rootDegMedian": round(float(np.median(np.linalg.norm(wr, axis=1)) * deg), 3),
                           "rootDegP95": round(float(np.percentile(np.linalg.norm(wr, axis=1), 95) * deg), 3),
                           "rootCmMedian": round(float(np.median(np.linalg.norm(tr, axis=1)) * 100), 2),
                           "rootCmP95": round(float(np.percentile(np.linalg.norm(tr, axis=1), 95) * 100), 2),
                           "rootUpCmMaxAbs": round(float(np.abs(tr[:, 1]).max() * 100), 2),
                           "boneDegMedian": round(float(np.median(np.linalg.norm(wb, axis=2)) * deg), 3),
                           "boneDegP95": round(float(np.percentile(np.linalg.norm(wb, axis=2), 95) * deg), 3)},
        "gains": {"p05": [round(float(x), 3) for x in np.percentile(g_all[tf], 5, 0)],
                  "p50": [round(float(x), 3) for x in np.percentile(g_all[tf], 50, 0)],
                  "p95": [round(float(x), 3) for x in np.percentile(g_all[tf], 95, 0)]},
        "seenTexels": round(float(seen.sum() / max(1, P.island.sum())), 4), "recolour": rrep, "hands": hrep,
        "before": before, "after": after,
        "history": hist, "perFrame": per_frame, "regions": P.region_info, "weights": w, "lr": lr,
    }
    write_json(out / f"photofit-{k}.json", rep)
    log("photofit", f"person {k}: {({kk: v for kk, v in rep.items() if kk not in ('history', 'perFrame')})}")
    return rep


def fit(work: Path, poses: Path, prep_dir: Path, out: Path, people: list[int], held: set, tex_dir: Path,
        steps: int | None = None, batch: int = 8, scale: float = 1.0, sil_scale: float = 0.25, budget_min: float = 6.0,
        w: dict | None = None, lr: dict | None = None, warm_frac: float = 0.12, seed: int = 0, geo_grad: float = 0.25,
        device: str | None = None, pose_bounds=(5.0, 0.15, 0.02, 6.0), pack: dict | None = None, init_dir: Path | None = None,
        tex_name: str = "tex-{k}.jpg") -> dict:
    """One fitting pass over `people`; writes OUT (see the module docstring) and returns the pass report."""
    import torch

    w = dict(WEIGHTS, **(w or {}))
    lr = dict(LRS, **(lr or {}))
    dev = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
    torch.manual_seed(seed)
    t0 = time.time()
    clip = Clip(prep_dir, poses, work / "frames", scale, sil_scale, dev, people)
    if set(clip.img) & held:
        raise RuntimeError("held-out frames in the fitted set")
    reps = {}
    for k in people:
        P = Person(work, k, dev, tex_dir / tex_name.format(k=k), max_root_deg=pose_bounds[0], max_root_m=pose_bounds[1],
                   max_root_up_m=pose_bounds[2], max_bone_deg=pose_bounds[3], pack=(pack or {}).get(k, True))
        if init_dir is not None:
            P.warm_start(init_dir)
        n_steps = steps or auto_steps(len(clip.frames_of(k)), batch)
        reps[f"person-{k}"] = fit_person(P, clip, out, held, n_steps, batch, budget_min * 60, w, lr, warm_frac, seed, geo_grad)
        del P
        if dev.type == "cuda":
            torch.cuda.empty_cache()
    doc = {"work": str(work), "prep": str(prep_dir), "scale": scale, "silScale": sil_scale, "batch": batch,
           "poseBounds": {"rootDeg": pose_bounds[0], "rootM": pose_bounds[1], "rootUpM": pose_bounds[2], "boneDeg": pose_bounds[3]},
           "init": str(init_dir) if init_dir else None, "device": str(dev),
           "gpu": torch.cuda.get_device_name(0) if dev.type == "cuda" else None, "seconds": round(time.time() - t0, 1),
           "people": {k: {kk: v for kk, v in r.items() if kk not in ("history", "perFrame")} for k, r in reps.items()}}
    export(work, out)
    write_json(out / "photofit.json", doc)
    return doc


def export(work: Path, fit_dir: Path) -> dict:
    """FIT -> asset-<k>.npz with the fitted offsets applied and tracks.npz with the refined motion (what the glb step
    and the next pass's masks read)."""
    from pipeline.avatar import body
    from pipeline.avatar.body import Asset

    tr = dict(np.load(work / "tracks.npz"))
    n_people = sum(1 for k in tr if k.endswith("/rest_vertices"))
    rep = {}
    for k in range(n_people):
        pre = f"person-{k}/"
        if not (fit_dir / f"pose-{k}.npz").exists():
            continue
        a = Asset.load(work / f"asset-{k}.npz")
        od = np.load(fit_dir / f"offsets-{k}.npz")
        moved = tr[pre + "rest_vertices"] + od["displacement"]
        a.positions = moved[a.src_vertex]
        a.normals = body.vertex_normals(moved, a.src_vertex[a.tris])[a.src_vertex]
        a.save(fit_dir / f"asset-{k}.npz")
        po = np.load(fit_dir / f"pose-{k}.npz")
        tr[pre + "delta_q"], tr[pre + "root_q"], tr[pre + "root_p"] = po["delta_q"], po["root_q"], po["root_p"]
        rep[f"person-{k}"] = {"vertices": int(len(a.positions)), "triangles": int(len(a.tris))}
    np.savez_compressed(fit_dir / "tracks.npz", **tr)
    return rep


# --------------------------------------------------------------------------------------------- two passes


def run_masks(work: Path, poses: Path, world: Path | None, out: Path, hmr_file: str, holdout: Path | None,
              occluders: Path | None, workers: int) -> None:
    """The masks in a fresh process (the pool forks; the parent may hold a CUDA context)."""
    cmd = [sys.executable, "-W", "ignore", "-m", "pipeline.avatar.photofit", "masks", "--work", str(work), "--poses", str(poses),
           "--out", str(out), "--hmr", hmr_file, "--workers", str(workers)]
    if world is not None:
        cmd += ["--world", str(world)]
    if holdout is not None:
        cmd += ["--holdout", str(holdout)]
    if occluders is not None:
        cmd += ["--occluders", str(occluders)]
    log("photofit", f"masks: {' '.join(cmd[3:])}")
    subprocess.run(cmd, check=True, cwd=str(Path(__file__).resolve().parents[2]))


def run(work: Path, poses: Path, world: Path | None, holdout: Path | None = None, people: list[int] | None = None,
        passes: int = 2, steps: int | None = None, batch: int = 8, budget_min: tuple[float, float] = (4.5, 6.5),
        backpack: str = "auto", workers: int = 8, hmr_file: str = "hmr.npz", seed: int = 0, w: dict | None = None,
        lr: dict | None = None, pose_bounds=(5.0, 0.15, 0.02, 6.0)) -> dict:
    """Both passes (module docstring) -> WORK/photofit (pass 2) and WORK/photofit-1 (pass 1)."""
    t0 = time.time()
    held = set(int(f) for f in read_json(holdout)["frames"]) if holdout is not None else set()
    tr = np.load(work / "tracks.npz")
    n_people = sum(1 for k in tr.files if k.endswith("/rest_vertices"))
    people = list(range(n_people)) if people is None else people
    out_final = work / "photofit"
    doc: dict = {"passes": [], "heldOut": sorted(held), "backpack": backpack}
    prev = None
    pack = {k: backpack != "off" for k in people}
    for n in range(1, passes + 1):
        last = n == passes
        out = out_final if last else work / f"photofit-{n}"
        prep = work / f"photofit-masks-{n}"
        run_masks(work, poses, world, prep, hmr_file, holdout, prev, workers)
        if prev is not None and backpack == "auto":
            for k in people:
                od = np.load(prev / f"offsets-{k}.npz")
                pack[k], sh = pack_evidence(od["offset"], od["upper"])
                log("photofit", f"person {k}: pass {n - 1} pushed {100 * sh:.0f} % of the upper back past 8 cm -> backpack "
                                f"{'kept' if pack[k] else 'off'}")
        n_steps = steps
        if steps is None:
            meta = read_json(prep / "train.json")
            n_frames = max(sum(1 for r in meta["rows"] if r["people"].get(str(k))) for k in people)
            n_steps = auto_steps(n_frames, batch)
        rep = fit(work, poses, prep, out, people, held, tex_dir=work,
                  steps=n_steps if last else max(1000, int(round(n_steps * 2 / 3))), batch=batch,
                  budget_min=budget_min[1] if last else budget_min[0], w=w,
                  lr=lr if prev is None else {kk: v * 0.5 for kk, v in dict(LRS, **(lr or {})).items()},
                  warm_frac=0.12 if prev is None else 0.05, seed=seed, init_dir=prev, pose_bounds=pose_bounds, pack=pack)
        rep["pass"] = n
        rep["backpack"] = {f"person-{k}": bool(pack[k]) for k in people}
        doc["passes"].append(rep)
        prev = out
    doc["seconds"] = round(time.time() - t0, 1)
    write_json(out_final / "photofit.json", doc)
    return doc


# ------------------------------------------------------------------------------------------------------- CLI

WEIGHTS = {"photo": 1.0, "sil": 20.0, "unc": 1.5, "lap": 2.0, "nc": 5.0, "tv": 1.0, "gain": 1.0, "gainMean": 10.0,
           "poseSmooth": 0.01, "poseMag": 1e-4, "floor": 0.02, "seenObs": 0.1, "clipped": 0.2}
LRS = {"tex": 0.01, "offset": 0.05, "gain": 0.01, "pose": 0.01}


def _overrides(sets: list[str]) -> tuple[dict, dict]:
    w, lr = {}, {}
    for s in sets:
        key, val = s.split("=", 1)
        (lr if key.startswith("lr.") else w)[key[3:] if key.startswith("lr.") else key] = float(val)
    return w, lr


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("masks")
    m.add_argument("--work", required=True)
    m.add_argument("--poses", required=True)
    m.add_argument("--out", required=True)
    m.add_argument("--world", default=None)
    m.add_argument("--hmr", default="hmr.npz")
    m.add_argument("--holdout", default=None, help="heldout.json: frames never used")
    m.add_argument("--occluders", default=None, help="an earlier fit's folder: other people in front leave the masks")
    m.add_argument("--workers", type=int, default=8)
    r = sub.add_parser("run")
    r.add_argument("--work", required=True)
    r.add_argument("--poses", required=True)
    r.add_argument("--world", default=None)
    r.add_argument("--holdout", default=None)
    r.add_argument("--hmr", default="hmr.npz")
    r.add_argument("--passes", type=int, default=2)
    r.add_argument("--steps", type=int, default=None, help="last pass's steps (default: about 72 visits per frame)")
    r.add_argument("--batch", type=int, default=8)
    r.add_argument("--backpack", choices=["auto", "on", "off"], default="auto")
    r.add_argument("--workers", type=int, default=8)
    r.add_argument("--set", action="append", default=[], help="weight or lr override, e.g. floor=0.05 or lr.tex=0.02")
    a = ap.parse_args(argv)
    if a.cmd == "masks":
        held = set(int(f) for f in read_json(a.holdout)["frames"]) if a.holdout else None
        masks(Path(a.work), Path(a.poses), Path(a.world) if a.world else None, Path(a.out), a.hmr, held,
              Path(a.occluders) if a.occluders else None, a.workers)
    else:
        w, lr = _overrides(a.set)
        run(Path(a.work), Path(a.poses), Path(a.world) if a.world else None, Path(a.holdout) if a.holdout else None,
            passes=a.passes, steps=a.steps, batch=a.batch, backpack=a.backpack, workers=a.workers, hmr_file=a.hmr,
            w=w, lr=lr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
