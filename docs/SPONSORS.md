# Déjà View: why each sponsor is in it

One sentence holds it together: **Déjà View turns the photos and videos a family already has into places they can walk
back into, together, and every sponsor does one real job in that.** The story we lead with is our teammate
Shivin's dad, who has struggled with Alzheimer's: the old places last longest, so we give them back.

Each section: what it does, why it matters, where a judge sees it, and whether it is live tonight. Add your own notes
under each one.

---

## Vobile (Best Overall): the reality check

- **What it does:** one toggle tints every part of a world the AI imagined; what the camera captured stays clean. It
  works by reprojecting every splat into the input camera and checking it against depth.
- **Why it matters:** Vobile protects real content. A world model fills in most of a room from one photo (only 14% to
  23% of a Tilted Towers world was in the screenshot), so an honest app has to show its seams. For someone whose
  memory is slipping, a made-up detail is worse than a gap: the family must always know what was really there.
- **See it:** in the headset (left Y) or "Reality check" on `/host`.
- **Live:** yes.
- **Your notes:**

## DeepSpace: how a memory gets in

- **What it does:** "Add a memory" in the DeepSpace app takes the photo or clip someone adds and hands it to our
  pipeline, which turns it into the world; the card comes back with the links to walk in.
- **Why it matters:** the family's memories start where they already share them. Nobody has to learn our tools: add a
  clip, get a place back.
- **See it:** Seb's DeepSpace app, "Add a memory".
- **Live:** Seb's app; our server builds what it hands over.
- **Your notes:**

## Roblox: everyone else comes in

- **What it does:** each real place is also a life-size Roblox room built from the same scan (block maps; the Game Lawn
  and the giant chess room built by hand from their measurements). The games are played on the real furniture: ping
  pong, foosball and giant chess. **Cross-play:** the headset player rallies on the real ping pong table against a
  Roblox player on a computer, with late hits allowed.
- **Why it matters:** the rest of the family doesn't need a headset. They join the same place from a laptop or phone and play
  with whoever is in the headset.
- **See it:** https://www.roblox.com/games/2942475849 (version 16) next to the headset.
- **Live:** yes.
- **Your notes:**

## MLH Gemini: the room understands itself

- **What it does:** writes the caption the world model imagines from, pins labels on what matters in the room,
  greets you, and answers spoken questions out loud ("who won?").
- **Why it matters:** a memory you can ask about. In a family memory the guide stays gentle, and with Memory Keys it
  only tells family the family stories.
- **See it:** the labels in any world; hold the button in the headset and ask.
- **Live:** yes (Brianna's guide on the Mac).
- **Your notes:**

## MLH Vultr (with HiPerGator): the worlds get built

- **What it does:** GPU work ran on a rented Vultr cloud GPU in parallel with UF HiPerGator, with the same worker code
  on each. A photo becomes a walkable world in about 10 seconds; a phone video becomes people in 3D in the room.
- **Why it matters:** speed is what makes it feel like magic: a judge can make a world live at the table. Two GPU
  sources also mean the finale doesn't depend on one class allocation.
- **See it:** the live build at the table; the GPU tile on `/host`.
- **Live:** yes.
- **Your notes:**

## MLH Auth0: memories stay in the family

- **What it does:** sign-in in front of everything that changes something (adding or rebuilding a memory, the `/host`
  remote, a tab). **Memory Keys** (Shivin): a memory has an owner; a private one opens only for people the owner lets
  in, a stranger can knock and the owner taps "Let in", and the guide knows who is asking.
- **Why it matters:** a family memory is private. The person with Alzheimer's and their family decide who walks in.
- **See it:** on the host laptop, `/capture`: claim `old-house-kitchen` and make it private; the judge signs in on a
  phone and knocks; tap "Let in" (`docs/memory-keys.md`).
- **Live:** yes (Shivin's tenant).
- **Your notes:**

## MLH Tiger Data: every visit remembered

- **What it does:** every position from the headset, Roblox and the browser (up to 5 a second per world) goes into a
  TimescaleDB hypertable with a one-second rollup and compression; Roblox moments go in beside it. The server answers
  replay questions: each visit (when, how long, who), everyone's paths over time, and a heatmap of where people stood.
- **Why it matters:** each memory keeps its own history. The family can see which places Dad goes back to most
  and where he lingers.
- **See it:** `/api/replay/<world>/sessions`, `/api/replay/<world>`, `/api/replay/<world>/heat`, and the tables in the
  Tiger Cloud console.
- **Live:** yes (Brianna's Tiger Cloud service; connected and recording).
- **Your notes:**

## MLH GoDaddy Registry (best domain): one link forever

- **What it does:** https://deja-view.photo is the site, the headset's address and Roblox's server, on the table card,
  the QR codes and the Devpost.
- **Why it matters:** one link that never changes, which anyone in the family can bookmark.
- **See it:** everywhere.
- **Live:** yes. (Check the domain qualifies for the challenge before entering.)
- **Your notes:**

## MLH DEV Writing Challenge: the story told

- **What it does:** the build story as a post on DEV, written by Ojasva after we submit.
- **Why it matters:** the Alzheimer's story and how we built it, for people who weren't in the room.
- **Live:** after submission.
- **Your notes:**

## Easy On the Eyes (UI/UX)

- **What it does:** the Apple-style redesign of the site and the headset UI: the landing, the gallery, the viewer's
  controls and cards.
- **Why it matters:** it has to be calm and simple for a parent with Alzheimer's, not just for gamers.
- **See it:** https://deja-view.photo
- **Your notes:**

---

## The track

We can enter one specialised track: **Best Entertainment & Creative Technology Hack** (games, interactive media,
storytelling) or **Best Use of AI/ML**. Your call.

- **Your notes:**
