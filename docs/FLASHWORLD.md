# FlashWorld and AnySplat: inputs, outputs and coordinate frames

This is the reference for everything that feeds FlashWorld (Rent Free, the Third Wheel room) and AnySplat
(Reconstruct), and for how their splats land in the viewer frame. It was written from the upstream code at:

| Project | Source | Pinned revision | License |
| --- | --- | --- | --- |
| FlashWorld (ICLR 2026) | https://github.com/imlixinyang/FlashWorld | `424db4487de308a39e5137afbe85e7568a96193f` (2026-03-24) | Apache-2.0 |
| FlashWorld weights | https://huggingface.co/imlixinyang/FlashWorld `model.ckpt` | snapshot `6a8e88c6f88678ac098e4c82675f0aee555d6e5d` | |
| Wan2.2 base (VAE, UMT5 text encoder, transformer config) | https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers | main | Apache-2.0 |
| AnySplat | https://github.com/InternRobotics/AnySplat | `5f5e208a7dd57d52e43ea0d553a95eab526e8775` | MIT |
| AnySplat weights | https://huggingface.co/lhjiang/anysplat `model.safetensors` | main | |

Neither project is vendored: `hpg/setup.sh` clones them to `$HPG_ROOT/src/` and our runners import them from
there (`FLASHWORLD_SRC`, `ANYSPLAT_SRC`).

## 1. FlashWorld in one paragraph

FlashWorld is a distilled Wan2.2-5B video diffusion transformer (4 denoising steps) whose decoder emits
pixel-aligned 3D Gaussians for every generated view, with a render-and-re-encode feedback loop that makes the views
3D consistent. You give it **one image and/or a text prompt plus a camera trajectory of N views**; it returns one
Gaussian splat scene that covers everything those N cameras see. The trajectory is the main control we have over
how complete the world is.

- Views: `N = 24` (the only frame count the upstream web UI offers; the model was trained for it).
- Resolution: `480 x 704` (landscape) or `704 x 480` (portrait), `resolution = [24, H, W]`.
- Splats: 2 per pixel at half resolution: `24 x 240 x 352 x 2 = 4,055,040` Gaussians before pruning,
  SH degree 2 (27 colour coefficients). We prune to `<= 1,000,000` for the Quest (section 5).
- Text is always prefixed internally with `"[Static] "`. Image-only requests with an empty prompt are accepted.

### Memory and time (upstream README, single A800)

| Time | GPU memory | Flags |
| --- | --- | --- |
| 8.5 s | 51 GB | none |
| 16.6 s | 30 GB | `--offload_t5` |
| 20 s | 24 GB | `--offload_t5 --offload_transformer_during_vae` |
| 10 min | 9 GB | `--offload_t5 --offload_vae` |

README: 7 s on A100, 4 s on H100. On the RTX PRO 6000 (96 GB) and B200 we run with no offload. On an L4 (24 GB)
`flashworld_run.py --offload auto` turns on `t5+transformer` offload; expect about a minute and a tight fit.
Host RAM peaks around 55-60 GB while loading (fp32 transformer + 21 GB checkpoint + fp32 UMT5), so jobs ask for
80 GB. Model load takes 1-3 minutes from `/blue`, which is why the warm worker exists.

### Weights (all under `HF_HOME=$HPG_ROOT/models`)

