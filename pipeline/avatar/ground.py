"""Step 3 (CPU): per-frame detections -> one smooth, grounded motion per person in the viewer frame.

    python -m pipeline.avatar.ground --work WORK/avatar --poses <clip>-poses.json [--people 2] [--start 0]

1. Cameras: the clip's per-frame track gives T_view_gl(t); the network's camera is cv, so T_view_cv = T_view_gl @
   diag(1, -1, -1).
2. Identity: Hungarian matching of world pelvis positions to the previous frame (gate 0.5 m, wider across gaps)
   with the network's tracking feature as a tie-break; the `people` longest tracks are kept, tracks under 1 s are
   dropped.
3. Outliers: conf < 0.4, mask IoU < 0.3, a body more than a tenth outside the frame (unless the refine step trusts
   it: its aligned fit matches the person mask), or a single-frame flip of more than 60 degrees in the root, hip,
   spine or shoulder bones; rejected frames are interpolated.
4. Shape: the median phenotype. Pose: the network's bone poses G (built on its per-frame rest skeleton R_t) are
   turned back into its pose parameters, delta_j = inv(inv(R_p) R_j) inv(G_p) G_j, and rebuilt on the median
   phenotype's rest skeleton R*, so bone lengths stay constant: G*_j = G*_p inv(R*_p) R*_j delta_j.
5. Size and floor: the body is first scaled about the camera centre by the clip median of the factor that puts
   its feet on the floor without moving any pixel (the network's bodies come out short; clamped to a standing
   height of 1.50-1.95 m); then each frame slides the body along the camera ray through the pelvis until the
   lowest sole vertex is at y = 0 (weighted with the clip-wide median of that correction).
6. Smoothing: Savitzky-Golay on the root position (window 31 on the floor plane, 9 for height, order 2) and on
   sign-aligned quaternions (window 7);
   fingers frozen at their median, face/jaw/eyes/tongue at rest.
7. Times: the presentation time of each frame minus --start (the media element's clock), clipped to --max-seconds.

Reads WORK/hmr.npz, or the refine step's WORK/hmr-refined.npz (same detections, aligned to the masks) when given.
Writes WORK/tracks.npz (person-<k>/... arrays), WORK/ground.json (checks) and WORK/evidence/ground-*.jpg.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from pipeline.avatar import raster
from pipeline.avatar.body import PART_NAMES
from pipeline.avatar.util import (CV_TO_GL, apply_T, interp_missing, log, mat_to_quat, project, quat_continuous,
                                  quat_to_mat, read_json, rigid_inv, rot_angle_deg, savgol, smooth_quats, write_json)

FREEZE_KEYS = ("finger", "metacarpal")
REST_KEYS = ("jaw", "oris", "levator", "orbicularis", "temporalis", "oculi", "risorius", "special", "eye", "tongue")
JUMP_KEYS = ("root", "pelvis", "upperleg01", "spine", "clavicle", "shoulder01", "upperarm01")
MIN_HEIGHT, MAX_HEIGHT = 1.50, 1.95  # standing height range (m) the body-size correction may produce
XZ_WINDOW = 31  # Savitzky-Golay window (frames) of the root position on the floor plane


# ---------------------------------------------------------------------------------------------- kinematics


def topo_order(parents: np.ndarray) -> list[int]:
    order, seen = [], set()
    children = {}
    for j, p in enumerate(parents):
        children.setdefault(int(p), []).append(j)
    stack = list(children.get(-1, []))
    while stack:
        j = stack.pop(0)
        if j in seen:
            continue
        seen.add(j)
        order.append(j)
        stack.extend(children.get(j, []))
    return order


def rest_locals(rest: np.ndarray, parents: np.ndarray) -> np.ndarray:
    """inv(R_parent) R_child for every non-root bone ((..., J, 4, 4); the root keeps R_0)."""
    out = np.array(rest, np.float64, copy=True)
    nonroot = parents >= 0
    out[..., nonroot, :, :] = rigid_inv(rest[..., parents[nonroot], :, :]) @ rest[..., nonroot, :, :]
    return out


def pose_params(G: np.ndarray, rest: np.ndarray, parents: np.ndarray) -> np.ndarray:
    """Network bone poses G (..., J, 4, 4) on rest skeleton `rest` -> local pose parameters delta (..., J, 3, 3).
    delta_root is G_root's rotation (its translation is zero by construction)."""
    G = np.asarray(G, np.float64)
    loc = np.array(G, copy=True)
    nonroot = parents >= 0
    loc[..., nonroot, :, :] = rigid_inv(G[..., parents[nonroot], :, :]) @ G[..., nonroot, :, :]
    d = rigid_inv(rest_locals(rest, parents)) @ loc
    d[..., ~nonroot, :, :] = G[..., ~nonroot, :, :]
    return d[..., :3, :3]


