# Seb: the group chat starts it, the map remembers who was there

Read `START-HERE.md` first (the short spec), then `plan.md` (the story), then this page (the build details).
`contracts.md` has the wiring for the whole team. If this page ever disagrees with `START-HERE.md` or `contracts.md`,
they win: say so in the team chat.

Your work opens the demo (0:00, the clip in the group chat), comes back at 1:40 (the live map, and the note that pops
up in the headset) and powers the finale (2:00 to 2:25, the judge's own photo becomes a world). Everything marked
**Verified** was checked against the live docs or live APIs on Friday night (Oct 16, ~11 PM).

---

**Update 13 (Sat ~7 PM): the kitchen's v2 room is live on `/model`, and your code got a review.**
1. **Kitchen v2 room:** `GET BASE/api/roblox/kitchen/model` now serves the photo-textured v2 kitchen: two parts
   (`roblox.glb` 18.9 MB, `roblox-2.glb` 14.7 MB) plus six sky faces, same frame as before (floor at y = 0, same
   headset spawn), so `features.surfaces` (the STOVE and the counters) still line up. It matches the real kitchen far
   better than v1: no black holes, the sink, door, signs and fire extinguisher read clearly. It has no asset id yet:
   it goes through your gate (contact sheet, `review.py`, then upload from your account, one part at a time). Until
   then your game builds the kitchen from `/map`. Shivin's old v1 kitchen asset would not load in your experience
   anyway.
2. **Your code was reviewed and fixed on `main` (`git pull`):** it's real code, not filler, but it had bugs. Fixed:
   the un-aimed hit crash in `PingPong.luau`; every return scoring an instant "Double bounce"; the serve never
   changing after 10-10; the bot playing itself and posting bot-vs-bot results after everyone left; the paddle's own
   speed missing from `paddleHit`; the invisible trail; the camera stuck in first person; the barcode scan in
   `preflight.py` crashing on a real barcode; one view voting twice in `build.py`; black floor colours and a metres
   ceiling in `mesh.py`; the review site open to the whole Wi-Fi and approving files nobody looked at;
   `roblox-objects-upload.sh` never succeeding. Play test the ping pong rally once (the Luau couldn't run here).
3. **Still yours to decide:** remove the green `PP CLIENT v5` debug HUD and the `ClientProbe` billboard before the
   expo; the VR paddle only hits with one face; `ObjectLayer.loadMesh` never moves an uploaded mesh to its spot.
4. **Uploads:** `scripts/roblox-upload-object.ts` now refuses unless you type `ROBLOX_UPLOAD=1` and set
   `ROBLOX_CREATOR_ID` yourself (Bun loads the repo `.env`, which is Shivin's key). Use your own key and id.

**Update 12 (Sat ~4 PM): the site is on its own domain now: `https://deja-view.photo`.** It's permanent, so it never
changes on a restart again. Three settings, once:
1. DeepSpace `/admin` → `baseUrl` = `https://deja-view.photo` (the gallery lists the worlds again).
2. Roblox Experience Config `dejaview_base` = `https://deja-view.photo` (Creator Hub, live at once).
3. `git pull`: `BASE_FALLBACK` in `roblox/src/server/DejaView/Config.luau` is `https://deja-view.photo` on `main`.
Every `BASE` in this file now means `https://deja-view.photo`. The old `trycloudflare` link keeps working for a while
as a backup; don't use it for anything new.

**Update 11 (Sat ~3:30 PM): tonight in order, so Roblox is real at the expo.**
1. **Task A first (Update 8): your experience, live.** Without it there is no Roblox at the table. Publish from the
   repo (`roblox/default.project.json` + `roblox/DejaView-pingpong-v4.rbxlx`, or your v19 place) on your account,
   set `dejaview_base` to BASE, and post the place id. The baked v19 court stays the fallback.
2. **DeepSpace gallery:** set `/admin` → `baseUrl` to `https://deja-view.photo` (Update 12).
3. **Censor pass and gate (Update 8, Tasks C and D):** then upload the Game Lawn room and its sky from your account.
   A teammate who isn't you (Brianna, or Ojasva) looks at the contact sheets and runs `review.py`; Shivin is on product work. Giant chess is next.
4. **Cooking rush on the real kitchen:** put the STOVE on a `features.surfaces` stove and the ingredients on the
   counters and tables (Update 10), keeping the raycast fallback. Play test it: the STOVE marker should sit on the
   real range.
5. **The kitchen's v2 textured room** is building on HiPerGator tonight. When Ojasva posts it, it goes through your
   gate like the others.
6. **Pool:** only if the game-room pool table gets filmed and rebuilt in time.
Don't upload anything Fortnite-derived, and don't publish or rename the team place `106038900865360`.

**Update 10 (Sat ~3 PM): the real kitchen for cooking rush.** `GET BASE/api/roblox/kitchen/model` (and `/map`) now
carries `features.surfaces`, measured from the splats (`pipeline/surfaces.py`). It's a list of real tops in studs, in
the map frame, each `{kind, name, corners[4], centre, height, length, width, yaw}`:
- `stove`: range 1, range 2 (the black cooktops, about 3.1 studs up)
- `counter`: the counter, the sink counter
- `table`: the steel prep table, two bar tables (3.7 studs)
- `fridge`: the fridge's footprint, `height` = its top (6.6 studs)
`WorldGames.cooking` still guesses: `counterSpots` raycasts the room and takes the spot nearest the middle as the
stove. With `features.surfaces` present, put the STOVE on a `stove` centre and spawn ingredients on the `counter`
and `table` tops; keep the raycast as the fallback for rooms without features. The same list works for any game and
any room once it is measured. The Game Lawn and Giant chess keep their tables as before. The kitchen's v2 textured
room (like the Game Lawn's) is building on HiPerGator now; until it lands, `/model` serves the older v1 kitchen room.

**Update 9 (Sat ~2:20 PM): the court isn't lost; your machine just never had it.** Answer to
`team/ojas-scene-recovery.md`:
- Scenes are never in git (`data/` is ignored). `the-courts` is complete on Ojasva's Mac, which runs the live server.
  Your local server only has the kitchen you copied, so it answers 404 for the court. Don't recover or rebuild
  anything; read the court from BASE.
- BASE today is `https://deja-view.photo`. `GET BASE/api/roblox/the-courts/model` is 200,
  and so is `.../model/roblox.glb` (18.7 MB), `.../map` and `BASE/data/scenes/the-courts/world.spz` (16.1 MB).
  `.../objects` is 404 because the object layer only exists for the kitchen.
- If you want a local copy for the asset maker, download those four files into `data/scenes/the-courts/`.
- Pull `main`: your branch is 83 commits behind it, and that's the only place the dead `prozac-...` fallback still
  lives. `main`'s `Config.luau` has the live link, and the Experience Config `dejaview_base` overrides it anyway.
- DeepSpace gallery empty: set `/admin` → `baseUrl` to BASE above. The quick tunnel's address changed once, at the
  11:19 AM network drop. The permanent fix is `https://deja-view.photo`, live as soon as the Cloudflare tunnel token
  is saved (Ojasva has the steps). Then `baseUrl`, `dejaview_base` and `BASE_FALLBACK` all move to it, once.
- The HPG root is `/blue/phz3152/sbernalorta/thirdwheel` (with an "r"). Don't use the `sbernalota` in the brief.
- Keep the baked v19 place as the fallback, as you said.

**Update 8 (Sat ~1 PM): Roblox is yours now. Shivin is banned from Studio.** You own the experience, every upload,
the asset maker (the object layer) and the censor pass that every texture goes through before Roblox sees it. This
update is written so you can hand each task below to a coding agent as is: paste the "Rules for every agent" block,
then one task. Tasks A, B and C can run in parallel (separate agents, separate branches); D needs C; E needs A.

Rules for every agent (paste this first):

```text
Repo: Déjà View (this checkout). Work on your own branch (seb/<task>), commit there, push the branch; Ojasva merges.
Commit messages: plain sentences, no timestamps, no Co-Authored-By or any tool attribution. Run once per clone:
  git config core.hooksPath .githooks      (its commit-msg hook strips those lines)
Code: write it yourself. Libraries and models come in only as pinned dependencies, credited in THIRD_PARTY.md. Never
copy another project's files in, and never name other repositories in code headers or commit messages.
Secrets: Roblox keys live only in ~/.config/dejaview/roblox-assets.key (chmod 600). Never print, log or commit a key.
Data: never delete anything under data/; move it to data/archive/ instead.
Roblox: nothing is uploaded unless pipeline/objects/preflight.py passed AND a human approved that exact file with
pipeline/objects/review.py (the approval is bound to the file's SHA1). One upload at a time, never in bulk.
Fortnite-derived worlds (tilted-towers, brick-apartment and any fortnite-*) never go to Roblox: Epic's art.
BASE (the live server) = the link Ojasva posts in the team chat; today https://deja-view.photo
It changes whenever the tunnel restarts.
```

**Task A: take the experience over (Studio, your account).**
- Why: `LoadAssetAsync` only loads assets owned by the experience's creator, so the experience and every room and
  object asset must belong to the same owner: your account, or a group you own. Shivin's place `106038900865360` and
  his asset ids (Game Lawn room `91874647541773`, its sky faces, the chess rooms) will not load in your experience.
- Source of truth is the repo: the Rojo project `roblox/default.project.json` (`roblox/src/{server,client,shared}`)
  and the latest place file `roblox/DejaView-pingpong-v4.rbxlx`. Create a new experience on your account, open the
  place file in Studio, sync `roblox/src` with Rojo, publish. Turn on VR (Meta Quest) in the experience settings.
- Set the Experience Config `dejaview_base` to BASE (Creator Hub; live at once, no publish). The fallback when it is
  missing is `BASE_FALLBACK` in `roblox/src/server/DejaView/Config.luau`.
- Done when: a Studio Play test on the Game Lawn shows the block map from `GET BASE/api/roblox/the-courts/map`, your
  ping pong on the real table (from `features`), and the game's presence posts reaching the server (Ojasva confirms
  from the log). Post the new place id in the team chat.

**Task B: the asset maker, world by world (our own photo worlds only).**
- The pipeline is yours already (`docs/object-layer.md` sections 6 to 15): `segment.py` -> `build.py` (objects.json)
  -> `mesh.py` (one textured GLB per object) -> `preflight.py` -> `review.py` -> `scripts/roblox-upload-assets.sh`.
- Worlds: `the-courts` (Game Lawn: ping-pong table, foosball table, chairs, benches), `chess-room` (the giant board
  and pieces), `kitchen` (fridge, counters, stools; it is being rebuilt for the whole room now, so take it last).
- Room files come from the live server, so no access to Ojasva's Mac is needed:
  `GET BASE/api/roblox/<id>/model` (JSON: `parts[].url`, `skyFiles`, `features`) and `GET BASE<parts[].url>`.
- Done when: each world has `objects.json` plus one GLB per object, every GLB under Roblox's limits (20,000 triangles
  per MeshPart; textures above 1024 px get downscaled), and a contact sheet from `preflight.py` for each.

**Task C: the censor pass (extend `pipeline/objects/preflight.py`).** It catches QR codes and barcodes today. Make it
catch everything Roblox moderation flags in an image, and mark each hit as blocking or for review:
1. Text: OCR every texture. Block URLs, emails, phone numbers, handles and promotional words; send any other readable
   text to review. Pick a pinned, offline OCR (credit it in THIRD_PARTY.md).
2. Faces: detect people's faces in textures (a real person in a photo is the likeliest one). Block until blurred.
3. Logos and brand marks: send big high-contrast marks to review (the human decides).
4. QR and barcodes: keep the current check; a decodable payload blocks.
5. Fix-ups: `--fix` blurs faces and text regions (or runs the existing `mesh.py --ink` pass on signs and posters),
   writes a new GLB, and re-runs the scan, so the approval is always for the fixed file.
6. It must also take a room: `--glb roblox.glb --sky-dir <dir with the six sky faces>` scans every texture atlas of the room
   and the sky faces (the Game Lawn's sky has real trees and a building; check it for signs).
- Done when: `python pipeline/objects/preflight.py --glb <file>` prints one line per texture (OK / REVIEW / BLOCK
  with the reason and a box), writes the contact sheet with hits outlined, and exits non-zero on any BLOCK; tests in
  `tests/pipeline/` cover a synthetic QR, a URL, a face and a clean texture.

**Task D: the gate for rooms too (needs C).** Today the gate covers objects only.
- Extend `scripts/roblox-upload-assets.sh` (or a sibling script) to upload a world's room: every room part GLB and
  the six sky faces, each only with a matching `approval.json`. Upload with your key, as you (or your group).
- Send Ojasva the new ids per world (room parts and the six sky faces). He swaps them into the server's upload ledger,
  so `GET BASE/api/roblox/<id>/model` hands your ids to the game. (The server's own uploader stays off.)
- Done when: the Game Lawn room loads with `LoadAssetAsync` in your experience, with its sky, and a second upload of
  an unchanged file is refused as already uploaded.

**Task E: the games on the real furniture (needs A).** Your ping pong and foosball are on `main`; pool once the game-room
pool table is filmed and rebuilt. Chess: `features.chessBoard` comes in `/model` and `/map` for `chess-room`.
- Bug from Shivin's handover (`roblox/HANDOVER-NOTES.md`): `PingPong.luau` around line 528 calls
  `launch(other(side), p0, flight, aim)`, but `flight` and `aim` only exist inside the branches above it. A hit that
  is neither camera-aimed nor a VR swing errors there.
- Shivin saw the chess-room textured model sit about 1 m off the board. That came from the server pairing an older
  model's asset id with a newer model's bounds. `/model` now gives one file's id and bounds together, and your
  re-upload makes them yours anyway. Check the board against the model once your chess-room upload lands.

**Update 7 (Sat ~9:20 AM): your object layer is merged; one repo rule, and Roblox uploads are paused.**
- Merged on `main` (b5d7939, a108ef1): objects found in the splats, described, and planned as Roblox parts. Tests pass.
- Repo rule from Ojasva: models and libraries come in only as pinned dependencies, credited in `THIRD_PARTY.md` and on
  the Devpost. Never copy another project's source files into the repo, and never name other repositories in commit
  messages or code headers. `docs/object-layer.md` section 13 now says this.
- Roblox: Shivin's account now answers `User is moderated` to uploads (likely the Fortnite-derived rooms), so the
  server's uploads are off and nothing should be uploaded with his key until he clears it (shivin.md Update 13). Your
  test place publishes with your own key, so check that account's notices too before publishing again.

**Update 6 (Sat ~7 AM): the real table comes from the server.** Your ping pong is merged on `main` (67de0b3),
great work.

1. **`features` in `/model` and `/map`** (`contracts.md` 6.6), live once Ojasva restarts the server (he posts it).
   Studs, the map's frame (metres × 3.57, floor y = 0, no flips). The Game Lawn (`the-courts`):

   ```json
   "pingPongTable": { "corners": [[0.01, 2.713, -22.161], [7.349, 2.713, -15.694], [3.75, 2.713, -11.609],
                                  [-3.589, 2.713, -18.076]],
                      "height": 2.713, "centre": [1.88, 2.713, -16.885], "length": 9.782, "width": 5.444,
                      "yaw": -2.2931, "net": [[3.68, 2.713, -18.927], [0.08, 2.713, -14.843]] }
   ```

   Measured from the splats and checked on the real photos; the net's own splats sit 0.3 mm off the `net` line.
2. **Nothing to change to read it:** `placeForScene` in `PingPong.luau` already takes `features.pingPongTable.corners`
   through `Sim.fromCorners` before the Config table, and gets your `LEN` × `WID` (9.78 × 5.44). `centre`, `length`,
   `width` and `yaw` are exactly what `fromCorners` returns, so use them or ignore them. No mismatch found.
3. **Drop the hand-tuned table** once a Play test shows `features` arriving: the temporary visible table in
   `maybePlace`, and any tuning on `Config.PINGPONG_TABLES["the-courts"]` (y 3.0, yaw 0.781). The real top is 0.29
   studs lower and 3.9° turned from it, so check the bounce and the ball at rest on the real top once more. The Config
   entry is Shivin's; it now only matters when `features` is missing (mock).
4. **Test:** `Rooms.modelInfo` caches `/model` once per Roblox server, so stop and start the test after the restart.
5. **The rooms are real now:** the Game Lawn's photo-textured v2 room (asset `91874647541773`, with six sky faces in
   `sky`) and the Brick House apartment (asset `96179943812932`) are uploaded and served by `/model`.

**Update 5 (Sat ~6 AM): Roblox games.** From now to the freeze you turn our worlds into real Roblox games, on top
of Shivin's game in `roblox/` (Luau + Rojo): **real-physics ping pong** on the real table at the Infinity Hall Game
Lawn now, then **pool** on the game-room table we film today. This block is your build guide (A to F). Read
`roblox/README.md` first (Studio, Rojo, mock, going live).

**A. How the game is organised, and working beside Shivin without collisions**

1. **Your branch:** `git switch -c seb/roblox-games` off an up-to-date `main`. Push it and tell Shivin at each
   checkpoint (F); he merges into `main` and publishes. Never commit to `main`, never publish place `106038900865360`
   yourself.
2. **Your files, all new (nobody else edits them):**

   | File | In Studio | What |
   | --- | --- | --- |
   | `src/server/DejaView/PingPong.luau` | ServerScriptService.DejaView | match rules, the 60 Hz ball, hit checks |
   | `src/server/DejaView/PoolGame.luau` | ServerScriptService.DejaView | 8-ball rules, turns, the 120 Hz sim |
   | `src/shared/PingPongSim.luau`, `src/shared/PoolSim.luau` | ReplicatedStorage.Shared | the physics step: the same code on the server and every client |
   | `src/client/Games.client.luau` | StarterPlayerScripts | your own LocalScript: input, paddle, cue, cameras, your HUD |
   | `src/client/Modules/PingPongView.luau`, `PoolView.luau` | StarterPlayerScripts.Modules | local balls, paddles, cue, aim line |

   Every `*.client.luau` in `src/client` becomes its own LocalScript, so you never edit `Client.client.luau`.
3. **The only line you add to Shivin's code**, per game, in `Main.server.luau` after `Foosball.start()`:
   `require(DV.PingPong).start()` (later `require(DV.PoolGame).start()`).
4. **Ask Shivin (his files):** the Game Lawn numbers in `Config.PINGPONG_TABLES["the-courts"]` (shared with his
   arcade game), a `"pool"` column in `Stats.GAMES`, and ending your game from his `pingpong` host action (item 12).
5. **Remotes:** create yours in `start()` under `ReplicatedStorage.Remotes`, so `default.project.json` stays his:

   ```lua
   local Remotes = ReplicatedStorage:WaitForChild("Remotes")
   local function remote(name: string, class: string): any
   	local r = Remotes:FindFirstChild(name) or Instance.new(class)
   	r.Name = name
   	r.Parent = Remotes
   	return r
   end
   local Paddle = remote("PPPaddle", "UnreliableRemoteEvent") -- hand poses, 30 Hz
   local Hit = remote("PPHit", "RemoteEvent") -- one per hit
   ```

   Clients: `Remotes:WaitForChild("PPPaddle")`. Prefix every remote and workspace attribute `PP` or `Pool`
   (`PPActive`, `PoolTurn`). Never set `PongActive`: while it is true Shivin's client shows his HIT button and fires
   `PongHit` on R2.
6. **Reuse, don't copy:** `World.Moment` and `World.toast` (moments, toasts), `World.where(p) == "room"`,
   `Theme.make` / `label` / `corner` / `stroke` (boards in the house style), `Stats.win(p, "pingpong")` (hall of
   fame), `Rooms.modelInfo(sceneId).features` (where the table is), `Backend.sendEvent` (results, D).
7. **Room lifecycle:** place your table when the workspace attribute `Phase` becomes `"room"`, inside
   `workspace.Room`; that folder is destroyed on every room switch, so on a `SceneId` change you only reset your state
   (as `Pong.start()` does). Leave `Rooms.onRoomReady` alone: it has one slot.
8. **Starting a game:** a `ProximityPrompt` on the table ("Play ping pong", "Play pool"). It works on phone, PC and
   Quest and needs no new HUD button; the host-bar PING PONG button stays Shivin's arcade game.
9. **Sync:** in `roblox/`, `rojo build -o seb.rbxlx` once, open that file in Studio, then `rojo serve` and Plugins →
   Rojo → Connect. Your own local place only: never Rojo into Shivin's published place or a Team Create session.
10. **Test in Studio:** Test → Server & Clients, 2 clients (HTTP on: README step 4).
    - **Live is the default:** `Config.USE_MOCK = false` and `BASE_FALLBACK` in `Config.luau` is the live link. Pick
      the Infinity Hall Game Lawn (`the-courts`) in the picker. A 401 means the key is on: add the `dejaview_key` Local
      Secret (README, Going live) with the value from Ojasva, privately.
    - **Mock:** `workspace:SetAttribute("DejaViewMock", true)` in the Server window's command bar (no file edit).
      Fixture rooms, no `features`, and every event you post prints as `[MockServer] event ...` in Output.
    - `/model` is cached per Roblox server: once Ojasva adds `features`, stop and start the test.
    - **Quest:** Studio on a Mac cannot play in a headset. Add a debug flag that drives the paddle from the mouse for
      most tests; for the real thing publish your build to your own private test experience (VR on, HTTP on) and join
      it from the Roblox app on Ojasva's Quest.
11. **Shivin's arcade ping pong (`Pong.luau`), so you know what is beside you:** no physics. The server picks every shot
    (a random bounce point on the receiver's half and an end point past their end) and every client draws the same two
    arcs from that description on the server clock (`PongBall.luau`). HIT counts after the bounce within 9 studs of
    your root, and a hit at the top of the bounce returns faster. First to 7; a bot covers an empty end. It works on
    any phone.
12. **Yours is the real-physics version beside it, made for the Quest.** Agree with Shivin today which one the Game
    Lawn table opens by default. Proposal: yours once it passes the Sat afternoon checkpoint, his arcade stays on the
    host bar as the phone-friendly fallback. One at a time: before you place yours,
    `if Pong.isActive() then Pong.remove() end`; he calls your `PingPong.stop()` from his `pingpong` action.

**B. Real ping pong at the Infinity Hall Game Lawn (now)**

Scene id `the-courts`; anything a player sees says "Infinity Hall Game Lawn" (or "Game Lawn"), never the id.

1. **Placement**, in this order: `features.pingPongTable` from `Rooms.modelInfo("the-courts")` once the server sends
   it (4 top corners in order around the table + `height`, studs; `contracts.md` 6.6); else
   `Config.PINGPONG_TABLES["the-courts"]` (`{centre, yaw, length, width, visible = false}`); else a full table 6 studs
   in front of whoever pressed the prompt (every mock room). Corners to centre, yaw and size: copy `placeFromFeature`
   in `Pong.luau`. Same frame as the block map: studs = metres × 3.57, floor y = 0. To tune by hand, drop a Part on
   the textured table top in a Play test, line it up, read its Position and Orientation.
2. **Real sizes**, life size (the textured table is):

   | | metres | studs |
   | --- | --- | --- |
   | Top | 2.74 × 1.525 | 9.78 × 5.44 |
   | Top above the floor | 0.76 | 2.71 |
   | Net | 0.1525 high, 1.83 long | 0.54 high, 6.53 long |
   | Ball | 40 mm | 0.143 across |
   | Paddle blade | about 0.15 × 0.16 | 0.55 × 0.57 |

   On the real table draw only the net and the white lines, like Pong does with `visible = false`.
3. **Ball, server-authoritative.** State `{pos, vel, spin, t, shotId}` in the table frame (long axis Z, net at z = 0,
   top at y = 0). A `Heartbeat` accumulator runs fixed 60 Hz steps, 4 substeps each. Per substep:
   - gravity **35.0 studs/s²** (9.81 × 3.57; not `workspace.Gravity`, which is 196.2 for avatars);
   - light drag: `vel -= 0.02 * vel.Magnitude * vel * dt` (a real ball is about 0.04 per stud);
   - table: the ball's bottom crosses the top inside the rectangle, moving down: `vel.Y = -vel.Y * 0.88`,
     horizontal × 0.95;
   - net: a thin box at z = 0 (6.53 × 0.54 × 0.05): `vel.Z = -vel.Z * 0.2`, the rest × 0.5; a ball over the top
     carries on;
   - dead ball: below y = −2.5 (near the floor) or 1.5 s after the last touch.
   Test each crossing between the substep's start and end (a sweep): a 30 m/s smash (107 studs/s) moves 0.45 studs per
   substep and would tunnel through the net otherwise. The step lives in `PingPongSim.luau`: the server runs it, and
   each client runs it forward from the last state for a smooth ball. Send state on a reliable remote at every hit,
   bounce, serve and point, plus an unreliable copy at 10 Hz; clients render on `workspace:GetServerTimeNow()`, like
   `PongBall.luau`.
4. **Paddle in VR**, every RenderStepped (`UserInputService.VREnabled` tells you it is a headset):

   ```lua
   local cam = workspace.CurrentCamera
   local h = UserInputService:GetUserCFrame(Enum.UserCFrame.RightHand) -- relative to the camera
   local hand = cam.CFrame * CFrame.new(h.Position * cam.HeadScale) * h.Rotation
   paddle.CFrame = hand * GRIP -- GRIP: the blade about 0.35 studs ahead of the hand, tilted to taste
   ```

   Use the hand whose trigger claimed the end (`ButtonR2` right, `ButtonL2` with `LeftHand`). Send `hand` on
   `PPPaddle` at 30 Hz; the server fans it out, and everyone draws the other paddles 0.1 s behind, interpolated.
5. **Hits: detected on the client, checked on the server.**
   - Client: each frame, the predicted ball in the paddle's space last frame and now; a hit when it crosses the blade
     plane within 0.45 studs of the blade centre (generous for tracking and latency). Paddle velocity = its movement
     over the last 3 frames. Apply the hit locally at once (it feels instant), then
     `PPHit:FireServer(shotId, ballPos, paddleVel, bladeNormal, workspace:GetServerTimeNow())`.
   - Server accepts when: it is that player's ball (their end, one bounce on their half, no volleys), `shotId`
     matches and is not hit yet, `ballPos` is within 1.5 studs of the server's ball at that time (keep 0.5 s of
     history), their last paddle pose is within 2 studs, and the speed is at most 107 studs/s. It sets the new state
     at that time, steps forward to now and sends it; a rejected hit gets the current state back and the client snaps.
   - Paddle to ball: `rel = vel - paddleVel`, `vn = rel:Dot(n)`; if `vn < 0`, `vel -= 1.8 * vn * n` (paddle
     restitution 0.8) and the tangential part of `rel` × 0.85; clamp to 107 studs/s. An `ASSIST` constant (0 to 1,
     start at 0.3) nudges a landing just outside onto the far half and lifts a ball that would hit the net.
   - Spin, optional and last: from the paddle's sideways speed at contact; a small Magnus term
     `vel += K * spin:Cross(vel) * dt`, K tuned by eye.
6. **Phones and PC (the assist):** the paddle sits in the avatar's hand. In your hit window (after the bounce on your
   half, within 6 studs of your root), tap your own HIT button, click or press E. The server builds the return: aim x
   from where you tapped or the mouse (left, centre or right third), depth from timing (early = short, top of the
   bounce = deep), flight time T from 0.8 s down to 0.5 s as the rally grows: `v0 = (target - p0) / T - 0.5 * g * T`
   (aim 5% long for the drag), lifted if it clears the net by less than 0.3 studs. The same function is the bot at an
   empty end, so you can test alone.
7. **The ball, bigger than real** (0.143 studs is a dot): physics radius 0.15 for everything (a 0.3-stud ball), drawn
   0.3 in VR and up to 0.45 on phones (centre lifted by the extra radius so it never sinks into the top). Neon white or
   orange, a short Trail, and a dark dot on the table under it so you can judge depth.
8. **Rules:** rally scoring to 11, win by 2 (one constant; 7 for the skit). Serve: the ball floats at chest height
   over the server's end line, hit it, it must land on the far half; net and in is a let. Serve changes every 2 points,
   every point from 10-10. A point is lost by a ball that misses the far half, a second bounce on your half, or a
   volley. Change ends after each game and at 5 in the last game: a 0.5 s fade, `PivotTo` the other end, swap the
   sides in your state (never move a VR player's camera without the fade).
9. **Spectators:** everyone else in the room sees the ball and both paddles. Scoreboard over the net (copy Pong's:
   names, score, who serves, rally, best rally). Pressing the prompt during a match queues you ("NEXT: Maya"); the
   winner stays on.
10. **Done when:** at the Game Lawn, you on the Quest against Shivin on a phone: a 5-shot rally, a full game to 11 with
    the right serve changes and the end change, and the `game.result` event (D) arrives.

**C. Pool in the game room (filmed today, playable tonight)**

1. **Film it (about 20 min, one phone; it becomes the world `game-room`):**
   - Room lights and the table lamp on, no flash. Lock exposure and focus (iPhone: long-press the table until
     "AE/AF LOCK"), 1× lens, no portrait mode.
   - Clear the table: balls in the pockets or the rack, cues on the wall (anything on the cloth is baked into the
     world; the game draws its own balls). Nobody moving, screens off.
   - The whole table and the room around it in every frame. **30 to 50 sharp photos** walking all the way round, at two
     heights: one lap at eye level looking slightly down, one at table height looking across. About 30 cm between
     shots, so each overlaps the last by about 70%.
   - Then **one slow 60 s video** lap at waist height, no fast turns.
   - **Close-ups:** each of the 6 pockets and both long rails, 2 or 3 photos each.
   - AirDrop the originals to Ojasva (chat apps shrink them).
2. **Measure with a tape** and send the numbers to Ojasva: the playing surface (cloth inside the cushion noses), the
   cloth height above the floor, one corner and one side pocket mouth. To sanity-check the size:

   | Table | Playing surface | Studs |
   | --- | --- | --- |
   | 7 ft | 78 × 39 in (1.98 × 0.99 m) | 7.07 × 3.54 |
   | 8 ft | 88 × 44 in (2.24 × 1.12 m) | 7.98 × 3.99 |
   | 9 ft | 100 × 50 in (2.54 × 1.27 m) | 9.07 × 4.53 |

3. **What the server provides** once `game-room` is rebuilt: `features.poolTable` in `/model` (`contracts.md` 6.6):
   `corners` (4 × [x, y, z] of the cloth surface, in order around), `pockets` (6 × [x, y, z] at cloth height),
   `railHeight`, `clothColor`, in studs. Until then: your own `POOL_TABLES` at the top of `PoolGame.luau` with the
   measured size, or a table in front of the player.
4. **Game: 8-ball, two players plus spectators, turn based.** The prompt claims a seat; the first two play, the rest
   watch and queue, the winner stays on. Rack: apex on the foot spot, 8 in the middle of the third row, a solid and a
   stripe in the back corners; cue ball behind the head string. Rules: the first ball potted after the break gives
   that player its group; you keep shooting while you pot your own; a foul (cue ball potted, nothing hit, or the other
   group or the 8 hit first) gives the other player ball in hand (tap or point to place it); potting the 8 after your
   group wins; the 8 early, or the 8 with the cue ball, loses. No called pockets.
5. **Physics: your own deterministic 2D sim on the table plane, never Roblox physics for the balls** (each client
   draws anchored, non-colliding Parts by CFrame, like `PongBall.luau`).
   - Server: a `Heartbeat` accumulator at 120 Hz; inside each tick, substeps so no ball moves more than half its
     radius (a break needs about 8).
   - Ball radius 0.102 studs (57 mm). Cue speed up to 30 studs/s for the break, about 3 to 10 for normal shots.
   - Ball to ball, equal masses, restitution 0.95: `n` from ball 1 to ball 2, `vn = (v1 - v2):Dot(n)`; if `vn > 0`,
     `v1 -= 0.975 * vn * n` and `v2 += 0.975 * vn * n`; then push the pair apart by the overlap.
   - Cushions: the 4 cloth edges inset by the radius; the normal part × −0.75, along the rail × 0.95; no cushion
     inside a pocket mouth.
   - Rolling friction: slow down by 0.4 studs/s² (μ about 0.011), stop below 0.05 studs/s. A shot ends when every
     ball has stopped.
   - Pockets: capture circles at the 6 pocket points, radius about half the mouth (0.22 corner, 0.24 side); a ball
     whose centre enters one is potted.
   - Only + − × ÷ and `math.sqrt` in the step (trig can differ between CPUs), a fixed pair order, no random. Then
     every client runs the same shot from one reliable `PoolShot {balls, cueVel, t0}` and matches the server; the
     server's positions at rest (`PoolRest`) snap any drift.
6. **Cue controls.** A shot is a direction in the table plane plus a speed; the server checks it is your turn, every
   ball is still and the speed is at most 30.
   - **VR:** hold the trigger with the controller near the cue ball to address it; aim along the controller's
     forward, flattened onto the table; pull the controller back along the aim line: 0 to 0.45 m (1.6 studs) is 0 to
     full power (squared, so soft shots are easy); release to shoot. Draw the cue and a line to the first ball it will
     hit.
   - **Phone:** a top-down aim camera on your turn (Scriptable, over the table centre, the table filling the screen).
     Touch near the cue ball and drag back: the opposite of the drag is the direction, its length the power (35% of the
     screen height is full); release to shoot, drag back onto the ball to cancel.
   - **PC:** the same drag with the mouse; one code path for `Touch` and `MouseButton1`.
7. **Ball scale:** real balls are 0.2 studs across, specks in third person. Keep real scale (in VR it is the real
   table) and let the top-down camera make them readable on phones. If you scale anything, scale balls, pockets and
   capture circles together and leave the cloth as it is.
8. **Done when:** on the rebuilt game-room table, a full 8-ball game between the Quest and a phone, with ball in hand
   after a scratch, the right winner, and its `game.result` event.

**D. Results: one event at the end of every match**

Post `game.result` (`contracts.md` 6.5) when a match ends, plus `Stats.win(winner, "pingpong")` for the hall of fame.
Ojasva's side does the rest, all being built now: the server stores it (Tiger Data replay), writes it to a public
Solana devnet scoreboard (the `/scores` page) and settles the Capital One Nessie tab (the loser covers the table, mock
money). Nothing else for you.

```lua
local HttpService = game:GetService("HttpService")
local Backend = require(script.Parent.Backend)

-- once when the match starts: retries reuse it, so the server never counts a match twice
local matchId = "pp-" .. HttpService:GenerateGUID(false)
local startedAt = workspace:GetServerTimeNow()

local function idOf(p: Player?): string
	return if p then "rbx-" .. p.UserId else "bot"
end

-- once when it ends; the winner's points first
local function postResult(winner: Player?, loser: Player?, winnerPoints: number, loserPoints: number)
	local sceneId = workspace:GetAttribute("SceneId")
	if type(sceneId) ~= "string" or sceneId == "" then
		return
	end
	-- queued and in order, 3 retries 1 s apart; each try is Backend.event(sceneId, body)
	Backend.sendEvent(sceneId, {
		type = "game.result",
		game = "pingpong", -- "pool" for pool
		round = matchId,
		winner = idOf(winner),
		winnerName = if winner then winner.DisplayName else "Bot",
		loser = idOf(loser),
		loserName = if loser then loser.DisplayName else "Bot",
		score = string.format("%d-%d", winnerPoints, loserPoints), -- pool: balls each potted, the 8 counts for the winner
		durationS = math.floor(workspace:GetServerTimeNow() - startedAt),
	})
end
```

Mock: the event prints in Output. Live: no `event failed` warning may follow. A `400` about the type means the server
does not take the dot in `game.result` yet: tell Ojasva (a one-line server fix) and keep your body as it is.

**E. Sponsor sign-ups only a person can do (15 minutes in any gap)**

Send every value to Ojasva privately (DM): never in the repo, the team chat or a screenshot.

1. **Auth0** (free tenant, auth0.com): Applications → Create Application → Single Page Application, "Déjà View".
   Allowed Callback URLs and Allowed Logout URLs: `https://<your domain>/capture, https://<your domain>/host` (plus the
   same two on the current tunnel link); Allowed Web Origins: both origins. Then Applications → APIs → Create API,
   identifier `https://dejaview/api`. Send `AUTH0_DOMAIN` (the tenant, like `dejaview.us.auth0.com`),
   `AUTH0_CLIENT_ID` and `AUTH0_AUDIENCE` (the API identifier).
2. **Tiger Data:** a free Tiger Cloud service (tigerdata.com); its connection string (`postgres://...?sslmode=require`)
   is `TIGER_DATA_URL`.
3. **Capital One Nessie:** nessieisreal.com, sign in with GitHub, the key on the Profile page is `NESSIE_API_KEY`
   (section 12.1).
4. **Still open from before, if not done:** Vultr access (Update 3 item 3) and the domain's tunnel token (Update 3
   item 2).

**F. Checklist**

- [ ] **Sat 7 AM:** branch, Studio + Rojo on your own place, `PingPong.luau` registered, a full table in front of you
  in mock.
- [ ] **Sat 10 AM:** `PingPongSim` on its own: bounces on the top (0.88), stops at the net, dies on the floor; 2
  clients see the same smooth ball.
- [ ] **Sat 12 PM:** a phone/PC assist rally against the bot; serve, score to 11, serve changes, end change,
  scoreboard; `game.result` in the mock Output.
- [ ] **Sat 1 PM:** the pool table filmed and measured, photos with Ojasva (earlier is better: the rebuild runs after).
- [ ] **Sat 3 PM:** the VR paddle on the Quest (your test place): hits feel right, others see your paddle.
- [ ] **Sat afternoon (5 PM): ping pong playable** at the Infinity Hall Game Lawn, Quest against a phone on the real
  table, live link; Shivin merges it and you settle the default table game with him.
- [ ] **Sat 7 PM:** `PoolSim` on a hand-made table of the measured size: break, collisions, cushions, pockets, the same
  result on 2 clients.
- [ ] **Sat night (11 PM): pool playable** on the rebuilt `game-room` table: 8-ball on Quest, phone and PC,
  `game.result` arrives; Shivin merges it.
- [ ] **Sun 2 AM:** the full team run with both games; fix only what breaks.
- [ ] **Sun 4 AM:** your Devpost lines: what is real physics, the controls per device, credit for any Creator Store
  sounds or models.
- [ ] **Sun 6 AM: freeze.** No new code; the last merge; Shivin publishes. Submission Sun 8 AM.
- [ ] **Any gap:** E (15 minutes).

**Update 4 (Sat ~4:50 AM):** five worlds (`tilted-towers`, `brick-apartment`, `the-courts`, `chess-room`, `kitchen`)
and three video memories (`courts-foosball`, `chess-match`, `kitchen-cooking`). Your gallery picks them up from
`GET /api/scenes` with no change. "Join in Roblox" goes on the five worlds, not on the video memories.

**Update 3 (Sat ~3 AM): what is next for you (the update box below still stands):**

**The public link is live:** `https://deja-view.photo` (it changes if the tunnel restarts; Ojasva reposts). Set it as `dvBase` in your
DeepSpace config now and point your gallery and "Add a memory" at it (uploads open once Ojasva switches the server
from read-only, Saturday morning; reading `/api/scenes` works now). Send your DeepSpace URL and `DS_KEY` privately the
moment `/api/ingest` and `/api/notes` are deployed, so the live map and notes go end to end.

1. **The worlds are changing:** the four rebuilt worlds (real footage, every angle; walking limited to where the camera went): **`tilted-towers`**
(outdoor town centre), **`brick-apartment`** (the Brick House apartment), **`the-courts`** (our table-tennis and
foosball patio, from 25 photos), **`chess-room`** (the giant-chess lounge). The two video memories, **`courts-foosball`**
and **`chess-match`**, put the people from our clips into those places as full 3D people you can walk around, even
paused. "Add a memory" and your gallery need nothing new: they read
   `GET /api/scenes` like before.
2. **The domain's tunnel token:** when you have it, send it to Ojasva privately; the server's tunnel runs with it on
   the demo Mac.
3. **Vultr:** the backup worker is ready in the repo (`vultr/README.md`: push, setup, start, point the server at it,
   destroy after). When your A40 access works, do one practice run with Ojasva Saturday evening, then destroy it.
4. **Optional, a nice extra for the map:** `GET BASE/api/replay/<sceneId>/heat` (Tiger Data, once Ojasva turns it on)
   returns person-seconds per floor cell; shading your map's floor with it shows where everyone hung out.

## Update, Saturday early morning: Photon is out, a domain comes in

This box wins over anything below it. Keep everything you have already built; this only moves time around.

**What changed:** Photon is not a prize on the SwampHacks XII Devpost and the bot is not working, so it is dropped: it
does not appear in the demo, the pitch or the Devpost write-up. The Devpost does list **MLH Best Domain Name from GoDaddy Registry**, and a
domain fixes a real problem for the whole team, so that takes Photon's place.

1. **Photon bot: stop.** No more time on it. Keep any code you wrote for demo mode (the SHA-256 table) and the upload
   (4.2, 4.4): step 2 reuses both. Skip every Photon, iMessage and Telegram step in sections 2.4 and 4.
2. **New, about 1.5 h: "Add a memory" in your DeepSpace app.** This is now the way a memory comes in, and it gives DeepSpace **storage** real work to do (one more feature for the DeepSpace judges).
   - A big button on the gallery page, phone-first: take or pick a photo or video.
   - Save the file in DeepSpace storage, then send it to Déjà View with the same upload as the bot (4.4: `POST
     BASE/api/scenes`, `mode=photo` or `mode=video`, `name`, `files`), from your worker, never from the browser.
   - **Demo mode carries over:** if the file's SHA-256 is in your demo table (4.2), link the pre-built scene id instead
     of uploading.
   - The new card shows up building live in your gallery, then ready with "Walk in" (`BASE/view?scene=<id>`).
   - In the skit (0:00) you drop the game-night clip in from the table iPhone through this page; demo mode answers at
     once. The finale ("now do it") uses it too: the judge snaps a photo on the table iPhone and it goes in here.
   - Each ready memory gets a "Copy link" button, so anyone can paste the walk-in link into a group chat.
   - Photo memories also get "Join in Roblox": `https://www.roblox.com/games/start?placeId=106038900865360&launchData=<sceneId>`
     (Shivin's experience "Deja View", VR on Quest enabled); video memories do not (a video is not a Roblox place).
3. **New, about 1 h: the domain (MLH Best Domain Name from GoDaddy Registry).**
   - Why: today the public link is a quick tunnel whose address changes every time it restarts, so Roblox, the
     headset, your app and the judges' phones all break at once. A domain makes one link that never changes. It goes
     on the table card, the Devpost and the QR codes.
   - Get the domain **free** with the MLH GoDaddy Registry offer (MLH prizes page or an MLH coach). **Do not pay for
     anything.** Pick something short that says Déjà View; run the name past the team chat first.
   - Free Cloudflare account → Add a site → your domain → set the domain's nameservers to the two Cloudflare gives you.
   - Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared) → name it `dejaview`. Add a public
     hostname: your domain (or `app.<domain>`), service `HTTP`, URL `localhost:8788`.
   - Copy the **tunnel token** and send it to Ojasva **privately** (never in the team chat, never in a repo). He runs
     the tunnel on the demo Mac with it.
   - **Done** when `https://<your domain>/api/health` answers from your phone on cellular. Target: **Sat 12 PM**
     (nameserver changes can take an hour or more, so start early).
4. **DeepSpace write-up for the Devpost (15 min, by Sat 10 PM).** Their rules want the features you used and where
   judges can see them. Five lines: sign-in (auth), notes and presence (data), the live map (real-time sync), "Add a
   memory" (storage), and the live URL with how a judge signs in, without exposing any key.
5. **Look: the Déjà View site is moving to a clean Apple style**, so your app should match it (this replaces 5.12):
   - Type: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`.
   - Colours: text `#1D1D1F`, secondary text `#6E6E73`, background white, cards `#F5F5F7`, hairlines
     `rgba(0,0,0,.1)`, buttons and links iMessage blue `#007AFF`, notes as gray message bubbles `#E9E9EB`.
   - Shape: radii 12 to 20 px, generous spacing.
   - Avoid: glowing or pulsing dots, neon, monospace labels. On the `/live` map the headset dot is a plain blue dot
     with a view cone, and the "LIVE" chip is a small red pill with no pulse.
6. **Capital One is still optional and still yours**, but it is the biggest sponsor cash prize on the Devpost ($1,000)
   and the Photon time is now free. If you want it, it is worth a real try after the Sat 4 PM milestone. Nothing
   depends on it.

New order: (1) Vultr, (2) the DeepSpace app plus "Add a memory", (3) the domain, (4) Capital One if you want it. The
milestones in section 10 stay, plus the domain by Sat 12 PM.

## 0. The short version

You own these, in this priority order:

| # | What | Why it matters (what it causes) | Prize | Time budget |
| --- | --- | --- | --- | --- |
| 1 | **Vultr GPU access** (tonight) | A warm GPU worker is what makes the live finale possible. New accounts can be blocked from GPUs, so find out tonight | MLH Best Use of Vultr | 30 min tonight |
| 2 | ~~Group-chat bot (iMessage through Photon)~~ **Dropped: see the update above.** Its demo mode and upload move into "Add a memory" | | | 0 |
| 3 | **DeepSpace app**: sign-in, gallery, **live presence map with trails**, **notes** (DeepSpace is where notes live), invites | It remembers who was there and what they said: the table-laptop screen at 1:40 | DeepSpace: 1st = $1,000 credits + $250 cash | the rest of Saturday |
| 4 | Capital One Nessie side quest (section 12) | **Optional, your design.** Nothing depends on it; 15 s at 2:45 only if it is ready and good | Capital One Best Use of Nessie ($1,000 cash) | only after the Sat 4 PM milestone |

**Deadlines:** Vultr tonight; the bot replying by **Sat 10 AM**; the DeepSpace map and notes by **Sat 4 PM** (post the
deployed URL and hand over `DS_KEY` as soon as the first deploy of `/api/ingest` and `/api/notes` works, so Ojasva can
point his server at them early);
full demo run **Sat 10 PM**; Capital One ready and good, or dropped, by **Sat 10 PM**; feature freeze **Sun 4 AM**.

Six facts from tonight's checks:

1. **Photon is not a listed SwampHacks XII challenge.** It is not in the hacker guide, on Devpost or on the MLH prize
   page. Build the bot anyway (it opens the demo), but cap it and spend the rest on DeepSpace, which is a prize.
2. **Photon's free iMessage lines only talk to phone numbers you registered first** ("users"), and a shared line can
   never send the first message. So every phone that texts the bot is added beforehand (20 s each), and the demo
   phones are registered tonight. A judge's own phone only works if you register it before they text.
3. **Group chats on the free plan are not guaranteed.** Photon's docs: shared lines (Free and Pro) cannot create
   groups and get no group membership events; existing group chats are listed as supported on cloud lines, but Photon
   recommends a dedicated line (Business, $250 per line per month) for group workflows. Different users are also
   assigned different bot numbers. So tonight you **test** a group on the free line, with a verified Plan B (2.4).
4. **Vultr GPUs right now: only the NVIDIA A40 48 GB has enough memory, and only in New Jersey (`ewr`) and
   Los Angeles (`lax`).** No L40S or A100 anywhere, nothing in Miami, and Atlanta has only the 16 GB A16 (too small).
5. **DeepSpace: open the referral link and sign in there first.** Your DeepSpace account is created by your first
   Google/GitHub sign-in, so running `npx deepspace auth login` first loses the 5,000 free credits.
6. **The Déjà View server calls your DeepSpace worker, never the other way round:** presence to
   `POST https://<your-app>.app.space/api/ingest`, notes from `GET .../api/notes?sceneId=<id>` and to
   `POST .../api/notes`, all with the header `X-DejaView-Key`. Routes under `/api/` are handled by the DeepSpace worker
   before the static site. Your browser pages never write to Déjà View.

---

## 1. Your moments in the demo, and what is going on with Ojasva

### 1.1 The skit and the finale, from your side

| Time | What the judge sees | Your piece |
| --- | --- | --- |
| 0:00 | Host: "We had a game night. Seb skipped it. He's about to find out what he missed." You drop the game-night clip into the group chat from the table iPhone (the clip was filmed on it). Within 3 s the bot replies in the same thread with a thumbnail and the links (walk in, join from Roblox, see who's inside) | Bot, **demo mode**: it recognises the clip and answers with the pre-built world, no GPU wait |
| 0:15 | The judge puts on the Quest and is inside the game-night memory (Ojasva has it loaded already) | optional `load` cue from the bot |
| 0:40 to 1:00 | Gemini labels, the voice answer, the reality check | (Brianna, Ojasva) |
| 1:10 | Shivin and Brianna join as Roblox avatars; tag round | (Shivin) |
| 1:40 | The table laptop shows your **live map**: everyone moving, a lime VR dot with a view cone, trails. Brianna clicks the couch and types "Seb's seat. He was too scared to show up." It appears on the map at once and pops up in the headset as a sticky note within about 2.5 s | DeepSpace `/live` + notes |
| 2:00 | **"Now do it."** The judge snaps a photo on the table iPhone and sends it to the group chat. The bot answers "Got it. Moving you in...", one progress text, then the thumbnail and links | Bot, **live path** (real generation on the warm GPU); the gallery shows the card building live |
| 2:25 | The judge's world is ready: the bot replies, the headset swaps in, the new room appears in the DeepSpace gallery and on the map with the judge's dot | bot, gallery, map |
| 2:45 | Optional: your Capital One side quest, 15 s | section 12 |

You are not in the game-night clip: in the story you skipped game night. Ojasva runs the filming on Saturday by 2 PM,
on the table iPhone; you prop the phone and stay out of frame.

### 1.2 What exists today vs what Ojasva is building

`BASE` is the Déjà View server: the LAN address on the same Wi-Fi now (`http://<mac-lan-ip>:8788`), and a public https
link by **Sat 4 PM**. The server (Bun, on Ojasva's Mac) **already works**: upload a photo or video, it generates a world
on a GPU (HiPerGator warm worker first, then a HiPerGator batch job, then a public FlashWorld Space, then a local
fallback), and serves the viewer that runs in the Quest 3S.

| Already there (use it now) | Ojasva still builds (you depend on it; `contracts.md`) |
| --- | --- |
| `POST /api/scenes` (upload), `GET /api/scenes`, `GET /api/scenes/:id` | `mode=photo` / `mode=video` aliases (Fri night). If an upload with `mode=photo` returns 400 before that lands, tell him |
| `/data/scenes/:id/<file>` (thumbnails, worlds), with `Access-Control-Allow-Origin: *` | Plain-HTTP port **8788** for machines (Fri night). Port 8787 is https with a self-signed certificate, for the Quest |
| `/view?scene=<id>` (the viewer; works on phones, desktops, Quest) | Every endpoint answering on the LAN (**Sat 10 AM**), including the presence push and the notes relay against your local DeepSpace or a mock |
| `WS /ws` (live scene events: created, progress, ready, failed) | The **public https link** (**Sat 4 PM**); the push and notes pointed at your deployed app |
| | `world.bounds` and **`world.topdown`** (a top-down image of the room) on the demo worlds (Sat 4 PM) |
| | Optional: `POST /api/host/cue`, so the bot can make the Quest load a world |

HiPerGator note: the server reaches HiPerGator through one SSH socket on Ojasva's Mac that the login holder opens with
password + Duo, and it lasts 24 hours. The config uses the login `sbernalorta`. **If that is your account, Ojasva needs
you for one login on his Mac on Saturday morning and again about 24 hours later, before the demo.** Do it the moment
he asks.

---

## 2. Tonight: accounts and keys, in this order

Do these before writing code. Each one has a time box; if one is blocked, follow the fallback and move on.

### 2.1 Tools (10 min)

- **Node 24** (`node --version` shows v24.x). DeepSpace requires Node 22.15+, 24 or 26 (not 23 or 25), **and npm
  11.6+**. Node 22 ships npm 10, so take Node 24 (or run `npm i -g npm@latest`). **Verified** on the npm registry
  (`create-deepspace@0.42.3`, published Oct 13).
- **Bun 1.3+** for the bot (`curl -fsSL https://bun.sh/install | bash`). Node 20+ also works if you prefer it.
- git, a code editor, and your iPhone with iMessage on.

### 2.2 Vultr (30 min, tonight)

**Verified** facts: the MLH steps (mlh.com/partners/vultr), the gift-code link (`mlh.link/vultr-giftcode` redirects to
`my.vultr.com/billing/?promo=HACKATHON`), and the live GPU plans and stock (Vultr public API, checked 11 PM Friday).

1. **Get the free $100 code.** Register at `mlh.link/vultr-discover` (Company: University of Florida, Job title:
   Student) and check your email for the promo code. You can also get one from the "Log In To Claim Code" button on
   https://www.mlh.com/events/swamphacks-xii/prizes or from an MLH coach at the venue.
2. **Create the account** at `mlh.link/vultr-signup` and verify your email. Only one account per person.
3. **Redeem:** Billing → Gift Code → paste the code → you should see $100 of credit.
   - If Vultr asks for a card or PayPal before it lets you deploy, that is your call. If you would rather not, stop
     here and tell Ojasva; HiPerGator stays the main GPU.
4. **Check the limits:** Account → Limits (under Billing). A GPU box costs about $1,250 a month at the monthly rate. If
   the "maximum instance cost" is below that, click **Request Limit Increase** now (use case: "SwampHacks hackathon, one
   A40 GPU for about 24 hours"). Approvals take hours, which is why this happens tonight.
5. **Test deploy, then destroy.** Products → Compute → Deploy → **Cloud GPU** → location **New Jersey** → GPU
   **NVIDIA A40**, plan `vcg-a40-24c-120g-48vram` (48 GB GPU, 24 vCPU, 120 GB RAM, 1.4 TB disk, **$1.712/hour**) →
   Ubuntu 24.04 (the GPU images come with NVIDIA drivers) → Deploy. When it says **Running**, **destroy it right away**
   (server page → Destroy). That proves GPU access works. Cost: about one hour of billing at most.
   - A40 not offered in New Jersey? Try **Los Angeles**. Re-check stock from a terminal any time:
     `curl -s https://api.vultr.com/v2/regions/ewr/availability | grep -o 'vcg-a40[^"]*'`
   - Only A16 (16 GB) available? Do not deploy: it is too small for the world model. Tell Ojasva.
   - Error "not authorized" or "limit": open a support ticket (Support → New ticket) saying the same as in step 4.
6. **Tell Ojasva** in one message: "Vultr OK, A40 in ewr deploys" (or exactly what failed).

**Billing rule (Verified, Vultr Cloud GPU FAQ): a stopped GPU instance is billed exactly like a running one. Only
Destroy stops the charges.** $100 at $1.712/h is about 58 hours, so keep the real box under about 40 hours.

The real box comes later (section 7). Do not leave anything running tonight.

### 2.3 DeepSpace (10 min, tonight)

1. **Before anything else** open https://dashboard.deep.space/join/SWAMPHACKS2026 (the referral code `SWAMPHACKS2026`
   is in the link; if a code box appears, enter it) and sign in there with Google or GitHub. That first sign-in creates
   your account with the referral: 5,000 credits ($50). **Verified**: hacker guide; DeepSpace docs say accounts are
   OAuth-only and created on first sign-in.
   - Already have a DeepSpace account? Message DeepSpace privately (Discord DM, not a public channel) with your
     account email to get the credits.
   - Credits must be claimed **and used** by Oct 28, 11:59 PM ET. Optional: code `DEEPSPACE20` gives 20% off a first
     paid plan. You should not need a paid plan.
2. In a terminal (Node 24): `npx deepspace auth login` and sign in with the **same** Google/GitHub account, then
   `npx deepspace auth whoami` should print your email.
3. Pick the app name now. It becomes `https://<name>.app.space`, is globally unique, lowercase letters, digits and
   dashes, 2 to 63 characters. Suggestion: `dejaview-live` (fallback `dejaview-swamp`). The name is shown on the
   table laptop, so keep it clean. Post it in the team chat.

### 2.4 Photon and the group chat (45 min, tonight)

What Photon is (**Verified**, photon.codes and its docs, Oct 16): an open-source TypeScript SDK called **Spectrum**
(`spectrum-ts`, v12.11.0, published Oct 15) plus a cloud that runs real iMessage lines for you. Your bot is a normal
Bun/Node process: it opens an outbound connection to Photon's cloud, so **you need no public URL and no webhook**.
It receives messages in a `for await` loop and replies with text, images, effects and links. The same code can also
answer on Telegram.

Plans (**Verified**, photon.codes/pricing and the beta plans page): **Free, $0**: a managed *shared* iMessage line
pool, up to 10 users (the beta plans page says 25 shared assignments; plan on 10), RCS/SMS fallback, Telegram. Each
user is assigned a line number that has never messaged them before, so **different people text different numbers**.
Quotas: 5,000 messages per day and 50 new conversations per line per day. Group creation is not available on shared
lines; Business ($250 per dedicated line per month) has full group messaging.

Use the stable dashboard **https://app.photon.codes** (not `app.beta.photon.codes`, which is "Photon 2.0" with a
different SDK and API).

1. Sign up at https://app.photon.codes (Get Started) and create a project (location `us-east`, Spectrum on).
   CLI alternative: `npx @photon-ai/cli login`, then
   `npx @photon-ai/cli projects create --name "Deja View" --location us-east --spectrum`.
2. Project → **Settings**: copy the **Project ID** and **Project secret** into `bot/.env` as `SPECTRUM_PROJECT_ID` and
   `SPECTRUM_PROJECT_SECRET`. Never commit this file.
3. Make sure iMessage is enabled for the project (dashboard platforms, or
   `photon spectrum platforms ls` / `photon spectrum platforms enable imessage`).
4. **Find each real iMessage handle:** open https://debug.photon.codes on the iPhone. It opens a chat with Photon's
   debug bot, which replies with the exact handle (phone number or email) Apple sends from. If it shows an email,
   switch iPhone Settings → Messages → Send & Receive → "Start new conversations from" to the number.
5. Project → **Users** → add that handle. The dashboard shows the **line number assigned to that user**: that is the
   number that user texts. Register: the **table iPhone** (you send the clip from it at 0:00, and the judge sends their
   photo from it at 2:00), your phone, Brianna's, Shivin's and Ojasva's.
6. Run the echo bot from section 4.5 and text "ping" to your assigned number. Then send a **photo** and a
   **5-second video** and check that the bot logs a MIME type, a byte count and a sha256 for each.
7. **The group test (15 min; the 0:00 beat depends on it).** On the table iPhone, create a new iMessage group with the
   bot number assigned to the table iPhone's user plus your phone and one more teammate. From the **table iPhone**,
   send "ping", a photo and a short video; then send a photo from your phone. **Pass** = the bot logs all of them with
   `space` being the group, and its replies appear in the group for everyone.

If step 7 fails, go straight to Plan B. Tell Ojasva which plan won before you sleep.

**Plan B: the local iMessage provider (Verified: docs and npm, `@spectrum-ts/imessage-local` 12.11.0).** It reads the
Messages database on a Mac, needs no Photon credentials and no user registration, and supports existing DMs and group
chats (receive and send text and attachments). It has no message effects (no confetti) and typing indicators do
nothing. Because it needs no registration, a judge's own phone can text it directly.
- It needs a Mac signed into **Messages** with an Apple ID that is **not** the person sending the clip (the bot skips
  its own outbound messages, so it would ignore you if it ran as you). Best: a new Apple ID made just for the bot
  ("Déjà View"), signed into Messages on a teammate's Mac or on Ojasva's demo Mac (ask him first: his own iMessage
  leaves that Mac for the weekend). Add that Apple ID's handle to the demo group.
- Grant **Full Disk Access** to the terminal app that runs the bot (System Settings → Privacy & Security → Full Disk
  Access), so it can read `~/Library/Messages/chat.db`. On Node it needs `better-sqlite3`; Bun is fine.
- Config: `import { localIMessage } from "@spectrum-ts/imessage-local"` and
  `Spectrum({ providers: [localIMessage.config()] })`. `message.platform` is `"local_imessage"`.
- If the bot runs on a Mac other than Ojasva's, set `DV_API` to the public `BASE` (or his LAN `http://<ip>:8788`).

**Plan C:** a 1:1 thread with the bot, using the cloud line. The host says "drops it in the chat". Everything else stays
the same.

**Checkpoint (tonight):** a photo and a video sent in the demo chat reach your laptop as bytes, and the bot can reply
into that chat. If any step is blocked for more than 30 minutes, take the next plan and keep going.

### 2.5 Fallback channel: Telegram (5 min, do it tonight anyway)

- In Telegram, message **@BotFather** → `/newbot` → pick a name → copy the token into `bot/.env` as
  `SPECTRUM_TELEGRAM_BOT_TOKEN`.
- Spectrum has a Telegram provider: add `telegram.config()` next to `imessage.config()` and the **same loop** answers
  on both (it uses your Photon project to register the webhook, so still no public URL). Telegram groups work with
  bots (turn privacy mode off in @BotFather with `/setprivacy` so the bot sees photos in the group).
- If Photon itself is down: talk to the Telegram Bot API directly with long polling (`getUpdates`), also no public URL.
- **Verified** limits (core.telegram.org/bots/api): a bot can download files up to **20 MB** (keep test videos short);
  photos you upload can be up to 10 MB.
- Not an option: **Twilio SMS/MMS**. It needs a paid number, and US texts from an unregistered 10-digit number are
  blocked until A2P 10DLC registration is approved (Twilio error 30034), which takes days.

---

## 3. How everything connects

```
  your phone / table iPhone ──iMessage group──▶ Photon cloud ◀──outbound── BOT (Bun; your laptop, the demo Mac for the skit)
                                        (or Plan B: Messages on a Mac)       │  POST /api/scenes (mode=photo|video)
                                                                             │  GET /api/scenes/:id or WS /ws (progress)
                                                                             │  GET /data/scenes/:id/<thumb>
                                                                             ▼  (optional) POST /api/host/cue
                         ┌───────────────── Déjà View server (Ojasva's Mac; LAN BASE :8788, public https BASE)
  Quest 3S viewer ──────▶│  presence store ── GPU: HiPerGator warm worker / Vultr A40
  Roblox servers  ──────▶│  notes cache ──WS──▶ headset (sticky notes)
                         └──┬── POST <DS_URL>/api/ingest          (about 4 Hz per occupied scene)
                            ├── GET  <DS_URL>/api/notes?sceneId=   (every 2 s per occupied scene)
                            └── POST <DS_URL>/api/notes            (notes made in the headset)
                                         all with X-DejaView-Key: <DS_KEY>
                                                    ▼
                         DeepSpace app (Cloudflare Workers, yours)
                           worker /api/ingest ──▶ "live" row ──realtime──▶ every open map, 60 fps
                           worker /api/notes  ◀─▶ "notes" collection ──realtime──▶ every open map
                           browser ── click on the map ──▶ creates a "notes" record (signed in)
                           browser ── GET BASE/api/scenes + WS BASE/ws + thumbnails ──▶ gallery (CORS: *)
                           Google/GitHub sign-in, favourites, comments, visits, invites
```

Who calls whom:

| Caller | Callee | What | Auth |
| --- | --- | --- | --- |
| Bot | Photon cloud (or local Messages) | receive and send messages | `SPECTRUM_PROJECT_ID` + secret (env) |
| Bot | Déjà View `DV_API` | create scenes, watch progress, fetch thumbnails, optional cue | none from the same Mac; `x-dejaview-key: <DV_KEY>` on the cue from elsewhere |
| Déjà View server | DeepSpace `/api/ingest`, `/api/notes` | presence snapshots; read notes; write headset notes | header `X-DejaView-Key: <DS_KEY>` |
| DeepSpace page (browser) | Déjà View `dvBase` | scene list, thumbnails, top-down image, live scene events (read only) | none (server sends CORS `*`) |
| DeepSpace page | DeepSpace worker + records | sign-in, records, realtime | DeepSpace JWT (handled by the SDK) |

URLs and ports:

| Name | Value | Notes |
| --- | --- | --- |
| `DV_API` (bot) | the LAN `BASE` `http://<Ojasva LAN IP>:8788` while building; `http://localhost:8788` on Ojasva's Mac at the demo | plain HTTP (8787 is https with a self-signed certificate for the Quest: don't use it). Until 8788 exists, Ojasva may post `https://<ip>:8787`: use `curl -k` for tests |
| `DV_PUBLIC` (bot) / `dvBase` (DeepSpace) | the public https `BASE`, e.g. `https://xxxx.trycloudflare.com` (Sat 4 PM) | what goes into links people tap. It can change if the tunnel restarts, so keep it configurable (bot `.env`, DeepSpace `config` record) |
| `DS_URL` | `https://dejaview-live.app.space` | your app |
| DeepSpace local dev | `http://localhost:5173` | `npx deepspace dev start` |

Two network traps:
- A deployed DeepSpace page is https, so the browser **refuses** to fetch an `http://10.x...` LAN address (mixed
  content). Until the public link exists (Sat 4 PM), build the gallery in local dev (`http://localhost:5173` may call
  http) or against mock JSON. The server's push and notes calls to your deployed app work any time: they go out from
  Ojasva's Mac.
- Campus Wi-Fi often blocks laptop-to-laptop traffic. If you cannot reach Ojasva's LAN IP, both of you join one phone
  hotspot.

`/ws` sends more message types than `scene` (`note`, `roblox`, `cue`, ...). **Ignore any type you don't use.**

---

## 4. Part A: the group-chat bot

### 4.1 Behaviour (the spec)

| You receive | The bot does |
| --- | --- |
| media or text that matches **demo mode** (4.2) | instant reply with the pre-built world. No upload |
| 1 to 8 photos (any order, within 2.5 s) | Photo world: `mode=photo`, all photos (the server picks the best one) |
| 1 video | Video memory: `mode=video` (exactly one video, filmed from a still, propped-up phone) |
| a photo and a video together (an iPhone **Live Photo** can arrive as HEIC + MOV) | keep the photo(s), drop the video, `mode=photo` (the server rejects photos and a video together) |
| in a DM: plain text that is not a command, at least 3 words ("a cozy cabin at night") | Photo world from the prompt alone (`mode=photo`, `prompt=<text>`, no files) |
| text within 2.5 s of an attachment | becomes the memory's `name` (first 60 chars) |
| `rooms` | the 3 newest ready memories, each with its link |
| `map` | the live-map link for this chat's latest memory |
| `help` | one short help message |
| anything while this chat's previous memory is still building | "Still on your last one. I'll text you the second it's ready." |

**In a group chat**, react only to photos, videos and messages that start with a command word (`rooms`, `map`,
`help`, or `dejaview ...`) or a demo keyword. Never answer normal conversation: friends are talking to each other.
**In a DM**, answer everything (it keeps the line healthy).

Message timing and copy (keep every string in `copy.ts`; plain text, warm, short, a little funny; no emoji walls):

1. **Within 2 s of the last attachment:** typing indicator (cloud only), then "Got it. Moving you in..."
   (video: "Ooh, footage. Building the room around it...").
2. **One progress message, not more,** when the scene first reports `status: "running"` or `progress >= 0.3`:
   "Building the room: <stage, lowercased>". The server's `stage` strings are already human ("Generating the room").
3. **Ready:** the thumbnail as an image (with the iMessage **confetti** effect on cloud lines), then **one** text with
   three lines:
   ```
   Your memory is ready. Walk in: <DV_PUBLIC>/view?scene=<id>
   No headset? Join in Roblox: https://www.roblox.com/games/start?placeId=<ROBLOX_PLACE_ID>&launchData=<id>
   See who's inside: <DS_URL>/m/<id>
   ```
   (Shivin sends you `ROBLOX_PLACE_ID` by Sat 12 PM; leave that line out until then.) Then, only for the demo chat,
   the optional `load` cue (4.4).
4. **Over 90 s and not ready:** "Still building. Big room. I'll text you when it's done." (once), keep waiting up to
   10 minutes.
5. **Failed:** the server's `error` is already a friendly sentence; pass it through, prefixed with "That one didn't
   work: ". Network error reaching Déjà View: "Our GPU is taking a breather. Try again in a minute." and retry the
   upload once after 5 s.

Pace: never send more than one message per second (Apple flags bursty lines). Links work well because users write
first.

### 4.2 Demo mode (the 0:00 beat)

The skit uses worlds built in advance (`plan.md`). The bot must recognise the demo clip and answer instantly.
`bot/demo.json` (not secret; the `media` and `keywords` tables are the `contracts.md` section 9 format, the other
fields are yours):

```json
{ "media":    { "<sha256 of the game-night clip as the bot receives it>": "game-night-k3x9a" },
  "keywords": { "#dejaview gamenight": "game-night-k3x9a", "#dejaview fortnite": "fortnite-q8w2e" },
  "demoSpaceId": "<the demo group's space id, logged the first time it messages the bot>",
  "arm": { "gamenight": "game-night-k3x9a" } }
```

Matching, in this order, only when `DEMO_MODE=1`:
1. **sha256 of the received bytes** is a key in `media`. Hash the bytes **as the bot receives them**, not the file on
   the phone: iMessage may re-encode. In rehearsal, send the clip once from the **table iPhone** (the phone used on stage),
   copy the hash the bot logs into `demo.json`, restart, send it again and confirm the match.
2. **A keyword** in text that arrives within 2.5 s of the media, or on its own (type `#dejaview gamenight` as the
   caption). This is the backup: send it with the clip on the night.
3. **Armed cue:** you DM the bot `!arm gamenight` from your own registered phone; the next video in the demo chat maps
   to that scene, once. Use this if the hash changes on the night.

On a match: send the scene's thumbnail (`GET {DV_API}/data/scenes/<id>/<thumb>`; Ojasva sets a good frame as
`thumb.jpg` on the frozen game-night world) and the ready text from 4.1 **within 3 s**, then the optional cue. No
upload, no progress text. Log `demo match: gamenight (sha256)` so you can see why.

Ojasva posts the frozen scene ids (game night, Fortnite, the backup photo world) by Sat 8 PM. Test with any ready
sample id until then.

Everything that does not match (the judge's photo at 2:00) goes through the live path. Media from any chat other than
`demoSpaceId` never cues the headset.

### 4.3 Files

```
bot/
  package.json        "type": "module"; deps: spectrum-ts pinned to 12.11.0 (+ @spectrum-ts/imessage-local 12.11.0 for Plan B)
  .env.example        names only: SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, DV_API, DV_PUBLIC, DV_KEY, DS_URL,
                      ROBLOX_PLACE_ID, DEMO_MODE, BOT_PROVIDER (cloud | local), SPECTRUM_TELEGRAM_BOT_TOKEN
  demo.json           demo tables (4.2)
  src/index.ts        Spectrum loop: route each inbound message, never block the loop
  src/collect.ts      per-chat 2.5 s collector (attachments + caption), "one active job per chat", group rules
  src/demo.ts         sha256, keyword and armed-cue matching
  src/dejaview.ts     createScene(), watchScene() (ws first, polling fallback), thumbnailBytes(), latestReady(), cue()
  src/copy.ts         every string the bot sends
  src/dev.ts          terminal-provider mode for testing without a phone: "/photo ./samples/room.jpg"
  samples/            room.jpg, room.heic, still-couch.mov (under 20 MB)
```

### 4.4 The Déjà View API you call

**Upload (exists).** `POST {DV_API}/api/scenes`, `multipart/form-data`:

| Field | Value |
| --- | --- |
| `mode` | `photo` or `video` |
| `name` | optional, up to 80 chars |
| `files` | one field per file (repeat `files`). Photo: JPEG, PNG, HEIC/HEIF (the server converts HEIC itself). Video: exactly one MOV/MP4 |
| `prompt` | optional text. With no files, Photo mode builds a world from the text alone |

201 Created, a `Scene`:
```json
{ "id": "my-kitchen-p2m4z", "name": "My kitchen", "mode": "photo", "status": "queued", "stage": "Queued",
  "progress": 0, "createdAt": "2026-10-17T22:52:03.100Z", "updatedAt": "2026-10-17T22:52:03.100Z",
  "input": { "files": ["input/00.jpg"] }, "thumb": "thumb.jpg" }
```
Errors are `{ "error": "<human sentence>" }` with 400 (bad input, for example photos and a video together), 413 (over
1 GB), 415 (not multipart), 500. `thumb.jpg` is written before the GPU job starts (for a video, a frame from the first
second).

**Status (exists).** `GET {DV_API}/api/scenes/<id>` every 2 s, or the WebSocket:
- `{ status, stage, progress, error, thumb, caption?, world: { bounds, topdown? } }`. `status` goes `queued` →
  `running` → `ready`, or `failed` with `error`. Brief `uploading` and `downloading` states may appear: treat them as
  `running`. `progress` is 0 to 1 when known. After `ready` the scene also has a `caption` written by Gemini
  (Brianna); you can add it to the ready text.
- WebSocket `ws://{DV_API host}/ws`: `{ "type": "health", ... }` first (ignore), then
  `{ "type": "scene", "scene": <Scene> }` on every change to any scene (filter by `id`), `{ "type": "scene_deleted", "id" }`,
  and other types you ignore. Polling is the guaranteed path; the socket just makes it faster.

**Ready (exists).** Thumbnail bytes: `GET {DV_API}/data/scenes/<id>/<scene.thumb>` (a JPEG; some bundled samples have no
`thumb`). Link to text back: `{DV_PUBLIC}/view?scene=<id>`.

**List (exists).** `GET {DV_API}/api/scenes` → `Scene[]`, newest first. It includes failed scenes; filter
`status === "ready"`.

**Optional `load` cue (Ojasva, ask him if it is live).** `POST {DV_API}/api/host/cue`, JSON
`{ "action": "load", "sceneId": "<id>", "by": "bot" }`, header `x-dejaview-key: <DV_KEY>` (not needed from the same
Mac). Response `{ "ok": true }`. The skit does not depend on it: the game-night world is already loaded on the Quest,
and the headset picks up a finale world on its own when it becomes `ready`. A failed cue is not an error for the chat:
log it and move on.

### 4.5 Snippets that remove the guesswork

Echo bot (tonight's checkpoint). Spectrum reads `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` from the
environment (Bun loads `.env` automatically):

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createHash } from "node:crypto";

const app = await Spectrum({ providers: [imessage.config()] });

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const c = message.content;
  if (c.type === "attachment") {
    const bytes = await c.read(); // each read() downloads again: read once, keep it
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(space.id, message.sender?.id, c.name, c.mimeType, bytes.length, sha);
    await space.send(`got ${c.mimeType}, ${bytes.length} bytes`);
  } else if (c.type === "text") {
    await space.send(`echo: ${c.text}`);
  }
}
```

Inbound attachment content (**Verified**, Spectrum messages docs): `{ type: "attachment", id, name, mimeType,
size?, read(), stream() }`. Expect `image/heic` for iPhone photos and `video/quicktime` for iPhone videos, but route
on the `image/` or `video/` prefix and log what really arrives during the tonight checkpoint. Log `space.id` too:
that is how you tell the demo group from DMs (`demoSpaceId` in 4.2).

**Never `await` a whole job inside the loop.** One 30-second world would freeze every other conversation. Hand each
message to an async function and catch its errors:

```ts
for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  handle(space, message).catch((err) => console.error("[bot]", err));
}
```

Typing indicator around slow work (it is cleared even if your code throws; a no-op on Plan B):

```ts
await space.responding(async () => { await space.send(copy.ack(kind)); });
```

Upload to Déjà View (Bun and Node 20+ have `fetch`, `FormData` and `File` built in):

```ts
const form = new FormData();
form.set("mode", mode);                 // "photo" | "video"
if (name) form.set("name", name);
if (prompt) form.set("prompt", prompt);
for (const f of files) form.append("files", new File([f.bytes], f.name, { type: f.mimeType }));
const res = await fetch(`${process.env.DV_API}/api/scenes`, { method: "POST", body: form });
const body = await res.json();          // 201: Scene. Otherwise { error }
```

Watch it: poll, plus the WebSocket for speed (reconnect on close):

```ts
async function waitReady(id: string): Promise<Scene> {
  for (;;) {                                         // give up after 10 minutes (4.1, step 4)
    const s = await (await fetch(`${DV_API}/api/scenes/${id}`)).json();
    if (s.status === "ready" || s.status === "failed") return s;
    onProgress(s);                                   // sends the one progress text
    await Bun.sleep(2000);
  }
}
const ws = new WebSocket(process.env.DV_API!.replace(/^http/, "ws") + "/ws");
ws.onmessage = (e) => {
  const ev = JSON.parse(String(e.data));
  if (ev.type === "scene") onSceneUpdate(ev.scene); // look up which chat waits for ev.scene.id; ignore other types
};
```

Send the thumbnail with an effect, then the links (**Verified**, Spectrum attachments and message-effects docs):

```ts
import { attachment } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";

