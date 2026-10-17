# The object layer, splats, and what can actually reach Roblox

Status: design note for `seb/object-layer`. It records the decisions and the survey
behind them. The direction log is `docs/vision.md`. The first code slice is
`pipeline/objects/lift.py`.

## 1. Short verdict

Roblox cannot render Gaussian splats. Its renderer draws parts and triangle meshes
with textures. There is no point-cloud primitive, no custom shader, no custom render
pass, and no way to upload a radiance field.

Every path from splats to Roblox ends in one of four forms:

1. A triangle mesh with a baked texture. This is what `pipeline/roblox_mesh.py`
   already produces.
2. A set of billboards or decals, which is a light-field impostor.
3. A video or an image stream on a surface, which is a fixed view.
4. Nothing, because the data does not fit.

The real choice is therefore not "splats or no splats". It is "which approximation
of the splats" and "how good can the bake get". The object layer is the highest
leverage improvement, because it lets us replace the rough fused shell with clean,
stylized objects while keeping the scanned room as the backdrop.

## 2. Why the data does not fit

A Gaussian splat carries a centre, three scale values, a quaternion, opacity, and
spherical-harmonic colour coefficients. That is roughly 50 to 250 bytes per splat.
Our scenes have 300k to 1M splats, so a raw scene is 30 MB to 250 MB before
compression. Roblox's memory and network budgets are far below that, and its
renderer has no way to rasterize anisotropic 2D Gaussians with per-view colour.

The current `the-courts` model is a 299k triangle mesh in 43 chunks, with a 1024 px
texture per chunk. That is already a heavy Roblox asset. It is a fused shell, so it
keeps the shape and the average colour, and it loses the fine detail and the
view-dependent sparkle that make the web viewer look photographic.

The temporary ping pong table in the test place is a separate issue: it is a block
placeholder until `features.pingPongTable` arrives from the scene model.

## 3. Every option for getting the splat look into Roblox

| Option | What the player sees | Work | Verdict |
|---|---|---|---|
| Mesh bake (today) | A textured room shell at 1k to 2k per chunk | Low, already built | Ship this. Improve texture size, atlas quality, baked light |
| Splat quads as one mesh | A sparse point cloud, 20k splats at most | High | Not worth it. 800k quads is impossible, and a subset looks like confetti |
| Billboard impostors | Camera-facing cards that swap by view | High | Good for plants, clutter, and distant detail. Not a room |
| Light-field atlas | Many pre-rendered views shown on cards or a skybox | Very high | Looks close for a fixed viewpoint. Breaks when walking, and VR is out |
| 360 video on a skybox | A pre-rendered look-around | Low | Good for a memory clip, not for a game world |
| Cloud-rendered frames into `EditableImage` | A live stream of a splat render | Very high | Latency and cost. Not viable for VR or a fast game |
| Blender as a content tool | A cleaned, retopologized, baked GLB | Medium | Useful for hero objects and stylization. Not a runtime |
| Native splat support in Roblox | The real thing | Blocked | Nothing announced. Do not plan around it |

### The Blender question

Blender can import a PLY point cloud, and Geometry Nodes can instance a sphere or a
quad per point for a preview. It can retopologize, unwrap, bake, and export a GLB.
That is useful for hero objects and for a stylized pass. It cannot make Roblox render
splats, because the glTF export is still a mesh with textures.

The popular `ReshotAI/gaussian-splatting-blender-addon` has no license file, so we
will not vendor it. Use Blender itself (GPL) as a tool, and import PLY directly.

## 4. What we borrow, and under which license

The rule: prefer permissive code and models that load through libraries we already
have. Pin every model by revision. Never commit weights.

| Need | Pick | License | How |
|---|---|---|---|
| Class-agnostic masks | `facebook/sam2.1-hiera-large` (and `small` for CPU) | Apache-2.0 | Hugging Face Transformers `Sam2Model` and `Sam2Processor` |
| Text prompts to boxes | `IDEA-Research/grounding-dino-tiny` | Apache-2.0 | Hugging Face Transformers `GroundingDinoForObjectDetection` |
| Mask to splats | Our own projection and vote | Ours | `pipeline/objects/lift.py` |
| Mesh from splats | Our TSDF pipeline | Ours | `pipeline/roblox_mesh.py` |
| Splat rendering | `nerfstudio-project/gsplat` | Apache-2.0 | Already used by `pipeline/splat_io.py` |
| Splat file format | `nianticlabs/spz` | MIT | Already used by `pipeline/splat_io.py` |
| Image to 3D prop (optional) | `microsoft/TRELLIS-image-large` | MIT | HF pipeline, for generated replacements only |
| Inpainting | Big LaMa | Apache-2.0 | Already in `pipeline/requirements-local.txt` |
| Roblox build | `rojo-rbx/rojo` | MPL-2.0 | Already used |
| Luau test runtime | `lune-org/lune` | MPL-2.0 | Already used by the ping pong sim test |

