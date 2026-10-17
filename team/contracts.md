# Déjà View: integration contracts

This is the single source of truth for every place two pieces of the demo talk to each other. If a brief and this
file disagree, this file wins. Tell everyone in the team chat when you find a disagreement, and Ojasva fixes it here.

Read `plan.md` for the story. Then read this for the wiring. Mode names: what `plan.md` calls **Photo** is the API mode
`rentfree`, and **Video** is `thirdwheel`. The API values do not change. Each brief (`shivin.md`, `brianna.md`, `seb.md`) has the
build details for one piece.

Checked against the server code on Fri Oct 16, ~11 PM: what exists today is listed in section 4, and everything else
here is still to be built.

---

## 1. The whole system on one page

```
                         ┌──────────────────────── Ojasva's Mac (the demo Mac) ────────────────────────┐
 table iPhone            │                                                                              │
 (group chat) ─iMessage─▶│ Photon bot (Seb, Bun) ──POST /api/scenes, /api/host/cue──┐                  │
                         │                                                          ▼                  │
                         │  guide (Brianna, Node :8795) ◀──/describe /prepare──  Déjà View server      │
                         │      │  ▲                      /narrate /ask /speak   (Bun)                  │
                         │      │  └──────────────────────────/hotspots────────  :8787 https (Quest)   │
                         │      ▼                                               :8788 http (machines)  │
                         │   Gemini API                                            │   ▲  ▲            │
                         │                                     cloudflared ────────┘   │  │            │
                         └─────────────────────────────────────────│───────────────────│──│────────────┘
                                                                   │ public https BASE │  │ LAN https
   Roblox game servers (Shivin) ──/api/roblox/*──────────────────▶│                   │  │
   DeepSpace page (Seb) ──GET /api/scenes, WS /ws, POST /api/notes─▶│                  │  │
   Judges' phones / browsers ──/view──────────────────────────────▶│                   │  │
                                                                                       │  │
   DeepSpace worker (Seb) ◀──POST /api/ingest (4 Hz presence)──────────────────────────┘  │
                                                                                          │
   Quest 3S viewer (Ojasva) ──/view, /api/presence, /api/guide/*, WS /ws──────────────────┘
```

Who calls whom (nobody else calls anybody):

| Caller | Callee | What | Auth |
| --- | --- | --- | --- |
| Quest / browser viewer | Déjà View | page, assets, presence, guide proxy, notes, hotspots, WS | none |
| Roblox game server | Déjà View `/api/roblox/*` | rooms, maps, presence, events | `x-dejaview-key: <DV_KEY>` |
| Photon bot | Déjà View | upload, watch progress, thumbnail, cue the headset | `x-dejaview-key: <DV_KEY>` (not needed from localhost) |
| DeepSpace page (browser) | Déjà View (public BASE) | scene list, WS events, thumbnails, top-down image, hotspots, **post notes** | none (CORS `*`) |
| Déjà View | guide (Brianna) | describe, prepare, narrate, ask, speak, hotspots | `X-Guide-Key: <GUIDE_KEY>` |
| Déjà View | DeepSpace worker | presence snapshots (and optional tag events) | `X-DejaView-Key: <DS_INGEST_KEY>` |
| guide | Gemini | everything AI | Brianna's `GEMINI_API_KEY` |
| bot | Photon | messages | Seb's Photon project ID and secret |

Nothing ever calls Roblox. Nothing calls the bot. The headset never calls the guide or DeepSpace directly.

The bot runs on the demo Mac unless Seb's group-chat test picks Photon's local provider (`seb.md` 2.4, Plan B), which
needs a Mac signed into Messages as the bot. If that is a different Mac, the bot uses `BASE` instead of
`http://localhost:8788` and sends `DV_KEY` on the cue.

---

## 2. Network, ports, URLs and keys

### 2.1 Ports and URLs

