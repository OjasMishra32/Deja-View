# Shivin: Déjà View in Roblox

Read `plan.md` first (the story), then this. `contracts.md` has the wiring for the whole team; where this page and
`contracts.md` disagree, `contracts.md` wins.

Your experience is minute **1:15** of the demo (you and Brianna join as Roblox avatars and play tag with the judge),
and the positions you send are the Roblox dots on Seb's live DeepSpace map at **1:45**.

**Prize:** Best Use of Roblox Studio. Build it in Roblox Studio with the core logic in Luau. Confirm the exact judging
criteria on the SwampHacks Discord tonight: ask whether the experience must be published or public, and whether a place
file has to be submitted.

---

## 1. The moment you are building

A judge in the Quest 3S stands in Brianna's kitchen: the Third Wheel cooking memory that Seb's bot dropped into the
group chat at 0:00. You and Brianna are already in the Roblox lobby on two laptops. When the judge enters the memory
(0:20), your experience sees it ("Judge entered Game night") and quietly builds the same room out of colored blocks
in the background, while you both wait in the lobby.

At **1:15** the host says "and friends without a headset can still be there". You press **JOIN** on your HUD: you and
Brianna spawn inside the room within a second. A glowing lime ghost (a head, two hands and a faint body) moves around
the room exactly as the judge moves, and the judge sees your avatars in the headset. A **30-second** tag round starts
with the headset player as "it". The judge reaches out with a controller, your avatar bursts into lime sparks, the
headset shows **TAGGED**, and a scoreboard and winner screen follow. Same room, two engines, live, no refresh.

In the bigger story (`plan.md`, "Roblox: friends without a headset can still be there"), the people in the group chat
where the photo was posted tap a link and join the same room from a laptop **or a phone**. Your experience is how
someone without a headset is still in the memory.

What has to be true on the night:

| Requirement | Target |
| --- | --- |
| Judge enters VR → room built in Roblox (follow mode) | 15 s or less (aim for 10) |
| JOIN pressed → both avatars inside the room | 1 s or less (the room is already built) |
| Judge moves → ghost moves in Roblox | 0.7 s or less end to end, and smooth (glides, never teleports) |
| Frame rate on the demo laptops | 60 fps with the room loaded |
| Failures | Self-healing: banner, retry, cached room. Nobody rejoins, nobody restarts |

---

## 2. Decisions already made (and why)

These came out of checking the Roblox docs. Do not re-litigate them on Saturday.

1. **Blocks, not EditableMesh.** The room is built from anchored `Part`s. EditableMesh is disabled in published games
   unless you turn on a security toggle. It has strict memory budgets on the client and a cap of 20,000 triangles per
   mesh. In April 2026, developers on the DevForum reported that it does not replicate from the server: clients see a
   checkerboard box. Parts replicate, collide and just work.
2. **Part budget: 3,000 to 6,000 parts, hard cap 12,000.** The server merges voxels into boxes before sending them. The
   map endpoint takes `maxParts` so you can request a coarser room if building is slow.
3. **The map arrives in chunks of at most 2,500 parts (about 120 KB each).** Roblox does not document a maximum response
   size, so we never depend on a large one. Chunks also give you a real progress bar, and the floor comes first, so
   players can land early.
4. **HTTP runs only on the Roblox game server.** LocalScripts cannot use HttpService. One server Script owns the network
   and tells clients what to show through attributes and RemoteEvents.
5. **Presence is polled at 4 Hz.** HttpService can stream (SSE or WebSockets) only in Studio, so a published game cannot
   use it. Polling uses about 280 of the 500 requests per minute that each game server gets.
6. **Each client renders the ghost itself and interpolates it.** Roblox's performance guide warns that moving things
   from the server (server-side TweenService) makes them jittery and wastes bandwidth. The server sends ghost snapshots
   4 times a second, and each client draws the ghost 0.35 s in the past, sliding between snapshots.
7. **The public URL is a Cloudflare Tunnel, never free ngrok.** Free ngrok allows only 20,000 requests a month, and
   Roblox alone makes 14,400 an hour. The URL lives in an **Experience Config**, so a new tunnel URL takes effect in
   under a minute without republishing.
8. **The shared key lives in the Roblox Secrets store, never in a script.** It is sent as a header.
9. **Scale comes from the server.** Every map response carries `studsPerMeter` (default 4.0). One stud is 28 cm, so 4.0
   makes a room slightly bigger than life, which gives avatars of about 5 studs room to run. Never hard-code the scale.
10. **The room picker shows color swatches, not thumbnails.** An ImageLabel can only show images uploaded to Roblox, so
    the server sends 4 dominant colors per room.
11. **Every Roblox server reports its `game.JobId`.** If someone lands in a different Roblox server, they still show up
    in VR, on the map and as a ghost for you. The demo never depends on everyone landing in the same server, even
    though they normally will.

---

## 3. Accounts and setup (tonight, in this order)

| # | Step | Time | If blocked |
| --- | --- | --- | --- |
| 1 | Install Roblox Studio from https://create.roblox.com (Start Creating → download). Sign in. | 10 min | Use another teammate's computer |
| 2 | **Age check** on your account: Roblox app or site → Settings (gear) → Account info → Age Group → Continue with selfie. You need a camera (a phone works). See https://about.roblox.com/age-estimation | 5 min | Use ID verification (takes a few minutes). If both fail, a teammate who passes owns and publishes the experience and gives you Edit access |
| 3 | Add Ojasva, Seb, Brianna and the second Roblox player as **Roblox friends**. On a user-owned game, Edit permission can only go to friends. | 5 min | Make a Roblox group, which needs no friendship |
| 4 | Studio: New → Baseplate. Then File → **Publish to Roblox**, name it "Déjà View" and leave it **Private**. | 5 min | |
| 5 | File → Experience Settings → Security → **Allow HTTP Requests: ON**. Save. | 1 min | Unpublished place: in the Command Bar, run `game:GetService("HttpService").HttpEnabled = true` |
| 6 | Workspace properties: **StreamingEnabled: OFF**. This is one room, so streaming only adds "part not there yet" bugs. You can only change it in Studio. | 1 min | |
| 7 | Studio → Collaborate: add each teammate with **Edit**. Adding collaborators needs the age check from step 2. Friends with Edit can join your Private experience from the Roblox app. | 5 min | |
| 8 | Install `cloudflared` for the transport test in section 9.3 (`brew install cloudflared`, or the Windows installer from Cloudflare). | 5 min | Skip it and test against Ojasva's tunnel Saturday morning |

Saturday, once Ojasva sends the tunnel URL and key (section 4):

