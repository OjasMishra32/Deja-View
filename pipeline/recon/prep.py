#!/usr/bin/env python3
"""Step 1: a capture (photos and/or videos of one place) -> the image set the pose solver and the trainer read.

  python pipeline/recon/prep.py --work WORK --photos a.jpg b.jpg ... \
      --video walk=clip1.mov:80 --video play=clip2.mov:56:people

Photos: EXIF orientation applied, resized so the long side is --photo-long, intrinsics prior from the EXIF 35 mm
equivalent focal length (diagonal convention, which is how phones fill that tag). Photos that share a lens and an
aspect ratio share one camera.

Videos (`name=path:count[:people]`): every frame is scored for sharpness (variance of the Laplacian at 640 px), the
clip is cut into `count` equal time windows and the sharpest frame of each window is kept. A window whose best frame
is much blurrier than the frames around it (a fast pan) is skipped. HDR clips (HLG/PQ, every recent iPhone) are
tone-mapped to SDR with the same LUTs as the rest of the pipeline. Each video is one camera (focal solved later).
Frames are decoded with every source frame kept (no frame-rate conversion), so `frameIndex` is the index of the
frame in the file and `time` its presentation time in seconds.

`:people` runs a person segmentation on the kept frames and writes masks/<image>.png (255 = use, 0 = ignore,
dilated, each blob filled to its convex hull so backpacks go too), which COLMAP's feature extractor and the training
loss both honour. `--redo-masks [GROUP ...]` recomputes only the masks of an existing work folder.

Writes WORK/images/<group>/*.jpg, WORK/masks/<group>/*.jpg.png and WORK/frames.json.
"""
from __future__ import annotations

import argparse
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

from util import Work, log, read_json, write_json  # noqa: E402  (util puts pipeline/ on sys.path)

from common.hdr import lut_file, lut_filters, rgb48_to_rgb24, scale_options  # noqa: E402
from common.media import hdr_source, load_image, probe, require_ffmpeg, resize_long, save_jpg  # noqa: E402

# Diagonal of a 36 x 24 mm frame: phones write FocalLengthIn35mmFilm against it.
DIAG_35MM = math.hypot(36.0, 24.0)
JPEG_QUALITY = 95


def say(msg: str) -> None:
    log("prep", msg)


# --------------------------------------------------------------------------------------------------------------
# Photos
# --------------------------------------------------------------------------------------------------------------


def photo_exif(path: Path) -> dict:
    from PIL import Image

    out: dict = {}
    try:
        if path.suffix.lower() in (".heic", ".heif"):
            import pillow_heif

            pillow_heif.register_heif_opener()
        with Image.open(path) as im:
            ex = im.getexif()
            sub = ex.get_ifd(0x8769)
    except Exception:
        return out
    pick = {"f35": 41989, "focalMm": 37386, "exposure": 33434, "iso": 34855, "time": 36867, "lens": 42036}
    for k, tag in pick.items():
        v = sub.get(tag)
        if v is None:
            continue
        if isinstance(v, bytes):
            v = v.decode(errors="replace")
        if isinstance(v, (tuple, list)):
            v = v[0] if v else None
        try:
            out[k] = float(v) if k not in ("time", "lens") else str(v).strip("\x00 ")
        except (TypeError, ValueError):
            out[k] = str(v)
    return out


def focal_from_35mm(f35: float, width: int, height: int) -> float:
    """Focal length in pixels from a 35 mm equivalent focal length (diagonal field of view kept)."""
    return f35 / DIAG_35MM * math.hypot(width, height)


