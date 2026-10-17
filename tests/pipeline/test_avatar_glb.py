"""Avatar step 8 (pipeline/avatar/glb.py): the GLB's skeleton, skin and animation reproduce our LBS exactly.

The GLB is read back as plain JSON + binary (no glTF library), node world matrices are composed from the stored
TRS, and the skinned vertices are compared with body.lbs of the same bone poses. The three.js side of the same
check is tests/harness/avatar-turntable.ts --check.
"""

import os
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

pytest.importorskip("pygltflib")

from pipeline.avatar import body, glb, ground  # noqa: E402
from pipeline.avatar.util import quat_to_mat  # noqa: E402

FIXTURE = Path(os.environ.get("AVATAR_FIXTURE", ROOT / "data" / "tmp" / "avatars" / "fixture" / "anny-fixture.npz"))
needs_fixture = pytest.mark.skipif(not FIXTURE.exists(), reason=f"no body fixture at {FIXTURE}")

COMP = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    import json

    raw = Path(path).read_bytes()
    clen = struct.unpack_from("<I", raw, 12)[0]
    js = json.loads(raw[20:20 + clen])
    off = 20 + clen
    blen = struct.unpack_from("<I", raw, off)[0]
    blob = raw[off + 8: off + 8 + blen]

    def acc(i):
        a = js["accessors"][i]
        v = js["bufferViews"][a["bufferView"]]
        n = NCOMP[a["type"]]
        arr = np.frombuffer(blob, COMP[a["componentType"]], a["count"] * n, v.get("byteOffset", 0) + a.get("byteOffset", 0))
        return arr.reshape(a["count"], n) if n > 1 else arr

    return js, acc


def trs(t, q):
    M = np.eye(4)
    M[:3, :3] = quat_to_mat(np.asarray(q, np.float64))
    M[:3, 3] = t
    return M


@needs_fixture
def test_glb_skin_matches_numpy_lbs(tmp_path):
    fx = dict(np.load(FIXTURE))
    a = body.build_asset(fx, fx["rest_vertices"], fx["rest_bone_poses"])
    par = a.bone_parents
    J = len(par)
    # three frames of the network's own pose (local parameters), placed and turned in the viewer frame
    delta = ground.pose_params(fx["frame_bone_poses"], fx["frame_net_rest_bone_poses"], par)
    rng = np.random.default_rng(0)
    T = 3
    dq = np.stack([np.concatenate([[[0, 0, 0, 1.0]], np.tile(ground.mat_to_quat(delta[1:]), (1, 1))]) for _ in range(T)])
    dq[1, 50] = [0.2, 0.1, 0.0, 0.97]
    dq /= np.linalg.norm(dq, axis=-1, keepdims=True)
    root_q = rng.normal(size=(T, 4))
    root_q /= np.linalg.norm(root_q, axis=1, keepdims=True)
    root_p = rng.normal(size=(T, 3))
    times = np.array([0.0, 0.5, 1.0])
    gltf = glb.build(a, times, dq, root_q, root_p, glb.solid_texture_jpeg())
    path = tmp_path / "a.glb"
    glb.write(gltf, path)
    js, acc = read_glb(path)
    assert js["extensionsUsed"] == ["KHR_materials_unlit"]
    assert js["animations"][0]["name"] == "video"
    pos = acc(js["meshes"][0]["primitives"][0]["attributes"]["POSITION"]).astype(np.float64)
    jnt = acc(js["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"]).astype(np.int64)
    wts = acc(js["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"]).astype(np.float64)
    ibm = acc(js["skins"][0]["inverseBindMatrices"]).reshape(J, 4, 4).transpose(0, 2, 1).astype(np.float64)
    # animated values per node at keyframe k
    anim = js["animations"][0]
    keyed = {}
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        keyed[(ch["target"]["node"], ch["target"]["path"])] = acc(s["output"]).astype(np.float64)
    for k in range(T):
        Wn = np.zeros((J, 4, 4))
        for j in ground.topo_order(par):
            n = js["nodes"][j]
            t = keyed.get((j, "translation"), np.array([n.get("translation", [0, 0, 0])]))
            q = keyed.get((j, "rotation"), np.array([n.get("rotation", [0, 0, 0, 1])]))
            L = trs(t[min(k, len(t) - 1)], q[min(k, len(q) - 1)])
            Wn[j] = L if par[j] < 0 else Wn[par[j]] @ L
        A = Wn @ ibm
        M = np.einsum("vk,vkij->vij", wts, A[jnt])
        V_glb = np.einsum("vij,vj->vi", M[:, :3, :3], pos) + M[:, :3, 3]
        Groot = np.eye(4)
        Groot[:3, :3] = quat_to_mat(root_q[k])
        Groot[:3, 3] = root_p[k]
        G = ground.forward(quat_to_mat(dq[k:k + 1]), a.rest_bone_poses, par, root=Groot[None])[0]
        V_np = body.lbs(a.positions, a.weights.astype(np.float64), a.joints.astype(np.int64), G, a.rest_bone_poses)
        err = np.linalg.norm(V_glb - V_np, axis=1).max()
        assert err < 2e-4, (k, err)
    # static bones are left out of the clip
    rot_nodes = {c["target"]["node"] for c in anim["channels"] if c["target"]["path"] == "rotation"}
    assert 0 in rot_nodes and 50 in rot_nodes and len(rot_nodes) < J
