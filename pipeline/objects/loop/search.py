"""Search: a contextual bandit prior over configuration values, successive halving, patience and the Pareto front.

Pure Python: `run_episode` takes a `trial(config, rung) -> result` callable, so the tests drive it with a synthetic
objective and PACE drives it with the real bake + evaluator.

The bandit's context is the object's class (regular, small, flat). For every knob value it keeps how well trials with
that value scored relative to the episode's best (a reward in 0..1). The first configuration of an episode takes every
knob's best upper confidence bound; the rest sample knob values in proportion to it, so knowledge from the first
objects steers the later ones while every value keeps getting tried.
"""
from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from objects.loop.space import PROMOTE, SPACE, Config, legal, stage_sizes

PATIENCE = 3
MIN_RUNG0 = 4  # rung 0 explores at least this many configurations before patience can end it


@dataclass
class Prior:
    """Per context, per knob, per value: [trials, summed reward]."""
    stats: dict = field(default_factory=dict)

    def arm(self, ctx: str, knob: str, value) -> list:
        return self.stats.setdefault(ctx, {}).setdefault(knob, {}).setdefault(json.dumps(value), [0, 0.0])

    def ucb(self, ctx: str, knob: str, value, c: float = 0.6) -> float:
        n, s = self.arm(ctx, knob, value)
        total = sum(v[0] for v in self.stats.get(ctx, {}).get(knob, {}).values())
        if n == 0:
            return 1e9
        return s / n + c * math.sqrt(math.log(max(total, 2)) / n)

    def update(self, ctx: str, config: Config, reward: float) -> None:
        for knob, value in config.to_json().items():
            a = self.arm(ctx, knob, value)
            a[0] += 1
            a[1] += float(reward)

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.stats, indent=1))

    @classmethod
    def load(cls, path: str | Path) -> "Prior":
        p = Path(path)
        return cls(json.loads(p.read_text())) if p.exists() else cls()


def propose(prior: Prior, ctx: str, n: int, rng: random.Random, space: dict = SPACE,
            seed_configs: list[Config] | None = None) -> list[Config]:
    """`n` distinct configurations: the seeds (e.g. the current bake), then the UCB-greedy one, then UCB-weighted
    samples."""
    out: list[Config] = []
    seen: set[str] = set()

    def add(c: Config) -> None:
        c = legal(c, ctx, space)
        if c.key() not in seen and len(out) < n:
            seen.add(c.key())
            out.append(c)

    for c in seed_configs or []:
        add(c)
    greedy = {k: max(vals, key=lambda v: (prior.ucb(ctx, k, v), -vals.index(v))) for k, vals in space.items()}
    add(Config(**greedy))
    tries = 0
    while len(out) < n and tries < 500:
        tries += 1
        pick = {}
        for k, vals in space.items():
            w = [min(prior.ucb(ctx, k, v), 3.0) + 0.05 for v in vals]
            pick[k] = rng.choices(vals, weights=w)[0]
        add(Config(**pick))
    return out


def mutate(c: Config, ctx: str, rng: random.Random, space: dict = SPACE) -> Config:
    """One knob moved to a neighbouring value (the evolutionary step for the weaker promoted configurations)."""
    knobs = [k for k, vals in space.items() if len(vals) > 1 and k != "ink"]
    k = rng.choice(knobs)
    vals = space[k]
    i = vals.index(getattr(c, k))
    j = min(len(vals) - 1, max(0, i + rng.choice((-1, 1))))
    if j == i:
        j = (i + 1) % len(vals)
    return legal(c.with_(**{k: vals[j]}), ctx, space)


def rank_key(r: dict) -> tuple:
    """Trials whose silhouette or texture gate fails rank below every trial that passes them; then by score."""
    g = r.get("gates", {})
    shape_ok = all(g.get(k, {}).get("pass", True) for k in ("silhouette", "texture"))
    return (shape_ok, r.get("score") if r.get("score") is not None else -1.0)


def pareto(trials: list[dict]) -> list[dict]:
    """Non-dominated trials: higher score, fewer triangles, fewer bytes, less runtime."""
    ok = [t for t in trials if t.get("score") is not None and t.get("error") is None]

    def dominates(a, b):
        ka = (a["score"], -a.get("triangles", 0), -a.get("bytes", 0), -a.get("seconds", 0))
        kb = (b["score"], -b.get("triangles", 0), -b.get("bytes", 0), -b.get("seconds", 0))
        return all(x >= y for x, y in zip(ka, kb)) and any(x > y for x, y in zip(ka, kb))

    return [t for t in ok if not any(dominates(o, t) for o in ok if o is not t)]


def run_episode(trial: Callable[[Config, int], dict], ctx: str, prior: Prior, budget: int = 14, seed: int = 0,
                space: dict = SPACE, seeds: list[Config] | None = None, log=print) -> dict:
    """One object's search. Returns {trials, best, pareto, stopped}. Updates `prior` in place."""
    rng = random.Random(seed)
    sizes = stage_sizes(budget)
    trials: list[dict] = []
    best_score, since = -math.inf, 0
    stopped = "budget"

    def run(c: Config, rung: int) -> dict:
        nonlocal best_score, since
        r = trial(c, rung)
        r = {"n": len(trials) + 1, "rung": rung, "config": c.to_json(), **r}
        trials.append(r)
        s = r.get("score")
        if s is not None and s > best_score + 1e-9:
            best_score, since = s, 0
        else:
            since += 1
        log(f"trial {r['n']} rung {rung}: score {s} {'(best)' if since == 0 else ''}")
        return r

    rung0 = []
    for c in propose(prior, ctx, sizes[0], rng, space, seeds):
        rung0.append(run(c, 0))
        if len(rung0) >= MIN_RUNG0 and since >= PATIENCE:
            stopped = "patience in rung 0"
            break
    survivors = sorted(rung0, key=rank_key, reverse=True)
    for rung, keep in enumerate(PROMOTE, start=1):
        since = 0  # a new rung (higher resolution) is a new baseline for patience
        promoted = []
        for i, r in enumerate(survivors[:keep]):
            c = Config(**r["config"])
            if rung == 1 and i >= keep // 2:  # the weaker half also tries one mutation
                c = mutate(c, ctx, rng, space)
            promoted.append(run(c, rung))
            if since >= PATIENCE:
                stopped = f"patience in rung {rung}"
                break
        survivors = sorted(promoted, key=rank_key, reverse=True)
        if stopped.startswith("patience in rung") and stopped != "patience in rung 0":
            break
    # rewards for the prior: each trial against the best of its rung (so resolution is not credited to a knob)
    for rung in {t["rung"] for t in trials}:
        rows = [t for t in trials if t["rung"] == rung and t.get("score") is not None]
        top = max((t["score"] for t in rows), default=0) or 1.0
        for t in rows:
            prior.update(ctx, Config(**t["config"]), max(0.0, t["score"]) / top)
    final = [t for t in trials if t.get("score") is not None]
    best = max(final, key=lambda t: (rank_key(t), t["rung"]), default=None)
    return {"trials": trials, "best": best, "pareto": [t["n"] for t in pareto(trials)], "stopped": stopped,
            "budget": budget, "stages": list(sizes)}
