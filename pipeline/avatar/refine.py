"""Step 3b (CPU): the network's detections aligned to the person masks before the motion is solved again.

    python -m pipeline.avatar.refine --work WORK --poses <clip>-poses.json [--world world.spz] [--mode full|legs]

Needs a first ground pass (tracks.npz names the people and their body scale). Then:
  - full: every detection of a tracked person is nudged against its share of the person mask (the mask split between
    the detected bodies as the yardstick splits it, at half size): a root shift and turn plus small turns of 10 bones
    (spine, neck, upper and lower arms and legs) so that the visible vertices stay on the person's pixels (or behind
    the other player or the table) and every limb's axis runs at least its radius inside them, under a Gaussian prior
    on each turn and shift. There is no keypoint model in the avatar env, so the masks are the only evidence. The
    nudges are then smoothed along each person's track (Gaussian, `smooth` frames), so a detection's nudge never
    jumps away from its neighbours', and a detection keeps the smoothed nudge only if its silhouette IoU rises;
  - legs (and full): a detection whose shins and feet are mostly below the frame edge takes the leg turns of the
    nearest detection of the same person (within 2 s) that shows them; the network's guess for hidden legs would
    otherwise steer ground's floor contact;
  - a detection cut off by the frame edge (50-90 % inside) whose fit matches its share of the mask (IoU >= 0.6) is
    trusted: ground follows it instead of interpolating over it.
Then ground runs again on WORK/hmr-refined.npz (same detections, same order as hmr.npz).

Writes WORK/hmr-refined.npz, WORK/refine.npz (trusted flags, IoU per detection), WORK/refine.json and
WORK/evidence/refine.jpg.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

from pipeline.avatar import raster
from pipeline.avatar.util import box_of, crop, label, log, project, read_json, write_json

# the bones that turn (each with everything below it) and the limb axes that must stay inside the mask
GROUPS = ("root", "spine03", "neck01", "upperarm01.L", "lowerarm01.L", "upperarm01.R", "lowerarm01.R",
          "upperleg01.L", "lowerleg01.L", "upperleg01.R", "lowerleg01.R")
AXES = (("root", "spine03", 0.11), ("spine03", "neck01", 0.11), ("neck01", "head", 0.06),
        ("upperarm01.L", "lowerarm01.L", 0.04), ("lowerarm01.L", "wrist.L", 0.03),
        ("upperarm01.R", "lowerarm01.R", 0.04), ("lowerarm01.R", "wrist.R", 0.03),
        ("upperleg01.L", "lowerleg01.L", 0.065), ("lowerleg01.L", "foot.L", 0.045),
        ("upperleg01.R", "lowerleg01.R", 0.065), ("lowerleg01.R", "foot.R", 0.045))
SIGMA_ROOT, SIGMA_BONE, SIGMA_SHIFT, SIGMA_DEPTH = 0.06, 0.12, 0.03, 0.01  # rad, rad, m, m
W_AXIS, W_PRIOR = 0.5, 0.1
TRUST_IN_FRAME, TRUST_IOU = (0.5, 0.9), 0.6


# ------------------------------------------------------------------------------------------------- masks


def owners(U: np.ndarray, Vs: list[np.ndarray], tris: np.ndarray, K: np.ndarray, size: tuple[int, int], scale: float,
           reach_m: float = 0.30):
    """Who every pixel of the person mask U (at `scale`) belongs to (index into Vs, -1 = nobody): the front-most body
    where a body covers it, else the nearest body silhouette within reach_m at that body's depth (backpacks, hoods,
    hair). Also returns the depth and body-id maps of all bodies. `size`: the full frame (H, W)."""
    import cv2

    h, w = U.shape
    owner = np.full((h, w), -1, np.int64)
    if not Vs:
        return owner, np.full((h, w), np.inf), np.full((h, w), -1)
    rend = raster.DepthRenderer(K, size[1], size[0], scale=scale)
    depth, mid, _, _ = rend.render([(V, tris) for V in Vs])
    owner[mid >= 0] = mid[mid >= 0]
    D = np.full((len(Vs), h, w), np.inf, np.float32)
    for i, V in enumerate(Vs):
        S = raster.silhouette(V, tris, K, (h, w), scale)
        dt = cv2.distanceTransform((~S).astype(np.uint8), cv2.DIST_L2, 5)
        reach = reach_m * K[0, 0] * scale / max(float(np.median(V[:, 2])), 0.3)
        D[i] = np.where(dt <= reach, dt, np.inf)
    rest = U & (owner < 0) & np.isfinite(D.min(0))
    owner[rest] = np.argmin(D, 0)[rest]
    return owner, depth, mid


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


def iou_in(S: np.ndarray, M: np.ndarray, valid: np.ndarray) -> tuple[float, float, float]:
    """IoU, precision and recall of silhouette S against mask M inside their padded box, over `valid` pixels."""
    from pipeline.avatar.ground import padded_box

    box = padded_box(S | M) & valid
    inter = np.count_nonzero(S & M & box)
    return (inter / max(1, np.count_nonzero((S | M) & box)), inter / max(1, np.count_nonzero(S & box)),
            inter / max(1, np.count_nonzero(M & box)))


# --------------------------------------------------------------------------------------------------- rig


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

    def transforms(self, w: np.ndarray, t: np.ndarray, J: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """numpy: group transforms (G, 3, 3), (G, 3) of one detection's turns w (G, 3), shift t (3), joints J."""
        import torch

        R, T = self.compose(torch.tensor(w[None], dtype=torch.float64), torch.tensor(t[None], dtype=torch.float64),
                            torch.tensor(J[self.joint][None], dtype=torch.float64))
        return R[0].numpy(), T[0].numpy()

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
    """Refines a batch of detections at once; returns per item its turns (G, 3) and root shift (3), and fills
    item['loss']."""
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
        return lo, la, pr

    with torch.no_grad():
        lo0, la0, _ = losses()
    for _ in range(iters):
        lo, la, pr = losses()
        loss = (lo + W_AXIS * la + W_PRIOR * pr).sum()
        opt.zero_grad()
        loss.backward()
        opt.step()
    with torch.no_grad():
        lo, la, pr = losses()
    out = []
    for b, it in enumerate(items):
        it["loss"] = {"outsidePx": [round(float(lo0[b]), 3), round(float(lo[b]), 3)],
                      "axisPx": [round(float(la0[b]), 3), round(float(la[b]), 3)], "prior": round(float(pr[b]), 3)}
        out.append((wv[b].detach().double().numpy(), tv[b].detach().double().numpy()))
    return out