| Repo | Files | Size |
| --- | --- | --- |
| `imlixinyang/FlashWorld` | `model.ckpt` | 20.9 GB |
| `Wan-AI/Wan2.2-TI2V-5B-Diffusers` | `transformer/` (loaded, then replaced by the checkpoint) | 20.0 GB |
| | `text_encoder/` (UMT5-XXL) | 11.4 GB |
| | `vae/` | 2.8 GB |
| | `tokenizer/`, `scheduler/`, `model_index.json` | 21 MB |
| `Qwen/Qwen2.5-VL-3B-Instruct` (optional captioner, ours) | all | 7.5 GB |
| `lhjiang/anysplat` | `model.safetensors`, `config.json` | 2.9 GB |
| `facebook/VGGT-1B` (AnySplat's constructor loads it before its own weights) | `model.safetensors`, `config.json` | 5.0 GB |

Total about 71 GB. `hpg/fetch_weights.py` downloads all of it (`hpg/setup.sh weights`).

### Install facts that matter on Blackwell

- Upstream pins `torch==2.6.0` (CUDA 12.4), which has no sm_100/sm_120 kernels. We use `torch==2.8.0`
  and `torchvision==0.23.0` from the `cu128` index. The other pins are kept (`diffusers` at `447e8322f76efea55d4769cd67c372edbf0715b8`), except
  `transformers==4.57.1` instead of the yanked 4.57.0.
- `gsplat` must be built from source (`32f2a54d21c7ecb135320bb02b136b7407ae5712`) against that torch with
  `TORCH_CUDA_ARCH_LIST="8.9;10.0;12.0+PTX"` after `module load cuda/12.8.x` (or newer).
- `app.py` imports `gradio`, `fastapi`, `uvicorn` at module level (only used under `__main__`); they are installed.
  The `spaces` package must **not** be installed: if it imports, `app.mode` becomes `"Spaces"` and the code moves
  models between devices on every call.
- `quant.py` converts the transformer's linear layers to FP8 and uses `torch._scaled_mm` when the device capability
  is `>= (9, 0)`. Our runner probes `_scaled_mm` once at load and switches those layers to the dequantised path if
  the probe fails, so a missing FP8 kernel costs speed rather than a crash.
- The upstream `.spz`/`.ply` exporters are not used. We export ourselves (section 5) because the upstream PLY puts all
  27 SH coefficients in `f_dc_*` (non-standard) and we need pruning plus the transform.

## 2. Request format (CLI JSON, web UI and the Space use the same one)

```json
{
  "image_prompt": "data:image/png;base64,...  |  a file path  |  null or \"\"",
  "text_prompt": "A cozy bedroom with a wooden floor, a white bed and a window.",
  "image_index": 0,
  "resolution": [24, 480, 704],
  "cameras": [
    {"position": [0, 0, 0], "quaternion": [1, 0, 0, 0], "fx": 415.7, "fy": 415.7, "cx": 352, "cy": 240},
    "... 24 entries"
  ]
}
```

- `cameras[i]` is a **camera-to-world pose in the OpenGL / three.js convention**: camera looks down its local -Z,
  +Y is up, +X right. `quaternion` is **[w, x, y, z]** (real part first; the web UI writes
  `[q.w, q.x, q.y, q.z]` from a three.js camera). `position` is the camera centre.
- `fx, fy, cx, cy` are pixels **of the image you send**. The server center-crops the image to the target aspect,
  resizes it to `W x H`, and rescales the intrinsics with the same crop and scale. For text-only requests they are
  pixels of the `W x H` target. Our runner pre-crops and resizes the photo to exactly `W x H` itself, so the server
  side crop is a no-op and the intrinsics we send are in target pixels.
- The upstream web UI uses `fx = fy = 0.5 * H / tan(fov_y / 2)` with `fov_y = 60` degrees by default.
- `image_index` is the trajectory index the image is pinned to. We always use 0 (see section 3).
- If `len(cameras) != N` the server resamples the trajectory (slerp + lerp) to N poses. We always send exactly 24.

`python pipeline/flashworld_run.py --image photo.jpg [--prompt ...] --emit-request request.json` writes exactly this
JSON (with the image embedded as base64 PNG) without loading any model, for the Space backend.

## 3. Output frame (the important part)

FlashWorld normalises the trajectory before generating (`utils.normalize_cameras`):

1. Every pose is re-expressed relative to **`cameras[0]`** (not `image_index`): `c2w_i <- inverse(c2w_0) @ c2w_i`.
2. Translations are divided by `T_norm + 0.01`, where `T_norm = max_i |t_i|` (largest camera distance from camera 0).
3. Gaussians are generated in that normalised frame (`xyz = ray_origin + depth * ray_direction`), and the
   exporter multiplies positions and scales by `T_norm`.

So the exported splats are in **camera 0's own frame, OpenGL axes**: camera 0 sits at the origin looking down -Z,
+Y is camera 0's up, +X its right. Units are the units of the request's `position` values, times
`T_norm / (T_norm + 0.01)` (0.994 for our 1.6 m trajectories). Our exporter multiplies by `T_norm + 0.01` instead,
so our files are exactly in request units.

Consequences:

- A trajectory with no translation at all (`T_norm = 0`) collapses every splat to the origin. All our presets move.
- The SPZ format's native frame is RUB (OpenGL), and the upstream exporter stores positions without conversion.
  Spark renders SPZ positions as stored, and the upstream viewer adds the generated `SplatMesh` to the same three.js
  scene as the cameras with no rotation. **A raw FlashWorld SPZ with the input image at camera 0 already lives in our
  viewer axes: `quaternion [0, 0, 0, 1]`, not the `[1, 0, 0, 0]` used for Marble and AnySplat output.**
- Rotations inside FlashWorld are wxyz (gsplat order); SPZ stores xyzw; our PLY writer uses the standard
  `rot_0..3 = w, x, y, z`.

### Scale

FlashWorld is not metric. The trajectory sets a soft scale: the model must make room for the camera motion, so a
1.6 m walk forward gives a room that is roughly room-sized in metres. We then calibrate from the floor:

- Estimate the floor plane from the splat centres (RANSAC on opaque splats below the camera, normal within 35 degrees
  of camera-up, scored against points below the plane, refined by least squares).
- `scale = camera_height / height_of_input_camera_above_floor`, with `camera_height = 1.45 m` for a hand-held photo
  (job param `cameraHeight`, e.g. about 1.1 m for a phone propped on a kitchen counter). Clamped to [0.3, 3].
- If no confident floor: scale 1 (trajectory units, metres-ish), camera-up taken as world-up, `floorY: null`.

### The transform we write

The runner levels the world (rotates the floor normal onto +Y with the smallest rotation, which keeps the input
camera's heading), scales it, and moves it so the floor is `y = 0` and the input camera stands at `x = z = 0`:

```
world = position + quaternion * (scale * file)
quaternion = R_level            (xyzw; identity when the photo was taken level)
scale      = s
position   = [0, s * h, 0]      (h = input camera height above the floor in file units)
floorY     = 0                  (null when no floor was found)
spawn      = { position: [0, 0, 0], yaw: 0 }   (on the floor under the input camera, facing the photo)
```

`yaw` is radians about +Y, 0 = looking down -Z, positive = turning left (three.js `rotation.y`).

For a **raw FlashWorld SPZ** that did not go through our runner (for example straight from the Space) the safe
default is `{position: [0, 1.45, 0], quaternion: [0, 0, 0, 1], scale: 1}`, `floorY: null`,
`spawn: {position: [0, 0, 0], yaw: 0}`. Better: run the Mac-side post-processor on it, which needs no GPU and gives
the levelled transform, floor, spawn, bounds, thumbnail, `input_camera.json` and `input_depth.npy`:

```
.venv/bin/python pipeline/flashworld_run.py --from-spz downloaded.spz --request request.json --out OUTDIR
```

(`request.json` is the one sent to the Space, from `--emit-request`.)

## 4. Our camera trajectories

All presets have 24 views, view 0 is the input photo at the origin with identity rotation, and every view uses the
photo's intrinsics. Units are metres. Pick one with `--trajectory` or job param `trajectory`; the default can be
changed for the worker with `FLASHWORLD_TRAJECTORY`.

| Preset | Views | Why |
| --- | --- | --- |
| `spin360` (default) | 0-15: turn left in 22.5 degree steps through a full circle while sliding on a 0.3 m radius ring (camera centre 0.3 m behind the input camera), pitch easing to -10 degrees behind you. 16-23: walk 1.6 m forward, panning -20 to +20 degrees, pitch -8 degrees. | You spawn at the input camera, so the walls behind and beside you must exist. The ring adds parallax (a pure spin gives `T_norm = 0`, which breaks export, and no depth cues). The downward pitch fills the floor near your feet, which is what you see in VR. The walk fills the area you will walk into with views at close range. |
| `orbit360` | 0-17: walk a 0.6 m radius loop turning left, looking along the direction of travel. 18-23: walk 1.35 m forward. | Same coverage with motion closer to a hand-held video. |
| `pan180` | Pan to +75 degrees, sweep to -90 degrees, then walk 1.2 m forward. | Front hemisphere only, closest to the training trajectories (the upstream examples pan 20-100 degrees and walk 3-7 units). Use it if 360 views come out smeared. |
| `forward` | Walk 2 m forward with a +/-25 degree pan. | Most conservative. |

The upstream example trajectories never turn more than about 100 degrees, so the 360 presets are outside what the
model saw most in training. That is why the HiPerGator smoke test (`hpg/smoke/smoke_flashworld.py`) generates every
preset from the same photo, writes a 12-view contact sheet for each, and reports hole coverage (the fraction of
pixels with alpha < 0.5 looking around from the spawn). Pick the default from that evidence once the GPU is back.

## 5. What `flashworld_run.py` writes

```
OUTDIR/world.spz          SPZ v3, SH degree 2, <= 1,000,000 splats, file frame = camera 0 (section 3)
OUTDIR/scene.json         JobResult: { world: WorldAsset, thumb: "thumb.jpg", caption }
OUTDIR/thumb.jpg          640 px wide render of the world from the input camera (input photo if rendering fails)
OUTDIR/input_camera.json  the input view, see below
OUTDIR/input_depth.npy    float32 [Hd, Wd] z-depth from the input camera in viewer units (metres-ish); 0 = no data
OUTDIR/request.json       the exact FlashWorld request; image_prompt names input_fw.png
OUTDIR/input_fw.png       the photo as FlashWorld saw it (centre-cropped, 704 x 480 or 480 x 704)
OUTDIR/flashworld.json    diagnostics: timings, T_norm, floor fit, scale, splat counts, caption, preset, FP8 path
```

Pruning: drop non-finite and `opacity < 0.005` splats and far outliers, then keep the top `--max-splats` by
`opacity * sqrt(s1 * s2) / distance_to_nearest_trajectory_camera` (projected footprint as seen from where the
model looked). `WorldAsset.bounds` are the 0.5-99.5 percentiles of opaque splat centres in the viewer frame.

### `input_camera.json`

```json
{
  "width": 4032, "height": 3024,
  "fx": 3022.1, "fy": 3022.1, "cx": 2016.0, "cy": 1512.0,
  "position": [0, 1.45, 0],
  "quaternion": [0.0, 0.0, 0.0, 1.0],
  "depthWidth": 1024, "depthHeight": 768,
  "crop": {"x": 0, "y": 337, "w": 4032, "h": 2749},
  "convention": "OpenGL camera (looks down -Z, +Y up) in the viewer frame; intrinsics in pixels of width x height"
}
```

- `width/height/fx/fy/cx/cy` describe the **original input image** (EXIF-oriented). `crop` is the part FlashWorld
  saw; the generated world extends past it, and the depth map covers the whole image.
- `position`/`quaternion` (xyzw) are the input camera pose in the viewer frame, the same shape as
  `VideoLayer.cameraPose`. For Third Wheel the plate camera is the video camera, so this is the video camera pose.
- `input_depth.npy` is `depthHeight x depthWidth` (same aspect, long side at most 1024). Pixel `(row, col)` of the
  depth map covers image pixel `((col + 0.5) * width / depthWidth - 0.5, (row + 0.5) * height / depthHeight - 0.5)`.
  Values are z-depth along the viewing axis (not ray length), already multiplied by the world scale, 0 where the
  rendered opacity is below 0.5.

Third Wheel alignment: compare this depth with the video's plate depth over pixels where both are valid (a robust
median of the ratio, or a least-squares fit of `1/d`), and scale the video depth to the room.

### Captions

FlashWorld conditions the unseen parts of the world on the text. When a photo comes with no prompt the runner
captions it with `Qwen/Qwen2.5-VL-3B-Instruct` (one or two sentences: place, objects, materials, light; no people)
when the weights are present and the GPU has room, and otherwise uses the neutral
`"A realistic, detailed, static 3D scene with consistent lighting."`. `--caption none` disables it,
`TW_CAPTION_MODEL` picks another model. A user prompt is passed through unchanged.

## 6. The Hugging Face Space fallback

`imlixinyang/FlashWorld-Demo-Spark` is a **static** page (`sdk: static`) and has no API. Its backend, the Gradio
Space **`imlixinyang/FlashWorld-Demo`** (Gradio 6.14, ZeroGPU A10G, `app_gradio.py`), is the one to call. Endpoints:

| Endpoint | Input | Output |
| --- | --- | --- |
| `/gradio_generate` | `json_input`: the request JSON (section 2) **as a string**, image as a base64 data URL | a JSON **string**: `{"success": true, "file_id", "file_path", "file_size", "download_url", "generation_time"}` or `{"error": "..."}` |
| `/download_file` | `file_id` (string) | a `FileData` whose `url` is the `.spz` |
| `/gradio_delete` | `file_id` | removes the server copy (polite after download) |

```ts
const client = await Client.connect('imlixinyang/FlashWorld-Demo', { hf_token });
const r = await client.predict('/gradio_generate', { json_input: JSON.stringify(request) });
const res = JSON.parse(r.data[0]);                // { success, file_id, ... } or { error }
const f = await client.predict('/download_file', { file_id: res.file_id });
const url = f.data[0].url;                         // fetch it -> world.spz
```

The Space exports with an opacity threshold of 0.00025 and no pruning (about 4M splats, 60-120 MB) and `T_norm`
units (section 3). Its SPZ is in camera-0 OpenGL axes like ours. Run it through `--from-spz` on the Mac to prune it
for the Quest and get the levelled transform. ZeroGPU quotas apply per HF account; an `HF_TOKEN` raises them.

## 7. AnySplat (Reconstruct)

AnySplat is a feed-forward 3DGS model on a VGGT backbone: uncalibrated photos in, Gaussians plus camera poses out.

- Input: `[1, V, 3, 448, 448]` RGB in [0, 1]. Upstream resizes the short side to 448 and center-crops a square;
  `anysplat_run.py` does the same. We use up to 32 views by default (`--max-views`).
- Output Gaussians (`model.inference`): `means [G,3]`, `scales [G,3]` (linear), `rotations [G,4]` in **xyzw**
  (scipy order, see `build_covariance(scale, rotation_xyzw)`), `harmonics [G,3,25]` (SH degree 4, channel-major),
  `opacities [G]` **already activated** (0..1; the upstream PLY exporter writes them without the logit, which is a
  bug we avoid).
- Poses: `pred_context_pose["extrinsic"]` is camera-to-world, **OpenCV convention** (+X right, +Y down, +Z forward);
  `["intrinsic"]` is normalised by width and height.
- World frame: VGGT's, i.e. roughly camera 0's OpenCV frame, at VGGT's normalised scale (not metric).

`anysplat_run.py` writes `world.ply` (standard 3DGS PLY: `x y z f_dc_0..2 [f_rest_*] opacity scale_0..2 rot_0..3`,
logit opacity, log scales, wxyz, SH degree 0 by default, `--sh-degree` up to 3; `--spz` also writes `world.spz`
and points `scene.json` at it), plus `thumb.jpg`, `input_camera.json` and `input_depth.npy` for the first view,
`cameras.json` (every input view as an OpenGL pose in the viewer frame) and `anysplat.json` (diagnostics). The transform composes:
camera 0's pose (inverted, then the OpenCV-to-OpenGL half turn about X; for a camera-0-at-origin frame this is the
familiar `[1, 0, 0, 0]`), the floor levelling, and a scale from the camera height. Without a floor the scale makes
the median camera-to-splat distance 2.5 m. Spawn is camera 0 on the floor, facing where it looked.

