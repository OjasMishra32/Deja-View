# Open-source models and tools we depend on

The open-source models, libraries and tools Déjà View depends on, credited as the SwampHacks rules
require. The full reasoning is in `docs/object-layer.md`.

## In use or pinned

| Component | License | Use | Pin |
|---|---|---|---|
| `facebook/sam2.1-hiera-large` | Apache-2.0 | Object masks | `665f8e2ad61cf5f53d65644ff27c8ee525124610` |
| `facebook/sam2.1-hiera-small` | Apache-2.0 | Object masks, CPU and tests | `ee5bba1d82bb8749febdf90f45e84b687142ba03` |
| `IDEA-Research/grounding-dino-tiny` | Apache-2.0 | Text prompts to boxes | `a2bb814dd30d776dcf7e30523b00659f4f141c71` |
| `microsoft/TRELLIS-image-large` | MIT | Optional image-to-3D props | `25e0d31ffbebe4b5a97464dd851910efc3002d96` |
| `nerfstudio-project/gsplat` | Apache-2.0 | Splat rendering | Python dependency |
| `nianticlabs/spz` | MIT | Splat file format | Python dependency |
| `rojo-rbx/rojo` | MPL-2.0 | Roblox build | Build tool |
| `lune-org/lune` | MPL-2.0 | Luau test runtime | Test tool |

Model revisions also live in `pipeline/models.lock.json`. Weights are never
committed. The `pipeline/models/` directory is ignored.

## Looked at, not used

| Component | Reason |
|---|---|
| `Anttwo/SuGaR` | No clear license, 3DGS lineage is non-commercial |
| `hbb1/2d-gaussian-splatting` | No clear license, 3DGS lineage is non-commercial |
| `autonomousvision/gaussian-opacity-fields` | No clear license, 3DGS lineage is non-commercial |
| `lkeab/gaussian-grouping` | Apache code, but the 3DGS dependency is non-commercial and the build is heavy |
| `Jumpat/SegAnyGAussians` | Apache code, same 3DGS dependency and CUDA build |
| `florinshen/FlashSplat` | No clear license |
| `apple-aiml-research/ml-hugs` | No clear license, research use only |
| `ReshotAI/gaussian-splatting-blender-addon` | No license file |
