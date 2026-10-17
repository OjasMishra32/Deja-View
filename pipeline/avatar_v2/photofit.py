"""Prototype A: each person's texture, clothing volume and alignment fitted to the training frames by
differentiable rendering.

    python -m pipeline.avatar_v2.photofit prep --work WORK --poses POSES --world WORLD --eval EVAL --out PREP
    python -m pipeline.avatar_v2.photofit fit --work WORK --poses POSES --eval EVAL --prep PREP --out FIT --glb-dir OUT
    python -m pipeline.avatar_v2.photofit export --work WORK --fit FIT --glb-dir OUT [--base-glb-dir DIR]

WORK is a pipeline/avatar work folder built without the held-out frames (v2/work-heldout): its tracks, assets,
offsets and filled textures are the starting point. Nothing here reads a held-out frame (EVAL/heldout.json lists
them; prep skips them and fit refuses them).

prep (CPU): the yardstick's masks (yardstick.prepare, same settings) for every training frame: the person mask
  shared between the detected bodies, M = person k's share, E = M eroded by 3 px minus the table, V = the pixels
  that count (not another person's, not the table in front of the legs). With --occluders (an earlier fit's GLBs),
  mask pixels where another fitted person, backpack included, stands in front count for nobody: the split by the
  bare network bodies hands the near player's backpack and keychain to the player behind.
fit (GPU): per person, starting from the held-out baseline, Adam on
  - the 2048 UV texture (a free texel grid, sampled through a mip pyramid with one level per triangle, like the
    yardstick and the viewer),
  - one offset per model vertex (clothes, hair, hood, backpack) along its rest normal, turned towards the body's
    back on the upper back (a backpack is a box behind the back), bounded per body region (upper back up to 22 cm,
    head 8 cm, face and hands 1 cm, ...), Laplacian-smoothed and normal-consistent, starting from the silhouette
    offsets the baseline computed and rejected,
  - a colour gain per frame (3 numbers, log-gains bounded to +-0.3, pulled to 0 and to a zero clip mean, so the
    texture keeps the clip's mean exposure),
  - a pose correction per frame (root: up to 5 degrees and 15 cm; 12 main bones: up to 6 degrees), smooth over
    time; the held-out frames get theirs from the smoothness term alone (their training neighbours),
  against
  - photometric: 0.8 L1 + 0.2 (1 - SSIM) between the render (times the frame's gain) and the frame, over the pixels
    of E the render covers (the other player and the table are not in E, nor, for this loss only, the table's
    rods and handles inside the person mask: splats below 0.95 m standing 15 cm in front of the body); its
    gradient reaches the geometry at a quarter of its strength, so the silhouettes lead the shape,
  - silhouette (quarter resolution): surface points outside M (the other people and the table are allowed) are
    pulled in along the distance transform (weighted by the surface area they stand for), and pixels of M the
    render misses pull their three nearest vertices out, both in metres at the point's depth,
  - total variation of the texture's change from the baseline inside each UV chart (the baseline's own detail is
    kept unless the frames disagree).
  Rendering: a z-buffer rasteriser in torch (no gradient) picks each pixel's front triangle; the barycentrics are
  recomputed differentiably from the projected vertices (perspective-correct), then UVs and the texture lookup, so
  the texture, offsets, gains and pose all get gradients. Afterwards every texel's observation weight (the
  gradient of the summed render with respect to the texture) decides 'seen'; texels never seen keep the baseline
  fill (mirror, generated back, LaMa), re-coloured by the change of their seen neighbours in the same UV chart
  (push-pull of the colour change).
  --init FIT continues from an earlier fit (texture, offsets, pose corrections, gains); the baseline stays the
  reference of the texture's change and of the unseen texels.
export: FIT/asset-<k>.npz (offsets applied), FIT/offsets-<k>.npz (per model vertex: offset, direction,
displacement), FIT/tex-<k>.jpg, FIT/pose-<k>.npz, FIT/tracks.npz (refined pose), OUT/avatar-<k>.glb.

Variant A (IMG_7373) is two passes: prep -> fit (3000 steps) -> prep --occluders OUT1 -> fit --init FIT1 (3000
steps at half the learning rates, 5 % warm-up); each fit takes about 4 minutes per person on one RTX PRO 6000.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar.util import log, read_json, write_json

ERODE_PX, REACH_M, TABLE_MARGIN = 3, 0.30, 0.10  # the yardstick's mask settings
BIT_M, BIT_E, BIT_V, BIT_F = 1, 2, 4, 8
LOW_FURNITURE_M, LOW_FURNITURE_GAP = 0.95, 0.15  # table height; how far in front of the body it must stand
POSE_BONES = ("spine04", "spine02", "neck01", "head", "upperarm01.L", "upperarm01.R", "lowerarm01.L", "lowerarm01.R",
              "upperleg01.L", "upperleg01.R", "lowerleg01.L", "lowerleg01.R")
TEX = 2048


# --------------------------------------------------------------------------------------------------- prep

_P: dict = {}  # what the prep workers read (filled before the pool forks)


def _prep_frame(f: int):
    import cv2

    from pipeline.avatar import raster
    from pipeline.avatar_v2 import yardstick as ys

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
    owner = ys.partition(U, Vs, tris, K, rend, REACH_M)
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
    # a previous fit's people (clothes and backpacks included) as occluders: which of them is front-most per pixel
    fitted = None
    if g["fits"] is not None and int(f) in cams:
        Tf = cams[int(f)]
        meshes, ids = [], []
        for j, gl in enumerate(g["fits"]):
            i = np.nonzero(tr[f"person-{j}/frames"] == f)[0]
            if gl is None or not len(i):
                continue
            Vw, _ = gl.pose(float(tr[f"person-{j}/times"][i[0]]))
            meshes.append(((Vw - Tf[:3, 3]) @ Tf[:3, :3], gl.F))
            ids.append(j)
        if meshes:
            _, mid, _, _ = rend.render(meshes)
            fitted = np.where(mid >= 0, np.asarray(ids)[np.clip(mid, 0, None)], -1)
    se_d = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * ERODE_PX + 1, 2 * ERODE_PX + 1))
    se_t = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
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
                # the table's rods and handles in front of the thighs sit inside the person mask; for the photometric
                # loss only (the yardstick keeps them): table-height splats well in front of the body
                Fin = (cv2.dilate((furn_low < sigma[k] * zmap - LOW_FURNITURE_GAP).astype(np.uint8), se_t) > 0) & M
        E = (cv2.erode(M.astype(np.uint8), se_d) > 0) & ~T
        valid = ~others & ~T
        arrays[f"f{int(f)}/p{k}"] = (M.astype(np.uint8) * BIT_M | E.astype(np.uint8) * BIT_E | valid.astype(np.uint8) * BIT_V
                                     | Fin.astype(np.uint8) * BIT_F)
        box = ys.box_of(M | E)
        row["people"][str(k)] = {"det": d, "index": int(i[0]), "trackValid": bool(tr[f"person-{k}/valid"][i[0]]),
                                 "maskPx": int(M.sum()), "evalPx": int(E.sum()), "tablePx": int((T & U).sum()), "tableInMaskPx": int(Fin.sum()),
                                 "otherInFrontPx": int(Oc.sum()),
                                 "box": list(box) if box else None}
    return int(f), arrays, row


def prep(work: Path, poses: Path, world: Path | None, eval_dir: Path, out: Path, workers: int = 8,
         occluders: Path | None = None) -> dict:
    """The yardstick's M / E / V masks for every training frame -> OUT/train.npz (one uint8 bit image per frame and
    person: 1 = M, 2 = E, 4 = V, 8 = the table inside the person mask) and OUT/train.json. occluders: a GLB folder of
    an earlier fit (avatar-<k>.glb, trained without the held-out frames too); mask pixels where another fitted person
    is in front leave M, E and V."""
    import multiprocessing as mp

    from pipeline.avatar.body import Asset
    from pipeline.avatar.ground import camera_track

    out.mkdir(parents=True, exist_ok=True)
    held = set(int(f) for f in read_json(eval_dir / "heldout.json")["frames"])
    h = np.load(work / "hmr.npz")
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
        from pipeline.avatar_v2 import yardstick as ys

        fits = [ys.Glb(occluders / f"avatar-{k}.glb") if (occluders / f"avatar-{k}.glb").exists() else None for k in range(n_people)]
    _P.update(work=work, K=h["K"].astype(np.float64), v3d=h["v3d"], det_frame=h["frame"], tris=a0.src_vertex[a0.tris],
              tracks=tr, sigma=[float(tr.get(f"person-{k}/body_scale", 1.0)) for k in range(n_people)],
              hw=(int(doc["intrinsics"]["height"]), int(doc["intrinsics"]["width"])), occ=occ, occ_low=occ_low,
              cams=camera_track(doc), fits=fits,
              people=n_people)
    t0 = time.time()
    arrays: dict[str, np.ndarray] = {}
    rows = []
    with mp.get_context("fork").Pool(workers) as pool:
        for n, (f, arr, row) in enumerate(pool.imap_unordered(_prep_frame, frames, chunksize=2)):
            arrays.update(arr)
            rows.append(row)
            if n % 25 == 0:
                log("photofit", f"prep {n + 1}/{len(frames)} (frame {f}) {time.time() - t0:.0f} s")
    rows.sort(key=lambda r: r["frame"])
    np.savez_compressed(out / "train.npz", **arrays)
    meta = {"work": str(work), "poses": str(poses), "world": str(world) if world else None, "heldOut": sorted(held),
            "frames": [r["frame"] for r in rows], "people": n_people, "width": _P["hw"][1], "height": _P["hw"][0],
            "K": _P["K"].tolist(), "erodePx": ERODE_PX, "reachM": REACH_M, "tableMarginM": TABLE_MARGIN,
            "occluders": str(occluders) if occluders else None, "rows": rows,
            "seconds": round(time.time() - t0, 1)}
    write_json(out / "train.json", meta)
    log("photofit", f"prep: {len(rows)} training frames in {meta['seconds']} s -> {out}")
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
    """(S, S, 3) texture -> mip levels [(1, 3, S, S), (1, 3, S/2, S/2), ... (1, 3, 1, 1)] (2 x 2 means, as the
    yardstick's cv2 INTER_AREA halving)."""
    import torch.nn.functional as Fn

    lv = [tex.permute(2, 0, 1)[None]]
    while min(lv[-1].shape[-2:]) > 1:
        lv.append(Fn.avg_pool2d(lv[-1], 2))
    return lv


def sample_mip(pyr, uv, lev):
    """Trilinear samples (n, 3) at glTF UVs (n, 2), mip level per sample (n,) (clamp-to-edge, like the yardstick)."""
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


# ------------------------------------------------------------------------------------------------- the data


class Clip:
    """The training frames (at the photometric scale) and every person's masks, on the device."""

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

    def to_camera(self, f: int, Vw):
        R, t = self.cam[f]
        return (Vw - t) @ R


def offset_bounds(a, rest_v: np.ndarray, n0: np.ndarray, src_tris: np.ndarray, pack_bias: float = 3.0):
    """Per model vertex (lo, hi) of the outward offset in metres, by body region: the upper back (the backpacks)
    up to 22 cm, the head 8 cm (hair, hood), the face and hands 1 cm, feet 3 cm, arms and legs 5 cm (sleeves,
    shorts), the rest of the torso 6 cm; caps blended over a few rings of the mesh so regions meet smoothly. Also the
    direction each vertex moves along: its rest normal, turned towards the body's back on the upper back.
    Returns (lo, hi, direction (nv, 3), counts)."""
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
    zb = {b: float(a.rest_bone_poses[labels.index(b), 2, 3]) for b in ("spine05", "neck01")}
    torso = ~arm & ~leg & ~head & ~hands & ~feet
    back = torso & (fwd < -0.3) & (z > zb["spine05"]) & (z < zb["neck01"])
    hi = np.full(nv, 0.06)
    hi[arm | leg] = 0.05
    hi[head] = 0.08
    hi[face] = 0.01
    hi[feet] = 0.03
    hi[back] = 0.22
    hi[hands] = 0.01
    L = offs.neighbours(src_tris, nv)
    for _ in range(12):
        hi = 0.5 * hi + 0.5 * (L @ hi)
    hi[hands] = 0.01
    hi = np.maximum(hi, 0.01)
    lo = np.full(nv, -0.01)
    lo[hands | face] = -0.004
    # the upper back moves mostly straight backwards (a backpack is a box behind the back, not a swelling along the
    # back's normals, which on the sides of the back point sideways)
    pack = back.astype(np.float64)
    for _ in range(12):
        pack = 0.5 * pack + 0.5 * (L @ pack)
    bdir = np.array([0.0, -texture.front_sign(a), 0.0])
    u = n0 + pack_bias * pack[:, None] * bdir
    u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9)
    return lo, hi, u, {"backVertices": int(back.sum()), "headVertices": int(head.sum()), "faceVertices": int(face.sum())}


