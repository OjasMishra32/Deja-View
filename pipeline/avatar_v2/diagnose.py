"""Why the baseline people look wrong: every texture defect traced back to the frames and pixels it came from.

    python -m pipeline.avatar_v2.diagnose trace --work WORK --poses POSES --world WORLD --glb-dir OUT --eval EVAL --out DIAG
    python -m pipeline.avatar_v2.diagnose geometry --work WORK --poses POSES --glb-dir OUT --eval EVAL --out DIAG
    python -m pipeline.avatar_v2.diagnose controls --work WORK --poses POSES --glb-dir OUT --eval EVAL --out DIAG

trace: re-runs the baseline bake (pipeline/avatar/texture.py: same keyframes, weights and tests) and records, for
  each texel's 5 kept samples, the frame and pixel it came from and what that pixel is: the other player's share of
  the person mask (the yardstick's partition), inside the 15 cm zone around another body, in the mask's 12 px edge
  band, a mask pixel nobody owns. From that:
    - class atlas: per texel, the weight share of each kind among the samples its colour was averaged from;
    - exposure: per keyframe, the median ratio of a frame's clean samples to their texel's final colour (each
      channel), so a frame that came out brighter or warmer shows as a gain above 1;
    - defects: texels whose colour does not belong to the garment there (white or pink on the grey hoodie and the
      black shorts, black or pink on the white shirt), traced to their source frames and drawn on those frames;
    - fill: which texels are seen, seen only through penalised samples, mirrored or LaMa, drawn on a turntable;
    - the held-out colour error split by fill source, sample class and body region.
controls: the yardstick on renders that change one thing each (the network's per-frame body instead of the
  animation; that body with the rejected offsets; flat region colours instead of the texture).
geometry: silhouettes on the held-out frames of the shipped animation, of the network's own per-frame body (what the
  bake projects with) and of that body with the rejected silhouette offsets; the 2D distance between the shipped
  animation and the network body per body part; how far the mask reaches past the body; animation jitter; colour
  jumps across UV seams.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from pipeline.avatar import paths  # noqa: F401
from pipeline.avatar.util import log, read_json, write_json
from pipeline.avatar_v2 import yardstick as ys

ZONE, EDGE, OTHER, NOBODY = 1, 2, 4, 8
PROV = ("seen", "seen-penalised", "mirrored", "lama")
PROV_COL = np.array([(150, 150, 150), (255, 210, 0), (0, 200, 255), (255, 0, 200)], np.uint8)


def robust_mean_sel(c: np.ndarray, w: np.ndarray, tol: float = 35.0, chunk: int = 400_000):
    """texture.robust_mean, also returning which samples were averaged (n, K)."""
    out = np.zeros((len(c), 3), np.float32)
    sel = np.zeros(w.shape, bool)
    for a in range(0, len(c), chunk):
        cc, ww = c[a:a + chunk], w[a:a + chunk]
        valid = ww > 0
        d = np.linalg.norm(cc[:, :, None, :] - cc[:, None, :, :], axis=-1)
        d = np.where(valid[:, None, :], d, 0.0)
        cost = np.where(valid, (d * ww[:, None, :]).sum(-1), np.inf)
        med = np.take_along_axis(cc, np.argmin(cost, 1)[:, None, None], 1)[:, 0]
        near = valid & (np.linalg.norm(cc - med[:, None, :], axis=-1) <= tol)
        wn = ww * near
        out[a:a + chunk] = (cc * wn[:, :, None]).sum(1) / np.maximum(wn.sum(1, keepdims=True), 1e-9)
        sel[a:a + chunk] = near
    return out, sel


# ------------------------------------------------------------------------------------------------- trace


def bake_traced(work: Path, assets, tracks, hmr, occluders, cams, size: int = 2048, max_frames: int = 190,
                depth_tol: float = 0.015, erode_px: int = 2, min_cos: float = 0.3, keep: int = 5, min_weight: float = 0.12,
                near_other: float = 0.02, furniture_margin: float = 0.10, edge_px: int = 6, expo_every: int = 29) -> list[dict]:
    """texture.bake with provenance (see the module docstring); same defaults as the shipped run."""
    import cv2

    from pipeline.avatar import body, raster
    from pipeline.avatar.body import PART_NAMES
    from pipeline.avatar.texture import (REGIONS, bilinear, frame_sharpness, others_zone, texel_map, texel_points,
                                         texel_regions)

    K, v3d, det_frame = hmr["K"], hmr["v3d"], hmr["frame"]
    n_people = len(assets)
    tms = [texel_map(a, size) for a in assets]
    tris_model = assets[0].src_vertex[assets[0].tris]
    frames_k = [tracks[f"person-{k}/frames"] for k in range(n_people)]
    sigma_k = [float(tracks.get(f"person-{k}/body_scale", 1.0)) for k in range(n_people)]
    dets_k = [tracks[f"person-{k}/det"] for k in range(n_people)]
    valid_k = [tracks[f"person-{k}/valid"] for k in range(n_people)]
    all_frames = np.unique(np.concatenate(frames_k))
    step = max(1, int(np.ceil(len(all_frames) / max_frames)))
    keyframes = all_frames[::step]
    N = [len(t.tid) for t in tms]
    best_w = [np.zeros((n, keep), np.float32) for n in N]
    best_c = [np.zeros((n, keep, 3), np.float32) for n in N]
    best_f = [np.full((n, keep), -1, np.int16) for n in N]
    best_px = [np.zeros((n, keep, 2), np.float32) for n in N]
    best_cls = [np.zeros((n, keep), np.uint8) for n in N]
    best_d = [np.zeros((n, keep), np.float16) for n in N]
    raw_w = [np.zeros(n, np.float32) for n in N]
    clean_w = [np.zeros(n, np.float32) for n in N]
    hidden = [np.zeros(n, np.int32) for n in N]
    n_all = [np.zeros(n, np.int32) for n in N]
    n_bright = [np.zeros(n, np.int32) for n in N]
    n_dark = [np.zeros(n, np.int32) for n in N]
    expo = [[] for _ in range(n_people)]
    sharp_all = []
    renderer = None
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
        U = cv2.resize(mk, (W, H), interpolation=cv2.INTER_LINEAR) > 127
        edge_d = cv2.distanceTransform(U.astype(np.uint8), cv2.DIST_L2, 5)
        frame_dets = np.nonzero(det_frame == f)[0]
        owner = ys.partition(U, [v3d[o].astype(np.float64) for o in frame_dets], tris_model, K, renderer)
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
            idx = idx[vis]
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
                np.add.at(hidden[k], idx[~vis2], 1)
                idx, cos, uu, vv, zz = idx[vis2], cos[vis2], uu[vis2], vv[vis2], zz[vis2]
                if len(idx) == 0:
                    continue
            pv = np.floor(vv).astype(np.int64).clip(0, H - 1)
            pu = np.floor(uu).astype(np.int64).clip(0, W - 1)
            others = [v3d[o].astype(np.float64)[a.src_vertex] for o in frame_dets if o != own[k]]
            zone = others_zone(others, a.tris, K, (H, W))[pv, pu] if others else np.zeros(len(idx), bool)
            edge = ~inner[pv, pu]
            near = zone | edge
            ys_, xs_ = np.nonzero(mesh_id == slot)
            sharp = frame_sharpness(img, (xs_.min(), ys_.min(), xs_.max() + 1, ys_.max() + 1))
            sharp_all.append(sharp)
            ref = np.median(sharp_all)
            wsharp = np.clip(sharp / max(ref, 1e-6), 0.2, 2.0)
            res = np.clip((K[0, 0] / zz) / 500.0, 0.2, 2.0)
            w_raw = (cos * cos * wsharp * res).astype(np.float32)
            w = np.where(near, w_raw * near_other, w_raw).astype(np.float32)
            col = bilinear(img, uu, vv)[:, ::-1]
            oi = int(np.nonzero(frame_dets == own[k])[0][0])
            ow = owner[pv, pu]
            cls = (zone.astype(np.uint8) * ZONE | edge.astype(np.uint8) * EDGE | ((ow >= 0) & (ow != oi)).astype(np.uint8) * OTHER
                   | (ow < 0).astype(np.uint8) * NOBODY)
            lum = col[:, 0] * 0.299 + col[:, 1] * 0.587 + col[:, 2] * 0.114
            np.add.at(n_all[k], idx, 1)
            np.add.at(n_bright[k], idx[lum > 185], 1)
            np.add.at(n_dark[k], idx[lum < 55], 1)
            np.maximum.at(raw_w[k], idx, w_raw)
            np.maximum.at(clean_w[k], idx, np.where(near, 0.0, w_raw).astype(np.float32))
            bw, bc, bf, bp, bk, bd = best_w[k], best_c[k], best_f[k], best_px[k], best_cls[k], best_d[k]
            allw = np.concatenate([bw[idx], w[:, None]], 1)
            o = np.argsort(-allw, 1)[:, :keep]
            bw[idx] = np.take_along_axis(allw, o, 1)
            bc[idx] = np.take_along_axis(np.concatenate([bc[idx], col[:, None, :]], 1), o[:, :, None], 1)
            bf[idx] = np.take_along_axis(np.concatenate([bf[idx], np.full((len(idx), 1), int(f), np.int16)], 1), o, 1)
            bp[idx] = np.take_along_axis(np.concatenate([bp[idx], np.stack([uu, vv], 1)[:, None, :].astype(np.float32)], 1), o[:, :, None], 1)
            bk[idx] = np.take_along_axis(np.concatenate([bk[idx], cls[:, None]], 1), o, 1)
            bd[idx] = np.take_along_axis(np.concatenate([bd[idx], edge_d[pv, pu][:, None].astype(np.float16)], 1), o, 1)
            sel = (idx % expo_every == 0) & (cls == 0) & (cos > 0.5)
            expo[k].append((n, int(f), idx[sel], col[sel]))
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
            log("diagnose", f"traced keyframe {n + 1}/{len(keyframes)} (frame {int(f)})")
    out = []
    for k in range(n_people):
        a, tm = assets[k], tms[k]
        seen = raw_w[k] >= min_weight
        avg, sel = robust_mean_sel(best_c[k], best_w[k])
        fidx = np.nonzero(faces[k])[0][face_seen[k]]
        avg[fidx] = face_c[k][face_seen[k]]
        seen[fidx] = True
        face_t = np.zeros(len(seen), bool)
        face_t[fidx] = True
        out.append({"tm": tm, "avg": avg, "sel": sel, "seen": seen, "clean": clean_w[k] >= min_weight, "face": face_t,
                    "w": best_w[k], "c": best_c[k], "f": best_f[k], "px": best_px[k], "cls": best_cls[k], "d": best_d[k],
                    "hidden": hidden[k], "nAll": n_all[k], "nBright": n_bright[k], "nDark": n_dark[k], "expo": expo[k], "faceFrame": face_frame[k], "keyframes": keyframes})
    return out


def class_shares(r: dict) -> dict[str, np.ndarray]:
    """Per texel, the weight share of each sample kind among the samples its colour was averaged from."""
    wn = r["w"] * r["sel"]
    tot = np.maximum(wn.sum(1), 1e-12)
    cls = r["cls"]
    return {"clean": (wn * (cls == 0)).sum(1) / tot, "other": (wn * ((cls & OTHER) > 0)).sum(1) / tot,
            "zone": (wn * ((cls & ZONE) > 0)).sum(1) / tot, "edge": (wn * ((cls & EDGE) > 0)).sum(1) / tot,
            "nobody": (wn * ((cls & NOBODY) > 0)).sum(1) / tot}


def provenance(asset, r: dict) -> np.ndarray:
    """0 seen, 1 seen only through penalised samples, 2 mirrored, 3 LaMa (fill.py's order)."""
    from pipeline.avatar import fill

    seen = r["seen"]
    p = np.full(len(seen), 3, np.int64)
    p[seen] = 0
    p[seen & ~r["clean"] & ~r["face"]] = 1
    src = fill.mirror_sources(asset, r["tm"])
    use = ~seen & (src >= 0)
    use[use] &= seen[src[use]]
    p[use] = 2
    return p


def atlas_image(tm, values: np.ndarray, size: int = 1024) -> np.ndarray:
    import cv2

    img = np.zeros((tm.size, tm.size, 3), np.uint8)
    img[tm.ys, tm.xs] = values
    return cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)


