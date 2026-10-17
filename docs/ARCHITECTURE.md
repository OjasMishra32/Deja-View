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
| `server/social/` | Presence store (everyone in a scene, 3 s timeout), Roblox map builder service and the presence / Roblox routes | TS |
| `server/integrations/` | DeepSpace presence push + notes relay, the guide relay (`/api/guide/*`), `/describe` for uploads | TS |
| `server/cue.ts`, `server/hotspots.ts`, `server/reality.ts` | Host cues, the stored 3D labels, background reality split for worlds that arrived without it | TS |
| `web/src/viewer/social/`, `web/src/viewer/guide/` | In-viewer ghosts, sticky notes, tag moments, reality check; labels, hold-to-ask, narration | TS |
| `web/index.html`, `web/capture.html`, `web/src/gallery.ts`, `web/src/capture.ts`, `web/src/api.ts`, `web/src/styles.css` | Landing page + gallery, upload/capture flow | TS/HTML/CSS |
| `web/view.html`, `web/src/viewer/*` | The viewer: splat world, walking, VR, HUD | TS |
| `web/src/viewer/thirdwheel.ts` | The Third Wheel video layer (RGBD video → 3D) | TS/GLSL |
| `pipeline/` | Python pipelines shared by HPG and the Mac: `tw/` (video → packed RGBD), `plate_room.py`, `flashworld_run.py`, `anysplat_run.py`, `run_job.py` | Python |
| `hpg/` | HiPerGator: env setup, sbatch templates, warm worker | bash/Python |
| `scripts/` | Dev utilities (samples, certs, smoke tests) | TS |
| `tests/` | `*.test.ts` for `bun test` (server, capture page, viewer, Third Wheel layer); `gpu/` and `pipeline/` are pytest suites for the Python code; `harness/` holds the test servers the browser checks start. See [Tests](#tests) | TS/Python |
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
  input_camera.json the input view's camera in the viewer frame (FlashWorld worlds; the guide places labels with it)
  input_depth.npy   float32 depth of the world rendered at that camera
  world-seen.spz    reality check: the splats the input camera saw (same file frame as the world)
  world-imagined.spz  ... and the ones the world model imagined
  reality.json      {seen, imagined, seenFraction, camera, depth, ...} (pipeline/reality_split.py)
  hotspots.json     stored 3D labels {hotspots:[{label, blurb, x, y, z, u?, v?, source?}], updatedAt}
  roblox-map.json   cached Roblox map (roblox-map-<N>.json for other part budgets); rebuilt when the world changes
```

Every file a job leaves at the top of `out/` is copied into the scene directory (except scene.json, log.txt,
progress.json and the DONE/FAILED markers), so the reality parts, the input camera and depth arrive with the world.
A rebuild whose new world comes without some of them (reality parts, input camera and depth, stored labels) removes the
old ones, so nothing describes the previous world; the server then splits the new world for the reality check itself.

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
| GET | `/host` | the host's status page and cue remote (`web/host.html`) |
| GET | `/api/health` | `HealthInfo` |
| GET | `/api/scenes` | `Scene[]` newest first (every scene response and `/ws` message uses the public shape: `mode` is `photo`, `video` or `sample`, and `stage`, `progress`, `error` are always there; `server/copy.ts` publicScene) |
| GET | `/api/scenes/:id` | `Scene` |
| POST | `/api/scenes` | multipart: `mode` (rentfree, thirdwheel or reconstruct), `name`, optional `prompt`, `files` (one or more). Returns `Scene` (201) |
| POST | `/api/scenes/:id/retry` | re-run a failed scene |
| DELETE | `/api/scenes/:id` | delete |
| GET | `/data/scenes/:id/<file>` | assets, with **HTTP Range support** (the Quest needs it to seek video) and correct MIME types (`.spz` → application/octet-stream, `.mp4` → video/mp4) |
| GET | `/api/scenes/:id/hotspots` | `{hotspots:[{label, blurb, x, y, z, u?, v?, source?}]}` (room-frame metres); `{hotspots:[]}` when none are stored |
| PUT | `/api/scenes/:id/hotspots` | same body; replaces the stored labels and sends `{type:"hotspots"}` on `/ws` |
| GET/POST | `/api/presence/:sceneId` | headset and browser viewers, 4 Hz, metres (contracts 5); POST answers everyone else |
| GET | `/api/roblox/:sceneId/map` | the room as boxes in studs (`?maxParts=`, `?chunk=N` 1-based); 202 while it builds; Photo worlds only (a Video memory answers 404) |
| GET | `/api/roblox/:sceneId/model`, `.../model.glb` | the textured room (`roblox-model.json` + `roblox.glb` from `pipeline/roblox_mesh.py`) and its Open Cloud `assetId` once uploaded (`ROBLOX_API_KEY`, `ROBLOX_CREATOR_ID`); 404 until a model exists and for Video memories |
| POST | `/api/roblox/:sceneId/presence` | a Roblox game server's players (studs) → everyone else in studs |
| POST | `/api/roblox/:sceneId/event` | `tag` / `round` → `{type:"roblox"}` on `/ws` with `t` (and `pos`, `targetName` for a tag) |
| GET/POST | `/api/notes/:sceneId` | notes from the DeepSpace relay (`offline: true` while it is down); POST forwards a headset note (502 `notes offline`) |
| POST | `/api/guide/describe\|hotspots\|narrate\|ask` | forwarded to `GUIDE_URL/<name>` with `scene:{id}` expanded; 502 `guide offline` / 504 with a canned answer |
| GET | `/api/guide/health` | the guide's own health |
| POST | `/api/host/cue` | `{action:"reality"\|"labels", on}` or `{action:"load", sceneId}` → `{type:"cue", ..., at}` on `/ws` |
| GET | `/api/host/status` | everything `/host` checks (GPU, guide, DeepSpace, public link, worlds, people); same access rules as the cue |
| WS | `/ws` | `ServerEvent` pushes (below) |

### WebSocket messages (`shared/types.ts` ServerEvent; contracts 10)

| `type` | Payload | Sent when |
| --- | --- | --- |
| `health` | `health` | first, on connect; then when it changes |
| `scene` | `scene` | any change to any scene |
| `scene_deleted` | `id` | a scene was deleted |
| `roblox` | `sceneId`, `event` (`tag` / `round`, with `t`) | a Roblox moment arrived |
| `note` | `sceneId`, `note` | a note id the relay has not seen before (map or headset) |
| `cue` | `action`, `on?`, `sceneId?`, `by?`, `at` | the host or the bot cued something |
| `hotspots` | `sceneId`, `hotspots` | labels were stored |

### Who may change things

- **Guard** (`server/guard.ts`): POST, PUT and DELETE on `/api/*` (scenes, retry, delete, hotspots, notes, guide)
  pass only from the app's own pages (same Origin), a script with no Origin, or with `THIRDWHEEL_API_TOKEN`
  (`X-DejaView-Token` or `Authorization: Bearer`). `THIRDWHEEL_ALLOWED_ORIGINS` adds origins (the tunnel URL).
  Changes carry no CORS headers; reads answer any origin.
- **Presence and Roblox** keep CORS `*` (phones and the map page post presence). `DV_KEY`, when set, is required as
  `x-dejaview-key` on `/api/roblox/*` and `/api/host/cue` from other machines; this machine skips it unless the request
  came through the tunnel (proxy headers).
- **Lock** (`server/lock.ts`): one server per data folder (`data/server.lock`, `{pid, port, startedAt}`); a second
  one refuses to start, because both would resume and double-run the same jobs. A stale lock is taken over.
- **Read-only mode**: `THIRDWHEEL_READONLY=1` lets a second server run on a locked data folder: it shows scenes and
  answers the live routes (presence is in memory), refuses changes to scenes and labels with 503, and runs no jobs,
  map prewarms or reality splits. Any other extra server uses its own `THIRDWHEEL_DATA` copy.

### The live layer (server/index.ts)

- Presence store → DeepSpace: the forwarder pulls a snapshot of every scene with people at 4 Hz and pushes
  `{sceneId, t, people}` (7 fields each) to `DS_URL/api/ingest` with `X-DejaView-Key: DS_KEY`; one empty push when the
  last person leaves. Notes are read from `DS_URL/api/notes` every 2 s for scenes with people.
- A finished build (status `ready` with a world): the Roblox map is prewarmed, which also bakes the floor plan
  (`topdown.jpg`; `world.topdown`, plus `world.floorY` when null and `world.bounds` when missing, go into
  `scene.json`), the reality split runs if the job left no `reality.json`, and Photo worlds get the guide's greeting
  cached (`/narrate`). At boot every ready world gets the map, floor plan and reality parts it lacks, and a world whose
  caption only says how it was made gets the guide's description of its thumbnail.
- An upload (Photo or Video): before the job starts, the guide describes the photo, or for a clip its first-second
  thumbnail (`/describe`, within 5 s). The caption is
  stored as `scene.caption` (`captionSource: "guide"`), becomes the world model's prompt after the upload's own
  prompt, and outlives the job's generic caption. No guide or a slow one: the world model's own captioner runs.
- Without `DS_URL` or `GUIDE_URL` each piece degrades on its own (no push, empty notes, canned guide lines).

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

## Inputs per mode

- `rentfree` accepts one or more photos **or a video** (game clips, phone clips). With several photos the job uses the
  best one; with a video it picks the sharpest, steadiest frame (variance of the Laplacian, penalise motion) and
  generates from that. A prompt alone (no files) is also valid: FlashWorld supports text-to-world.
- `thirdwheel` accepts one video (best from a still camera). An optional prompt describes the room.
- `reconstruct` accepts 8 or more photos or a video (frames are sampled).

### FlashWorld runner CLI (pipeline/flashworld_run.py)

```
python pipeline/flashworld_run.py (--image IMG | --prompt TEXT) [--prompt TEXT] --out OUTDIR [--progress progress.json]
```
Writes `OUTDIR/world.spz`, `OUTDIR/thumb.jpg` and `OUTDIR/scene.json` (a JobResult with `world`). It also writes
`OUTDIR/input_camera.json` (`{width, height, fx, fy, cx, cy, position, quaternion}` for the input view in the
viewer frame) and `OUTDIR/input_depth.npy` (float32 depth of the world rendered at that camera, in viewer units)
so the Third Wheel pipeline can align the video's depth with the room. It is importable too:
`generate(image=None, prompt=None, out_dir=..., progress=None) -> dict` keeps the model loaded between calls, for the worker.
`python pipeline/anysplat_run.py --images DIR --out OUTDIR` follows the same output convention (`world.ply`).

## Controls (also in the user-facing guide)

Desktop: click to look (pointer lock), WASD walk, Shift run, Space play/pause the video, R back to spawn, F fly mode
(Q/E down/up), M mute, H help, and an Enter VR button. Phones: left-half drag to move, right-half drag to look.
Live layer: T (Space too in Photo worlds) or the mic button: hold and ask the guide; N leave a note; C reality check
(also a top-bar button). Click a label to ask about it.

Headset buttons are split so nothing collides: right hand A play/pause, B back to spawn, trigger on the wrist panel
or a label (ask about it), grip hold to aim a note; left hand X or trigger hold to ask the guide, Y reality check.

Quest 3S (WebXR, `local-floor`): left stick walks relative to the head direction, right stick left/right snaps 30 degrees,
right stick forward aims a teleport arc and releasing teleports onto a valid floor, A play/pause, B back to spawn,
trigger selects UI. Use a short comfort vignette while moving. `?xremu=1` installs the `iwer` WebXR emulator (Quest 3
profile) so XR code paths can be tested in desktop Chrome.

## Ports during development

Main server 8787 (`bun run dev` at a desk; `bun run https` for the Quest and the demo: https 8787 plus plain HTTP 8788,
no hot reload). Throwaway test harnesses: viewer 8790, Third Wheel layer 8791, teammate stand-ins
8794 (live map service, `bun run mock:deepspace`) and 8795 (guide, `bun run mock:guide`; both at once:
`bun run demo:mocks`). Check a port is free on IPv4 and IPv6 before binding. Kill only processes you started.

The public link: `bun run tunnel` starts a cloudflared quick tunnel to the local server (http :8788, else :8787),
writes the `https://<random>.trycloudflare.com` address to `data/public-url.txt` and restarts it if it dies. Install
cloudflared once with `brew install cloudflared`.

## Tests

```bash
bunx tsc --noEmit -p .                            # type-check server, web/src, shared, scripts and tests
bun test tests                                    # TypeScript unit tests (server-boot.test.ts starts the real
                                                  # server on its own data folder and port, against both stand-ins)
VIEWER_E2E=1 bun test tests/viewer-e2e.test.ts    # opt-in: the viewer in headless Chrome (needs Chrome and the samples)
GUIDE_E2E=1 bun test tests/guide-e2e.test.ts      # opt-in: the guide in the viewer (tests/harness/guide-harness.ts)
bun tests/harness/live-smoke.ts                   # the live layer in headless Chrome against a running server started
                                                  # with DS_URL/GUIDE_URL on `bun run demo:mocks`: Roblox ghost, note,
                                                  # TAGGED, reality check, labels, follow-mode cues (data/evidence/wiring)
.venv/bin/python -m pytest tests -q               # both Python suites in one run
.venv/bin/python -m pytest tests/gpu -q           # splat formats, transforms, floor, runners, HPG worker (CPU only)
.venv/bin/python -m pytest tests/pipeline -q      # Third Wheel video pipeline, plate room, run_job.py
```

`scripts/setup-local.sh` creates `.venv` with pytest included. The pipeline tests that build clips skip themselves
when `ffmpeg` is missing. docs/HPG.md lists the GPU-side checks.

To run both Python suites at once, give pytest the `tests` directory (or no path at all), not
`tests/gpu tests/pipeline` as two arguments. Each suite has its own top-level `conftest.py` and no `__init__.py`,
and some test modules import shared helpers with `from conftest import ...`. When both directories are named on the
command line, pytest loads both conftests before it imports any test module, so that import finds the other
suite's conftest and collection stops with an `ImportError`. When it walks `tests`, each conftest is loaded right
before its own suite and the imports resolve. Put any new helper that test modules import in a uniquely named
module beside the conftest instead of in the conftest itself.

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
