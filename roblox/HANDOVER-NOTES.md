# Overnight notes for Shivin (Sat Oct 17)

Live game: **version 58** published, place id 106038900865360. Everything below is pushed to `shivin/roblox`
(Ojasva merges it into `main`).

## ⚠️ ~8:50 AM: Studio was removed from Team Create; new portal scripts

- My Studio got **"You have been removed from this Team Create session"** while I was inspecting the place. I didn't
  rejoin, in case a teammate did it on purpose. Reopen Deja View in Studio when you're up (and reconnect Rojo).
- Not published because of that: **Seb's latest ping pong tuning** (merged into `shivin/roblox`, his 10 physics tests
  pass under Lune, and it ran at the court in Studio with no errors). Publish after you reopen.
- The startup audit now flags two scripts that aren't ours: `Workspace.Portal.Portal.Screen.Spin` and
  `ServerStorage.PortalTemplate.Screen.Spin`, plus a new `ServerStorage.OriginalPortalBackup`. Someone is building a
  portal from the **Toolbox free model** "PortalTemplate". **Open `Spin` and read it before you publish**: if it is
  more than a few lines rotating the Screen part (anything with `require(<number>)`, `getfenv`, `loadstring`,
  `HttpService`, `MarketplaceService`, `InsertService` or long scrambled text), delete the whole portal and tell the team.

## ⚠️ Security: read this first

During one play-test (~5:33 AM) a fake **"Something went wrong with this game"** screen appeared, telling the developer
to paste code into Studio's command bar: `game:GetObjects('rbxassetid://114706280708394')…` plus turning on HTTP.
**That is a known Roblox backdoor scam. Never run it.** It came from a `Credits` ScreenGui + LocalScript that was not
ours. It appeared while a teammate's **Team Create draft scripts** were loaded; right after, Studio reloaded the place
and it was gone. I didn't run anything and didn't delete anyone's work.
- The game now **audits itself at startup**: every script that isn't ours is listed in the Output with its full path.
  The place audits clean now (only Roblox's own player scripts).
- `ServerStorage/PortalTemplate` is a **Toolbox free model** ("AJTowerExp…" meshes) that someone added. It has no
  scripts, but free models are how backdoors get in. Ask the team who added it, and tell everyone: **no Toolbox models
  with scripts**, and don't run anything a pop-up asks you to paste.
- A player named **VvortexX56** was in the live game's court room. Check it's a teammate.

## New since ~7:30 AM (Ojasva's Update 12), version 58

- **Real table and board positions** now come from the server. FOOSBALL now plays **on the real foosball table** at the
  Game Lawn: 8 rods like a real table, scaled to its 4.2 × 2.5 studs, players on the long sides (◀ pull, ▶ push).
  Bot vs bot played a full game to 5-4 there.
- **Chess:** reads the board from the chess-room map and faces the right way now (Ojasva caught a 90° error).
  **But the chess-room textured model looks shifted from the board** (screenshot
  `roblox/screenshots/chess-room-board-offset.jpg`): the server's board centre (-1.45, -10.5) matches the dark
  squares in the block map (-2.2, -10.6), so the game board is right in the map frame; the model was moved by
  (-3.23, 0, -5.28) when aligned. **Tell Ojasva:** likely the chess-room model's alignment (the court lines up fine).
- **game.result** reports (the new contract for replay / scoreboard / Nessie) now go out from ping pong, foosball,
  chess and tag.
- **Seb's real-physics ping pong** is merged and running on the real court table ("hold to charge"). Tell Seb one bug:
  `PingPong.luau` line ~528 calls `launch(other(side), p0, flight, aim)` where `flight` and `aim` don't exist (only
  inside the branches above), so a hit that is neither camera-aimed nor a VR swing errors. I didn't touch his file.
- New v2 room models: the court (91874647541773) and Brick House apartment (96179943812932) load; chess-room
  (122387814565130) too.

## New since ~6 AM (Ojasva's Update 11, Seb's Roblox guide), version 53

- **The real court is in Roblox.** `the-courts` now has its textured model, aligned by Ojasva's new code, unlit so the
  photo colours show, with its own 360° skybox. Screenshots: `roblox/screenshots/the-courts-textured-model.jpg` and
  `the-courts-pingpong-on-real-table.jpg`.
- **Ojasva edited the game code himself** (Update 11: real floor at y = 0, model alignment, closed rooms). He had no way
  to run it; I ran it first in Studio: it works, no errors. Tell him.
- **Lighting:** his server-side unlit lighting would also darken the lobby for everyone; it now stands down
  (`Config.SERVER_UNLIT = false`) and the per-player version handles it. Mention this to him.
- **PING PONG now plays on the real table** at the Game Lawn: I found it in the block map (blue top, 9.8 × 5.4 studs,
  45°). The foosball table couldn't be found by colour, so FOOSBALL still drops in front of the host until `features`.