def forward(delta: np.ndarray, rest: np.ndarray, parents: np.ndarray, root: np.ndarray | None = None) -> np.ndarray:
    """Bone poses from pose parameters on a rest skeleton: G_j = G_p inv(R_p) R_j delta_j; G_root = root (4x4,
    default [delta_root | 0]). delta (T, J, 3, 3) -> (T, J, 4, 4)."""
    T, J = delta.shape[:2]
    rl = rest_locals(rest, parents)
    G = np.zeros((T, J, 4, 4))
    D = np.zeros((T, J, 4, 4))
    D[..., :3, :3] = delta
    D[..., 3, 3] = 1.0
    for j in topo_order(parents):
        p = int(parents[j])
        if p < 0:
            G[:, j] = D[:, j] if root is None else root
        else:
            G[:, j] = G[:, p] @ rl[j] @ D[:, j]
    return G


# ------------------------------------------------------------------------------------------------- cameras


def camera_track(doc: dict) -> dict[int, np.ndarray]:
    """frameIndex -> T_view_cv (4x4)."""
    out = {}
    for rec in doc["track"]:
        T = np.eye(4)
        T[:3, :3] = quat_to_mat(np.asarray(rec["quaternion"], np.float64))
        T[:3, 3] = rec["position"]
        out[int(rec["frameIndex"])] = T @ CV_TO_GL
    return out


def position_outliers(pw: np.ndarray, valid: np.ndarray, window: int = 31, max_dev: float = 0.25) -> np.ndarray:
    """Frames whose world pelvis (x, z) is more than max_dev from the median of the valid frames around it."""
    out = np.zeros(len(pw), bool)
    idx = np.nonzero(valid)[0]
    h = window // 2
    for i in idx:
        near = idx[(idx >= i - h) & (idx <= i + h)]
        med = np.median(pw[near][:, [0, 2]], axis=0)
        out[i] = np.linalg.norm(pw[i, [0, 2]] - med) > max_dev
    return out


def image_floor_scale(Tv: np.ndarray, pel_c: np.ndarray, V_rel: np.ndarray) -> np.ndarray:
    """Per frame, the factor l that scales the whole body about the camera centre (pelvis at l * pel_c, offsets
    l * V_rel, so its image does not change) until its lowest point touches the floor y = 0. NaN where no body
    point lies below the camera."""
    Rv = Tv[:, :3, :3]
    Cy = Tv[:, 1, 3]
    low = np.einsum("tj,tfj->tf", Rv[:, 1, :], pel_c[:, None, :] + V_rel).min(1)
    return np.where(low < -1e-3, -Cy / np.minimum(low, -1e-3), np.nan)


def ray_floor_scale(Tv: np.ndarray, pel_c: np.ndarray, V_rel: np.ndarray) -> np.ndarray:
    """Per frame, the factor s that slides the body along the camera ray through its pelvis (pelvis at s * pel_c,
    the body's shape relative to the pelvis unchanged) until its lowest point V_rel (cv offsets from the pelvis,
    (T,F,3)) touches the floor y = 0. Tv: T_view_cv (T,4,4). s = 1 where the pelvis ray does not point down."""
    Rv = Tv[:, :3, :3]
    Cy = Tv[:, 1, 3]
    py = np.einsum("tj,tj->t", Rv[:, 1, :], pel_c)
    vy = np.einsum("tj,tfj->tf", Rv[:, 1, :], V_rel).min(1)
    return np.where(py < -1e-3, -(Cy + vy) / np.minimum(py, -1e-3), 1.0)


# ------------------------------------------------------------------------------------------------ tracking


