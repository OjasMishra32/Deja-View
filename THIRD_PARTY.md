# Credits

Déjà View was built at SwampHacks XII. Every line of our own code was written during the event. This file credits
the open-source models, libraries, tools, services, media and AI tools the project depends on, as the SwampHacks
rules require.

A licence is given where this repo records it: `pipeline/models.lock.json`, the headers of `pipeline/requirements-*.txt`,
`docs/FLASHWORLD.md`, `pipeline/common/models.py`, the avatar credits in `data/scenes/the-courts/avatar.json`
(written by `pipeline/avatar/run.py`), and each npm package’s own `package.json`. “See upstream” means we have not
recorded the licence; the project’s own licence is the one that applies.

The website shows the same list at `/credits.html` (`web/public/credits.html`). Keep the two in step.

## Models

| Model | Licence | What it does in Déjà View | Source |
|---|---|---|---|
| FlashWorld | Apache-2.0 (code); weights: see upstream | Photo mode: one photo, screenshot or sentence becomes a whole world | github.com/imlixinyang/FlashWorld (rev `424db448`), weights huggingface.co/imlixinyang/FlashWorld |
| Wan2.2-TI2V-5B (VAE, UMT5 text encoder, transformer config) | Apache-2.0 | The video model FlashWorld is built on | `Wan-AI/Wan2.2-TI2V-5B-Diffusers` |
| Qwen2.5-VL-3B-Instruct | See upstream | FlashWorld’s captioner | `Qwen/Qwen2.5-VL-3B-Instruct` |
| AnySplat | MIT (code); weights: see upstream | Many photos become a splat world in one pass | github.com/InternRobotics/AnySplat (rev `5f5e208a`), weights `lhjiang/anysplat` |
| VGGT | See upstream | AnySplat’s geometry backbone | `facebook/VGGT-1B` |
| Depth Anything V2 (Metric Indoor Small and Base) | See upstream | Per-frame depth for Video mode, the depth term when rebuilding a place, and lifting generated fill into 3D | `depth-anything/Depth-Anything-V2-Metric-Indoor-*-hf` |
| DeepLabV3 (torchvision, ResNet-50 and MobileNet) | See upstream | Person masks, so people don’t get baked into the room | torchvision |
| Big LaMa | Apache-2.0 (the TorchScript file from simple-lama-inpainting is Apache-2.0 too) | Inpainting the empty room behind people, and small fills | github.com/advimman/lama, file from github.com/enesmsahin/simple-lama-inpainting |
| Qwen-Image-Edit-2511 | Apache-2.0 | Paints what the photos never saw (the ceiling, tree tops, the sky) and the back of each 3D person | `Qwen/Qwen-Image-Edit-2511` |
| Qwen2.5-VL-7B (Qwen-Image-Edit-2511’s text encoder) | See upstream | Describes what belongs in each gap before it is painted | Ships inside `Qwen/Qwen-Image-Edit-2511` |
| Multi-HMR 2 (NAVER) | **Non-commercial licence** (code and checkpoint), plus BEDLAM and AnnyOne terms | Body pose and shape per frame for the 3D people | github.com/naver/multi-hmr2 (commit `f066532d`) |
| Anny body model (NAVER) | Apache-2.0 code, CC0 assets | The body the 3D people are built on | `anny==0.6.0` |
| DINOv3 backbone code | DINOv3 License | Multi-HMR 2’s image backbone, fetched by `torch.hub` at run time | Meta DINOv3 |
| SAM 2.1 (large and small) | Apache-2.0 | Object masks | `facebook/sam2.1-hiera-large` (`665f8e2a`), `facebook/sam2.1-hiera-small` (`ee5bba1d`) |
| Grounding DINO (tiny) | Apache-2.0 | Text prompts to boxes for the object vocabulary | `IDEA-Research/grounding-dino-tiny` (`a2bb814d`) |
| TRELLIS (image, large) | MIT | Optional image-to-3D props | `microsoft/TRELLIS-image-large` (`25e0d31f`) |

No SMPL-family file is installed or used. Model revisions for the object layer also live in
`pipeline/models.lock.json`; the full reasoning is in `docs/object-layer.md`. Weights are never committed, and the
`pipeline/models/` directory is ignored.

## Libraries and tools

### In the web page and viewer

| Package | Licence | Use |
|---|---|---|
| three.js (`three` 0.186.1, with its GLTFLoader, meshopt decoder and RoomEnvironment add-ons) | MIT | 3D rendering, the landing page headset |
| Spark (`@sparkjsdev/spark` 2.3.1) | MIT | Gaussian splat rendering in the browser and the headset |
| three-mesh-bvh 0.9.15 | MIT | Fast collision and ray tests against the room |
| WebXR, Web Audio, MediaRecorder | Web standards | Headset mode, spatial sound, recording |

### Server

