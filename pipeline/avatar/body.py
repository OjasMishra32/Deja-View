"""Step 4: the canonical body asset of one person (rest mesh, UVs, skin weights, skeleton).

Two halves:
  - Anny side (HiPerGator, needs anny + torch): build the body model with exactly the arguments the pose network
    uses, and evaluate its rest shape at a phenotype vector. `python -m pipeline.avatar.body export --out X.npz`
    writes the static topology (quads, UVs, weights, bones, the UV body-part map) plus the rest shape at the
    default phenotype, for the Mac tests.
  - numpy side (anywhere): triangulate, split vertices at UV seams (one vertex per unique (vertex, uv) pair),
    keep the 4 strongest skin weights, label faces by body part, drop the eye/mouth cavities and the tongue,
    and plain linear blend skinning to check against the network's own vertices.

LBS here is v' = sum_k w_k * (G_k @ inv(R_k)) @ v, with G the posed bone poses and R the rest bone poses; a glTF
skin whose inverseBindMatrices are inv(R) and whose joint world matrices are G reproduces it exactly.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline.avatar.util import log, rigid_inv

# The body model arguments the pose network's decoder uses (keep identical, or vertices drift).
ANNY_ARGS = dict(local_changes=True, pose_parameterization="root_relative", remove_unattached_vertices=False,
                 all_phenotypes=False)

# Body-part colours of the UV segmentation image shipped with anny (data/segmentation/body_parts_segmentation.*).
PART_NAMES = ["body", "head", "hand.R", "hand.L", "eye_back.L", "eye_front.L", "eye_back.R", "eye_front.R",
              "eye_cavity.R", "eye_cavity.L", "mouth_cavity", "foot.L", "foot.R", "tongue"]
PART_COLOURS = np.array([[0, 0, 0], [90, 86, 255], [255, 29, 35], [7, 255, 0], [255, 101, 0], [16, 231, 186],
                         [24, 170, 109], [16, 115, 231], [253, 249, 16], [249, 108, 136], [112, 172, 255],
                         [254, 251, 251], [255, 0, 245], [206, 153, 167]], np.float64)
DROP_PARTS = ("eye_back.L", "eye_back.R", "eye_cavity.L", "eye_cavity.R", "mouth_cavity", "tongue")


# ------------------------------------------------------------------------------------------------ Anny side


def build_anny():
    """The full-resolution body model the decoder uses (float32, plain LBS). HiPerGator only."""
    from pipeline.avatar import paths  # noqa: F401  (cache locations first)
    import warnings

    import anny
    import torch

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        m = anny.create_fullbody_model(**ANNY_ARGS).to(dtype=torch.float32)
    m.set_skinning_method("lbs")
    return m.eval()


def anny_static(m) -> dict:
    """Topology, UVs, skin weights and the skeleton, as numpy."""
    import torch

    def np_(x):
        return x.detach().cpu().numpy() if isinstance(x, torch.Tensor) else np.asarray(x)

    seg_png = Path(__import__("anny").__file__).parent / "data" / "segmentation" / "body_parts_segmentation.png"
    out = {
        "faces": np_(m.faces).astype(np.int64),
        "uv": np_(m.texture_coordinates).astype(np.float64),
        "face_uv": np_(m.face_texture_coordinate_indices).astype(np.int64),
        "weights": np_(m.vertex_bone_weights).astype(np.float64),
        "indices": np_(m.vertex_bone_indices).astype(np.int64),
        "bone_parents": np.asarray(m.bone_parents, np.int64),
        "bone_labels": np.asarray(list(m.bone_labels)),
        "phenotype_labels": np.asarray(list(m.phenotype_labels)),
        "local_change_labels": np.asarray(list(m.local_change_labels)),
    }
    if seg_png.exists():
        import cv2

        out["part_map"] = cv2.imread(str(seg_png), cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    return out


def anny_rest(m, phenotypes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Rest vertices (P,V,3) and rest bone poses (P,J,4,4) at phenotype rows (P, n_labels), float64."""
    import torch

    ph = torch.as_tensor(np.atleast_2d(phenotypes), dtype=torch.float32)
    P = ph.shape[0]
    kw = {k: ph[:, i] for i, k in enumerate(m.phenotype_labels)}
    lc = {k: torch.zeros(P) for k in m.local_change_labels}
    J = len(m.bone_labels)
    eye = torch.eye(4).expand(P, J, 4, 4).clone()
    with torch.inference_mode():
        out = m(pose_parameters=eye, phenotype_kwargs=kw, local_changes_kwargs=lc)
    rv = out["rest_vertices"].detach().cpu().double().numpy()
    if rv.shape[0] != P:
        rv = np.broadcast_to(rv, (P,) + rv.shape[1:]).copy()
    return rv, out["rest_bone_poses"].detach().cpu().double().numpy()