const jpg = Buffer.from(await (await fetch(`${DV_API}/data/scenes/${s.id}/${s.thumb}`)).arrayBuffer());
const pic = attachment(jpg, { name: "your-memory.jpg", mimeType: "image/jpeg" });
await space.send(message.platform === "imessage" ? effect(pic, imessage.effect.message.confetti) : pic);
await space.send(copy.ready(s.id));
if (space.id === demo.demoSpaceId) await cue(s.id).catch(() => {});  // optional, demo chat only
```

Effects only apply on cloud iMessage; on Plan B and Telegram send the plain attachment. Spectrum also has
`richlink(url)`, but the preview comes from the page's own metadata, so a plain link plus your thumbnail looks better.

Telegram fallback in the same process:

```ts
import { telegram } from "spectrum-ts/providers/telegram";
const app = await Spectrum({
  providers: [imessage.config(), telegram.config({ botToken: process.env.SPECTRUM_TELEGRAM_BOT_TOKEN! })],
});
// message.platform tells you which one a message came from
```

Testing without a phone: the `terminal` provider (`spectrum-ts/providers/terminal`, no credentials) gives you a chat
UI in your terminal with the same `for await` loop. It downloads a small chat program (`tuichat`) the first time.
Add a dev-only text command `/photo <path>` that reads a local file and runs the exact same pipeline.

### 4.6 Build order and checkpoints

| Step | Do | You should now see |
| --- | --- | --- |
| A1 | `bun init`, `bun add spectrum-ts`, echo bot (4.5) | "ping" from your phone gets "echo: ping"; a photo logs `image/heic`, a byte count and a sha256 |
| A2 | the group test (2.4 step 7), Plan B if needed | the bot sees media in the demo group and its reply shows up there |
| A3 | `dejaview.ts`: `createScene` against Ojasva's LAN server (curl first, 4.7) | `curl` and your function both return 201 with an `id` and `mode: "photo"` |
| A4 | `watchScene` (polling + ws), test with a scene you created by curl | log lines: queued → running 0.4 → ready |
| A5 | collector (2.5 s window, Live Photo rule, caption → name), one job per chat, group rules | 3 photos sent quickly = 1 scene; photo + "Our kitchen" = a scene named "Our kitchen"; chatter in the group gets no reply |
| A6 | full flow with copy, effect and links | your phone: ack < 2 s, one progress text, thumbnail, one links message that opens. **This is the Sat 10 AM milestone** |
| A7 | demo mode (4.2) with a sample scene id | the clip from the table iPhone, and `#dejaview gamenight` alone, both get the pre-built world in under 3 s, no upload in the server log |
| A8 | `cue()`, once Ojasva says the endpoint is live | the desktop viewer opened with `?follow=1` loads the world when the bot replies |
| A9 | errors: a PDF, two videos at once, a photo and a video together, a 25 MB clip on Telegram, the server stopped | every case gets one specific, friendly reply; the bot never crashes |
| A10 | `rooms`, `map`, `help`, text prompt in a DM; Telegram provider on | each command answers in under 1 s; the same flow works from Telegram |

