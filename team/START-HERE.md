# Start here: what each of us does right now

This page is current and final. The long guides (`shivin.md`, `brianna.md`, `seb.md`) are being updated to match it; if
anything in them disagrees with this page, **this page wins** until they are refreshed.

**The product:** Déjà View. Two modes: **Photo** (one photo or game screenshot becomes a world you walk into, **and the
same world is a Roblox place** friends play on the Quest Roblox app or a phone) and **Video** (a still-camera video becomes
a room with the real footage standing in it in 3D; headset and browser only, not Roblox). Walk around in a Meta Quest 3S
or a browser.

**Now (Sat ~4 PM): the site is `https://deja-view.photo`, our own domain, permanent.** Use it everywhere: browser,
Quest browser, DeepSpace `baseUrl`, Roblox `dejaview_base`. The old `trycloudflare` link is only a backup.

Live on it:
- Worlds: Infinity Hall Game Lawn (`the-courts`), Giant chess (`chess-room`), the kitchen (`kitchen`, walkable
  along its whole strip), Tilted Towers, the Brick House apartment, and the old Pennsylvania house kitchen
  (`old-house-kitchen`, rebuilt from four listing photos).
- Video memories, with the people in full 3D: Foosball at the Game Lawn (`courts-foosball`) and Sebastian cooking
  (`kitchen-cooking`: fridge doors and the milk jug included). The chess match (`chess-match`) is next.

Who does what now, each in their own file's newest update:
- Seb: Roblox on his account, censor pass and gate, cooking rush (seb.md Updates 11 and 12).
- Shivin: product work only: automatic walk zones, listing photos to a home, one-command video memories, headset QA
  (shivin.md Updates 19 and 20).
- Brianna: turn the Gemini guide on first (brianna.md Updates 7 and 8).
- Ojasva: worlds, memories, the site and the server.

**Update 5 (Sat ~5:30 AM):** on the link now: `the-courts` (shown as Infinity Hall Game Lawn) and `brick-apartment`.
Still being built: `chess-room`, `kitchen`, `tilted-towers`, the three video memories, and the version 2 Roblox models
(the court first). New on `main`: the Roblox game stands you on a real floor at y = 0, lines the textured model up on
the server's box and sends everyone to the court when a room is closed; Brianna's guide reads clip frames, label hints
per world and checked notes for each memory. Next, one line each:
- **Shivin:** pull, Rojo sync, play-test `the-courts` (floor, walls, model line-up), publish: Update 11 in `shivin.md`.
- **Brianna:** key in, `npm install`, `npm test`, run the guide on the demo Mac, check the notes (who won the foosball?),
  tune labels: Update 5 in `brianna.md`.
- **Seb:** Roblox games on your own branch (real-physics ping pong at the court, then pool): Update 5 in `seb.md`.
- **Ojasva:** restart the live server so the new Roblox fields and clip captions go live; caption each memory with
  `bun run describe:clip <id>` once it is up.

**Update 4 (Sat ~4:50 AM):** five worlds now, all rebuilt from our own footage: `tilted-towers`, `brick-apartment`,
`the-courts` (ping pong + foosball), `chess-room` and **`kitchen`** (new: 36 photos). Three video memories put the people
in full 3D, walkable from every side even when paused: **`courts-foosball`** and **`chess-match`** are the game night we
actually played, and **`kitchen-cooking`**. The headset view now has the same Apple look as the site. Each guide has a
new box.

**Update 3 (Sat ~3 AM):** the worlds are now four rebuilt from real footage: `tilted-towers`, `brick-apartment`,
`the-courts` (our ping-pong and foosball patio) and `chess-room`, plus two video memories (`courts-foosball`,
`chess-match`) with the people in full 3D you can walk around, even paused. Each guide has an Update 3 box with your
next steps.

**The demo (a short skit, then a live finale):** "We had a game night. Seb skipped it." Seb drops the game-night video into his
Déjà View memory board (the DeepSpace app), the world comes back, the judge puts on the headset and is standing in it with sound. Gemini
pins labels on things and answers "who won?" out loud. A reality-check toggle tints what the AI imagined. Shivin and
Brianna join from Roblox and play tag with the judge. The DeepSpace map shows everyone live, and a note typed on the map
pops up in the headset. Finale: "now do it": the judge's own photo becomes a world they walk into.

Details for every connection: `contracts.md`. The whole plan: `plan.md`.

---

## Shivin: Déjà View in Roblox

**Update (Sat ~2 AM):** only Photo worlds go to Roblox, and each one now comes as a real textured model of the room
(`GET /api/roblox/<id>/model`, `.../model.glb`), not just blocks; it must play on the Quest Roblox app and on phones.
You join the judge in the **Fortnite** world (now `tilted-towers`; the old `fortnite-*` rooms are retired). Details:
Update 2 at the top of `shivin.md`.

Someone texts a photo of a real room, it becomes a 3D world, and you plus friends join that same room in Roblox and play
tag with the person in the VR headset.

**Tonight**
1. Roblox Studio → new place → publish it (private) → Game Settings → Security → **Allow HTTP Requests** on.
2. Build against **mock data** (the server endpoint is not public yet). A ModuleScript returns a map in exactly this shape:
   `{ studsPerMeter = 3.57, spawn = {x, y, z}, parts = { {x, y, z, sx, sy, sz, r, g, b}, ... } }`
   Each part: centre in studs (Y up), size in studs, colour 0 to 255.
3. Build in order:
   - **Room loader:** anchored Parts, built in batches so the game never freezes, behind a "Moving in..." loading screen.
   - **Room picker** board.
   - **VR ghost:** a head and two hands gliding along a fake path, smoothly interpolated.
   - **Tag rounds:** 90 s, the VR player is "it", tagged within 4 studs, scoreboard and sounds.
