# Advisory mesh judge: prompt and rubric

The judge sees one contact sheet. Each row is one held-out camera. The columns are, left to right:
**mesh** (our Roblox mesh rendered from that camera), **splat** (the captured scene, the ground truth),
**mask** (the object's silhouette) and **difference** (red: colour error, green: mask the mesh misses,
blue: mesh outside the mask). The object is a {label}.

Score each axis from 1 (unusable) to 5 (indistinguishable at game distance):

- **shape**: does the mesh have the object's silhouette and parts (doors, handles, knobs, legs)? Missing or extra
  geometry costs most.
- **texture**: are colours, labels and surface detail where they belong, sharp enough, without smears or seams?
- **scale**: is the mesh the same size and in the same place as the splat object?
- **artifacts**: 5 means none. Floating fragments, holes, spikes, stretched texture, background (wall, floor)
  baked into the object, or a ceiling lid all cost.

Then list each concrete problem you can see as a short phrase, and give one overall verdict:
`good`, `usable` or `redo`. You are advisory only: you never approve or reject an upload. A person decides.

Answer with JSON only:
{"shape": 1-5, "texture": 1-5, "scale": 1-5, "artifacts": 1-5, "verdict": "good|usable|redo",
 "problems": ["..."], "summary": "one sentence"}
