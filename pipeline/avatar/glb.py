"""Step 8: one person -> avatar-<k>.glb (skinned mesh, unlit texture, one animation clip on the video's clock).

Layout of the file:
  - nodes 0..J-1: the skeleton. Node j's rest local transform is inv(R_parent) R_j (R = rest bone poses at the
    person's phenotype); the root's is its first animated pose. Parents come from the body model.
  - node J: the mesh (identity transform, so the skin's bind matrix is the identity), skin over nodes 0..J-1 with
    inverseBindMatrices inv(R_j) (column-major, as glTF stores every matrix).
  - one animation "video": LINEAR rotation channels for every joint that moves plus the root's translation, keyed
    at the media times (seconds on the played video element's clock), positions in the viewer frame (y up,
    metres, floor y = 0). Bones that never move are left out of the clip.
  - material: KHR_materials_unlit with the baseColor JPEG (sRGB), double-sided.

So the skinned position of vertex v at time t is sum_k w_k * Gworld_k(t) @ inv(R_k) @ v, exactly the numpy LBS of
the same bone poses (body.lbs), which the tests check against three.js.
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

import numpy as np

from pipeline.avatar.body import Asset
from pipeline.avatar.util import mat_to_quat, quat_continuous, rigid_inv


def node_locals(asset: Asset, delta_q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame local rotations (T,J,4) and constant local translations (J,3) of the non-root joints."""
    from pipeline.avatar.ground import rest_locals
    from pipeline.avatar.util import quat_to_mat

    rl = rest_locals(asset.rest_bone_poses, asset.bone_parents)
    R = rl[None, :, :3, :3] @ quat_to_mat(delta_q)  # (T,J,3,3)
    return quat_continuous(mat_to_quat(R)), rl[:, :3, 3]


