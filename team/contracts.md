# Déjà View: integration contracts

The single source of truth for every place two pieces talk to each other. If a brief and this file disagree, this
file wins: say so in the team chat and Ojasva fixes it here.

`START-HERE.md` is the one-page version of everyone's job and uses exactly the endpoints, fields and deadlines below;
this file adds the full shapes, examples and the test plan. Read `plan.md` for the story. Each brief (`shivin.md`,
`brianna.md`, `seb.md`) has the build details for one piece; this file has only the wiring, the deadlines and the
test plan.

The two modes are **Photo** and **Video**, and the API uses exactly those words: `mode=photo` and `mode=video`.

Extra fields: every receiver **ignores fields it does not know**, and every sender may add extra fields. Never remove
or rename a field listed here without changing this file first.

---

## 1. The whole system

```
 group chat (iMessage)                         Ojasva's Mac (the demo Mac)
 ─────────────────────                        ─────────────────────────────────────────────────────────
 Seb / judge ──▶ Photon cloud ◀── Photon bot (Seb) ── POST /api/scenes ──▶ Déjà View server (Bun)
                                     │  demo mode: hash/keyword → scene id     │  :8787 https (Quest, LAN)
                                     │  reply: thumb + view/Roblox/map links   │  :8788 http  (everyone else)
                                                                               │
                         guide (Brianna, :8795) ◀── /describe /hotspots ───────┤── GPU worker (HiPerGator warm
                              │                     /narrate /ask               │   worker, or Vultr A40)
                              ▼                                                 │
                           Gemini API                       cloudflared ── public https BASE
                                                                               │
 Quest 3S viewer (Ojasva) ── /view, /api/presence, /api/guide/*, /api/notes, WS /ws (LAN, :8787)
 Roblox game servers (Shivin) ── /api/scenes, /api/roblox/* (public BASE)
 DeepSpace page in a browser (Seb) ── /api/scenes, /data/*, WS /ws (public BASE)

 Déjà View server ── POST /api/ingest (presence, 4 Hz) ──────────────▶ DeepSpace worker (Seb, <DS_URL>)
 Déjà View server ── GET /api/notes (every 2 s), POST /api/notes ─────▶ DeepSpace worker (notes live there)
```

### Who calls whom (nobody else calls anybody)

| Caller | Callee | What | Auth |
| --- | --- | --- | --- |
| Photon bot | Déjà View | upload, status, list, thumbnail, WS; optional `load` cue | none from localhost; `x-dejaview-key` for the cue from elsewhere |
| Quest / browser viewer | Déjà View | page, assets, presence, guide proxy, notes, WS | none |
| Roblox game server | Déjà View | `GET /api/scenes`, `/api/roblox/*` | `x-dejaview-key` (checked only when `DV_KEY` is set) |
| DeepSpace page (browser) | Déjà View (public BASE) | scene list, thumbnails, WS | none (CORS `*`) |
| Déjà View | guide | `/describe`, `/hotspots`, `/narrate`, `/ask` | `X-Guide-Key` (checked only when the guide sets `GUIDE_KEY`) |
| Déjà View | DeepSpace worker | presence push, notes read and write | `X-DejaView-Key: <DS_KEY>` |
| guide | Gemini | everything AI | Brianna's `GEMINI_API_KEY` |
| bot | Photon cloud | messages (outbound connection, no webhook) | Seb's Photon project ID + secret |