class Person:
    """One person's parameters (texture, offsets, gains, pose corrections) and the differentiable posed mesh."""

    def __init__(self, work: Path, k: int, dev, max_root_deg: float = 5.0, max_root_m: float = 0.15,
                 max_bone_deg: float = 6.0, max_log_gain: float = 0.3, pack_bias: float = 3.0):
        import cv2
        import torch

        from pipeline.avatar import body
        from pipeline.avatar.body import Asset
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
        self.asset_gap_m = float(np.abs(a.positions - rest_v[a.src_vertex]).max())
        lo, hi, udir, self.region_info = offset_bounds(a, rest_v, n0, src_tris, pack_bias)
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
        self.max_t = max_root_m
        self.max_bone = np.radians(max_bone_deg)
        self.max_lg = max_log_gain
        self.w_root = torch.zeros(T, 3, **f32).requires_grad_(True)
        self.t_root = torch.zeros(T, 3, **f32).requires_grad_(True)
        self.w_bone = torch.zeros(T, len(self.cb), 3, **f32).requires_grad_(True)
        self.log_g = torch.zeros(T, 3, **f32).requires_grad_(True)
        # texture: the held-out baseline's filled atlas
        tex = cv2.imread(str(work / f"tex-{k}.jpg"))[:, :, ::-1].astype(np.float32) / 255.0
        if tex.shape[:2] != (TEX, TEX):
            tex = cv2.resize(tex, (TEX, TEX), interpolation=cv2.INTER_AREA)
        self.tex0 = tex
        self.tex = torch.tensor(tex, **f32).requires_grad_(True)
        self.tex0_t = torch.tensor(tex, **f32)
        tm = texel_map(a, TEX)
        self.island = tm.tri >= 0
        # UV charts: triangles joined through shared split vertices (atlas pixels of different charts can touch)
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components

        ns = len(a.positions)
        e = np.concatenate([a.tris[:, [0, 1]], a.tris[:, [1, 2]]])
        _, comp = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(ns, ns)), directed=False)
        lab = np.where(self.island, comp[a.tris[np.clip(tm.tri, 0, None), 0]] + 1, 0).astype(np.int32)
        self.island_lab = lab
        lab_t = torch.tensor(lab, dtype=torch.int32, device=dev)
        # surface area per split vertex (a third of each adjacent triangle), for area-weighted silhouette terms
        P0 = a.positions
        ta = 0.5 * np.linalg.norm(np.cross(P0[a.tris[:, 1]] - P0[a.tris[:, 0]], P0[a.tris[:, 2]] - P0[a.tris[:, 0]]), axis=1)
        va = np.zeros(ns)
        for j in range(3):
            np.add.at(va, a.tris[:, j], ta / 3)
        self.v_area = torch.tensor(va / va.sum(), **f32)
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
        """Continue from an earlier fit of the same person: texture, offsets, pose corrections, gains. The baseline
        stays the reference of the texture's change (tex0) and of the unseen texels."""
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
                    return np.arctanh(np.clip(x / m, -0.995, 0.995)) if m > 0 else np.zeros_like(x)

                self.w_root.copy_(torch.tensor(raw(po["w_root"], self.max_root), dtype=torch.float32, device=self.dev))
                self.t_root.copy_(torch.tensor(raw(po["t_root"], self.max_t), dtype=torch.float32, device=self.dev))
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
        import torch

        return torch.exp(self.max_lg * torch.tanh(self.log_g[idx]))

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
        tex = self.tex - self.tex0_t  # the change is smooth; the baseline's own detail is not penalised
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