| Package | Licence | Use |
|---|---|---|
| Bun, TypeScript | See upstream | Runtime, server, bundler, tests |
| `@gradio/client` 2.7.1 | ISC | Fallback to the public FlashWorld Hugging Face Space |
| `@google/genai` | See upstream | The Gemini guide service (`integrations/guide`) |

### Pipeline (Python and media)

| Tool | Licence | Use |
|---|---|---|
| gsplat (`nerfstudio-project/gsplat`) | Apache-2.0 | Splat training (MCMC), rendering and gap finding |
| spz (`nianticlabs/spz`) | MIT | The compressed splat file format |
| COLMAP 3.11 | See upstream | Camera poses for photos and clips (SIFT, matching, mapper) |
| PyTorch | BSD-3-Clause | Every model above |
| torchvision | See upstream | DeepLabV3, image ops |
| OpenCV | Apache-2.0 | Image and video processing |
| Open3D | MIT | Geometry and texture baking for the 3D people |
| pygltflib | MIT | glTF export for the 3D people |
| Hugging Face transformers, diffusers, accelerate, hub, safetensors | See upstream | Model loading and inference |
| NumPy, SciPy, Pillow, pillow-heif, plyfile, trimesh, warp-lang, einops | See upstream | Arrays, solvers, images (including HEIC), PLY files, meshes |
| ffmpeg | See upstream | Video decode and encode |
| uv | See upstream | Python environments |

### Roblox

| Tool | Licence | Use |
|---|---|---|
| Roblox Studio and Luau | Roblox terms | The Roblox experience |
| rojo (`rojo-rbx/rojo`) | MPL-2.0 | Roblox build |
| lune (`lune-org/lune`) | MPL-2.0 | Luau test runtime |
| selene | See upstream | Luau lint |

### Testing

| Tool | Licence | Use |
|---|---|---|
| iwer 2.5.0 (Meta’s WebXR emulator) | MIT | Headset tests without a headset |
| playwright-core 1.63.0 | Apache-2.0 | Headless browser checks |
| pytest, `bun test` | See upstream | Test runners |

## Services and hardware

- **UF HiPerGator** (Slurm, RTX PRO 6000 Blackwell GPUs) runs the models.
- **Hugging Face** hosts the model weights and the public FlashWorld Space we fall back to.
- **Google Gemini API** (`gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.8-flash-lite-tts`, voice Sulafat):
  the caption a Photo world is imagined from, the floating labels, spoken answers, narration, and clip notes.
- **Cloudflare Tunnel** (`cloudflared`) for the public link.
- **DeepSpace** for the memory board, live map and notes.
- **Roblox** for the multiplayer places.
- **Auth0** for sign-in in front of the routes that add, delete or drive things.
- Sponsor pieces that are off unless configured: the **Solana** devnet scoreboard, the tab in **Capital One’s Nessie**
  sandbox, and replays recorded into **Tiger Data**. Scripts for a **Vultr** GPU are in `vultr/`.
- **Meta Quest 3S** is the headset we built for.

## Media

| What | By | Licence | Where it is used |
|---|---|---|---|
| “Quest 3S with controllers” 3D model | OG_MATTER, sketchfab.com/3d-models/quest-3s-with-controllers-448519e4ef0b40619592000db3729aaa | CC BY 4.0 (creativecommons.org/licenses/by/4.0/) | The headset on the landing page. Changes: we kept only the headset and gave it new materials to match photos of the real one. |
| “Tilted Towers Tour \| Fortnite OG S2” free-camera footage | woodinjake | See upstream | The Tilted Towers world and the Brick House apartment world (71 frames) |
| Greyscale room sample splat | Public demo file at storage.googleapis.com/forge-dev-public/marble-scenes/ (`scripts/fetch-samples.ts`) | See upstream | The sample world in the gallery |

The Infinity Hall Game Lawn, the giant chess board and the kitchen are our own photos and clips.

## Trademarks

Meta Quest, Roblox and Fortnite are trademarks of their owners; Déjà View is not affiliated with or endorsed by them.

## AI tools used

- **Google Gemini**: inside the product, as listed under Services.
- The generative models under Models make up the parts of each world the camera never saw. The Reality check
  toggle tints everything they imagined.

## Looked at, not used

| Component | Reason |
|---|---|
| `Anttwo/SuGaR` | No clear licence, 3DGS lineage is non-commercial |
| `hbb1/2d-gaussian-splatting` | No clear licence, 3DGS lineage is non-commercial |
| `autonomousvision/gaussian-opacity-fields` | No clear licence, 3DGS lineage is non-commercial |
| `lkeab/gaussian-grouping` | Apache code, but the 3DGS dependency is non-commercial and the build is heavy |
| `Jumpat/SegAnyGAussians` | Apache code, same 3DGS dependency and CUDA build |
| `florinshen/FlashSplat` | No clear licence |
| `apple-aiml-research/ml-hugs` | No clear licence, research use only |
| `ReshotAI/gaussian-splatting-blender-addon` | No licence file |