### 4.7 Test alone first

```bash
# Is the server reachable? (Ojasva posts the LAN BASE)
BASE=http://10.x.x.x:8788
curl -s $BASE/api/health

# Create a scene by hand, exactly what your bot will do
curl -s -F mode=photo -F name="Curl test room" -F files=@samples/room.jpg $BASE/api/scenes
curl -s -F mode=video -F name="Curl test clip" -F files=@samples/still-couch.mov $BASE/api/scenes

# Watch it
curl -s $BASE/api/scenes/<id> | jq '{status, stage, progress, error, thumb, caption}'

# Prompt only
curl -s -F mode=photo -F prompt="a cozy cabin at night with a fireplace" $BASE/api/scenes

# Optional cue (once Ojasva says it is live)
curl -s -X POST $BASE/api/host/cue -H 'Content-Type: application/json' -H "x-dejaview-key: $DV_KEY" \
  -d '{"action":"load","sceneId":"test-tw-local","by":"bot"}'
```

No server yet? Write a 30-line fake in Bun (`Bun.serve` on 8788) that answers `POST /api/scenes` with a fake id and
moves it to `ready` after 10 s, with a static `thumb.jpg`. The bot should not know the difference.

---

## 5. Part B: the DeepSpace app (the prize)

### 5.1 What the judges must see