def track_people(frames: np.ndarray, used: np.ndarray, pelvis_w: np.ndarray, conf: np.ndarray, feat: np.ndarray,
                 gate: float = 0.5, max_gap: int = 30, min_conf: float = 0.3) -> np.ndarray:
    """Track id per detection (-1 = unassigned)."""
    from scipy.optimize import linear_sum_assignment

    ids = np.full(len(frames), -1, np.int64)
    fn = feat.astype(np.float64)
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-9)
    tracks: list[dict] = []
    for n, f in enumerate(used):
        dets = np.nonzero((frames == f) & (conf >= min_conf))[0]
        live = [k for k, t in enumerate(tracks) if n - t["n"] <= max_gap]
        if len(dets) and live:
            C = np.full((len(live), len(dets)), 1e6)
            for a, k in enumerate(live):
                t = tracks[k]
                g = gate * min(3.0, 1.0 + 0.5 * (n - t["n"] - 1))
                d = np.linalg.norm(pelvis_w[dets] - t["pos"], axis=1)
                sim = fn[dets] @ t["feat"]
                c = d + 0.1 * (1.0 - sim)
                C[a] = np.where(d <= g, c, 1e6)
            r, c = linear_sum_assignment(C)
            taken = set()
            for a, b in zip(r, c):
                if C[a, b] >= 1e6:
                    continue
                k = live[a]
                i = dets[b]
                ids[i] = k
                tracks[k].update(n=n, pos=pelvis_w[i], feat=0.8 * tracks[k]["feat"] + 0.2 * fn[i])
                tracks[k]["feat"] /= np.linalg.norm(tracks[k]["feat"])
                taken.add(i)
            dets = np.array([i for i in dets if i not in taken], np.int64)
        for i in dets:
            ids[i] = len(tracks)
            tracks.append({"n": n, "pos": pelvis_w[i], "feat": fn[i].copy()})
    return ids


def merge_tracks(ids: np.ndarray, frames: np.ndarray, used: np.ndarray, pelvis_w: np.ndarray, conf: np.ndarray,
                 gate: float = 0.8, max_gap: int = 90, max_overlap: int = 30) -> np.ndarray:
    """Join track fragments of one person. Two tracks merge when (a) they overlap in at most `max_overlap` frames
    and, where both have a detection in the same frame, those detections are within 0.6 m (duplicates), and (b)
    the hand-over (last detection of the earlier track before the later one starts) is within `gate`. In a frame
    with two detections after a merge, the higher-confidence one stays."""
    ids = ids.copy()
    pos_of = {int(f): n for n, f in enumerate(used)}
    nidx = np.array([pos_of[int(f)] for f in frames])
    changed = True
    while changed:
        changed = False
        tids = sorted([t for t in np.unique(ids) if t >= 0], key=lambda t: -np.count_nonzero(ids == t))
        for a in tids:
            for b in tids:
                if a == b:
                    continue
                ia, ib = np.nonzero(ids == a)[0], np.nonzero(ids == b)[0]
                if len(ib) > len(ia):
                    continue
                na, nb = nidx[ia], nidx[ib]
                common = np.intersect1d(na, nb)
                if len(common) > max_overlap:
                    continue
                if len(common):
                    d = [np.linalg.norm(pelvis_w[ia[na == n][0]] - pelvis_w[ib[nb == n][0]]) for n in common]
                    if np.median(d) > 0.6:
                        continue
                b0 = nb.min()
                before = ia[na < b0]
                if len(before):
                    last = before[np.argmax(nidx[before])]
                    first = ib[np.argmin(nb)]
                    if b0 - nidx[last] > max_gap or np.linalg.norm(pelvis_w[last] - pelvis_w[first]) > gate:
                        continue
                else:
                    after = ia[na > nb.max()]
                    if not len(after):
                        continue
                    first = after[np.argmin(nidx[after])]
                    last = ib[np.argmax(nb)]
                    if nidx[first] - nb.max() > max_gap or np.linalg.norm(pelvis_w[last] - pelvis_w[first]) > gate:
                        continue
                ids[ib] = a
                for n in common:  # keep one detection per frame
                    both = np.nonzero((ids == a) & (nidx == n))[0]
                    drop = both[np.argsort(-conf[both])][1:]
                    ids[drop] = -1
                changed = True
                break
            if changed:
                break
    return ids


# --------------------------------------------------------------------------------------------- main solve


def padded_box(S: np.ndarray, frac: float = 0.15) -> np.ndarray:
    ys, xs = np.nonzero(S)
    box = np.zeros(S.shape, bool)
    if len(ys) == 0:
        return box
    pad = int(frac * max(np.ptp(ys) + 1, np.ptp(xs) + 1))
    box[max(0, ys.min() - pad): ys.max() + pad + 1, max(0, xs.min() - pad): xs.max() + pad + 1] = True
    return box


def detection_iou(S: np.ndarray, mask: np.ndarray, others: list[np.ndarray]) -> float:
    """IoU of one detection's silhouette S with the person mask, inside its own padded box and excluding pixels
    that only the other detections cover."""
    if not S.any():
        return 0.0
    M = mask & padded_box(S)
    for O in others:
        M &= ~(O & ~S)
    return raster.iou(S, M)