def luminance(c: np.ndarray) -> np.ndarray:
    return c[..., 0] * 0.299 + c[..., 1] * 0.587 + c[..., 2] * 0.114


DEFECTS = {
    # person index -> name -> (colour rule over (N,3) RGB, regions it does not belong to, what it is)
    0: {"dark-on-shirt": ("dark", ("torso",), "black on the white shirt"),
        "pink": ("pink", ("torso", "arms", "legs", "hair"), "pink smears")},
    1: {"white-on-hoodie-shorts": ("white", ("torso", "arms", "legs"), "white on the grey hoodie / black shorts"),
        "pink": ("pink", ("torso", "arms", "legs", "hair"), "pink smears")},
}


def colour_rule(name: str, c: np.ndarray) -> np.ndarray:
    L = luminance(c)
    chroma = c.max(1) - c.min(1)
    if name == "white":
        return (L > 185) & (chroma < 45)
    if name == "dark":
        return L < 55
    if name == "pink":
        return (c[:, 0] > 130) & (c[:, 0] - c[:, 1] > 40) & (c[:, 2] - c[:, 1] > 5)
    raise ValueError(name)


def trace(work: Path, poses: Path, world: Path | None, glb_dir: Path, eval_dir: Path, out: Path) -> dict:
    import cv2

    from pipeline.avatar.body import Asset, PART_NAMES
    from pipeline.avatar.ground import camera_track
    from pipeline.avatar.texture import REGIONS, texel_regions

    out.mkdir(parents=True, exist_ok=True)
    hmr = np.load(work / "hmr.npz")
    tracks = dict(np.load(work / "tracks.npz"))
    n_people = sum(1 for k in tracks if k.endswith("/rest_vertices"))
    assets = [Asset.load(work / f"asset-{k}.npz") for k in range(n_people)]
    occ = None
    if world is not None and Path(world).exists():
        from pipeline.avatar.world import Occluders

        occ = Occluders(Path(world))
    cams = camera_track(read_json(poses))
    res = bake_traced(work, assets, tracks, hmr, occ, cams)
    report: dict = {"people": {}}
    files = sorted(Path(glb_dir).glob("avatar-*.glb"), key=lambda p: int(p.stem.split("-")[-1]))
    glbs = [ys.Glb(p) for p in files]
    held = set(read_json(eval_dir / "heldout.json")["frames"])
    for k, (a, r) in enumerate(zip(assets, res)):
        tm = r["tm"]
        rep: dict = {}
        base = cv2.imread(str(work / f"tex_seen-{k}.png"))[:, :, ::-1][tm.ys, tm.xs].astype(np.float32)
        mine = np.clip(r["avg"] + 0.5, 0, 255)
        s = r["seen"]
        rep["retraceMatchesBaseline"] = {"meanAbs": round(float(np.abs(mine[s] - base[s]).mean()), 3),
                                         "p99Abs": round(float(np.percentile(np.abs(mine[s] - base[s]).max(1), 99)), 2)}
        reg, _ = texel_regions(a, tm)
        part = a.tri_part[tm.tid]
        sh = class_shares(r)
        prov = provenance(a, r)
        # held-out frames used by the baseline (it used every keyframe)
        rep["heldOutFramesInBake"] = int(len(held & set(int(x) for x in r["keyframes"])))
        # class atlas: red = other player's pixels or their 15 cm zone, green = mask edge band, blue = clean
        rgb = np.stack([np.maximum(sh["other"], sh["zone"]), sh["edge"] * (1 - np.maximum(sh["other"], sh["zone"])), sh["clean"]], 1)
        rgb = np.where(s[:, None], rgb * 255, 0).astype(np.uint8)
        ca = atlas_image(tm, rgb)
        tex = cv2.imread(str(work / f"tex-{k}.jpg"))[:, :, ::-1]
        both = np.concatenate([cv2.resize(tex, (1024, 1024), interpolation=cv2.INTER_AREA), ca], 1)
        ys.label(both, f"person-{k}: shipped texture | sample kind per texel: red = other person / their zone, "
                       f"green = mask edge band, blue = clean, black = not seen", scale=0.55)
        cv2.imwrite(str(out / f"class-atlas-{k}.jpg"), both[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 88])
        dirty = s & (sh["clean"] < 0.5)
        rep["seenTexels"] = int(s.sum())
        rep["seenMostlyNotClean"] = round(float(dirty.sum() / max(1, s.sum())), 4)
        rep["seenMostlyNotCleanByRegion"] = {REGIONS[i]: round(float((dirty & (reg == i)).sum() / max(1, (s & (reg == i)).sum())), 4)
                                             for i in range(len(REGIONS)) if (reg == i).any()}
        rep["shareOfAveragedWeight"] = {kk: round(float(v[s].mean()), 4) for kk, v in sh.items()}
        rep["furnitureHiddenSamplesByRegion"] = {REGIONS[i]: int(r["hidden"][reg == i].sum()) for i in range(len(REGIONS))}
        rep["provenance"] = {PROV[i]: round(float((prov == i).mean()), 4) for i in range(4)}
        rep["provenanceByRegion"] = {REGIONS[j]: {PROV[i]: round(float(((prov == i) & (reg == j)).sum() / max(1, (reg == j).sum())), 4)
                                                  for i in range(4)} for j in range(len(REGIONS))}
        # spread of the kept samples (how much the views disagree), per texel
        wv = r["w"] > 0
        cmean = (r["c"] * wv[..., None]).sum(1) / np.maximum(wv.sum(1, keepdims=True), 1)
        spread = np.sqrt((((r["c"] - cmean[:, None]) ** 2).sum(-1) * wv).sum(1) / np.maximum(wv.sum(1), 1))
        rep["sampleSpreadRGB"] = {"median": round(float(np.median(spread[s])), 2), "p90": round(float(np.percentile(spread[s], 90)), 2)}
        heat = cv2.applyColorMap(np.clip(spread * 255 / 60, 0, 255).astype(np.uint8)[:, None], cv2.COLORMAP_TURBO)[:, 0, ::-1]
        cv2.imwrite(str(out / f"spread-atlas-{k}.jpg"), atlas_image(tm, np.where(s[:, None], heat, 0))[:, :, ::-1],
                    [cv2.IMWRITE_JPEG_QUALITY, 85])
        # exposure: per keyframe, the median ratio of its clean samples to their texel's final colour
        gains = []
        for n, f, idx, col in r["expo"]:
            ref = r["avg"][idx]
            ok = (ref.min(1) > 25) & (col.min(1) > 5) & s[idx]
            if ok.sum() < 300:
                continue
            g = np.exp(np.median(np.log(col[ok] / ref[ok]), 0))
            gl = float(np.exp(np.median(np.log(luminance(col[ok]) / luminance(ref[ok])))))
            gains.append((f, float(hmr["all_times"][f]), gl, *g.tolist(), int(ok.sum())))
        rep["exposure"] = summarise_gains(gains)
        r["gains"] = gains
        np.save(out / f"gains-{k}.npy", np.asarray(gains))
        # fill provenance on the shipped texture, and a turntable
        pt = cv2.resize(tex, (tm.size, tm.size)) if tex.shape[0] != tm.size else tex.copy()
        g = (luminance(pt[tm.ys, tm.xs].astype(np.float32)) * 0.6 + 50).astype(np.uint8)
        pc = np.stack([g, g, g], 1)
        pc[prov > 0] = PROV_COL[prov[prov > 0]]
        provtex = pt.copy()
        provtex[tm.ys, tm.xs] = pc
        r["provtex"] = provtex
        r["prov"], r["reg"], r["part"], r["shares"] = prov, reg, part, sh
        # defects
        rep["defects"] = {}
        for name, (rule, regions, what) in DEFECTS.get(k, {}).items():
            inreg = np.isin(reg, [REGIONS.index(x) for x in regions]) & (part == PART_NAMES.index("body"))
            final = cv2.imread(str(work / f"tex-{k}.jpg"))[:, :, ::-1][tm.ys, tm.xs].astype(np.float32)
            bad = inreg & colour_rule(rule, final)
            d = defect_report(r, bad, held)
            d["what"] = what
            d["texelsFractionOfRegion"] = round(float(bad.sum() / max(1, inreg.sum())), 4)
            d["fromFill"] = {PROV[i]: round(float(((prov == i) & bad).sum() / max(1, bad.sum())), 4) for i in range(4)}
            rep["defects"][name] = d
            if bad.sum() > 50:
                defect_evidence(work, glbs[k], tm, tex, r, bad, d, out / f"defect-person-{k}-{name}.jpg", f"person-{k}: {what}")
        report["people"][f"person-{k}"] = rep
        log("diagnose", f"person {k}: {rep}")
    # exposure plot, fill turntable
    draw_gains([r.get("gains", []) for r in res], out / "exposure-gain.png")
    tt = ys.turntable(glbs, 6.0, textures=[r["provtex"] for r in res], names=[f"person-{k}" for k in range(n_people)])
    ys.label(tt, "fill source: grey = seen, yellow = seen only near the other person / mask edge, cyan = mirrored, magenta = LaMa",
             y=tt.shape[0] - 10, scale=0.6)
    cv2.imwrite(str(out / "fill-provenance-turntable.jpg"), tt, [cv2.IMWRITE_JPEG_QUALITY, 88])
    # held-out error split
    report["heldOutError"] = heldout_split(eval_dir, glbs, res, assets)
    write_json(out / "trace.json", report)
    np.savez_compressed(out / "trace-small.npz", **{f"p{k}/{n}": r[n] for k, r in enumerate(res) for n in ("prov", "reg", "seen", "clean")})
    return report