Nothing calls Roblox. Nothing calls the bot. The headset never calls the guide or DeepSpace directly. The DeepSpace
page never writes to Déjà View. Capital One (Seb's optional side quest) has no contract with anyone: nothing in this
file depends on it.

---

## 2. Addresses, ports and keys

### 2.1 Addresses

| Name | Value | Used by |
| --- | --- | --- |
| `BASE` on the LAN (now) | `http://<mac-lan-ip>:8788`, plain HTTP, same process and data as 8787. Until 8788 exists, Ojasva posts the working address (it may be `https://<ip>:8787` with a self-signed certificate: use `curl -k`) | teammates on the same Wi-Fi, the bot, curl |
| Quest address | `https://<mac-lan-ip>:8787` (self-signed; accept the certificate once in the Quest Browser). WebXR and the microphone need a secure origin | the headset only |
| `BASE` public (by **Sat 4 PM**) | `https://<host>`, a Cloudflare Tunnel to `http://localhost:8788` | Roblox, DeepSpace pages, judges' phones, links in bot replies |
| `GUIDE_URL` | `http://<brianna-ip>:8795` while building; `http://127.0.0.1:8795` on the demo Mac from Sat 8 PM | Déjà View server only |
| `DS_URL` | `https://<app>.app.space` (Seb picks the name tonight, e.g. `dejaview-live`); local dev `http://localhost:5173` | the table laptop, the server's push and notes |
| Ports to avoid | 8790, 8791 (Ojasva's test harnesses) | |

Public link rules:
- **Never free ngrok.** Its free plan allows 20,000 requests a month; Roblox polling alone makes about 14,400 an hour.
- **Named Cloudflare tunnel preferred** (stable hostname, needs a domain on Cloudflare). **Quick tunnel fallback:**
  `cloudflared tunnel --url http://localhost:8788` prints a new `https://<random>.trycloudflare.com` every run, allows
  at most 200 in-flight requests, has no uptime guarantee and no SSE (we use none). WebSockets through a quick tunnel
  are not documented: Seb tests `wss://BASE/ws` on Saturday, and his gallery falls back to polling `GET /api/scenes`.
- **When the hostname changes**, Ojasva posts the new `BASE` in the team chat (it is not a secret) and each piece
  changes it at runtime, no redeploy: Shivin's Roblox Experience Config `dejaview_base`; Seb's DeepSpace `dvBase`
  setting and the bot's `DV_PUBLIC` (restart the bot). The Quest uses the LAN and is not affected.
- Campus Wi-Fi may block laptop-to-laptop traffic. If you cannot reach the LAN `BASE`, everyone joins one phone hotspot.
- A deployed DeepSpace page is https, so a browser refuses `http://` LAN addresses (mixed content). Seb builds against
  local dev or mock JSON until the public `BASE` exists.

### 2.2 Keys (random strings from `openssl rand -hex 24`; handed over in person or by DM, never in code or group chats)

| Key | Made by | Sent by, as | Checked by |
| --- | --- | --- | --- |
| `DV_KEY` | Ojasva | Roblox (Secret `dejaview_key`) and the bot, header `x-dejaview-key` | Déjà View on `/api/roblox/*` and `/api/host/*`, only when the `DV_KEY` env var is set; requests from `127.0.0.1` skip it |
| `DS_KEY` | Seb (stored with `npx deepspace secrets set`) | Déjà View, header `X-DejaView-Key` | DeepSpace worker on `/api/ingest` and `/api/notes`; it refuses everything if its secret is unset |
| `GUIDE_KEY` | Brianna | Déjà View, header `X-Guide-Key` | the guide, on everything except `GET /health`, when set |
| `GEMINI_API_KEY` | Brianna | the guide only | Google |
| Photon project ID + secret | Seb | the bot only | Photon |

`DV_KEY` and `DS_KEY` travel in headers with the same name in opposite directions; they are different secrets. Header
names are case-insensitive (Roblox sends lowercase, which HTTP/2 requires).

### 2.3 Server environment (demo values)

```
HTTP_PORT=8788
DV_KEY=<random>                               # optional; when set, /api/roblox/* and /api/host/* need x-dejaview-key
GUIDE_URL=http://127.0.0.1:8795
GUIDE_KEY=<from Brianna>
DS_URL=https://dejaview-live.app.space
DS_KEY=<from Seb>
```

### 2.4 CORS

The server already sends `Access-Control-Allow-Origin: *` and answers `OPTIONS` with 204 on `/api/*` and `/data/*`.
Only browsers need it (the DeepSpace page, judges' phones). Every new route keeps it. Roblox, the bot, the guide and the
DeepSpace worker are not browsers and need no CORS.

---

## 3. Shared conventions

### 3.1 The room frame (metres)

Every position in metres (presence, notes, hotspots, bounds) is in the **room frame**: Y up, right-handed, a camera at
the origin looks down −Z, and the floor is at **y = 0** (the scene's `floorY` is subtracted: `y_room = y_scene − floorY`).
This is exactly the viewer's three.js world frame. A person standing on the floor has `y = 0`; a standing head is at
about `y = 1.6`. The headset spawns at the origin.

### 3.2 Roblox studs

`studs = metres_room × studsPerMeter`, axis for axis. **`studsPerMeter = 3.57`** (one stud is 28 cm, so the room is life
size), and every map response carries it: never hard-code it. Roblox is also right-handed, Y up, −Z forward, so no axis
flips. Only the Déjà View server converts: Roblox sends and receives studs only, everyone else metres only.

### 3.3 People

| Field | Meaning |
| --- | --- |
| `id` | `quest-1` (headset; `quest-2` for a second one), `rbx-<Roblox UserId>`, `web-<8 hex chars>` (a browser viewer) |
| `name` | display name, at most 40 characters |
| `kind` | `vr`, `roblox` or `web` |
| `x, y, z` | the person's **feet** on the floor (room frame metres, or studs for Roblox) |
| `yaw` | radians about +Y, same as three.js `rotation.y` and Roblox `CFrame.Angles(0, yaw, 0)`: **0 faces −Z, positive turns left** (counter-clockwise seen from above). Facing direction = `(−sin yaw, −cos yaw)` in (x, z) |
| `hands` | optional `[[x, y, z], [x, y, z]]`, left then right (VR only); may be missing or `null` |
| `head` | optional `[x, y, z]`, eye position (VR only). Missing: assume feet + 1.6 m |
| `age` | seconds since the server last heard from this person |

An `id` is in one scene at a time: posting it to a new scene removes it from the old one. Anyone silent for **3 s** is
dropped.

### 3.4 Everything else

- **Rate:** every position stream is **4 Hz** (every 250 ms). Everyone draws other people **0.3 to 0.35 s in the past**
  and interpolates (yaw the short way round). Nobody teleports.
- **Times:** `t` is Unix seconds (float) on the Déjà View server's clock. `createdAt` is an ISO string, UTC.
- **Scene ids:** `^[a-z0-9][a-z0-9-]{0,95}$` (the server's own rule). Every validator uses it.
- **Errors:** JSON `{ "error": "<a sentence a person understands>" }` with a 4xx or 5xx status. An HTML body instead
  of JSON (a Cloudflare error page, usually 502 or 530) means **the tunnel or the Mac is down**: back off and retry.
- **WebSocket:** `/ws` sends JSON messages with a `type`. Every client ignores types it does not know.
- **Look:** dark UI, one acid-lime accent **`#C6FF3D`**, bold type.

---

## 4. Scenes (exists today)

### 4.1 Upload: `POST BASE/api/scenes` (multipart/form-data)

| Field | Value |
| --- | --- |
| `mode` | `photo` or `video` |
| `name` | optional, up to 80 characters |
| `files` | one field per file (repeat `files`). Photo: one or more photos (JPEG, PNG, HEIC/HEIF; the server converts HEIC). Video: exactly one video (MOV/MP4) from a still, propped-up phone |
| `prompt` | optional text. With no files, Photo mode builds a world from the text alone |

```bash
curl -s -F mode=photo -F name="Dorm room" -F files=@room.jpg $BASE/api/scenes
curl -s -F mode=video -F name="Game night" -F files=@gamenight.mov $BASE/api/scenes
```

`201 Created`, a `Scene`:

```json
{ "id": "game-night-k3x9a", "name": "Game night", "mode": "video", "status": "queued", "stage": "Queued",
  "progress": 0, "createdAt": "2026-10-17T14:02:19.250Z", "updatedAt": "2026-10-17T14:02:19.250Z",
  "input": { "files": ["input/video.mp4"] }, "thumb": "thumb.jpg" }
```

Errors with `{error}`: 400 (bad input, for example photos and a video together), 413 (over 1 GB), 415 (not
multipart), 500. `thumb.jpg` is written before the GPU job starts, so the bot can show it at once. For a video it is a
frame from the first second (the empty spot).

`photo` and `video` are aliases Ojasva adds on Friday night for the server's internal mode names. If an upload with
`mode=photo` returns 400 before that lands, tell him. Responses report `mode` as `photo` or `video`; bundled samples
may report something else: treat anything that is not `video` as a place.

### 4.2 Status: `GET BASE/api/scenes/:id`

```json
{ "id": "game-night-k3x9a", "name": "Game night", "mode": "video",
  "status": "ready", "stage": "Ready", "progress": 1, "error": null, "thumb": "thumb.jpg",
  "caption": "A small lounge with a grey couch facing a TV on a low cabinet, carpet tiles, warm lamp light ...",
  "world": { "floorY": -1.25,
             "bounds": { "min": [-2.30, -1.25, -3.48], "max": [1.75, 1.35, 1.80] },
             "topdown": { "file": "topdown.jpg", "min": [-2.30, -3.48], "max": [1.75, 1.80] } } }
```

- `status`: `queued` → `running` → `ready`, or `failed` with `error` (a friendly sentence: pass it through). Brief
  `uploading` and `downloading` states may appear: treat them as `running`.
- `stage`: human text ("Generating the room"). `progress`: 0 to 1 when known.
- `world.bounds`: scene frame (y values include `floorY`); x and z are what maps and notes use.
- `world.topdown` (added by Ojasva with the map bake, Sat 4 PM; required for the three demo worlds): an orthographic
  view from above, ceiling cut off, covering exactly `min` to `max` in (x, z), at
  `BASE/data/scenes/<id>/topdown.jpg`. Image right = +X, image down = +Z (so forward, −Z, is up). About 100 px per
  metre, at most 1024 px on the long side. It is how Brianna finds the couch on the DeepSpace map: draw it under the
  map grid when present.

### 4.3 List, view link, thumbnail, live events

| What | Call |
| --- | --- |
| List | `GET BASE/api/scenes` → `Scene[]`, newest first, **including failed scenes** (filter `status === "ready"`) |
| View link | `BASE/view?scene=<id>` (Quest, desktop, phone) |
| Thumbnail | `BASE/data/scenes/<id>/<thumb>` (a JPEG; some bundled samples have no `thumb`) |
| Live events | `WS BASE/ws` (`wss://` on the public link): `{type:"health", health}` first, then `{type:"scene", scene}` on every change to any scene, `{type:"scene_deleted", id}` |

---

## 5. Presence

### 5.1 From the headset: `POST BASE/api/presence/:sceneId` (Ojasva's viewer, 4 Hz, metres)

```json
{ "id": "quest-1", "name": "Judge", "kind": "vr",
  "x": 0.42, "y": 0, "z": -1.10, "yaw": 0.30,
  "head": [0.42, 1.62, -1.10],
  "hands": [[0.20, 1.21, -1.40], [0.65, 1.25, -1.35]] }
```

`kind` is `vr` (headset) or `web` (a browser viewer). `200 OK` returns everyone else in that scene, in the 5.2 shape,
so the viewer gets its ghosts with no second call. Errors: 400 (`{"error":"x must be a finite number"}`, unknown
`kind`, name over 40 characters), 404 unknown scene.

### 5.2 Everyone in a scene: `GET BASE/api/presence/:sceneId` (metres)

```json
{ "t": 1760715600.31,
  "people": [
    { "id": "quest-1", "name": "Judge", "kind": "vr", "x": 0.42, "y": 0, "z": -1.10, "yaw": 0.30, "age": 0.12,
      "hands": [[0.20, 1.21, -1.40], [0.65, 1.25, -1.35]] },
    { "id": "rbx-12345", "name": "shivin", "kind": "roblox", "x": 1.05, "y": 0, "z": -0.38, "yaw": 1.57, "age": 0.20 } ] }
```

---

## 6. Roblox (studs; Shivin calls these from the Roblox game server)

### 6.1 Room picker: `GET BASE/api/scenes`

The picker lists ready **Photo** scenes (filter `status === "ready"` and `mode !== "video"`, newest first, show at
most 12): only photos and screenshots become Roblox places; a video memory stays in the headset and the browser. Poll every 3 s while the picker is open, so a room built live in the finale appears within seconds
of being ready. A room is loadable once its map (6.2) returns 200.

### 6.2 Map: `GET BASE/api/roblox/:sceneId/map`

(Photo scenes only; a video scene answers 404. The textured room model is 6.2b.)

```json
{ "sceneId": "game-night-k3x9a", "name": "Game night", "studsPerMeter": 3.57,
  "spawn": [0, 0, 5.4],
  "parts": [[0, -0.5, 0, 26.8, 1, 23.2, 120, 104, 90], [0, 4.6, -11.2, 26.8, 9.3, 1, 220, 214, 200]] }
```

- Each part is `[x, y, z, sx, sy, sz, r, g, b]`: centre and size in studs, axis-aligned, colour 0 to 255, sorted
  bottom-up (floor first). The ceiling is left out.
- `spawn`: a free floor point (`y` = floor height, add 3 studs for the root part), away from the headset spawn at the
  origin.
- Optional query `maxParts` (default 6000, cap 12000): the server coarsens the voxels until the room fits.
- Optional query `chunk=N`: the same response cut into chunks of at most 2,500 parts (about 120 KB), each repeating
  the header fields plus `chunk` and `chunks`. Without `chunk`, all parts come in one response.
- Optional extra fields: `ceilingY` (studs, for an invisible lid), `bounds` (studs), and a 10th value per part (`1` =
  imagined, `0` = captured) for the reality-check tint.
- Errors: `202 {"status":"building","retryAfter":2}` (wait and retry), `404 {"error":"No such scene"}`,
  `409 {"error":"Scene is not ready","status":"running"}`, `401 {"error":"Bad key"}`.

### 6.2b The real room: `GET BASE/api/roblox/:sceneId/model` and `.../model.glb`

Shivin's experience: "Deja View", place id `106038900865360` (VR / Meta Quest enabled). Join link for a room:
`https://www.roblox.com/games/start?placeId=106038900865360&launchData=<sceneId>`.

Photo scenes only. `model.glb` is the room as a textured mesh in named chunks (`room_00`, ...), each under Roblox's
triangle limit, in the same frame as the map. `model` is JSON: units, studsPerMeter, chunk names and triangle counts,
bounds, spawn in studs, and `assetId` once the server has uploaded it with Open Cloud (only when `ROBLOX_API_KEY` and
`ROBLOX_CREATOR_ID` are set). Load an `assetId` on the Roblox server with `AssetService:LoadAssetAsync`; without one,
build the map (6.2). Demo worlds are imported in Studio ahead of time.

### 6.3 Presence: `POST BASE/api/roblox/:sceneId/presence` (4 Hz, one loop per Roblox server)

Request: every Roblox player who is **inside the room** (not the lobby, not still loading).

```json
{ "players": [ { "id": "rbx-12345", "name": "shivin", "x": 4.2, "y": 0.0, "z": -1.5, "yaw": 1.57 },
               { "id": "rbx-67890", "name": "brianna", "x": -3.0, "y": 0.0, "z": 2.4, "yaw": -0.4 } ] }
```

Optional: `server` (`game.JobId`) lets the server drop that server's players the moment they stop being listed;
otherwise they drop after 3 s of silence.

Response, in studs: everyone in the scene except the players you just posted.

```json
{ "t": 1760715600.31,
  "others": [
    { "id": "quest-1", "name": "Judge", "kind": "vr", "x": 1.5, "y": 0, "z": -3.93, "yaw": 0.3,
      "hands": [[0.71, 4.32, -5.0], [2.32, 4.46, -4.82]] },
    { "id": "web-7f3a19c2", "name": "Maya", "kind": "web", "x": -3.57, "y": 0, "z": 2.86, "yaw": 3.1 } ] }
```

`hands` may be missing or `null`: fall back to a head-only ghost. Optional extra: `active` (`{sceneId, name}` of the
scene the headset is in, or `null`) for a follow mode.

### 6.4 Events: `POST BASE/api/roblox/:sceneId/event` (once per moment)

```json
{ "type": "round", "state": "start", "scores": { "quest-1": 0, "rbx-12345": 3, "rbx-67890": 3 } }
{ "type": "tag", "by": "quest-1", "target": "rbx-12345" }
{ "type": "round", "state": "end", "scores": { "quest-1": 4, "rbx-12345": 0, "rbx-67890": 2 } }
```

`200 {"ok":true}`. The rules: a round lasts **90 s** by default (for the skit Shivin sets it to 25 s so it ends at
about 1:40), the VR player is "it", and a Roblox avatar is tagged when either headset hand comes **within 4 studs** of
its HumanoidRootPart (`hands` missing: the headset's feet within 4 studs horizontally). Roblox's server is the referee: it
checks the headset's `hands` (from 6.3) against avatar positions and sends `tag` with `by: "quest-1"`. Send
`round start` when the round really begins (after the countdown). `scores` maps person id to a number (Shivin decides
what it counts; the headset only shows it). Extra fields are welcome (`duration`, `it`, `targetName`, `winner`). On
failure, retry up to 3 times, 1 s apart, then drop.

The server adds `t` and broadcasts on `/ws` for the headset:

```json
{ "type": "roblox", "sceneId": "game-night-k3x9a",
  "event": { "type": "tag", "by": "quest-1", "target": "rbx-12345", "t": 1760715612.4 } }
```

The headset plays TAGGED at the target's latest position, a "TAG: YOU'RE IT" banner on round start and a winner card
on round end.

**Request budget:** Roblox allows 500 HTTP requests per minute per game server. Presence (240) + picker (20) + map
loads + events stays near 280.

---

## 7. DeepSpace

### 7.1 Presence push: `POST <DS_URL>/api/ingest` (Déjà View server → Seb)

```
POST https://dejaview-live.app.space/api/ingest
Content-Type: application/json
X-DejaView-Key: <DS_KEY>

{ "sceneId": "game-night-k3x9a", "t": 1760715600.25,
  "people": [
    { "id": "quest-1",   "name": "Judge",  "kind": "vr",     "x": 0.42, "y": 0, "z": -1.10, "yaw": 0.30 },
    { "id": "rbx-12345", "name": "shivin", "kind": "roblox", "x": 1.05, "y": 0, "z": -0.38, "yaw": 1.57 } ] }
```

- About **4 Hz per active scene** (at least once a second while anyone is there, even if nobody moved). A full
  snapshot every time, metres, room frame, feet `y`, only these 7 fields per person, at most 32 people.
- Exactly one push with `"people": []` when the last person leaves.
- Fire and forget, 2 s timeout. If the previous push for that scene is still in flight, skip this one; never queue.
- Responses: `200 {"ok":true,"people":2}`, `400 {error}` (a contract bug: the server logs it once), `401` (wrong
  key), `413` (over 32 KB), `500`.

### 7.2 Notes (DeepSpace is the source of truth: auth, data and realtime live there)

A note:

```json
{ "id": "n_8f2k1q", "sceneId": "game-night-k3x9a", "author": "Brianna",
  "text": "Seb's seat. He was too scared to show up.",
  "x": 1.20, "y": 1.4, "z": -0.80, "createdAt": "2026-10-17T22:41:07Z" }
```

- `x, y, z` in room-frame metres. A web user clicks the room map; the app sets `x, z` from the click and `y = 1.4`
  (above the floor) unless set. `text` 1 to 120 characters, `author` at most 40 (the signed-in user's name).
- Web users create notes in the DeepSpace app on the room map. The map shows them at once (DeepSpace realtime).

DeepSpace worker endpoints (Seb), both with `X-DejaView-Key: <DS_KEY>`:

| Call | Body | Response |
| --- | --- | --- |
| `GET <DS_URL>/api/notes?sceneId=<id>` | | `200 {"notes":[note, ...]}`, oldest first |
| `POST <DS_URL>/api/notes` | `{sceneId, author, text, x, y, z}` | `201 {"ok":true,"note":note}` (DeepSpace makes `id` and `createdAt`) |

Errors: `400 {error}`, `401` wrong key.

Déjà View server (Ojasva):
- **Reads** `GET <DS_URL>/api/notes?sceneId=<id>` every **2 s** for every scene with someone in it (and at once when
  a scene gets its first person). It keeps the last good list; when DeepSpace is unreachable it serves that list.
- **Serves** `GET BASE/api/notes/:sceneId` → `{"notes":[...]}` to the headset, and broadcasts
  `{ "type": "note", "sceneId": "...", "note": {...} }` on `/ws` for every id it has not seen before.
- **Forwards** headset-created notes: `POST BASE/api/notes/:sceneId` with `{author, text, x, y, z}` → the server adds
  `sceneId` and calls `POST <DS_URL>/api/notes`, returns DeepSpace's response, and broadcasts the note. DeepSpace
  unreachable: `502 {"error":"notes offline"}`.
- End to end, a note typed on the map pops up in the headset within about 2.5 s.

The headset draws each note as a floating lime `#C6FF3D` sticky note at `(x, y, z)`, near-black bold text, wrapped at
about 22 characters, "— Brianna" underneath, turning to face the viewer about the vertical axis, with a soft pop
sound. Notes stay, so the next visitor finds them.

---

## 8. Gemini guide (Brianna's server at `GUIDE_URL`)

Plain HTTP, JSON in and out, no CORS needed (no browser calls it). The headset calls `BASE/api/guide/<name>` and the
server forwards the body to `GUIDE_URL/<name>`, adding `X-Guide-Key` and expanding `scene: {id}` into the full scene
context from its store. Guide unreachable: `502 {"error":"guide offline"}`. Exact field rules and examples:
`brianna.md` section 5.

`scene` (filled in by the server): `{ id, name, mode: "photo"|"video", caption, hotspots? }`, where `hotspots` is the
list of labels already pinned in this world (`[{label, blurb}]`), as extra context.

| Endpoint | Request | Response | Server timeout | Called |
| --- | --- | --- | --- | --- |
| `POST /describe` | `{image}` | `{caption}` | 5 s | by the server, right after an upload is accepted, before the GPU job |
| `POST /hotspots` | `{image, scene}` | `{hotspots:[{label, x, y, blurb}]}` | 15 s | by the headset on entering a world with no stored labels |
| `POST /narrate` | `{image, scene}` | `{answer, speech}` | 10 s | by the server when a scene becomes ready (cache warm-up), then by the headset on entering a Photo world |
| `POST /ask` | `{image, audio or question, scene, history}` | `{question, answer, speech, hotspot?}` | 10 s | by the headset: hold the button, ask out loud |

- `image`: a data URL, `data:image/jpeg;base64,...`. The headset sends a JPEG of what the person sees (about
  1024 × 768). `/describe` gets the scene's `thumb.jpg` (for a video, a frame from the first second: the empty spot).
- `caption` (from `/describe`): one or two sentences describing the place for a world generator: layout, materials,
  light, what is likely just outside the frame; no people. The server uses it as the world model's text prompt (the
  upload's own `prompt`, if any, goes first) and stores it as `scene.caption`. Timeout or error: the job runs with the
  built-in captioner, so a slow `/describe` never blocks a world.
- `x, y` in hotspots (and in `hotspot`): normalized 0 to 1 in the image you were sent, x to the right, y down.
- `audio`: `data:audio/webm;codecs=opus;base64,...` from the Quest's `MediaRecorder`, 1 to 8 s. Exactly one of
  `audio` or `question` (typed text) is set.
- `history`: the last 4 turns, `[{q, a}]`.
- `speech`: a WAV data URL (`data:audio/wav;base64,...`, 24 kHz mono 16-bit), or `null` when text-to-speech failed
  (the headset then shows the caption only).
- `hotspot` (optional in `/ask`): `{label, x, y}` when the answer is about one visible thing; the headset highlights it.
- Fallbacks: the guide never returns 500 on these routes. A Gemini failure comes back as `200` with a canned answer,
  `"degraded": true` and `"error"` (and `hotspots: []` for `/hotspots`).

**Labels in 3D (Ojasva):** the headset renders the capture with a known `PerspectiveCamera` and keeps its matrices. For
each hotspot: NDC = `(2x − 1, 1 − 2y)`, unproject, march along the ray in half-voxel steps until the voxel grid is
solid, anchor the label 0.05 m in front of the hit; no hit within 6 m drops it. The positions are stored per scene, so
labels appear instantly next time. The three demo worlds are labelled once in rehearsal and kept.

---

## 9. Photon bot (Seb)

**Dropped (Sat early morning):** Photon is not a Devpost prize and the bot did not work. The demo mode and live path
below now run from Seb's DeepSpace "Add a memory" page (`seb.md`, the update at the top); read "bot" as that page.

**Demo mode.** The bot keeps a table: SHA-256 of demo media → scene id, and keywords → scene id.

```json
{ "media":    { "<sha256 of the game-night clip as the bot receives it>": "game-night-k3x9a" },
  "keywords": { "#dejaview gamenight": "game-night-k3x9a", "#dejaview fortnite": "fortnite-q8w2e" } }
```

- Hash the bytes **as the bot receives them**, not the file on the phone (iMessage may re-encode). In rehearsal, send
  the clip once from the exact phone used on stage, copy the hash from the bot's log into the table, and send it again
  to confirm a hit. The keyword is the backup: Seb types it with the clip.
- A hit replies within 3 s: the thumbnail (Ojasva sets a good frame as `thumb.jpg` on the frozen game-night world),
  then the links below. No upload happens.

**Live path** (anything else): photos → `POST /api/scenes` with `mode=photo` (plus `name`, `files`); one video →
`mode=video`; then poll `GET /api/scenes/:id` every 2 s until `status` is `ready` (or `failed`: pass the `error`
sentence through). `WS /ws` is an optional speed-up (filter `scene` events by `id`); polling alone is enough. Ack
within 2 s, one progress message, reply on `ready`. Never block the message loop on a job.

Photon's free lines only talk to phone numbers registered first, so every phone that texts the bot (the table iPhone,
the teammates' phones, a judge's own phone) is registered with Photon beforehand. An unregistered judge uses the table
iPhone at 2:00.

**Reply** (both paths), in the same thread so the whole chat can get in:
- the thumbnail `BASE/data/scenes/<id>/<thumb>`,
- walk in: `BASE/view?scene=<id>` (public `BASE`),
- join from Roblox: `https://www.roblox.com/games/start?placeId=<PLACE_ID>&launchData=<sceneId>` (Shivin sends
  `PLACE_ID`),
- see who's inside: `<DS_URL>/m/<id>`.

**Optional `load` cue:** after a demo hit or a live `ready`, the bot may call
`POST BASE/api/host/cue {"action":"load","sceneId":"<id>","by":"bot"}` (no key from `127.0.0.1`, otherwise
`x-dejaview-key`). A Quest on `?follow=1` then loads that world. The skit does not depend on it: the game-night world
is already loaded on the Quest, and a finale world that becomes `ready` is picked up by follow mode on its own.

---

## 10. WebSocket messages (complete list)

| `type` | Payload | Status |
| --- | --- | --- |
| `health` | `health` | exists |
| `scene` | `scene` | exists |
| `scene_deleted` | `id` | exists |
| `note` | `sceneId`, `note` | 7.2 |
| `roblox` | `sceneId`, `event` (`tag`, `round` start/end, with `t`) | 6.4 |
| `cue` | `action` (`reality`, `labels`, `load`), `on?`, `sceneId?`, `at` | 9, 11 |
| `hotspots` | `sceneId`, `hotspots` (3D, metres) | Ojasva-internal (11) |

Seb's gallery and bot act only on `scene` and `scene_deleted`.

---

## 11. Ojasva-internal (no teammate depends on these)

- `POST /api/host/cue` from the `/host` page on the table laptop (or the bot, section 9): `{action:"reality", on}`,
  `{action:"labels", on}`, `{action:"load", sceneId}` → `cue` on `/ws`, response `{ "ok": true }`. This is how the
  host flips the reality check at 1:00 and drops the judge into the Fortnite world at 2:10.
- Viewer `?follow=1` on the Quest: obeys `cue`, and loads a scene that becomes `ready` after the page opened (the
  finale) by swapping the world **inside the running XR session** (a page reload would end it). Fallback: B button
  leaves VR, the page swaps, the judge presses Enter VR again (about 5 s).
- `PUT/GET /api/scenes/:id/hotspots`: the 3D label positions.
- The map bake writes `world.floorY` (if `null`) and `world.bounds` (if missing) into `scene.json`, plus `topdown.jpg`,
  so the headset, Roblox and the DeepSpace map agree to the centimetre.
- Rename user-facing server strings (mode labels, error text) to Photo and Video.

---

## 12. Deadlines

### 12.1 Ojasva delivers

| By | What | Unblocks |
| --- | --- | --- |
| Fri night | `:8788` listener; LAN `BASE` posted; `photo`/`video` aliases; `DV_KEY` made | everyone's curl tests |
| **Sat 10 AM** | **Every endpoint answers on the LAN** in the shapes above: presence (5), Roblox map (sample scenes) + presence + event (6), DeepSpace push (7.1), notes relay against Seb's local DeepSpace or a mock (7.2), guide proxy (8), host cue (11). 3 real headset request bodies saved as JSON for Brianna | every pair test |
| Sat 12 PM (optional) | an early quick tunnel, if ready, for Shivin's first tests from real Roblox servers (Roblox servers cannot reach a LAN address; until a public link exists Shivin works on mock data) | Shivin |
| **Sat 4 PM** | **Public https `BASE`**. Map + `topdown.jpg` + floor/bounds for every new ready scene within 10 s. `/describe` in the upload flow; `/narrate` warm-up on ready. Push and notes pointed at Seb's deployed app | everything talks to the real server |
| Sat 6 PM | Viewer: voice button, narration playback, hotspot pins, reality-check toggle | Brianna's tuning with real views |
| Sat 8 PM | Viewer: Roblox ghosts, sticky notes, tag moments, follow mode. Demo worlds frozen (game night, Fortnite, backup photo world) and labelled. Guide and bot running on the demo Mac | the full run |

If behind, cut in this order and say so in the team chat the moment you cut:
1. **P0 (the demo breaks without it):** 8788 + tunnel, presence, Roblox map/presence/event, ghosts + TAGGED, DeepSpace
   push, notes relay + sticky notes, `topdown.jpg`, guide proxy + voice ask + hotspot pins, reality check, host cue,
   follow mode (or its fallback), the frozen demo worlds, a warm GPU for live Photo.
2. **P1:** `/describe` in the upload flow (the finale still works with the built-in captioner), narrate warm-up, the
   in-session swap (fallback above).
3. **P2:** imagined flag on Roblox parts, `chunk`, `active`, headset-created notes.

### 12.2 Teammates deliver

| Who | What | By |
| --- | --- | --- |
| Seb | Vultr: A40 test deploy, then destroy; "Vultr OK" or the exact error to Ojasva. Demo phones registered with Photon; Photon line tested in a group chat; DeepSpace account (referral code entered first) and app name | tonight |
| Brianna | Gemini key works; free-tier limits sent to Ojasva | tonight |
| Shivin | Roblox Studio, place published private, HTTP requests on; building on mock data | tonight |
| Brianna | all four endpoints (`/describe`, `/hotspots`, `/narrate`, `/ask`) working via curl on fixtures; median `/ask` latency | Sat 10 AM |
| Seb | the bot replying: a photo texted → world link on the LAN; demo mode table working | Sat 10 AM |
| Shivin | room loader, picker, VR ghost and tag rounds working on mock data | Sat 10 AM |
| Shivin | `PLACE_ID` and the join link to Seb and Ojasva | Sat 12 PM |
| Brianna | `GUIDE_KEY` (in person) + laptop `GUIDE_URL`; wired into the headset through the server | Sat afternoon (by 4 PM) |
| Seb | DeepSpace map and notes: deployed `DS_URL` + `DS_KEY` (in person), `/api/ingest` and `/api/notes` live (post the URL as soon as the first deploy works) | Sat 4 PM |
| Shivin | the experience on the real public `BASE` | Sat 4 PM |
| Brianna, Seb | guide folder and bot folder (no `.env`) running on the demo Mac | Sat 8 PM |
| Seb | Capital One side quest: ready and good, or dropped | Sat 10 PM |
| Everyone | full demo run Sat 10 PM; feature freeze Sun 4 AM; submission Sun 8 AM | |

---

## 13. Demo test plan

### 13.0 Demo assets (filmed by Sat 2 PM, frozen by Sat 8 PM)

| Asset | How | Owner | Pass |
| --- | --- | --- | --- |
| Game-night clip (Video) | On the table iPhone, propped completely still, 1.5 to 3 m away, landscape, 15 to 20 s with sound. A couple of seconds of the empty spot first, then everyone except Seb sits down and plays, a last-second upset, everyone yelling. The game screen visible and readable (big results screen). Snacks on the table, one empty couch seat (Seb's). 3 takes, keep the best | Ojasva runs it; Seb props the phone and stays out of frame | the built world shows the room, the people in 3D and the readable screen; "who won?" is answered correctly from it |
| Ping pong clip (optional, Video) | Same rules. The players look great; the tiny fast ball may flicker | Ojasva | only kept if it looks good |
| Fortnite frame (Photo) | A clean, HUD-free frame of real gameplay. On a Mac: Xbox Cloud Gaming in a browser (xbox.com/play, Fortnite is free with a Microsoft account; GeForce NOW free tier as backup). On a PC or console: Replay mode (hide the HUD, free camera). Record with Cmd+Shift+5 at a scenic, calm spot; one wide screenshot (or a slow 10 s pan, pick the best frame) | Ojasva | no HUD, no players in frame; `/describe` keeps the game's art style |
| Backup photo world | One good room photo, built in advance | Ojasva | ready to load if the live finale build is slow |

Freeze checklist (Sat 8 PM): demo worlds built and their ids posted (game night, Fortnite, backup photo world); labels
checked in each world and fixed by hand where wrong; the bot's demo table holds the hash it logged when the clip was sent
from the table iPhone, plus the keyword; Shivin's baked Roblox copies of the demo rooms; rehearsal notes deleted in
DeepSpace before each run. Our own footage leads; Fortnite comes second.

### 13.1 Each piece alone (by Sat 10 AM)

| Piece | Test | Pass |
| --- | --- | --- |
| Server | the curl block in 13.2 against the LAN `BASE` | every call returns the documented shape |
| Roblox | Studio with 2 clients and the mock | mock room builds behind the loading screen, the mock ghost glides on both, a tag round works (90 s default, 25 s skit setting) |
| Guide | Brianna's curl scripts on room photos and a screenshot of a gaming setup | a one or two sentence `caption` with no people; 3 to 6 labels on the screen, controllers, snacks; `/ask` with a recorded "who won?" answers about the screen in under 2 s |
| Bot | text a photo; send the demo clip; send the keyword | world link back on the LAN; demo clip and keyword answered in under 3 s |
| DeepSpace | fake feed against the app; a note click | three dots gliding at 60 fps; the note appears on the map at once |

### 13.2 Server contract checks (Ojasva runs these after every server change)

```bash
B=http://localhost:8788; K=$DV_KEY; S=test-tw-local
curl -s -F mode=photo -F name="curl photo" -F files=@room.jpg $B/api/scenes | jq '{id, mode, status}'
curl -s $B/api/scenes | jq '[.[] | select(.status=="ready") | .id]'
curl -s -X POST $B/api/presence/$S -H 'Content-Type: application/json' \
  -d '{"id":"quest-1","name":"Judge","kind":"vr","x":0,"y":0,"z":0,"yaw":0,"hands":null}' | jq .
curl -s "$B/api/roblox/$S/map" -H "x-dejaview-key: $K" | jq '{studsPerMeter, spawn, parts: (.parts|length), first: .parts[0]}'
curl -s -X POST $B/api/roblox/$S/presence -H "x-dejaview-key: $K" -H 'Content-Type: application/json' \
  -d '{"players":[{"id":"rbx-1","name":"curl","x":4,"y":0,"z":0,"yaw":0}]}' | jq .     # others has quest-1
curl -s $B/api/presence/$S | jq '.people[] | {id, kind, x}'                     # rbx-1 x = 1.12 (4 / 3.57)
curl -s -X POST $B/api/roblox/$S/event -H "x-dejaview-key: $K" -H 'Content-Type: application/json' \
  -d '{"type":"tag","by":"quest-1","target":"rbx-1"}' | jq .
curl -s $B/api/notes/$S | jq '.notes | length'
curl -s -X POST $B/api/host/cue -H 'Content-Type: application/json' -d '{"action":"reality","on":true}' | jq .
curl -s -X POST $B/api/guide/narrate -H 'Content-Type: application/json' -d '{"scene":{"id":"'$S'"}}' | jq '{answer, degraded}'
```

Watch the WebSocket at the same time (`bunx wscat -c ws://localhost:8788/ws`): each `roblox`, `note` and `cue`
message must show up.

### 13.3 Pairs (Sat 10 AM to 6 PM)

| Pair | Do | Pass |
| --- | --- | --- |
| Roblox ↔ server | a 60 s fake VR player by curl, then the real headset | the ghost moves at head height facing where it walks; the headset sees the avatars where they really are |
| Coordinates | Ojasva stands in a corner in VR; Shivin walks his avatar to the ghost's feet | positions agree within 0.3 m; yaw is not mirrored |
| Server → DeepSpace | Ojasva walks in a sample room on the desktop viewer | the dot on the map moves the same way within 0.5 s; walking toward −Z points the cone up |
| DeepSpace → headset | Brianna clicks the map and types a note | the note appears in the headset within 2.5 s at the spot she clicked, at 1.4 m |
| Guide ↔ headset | Ojasva looks at the screen in the game-night memory and asks "who won?" | caption and voice together within 2.5 s of releasing the button (the guide itself under 2 s); the answer names the right winner and the screen pin highlights |
| Bot → everyone | Seb sends a new photo to the group chat | the reply arrives with all links; the room appears in the Roblox picker and the DeepSpace gallery within 3 s of `ready` |

### 13.4 Full run: skit + finale (Sat 10 PM twice with a timer, again Sun 2 AM)

Before starting (Ojasva checks): `/host` shows guide ok, GPU warm (send one photo 10 minutes before), tunnel up; the
game-night world loaded on the Quest (`/view?scene=<id>&follow=1`), mic permission granted; Shivin and Brianna in the
Roblox lobby with the game-night room already built; the DeepSpace map open full screen on the table laptop; Brianna
signed in to DeepSpace; rehearsal notes deleted; the table iPhone (registered with Photon) in the group chat.

| Time | Check | Owner | Target | Fallback if it fails |
| --- | --- | --- | --- | --- |
| 0:00 | Seb drops the clip → bot reply with thumbnail + links (demo mode) | Seb | under 3 s | Seb sends the keyword; host opens it from `/host` |
| 0:15 | Judge in the game-night memory, video plays with sound | Ojasva | instant | recorded clip |
| 0:40 | Labels on the screen, controllers, snacks; the judge looks at the screen and asks "who won?"; answered out loud | Brianna / Ojasva | labels on entry (stored); answer within 2.5 s of release (guide under 2 s) | the judge asks again; caption only (`degraded`); recorded clip |
| 1:00 | Reality-check cue tints the imagined parts | Ojasva | under 1 s | |
| 1:10 | Shivin and Brianna press JOIN and appear in the headset; the tag round starts with the judge as "it" (25 s for the skit, so it ends at about 1:40; Shivin can also end it from his HUD); the judge tags someone, TAGGED, then the winner card | Shivin | both avatars in under 1 s; ghost lag under 0.7 s; TAGGED in the headset within 1 s | recorded clip |
| 1:40 | DeepSpace map: three dots with trails; Brianna clicks the couch, types "Seb's seat. He was too scared to show up."; it pops up in the headset | Seb / Brianna | note within 2.5 s, at the couch, 1.4 m up | fake feed only if said out loud on stage |
| 2:00 | "Now do it": judge's photo sent → bot ack; `/describe` caption in the server log | Seb | ack under 2 s | table iPhone instead of an unregistered phone |
| 2:10 | Host drops the judge into the Fortnite world while it builds | Ojasva | | skip if the build is already done |
| 2:25 | World ready → bot reply, headset swaps in, greeting plays, labels pop in; the room is in the Roblox picker (Shivin hops in) and the DeepSpace gallery | Ojasva / Brianna / Shivin / Seb | ready within 30 s of sending; everywhere within 3 s of ready | say so honestly, load the backup photo world (built earlier) or show the recorded finale clip |
| 2:45 | Capital One (optional) | Seb | 15 s | skip |

Write down every time that misses its target and fix the slowest first.

### 13.5 Failure drills (once each, Sat night)

- Kill the tunnel: Roblox shows a banner and recovers by itself; the DeepSpace map dims ("No one here right now").
- Stop the guide: the headset shows the canned line; labels stay (stored).
- Stop DeepSpace pushes and notes: existing notes stay in the headset; the map dims, never freezes on old dots.
- Turn the Mac's Wi-Fi off: the Quest on the LAN keeps the world; everything else degrades politely.
- Restart the server mid-round: presence repopulates within 1 s, nobody refreshes anything.
- Cold GPU: send a photo 10 minutes before the demo and confirm the build time.

---

## 14. Rules

Everyone writes all their own code during the event. Credit every AI tool you used on Devpost, as the rules require.
Keys never go in code, commits, screenshots or group chats.