def prep_photos(paths: list[Path], work: Work, long_side: int, people: bool = False) -> tuple[dict, list[dict]]:
    groups: dict = {}
    images: list[dict] = []
    smalls: list[np.ndarray] = []
    for p in sorted(paths):
        rgb = load_image(p)
        h0, w0 = rgb.shape[:2]
        ex = photo_exif(p)
        small = resize_long(rgb, long_side)
        h, w = small.shape[:2]
        f35 = ex.get("f35")
        aspect = f"{max(w0, h0) / min(w0, h0):.3f}"
        key = (round(float(f35 or 0)), aspect, w > h)
        gname = next((g for g, info in groups.items() if info["_key"] == key), None)
        if gname is None:
            gname = "photo" if not groups else f"photo{len(groups) + 1}"
            prior = None
            if f35:
                f = focal_from_35mm(float(f35), w, h)
                prior = {"fx": f, "fy": f, "cx": w / 2.0, "cy": h / 2.0}
            groups[gname] = {
                "_key": key,
                "kind": "photo",
                "width": w,
                "height": h,
                "prior": prior,
                "hasPriorFocal": prior is not None,
                "f35": f35,
                "lens": ex.get("lens"),
            }
        g = groups[gname]
        if (w, h) != (g["width"], g["height"]):
            # same lens and aspect, different pixel count (12 MP vs 24 MP mode): match the group's size exactly
            import cv2

            small = cv2.resize(rgb, (g["width"], g["height"]), interpolation=cv2.INTER_AREA)
            h, w = small.shape[:2]
        name = f"{gname}/{p.stem}.jpg"
        save_jpg(work.images / name, small, quality=JPEG_QUALITY)
        images.append({"name": name, "group": gname, "source": p.name, "width": w, "height": h, "sourceSize": [w0, h0], "exif": ex})
        if people:
            smalls.append(small)
        say(f"photo {p.name} {w0}x{h0} -> {name} {w}x{h} (f35={f35}, exposure={ex.get('exposure')}, iso={ex.get('iso')})")
    for g in groups.values():
        g.pop("_key", None)
    if people:
        from common.media import save_png

        for rec, m in zip(images, person_masks(smalls)):
            rec["masked"] = round(float(np.mean(m == 0)), 4)
            if rec["masked"] > 0:
                save_png(work.mask_for(rec["name"]), m)
                say(f"photo {rec['name']}: {100 * rec['masked']:.1f}% masked (people)")
    return groups, images


# --------------------------------------------------------------------------------------------------------------
# Videos
# --------------------------------------------------------------------------------------------------------------


def frame_times(path: Path) -> np.ndarray:
    """Presentation time (s) of every frame of the first video stream, in decode order."""
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time",
           "-of", "csv=p=0", str(path)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=300).stdout
    t = [float(x.strip().rstrip(",")) for x in out.splitlines() if x.strip() and x.strip() != "N/A"]
    return np.asarray(t, np.float64)


def decode_frames(path: Path, size: tuple[int, int], keep: set[int] | None = None, tonemap: bool = True,
                  hdr_signal: bool = False):
    """Yields (index, rgb uint8) for every source frame (or those in `keep`), exactly `size` (w, h).

    Unlike common.media.iter_frames this never resamples time (-fps_mode passthrough), so the index is the frame
    number in the file. hdr_signal=True yields the HDR R'G'B' signal itself as float32 0..1 (HDR clips only), for
    hdr_to_sdr()."""
    require_ffmpeg()
    w, h = size
    scale = f"scale={w}:{h}:flags=area+accurate_rnd+full_chroma_int"
    src = hdr_source(path) if tonemap or hdr_signal else None
    base = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-fps_mode", "passthrough"]
    if src is not None and hdr_signal:
        # planar 16-bit first: see common/hdr.py lut_filters() on packed rgb48 conversions
        cmd = base + ["-vf", scale + scale_options(src) + ",format=gbrp16le", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"]
        nbytes = w * h * 6
        conv = lambda b: (np.frombuffer(b, "<u2").reshape(h, w, 3).astype(np.float32) / 65535.0)  # noqa: E731
    elif src is not None:
        vf = ",".join([scale + scale_options(src)] + lut_filters(src, lut_file(src.transfer, src.primaries)))
        cmd = base + ["-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"]
        nbytes = w * h * 6
        conv = lambda b: rgb48_to_rgb24(b, w, h)  # noqa: E731
    else:
        cmd = base + ["-vf", scale, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        nbytes = w * h * 3
        conv = lambda b: np.frombuffer(b, np.uint8).reshape(h, w, 3)  # noqa: E731
    last = max(keep) if keep else None
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=nbytes * 2)
    try:
        i = 0
        while True:
            buf = proc.stdout.read(nbytes)
            while buf is not None and 0 < len(buf) < nbytes:
                more = proc.stdout.read(nbytes - len(buf))
                if not more:
                    break
                buf += more
            if not buf or len(buf) < nbytes:
                break
            if keep is None or i in keep:
                yield i, conv(buf)
            i += 1
            if last is not None and i > last:
                break
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()


def laplacian_var(rgb: np.ndarray) -> float:
    import cv2

    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    return float(cv2.Laplacian(g, cv2.CV_32F, ksize=3).var())


def hdr_linear(sig: np.ndarray, transfer: str, primaries: str) -> np.ndarray:
    """HDR R'G'B' signal -> linear BT.709 light relative to reference white (no highlight roll-off)."""
    from common import hdr

    r, g, b = sig[..., 0].astype(np.float64), sig[..., 1].astype(np.float64), sig[..., 2].astype(np.float64)
    if transfer == "hlg":
        r, g, b = hdr._hlg_display(r, g, b, hdr._Y709 if primaries == "bt709" else hdr._Y2020)
    else:
        r, g, b = hdr._pq_eotf(r), hdr._pq_eotf(g), hdr._pq_eotf(b)
    lin = np.stack([r, g, b], axis=-1) / hdr.REF_WHITE_NITS
    if primaries != "bt709":
        lin = lin @ np.asarray(hdr._M2020_TO_709).T
    return lin


def hdr_to_sdr(sig: np.ndarray, transfer: str, primaries: str, gain: float) -> np.ndarray:
    """HDR signal -> 8-bit SDR with an exposure `gain` applied in linear light before the usual roll-off.

    Phones expose night HDR video so that walls and floors sit above reference white; the display tone mapping
    then squeezes them into the roll-off and their texture is gone. A per-clip gain (exposure_gain()) keeps them
    in the linear part, which is what reconstruction needs (colour differences to the photos are learned)."""
    from common import hdr

    lin = hdr_linear(sig, transfer, primaries) * gain
    r, g, b = hdr._rolloff(lin[..., 0], lin[..., 1], lin[..., 2])
    out = np.stack([hdr._encode(np.maximum(r, 0)), hdr._encode(np.maximum(g, 0)), hdr._encode(np.maximum(b, 0))], axis=-1)
    return np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)