def summarise_gains(gains: list) -> dict:
    if not gains:
        return {}
    G = np.asarray(gains)
    L = G[:, 2]
    rb = G[:, 3] / np.maximum(G[:, 5], 1e-6)
    return {"keyframes": len(G), "luminanceGain": {"p5": round(float(np.percentile(L, 5)), 3), "median": round(float(np.median(L)), 3),
                                                   "p95": round(float(np.percentile(L, 95)), 3), "min": round(float(L.min()), 3),
                                                   "max": round(float(L.max()), 3)},
            "redOverBlue": {"p5": round(float(np.percentile(rb, 5)), 3), "p95": round(float(np.percentile(rb, 95)), 3)},
            "framesOver15pct": round(float(np.mean(np.abs(np.log(L)) > np.log(1.15))), 3)}


def draw_gains(all_gains: list[list], path: Path) -> None:
    import cv2

    Wd, Hd = 1100, 420
    img = np.full((Hd, Wd, 3), 255, np.uint8)
    x0, x1, y0, y1 = 60, Wd - 20, 30, Hd - 40
    lo, hi = 0.5, 1.6
    ymap = lambda g: int(y1 - (np.log(g) - np.log(lo)) / (np.log(hi) - np.log(lo)) * (y1 - y0))  # noqa: E731
    tmax = max([g[1] for gs in all_gains for g in gs] + [1.0])
    xmap = lambda t: int(x0 + t / tmax * (x1 - x0))  # noqa: E731
    for gv in (0.6, 0.8, 1.0, 1.25, 1.5):
        cv2.line(img, (x0, ymap(gv)), (x1, ymap(gv)), (200, 200, 200) if gv != 1.0 else (90, 90, 90), 1)
        cv2.putText(img, f"{gv:.2f}", (8, ymap(gv) + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (60, 60, 60), 1, cv2.LINE_AA)
    for s in range(0, int(tmax) + 1):
        cv2.putText(img, f"{s}s", (xmap(s) - 6, y1 + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (60, 60, 60), 1, cv2.LINE_AA)
    cols = [(0, 140, 255), (255, 90, 0)]
    for k, gs in enumerate(all_gains):
        if not gs:
            continue
        G = np.asarray(gs)
        pts = np.stack([[xmap(t) for t in G[:, 1]], [ymap(g) for g in G[:, 2]]], 1).astype(np.int32)
        cv2.polylines(img, [pts.reshape(-1, 1, 2)], False, cols[k % 2], 2, cv2.LINE_AA)
        rb = G[:, 3] / np.maximum(G[:, 5], 1e-6)
        pts = np.stack([[xmap(t) for t in G[:, 1]], [ymap(g) for g in rb]], 1).astype(np.int32)
        cv2.polylines(img, [pts.reshape(-1, 1, 2)], False, tuple(int(c * 0.5) for c in cols[k % 2]), 1, cv2.LINE_AA)
    cv2.putText(img, "per keyframe: brightness of the person's clean samples / their texel's final colour (thick; orange person-0, "
                     "blue person-1); thin: red/blue ratio", (x0, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1, cv2.LINE_AA)
    cv2.imwrite(str(path), img)


def defect_report(r: dict, bad: np.ndarray, held: set) -> dict:
    """Where the averaged samples of the `bad` texels came from."""
    sel = r["sel"][bad] & (r["w"][bad] > 0)
    w = r["w"][bad] * sel
    cls = r["cls"][bad]
    tot = max(float(w.sum()), 1e-12)
    fr = r["f"][bad]
    d = r["d"][bad].astype(np.float32)
    byf: dict[int, float] = {}
    for f, ww in zip(fr[sel], w[sel]):
        byf[int(f)] = byf.get(int(f), 0.0) + float(ww)
    top = sorted(byf.items(), key=lambda x: -x[1])[:6]
    samp_c = r["c"][bad][sel]
    # do the views agree? share of each defect texel's samples (all of them, not only the kept 5) of that colour
    na = np.maximum(r["nAll"][bad], 1)
    lum_k = r["c"][bad][..., 0] * 0.299 + r["c"][bad][..., 1] * 0.587 + r["c"][bad][..., 2] * 0.114
    lum_f = luminance(r["avg"][bad])
    kept = r["w"][bad] > 0
    dissent = (kept & (np.abs(lum_k - lum_f[:, None]) > 60)).any(1)
    return {"texels": int(bad.sum()), "seen": round(float(r["seen"][bad].mean()), 4) if bad.any() else 0.0,
            "weightShare": {"clean": round(float((w * (cls == 0)).sum() / tot), 4),
                            "otherPersonPixels": round(float((w * ((cls & OTHER) > 0)).sum() / tot), 4),
                            "otherPersonZone": round(float((w * ((cls & ZONE) > 0)).sum() / tot), 4),
                            "maskEdgeBand": round(float((w * ((cls & EDGE) > 0)).sum() / tot), 4),
                            "unownedMaskPixels": round(float((w * ((cls & NOBODY) > 0)).sum() / tot), 4)},
            "sourceWithin12pxOfMaskEdge": round(float((w * (d < 12)).sum() / tot), 4),
            "sourceWithin25pxOfMaskEdge": round(float((w * (d < 25)).sum() / tot), 4),
            "sourceMeanRGB": [int(x) for x in samp_c.mean(0)] if len(samp_c) else None,
            "topFrames": [{"frame": f, "weightShare": round(ww / tot, 4), "heldOut": f in held} for f, ww in top],
            "distinctFrames": len(byf),
            "allSamplesPerTexelMedian": int(np.median(r["nAll"][bad])) if bad.any() else 0,
            "brightShareOfAllSamples": round(float(np.median(r["nBright"][bad] / na)), 4) if bad.any() else None,
            "darkShareOfAllSamples": round(float(np.median(r["nDark"][bad] / na)), 4) if bad.any() else None,
            "texelsWithADissentingKeptSample": round(float(dissent.mean()), 4) if bad.any() else None}


def defect_evidence(work: Path, glb, tm, tex: np.ndarray, r: dict, bad: np.ndarray, d: dict, path: Path, title: str) -> None:
    """Left: the shipped avatar with the defect texels in magenta (4 views). Right: the 3 frames that gave those
    texels most of their colour, the source pixels as magenta dots, the person's own mask share outlined in green and
    everyone else's in red."""
    import cv2

    hl = tex.copy()
    if hl.shape[0] != tm.size:
        hl = cv2.resize(hl, (tm.size, tm.size))
    m = np.zeros((tm.size, tm.size), np.uint8)
    m[tm.ys[bad], tm.xs[bad]] = 1
    m = cv2.dilate(m, np.ones((3, 3), np.uint8)) > 0
    hl[m] = (255, 0, 220)
    tt = ys.turntable([glb], 6.0, views=8, size=(240, 360), textures=[hl], names=[""])
    tt = np.concatenate([tt[:, : 240 * 4], tt[:, 240 * 4:]], 0)  # 2 x 4 views
    sel = r["sel"][bad] & (r["w"][bad] > 0)
    fr, px = r["f"][bad][sel], r["px"][bad][sel]
    crops = []
    for item in d["topFrames"][:3]:
        f = item["frame"]
        img = cv2.imread(str(work / "frames" / f"f{f:06d}.jpg"))
        pts = px[fr == f]
        if img is None or not len(pts):
            continue
        H, W = img.shape[:2]
        mk = cv2.imread(str(work / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        U = cv2.resize(mk, (W, H)) > 127
        cnt, _ = cv2.findContours(U.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(img, cnt, -1, (0, 255, 0), 2)
        for x, y in pts[:: max(1, len(pts) // 3000)].astype(int):
            cv2.circle(img, (int(x), int(y)), 2, (220, 0, 255), -1)
        x0, y0 = pts.min(0).astype(int)
        x1, y1 = pts.max(0).astype(int)
        cv2.rectangle(img, (x0 - 8, y0 - 8), (x1 + 8, y1 + 8), (0, 0, 255), 3)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        half = int(max(x1 - x0, y1 - y0, 260) * 0.9)
        box = (cy - half, cy + half, cx - int(half * 0.75), cx + int(half * 0.75))
        c = ys.crop(img, box, (360, 480), fill=60)
        ys.label(c, f"frame {f} ({100 * item['weightShare']:.0f}% of weight)", scale=0.5)
        crops.append(c)
    right = np.concatenate(crops, 1) if crops else np.zeros((480, 360, 3), np.uint8)
    left = cv2.resize(tt, (int(tt.shape[1] * 480 / tt.shape[0]), 480))
    sheet = np.concatenate([left, right], 1)
    ws = d["weightShare"]
    text = (f"{title}: {d['texels']} texels; weight from other person {100 * (ws['otherPersonPixels']):.0f}% / their zone "
            f"{100 * ws['otherPersonZone']:.0f}% / mask edge band {100 * ws['maskEdgeBand']:.0f}% / clean {100 * ws['clean']:.0f}%; "
            f"green = person mask outline, magenta dots = source pixels")
    bar = np.full((28, sheet.shape[1], 3), 30, np.uint8)
    cv2.putText(bar, text, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(path), np.concatenate([bar, sheet], 0), [cv2.IMWRITE_JPEG_QUALITY, 88])


def heldout_split(eval_dir: Path, glbs, res: list[dict], assets) -> dict:
    """Squared error of the shipped avatars on the held-out frames, split by what each pixel is: not covered by
    the render (the background grey shows), or covered and textured by a seen / penalised / mirrored / LaMa texel;
    and by body region."""
    import cv2

    from pipeline.avatar.texture import REGIONS

    meta, data, get = ys.load_masks(eval_dir)
    K = np.asarray(data["K"], np.float64)
    rend = ys.TexRenderer(K, meta["width"], meta["height"])
    frames_dir = Path(meta["work"]) / "frames"
    which = ys.match_people(glbs, meta, get, rend)
    out = {}
    for k in range(meta["people"]):
        j = which[k]
        if j < 0:
            continue
        g, r = glbs[j], res[j]
        tm = r["tm"]
        S = tm.size
        prov_img = np.full((S, S), -1, np.int64)
        prov_img[tm.ys, tm.xs] = r["prov"]
        reg_img = np.full((S, S), -1, np.int64)
        reg_img[tm.ys, tm.xs] = r["reg"]
        pyr = ys.mip_pyramid(g.tex)
        acc = {"uncovered": [0.0, 0]}
        for name in PROV:
            acc[name] = [0.0, 0]
        accr = {name: [0.0, 0] for name in REGIONS}
        for row in meta["rows"]:
            if not row["people"].get(str(k)):
                continue
            f, t = row["frame"], row["time"]
            E = get(f, k, "E")
            real = cv2.imread(str(frames_dir / f"f{f:06d}.jpg"))[:, :, ::-1].astype(np.float32)
            Vw, _ = g.pose(t)
            rgb, hit, uvi, _, _ = rend.render(ys.to_camera(Vw, np.asarray(meta["cameras"][str(f)])), g.F, g.uv, pyr)
            se = ((rgb - real) ** 2).mean(-1)
            un = E & ~hit
            acc["uncovered"][0] += float(se[un].sum())
            acc["uncovered"][1] += int(un.sum())
            cov = E & hit
            tx = np.clip((uvi[cov, 0] * S).astype(np.int64), 0, S - 1)
            ty = np.clip((uvi[cov, 1] * S).astype(np.int64), 0, S - 1)
            pv, rv, sv = prov_img[ty, tx], reg_img[ty, tx], se[cov]
            for i, name in enumerate(PROV):
                acc[name][0] += float(sv[pv == i].sum())
                acc[name][1] += int((pv == i).sum())
            for i, name in enumerate(REGIONS):
                accr[name][0] += float(sv[rv == i].sum())
                accr[name][1] += int((rv == i).sum())
        tot = sum(v[0] for v in acc.values())
        npx = sum(v[1] for v in acc.values())
        out[f"person-{k}"] = {
            "pixels": npx, "pooledPsnr": round(10 * np.log10(255 ** 2 / max(tot / max(npx, 1), 1e-6)), 3),
            "bySource": {n: {"pixelShare": round(v[1] / max(npx, 1), 4), "errorShare": round(v[0] / max(tot, 1e-9), 4),
                             "rmse": round(float(np.sqrt(v[0] / max(v[1], 1))), 2)} for n, v in acc.items()},
            "byRegion": {n: {"pixelShare": round(v[1] / max(npx, 1), 4), "errorShare": round(v[0] / max(tot, 1e-9), 4),
                             "rmse": round(float(np.sqrt(v[0] / max(v[1], 1))), 2)} for n, v in accr.items() if v[1]},
            "psnrIfUncoveredWerePerfect": round(10 * np.log10(255 ** 2 / max((tot - acc["uncovered"][0]) / max(npx, 1), 1e-6)), 3),
        }
        log("diagnose", f"held-out split person {k}: {out[f'person-{k}']}")
    return out


# ---------------------------------------------------------------------------------------------- geometry


def geometry(work: Path, poses: Path, glb_dir: Path, eval_dir: Path, out: Path) -> dict:
    import cv2

    from pipeline.avatar import body, raster
    from pipeline.avatar.body import PART_NAMES, Asset

    out.mkdir(parents=True, exist_ok=True)
    hmr = np.load(work / "hmr.npz")
    tracks = dict(np.load(work / "tracks.npz"))
    v3d = hmr["v3d"]
    n_people = sum(1 for k in tracks if k.endswith("/rest_vertices"))
    assets = [Asset.load(work / f"asset-{k}.npz") for k in range(n_people)]
    offs = [np.load(work / f"offsets-{k}.npz")["offset"] if (work / f"offsets-{k}.npz").exists() else None for k in range(n_people)]
    meta, data, get = ys.load_masks(eval_dir)
    K = np.asarray(data["K"], np.float64)
    W, H = meta["width"], meta["height"]
    rend = ys.TexRenderer(K, W, H)
    files = sorted(Path(glb_dir).glob("avatar-*.glb"), key=lambda p: int(p.stem.split("-")[-1]))
    glbs = [ys.Glb(p) for p in files]
    which = ys.match_people(glbs, meta, get, rend)
    report: dict = {"people": {}}
    parts = {"head": ["head"], "hands": ["hand.L", "hand.R"], "feet": ["foot.L", "foot.R"], "body": ["body"]}
    for k in range(n_people):
        a = assets[k]
        g = glbs[which[k]]
        src_tris = a.src_vertex[a.tris]
        rows = []
        overlays = []
        reach_cm = []
        for row in meta["rows"]:
            p = row["people"].get(str(k))
            if not p:
                continue
            f, t = row["frame"], row["time"]
            M, Vd = get(f, k, "M"), get(f, k, "V")
            T = np.asarray(meta["cameras"][str(f)])
            Vw, _ = g.pose(t)
            Vs = ys.to_camera(Vw, T)
            S_ship = rend.cast(Vs, g.F)[1]
            Vn = v3d[p["det"]].astype(np.float64)
            # ray cast, not raster.silhouette: its single cv2.fillPoly over every triangle leaves holes where
            # triangles overlap (front and back of the body), so it under-fills a body by 10-35%
            S_net = rend.cast(Vn, src_tris)[1]
            S_netpoly = raster.silhouette(Vn, src_tris, K, (H, W))
            r_poly = np.count_nonzero(S_netpoly) / max(1, np.count_nonzero(S_net))
            r = {"frame": f, "fillPolyOverRaycastPx": round(r_poly, 4)}
            for name, S in (("shipped", S_ship), ("network", S_net)):
                inter = np.count_nonzero(S & M & Vd)
                r[name] = {"iou": inter / max(1, np.count_nonzero((S | M) & Vd)), "precision": inter / max(1, np.count_nonzero(S & Vd)),
                           "recall": inter / max(1, np.count_nonzero(M & Vd))}
            if offs[k] is not None:
                n = body.vertex_normals(Vn, src_tris)
                S_off = rend.cast(Vn + offs[k][:, None] * n, src_tris)[1]
                inter = np.count_nonzero(S_off & M & Vd)
                r["networkWithOffsets"] = {"iou": inter / max(1, np.count_nonzero((S_off | M) & Vd)),
                                           "precision": inter / max(1, np.count_nonzero(S_off & Vd)),
                                           "recall": inter / max(1, np.count_nonzero(M & Vd))}
            # 2D distance between the shipped animation and the network's own body, per part
            u_s = raster.project(K, Vs)
            u_n = raster.project(K, Vn[a.src_vertex])
            dist = np.linalg.norm(u_s - u_n, axis=1)
            r["shippedVsNetworkPx"] = {pn: round(float(np.median(dist[np.isin(a.vert_part, [PART_NAMES.index(x) for x in pl])])), 2)
                                       for pn, pl in parts.items()}
            # how far the mask reaches past the shipped body (cm at the body's depth)
            miss = M & Vd & ~S_ship
            if miss.any():
                dt = cv2.distanceTransform((~S_ship).astype(np.uint8), cv2.DIST_L2, 5)
                z = float(np.median(Vs[:, 2]))
                reach_cm.append(dt[miss] * z / K[0, 0] * 100)
            rows.append(r)
            if len(overlays) < 4 and p["evalPx"] > 0.6 * max(q["evalPx"] for q in [rr["people"].get(str(k)) for rr in meta["rows"]] if q):
                overlays.append((f, M, Vd, S_ship, S_net))
        agg = {}
        for name in ("shipped", "network", "networkWithOffsets"):
            vals = [r[name] for r in rows if name in r]
            if vals:
                agg[name] = {m: round(float(np.mean([v[m] for v in vals])), 4) for m in ("iou", "precision", "recall")}
        agg["fillPolyOverRaycastPx"] = round(float(np.median([r["fillPolyOverRaycastPx"] for r in rows])), 4)
        agg["shippedVsNetworkPxMedian"] = {pn: round(float(np.median([r["shippedVsNetworkPx"][pn] for r in rows])), 2) for pn in parts}
        if reach_cm:
            rc = np.concatenate(reach_cm)
            agg["maskPastBodyCm"] = {"pixels": int(len(rc)), "<2": round(float((rc < 2).mean()), 3), "2-5": round(float(((rc >= 2) & (rc < 5)).mean()), 3),
                                     "5-10": round(float(((rc >= 5) & (rc < 10)).mean()), 3), "10-20": round(float(((rc >= 10) & (rc < 20)).mean()), 3),
                                     ">20": round(float((rc >= 20).mean()), 3), "median": round(float(np.median(rc)), 2)}
        agg["offsets"] = read_json(work / f"offsets-{k}.json")
        report["people"][f"person-{k}"] = {"summary": agg, "perFrame": rows}
        # overlays: green = mask and shipped body, red = mask only, blue = shipped body only, yellow = network outline
        tiles = []
        for f, M, Vd, S1, S2 in overlays:
            img = cv2.imread(str(work / "frames" / f"f{f:06d}.jpg"))
            ov = img.copy()
            ov[M & Vd & S1] = (60, 200, 60)
            ov[M & Vd & ~S1] = (40, 40, 230)
            ov[S1 & Vd & ~M] = (230, 120, 30)
            vis = cv2.addWeighted(img, 0.45, ov, 0.55, 0)
            cnt, _ = cv2.findContours(S2.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(vis, cnt, -1, (0, 230, 255), 2)
            box = ys.box_of(M | S1, pad=0.06, aspect=0.75)
            c = ys.crop(vis, box, (360, 480), fill=40)
            r = next(rr for rr in rows if rr["frame"] == f)
            ys.label(c, f"f{f} iou shipped {r['shipped']['iou']:.2f} network {r['network']['iou']:.2f}", scale=0.48)
            tiles.append(c)
        if tiles:
            sheet = np.concatenate(tiles, 1)
            bar = np.full((26, sheet.shape[1], 3), 30, np.uint8)
            cv2.putText(bar, f"person-{k}: green = mask and shipped body, red = mask only (clothes, backpack, hair, coarse mask), "
                             f"blue = shipped body off the mask, yellow line = network's own body", (6, 18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.imwrite(str(out / f"misfit-person-{k}.jpg"), np.concatenate([bar, sheet], 0), [cv2.IMWRITE_JPEG_QUALITY, 88])
        # jitter: frame-to-frame second difference of the main bones' local rotations, shipped vs network
        report["people"][f"person-{k}"]["jitter"] = jitter(tracks, hmr, k)
        report["people"][f"person-{k}"]["seams"] = seams(work, a, k, out)
        log("diagnose", f"geometry person {k}: {agg} jitter {report['people'][f'person-{k}']['jitter']}")
    write_json(out / "geometry.json", report)
    return report


def jitter(tracks: dict, hmr, k: int) -> dict:
    from pipeline.avatar.ground import pose_params
    from pipeline.avatar.util import quat_to_mat, rot_angle_deg

    labels = [str(x) for x in tracks["bone_labels"]]
    parents = tracks["bone_parents"]
    keys = ("spine03", "neck01", "head", "upperarm01.L", "upperarm01.R", "lowerarm01.L", "lowerarm01.R", "upperleg01.L",
            "upperleg01.R", "lowerleg01.L", "lowerleg01.R")
    js = [labels.index(x) for x in keys if x in labels]
    pre = f"person-{k}/"
    R_ship = quat_to_mat(tracks[pre + "delta_q"][:, js])
    det, valid = tracks[pre + "det"], tracks[pre + "valid"]
    ok = (det >= 0) & valid
    run = np.nonzero(ok)[0]
    d = det[run]
    R_net = pose_params(hmr["bone_poses"][d].astype(np.float64), hmr["rest_bone_poses"][d].astype(np.float64), parents)[:, js]

    def accel(R, idx):
        # per consecutive triple and bone: the angle between the middle pose and the halfway rotation of its
        # neighbours (a second difference on the rotation group), degrees
        from scipy.spatial.transform import Rotation

        out = []
        for i in range(1, len(idx) - 1):
            if idx[i + 1] - idx[i - 1] != 2:
                continue
            r0, r1, r2 = (Rotation.from_matrix(R[j]) for j in (i - 1, i, i + 1))
            mid = r0 * Rotation.from_rotvec(0.5 * (r0.inv() * r2).as_rotvec())
            out.append(np.degrees((mid.inv() * r1).magnitude()))
        return np.concatenate(out) if out else np.zeros(1)

    ship = accel(R_ship[run], run)
    net = accel(R_net, run)
    rp = tracks[pre + "root_p"]
    acc = np.linalg.norm(np.diff(rp, 2, axis=0), axis=1) * 100
    return {"boneAccelDegShipped": {"median": round(float(np.median(ship)), 3), "p95": round(float(np.percentile(ship, 95)), 3)},
            "boneAccelDegNetwork": {"median": round(float(np.median(net)), 3), "p95": round(float(np.percentile(net, 95)), 3)},
            "rootAccelCmShipped": {"median": round(float(np.median(acc)), 3), "p95": round(float(np.percentile(acc, 95)), 3)}}


def seams(work: Path, a, k: int, out: Path) -> dict:
    """Colour jump across UV seams (one 3D point, two UV positions) vs. the colour change along ordinary mesh edges."""
    import cv2

    tex = cv2.imread(str(work / f"tex-{k}.jpg"))[:, :, ::-1].astype(np.float32)
    S = tex.shape[0]
    blur = cv2.GaussianBlur(tex, (0, 0), 2.0)

    def colour_at(vi: np.ndarray) -> np.ndarray:
        # just inside the vertex's own triangles: 70% vertex UV + 30% the triangle centroid's, averaged over its triangles
        acc = np.zeros((len(vi), 3))
        cnt = np.zeros(len(vi))
        pos = {int(v): i for i, v in enumerate(vi)}
        for c in range(3):
            sel = np.isin(a.tris[:, c], vi)
            for t in np.nonzero(sel)[0]:
                v = int(a.tris[t, c])
                uv = 0.7 * a.uv[v] + 0.3 * a.uv[a.tris[t]].mean(0)
                x, y = np.clip((uv * S - 0.5).astype(int), 0, S - 1)
                acc[pos[v]] += blur[y, x]
                cnt[pos[v]] += 1
        return acc / np.maximum(cnt[:, None], 1)

    sv = a.src_vertex
    order = np.argsort(sv, kind="stable")
    s_sorted = sv[order]
    starts = np.r_[0, np.nonzero(np.diff(s_sorted))[0] + 1]
    counts = np.diff(np.r_[starts, len(sv)])
    pairs = np.array([(order[s], order[s + 1]) for s, c in zip(starts, counts) if c >= 2])
    rng = np.random.default_rng(0)
    pairs = pairs[rng.choice(len(pairs), size=min(3000, len(pairs)), replace=False)]
    ca, cb = colour_at(pairs[:, 0]), colour_at(pairs[:, 1])
    jump = np.linalg.norm(ca - cb, axis=1)
    e = np.concatenate([a.tris[:, [0, 1]], a.tris[:, [1, 2]]])
    e = e[rng.choice(len(e), size=3000, replace=False)]
    ea, eb = colour_at(e[:, 0]), colour_at(e[:, 1])
    edge = np.linalg.norm(ea - eb, axis=1)
    elen = np.linalg.norm(a.positions[e[:, 0]] - a.positions[e[:, 1]], axis=1) * 100
    return {"seamPairs": int(len(pairs)), "seamJumpRGB": {"median": round(float(np.median(jump)), 2), "p90": round(float(np.percentile(jump, 90)), 2),
                                                         "over40": round(float((jump > 40).mean()), 4)},
            "edgeChangeRGB": {"median": round(float(np.median(edge)), 2), "p90": round(float(np.percentile(edge, 90)), 2),
                              "over40": round(float((edge > 40).mean()), 4), "edgeLengthCmMedian": round(float(np.median(elen)), 2)}}


def controls(work: Path, glb_dir: Path, eval_dir: Path, out: Path) -> dict:
    """The yardstick's numbers for renders that change one thing each:
      shipped           the shipped GLB (= the baseline variant);
      networkPose       the shipped texture on the network's own per-frame body (camera space, what the bake projected
                        with): no smoothing, grounding or interpolation, so the pose drift of the animation is gone;
      networkPoseOffsets the same with the rejected silhouette offsets along the posed normals: clothing volume;
      flatColours       the shipped GLB with its fallback texture (one median colour per body region)."""
    import cv2

    from pipeline.avatar import body
    from pipeline.avatar.body import Asset

    out.mkdir(parents=True, exist_ok=True)
    hmr = np.load(work / "hmr.npz")
    tracks = dict(np.load(work / "tracks.npz"))
    v3d = hmr["v3d"]
    meta, data, get = ys.load_masks(eval_dir)
    K = np.asarray(data["K"], np.float64)
    W, H = meta["width"], meta["height"]
    rend = ys.TexRenderer(K, W, H)
    files = sorted(Path(glb_dir).glob("avatar-*.glb"), key=lambda p: int(p.stem.split("-")[-1]))
    glbs = [ys.Glb(p) for p in files]
    which = ys.match_people(glbs, meta, get, rend)
    frames_dir = Path(meta["work"]) / "frames"
    res: dict = {}
    for k in range(meta["people"]):
        g = glbs[which[k]]
        a = Asset.load(work / f"asset-{which[k]}.npz")
        src_tris = a.src_vertex[a.tris]
        off = np.load(work / f"offsets-{which[k]}.npz")["offset"] if (work / f"offsets-{which[k]}.npz").exists() else None
        flat = cv2.imread(str(work / f"tex-f1-{which[k]}.jpg"))[:, :, ::-1]
        pyr, pyr_flat = ys.mip_pyramid(g.tex), ys.mip_pyramid(flat)
        fr_k, valid_k = tracks[f"person-{which[k]}/frames"], tracks[f"person-{which[k]}/valid"]
        rows = []
        for row in meta["rows"]:
            p = row["people"].get(str(k))
            if not p:
                continue
            f, t = row["frame"], row["time"]
            M, E, Vd = get(f, k, "M"), get(f, k, "E"), get(f, k, "V")
            if E.sum() < 200:
                continue
            real = cv2.imread(str(frames_dir / f"f{f:06d}.jpg"))[:, :, ::-1].astype(np.float32)
            Vw, _ = g.pose(t)
            Vs = ys.to_camera(Vw, np.asarray(meta["cameras"][str(f)]))
            Vn = v3d[p["det"]].astype(np.float64)
            i = np.nonzero(fr_k == f)[0]
            r = {"frame": f, "valid": bool(valid_k[i[0]]) if len(i) else None, "inFrame": p["inFrame"]}
            renders = {"shipped": (Vs, g.F, g.uv, pyr), "flatColours": (Vs, g.F, g.uv, pyr_flat),
                       "networkPose": (Vn[a.src_vertex], a.tris, a.uv, pyr)}
            if off is not None:
                nrm = body.vertex_normals(Vn, src_tris)
                renders["networkPoseOffsets"] = ((Vn + off[:, None] * nrm)[a.src_vertex], a.tris, a.uv, pyr)
            for name, (V, F, uv, pp) in renders.items():
                rgb, hit, _, _, _ = rend.render(V, F, uv, pp)
                r[name] = ys.score(real, rgb, hit, M, E, Vd)
            rows.append(r)
        summ = {}
        for name in ("shipped", "networkPose", "networkPoseOffsets", "flatColours"):
            vals = [r[name] for r in rows if name in r]
            if not vals:
                continue
            mse = sum(v["mse"] * v["evalPx"] for v in vals) / sum(v["evalPx"] for v in vals)
            summ[name] = {"psnr": round(float(np.mean([v["psnr"] for v in vals])), 3), "psnrPooled": round(10 * np.log10(255 ** 2 / mse), 3),
                          "ssim": round(float(np.mean([v["ssim"] for v in vals])), 4), "iou": round(float(np.mean([v["iou"] for v in vals])), 4),
                          "recall": round(float(np.mean([v["recall"] for v in vals])), 4), "cover": round(float(np.mean([v["cover"] for v in vals])), 4)}
        inv = [r for r in rows if r["valid"] is False]
        summ["framesInvalidInTrack"] = [r["frame"] for r in inv]
        res[f"person-{k}"] = {"summary": summ, "perFrame": rows}
        log("diagnose", f"controls person {k}: {summ}")
    write_json(out / "controls.json", res)
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("trace", "geometry", "controls"):
        p = sub.add_parser(name)
        p.add_argument("--work", required=True)
        p.add_argument("--poses", required=True)
        p.add_argument("--glb-dir", required=True)
        p.add_argument("--eval", required=True)
        p.add_argument("--out", required=True)
        if name == "trace":
            p.add_argument("--world", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "trace":
        trace(Path(a.work), Path(a.poses), Path(a.world) if a.world else None, Path(a.glb_dir), Path(a.eval), Path(a.out))
    elif a.cmd == "geometry":
        geometry(Path(a.work), Path(a.poses), Path(a.glb_dir), Path(a.eval), Path(a.out))
    else:
        controls(Path(a.work), Path(a.glb_dir), Path(a.eval), Path(a.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
