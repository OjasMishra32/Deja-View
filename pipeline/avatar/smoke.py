"""GPU smoke test for the avatar env: Multi-HMR 2 on a few frames of a clip.

    python -m pipeline.avatar.smoke --video IMG_7373.mov --times 2.0,8.0 --out OUT [--hfov-deg 64]

For each frame: the network's own camera (predicted K) and the path hmr.py uses, our K passed to the decoder
(here a pinhole from --hfov-deg until the reconstruction's intrinsics exist). Prints people found, output
shapes, confidences and pelvis depths; writes OUT/smoke.json and OUT/frame-<t>.jpg (2D joints drawn).
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

from pipeline.avatar import paths  # cache locations before anny / torch.hub


def read_frame(video: str, t: float, tmp: Path):
    import cv2

    png = tmp / f"_src-{t:07.3f}.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1", str(png)],
                   check=True)
    bgr = cv2.imread(str(png), cv2.IMREAD_COLOR)
    png.unlink(missing_ok=True)
    if bgr is None:
        raise SystemExit(f"could not decode {video} at {t}s")
    return bgr[:, :, ::-1].copy()


def letterbox_geometry(h: int, w: int, hp: int, wp: int, long_side: int = 768):
    """Scale and centre-pad offsets that map original pixels into the network input (hp x wp)."""
    if w >= h:
        wr, hr = long_side, int(long_side * h / w)
    else:
        hr, wr = long_side, int(long_side * w / h)
    return wr / w, hr / h, (wp - wr) // 2, (hp - hr) // 2, wr, hr


def k_into_input(K, sx: float, sy: float, px: int, py: int):
    import numpy as np

    K = np.asarray(K, dtype=np.float64)
    return np.array([[K[0, 0] * sx, 0.0, K[0, 2] * sx + px],
                     [0.0, K[1, 1] * sy, K[1, 2] * sy + py],
                     [0.0, 0.0, 1.0]])


def describe(pred) -> dict:
    p = pred.persons
    d = {"num_person": int(p.num_person)}
    for name in ("conf", "shape", "v3d", "j3d", "j2d", "transl_pelvis", "bone_poses", "rest_bone_poses", "trackfeat"):
        v = getattr(p, name, None)
        if v is not None:
            d[name] = {"shape": list(v.shape), "dtype": str(v.dtype).replace("torch.", "")}
    if p.num_person:
        d["conf_values"] = [round(float(c), 3) for c in p.conf.flatten()]
        d["pelvis_xyz_m"] = [[round(float(x), 3) for x in row] for row in p.transl_pelvis.reshape(-1, 3)]
    return d


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--times", default="2.0,8.0", help="comma-separated seconds")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ckpt", default=str(paths.MULTIHMR2_CKPT))
    ap.add_argument("--hfov-deg", type=float, default=64.0, help="placeholder camera until COLMAP K exists")
    ap.add_argument("--conf", type=float, default=0.3)
    ap.add_argument("--nms", type=float, default=0.25)
    args = ap.parse_args(argv)

    import cv2
    import numpy as np
    import torch

    import anny
    import multihmr2
    import open3d
    import warp

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict = {
        "versions": {"torch": torch.__version__, "cuda": torch.version.cuda, "anny": getattr(anny, "__version__", "?"),
                     "open3d": open3d.__version__, "warp": warp.__version__},
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "frames": [],
    }
    print(json.dumps(report["versions"]), report["gpu"], flush=True)

    t0 = time.time()
    sess = multihmr2.init_hmr_session(args.ckpt)
    report["init_seconds"] = round(time.time() - t0, 1)
    print(f"session ready in {report['init_seconds']} s on {sess.device}", flush=True)
    dev = sess.device

    for t in [float(x) for x in args.times.split(",") if x.strip()]:
        img = read_frame(args.video, t, out)
        h, w = img.shape[:2]
        x = sess.preprocessor(img).unsqueeze(0).to(dev)
        hp, wp = x.shape[-2:]
        sx, sy, px, py, wr, hr = letterbox_geometry(h, w, hp, wp)
        f_ours = (w / 2) / math.tan(math.radians(args.hfov_deg) / 2)
        K_ours = k_into_input([[f_ours, 0, w / 2], [0, f_ours, h / 2], [0, 0, 1]], sx, sy, px, py)
        K_in = torch.from_numpy(K_ours).float().unsqueeze(0).to(dev)

        torch.cuda.synchronize()
        t1 = time.time()
        with torch.inference_mode(), torch.amp.autocast(device_type="cuda", enabled=sess.use_cuda):
            z = sess.model.encoder(x)
            pred_own = sess.model.full_body_decoder(z, K=z.K, conf_thresh=args.conf, dist_thresh_nms=args.nms)[0]
            pred_ours = sess.model.full_body_decoder(z, K=K_in, conf_thresh=args.conf, dist_thresh_nms=args.nms)[0]
        torch.cuda.synchronize()
        dt = time.time() - t1
        f_pred = float(z.K[0, 0, 0])
        hfov_pred = math.degrees(2 * math.atan((wr / 2) / f_pred))
        fr = {
            "t": t, "src_hw": [h, w], "input_hw": [int(hp), int(wp)], "pad_xy": [px, py],
            "hfov_pred_deg": round(hfov_pred, 2), "hfov_ours_deg": args.hfov_deg,
            "seconds_encoder_plus_2_decodes": round(dt, 3),
            "predicted_K": describe(pred_own.to("cpu")), "our_K": describe(pred_ours.to("cpu")),
        }
        report["frames"].append(fr)
        print(f"t={t:.2f}s input {hp}x{wp} pad ({px},{py}) | predicted hfov {hfov_pred:.1f} deg vs ours "
              f"{args.hfov_deg:.1f} | people: predicted-K {fr['predicted_K']['num_person']}, our-K "
              f"{fr['our_K']['num_person']} | {dt * 1000:.0f} ms", flush=True)
        print("  our-K outputs:", json.dumps({k: v for k, v in fr["our_K"].items()}), flush=True)

        # Evidence: 2D joints (our-K decode) drawn on the original frame, written at half size.
        vis = np.ascontiguousarray(img[:, :, ::-1])
        p = pred_ours.to("cpu").persons
        colours = [(0, 200, 255), (255, 120, 0), (80, 255, 80), (255, 0, 200)]
        for i in range(int(p.num_person)):
            j2d = p.j2d[i].float().numpy()
            uv = np.stack([(j2d[:, 0] - px) / sx, (j2d[:, 1] - py) / sy], axis=1)
            c = colours[i % len(colours)]
            for u, v in uv:
                if 0 <= u < w and 0 <= v < h:
                    cv2.circle(vis, (int(u), int(v)), 3, c, -1)
            u0, v0 = uv[0]
            cv2.putText(vis, f"#{i} conf {float(p.conf[i]):.2f} z {float(p.transl_pelvis[i].flatten()[2]):.2f} m",
                        (int(max(0, u0 - 80)), int(max(30, v0 - 40))), cv2.FONT_HERSHEY_SIMPLEX, 1.0, c, 2)
        cv2.imwrite(str(out / f"frame-{t:06.2f}.jpg"), cv2.resize(vis, (w // 2, h // 2)), [cv2.IMWRITE_JPEG_QUALITY, 85])

    if torch.cuda.is_available():
        report["max_gpu_mem_GB"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
    (out / "smoke.json").write_text(json.dumps(report, indent=1))
    print(f"wrote {out / 'smoke.json'} (max GPU mem {report.get('max_gpu_mem_GB')} GB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