def exposure_gain(samples: list[np.ndarray], transfer: str, primaries: str, target: float = 0.85, pct: float = 99.0) -> float:
    """Gain that puts the pct-th percentile of max(R, G, B) (linear) at `target` (just under the roll-off knee)."""
    vals = []
    for sig in samples:
        lin = hdr_linear(sig[::4, ::4], transfer, primaries)
        vals.append(lin.max(axis=-1).reshape(-1))
    v = float(np.percentile(np.concatenate(vals), pct))
    return float(min(1.0, target / max(v, 1e-6)))


def pick_sharp(sharp: np.ndarray, times: np.ndarray, count: int, blur_ratio: float = 0.55, envelope_s: float = 1.0) -> tuple[list[int], list[dict]]:
    """Sharpest frame per equal time window; skips windows that are blurred relative to their surroundings.

    The reference for "blurred" is the 90th percentile of sharpness within +-envelope_s/2 of the candidate (the
    same part of the scene, so dark or flat views are not punished), and a floor at 35% of the median window best.
    Returns (kept frame indices, per window report)."""
    n = len(sharp)
    t0, t1 = float(times[0]), float(times[-1]) + 1e-6
    edges = np.linspace(t0, t1, count + 1)
    best_list = []
    for a, b in zip(edges[:-1], edges[1:]):
        idx = np.nonzero((times >= a) & (times < b))[0]
        if len(idx) == 0:
            continue
        best_list.append(int(idx[np.argmax(sharp[idx])]))
    floor = 0.35 * float(np.median(sharp[best_list])) if best_list else 0.0
    kept, report = [], []
    for i in best_list:
        near = np.nonzero(np.abs(times - times[i]) <= envelope_s / 2)[0]
        env = float(np.percentile(sharp[near], 90))
        ok = sharp[i] >= blur_ratio * env and sharp[i] >= floor
        report.append({"frameIndex": i, "time": round(float(times[i]), 4), "sharpness": round(float(sharp[i]), 2),
                       "envelope": round(env, 2), "kept": bool(ok)})
        if ok:
            kept.append(i)
    return kept, report


MASK = {"thresh": 0.15, "grow": 0.06, "hull": True}