DeepSpace's rule (**Verified**, hacker guide and Devpost): the SDK must be part of the project's working
functionality (a logo or mention alone doesn't count), you must explain which features you used and where to see
them, and there must be a live demo or testable build that does not expose secrets. Your app uses:

| DeepSpace feature | Where it does real work |
| --- | --- |
| **Auth** (Better Auth, Google/GitHub, `useAuth`, `AuthGate`) | sign in to leave notes, favourite, comment, invite; the table laptop is signed in; a note's `author` is the signed-in name |
| **Records + RBAC** (`RecordRoom`, collection schemas, `'*'`/member/admin rules, `uniqueOn`, `ownerField`) | `live`, `notes`, `visits`, `favorites`, `comments`, `invites`, `config` |
| **Realtime sync** (`useQuery` subscriptions) | the live map: one `live` row per room updated 4 times a second, pushed to every open map; a new note appears on every open map at once |
| **Worker routes + RBAC-bypass reads and writes** (Hono routes, the app's action tools) | `/api/ingest` (presence in), `GET /api/notes` and `POST /api/notes`: **DeepSpace is the source of truth for notes**, and the Déjà View server reads them from you |
| **Secrets store** (`deepspace secrets set`) | the shared `DS_KEY`, never in code |
| **Presence room** (`usePresenceRoom`) | "watching now": everyone with the map open shows up as an avatar in the corner |
| **Cron room** (optional) | every minute, clear rooms nobody has pushed for 30 s |
| **Server action** (optional) | "text a memory": registers a judge's phone with Photon and shows a QR (5.11); the Nessie side quest (section 12) |
| **Deploy** (`deepspace deploy` to `*.app.space`) | the public URL on the laptop and in every bot reply |

### 5.2 Pages

| Route | File | Who | What |
| --- | --- | --- | --- |
| `/` | `src/pages/index.tsx` (static, no data hooks) | anyone | landing: "Every memory, shared." + button to `/gallery` |
| `/gallery` | `src/pages/(app)/gallery.tsx` | anyone; sign-in to act | grid of memories from Déjà View; live "building" cards; "3 inside now" badges from `live`; favourites |
| `/m/:id` | `src/pages/(app)/m/[id].tsx` | anyone; sign-in to leave notes | the big live map with notes, people list, "Step inside" (opens `{dvBase}/view?scene=<id>`), who has been here, comments, invite button, QR to this page |
| `/live` | `src/pages/(app)/live.tsx` | the table laptop | full-screen map with notes that **automatically follows the busiest room** (most people, most recent; switch only after 5 s of a clear lead); `?scene=<id>` pins one. No clicking needed during the demo except Brianna's note |
| `/i/:code` | `src/pages/(app)/i/[code].tsx` | the invited friend | "Seb invited you into Game night" + Step inside button |
| `/admin` | `src/pages/(app)/(protected)/admin.tsx` | you (the app owner is always `admin`) | set `dvBase` (the public link) without a redeploy; feed health ("last ingest 0.2 s ago", "last notes read 1.4 s ago"); delete test notes |

Put pages only where the docs say: `src/pages/(app)/...` for pages with data (they work signed out too), and
`src/pages/(app)/(protected)/...` for pages that need sign-in. A new `(protected)` folder anywhere else is **not**
gated and has no data provider. Dynamic segments use `[id].tsx`.

### 5.3 Collections (`src/schemas/*.ts`, added to `src/schemas.ts`)

| Collection | Columns | Permissions | Written by |
| --- | --- | --- | --- |
| `live` | `sceneId` (text, required), `t` (number), `people` (json: `Person[]`) | everyone read; nobody writes from the browser | worker `/api/ingest` |
| `notes` | `sceneId` (text, required), `author` (text, ≤ 40), `text` (text, ≤ 120), `x`, `y`, `z` (number, metres), `createdAt` (text, ISO UTC), `userId` (`userBound`, browser notes only) | everyone read; member create; delete own; admin delete | signed-in users clicking the map; the worker for headset notes |
| `visits` | `sceneId`, `personId`, `name`, `kind`, `firstSeenAt` (number, unix s) | everyone read; no browser writes | worker, first time a person appears in a room |
| `favorites` | `sceneId`, `userId` (`userBound`, `immutable`) | read all; member create; delete own. `uniqueOn: ['sceneId','userId']`, `ownerField: 'userId'` | signed-in users |
| `comments` | `sceneId`, `text` (≤ 280), `authorName` | everyone read; member create; delete own | signed-in users |
| `invites` | `sceneId`, `code` (8 random chars), `inviteeName` | everyone read (codes are unguessable); member create; delete own | signed-in users |
| `config` | `key`, `value` | everyone read; admin create/update | you, on `/admin` |

A note's `id` is its record id. One full example so the syntax is right (json columns take the array directly; never
`JSON.stringify`):

```ts
// src/schemas/live-schema.ts
import type { CollectionSchema } from 'deepspace/schema'

const browserReadOnly = { read: true, create: false, update: false, delete: false }

export const liveSchema: CollectionSchema = {
  name: 'live',
  columns: [
    { name: 'sceneId', storage: 'text', interpretation: 'plain', required: true },
    { name: 't', storage: 'number', interpretation: 'plain' },
    { name: 'people', storage: 'text', interpretation: { kind: 'json' } },
  ],
  uniqueOn: ['sceneId'],
  permissions: { '*': browserReadOnly, viewer: browserReadOnly, member: browserReadOnly, admin: browserReadOnly },
}
```

Schemas are baked in at build time: every schema change needs a redeploy (new columns migrate automatically).
Do not store phone numbers or emails in any collection. How a `userBound` column is filled is not spelled out in the
docs: pass `useAuth().userId` when you create the record and check it in local dev.

### 5.4 Worker routes: the contract with Ojasva's server

All three routes check the same header, `X-DejaView-Key: <DS_KEY>`, and refuse everything if the secret is unset.
Local dev: `http://localhost:5173/api/...`. Errors are `400 { "error": "<what is wrong>" }` and
`401 { "error": "unauthorized" }`.

**1. Presence in: `POST <DS_URL>/api/ingest`**

```json
{
  "sceneId": "game-night-k3x9a",
  "t": 1760710000.25,
  "people": [
    { "id": "quest-1",      "name": "Judge",   "kind": "vr",     "x": 0.4,  "y": 0, "z": -1.2, "yaw": 0.3 },
    { "id": "rbx-12345",    "name": "shivin",  "kind": "roblox", "x": 2.1,  "y": 0, "z": 0.3,  "yaw": 1.2 },
    { "id": "web-7f2a91c0", "name": "Maya",    "kind": "web",    "x": -1.0, "y": 0, "z": 0.8,  "yaw": 3.1 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `sceneId` | Déjà View scene id, `^[a-z0-9][a-z0-9-]{0,95}$` |
| `t` | server time in seconds (Unix, float) when the snapshot was taken |
| `people` | **everyone** in that scene right now (a full snapshot, not a diff), at most 32. Empty array = room is empty |
| `id` | stable per person (`quest-1`, `rbx-<robloxUserId>`, `web-<8 hex>`) |
| `kind` | `vr` (headset), `roblox`, `web` (a browser viewer) |
| `x, y, z` | **metres in the room frame** (`contracts.md` 3.1): Y up, floor at y = 0, a camera at the origin looks down −Z. These are the person's **feet**, so `y` is about 0. The map uses x and z |
| `yaw` | radians, rotation about +Y like three.js `rotation.y`: **0 faces −Z, positive turns left** (counter-clockwise seen from above). Facing direction = (−sin yaw, −cos yaw) in (x, z) |

Ignore any extra fields you don't know (future-proofing). Responses: `200 { "ok": true, "people": 3 }`; `400`
(validate everything: `people` at most 32, finite numbers, known `kind`, names ≤ 40 chars); `401`; `413` body over
32 KB; `500 { "error": "..." }`.

What Ojasva's server promises (`contracts.md` 7.1): about 4 pushes a second **only for scenes with people in them**, at
least once a second while anyone is there even if nobody moved; exactly one push with `"people": []` when the last
person leaves; fire-and-forget with a 2 s timeout, skipping (never queueing) while the previous push is in flight.

**2. Notes out: `GET <DS_URL>/api/notes?sceneId=<id>`**

`200`, oldest first:

```json
{ "notes": [
  { "id": "n_8f2k1q", "sceneId": "game-night-k3x9a", "author": "Brianna",
    "text": "Seb's seat. He was too scared to show up.",
    "x": 1.20, "y": 1.4, "z": -0.80, "createdAt": "2026-10-17T22:41:07Z" } ] }
```

Ojasva's server calls this **every 2 s** for every scene with someone in it (and at once when a scene gets its first
person), keeps the last good list, serves it to the headset, and pops up every id it has not seen before. Return only
these 8 fields per note (never `userId`). Keep it fast: it is the one route that is called constantly.

**3. Notes in (made in the headset): `POST <DS_URL>/api/notes`**

Body `{ "sceneId": "game-night-k3x9a", "author": "Judge", "text": "Best seat in the house", "x": 0.6, "y": 1.4, "z": -1.1 }`.
You make `id` and `createdAt`. Response `201 { "ok": true, "note": <note> }`. Validate: `sceneId` matches the id
pattern, `text` 1 to 120 characters, `author` 1 to 40, `x`, `y`, `z` finite (`y` missing → 1.4). This path is a P2 on
Ojasva's side, so it may only be used in rehearsal; build it anyway, it is 15 lines.

The handlers, so you do not have to dig. The template's `src/server/action-routes.ts` builds the "tools" that server
actions use to read and write records with RBAC off (`createActionTools`). It is a local function: add `export` to it
and reuse it. **Verified** (server-actions reference and the `create-deepspace@0.42.3` template): `tools.create(collection,
data, recordId?)` (a fixed `recordId` makes it an **upsert** that merges into the existing row), `tools.get(collection,
recordId)`, `tools.query(collection, { where, orderBy, orderDir, limit })` → `data: { records, count }`, `tools.update`,
`tools.remove`. Every call returns `{ success, data }` or an error: check `success` first. `query` with no `where`
returns the whole collection, so always scope it.

```ts
// src/server/dejaview-routes.ts
import type { Hono } from 'hono'
import type { AppContext } from '../../worker.js'
import { createActionTools } from './action-routes.js' // add `export` to that function

const ID = /^[a-z0-9][a-z0-9-]{0,95}$/
const seen = new Map<string, Set<string>>() // per-isolate cache: sceneId -> person ids already logged as visits

export function registerDejaViewRoutes(app: Hono<AppContext>): void {
  app.use('/api/ingest', keyCheck)
  app.use('/api/notes', keyCheck)

  app.post('/api/ingest', async (c) => {
    const body = await c.req.json().catch(() => null)
    // ...validate body (table above); on failure return c.json({ error: '...' }, 400)
    const tools = createActionTools(c.env, c.env.OWNER_USER_ID, '')
    const r = await tools.create('live', { sceneId: body.sceneId, t: body.t, people: body.people }, `live-${body.sceneId}`)
    if (!r.success) return c.json({ error: r.error }, 500)
    // for each person not yet in seen[sceneId]: tools.create('visits', {...}, `v-${sceneId}-${person.id}`) (idempotent)
    return c.json({ ok: true, people: body.people.length })
  })

  app.get('/api/notes', async (c) => {
    const sceneId = c.req.query('sceneId') ?? ''
    if (!ID.test(sceneId)) return c.json({ error: 'sceneId is missing or invalid' }, 400)
    const tools = createActionTools(c.env, c.env.OWNER_USER_ID, '')
    const r = await tools.query('notes', { where: { sceneId }, orderBy: 'createdAt', orderDir: 'asc', limit: 200 })
    if (!r.success) return c.json({ error: r.error }, 500)
    // log one record in local dev to confirm the field names; the record id is the note id
    const notes = r.data.records.map((rec: any) => ({ id: rec.recordId, sceneId: rec.data.sceneId,
      author: rec.data.author, text: rec.data.text, x: rec.data.x, y: rec.data.y, z: rec.data.z,
      createdAt: rec.data.createdAt }))
    return c.json({ notes })
  })

  app.post('/api/notes', async (c) => {
    const b = await c.req.json().catch(() => null)
    // ...validate (above); on failure return c.json({ error: '...' }, 400)
    const tools = createActionTools(c.env, c.env.OWNER_USER_ID, '')
    const id = 'n_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    const note = { sceneId: b.sceneId, author: b.author, text: b.text, x: b.x, y: b.y ?? 1.4, z: b.z,
                   createdAt: new Date().toISOString() }
    const r = await tools.create('notes', note, id)
    if (!r.success) return c.json({ error: r.error }, 500)
    return c.json({ ok: true, note: { id, ...note } }, 201)
  })
}