| # | Step | Time |
| --- | --- | --- |
| 9 | Creator Hub → your experience → **Secrets** → Create Secret. Name `dejaview_key`, value = the key Ojasva DMs you. Domain = the tunnel host, or `*.trycloudflare.com` for a quick tunnel. | 3 min |
| 10 | Studio → File → Experience Settings → Security → **Local Secrets**: add the same `dejaview_key`. Live secrets are not available in a local playtest. | 2 min |
| 11 | Creator Hub → your experience → **Configs** → Create config `dejaview_base` (string) = the tunnel URL with no trailing slash → **Publish now**. Also create `demo_round_seconds` (number) = 30. | 3 min |
| 12 | Creator Hub → your experience → fill in the **Maturity & Compliance questionnaire**, so you can open the audience on Sat 4 PM (see below) | 10 min |

Who can play, and how:

- **Teammates (the demo):** they are friends with Edit, so they open the experience from the Roblox app. By default,
  Roblox matchmaking always places a joining player in a server with their friends, or with players on the same IP
  address (same Wi-Fi). Two laptops on the same Wi-Fi land together. For certainty, join from the friend's profile.
- **Friends from the group chat and judges, on their own accounts and phones (Sat 4 PM):** a Private experience only
  lets in people with Edit permission. To let anyone with the link join, the publishing requirements for a Limited or
  Public audience must be met: your age check, an account in good standing that is at least 2 days old, and the
  Maturity & Compliance questionnaire (about 10 minutes, Creator Hub → your experience). Then do one of these:
  - Audience → **Public** with **Enable Beta Mode** on: anyone with the link can join, and Beta keeps it out of
    recommendations. This is the best fit for "friends from the group chat tap a link".
  - Audience → **Limited → Playtesters**: add specific judges' usernames with Play permission.

  Stay Private until Saturday afternoon. If none of this works out, hand the judge a teammate's laptop.
- **Team Test** (the Studio test-mode dropdown → Team Test) runs on a Roblox server, so it can reach the public tunnel.
  Your teammates join it from their Studio. Use it to rehearse together before you republish.

---

## 4. Architecture

```
  Roblox clients (laptops, phones)    Roblox game server (Roblox datacenter)          Déjà View server (Ojasva's Mac)
 ┌────────────────────────┐ attrs  ┌──────────────────────────────────┐   HTTPS 443   ┌──────────────────────────────┐
 │ Client (LocalScript)   │◀───────│ Main (Script)                    │──────────────▶│ GET  /api/roblox/rooms        │
 │  UI: loading, picker,  │ events │  Api ── the only network code    │  Cloudflare   │ GET  /api/roblox/:id/map      │
 │  HUD, scoreboard       │───────▶│  MapBuilder  Rooms  Presence     │◀──────────────│ POST /api/roblox/:id/presence │
 │  Ghost renderer        │        │  TagGame (authoritative)         │    tunnel     │ POST /api/roblox/:id/event    │
 │  (interpolates)        │        │                                  │               └───────────┬──────────────────┘
 └────────────────────────┘        └──────────────────────────────────┘                           │ studs ↔ metres
                                                                                 Quest 3S viewer ◀─┼─▶ DeepSpace live map (Seb)
                                                                                 (ghosts, TAGGED)  └─▶ people count for Gemini (Brianna)
```

- **Who calls whom:** only your Roblox **server** calls the Déjà View server. Nothing ever calls Roblox. Clients talk only
  to your server, through RemoteEvents and attributes.