def project(X, K, s: float):
    import torch

    z = X[:, 2]
    zc = z.clamp(min=1e-3)
    return torch.stack([K[0, 0] * s * X[:, 0] / zc + K[0, 2] * s, K[1, 1] * s * X[:, 1] / zc + K[1, 2] * s], 1), z


def photo_terms(P: Person, clip: Clip, f: int, X, pyr, gain, kernel, geo_grad: float = 0.25, want_obs: bool = False):
    """Photometric loss of person P in frame f (camera-space vertices X), or None when too little of E is covered."""
    import torch

    k = P.k
    row = clip.rows[f]["people"][str(k)]
    s = clip.s
    xy, z = project(X, clip.K, s)
    # crop: the mask's box and the projected body, inside the image
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
    if want_obs:
        return col[inP].sum(), n
    pred = col * gain[None]
    l1 = (pred - real).abs()[inP].mean()
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
    """Silhouette losses of person P in frame f at the silhouette scale (see the module docstring)."""
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
    l_out = (P.v_area * dv * z.clamp(min=0.1) / fq).sum()
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


# ---------------------------------------------------------------------------------------------------- fit


def recolour_unseen(tex_fit: np.ndarray, tex0: np.ndarray, seen: np.ndarray, lab: np.ndarray) -> tuple[np.ndarray, dict]:
    """Texels the fit never saw: the baseline fill plus the colour change of the seen texels of the same UV chart
    (lab: chart per texel, 0 = outside; push-pull); charts with nothing seen take the atlas-wide push-pull."""
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