async function keyCheck(c: any, next: () => Promise<void>) {
  const key = c.env.DS_KEY // if the secret is missing, refuse everything (undefined === undefined!)
  if (!key || c.req.header('X-DejaView-Key') !== key) return c.json({ error: 'unauthorized' }, 401)
  await next()
}
```

The second argument to `createActionTools` is the identity the write is recorded as. Log `c.env.OWNER_USER_ID` once in
local dev; if it is empty there, pass a fixed string such as `'dejaview-server'`.

Wire it up: in `worker.ts` add `DS_KEY: string` to `interface Env`, and call `registerDejaViewRoutes(app)` right after
`registerActionRoutes(app, resolveAuth)` (before the platform proxy and static routes; order matters). Set the key with
`npx deepspace secrets set DS_KEY=$(openssl rand -hex 24)`, restart dev, redeploy for production (deployed apps only
see secret changes after a deploy). Read it back with `npx deepspace secrets get DS_KEY --plain` to hand to Ojasva in
person.

Whether 4 pushes a second plus a notes read every 2 s cost DeepSpace credits or hit a platform rate limit is not
documented. Watch the credit balance on the dashboard after the first hour of real traffic on Saturday and tell Ojasva
if it drops fast: he can push at 2 Hz and read notes every 4 s instead.

### 5.5 The live map: smooth, not janky

Data: `useQuery('live', { where: { sceneId } })` gives you one row that changes about 4 times a second. **Do not render
the map with React state.** Push each row into a buffer kept in a `ref`, and draw on a `<canvas>` in a
`requestAnimationFrame` loop. React only re-renders the side panel.

Snapshot interpolation: draw everyone 300 ms in the past, between the two snapshots around that moment. Motion is then
continuous and evenly paced even though data arrives in steps:

```ts
type Sample = { t: number; x: number; z: number; yaw: number }
const buf = new Map<string, Sample[]>() // person id -> last ~10 samples
let offset: number | null = null         // local clock minus server clock, in seconds