- **BASE:** the `dejaview_base` config value, for example `https://dejaview-xyz.trycloudflare.com`. HTTPS on port 443
  only. (The tunnel ends at Ojasva's plain-HTTP port 8788; you never see that.)
- **Headers on every request:** `content-type: application/json` (on POSTs) and `x-dejaview-key: <Secret>`. The secret
  value is Ojasva's `DV_KEY`. Use lowercase header names, because HTTP/2 requires them. If `GetSecret` fails, send the
  request without the key and warn once in the Output window. The server accepts keyless requests unless Ojasva turns
  enforcement on.

### Coordinate frame (shared with Ojasva, exact)

- **The room frame is the Workspace frame.** Build the room at the Workspace origin. Studs, Y up, floor at `y = 0`. Put
  your lobby far away (centred at `0, 300, 0`) so nothing needs an offset.
- **Axes match the headset viewer.** Both are right-handed, Y up, with -Z forward. Everyone else uses the **room frame**
  in metres (`contracts.md` 3.1): the viewer frame shifted so the floor is at y = 0. The server converts with
  `studs = metres * studsPerMeter` and back again, axis for axis. You never convert anything yourself: everything
  you send and receive is studs.
- **Yaw** is in radians: 0 faces -Z, and positive turns left (counter-clockwise seen from above). It is the same angle
  as `CFrame.Angles(0, yaw, 0)`:
  ```lua
  local look = hrp.CFrame.LookVector
  local yaw = math.atan2(-look.X, -look.Z)                   -- character → yaw
  local cf  = CFrame.new(pos) * CFrame.Angles(0, yaw, 0)     -- yaw → CFrame
  ```
- **`x, y, z` of any person is their feet on the floor.** For a Roblox R15 avatar, use
  `feetY = hrp.Position.Y - (humanoid.HipHeight + hrp.Size.Y / 2)`. VR people also carry `head` (eye position) and
  `hands`.
- **IDs:** Roblox players are `"rbx-" .. player.UserId`. VR is `quest-1` (more if there are more headsets), and web
  viewers are `web-xxxx`.

### What Ojasva provides, and by when

| What | Shape | Deadline |
| --- | --- | --- |
| Public HTTPS tunnel URL + shared key `DV_KEY` (key by DM, never in chat or code) | `https://<host>` | Sat 12 PM (no later than 4 PM) |
| `GET /api/roblox/rooms` | §5.1 | Sat 12 PM |
| `GET /api/roblox/:id/map` for the two sample scenes | §5.2 | Sat 12 PM |
| `POST /api/presence/:id` (metres; what the headset uses), so you can fake a VR player with curl | §9.4 | Sat 12 PM |
| `POST /api/roblox/:id/presence` relay (others + active) | §5.3 | Sat 2 PM |
| Maps generated automatically for every new ready scene, within 10 s | §5.2 | Sat 4 PM |
| `POST /api/roblox/:id/event` forwarded to the headset (TAGGED, scoreboard) and to DeepSpace | §5.4 | Sat 4 PM |
| Headset viewer draws Roblox players as ghosts | (his side) | Sat 8 PM |

Until then, everything runs against your mock (section 9.1). You are never blocked.

---

## 5. Endpoints (full contract)

Common rules:

- JSON in, JSON out. Numbers are studs, rounded to 2 decimals. Times `t` are server epoch seconds (floats).
- Errors are `{ "error": "message" }` with a 4xx or 5xx status. A response that is **HTML instead of JSON** (a Cloudflare
  error page when the tunnel is down, typically HTTP 502 or 530) means **offline**: back off and retry.
- `429` means you are being rate limited: wait 5 s.

### 5.1 `GET BASE/api/roblox/rooms`

Ready rooms, newest first (at most 12), plus where the headset player is right now.

```json
{
  "t": 1760715600.2,
  "active": { "sceneId": "dorm-k3x9", "name": "Dorm room" },
  "rooms": [
    { "id": "dorm-k3x9", "name": "Dorm room", "mode": "rentfree", "createdAt": "2026-10-17T14:02:11Z",
      "map": "ready", "parts": 5821, "people": 1,
      "swatch": [[120,104,90],[220,214,200],[60,70,90],[200,160,90]] },
    { "id": "kitchen-a1b2", "name": "Kitchen", "mode": "thirdwheel", "createdAt": "2026-10-17T13:40:00Z",
      "map": "building", "parts": 0, "people": 0, "swatch": [] },
    { "id": "sample-painted-bedroom", "name": "Painted bedroom", "mode": "sample", "createdAt": "2026-10-17T00:08:15Z",
      "map": "ready", "parts": 4410, "people": 0,
      "swatch": [[180,120,90],[90,70,60],[230,220,200],[40,60,80]] }
  ]
}
```

- `active` is `null` when nobody is in VR. `map` is `"ready"`, `"building"` or `"failed"`, and only `ready` rooms can be
  loaded. `people` is everyone in that room right now, across all kinds.
- Poll it every 3 s while you are in the lobby or the picker is open. Otherwise, the presence response carries `active`.

### 5.2 `GET BASE/api/roblox/<sceneId>/map?chunk=0&maxParts=6000`

`200 OK`. Every chunk repeats the header fields, so any chunk on its own is enough to start.

```json
{
  "v": 1,
  "sceneId": "dorm-k3x9",
  "name": "Dorm room",
  "studsPerMeter": 4.0,
  "bounds": { "min": [-14.2, -1, -13.0], "max": [15.8, 10.4, 13.6] },
  "ceilingY": 10.4,
  "spawns": [[0, 0, 6], [3, 0, 4], [-3, 0, 4]],
  "spawnYaw": 3.14159,
  "vrSpawn": [0, 0, 0],
  "floorColor": [120, 104, 90],
  "totalParts": 5821,
  "chunk": 0,
  "chunks": 3,
  "parts": [
    [0, -0.5, 0, 30, 1, 26, 120, 104, 90],
    [0, 5.2, -12.5, 30, 10.4, 1, 220, 214, 200]
  ]
}
```

- Each part is `[x, y, z, sx, sy, sz, r, g, b]`: centre and size in studs, Y up, axis-aligned, color 0 to 255.
  An **optional 10th value** may appear later: `1` = the AI imagined this block, `0` = the camera actually captured it
  (for the Reality check toggle in 7.8). Read `p[10]` only if it is not nil.
- Parts are sorted **bottom-up** (floor first). The ceiling is **left out**, so the third-person camera can see in from
  above. `ceilingY` tells you where to put an invisible collision lid.
- `spawns` are free floor points where `y` is the floor height. Add 3 studs for the root part. They sit away from
  `vrSpawn`, so nobody spawns inside the judge.
- `maxParts` is optional (default 6000). The server coarsens the voxels until the room fits.
- Fetch `chunk=0` first, then `1` to `chunks-1` one after another (not in parallel). Cache the decoded chunks per
  `sceneId` in a server-side table, so switching back is instant.

Errors:

| Status | Body | Do |
| --- | --- | --- |
| 202 | `{ "status": "building", "retryAfter": 2 }` | wait `retryAfter`, retry (the loading screen says "Measuring the room...") |
| 404 | `{ "error": "No such scene" }` | toast, back to the picker |
| 409 | `{ "error": "Scene is not ready", "status": "running" }` | retry in 3 s, at most 20 times |
| 400 | `{ "error": "chunk out of range" }` | bug: log it, stop |
| 401 | `{ "error": "Bad key" }` | banner "Key rejected", keep the current room |

### 5.3 `POST BASE/api/roblox/<sceneId>/presence` (4 times a second, one loop per Roblox server)

Request: every Roblox player who is **in the room**. Leave out players who are in the lobby or still loading.

```json
{
  "server": "8b1c0e3a-6f1d-4f9e-9a55-2f3c1d1e9b77",
  "lastEventId": 40,
  "players": [
    { "id": "rbx-12345", "name": "shivin", "x": 4.2, "y": 0.0, "z": -1.5, "yaw": 1.57, "state": "playing" },
    { "id": "rbx-67890", "name": "brianna", "x": -3.0, "y": 2.1, "z": 2.4, "yaw": -0.4, "state": "caught" }
  ],
  "round": { "state": "running", "endsAt": 1760715645.0, "it": "quest-1",
             "scores": { "quest-1": 2, "rbx-12345": 3, "rbx-67890": 1 } }
}
```

- `server` is `game.JobId`. JobId is an empty string in Studio, so use `"studio-" .. HttpService:GenerateGUID(false)`
  once per session.
- `name` is the player's `DisplayName`. `state` is `playing`, `caught` (inside the 3 s immunity), `out` (no lives) or
  `idle`.
- `round` is optional. Send `{ "state": "idle" }` between rounds. In `scores`, a Roblox player's value is their lives
  left and the VR player's value is their tags. Never send an empty table: Luau encodes `{}` as `[]`.

Response:

```json
{
  "t": 1760715600.31,
  "active": { "sceneId": "dorm-k3x9", "name": "Dorm room" },
  "others": [
    { "id": "quest-1", "name": "Judge", "kind": "vr", "t": 1760715600.18,
      "x": 0.4, "y": 0, "z": 2.0, "yaw": 0.3,
      "head": [0.4, 6.4, 2.0],
      "hands": [[-1.6, 4.8, 0.9], [1.9, 5.0, 1.1]] },
    { "id": "web-7f3a", "name": "Seb", "kind": "web", "t": 1760715599.90, "x": -3, "y": 0, "z": 1, "yaw": 2.1 },
    { "id": "rbx-55555", "name": "late judge", "kind": "roblox", "server": "other-job-id", "t": 1760715600.05,
      "x": 6, "y": 0, "z": -2, "yaw": 0 }
  ],
  "events": [ { "id": 41, "type": "start_round", "from": "quest-1" } ]
}
```

- `others` is everyone in this scene **except** players from your own `server`. The server drops anyone silent for 3 s.
- `hands` can be missing or `null`, for example when controllers are idle or the person is on desktop. Fall back to a
  head-only ghost.
- `t` per person is when the server last heard from them. Use it to drop duplicates and as the interpolation timeline
  (sections 7.3 and 7.4).
- `events` is optional, so ignore it if it is missing. These are commands from the headset or Ojasva:
  `start_round`, `end_round`, `reload_room`. Apply each `id` once, and send the highest one back as `lastEventId`.
- If `active.sceneId` differs from your room and Follow is on, start the follow countdown (section 7.2).

### 5.4 `POST BASE/api/roblox/<sceneId>/event`

Send each of these once, the moment it happens. The response is `{ "ok": true }`. On failure, retry up to 3 times with a
1 s gap, then drop it.

```json
{ "server": "<JobId>", "type": "round", "state": "start", "duration": 30, "it": "quest-1",
  "players": [ { "id": "rbx-12345", "name": "shivin" }, { "id": "rbx-67890", "name": "brianna" } ] }

{ "server": "<JobId>", "type": "tag", "by": "quest-1", "target": "rbx-12345", "targetName": "shivin",
  "livesLeft": 2, "at": [4.1, 2.8, -1.2], "scores": { "quest-1": 3, "rbx-12345": 2, "rbx-67890": 3 } }

{ "server": "<JobId>", "type": "round", "state": "end", "winner": "roblox",
  "mvp": { "id": "rbx-67890", "name": "brianna" }, "survivors": ["rbx-67890"],
  "scores": { "quest-1": 4, "rbx-12345": 0, "rbx-67890": 2 } }
```

`winner` is `"vr"` or `"roblox"`. Send `round start` when the round actually begins, after your 3-2-1 countdown (the
headset starts its own timer from `duration` when it receives it). When the headset receives a `tag` event, it plays
the big TAGGED moment at `at`. Ojasva also forwards tags to Seb's map.

### Request budget (limit: 500 per minute per Roblox server, Open Cloud excluded)

| Loop | Rate | Per minute |
| --- | --- | --- |
| Presence | 4 per second | 240 |
| Rooms (lobby or picker open) | 1 per 3 s | 20 |
| Map chunks | about 3 per room load | under 10 |
| Events | per tag or round | under 10 |
| **Total** | | **about 280** |

Keep at most 2 requests in flight. The `TooManyOutstandingRequests` HTTP error exists for a reason.

---

## 6. Recommended layout in Studio

```
ServerScriptService
  Main                (Script)        boots everything; state machine: lobby → following → loading → room
  DejaView            (Folder)
    Config            (ModuleScript)  constants + USE_MOCK + BASE fallback; reads ConfigService
    Api               (ModuleScript)  the ONLY code that touches HttpService; same interface as MockServer
    MockServer        (ModuleScript)  fake rooms, procedural maps, a fake VR player, latency and failure injection
    MapBuilder        (ModuleScript)  chunks → Parts, progress, teardown, baked-room fallback
    Rooms             (ModuleScript)  rooms list, votes, host override, follow mode, prefetch
    Presence          (ModuleScript)  4 Hz loop, snapshot buffers, fan-out to clients
    TagGame           (ModuleScript)  rounds, tag checks (10 Hz), lives, scores, events
ReplicatedStorage
  Shared              (Folder)
    Theme             (ModuleScript)  colors, fonts, sizes (used by every UI)
    Interp            (ModuleScript)  snapshot interpolation (server uses it for tag checks, clients for rendering)
    Fixtures          (ModuleScript)  the JSON strings from section 9.1
  Remotes             (Folder)
    GhostState        (UnreliableRemoteEvent)  server → clients, 4 Hz snapshots (each under 1,000 bytes or it's dropped)
    Moment            (RemoteEvent)            server → clients: tagged, toast, round start/end
    Vote              (RemoteEvent)            client → server: vote for a room
    HostAction        (RemoteEvent)            client → server: start round, follow on/off, reload (server checks host)
  Assets              (Folder)    GhostTemplate (Model), TagBurst (ParticleEmitter), sounds
ServerStorage
  BakedRooms          (Folder)    pre-built room Models used if HTTP is down (section 10)
StarterPlayer > StarterPlayerScripts
  Client              (LocalScript)   UI controller + ghost renderer
StarterGui
  DejaViewUI          (ScreenGui)     LoadingScreen, Hud, RoomPicker, Scoreboard, Winner, Toasts, Banner
Workspace
  Lobby               (Model at 0, 300, 0)    board + spawn
  Room                (Folder)                built at runtime
```

Use **attributes** for state that late joiners need to see, for example `workspace:SetAttribute("Phase", "loading")`,
`"LoadProgress"`, `"RoomName"`, `"RoundEndsAt"` and `"Follow"`. Use **RemoteEvents** for moments (a tag, a toast).
Clients listen with `GetAttributeChangedSignal`.

---

## 7. How each feature works

### 7.1 Room loader (MapBuilder)

1. Set `Phase = "loading"`, `RoomName` and `LoadProgress = 0`. Every client shows the loading screen.
2. Fetch `chunk=0`. Destroy the old `Workspace.Room` contents with one `Destroy()` on the folder, then create a new
   folder.
3. Build the parts in batches, using **one template part that you clone**. Set every property **before** `Parent`, as the
   Roblox docs recommend, and yield every batch:
   ```lua
   local template = Instance.new("Part")
   template.Anchored = true
   template.Material = Enum.Material.SmoothPlastic
   template.TopSurface, template.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
   template.CanTouch = false

   local BATCH = 400  -- tune: measure with os.clock()
   for i, p in parts do
       local part = template:Clone()
       part.Size = Vector3.new(p[4], p[5], p[6])
       part.CFrame = CFrame.new(p[1], p[2], p[3])
       part.Color = Color3.fromRGB(p[7], p[8], p[9])
       local small = math.min(p[4], p[5], p[6]) < 1
       part.CastShadow = not small
       part.CanCollide = math.max(p[4], p[5], p[6]) >= 0.6   -- specks don't block players
       part.Parent = roomFolder                               -- parent LAST
       if i % BATCH == 0 then task.wait() end
   end
   ```
4. After chunk 0, the floor exists. Add a **safety floor** (an invisible 2-stud slab under `bounds`), **invisible walls**
   just outside `bounds`, and an **invisible lid** at `ceilingY`. Then teleport players to `spawns` with
   `character:PivotTo(CFrame.new(x, y + 3, z) * CFrame.Angles(0, spawnYaw, 0))`, and hold them anchored until the
   last chunk is built. Anyone whose root part goes below y = -30 respawns at a spawn point.
5. Update `LoadProgress` after every batch (`built / totalParts`). When done, set `Phase = "room"` and fade the loading
   screen out over 0.6 s.
6. Log `os.clock()` timings (fetch, decode, build) so you can tune `BATCH` and `maxParts`.

Camera and lighting for a voxel room:

- `StarterPlayer.DevCameraOcclusionMode = Invisicam`: walls between the camera and you turn see-through locally.
- `StarterPlayer.CameraMaxZoomDistance = 25`.
- Lighting: bright, neutral ambient, so the splat colors read true (try `Ambient` and `OutdoorAmbient` around
  140, 140, 140 and `ClockTime` 13). For a dark void around the room that matches the website, try an Atmosphere with
  color and decay `#0B0B0F`, then tune by eye.
- Humanoid `WalkSpeed` 12 instead of 16. Rooms are small.

### 7.2 Room picker and follow mode (Rooms)

- **Board:** a SurfaceGui in the lobby, plus the same list in a ScreenGui panel (key `R` or a top-bar button). Each card
  shows the name (bold), a mode chip (RENT FREE, THIRD WHEEL or SAMPLE), the age ("2 min ago"), the block count, 4
  swatch squares from `swatch`, and a lime "JUDGE IS HERE" badge when `id == active.sceneId`. `building` rooms show a
  pulsing "Measuring the room..." and cannot be clicked.
- **Votes:** clicking a card fires `Vote`. The server tallies one vote per player and switches when a majority or the
  host picks. The host is the game owner (`game.CreatorId`), or the first player in the server when testing in Studio.
- **Follow mode (on by default, and it is the demo):** when `active.sceneId` changes to a `ready` room that is not
  yours, toast "Judge entered Game night", then build it. The host can turn Follow off from the HUD.
- **Auto-join (a host toggle on the HUD, default ON):** with Auto-join on, players are teleported into the room as soon
  as it is built, with a 3-2-1 countdown. **For the skit, turn Auto-join OFF before the demo starts:** the room builds
  in the background at 0:20 while everyone stays in the lobby (lobby players are not sent in presence, so the judge
  sees nobody yet), and at 1:15 you press the big **JOIN** button on the HUD, which teleports everyone in the server
  into the room at once. Show "Room ready · JOIN" in lime on every client while it waits.
- **Prefetch:** when a new `ready` room appears in the rooms list, download its chunks into the cache in the background.
  When the judge enters, the build starts immediately with no network wait. This keeps you under the 15 s target.

### 7.3 Presence (Presence)

- One loop on the server. Send the request, wait for the reply, then wait out the rest of the 250 ms. Never let requests
  overlap.
  ```lua
  while running do
      local started = os.clock()
      local ok, res = Api.presence(currentSceneId, buildPayload())
      if ok then failures = 0; handle(res) else failures += 1 end
      local delay = (failures == 0) and 0.25 or math.min(0.5 * 2 ^ (failures - 1), 4)
      task.wait(math.max(0, delay - (os.clock() - started)))
  end
  ```
- After 3 failures in a row, set the `Banner` attribute to "Reconnecting to Déjà View..." and fade the ghost to 30%.
  Clear the banner on the first success.
- For each person in `others`, skip them if their `t` has not changed (a duplicate). Otherwise, stamp the snapshot with
  Roblox time, `stamp = workspace:GetServerTimeNow() - (res.t - person.t)`, then push it into that person's buffer
  (keep the last 2 s).
- Fan out to clients: `GhostState:FireAllClients({ id, kind, name, stamp, head, hands, x, y, z, yaw })`, one call per
  changed person. Keep each payload small: UnreliableRemoteEvent drops payloads over 1,000 bytes.

### 7.4 The VR ghost (client side, `Client` LocalScript)

- **Look:** clone `ReplicatedStorage.Assets.GhostTemplate` into `Workspace` from the LocalScript (a client-created model
  stays local).
  - Head: a 1.6-stud ball in Neon `#C6FF3D` at transparency 0.15, with a dark visor band on the front so you can see
    where the judge is looking.
  - Hands: two 0.8-stud Neon balls with short Trails.
  - Body: a faint capsule (transparency 0.75) from the floor to the head.
  - A lime PointLight on the head, so the room glows where the judge is.
  - A Highlight on the model (lime outline, DepthMode AlwaysOnTop), so you can always find "it" through walls.
  - A BillboardGui: "JUDGE · VR", plus an "IT" chip during a round.
  - All parts: `Anchored`, `CanCollide`, `CanQuery` and `CanTouch` all false.
- **Others:** draw web viewers as small lime orbs with a name, and Roblox players from other servers as translucent
  avatar-height capsules with a name.
- **Smoothness (snapshot interpolation):** render each person `DELAY = 0.35` s in the past. Find the two snapshots
  around `renderT = workspace:GetServerTimeNow() - DELAY`, then lerp the positions and the yaw (the shortest way round):
  ```lua
  local function lerpAngle(a, b, t)
      local d = (b - a + math.pi) % (2 * math.pi) - math.pi
      return a + d * t
  end
  -- renderT past the newest snapshot: extrapolate for at most 0.25 s using the last velocity, then hold.
  -- Newest snapshot older than 3 s: fade to 30% and show "signal lost" under the name.
  ```
  Update on `RunService.RenderStepped` (every frame). Set `CFrame` on the few parts directly.
- Put the interpolation in `ReplicatedStorage.Shared.Interp`, so the **server uses exactly the same function** for tag
  checks (section 7.5). Players then get tagged by the ghost they can see, not by a position 0.35 s ahead of it.

### 7.5 Tag (TagGame, server authoritative)

Rules (constants in `Config`). The round length comes from the `demo_round_seconds` config:

| Rule | Value |
| --- | --- |
| Round length | `demo_round_seconds` (30 s for the skit), 90 s otherwise |
| "It" | The VR player (`kind == "vr"`; if there are several, the first) |
| Lives per Roblox player | 3 |
| Tagged when | Either VR hand is within **3.5 studs** of your HumanoidRootPart, **or** the VR head is within **3 studs** horizontally. Scale both by `studsPerMeter / 4` |
| After a tag | 3 s immunity (ForceField visual, `state = "caught"`), respawn at a random `spawns` point |
| Out | 0 lives → spectator (`state = "out"`), camera follows the ghost |
| VR wins | Everyone is out before time |
| Roblox wins | Anyone survives; MVP = most lives left, ties broken by the longest time since their last tag |

- Check at 10 Hz on the server, using `Interp` at the same `DELAY` as the clients.
- **Start:** the host presses Start on the HUD, or an `events` item `start_round` arrives. Show a 3-2-1 countdown on
  every client and send the `round start` event. **No VR player present:** show "Waiting for the headset..." and do not
  start.
- **On a tag:** `Moment:FireAllClients({type = "tagged", ...})`. Clients play a burst (`TagBurst:Emit(40)` at the
  victim), a short sound, a camera shake for the victim, and a big **TAGGED** banner. The server sends the `tag` event
  to Déjà View.
- **Scoreboard:** a top-right panel. The judge's tags appear in lime. Roblox players show lives as 3 dots each, and the
  timer counts down in big type.
- **Winner screen:** 5 s full-screen dark card: "THE JUDGE WINS" or "ROBLOX SURVIVES", the MVP's name, and a lime
  underline. Then back to free roam in the same room.
- In the skit, the round starts around 1:18 and ends around 1:48. At 1:45 Seb's map shows your dots chasing, and
  right after the round Brianna switches to her browser to leave a note on the map.

### 7.6 One look (Theme module)

| Token | Value |
| --- | --- |
| Background | `#0B0B0F` (UI panels at 0.05 transparency) |
| Surface / cards | `#15151B`, `UICorner` 14 px, `UIStroke` 1 px `#2A2A33` |
| Text | `#F4F4F5`, muted `#9A9AA6` |
| Accent (one only) | `#C6FF3D` for progress fills, active badges, the ghost, "IT" and focus strokes |
| Danger | `#FF4D6D` (tagged flash) |
| Type | `Font.fromName("BuilderSans", Enum.FontWeight.ExtraBold)` for headings, `Bold` for body. Big, uppercase headings, short copy |

- Hide the default player list (`StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.PlayerList, false)`), because your
  scoreboard replaces it. Keep chat.
- Copy voice: "Moving in...", "Measuring the room...", "Judge entered Dorm room", "TAGGED", "You survived", "Reconnecting
  to Déjà View...".
- Loading screen: a full-screen dark background, the Déjà View wordmark, "Moving in..." in huge bold type, the room name,
  a 6 px lime progress bar with "4,210 / 5,821 blocks", and one rotating tip line.
- Sounds and particles: use Roblox-made audio from the Creator Store, and credit it on Devpost. **No free models with
  scripts** (backdoors, and the rule that all code is written by you during the event).

### 7.7 Join link and phones

- **A link that opens a specific room:** Roblox deep links can carry up to 200 bytes of launch data:
  `https://www.roblox.com/games/start?placeId=<PLACE_ID>&launchData=<sceneId>`. On the server,
  `player:GetJoinData().LaunchData` holds the scene id. If the server is in the lobby, load that room. If it is already
  in a room, ignore it, because Follow keeps everyone together. Roblox now calls deep links deprecated in favour of
  share links, but they still work. Send your place id and this format to **Seb and Ojasva by Sat 12 PM**, so Seb's
  bot can add "No headset? Join in Roblox" to its group-chat reply.
- **Phones:** every UI element uses Scale sizes plus `UIAspectRatioConstraint`. Touch targets are at least 44 px. Keep
  the bottom-left (thumbstick) and bottom-right (jump) corners clear. Test with Studio's Device Simulator (phone
  profile) before Sat 4 PM. On small screens, the scoreboard collapses to a single line.

