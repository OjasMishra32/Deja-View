# ThirdWheel architecture

**Rent Free:** snap one photo of any room (or type a prompt) and an AI world model generates the whole
space, filling in the corners and everything behind you. Walk around it in a Meta Quest 3S or a browser.

**Third Wheel:** film a friend cooking on a propped-up phone. The kitchen becomes a generated walkable world,
and the friend, their hands, the pan and the steam are the real footage lifted into 3D with per-frame AI depth.
It plays back with the original audio while you stand in the room.

**Reconstruct:** many photos of a place become a faithful splat of exactly what was photographed.

```
phone / laptop ──upload──▶ Bun server (Mac) ──ssh socket──▶ HiPerGator GPU (FlashWorld, Video Depth Anything, AnySplat)
                              │   ▲                    └─fallback─▶ FlashWorld Hugging Face Space (photo mode)
                              │   └──────────────────────fallback─▶ local Mac pipeline (video depth on MPS/CPU)
                              ▼
                        data/scenes/<id>/  ──HTTP──▶  viewer (three.js + Spark + WebXR) on Quest 3S / desktop
```

## Repository layout and ownership

| Path | What | Language |
| --- | --- | --- |
| `shared/types.ts` | The data contract. Do not change shapes without updating every consumer. | TS |
| `server/` | Bun HTTP + WebSocket server, scene store, job orchestration, HPG ssh wrapper, HF Space client | TS |
| `web/index.html`, `web/capture.html`, `web/src/gallery.ts`, `web/src/capture.ts`, `web/src/api.ts`, `web/src/styles.css` | Landing page + gallery, upload/capture flow | TS/HTML/CSS |
| `web/view.html`, `web/src/viewer/*` | The viewer: splat world, walking, VR, HUD | TS |
| `web/src/viewer/thirdwheel.ts` | The Third Wheel video layer (RGBD video → 3D) | TS/GLSL |
| `pipeline/` | Python pipelines shared by HPG and the Mac: `tw/` (video → packed RGBD), `plate_room.py`, `flashworld_run.py`, `anysplat_run.py`, `run_job.py` | Python |
| `hpg/` | HiPerGator: env setup, sbatch templates, warm worker | bash/Python |
| `scripts/` | Dev utilities (samples, certs, smoke tests) | TS |
| `tests/` | `bun test` unit tests | TS |
| `data/` (gitignored) | Scenes and their assets | — |

## Coordinate frames

The **viewer frame** is y-up, metres, and a camera at the origin looks down −Z (three.js / OpenGL).
Every `WorldAsset.transform` maps a splat file into it. Examples:

- Marble/World Labs SPZ and most generative and reconstruction outputs are OpenCV style (+Y down, +Z forward).
  A half turn about X fixes that: `quaternion: [1, 0, 0, 0]` (x, y, z, w).
- `floorY: null` tells the viewer to estimate the floor from the splats: the densest low layer of opaque splats.
- `VideoLayer.cameraPose` is an OpenGL camera pose in the viewer frame. Pipelines must make the video camera and
  the room agree: the room is generated from the video's own background plate, so the plate camera and the video
  camera are the same camera.

## Scene directory

```
data/scenes/<id>/
  scene.json        Scene (shared/types.ts)
  input/            uploaded files (00.jpg, 01.jpg ... or video.mp4)
  world.spz|ply     splat world
  tw.mp4            Third Wheel packed video (tw-pack-v1)
  plate.jpg         background plate (Third Wheel)
  thumb.jpg         gallery thumbnail
  log.txt           job log (appended)
```

Bundled samples: `scripts/fetch-samples.ts` creates `data/scenes/sample-*` from public Marble demo splats:
- https://storage.googleapis.com/forge-dev-public/painted_bedroom.spz (7.8 MB)
- https://storage.googleapis.com/forge-dev-public/marble-scenes/greyscale-room.spz (30 MB)

These use `transform.quaternion [1,0,0,0]`, `scale 1`, `floorY null`.

## HTTP API (server/index.ts)

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/` | landing + gallery (`web/index.html`) |
| GET | `/capture` | upload/capture page (`web/capture.html`) |
| GET | `/view` | viewer (`web/view.html`), `?scene=<id>` |
| GET | `/api/health` | `HealthInfo` |
| GET | `/api/scenes` | `Scene[]` newest first |
| GET | `/api/scenes/:id` | `Scene` |
| POST | `/api/scenes` | multipart: `mode` (rentfree, thirdwheel or reconstruct), `name`, optional `prompt`, `files` (one or more). Returns `Scene` (201) |
| POST | `/api/scenes/:id/retry` | re-run a failed scene |
| DELETE | `/api/scenes/:id` | delete |
| GET | `/data/scenes/:id/<file>` | assets, with **HTTP Range support** (the Quest needs it to seek video) and correct MIME types (`.spz` → application/octet-stream, `.mp4` → video/mp4) |
| WS | `/ws` | `ServerEvent` pushes |

## Jobs

A job is a directory with:

```
<jobdir>/
  job.json        { "id", "mode", "prompt"?, "params": {...} }
  input/          the inputs
  out/            outputs; out/scene.json is a JobResult (paths relative to out/)
  progress.json   JobProgress, rewritten as the job runs
  DONE | FAILED   marker files written last
  log.txt
