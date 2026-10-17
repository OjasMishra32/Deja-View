# Déjà View: setup

How to go from a fresh Mac to a world on the Quest, and then wire in HiPerGator, the teammates' services and the
public link. Skip whatever you don't need: the server runs fine with none of the extras.

## 1. Fresh Mac

```bash
# tools (Homebrew)
brew install oven-sh/bun/bun uv ffmpeg openssl cloudflared
brew install --cask android-platform-tools        # adb, only for the USB route to the Quest

# the app
bun install
cp .env.example .env                              # Bun loads .env automatically; edit as you go
scripts/setup-local.sh                            # .venv (Python 3.12) + model weights into data/models
bun run samples                                   # two sample worlds in data/scenes/sample-*
bun run dev                                       # http://localhost:8787 (hot reload: desktop development only)
```

`scripts/setup-local.sh` installs the Mac pipeline (PyTorch with MPS, transformers, OpenCV and friends) and
prefetches the Depth Anything V2, DeepLabV3 and Big LaMa weights. It stops early if `uv`, `ffmpeg` or `ffprobe` is
missing. `SKIP_MODELS=1` installs without the weights. Run it again
whenever you like, because it skips whatever is already done.

What runs where:

| Mode | Warm HiPerGator worker | Without the warm worker |
| --- | --- | --- |
| Photo | FlashWorld, seconds | A batch Slurm job (it pays the cold model load), then the public FlashWorld Space, then a plate-depth room on the Mac built from the photo |
| Video | Depth on CUDA + a FlashWorld room | A batch Slurm job, else the whole pipeline on the Mac (MPS or CPU) with a plate-depth room |
| Prompt only | FlashWorld text-to-world | A batch Slurm job or the FlashWorld Space. The Mac can't build one (the job says so) |

Check that everything is green:

```bash
bunx tsc --noEmit -p .
bun test tests
.venv/bin/python -m pytest tests -q     # both Python suites (tests/gpu and tests/pipeline)
```

## 2. The Quest 3S

WebXR and the microphone need a secure origin. Pick one route.

**Wi-Fi (HTTPS):**

```bash
bun run cert      # self-signed certificate for localhost, <mac>.local and every LAN IP (rerun if the IP changes)
bun run https     # the demo server: https on :8787 (the Quest) + plain HTTP on :8788 (teammates, curl, the tunnel)
```

`bun run https` runs without hot reload (`NODE_ENV=production`). Hot reload keeps a socket open from every page and
reloads the page whenever that socket drops: a server restart, a Wi-Fi blip or a Quest that slept would throw the
judge out of VR. `bun run https:dev` is the same with hot reload, for working on the viewer at a desk. `HTTP_PORT`
moves the plain-HTTP listener (`HTTP_PORT=0` turns it off).

On the Quest Browser, open the `https://<lan-ip>:8787` address the server prints. At "Your connection is not
private", tap Advanced, then Proceed. You only do this once per certificate.

**USB (plain HTTP):** turn on Developer Mode for the headset in the Meta Horizon phone app, plug in the cable, and allow
USB debugging in the headset. Then run:

```bash
adb reverse tcp:8788 tcp:8788
```

Then, with `bun run https` running, open `http://localhost:8788` on the Quest. Browsers treat localhost as secure, so
plain HTTP is enough and Wi-Fi doesn't matter. Run `adb reverse` again after reconnecting the cable. (Without the https
server, `bun start` serves plain HTTP on :8787 without hot reload: `adb reverse tcp:8787 tcp:8787`.)

To test the headset code without a headset, add `?xremu=1` to a viewer URL in desktop Chrome (a simulated Quest 3).

## 3. HiPerGator

The full guide, with etiquette, layout, stages and troubleshooting, is [`docs/HPG.md`](HPG.md). The short version:

1. **Open the socket once** (the teammate with the login, password + Duo). It stays up for 24 h:
   ```bash
   ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=24h <user>@hpg.rc.ufl.edu
   ```
   The server only ever uses this socket and never prompts. No socket means HiPerGator counts as offline.
2. **First-time setup** (about 1.5 h, mostly unattended): rsync `pipeline/` and `hpg/` to `$HPG_ROOT/repo/`, then on
   HiPerGator run `bash $HPG_ROOT/repo/hpg/setup.sh`. That builds three envs (torch 2.8 + CUDA 12.8, with gsplat built
   for L4, B200 and RTX PRO 6000), downloads about 71 GB of weights, and runs a one-GPU smoke test. Rerunning it
   skips the stages that are already finished.