def evaluate(P: Person, clip: Clip, frames: list[int], idx_all: list[int], kernel, gen, obs: bool = False):
    """Per training frame: PSNR / SSIM over E (with the frame's gain), cover, silhouette IoU at the silhouette scale.
    With obs, also every texel's observation weight (the gradient of the summed render over E with respect to the
    texture: how much of the frames' pixels it fed)."""
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
        for b, i in enumerate(chunk):
            f = frames[i]
            X = clip.to_camera(f, Vw[b])
            if obs:
                o = photo_terms(P, clip, f, X, pyramid(texd + probe), gains[b], kernel, want_obs=True)
                if o is not None:
                    o[0].backward()
            with torch.no_grad():
                ph = photo_terms(P, clip, f, X, pyramid(texd), gains[b], kernel)
                st = sil_terms(P, clip, f, X, gen)
            r = {"frame": f, "silIoUq": round(float(st["iou"]), 4), "gain": [round(float(x), 4) for x in gains[b]]}
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

    return {"psnrWithGain": mean("psnrGain"), "ssim": mean("ssim"), "cover": mean("cover"), "silIoUquarter": mean("silIoUq")}, rows, ob


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
        raise RuntimeError(f"held-out frames among the training frames: {bad}")
    idx_all = [P.index_of[f] for f in frames]
    train_idx = torch.tensor(idx_all, dtype=torch.int64, device=dev)
    log("photofit", f"person {k}: {len(frames)} training frames, asset vs rest gap {P.asset_gap_m * 100:.2f} cm, "
                    f"regions {P.region_info}")
    groups = [{"params": [P.tex], "lr": lr["tex"], "name": "tex"}, {"params": [P.theta], "lr": lr["offset"], "name": "offset"},
              {"params": [P.log_g], "lr": lr["gain"], "name": "gain"},
              {"params": [P.w_root, P.t_root, P.w_bone], "lr": lr["pose"], "name": "pose"}]
    opt = torch.optim.Adam(groups, betas=(0.9, 0.99))
    base_lr = [g["lr"] for g in opt.param_groups]
    kernel = gauss_kernel(dev)
    rng = np.random.default_rng(seed + k)
    gen = torch.Generator().manual_seed(seed + k)
    warm = int(warm_frac * steps)
    train_before, _, _ = evaluate(P, clip, frames, idx_all, kernel, gen)
    log("photofit", f"person {k} before: {train_before}")
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
            X = clip.to_camera(f, Vw[b])
            st = sil_terms(P, clip, f, X, gen)
            loss = loss + w["sil"] * (st["out"] + w["unc"] * st["unc"]) / len(pick)
            for key in ("out", "unc", "iou", "uncFrac"):
                stats[key].append(float(st[key]))
            if pyr is not None:
                ph = photo_terms(P, clip, f, X, pyr, gains[b], kernel, geo_grad=geo_grad)
                if ph is not None:
                    loss = loss + w["photo"] * ph["photo"] / len(pick)
                    for key in ("photo", "l1", "ssim"):
                        stats[key].append(float(ph[key]))
        r = P.reg_terms(train_idx)
        reg = (w["lap"] * r["lap"] + w["nc"] * r["nc"] + w["tv"] * r["tv"] + w["gain"] * r["gain"] + w["gainMean"] * r["gainMean"]
               + w["poseSmooth"] * r["poseSmooth"] + w["poseMag"] * r["poseMag"])
        loss = loss + reg
        opt.zero_grad(set_to_none=True)
        loss.backward()
        if it < warm:
            P.tex.grad = None
        opt.step()
        with torch.no_grad():
            P.tex.clamp_(0.0, 1.0)
        if it % 50 == 0 or it == steps - 1:
            row = {"step": it, "s": round(time.time() - t0, 1), "loss": round(float(loss), 5)}
            row.update({kk: round(float(np.mean(v)), 5) for kk, v in stats.items() if v})
            row.update({kk: round(float(v), 5) for kk, v in r.items()})
            hist.append(row)
            if it % 200 == 0 or it == steps - 1:
                log("photofit", f"person {k} step {it}: {row}")
    steps_done = it + 1
    fit_s = time.time() - t0
    train_after, per_frame, obs = evaluate(P, clip, frames, idx_all, kernel, gen, obs=True)
    seen = (obs > w["seenObs"]) & P.island
    tex_fit = P.tex.detach().cpu().numpy()
    tex_rec, rrep = recolour_unseen(tex_fit, P.tex0, seen, P.island_lab)
    img, jpeg = fillmod.finish(tex_rec * 255.0, P.island)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"tex-{k}.jpg").write_bytes(jpeg)
    with torch.no_grad():
        d = P.offsets().cpu().numpy().astype(np.float64)
        wr, tr, wb = [x.cpu().numpy().astype(np.float64) for x in P.corrections()]
        g_all = P.gains(torch.arange(len(P.frames), device=dev)).cpu().numpy()
    np.savez_compressed(out / f"offsets-{k}.npz", offset=d, direction=P.udir_np, displacement=d[:, None] * P.udir_np,
                        lo=P.lo.cpu().numpy(), hi=P.hi.cpu().numpy())
    # refined pose for every key (held-out keys carry the smoothness term's values)
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
    from pipeline.avatar_v2.yardstick import label

    label(ev, f"person-{k}: baseline texture | photofit texture | texels the fit saw (white)", scale=0.5)
    (out / "evidence").mkdir(exist_ok=True)
    cv2.imwrite(str(out / "evidence" / f"texture-{k}.jpg"), ev, [cv2.IMWRITE_JPEG_QUALITY, 85])
    used = P.used.cpu().numpy()
    deg = 180 / np.pi
    tf = np.isin(np.arange(len(P.frames)), idx_all)
    rep = {
        "person": k, "trainingFrames": len(frames), "steps": steps_done, "fitSeconds": round(fit_s, 1),
        "offsetCm": {"median": round(100 * float(np.median(d[used])), 2), "p95": round(100 * float(np.percentile(d[used], 95)), 2),
                     "max": round(100 * float(d[used].max()), 2), "min": round(100 * float(d[used].min()), 2)},
        "poseCorrection": {"rootDegMedian": round(float(np.median(np.linalg.norm(wr, axis=1)) * deg), 3),
                           "rootDegP95": round(float(np.percentile(np.linalg.norm(wr, axis=1), 95) * deg), 3),
                           "rootCmMedian": round(float(np.median(np.linalg.norm(tr, axis=1)) * 100), 2),
                           "rootCmP95": round(float(np.percentile(np.linalg.norm(tr, axis=1), 95) * 100), 2),
                           "boneDegMedian": round(float(np.median(np.linalg.norm(wb, axis=2)) * deg), 3),
                           "boneDegP95": round(float(np.percentile(np.linalg.norm(wb, axis=2), 95) * deg), 3)},
        "gains": {"p05": [round(float(x), 3) for x in np.percentile(g_all[tf], 5, 0)],
                  "p50": [round(float(x), 3) for x in np.percentile(g_all[tf], 50, 0)],
                  "p95": [round(float(x), 3) for x in np.percentile(g_all[tf], 95, 0)]},
        "seenTexels": round(float(seen.sum() / max(1, P.island.sum())), 4), "recolour": rrep,
        "trainBefore": train_before, "trainAfter": train_after,
        "history": hist, "perFrame": per_frame, "regions": P.region_info, "weights": w, "lr": lr,
    }
    write_json(out / f"photofit-{k}.json", rep)
    log("photofit", f"person {k}: {({kk: v for kk, v in rep.items() if kk not in ('history', 'perFrame')})}")
    return rep