def smooth_track(params: dict[int, tuple[np.ndarray, np.ndarray]], frame_of: dict[int, int], sigma: float) -> dict:
    """Gaussian smoothing (sigma in frames of the track) of per-detection nudges along one person's track."""
    if sigma <= 0 or len(params) < 3:
        return dict(params)
    dets = sorted(params, key=lambda d: frame_of[d])
    f = np.array([frame_of[d] for d in dets], np.float64)
    step = float(np.median(np.diff(f))) if len(f) > 1 else 1.0
    W = np.stack([p[0].ravel() for p in (params[d] for d in dets)])
    Tt = np.stack([params[d][1] for d in dets])
    out = {}
    for i, d in enumerate(dets):
        g = np.exp(-0.5 * ((f - f[i]) / (sigma * step)) ** 2)
        g[g < 1e-3] = 0
        g /= g.sum()
        out[d] = ((g @ W).reshape(params[d][0].shape), g @ Tt)
    return out


# ---------------------------------------------------------------------------------------------- the step


def refine(work: Path, poses: Path, world: Path | None, mode: str = "full", scale: float = 0.5, batch: int = 24,
           iters: int = 60, smooth: float = 1.5, evidence: int = 8) -> dict:
    import cv2
    import torch

    from pipeline.avatar import body
    from pipeline.avatar.body import Asset
    from pipeline.avatar.ground import camera_track

    torch.set_num_threads(max(1, int(__import__("os").environ.get("OMP_NUM_THREADS", "8"))))
    h = dict(np.load(work / "hmr.npz"))
    tr = np.load(work / "tracks.npz")
    doc = read_json(poses)
    W, H = int(doc["intrinsics"]["width"]), int(doc["intrinsics"]["height"])
    K = h["K"].astype(np.float64)
    Kh = K.copy()
    Kh[:2] *= scale
    hh, wh = int(round(H * scale)), int(round(W * scale))
    a0 = Asset.load(work / "asset-0.npz") if (work / "asset-0.npz").exists() else None
    labels = [str(x) for x in tr["bone_labels"]]
    parents = tr["bone_parents"]
    m = body.build_anny()
    st = body.anny_static(m)
    tris = a0.src_vertex[a0.tris] if a0 is not None else body.triangulate(st["faces"], st["face_uv"])[0]
    rig = Rig(labels, parents, st["weights"].astype(np.float64), st["indices"].astype(np.int64))
    v3d = h["v3d"].astype(np.float64)
    G = h["bone_poses"].astype(np.float64)
    tp = h["transl_pelvis"].astype(np.float64)
    frame_det = h["frame"]
    n_people = sum(1 for k in tr.files if k.endswith("/rest_vertices"))
    person_of, sigma = {}, {}
    for k in range(n_people):
        for d in tr[f"person-{k}/det"]:
            if d >= 0:
                person_of[int(d)] = k
        sigma[k] = float(tr[f"person-{k}/body_scale"]) if f"person-{k}/body_scale" in tr.files else 1.0
    cams = camera_track(doc)
    occ = None
    if world is not None and Path(world).exists():
        from pipeline.avatar.world import Occluders

        occ = Occluders(Path(world))
    se3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    newV, newG, newT = v3d.copy(), G.copy(), tp.copy()
    j2d = h["j2d"].astype(np.float64).copy()
    rows: dict[int, dict] = {}
    masks: dict[int, tuple] = {}  # det -> packed (M, valid)
    raw: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    pending: list[dict] = []

    def flush():
        if not pending:
            return
        for it, prm in zip(pending, fit_batch(pending, rig, Kh, (hh, wh), iters)):
            raw[it["det"]] = prm
            rows[it["det"]] = it["loss"]
        pending.clear()

    used = [int(f) for f in h["used_frames"]]
    t0 = time.time()
    for n, f in enumerate(used):
        if n % 40 == 0:
            log("refine", f"frame {f} ({n + 1}/{len(used)}), {len(masks)} detections, {time.time() - t0:.0f} s")
        dets = np.nonzero(frame_det == f)[0]
        mine = [int(d) for d in dets if int(d) in person_of]
        if not mine:
            continue
        mk = cv2.imread(str(work / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if mk is None:
            continue
        U = cv2.resize(mk, (wh, hh), interpolation=cv2.INTER_LINEAR) > 127
        Vs = [v3d[d] for d in dets]
        owner, depth, mid = owners(U, Vs, tris, K, (H, W), scale)
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
            if M.sum() < 200:
                continue
            masks[d] = (np.packbits(M), np.packbits(~O & ~T))
            if mode != "full":
                continue
            allowed = M | O | T
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
            pending.append({"det": d, "V": v3d[d], "J": J, "vis": vis, "dout": dout, "din": din, "rad": rad})
            if len(pending) >= batch:
                flush()
    flush()
    # smoothed nudges per person, kept where they raise the detection's IoU
    fof = {int(d): int(frame_det[d]) for d in masks}
    smoothed: dict[int, tuple] = {}
    for k in range(n_people):
        smoothed.update(smooth_track({d: p for d, p in raw.items() if person_of[d] == k}, fof, smooth))
    unpack = lambda b: np.unpackbits(b)[: hh * wh].reshape(hh, wh).astype(bool)  # noqa: E731
    shots = []
    for d in sorted(masks):
        M, valid = unpack(masks[d][0]), unpack(masks[d][1])
        S0 = raster.silhouette(v3d[d], tris, K, (hh, wh), scale)
        i0 = iou_in(S0, M, valid)
        i1, keep, S1 = i0, False, S0
        Jc = tp[d] + G[d, :, :3, 3]
        if d in smoothed:
            R, T = rig.transforms(smoothed[d][0], smoothed[d][1], Jc)
            Vn = rig.apply(v3d[d], R, T)
            S1 = raster.silhouette(Vn, tris, K, (hh, wh), scale)
            i1 = iou_in(S1, M, valid)
            keep = i1[0] > i0[0] + 0.002
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
            else:
                i1 = i0
        uvd = project(K, newV[d][::4])
        in_frame = float(((uvd[:, 0] >= 0) & (uvd[:, 0] < W) & (uvd[:, 1] >= 0) & (uvd[:, 1] < H)).mean())
        r = {"det": int(d), "frame": int(frame_det[d]), "person": person_of[d], "kept": bool(keep),
             "iou": [round(i0[0], 4), round(i1[0], 4)], "precision": [round(i0[1], 4), round(i1[1], 4)],
             "recall": [round(i0[2], 4), round(i1[2], 4)], "inFrame": round(in_frame, 3)}
        if d in smoothed:
            r.update(rows.get(d, {}), turnDeg=round(float(np.degrees(np.linalg.norm(smoothed[d][0], axis=1).max())), 2),
                     shiftCm=[round(100 * float(x), 2) for x in smoothed[d][1]])
        rows[d] = r
        if keep and (len(shots) < evidence or i1[0] - i0[0] > shots[-1][0]):
            shots.append((i1[0] - i0[0], d, masks[d], S0, S1))
            shots.sort(key=lambda s: -s[0])
            del shots[evidence:]
    rows = {d: r for d, r in rows.items() if "det" in r}
    borrowed = borrow_legs(m, st, labels, parents, h, newV, newG, newT, j2d, person_of, K, (H, W))
    out = dict(h)
    out["v3d"] = newV.astype(np.float16)
    out["bone_poses"] = newG.astype(np.float32)
    out["transl_pelvis"] = newT.astype(np.float32)
    out["j2d"] = j2d.astype(np.float32)
    np.savez(work / "hmr-refined.npz", **out)
    det_ids = np.array(sorted(rows), np.int64)
    in_frame = np.array([rows[d]["inFrame"] for d in det_ids])
    iou_after = np.array([rows[d]["iou"][1] for d in det_ids])
    trusted = np.zeros(len(frame_det), bool)
    trusted[det_ids] = (in_frame < TRUST_IN_FRAME[1]) & (in_frame >= TRUST_IN_FRAME[0]) & (iou_after >= TRUST_IOU)
    np.savez(work / "refine.npz", det=det_ids, trusted=trusted, iou_after=iou_after, in_frame=in_frame)
    rep: dict = {"mode": mode, "smoothFrames": smooth, "detections": len(rows), "seconds": round(time.time() - t0, 1),
                 "legsBorrowed": borrowed, "people": {}}
    for k in range(n_people):
        rs = [r for r in rows.values() if r["person"] == k]
        if not rs:
            continue
        kept = [r for r in rs if r["kept"]]
        rep["people"][f"person-{k}"] = {
            "detections": len(rs), "kept": round(len(kept) / len(rs), 3),
            "iouBefore": round(float(np.median([r["iou"][0] for r in rs])), 4),
            "iouAfter": round(float(np.median([r["iou"][1] for r in rs])), 4),
            "precisionAfter": round(float(np.median([r["precision"][1] for r in rs])), 4),
            "recallAfter": round(float(np.median([r["recall"][1] for r in rs])), 4),
            "turnDegMedian": round(float(np.median([r["turnDeg"] for r in kept])), 2) if kept else None,
            "shiftCmMedian": round(float(np.median([np.linalg.norm(r["shiftCm"]) for r in kept])), 2) if kept else None,
            "cutOffTrusted": int(trusted[[r["det"] for r in rs]].sum()),
            "cutOff": int(sum(1 for r in rs if r["inFrame"] < TRUST_IN_FRAME[1]))}
    rep["perDetection"] = [rows[d] for d in det_ids]
    write_json(work / "refine.json", rep)
    draw_refine(work, shots, frame_det, (hh, wh))
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
    from pipeline.avatar.util import rigid_inv

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


def draw_refine(work: Path, shots: list, frame_det: np.ndarray, hw: tuple[int, int]) -> None:
    """The detections whose IoU rose most: the person's share of the mask (red), the network body (yellow outline)
    and the refined body (green outline)."""
    import cv2

    if not shots:
        return
    ev = work / "evidence"
    ev.mkdir(parents=True, exist_ok=True)
    hh, wh = hw
    unpack = lambda b: np.unpackbits(b)[: hh * wh].reshape(hh, wh).astype(bool)  # noqa: E731
    tiles = []
    for gain, d, (Mb, Vb), S0, S1 in shots:
        M, valid = unpack(Mb), unpack(Vb)
        img = cv2.imread(str(work / "frames" / f"f{int(frame_det[d]):06d}.jpg"))
        if img is None:
            continue
        img = cv2.resize(img, (wh, hh), interpolation=cv2.INTER_AREA)
        ov = img.copy()
        ov[M] = (40, 40, 220)
        ov[~valid] = (90, 90, 90)
        vis = cv2.addWeighted(img, 0.55, ov, 0.45, 0)
        for S, col in ((S0, (0, 230, 255)), (S1, (60, 220, 60))):
            c, _ = cv2.findContours(S.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(vis, c, -1, col, 1)
        box = box_of(M | S0, pad=0.08, aspect=0.75)
        if box is None:
            continue
        t = crop(vis, box, (240, 320), fill=40)
        label(t, f"f{int(frame_det[d])} iou {gain:+.3f}", scale=0.45)
        tiles.append(t)
    if tiles:
        sheet = np.concatenate(tiles, 1)
        bar = np.full((24, sheet.shape[1], 3), 30, np.uint8)
        cv2.putText(bar, "red: the person's share of the mask; grey: other people and the table; yellow: network body; "
                         "green: refined body (largest IoU gains)", (6, 16), cv2.FONT_HERSHEY_SIMPLEX,
                    0.42, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imwrite(str(ev / "refine.jpg"), np.concatenate([bar, sheet], 0), [cv2.IMWRITE_JPEG_QUALITY, 88])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--poses", required=True)
    ap.add_argument("--world", default=None)
    ap.add_argument("--mode", choices=["full", "legs"], default="full")
    ap.add_argument("--smooth", type=float, default=1.5)
    a = ap.parse_args(argv)
    refine(Path(a.work), Path(a.poses), Path(a.world) if a.world else None, a.mode, smooth=a.smooth)
    return 0


if __name__ == "__main__":
    sys.exit(main())
