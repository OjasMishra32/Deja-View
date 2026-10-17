# Shivin: Déjà View in Roblox

Read `START-HERE.md` first (the short spec), then `plan.md` (the story), then this page (the build details).
`contracts.md` has the wiring for the whole team. If this page ever disagrees with `START-HERE.md` or `contracts.md`,
they win: say so in the team chat.

> **Update (Sat early morning):** the Photon group-chat bot is dropped (not a Devpost prize, and it did not work).
> Memories now come in through Seb's DeepSpace app ("Add a memory"). Wherever this page says "the bot" or "the group
> chat", read "Seb's app". Nothing else changes for you.

> **Update 13 (Sat ~9:15 AM): URGENT, your Roblox account is moderated.** Since about 9 AM every Open Cloud upload
> with your key answers `User is moderated` (chess room sky faces, the Tilted Towers room). Server-side uploads are now
> OFF (the live server no longer sends anything to Roblox). What to do now:
> 1. Open roblox.com and Creator Hub on your account and read the moderation notice: what was flagged (asset id or
>    name), the reason and how long it lasts. Tell Ojasva exactly what it says. Appeal it there if it is a mistake.
> 2. Our uploads so far: the-courts v2 room 91874647541773 plus 6 sky faces, brick-apartment room 96179943812932,
>    chess-room v1 room 122387814565130 and v2 room 70649141763810, plus earlier test rooms. The likeliest trigger is
>    Fortnite-derived content (the old fortnite-* rooms, the Brick House apartment, Tilted Towers): Epic's IP.
> 3. Until it is cleared, do not upload anything from your account (Studio or Open Cloud). Rooms already uploaded may
>    or may not keep loading; if LoadAssetAsync fails, the game falls back to the block map (that path still works).
> 4. Proposal (Ojasva decides): keep Fortnite-derived worlds (tilted-towers, brick-apartment) out of the Roblox
>    picker for good; the Roblox story is our own captures (the Game Lawn, chess, kitchen).

> **Update 12 (Sat ~7 AM): the real tables come from the server, two real rooms are uploaded. Fix chess and foosball.**
> **New server field** (`contracts.md` 6.6), live once Ojasva restarts the server (he posts it): `features` in `/model`
> and in `/map` (after `walkBounds`, every chunk too). Studs, the map's frame (metres × 3.57, floor y = 0, no flips).
> `Rooms.modelInfo` caches `/model` once per Roblox server, so stop and start a test after the restart.
> `the-courts`, in `/model` and `/map`:
>
> ```json
> "pingPongTable": { "corners": [[0.01, 2.713, -22.161], [7.349, 2.713, -15.694], [3.75, 2.713, -11.609],
>                                [-3.589, 2.713, -18.076]],
>                    "height": 2.713, "centre": [1.88, 2.713, -16.885], "length": 9.782, "width": 5.444,
>                    "yaw": -2.2931, "net": [[3.68, 2.713, -18.927], [0.08, 2.713, -14.843]] },
> "foosballTable": { "corners": [[0.21, 2.642, -9.202], [1.151, 2.642, -5.077], [-1.296, 2.642, -4.519],
>                                [-2.237, 2.642, -8.644]],
>                    "height": 2.642, "centre": [-0.543, 2.642, -6.86], "length": 4.231, "width": 2.51,
>                    "yaw": -2.9173, "rods": [-0.975, 0, 0.2224], "fieldHeight": 2.642, "rimHeight": 3.131,
>                    "rodHeight": 2.97, "rodOffsets": [-1.839, -1.321, -0.793, -0.261, 0.261, 0.796, 1.296, 1.831] }
> ```
>
> `chess-room`, in `/map` only (its `/model` is 404, no textured model yet):
>
> ```json
> "chessBoard": { "corners": [[-2.789, 0, -17.965], [6.019, 0, -11.837], [-0.109, 0, -3.03], [-8.917, 0, -9.158]],
>                 "a1": 4, "cornerSquares": ["a8", "h8", "h1", "a1"], "centre": [-1.449, 0, -10.497], "size": 10.73,
>                 "square": 1.341, "files": [0.8209, 0, 0.5711], "whiteForward": [0.5711, 0, -0.8209] }
> ```
>
> All three were measured from the splats and checked on the real photos. What reads them, and what to fix:
> - **Ping pong** (`Pong.luau` `placeFromFeature`, and Seb's `PingPong.luau`): reads `corners`, no change needed.
>   `Config.PINGPONG_TABLES["the-courts"]` is now only the fallback when `features` is missing.
> - **Chess never gets the board:** `Main` passes only `Rooms.modelInfo(...).features`, and `chess-room`'s `/model` is
>   404, so `Chess.placeForRoom` falls back to the empty `Config.CHESS_BOARDS`. Pass the map's `features` when the
>   model has none.
> - **Chess is turned 90°:** `Chess.luau:359` `CFrame.Angles(0, -math.pi / 4, 0)` should be `+math.pi / 4` (the
>   comment on 358 has the direction backwards), or use `fb.whiteForward` directly. Today the game's a1 (dark) lands
>   on the real a8 square.
> - **Foosball stops on the real table** (4.23 × 2.51 studs, not 16 × 9): the rod range on `Foosball.luau:288` is
>   2.51 / 2 − 2.9 − 0.55 = −2.2, so `math.clamp` on line 148 errors every frame (min above max, per the Luau docs; not
>   run in Studio) and the ball never moves. The men at ±2.4 / ±2.6 stand outside the walls (±1.255), `GOAL_HALF` 1.8
>   is wider than the table, the rods float 1.6 studs up (real: 0.33), and the real table has 8 rods. Scale the layout
>   to `LEN` / `WID`, or use `rodOffsets` (local z = −offset), `rodHeight` and `rods`. `corners` and `height` are the
>   field, so the table frame's y = 0 is the pitch, as you play it; `rimHeight` is the cabinet top. Players stand on
>   the long sides (corners 1-2 and 3-4), not at the ends.
>
> **Rooms, uploaded and served by `/model` now:** the Game Lawn's photo-textured v2 room (`the-courts`, asset
> `91874647541773`, which replaced `140213715469147` at ~7:20 with the ceiling closed; six sky faces in `sky`) and the
> Brick House apartment (`brick-apartment`, asset `96179943812932`). Delete `ServerStorage.Rooms.the-courts` and
> `ServerStorage.Rooms.brick-apartment` (a Studio import always wins), play-test both, then File → Publish to Roblox.