export function onLiveRow(row: { t: number; people: Person[] }) {
  const local = performance.now() / 1000
  if (offset === null || Math.abs(local - row.t - offset) > 1) offset = local - row.t // resync on big drift
  for (const p of row.people) {
    const b = buf.get(p.id) ?? []
    if (!b.length || row.t > b[b.length - 1].t) b.push({ t: row.t, x: p.x, z: p.z, yaw: p.yaw })
    if (b.length > 10) b.shift()
    buf.set(p.id, b)
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a)) // shortest way round for yaw

export function poseAt(b: Sample[], renderT: number): Sample { // b holds at least one sample
  if (renderT <= b[0].t) return b[0]
  for (let i = 1; i < b.length; i++) {
    if (b[i].t >= renderT) {
      const a = b[i - 1], c = b[i], k = (renderT - a.t) / (c.t - a.t)
      return { t: renderT, x: a.x + (c.x - a.x) * k, z: a.z + (c.z - a.z) * k, yaw: a.yaw + wrap(c.yaw - a.yaw) * k }
    }
  }
  return b[b.length - 1] // no newer sample yet: hold the last pose (do not extrapolate more than 0.25 s)
}
// every frame: const renderT = performance.now() / 1000 - offset! - 0.3
```

Drawing rules:
- **Projection:** fit the room's x/z extent into the canvas with 24 px padding, same scale on both axes. Screen x =
  world x, screen y (downwards) = world z, so "forward" (−Z) points up. Use `devicePixelRatio` for a crisp canvas. Keep
  the inverse function too: clicks become world (x, z) for notes.
- **Floor plan:** `GET {dvBase}/api/scenes/<id>` → `world.topdown = { file, min: [x, z], max: [x, z] }`. Draw
  `{dvBase}/data/scenes/<id>/<file>` stretched exactly from `min` to `max` (image right = +X, image down = +Z), at
  about 70% opacity under the grid. This is what lets Brianna find the couch. Ojasva ships it for the three demo worlds
  by Sat 4 PM. No `topdown`: use `world.bounds` x/z; no bounds either (the bundled samples): start with −4 to 4 m and
  grow smoothly to fit everyone seen, plus 1 m of margin.
- **Grid:** dark grid every 0.5 m, a slightly brighter line every 1 m, the extent as a soft rounded rectangle, a
  vignette at the edges. The scene thumbnail is a perspective photo, not a floor plan: show it as a card in the corner.
- **People:** VR = lime `#C6FF3D` dot with a slow pulsing ring and a translucent **view cone** (60°, 1.2 m) in the
  facing direction, so the room can see where the judge is looking. Roblox = white dot with a tiny block glyph. Web =
  grey outline dot. Name label above each in bold caps.