### 7.8 Reality check tint (only if the server sends `p[10]`)

`plan.md` has a toggle that tints every AI-imagined part of the world. If map parts carry the 10th value, add a HUD
toggle "Reality check". On each client, it tints imagined blocks toward a cool magenta and dims them slightly.
Client-side property changes stay local, so each player chooses for themselves. Keep each block's original color in a
table keyed by the part. This is P2: do it only after everything in milestone Sat 4 PM works.

---

## 8. Build order with checkpoints

Work top to bottom. Each step ends with something you can see.

| # | Build | You should now see |
| --- | --- | --- |
| 0 | Setup (section 3) and the transport test (section 9.3) | A live Roblox server printing JSON fetched from your own quick tunnel |
| 1 | `Theme`, `Config`, `DejaViewUI` shell, `Main` state machine, lobby | Play: the dark loading screen fades into a branded lobby |
| 2 | `MapBuilder` with `Fixtures.MAP_SMALL` | The 12-part fixture room appears around you. You land on the floor, and Invisicam works |
| 3 | `MockServer.map(id, maxParts)` procedural rooms; stress test with 6,000 and 12,000 parts | The progress bar fills. Output prints build times. Pick `BATCH` and the default `maxParts` from these numbers |
| 4 | `Api` / `MockServer` with one shared interface (`rooms()`, `mapChunk(id, n, maxParts)`, `presence(id, body)`, `event(id, body)`); `Rooms` + picker | 3 mock rooms on the board; clicking one rebuilds the room |
| 5 | `Presence` + `Interp` + ghost renderer, with the mock VR player | Testing-mode dropdown → Server & Clients, 2 clients: the ghost glides on both screens, even with 5% injected failures and 50 to 250 ms jitter |
| 6 | `TagGame` + scoreboard + winner screen + tag effects | The mock ghost chases and tags you; lives drop, the burst plays, the winner card shows; events print in Output |
| 7 | Follow mode + prefetch | The mock `active` switches after 30 s; the countdown and swap finish in under 10 s |
| 8 | Publish; Configs + Secrets; teammates join | A teammate's avatar runs next to yours in the live private server |
| 9 | Real server: `USE_MOCK = false` (section 9.4) | The sample rooms load from the tunnel. A curl-faked VR player moves the ghost |
| 10 | Real headset with Ojasva | The judge's head and hands move the ghost; the headset sees your avatars and TAGGED |
| 11 | Fallbacks + polish (section 10) | Pull the tunnel: banner, the room stays, it recovers by itself. Baked rooms load with HTTP off |

