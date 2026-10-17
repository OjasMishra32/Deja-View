"""Step 6: a UV texture per person from the real video pixels.

For every texel of a 2048 x 2048 atlas we know which triangle of the body it lies on and where (texel ->
(triangle, barycentric) map, cv2.fillConvexPoly over the UV triangles). In each keyframe both people are posed
exactly as the network saw them (its own vertices for that frame, so the body lines up with the image), ray cast
from the camera with Open3D (each person can hide the other), and every texel of a person is projected into the
frame. A texel takes a colour sample when its point is the first surface along its pixel's ray (within 1.5 cm),
the pixel is inside the person mask eroded by about 4 px, and the surface faces the camera (cos > 0.3). Samples
within 15 cm of another detected body (the other player, a bystander) count only 2%, so they fill a texel only
when no clean view saw it (the person mask is one mask for everybody: a backpack or a too-wide fit would paint
the other person's colours), and so do samples within ~12 px of the mask's edge. With the world given, samples hidden behind furniture (the foosball table in front
of the legs; pipeline/avatar/world.py) are dropped. Samples
are weighted by cos^2(normal, view) x frame sharpness x resolution; each texel keeps its 5 best samples and
averages those that agree with their medoid (so one misaligned view does not smear in), except the face, which
comes from the single frame where the visible face carries the most weight (most frontal, sharp, close), so it is
not a blend of several views.

Outputs per person k: tex_seen-<k>.png (seen texels, others black), seen-<k>.png (0/255), coverage-<k>.png (a
false-colour weight map, evidence), regions-<k>.json (median colour per body region for the flat-colour
fallback), and per-part coverage numbers.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline.avatar import body, raster
from pipeline.avatar.body import PART_NAMES, Asset
from pipeline.avatar.util import log

REGIONS = ("skin", "hair", "torso", "arms", "legs", "shoes")
DEFAULT_REGION_COLOURS = {"skin": (190, 150, 125), "hair": (40, 32, 28), "torso": (150, 150, 155),
                          "arms": (150, 150, 155), "legs": (70, 70, 80), "shoes": (60, 60, 60)}


@dataclass
class TexelMap:
    size: int
    tri: np.ndarray  # (S,S) int32, -1 = outside every UV island
    bary: np.ndarray  # (N,3) float32 for the covered texels (row-major order of tri >= 0)
    ys: np.ndarray  # (N,)
    xs: np.ndarray  # (N,)
    tid: np.ndarray  # (N,) triangle of each covered texel


def texel_map(asset: Asset, size: int = 2048) -> TexelMap:
    import cv2

    uvp = asset.uv * size - 0.5  # glTF uv (0,0) = top-left of the image
    tri_img = np.full((size, size), -1, np.int32)
    pts = uvp[asset.tris]  # (T,3,2)
    for t in range(len(asset.tris)):
        cv2.fillConvexPoly(tri_img, np.rint(pts[t] * 16).astype(np.int32), int(t), lineType=cv2.LINE_8, shift=4)
    ys, xs = np.nonzero(tri_img >= 0)
    tid = tri_img[ys, xs]
    a, b, c = pts[tid, 0], pts[tid, 1], pts[tid, 2]
    p = np.stack([xs, ys], 1).astype(np.float64)
    v0, v1, v2 = b - a, c - a, p - a
    d00 = (v0 * v0).sum(1)
    d01 = (v0 * v1).sum(1)
    d11 = (v1 * v1).sum(1)
    d20 = (v2 * v0).sum(1)
    d21 = (v2 * v1).sum(1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) < 1e-12, 1e-12, den)
    w1 = (d11 * d20 - d01 * d21) / den
    w2 = (d00 * d21 - d01 * d20) / den
    bary = np.clip(np.stack([1 - w1 - w2, w1, w2], 1), 0, 1)
    bary /= bary.sum(1, keepdims=True)
    return TexelMap(size, tri_img, bary.astype(np.float32), ys, xs, tid)


def texel_points(V: np.ndarray, asset: Asset, tm: TexelMap) -> np.ndarray:
    F = asset.tris[tm.tid]
    return (tm.bary[:, :1] * V[F[:, 0]] + tm.bary[:, 1:2] * V[F[:, 1]] + tm.bary[:, 2:3] * V[F[:, 2]])


def front_sign(asset: Asset) -> float:
    """+1 if the body faces +y in model space, else -1: the foot's vertices lie in front of the ankle joint."""
    labels = [str(b) for b in asset.bone_labels]
    j = labels.index("foot.L")
    foot = asset.vert_part == PART_NAMES.index("foot.L")
    return 1.0 if asset.positions[foot, 1].mean() > asset.rest_bone_poses[j, 1, 3] else -1.0