3. **Run the warm worker** for live builds. From the Mac:
   ```bash
   set -a; source .env; set +a
   hpg() { ssh -S ~/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no "$HPG_USER@$HPG_HOST" bash "$HPG_ROOT/repo/hpg/tw.sh" "$@"; }
   hpg status        # heartbeat, our jobs, the class's GPU use
   hpg start         # one GPU for up to 4 h; the model loads in about 6 min, then "idle"
   hpg logs
   hpg stop          # when you're done (it also exits after 20 idle minutes)
   ```
4. Fill in the `HPG_*` values in `.env` (the defaults are in `.env.example`). The server re-syncs the code before each
   batch job and at most every 5 minutes for worker jobs, so changes to the pipeline reach HiPerGator on their own.
   A worker that is already running keeps its old code until you restart it.

**Etiquette:** this is a class allocation with two GPUs for everyone. Use one at a time, never run anything heavy on
the login node, and stop the worker when you're done.

`THIRDWHEEL_HPG=off` keeps the server away from HiPerGator completely, for example while a teammate is logged out.

## 4. Teammates' services

The server is the hub. The headset never calls the guide or DeepSpace directly: it calls the server, and the server
forwards. Every shape is in [`team/contracts.md`](../team/contracts.md).

> **Status:** the relays behind these variables (`server/social/`, `server/integrations/`) are wired into the
> server. The end-to-end check against the mocks is in progress. On boot, the server prints a `Live:` line saying
> which integrations are on.

| Variable | What | Example |
| --- | --- | --- |
| `GUIDE_URL` | The Gemini guide (`/describe`, `/hotspots`, `/narrate`, `/ask`) | `http://127.0.0.1:8795` |
| `GUIDE_KEY` | Sent as `X-Guide-Key`, if the guide checks one | from the guide's owner, in person |
| `DS_URL` | The DeepSpace worker (presence push to `/api/ingest`, notes at `/api/notes`) | `https://<app>.app.space` |
| `DS_KEY` | Sent as `X-DejaView-Key` to DeepSpace | from the DeepSpace owner, in person |
| `DV_KEY` | When set, `/api/roblox/*` and `/api/host/*` need `x-dejaview-key` (requests from this Mac skip the check) | `openssl rand -hex 24` |

Put them in `.env` and restart the server. Keys never go in code, commits, screenshots or group chats. A URL left
empty turns that integration off, and the server answers politely instead of failing.

### The mocks

Stand-ins for the guide and DeepSpace, so every hop can be tested before the real services exist.

```bash
bun run demo:mocks       # DeepSpace stand-in on :8794 (key dev-ds-key, live map page), guide on :8795
# then, in another terminal, the line it prints:
DS_URL=http://127.0.0.1:8794 DS_KEY=dev-ds-key GUIDE_URL=http://127.0.0.1:8795 THIRDWHEEL_HPG=off bun run dev
# (drop THIRDWHEEL_HPG=off to build worlds on HiPerGator while you test)
```

The mock guide gives canned or keyword answers with real speech (macOS `say`). The mock DeepSpace serves a live
top-down map at `http://127.0.0.1:8794/?dv=http://localhost:8787` (`:8788` when the server runs `bun run https`), with the world's floor plan under it, where you can click to leave notes.
`DS_MOCK_PORT` and `GUIDE_MOCK_PORT` move them. To run just one, use `bun run mock:guide` or `bun run mock:deepspace`
with an explicit `PORT=`, because otherwise the `PORT=8787` from `.env` takes over.

Both mocks have failure modes for drills: `POST /mock/mode` on the guide and `POST /ui/mode` on DeepSpace, with
`{"mode": "slow" | "html" | ...}` (the file headers list them all). Mocks are for rehearsal only. If one ever ends up
on stage, say so.

## 5. The public link

Roblox game servers, the DeepSpace page and judges' phones can't reach a laptop on campus Wi-Fi, so they use a
Cloudflare tunnel:

```bash
bun run tunnel
```

The script exposes the first local server that answers (`http://localhost:8788`, then `:8787` over http, then https).
It prints `https://<random>.trycloudflare.com`, saves it to `data/public-url.txt`, and restarts the tunnel when it
drops or stops answering for about 2 minutes. Things to know:

- A quick tunnel gets a **new address on every start.** Post it in the team chat, then update the Roblox base
  (`dejaview_base`) and the DeepSpace base (`dvBase`). No redeploy is needed.