def person_masks(frames: list[np.ndarray], grow_frac: float | None = None, thresh: float | None = None,
                 hull: bool | None = None, batch: int = 4) -> list[np.ndarray]:
    """uint8 masks, 255 = static scene (use), 0 = person (ignore).

    The segmentation knows people, not what they carry: a backpack sticking out of the silhouette ends up baked
    into the room as a dark floater. So the person probability is thresholded low, dilated by grow_frac of the short
    side, and each blob is replaced by its convex hull (which takes in the backpack and the gap under an arm)."""
    import cv2

    from common.models import PersonSegmenter

    grow_frac = MASK["grow"] if grow_frac is None else grow_frac
    thresh = MASK["thresh"] if thresh is None else thresh
    hull = MASK["hull"] if hull is None else hull
    seg = PersonSegmenter()
    out = []
    for k in range(0, len(frames), batch):
        prob = seg(np.stack(frames[k : k + batch]))
        for p in prob:
            fg = (p >= thresh).astype(np.uint8)
            r = max(3, int(round(grow_frac * min(fg.shape))))
            fg = cv2.dilate(fg, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
            if hull:
                n, lab = cv2.connectedComponents(fg)
                for c in range(1, n):
                    ys, xs = np.nonzero(lab == c)
                    cv2.fillConvexPoly(fg, cv2.convexHull(np.stack([xs, ys], axis=1).astype(np.int32)), 1)
            else:
                # fill holes inside a person (between an arm and the body): flood the background from a zero
                # border, whatever is left unflooded is enclosed by the person
                ff = np.pad(fg, 1)
                cv2.floodFill(ff, None, (0, 0), 1)
                fg[ff[1:-1, 1:-1] == 0] = 1
            out.append(np.where(fg > 0, 0, 255).astype(np.uint8))
    return out


def redo_masks(work: Work, groups: set[str] | None) -> None:
    """Recomputes the person masks of the images already in WORK (frames.json) with the current settings."""
    import cv2

    from common.media import save_png

    frames = read_json(work.frames)
    todo = [im for im in frames["images"] if (groups is None or im["group"] in groups)]
    for k in range(0, len(todo), 16):
        chunk = todo[k : k + 16]
        imgs = [cv2.cvtColor(cv2.imread(str(work.images / im["name"])), cv2.COLOR_BGR2RGB) for im in chunk]
        for im, m in zip(chunk, person_masks(imgs)):
            im["masked"] = round(float(np.mean(m == 0)), 4)
            mp = work.mask_for(im["name"])
            if im["masked"] > 0 or mp.exists():
                save_png(mp, m)
    frames["masks"] = dict(MASK)
    write_json(work.frames, frames)
    say(f"masks redone for {len(todo)} images ({MASK})")


def prep_video(name: str, path: Path, count: int, people: bool, work: Work, long_side: int, tone: str = "exposure",
               keep_frames: list[int] | None = None) -> tuple[dict, list[dict], dict]:
    info = probe(path)
    w, h = info.width, info.height
    s = min(1.0, long_side / max(w, h))
    W, H = int(round(w * s / 2)) * 2, int(round(h * s / 2)) * 2
    times = frame_times(path)
    say(f"video {path.name}: {w}x{h} {info.fps:.3f} fps {info.duration:.2f}s, {len(times)} frames, hdr={info.hdr}")
    sw, sh = (640, int(round(640 * h / w / 2)) * 2) if w >= h else (int(round(640 * w / h / 2)) * 2, 640)
    sharp = []
    for _, fr in decode_frames(path, (sw, sh)):
        sharp.append(laplacian_var(fr))
    sharp_a = np.asarray(sharp, np.float64)
    if len(sharp_a) != len(times):
        say(f"WARNING: decoded {len(sharp_a)} frames but ffprobe listed {len(times)}; using decode order")
        n = min(len(sharp_a), len(times))
        sharp_a, times = sharp_a[:n], times[:n]
    t_rel = times - times[0]
    np.save(work.root / f"{name}-times.npy", t_rel)
    if keep_frames:
        kept, report = sorted(keep_frames), [{"frameIndex": i, "kept": True, "reused": True} for i in sorted(keep_frames)]
        say(f"video {name}: reusing the {len(kept)} frames picked before")
    else:
        kept, report = pick_sharp(sharp_a, t_rel, count)
        say(f"video {name}: kept {len(kept)} of {len(report)} windows (sharpness median {np.median(sharp_a):.1f})")
    frames: dict[int, np.ndarray] = {}
    src = hdr_source(path)
    gain = None
    if src is not None and tone == "exposure":
        probe_idx = set(kept[:: max(1, len(kept) // 12)])
        gain = exposure_gain([sig for _, sig in decode_frames(path, (W, H), keep=probe_idx, hdr_signal=True)], src.transfer, src.primaries)
        say(f"video {name}: {src.transfer} decoded with exposure gain {gain:.3f} before the roll-off")
        for i, sig in decode_frames(path, (W, H), keep=set(kept), hdr_signal=True):
            frames[i] = hdr_to_sdr(sig, src.transfer, src.primaries, gain)
    else:
        for i, fr in decode_frames(path, (W, H), keep=set(kept)):
            frames[i] = fr.copy()
    order = [i for i in kept if i in frames]
    reuse_masks = bool(keep_frames) and all(work.mask_for(f"{name}/f{i:06d}.jpg").exists() for i in order)
    masks = person_masks([frames[i] for i in order]) if people and not reuse_masks else [None] * len(order)
    images = []
    for i, m in zip(order, masks):
        nm = f"{name}/f{i:06d}.jpg"
        save_jpg(work.images / nm, frames[i], quality=JPEG_QUALITY)
        rec = {"name": nm, "group": name, "source": path.name, "width": W, "height": H, "frameIndex": int(i),
               "time": round(float(t_rel[i]), 6), "sharpness": round(float(sharp_a[i]), 2)}
        if m is not None:
            from common.media import save_png

            save_png(work.mask_for(nm), m)
            rec["masked"] = round(float(np.mean(m == 0)), 4)
        elif reuse_masks:
            import cv2

            rec["masked"] = round(float(np.mean(cv2.imread(str(work.mask_for(nm)), cv2.IMREAD_GRAYSCALE) == 0)), 4)
        images.append(rec)
    group = {
        "kind": "video",
        "width": W,
        "height": H,
        "prior": None,
        "hasPriorFocal": False,
        "source": path.name,
        "fps": info.fps,
        "frames": int(len(times)),
        "duration": info.duration,
        "hdr": info.hdr,
        "tone": ("exposure" if gain is not None else "lut") if info.hdr else "sdr",
        "exposureGain": gain,
        "people": bool(people),
    }
    return group, images, {"windows": report}


# --------------------------------------------------------------------------------------------------------------


def parse_video_arg(s: str) -> tuple[str, Path, int, bool]:
    if "=" not in s:
        raise argparse.ArgumentTypeError("--video wants name=path:count[:people]")
    name, rest = s.split("=", 1)
    parts = rest.split(":")
    flags = set()
    while parts and parts[-1] in ("people",):
        flags.add(parts.pop())
    count = 60
    if len(parts) > 1 and parts[-1].isdigit():
        count = int(parts.pop())
    return name, Path(":".join(parts)), count, "people" in flags


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--photos", nargs="*", default=[], type=Path)
    ap.add_argument("--video", action="append", default=[], type=parse_video_arg)
    ap.add_argument("--photo-long", type=int, default=1920)
    ap.add_argument("--photo-people", action="store_true", help="mask people in the photos too")
    ap.add_argument("--video-long", type=int, default=1920)
    ap.add_argument("--video-tone", choices=["exposure", "lut"], default="exposure",
                    help="HDR clips: per-clip exposure before the roll-off (default) or the display tone mapping")
    ap.add_argument("--keep-frames", action="store_true",
                    help="re-decode the video frames listed in WORK/frames.json (same frames, poses stay valid)")
    ap.add_argument("--mask-thresh", type=float, default=MASK["thresh"], help="person probability that counts as a person")
    ap.add_argument("--mask-grow", type=float, default=MASK["grow"], help="mask dilation, fraction of the short side")
    ap.add_argument("--mask-hull", action=argparse.BooleanOptionalAction, default=MASK["hull"], help="fill each person blob's convex hull")
    ap.add_argument("--redo-masks", nargs="*", default=None, metavar="GROUP",
                    help="only recompute the masks of the images in WORK (all groups, or the ones named) and exit")
    a = ap.parse_args(argv)
    work = Work(a.work)
    work.root.mkdir(parents=True, exist_ok=True)
    MASK.update(thresh=a.mask_thresh, grow=a.mask_grow, hull=a.mask_hull)
    if a.redo_masks is not None:
        redo_masks(work, set(a.redo_masks) or None)
        return 0
    groups, images, videos = {}, [], {}
    if a.photos:
        g, im = prep_photos(a.photos, work, a.photo_long, a.photo_people)
        groups.update(g)
        images += im
    before = read_json(work.frames, {}) if a.keep_frames else {}
    for name, path, count, people in a.video:
        keep = [im["frameIndex"] for im in before.get("images", []) if im.get("group") == name] or None
        g, im, rep = prep_video(name, path, count, people, work, a.video_long, a.video_tone, keep)
        groups[name] = g
        images += im
        videos[name] = rep
    write_json(work.frames, {"version": 1, "groups": groups, "images": images, "videos": videos})
    say(f"wrote {len(images)} images in {len(groups)} camera groups to {work.root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