def solve(work: Path, poses: Path, people: int = 2, start: float = 0.0, max_seconds: float = 60.0,
          anny_model=None, tris: np.ndarray | None = None, foot_vertices: np.ndarray | None = None,
          hmr_file: str = "hmr.npz", trusted: np.ndarray | None = None) -> dict:
    """trusted: per detection, cut off by the frame edge but kept (the refine step's aligned fit matches the mask)."""
    import cv2

    from pipeline.avatar import body

    h = np.load(work / hmr_file)
    doc = read_json(poses)
    K = h["K"]
    W = int(doc["intrinsics"]["width"])
    cams = camera_track(doc)
    used = h["used_frames"]
    used_t = h["used_times"]
    frames = h["frame"]
    n_det = len(frames)
    m = anny_model if anny_model is not None else body.build_anny()
    st = body.anny_static(m)
    parents = st["bone_parents"]
    labels = [str(x) for x in st["bone_labels"]]
    n_ph = len(st["phenotype_labels"])
    if tris is None:
        tris = body.triangulate(st["faces"], st["face_uv"])[0]
    if foot_vertices is None:
        tri_t, tri_uv = body.triangulate(st["faces"], st["face_uv"])
        part = body.face_parts(st["part_map"], st["uv"], tri_uv)
        foot_vertices = np.unique(tri_t[np.isin(part, [PART_NAMES.index("foot.L"), PART_NAMES.index("foot.R")])])

    # --- world pelvis of every detection
    Tvc = np.stack([cams[int(f)] for f in frames])
    pelvis_w = apply_T(Tvc, h["transl_pelvis"].astype(np.float64))
    ids = track_people(frames, used, pelvis_w, h["conf"], h["trackfeat"])
    ids = merge_tracks(ids, frames, used, pelvis_w, h["conf"])
    fps = len(used) / max(used_t[-1] - used_t[0], 1e-6)
    tids, counts = np.unique(ids[ids >= 0], return_counts=True)
    keep = [t for t, c in sorted(zip(tids, counts), key=lambda x: -x[1]) if c / fps >= 1.0][:people]
    log("ground", f"{len(tids)} tracks, lengths {sorted(counts.tolist(), reverse=True)[:6]}; keeping {len(keep)}")

    # masks (half size) for the used frames
    masks = {}
    for f in used:
        mk = cv2.imread(str(work / "masks" / f"f{int(f):06d}.png"), cv2.IMREAD_GRAYSCALE)
        masks[int(f)] = mk > 127 if mk is not None else None

    # per detection IoU (with all detections of the frame as possible occluders)
    v3d = h["v3d"].astype(np.float64)
    Hh = int(doc["intrinsics"]["height"])
    uvd = project(K, v3d[:, ::4])
    in_frame = ((uvd[..., 0] >= 0) & (uvd[..., 0] < W) & (uvd[..., 1] >= 0) & (uvd[..., 1] < Hh)).mean(1)
    cut_off = in_frame < 0.9
    if trusted is not None and len(trusted) == n_det:
        in_frame = np.where(trusted, 1.0, in_frame)
    det_iou = np.zeros(n_det)
    for f in used:
        dets = np.nonzero(frames == f)[0]
        mk = masks[int(f)]
        if mk is None:
            continue
        sil = {i: raster.silhouette(v3d[i], tris, K, mk.shape, scale=mk.shape[1] / W) for i in dets}
        for i in dets:
            det_iou[i] = detection_iou(sil[i], mk, [sil[o] for o in dets if o != i])

    T = len(used)
    evid: dict[int, list] = {}
    sil_g: dict[tuple[int, int], np.ndarray] = {}
    sil_c: dict[tuple[int, int], np.ndarray] = {}
    out: dict = {"people": [], "fps": round(float(fps), 3), "tracksFound": int(len(tids))}
    arrays: dict[str, np.ndarray] = {}
    jump_bones = [j for j, b in enumerate(labels) if any(b.startswith(k) for k in JUMP_KEYS)]
    freeze = np.array([any(k in b for k in FREEZE_KEYS) for b in labels])
    at_rest = np.array([any(k in b for k in REST_KEYS) for b in labels])
    for k, tid in enumerate(keep):
        det_of = np.full(T, -1, np.int64)
        for i in np.nonzero(ids == tid)[0]:
            det_of[np.searchsorted(used, frames[i])] = i
        found = det_of >= 0
        d = det_of[found]
        valid = found.copy()
        valid[found] &= h["conf"][d] >= 0.4
        valid[found] &= det_iou[d] >= 0.3
        valid[found] &= in_frame[d] >= 0.9  # bodies cut off by the frame edge get unreliable depth
        # pose parameters (on each detection's own rest skeleton) and the camera-space root
        delta = np.tile(np.eye(3), (T, len(labels), 1, 1))
        delta[found] = pose_params(h["bone_poses"][d].astype(np.float64), h["rest_bone_poses"][d].astype(np.float64), parents)
        pel_c = np.zeros((T, 3))
        pel_c[found] = h["transl_pelvis"][d]
        Tv = np.stack([cams[int(f)] for f in used])
        # position outliers: a detection more than 0.25 m (on the floor plane) from the running median of the
        # track's world pelvis (a duplicate of the other player, a bad depth on a cut-off body)
        pw = apply_T(Tv, pel_c)
        jumps = position_outliers(pw, valid)
        valid &= ~jumps
        # flips: a bone that turns > 60 deg away from both neighbours while they agree with each other
        root_w = Tv[:, :3, :3] @ delta[:, 0]
        flips = 0
        idx = np.nonzero(valid)[0]
        for a in range(1, len(idx) - 1):
            i0, i1, i2 = idx[a - 1], idx[a], idx[a + 1]
            if i2 - i0 > 6:
                continue
            for j in jump_bones:
                Ra = root_w if j == 0 else delta[:, j]
                if (rot_angle_deg(Ra[i1], Ra[i0]) > 60 and rot_angle_deg(Ra[i1], Ra[i2]) > 60
                        and rot_angle_deg(Ra[i0], Ra[i2]) < 30):
                    valid[i1] = False
                    flips += 1
                    break
        # shape: median phenotype of the valid frames
        ph = np.median(h["shape"][det_of[valid], :n_ph].astype(np.float64), axis=0)
        rest_v, rest_b = body.anny_rest(m, ph[None])
        rest_v, rest_b = rest_v[0], rest_b[0]
        # quaternions: valid frames kept, the rest interpolated, then smoothed
        q = mat_to_quat(delta)  # (T,J,4)
        q_root = mat_to_quat(root_w)
        q[valid] = quat_continuous(q[valid])
        q_root[valid] = quat_continuous(q_root[valid][:, None])[:, 0]
        q = interp_missing(q, valid)
        q_root = interp_missing(q_root, valid)
        q = q / np.linalg.norm(q, axis=-1, keepdims=True)
        q_root = q_root / np.linalg.norm(q_root, axis=-1, keepdims=True)
        q = smooth_quats(q, 7)
        q_root = smooth_quats(q_root[:, None], 7)[:, 0]
        q_med = np.median(quat_continuous(q[:, freeze]), axis=0)
        q[:, freeze] = q_med / np.linalg.norm(q_med, axis=-1, keepdims=True)
        q[:, at_rest] = np.array([0.0, 0.0, 0.0, 1.0])
        delta_s = quat_to_mat(q)
        # rejected frames: interpolate the pelvis in the world (the camera moves), then back into each camera
        pel_c = apply_T(rigid_inv(Tv), interp_missing(apply_T(Tv, pel_c), valid))
        # floor: slide along the camera ray through the pelvis
        root_c = np.tile(np.eye(4), (T, 1, 1))  # the smoothed world root, expressed in the camera, at the pelvis
        root_c[:, :3, :3] = Tv[:, :3, :3].transpose(0, 2, 1) @ quat_to_mat(q_root)
        Gm = forward(delta_s, rest_b, parents, root=root_c)
        V = np.stack([body.lbs(rest_v[foot_vertices], st_w(st, foot_vertices), st_i(st, foot_vertices), Gm[t], rest_b)
                      for t in range(T)])  # (T,F,3) camera-oriented, relative to the pelvis
        # body size: the network fits the image well but its bodies come out short, so at its own depth their feet
        # float above the floor. Scaling the body about the camera centre keeps every pixel where the network put
        # it and lands the feet on the floor; the clip median of that factor (sigma) becomes the person's size and
        # the per-frame slide below only takes up what is left.
        lam = image_floor_scale(Tv, pel_c, V)
        h0 = float(rest_v[:, 2].max() - rest_v[:, 2].min())
        ok_l = valid & np.isfinite(lam)
        sigma = float(np.median(lam[ok_l])) if ok_l.any() else 1.0
        sigma = float(np.clip(sigma, max(0.8, MIN_HEIGHT / h0), min(1.25, MAX_HEIGHT / h0)))
        rest_v = rest_v * sigma
        rest_b = rest_b.copy()
        rest_b[:, :3, 3] *= sigma
        pel_c = pel_c * sigma
        V = V * sigma
        s_floor = ray_floor_scale(Tv, pel_c, V)
        s_med = float(np.median(s_floor[valid])) if valid.any() else 1.0
        # every frame (rejected ones carry the interpolated pose and pelvis) slides to the floor when its correction
        # is plausible; the median stands in otherwise
        good = np.abs(np.log(np.maximum(s_floor, 1e-3) / s_med)) < 0.25
        s = np.where(good, s_floor, s_med)
        s = np.exp(0.85 * np.log(np.maximum(s, 1e-3)) + 0.15 * np.log(s_med))
        s = savgol(s, 15, 2)
        root_p = apply_T(Tv, s[:, None] * pel_c)
        # height keeps the short window (it carries the floor contact); the floor-plane position gets about a
        # second, which removes the per-frame depth jitter (feet skating, jumps where the body is cut off)
        root_p = np.concatenate([savgol(root_p[:, :1], XZ_WINDOW, 2), savgol(root_p[:, 1:2], 9, 2),
                                 savgol(root_p[:, 2:], XZ_WINDOW, 2)], 1)
        # final world bone poses and checks
        Rw = quat_to_mat(q_root)
        Groot = np.tile(np.eye(4), (T, 1, 1))
        Groot[:, :3, :3] = Rw
        Groot[:, :3, 3] = root_p
        Gw = forward(delta_s, rest_b, parents, root=Groot)
        foot_y = np.array([body.lbs(rest_v[foot_vertices], st_w(st, foot_vertices), st_i(st, foot_vertices), Gw[t], rest_b)[:, 1].min()
                           for t in range(T)])
        jitter = np.linalg.norm(np.diff(root_p, axis=0), axis=1)
        resid = np.linalg.norm(root_p - savgol(root_p, 31, 2), axis=1)  # wobble around the slow path
        acc = np.linalg.norm(np.diff(root_p, 2, axis=0), axis=1)
        # silhouette IoU after grounding (every 3rd frame)
        # silhouettes every 3rd frame: grounded (world) and camera-aligned (network depth, for texturing)
        wk, ik = st["weights"], st["indices"]
        cam_p = savgol(pel_c, 9, 2)
        root_c[:, :3, 3] = cam_p
        Gc = forward(delta_s, rest_b, parents, root=root_c)
        for t in range(0, T, 3):
            mk = masks[int(used[t])]
            if mk is None:
                continue
            Vc = apply_T(rigid_inv(Tv[t]), body.lbs(rest_v, wk, ik, Gw[t], rest_b))
            sil_g[(t, k)] = raster.silhouette(Vc, tris, K, mk.shape, scale=mk.shape[1] / W)
            sil_c[(t, k)] = raster.silhouette(body.lbs(rest_v, wk, ik, Gc[t], rest_b), tris, K, mk.shape, scale=mk.shape[1] / W)
            if t % 30 == 0:
                D = raster.silhouette(v3d[det_of[t]], tris, K, mk.shape, scale=mk.shape[1] / W) if det_of[t] >= 0 else None
                evid.setdefault(int(used[t]), []).append((k, sil_g[(t, k)], sil_c[(t, k)], D))
        times = used_t - start
        sel = (times >= -1e-6) & (times <= max_seconds + 1e-6)
        pre = f"person-{k}/"
        arrays.update({
            pre + "times": times[sel], pre + "frames": used[sel], pre + "valid": valid[sel], pre + "found": found[sel],
            pre + "delta_q": q[sel].astype(np.float64), pre + "root_q": q_root[sel], pre + "root_p": root_p[sel],
            pre + "phenotype": ph, pre + "rest_vertices": rest_v, pre + "rest_bone_poses": rest_b,
            pre + "depth_scale": s[sel], pre + "foot_y": foot_y[sel], pre + "det": det_of[sel],
            pre + "cam_pelvis": cam_p[sel], pre + "body_scale": np.array(sigma),
        })
        rep = {
            "track": int(tid), "foundFraction": round(float(found.mean()), 4), "validFraction": round(float(valid.mean()), 4),
            "flipsRejected": int(flips), "positionOutliers": int(jumps.sum()),
            "cutOffFrames": int(np.count_nonzero(cut_off[d])), "cutOffTrusted": int(np.count_nonzero(cut_off[d] & (in_frame[d] >= 0.9))),
            "confMedian": round(float(np.median(h["conf"][d])), 3) if len(d) else None,
            "detectionIoU": {"median": round(float(np.median(det_iou[d])), 3) if len(d) else None,
                             "p10": round(float(np.percentile(det_iou[d], 10)), 3) if len(d) else None},
            "phenotype": {lab: round(float(v), 3) for lab, v in zip(st["phenotype_labels"], ph)},
            "bodyScale": {"sigma": round(sigma, 4), "imageFloorScale": {
                "median": round(float(np.median(lam[ok_l])), 3) if ok_l.any() else None,
                "p10": round(float(np.percentile(lam[ok_l], 10)), 3) if ok_l.any() else None,
                "p90": round(float(np.percentile(lam[ok_l], 90)), 3) if ok_l.any() else None},
                "networkHeightM": round(h0, 3)},
            "depthScale": {"median": round(s_med, 3), "min": round(float(s.min()), 3), "max": round(float(s.max()), 3)},
            "footYcm": {"medianAbs": round(100 * float(np.median(np.abs(foot_y))), 2),
                        "p95Abs": round(100 * float(np.percentile(np.abs(foot_y), 95)), 2)},
            "pelvisJitterCmPerFrame": {"median": round(100 * float(np.median(jitter)), 2),
                                       "p95": round(100 * float(np.percentile(jitter, 95)), 2)},
            "pelvisResidualCm": {"median": round(100 * float(np.median(resid)), 2), "p95": round(100 * float(np.percentile(resid, 95)), 2)},
            "pelvisAccelCm": {"median": round(100 * float(np.median(acc)), 3), "p95": round(100 * float(np.percentile(acc, 95)), 3)},
            "pelvisMeanWorld": [round(float(v), 3) for v in root_p.mean(0)],
            "heightM": round(float(rest_v[:, 2].max() - rest_v[:, 2].min()), 3),
        }
        out["people"].append(rep)
        log("ground", f"person {k}: {rep}")
    # IoU with the person mask inside each body's padded box, minus pixels only the other bodies cover
    for k, rep in enumerate(out["people"]):
        for name, sil in (("smoothedIoU", sil_c), ("groundedIoU", sil_g)):
            vals, prec, rec = [], [], []
            for (t, kk), S in sil.items():
                if kk != k or not S.any():
                    continue
                M = masks[int(used[t])] & padded_box(S)
                for (t2, k2), O in sil.items():
                    if t2 == t and k2 != k:
                        M &= ~(O & ~S)
                vals.append(raster.iou(S, M))
                prec.append(np.count_nonzero(S & M) / max(1, np.count_nonzero(S)))
                rec.append(np.count_nonzero(S & M) / max(1, np.count_nonzero(M)))
            rep[name] = {"median": round(float(np.median(vals)), 3) if vals else None,
                         "p10": round(float(np.percentile(vals, 10)), 3) if vals else None,
                         "precision": round(float(np.median(prec)), 3) if prec else None,
                         "recall": round(float(np.median(rec)), 3) if rec else None, "frames": len(vals)}
        log("ground", f"person {k} IoU: smoothed {rep['smoothedIoU']} grounded {rep['groundedIoU']}")
    if len(out["people"]) >= 2:
        P0 = arrays["person-0/root_p"]
        P1 = arrays["person-1/root_p"]
        n = min(len(P0), len(P1))
        dist = np.linalg.norm((P0[:n] - P1[:n])[:, [0, 2]], axis=1)
        out["pelvisDistanceM"] = {"median": round(float(np.median(dist)), 3), "min": round(float(dist.min()), 3),
                                  "max": round(float(dist.max()), 3)}
    both = np.zeros(T, bool)
    if len(keep) >= 2:
        f0 = np.isin(used, frames[ids == keep[0]])
        f1 = np.isin(used, frames[ids == keep[1]])
        both = f0 & f1
    out["bothFoundFraction"] = round(float(both.mean()), 4)
    out["start"] = start
    out["mediaDuration"] = round(float(min(max_seconds, used_t[-1] - start)), 4)
    draw_evidence(work, evid, masks, arrays, cams, len(out["people"]))
    arrays["bone_parents"] = parents
    arrays["bone_labels"] = np.asarray(labels)
    arrays["K"] = K
    np.savez_compressed(work / "tracks.npz", **arrays)
    write_json(work / "ground.json", out)
    return out


