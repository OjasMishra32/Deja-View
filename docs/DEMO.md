# Déjà View: the 3-minute demo

A short skit with worlds we built in advance and trigger on cue, followed by "now do it", where the judge makes a
world for real. Everything shown is real software doing real things. The only thing we control is the timing.

The cast below is by role. Who plays which role is in [`team/plan.md`](../team/plan.md).

| Role | Where | Has |
| --- | --- | --- |
| **Host** | Table laptop | The server, a terminal with the cue commands below, the fallback clips |
| **No-show** (the "Seb" of the skit) | Off to the side | The table iPhone, signed in to the DeepSpace app on "Add a memory" |
| **Player 1** | Laptop | Roblox, in the lobby |
| **Player 2** | Laptop | Roblox, plus the DeepSpace map for the note |
| **Judge** | Standing at the table | The Quest 3S |

The DeepSpace map runs full screen on the table laptop the whole time.

---

## The script

| Time | Who | What happens | What really runs |
| --- | --- | --- | --- |
| **0:00** | Host | *"We had a game night. Seb skipped it. He's about to find out what he missed."* | |
| | No-show | Drops the game-night clip into "Add a memory" in the DeepSpace app | DeepSpace demo mode: the clip's SHA-256 maps to the pre-built world, so the card comes back at once with the thumbnail, the world link, the Roblox link and the map link |
| **0:15** | Judge | Puts on the Quest and is standing in the game-night memory: the room, the team in 3D, the upset, the yelling, with sound | Viewer, Video world |
| | Host | *"Walk around. Go sit in his seat."* | |
| **0:40** | Judge | Labels pop onto the screen, the controllers, the snacks. Looks at the screen, holds **X** and asks *"who won?"* The room answers out loud | Gemini `/hotspots` (stored ahead of time), `/ask` with audio in and speech out |
| **1:00** | Host | Flips the reality check: the parts the AI imagined tint, the captured parts stay clean. *"Everything tinted, the camera never saw."* | Reality check (host cue, or the judge presses **Y**) |
| **1:10** | Players 1 + 2 | Press JOIN and show up in the headset as Roblox ghosts. A tag round starts with the judge as "it" (25 s for the skit). The judge reaches out and tags someone: TAGGED, then the winner card | Roblox presence relay at 4 Hz, tag and round events over `/ws` |
| **1:40** | Player 2 | On the DeepSpace map, everyone is moving live with trails. Clicks the couch and types *"Seb's seat. He was too scared to show up."* It pops up in the headset as a sticky note | DeepSpace presence push, notes relay (2 s poll, then pushed over `/ws`; target under 2.5 s) |
| **2:00** | Host | **"Now do it."** The judge lifts the headset and snaps a photo on the table iPhone into "Add a memory" | DeepSpace live path, `POST /api/scenes`, Gemini `/describe` |
| **2:10** | Host | While it builds, drops the judge into the Fortnite world (skip this if the build has already finished). The judge presses Enter VR when it appears | Load cue, follow mode, pre-built Photo world |
| **2:25** | Everyone | Their world is ready: the card in the DeepSpace app turns to "Walk in", the headset opens it (the judge presses Enter VR again, about 5 s), the room greets them, labels pop in. The same room appears in the Roblox picker and the DeepSpace gallery, and Player 1 hops in | Warm GPU worker (about 10 s), follow mode, Gemini `/narrate` + `/hotspots`, Roblox map built in under 2 s |
| **2:45** | No-show | *(Optional, 15 s, only if ready and good)* the Capital One side quest | Nessie |
| **3:00** | Host | *"Every memory: shared, walkable, from one photo or one video."* | |

Photo is the guaranteed live beat. Live Video is a stretch and only happens if a 15 s clip builds in under a minute.

**Q&A answers to have ready.** "How much was imagined?" From one OG Tilted Towers screenshot, only 14% to 23% of
each world was in the picture. "How fast?" 5 to 7.5 s of generation on an RTX PRO 6000, about 10 s on a warm
worker. "Is that real footage?" Yes: it's the phone video, with per-frame depth, standing in a generated room.

---

## Fallback for every beat

Rule: if a beat misses its target, say so in one line and move on. Never debug on stage.

| Time | If this happens | Do this |
| --- | --- | --- |
| 0:00 | The card doesn't come back within 3 s | Keep going: the skit doesn't depend on it, because the world is already loaded on the Quest. If the app is down, the host shows the world from the Déjà View gallery |
| 0:15 | The video doesn't play, or there's no sound | Judge presses **A** (play/pause). Still nothing: the host plays the recorded 10 s clip |
| 0:40 | No labels | They are stored ahead of time. If they still don't appear, skip them and go straight to the question |
| 0:40 | No answer, or the guide is down | Ask once more. If the answer comes back as a caption with no voice, read it out loud. Otherwise play the recorded clip |
| 1:00 | The host cue doesn't arrive | The host says *"press Y on your left controller"* |
| 1:10 | No ghosts in the headset | Players rejoin from the picker. Still nothing after 10 s: play the recorded clip and keep talking. If the tunnel died, Roblox shows a banner and recovers by itself once it's back |
| 1:40 | The note doesn't pop up in the headset | Wait the full 2.5 s, then type it again. Notes that already exist stay in the headset even if DeepSpace drops. Only use the mock map if the host says out loud that it's a mock |
| 2:00 | The photo doesn't go in through "Add a memory" | Upload it on the table laptop instead: **Make one**, Photo (the `/capture` page). A Quest in follow mode still opens the new world when it is ready |
| 2:10 | The Fortnite drop doesn't load | Send the load cue again. Still nothing: exit VR from the Quest menu, open the Fortnite world from the gallery, press Enter VR (about 5 s) |
| 2:25 | The build takes longer than 30 s | Say so honestly, load the backup photo world (built earlier), or show the recorded finale clip |
| 2:25 | The headset doesn't open the new world on its own | Send a load cue with the new id, or do the same as 2:10: exit VR, open the new world (it's at the top of the gallery), Enter VR |
| 2:45 | The side quest isn't ready | Skip it. Nothing depends on it |
| Any | The Wi-Fi dies | Everyone switches to the phone hotspot. A Quest on USB (`adb reverse`) keeps working, and a Quest on the LAN keeps the world it already loaded |
| Any | The server restarts | Presence comes back on its own within a few seconds (viewers keep posting and the socket reconnects). Nobody refreshes anything |