4. Look: dark UI, lime accent **#C6FF3D**, bold type.

**Real endpoints** (live Sat ~4 PM on a public https link):
- `GET /api/roblox/<sceneId>/map` returns the map shape above.
- `POST /api/roblox/<sceneId>/presence`, about 4 per second: send `{players:[{id, name, x, y, z, yaw}]}`, get back
  `{others:[{id, name, kind, x, y, z, yaw, hands?}], t}`. All in studs.
- `POST /api/roblox/<sceneId>/event`: `{type: "tag", by, target}` or `{type: "round", state: "start" | "end", scores}`.

**Deadlines:** working on mock data by Sat 10 AM; on the real server by Sat 4 PM.

---

## Brianna: Gemini, the AI brain

Gemini decides what the world looks like, then makes the room talk. **No Capital One for you.**

**Tonight**
1. Gemini API key: https://aistudio.google.com/apikey. Keep it in `.env`, never in code.
2. One small web server (Node, Bun or Python) with four endpoints. Only the Déjà View server calls it (no CORS needed):
   - `POST /describe {image}` returns `{caption}`: one or two sentences describing the place for a world generator
     (layout, materials, light, what is likely just outside the frame; no people). This text decides what the AI imagines
     behind you.
   - `POST /hotspots {image, scene}` returns `{hotspots:[{label, x, y, blurb}]}`: the 3 to 6 most interesting things in
     the shot; `x`, `y` are 0 to 1 positions in the image. The viewer pins them as floating labels in 3D.
   - `POST /narrate {image, scene}` returns `{answer, speech}`: a funny one-line welcome when someone enters.
   - `POST /ask {image, audio | question, scene, history}` returns `{question, answer, speech, hotspot?}`. `audio` is the
     spoken question as a webm data URL (Gemini understands audio directly). `speech` is the answer as Gemini text-to-speech
     audio, returned as a WAV data URL.
3. Answers: one or two short spoken sentences, specific to the image, a little funny; **under 2 s** for `/ask`.
4. Test with curl on room photos and a screenshot of a gaming setup (the skit is a game night).

**Deadline:** all four endpoints working via curl by Sat 10 AM; wired into the headset by Ojasva Saturday afternoon.

---

## Seb: Vultr, DeepSpace, the domain

How memories get in, and who is in them.

**Update (Sat early morning):** Photon is not a prize on the Devpost and the bot is not working, so it is dropped.
New: **"Add a memory"** in the DeepSpace app and a **free domain**
(MLH Best Domain Name from GoDaddy Registry) that gives the whole team one link that never changes. Details: the update
at the top of `seb.md`.

**Right now (30 min)**
1. **Vultr:**
   - Get the free $100 code (`mlh.link/vultr-discover` or an MLH coach), create the account, Billing → Gift Code.
   - Test-deploy one **Cloud GPU, NVIDIA A40 48 GB, New Jersey** (or Los Angeles). Those are the only places with enough
     GPU memory. Ubuntu.
   - **Destroy it right away**: stopped instances still bill.
   - Tell Ojasva "Vultr OK" or exactly what failed.
2. **DeepSpace:** open the referral link and enter **SWAMPHACKS2026 before creating the account** (otherwise the free
   credits are lost). Use Node 24.

**Then build**
- **Text-a-memory bot (Photon): dropped.** Its two pieces move into "Add a memory" below:
  - **Demo mode:** a table of known demo clips (by file hash) that maps to pre-built scene ids, so it answers at once.
  - **Live path:** upload to `POST /api/scenes` (`mode=photo` or `mode=video`, `name`, `files`), watch
    `GET /api/scenes/<id>` until `status` is `ready`, then show the thumbnail and the `/view?scene=<id>` link.
- **DeepSpace app** (`npm create deepspace@latest`):
  - **Sign-in** and a **gallery** of memories from `GET /api/scenes`.
  - A **live top-down map** of who is inside a memory. The Déjà View server pushes positions to your
    `POST /api/ingest` (header `X-DejaView-Key`, body `{sceneId, t, people:[{id, name, kind, x, y, z, yaw}]}`,
    metres, Y up, about 4 per second).
  - **Notes inside the memory:** click a spot on the map, type a note; it appears floating in the headset. Store notes
    as `{id, sceneId, author, text, x, y, z, createdAt}`. The Déjà View server reads `GET /api/notes?sceneId=<id>` and
    forwards headset-made notes to `POST /api/notes` (same header).
  - **"Add a memory"** (new): take or pick a photo or video, save it in DeepSpace storage, send it to
    `POST /api/scenes` from your worker (demo mode: a known clip links its pre-built scene), and show the card building
    live. This is how the clip comes in during the skit and how the judge's photo comes in at the finale.
- **Domain** (new, MLH GoDaddy Registry): free with the MLH offer (do not pay), DNS on a free Cloudflare account, a
  Cloudflare tunnel named `dejaview` pointing at `localhost:8788`; send Ojasva the tunnel token privately.
- **Capital One (Nessie): optional, your idea, only after the rest works.** Nothing depends on it.

**Deadlines:** Vultr tonight; the domain answering by Sat 12 PM; the DeepSpace map, notes and "Add a memory" by Sat
4 PM.

---

## Everyone

- Point your coding agent at this page, your guide in `team/`, and `team/contracts.md`.
- Write your own code (it must be written during the event) and list the AI tools you used on Devpost, as the rules require.
- Full demo run Sat 10 PM; feature freeze Sun 4 AM; submission Sun 8 AM.