API wrapper (the one place that talks HTTP). Use `RequestAsync`, not `GetAsync`: GetAsync caches responses unless you
pass `nocache = true`.

```lua
local HttpService = game:GetService("HttpService")

local function headers(isPost)
    local h = {}
    if isPost then h["content-type"] = "application/json" end
    local ok, secret = pcall(function() return HttpService:GetSecret("dejaview_key") end)
    if ok then h["x-dejaview-key"] = secret end       -- a Secret works as a header value
    return h
end

local function request(method, path, body)  -- returns ok, decodedOrError, status
    local ok, res = pcall(function()
        return HttpService:RequestAsync({
            Url = Config.base() .. path, Method = method, Headers = headers(body ~= nil),
            Body = body and HttpService:JSONEncode(body) or nil, Timeout = 5,
        })
    end)
    if not ok then return false, tostring(res), 0 end                  -- DNS, timeout, refused
    local okJson, data = pcall(HttpService.JSONDecode, HttpService, res.Body)
    if not okJson then return false, "not JSON (tunnel down?)", res.StatusCode end
    return res.Success, data, res.StatusCode
end
```

Reading BASE from Experience Configs (server only), with a fallback:

```lua
local ConfigService = game:GetService("ConfigService")
local base = Config.BASE_FALLBACK
local ok, snap = pcall(function() return ConfigService:GetConfigAsync() end)
if ok and snap then
    base = snap:GetValue("dejaview_base") or base
    snap.UpdateAvailable:Connect(function() snap:Refresh() end)
    snap:GetValueChangedSignal("dejaview_base"):Connect(function(v) base = v end)
end
```