COLOURS = [(255, 170, 0), (0, 140, 255), (80, 220, 80), (220, 0, 220)]


def draw_evidence(work: Path, evid: dict, masks: dict, arrays: dict, cams: dict, n_people: int) -> None:
    """Per sampled frame: the person mask (white outline), each network detection (yellow outline) and the
    grounded body (filled, one colour per person). Plus a top view of the floor with both pelvis paths and the
    camera path, and the lowest sole height over time."""
    import cv2

    ev = work / "evidence"
    ev.mkdir(exist_ok=True)
    for f, items in sorted(evid.items()):
        img = cv2.imread(str(work / "frames" / f"f{f:06d}.jpg"))
        mk = masks.get(f)
        if img is None or mk is None:
            continue
        img = cv2.resize(img, (mk.shape[1], mk.shape[0]), interpolation=cv2.INTER_AREA)
        over = img.copy()
        over[mk] = (0, 0, 160)
        for k, S, C, D in items:
            over[S] = COLOURS[k % 4]
        img = cv2.addWeighted(img, 0.5, over, 0.5, 0)
        for k, S, C, D in items:
            for sil, col, th in ((D, (0, 255, 255), 1), (C, COLOURS[k % 4], 2)):
                if sil is not None:
                    c, _ = cv2.findContours(sil.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    cv2.drawContours(img, c, -1, col, th)
        cv2.putText(img, "red: person mask | fill: grounded body | outline: camera-aligned body | yellow: raw network",
                    (5, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        cv2.imwrite(str(ev / f"ground-{f:06d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    # top view (x right, z down), 1 px = 1 cm
    size, ctr = 600, np.array([0.0, -1.5])
    top = np.full((size, size, 3), 30, np.uint8)
    for x in range(-3, 4):
        cv2.line(top, (int(size / 2 + (x - ctr[0]) * 100), 0), (int(size / 2 + (x - ctr[0]) * 100), size), (60, 60, 60), 1)
    for z in range(-5, 2):
        cv2.line(top, (0, int(size / 2 + (z - ctr[1]) * 100)), (size, int(size / 2 + (z - ctr[1]) * 100)), (60, 60, 60), 1)

    def px(p):
        return int(size / 2 + (p[0] - ctr[0]) * 100), int(size / 2 + (p[2] - ctr[1]) * 100)

    cpath = [cams[int(f)][:3, 3] for f in sorted(cams)]
    for a, b in zip(cpath[:-1], cpath[1:]):
        cv2.line(top, px(a), px(b), (200, 200, 200), 1)
    for k in range(n_people):
        P = arrays[f"person-{k}/root_p"]
        for a, b in zip(P[:-1], P[1:]):
            cv2.line(top, px(a), px(b), COLOURS[k % 4], 2)
        cv2.putText(top, f"person {k}", px(P[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOURS[k % 4], 1)
    cv2.putText(top, "top view, 1 m grid; grey = camera path", (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    cv2.imwrite(str(ev / "ground-top.png"), top)
    # lowest sole height over time, +-5 cm range, 1 px = 1 mm
    w = 740
    plot = np.full((120, w, 3), 30, np.uint8)
    cv2.line(plot, (0, 60), (w, 60), (120, 120, 120), 1)
    for d in (-20, 20):
        cv2.line(plot, (0, 60 - d), (w, 60 - d), (70, 70, 70), 1)
    for k in range(n_people):
        y = arrays[f"person-{k}/foot_y"]
        xs = np.linspace(0, w - 1, len(y)).astype(int)
        pts = np.stack([xs, np.clip(60 - y * 1000, 0, 119).astype(int)], 1)
        cv2.polylines(plot, [pts.reshape(-1, 1, 2)], False, COLOURS[k % 4], 1)
    cv2.putText(plot, "lowest sole y (mm), lines at 0 and +-2 cm", (5, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    cv2.imwrite(str(ev / "ground-feet.png"), plot)


def st_w(st: dict, idx: np.ndarray) -> np.ndarray:
    return st["weights"][idx]


def st_i(st: dict, idx: np.ndarray) -> np.ndarray:
    return st["indices"][idx]


def world_bone_poses(tracks, k: int, parents: np.ndarray | None = None) -> np.ndarray:
    """(T, J, 4, 4) world bone poses of person k from tracks.npz arrays."""
    pre = f"person-{k}/"
    parents = tracks["bone_parents"] if parents is None else parents
    q = tracks[pre + "delta_q"]
    Groot = np.tile(np.eye(4), (len(q), 1, 1))
    Groot[:, :3, :3] = quat_to_mat(tracks[pre + "root_q"])
    Groot[:, :3, 3] = tracks[pre + "root_p"]
    return forward(quat_to_mat(q), tracks[pre + "rest_bone_poses"], parents, root=Groot)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--poses", required=True)
    ap.add_argument("--people", type=int, default=2)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--max-seconds", type=float, default=60.0)
    a = ap.parse_args(argv)
    solve(Path(a.work), Path(a.poses), a.people, a.start, a.max_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