> **Update 11 (Sat ~5:30 AM): a real floor, and the model lines itself up. Pull, sync, test the court, publish.**
> **Changed in the game code on `main`** (MapBuilder, Rooms, Presence, Config, one line in Main; no new files). It has
> not been compiled or run in Studio yet (no Luau toolchain on Ojasva's Mac), so you are the first: post any Output
> error in the team chat.
> - **Floor:** an invisible `Room.Bounds.Floor` slab, top exactly at y = 0, 2 studs thick, under the walk box and the
>   spawn plus 4 studs. `SafetyFloor` moved down to y = -8 (lower if the room goes lower) and `Config.FALL_Y` is now -4,
>   so anyone who drops onto it goes back to spawn. The walls sit on the walk box.
> - **Model alignment:** the loaded model is turned, scaled and moved until its box matches `/model` `bounds`. Uploaded
>   models always; Studio imports (`ServerStorage.Rooms`) only when their shape matches that box within 3%, else
>   loosely on the block map and only when clearly off. Multi-part models load every part and line each one up on its
>   own `parts[i].bounds`. Limits: a 180-degree turn can't be seen from a box, and a quarter turn is always fixed as +90.
> - **Closed rooms:** a JSON 404 from our server for the map (room archived or deleted) shows "That room was closed"
>   and moves everyone to `the-courts` (`Config.DEFAULT_SCENE`; to the lobby, once, if that is gone too). A presence
>   404 no longer shows "Reconnecting".
> - **Lighting:** Update 10's unlit setup and part materials are in MapBuilder: on while a textured room is loaded, the
>   old lighting back for block rooms and the lobby. Lighting is global, so the lobby is unlit while a textured room
>   is loaded.
>
> **New server fields** (studs, map frame; `contracts.md` 6.2 and 6.2b): `/map` adds `walkBounds`; `/model` adds
> `bounds` (+ `boundsSource`), `parts[i].bounds`, `walkBounds`, `floorY: 0` (the scene-frame floor is now
> `sceneFloorY`), `studsPerMeter`, `spawn`. They show on the public link after Ojasva restarts the live server (he
> posts it); until then the walls fall back to the captured blocks. `the-courts`: `walkBounds` min (-22.74, 0, -36.69),
> max (24.82, 15.5, 13.32), spawn (-4.65, 0, -5.27).
>
> **Your steps:**
> 1. Pull `main`, `rojo serve roblox/default.project.json`, sync with the Rojo plugin. Check `ServerScriptService.DejaView`
>    (MapBuilder, Rooms, Presence, Config) and `Main` are updated.
> 2. Delete `ServerStorage.Rooms.<id>` for every world whose `/model` returns an `assetId` (a Studio import always wins
>    over the uploaded model); `the-courts` as soon as its model lands.
> 3. After the restart, play-test `the-courts`: spawn on the floor, walk to every edge (the walls hold you), jump on the
>    tables, nothing falls through. With a model loaded, show the collision blocks (Play, switch to the server view,
>    command bar: `for _, p in workspace.Room:GetChildren() do if p:IsA("BasePart") then p.Transparency = 0.6 end end`)
>    and check the model sits on them. Output should say `loaded uploaded room model ...` and
>    `room model aligned on the model box: scale ..., turned ..., offset ...`. To test closing, ask Ojasva to archive a
>    spare room while you are in it: the toast shows and everyone lands at the court.
> 4. File → Publish to Roblox.
>
> **Judge only** `the-courts`, `chess-room`, `kitchen`, `tilted-towers`, `brick-apartment`; the old `fortnite-*` rooms are
> retired. `the-courts` has no textured model yet. The version 2 models (textures projected from the real photos, sky
> boxes) come from the server as each one finishes and need no code from you beyond Update 10: its lighting part is
> done above; the sky faces (`sky` → `Lighting.Sky`) are still yours.

> **Update 10 (Sat ~5:05 AM): make the textured rooms look like the splat viewer. Do this first (15 min).**
> The model's textures already contain the real lighting from the photos; Roblox lights them again, so they look dark
> and plasticky. Make Roblox show the texture colours as they are, while a room is loaded:
> - `Lighting`: `GlobalShadows = false`, `Ambient = (255,255,255)`, `OutdoorAmbient = (255,255,255)`, `Brightness = 0`,
>   `EnvironmentDiffuseScale = 0`, `EnvironmentSpecularScale = 0`, `ExposureCompensation = 0` (tune ±0.3 by eye), no
>   Atmosphere/Bloom/ColorCorrection effects while in a room (restore them in the lobby).
> - Every model part: `Material = SmoothPlastic`, `Reflectance = 0`, `CastShadow = false`.
> - Compare against the splat viewer at the same spot (`/view?scene=<id>`): colours should match closely.
> Also coming from the server (no work for you yet): version 2 room models built from the rebuilt worlds (much cleaner
> geometry, more detail), plus a 360-degree **skybox** per world rendered from the splat viewer at the spawn: six
> images uploaded to your account. `GET /api/roblox/<id>/model` will add `sky: {front, back, left, right, up, down}`
> asset ids; set them on `Lighting.Sky` (`SkyboxFt`, `SkyboxBk`, `SkyboxLf`, `SkyboxRt`, `SkyboxUp`, `SkyboxDn`) while in that
> room, so far scenery (sky, buildings, palms) looks exactly like the splat viewer and only the nearby room is geometry.
> Don't judge the look on the old one-screenshot worlds (`fortnite-*`): their geometry falls apart away from the spawn.
> Judge it on `the-courts` once its version 2 model lands.

> **Update 9 (Sat ~5 AM): Updates 6-8 are merged, amazing. Next: make every world a real, polished game.**
> 1. **Playable end to end, every world:** join from a phone, a laptop and the Quest Roblox app into `the-courts`,
>    `chess-room`, `kitchen`, `tilted-towers`, `brick-apartment` (as each lands): spawn on the floor, walls hold you in,
>    the games start from one prompt, nothing falls through. Fix whatever breaks; a short checklist per world in your
>    README.
> 2. **A game per world:** court = ping pong + foosball (done); chess-room = giant chess (done); **kitchen = a cooking
>    rush** (ingredients appear around the real counters, carry them to the stove before the timer ends, score board);
>    **tilted-towers = tag or a "floor is lava" round on the real street**; apartment = hide and seek.
> 3. **Arrival animation:** when a room loads, the real room assembles around the players: chunks of the textured model
>    rise from the floor and slot into place over ~2 s with a soft sound, then the game prompt appears. Same when leaving
>    (the room folds away into a card). This mirrors the headset, where the photo turns into the world.
> 4. **VR polish (Quest Roblox app):** comfortable movement, the HUD on a wrist or a floating panel, games playable with
>    motion controllers.
> 5. **Still open:** ambient sounds per world, phones at 30+ fps, the 30-second trailer.

> **Update 8 (Sat ~4:50 AM):**
> - **New world:** `kitchen` (a real office kitchen: fridge, stoves, sink, steel prep table, bar tables and stools). It
>   is a Photo world, so it gets a textured model and goes in your picker like the others.
> - **The best demo moment is the court:** the judge stands at the real foosball table in VR while you two play foosball
>   or ping pong on the same table in Roblox. Make sure `the-courts` loads first in your picker and the games start
>   there with one button.
> - **Uploads:** the server only uploads models from the one live server now (an accident earlier put 4 duplicate
>   models on your account: 120627213500145, 137210308273579, 113019081409529, 75220212245793; archive them in the
>   Creator Dashboard if you like, nothing uses them).
> - The headset now uses a light Apple look; matching your HUD to it (white panels, blue accent) is a nice touch if you
>   have time.

> **Update 7 (Sat ~4:10 AM): the real textured rooms are live. Drop the blocks as the look.**
> The block rooms only resemble the place; the textured model IS the place. Now:
> - `GET BASE/api/roblox/<id>/model` is live on the public link: `assetId`, `units: "studs"`, `studsPerMeter: 3.57`,
>   `chunks` (named pieces, each under 20,000 triangles, 1024 px textures). If a model has no `assetId` yet, the server
>   uploads it to your account on that request (your key is set) and the next poll returns it.
> - Test now: `sample-painted-bedroom` is asset **82386512202897** (uploaded to your account). Load it with
>   `AssetService:LoadAssetAsync`, compare it with the block room in the same spot, and send Ojasva a screenshot.
> - Show the model; keep the blocks only as invisible collision (Transparency 1). Check the model sits exactly on the
>   block room (if it is turned 180 degrees about Y, rotate it; the chunk sizes match either way).
> - Lighting: the textures already contain the scene's light, so Roblox shades them twice. Raise `Lighting.Ambient` /
>   `OutdoorAmbient` or set the parts' Material to SmoothPlastic with low reflectance so they are not too dark.
> - The four real worlds get their models as each one passes its check (the court first); same ids as Update 3.

> **Update 6 (Sat ~3:55 AM): ping pong and the first chess are merged. Your queue after foosball (Update 5 item 2),
> in order, so you never wait on anyone:**
> 1. **Finish the games:** chess checkmate/stalemate/promotion edge cases; ping pong and foosball scores sent as
>    `POST /event {type:"game", ...}` (Update 5 item 5); a rematch button.
> 2. **Hall of fame:** a lobby board with wins per player across sessions (DataStore), per game, top 5.
> 3. **Badges** (Roblox badges or in-game): "Walked into a memory", "Tagged the judge", "Checkmate at the chess room",
>    "21 at the court".
> 4. **Sound per world:** quiet ambient loops from the Creator Store (night crickets at the court, lounge hum in the chess
>    room, wind in Tilted), plus hit/goal/check sounds; credit them for the Devpost.
> 5. **First-join card:** a 10-second controls card for phone, keyboard and Quest, shown once.
> 6. **Replay (when Ojasva says Tiger Data is live):** after a round, a Replay button plays everyone's paths as ghost
>    trails from `GET BASE/api/replay/<id>?from=<ms>&to=<ms>` (per person: `t[]`, `x[]`, `y[]`, `z[]`, `yaw[]` in room
>    metres, times in ms after `from`).
> 7. **Trailer:** a 30-second capture of the best Roblox moments (joining from a phone, a tag, a checkmate, ping pong)
>    for the Devpost video.

> **Update 5 (Sat ~3:30 AM): items 1-4, 6 and 7 are merged, great work. Next: make the real places real games.**
>
> The worlds are rebuilt from our own footage, so the actual objects are there. Turn them into games people play:
> 1. **Ping pong at the court** (`the-courts`): a playable table-tennis game on the real table, 1v1, phone and Quest
>    controls (tap or swing to hit), the score on a floating board, rally-length record. Physics simple and fun beats
>    realistic.
> 2. **Foosball at the court:** a 2-player foosball game on the real foosball table (rods on keys / touch sliders),
>    goals counted on a board.
> 3. **Giant chess** (`chess-room`): a real chess game on the giant board where the players in our video played: walk
>    up to a piece and move it, legal moves only, turn indicator, checkmate banner. Two Roblox players, or a Roblox player
>    against the person in the headset.
> 4. **Where the objects are:** `GET BASE/api/roblox/<id>/model` will include `features` in studs, the same frame as
>    the map: `pingPongTable` (4 top corners + height), `foosballTable` (4 top corners), `chessBoard` (4 corners, which
>    corner is a1). Build against a config table you can tune by hand now; switch to `features` when the worlds land
>    (the court first, Saturday morning).
> 5. **Scores:** send each finished game as `POST /event {type:"game", game:"pingpong"|"foosball"|"chess", winner,
>    score}`. The headset shows it, and it lands in the replay.
> 6. **Still open from Update 4:** item 5 (Roblox on the Quest, with Ojasva Saturday afternoon), 8 (phones), 9 (clips).

> **Update 4 (Sat ~3:10 AM): the server is public. Your work list, in order.**
>
> **The link (live now):** `https://prozac-covered-burke-oklahoma.trycloudflare.com` (it changes if the tunnel
> restarts; Ojasva posts the new one; Seb's fixed domain replaces it later). Checked from outside: `/api/scenes`,
> `/api/roblox/<id>/map`, `/presence` and `/event` all answer. No `dejaview_key` is required yet.
>
> **A. Right now (30 min): go live.** `dejaview_base` = the link, `use_mock` = false, publish, run your transport test.
> Join `fortnite-tilted-night` (an old test world; the four real worlds arrive Saturday morning). Ojasva opens
> `/view?scene=fortnite-tilted-night` in his browser or Quest so you see a real ghost. Report anything that breaks.
>
> **B. Build next (each one makes the demo better; do them in this order):**
> 1. **Walk limits in Roblox.** The rebuilt worlds only look right where the camera went, and the same goes for Roblox.
>    Build invisible walls at the world's walkable box: `GET BASE/api/roblox/<id>/model` will return `walkBounds` (studs,
>    same frame as the map) with the room model; until that route is live, use the extent of the map's floor parts.
> 2. **Gemini labels in Roblox.** `GET BASE/api/scenes/<id>/hotspots` returns `{hotspots:[{label, blurb, x, y, z}]}`
>    in room metres (studs = metres x 3.57, the same transform as the map). Show each as a floating label
>    (BillboardGui, readable on a phone). Then a **"Hunt" round**: players race to touch every label; the first to finish
>    wins; send `POST /event {type:"hunt", by, found, total}` (unknown event types pass through to the headset).
> 3. **Notes in Roblox.** `GET BASE/api/notes/<id>` every 2 s returns `{notes:[{id, author, text, x, y, z}]}` (metres):
>    show each as a floating note bubble at its spot (gray message bubble, author on top). Let a Roblox player leave
>    one: `POST BASE/api/notes/<id> {author, text, x, y, z}` (metres). It shows up in the headset and on Seb's map.
>    Until Seb's DeepSpace is connected, POST answers an error: show "Notes are offline" and keep going.
> 4. **The judge as a person, not floating parts.** Drive an R15 rig with IKControl from the presence `head` and
>    `hands`, so the VR player in Roblox walks, turns and reaches like a real avatar.
> 5. **Roblox in VR.** Play the published game in the Roblox app on Ojasva's Quest: movement comfort (snap turn,
>    vignette), the HUD readable in VR, tag works with motion controllers. Friends with a Quest could join this way.
> 6. **Big-screen camera.** A host-bar toggle for a smooth spectator camera that follows the judge's ghost, for the
>    table laptop and projector during the demo.
> 7. **"New room unlocked."** When a scene turns ready (the finale), a lobby moment: a portal or banner with its name,
>    and everyone gets a JOIN prompt.
> 8. **Phones.** StreamingEnabled and a part budget so a phone keeps 30+ fps in the biggest world; test on a phone.
> 9. **Devpost clips.** 10 s screen recordings: joining a world, a tag, labels, a note appearing, a phone and a Quest.