- **Trails** ("where everyone walked"): a fading line of each person's last 15 s, lime for VR, white for Roblox.
- **Join and leave:** fade and scale in over 300 ms; when someone disappears from `people`, fade out over 600 ms. No
  pops, no teleports.
- **Stale feed:** if the newest `t` is more than 5 s old, dim the map and show "No one here right now".
- **Watching now:** `usePresenceRoom('map:' + sceneId)` and show the people who have the map open as small avatars
  in a corner.

### 5.6 Notes: click the map, it appears in the headset

The 1:40 beat. Brianna, signed in on her laptop, clicks the couch on `/live` or `/m/:id` and types "Seb's seat. He was
too scared to show up." It appears on every open map at once and, within about 2.5 s, as a floating sticky note in
the headset at that spot. Notes stay, so the next visitor finds them.

1. **Click** (signed in only; signed out shows "Sign in to leave a note"): open a small composer at the click point: one
   input, a 120-character counter, Enter sends, Esc cancels. Convert the click to world `(x, z)` with the inverse
   projection.
2. **Save in DeepSpace** (that is all; the page never calls Déjà View): create a `notes` record with the SDK's record
   mutations (`useMutations`): `{ sceneId, author: <signed-in display name, ≤ 40>, text, x, y: 1.4, z,
   createdAt: new Date().toISOString(), userId }`. `y = 1.4` m puts the note at about chest height above the clicked
   spot.
3. **Draw notes** from `useQuery('notes', { where: { sceneId } })`: a small lime square "sticky" with the first 24
   characters and the author, popping in with a 200 ms scale. Hover or tap shows the full text. Notes whose author is
   "Judge" (made in the headset) get a small headset glyph.
4. **Headset delivery** is Ojasva's server reading your `GET /api/notes` every 2 s. Show a quiet "in the headset" tick
   on a note once 3 s have passed since it was created while the notes feed is healthy (`/admin` shows "last notes
   read"); that is cosmetic only.

### 5.7 The gallery reads Déjà View directly

- Fetch `{dvBase}/api/scenes` straight from the browser (the server sends `Access-Control-Allow-Origin: *`;
  **Verified** on the running server). Show `ready` scenes and the ones still building; hide `failed`.
- Thumbnail: a plain `<img>` with `src` = `{dvBase}/data/scenes/<id>/<thumb>` (images need no CORS). No `thumb`: a
  dark gradient card with the name. Show `caption` (written by Gemini) under the name.
- Live updates: open `new WebSocket(dvBase.replace(/^http/, 'ws') + '/ws')` and apply every
  `{ type: 'scene', scene }` event (insert, update in place) and `{ type: 'scene_deleted', id }`; ignore other types.
  That is what makes a new card appear the second the judge sends the photo at 2:00. If the socket drops (or the
  tunnel does not pass WebSockets: test `wss://` at B4), reconnect with backoff and poll the list every 2 s meanwhile.
- Badges per card: mode (**Photo** or **Video**, from `mode`; treat anything that is not `video` as Photo), status with a
  lime progress bar while building, "3 inside now" from `live`, favourites count, notes count, "Judge, shivin and 2
  others have been here" from `visits`.
- `dvBase` comes from the `config` collection (key `dvBase`), with a hard-coded default. The tunnel URL can change on
  restart; you fix it on `/admin` in 10 seconds, without a redeploy.

### 5.8 Invites

On `/m/:id`, signed-in users click "Invite a friend", type a name, and get a link `https://<app>.app.space/i/<code>`
(plus a QR). The invite page shows the room and a big "Step inside" button that opens
`{dvBase}/view?scene=<id>&name=<inviteeName>`. When the viewer supports `?name=` (Ojasva, optional), the friend shows
up on the map as a grey "web" dot with their name: the invite visibly works on screen.

### 5.9 Build order and checkpoints

| Step | Do | You should now see |
| --- | --- | --- |
| B1 | `npm create deepspace@latest dejaview-live`, `cd dejaview-live`, `npx deepspace dev start` | the starter at `http://localhost:5173`; sign-in with Google works |
| B2 | first deploy right away: `git add -A && git commit -m init && npx deepspace deploy` | `https://dejaview-live.app.space` is live (deploys refuse uncommitted changes) |
| B3 | theme (5.12), landing page, `/gallery` from mock JSON (copy the shape in 4.4) | dark grid of cards with lime accents |
| B4 | gallery from Ojasva's LAN server in local dev, then `/ws` live updates; once the public link exists (Sat 4 PM), the same from the deployed app | a scene created by curl pops in as "Building", then flips to "Ready" with its thumbnail; note whether `wss://` works through the tunnel |
| B5 | schemas + `/api/ingest` + `/api/notes` (GET and POST) + `DS_KEY`; curl them (5.13); deploy | 200 / 201 with the right shapes; 401 with a wrong key. **Hand Ojasva the URL and the key the moment this works** (aim for Sat 2 PM) |
| B6 | fake feed script (5.13) + canvas map with interpolation and trails on `/m/:id` | three dots gliding at 60 fps, no stutter, with names, cone and trails |
| B7 | notes (5.6): click, composer, record, sticky | click, type, Enter: the sticky appears on two open maps at once; your `GET /api/notes` returns it |
| B8 | top-down floor plan, `/live` auto-follow, stale state, join/leave fades, watching-now avatars | start and stop fake people: they fade in and out; the screen follows the busiest room; the couch is easy to find |
| B9 | with Ojasva: his real pushes and notes reads against the deployed app | dots move from the desktop viewer; a note typed on the map pops up in the headset within 2.5 s. **Sat 4 PM milestone** |
| B10 | favourites, comments, visits, invites, `/admin` config | all work signed in; signed-out visitors can see but not write |
| B11 | stretch: cron cleanup, "text a memory" QR (5.11) | only after B1 to B10 are rock solid |

### 5.10 Getting a judge's own phone in (the finale)

The default at 2:00 is the table iPhone (registered tonight). If a judge wants to text **their own** photo, their
number must be registered first (fact 2): before the demo, ask for it and add it in the Photon dashboard (Project →
Users → add, 20 s), then tell them which line number to text. With Plan B (local Messages), no registration is needed.

### 5.11 Stretch: "text a memory" QR (Photon + DeepSpace together)

Makes 5.10 self-serve in 20 seconds (cloud line only). On the laptop, a small form (signed in as you): judge's name
and phone. A **server action** `joinTextLine` calls Photon's management API (**Verified**, Spectrum API OpenAPI at
`https://spectrum.photon.codes/openapi/json`):

```
POST https://spectrum.photon.codes/projects/<PHOTON_PROJECT_ID>/users/
Authorization: Basic base64(<projectId>:<projectSecret>)
Content-Type: application/json

{ "type": "shared", "phoneNumber": "+13525550123", "firstName": "Judge" }
```

