"""Advisory VLM judge (team/shivin-reconstruction-loop.md, deliverable 3).

It looks at the evaluator's contact sheet (mesh | splat | mask | difference) and returns a structured score for
shape, texture, scale and artifacts against `judge_rubric.md`. It is advisory: nothing it says approves, rejects or
uploads anything; the captain approves. Results are cached by (image hash, rubric hash, model) so a re-run is free.

Gemini through its REST API with `GEMINI_API_KEY` (the key is read from the environment, never stored). Any other
VLM fits by passing `transport`: a function (prompt, jpeg bytes) -> reply text.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.request
from pathlib import Path
from typing import Callable

RUBRIC_FILE = Path(__file__).with_name("judge_rubric.md")
DEFAULT_MODEL = os.environ.get("DEJAVIEW_JUDGE_MODEL", "gemini-2.5-flash")
AXES = ("shape", "texture", "scale", "artifacts")
VERDICTS = ("good", "usable", "redo")


def rubric(label: str) -> str:
    return RUBRIC_FILE.read_text(encoding="utf-8").replace("{label}", label or "object")


def parse(reply: str) -> dict:
    """The model's JSON, validated and clamped. Raises ValueError on anything unusable."""
    text = reply.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.index("{"):] if "{" in text else text
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in the reply")
    d = json.loads(text[start:end + 1])
    scores = {}
    for k in AXES:
        v = d.get(k)
        if not isinstance(v, (int, float)):
            raise ValueError(f"missing score {k}")
        scores[k] = int(min(5, max(1, round(float(v)))))
    verdict = str(d.get("verdict", "")).lower()
    if verdict not in VERDICTS:
        verdict = "redo" if min(scores.values()) <= 2 else "usable"
    problems = [str(p)[:200] for p in d.get("problems", []) if str(p).strip()][:12]
    return {"scores": scores, "verdict": verdict, "problems": problems, "summary": str(d.get("summary", ""))[:400],
            "mean": round(sum(scores.values()) / len(scores), 2)}


def gemini_transport(model: str = DEFAULT_MODEL, timeout: float = 60.0) -> Callable[[str, bytes], str]:
    def call(prompt: str, jpeg: bytes) -> str:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        body = {"contents": [{"parts": [{"text": prompt},
                                        {"inline_data": {"mime_type": "image/jpeg",
                                                         "data": base64.b64encode(jpeg).decode()}}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}}
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            doc = json.loads(r.read())
        return doc["candidates"][0]["content"]["parts"][0]["text"]

    return call


class Judge:
    def __init__(self, cache_dir: str | Path, transport: Callable[[str, bytes], str] | None = None,
                 model: str = DEFAULT_MODEL):
        self.cache = Path(cache_dir)
        self.model = model
        self.transport = transport or gemini_transport(model)

    def key(self, jpeg: bytes, prompt: str) -> str:
        h = hashlib.sha256()
        for part in (jpeg, prompt.encode(), self.model.encode()):
            h.update(hashlib.sha256(part).digest())
        return h.hexdigest()

    def __call__(self, sheet: str | Path, label: str) -> dict:
        jpeg = Path(sheet).read_bytes()
        prompt = rubric(label)
        k = self.key(jpeg, prompt)
        hit = self.cache / f"{k}.json"
        if hit.exists():
            return {**json.loads(hit.read_text()), "cached": True}
        try:
            out = {"ok": True, **parse(self.transport(prompt, jpeg))}
        except Exception as e:  # noqa: BLE001  (the judge is advisory: a failure is recorded, never fatal)
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "model": self.model, "advisory": True}
        out.update({"model": self.model, "advisory": True, "approves": False, "key": k})
        self.cache.mkdir(parents=True, exist_ok=True)
        hit.write_text(json.dumps(out, indent=2))
        return {**out, "cached": False}