> **Update 3 (Sat ~3 AM): your Update 2 work is merged, thanks. What is next for you:**
> 1. **The worlds are changing:** the four rebuilt worlds (real footage, every angle; walking limited to where the camera went): **`tilted-towers`**
> (outdoor town centre), **`brick-apartment`** (the Brick House apartment), **`the-courts`** (our table-tennis and
> foosball patio, from 25 photos), **`chess-room`** (the giant-chess lounge). The two video memories, **`courts-foosball`**
> and **`chess-match`**, put the people from our clips into those places as full 3D people you can walk around, even
> paused. Only the four worlds go in your picker (the video memories are filtered
>    out already). Their `.glb` files and `model` details come as each one finishes training (the court first, Saturday
>    morning); Ojasva posts each in the team chat. Import each into `ServerStorage/Rooms/<sceneId>` with those exact ids.
>    New worlds after that upload themselves with your key (it is set on the server).
> 2. **Public link:** as soon as Ojasva posts it (after the server wiring lands), set `dejaview_base` and the
>    `dejaview_key` secret, `use_mock` = false, publish, and run your transport test against it.
> 3. **Demo:** you and Brianna join the judge in **`tilted-towers`** at 1:10 (tag round). Then the court is the second
>    "wow": the patio we actually played in, as a Roblox place on a phone.
> 4. **Quest:** try the published game in the Roblox app on Ojasva's Quest Saturday afternoon (movement, the HUD, tag).
> 5. **Optional, only if you have time:** the site moved to a clean Apple style; a lighter HUD (white panels, blue
>    accent) would match it. Your call; it works as it is.
> 6. **Devpost:** list the Creator Store sounds you use, with credit.