def anny_posed(m, phenotypes: np.ndarray, bone_poses: np.ndarray) -> np.ndarray:
    """The model's own skinning of rest vertices at `phenotypes` with world bone poses G (P,J,4,4)."""
    import torch

    rv, rb = anny_rest(m, phenotypes)
    G = torch.as_tensor(bone_poses, dtype=torch.float32)
    Tr = G @ torch.as_tensor(rigid_inv(rb), dtype=torch.float32)
    with torch.inference_mode():
        v = m.get_skinned_vertices(torch.as_tensor(rv, dtype=torch.float32), Tr)
    return v.detach().cpu().double().numpy()


# ------------------------------------------------------------------------------------------------ numpy side


def lbs(rest_v: np.ndarray, weights: np.ndarray, indices: np.ndarray, bone_poses: np.ndarray,
        rest_bone_poses: np.ndarray) -> np.ndarray:
    """Linear blend skinning. rest_v (V,3); weights/indices (V,K); bone poses (J,4,4) -> (V,3)."""
    A = np.asarray(bone_poses, np.float64) @ rigid_inv(rest_bone_poses)  # (J,4,4)
    M = np.einsum("vk,vkij->vij", weights, A[indices])  # (V,4,4)
    return np.einsum("vij,vj->vi", M[:, :3, :3], rest_v) + M[:, :3, 3]


