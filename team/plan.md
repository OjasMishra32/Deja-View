# Déjà View: the plan

**Drop in a memory. Walk into it. Bring your friends.**

Two modes, nothing else:
- **Photo:** one photo becomes a world you walk into.
- **Video:** a still-camera video becomes a room with the real footage standing in it, in 3D, with sound.

Walk around in a Meta Quest 3S or a browser. Your job on one page: `START-HERE.md`. Wiring for every hop:
`contracts.md` (it wins any disagreement with a brief). Build details: `shivin.md`, `brianna.md`, `seb.md`.

## Every sponsor causes the next thing

No stickers. Each sponsor makes the next moment possible.

1. **The memory comes in through Seb's DeepSpace app ("Add a memory", DeepSpace storage).** The clip comes back as a
   world link with a Roblox link and a map link, so everyone can get in. (Photon is dropped: not a Devpost prize, and
   the bot did not work.) The link is one fixed domain (MLH GoDaddy Registry), so Roblox, the headset and the judges'
   phones never lose it.
2. **Gemini writes the world, then makes it interactive.** `/describe` writes the caption the world model uses to
   imagine everything the camera never saw. Inside the world, `/hotspots` pins floating labels on the things worth
   asking about, and you ask out loud (`/ask`) and the room answers in a voice.
3. **The GPU's speed makes the live finale possible.** A warm worker (HiPerGator, or Seb's Vultr A40) builds a world
   in seconds, so a judge can do it for real on stage.
4. **Reality check (for the host sponsor, Vobile, who protect real content).** One toggle tints every part of the
   world the AI imagined. What the camera captured stays untinted.
5. **Roblox turns every photo into a game.** Each Photo world also becomes a real Roblox place: a textured model of the
   room, not blocks. Friends join from the Roblox app on a Quest or a phone and play tag with the person in the headset.
   (Video memories stay in the headset and the browser.)
6. **DeepSpace remembers who was there and what they said.** Live presence and trails across headset, Roblox and web,
   and notes left inside the memory that pop up in the headset and stay for the next visitor.

Chain: **"Add a memory" → Gemini caption → GPU world → Gemini labels + voice → reality check → Roblox friends →
DeepSpace presence + notes → the judge does it live.**

**Capital One (Nessie) is Seb's optional side quest.** His design, nothing depends on it, the demo works without it.
It gets 15 seconds only if it is ready and good.

### What we enter on the Devpost (checked against the Devpost prize list)

- **Best Overall** (Vobile): automatic. The reality check is for them.
- **One specialized track** (the rules allow at most one): **Best Entertainment & Creative Technology Hack** (games,
  interactive media, storytelling). Best Use of AI/ML is the alternative. Ojasva makes the final call.
- **Big sponsor challenges, each doing real work:**

  | Challenge | Prize | Owner | What it causes in the demo |
  | --- | --- | --- | --- |
  | DeepSpace | $1,000 credits + $250 | Seb | "Add a memory" (storage), live map and trails (real-time), notes into the headset (data), sign-in |
  | Roblox Studio | $400 + Robux | Shivin | friends without a headset join the same room and play tag with the judge |
  | MLH Gemini | swag | Brianna | writes the caption the world model imagines from; labels; the room answers out loud |
  | MLH Vultr | M5Stack Tab5 | Seb + Ojasva | the A40 backup GPU that keeps the live finale live |
  | Capital One Nessie | $1,000 | Seb (optional) | his design; worth a real try now that the Photon time is free |

- **Smaller sponsors we can also win**, each with a real reason to exist:

  | Challenge | Owner | What it causes | Needs |
  | --- | --- | --- | --- |
  | MLH GoDaddy Registry (best domain) | Seb | one link that never changes, on the table card, the QR codes and the Devpost | the free MLH domain + a free Cloudflare account |
  | MLH Auth0 | Ojasva | once the link is public, signing in is what lets someone add a memory or drive the headset from the `/host` remote; strangers can still walk in | a free Auth0 tenant (no card) |
  | MLH Tiger Data | Ojasva | every position from the headset, Roblox and the web is stored as a time series, so a memory can be **replayed**: scrub back and watch everyone walk where they walked, plus a heatmap of where people stood | a free Tiger Cloud service |
  | Easy On the Eyes (UI/UX) | Ojasva | the Apple-style redesign of the site and the headset UI | nothing |
  | MLH DEV Writing Challenge ($100) | Ojasva | the build story, posted on DEV after submission | a DEV account |
  | MLH Solana (stretch, only if everything else is done) | Ojasva | each tag-round result written on Solana devnet as a public scoreboard | nothing (devnet only, no real money) |