**Cues from the host laptop.** Open `/host` on the demo Mac (`http://localhost:8788/host`, or
`https://localhost:8787/host`): it shows the GPU, the guide, DeepSpace, the public link, the worlds and who is in the
open world, and sends the cues. A Quest opened with `&follow=1` obeys them. The same cues from a terminal on that Mac
(requests from it need no key):

```bash
cue() { curl -s -X POST localhost:8788/api/host/cue -H 'Content-Type: application/json' -d "$1"; echo; }
cue '{"action":"reality","on":true}'                         # 1:00 tint what the AI imagined
cue '{"action":"reality","on":false}'
cue '{"action":"load","sceneId":"fortnite-tilted-night"}'    # 2:10 drop into the Fortnite world
cue '{"action":"labels","on":false}'                         # hide labels (true shows them)
```

`bun run https` serves plain HTTP on `:8788` next to https on `:8787` (same process, same data); with only `:8787`,
use `https://localhost:8787` and `curl -sk`. Opening another world reloads the viewer, so the headset leaves VR and the
judge presses Enter VR again (about 5 s). Rehearse that moment. Every ready world has its floor plan
(`world.topdown`, `topdown.jpg`) for the DeepSpace map: the server bakes it with the Roblox map, within seconds of
ready.

---

## Pre-demo checklist

### An hour before

- [ ] **Quest 3S** and both controllers charged. Volume up, lenses wiped, guardian drawn around the table area.
- [ ] **Secure origin for the Quest**, either:
  - Wi-Fi: `bun run cert` (again if the Mac's IP changed) then `bun run https`, with the certificate accepted once
    in the Quest Browser, or
  - USB: with `bun run https` running, `adb reverse tcp:8788 tcp:8788`, then `http://localhost:8788` on the Quest.
    This survives bad Wi-Fi.
- [ ] **The server runs as `bun run https`, never `bun run dev` or `bun --hot`.** It runs without hot reload: with
      hot reload, a server restart, a Wi-Fi blip or a Quest that slept reloads every open page and drops the judge
      out of VR. `bun run https` starts https on `:8787` (the Quest) and plain HTTP on `:8788` (teammates, curl, the
      tunnel), on the same data.
- [ ] Microphone permission granted for the site on the Quest (hold **X** once and allow it).
- [ ] **Warm GPU worker started:** `hpg/tw.sh start` on HiPerGator ([`docs/SETUP.md`](SETUP.md) has the one-liner
      from the Mac). A cold model load takes about 6 minutes. `hpg/tw.sh status` should say `idle`.
- [ ] **Demo worlds built and frozen:** game night (Video), the Fortnite world (Photo; `fortnite-tilted-night` or
      `fortnite-brick-house`), and a backup photo world. Labels checked in each one, a good `thumb.jpg` on game night.
- [ ] **DeepSpace demo table** holds the game-night clip's SHA-256 as the app receives it from the table iPhone (send
      it once in rehearsal and check that it hits).
- [ ] **Real teammate services or mocks:** decide now, not on stage.
  - Real: server env has `GUIDE_URL`, `GUIDE_KEY`, `DS_URL`, `DS_KEY`, `DV_KEY`. Check
    `curl -s localhost:8788/api/guide/health` and that a note typed on the DeepSpace map shows up in a desktop viewer.
  - Mocks (rehearsal only): see [`docs/SETUP.md`](SETUP.md#the-mocks). If one ever reaches the stage, say so.
- [ ] **Public link up:** `bun run tunnel`, URL posted in the team chat, and the Roblox base and DeepSpace base
      updated if the hostname changed.
- [ ] **Phone hotspot** ready, and everyone knows its name and password.
- [ ] **Recorded 10 s fallback clip for every beat** on the table laptop, in order, one click away.

### Ten minutes before

- [ ] Send one photo through the live path and time it. Fix the slowest hop first.
- [ ] Game-night world open on the Quest (`/view?scene=<id>&follow=1&name=Judge`), paused at the start, headset on the
      table.
- [ ] Both players in the Roblox lobby with the game-night room already built. Tag round set to 25 s.
- [ ] DeepSpace map full screen on the table laptop, Player 2 signed in, rehearsal notes deleted.
- [ ] The table iPhone charged, unlocked, signed in to the DeepSpace app on "Add a memory", with the clip ready to
      send.
- [ ] Host has the beats on a card and a timer running.

### After

- [ ] `hpg/tw.sh stop`. The class shares two GPUs.
- [ ] Delete rehearsal notes before the next table comes by.
