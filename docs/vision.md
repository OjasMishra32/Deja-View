# Direction log

Branch: `seb/object-layer`, based on `seb/roblox-games`.
Date: 2026-10-17.
Status: active. This file is the durable record of the captain's direction. Code and
tests are the proof; this file is the reasoning and the sequence.

## 1. Why this exists

The games are playable, but the rooms look much better on the website than in
Roblox. The captain wants to know why, whether the games can be shared across the
website, Roblox, and VR, and whether we can turn the captured rooms into objects
that can be restyled, inhabited, and touched.

The short answer is that the website renders Gaussian splats and Roblox cannot.
Everything else follows from that. The object layer is the keystone that makes the
rest of the ideas possible.

## 2. The captain's direction, in order

1. Close the visual gap between the website and Roblox, or explain it honestly.
2. Make the Roblox games, the website, and VR compatible where that is possible.
3. Build object identities, not just scene reconstruction, so a fridge is a fridge.
4. Use those objects to simplify and reskin the rough scan into clean shapes and
   flat colors that keep the real material: this kitchen's fridge is stainless, so
   the proxy is a light warm grey, not white. Handles come next.
5. Add styles: flat or cartoon first, then retro, dark, and gamified.
6. Put people in the room as NPCs, including a literal Ojas avatar as the ping pong
   bot.
7. Let a phone scan a person into a 3D avatar, with more views captured when the
   system needs them.
8. Make some surroundings interactive: draggable items, openable doors, one hero
   object at a time.
9. Do all of this on a branch, with proper commit history.

The captain also confirmed that this project is not going commercial. That removes
the license blocker for research code. We still prefer permissive dependencies when
they are easier to install and maintain, and we still avoid code with no license at
all because we cannot legally redistribute it.

## 3. The visual gap, settled

The website uses Spark to render the splats directly. Roblox draws parts and
triangle meshes with textures. It has no point-cloud primitive, no custom shader,
and no way to upload a radiance field. The current Roblox room is a baked mesh with
1024 px textures, unlit, while the web scene is 300k to 1M splats with view-dependent
color.

A literal splat port is impossible. The practical options are:

- Mesh with a baked texture. The current pipeline. Best base.
- Billboard impostors or a light-field atlas. Closer to the splat look for a fixed
  viewpoint, not for free movement or VR.
- 360 video on a surface. Good for a memory clip, not a game.
- Cloud-rendered frames. Too slow and too costly.

The quality plan is therefore: better objects, higher-resolution bakes, baked
lighting, and impostor cards for detail. Not a splat runtime.

## 4. Compatibility, settled

- Results and events: yes. `game.result` already crosses the boundary.
- Same live match between web and Roblox: not today. It needs one match service that
  both clients join. Medium work, later.
- Same visuals: no. The website shows splats and Roblox shows mesh. They can share
  object data and styles, not a renderer.
- VR: WebXR on the website for the splat world, Roblox VR for the games. The shared
  layer is the object data and the game rules.

## 5. Object layer

The scan has geometry but no object identity. A splat does not know it is part of a
fridge, and a mesh chunk is a spatial tile. The object layer adds a scene graph.

Pipeline:

1. Render or use keyframes. The kitchen capture has no stored photos, so we render
   views from the splats with the same camera model.
2. Detect objects with Grounding DINO from a small vocabulary.
3. Segment the boxes with SAM 2.1.
4. Project the splats into each view and sample the masks. Keep a splat when enough
   views agree. Reuse `reality_split.project_points`.
5. Take robust bounds and the median color. Fit a box or cylinder.
6. Write `objects.json` in studs, in the same room frame as `roblox-model.json`.
7. Roblox and the web read the same file. The proxy is inflated slightly to cover the
   rough scanned original.

Schema and field rules live in `docs/object-layer.md` section 6.

## 6. Styling