class _Buf:
    def __init__(self):
        self.data = bytearray()
        self.views = []
        self.accessors = []

    def add(self, arr: np.ndarray, gltf_type: str, component: int, target: int | None = None,
            minmax: bool = False, normalized: bool = False) -> int:
        while len(self.data) % 4:
            self.data.append(0)
        b = np.ascontiguousarray(arr).tobytes()
        view = {"buffer": 0, "byteOffset": len(self.data), "byteLength": len(b)}
        if target is not None:
            view["target"] = target
        self.data.extend(b)
        self.views.append(view)
        acc = {"bufferView": len(self.views) - 1, "componentType": component, "count": int(arr.shape[0]),
               "type": gltf_type}
        if normalized:
            acc["normalized"] = True
        if minmax:
            a2 = arr.reshape(arr.shape[0], -1)
            acc["min"] = [float(x) for x in a2.min(0)]
            acc["max"] = [float(x) for x in a2.max(0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_image(self, jpeg: bytes) -> int:
        while len(self.data) % 4:
            self.data.append(0)
        self.views.append({"buffer": 0, "byteOffset": len(self.data), "byteLength": len(jpeg)})
        self.data.extend(jpeg)
        return len(self.views) - 1


FLOAT, USHORT, UINT = 5126, 5123, 5125
ARRAY, ELEMENT = 34962, 34963


def build(asset: Asset, times: np.ndarray, delta_q: np.ndarray, root_q: np.ndarray, root_p: np.ndarray,
          texture_jpeg: bytes, name: str = "person", static_deg: float = 0.05, extras: dict | None = None):
    """Returns a pygltflib.GLTF2 for one person."""
    import pygltflib as g

    J = len(asset.bone_parents)
    times = np.asarray(times, np.float64)
    order = np.argsort(times)
    times, delta_q, root_q, root_p = times[order], delta_q[order], root_q[order], root_p[order]
    keep = np.concatenate([[True], np.diff(times) > 1e-5])
    times, delta_q, root_q, root_p = times[keep], delta_q[keep], root_q[keep], root_p[keep]
    lq, lt = node_locals(asset, delta_q)
    lq[:, 0] = quat_continuous(root_q[:, None])[:, 0]
    buf = _Buf()

    # mesh
    pos = asset.positions.astype(np.float32)
    a_pos = buf.add(pos, "VEC3", FLOAT, ARRAY, minmax=True)
    a_nrm = buf.add(asset.normals.astype(np.float32), "VEC3", FLOAT, ARRAY)
    a_uv = buf.add(asset.uv.astype(np.float32), "VEC2", FLOAT, ARRAY)
    a_j = buf.add(asset.joints.astype(np.uint16), "VEC4", USHORT, ARRAY)
    w = asset.weights.astype(np.float32)
    w = w / w.sum(1, keepdims=True)
    a_w = buf.add(w, "VEC4", FLOAT, ARRAY)
    idx = asset.tris.reshape(-1)
    a_idx = buf.add(idx.astype(np.uint16 if len(pos) < 65536 else np.uint32), "SCALAR",
                    USHORT if len(pos) < 65536 else UINT, ELEMENT)
    ibm = rigid_inv(asset.rest_bone_poses).astype(np.float32).transpose(0, 2, 1).reshape(J, 16)  # column-major
    a_ibm = buf.add(ibm, "MAT4", FLOAT)
    img_view = buf.add_image(texture_jpeg)

    # skeleton nodes: rest locals; root at its first animated pose
    children: dict[int, list[int]] = {}
    for j, p in enumerate(asset.bone_parents):
        if p >= 0:
            children.setdefault(int(p), []).append(j)
    nodes = []
    for j in range(J):
        n = g.Node(name=str(asset.bone_labels[j]), rotation=[float(x) for x in lq[0, j]],
                   translation=[float(x) for x in (root_p[0] if j == 0 else lt[j])])
        if j in children:
            n.children = children[j]
        nodes.append(n)
    mesh_node = J
    nodes.append(g.Node(name=f"{name}-mesh", mesh=0, skin=0))

    # animation: root translation + rotation, and every joint whose local rotation moves
    a_t = buf.add(times.astype(np.float32)[:, None], "SCALAR", FLOAT, minmax=True)
    buf.accessors[a_t]["min"] = [float(times[0])]
    buf.accessors[a_t]["max"] = [float(times[-1])]
    samplers, channels = [], []

    def channel(node: int, path: str, values: np.ndarray, typ: str):
        a_v = buf.add(values.astype(np.float32), typ, FLOAT)
        samplers.append(g.AnimationSampler(input=a_t, output=a_v, interpolation="LINEAR"))
        channels.append(g.AnimationChannel(sampler=len(samplers) - 1, target=g.AnimationChannelTarget(node=node, path=path)))

    channel(0, "translation", root_p, "VEC3")
    animated = [0]
    for j in range(J):
        d = np.abs(np.sum(lq[:, j] * lq[0:1, j], axis=-1)).clip(0, 1)
        if j == 0 or np.degrees(2 * np.arccos(d)).max() > static_deg:
            channel(j, "rotation", lq[:, j], "VEC4")
            if j:
                animated.append(j)

    gltf = g.GLTF2(
        asset=g.Asset(version="2.0", generator="deja-view pipeline/avatar"),
        scene=0,
        scenes=[g.Scene(nodes=[0, mesh_node])],
        nodes=nodes,
        meshes=[g.Mesh(name=name, primitives=[g.Primitive(
            attributes=g.Attributes(POSITION=a_pos, NORMAL=a_nrm, TEXCOORD_0=a_uv, JOINTS_0=a_j, WEIGHTS_0=a_w),
            indices=a_idx, material=0)])],
        skins=[g.Skin(name=f"{name}-skin", joints=list(range(J)), inverseBindMatrices=a_ibm, skeleton=0)],
        materials=[g.Material(name=f"{name}-unlit", doubleSided=True,
                              pbrMetallicRoughness=g.PbrMetallicRoughness(baseColorTexture=g.TextureInfo(index=0),
                                                                          metallicFactor=0.0, roughnessFactor=1.0),
                              extensions={"KHR_materials_unlit": {}})],
        textures=[g.Texture(sampler=0, source=0)],
        samplers=[g.Sampler(magFilter=9729, minFilter=9987, wrapS=33071, wrapT=33071)],
        images=[g.Image(bufferView=img_view, mimeType="image/jpeg")],
        animations=[g.Animation(name="video", samplers=samplers, channels=channels)],
        extensionsUsed=["KHR_materials_unlit"],
        buffers=[g.Buffer(byteLength=0)],
    )
    gltf.extras = dict(extras or {}, animatedJoints=len(animated), joints=J)
    for v in buf.views:
        gltf.bufferViews.append(g.BufferView(**v))
    for a in buf.accessors:
        gltf.accessors.append(g.Accessor(**a))
    data = bytes(buf.data)
    gltf.buffers[0].byteLength = len(data)
    gltf.set_binary_blob(data)
    return gltf


def write(gltf, path: Path) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    gltf.save_binary(str(path))
    return path.stat().st_size


def solid_texture_jpeg(colour=(180, 180, 180), size: int = 8) -> bytes:
    from PIL import Image

    im = Image.new("RGB", (size, size), tuple(int(c) for c in colour))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=90)
    return b.getvalue()


def read_glb_json(path: Path) -> dict:
    """The JSON chunk of a .glb (for tests and reports, no dependency)."""
    import json

    raw = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<4sII", raw, 0)
    assert magic == b"glTF" and version == 2
    clen, ctype = struct.unpack_from("<I4s", raw, 12)
    assert ctype == b"JSON"
    return json.loads(raw[20:20 + clen])


def check_points(asset: Asset, times: np.ndarray, delta_q: np.ndarray, root_q: np.ndarray, root_p: np.ndarray,
                 keys: tuple[int, ...] = (0,), n: int = 50, seed: int = 0) -> list[dict]:
    """World positions (numpy LBS) of n random vertices at a few keyframes, for the three.js check."""
    from pipeline.avatar.body import lbs
    from pipeline.avatar.ground import forward
    from pipeline.avatar.util import quat_to_mat

    rng = np.random.default_rng(seed)
    ids = np.sort(rng.choice(len(asset.positions), size=n, replace=False))
    out = []
    for k in keys:
        Groot = np.eye(4)
        Groot[:3, :3] = quat_to_mat(root_q[k])
        Groot[:3, 3] = root_p[k]
        G = forward(quat_to_mat(delta_q[k:k + 1]), asset.rest_bone_poses, asset.bone_parents, root=Groot[None])[0]
        V = lbs(asset.positions[ids], asset.weights[ids].astype(np.float64), asset.joints[ids].astype(np.int64), G,
                asset.rest_bone_poses)
        out.append({"key": int(k), "time": float(np.float32(times[k])), "vertices": ids.tolist(),
                    "positions": np.round(V, 6).tolist()})
    return out