```

Entry point (same on HPG and the Mac): `python pipeline/run_job.py <jobdir>` dispatches on `mode`:

- `rentfree`: `flashworld_run.py` turns one image (and/or a prompt) into `out/world.spz` and `out/thumb.jpg`, and
  writes `world.transform` so the result is y-up and metric-ish, with a spawn at the input camera.
- `reconstruct`: `anysplat_run.py` turns images into `out/world.ply`.
- `thirdwheel`: `tw/` turns the video into `out/tw.mp4` (tw-pack-v1, with the original audio), `out/plate.jpg`
  and `out/thumb.jpg`. The room comes from `flashworld_run.py` on the plate when a GPU is available,
  otherwise from `plate_room.py`, which lifts the plate's own depth into a splat PLY so there is always a room.
  The depth scale of the video and the room must match: align them by comparing the world's depth rendered at the
  plate camera with the video's plate depth.

### Backends (server/jobs.ts picks, in order)

1. **hpg-worker**: a warm GPU job on HiPerGator watches `$HPG_ROOT/jobs/queue/`. Its heartbeat is
   `$HPG_ROOT/jobs/worker.json` (`{time, host, gpu}`, fresh within 90 s). The server rsyncs the job dir into
   `queue/` and the worker claims it by renaming it into `running/`. Models stay loaded, so photo mode takes seconds.
2. **hpg-batch**: `sbatch hpg/job.sbatch <jobdir>` (account/QOS phz3152, 1 GPU; partition from env). The server
   polls `sacct` and `progress.json`, then rsyncs `out/` back.
3. **hf-space** (rentfree only): the public FlashWorld Space `imlixinyang/FlashWorld-Demo-Spark`, via
   `@gradio/client`.
4. **local** (thirdwheel and plate rooms): `.venv` Python on the Mac (MPS or CPU) runs `pipeline/run_job.py`.

All SSH goes through the ControlMaster socket only:
`ssh -S $HPG_SOCKET -o BatchMode=yes -o ControlMaster=no $HPG_USER@$HPG_HOST ...` (rsync: `-e` with the same options).
Never prompt for a password. If the socket is missing, HPG counts as offline.

### HiPerGator layout and rules

```
$HPG_ROOT = /blue/phz3152/sbernalorta/thirdwheel
  repo/        rsynced copy of pipeline/ and hpg/ (the server syncs it before submitting)
  envs/        conda/venv environments (flashworld, video, anysplat)
  models/      Hugging Face cache (HF_HOME) and weights
  jobs/queue|running|done/
```

- This is a **class allocation** (2 GPUs total for the whole group, shared with classmates). Use **one GPU** at a
  time, keep jobs short, cancel idle jobs. Never run heavy work on login nodes: use `srun`/`sbatch` with
  `--account=phz3152 --qos=phz3152`.
- GPUs: `hpg-rtx6000` (RTX PRO 6000 Blackwell, 96 GB, sm_120), `hpg-b200` (B200, sm_100), `hpg-turin` (L4 24 GB,
  sm_89). Blackwell needs PyTorch built for CUDA 12.8 or newer.

## Viewer module contracts (web/src/viewer)

- `app.ts`: boots `view.html`. Reads `?scene=`, fetches the Scene, and builds the renderer, `SparkRenderer`, world,
  physics, controls, HUD, and the video layer when `scene.video` is set.
- `thirdwheel.ts` must export:
  ```ts
  export interface VideoLayerHandle {
    object: THREE.Object3D;          // add to the scene; already placed at video.cameraPose
    video: HTMLVideoElement;         // the source element (owns audio)
    ready: Promise<void>;
    play(): Promise<void>; pause(): void; seek(t: number): void;
    readonly playing: boolean; readonly currentTime: number; readonly duration: number;
    update(dt: number, camera: THREE.Camera): void;   // call every frame
    setOpacity(o: number): void;
    dispose(): void;
  }
  export function createVideoLayer(layer: VideoLayer, baseUrl: string, renderer: THREE.WebGLRenderer): VideoLayerHandle;
  ```
- Video playback needs a user gesture: start it from Enter VR or a play button. Audio comes from the video element.

## Quality bar

- It must **look great**: correct orientation, floor at 0, spawn inside the room facing the content, no black
  void (a tasteful gradient or environment background), soft fade where the world ends, stable frame rate on
  Quest 3S (≤ ~1M splats, foveation), crisp UI.
- You must be able to **walk**: WASD and mouse look on desktop. On Quest: left-stick smooth locomotion, right-stick
  snap turn, teleport arc, floor following, sensible eye height, no walking through walls when there is geometry.
- Errors are visible and actionable in the UI. Nothing crashes on missing optional fields.

## Hackathon rules that bind the code

All code is written during SwampHacks XII (from 8 PM Fri Oct 16). Open-source libraries and models are allowed and
credited in README.md. Never commit secrets. Never push to GitHub.
