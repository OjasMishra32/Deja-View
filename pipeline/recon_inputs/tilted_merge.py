#!/usr/bin/env python3
"""Separate COLMAP models of one place (one per continuous video range) -> one model, joined only where many
independent views agree.

  python tilted_merge.py SPARSE_DIR --database database.db --frames frames.json --out MERGED_DIR [--report r.json]

Why: a game town reuses textures and whole buildings, so a single view pair across two ranges can verify with
dozens of inliers and still show two different places. Mapping everything at once lets such pairs pull frames
to the wrong copy. Here each range is reconstructed from its own time-adjacent pairs only (trustworthy), and the
cross-range pairs are used afterwards, all together: every inlier match whose two keypoints both carry a 3D point
gives a 3D-3D correspondence between two models; a similarity transform is fitted with RANSAC to all of them at
once, and an edge is accepted only if it has many inlier correspondences coming from several different image pairs.
The accepted edges form a maximum spanning tree rooted at the largest model; every model is moved into the root
frame and written as one model (tracks kept, point ids renumbered). Re-triangulate and bundle-adjust it afterwards
(colmap point_triangulator + bundle_adjuster) so cross-model tracks join.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import struct
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tilted_coverage import CAM_NPARAMS, qvec2rot  # noqa: E402

M = 2147483647


def read_model(d: Path) -> dict:
    cams = {}
    with open(d / "cameras.bin", "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            cid, model, w, h = struct.unpack("<iiQQ", f.read(24))
            k = CAM_NPARAMS[model]
            cams[cid] = (model, w, h, np.array(struct.unpack(f"<{k}d", f.read(8 * k))))
    images = {}
    with open(d / "images.bin", "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            iid = struct.unpack("<I", f.read(4))[0]
            q = np.array(struct.unpack("<4d", f.read(32)))
            t = np.array(struct.unpack("<3d", f.read(24)))
            cid = struct.unpack("<I", f.read(4))[0]
            name = b""
            while (c := f.read(1)) != b"\x00":
                name += c
            n = struct.unpack("<Q", f.read(8))[0]
            arr = np.frombuffer(f.read(24 * n), dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("id", "<i8")])).copy()
            images[iid] = {"name": name.decode(), "q": q, "t": t, "cam": cid, "pts": arr}
    points = {}
    with open(d / "points3D.bin", "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            pid, x, y, z, r, g, b, e, L = struct.unpack("<Q3d3BdQ", f.read(51))
            tr = np.frombuffer(f.read(8 * L), dtype="<u4").reshape(-1, 2).copy()
            points[pid] = {"xyz": np.array([x, y, z]), "rgb": (r, g, b), "err": e, "track": tr}
    return {"cams": cams, "images": images, "points": points}


def rot2qvec(R: np.ndarray) -> np.ndarray:
    K = np.array([[R[0, 0] - R[1, 1] - R[2, 2], 0, 0, 0],
                  [R[1, 0] + R[0, 1], R[1, 1] - R[0, 0] - R[2, 2], 0, 0],
                  [R[2, 0] + R[0, 2], R[2, 1] + R[1, 2], R[2, 2] - R[0, 0] - R[1, 1], 0],
                  [R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1], R[0, 0] + R[1, 1] + R[2, 2]]]) / 3.0
    w, v = np.linalg.eigh(K)
    q = v[[3, 0, 1, 2], np.argmax(w)]
    return -q if q[0] < 0 else q


def umeyama(A: np.ndarray, B: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """s, R, t minimising |s R A + t - B|."""
    ma, mb = A.mean(0), B.mean(0)
    a, b = A - ma, B - mb
    U, S, Vt = np.linalg.svd(b.T @ a / len(A))
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    va = (a ** 2).sum() / len(A)
    s = float(np.trace(np.diag(S) @ D) / max(va, 1e-12))
    return s, R, mb - s * R @ ma


def ransac_sim3(A, B, thr, iters, rng):
    n = len(A)
    best = (0, None)
    for _ in range(iters):
        idx = rng.choice(n, 3, replace=False)
        try:
            s, R, t = umeyama(A[idx], B[idx])
        except np.linalg.LinAlgError:
            continue
        if not np.isfinite(s) or s <= 0:
            continue
        err = np.linalg.norm((s * (R @ A.T)).T + t - B, axis=1)
        k = int((err < thr).sum())
        if k > best[0]:
            best = (k, err < thr)
    if best[1] is None:
        return None
    inl = best[1]
    for _ in range(3):
        s, R, t = umeyama(A[inl], B[inl])
        err = np.linalg.norm((s * (R @ A.T)).T + t - B, axis=1)
        inl = err < thr
    return s, R, t, inl


def centers(model: dict) -> dict:
    out = {}
    for iid, im in model["images"].items():
        R = qvec2rot(im["q"])
        out[iid] = -R.T @ im["t"]
    return out


def step_scale(model: dict, meta: dict) -> float:
    c = centers(model)
    rows = sorted((meta[model["images"][i]["name"]]["time"], i) for i in c)
    d = [np.linalg.norm(c[b] - c[a]) / max(tb - ta, 0.05) for (ta, a), (tb, b) in zip(rows[:-1], rows[1:])]
    return float(np.median(d)) * 0.5 if d else 1.0  # model units per half second of video


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sparse", type=Path)
    ap.add_argument("--database", type=Path, required=True)
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--min-pair-inliers", type=int, default=20)
    ap.add_argument("--min-corr", type=int, default=60, help="inlier 3D-3D correspondences an edge needs")
    ap.add_argument("--min-pairs", type=int, default=3, help="distinct image pairs among an edge's inliers")
    ap.add_argument("--min-ratio", type=float, default=0.3, help="inlier fraction an edge needs")
    ap.add_argument("--thr", type=float, default=1.0, help="RANSAC threshold in half-second steps of the target")
    ap.add_argument("--min-model", type=int, default=8)
    ap.add_argument("--scale-band", type=float, default=1.25, help="allowed factor between fitted and speed-implied scale")
    ap.add_argument("--scale-tight", type=float, default=1.1, help="scale agreement that lets a weaker edge in")
    ap.add_argument("--min-corr-tight", type=int, default=25)
    ap.add_argument("--scale-trust", type=float, default=1.15, help="scale agreement for a trusted edge")
    ap.add_argument("--pairs-out", type=Path, help="write the view pairs (pair_id) of trusted edges that agree")
    a = ap.parse_args(argv)
    rng = np.random.default_rng(0)
    meta = {r["name"]: r for r in json.loads(a.frames.read_text())["images"]}

    models = {}
    for d in sorted(p for p in a.sparse.iterdir() if (p / "images.bin").exists()):
        m = read_model(d)
        if len(m["images"]) >= a.min_model:
            models[d.name] = m
    owner = {}
    for k, m in models.items():
        for iid in m["images"]:
            if iid in owner:  # an image in two models: keep it in the bigger one
                if len(models[owner[iid]]["images"]) >= len(m["images"]):
                    continue
            owner[iid] = k
    for k, m in models.items():
        m["images"] = {i: im for i, im in m["images"].items() if owner.get(i) == k}
        m["step"] = step_scale(m, meta)
        m["segments"] = sorted({meta[im["name"]]["segment"] for im in m["images"].values()})
    print("models:", {k: (len(m["images"]), m["segments"], round(m["step"], 4)) for k, m in models.items()}, flush=True)

    con = sqlite3.connect(f"file:{a.database}?mode=ro", uri=True)
    corr = defaultdict(lambda: ([], [], []))  # (kx, ky) -> (A pts, B pts, pair ids)
    for pid, rows, data in con.execute("select pair_id, rows, data from two_view_geometries where rows >= ?",
                                       (a.min_pair_inliers,)):
        j = pid % M
        i = (pid - j) // M
        if i not in owner or j not in owner or owner[i] == owner[j]:
            continue
        mi, mj = models[owner[i]], models[owner[j]]
        mt = np.frombuffer(data, dtype="<u4").reshape(-1, 2)
        pi, pj = mi["images"][i]["pts"]["id"], mj["images"][j]["pts"]["id"]
        sel = (pi[mt[:, 0]] >= 0) & (pj[mt[:, 1]] >= 0)
        if not sel.any():
            continue
        ka, kb = owner[i], owner[j]
        A = np.array([mi["points"][int(p)]["xyz"] for p in pi[mt[sel, 0]]])
        B = np.array([mj["points"][int(p)]["xyz"] for p in pj[mt[sel, 1]]])
        if ka > kb:
            ka, kb, A, B = kb, ka, B, A
        c = corr[(ka, kb)]
        c[0].append(A)
        c[1].append(B)
        c[2].append(np.full(len(A), pid, np.int64))
    edges = []
    for (ka, kb), (As, Bs, Ps) in corr.items():
        A, B, P = np.vstack(As), np.vstack(Bs), np.concatenate(Ps)
        if len(A) < 10:
            continue
        if len(A) > 20000:
            sub = rng.choice(len(A), 20000, replace=False)
            A, B, P = A[sub], B[sub], P[sub]
        thr = a.thr * models[kb]["step"]
        r = ransac_sim3(A, B, thr, 3000, rng)
        if r is None:
            continue
        s, R, t, inl = r
        n_in, n_pairs = int(inl.sum()), len(set(P[inl].tolist()))
        # the free camera flies at a near-constant speed, so the ratio of the two models' step lengths predicts
        # the scale between them; a fit far from it is degenerate (points bunched on one facade or far away)
        expect = models[kb]["step"] / max(models[ka]["step"], 1e-9)
        dev = abs(np.log(s / expect))
        strong = n_in >= a.min_corr and n_pairs >= a.min_pairs and n_in >= a.min_ratio * len(A) and dev <= np.log(a.scale_band)
        # a weaker edge is still trusted when its scale matches the speed prediction closely (independent evidence)
        weak = n_in >= a.min_corr_tight and n_pairs >= a.min_pairs and n_in >= 0.4 * len(A) and dev <= np.log(a.scale_tight)
        ok = strong or weak
        # view pairs that agree with this edge's similarity: most of their correspondences are inliers
        good_pairs = []
        for pid in set(P.tolist()):
            m = P == pid
            if int((inl & m).sum()) >= 5 and (inl & m).sum() >= 0.5 * m.sum():
                good_pairs.append(int(pid))
        trusted = bool(ok and n_in >= a.min_corr and n_pairs >= 5 and dev <= np.log(a.scale_trust))
        edges.append({"a": ka, "b": kb, "corr": len(A), "inliers": n_in, "pairs": n_pairs, "ratio": round(n_in / len(A), 3),
                      "scale": s, "expected_scale": expect, "R": R, "t": t, "accepted": bool(ok), "trusted": trusted,
                      "good_pairs": good_pairs})
        print(f"edge {ka}->{kb} {models[ka]['segments']}->{models[kb]['segments']}: {len(A)} corr, {n_in} inliers "
              f"({n_in / len(A):.2f}) from {n_pairs} pairs, scale {s:.3f} (speed says {expect:.3f}) "
              f"{'OK' if ok else 'rejected'}", flush=True)

    # maximum spanning tree from the largest model
    root = max(models, key=lambda k: len(models[k]["images"]))
    T = {root: (1.0, np.eye(3), np.zeros(3))}  # model -> sim3 into root frame
    acc = sorted([e for e in edges if e["accepted"]], key=lambda e: -e["inliers"])
    tree = []
    while True:  # Prim: always take the strongest accepted edge that reaches a model not yet joined
        cand = [e for e in acc if (e["a"] in T) != (e["b"] in T)]
        if not cand:
            break
        e = max(cand, key=lambda e: e["inliers"])
        if e["a"] in T:
            # X_b = s R X_a + t  ->  X_a = R^T (X_b - t) / s ; root <- a <- b
            sa, Ra, ta = T[e["a"]]
            s2, R2, t2 = 1.0 / e["scale"], e["R"].T, -e["R"].T @ e["t"] / e["scale"]
            T[e["b"]] = (sa * s2, Ra @ R2, sa * Ra @ t2 + ta)
            tree.append((e["a"], e["b"], e["inliers"]))
        else:
            sb, Rb, tb = T[e["b"]]
            T[e["a"]] = (sb * e["scale"], Rb @ e["R"], sb * Rb @ e["t"] + tb)
            tree.append((e["b"], e["a"], e["inliers"]))
    print("tree:", tree, flush=True)
    if a.pairs_out:
        keep = sorted({p for e in edges if e["trusted"] for p in e["good_pairs"]})
        a.pairs_out.write_text("".join(f"{p}\n" for p in keep))
        print(f"trusted edges {sum(e['trusted'] for e in edges)}, agreeing view pairs {len(keep)}", flush=True)
    left = [k for k in models if k not in T]
    in_tree = {(x, y) for x, y, _ in tree} | {(y, x) for x, y, _ in tree}
    loops = []
    for e in acc:
        if e["a"] in T and e["b"] in T and (e["a"], e["b"]) not in in_tree:
            # predicted b-frame position of model a's camera centres via the tree vs via this edge
            sa, Ra, ta = T[e["a"]]
            sb, Rb, tb = T[e["b"]]
            C = np.array(list(centers(models[e["a"]]).values()))
            via_tree = (sa * (Ra @ C.T)).T + ta
            via_edge = (sb * (Rb @ ((e["scale"] * (e["R"] @ C.T)).T + e["t"]).T)).T + tb
            err = float(np.median(np.linalg.norm(via_tree - via_edge, axis=1)) / (sa * models[e["a"]]["step"]))
            loops.append((e["a"], e["b"], round(err, 2)))
    print("loop check (non-tree edges, median camera disagreement in half-second steps):", loops, flush=True)
    print("joined:", sorted(T), "left out:", [(k, len(models[k]["images"]), models[k]["segments"]) for k in left], flush=True)

    # write the merged model
    out = a.out
    out.mkdir(parents=True, exist_ok=True)
    rootcam = models[root]["cams"]
    cid0 = next(iter(rootcam))
    model_id, w, h, params = rootcam[cid0]
    with open(out / "cameras.bin", "wb") as f:
        f.write(struct.pack("<Q", 1))
        f.write(struct.pack("<iiQQ", cid0, model_id, w, h))
        f.write(struct.pack(f"<{len(params)}d", *params))
    pid_map = {}
    next_pid = 1
    pts_out = []
    for k in T:
        for pid in models[k]["points"]:
            pid_map[(k, pid)] = next_pid
            next_pid += 1
    n_img = sum(len(models[k]["images"]) for k in T)
    with open(out / "images.bin", "wb") as f:
        f.write(struct.pack("<Q", n_img))
        for k in T:
            s, Rs, ts = T[k]
            for iid, im in sorted(models[k]["images"].items()):
                Rc = qvec2rot(im["q"])
                Rn = Rc @ Rs.T
                tn = s * im["t"] - Rn @ ts
                f.write(struct.pack("<I", iid))
                f.write(struct.pack("<4d", *rot2qvec(Rn)))
                f.write(struct.pack("<3d", *tn))
                f.write(struct.pack("<I", cid0))
                f.write(im["name"].encode() + b"\x00")
                ids = im["pts"]["id"].copy()
                m = ids >= 0
                ids[m] = [pid_map[(k, int(p))] for p in ids[m]]
                arr = im["pts"].copy()
                arr["id"] = ids
                f.write(struct.pack("<Q", len(arr)))
                f.write(arr.tobytes())
    n_pts = 0
    with open(out / "points3D.bin", "wb") as f:
        f.write(struct.pack("<Q", 0))
        for k in T:
            s, Rs, ts = T[k]
            for pid, p in models[k]["points"].items():
                tr = p["track"]
                keep = np.array([owner.get(int(i)) == k for i in tr[:, 0]], bool)
                if keep.sum() < 2:
                    continue
                X = s * Rs @ p["xyz"] + ts
                f.write(struct.pack("<Q3d3BdQ", pid_map[(k, pid)], *X, *p["rgb"], p["err"], int(keep.sum())))
                f.write(tr[keep].astype("<u4").tobytes())
                n_pts += 1
        f.seek(0)
        f.write(struct.pack("<Q", n_pts))
    # images.bin may still reference points dropped above (tracks reduced below 2): COLMAP tolerates missing ids
    # poorly, so rewrite those references as -1
    kept_ids = set()
    with open(out / "points3D.bin", "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            pid, *_r, L = struct.unpack("<Q3d3BdQ", f.read(51))
            f.seek(8 * L, 1)
            kept_ids.add(pid)
    buf = bytearray((out / "images.bin").read_bytes())
    off = 8
    for _ in range(n_img):
        off += 4 + 32 + 24 + 4
        e = buf.index(b"\x00", off)
        off = e + 1
        n = struct.unpack_from("<Q", buf, off)[0]
        off += 8
        arr = np.frombuffer(bytes(buf[off: off + 24 * n]), dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("id", "<i8")])).copy()
        bad = (arr["id"] >= 0) & ~np.isin(arr["id"], np.fromiter(kept_ids, np.int64))
        if bad.any():
            arr["id"][bad] = -1
            buf[off: off + 24 * n] = arr.tobytes()
        off += 24 * n
    (out / "images.bin").write_bytes(bytes(buf))
    print(f"wrote {n_img} images, {n_pts} points to {out}", flush=True)
    if a.report:
        rep = {"root": root, "models": {k: {"images": len(m["images"]), "segments": m["segments"], "step": m["step"]}
                                        for k, m in models.items()},
               "edges": [{k: (v if not isinstance(v, np.ndarray) else v.tolist()) for k, v in e.items()} for e in edges],
               "tree": tree, "loops": loops, "joined": sorted(T), "left_out": left, "images": n_img, "points": n_pts}
        a.report.write_text(json.dumps(rep, indent=1, default=float))
    return 0


if __name__ == "__main__":
    sys.exit(main())
