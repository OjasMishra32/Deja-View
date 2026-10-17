"""The mega evaluation (team/shivin-reconstruction-loop.md, deliverable 1 and 3).

`evaluate.py` scores one mesh against the held-out splat views of its scene and writes `eval.json`; `gates.py` holds
the hard gates; `judge.py` is the advisory VLM judge. Rendering and image metrics come from `objects.detail`.
Nothing here uploads, approves or edits an approval.
"""