→ `{ "succeed": true, "data": { "id": "<uuid>", "assignedPhoneNumber": "+1...", ... } }`. Show a QR for
`https://spectrum.photon.codes/users/<id>/redirect?msg=Hi%20Deja%20View`. That link redirects to an `sms:` deep link
that opens Messages to their assigned line with the text pre-filled; they hit send, then attach a photo. Store the
Photon ID and secret with `deepspace secrets set`, never return the phone number, never save it in a collection,
and delete test users afterwards (the free plan holds about 10).

### 5.12 Look

**Replaced by item 5 of the update at the top (Apple style).** The old version, for reference: match the Déjà View site: background `#0b0b0d`, surfaces `#151519`, text `#f3f1ea`, muted `#a3a097`, accent **acid
lime `#C6FF3D`** (the team standard; lime is the only accent), danger `#ff6b5b`. Type: **Bricolage Grotesque** (700 to
800 for headings, tight tracking) and **JetBrains Mono** for numbers and labels, both from Google Fonts. Big bold
headings, generous spacing, 12 to 16 px radii, no gradients except the soft vignette on the map. Set `data-theme` in
`index.html` to a dark preset and override its CSS variables in `src/themes.css`. The table laptop shows `/live` full
screen: the room name huge in the top-left, a pulsing "LIVE" chip, a people count, and nothing else.

### 5.13 Test alone first

```bash
D=http://localhost:5173        # or https://dejaview-live.app.space
# One presence push (replace KEY)
curl -s -X POST $D/api/ingest \
  -H 'Content-Type: application/json' -H "X-DejaView-Key: $KEY" \
  -d '{"sceneId":"test-tw-local","t":'"$(date +%s)"',"people":[{"id":"quest-1","name":"Judge","kind":"vr","x":0.4,"y":0,"z":-1.2,"yaw":0.3}]}'

# Wrong key must be 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $D/api/ingest -H 'X-DejaView-Key: nope' -d '{}'

# A note made "in the headset", then read back exactly as Ojasva's server will
curl -s -X POST $D/api/notes -H 'Content-Type: application/json' -H "X-DejaView-Key: $KEY" \
  -d '{"sceneId":"test-tw-local","author":"Judge","text":"curl note","x":0.5,"y":1.4,"z":-1}'
curl -s "$D/api/notes?sceneId=test-tw-local" -H "X-DejaView-Key: $KEY" | jq '.notes[-1]'
```

Write `scripts/fake-feed.ts` (Bun, about 30 lines): every 250 ms, POST a snapshot for one scene with a VR person
walking a slow circle (radius 1.5 m, turning to face where they walk: `yaw = atan2(-vx, -vz)`), two Roblox people
running faster figure-eights, and a web person who joins after 20 s and leaves after 40 s. Add ±60 ms of random delay
to every send to imitate real network jitter, and once a minute pause for 3 s to test the stale state. Point it at
local or deployed with an env var. This feed is your rehearsal tool, and a demo fallback only if you say on stage that
it is a replay.

---

## 6. What Ojasva provides, and when

| What | Exact shape | By |
| --- | --- | --- |
| LAN `BASE` of the Déjà View server | `http://10.x.x.x:8788` (same Wi-Fi or one hotspot); `mode=photo` / `mode=video` accepted | Fri night |
| `DV_KEY` (only for the optional cue from another Mac, by DM) | random string | Fri night |
| Every endpoint answering on the LAN, including the presence push and the notes relay against your local app or a mock | `contracts.md` 7 | **Sat 10 AM** |
| Public https link | a Cloudflare tunnel URL serving `/api/*`, `/data/*`, `/view`, `/ws` (wss). Not ngrok's free tier: 20,000 requests a month is far too few | **Sat 4 PM** |
| Presence push + notes reads pointed at your deployed app | 5.4, with your `DS_KEY` | Sat 4 PM (first test as soon as you hand over the URL and key) |
| `world.topdown` + `world.bounds` on the demo worlds | `contracts.md` 4.2, metres | Sat 4 PM |
| The frozen demo scene ids (game night, Fortnite, the backup photo world) | strings, for `demo.json` | Sat 8 PM; a sample id to test with right away |
| Optional: `POST /api/host/cue` | 4.4 | he tells you |
| Optional: viewer `?name=` | the browser viewer reports itself as `kind: "web"` with that name | Sat 10 PM, or skip |
| SSH public key for the Vultr box | one line, `ssh-ed25519 AAAA... ojasva` | when he is ready to set the GPU up |

From Shivin: `ROBLOX_PLACE_ID` (the join link format is in 4.1), by Sat 12 PM.

What you give Ojasva:

| What | By |
| --- | --- |
| "Vultr OK" (or the exact error); which Photon plan won the group test (cloud group, Plan B, Plan C); the DeepSpace app name | tonight |
| The bot replying with a world link on the LAN; demo mode table working | Sat 10 AM |
| The deployed DeepSpace URL and `DS_KEY` (in person or DM, never in code or a group chat); `/api/ingest` and `/api/notes` live | as soon as the first deploy works (aim Sat 2 PM); due Sat 4 PM |
| `npx deepspace app collaborators add <Ojasva's email>` so he can redeploy in an emergency (this also gives him the secrets) | Sat 4 PM |
| The bot folder (no `.env`) with `demo.json` and a one-line start command, running on the demo Mac (or the Plan B Mac); the Photon ID/secret typed in person | Sat 8 PM |
| Capital One: ready and good, or dropped | Sat 10 PM |

---

## 7. The real Vultr box (when Ojasva asks)

1. Ojasva sends his SSH **public** key. Vultr: Account → SSH Keys → Add SSH Key → paste → save.
2. Deploy the same plan as tonight (A40 48 GB, New Jersey or Los Angeles, Ubuntu 24.04), tick his SSH key, hostname
   `dejaview-gpu`. Send him the IPv4 address from the server page.
3. He installs the pipeline and keeps it warm for the finale. Two facts for him: the A40 is compute capability **8.6**
   (build CUDA extensions with 8.6 in the arch list), and 48 GB is below the world model's 51 GB no-offload footprint,
   so it runs with T5 offload (about 30 GB).
4. **Destroy it** after the demo on Sunday, or any time it will sit idle for more than a few hours. Stopped still bills.

---

## 8. Quality bar

| Thing | Target |
| --- | --- |
| Demo clip → reply in the chat | under 3 s (demo mode) |
| Bot first reply to a new photo | under 2 s after the photo arrives |
| World ready (warm GPU) | about 10 to 30 s; the bot keeps the person company with one progress text |
| Ready → thumbnail on the phone | under 2 s |
| New memory → card on the laptop | under 1 s (from `/ws`), under 3 s with polling |
| Presence → dot moving on the laptop | under 500 ms end to end, 60 fps, no teleports, no flicker |
| Note sent → on every map | under 0.5 s; in the headset within about 2.5 s |
| `GET /api/notes` | under 300 ms (it is called every 2 s) |
| App load | under 2 s on the laptop; skeleton cards, never a blank page or a spinner forever |
| Errors | always a sentence a judge understands, never a stack trace |

One product: the bot's copy, the gallery and the map must feel like the Déjà View site: dark, bold, one lime accent,
the same fonts. Name everything "Déjà View" (the bot calls itself that in `help`), and the modes "Photo" and "Video".

---

## 9. When something breaks on the night

| Breaks | Do this |
| --- | --- |
| Group delivery on the night | send the clip in the 1:1 thread with the bot (Plan C); the host says "the chat" |
| Photon iMessage (no delivery, no attachments) | Telegram through the same bot (2.5). Last resort: Ojasva opens the world from his `/host` page |
| Demo clip not recognised | send `#dejaview gamenight`; or `!arm gamenight` from your phone and send again; or Ojasva loads the memory from `/host` |
| A judge's own phone | they take the photo with the table iPhone (5.10) |
| Déjà View server unreachable from the bot | the bot says so politely; Ojasva opens a pre-generated world |
| GPU slow | bot copy covers it ("Big room."); the host drops the judge into the Fortnite world meanwhile |
| Note does not reach the headset | it still shows on the map; check `/admin` "last notes read"; Ojasva checks his server log |
| Ingest pushes stop | the map dims to "No one here right now" (it never freezes on old dots); run `fake-feed.ts` only if you clearly say on stage it is a replay |
| Deployed app broken | `npx deepspace dev start` on the table laptop (sign-in still works); point it at the public link |
| Venue Wi-Fi | phone hotspot for the laptop and Ojasva's Mac |
| Everything | the recorded 10 s clips (milestones) |

---

## 10. Milestones

| When | Done means |
| --- | --- |
| **Tonight** | Vultr: A40 deploy proven and destroyed (or the exact blocker sent to Ojasva). DeepSpace account with referral credits, `auth login` works, app name chosen. Photon: project made, your phone, the table iPhone and teammates' phones registered, echo bot gets photo bytes, **group test done and the winning plan reported**. Telegram token saved |
| **Sat 10 AM** | Text a photo → working world link on the LAN (A1 to A6). Demo mode answers the clip and `#dejaview gamenight` with a sample scene id. DeepSpace starter deployed once (B1, B2) |
| **Sat 12 PM** | Domain live: `https://<your domain>/api/health` answers from a phone on cellular; tunnel token sent to Ojasva privately. "Add a memory" uploads a photo and the card builds live in your gallery |
| Sat 2 PM (aim) | DeepSpace `/api/ingest` and `/api/notes` deployed; URL and `DS_KEY` handed to Ojasva. You prop the phone for the game-night filming |
| **Sat 4 PM** | DeepSpace: sign-in, gallery with live building cards, live map with trails, notes working end to end into the headset (B3 to B9) on the deployed app. Ojasva's real pushes accepted |
| Sat 8 PM | "Add a memory" demo table (`demo.json`) holds the frozen scene ids |
| **Sat 10 PM** | Full skit + finale run twice with a timer: the clip at 0:00 answered by demo mode, real headset + Roblox dots on `/live`, Brianna's note in the headset, the judge's photo at 2:00 built live and in the gallery at 2:25. Capital One decided |
| **Sun 4 AM** | Feature freeze. Record 10 s clips: the clip in the chat and the reply; the gallery card going from building to ready; the live map with three dots and a note appearing |
| **Sun 8 AM** | Submitted (Ojasva). You make sure the DeepSpace features list (5.1) and the live URL are in the Devpost write-up |

---

## 11. Rules and hand-off

- **Write all your own code during the event** (it started Fri 8 PM). Open-source libraries and SDKs are fine and
  must be credited. If you use AI coding tools (the DeepSpace scaffold even ships agent instruction files), list them
  on Devpost; the rules require it.
- **Keys never in code, commits, screenshots or group chats.** Bot: `.env` (gitignored) plus a `.env.example` with names
  only. DeepSpace: `npx deepspace secrets set`. Hand keys over in person.
- Hand-off to Ojasva: `bot/` (no `.env`, with `README.md`: requirements, `bun install`, `bun run src/index.ts`, the env
  names) and the DeepSpace project folder (no `.dev.vars`). He puts them in the repo under `integrations/bot/` and
  `integrations/deepspace/`.
- For the DeepSpace judges (put this in the Devpost text): the live URL, "sign in with Google to leave a note,
  favourite and invite", and the feature table from 5.1 with where to see each one.

---

## 12. Side quest: Capital One Nessie (optional, your design)

`plan.md`: Nessie is **your** side quest, not a link in the chain. You decide what to build. Nothing else may depend
on it and the demo works without it. Start only after the Sat 4 PM milestone is done; if it is ready and good by the
Sat 10 PM run, it gets 15 seconds at 2:45, otherwise drop it. Cap it at 3 hours.

**Prize (Verified, Devpost):** "Capital One - The Best Use of Nessie!", $1,000 cash, 1 winner. They want projects that
"creatively integrate Nessie's endpoints to empower users and improve their financial lives".

### 12.1 Quickstart (Verified live on Oct 16)

1. The site moved to **https://nessieisreal.com**. Sign-in is **GitHub only**; your API key is on the **Profile** page.
2. Smoke test (prints `[]` for a fresh key): `curl -s "https://api.nessieisreal.com/customers?key=$NESSIE_API_KEY"`.
3. **Use `https://`.** `http://api.nessieisreal.com` refuses connections (port 80 is closed), and most old tutorials
   use `http://`. `https://api.nessieisreal.com` and `https://prod-api.nessieisreal.com` answer in about 0.13 s.
4. The key goes in the query string (`?key=...`); there is no auth header. Never log the URL. Call Nessie only from a
   server (a DeepSpace server action or the bot), with the key in `deepspace secrets` or the bot's `.env`, never in a
   browser.
5. Endpoints: `POST/GET /customers`; `POST/GET /customers/{id}/accounts` (type `Checking`, `Savings` or `Credit Card`,
   `nickname`, `rewards`, `balance` as integers); `POST/GET /merchants` (`name`, `category`, `address`, `geocode`);
   `POST/GET /accounts/{id}/deposits` (`medium: "balance"`, `transaction_date`, `status`, integer `amount`,
   `description`); `POST/GET /accounts/{id}/bills` (`status: "recurring"`, `payee`, `payment_amount`,
   `recurring_date`); `POST/GET /accounts/{id}/purchases` (`merchant_id`, `medium`, integer `amount`). Spec:
   https://nessieisreal.com/nessie-openapi-spec.yaml.
6. Gotchas: the purchases endpoints work but are **missing from the spec** (get-one is singular: `GET /purchase/{id}`).
   POST answers are short strings like `"Customer created"`, possibly without the new `_id`, so **list again and find
   your object by name**. `403 {"message":"Missing Authentication Token"}` means a wrong path, `401 Invalid API key.`
   means a bad key. Rate limits are not documented: wait 100 ms between seeding calls.
7. Seed once with a script that reuses objects found by name (so it can run twice), and save everything it reads back
   to `nessie-snapshot.json` as the offline fallback. Cache live reads for 60 s.
8. Money math in code, never by a model.

### 12.2 Ideas (pick one, or do your own)

1. **Split the game-night snack run.** Seed a purchase "Game night snack run" (for example 38) at a grocery merchant.
   On the memory's page (`/m/:id`) or with a `split` command in the group chat, the bot splits it among everyone who was
   in the memory: the `visits` rows for that scene (or the live head count from `live`). `perPerson = ceil(total /
   people)`. The joke writes itself: "4 people were there: 10 each. Seb: 0, and he missed everything." The head count
   is real, so it changes as Roblox friends join.
2. **Spending becomes places.** Nessie merchants carry a `geocode`. Group a month of seeded purchases by merchant into
   place cards ("Midtown Coffee: 23 visits, 95"), and a "make it a memory" button that starts a Photo world for that
   place: `POST /api/scenes` with `mode=photo` and a prompt ("a cozy coffee shop at night"). Money turns into places you
   can walk into.
3. **Next game night fund.** Everyone who was at game night chips in toward a shared savings account (Nessie deposits);
   a lime progress bar on the memory page shows "Next game night: 43 of 60". Each deposit is a real Nessie call.

Whatever you pick: one screen, one clear number, readable in 15 seconds from across the table.