Model revisions are pinned in `pipeline/models.lock.json`.

## 5. What we deliberately do not borrow

These are good research. This project is not commercial, so their licenses are not a
hard blocker. We are still not vendoring them now: the 3DGS mesh variants are heavy
CUDA builds, and the unlicensed projects cannot be redistributed in the repo. If the
bake needs more quality later, we can run SuGaR or 2DGS as an external tool from a
separate environment.

| Project | Why not vendored now |
|---|---|
| `Anttwo/SuGaR` | No clear license, so it cannot be redistributed. Heavy CUDA build |
| `hbb1/2d-gaussian-splatting` | No clear license, same 3DGS lineage and build |
| `autonomousvision/gaussian-opacity-fields` | No clear license, same 3DGS lineage and build |
| `lkeab/gaussian-grouping` | Apache code, but the 3DGS dependency and CUDA extensions are heavy |
| `Jumpat/SegAnyGAussians` | Apache code, same 3DGS dependency and CUDA build |
| `florinshen/FlashSplat` | No clear license |
| `apple-aiml-research/ml-hugs` | No clear license, research use only |
| `ReshotAI/gaussian-splatting-blender-addon` | No license file |

The original 3DGS reference implementation is non-commercial. `gsplat` is a
permissive reimplementation, which is why it is in the pipeline. This project is not
commercial, so the research licenses are allowed. The rule that remains is practical:
do not copy code we cannot redistribute, and do not make the build depend on a CUDA
extension we cannot install reproducibly.

## 6. The object layer

The missing piece is object identity. A splat does not know it is part of a fridge.
A mesh chunk is a spatial tile, not an object. The object layer adds a scene graph on
top of the scan.

`objects.json`, written next to `roblox-model.json`:

```json
{
  "version": 1,
  "sceneId": "kitchen",
  "units": "studs",
  "studsPerMeter": 3.57,
  "frame": "room frame x studsPerMeter, Y up, -Z forward, floor at y = 0",
  "style": "flat",
  "objects": [
    {
      "id": "fridge",
      "label": "fridge",
      "confidence": 0.94,
      "center": [1.2, 4.6, -3.4],
      "size": [2.6, 9.2, 2.4],
      "yaw": 0.0,
      "shape": "box",
      "color": [242, 242, 238],
      "parts": [
        {
          "name": "handle",
          "shape": "cylinder",
          "center": [1.2, 5.4, -2.2],
          "size": [0.18, 2.0, 0.18],
          "color": [44, 44, 48]
        }
      ],
      "affordance": { "kind": "door", "hinge": "left", "openAngle": 100 },
      "source": { "splats": 12400, "mesh": "objects/fridge.glb" }
    }
  ]
}
```

Rules:

- Units are studs in the same room frame as `roblox-model.json`.
- `shape` is `box`, `cylinder`, `sphere`, or `mesh`.
- `parts` use the same room frame as the object, so the handle centre is an absolute point in studs.
- `affordance` is optional and names what the game may animate.
- `source` is provenance, not required to render.
- A missing file means no object layer. The room still renders.

## 7. Pipeline stages

1. Masks. Run Grounding DINO on keyframes for a small vocabulary, then SAM 2 with
   the boxes as prompts. For hinge-level parts such as a handle, run SAM 2 again on
   the object crop.
2. Lift. Project every splat into each keyframe, sample the mask, and keep a splat
   when enough views agree. This reuses the projection in `reality_split.py`.
3. Group. Give each surviving splat an object id. Merge masks with the same label
   and spatial overlap. Resolve overlaps by depth.
4. Describe. Compute a robust 3D box, the dominant colours, and a confidence.
5. Mesh. Optionally crop the world to the object and run the existing TSDF mesh on
   it. Otherwise use a primitive fit.