def fit(work: Path, poses: Path, eval_dir: Path, prep_dir: Path, out: Path, glb_dir: Path | None, people: list[int],
        steps: int, batch: int, scale: float, sil_scale: float, budget_min: float, w: dict, lr: dict, warm_frac: float,
        seed: int, geo_grad: float, device: str | None, base_glb_dir: Path | None, pose_bounds=(5.0, 0.15, 6.0),
        pack_bias: float = 3.0, init_dir: Path | None = None) -> dict:
    import torch

    dev = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
    torch.manual_seed(seed)
    held = set(int(f) for f in read_json(eval_dir / "heldout.json")["frames"])
    t0 = time.time()
    clip = Clip(prep_dir, poses, work / "frames", scale, sil_scale, dev, people)
    if set(clip.img) & held:
        raise RuntimeError("held-out frames in the training set")
    reps = {}
    for k in people:
        P = Person(work, k, dev, max_root_deg=pose_bounds[0], max_root_m=pose_bounds[1], max_bone_deg=pose_bounds[2],
                   pack_bias=pack_bias)
        if init_dir is not None:
            P.warm_start(init_dir)
        reps[f"person-{k}"] = fit_person(P, clip, out, held, steps, batch, budget_min * 60, w, lr, warm_frac, seed, geo_grad)
        del P
        if dev.type == "cuda":
            torch.cuda.empty_cache()
    doc = {"work": str(work), "prep": str(prep_dir), "scale": scale, "silScale": sil_scale, "steps": steps, "batch": batch,
           "poseBounds": {"rootDeg": pose_bounds[0], "rootM": pose_bounds[1], "boneDeg": pose_bounds[2]}, "packBias": pack_bias,
           "init": str(init_dir) if init_dir else None,
           "device": str(dev), "gpu": torch.cuda.get_device_name(0) if dev.type == "cuda" else None,
           "seconds": round(time.time() - t0, 1), "people": {k: {kk: v for kk, v in r.items() if kk not in ("history", "perFrame")}
                                                              for k, r in reps.items()}}
    write_json(out / "photofit.json", doc)
    if glb_dir is not None:
        doc["export"] = export(work, out, glb_dir, base_glb_dir)
        write_json(out / "photofit.json", doc)
    return doc