def texel_regions(asset: Asset, tm: TexelMap) -> tuple[np.ndarray, np.ndarray]:
    """Region index (into REGIONS) and a 'back' flag per covered texel, from the UV body-part map, the dominant
    bone of each vertex and the rest-pose normal."""
    labels = [str(b) for b in asset.bone_labels]
    dom = asset.joints[np.arange(len(asset.joints)), np.argmax(asset.weights, 1)].astype(np.int64)
    dom_name = np.array([labels[j] for j in dom])
    F = asset.tris[tm.tid]
    part = asset.tri_part[tm.tid]
    vbone = dom_name[F[:, 0]]
    n = body.vertex_normals(asset.positions, asset.tris)
    tn = (tm.bary[:, :1] * n[F[:, 0]] + tm.bary[:, 1:2] * n[F[:, 1]] + tm.bary[:, 2:3] * n[F[:, 2]])
    tn /= np.maximum(np.linalg.norm(tn, axis=1, keepdims=True), 1e-9)
    fs = front_sign(asset)
    fwd = tn[:, 1] * fs
    reg = np.full(len(tm.tid), REGIONS.index("torso"), np.int64)
    is_arm = np.char.find(vbone.astype(str), "arm") >= 0
    is_leg = np.char.find(vbone.astype(str), "leg") >= 0
    reg[is_arm] = REGIONS.index("arms")
    reg[is_leg] = REGIONS.index("legs")
    head = part == PART_NAMES.index("head")
    P = texel_points(asset.positions, asset, tm)
    zhead = P[head, 2]
    z_eye = np.percentile(zhead, 70) if head.any() else 0
    face = head & (fwd > 0.25) & (P[:, 2] < z_eye)
    reg[head] = REGIONS.index("hair")
    reg[face] = REGIONS.index("skin")
    reg[np.isin(part, [PART_NAMES.index("hand.L"), PART_NAMES.index("hand.R"), PART_NAMES.index("eye_front.L"),
                       PART_NAMES.index("eye_front.R")])] = REGIONS.index("skin")
    reg[np.isin(part, [PART_NAMES.index("foot.L"), PART_NAMES.index("foot.R")])] = REGIONS.index("shoes")
    back = fwd < -0.5
    return reg, back


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear samples (N, C) float32 of an (H, W, C) image at pixel-centre coordinates (x, y)."""
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    f = img.astype(np.float32)
    return ((f[y0, x0] * (1 - fx) + f[y0, x0 + 1] * fx) * (1 - fy) + (f[y0 + 1, x0] * (1 - fx) + f[y0 + 1, x0 + 1] * fx) * fy)


def frame_sharpness(img: np.ndarray, box: tuple[int, int, int, int]) -> float:
    import cv2

    x0, y0, x1, y1 = box
    crop = img[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
    if crop.size == 0:
        return 0.0
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return float(cv2.Laplacian(g, cv2.CV_32F, ksize=3).var())


def robust_mean(c: np.ndarray, w: np.ndarray, tol: float = 35.0, chunk: int = 400_000) -> np.ndarray:
    """Per texel: the weighted mean of the samples within `tol` (RGB 0-255) of the samples' medoid, so a few
    misaligned views (table, background, the other person's sleeve) do not smear into the colour."""
    out = np.zeros((len(c), 3), np.float32)
    for a in range(0, len(c), chunk):
        cc, ww = c[a:a + chunk], w[a:a + chunk]
        valid = ww > 0
        d = np.linalg.norm(cc[:, :, None, :] - cc[:, None, :, :], axis=-1)  # (n,K,K)
        d = np.where(valid[:, None, :], d, 0.0)
        cost = np.where(valid, (d * ww[:, None, :]).sum(-1), np.inf)
        med = np.take_along_axis(cc, np.argmin(cost, 1)[:, None, None], 1)[:, 0]
        near = valid & (np.linalg.norm(cc - med[:, None, :], axis=-1) <= tol)
        wn = ww * near
        out[a:a + chunk] = (cc * wn[:, :, None]).sum(1) / np.maximum(wn.sum(1, keepdims=True), 1e-9)
    return out


def others_zone(V_others: list[np.ndarray], tris: np.ndarray, K: np.ndarray, hw: tuple[int, int],
                margin_m: float = 0.15) -> np.ndarray:
    """Pixels within `margin_m` (at each body's depth) of any other detected body (the other player, bystanders).
    The person masks are one mask for everybody, so where a body is fitted a little too wide, or another person's
    backpack or keychain hangs in front of it, that pixel would otherwise paint the wrong person's colour."""
    import cv2

    zone = np.zeros(hw, np.uint8)
    for Vo in V_others:
        sil = raster.silhouette(Vo, tris, K, hw).astype(np.uint8)
        if not sil.any():
            continue
        z = float(np.median(Vo[:, 2]))
        r = int(np.clip(margin_m * K[0, 0] / max(z, 0.3), 4, 80))
        zone |= cv2.dilate(sil, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    return zone.astype(bool)


def bake(work: Path, assets: list[Asset], tracks, hmr, size: int = 2048, max_frames: int = 190,
         depth_tol: float = 0.015, erode_px: int = 2, min_cos: float = 0.3, keep: int = 5,
         min_weight: float = 0.12, near_other: float = 0.02, occluders=None, cams: dict | None = None,
         furniture_margin: float = 0.10, edge_px: int = 6) -> list[dict]:
    """Bakes every person's seen texture. `tracks`: tracks.npz arrays; `hmr`: hmr.npz arrays. Samples near
    another detected body count `near_other` times their weight, so they only fill texels no clean view saw.
    occluders (world.Occluders) + cams (frameIndex -> T_view_cv): samples hidden behind furniture are dropped.
    Samples within `edge_px` mask pixels of the mask's edge (the masks are coarse: floor, table or wall colours
    sit just inside them) are down-weighted the same way as samples near another body."""
    import cv2

    K = hmr["K"]
    v3d = hmr["v3d"]
    det_frame = hmr["frame"]
    n_people = len(assets)
    tms = [texel_map(a, size) for a in assets]
    log("texture", f"texel maps: {[len(t.tid) for t in tms]} covered texels of {size * size}")
    frames_k = [tracks[f"person-{k}/frames"] for k in range(n_people)]
    sigma_k = [float(tracks.get(f"person-{k}/body_scale", 1.0)) for k in range(n_people)]
    hidden_n = [0] * n_people
    dets_k = [tracks[f"person-{k}/det"] for k in range(n_people)]
    valid_k = [tracks[f"person-{k}/valid"] for k in range(n_people)]
    all_frames = np.unique(np.concatenate(frames_k))
    step = max(1, int(np.ceil(len(all_frames) / max_frames)))
    keyframes = all_frames[::step]
    best_w = [np.zeros((len(t.tid), keep), np.float32) for t in tms]
    raw_w = [np.zeros(len(t.tid), np.float32) for t in tms]  # best unpenalised weight (decides 'seen')
    clean_w = [np.zeros(len(t.tid), np.float32) for t in tms]  # best weight away from other bodies
    best_c = [np.zeros((len(t.tid), keep, 3), np.float32) for t in tms]
    nsamp = [np.zeros(len(t.tid), np.int32) for t in tms]
    sharp_all = []
    renderer = None
    # the face comes from one frame (the one where the visible face carries the most weight), not a mosaic
    faces = []
    for a, t in zip(assets, tms):
        reg, _ = texel_regions(a, t)
        faces.append((a.tri_part[t.tid] == PART_NAMES.index("head")) & (reg == REGIONS.index("skin")))
    face_c = [np.zeros((int(fm.sum()), 3), np.float32) for fm in faces]
    face_seen = [np.zeros(int(fm.sum()), bool) for fm in faces]
    face_score = [0.0] * n_people
    face_frame = [-1] * n_people
    for n, f in enumerate(keyframes):
        img = cv2.imread(str(work / "frames" / f"f{int(f):06d}.jpg"))
        mk = cv2.imread(str(work / "masks" / f"f{int(f):06d}.png"), cv2.IMREAD_GRAYSCALE)
        if img is None or mk is None:
            continue
        H, W = img.shape[:2]
        if renderer is None:
            renderer = raster.DepthRenderer(K, W, H, scale=1.0)
        m0 = (mk > 127).astype(np.uint8)
        m = cv2.erode(m0, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * erode_px + 1, 2 * erode_px + 1)))
        m = cv2.resize(m, (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)
        inner = cv2.erode(m0, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * edge_px + 1, 2 * edge_px + 1)))
        inner = cv2.resize(inner, (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)
        posed = {}
        for k in range(n_people):
            i = np.nonzero(frames_k[k] == f)[0]
            if len(i) and dets_k[k][i[0]] >= 0 and valid_k[k][i[0]]:
                posed[k] = v3d[dets_k[k][i[0]]].astype(np.float64)[assets[k].src_vertex]
        if not posed:
            continue
        ks = sorted(posed)
        depth, mesh_id, _, _ = renderer.render([(posed[k], assets[k].tris) for k in ks])
        own = {k: dets_k[k][np.nonzero(frames_k[k] == f)[0][0]] for k in ks}
        frame_dets = np.nonzero(det_frame == f)[0]
        furn = None
        if occluders is not None and cams is not None and int(f) in cams:
            Tf = cams[int(f)]
            sig_of = {int(own[kk]): sigma_k[kk] for kk in ks}
            bodies = [(sig_of.get(int(o), 1.0) * v3d[o][::4].astype(np.float64)) @ Tf[:3, :3].T + Tf[:3, 3] for o in frame_dets]
            furn = occluders.depth(Tf, K, (H, W), bodies, scale=0.125)
        for slot, k in enumerate(ks):
            a, tm = assets[k], tms[k]
            V = posed[k]
            P = texel_points(V, a, tm)
            z = P[:, 2]
            u = K[0, 0] * P[:, 0] / np.maximum(z, 1e-6) + K[0, 2]
            v = K[1, 1] * P[:, 1] / np.maximum(z, 1e-6) + K[1, 2]
            ui, vi = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
            inside = (z > 0.1) & (ui >= 0) & (vi >= 0) & (ui < W) & (vi < H)
            idx = np.nonzero(inside)[0]
            ui, vi = ui[idx], vi[idx]
            vis = (np.abs(depth[vi, ui] - z[idx]) < depth_tol) & (mesh_id[vi, ui] == slot) & m[vi, ui]
            idx, ui, vi = idx[vis], ui[vis], vi[vis]
            if len(idx) == 0:
                continue
            nrm = body.vertex_normals(V, a.tris)
            F = a.tris[tm.tid[idx]]
            bb = tm.bary[idx]
            tn = bb[:, :1] * nrm[F[:, 0]] + bb[:, 1:2] * nrm[F[:, 1]] + bb[:, 2:3] * nrm[F[:, 2]]
            tn /= np.maximum(np.linalg.norm(tn, axis=1, keepdims=True), 1e-9)
            vd = -P[idx] / np.linalg.norm(P[idx], axis=1, keepdims=True)
            cos = (tn * vd).sum(1)
            ok = cos > min_cos
            idx, cos, uu, vv, zz = idx[ok], cos[ok], u[idx][ok], v[idx][ok], z[idx][ok]
            if len(idx) == 0:
                continue
            if furn is not None:
                fd = furn[np.clip((vv * 0.125).astype(np.int64), 0, furn.shape[0] - 1),
                          np.clip((uu * 0.125).astype(np.int64), 0, furn.shape[1] - 1)]
                vis2 = ~(fd < sigma_k[k] * zz - furniture_margin)
                hidden_n[k] += int((~vis2).sum())
                idx, cos, uu, vv, zz = idx[vis2], cos[vis2], uu[vis2], vv[vis2], zz[vis2]
                if len(idx) == 0:
                    continue
            others = [v3d[o].astype(np.float64)[a.src_vertex] for o in frame_dets if o != own[k]]
            near = others_zone(others, a.tris, K, (H, W))[np.floor(vv).astype(np.int64).clip(0, H - 1),
                                                          np.floor(uu).astype(np.int64).clip(0, W - 1)] if others else np.zeros(len(idx), bool)
            near |= ~inner[np.floor(vv).astype(np.int64).clip(0, H - 1), np.floor(uu).astype(np.int64).clip(0, W - 1)]
            ys, xs = np.nonzero(mesh_id == slot)
            sharp = frame_sharpness(img, (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
            sharp_all.append(sharp)
            ref = np.median(sharp_all)
            wsharp = np.clip(sharp / max(ref, 1e-6), 0.2, 2.0)
            res = np.clip((K[0, 0] / zz) / 500.0, 0.2, 2.0)  # pixels per metre, relative
            w_raw = (cos * cos * wsharp * res).astype(np.float32)
            w = np.where(near, w_raw * near_other, w_raw).astype(np.float32)
            col = bilinear(img, uu, vv)[:, ::-1]  # RGB
            nsamp[k][idx] += 1
            np.maximum.at(raw_w[k], idx, w_raw)
            np.maximum.at(clean_w[k], idx, np.where(near, 0.0, w_raw).astype(np.float32))
            # insert into the per-texel best `keep` samples
            bw, bc = best_w[k], best_c[k]
            allw = np.concatenate([bw[idx], w[:, None]], 1)
            allc = np.concatenate([bc[idx], col[:, None, :]], 1)
            o = np.argsort(-allw, 1)[:, :keep]
            bw[idx] = np.take_along_axis(allw, o, 1)
            bc[idx] = np.take_along_axis(allc, o[:, :, None], 1)
            # face: keep this frame's samples if its visible face outweighs the best frame so far
            fsel = faces[k][idx]
            score = float(w[fsel].sum())
            if score > face_score[k]:
                face_score[k], face_frame[k] = score, int(f)
                fpos = np.cumsum(faces[k]) - 1
                face_c[k][:] = 0
                face_seen[k][:] = False
                face_c[k][fpos[idx[fsel]]] = col[fsel]
                face_seen[k][fpos[idx[fsel]]] = True
        if n % 20 == 0:
            log("texture", f"keyframe {n + 1}/{len(keyframes)} (frame {int(f)}): seen "
                           f"{[round(float((bw[:, 0] > 0).mean()), 3) for bw in best_w]}")
    out = []
    for k in range(n_people):
        a, tm = assets[k], tms[k]
        bw, bc = best_w[k], best_c[k]
        seen = raw_w[k] >= min_weight  # texels only ever seen at grazing angles or blurred count as unseen
        avg = robust_mean(bc, bw)
        fidx = np.nonzero(faces[k])[0][face_seen[k]]
        avg[fidx] = face_c[k][face_seen[k]]
        seen[fidx] = True
        tex = np.zeros((size, size, 3), np.uint8)
        tex[tm.ys[seen], tm.xs[seen]] = np.clip(avg[seen] + 0.5, 0, 255).astype(np.uint8)
        seen_img = np.zeros((size, size), np.uint8)
        seen_img[tm.ys[seen], tm.xs[seen]] = 255
        reg, back = texel_regions(a, tm)
        colours = {}
        for r, name in enumerate(REGIONS):
            sel = seen & (reg == r)
            colours[name] = [int(x) for x in np.median(avg[sel], 0)] if sel.sum() > 200 else list(DEFAULT_REGION_COLOURS[name])
        part = a.tri_part[tm.tid]
        cov = {PART_NAMES[p]: round(float(seen[part == p].mean()), 4) for p in np.unique(part)}
        cov_reg = {name: round(float(seen[reg == r].mean()), 4) for r, name in enumerate(REGIONS) if (reg == r).any()}
        torso_like = np.isin(reg, [REGIONS.index("torso"), REGIONS.index("hair")]) | (part == PART_NAMES.index("head"))
        back_cov = float(seen[back & torso_like].mean()) if (back & torso_like).any() else 0.0
        out.append({"tex": tex, "seen": seen_img, "weight": raw_w[k], "regions": colours, "coverage": {
            "all": round(float(seen.mean()), 4), "parts": cov, "regions": cov_reg, "back": round(back_cov, 4),
            "samplesMedian": int(np.median(nsamp[k][seen])) if seen.any() else 0,
            "cleanFraction": round(float((clean_w[k][seen] >= min_weight).mean()), 4) if seen.any() else 0.0,
            "furnitureHiddenSamples": hidden_n[k],
            "faceFrame": face_frame[k],
            "faceTexelsFromThatFrame": round(float(face_seen[k].mean()), 4) if len(face_seen[k]) else 0.0}, "texel_map": tm,
            "region_of_texel": reg, "back_of_texel": back})
        log("texture", f"person {k}: coverage {out[-1]['coverage']}; region colours {colours}")
    return out


def coverage_image(tm: TexelMap, weight: np.ndarray) -> np.ndarray:
    import cv2

    img = np.zeros((tm.size, tm.size, 3), np.uint8)
    island = tm.tri >= 0
    img[island] = (40, 40, 40)
    w = weight / max(np.percentile(weight[weight > 0], 95), 1e-6) if (weight > 0).any() else weight
    col = cv2.applyColorMap(np.clip(w * 255, 0, 255).astype(np.uint8)[:, None], cv2.COLORMAP_TURBO)[:, 0, ::-1]
    s = weight > 0
    img[tm.ys[s], tm.xs[s]] = col[s]
    return img


def region_texture(tm: TexelMap, reg: np.ndarray, colours: dict) -> np.ndarray:
    tex = np.zeros((tm.size, tm.size, 3), np.uint8)
    lut = np.array([colours[r] for r in REGIONS], np.uint8)
    tex[tm.ys, tm.xs] = lut[reg]
    return tex


if __name__ == "__main__":
    sys.exit("run through pipeline.avatar.run")