> **Update 2 (Sat ~2 AM): only Photo worlds go to Roblox, and the room becomes the real room.**
>
> 1. **Photo worlds only.** A photo or screenshot of a place becomes a Roblox place; a video memory stays in the headset
>    and the browser. The picker lists `status == "ready"` and `mode != "video"`. For a video scene the server's map
>    and model answer 404.
> 2. **The real room, not blocks.** For every Photo world the server now also builds `roblox.glb`: the room as a
>    textured 3D model split into chunks (each under Roblox's triangle limit), in exactly the same frame as the block
>    map. `GET BASE/api/roblox/<sceneId>/model` returns its details (units, chunk names, spawn in studs, and an
>    `assetId` once uploaded); `GET BASE/api/roblox/<sceneId>/model.glb` is the file.
>    - **Demo worlds** (Fortnite and the backup photo world): Ojasva posts the `.glb` files Saturday morning. Import
>      each with Studio's 3D Importer, use the units the `model` route names, anchor every part, and keep it in
>      `ServerStorage/Rooms/<sceneId>`. The loader clones that instead of building blocks.
>    - **New worlds** (the finale): create an Open Cloud API key (Creator Dashboard → Open Cloud → API Keys, Assets
>      read + write) and send it with your user id to Ojasva **privately**. The server then uploads each new world's
>      model, `model` returns `assetId`, and your server loads it with `AssetService:LoadAssetAsync(assetId)` (it
>      replicates to everyone). While there is no `assetId`, build the block map exactly as today.
>    - **Walking:** keep the block map's floor as invisible collision under the model, or use the MeshParts' own
>      collision, whichever walks better on a phone.
> 3. **Quest and phones.** It must play in the Roblox app on the Meta Quest (turn on VR / Meta Quest support for the
>    experience in the Creator Dashboard; the default PlayerModule handles VR movement) and on phones (7.7). Ojasva
>    tests it on his Quest Saturday afternoon.
> 4. **Demo change:** you join in the **Fortnite world** (a Photo world), not the game-night memory. At 1:10 the host
>    drops the judge into Fortnite and you press JOIN there; have Fortnite pre-loaded in your server.

Someone drops a photo or a clip of a real place into Déjà View, it becomes a 3D world, and you and friends join
that same room in Roblox and play tag with the person in the VR headset. Roblox is how friends without a headset can
be there.

**Prize:** Best Use of Roblox Studio. Build it in Roblox Studio with the core logic in Luau. Confirm the exact judging
criteria on the SwampHacks Discord tonight: ask whether the experience must be published or public, and whether a place
file has to be submitted.

---

## 0. The short version

**Tonight**
1. Roblox Studio → new place → publish it (Private) → File → Experience Settings (older Studio builds call it Game
   Settings) → Security → **Allow HTTP Requests: ON**.
2. Build against **mock data** (the server is not public yet). A ModuleScript returns a map in exactly this shape:
   `{ studsPerMeter = 3.57, spawn = {x, y, z}, parts = { {x, y, z, sx, sy, sz, r, g, b}, ... } }`.
   Each part: centre in studs (Y up), size in studs, colour 0 to 255.
3. Build in this order: **room loader** (anchored Parts in batches, behind a "Moving in..." loading screen) → **room
   picker** board → **VR ghost** (a head and two hands gliding along a fake path, interpolated) → **tag rounds** (90 s,
   the VR player is "it", tagged within 4 studs, scoreboard and sounds).
4. Look: dark UI, one lime accent **`#C6FF3D`**, bold type.
5. Run the transport test (section 9.3): a live Roblox server fetching JSON through a Cloudflare quick tunnel.

**Real endpoints** (`BASE` = the Déjà View server; public https link by **Sat 4 PM**):

| Call | Shape |
| --- | --- |
| `GET BASE/api/scenes` | the room list for the picker (`Scene[]`, newest first; keep `status == "ready"`) |
| `GET BASE/api/roblox/<sceneId>/map` | `{sceneId, name, studsPerMeter: 3.57, spawn: [x, y, z], parts: [[x, y, z, sx, sy, sz, r, g, b], ...]}` |
| `POST BASE/api/roblox/<sceneId>/presence` (about 4 per second) | send `{players: [{id, name, x, y, z, yaw}]}`, get `{others: [{id, name, kind, x, y, z, yaw, hands?}], t}`. All studs |
| `POST BASE/api/roblox/<sceneId>/event` | `{type: "tag", by, target}` or `{type: "round", state: "start" \| "end", scores}` |

**Deadlines:** working on mock data by **Sat 10 AM**; place id and join link to Seb and Ojasva by **Sat 12 PM**; on the
real server by **Sat 4 PM**; full demo run **Sat 10 PM**; feature freeze **Sun 4 AM**.

---

## 1. Your moments in the demo

| Time | What happens | Your piece |
| --- | --- | --- |
| before | The Fortnite room (pre-built, the imported model) is already loaded in your Roblox server. You and Brianna wait in the lobby on two laptops. Auto-join is off | picker, loader, baked room |
| 0:00 | Seb drops the clip into his DeepSpace app. The memory's card carries a "Join in Roblox" link | your place id + launch data (7.7) |
| 0:15 | The judge is in the memory in the Quest. Your lobby board shows "JUDGE IS IN GAME NIGHT" (the Video memory; not a Roblox room) | presence (7.3) |
| 1:10 | Host: "and every photo is also a game." The host drops the judge into the Fortnite world; you press **JOIN**: you and Brianna spawn in the room within a second. A lime ghost (head, two hands, faint body) moves exactly as the judge moves, and the judge sees your avatars. 3-2-1, the tag round starts with the judge as "it". The judge reaches out, your avatar bursts into lime sparks, the headset shows **TAGGED**, a scoreboard and a winner card follow | ghost (7.4), tag (7.5), events (5.4) |
| 1:40 | The DeepSpace map on the table laptop shows everyone live. Your Roblox dots are on it. Keep running around the couch so your dot moves; Brianna switches to her browser to leave the note | presence (7.3) |
| 2:25 | Finale: the judge's own photo became a world. It appears in your picker within 3 s of being ready. You hop in (or Follow moves you) and the judge sees you standing in their brand-new world | picker + follow (7.2) |

What has to be true on the night:

| Requirement | Target |
| --- | --- |
| A scene becomes `ready` → card in the picker | 3 s or less (the picker polls every 3 s) |
| Map available → you are standing in the new room | 10 s or less (prefetch, 7.2) |
| JOIN pressed → both avatars inside the room | 1 s or less (the room is already built) |
| Judge moves → ghost moves in Roblox | 0.7 s or less end to end, and smooth (glides, never teleports) |
| Frame rate on the demo laptops | 60 fps with the room loaded |
| Failures | Self-healing: banner, retry, cached or baked room. Nobody rejoins, nobody restarts |

---

## 2. Decisions already made (and why)

These came out of checking the Roblox docs. Do not re-litigate them on Saturday.

1. **Blocks, not EditableMesh.** The room is built from anchored `Part`s. EditableMesh is disabled in published games
   unless you turn on a security toggle. It has strict memory budgets on the client and a cap of 20,000 triangles per
   mesh. In April 2026, developers on the DevForum reported that it does not replicate from the server: clients see a
   checkerboard box. Parts replicate, collide and just work.
2. **Part budget: 3,000 to 6,000 parts, hard cap 12,000.** The server merges voxels into boxes before sending them. The
   map endpoint takes an optional `maxParts` (default 6000, cap 12000) so you can request a coarser room if building is
   slow.
3. **One map response by default, chunks only if needed.** Roblox does not document a maximum response size. 6,000
   parts is about 270 KB of JSON, so tonight's transport test (9.3) also fetches a 300 KB file to prove it works. If it
   does not, ask for `maxParts=3000`, or use the optional `chunk=N` query (chunks of at most 2,500 parts, about
   120 KB, each repeating the header fields plus `chunk` and `chunks`). Chunks work: `chunk` is **1-based** (loop
   `for c = 1, chunks`; `chunk=0` is a 400).
4. **HTTP runs only on the Roblox game server.** LocalScripts cannot use HttpService. One server Script owns the network
   and tells clients what to show through attributes and RemoteEvents.
5. **Presence is polled at 4 Hz.** HttpService can stream (SSE or WebSockets) only in Studio, so a published game cannot
   use it. Polling stays well inside the 500 requests per minute that each game server gets.
6. **Each client renders the ghost itself and interpolates it.** Roblox's performance guide warns that moving things
   from the server (server-side TweenService) makes them jittery and wastes bandwidth. The server sends ghost snapshots
   4 times a second, and each client draws the ghost 0.35 s in the past, sliding between snapshots.
7. **The public URL is a Cloudflare Tunnel, never free ngrok.** Free ngrok allows only 20,000 requests a month, and
   Roblox alone makes about 14,400 an hour. The URL lives in an **Experience Config**, so a new tunnel URL takes effect
   in under a minute without republishing.
8. **The shared key lives in the Roblox Secrets store, never in a script.** It is sent as a header.
9. **Scale comes from the server: `studsPerMeter = 3.57`.** One stud is 28 cm, so the room is life size. Every map
   response carries it. Never hard-code the scale: if a room feels cramped for 5-stud avatars, Ojasva can raise it for
   that scene and your code just follows.
10. **The room picker shows colour swatches, not thumbnails.** An ImageLabel can only show images uploaded to Roblox, so
    you compute 4 dominant colours from each room's map parts after prefetching it.
11. **Every Roblox server reports its `game.JobId`** (optional `server` field). If someone lands in a different Roblox
    server, they still show up in VR, on the map and as a ghost for you. The demo never depends on everyone landing in
    the same server, even though they normally will.

---

## 3. Accounts and setup

Tonight, in this order:

| # | Step | Time | If blocked |
| --- | --- | --- | --- |
| 1 | Install Roblox Studio from https://create.roblox.com (Start Creating → download). Sign in. | 10 min | Use another teammate's computer |
| 2 | **Age check** on your account: Roblox app or site → Settings (gear) → Account info → Age Group → Continue with selfie. You need a camera (a phone works). See https://about.roblox.com/age-estimation | 5 min | Use ID verification (takes a few minutes). If both fail, a teammate who passes owns and publishes the experience and gives you Edit access |
| 3 | Add Ojasva, Seb and Brianna as **Roblox friends**. On a user-owned game, Edit permission can only go to friends. | 5 min | Make a Roblox group, which needs no friendship |
| 4 | Studio: New → Baseplate. Then File → **Publish to Roblox**, name it "Déjà View" and leave it **Private**. | 5 min | |
| 5 | File → Experience Settings → Security → **Allow HTTP Requests: ON**. Save. | 1 min | Unpublished place: in the Command Bar, run `game:GetService("HttpService").HttpEnabled = true` |
| 6 | Workspace properties: **StreamingEnabled: OFF**. This is one room, so streaming only adds "part not there yet" bugs. You can only change it in Studio. | 1 min | |
| 7 | Studio → Collaborate: add each teammate with **Edit**. Adding collaborators needs the age check from step 2. Friends with Edit can join your Private experience from the Roblox app. | 5 min | |
| 8 | Install `cloudflared` for the transport test in section 9.3 (`brew install cloudflared`, or the Windows installer from Cloudflare). | 5 min | Skip it; your first real test is then Ojasva's early quick tunnel (if he has one around Sat 12 PM) or the public `BASE` at Sat 4 PM |

Saturday, once Ojasva sends a tunnel URL (the public `BASE` at 4 PM, or an early quick tunnel if he has one ready around
12 PM) and DMs you the key:

| # | Step | Time |
| --- | --- | --- |
| 9 | Creator Hub → your experience → **Secrets** → Create Secret. Name `dejaview_key`, value = the key Ojasva DMs you (`DV_KEY`). Domain = the tunnel host, or `*.trycloudflare.com` for a quick tunnel. Update the domain when the public host changes. | 3 min |
| 10 | Studio → File → Experience Settings → Security → **Local Secrets**: add the same `dejaview_key`. Live secrets are not available in a local playtest. | 2 min |
| 11 | Creator Hub → your experience → **Configs** → create `dejaview_base` (string) = the tunnel URL with no trailing slash → **Publish now**. Also create `round_seconds` (number) = 90. | 3 min |
| 12 | Creator Hub → your experience → fill in the **Maturity & Compliance questionnaire**, so you can open the audience on Sat 4 PM (below) | 10 min |

Who can play, and how:

- **Teammates (the demo):** they are friends with Edit, so they open the experience from the Roblox app. By default,
  Roblox matchmaking places a joining player in a server with their friends, or with players on the same IP address
  (same Wi-Fi). Two laptops on the same Wi-Fi land together. For certainty, join from the friend's profile.
- **Friends from the group chat and judges, on their own accounts and phones (Sat 4 PM):** a Private experience only
  lets in people with Edit permission. To let anyone with the link join, the publishing requirements for a Limited or
  Public audience must be met: your age check, an account in good standing that is at least 2 days old, and the
  Maturity & Compliance questionnaire (about 10 minutes, Creator Hub → your experience). Then do one of these:
  - Audience → **Public** with **Enable Beta Mode** on: anyone with the link can join, and Beta keeps it out of
    recommendations. This is the best fit for "friends from the group chat tap a link".
  - Audience → **Limited → Playtesters**: add specific judges' usernames with Play permission.

  Stay Private until Saturday afternoon. If none of this works out, hand the judge a teammate's laptop.
- **Team Test** (the Studio test-mode dropdown → Team Test) runs on a Roblox server, so it can reach a public tunnel.
  Your teammates join it from their Studio. Use it to rehearse together before you republish.

---

## 4. Architecture

```
  Roblox clients (laptops, phones)    Roblox game server (Roblox datacenter)          Déjà View server (Ojasva's Mac)
 ┌────────────────────────┐ attrs  ┌──────────────────────────────────┐   HTTPS 443   ┌───────────────────────────────┐
 │ Client (LocalScript)   │◀───────│ Main (Script)                    │──────────────▶│ GET  /api/scenes              │
 │  UI: loading, picker,  │ events │  Api ── the only network code    │  Cloudflare   │ GET  /api/roblox/:id/map      │
 │  HUD, scoreboard       │───────▶│  MapBuilder  Rooms  Presence     │◀──────────────│ POST /api/roblox/:id/presence │
 │  Ghost renderer        │        │  TagGame (the referee)           │    tunnel     │ POST /api/roblox/:id/event    │
 │  (interpolates)        │        │                                  │               │ GET  /api/presence/:id        │
 └────────────────────────┘        └──────────────────────────────────┘               └───────────┬───────────────────┘
                                                                                                  │ studs ↔ metres
                                                                     Quest 3S viewer (ghosts, TAGGED) ◀─┤
                                                                     DeepSpace live map (Seb) ◀─────────┘
```

- **Who calls whom:** only your Roblox **server** calls the Déjà View server. Nothing ever calls Roblox. Clients talk only
  to your server, through RemoteEvents and attributes.
- **BASE:** the `dejaview_base` config value, for example `https://dejaview-xyz.trycloudflare.com`. HTTPS on port 443.
  (The tunnel ends at Ojasva's plain-HTTP port 8788; you never see that.)
- **Headers on every request:** `content-type: application/json` (on POSTs) and `x-dejaview-key: <Secret>`. Use lowercase
  header names, because HTTP/2 requires them. The server checks the key only when Ojasva sets `DV_KEY`. If `GetSecret`
  fails, send the request without the key and warn once in the Output window.

### Coordinate frame (shared with everyone, exact)

- **The room frame is the Workspace frame.** Build the room at the Workspace origin. Studs, Y up, floor at `y = 0`. Put
  your lobby far away (centred at `0, 300, 0`) so nothing needs an offset.
- **Axes match the headset viewer.** Both are right-handed, Y up, with -Z forward, so no axis flips. Everyone else uses
  the **room frame** in metres (`contracts.md` 3.1). The server converts with `studs = metres * studsPerMeter` and back,
  axis for axis. You never convert anything yourself: everything you send and receive is studs.
- **Yaw** is in radians: 0 faces -Z, and positive turns left (counter-clockwise seen from above). It is the same angle
  as `CFrame.Angles(0, yaw, 0)`. Facing direction = `(-sin yaw, -cos yaw)` in (x, z).
  ```lua
  local look = hrp.CFrame.LookVector
  local yaw = math.atan2(-look.X, -look.Z)                   -- character → yaw
  local cf  = CFrame.new(pos) * CFrame.Angles(0, yaw, 0)     -- yaw → CFrame
  ```
- **`x, y, z` of any person is their feet on the floor.** For a Roblox R15 avatar, use
  `feetY = hrp.Position.Y - (humanoid.HipHeight + hrp.Size.Y / 2)`.
- **VR head and hands:** `hands` is `[[x, y, z], [x, y, z]]`, left then right, and may be missing or `null`. A `head`
  field may appear; when it is missing, put the head at the feet plus 1.6 m, which is **5.7 studs** at 3.57.
- **IDs:** Roblox players are `"rbx-" .. player.UserId`. The headset is `quest-1` (`quest-2` for a second one), and
  browser viewers are `web-<8 hex chars>`.
- The headset spawns at the room origin. The map's `spawn` is a free floor point away from it.

### What Ojasva provides, and by when

| What | Shape | By |
| --- | --- | --- |
| LAN `BASE` + `DV_KEY` (key by DM, never in chat or code) | `http://<mac-lan-ip>:8788` | Fri night |
| Every Roblox endpoint answering on the LAN (map for the sample scenes, presence, event) and `GET /api/presence/:id` | section 5 | **Sat 10 AM** |
| Optional: an early quick tunnel to that server, if ready, for your first tests from real Roblox servers. Roblox servers cannot reach a LAN address, so until a tunnel exists your game stays on mock data | `https://<random>.trycloudflare.com` | Sat 12 PM (optional) |
| **Public https `BASE`**; a map for every new ready scene within 10 s, automatically | section 5.2 | **Sat 4 PM** |
| Headset draws Roblox players as avatars and plays TAGGED, "TAG: YOU'RE IT" and the winner card from your events | (his side) | Sat 8 PM |
| The three demo worlds frozen: game night, Fortnite, one backup photo world | scene ids in the team chat | Sat 8 PM |

Until then, everything runs against your mock (section 9.1). You are never blocked.

---

## 5. Endpoints (full contract)

Common rules:

- JSON in, JSON out. Positions are studs. `t` is server epoch seconds (a float).
- **Extra fields:** ignore any field you do not know, and feel free to send extra fields. The fields in
  `START-HERE.md` are the core; everything marked optional here may or may not be there, and your code must work
  without it.
- Errors are `{ "error": "message" }` with a 4xx or 5xx status. A response that is **HTML instead of JSON** (a Cloudflare
  error page when the tunnel is down, typically HTTP 502 or 530) means **offline**: back off and retry.
- `429` means you are being rate limited: wait 5 s.

### 5.1 Room list: `GET BASE/api/scenes`

`Scene[]`, newest first, **including failed scenes**. The fields you use:

```json
[
  { "id": "game-night-k3x9a", "name": "Game night", "mode": "video", "status": "ready", "stage": "Ready",
    "progress": 1, "createdAt": "2026-10-17T14:02:19.250Z" },
  { "id": "my-kitchen-p2m4z", "name": "My kitchen", "mode": "photo", "status": "running",
    "stage": "Generating the room", "progress": 0.4, "createdAt": "2026-10-17T22:52:03.100Z" }
]
```

- Picker = `status == "ready"`, newest first, at most 12. `mode` is `photo` or `video`; treat anything that is not
  `video` as a place (bundled samples may report something else).
- Optional nicety for the finale: show `queued` or `running` scenes as a pulsing "Building · 40%" card (from
  `progress`) that cannot be clicked yet. Hide `failed`.
- A ready room is **loadable once its map (5.2) returns 200**.
- Poll every 3 s (always, so finale rooms appear within 3 s of being ready). Use `RequestAsync` (section 8), never
  a cached `GetAsync`.

### 5.2 Map: `GET BASE/api/roblox/<sceneId>/map`

`200 OK`:

```json
{
  "sceneId": "game-night-k3x9a",
  "name": "Game night",
  "studsPerMeter": 3.57,
  "spawn": [0, 0, 5.4],
  "parts": [
    [0, -0.5, 0, 26.8, 1, 23.2, 120, 104, 90],
    [0, 4.6, -11.2, 26.8, 9.3, 1, 220, 214, 200]
  ]
}
```

- Each part is `[x, y, z, sx, sy, sz, r, g, b]`: centre and size in studs, Y up, axis-aligned, colour 0 to 255.
- Parts are sorted **bottom-up** (floor first). The ceiling is **left out**, so the third-person camera can see in from
  above.
- `spawn` is a free floor point: `y` is the floor height, so add 3 studs for the root part. It sits away from the
  headset spawn at the origin, so nobody spawns inside the judge.
- Optional query `maxParts` (default 6000, cap 12000): the server coarsens the voxels until the room fits.
- Optional query `chunk=N`: chunks of at most 2,500 parts, each repeating the header fields plus `chunk` and
  `chunks`. **1-based:** request `chunk=1` first, then up to `chunks` (`chunk=0` is a 400). Without `chunk`, all parts
  come in one response.
- Optional extra fields: `ceilingY` (studs, for the invisible lid), `bounds` (studs), and a **10th value** per part
  (`1` = the AI imagined this block, `0` = the camera captured it) for the reality-check tint (7.8). Read `p[10]` only
  if it is not nil. When `ceilingY` or `bounds` is missing, compute them from the parts (the highest part top, and the
  min and max of all part extents).
- Cache the decoded map per `sceneId` in a server-side table, so switching back is instant.

Errors:

| Status | Body | Do |
| --- | --- | --- |
| 202 | `{ "status": "building", "retryAfter": 2 }` | wait `retryAfter`, retry (the card says "Measuring the room...") |
| 404 | `{ "error": "No such scene" }` | toast, back to the picker |
| 409 | `{ "error": "Scene is not ready", "status": "running" }` | retry in 3 s, at most 20 times |
| 401 | `{ "error": "Bad key" }` | banner "Key rejected", keep the current room |

### 5.3 Presence: `POST BASE/api/roblox/<sceneId>/presence` (4 times a second, one loop per Roblox server)

Request: every Roblox player who is **inside the room** (not in the lobby, not still loading). While everyone waits in
the lobby, keep posting `{ "players": [] }` for the loaded room: you still get `others`, which is how the lobby board
knows the judge is in there.

```json
{
  "players": [
    { "id": "rbx-12345", "name": "shivin", "x": 4.2, "y": 0.0, "z": -1.5, "yaw": 1.57 },
    { "id": "rbx-67890", "name": "brianna", "x": -3.0, "y": 0.0, "z": 2.4, "yaw": -0.4 }
  ],
  "server": "8b1c0e3a-6f1d-4f9e-9a55-2f3c1d1e9b77"
}
```

- `name` is the player's `DisplayName`, at most 40 characters.
- Optional `server` = `game.JobId`. It lets the server drop your players the moment you stop listing them (otherwise
  they drop after 3 s of silence). JobId is an empty string in Studio, so use `"studio-" .. HttpService:GenerateGUID(false)`
  once per session.
- Optional per-player `state` (`playing`, `caught`, `out`, `idle`): the headset may flash a caught avatar red.

Response, in studs: everyone in the scene except the players you just posted.

```json
{
  "t": 1760715600.31,
  "others": [
    { "id": "quest-1", "name": "Judge", "kind": "vr", "x": 1.5, "y": 0, "z": -3.93, "yaw": 0.3,
      "hands": [[0.71, 4.32, -5.0], [2.32, 4.46, -4.82]] },
    { "id": "web-7f3a19c2", "name": "Maya", "kind": "web", "x": -3.57, "y": 0, "z": 2.86, "yaw": 3.1 },
    { "id": "rbx-55555", "name": "late judge", "kind": "roblox", "x": 6, "y": 0, "z": -2, "yaw": 0 }
  ]
}
```

- `kind` is `vr`, `web` or `roblox` (a Roblox player in another Roblox server).
- `hands` can be missing or `null` (controllers idle, or a desktop viewer). Fall back to a head-only ghost.
- If an entry's `id` is one of your own players, drop it (belt and braces if the server ever echoes them).
- Optional extra `active` (`{sceneId, name}` of the scene the headset is in, or `null`): use it for Follow (7.2) when it
  appears. Optional extra `events` (host commands such as `start_round`): if it ever appears, apply each `id` once.

### 5.4 Events: `POST BASE/api/roblox/<sceneId>/event` (once per moment)

Your Roblox server is the **referee**: it checks the headset's `hands` against avatar positions (7.5) and reports what
happened. The core shapes:

```json
{ "type": "round", "state": "start", "scores": { "quest-1": 0, "rbx-12345": 3, "rbx-67890": 3 } }
{ "type": "tag", "by": "quest-1", "target": "rbx-12345" }
{ "type": "round", "state": "end", "scores": { "quest-1": 4, "rbx-12345": 0, "rbx-67890": 2 } }
```

- Response `{ "ok": true }`. On failure, retry up to 3 times with a 1 s gap, then drop it.
- Send `round start` when the round really begins, after your 3-2-1 countdown.
- Extra fields are welcome and help the headset: `duration` and `it` on round start (the headset starts its own timer
  from `duration` when it receives it), `targetName` on a tag, `winner` (`"vr"` or `"roblox"`) on round end.
- In `scores`, a Roblox player's value is their lives left and the VR player's value is their tags. Never send an empty
  table: Luau encodes `{}` as `[]`.
- The server adds `t` and broadcasts it to the headset, which plays TAGGED at the target's current position, "TAG:
  YOU'RE IT" on round start and a winner card on round end.

### 5.5 Who is in another room: `GET BASE/api/presence/<sceneId>` (metres, optional, for Follow)

```json
{ "t": 1760715600.31,
  "people": [ { "id": "quest-1", "name": "Judge", "kind": "vr", "x": 0.42, "y": 0, "z": -1.10, "yaw": 0.30, "age": 0.12 } ] }
```

Use only the count and `kind` (positions here are metres, not studs). Poll it every 3 s for the newest ready room you
are not in, to spot the judge arriving there in the finale (7.2). Skip this if the presence response carries `active`.

### Request budget (limit: 500 per minute per Roblox server)

| Loop | Rate | Per minute |
| --- | --- | --- |
| Presence | 4 per second | 240 |
| Room list | 1 per 3 s | 20 |
| Other-room presence (Follow) | 1 per 3 s | 20 |
| Map loads | about 1 per room | under 10 |
| Events | per tag or round | under 10 |
| **Total** | | **about 300** |

Keep at most 2 requests in flight: the presence loop, plus one background loop that does the room list, the other-room
check and prefetches one after another. The `TooManyOutstandingRequests` HTTP error exists for a reason.

---

## 6. Recommended layout in Studio

```
ServerScriptService
  Main                (Script)        boots everything; state machine: lobby → loading → room
  DejaView            (Folder)
    Config            (ModuleScript)  constants + USE_MOCK + BASE_FALLBACK; reads ConfigService
    Api               (ModuleScript)  the ONLY code that touches HttpService; same interface as MockServer
    MockServer        (ModuleScript)  fake scenes, procedural maps, a fake VR player, latency and failure injection
    MapBuilder        (ModuleScript)  map → Parts, progress, teardown, baked-room fallback
    Rooms             (ModuleScript)  room list, swatches, votes, host override, follow, prefetch
    Presence          (ModuleScript)  4 Hz loop, snapshot buffers, fan-out to clients
    TagGame           (ModuleScript)  rounds, tag checks (10 Hz), lives, scores, events
ReplicatedStorage
  Shared              (Folder)
    Theme             (ModuleScript)  colours, fonts, sizes (used by every UI)
    Interp            (ModuleScript)  snapshot interpolation (server uses it for tag checks, clients for rendering)
    Fixtures          (ModuleScript)  the JSON strings from section 9.1
  Remotes             (Folder)
    GhostState        (UnreliableRemoteEvent)  server → clients, 4 Hz snapshots (each under 1,000 bytes or it's dropped)
    Moment            (RemoteEvent)            server → clients: tagged, toast, round start/end
    Vote              (RemoteEvent)            client → server: vote for a room
    HostAction        (RemoteEvent)            client → server: join, start/end round, follow, auto-join (server checks host)
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
`"LoadProgress"`, `"RoomName"`, `"RoundEndsAt"`, `"JudgeHere"` and `"Follow"`. Use **RemoteEvents** for moments (a tag,
a toast). Clients listen with `GetAttributeChangedSignal`.

---

## 7. How each feature works

### 7.1 Room loader (MapBuilder)

1. Set `Phase = "loading"`, `RoomName` and `LoadProgress = 0`. Every client in the room shows the loading screen
   (players waiting in the lobby keep the lobby).
2. Take the map from the cache (prefetched) or fetch it. Destroy the old `Workspace.Room` contents with one `Destroy()`
   on the folder, then create a new folder.
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
4. Once the first batches (the floor) exist, add a **safety floor** (an invisible 2-stud slab under the bounds),
   **invisible walls** just outside the bounds, and an **invisible lid** at `ceilingY` (computed from the parts if the
   map has no `ceilingY` or `bounds`). Players joining the room are placed around `spawn`: try offsets `(0, 0)`,
   `(3, 0)`, `(-3, 0)`, `(0, 3)`, `(0, -3)` studs, raycast down from 10 studs up to find the floor, then
   `character:PivotTo(CFrame.new(x, floorY + 3, z) * CFrame.Angles(0, yaw, 0))` with `yaw = math.atan2(-dx, -dz)`
   facing the room centre. Hold them anchored until the last batch is built. Anyone whose root part goes below
   y = -30 respawns at `spawn`.
5. Update `LoadProgress` after every batch (`built / #parts`). When done, set `Phase = "room"` and fade the loading
   screen out over 0.6 s.
6. Log `os.clock()` timings (fetch, decode, build) so you can tune `BATCH` and `maxParts`.

Camera and lighting for a voxel room:

- `StarterPlayer.DevCameraOcclusionMode = Invisicam`: walls between the camera and you turn see-through locally.
- `StarterPlayer.CameraMaxZoomDistance = 25`.
- Lighting: bright, neutral ambient, so the splat colours read true (try `Ambient` and `OutdoorAmbient` around
  140, 140, 140 and `ClockTime` 13). For a dark void around the room that matches the website, try an Atmosphere with
  colour and decay `#0B0B0F`, then tune by eye.
- Humanoid `WalkSpeed` 12 instead of 16. Rooms are life size and small.

### 7.2 Room picker, finale rooms and Follow (Rooms)

- **Board:** a SurfaceGui in the lobby, plus the same list in a ScreenGui panel (key `R` or a top-bar button), so you can
  switch from inside a room. Each card shows the name (bold), a mode chip (**PHOTO** or **VIDEO**), the age ("2 min
  ago"), the block count, 4 swatch squares, and a lime **JUDGE IS HERE** badge when the headset is in that room. A new
  room gets a lime **NEW** chip for 60 s. A ready room whose map still answers 202 shows a pulsing "Measuring the
  room..." and cannot be clicked.
- **Swatches:** after prefetching a map, quantize each part's colour to 32 levels per channel, add up part volume per
  colour, and keep the top 4.
- **Votes:** clicking a card fires `Vote`. The server tallies one vote per player and switches when a majority or the
  host picks. The host is the game owner (`game.CreatorId`), or the first player in the server when testing in Studio.
- **Prefetch:** when a ready room appears in the list, download its map into the cache in the background (retry 202
  until 200). When you pick it or Follow moves you, the build starts immediately with no network wait. This is what
  keeps the finale under 10 s from "map ready" to "standing in it".
- **Auto-join (host toggle on the HUD, default ON):** with Auto-join on, players in the lobby are teleported into a room
  as soon as it is built, with a 3-2-1. **For the skit, turn Auto-join OFF before the demo starts:** the game-night
  room is built while everyone stays in the lobby (lobby players are not sent in presence, so the judge sees nobody
  yet). At 1:10 you press the big **JOIN** button on the HUD, which teleports everyone in the server into the room at
  once and starts the round countdown if a VR player is present. Show "Room ready · JOIN" in lime on every client while
  it waits, and "JUDGE IS IN GAME NIGHT" once the judge shows up in `others`.
- **Follow (host toggle, default ON):** when the judge appears in a different ready room (the optional `active` field,
  or a `vr` person in `GET /api/presence/<newest room>`, 5.5), toast "Judge entered <name>", then build that room from
  the cache and move everyone who is already in a room there with a 3-2-1. Players in the lobby stay in the lobby
  until JOIN. In the finale at 2:25 this moves you into the judge's new world on its own; if it does not fire within a
  few seconds, click the card.

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
- For each person in `others`, stamp the snapshot with Roblox time when the reply arrives
  (`stamp = workspace:GetServerTimeNow()`), then push it into that person's buffer (keep the last 2 s). People who
  disappear from `others` fade out over 0.6 s.
- Set `JudgeHere = true` while a `vr` person is in `others`.
- Fan out to clients: `GhostState:FireAllClients({ id, kind, name, stamp, head, hands, x, y, z, yaw })`, one call per
  person. Keep each payload small: UnreliableRemoteEvent drops payloads over 1,000 bytes.

### 7.4 The VR ghost (client side, `Client` LocalScript)

- **Look:** clone `ReplicatedStorage.Assets.GhostTemplate` into `Workspace` from the LocalScript (a client-created model
  stays local).
  - Head: a 1.6-stud ball in Neon `#C6FF3D` at transparency 0.15, with a dark visor band on the front so you can see
    where the judge is looking. Height: `head` if present, otherwise the feet plus 5.7 studs.
  - Hands: two 0.8-stud Neon balls with short Trails.
  - Body: a faint capsule (transparency 0.75) from the floor to the head.
  - A lime PointLight on the head, so the room glows where the judge is.
  - A Highlight on the model (lime outline, DepthMode AlwaysOnTop), so you can always find "it" through walls.
  - A BillboardGui: "JUDGE · VR", plus an "IT" chip during a round.
  - All parts: `Anchored` true; `CanCollide`, `CanQuery` and `CanTouch` false.
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
  checks (7.5). Players then get tagged by the ghost they can see, not by a position 0.35 s ahead of it.

### 7.5 Tag (TagGame; your server is the referee)

Rules (constants in `Config`; the round length comes from the `round_seconds` config):

| Rule | Value |
| --- | --- |
| Round length | **90 s** (`round_seconds`). For the skit set it to **25** so the round ends at 1:40 (Configs → Publish now; or end it from the HUD) |
| "It" | The VR player (`kind == "vr"`; if there are several, the first) |
| Lives per Roblox player | 3 |
| Tagged when | Either VR hand is within **4 studs** of your HumanoidRootPart. Hands missing: the VR feet within 4 studs horizontally |
| Round start | 3 s immunity for everyone (spawn is near the judge) |
| After a tag | 3 s immunity (ForceField visual, `state = "caught"`), respawn at a free point around `spawn` |
| Out | 0 lives → spectator (`state = "out"`), camera follows the ghost |
| VR wins | Everyone is out before time |
| Roblox wins | Anyone survives; MVP = most lives left, ties broken by the longest time since their last tag |

- Check at 10 Hz on the server, using `Interp` at the same `DELAY` as the clients.
- **Start:** JOIN starts it when a VR player is present; otherwise the host presses Start on the HUD. Show a 3-2-1
  countdown on every client, then send the `round start` event. **No VR player present:** show "Waiting for the
  headset..." and do not start. The host can press **End round** at any time.
- **On a tag:** `Moment:FireAllClients({type = "tagged", ...})`. Clients play a burst (`TagBurst:Emit(40)` at the
  victim), a short sound, a camera shake for the victim, and a big **TAGGED** banner. The server sends the `tag` event
  to Déjà View, and the headset plays its own TAGGED.
- **Scoreboard:** a top-right panel. The judge's tags appear in lime. Roblox players show lives as 3 dots each, and the
  timer counts down in big type.
- **Winner screen:** 5 s full-screen dark card: "THE JUDGE WINS" or "ROBLOX SURVIVES", the MVP's name, and a lime
  underline. Then back to free roam in the same room. At 1:40, keep moving so the DeepSpace map shows a live dot.

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
- Copy voice: "Moving in...", "Measuring the room...", "Judge entered Game night", "JUDGE IS IN GAME NIGHT", "TAGGED",
  "You survived", "Reconnecting to Déjà View...".
- Loading screen: a full-screen dark background, the Déjà View wordmark, "Moving in..." in huge bold type, the room name,
  a 6 px lime progress bar with "4,210 / 5,821 blocks", and one rotating tip line.
- Sounds and particles: use Roblox-made audio from the Creator Store, and credit it on Devpost. **No free models with
  scripts** (backdoors, and the rule that all code is written by you during the event).

### 7.7 Join link and phones

- **A link that opens a specific room:** Roblox deep links can carry up to 200 bytes of launch data:
  `https://www.roblox.com/games/start?placeId=<PLACE_ID>&launchData=<sceneId>`. On the server,
  `player:GetJoinData().LaunchData` holds the scene id. If the server is in the lobby, load that room. If it is already
  in a room, ignore it, because Follow keeps everyone together. Roblox now calls deep links deprecated in favour of
  share links, but they still work. Send your place id and this format to **Seb and Ojasva by Sat 12 PM**, so Seb's app
  shows "No headset? Join in Roblox" on every memory.
- **Phones:** every UI element uses Scale sizes plus `UIAspectRatioConstraint`. Touch targets are at least 44 px. Keep
  the bottom-left (thumbstick) and bottom-right (jump) corners clear. Test with Studio's Device Simulator (phone
  profile) before Sat 4 PM. On small screens, the scoreboard collapses to a single line.

### 7.8 Reality check tint (only if the server sends `p[10]`)

The reality check is the host sponsor beat (Vobile, who protect real content): one toggle tints every part of the
world the AI imagined. If map parts carry the 10th value, add a HUD toggle "Reality check". On each client, it tints
imagined blocks toward a cool magenta and dims them slightly. Client-side property changes stay local, so each player
chooses for themselves. Keep each block's original colour in a table keyed by the part. This is P2: do it only after
everything in the Sat 4 PM milestone works.

---

## 8. Build order with checkpoints

Work top to bottom. Each step ends with something you can see.

| # | Build | You should now see |
| --- | --- | --- |
| 0 | Setup (section 3) and the transport test (9.3) | A live Roblox server printing JSON fetched from your own quick tunnel, including the 300 KB file |
| 1 | `Theme`, `Config`, `DejaViewUI` shell, `Main` state machine, lobby | Play: the dark loading screen fades into a branded lobby |
| 2 | `MapBuilder` with `Fixtures.MAP_SMALL` | The 12-part fixture room appears around you. You land on the floor, and Invisicam works |
| 3 | `MockServer.map(id, maxParts)` procedural rooms; stress test with 6,000 and 12,000 parts | The progress bar fills. Output prints build times. Pick `BATCH` and the default `maxParts` from these numbers |
| 4 | `Api` / `MockServer` with one shared interface (`scenes()`, `map(id, maxParts)`, `presence(id, body)`, `event(id, body)`, `people(id)`); `Rooms` + picker + swatches | 2 mock rooms on the board, a "Building" card that turns ready after 30 s; clicking a card rebuilds the room |
| 5 | `Presence` + `Interp` + ghost renderer, with the mock VR player | Testing-mode dropdown → Server & Clients, 2 clients: the ghost glides on both screens, even with 5% injected failures and 50 to 250 ms jitter |
| 6 | `TagGame` + scoreboard + winner screen + tag effects | The mock ghost chases and tags you; lives drop, the burst plays, the winner card shows; events print in Output |
| 7 | JOIN + Auto-join off + Follow + prefetch | Lobby shows "JUDGE IS IN ..."; JOIN teleports both clients; when the mock judge moves to the finale room, the swap finishes in under 10 s |
| 8 | Publish; Configs + Secrets; teammates join | A teammate's avatar runs next to yours in the live private server |
| 9 | Real server: `USE_MOCK = false` (9.4) | The sample rooms load through the tunnel. A curl-faked VR player moves the ghost |
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
`game:GetService("ConfigService"):SetTestingValue("dejaview_base", "https://...")`. Read `round_seconds` the same way.

---

## 9. Testing

### 9.1 Alone: mock mode (`Config.USE_MOCK = true`)

`MockServer` has exactly the same functions as `Api` and returns the same shapes. It should:

- return the `SCENES` fixture below, and flip `mock-finale` from `running` to `ready` 30 s after the server starts (the
  finale);
- return `MAP_SMALL` for `fixture-room`, and **procedural rooms** for anything else: a floor, 4 walls with a window gap,
  a couch, a table, a TV, plus random "voxel noise" boxes until it reaches `maxParts`. This gives you stress tests at
  800, 6,000 and 12,000 parts. Answer 202 for `mock-finale` for 5 s after it turns ready (the "Measuring the room..."
  state);
- act as a fake VR player on a smooth loop, with the head bobbing and the hands swinging, in the current room, and move
  it into `mock-finale` 40 s after start (to test Follow):
  ```lua
  local function mockVr(t)                       -- t = os.clock(); studs at 3.57 studs per metre
      local a = t * 0.6
      local x, z = math.cos(a) * 6, math.sin(a * 0.8) * 4.5
      local dx, dz = -math.sin(a) * 6, math.cos(a * 0.8) * 3.6   -- velocity, for facing
      local yaw = math.atan2(-dx, -dz)
      local side = Vector3.new(math.cos(yaw), 0, -math.sin(yaw)) * 1.4
      return { id = "quest-1", name = "Judge", kind = "vr", x = x, y = 0, z = z, yaw = yaw,
               head = { x, 5.7 + math.sin(t * 3) * 0.15, z },
               hands = { { x - side.X, 4.3 + math.sin(t * 5), z - side.Z }, { x + side.X, 4.3, z + side.Z } } }
  end
  ```
- inject 50 to 250 ms of random latency (`task.wait`) and fail 5% of calls, so your backoff and banner get exercised.

`ReplicatedStorage.Shared.Fixtures` (exact shapes, as JSON strings, decoded with `JSONDecode`):

```lua
-- [=[ ... ]=] (not [[ ... ]]) because the JSON itself contains "]]"
return {
SCENES = [=[[
 {"id":"fixture-room","name":"Fixture room","mode":"photo","status":"ready","stage":"Ready","progress":1,"createdAt":"2026-10-17T10:00:00Z"},
 {"id":"mock-game-night","name":"Mock game night","mode":"video","status":"ready","stage":"Ready","progress":1,"createdAt":"2026-10-17T10:05:00Z"},
 {"id":"mock-finale","name":"Judge's photo","mode":"photo","status":"running","stage":"Generating the room","progress":0.4,"createdAt":"2026-10-17T10:06:00Z"},
 {"id":"mock-broken","name":"Broken","mode":"photo","status":"failed","stage":"Failed","progress":0,"error":"That one didn't work","createdAt":"2026-10-17T10:07:00Z"}]]=],

MAP_SMALL = [=[{"sceneId":"fixture-room","name":"Fixture room","studsPerMeter":3.57,
 "spawn":[0,0,5],"ceilingY":10.4,"parts":[
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

PRESENCE = [=[{"t":1760715600.31,"others":[
 {"id":"quest-1","name":"Judge","kind":"vr","x":1.5,"y":0,"z":-3.93,"yaw":0.3,
  "hands":[[0.71,4.32,-5.0],[2.32,4.46,-4.82]]},
 {"id":"web-7f3a19c2","name":"Maya","kind":"web","x":-3.57,"y":0,"z":2.86,"yaw":3.1}]}]=],
}
```

Multiplayer without anyone else: in the testing-mode dropdown pick **Server & Clients**, with 2 clients (up to 8 is
possible), and press Play. Check that both clients show the ghost, the scoreboard and the tag effects.

### 9.2 Things to verify in Studio before Saturday 10 AM

- [ ] 12,000 mock parts build without the server freezing (watch the server frame rate in the Developer Console), and
      clients stay at 60 fps.
- [ ] Switching rooms 5 times in a row leaves no leftover parts (check the Workspace part count).
- [ ] The ghost stays smooth with failure injection on, and the banner appears and clears.
- [ ] A player who joins in the middle of a round sees the right room, timer and scoreboard (attributes).
- [ ] The finale path on mocks: "Building" card → ready → "Measuring the room..." → Follow swaps you in under 10 s.

### 9.3 Transport test tonight (de-risks the biggest unknown)

Roblox does not document whether live servers can reach `*.trycloudflare.com`, or how large a response can be. Prove
both yourself in 15 minutes:

```bash
mkdir -p ~/dv-fixture/api && cd ~/dv-fixture
# save your SCENES fixture JSON as api/scenes (no extension)
python3 -c "import json; print(json.dumps({'sceneId':'big','name':'Big','studsPerMeter':3.57,'spawn':[0,0,5],'parts':[[i%50,0.5,i//50,1,1,1,120,104,90] for i in range(8000)]}))" > api/big
ls -l api/big                                        # about 300 KB
python3 -m http.server 8000
# second terminal:
cloudflared tunnel --url http://localhost:8000      # prints https://<random>.trycloudflare.com
```

Set that URL as `dejaview_base` (or `BASE_FALLBACK`), publish, and **join the live game from the Roblox app** (or use
Team Test). A Studio local playtest runs the server on your laptop, so it does not prove what Roblox's datacenter can
reach. Your server should print the decoded scenes and the part count of `/api/big` with the fetch time. If either
fails, tell Ojasva right away, so he can switch to a Cloudflare named tunnel on a real domain, or plan on `maxParts`
and `chunk`. To test POSTs too, write your own tiny mock server that returns `Fixtures.PRESENCE`.

### 9.4 Against the real server

From **Sat 10 AM** every endpoint answers on the LAN, so you can check every shape with curl from your laptop (below)
and compare it with your mock. Roblox servers cannot reach a LAN address, so the game itself stays on mock data until a
tunnel exists: Ojasva's early quick tunnel if he has one ready (around Sat 12 PM), otherwise the public `BASE` at
**Sat 4 PM**. Then set `dejaview_base`, flip `USE_MOCK = false` and test from the live game or Team Test.

```bash
BASE=http://<mac-lan-ip>:8788       # or the tunnel URL from Ojasva
KEY=<key from Ojasva's DM>          # never paste it into a script or the place
S=test-tw-local                     # a ready scene with a floor and bounds; Ojasva names others in the team chat

curl -s "$BASE/api/scenes" | python3 -c "import json,sys; print([s['id'] for s in json.load(sys.stdin) if s['status']=='ready'])"
curl -s "$BASE/api/roblox/$S/map" -H "x-dejaview-key: $KEY" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['studsPerMeter'], d['spawn'], len(d['parts']), d['parts'][0])"
curl -s -X POST "$BASE/api/roblox/$S/presence" -H "content-type: application/json" -H "x-dejaview-key: $KEY" \
  -d '{"players":[{"id":"rbx-1","name":"curl","x":4,"y":0,"z":0,"yaw":0}]}'
curl -s "$BASE/api/presence/$S"          # metres: rbx-1 should show x = 1.12 (4 / 3.57)
curl -s -X POST "$BASE/api/roblox/$S/event" -H "content-type: application/json" -H "x-dejaview-key: $KEY" \
  -d '{"type":"tag","by":"quest-1","target":"rbx-1"}'
```

Fake a VR player for 60 s, so you can test the ghost and tag with no headset. This uses the headset's own presence
endpoint, which is in **metres in the room frame** (floor at y = 0), exactly what the Quest sends:

```bash
python3 - "$BASE" "$S" <<'EOF'
import json, math, sys, time, urllib.request
base, scene = sys.argv[1], sys.argv[2]
for i in range(240):
    a = i * 0.05
    x, z = math.cos(a) * 1.5, math.sin(a) * 1.2
    yaw = math.atan2(math.sin(a) * 1.5, -math.cos(a) * 1.2)    # face the direction of travel
    body = {"id": "quest-1", "name": "Judge", "kind": "vr", "x": x, "y": 0, "z": z, "yaw": yaw,
            "head": [x, 1.6, z], "hands": [[x - 0.4, 1.2, z - 0.3], [x + 0.4, 1.2, z - 0.3]]}
    req = urllib.request.Request(f"{base}/api/presence/{scene}", json.dumps(body).encode(),
                                 {"content-type": "application/json"})
    urllib.request.urlopen(req).read()
    time.sleep(0.25)
EOF
```

You should see: the lobby says the judge is in that room, and the ghost circles the middle of the room at head height
(about 5.7 studs), hands at about 4.3 studs, always facing the way it moves. If it walks backwards or sideways, the yaw
convention is off somewhere: tell Ojasva with the numbers you see.

### 9.5 Together (Sat 4 PM to 10 PM)

1. Ojasva wears the headset (or uses the desktop viewer) in a sample room. You and Brianna are in the live game.
2. Check that the ghost faces the way the headset faces. If it is mirrored or rotated 90 degrees, the yaw convention is
   off: fix it in one place and tell Ojasva.
3. Coordinates: Ojasva stands in a corner in VR, you walk your avatar to the ghost's feet. Positions agree within
   0.3 m (about 1 stud).
4. Check that Seb's DeepSpace map shows your dots moving the same way as in Roblox.
5. The finale path: a new photo goes in through Seb's app; the room appears in your picker within 3 s of `ready`, the
   map loads, and Follow (or a click) puts you in it while the judge is there.
6. Run the full skit and finale with a timer, twice (Sat 10 PM). Note where the room-load time goes.

---

## 10. Fallbacks for the night

| Breaks | What happens / what you do |
| --- | --- |
| Tunnel down or Mac asleep | Banner "Reconnecting to Déjà View...", the room stays, the ghost fades, retries back off to 4 s and recover by themselves |
| Tunnel URL changed | Update `dejaview_base` in Creator Hub Configs (live in under 1 min); or use `SetTestingValue` in the server console for an instant change |
| Map endpoint slow or failing | The cached room from prefetch; otherwise a **baked room** (below); otherwise the fixture room |
| New room too heavy | Request `maxParts=3000`; the server sends a coarser version |
| Finale room never gets a map | Stay in the game-night room and say so; the judge's world still works in the headset |
| Headset dies mid-demo | The host toggles "Mock judge" on the HUD; the scripted ghost keeps the round going (`MockServer` VR path) |
| Roblox live servers have trouble | Studio Server & Clients test on your laptop (the server runs locally and still reaches the tunnel) |
| Everything | Your recorded 10 s clip |

**Baked rooms** (Saturday evening, once the demo worlds are frozen at 8 PM: game night, Fortnite, the backup photo
world):

1. Press Play in Studio (local playtest; Local Secrets are set) and let your loader build the room from the real server.
2. Switch to the Server view, select `Workspace.Room` and copy it (Ctrl/Cmd+C). Stop the playtest.
3. In edit mode, paste it into `ServerStorage.BakedRooms`, rename it to the scene id, then save and publish.
4. If loading fails, `MapBuilder` clones the baked copy into `Workspace` instead. This is instant and needs no network.
   Bake no more than 3 rooms of about 6,000 parts each, so the place file stays small.

The finale room cannot be baked (it does not exist until the judge sends the photo). That is why prefetch and the
"Measuring the room..." state matter.

---

## 11. Milestones

| When | Done means |
| --- | --- |
| **Fri night** | Studio installed, age check done, friends added, experience published Private with HTTP on, transport test passed (quick tunnel + 300 KB file) |
| **Sat 10 AM** | Mock mode: the room builds behind the loading screen; 12k-part stress measured; the mock ghost glides on 2 clients; tag works against it; picker, JOIN and Follow work on mocks |
| Sat 12 PM | Place id + join link sent to Seb and Ojasva; teammates join the live private server; Configs + Secrets set; curl shapes checked against the LAN server; first calls through Ojasva's early quick tunnel if he has one |
| **Sat 4 PM** | Real rooms from the public `BASE`; presence round-trips with the curl-faked VR player; events reach the server; audience opened (Public + Beta, or Playtesters); a phone joins via the link |
| Sat 8 PM | Real headset with Ojasva: the ghost moves with the judge, the headset sees your avatars and TAGGED. Demo rooms baked |
| **Sat 10 PM** | Full skit + finale run twice, timed: JOIN at 1:10, the round ends by 1:40, the finale room reached at 2:25 |
| Sun 2 AM | Third run; failure drills (kill the tunnel, kill the headset) done |
| **Sun 4 AM** | Freeze. Record a 10 s clip of your beats: JOIN, the ghost, a TAGGED moment, the winner card, hopping into the finale room |

## 12. Hand-off to Ojasva, and the rules

1. File → **Save to File As** → `DejaView.rbxlx` (XML).
2. Before sending, check that the key is not in it: `grep -c "<the key>" DejaView.rbxlx` must print `0`. The key lives
   only in Roblox Secrets.
3. Send: the `.rbxlx`, the experience link, who has Edit or Play access, the Config keys you use (`dejaview_base`,
   `round_seconds`), the secret's **name** (`dejaview_key`, not its value) and your fixture JSON. Ojasva files it under
   `integrations/roblox/`.
4. Tell him about any contract change immediately, in one message with an example JSON.

**Rules:** write all of your own code during the event (no prior scripts, no free models with scripts). Credit every
AI tool you used on Devpost, as the rules require. Credit Roblox-made assets and sounds too.

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