- **The team's fixed domain** (Seb makes the tunnel in the Cloudflare Zero Trust dashboard with the public hostname
  routed to service HTTP, URL `localhost:8788`, and sends the token privately): save the token in a file outside the
  repo and run

  ```bash
  printf '%s' '<token>' > ~/.dejaview-tunnel-token && chmod 600 ~/.dejaview-tunnel-token
  TUNNEL_TOKEN_FILE=~/.dejaview-tunnel-token TUNNEL_HOSTNAME=<the domain> bun run tunnel
  ```

  The script runs `cloudflared tunnel run` with the token in cloudflared's own `TUNNEL_TOKEN` variable (never on the
  command line), keeps the watchdog and the restarts, and writes `https://<the domain>` to `data/public-url.txt` for
  `/host`. The address never changes, so Roblox and DeepSpace set it once. This path hasn't run live yet.
- A tunnel made on this Mac instead (`cloudflared tunnel login` + `tunnel create`):
  `TUNNEL_NAME=<tunnel> TUNNEL_HOSTNAME=<host> bun run tunnel`.
- Browser pages on the public link that change things (uploads from a judge's phone) need
  `THIRDWHEEL_ALLOWED_ORIGINS=https://<that host>` on the server. Reads work from anywhere.
- Don't use free ngrok: Roblox polling alone would burn through its monthly request limit in under two hours.

## 6. Other server settings

| Variable | Effect |
| --- | --- |
| `PORT` | Main port (default 8787) |
| `THIRDWHEEL_DATA` | Data folder (default `data/`): scenes, jobs, lock, public URL |
| `THIRDWHEEL_BACKENDS` | Backend order, for example `local,hf-space` (default `hpg-worker,hpg-batch,hf-space,local`) |
| `THIRDWHEEL_LOCAL_FALLBACK=0` | Fail a Photo job with no GPU instead of building a plate-depth room locally |
| `THIRDWHEEL_API_TOKEN` | Scripts and other origins must send `X-DejaView-Token` (or `Authorization: Bearer`) to change things. Leave it unset unless every client sends it |
| `THIRDWHEEL_ALLOWED_ORIGINS` | Extra origins allowed to upload, retry or delete, comma separated |
| `THIRDWHEEL_READONLY=1` | Lets a second server share a data folder that another one owns: it shows scenes and runs nothing |
| `HF_TOKEN` | Raises the free GPU quota of the FlashWorld Space fallback |

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| **The Quest can't reach the Mac** | Same Wi-Fi network? Campus Wi-Fi often blocks device-to-device traffic: use a phone hotspot, or skip Wi-Fi entirely with USB and `adb reverse tcp:8788 tcp:8788` (with `bun run https` running). |
| ...and Cloudflare WARP or a VPN is on | Turn it off, or allow local network access in its settings. A VPN can also add an address the server prints as a "LAN" URL, so use the `192.168.x.x` or `10.x.x.x` one. |
| ...and the macOS firewall is on | System Settings > Network > Firewall: allow incoming connections for `bun`. |
| **No Enter VR button, or the mic never asks** | WebXR and the microphone need HTTPS or localhost. Use `bun run https` with the certificate accepted, or `adb reverse tcp:8788 tcp:8788` with `http://localhost:8788`. Plain `http://<lan-ip>` won't work. |
| Certificate warning every time, or the page won't load over HTTPS | The Mac's IP changed: `bun run cert`, restart `bun run https`, and accept the certificate again (`bun run cert --force` makes a fresh one). |
| **"Another Déjà View server (pid ...) is already using .../data"** | Only one server may own a data folder (two would run the same jobs twice). Stop the other one, give this one its own `THIRDWHEEL_DATA`, or start it with `THIRDWHEEL_READONLY=1` to only show scenes. If nothing else is running, delete `data/server.lock`. |
| An upload returns "This action only works from the Déjà View app." | The write guard refused it. From a browser on another origin (the tunnel URL), add that origin to `THIRDWHEEL_ALLOWED_ORIGINS`. From a script while `THIRDWHEEL_API_TOKEN` is set, send `X-DejaView-Token`. |
| A Photo job waits forever, or is slow | No warm worker: run `hpg status` / `hpg start`. Without one, every batch job pays for a cold model load (minutes). |
| "No GPU is free to build this right now" | Nothing could start the job. HiPerGator is offline (the socket expired, so log in again), the Space is unavailable or out of quota (set `HF_TOKEN`), and the Mac pipeline isn't installed (`scripts/setup-local.sh`). |
| The video plays with no sound | Browsers need a tap first. Press Play (or `A` in the headset). |
| An HTML page comes back instead of JSON from the public link | The tunnel or the Mac is down. The tunnel script restarts itself, so wait a few seconds. |
| The tunnel won't start | `brew install cloudflared`. If the server isn't up yet, the link starts working as soon as it is. |
