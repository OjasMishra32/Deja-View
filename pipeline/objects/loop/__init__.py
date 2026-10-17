"""The closed-loop reconstruction optimizer (team/shivin-reconstruction-loop.md, deliverable 2 and 4).

Each object is one episode: pick a bake configuration, bake, score it on held-out views (`objects.eval`), pick the
next from the score. Successive halving over a 10-15 trial budget, a contextual bandit prior shared across objects,
a patience stop and a Pareto front. `space.py` and `search.py` are pure; `bake.py`, `room.py` and `run.py` drive the
GPU bake on PACE. Nothing here uploads or approves; every new GLB is a new file that needs a person's approval.
"""