- **Seb is building real-physics ping pong and pool** in his own files on `seb/roblox-games` (team/seb.md, Update 5).
  He'll ask you to merge his branch at checkpoints; you merge into main and publish. Already done for him: a `pool`
  hall-of-fame column, the court table numbers, and your PING PONG button stops his game if it's up. Still to agree
  with him: which ping pong the court table opens by default (his proposal: his once it passes the afternoon checkpoint,
  yours stays on the host bar for phones).

## New since ~5 AM (Ojasva's Updates 9-10), version 40

- **Unlit textured rooms + skybox** (Update 10): rooms with a textured model show the photo's colours as they are, and
  the world's 360° sky when the server sends it; the lobby keeps the normal look. Not seen yet: no listed room has a
  model right now (the server's scene list is just the court, brick apartment and greyscale room).
- **Arrival animation:** the textured room rises into place around you. Also waiting on a model to be seen.
- **A game per world**, host buttons: **HIDE & SEEK** (apartment), **FLOOR IS LAVA** (Tilted Towers), **COOKING RUSH**
  (kitchen). Lava and cooking tested on the court; hide and seek needs 2 players or the judge.
- Host panel is two columns on normal screens (it has 15 buttons now). Per-world checklist is in `roblox/README.md`.

## New since ~4:50 AM (Ojasva's Updates 6-8)

- **Real textured rooms are live.** Tilted Towers now shows Ojasva's textured model (asset 105761651577283) instead
  of blocks; the blocks are invisible collision underneath. Screenshot: `roblox/screenshots/tilted-towers-textured-model.jpg`
  (Ojasva asked for one: send it to him). Brick House and the painted bedroom also have models; **the court, kitchen
  and brick apartment don't yet**, so they still show blocks until their models pass his check.
- **The court boots first** and is pinned at the top of the picker (Update 8: the best demo moment).
- **Rematch:** press CHESS BOARD / PING PONG / FOOSBALL again to reset that game in place.
- **Hall of fame** on the lobby's left wall (top 5 per game, saved across sessions) and **in-game badges**
  (Walked into a memory, Tag with the judge, Checkmate, 21 at the court).
- **First-join controls card** (phone / keyboard / Quest), once per player.

## Done and tested in Studio

| Piece | How to use it | Tested |
| --- | --- | --- |
| Live server | Loads Tilted Towers from Ojasva's public link. If the configured link is dead it switches to the built-in one by itself | yes |
| Finer blocks | 12,000-part rooms (blocks a third smaller), Future lighting | yes |
| Giant chess | Host panel → **CHESS BOARD**. Tap a piece, tap a lime square. First to touch a colour plays it | rules: perft-exact; scripted scholar's mate through the click handlers → checkmate |
| Ping pong | Host → **PING PONG**. Stand at an end, press **HIT** (or E / Quest trigger) after the bounce. First to 7; a bot covers an empty end | full game to 7 vs the bot |
| Foosball | Host → **FOOSBALL**. Stand at an end, hold ◀ ▶ (Z / X) to slide your rods, **KICK** (C) | bot vs bot full game to 5-3 |
| Labels + Hunt | Labels appear when the server has them (currently empty); host → **START HUNT** | with mock labels |
| Notes | **NOTE** button; reading works, posting shows "Notes are offline" until Seb's DeepSpace is connected | yes |
| Judge avatar | R15 person driven by the headset's head and hands | with the scripted fake judge |
| BIG SCREEN, New room unlocked | Host toggle / automatic banner with JOIN | yes |

## Not done / waiting on someone

- **Sounds per world** (Update 6 item 4) need Roblox-made audio picked from the Creator Store; I can't browse it
  reliably from here. Pick a few and put their ids in `Theme.Sounds`, or tell me which ones.
- **Replay** (Update 6 item 6) waits for Ojasva to say Tiger Data is live.
- **HUD in the headset's new light Apple look** (Update 8, optional) not done.

- **Court model and table positions:** `the-courts` is on the server but has no textured model or `features` yet, so
  the games are dropped in front of the host (one button each). When `features` arrive they snap to the real table.
- **chess-room** isn't on the server yet.
- **Returning a ping pong ball by hand**, and moving chess pieces by real clicks, were not exercised (Studio was in the
  background); the code paths underneath are tested.
- **Phones:** 12,000-part rooms may be heavy on a phone. If it stutters, add a Number config `max_parts` = 6000 in
  Creator Hub → Configs (no republish needed).

## Things only you can do

0. Send Ojasva the Tilted Towers screenshot. Optional: archive the 4 duplicate models he listed in Update 8
   (120627213500145, 137210308273579, 113019081409529, 75220212245793) in the Creator Dashboard.

1. Join the live game on your **phone** and check frame rate in Tilted Towers (see above).
2. Ask Ojasva to open `/view?scene=fortnite-tilted-night` while you're in the game, to see the real judge avatar.
3. Confirm your `dejaview_base` config in Creator Hub shows the current link (or delete it; the game no longer needs it).
4. Nothing to import by hand: the server uploads each room's model to your account and the game loads it by asset id.
5. Devpost clips (Update 4 item 9): 10 s each of joining a world, a tag, chess / ping pong / foosball, labels, a note.