Changing the URL live: Creator Hub → Configs → edit → Publish now (it takes effect in roughly 15 to 60 s). For one live
server right away: in the Developer Console (F9, server side), run
`game:GetService("ConfigService"):SetTestingValue("dejaview_base", "https://...")`.

---

## 9. Testing

### 9.1 Alone: mock mode (`Config.USE_MOCK = true`)

`MockServer` has exactly the same functions as `Api` and returns the same shapes. It should:

- return the `ROOMS` fixture below, and switch `active` to the second room 30 s after the server starts;
- return `MAP_SMALL` for `fixture-room`, and **procedural rooms** for anything else: a floor, 4 walls with a window gap,
  a bed, a table, a lamp, plus random "voxel noise" boxes until it reaches `maxParts`. This gives you stress tests at
  800, 6,000 and 12,000 parts;
- act as a fake VR player on a smooth loop, with the head bobbing and the hands swinging:
  ```lua
  local function mockVr(t)                       -- t = os.clock()
      local a = t * 0.6
      local x, z = math.cos(a) * 7, math.sin(a * 0.8) * 5
      local dx, dz = -math.sin(a) * 7, math.cos(a * 0.8) * 4   -- velocity, for facing
      local yaw = math.atan2(-dx, -dz)
      local head = { x, 6.4 + math.sin(t * 3) * 0.15, z }
      local side = Vector3.new(math.cos(yaw), 0, -math.sin(yaw)) * 1.6
      return { id = "quest-1", name = "Judge", kind = "vr", t = workspace:GetServerTimeNow(),
               x = x, y = 0, z = z, yaw = yaw, head = head,
               hands = { { x - side.X, 4.8 + math.sin(t * 5), z - side.Z }, { x + side.X, 4.8, z + side.Z } } }
  end
  ```