Dependencies AnySplat imports for inference that are awkward on Blackwell: `xformers` (only
`memory_efficient_attention` with the flash op) and `torch_scatter` (`scatter_add`, `scatter_max`). If either is
missing, or the flash op fails on the GPU, `anysplat_run.py` installs small in-process stand-ins built on
`torch.nn.functional.scaled_dot_product_attention` and `Tensor.scatter_reduce`. `skvideo` and `lightning` are
imported at module level by training code only and get empty stand-ins when absent; `curope` falls back to
AnySplat's own PyTorch RoPE. The model's constructor calls `VGGT.from_pretrained("facebook/VGGT-1B")` before
loading AnySplat's weights, so both must be in the cache. AnySplat code dates from numpy 1.x, so its environment
pins `numpy<2`. `ANYSPLAT_ALLOW_CPU=1` lets it run (very slowly) without a GPU for debugging.

## 8. Same post-processing for every source

`pipeline/splat_io.py` holds the shared parts: PLY and SPZ (v2/v3) read/write in pure numpy, transforms, floor
estimation, bounds, pruning, and a CPU point renderer used for thumbnails and depth when gsplat is not available.
`place_world()` does the levelling/scale/spawn math for both runners and can be used on any splat file:

```
.venv/bin/python pipeline/splat_io.py info data/scenes/<id>/world.spz --quaternion 1,0,0,0
```

prints splat count, SH degree, bounds and the floor fit in the viewer frame. The SPZ writer was checked against
Spark itself: `tests/gpu/spark_fixtures.py` re-encodes the Marble bedroom (v2, v3, and baked into an OpenGL frame) and
a synthetic SH-degree-2 scene, and `bun tests/gpu/spark_check.ts` renders them in headless Chrome; the re-encoded
files render the same as the original.