| Name | Value | Who uses it |
| --- | --- | --- |
| Déjà View, Quest port | `https://<mac-lan-ip>:8787` (self-signed; accept the certificate once in the Quest Browser) | the headset in the demo (no internet needed for the core) |
| Déjà View, machine port (**new**) | `http://<mac-lan-ip>:8788`, plain HTTP, same process, same data, same WS events | teammates on the LAN, the bot, `cloudflared`, curl. No `-k`, and Node's `fetch` works |
| Public `BASE` | `https://<host>` from a **Cloudflare Tunnel** to `http://localhost:8788` | Roblox, DeepSpace pages, judges' phones, links in bot replies |
| guide | `http://127.0.0.1:8795` on the demo Mac (`http://<brianna-ip>:8795` while building) | only Déjà View |
| DeepSpace app | `https://<app>.app.space` (Seb picks the name tonight, for example `dejaview-live`); local dev `http://localhost:5173` | the table laptop, invites, the ingest target |
| Ports to avoid | 8790, 8791 (Ojasva's throwaway test harnesses) | |

Rules for the public link:
- **Never free ngrok.** Its free plan allows 20,000 requests a month (https://ngrok.com/docs/pricing-limits/free-plan-limits);
  Roblox polling alone makes about 14,400 an hour.
- **Named tunnel preferred** (stable hostname, needs a domain on Cloudflare). **Quick tunnel fallback:**
  `cloudflared tunnel --url http://localhost:8788` prints a new `https://<random>.trycloudflare.com` every run, allows
  at most 200 in-flight requests, has no uptime guarantee and does not support SSE
  (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
  We use no SSE. WebSockets through a quick tunnel are not documented there: Seb tests `wss://BASE/ws` on Saturday
  morning, and his gallery falls back to polling.
- **When the hostname changes**, Ojasva posts the new `BASE` in the team chat (it is not a secret) and each piece
  updates it at runtime, with no redeploy: Shivin sets the Roblox Experience Config `dejaview_base`; Seb sets `dvBase`
  on his DeepSpace `/admin` page and `DV_PUBLIC` in the bot's `.env` (restart the bot). The Quest uses the LAN, so it is
  not affected.

### 2.2 Keys (all random strings, `openssl rand -hex 24`; handed over in person or by DM, never in code or group chats)

| Key | Made by | Sent by | Header | Checked by |
| --- | --- | --- | --- | --- |
| `DV_KEY` | Ojasva | Roblox (Roblox Secret `dejaview_key`), the bot (`.env` `DV_KEY`) | `x-dejaview-key` | Déjà View, on `/api/roblox/*` and `/api/host/*`. Enforced only when the env var is set. Requests from `127.0.0.1` skip the check |
| `GUIDE_KEY` | Brianna | Déjà View (env `GUIDE_KEY`) | `X-Guide-Key` | the guide, on everything except `GET /health` |
| `DS_INGEST_KEY` | Seb (`deepspace secrets set DEJAVIEW_INGEST_KEY=...`) | Déjà View (env `DS_INGEST_KEY`) | `X-DejaView-Key` | the DeepSpace worker. It refuses everything if the secret is unset |
| `GEMINI_API_KEY` | Brianna | the guide only | | Google |
| Photon project ID and secret | Seb | the bot only | | Photon |

`DV_KEY` and `DS_INGEST_KEY` travel in headers with the same name in opposite directions. They are different
secrets. Header names are case-insensitive. Roblox sends lowercase because HTTP/2 requires lowercase header names.

### 2.3 Environment on the Déjà View server (demo values)

```
HTTP_PORT=8788
DV_KEY=<random>
GUIDE_URL=http://127.0.0.1:8795
GUIDE_KEY=<from Brianna>
DS_INGEST_URL=https://dejaview-live.app.space/api/ingest
DS_INGEST_KEY=<from Seb>
DS_EVENT_URL=https://dejaview-live.app.space/api/event      # optional (tag flashes on the map)
```

### 2.4 CORS

The server already sends `Access-Control-Allow-Origin: *` and answers `OPTIONS` with 204 on `/api/*` and `/data/*`
(`server/files.ts`). Only browsers need it (the DeepSpace page and judges' phones). Keep it on every new route.
Allowed request headers today: `Range, Content-Type, If-None-Match, If-Range, If-Modified-Since`. That is enough,
because no browser sends a key.

---

## 3. Shared conventions (every piece uses these)

### 3.1 The room frame (metres)

Everything in metres (presence, notes, hotspots, tag positions, bounds) is in the **room frame**:

- the viewer frame of `docs/ARCHITECTURE.md` (Y up, metres, right-handed, a camera at the origin looks down −Z),
- shifted **down by the scene's `floorY`, so the floor is at y = 0**. This is exactly the three.js world frame the
  viewer uses at runtime: it sets `content.position.y = -floorY`. x and z are the same as in `scene.json`; only y
  moves.

So: `y_room = y_scene - floorY`. A person standing on the floor has `y = 0`. A standing head is at about `y = 1.6`.

Floor and bounds must be the same number everywhere. When the server bakes the Roblox map for a scene (section 5.3),
it **writes `world.floorY` into `scene.json` if it was `null`** (using the viewer's own rule: the densest low layer of
opaque splats), and writes `world.bounds` if it was missing. The viewer then uses the stored `floorY`, so the headset,
Roblox and the DeepSpace map agree to the centimetre. `world.bounds` stays in the scene frame (its y values include
`floorY`); its x and z are what the map and notes use.

### 3.2 Roblox studs

`studs = metres_room × studsPerMeter`, axis for axis (Roblox is also right-handed, Y up, −Z forward). The default is
`studsPerMeter = 4.0`, set per scene in the map response. Only the Déjà View server converts. Roblox sends and
receives studs only, everyone else sends and receives metres only.

### 3.3 People

| Field | Meaning |
| --- | --- |
| `id` | `quest-1` (headset; `quest-2` if there is a second), `rbx-<Roblox UserId>`, `web-<8 hex chars>` (a browser viewer, kept in `sessionStorage`) |
| `name` | display name, at most 40 characters |
| `kind` | `vr`, `roblox` or `web` |
| `x, y, z` | the person's **feet**, on the floor under them (room frame, or studs for Roblox) |
| `yaw` | radians about +Y, the same as three.js `rotation.y` and Roblox `CFrame.Angles(0, yaw, 0)`: **0 faces −Z, positive turns left** (counter-clockwise seen from above). Facing direction = `(−sin yaw, −cos yaw)` in (x, z) |
| `head` | optional `[x, y, z]`, eye position (VR only) |
| `hands` | optional `[[x, y, z], [x, y, z]]`, left then right (VR only); may be missing or `null` |
| `state` | optional, Roblox only: `playing`, `caught`, `out`, `idle` |
| `t` | when the server last heard from this person (server Unix seconds, float) |

An `id` is in one scene at a time: posting it to a new scene removes it from the old one. Anyone silent for **3 s** is
dropped.

### 3.4 Everything else

- **Times:** `t` and `at` are Unix seconds (floats) on the Déjà View server's clock. Durations are seconds. `ms`
  fields are milliseconds. ISO strings (`createdAt`) are UTC.
- **Rate:** every position stream is **4 Hz** (every 250 ms). Everyone renders other people **0.3 to 0.35 s in the past**
  and interpolates between snapshots (yaw the short way round). Nobody teleports dots.
- **Scene ids:** `^[a-z0-9][a-z0-9-]{0,95}$` (`server/store.ts`). Every validator uses this.
- **Errors:** JSON `{ "error": "<sentence a person understands>" }` with a 4xx or 5xx status. An HTML body instead of
  JSON (a Cloudflare error page, usually 502 or 530) means **the tunnel or the Mac is down**: back off and retry.
- **WebSocket:** `/ws` sends JSON messages with a `type`. **Every client ignores types it does not know.**
- **Look:** dark UI, one acid-lime accent **`#C6FF3D`**, bold type. (The site's `web/src/styles.css` still uses
  `#d4ff3a`; Ojasva switches it to `#C6FF3D` so everything matches.)

---

## 4. What exists today (in the repo, Fri 11 PM)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | `HealthInfo` |
| GET | `/api/scenes` | `Scene[]`, newest first, **including failed scenes** (filter `status === "ready"`) |
| GET | `/api/scenes/:id` | `Scene` (`shared/types.ts`): `id, name, mode, status, stage, progress, error, thumb, input.files, input.prompt, world{file, transform, floorY, spawn, bounds?}, video?, caption?` |
| POST | `/api/scenes` | multipart `mode` (`rentfree`, `thirdwheel`, `reconstruct`), `name`, `prompt`, `files` (repeat the field per file; JPEG, PNG, HEIC/HEIF, MOV/MP4). JSON `{mode, prompt}` also works for prompt-only. 201 + `Scene`. 400/413/415/500 with `{error}`. **No auth today** |
| POST | `/api/scenes/:id/retry` | re-run a failed scene |
| DELETE | `/api/scenes/:id` | delete (samples need `?force=1`) |
| GET | `/data/scenes/:id/<path>` | files, nested paths allowed, Range support, CORS `*` |
| GET | `/view?scene=<id>` | the viewer (Quest, desktop, phone) |
| WS | `/ws` | `{type:"health", health}` first, then `{type:"scene", scene}` on every change, `{type:"scene_deleted", id}` |

The upload already writes `thumb.jpg` (from the photo, or from the video at 25%) before the GPU job starts. Bundled
samples have `floorY: null`, no `bounds` and no `thumb`. `test-tw-local` has `floorY -1.25`, `bounds`, a
40 s `input/video.mp4` and `thumb.jpg`.

Nothing in sections 5 and 6 exists yet.

---

## 5. Déjà View server: what Ojasva builds (with deadlines)

### 5.1 Plain-HTTP second listener on :8788 (Fri night, 20 min)

Start a second `Bun.serve` in the same process with the same handlers and no TLS, on `HTTP_PORT` (8788). Publish
every WS event to both servers, so a note posted through the tunnel reaches the headset on 8787. Keep 8787 on https for
the Quest (WebXR and the mic need a secure origin over the LAN).

### 5.2 Public tunnel (Sat 12 PM, no later than 4 PM)

`cloudflared` to `http://localhost:8788`. It must pass `/api/*`, `/data/*`, `/view`, `/ws` (as `wss`). Post `BASE` in
the team chat. DM `DV_KEY` to Shivin and Seb.

### 5.3 Scene additions: floor, bounds, top-down image, caption, imagined (Sat 4 PM)

`scene.json` gains these (all optional for old readers):

```json
{
  "caption": "Sunny dorm room. Closet, fridge and door imagined behind you.",
  "imagined": ["closet with mirror doors", "mini fridge", "hallway door"],
  "world": {
    "floorY": -1.25,
    "bounds": { "min": [-2.30, -1.25, -3.48], "max": [1.75, 1.35, 1.80] },
    "topdown": { "file": "topdown.jpg", "min": [-2.30, -3.48], "max": [1.75, 1.80] }
  }
}
```

- `topdown.jpg`: an orthographic view from above, with the ceiling cut off (nothing above 2.1 m in the room frame),
  covering exactly `topdown.min` to `topdown.max` in (x, z). Image right = +X, image down = +Z (so forward, −Z, is
  up). About 100 px per metre, at most 1024 px on the long side. Made from the same voxel grid as the Roblox map
  (the colour of the highest voxel in each column), so it costs almost nothing extra. **It is required for the
  three demo worlds:** it is how Brianna knows where the couch is when she leaves the note at 1:45.
- `floorY` and `bounds` are written by the map bake (section 3.1).
- `caption` and `imagined` come from `/describe` (section 5.9).

### 5.4 Presence spine (Sat 12 PM)

In-memory store keyed by person `id`: `{sceneId, person, t}`. Every other presence feature reads it.

**`POST /api/presence/<sceneId>`**: the viewer (headset or browser) posts its own pose 4 times a second, in metres.

```json
{ "id": "quest-1", "name": "Judge", "kind": "vr",
  "x": 0.42, "y": 0, "z": -1.10, "yaw": 0.30,
  "head": [0.42, 1.62, -1.10],
  "hands": [[0.20, 1.21, -1.40], [0.65, 1.25, -1.35]] }
```

`200 OK`, everyone else in that scene (the poster is left out), so the viewer gets ghosts with no second call:

```json
{ "t": 1760715600.31,
  "people": [
    { "id": "rbx-12345", "name": "shivin", "kind": "roblox", "t": 1760715600.20, "server": "8b1c0e3a-...",
      "x": 1.05, "y": 0, "z": -0.38, "yaw": 1.57, "state": "playing" },
    { "id": "web-7f3a19c2", "name": "Maya", "kind": "web", "t": 1760715599.95, "x": -1.0, "y": 0, "z": 0.8, "yaw": 3.1 } ] }
```

Errors: 400 (`{error:"x must be a finite number"}`, unknown `kind`, name over 40 characters), 404 unknown scene.

**`GET /api/presence/<sceneId>`**: everyone in the scene, same entry shape (metres), plus `t`.

**`GET /api/presence`**: an overview.

```json
{ "t": 1760715600.31,
  "active": { "sceneId": "game-night-k3x9a", "name": "Game night" },
  "scenes": [ { "sceneId": "game-night-k3x9a", "people": 3, "vr": 1, "roblox": 2, "web": 0 } ] }
```

`active` is the scene of the `vr` person heard most recently (within 3 s), or `null`. Roblox follow mode uses it.

### 5.5 Roblox endpoints (studs; `x-dejaview-key` required when `DV_KEY` is set)

Full field-by-field contract with Luau notes: `shivin.md` section 5. Summary of what the server must do:

**`GET /api/roblox/rooms`** (Sat 12 PM)

```json
{ "t": 1760715600.2,
  "active": { "sceneId": "game-night-k3x9a", "name": "Game night" },
  "rooms": [
    { "id": "game-night-k3x9a", "name": "Game night", "mode": "thirdwheel", "createdAt": "2026-10-17T14:02:11Z",
      "map": "ready", "parts": 5821, "people": 1,
      "swatch": [[120,104,90],[220,214,200],[60,70,90],[200,160,90]] } ] }
```

Ready scenes only, newest first, at most 12. `map` is `ready`, `building` or `failed`. `people` counts every kind.
`swatch` = 4 dominant colours of the map (RGB 0 to 255), `[]` while building.

**`GET /api/roblox/<sceneId>/map?chunk=N&maxParts=M`** (two samples by Sat 12 PM; every new ready scene within
10 s, automatically, by Sat 4 PM)

```json
{ "v": 1, "sceneId": "game-night-k3x9a", "name": "Game night",
  "studsPerMeter": 4.0,
  "bounds": { "min": [-9.2, -1, -13.9], "max": [7.0, 10.4, 7.2] },
  "ceilingY": 10.4,
  "spawns": [[0, 0, 6], [3, 0, 4], [-3, 0, 4]], "spawnYaw": 3.14159,
  "vrSpawn": [0, 0, 0], "floorColor": [120, 104, 90],
  "totalParts": 5821, "chunk": 0, "chunks": 3,
  "parts": [[0, -0.5, 0, 30, 1, 26, 120, 104, 90], [0, 5.2, -12.5, 30, 10.4, 1, 220, 214, 200]] }
```

- Part = `[x, y, z, sx, sy, sz, r, g, b]` (centre and size in studs, axis-aligned), optional 10th value `1` = imagined,
  `0` = captured (P2, for the reality-check tint).
- Voxelize opaque splats (room frame), drop specks and isolated voxels, greedy-merge into boxes, coarsen until under
  `maxParts` (default 6000, cap 12000), leave out the ceiling (send `ceilingY`), sort by y ascending, at most 2,500
  parts per chunk (about 120 KB). Every chunk repeats the header fields. At least 3 `spawns` on free floor, away from
  `vrSpawn` (the headset spawn).
- Cache as `data/scenes/<id>/roblox-map-<maxParts>-<chunk>.json`. The same bake writes `topdown.jpg`, `floorY` and
  `bounds` (sections 3.1 and 5.3).
- Errors: `202 {"status":"building","retryAfter":2}`, `404 {"error":"No such scene"}`,
  `409 {"error":"Scene is not ready","status":"running"}`, `400 {"error":"chunk out of range"}`, `401 {"error":"Bad key"}`.

**`POST /api/roblox/<sceneId>/presence`** (Sat 2 PM against a curl-faked VR player; Sat 4 PM with the headset)

Request, once per Roblox server, 4 times a second: only players who are inside the room.

```json
{ "server": "8b1c0e3a-6f1d-4f9e-9a55-2f3c1d1e9b77", "lastEventId": 40,
  "players": [ { "id": "rbx-12345", "name": "shivin", "x": 4.2, "y": 0.0, "z": -1.5, "yaw": 1.57, "state": "playing" } ],
  "round": { "state": "running", "endsAt": 1760715645.0, "it": "quest-1",
             "scores": { "quest-1": 2, "rbx-12345": 3 } } }
```

The server stores each player as `kind: "roblox"` in metres (`studs / studsPerMeter`) with `server`, and removes
players of that `server` that are no longer listed. Response, in studs:

```json
{ "t": 1760715600.31,
  "active": { "sceneId": "game-night-k3x9a", "name": "Game night" },
  "others": [
    { "id": "quest-1", "name": "Judge", "kind": "vr", "t": 1760715600.18, "x": 1.6, "y": 0, "z": 8.0, "yaw": 0.3,
      "head": [1.6, 6.4, 8.0], "hands": [[-6.4, 4.8, 3.6], [7.6, 5.0, 4.4]] },
    { "id": "rbx-55555", "name": "late judge", "kind": "roblox", "server": "other-job-id", "t": 1760715600.05,
      "x": 6, "y": 0, "z": -2, "yaw": 0 } ],
  "events": [ { "id": 41, "type": "start_round", "from": "host" } ] }
```

`others` = everyone in the scene except players of the calling `server`. `events` = queued commands with
`id > lastEventId` (section 5.6).

**`POST /api/roblox/<sceneId>/event`** (Sat 4 PM): one call per moment, studs.

```json
{ "server": "<JobId>", "type": "round", "state": "start", "duration": 30, "it": "quest-1",
  "players": [ { "id": "rbx-12345", "name": "shivin" }, { "id": "rbx-67890", "name": "brianna" } ] }
{ "server": "<JobId>", "type": "tag", "by": "quest-1", "target": "rbx-12345", "targetName": "shivin",
  "livesLeft": 2, "at": [4.1, 2.8, -1.2], "scores": { "quest-1": 3, "rbx-12345": 2, "rbx-67890": 3 } }
{ "server": "<JobId>", "type": "round", "state": "end", "winner": "roblox",
  "mvp": { "id": "rbx-67890", "name": "brianna" }, "survivors": ["rbx-67890"],
  "scores": { "quest-1": 4, "rbx-12345": 0, "rbx-67890": 2 } }
```

`round start` is sent when the round actually begins (after Roblox's 3-2-1 countdown). Response `{ "ok": true }`. The
server converts `at` to metres, adds `t`, and broadcasts on `/ws`:

```json
{ "type": "roblox", "sceneId": "game-night-k3x9a",
  "event": { "type": "tag", "by": "quest-1", "target": "rbx-12345", "targetName": "shivin", "livesLeft": 2,
             "at": [1.03, 0.70, -0.30], "scores": { "quest-1": 3, "rbx-12345": 2, "rbx-67890": 3 }, "t": 1760715612.4 } }
```

If `DS_EVENT_URL` is set, it also forwards tags as `{sceneId, type:"tag", by, target, t}` (optional stretch).

### 5.6 Roblox commands (Sat 4 PM, optional but cheap)

**`POST /api/roblox/<sceneId>/command`** with `{ "type": "start_round" | "end_round" | "reload_room", "from": "host" }`
(from the host page or the headset). The server gives it the next integer `id` for that scene and returns it in the
next Roblox presence response. In the skit Shivin starts the round from his Roblox HUD, so this is a backup.

### 5.7 Presence forwarder to DeepSpace (first test Sat 2 PM, live Sat 4 PM)

For every scene with anyone in it, **4 times a second** (at least once a second even if nobody moved):

```
POST <DS_INGEST_URL>            (https://<app>.app.space/api/ingest)
Content-Type: application/json
X-DejaView-Key: <DS_INGEST_KEY>

{ "sceneId": "game-night-k3x9a", "t": 1760715600.25,
  "people": [
    { "id": "quest-1",   "name": "Judge",  "kind": "vr",     "x": 0.42, "y": 0, "z": -1.10, "yaw": 0.30 },
    { "id": "rbx-12345", "name": "shivin", "kind": "roblox", "x": 1.05, "y": 0, "z": -0.38, "yaw": 1.57 } ] }
```

- Full snapshot every time (not a diff), metres in the room frame, feet `y`. Only these 7 fields per person.
- Exactly one push with `"people": []` when the last person leaves a scene.
- Fire and forget with a 2 s timeout. If the previous push for that scene is still in flight, skip this one; never
  queue.
- Responses: `200 {"ok":true,"people":2}`, `400 {error}` (log it once: it is a contract bug), `401` (wrong key),
  `413` (over 32 KB), `500`.

### 5.8 Notes (Sat 2 PM, so Seb can test; in the headset by Sat 8 PM)

A friend on the DeepSpace map clicks a spot and types a note. The DeepSpace page saves it in its own `notes`
collection **and** posts it to Déjà View through the public `BASE`, which pushes it to the headset.

**`POST /api/notes/<sceneId>`** (from a browser, no key, CORS `*`)

```json
{ "id": "note-k2j3h4x9", "x": 1.20, "z": -0.80, "text": "Seb's seat. He was too scared to show up", "author": "Brianna" }
```

`201`:

```json
{ "ok": true,
  "note": { "id": "note-k2j3h4x9", "sceneId": "game-night-k3x9a", "x": 1.20, "y": null, "z": -0.80,
            "text": "Seb's seat. He was too scared to show up", "author": "Brianna", "createdAt": "2026-10-17T22:41:07Z" } }
```

- `id`: made by the DeepSpace page (the same id as its record, so the two sides match). Posting the same `id` again
  returns `200` with the stored note, so retries are safe.
- `text` 1 to 120 characters, `author` at most 40, `x`/`z` finite and within `bounds` plus 2 m.
- Errors: `400 {error}`, `404 {"error":"No such scene"}`.
- Stored in `data/scenes/<id>/notes.json`, so notes stay for the next visitor. Broadcast on `/ws`:
  `{ "type": "note", "sceneId": "...", "note": { ... } }`.

**`GET /api/notes/<sceneId>`** returns `{ "notes": [ ... ] }`, oldest first. **`DELETE /api/notes/<sceneId>/<id>`** is optional
(rehearsal clean-up), and broadcasts `{ "type": "note_deleted", "sceneId", "id" }`.

`y` is `null` on purpose: the map is top-down. The viewer picks the height (section 6.6).

### 5.9 Guide proxy and server-side Gemini calls (proxy Sat 2 PM; upload and ready hooks Sat 4 PM)

Every proxy route forwards the JSON body to `GUIDE_URL` + the same path, adds `X-Guide-Key`, fills in `scene` from
the store (`{name, mode, caption}`), and returns the guide's status and body unchanged. If the guide is unreachable:
`502 {"error":"guide offline"}`. Full request and response examples: `brianna.md` section 5.

| Déjà View route | Forwards to | Timeout | Called by |
| --- | --- | --- | --- |
| `POST /api/guide/narrate` | `POST /narrate` | 10 s | viewer, on entering a world that has no video playing |
| `POST /api/guide/ask` | `POST /ask` | 10 s | viewer, hold-to-talk |
| `POST /api/guide/speak` | `POST /speak` | 10 s | viewer (only for the `speak:false` path) |
| `POST /api/guide/hotspots` | `POST /hotspots` | 15 s | viewer, on entering a world without stored hotspots |
| `GET /api/guide/health` | `GET /health` | 3 s | host page |

For `/ask`, the proxy also adds `people` (count in presence, at least 1) and `names` (VR person first) as context.

Server-side calls (no proxy route, the server calls the guide directly):

| When | Call | Body | What the server does with the result |
| --- | --- | --- | --- |
| right after an upload is accepted (the 201 is already sent), before the GPU job is queued | `POST /describe`, **5 s timeout** | `{image: <data URL of thumb.jpg>, mode, name, userPrompt}` | `input.prompt` = returned `prompt` (the world model's text prompt); `caption` and `imagined` into the scene; then queue the job. Timeout or error: queue the job unchanged (today's captioner) |
| a scene becomes `ready` | `POST /narrate` (fire and forget) | `{sceneId, image: <thumb data URL>, scene}` | nothing: it warms the guide's cache so the headset's greeting is instant |
| a `thirdwheel` scene becomes `ready` | `POST /prepare` (fire and forget, 120 s) | `{sceneId, scene, videoPath: <absolute path of input/video.*>}` on the demo Mac; `videoUrl: "http://<mac-ip>:8788/data/scenes/<id>/input/video.mp4"` while the guide runs on Brianna's laptop | nothing: the guide caches a summary of the video so "what is she making?" lands |

### 5.10 Hotspots storage (Sat 4 PM)

The viewer finds the 3D positions (section 6.5) and stores them, so labels appear instantly next time and on the map.

**`PUT /api/scenes/<sceneId>/hotspots`**

```json
{ "hotspots": [
  { "id": "h1", "label": "screen", "blurb": "Scene of the crime", "ask": "Who won?", "x": 0.10, "y": 1.10, "z": -2.60 },
  { "id": "h2", "label": "controllers", "blurb": "Still warm", "ask": "Whose controller is that?", "x": -0.40, "y": 0.75, "z": -0.90 },
  { "id": "h3", "label": "snacks", "blurb": "Mostly crumbs now", "ask": "What snacks are left?", "x": 0.60, "y": 0.45, "z": -1.20 } ] }
```

Room-frame metres. Stored in `hotspots.json`, broadcast as `{ "type": "hotspots", "sceneId", "hotspots": [...] }`.
**`GET /api/scenes/<sceneId>/hotspots`** returns `{ "hotspots": [...] }` (empty array when none). Seb's map may draw
these labels (optional).

### 5.11 Host cue (Sat 4 PM; the bot uses it at 0:00 and 2:15)

**`POST /api/host/cue`** (from `127.0.0.1` without a key, otherwise `x-dejaview-key: <DV_KEY>`)

```json
{ "action": "load", "sceneId": "game-night-k3x9a", "by": "bot" }
{ "action": "reality", "on": true }
{ "action": "labels", "on": true }
```

Response `{ "ok": true }`. Broadcast `{ "type": "cue", "action": "load", "sceneId": "...", "at": 1760715600.1 }`.
The viewer opened with `?follow=1` obeys cues (section 6.8). A tiny `/host` page on the Mac (buttons for the three
demo worlds, reality check, labels, start round, guide health) lets Ojasva run the skit from the table laptop.

### 5.12 WebSocket messages, complete list

| `type` | Payload | From |
| --- | --- | --- |
| `health` | `health` | exists |
| `scene` | `scene` | exists |
| `scene_deleted` | `id` | exists |
| `cue` | `action`, `sceneId?`, `on?`, `at` | 5.11 |
| `note` | `sceneId`, `note` | 5.8 |
| `note_deleted` | `sceneId`, `id` | 5.8 |
| `hotspots` | `sceneId`, `hotspots` | 5.10 |
| `roblox` | `sceneId`, `event` (round start/end, tag; metres) | 5.5 |

Add the new ones to `ServerEvent` in `shared/types.ts`. Seb's gallery and bot only act on `scene` and ignore the rest.

---

## 6. The viewer (Ojasva's side of each teammate feature)

### 6.1 Presence posting and ghosts (Sat 4 PM)

- Post own pose 4 times a second to `/api/presence/<sceneId>` (section 5.4): `vr` in the headset with `head` and
  `hands` (controller grip positions), `web` elsewhere (`?name=` sets the name, otherwise "Guest").
- Draw everyone in the response, 0.3 s in the past, interpolated. Roblox players: a blocky avatar about
  `5 / studsPerMeter` m tall (1.25 m at 4.0), white with a lime outline, a bold name tag, a red flash while
  `state == "caught"`. Web viewers: a small glowing orb with a name.

### 6.2 Tag moments and scoreboard (Sat 8 PM)

On `{type:"roblox"}` events: `round start` shows "TAG: YOU'RE IT" and a countdown computed from `duration` on
receipt (do not compare clocks with Roblox). `tag` plays a lime burst plus a sound at `at` and a big **TAGGED** with
the name. `round end` shows the winner card for 5 s. A small scoreboard follows the left wrist.

### 6.3 Voice ask (Sat 6 PM)

- Ask for the microphone on a 2D click **before** entering VR (`getUserMedia` needs a secure origin and a user
  gesture; it may not prompt inside an immersive session). The 8787 https origin is what makes this work on the LAN.
- Hold a button to record with `MediaRecorder` (`audio/webm;codecs=opus` if `isTypeSupported`, otherwise the
  default type; pass whatever `mimeType` the recorder reports). 8 s max. Play a short "thinking" click on release.
- Send `POST /api/guide/ask` with the audio as a data URL, the current view as `image`, the pointed hotspot as
  `target`, and for a Video world the current video `frame` and `videoTime`, plus the last 4 turns as `history`
  (exact shape: `brianna.md` 5.3). Play `speech` with an `Audio` element and show the question and answer as captions.
- Optional time-saver: Brianna's test page includes a dependency-free `voice-client.js` (record, data URL, play). Use
  it if it saves you an hour.

### 6.4 Narration playback (Sat 6 PM)

On entering a world **with no video playing**, call `/api/guide/narrate` (`{sceneId}`; the server pre-warmed the
cache, so it returns in milliseconds) and play it. Video worlds skip it (the video's own sound plays).

### 6.5 Hotspot labels and pointing (Sat 6 PM)

- On entering a world: `GET /api/scenes/<id>/hotspots`. None stored: capture the view and call
  `POST /api/guide/hotspots`.
- **Capturing a view:** render one extra frame from the head pose with a normal `THREE.PerspectiveCamera` (for
  example 70° vertical FOV, 4:3, 768 × 576) into a `WebGLRenderTarget`, read the pixels, encode a JPEG (quality 0.7).
  Do not try to read the XR framebuffer. Keep that camera's matrices with the image.
- **2D box to 3D:** each hotspot has `box: [ymin, xmin, ymax, xmax]` normalized to 0 to 1000 (Gemini's format). Take
  the box centre `u = (xmin + xmax) / 2000`, `v = (ymin + ymax) / 2000`, make NDC `(2u − 1, 1 − 2v)`, unproject
  with the capture camera, march along the ray in steps of half a voxel until `VoxelGrid.solidAt` is true, and
  anchor the label 0.05 m in front of the hit. No hit within 6 m: drop that hotspot. Then
  `PUT /api/scenes/<id>/hotspots`.
- **Look:** a pill with the label in bold caps, dark background, lime dot, a thin leader line down to the anchor,
  always facing the viewer, scaled to stay readable from 1 to 4 m.
- **Pointing:** the controller ray that passes within about 0.25 m of a label highlights it (lime outline). Holding
  the talk button while pointing sends that hotspot as `target`.
- Things held in the moving footage (controllers in people's hands) are not in the voxel grid, so the ray passes
  through them to the couch. For a box whose centre falls on the video layer's foreground mask, use the video's own
  depth at that pixel instead (the Video layer decodes it), or anchor at 0.8 of the distance to the voxel hit.
- For the three demo worlds, run this once in rehearsal, fix any label by hand in `hotspots.json`, and keep it.

### 6.6 Notes in VR (Sat 8 PM)

On entering a world: `GET /api/notes/<sceneId>`. On `{type:"note"}`: spawn it with a pop. Height: the highest solid
voxel in a 0.2 m column at (x, z), plus 0.35 m, clamped to 0.9 to 1.9 m (so a note on the couch floats just above
the seat back). A lime `#C6FF3D` paper card, near-black bold text, wrapped at about 22 characters, "— Brianna" underneath,
turning to face the viewer about the vertical axis only. A soft sound when it appears.

### 6.7 Reality check (Sat 6 PM; Ojasva's own feature)

The host's `reality` cue tints everything the world model imagined and leaves what the camera captured untinted.
The legend lists `scene.imagined` from `/describe`. Optional: the same captured/imagined split as the 10th value of
each Roblox map part.

### 6.8 Follow mode (Sat 8 PM)

`/view?follow=1` on the Quest: on a `load` cue, fade out, swap the world **inside the running XR session** (no page
reload, which would end the session), fade in. A Video world needs one user gesture to start with sound: the
judge's Enter VR click at 0:20 provides it. If the in-session swap is not ready by Sat 8 PM, the fallback is: B button
leaves VR, the page swaps, the judge presses Enter VR again (costs about 5 s at 2:15).

---

## 7. What the teammates provide (summary; details in each brief)

| Who | Provides | Shape | By |
| --- | --- | --- | --- |
| Brianna | guide service: `GET /health`, `POST /describe`, `/hotspots`, `/narrate`, `/ask`, `/speak`, `/prepare`, `GET /prepare/<id>` on :8795 with `X-Guide-Key` | `brianna.md` 5 | on her laptop Sat 2 PM; on the demo Mac Sat 8 PM |
| Brianna | `GUIDE_KEY` in person; free-tier limits; median latencies | | Sat 10 AM |
| Seb | DeepSpace `POST /api/ingest` with `DS_INGEST_KEY` | 5.7 | deployed Sat 2 PM |
| Seb | DeepSpace page posts notes to `BASE/api/notes/<id>` | 5.8 | Sat 4 PM |
| Seb | bot: uploads, demo mode, `load` cues, replies with the world link, the map link and the Roblox link | `seb.md` 4 | Sat 10 AM on the LAN; on the demo Mac (or the bot Mac) Sat 10 PM |
| Seb | Vultr access result tonight; an A40 box with Ojasva's SSH key when he asks | `seb.md` 7 | tonight / Sat AM |
| Shivin | Roblox experience calling 5.5 with `dejaview_key`; place id; join link format | `shivin.md` | mocks Sat 10 AM; real server Sat 4 PM |
| Shivin | `PLACE_ID` to Seb and Ojasva; link `https://www.roblox.com/games/start?placeId=<PLACE_ID>&launchData=<sceneId>` | | Sat 12 PM |

---

## 8. Dependency timeline (who waits on whom)

Everyone builds against mocks until the real thing exists, so nobody is ever blocked. The left column is when the
real thing must exist.

| By | Ojasva delivers | Unblocks |
| --- | --- | --- |
| Fri night | `:8788` listener, LAN IP posted, `DV_KEY` made | Seb's curl tests, Brianna's fixtures |
| Sat 9 AM | LAN URL confirmed working from each laptop (or everyone on one phone hotspot) | all LAN testing |
| Sat 12 PM | public `BASE` (tunnel); `GET/POST /api/presence`; `GET /api/roblox/rooms`; maps for the two samples | Shivin's real-server tests, Seb's deployed gallery |
| Sat 2 PM | Roblox presence relay; guide proxy routes; DeepSpace forwarder pointed at Seb's app; notes endpoints; 3 headset request bodies saved as JSON for Brianna | Shivin's ghost with a curl VR player; Brianna end to end; Seb's live map and notes |
| Sat 4 PM | (team) the **game-night clip** filmed at the venue, on the table iPhone (so the exact file is the one sent at 0:00): everyone except Seb on a couch with controllers, the screen in frame, phone propped still 1.5 to 3 m away, landscape, 15 to 20 s, the empty spot for the first couple of seconds, a last-second upset, sound on. Also the dorm photo and a clean, HUD-free Fortnite frame for the Photo worlds | Ojasva generates and freezes the three demo worlds; Seb's demo mode |
| Sat 4 PM | auto map + `topdown.jpg` + `floorY`/`bounds` for every new ready scene; Roblox events to the headset; `/describe` in the upload flow; `/prepare` and narrate pre-warm on ready; hotspots storage; host cue | everything talks to the real server |
| Sat 6 PM | viewer: voice ask, narration, hotspot labels and pointing, reality check | Brianna's prompt tuning with real views |
| Sat 8 PM | demo worlds generated and frozen; viewer: ghosts, tag moments, notes, follow mode; guide and bot folders running on the demo Mac | the full skit |
| Sat 10 PM | full skit run twice with a timer | |
| Sun 4 AM | freeze; record clips | |

| By | Teammate delivers | Unblocks Ojasva |
| --- | --- | --- |
| tonight | Seb: Vultr GPU yes/no; Photon group-chat test result; DeepSpace app name. Shivin: transport test from a live Roblox server through a quick tunnel. Brianna: both keys work, free-tier limits | tunnel choice, GPU plan, bot channel |
| Sat 10 AM | Brianna: `/describe`, `/hotspots`, `/ask` answering fixtures; median latency. Shivin: mock room + ghost + tag in Studio. Seb: text a photo → link (LAN) | Ojasva can wire calls with real shapes |
| Sat 12 PM | Shivin: place id + join link | Seb's bot reply |
| Sat 2 PM | Brianna: `GUIDE_KEY` + laptop URL. Seb: deployed DeepSpace URL + `DS_INGEST_KEY` | proxy and forwarder go live |
| Sat 8 PM | Brianna: guide folder (no `.env`). Seb: bot folder (no `.env`) | demo Mac runs everything |

### Ojasva's critical path (be honest about the hours)

The glue above is roughly 25 hours of work for one person on top of the GPU pipeline. Cut in this order if behind,
and say so in the team chat the moment you cut something:

1. **P0 (the skit breaks without it):** 8788 listener, tunnel, presence spine, Roblox rooms + map + presence + event,
   ghosts and TAGGED in VR, DeepSpace forwarder, notes endpoint + notes in VR, `topdown.jpg`, guide proxy + voice ask,
   hotspot labels, host cue + follow mode, the three frozen demo worlds.
2. **P1:** describe in the upload flow (the live bonus still works with the default caption), prepare hook (can be
   run once by hand with curl for the game-night clip), narrate pre-warm, in-session swap (fallback in 6.8), scoreboard
   on the wrist.
3. **P2:** imagined flag on Roblox parts, DeepSpace tag events, viewer `?name=`, hotspot labels on the DeepSpace map,
   note deletion, `/api/roblox/<id>/command`.

---

## 9. Test plan

### 9.1 Each piece alone (by Sat 10 AM)

| Piece | Test | Pass |
| --- | --- | --- |
| Roblox | Studio, Server & Clients with 2 clients, `USE_MOCK = true` | mock room builds behind the loading screen, the mock ghost glides on both, tag works |
| Guide | the curl scripts in `brianna.md` 7 | `/hotspots` returns 3 to 6 tight boxes on the fixture image; `/ask` with `q-window.webm` answers about what is really by the window |
| Bot | text a photo to the bot | world link back on the LAN; demo clip answered instantly |
| DeepSpace | `fake-feed.ts` against the deployed app | three dots gliding at 60 fps; a note click shows the composer |
| Server | the curl block below against `http://localhost:8788` | every call returns the documented shape |

### 9.2 Server contract checks (Ojasva runs these after every server change)

```bash
B=http://localhost:8788; K=$DV_KEY; S=test-tw-local
curl -s $B/api/presence | jq .
curl -s -X POST $B/api/presence/$S -H 'Content-Type: application/json' \
  -d '{"id":"quest-1","name":"Judge","kind":"vr","x":0,"y":0,"z":0,"yaw":0,"head":[0,1.6,0],"hands":null}' | jq .
curl -s $B/api/roblox/rooms -H "x-dejaview-key: $K" | jq '.active, (.rooms|length)'
curl -s "$B/api/roblox/$S/map?chunk=0" -H "x-dejaview-key: $K" | jq '{studsPerMeter,totalParts,chunks,first:.parts[0]}'
curl -s -X POST $B/api/roblox/$S/presence -H "x-dejaview-key: $K" -H 'Content-Type: application/json' \
  -d '{"server":"curl","players":[{"id":"rbx-1","name":"curl","x":4,"y":0,"z":0,"yaw":0,"state":"playing"}]}' | jq .
curl -s $B/api/presence/$S | jq '.people[] | {id,kind,x}'          # rbx-1 must show x = 1.0 (4 studs / 4.0)
curl -s -X POST $B/api/notes/$S -H 'Content-Type: application/json' \
  -d '{"id":"note-test1","x":0.5,"z":-1,"text":"test note","author":"curl"}' | jq .
curl -s $B/api/notes/$S | jq '.notes|length'
curl -s -X POST $B/api/host/cue -H 'Content-Type: application/json' -d '{"action":"load","sceneId":"'$S'"}' | jq .
curl -s $B/api/guide/health | jq .
```

Watch the WebSocket while doing this: `bunx wscat -c ws://localhost:8788/ws` (or any WS client) shows each `note`,
`cue` and `roblox` message.

### 9.3 Pairs (Sat 2 PM to 6 PM)

| Pair | Do | Pass |
| --- | --- | --- |
| Roblox ↔ server | Shivin's 60 s fake VR player (`shivin.md` 9.4), then the real headset | the ghost circles at head height, facing where it walks; the headset sees the avatars where they really are |
| Server → DeepSpace | Ojasva in a sample room on the desktop viewer, walking | the dot on `/live` moves the same way within 0.5 s; facing matches (walk toward −Z: the cone points up) |
| DeepSpace → headset | Brianna clicks the map and types a note | the note appears in the headset within 1 s, at the spot she clicked |
| Guide ↔ headset | Ojasva points at "screen" in the game-night memory and asks "who won?" | caption within 1.2 s, voice within 2.5 s, the answer matches what happens in the clip |
| Bot → headset | Seb sends the demo clip to the chat | reply within 3 s; the Quest in `?follow=1` loads the memory |
| Coordinates | Ojasva stands at a corner in VR, Shivin walks his avatar to the ghost's feet | positions agree within 0.3 m; yaw is not mirrored |

### 9.4 Full skit run (Sat 10 PM, twice, with a timer; again at Sun 2 AM)

| Time | Check | Owner | Fallback if it fails |
| --- | --- | --- | --- |
| before | `/host` shows guide ok, GPU warm, tunnel up; Roblox clients in the lobby with auto-join off; `/live` open full screen; Quest on `/view?follow=1`; mic permission granted | Ojasva | fix before starting |
| 0:00 | game-night clip in the chat → bot reply with thumbnail + link within 3 s; Quest loads the memory | Seb | host loads it from `/host` |
| 0:20 | judge enters VR, the video plays with sound | Ojasva | |
| 0:40 | labels on the screen, controllers, snacks; "who won?" answered in the room's voice | Brianna / Ojasva | caption only (`degraded`), or recorded clip |
| 1:00 | reality-check cue tints the imagined half | Ojasva | |
| 1:15 | Shivin presses JOIN: both avatars appear in the headset; round of 30 s starts, judge is "it" | Shivin | "Mock judge" in Roblox; recorded clip |
| 1:45 | `/live` shows three dots and trails; Brianna clicks the couch and leaves the note; it pops up in the headset | Seb / Brianna | `fake-feed.ts` only if said out loud on stage |
| 2:15 | judge's photo (taken on the table iPhone) sent → world in 10 to 30 s → Quest swaps to it | Seb / Ojasva | skip if the GPU is cold |
| 2:40 | optional Capital One beat | Seb | skip |

Write down every time that is over its target, and fix the slowest one first.

### 9.5 Failure drills (once each, Sat night)

Kill the tunnel (Roblox banner, recovers by itself; DeepSpace map dims). Stop the guide (headset shows the canned
line). Cut the internet but keep the local network, for example by turning off mobile data on the hotspot (the Quest
keeps the world over the LAN; everything else degrades politely). Restart the server mid-round (presence repopulates
within 1 s, nobody refreshes).