def export(work: Path, fit_dir: Path, glb_dir: Path, base_glb_dir: Path | None = None) -> dict:
    """FIT -> asset-<k>.npz with the offsets applied, tracks.npz with the refined pose, OUT/avatar-<k>.glb. A person
    without fit outputs gets the baseline GLB from base_glb_dir."""
    from pipeline.avatar import body, glb, offsets
    from pipeline.avatar.body import Asset

    glb_dir.mkdir(parents=True, exist_ok=True)
    tr = dict(np.load(work / "tracks.npz"))
    n_people = sum(1 for k in tr if k.endswith("/rest_vertices"))
    rep = {}
    for k in range(n_people):
        pre = f"person-{k}/"
        if not (fit_dir / f"pose-{k}.npz").exists():
            if base_glb_dir is not None and (base_glb_dir / f"avatar-{k}.glb").exists():
                shutil.copy(base_glb_dir / f"avatar-{k}.glb", glb_dir / f"avatar-{k}.glb")
                rep[f"person-{k}"] = {"file": f"avatar-{k}.glb", "from": str(base_glb_dir)}
            continue
        a = Asset.load(work / f"asset-{k}.npz")
        od = np.load(fit_dir / f"offsets-{k}.npz")
        if "displacement" in od.files:
            moved = tr[pre + "rest_vertices"] + od["displacement"]
            a.positions = moved[a.src_vertex]
            a.normals = body.vertex_normals(moved, a.src_vertex[a.tris])[a.src_vertex]
        else:
            offsets.apply(a, tr[pre + "rest_vertices"], od["offset"])
        a.save(fit_dir / f"asset-{k}.npz")
        po = np.load(fit_dir / f"pose-{k}.npz")
        tr[pre + "delta_q"], tr[pre + "root_q"], tr[pre + "root_p"] = po["delta_q"], po["root_q"], po["root_p"]
        jpeg = (fit_dir / f"tex-{k}.jpg").read_bytes()
        g = glb.build(a, tr[pre + "times"], po["delta_q"], po["root_q"], po["root_p"], jpeg, name=f"person-{k}",
                      extras={"texture": "photofit"})
        nbytes = glb.write(g, glb_dir / f"avatar-{k}.glb")
        rep[f"person-{k}"] = {"file": f"avatar-{k}.glb", "bytes": nbytes, "vertices": int(len(a.positions)),
                              "triangles": int(len(a.tris))}
        log("photofit", f"export person {k}: {rep[f'person-{k}']}")
    np.savez_compressed(fit_dir / "tracks.npz", **tr)
    return rep