One style spec drives both renderers. The first style is `flat`: one solid body colour taken from the
scan's dominant lit cluster, dark handles, no texture noise. A label palette can be
a deliberate theme, but it is not the default: the real fridge is stainless, not white. The same `objects.json` can then be rendered as
`cartoon`, `retro`, or `dark` with a palette and material change.

Splat stylization is a later experiment. Object-level styling is cleaner, faster, and
consistent across web and Roblox.

## 7. NPCs and avatars

The avatar pipeline already exists: HMR for pose and shape, the Anny body, skinning,
texture, and a skinned GLB with an animation clip.

- First NPC: Ojas as the ping pong bot. Export his avatar, add a paddle and a swing,
  keep the existing bot return logic.
- Live people in the room: replay first. Live pose streaming into Roblox is a later
  step.
- Phone scan: an orbit capture plus a reconstruction step. Minutes per person, with
  consent and deletion. A stylized avatar from a few photos is the demo shortcut.

## 8. Interactions

Splats are static. An openable fridge needs a proxy object with a hinge, and the
surface behind it must be captured or inpainted. LaMa is already available for
inpainting. Start with one hero object against a wall, not every object.

## 9. The sequence

### Phase 0: contract and survey
Done. `docs/object-layer.md`, `THIRD_PARTY.md`, `pipeline/models.lock.json`, mask
lift, Roblox layout. Tests pass.

### Phase 1: producer
In progress. 16 views rendered from the kitchen splats on PACE. Grounding DINO and
SAM 2.1 produced 98 detections. The depth-banded lift, with two-view agreement, gives a clean fridge box of
0.90 by 1.65 by 1.03 m. The trash can also lifts, but it needs a per-label
one-view rule, so it is not in the first object file.

Acceptance: `objects.json` has the hero objects, each with a box, a color, and a
splat count. The boxes sit on the objects in the rendered views.
Remaining: choose the final three labels and add the handle parts.

### Phase 2: Roblox proxy
Build `ObjectLayer` from `objects.json`. It fetches the file, creates parts, applies
the flat style, and hides the proxy when there is no data.

Acceptance: in the test place, the fridge reads as a white box with dark handles, and
the scanned original is hidden.

### Phase 3: web overlay
Draw the same proxies in the web viewer, depth-tested against the splats.

Acceptance: the web scene and the Roblox scene show the same objects in the same
places.

### Phase 4: style pass
Add `cartoon`, `retro`, and `dark` to the same spec. Render a side-by-side comparison.

Acceptance: one scene, four styles, no geometry changes.

### Phase 5: Ojas NPC
Export the avatar, rig a paddle, wire the bot, and show a match.

Acceptance: the ping pong bot is a person, not a cube, and still returns the ball.

### Phase 6: one interaction
An openable cabinet or fridge with a proxy hinge and an inpainted or captured
interior.

Acceptance: the door opens and closes, and the room behind it does not tear.

## 10. Non-goals

- A native splat renderer in Roblox. It does not exist.
- Visual parity by porting splats. It ends in mesh, impostors, or video.
- A live phone scan for the first demo. A stylized avatar comes first.
- Every object interactive. One hero object first.
- Vendoring unlicensed code. Use it as an external tool if it is worth it.

## 11. Decisions

- 2026-10-17: Object layer first. It unlocks reskins, styles, NPC anchors, and
  interactables.
- 2026-10-17: Start with the kitchen, three hero objects, flat style.
- 2026-10-17: Borrow SAM 2.1 and Grounding DINO through Transformers. Write the mask
  lift ourselves.
- 2026-10-17: Do not vendor code with no license. Non-commercial research is allowed
  for this project, but prefer clean installs.
- 2026-10-17: The literal splat port is rejected. Improve the bake and use impostors
  for detail.

## 12. Open questions

- Which three objects matter most in the kitchen: fridge, cabinet, counter, or the
  stove?
- Does the flat style read better with outlines or without?
- For the Ojas bot, is a full body avatar or a stylized head and torso enough for the
  first demo?
- Do we keep the scanned room as the backdrop, or replace whole walls with clean
  geometry?
