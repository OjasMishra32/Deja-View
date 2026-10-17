"""The model worker: captions, image edits, metric depth and small-hole inpainting, served through a file queue.

  python -m genfill.models serve --queue DIR [--preload caption,edit,depth,lama] [--parent PID] [--fake]

It runs in its own process (the avatar env on HiPerGator: diffusers + transformers new enough for
Qwen-Image-Edit-2511), next to the gsplat process (fill.py), on the same GPU. The gsplat side writes
DIR/req-<id>.json (atomic rename) and waits for DIR/res-<id>.json. Ops:

  caption  {images: [png...], prompt, max_new_tokens}            -> {text}          Qwen2.5-VL-7B (the editor's)
  edit     {image: png, prompt, negative, steps, cfg, seed,
            width, height, out: png, refs: [png...]}              -> {out, seconds}   Qwen-Image-Edit-2511, bf16
  depth    {image: png, out: npy}                                 -> {out}           Depth Anything V2 metric (indoor)
  lama     {image: png, mask: png, out: png}                      -> {out}           Big LaMa
  ping     {}                                                     -> {loaded}

--fake answers every op with cheap stand-ins (no models): the tests use it to exercise the protocol.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np

# "editor": the Qwen2.5-VL-7B that Qwen-Image-Edit-2511 ships as its text encoder (full model, LM head included),
# so captions cost no extra memory; or a model id such as Qwen/Qwen2.5-VL-3B-Instruct.
CAPTION_MODEL = os.environ.get("GENFILL_CAPTION_MODEL", "editor")
EDIT_MODEL = os.environ.get("GENFILL_EDIT_MODEL", "Qwen/Qwen-Image-Edit-2511")
DEPTH_MODEL = os.environ.get("GENFILL_DEPTH_MODEL", "metric-indoor-base")


def say(msg: str) -> None:
    print(f"[genfill:models] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


def _atomic_json(path: Path, obj) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(obj))
    os.replace(tmp, path)


# --------------------------------------------------------------------------------------------------------------
# Client (gsplat side)
# --------------------------------------------------------------------------------------------------------------


class WorkerError(RuntimeError):
    pass


class Client:
    def __init__(self, queue: Path | str, timeout: float = 900.0):
        self.queue = Path(queue)
        self.queue.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout
        self._n = 0

    def status(self) -> dict | None:
        try:
            return json.loads((self.queue / "worker.json").read_text())
        except (OSError, json.JSONDecodeError):
            return None

    def alive(self, max_age: float = 60.0) -> bool:
        st = self.status()
        return bool(st) and (time.time() - float(st.get("t", 0))) < max_age and not st.get("stopped")

    def wait_ready(self, ops: list[str], timeout: float = 1200.0) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            st = self.status() or {}
            if set(st.get("failed") or []) & set(ops):
                return False
            if set(ops) <= set(st.get("loaded", [])):
                return True
            time.sleep(2.0)
        return False

    def call(self, op: str, timeout: float | None = None, **args) -> dict:
        self._n += 1
        rid = f"{time.time_ns()}-{os.getpid()}-{self._n}"
        req = self.queue / f"req-{rid}.json"
        res = self.queue / f"res-{rid}.json"
        _atomic_json(req, {"id": rid, "op": op, "args": args})
        t0 = time.time()
        lim = timeout or self.timeout
        while not res.exists():
            if time.time() - t0 > lim:
                raise WorkerError(f"{op}: no answer after {lim:.0f}s")
            st = self.status()
            if st and st.get("stopped"):
                raise WorkerError(f"{op}: the worker stopped ({st.get('error', '')})")
            time.sleep(0.05)
        out = json.loads(res.read_text())
        res.unlink(missing_ok=True)
        if not out.get("ok"):
            raise WorkerError(f"{op}: {out.get('error')}")
        return out.get("result", {})

    def stop(self) -> None:
        (self.queue / "stop").write_text("stop")


# --------------------------------------------------------------------------------------------------------------
# Models (worker side)
# --------------------------------------------------------------------------------------------------------------


class Models:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.vlm = None
        self.proc = None
        self.editor = None
        self.depth_model = None
        self.lama_model = None
        self.loaded: list[str] = []

    # -- caption ---------------------------------------------------------------------------------------------
    def load_caption(self) -> None:
        if self.vlm is not None:
            return
        import torch
        from transformers import AutoProcessor

        try:
            from transformers import Qwen2_5_VLForConditionalGeneration as VLM
        except ImportError:  # pragma: no cover
            from transformers import AutoModelForImageTextToText as VLM
        t0 = time.time()
        if CAPTION_MODEL == "editor":
            self.load_edit()
            self.vlm = self.editor.text_encoder
            self.proc = self.editor.processor  # the pipeline's own Qwen2VLProcessor (tokenizer + image processor)
            self.loaded.append("caption")
            say(f"captioner: the editor's Qwen2.5-VL-7B text encoder ({time.time() - t0:.1f}s)")
            return
        self.proc = AutoProcessor.from_pretrained(CAPTION_MODEL, min_pixels=256 * 28 * 28, max_pixels=1024 * 28 * 28)
        try:
            self.vlm = VLM.from_pretrained(CAPTION_MODEL, dtype=torch.bfloat16).to(self.device).eval()
        except TypeError:
            self.vlm = VLM.from_pretrained(CAPTION_MODEL, torch_dtype=torch.bfloat16).to(self.device).eval()
        self.loaded.append("caption")
        say(f"captioner {CAPTION_MODEL} loaded in {time.time() - t0:.1f}s")

    def caption(self, images: list[str], prompt: str, max_new_tokens: int = 120) -> dict:
        import torch
        from PIL import Image

        self.load_caption()
        ims = [Image.open(p).convert("RGB") for p in images]
        content = [{"type": "image"} for _ in ims] + [{"type": "text", "text": prompt}]
        messages = [{"role": "user", "content": content}]
        text = self.proc.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.proc(text=[text], images=ims, return_tensors="pt").to(self.device)
        with torch.no_grad():
            out = self.vlm.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        new = out[:, inputs["input_ids"].shape[1]:]
        cap = self.proc.batch_decode(new, skip_special_tokens=True)[0].strip()
        return {"text": cap}

    # -- edit ------------------------------------------------------------------------------------------------
    def load_edit(self) -> None:
        if self.editor is not None:
            return
        import torch
        from diffusers import QwenImageEditPlusPipeline

        t0 = time.time()
        try:
            pipe = QwenImageEditPlusPipeline.from_pretrained(EDIT_MODEL, torch_dtype=torch.bfloat16, device_map="cuda")
        except Exception as e:  # older diffusers: no device_map for pipelines
            say(f"device_map load failed ({e}); loading on the CPU first")
            pipe = QwenImageEditPlusPipeline.from_pretrained(EDIT_MODEL, torch_dtype=torch.bfloat16).to(self.device)
        pipe.set_progress_bar_config(disable=True)
        self.editor = pipe
        self.loaded.append("edit")
        say(f"editor {EDIT_MODEL} loaded in {time.time() - t0:.1f}s")

    def edit(self, image: str, prompt: str, out: str, negative: str = " ", steps: int = 32, cfg: float = 4.0,
             seed: int = 0, width: int | None = None, height: int | None = None, refs: list[str] | None = None) -> dict:
        import torch
        from PIL import Image

        self.load_edit()
        im = Image.open(image).convert("RGB")
        imgs = [im] + [Image.open(p).convert("RGB") for p in (refs or [])]
        w = int(width or im.width) // 16 * 16
        h = int(height or im.height) // 16 * 16
        t0 = time.time()
        with torch.inference_mode():
            res = self.editor(image=imgs if len(imgs) > 1 else imgs[0], prompt=prompt, negative_prompt=negative,
                              true_cfg_scale=cfg, guidance_scale=1.0, num_inference_steps=steps, width=w, height=h,
                              generator=torch.Generator(device="cpu").manual_seed(int(seed)), num_images_per_prompt=1)
        o = res.images[0]
        if o.size != im.size:
            o = o.resize(im.size, Image.LANCZOS)
        o.save(out)
        return {"out": out, "seconds": round(time.time() - t0, 1), "generated": [w, h]}

    # -- depth -----------------------------------------------------------------------------------------------
    def load_depth(self) -> None:
        if self.depth_model is not None:
            return
        from common.models import DepthEstimator

        t0 = time.time()
        self.depth_model = DepthEstimator(DEPTH_MODEL, device=self.device, short_side=644)
        self.loaded.append("depth")
        say(f"depth {DEPTH_MODEL} loaded in {time.time() - t0:.1f}s")

    def depth(self, image: str, out: str) -> dict:
        from PIL import Image

        self.load_depth()
        rgb = np.asarray(Image.open(image).convert("RGB"))
        d = self.depth_model(rgb)[0]
        np.save(out, d.astype(np.float32))
        return {"out": out, "min": float(d.min()), "max": float(d.max())}

    # -- lama ------------------------------------------------------------------------------------------------
    def load_lama(self) -> None:
        if self.lama_model is not None:
            return
        from common.models import Inpainter

        self.lama_model = Inpainter(device=self.device)
        self.loaded.append("lama")
        say("LaMa loaded")

    def lama(self, image: str, mask: str, out: str) -> dict:
        from PIL import Image

        self.load_lama()
        rgb = np.asarray(Image.open(image).convert("RGB"))
        m = np.asarray(Image.open(mask).convert("L")) > 127
        Image.fromarray(self.lama_model(rgb, m)).save(out)
        return {"out": out}


class FakeModels:
    """Cheap stand-ins with the same interface (tests, dry runs)."""

    def __init__(self):
        self.loaded = ["caption", "edit", "depth", "lama"]

    def caption(self, images, prompt, max_new_tokens=120):
        return {"text": '{"fill": "a plain grey surface", "sky_only": false}'}

    def edit(self, image, prompt, out, refs=None, **kw):
        from PIL import Image, ImageFilter

        im = Image.open(image).convert("RGB")
        a = np.asarray(im).copy()
        mag = (a[..., 0] > 170) & (a[..., 2] > 170) & (a[..., 1] < 90)
        a[mag] = (128, 128, 128)
        Image.fromarray(a).filter(ImageFilter.GaussianBlur(1)).save(out)
        return {"out": out, "seconds": 0.0}

    def depth(self, image, out):
        from PIL import Image

        im = Image.open(image)
        np.save(out, np.full((im.height, im.width), 3.0, np.float32))
        return {"out": out}

    def lama(self, image, mask, out):
        return self.edit(image, "", out)


def serve(queue: Path, preload: list[str], parent: int | None, fake: bool, idle_exit: float) -> int:
    queue.mkdir(parents=True, exist_ok=True)
    (queue / "stop").unlink(missing_ok=True)
    models = FakeModels() if fake else Models()
    status = {"pid": os.getpid(), "t": time.time(), "loaded": list(models.loaded), "busy": None, "served": 0}
    _atomic_json(queue / "worker.json", status)
    if not fake:
        failed = []
        for op in preload:
            try:
                getattr(models, f"load_{op}")()
            except Exception as e:
                say(f"preload {op} failed: {e}")
                traceback.print_exc()
                failed.append(op)
            status.update(t=time.time(), loaded=list(models.loaded), failed=failed)
            _atomic_json(queue / "worker.json", status)
    last = time.time()
    while True:
        if (queue / "stop").exists():
            break
        if parent and not _pid_alive(parent):
            say(f"parent {parent} is gone; stopping")
            break
        reqs = sorted(queue.glob("req-*.json"))
        if not reqs:
            if idle_exit and time.time() - last > idle_exit:
                say("idle; stopping")
                break
            status.update(t=time.time(), busy=None)
            _atomic_json(queue / "worker.json", status)
            time.sleep(0.1)
            continue
        for rq in reqs:
            try:
                req = json.loads(rq.read_text())
            except (OSError, json.JSONDecodeError):
                time.sleep(0.05)
                continue
            rq.unlink(missing_ok=True)
            op, args = req.get("op"), req.get("args", {})
            status.update(t=time.time(), busy=op)
            _atomic_json(queue / "worker.json", status)
            t0 = time.time()
            try:
                if op == "ping":
                    result = {"loaded": list(models.loaded)}
                else:
                    result = getattr(models, op)(**args)
                out = {"ok": True, "result": result}
            except Exception as e:
                traceback.print_exc()
                out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            say(f"{op} {'ok' if out['ok'] else 'FAILED'} in {time.time() - t0:.1f}s")
            status.update(t=time.time(), busy=None, served=status["served"] + 1, loaded=list(models.loaded))
            _atomic_json(queue / f"res-{req['id']}.json", out)
            _atomic_json(queue / "worker.json", status)
            last = time.time()
    status.update(t=time.time(), stopped=True, busy=None)
    _atomic_json(queue / "worker.json", status)
    return 0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["serve"])
    ap.add_argument("--queue", required=True, type=Path)
    ap.add_argument("--preload", default="depth,lama,edit,caption")
    ap.add_argument("--parent", type=int, default=None)
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--idle-exit", type=float, default=0.0)
    a = ap.parse_args(argv)
    pipeline = str(Path(__file__).resolve().parent.parent)
    if pipeline not in sys.path:
        sys.path.insert(0, pipeline)
    return serve(a.queue, [p for p in a.preload.split(",") if p], a.parent, a.fake, a.idle_exit)


if __name__ == "__main__":
    sys.exit(main())