# ------------------------------------------------------------------------------------------------------- CLI

WEIGHTS = {"photo": 1.0, "sil": 20.0, "unc": 1.5, "lap": 2.0, "nc": 5.0, "tv": 1.0, "gain": 1.0, "gainMean": 10.0,
           "poseSmooth": 0.01, "poseMag": 1e-4, "seenObs": 0.1}
LRS = {"tex": 0.01, "offset": 0.05, "gain": 0.01, "pose": 0.01}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prep")
    p.add_argument("--work", required=True)
    p.add_argument("--poses", required=True)
    p.add_argument("--world", default=None)
    p.add_argument("--eval", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--occluders", default=None, help="GLB folder of an earlier fit: other people in front leave the masks")
    f = sub.add_parser("fit")
    f.add_argument("--work", required=True)
    f.add_argument("--poses", required=True)
    f.add_argument("--eval", required=True)
    f.add_argument("--prep", required=True)
    f.add_argument("--out", required=True)
    f.add_argument("--glb-dir", default=None)
    f.add_argument("--base-glb-dir", default=None)
    f.add_argument("--people", default="0,1")
    f.add_argument("--steps", type=int, default=2000)
    f.add_argument("--batch", type=int, default=8)
    f.add_argument("--scale", type=float, default=1.0, help="photometric resolution (fraction of the frame size)")
    f.add_argument("--sil-scale", type=float, default=0.25)
    f.add_argument("--budget-min", type=float, default=11.0, help="fit time per person (minutes)")
    f.add_argument("--warm", type=float, default=0.12, help="fraction of the steps with the texture frozen")
    f.add_argument("--geo-grad", type=float, default=0.25, help="share of the photometric gradient that reaches the geometry")
    f.add_argument("--seed", type=int, default=0)
    f.add_argument("--device", default=None)
    f.add_argument("--max-root-deg", type=float, default=5.0, help="root correction bound per axis (0: no pose refinement)")
    f.add_argument("--max-root-m", type=float, default=0.15)
    f.add_argument("--max-bone-deg", type=float, default=6.0)
    f.add_argument("--pack-bias", type=float, default=3.0, help="how far the upper back's offsets turn backwards")
    f.add_argument("--init", default=None, help="an earlier fit to continue from (texture, offsets, pose, gains)")
    f.add_argument("--set", action="append", default=[], help="weight or lr override, e.g. tv=2 or lr.tex=0.02")
    e = sub.add_parser("export")
    e.add_argument("--work", required=True)
    e.add_argument("--fit", required=True)
    e.add_argument("--glb-dir", required=True)
    e.add_argument("--base-glb-dir", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "prep":
        prep(Path(a.work), Path(a.poses), Path(a.world) if a.world else None, Path(a.eval), Path(a.out), a.workers,
             Path(a.occluders) if a.occluders else None)
    elif a.cmd == "fit":
        w, lr = dict(WEIGHTS), dict(LRS)
        for s in a.set:
            key, val = s.split("=", 1)
            if key.startswith("lr."):
                lr[key[3:]] = float(val)
            else:
                w[key] = float(val)
        fit(Path(a.work), Path(a.poses), Path(a.eval), Path(a.prep), Path(a.out), Path(a.glb_dir) if a.glb_dir else None,
            [int(x) for x in a.people.split(",") if x != ""], a.steps, a.batch, a.scale, a.sil_scale, a.budget_min, w, lr,
            a.warm, a.seed, a.geo_grad, a.device, Path(a.base_glb_dir) if a.base_glb_dir else None,
            (a.max_root_deg, a.max_root_m, a.max_bone_deg), a.pack_bias, Path(a.init) if a.init else None)
    else:
        export(Path(a.work), Path(a.fit), Path(a.glb_dir), Path(a.base_glb_dir) if a.base_glb_dir else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