- **Not entered:** Photon (not on the Devpost; dropped), Sperry Tech PlanIT (unrelated), Least Vibe Coded (we used
  AI tools and say so).

## Update (Sat ~4:50 AM): the real game night

Our own footage now carries the demo. The game-night memory is **`courts-foosball`**: the judge stands at the real
foosball table at the court while the two players play it in full 3D (pause and walk around them), with sound. Then
Shivin and Brianna, on a phone and a laptop, play foosball or ping pong in Roblox on that same table while the judge
watches from VR. `chess-match` and `kitchen-cooking` are the extra memories to show if there is time; `tilted-towers`
stays the "even a game becomes a place" beat. The beats below keep their timing; read "the game-night clip" as the
foosball clip.

## The demo: a staged skit, then "Now do it"

The skit uses worlds we built in advance and triggers them on cue, so it never waits. Everything shown is real
software doing real things; we only control the timing. Then the judge does it for real.

**Cast:** Ojasva (host, table laptop), Seb (drops the clip into his DeepSpace app), Shivin and Brianna (laptops: Roblox
players; Brianna leaves the note), the judge (Quest headset).

### What we film and capture (by Sat 2 PM; Ojasva runs it, everyone except Seb is in the clip)

- **The game-night clip (Video):** a staged group video-game session at the venue, filmed on the table iPhone (so
  demo mode recognises the exact file at 0:00). Phone propped up and completely still, 1.5 to 3 m away, landscape, 15 to 20 s
  with sound. A couple of seconds of the empty spot first (the room is built from it), then everyone sits down and
  plays, a last-second upset, everyone yelling. The game screen visible and readable in frame (a big results screen) so
  Gemini can read it. Snacks on the table, one obvious empty seat on the couch: Seb's. Film 3 takes, keep the best.
- **Optional extra clip:** ping pong. The players look great; the tiny fast ball may flicker.
- **The digital world (Photo):** a clean, HUD-free frame of real Fortnite gameplay. On a Mac: Xbox Cloud Gaming in a
  browser (xbox.com/play, Fortnite is free with a Microsoft account; GeForce NOW free tier as backup). On a PC or
  console: Replay mode (hide the HUD, free camera). Record with Cmd+Shift+5 at a scenic, calm spot, then take one wide
  screenshot (or a slow 10 s pan and pick the best frame).
- **A backup photo world:** one good room photo, built in advance, in case the live build is slow.

Our own footage leads; Fortnite comes second.

### The beats

| Time | Beat | What really runs |
| --- | --- | --- |
| 0:00 | Host: "We had a game night. Seb skipped it. He's about to find out what he missed." Seb drops the clip into his DeepSpace app from the table iPhone | Demo mode recognises the clip and replies at once with the thumbnail, the world link, the Roblox link and the map link |
| 0:15 | The judge puts on the Quest and is inside the game-night memory: the room, the team in 3D, the upset, the yelling, with sound | Déjà View viewer, Video |
| 0:40 | Floating labels pin onto the foosball table, the ping pong table, the chairs. The judge looks at the game and asks "who won?" The room answers out loud | Gemini `/hotspots`, `/ask` (audio in, speech out) |
| 1:00 | Host flips the reality check: the AI-imagined parts of the room tint | Reality check (Vobile) |
| 1:10 | Host: "and every photo is also a game." The host drops the judge into the Fortnite world; Shivin and Brianna join that same world in Roblox (a phone and a laptop) and play tag with the judge (the judge is "it"; rounds are 90 s, set to 25 s for the skit so it ends at about 1:40) | Roblox presence relay, tag events |
| 1:40 | On the table laptop, the DeepSpace map shows everyone moving live with trails. Brianna clicks a spot on the map and types "Seb would have dropped here first." It pops up in the headset as a sticky note | DeepSpace realtime, notes |
| 2:00 | **"Now do it."** The judge lifts the headset and snaps a photo on the table iPhone into Seb's "Add a memory" page | live path, Gemini `/describe` |
| 2:10 | While it builds, the host drops the judge into the Fortnite world (skip if the build is already done) | pre-built Photo world |
| 2:25 | Their world is ready: the card in Seb's app turns to "Walk in", the headset swaps into it, the room greets them, labels pop in. The same room appears in the Roblox picker and the DeepSpace gallery; Shivin hops in | warm GPU, Gemini `/narrate` + `/hotspots`, Roblox, DeepSpace |
| 2:45 | (Optional, 15 s) Seb's Capital One side quest, only if ready and good | Nessie |
| 3:00 | Close: "Every memory: shared, walkable, from one photo or one video." | |