- inject 50 to 250 ms of random latency (`task.wait`) and fail 5% of calls, so your backoff and banner get exercised.

`ReplicatedStorage.Shared.Fixtures` (exact shapes, as JSON strings, decoded with `JSONDecode`):

```lua
-- [=[ ... ]=] (not [[ ... ]]) because the JSON itself contains "]]"
return {
ROOMS = [=[{"t":1760715600.2,"active":null,"rooms":[
 {"id":"fixture-room","name":"Fixture room","mode":"sample","createdAt":"2026-10-17T10:00:00Z","map":"ready","parts":12,"people":0,"swatch":[[128,112,96],[214,208,196],[70,90,140],[150,110,70]]},
 {"id":"mock-dorm","name":"Mock dorm","mode":"rentfree","createdAt":"2026-10-17T10:05:00Z","map":"ready","parts":6000,"people":1,"swatch":[[120,104,90],[220,214,200],[60,70,90],[200,160,90]]},
 {"id":"mock-kitchen","name":"Mock kitchen","mode":"thirdwheel","createdAt":"2026-10-17T10:06:00Z","map":"building","parts":0,"people":0,"swatch":[]}]}]=],

MAP_SMALL = [=[{"v":1,"sceneId":"fixture-room","name":"Fixture room","studsPerMeter":4.0,
 "bounds":{"min":[-13,-1,-11],"max":[13,10.4,11]},"ceilingY":10.4,
 "spawns":[[0,0,5],[-3,0,7],[2,0,8]],"spawnYaw":0,"vrSpawn":[0,0,-2],"floorColor":[128,112,96],
 "totalParts":12,"chunk":0,"chunks":1,"parts":[
 [0,-0.5,0,24,1,20,128,112,96],
 [0,5.2,-10.5,24,10.4,1,214,208,196],
 [0,5.2,10.5,24,10.4,1,214,208,196],
 [-12.5,5.2,0,1,10.4,20,205,199,188],
 [12.5,2,0,1,4,20,205,199,188],
 [12.5,9.2,0,1,2.4,20,205,199,188],
 [12.5,6,0,0.2,4,20,170,210,255],
 [-7,1,-5,8,2,10,70,90,140],
 [-7,2.4,-8.8,6,0.8,2,235,235,235],
 [6,3,4,6,0.4,4,150,110,70],
 [6,1.4,4,0.6,2.8,0.6,90,70,50],
 [9,4,-8,1,8,1,240,220,120]]}]=],

PRESENCE = [=[{"t":1760715600.31,"active":{"sceneId":"fixture-room","name":"Fixture room"},"others":[
 {"id":"quest-1","name":"Judge","kind":"vr","t":1760715600.18,"x":0.4,"y":0,"z":2.0,"yaw":0.3,
  "head":[0.4,6.4,2.0],"hands":[[-1.6,4.8,0.9],[1.9,5.0,1.1]]},
 {"id":"web-7f3a","name":"Seb","kind":"web","t":1760715599.9,"x":-3,"y":0,"z":1,"yaw":2.1}],"events":[]}]=],
}
```

Multiplayer without anyone else: in the testing-mode dropdown pick **Server & Clients**, with 2 clients (up to 8 is
possible), and press Play. Check that both clients show the ghost, the scoreboard and the tag effects.

### 9.2 Things to verify in Studio before Saturday noon

- [ ] 12,000 mock parts build without the server freezing (watch the server frame rate in the Developer Console), and
      clients stay at 60 fps.
- [ ] Switching rooms 5 times in a row leaves no leftover parts (check the Workspace part count).
- [ ] The ghost stays smooth with failure injection on, and the banner appears and clears.
- [ ] A player who joins in the middle of a round sees the right room, timer and scoreboard (attributes).

### 9.3 Transport test tonight (de-risks the biggest unknown)

Roblox does not document whether live servers can reach `*.trycloudflare.com`. Prove it yourself in 15 minutes:

```bash
mkdir -p ~/dv-fixture/api/roblox && cd ~/dv-fixture
# save your ROOMS fixture JSON as api/roblox/rooms (no extension)
python3 -m http.server 8000
# second terminal:
cloudflared tunnel --url http://localhost:8000      # prints https://<random>.trycloudflare.com
```

Set that URL as `dejaview_base` (or `BASE_FALLBACK`), publish, and **join the live game from the Roblox app** (or use
Team Test). A Studio local playtest runs the server on your laptop, so it does not prove what Roblox's datacenter can
reach. Your server should print the decoded rooms. If it fails, tell Ojasva right away, so he can switch to a Cloudflare
named tunnel on a real domain. If you want to test POSTs too, write your own tiny mock server that returns
`Fixtures.PRESENCE`.

### 9.4 Against the real server (from Sat 12 PM)

```bash
BASE=https://<tunnel-host>          # from Ojasva
KEY=<key from Ojasva's DM>          # never paste it into a script or the place

curl -s "$BASE/api/roblox/rooms" -H "x-dejaview-key: $KEY" | python3 -m json.tool | head -40
curl -s "$BASE/api/roblox/sample-painted-bedroom/map?chunk=0" -H "x-dejaview-key: $KEY" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['studsPerMeter'], d['totalParts'], d['chunks'], d['parts'][0])"
curl -s -X POST "$BASE/api/roblox/sample-painted-bedroom/presence" -H "content-type: application/json" \
  -H "x-dejaview-key: $KEY" -d '{"server":"curl-test","players":[{"id":"rbx-1","name":"curl","x":2,"y":0,"z":1,"yaw":0,"state":"playing"}]}'
curl -s "$BASE/api/presence/sample-painted-bedroom"     # what the server thinks is in the room (metres)
```