def triangulate(faces: np.ndarray, face_uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Quads (or mixed quads/triangles, a repeated or negative 4th index marks a triangle) -> triangles,
    splitting every quad (a,b,c,d) into (a,b,c), (a,c,d) for positions and UVs alike."""
    faces = np.asarray(faces)
    face_uv = np.asarray(face_uv)
    if faces.shape[1] == 3:
        return faces.copy(), face_uv.copy()
    is_tri = (faces[:, 3] < 0) | (faces[:, 3] == faces[:, 0]) | (faces[:, 3] == faces[:, 2])
    t1 = faces[:, [0, 1, 2]]
    u1 = face_uv[:, [0, 1, 2]]
    t2 = faces[~is_tri][:, [0, 2, 3]]
    u2 = face_uv[~is_tri][:, [0, 2, 3]]
    src = np.concatenate([np.arange(len(faces)), np.nonzero(~is_tri)[0]])
    order = np.argsort(src, kind="stable")
    return np.concatenate([t1, t2])[order], np.concatenate([u1, u2])[order]


def split_seams(tris: np.ndarray, tri_uv: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One output vertex per unique (position index, uv index) pair.
    Returns (src_vertex (N,), src_uv (N,), new triangles (T,3))."""
    pairs = np.stack([tris.reshape(-1), tri_uv.reshape(-1)], axis=1)
    uniq, inv = np.unique(pairs, axis=0, return_inverse=True)
    return uniq[:, 0], uniq[:, 1], inv.reshape(-1, 3)


def top_k(weights: np.ndarray, indices: np.ndarray, k: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Keep the k largest influences per vertex, renormalised; pads with weight 0 on bone 0."""
    w = np.asarray(weights, np.float64)
    idx = np.asarray(indices, np.int64)
    if w.shape[1] < k:
        pad = k - w.shape[1]
        w = np.concatenate([w, np.zeros((len(w), pad))], 1)
        idx = np.concatenate([idx, np.zeros((len(idx), pad), np.int64)], 1)
    order = np.argsort(-w, axis=1)[:, :k]
    wk = np.take_along_axis(w, order, 1)
    ik = np.take_along_axis(idx, order, 1)
    s = wk.sum(1, keepdims=True)
    wk = np.where(s > 0, wk / np.maximum(s, 1e-12), np.eye(1, k).repeat(len(w), 0))
    ik[wk == 0] = 0
    return wk, ik


def vertex_normals(V: np.ndarray, tris: np.ndarray) -> np.ndarray:
    fn = np.cross(V[tris[:, 1]] - V[tris[:, 0]], V[tris[:, 2]] - V[tris[:, 0]])  # area weighted
    n = np.zeros_like(V)
    for j in range(3):
        np.add.at(n, tris[:, j], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def uv_to_pixel(uv: np.ndarray, size: int, flip_v: bool = True) -> np.ndarray:
    """UV (0..1, v up when flip_v) -> continuous pixel coordinates of a size x size image (row 0 at the top)."""
    x = uv[..., 0] * size - 0.5
    y = ((1.0 - uv[..., 1]) if flip_v else uv[..., 1]) * size - 0.5
    return np.stack([x, y], axis=-1)


def face_parts(part_map: np.ndarray, uv: np.ndarray, tri_uv: np.ndarray, flip_v: bool = True) -> np.ndarray:
    """Body-part index (into PART_NAMES) per triangle: the part colour at the triangle's UV centroid."""
    h, w = part_map.shape[:2]
    c = uv[tri_uv].mean(axis=1)
    px = uv_to_pixel(c, w, flip_v)
    x = np.clip(np.rint(px[:, 0]).astype(int), 0, w - 1)
    y = np.clip(np.rint(px[:, 1] * h / w).astype(int), 0, h - 1)
    col = part_map[y, x].astype(np.float64)
    d = ((col[:, None, :] - PART_COLOURS[None]) ** 2).sum(-1)
    return np.argmin(d, axis=1)


@dataclass
class Asset:
    """The canonical mesh of one person, ready for texturing and glTF export."""

    positions: np.ndarray  # (N,3) rest positions, model space, metres
    normals: np.ndarray  # (N,3)
    uv: np.ndarray  # (N,2) glTF convention: (u, 1 - v_anny) so (0,0) is the image's top-left
    joints: np.ndarray  # (N,4) uint16
    weights: np.ndarray  # (N,4) float32, rows sum to 1
    tris: np.ndarray  # (T,3)
    src_vertex: np.ndarray  # (N,) index into the model's vertices
    tri_part: np.ndarray  # (T,) index into PART_NAMES
    vert_part: np.ndarray  # (N,)
    rest_bone_poses: np.ndarray  # (J,4,4)
    bone_parents: np.ndarray  # (J,)
    bone_labels: np.ndarray  # (J,)

    def save(self, path: Path) -> None:
        np.savez_compressed(path, **{k: getattr(self, k) for k in self.__dataclass_fields__})

    @classmethod
    def load(cls, path: Path) -> "Asset":
        d = np.load(path, allow_pickle=False)
        return cls(**{k: d[k] for k in cls.__dataclass_fields__})


def build_asset(static: dict, rest_v: np.ndarray, rest_bones: np.ndarray, flip_v: bool = True,
                drop_parts: tuple[str, ...] = DROP_PARTS) -> Asset:
    tris, tri_uv = triangulate(static["faces"], static["face_uv"])
    uv = static["uv"]
    if "part_map" in static and static["part_map"] is not None and np.size(static["part_map"]) > 1:
        part = face_parts(static["part_map"], uv, tri_uv, flip_v)
    else:
        part = np.zeros(len(tris), np.int64)
    drop = np.isin(part, [PART_NAMES.index(p) for p in drop_parts])
    tris, tri_uv, part = tris[~drop], tri_uv[~drop], part[~drop]
    vn_full = vertex_normals(rest_v, tris)
    src_v, src_uv, new_tris = split_seams(tris, tri_uv)
    wk, ik = top_k(static["weights"], static["indices"], 4)
    vpart = np.zeros(len(src_v), np.int64)
    for j in range(3):
        vpart[new_tris[:, j]] = part
    uvo = uv[src_uv].copy()
    if flip_v:
        uvo[:, 1] = 1.0 - uvo[:, 1]
    return Asset(
        positions=rest_v[src_v].astype(np.float64),
        normals=vn_full[src_v],
        uv=uvo,
        joints=ik[src_v].astype(np.uint16),
        weights=wk[src_v].astype(np.float32),
        tris=new_tris.astype(np.int64),
        src_vertex=src_v.astype(np.int64),
        tri_part=part.astype(np.int64),
        vert_part=vpart,
        rest_bone_poses=np.asarray(rest_bones, np.float64),
        bone_parents=np.asarray(static["bone_parents"], np.int64),
        bone_labels=np.asarray(static["bone_labels"]),
    )


def lateral_axis(rest_bones: np.ndarray, labels) -> tuple[int, float]:
    """Model-space axis (0,1,2) and sign that point from the body's right to its left (hand.R -> hand.L)."""
    labels = [str(x) for x in labels]
    iL = next(i for i, b in enumerate(labels) if b.lower() in ("hand.l", "wrist.l", "lowerarm01.l"))
    iR = next(i for i, b in enumerate(labels) if b.lower() in ("hand.r", "wrist.r", "lowerarm01.r"))
    d = rest_bones[iL, :3, 3] - rest_bones[iR, :3, 3]
    ax = int(np.argmax(np.abs(d)))
    return ax, float(np.sign(d[ax]))


# ------------------------------------------------------------------------------------------------------- CLI


def export(out: Path, hmr_npz: Path | None = None, frame: int = 0) -> dict:
    """Static topology + rest shape at the default phenotype (+ optionally one network frame) -> npz."""
    m = build_anny()
    st = anny_static(m)
    n_ph = len(st["phenotype_labels"])
    rv, rb = anny_rest(m, np.full((1, n_ph), 0.5))
    data = dict(st)
    data["rest_vertices"] = rv[0]
    data["rest_bone_poses"] = rb[0]
    info = {k: (v.shape if hasattr(v, "shape") else v) for k, v in data.items()}
    if hmr_npz is not None:
        h = np.load(hmr_npz)
        ph = h["shape"][frame, :n_ph].astype(np.float64)
        rv1, rb1 = anny_rest(m, ph[None])
        data.update(frame_shape=ph, frame_rest_vertices=rv1[0], frame_rest_bone_poses=rb1[0],
                    frame_bone_poses=h["bone_poses"][frame].astype(np.float64),
                    frame_net_rest_bone_poses=h["rest_bone_poses"][frame].astype(np.float64),
                    frame_v3d=h["v3d"][frame].astype(np.float64),
                    frame_transl_pelvis=h["transl_pelvis"][frame].astype(np.float64))
        G = data["frame_bone_poses"]
        v_model = anny_posed(m, ph[None], G[None])[0]
        data["frame_anny_posed"] = v_model
    np.savez_compressed(out, **data)
    log("body", f"wrote {out}: {info}")
    return info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="static topology + default rest shape -> npz (HiPerGator)")
    e.add_argument("--out", required=True)
    e.add_argument("--hmr", help="hmr.npz: also store one network frame for the 2 mm LBS test")
    e.add_argument("--frame", type=int, default=0)
    a = ap.parse_args(argv)
    if a.cmd == "export":
        export(Path(a.out), Path(a.hmr) if a.hmr else None, a.frame)
    return 0


if __name__ == "__main__":
    sys.exit(main())
