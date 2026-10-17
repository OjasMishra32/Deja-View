"""The bake configuration space (the brief's list) and the successive-halving rungs."""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace

SPACE: dict[str, tuple] = {
    "voxel": (0.005, 0.0075, 0.01, 0.015),
    "views": (12, 24, 48),
    "atlas": (1024, 2048),
    "min_component": (0.0005, 0.001, 0.005),
    "simplify": ("none", "light", "strong"),  # smoothing and decimation together
    "chunks": ("one", "floor"),  # one atlas, or one atlas plus a separate floor fill
    "maps": ("off", "light", "strong"),  # normal and AO strength
    "ink": (False, True),  # only ever on for signs and posters
}

# The room shell is metres across, not centimetres: the same knobs with room-sized voxels.
ROOM_SPACE: dict[str, tuple] = {**SPACE, "voxel": (0.01, 0.015, 0.02, 0.03), "ink": (False,)}

# (view resolution, atlas override) per rung: all configs at 512, the best four at 768, the best two at 1024 with a
# 2048 atlas. A rung's atlas of None keeps the configuration's own.
RUNGS = ((512, 1024), (768, 1024), (1024, 2048))
PROMOTE = (4, 2)

TRIANGLES = {"none": 20000, "light": 14000, "strong": 8000}
SMOOTH_ITERS = {"none": 0, "light": 2, "strong": 6}
MAPS = {"off": None, "light": {"normal_strength": 1.0, "ao_into_colour": 0.3},
        "strong": {"normal_strength": 2.5, "ao_into_colour": 0.6}}

# The point of the space nearest to how the current object set was baked (1 cm voxels, 1024 atlas, the room baker's
# cleanup, floor fill kept, no maps). It is always trial 1, so every episode measures the knobs against it. The
# current GLB itself is evaluated separately as the "current" row of the report.
CURRENT_LIKE = {"voxel": 0.01, "views": 24, "atlas": 1024, "min_component": 0.001, "simplify": "none",
                "chunks": "floor", "maps": "off", "ink": False}


@dataclass(frozen=True)
class Config:
    voxel: float = 0.01
    views: int = 24
    atlas: int = 2048
    min_component: float = 0.001
    simplify: str = "light"
    chunks: str = "one"
    maps: str = "light"
    ink: bool = False

    def key(self) -> str:
        return "|".join(f"{k}={v}" for k, v in sorted(asdict(self).items()))

    def to_json(self) -> dict:
        return asdict(self)

    def with_(self, **kw) -> "Config":
        return replace(self, **kw)


def legal(c: Config, kind: str, space: dict = SPACE) -> Config:
    """Clamp a configuration to what makes sense for the object: ink is for flat signs only and is always on there
    (moderation), and every value must be in the space."""
    c = c.with_(ink=(kind == "flat"))
    for k, vals in space.items():
        if getattr(c, k) not in vals:
            raise ValueError(f"{k}={getattr(c, k)} is not in the space {vals}")
    return c


def rung_settings(rung: int) -> tuple[int, int]:
    return RUNGS[min(rung, len(RUNGS) - 1)]


def stage_sizes(budget: int) -> tuple[int, ...]:
    """Trials per rung for a total budget: the brief's 10-15, with four and two promotions."""
    budget = int(max(10, min(15, budget)))
    return (budget - sum(PROMOTE),) + PROMOTE