Fake a VR player for 60 s, so you can test the ghost and tag with no headset. This uses Ojasva's presence endpoint,
which is in **metres in the room frame** (floor at y = 0, `contracts.md` 3.1), exactly what the headset sends.

```bash
python3 - "$BASE" <<'EOF'
import json, math, sys, time, urllib.request
base = sys.argv[1]
for i in range(240):
    a = i * 0.05
    x, z = math.cos(a) * 1.5, math.sin(a) * 1.2
    yaw = math.atan2(math.sin(a) * 1.5, -math.cos(a) * 1.2)    # face the direction of travel
    body = {"id": "quest-1", "name": "Judge", "kind": "vr", "x": x, "y": 0, "z": z, "yaw": yaw,
            "head": [x, 1.6, z], "hands": [[x - 0.4, 1.2, z - 0.3], [x + 0.4, 1.2, z - 0.3]]}
    req = urllib.request.Request(f"{base}/api/presence/sample-painted-bedroom", json.dumps(body).encode(),
                                 {"content-type": "application/json"})
    urllib.request.urlopen(req).read()
    time.sleep(0.25)
EOF
```

You should see: `active` becomes the painted bedroom, Follow builds it, and the ghost circles the middle of the room at
head height (6.4 studs at 4.0 studs per metre), always facing the way it moves. If it walks backwards or sideways,
the yaw convention is off somewhere: tell Ojasva with the numbers you see.

### 9.5 Together (by Sat 10 PM)

1. Ojasva wears the headset (or uses the desktop viewer with `?xremu=1`) in a sample room. You and a teammate are in
   the live game.
2. Check that the ghost faces the way the headset faces. If it is mirrored or rotated 90 degrees, the yaw convention is
   off: fix it in one place and tell Ojasva.
3. Check that Seb's live map (`/live`) shows 3 dots moving the same way as in Roblox, and that a note Brianna leaves
   on the map appears in the headset.
4. Run the full demo with a timer, twice. Note where the room-load time goes.

---

## 10. Fallbacks for the night

| Breaks | What happens / what you do |
| --- | --- |
| Tunnel down or Mac asleep | Banner "Reconnecting to Déjà View...", the room stays, the ghost fades, retries back off to 4 s and recover by themselves |
| Tunnel URL changed | Update `dejaview_base` in Creator Hub Configs (live in under 1 min); or use `SetTestingValue` in the server console for an instant change |
| Map endpoint slow or failing | The cached room from prefetch; otherwise a **baked room** (below); otherwise the fixture room |
| New room too heavy | Request `maxParts=3000`; the server sends a coarser version |
| Headset dies mid-demo | The host toggles "Mock judge" on the HUD; the scripted ghost keeps the round going (`MockServer` VR path) |
| Roblox live servers have trouble | Studio Server & Clients test on your laptop (the server runs locally and still reaches the tunnel) |
| Everything | Your recorded 20 s clip |

**Baked rooms** (do this Saturday evening for the demo rooms: the two samples plus the dorm photo we will text):

1. Press Play in Studio (local playtest; Local Secrets are set) and let your loader build the room from the real server.
2. Switch to the Server view, select `Workspace.Room` and copy it (Ctrl/Cmd+C). Stop the playtest.
3. In edit mode, paste it into `ServerStorage.BakedRooms`, rename it to the scene id, then save and publish.
4. If loading fails, `MapBuilder` clones the baked copy into `Workspace` instead. This is instant and needs no network.
   Bake no more than 3 rooms of about 6,000 parts each, so the place file stays small.

---

## 11. Milestones

| When | Done means |
| --- | --- |
| Fri night | Studio installed, age check done, friends added, experience published private with HTTP on, transport test passed |
| **Sat 10 AM** | Mock mode: the room builds behind the loading screen; 12k-part stress measured; the mock ghost glides on 2 clients; tag works against it |
| Sat 12 PM | Picker + follow + prefetch on mocks; teammates join the live private server; Configs + Secrets set |
| **Sat 4 PM** | Real rooms from the tunnel; presence round-trips with the curl-faked VR player, then the real headset; events reach the headset; audience opened (Public + Beta, or Playtesters); a phone joins via the link |
| **Sat 10 PM** | Full demo run with the judge-in-headset flow, twice, timed; baked rooms in place; all polish done |
| **Sun 4 AM** | Freeze. Record a 20 s clip: the follow countdown, the room building, the ghost, a TAGGED moment, the winner screen |

## 12. Hand-off to Ojasva

1. File → **Save to File As** → `DejaView.rbxlx` (XML).
2. Before sending, check that the key is not in it: `grep -c "<the key>" DejaView.rbxlx` must print `0`. The key lives
   only in Roblox Secrets.
3. Send: the `.rbxlx`, the experience link, who has Edit or Play access, the Config keys you use (`dejaview_base`,
   `demo_round_seconds`), the secret's **name** (`dejaview_key`, not its value) and your fixture JSON. Ojasva files it
   under `integrations/roblox/`.
4. Tell him about any contract change immediately, in one message with an example JSON.

Hackathon rules: write all of your own code during the event (no prior scripts, no free models with scripts). Credit
every AI tool you used on Devpost, as the rules require. Credit Roblox-made assets and sounds too.

## 13. Verified sources

- In-game HTTP (enable, 500/min, ports, best practices): https://create.roblox.com/docs/cloud-services/http-service
- HttpService (server-only, RequestAsync fields, Timeout, caching, JSON, Studio-only streaming):
  https://create.roblox.com/docs/reference/engine/classes/HttpService
- Secrets (domain-bound, headers OK, Local Secrets for Studio): https://create.roblox.com/docs/cloud-services/secrets
- Experience Configs (live values, 15 s to 1 min): https://create.roblox.com/docs/production/configs
- EditableMesh limits and the publish toggle: https://create.roblox.com/docs/reference/engine/classes/EditableMesh
- Streaming: https://create.roblox.com/docs/workspace/streaming · Performance (chunk map loads, no server tweens):
  https://create.roblox.com/docs/performance-optimization/improve
- Units (1 stud = 28 cm): https://create.roblox.com/docs/physics/units
- Publishing, audiences, requirements: https://create.roblox.com/docs/production/publishing/publish-experiences-and-places
- Collaborators and the age check: https://create.roblox.com/docs/projects/collaboration · Team Test:
  https://create.roblox.com/docs/studio/testing-modes
- Matchmaking (friends and same-IP players first): https://create.roblox.com/docs/matchmaking/scoring
- UnreliableRemoteEvent (1,000-byte limit): https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent
- Deep links with launch data (200 bytes): https://create.roblox.com/docs/production/promotion/deeplinks
- Cloudflare quick tunnels: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- ngrok free limits (why not ngrok): https://ngrok.com/docs/pricing-limits/free-plan-limits
