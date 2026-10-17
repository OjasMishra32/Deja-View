"""Decode a tw-pack-v1 video back and check it against its VideoLayer; optionally dump evidence.

  .venv/bin/python tests/pipeline/verify_pack.py <scene_or_out_dir> [--evidence DIR] [--frames 4]

Checks: container/stream layout (size = width x 1.5 height, H.264 yuv420p, fps, duration,
audio presence matches hasAudio), band layout (depth/mask bands are gray), decoded depth range
inside [near, far], mask coverage, and that the background depth matches the plate.
Evidence: per sampled frame an RGB / depth (turbo) / mask / overlay sheet, plus the plate.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from common.media import iter_frames, save_jpg  # noqa: E402
from tw.pack import decode_inverse_depth, unpack_frame  # noqa: E402


def stream_info(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def turbo(gray01: np.ndarray) -> np.ndarray:
    import cv2

    g = np.clip(gray01 * 255, 0, 255).astype(np.uint8)
    return cv2.cvtColor(cv2.applyColorMap(g, cv2.COLORMAP_TURBO), cv2.COLOR_BGR2RGB)


def verify(scene_dir: Path, evidence: Path | None = None, n_frames: int = 4) -> dict:
    import cv2

    meta = json.loads((scene_dir / "scene.json").read_text())
    v = meta["video"]
    W, H = v["width"], v["height"]
    mp4 = scene_dir / v["file"]
    report: dict = {"file": str(mp4), "checks": {}}
    chk = report["checks"]

    si = stream_info(mp4)
    vs = [s for s in si["streams"] if s["codec_type"] == "video"][0]
    aus = [s for s in si["streams"] if s["codec_type"] == "audio"]
    chk["codec_h264"] = vs["codec_name"] == "h264"
    chk["pix_fmt_yuv420p"] = vs.get("pix_fmt") == "yuv420p"
    chk["packed_size"] = (vs["width"], vs["height"]) == (W, H * 3 // 2)
    chk["audio_matches"] = bool(aus) == bool(v["hasAudio"])
    if aus:
        report["audio"] = {"codec": aus[0]["codec_name"], "channels": aus[0].get("channels"), "rate": aus[0].get("sample_rate")}
    rate = eval(vs["avg_frame_rate"]) if "/" in vs["avg_frame_rate"] else float(vs["avg_frame_rate"])  # noqa: S307
    chk["fps"] = abs(rate - v["fps"]) < 0.01
    dur = float(si["format"]["duration"])
    chk["duration"] = abs(dur - v["duration"]) < 0.2
    # faststart: the moov atom precedes mdat
    head = mp4.read_bytes()[:1 << 20]
    chk["faststart"] = head.find(b"moov") != -1 and (head.find(b"mdat") == -1 or head.find(b"moov") < head.find(b"mdat"))
    report["stream"] = {"size": [vs["width"], vs["height"]], "fps": rate, "duration": dur, "bytes": mp4.stat().st_size}

    near, far = v["depth"]["near"], v["depth"]["far"]
    nb = int(vs.get("nb_frames") or round(dur * rate))
    picks = sorted(set(int(round(x)) for x in np.linspace(0, nb - 1, n_frames)))
    plate = None
    if v.get("plate") and (scene_dir / v["plate"]).exists():
        from common.media import load_image

        plate = load_image(scene_dir / v["plate"])
    chroma, cover, dmins, dmaxs = [], [], [], []
    sheets = []
    for i, fr in enumerate(iter_frames(mp4, (W, H * 3 // 2))):
        band = fr[H:].astype(np.int16)
        chroma.append(float(np.abs(band - band.mean(axis=2, keepdims=True)).max(axis=2).mean()))
        rgb, dg, mg = unpack_frame(fr, W, H)
        d = decode_inverse_depth(dg, near, far)
        m = mg / 255.0
        cover.append(float((m > 0.5).mean()))
        dmins.append(float(d.min()))
        dmaxs.append(float(d.max()))
        if i in picks:
            dn = (dg / 255.0)
            mrgb = np.repeat((m * 255).astype(np.uint8)[..., None], 3, 2)
            small = cv2.resize(rgb, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
            over = small.astype(np.float32)
            over = (over * (0.35 + 0.65 * m[..., None]) + np.array([255, 60, 140]) * 0.0).astype(np.uint8)
            top = np.concatenate([small, turbo(dn)], 1)
            bot = np.concatenate([mrgb, over], 1)
            sheets.append((i, np.concatenate([top, bot], 0)))
    report["frames"] = len(cover)
    chk["frame_count"] = abs(len(cover) - nb) <= 1
    chk["bands_gray"] = float(np.max(chroma)) < 3.0
    report["bandChromaMean"] = float(np.mean(chroma))
    report["mask"] = {"coverageMean": float(np.mean(cover)), "coverageMin": float(np.min(cover)), "coverageMax": float(np.max(cover))}
    report["depthDecoded"] = {"min": float(np.min(dmins)), "max": float(np.max(dmaxs)), "near": near, "far": far}
    chk["depth_in_range"] = np.min(dmins) >= near * 0.999 and np.max(dmaxs) <= far * 1.001
    chk["mask_nonempty"] = float(np.mean(cover)) > 0.002
    if evidence is not None:
        evidence.mkdir(parents=True, exist_ok=True)
        for i, sheet in sheets:
            save_jpg(evidence / f"frame{i:05d}-rgb-depth-mask-overlay.jpg", sheet, quality=90)
        if plate is not None:
            save_jpg(evidence / "plate.jpg", plate, quality=90)
        report["evidence"] = str(evidence)
    report["ok"] = all(bool(x) for x in chk.values())
    return report


def lift_frame(scene_dir: Path, index: int, out_ply: Path, min_mask: float = 0.5) -> int:
    """Reference decode of one packed frame into viewer-frame splats (foreground only).

    For pixel centre (u, v) with decoded z-depth d: camera point ((u - cx)/fx * d, -(v - cy)/fy * d, -d)
    (OpenGL camera), then cameraPose (rotation, then translation) maps it into the viewer frame.
    The depth/mask bands are half resolution, so their pixel (i, j) covers RGB (2i..2i+1, 2j..2j+1).
    """
    import cv2

    from common.splat_ply import quat_from_matrix, write_splat_ply

    meta = json.loads((scene_dir / "scene.json").read_text())
    v = meta["video"]
    W, H = v["width"], v["height"]
    fr = None
    for i, f in enumerate(iter_frames(scene_dir / v["file"], (W, H * 3 // 2))):
        if i == index:
            fr = np.array(f)
            break
    if fr is None:
        raise SystemExit(f"frame {index} not found")
    rgb, dg, mg = unpack_frame(fr, W, H)
    d = decode_inverse_depth(dg, v["depth"]["near"], v["depth"]["far"])
    m = mg / 255.0
    h2, w2 = d.shape
    K = v["intrinsics"]
    # band pixel (i, j) centre in RGB pixel units = (2j + 1, 2i + 1)
    us = (np.arange(w2) * 2 + 1.0 - K["cx"]) / K["fx"]
    vs = (np.arange(h2) * 2 + 1.0 - K["cy"]) / K["fy"]
    uu, vv = np.meshgrid(us, vs)
    P = np.stack([uu * d, -vv * d, -d], -1)
    keep = m > min_mask
    pts = P[keep]
    q = v["cameraPose"]["quaternion"]
    from common.splat_ply import quat_to_matrix

    R = quat_to_matrix(np.array([q[3], q[0], q[1], q[2]]))
    pts = pts @ R.T + np.array(v["cameraPose"]["position"])
    col = cv2.resize(rgb, (w2, h2), interpolation=cv2.INTER_AREA)[keep].astype(np.float32) / 255.0
    foot = (d[keep] / K["fx"]) * 2.0
    sig = np.stack([foot * 0.7, foot * 0.7, foot * 0.7], -1)
    quat = quat_from_matrix(np.repeat(R[None], len(pts), 0))
    return write_splat_ply(out_ply, pts, col, np.full(len(pts), 0.98, np.float32), sig, quat)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scene_dir")
    ap.add_argument("--evidence")
    ap.add_argument("--frames", type=int, default=4)
    ap.add_argument("--lift", type=int, help="also lift this frame's foreground into a splat PLY")
    ap.add_argument("--lift-out", help="output PLY for --lift")
    args = ap.parse_args(argv)
    if args.lift is not None:
        n = lift_frame(Path(args.scene_dir), args.lift, Path(args.lift_out))
        print(f"lifted {n} foreground splats from frame {args.lift} -> {args.lift_out}", file=sys.stderr)
    rep = verify(Path(args.scene_dir), Path(args.evidence) if args.evidence else None, args.frames)
    print(json.dumps(rep, indent=2, default=lambda o: bool(o) if isinstance(o, np.bool_) else str(o)))
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