Photo is guaranteed live (P0). Live Video is a stretch: only if a 15 s clip builds in under a minute.

**Demo mode:** Seb's "Add a memory" keeps a table of demo media SHA-256 hashes mapped to pre-built scene ids and
answers instantly. Everything else takes the live upload path. Every beat has a recorded 10 s
fallback clip. Phone hotspot is the network fallback. Full test plan: `contracts.md` section 13.

## Who builds what

| Person | Builds | Brief |
| --- | --- | --- |
| Ojasva | Server and viewer: Photo/Video worlds, presence relay, Roblox endpoints and map voxelizer, DeepSpace forwarder, notes relay, guide proxy, viewer pieces (Roblox ghosts, sticky notes, labels, voice button, narration, reality check, tag moments), public link, filming, the `/host` remote, the Apple-style redesign, Auth0 sign-in, Tiger Data replay, the DEV post, Solana (stretch) | `contracts.md` |
| Shivin | The Roblox experience: room loader, room picker (shows finale rooms too), presence, VR ghost, tag rounds, events | `shivin.md` |
| Brianna | Gemini only: `/describe`, `/hotspots`, `/narrate`, `/ask` | `brianna.md` |
| Seb | Vultr GPU (tonight), DeepSpace app (presence map, trails, notes, gallery, invites, "Add a memory"), the domain (MLH GoDaddy Registry) + Cloudflare tunnel; Capital One side quest (optional) | `seb.md` |

## Timeline

| When | Milestone |
| --- | --- |
| Fri night | Seb: Vultr A40 test deploy (then destroy), DeepSpace account (referral code first). Brianna: Gemini key works. Shivin: Studio, private place, HTTP on, building on mock data. Ojasva: LAN address posted |
| Sat 10 AM | Ojasva's endpoints answer on the LAN. Brianna's four endpoints work via curl. Shivin's room loader, picker, ghost and tag work on mock data. Seb's "Add a memory" uploads |
| Sat 2 PM | Game-night clip filmed, Fortnite frame captured |
| Sat 4 PM | Public https link live. Roblox on the real server. DeepSpace map and notes live. Gemini wired into the headset |
| Sat 8 PM | Demo worlds built and frozen (game night, Fortnite, backup photo world), labels checked. Guide running on the demo Mac |
| Sat 10 PM | Skit + finale run end to end twice, with a timer |
| Sun 2 AM | Third run; failure drills done |
| Sun 4 AM | Feature freeze; record a 10 s clip of every beat |
| Sun 8 AM | Submitted |

## Quality bar

- **One flow, live, on the table.** Every hand-off takes seconds and never needs a refresh or a restart.
- **Smooth:** positions are interpolated, nothing teleports, sounds land on cue.
- **One look (updated Sat early morning):** the site, the headset labels and notes, and Seb's DeepSpace app move to a
  clean Apple style: system font (SF Pro on Apple devices), white and `#F5F5F7` surfaces, iMessage blue `#007AFF`,
  no glow, no neon. Shivin's Roblox UI keeps the look he already built.
- **Fallbacks for every hop:** pre-built worlds, recorded clips, phone hotspot.

**Rules for everyone:** write all your own code during the event, and credit the AI tools you used on Devpost, as the
hackathon rules require.
