"""Bake detail maps for an atlas-textured chunk: tangent-space normal, ambient occlusion and roughness.

Roblox shows these through a SurfaceAppearance (ColorMap, NormalMap, RoughnessMap, MetalnessMap). It has no AO slot,
so AO is also offered pre-multiplied into the colour map (`ao_into_colour`). Everything is derived from the mesh and
its baked albedo, so these are heuristics, not measured materials; the eval scores the result against the splats.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from objects.detail.glb import Prim, vertex_normals
from objects.detail.raster import Camera, look_at, render


def uv_raster(p: Prim, size: int) -> tuple[np.ndarray, np.ndarray]:
    """For every texel of a `size`^2 atlas: the face covering it (-1 if none) and its barycentrics."""
    if p.UV is None:
        raise ValueError("chunk has no UVs")
    face = np.full(size * size, -1, np.int64)
    bary = np.zeros((size * size, 3))
    tu, tv = p.UV[p.F, 0] * size, p.UV[p.F, 1] * size
    area = (tu[:, 1] - tu[:, 0]) * (tv[:, 2] - tv[:, 0]) - (tu[:, 2] - tu[:, 0]) * (tv[:, 1] - tv[:, 0])
    x0 = np.clip(np.floor(tu.min(axis=1) - 0.5), 0, size).astype(np.int64)
    x1 = np.clip(np.ceil(tu.max(axis=1) - 0.5), -1, size - 1).astype(np.int64)
    y0 = np.clip(np.floor(tv.min(axis=1) - 0.5), 0, size).astype(np.int64)
    y1 = np.clip(np.ceil(tv.max(axis=1) - 0.5), -1, size - 1).astype(np.int64)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    faces = np.nonzero((bw > 0) & (bh > 0) & (np.abs(area) > 1e-12))[0]
    for chunk in np.array_split(faces, max(1, len(faces) // 4000)):
        cn = (bw * bh)[chunk]
        fi = np.repeat(chunk, cn)
        local = np.arange(cn.sum()) - np.repeat(np.cumsum(cn) - cn, cn)
        px, py = x0[fi] + local % bw[fi], y0[fi] + local // bw[fi]
        sx, sy = px + 0.5, py + 0.5
        U, V, A = tu[fi], tv[fi], area[fi]
        w0 = ((U[:, 1] - sx) * (V[:, 2] - sy) - (U[:, 2] - sx) * (V[:, 1] - sy)) / A
        w1 = ((U[:, 2] - sx) * (V[:, 0] - sy) - (U[:, 0] - sx) * (V[:, 2] - sy)) / A
        w2 = 1 - w0 - w1
        ok = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        pix = py[ok] * size + px[ok]
        face[pix] = fi[ok]
        bary[pix] = np.stack([w0[ok], w1[ok], w2[ok]], axis=1)
    return face.reshape(size, size), bary.reshape(size, size, 3)


def dilate(img: np.ndarray, covered: np.ndarray, steps: int = 4) -> np.ndarray:
    """Push edge texels outwards so mip-mapping does not bleed the empty atlas background into seams."""
    out = img.astype(np.float64).copy()
    have = covered.copy()
    for _ in range(steps):
        acc = np.zeros_like(out)
        cnt = np.zeros(have.shape)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            sh = np.roll(have, (dy, dx), axis=(0, 1))
            acc += np.roll(out, (dy, dx), axis=(0, 1)) * (sh[..., None] if out.ndim == 3 else sh)
            cnt += sh
        grow = ~have & (cnt > 0)
        div = cnt[grow][:, None] if out.ndim == 3 else cnt[grow]
        out[grow] = acc[grow] / div
        have |= grow
    return out


def height_from_albedo(image: np.ndarray, sigma: float = 6.0) -> np.ndarray:
    """High-passed luminance as a stand-in height field: dark grout, seams and handles read as recessed."""
    from objects.detail.metrics import _gauss_filter, gray

    g = gray(image)
    return g - _gauss_filter(g, sigma)


def normal_map(image: np.ndarray, covered: np.ndarray, strength: float = 2.0) -> np.ndarray:
    """Tangent-space normal map (OpenGL / Roblox convention: +X right, +Y up in texture space) as uint8 RGB."""
    h = height_from_albedo(image)
    size = h.shape[0]
    gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5 * size / 64.0
    gy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5 * size / 64.0
    n = np.stack([-gx * strength, gy * strength, np.ones_like(h)], axis=-1)  # image rows go down, texture v goes up
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    n[~covered] = (0.0, 0.0, 1.0)
    return np.round((n * 0.5 + 0.5) * 255).astype(np.uint8)


def sphere_directions(count: int) -> np.ndarray:
    """Fibonacci directions over the whole sphere."""
    i = np.arange(count) + 0.5
    phi = np.arccos(1 - 2 * i / count)
    theta = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(theta) * np.sin(phi), np.cos(phi), np.sin(theta) * np.sin(phi)], axis=1)


def ambient_occlusion(prims: list[Prim], size: int = 1024, directions: int = 48, resolution: int = 512,
                      bias: float = 0.01) -> list[np.ndarray]:
    """Per-chunk AO atlases (float 0..1, 1 = open) from shadow maps along `directions` sphere directions.

    Each direction renders the whole object's depth from a far (near-orthographic) camera; a texel is lit from that
    direction when it faces it and nothing sits in front of it. Cosine-weighted over the hemisphere of its normal."""
    allV = np.concatenate([p.V for p in prims])
    lo, hi = allV.min(axis=0), allV.max(axis=0)
    centre, extent = (lo + hi) / 2, float(np.linalg.norm(hi - lo)) + 1e-6
    dist = extent * 50.0
    f = (resolution / 2.0) / (extent * 0.55 / dist)
    geo = [Prim(p.name, p.V, p.F, p.N) for p in prims]  # depth only
    # A mesh whose winding is flipped as a whole would bake black; orient normals outward from the centroid.
    allN = np.concatenate([p.N if p.N is not None else vertex_normals(p.V, p.F) for p in prims])
    sign = -1.0 if float(((allV - allV.mean(axis=0)) * allN).sum(axis=1).mean()) < 0 else 1.0
    texel = []
    for p in prims:
        face, bary = uv_raster(p, size)
        cov = face >= 0
        tri = p.F[face[cov]]
        b = bary[cov][:, :, None]
        pos = (p.V[tri] * b).sum(axis=1)
        N = sign * (p.N if p.N is not None else vertex_normals(p.V, p.F))
        nrm = (N[tri] * b).sum(axis=1)
        nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
        texel.append((cov, pos, nrm))
    lit = [np.zeros(len(t[1])) for t in texel]
    weight = [np.zeros(len(t[1])) for t in texel]
    for d in sphere_directions(directions):
        cam = Camera(look_at(centre + d * dist, centre), f, f, resolution / 2, resolution / 2, resolution, resolution)
        frame = render(geo, cam)
        R, t = cam.c2w[:3, :3], cam.c2w[:3, 3]
        for k, (cov, pos, nrm) in enumerate(texel):
            cosw = nrm @ d
            facing = cosw > 0
            pc = (pos - t) @ R
            z = -pc[:, 2]
            u = np.floor(cam.cx + f * pc[:, 0] / z).astype(np.int64)
            v = np.floor(cam.cy - f * pc[:, 1] / z).astype(np.int64)
            inb = (u >= 0) & (u < resolution) & (v >= 0) & (v < resolution)
            seen = np.zeros(len(z), bool)
            zz = frame.depth[np.clip(v, 0, resolution - 1), np.clip(u, 0, resolution - 1)]
            seen[inb] = (~frame.mask[v[inb], u[inb]]) | (z[inb] <= zz[inb] + bias * extent)
            w = np.where(facing, cosw, 0.0)
            lit[k] += w * seen
            weight[k] += w
    out = []
    for k, (cov, _, _) in enumerate(texel):
        ao = np.ones((size, size))
        ao[cov] = np.where(weight[k] > 0, lit[k] / np.maximum(weight[k], 1e-12), 1.0)
        out.append(np.clip(dilate(ao, cov), 0, 1))
    return out


def roughness_map(image: np.ndarray, covered: np.ndarray) -> np.ndarray:
    """Heuristic roughness (0 glossy .. 1 matte): bright, unsaturated, smooth areas (enamel, steel, glass) are
    glossier; textured or dark-saturated areas (wood, cloth, plastic) stay matte."""
    from objects.detail.metrics import _gauss_filter, gray

    img = image.astype(np.float64) / (255.0 if image.dtype == np.uint8 else 1.0)
    mx, mn = img.max(axis=-1), img.min(axis=-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    g = gray(img)
    local = np.sqrt(np.maximum(_gauss_filter(g * g, 2.0) - _gauss_filter(g, 2.0) ** 2, 0))
    r = 0.85 - 0.45 * mx * (1 - sat) + 3.0 * local
    r = np.clip(r, 0.25, 1.0)
    r[~covered] = 1.0
    return r


def bake_maps(prims: list[Prim], out_dir: str | Path, size: int | None = None, ao_directions: int = 48,
              normal_strength: float = 2.0, ao_into_colour: float = 0.5) -> dict:
    """Write `<chunk>_normal.png`, `_ao.png`, `_roughness.png` (and `_color.png` with AO pre-multiplied when
    `ao_into_colour` > 0) per chunk plus the `detail-maps.json` sidecar. Returns the sidecar."""
    from PIL import Image

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    textured = [p for p in prims if p.image is not None and p.UV is not None]
    if not textured:
        raise ValueError("no textured chunks to bake maps for")
    size = size or max(p.image.shape[0] for p in textured)
    ao = ambient_occlusion(textured, size=size, directions=ao_directions)
    chunks = []
    for k, p in enumerate(textured):
        img = p.image
        if img.shape[0] != size:
            img = np.asarray(Image.fromarray(img).resize((size, size), Image.BICUBIC))
        face, _ = uv_raster(p, size)
        cov = face >= 0
        stem = f"chunk{k:02d}"
        files = {}

        def save(kind: str, arr: np.ndarray) -> None:
            name = f"{stem}_{kind}.png"
            Image.fromarray(arr).save(out_dir / name, optimize=True)
            files[kind] = {"file": name, "sha1": hashlib.sha1((out_dir / name).read_bytes()).hexdigest()}

        save("normal", normal_map(img, cov, normal_strength))
        save("ao", np.round(ao[k] * 255).astype(np.uint8))
        save("roughness", np.round(roughness_map(img, cov) * 255).astype(np.uint8))
        if ao_into_colour > 0:
            shade = 1.0 - ao_into_colour * (1.0 - ao[k])
            save("color", np.clip(img.astype(np.float64) * shade[..., None], 0, 255).astype(np.uint8))
        chunks.append({"chunk": k, "name": p.name, "size": size, "coverage": round(float(cov.mean()), 4),
                       "aoMean": round(float(ao[k][cov].mean()) if cov.any() else 1.0, 4), "maps": files})
    sidecar = {
        "version": 1,
        "kind": "deja-view-detail-maps",
        "convention": {"normal": "tangent space, OpenGL +Y (Roblox SurfaceAppearance.NormalMap)",
                       "roughness": "0 glossy .. 1 matte (SurfaceAppearance.RoughnessMap)",
                       "ao": "1 open .. 0 occluded; Roblox has no AO slot, so `color` has it pre-multiplied",
                       "metalness": "not baked (0 everywhere)"},
        "aoIntoColour": ao_into_colour,
        "normalStrength": normal_strength,
        "aoDirections": ao_directions,
        "chunks": chunks,
    }
    (out_dir / "detail-maps.json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    return sidecar