6. Write `objects.json`. The Roblox and web consumers read it.

## 8. Consumers

Roblox:
- `ObjectLayer` fetches `/api/roblox/:sceneId/objects` (`GET`), and `Rooms` builds it after the room is ready.
- It builds parts for `box`, `cylinder`, and `sphere`, and `MeshPart` for `mesh`.
- It applies the style palette and hides the proxy if it has no data.
- The proxy is inflated by 2 to 5 cm so it covers the rough scanned original.
- Deploy a layer with `BASE=https://... SCENE=kitchen scripts/roblox-objects-upload.sh`.
  The script POSTs the file; the server validates it and checks the DV key when one is set.

Web:
- The viewer adds proxy meshes to the same scene as the splats.
- Depth testing keeps the splats in front and behind correctly.
- The same `objects.json` drives both renderers.

## 9. Styles

Define one `style.json` with palette, flat or gradient shading, outline width,
dither, and shadow strength. Implement it twice: a web shader and a Roblox material
set. The first style is `flat`: solid body colours, dark handles, no texture noise.
Later styles are `retro`, `dark`, and `gamified`.

Splat stylization is possible but harder: colour quantization and toon splatting.
Object-level styling is cleaner and consistent across both renderers.

## 10. NPCs and scanning

The existing `pipeline/avatar` already turns a video into a rigged, textured person
GLB: HMR for pose and shape, the Anny body, skinning, and an animation clip. That is
enough for an Ojas ping pong bot: export his avatar, add a paddle, and reuse the bot
return logic.

Live NPCs of people in the room are a later step. Replay works today. Live pose
streaming into Roblox is possible but needs latency, rigging, and animation blending
work.

A phone body scan is feasible with an orbit capture and a reconstruction step, but
it is minutes per person and needs consent and deletion. For the demo, a stylized
avatar from a few photos gets most of the effect.

## 11. Interactables

Splats are static. A fridge door cannot open in a splat world. The hybrid design is:

- Static splat or baked mesh as the backdrop.
- A proxy object with joints and physics for anything interactive.
- The hidden surface behind the object is captured open and closed, or inpainted with
  LaMa.

This is practical for hero objects against walls. It is not practical for everything.

## 12. Roadmap

1. Survey, model lock, third-party inventory. This commit.
2. Projection helper and mask lift, with tests. Next commit.
3. SAM 2 and Grounding DINO runner on PACE for the kitchen scene.
4. `objects.json` for three hero objects: fridge, cabinet, counter.
5. Roblox `ObjectLayer` proxy builder and web overlay.
6. Flat style pass, then a side-by-side comparison.
7. High-res bake experiment and impostor cards for detail.
8. Ojas NPC bot on the existing avatar pipeline.
9. Phone scan capture flow.
10. Openable hero object, one only.

## 13. Commit policy for borrowed code

- One commit per upstream component.
- The commit message names the upstream URL, the pinned revision, and the license.
- A source header repeats the upstream, the revision, the license, and our changes.
- Weights are never committed. `pipeline/models.lock.json` pins the download.
- Prefer a pinned dependency over a copied file. Copy only when the upstream cannot
  be installed cleanly.

## 14. Asset review and moderation

Roblox moderation scans uploaded images for QR codes, links, contact details, and
promotional text. A teammate was flagged for a QR code in a texture. Never bulk-upload
object assets.

1. `pipeline/objects/preflight.py --glb <glb>` extracts every texture, builds a
   contact sheet, and scans for QR codes and barcodes. A decodable QR or link blocks.
   A pattern hit with an empty payload is a review candidate, not a violation.
2. Inspect the sheet yourself. The fridge's two hits are empty-payload fragments of
   the texture atlas, not a poster or a link.
3. For signs, posters, logos, and text, rebuild with `pipeline/objects/mesh.py --ink 1.2`.
   The ink pass mega-smooths, blurs, posterizes, and grains the texture so it cannot be
   read as a promotion or scanned as a QR code, while keeping the captured colours.
4. Record your decision with `pipeline/objects/review.py --glb <glb> --approve --note "..."`
   or `--deny`. The approval is bound to the file's SHA1.
5. The upload script refuses without a matching approval file. Any change to the GLB
   invalidates the approval.
