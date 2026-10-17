# Déjà View: the plan

**Drop a memory in the group chat. Walk into it. Bring your friends.**

Two modes, nothing else:
- **Photo:** one photo becomes a world you walk into.
- **Video:** a still-camera video becomes a room with the real footage standing in it, in 3D, with sound.

Wiring for every hop: `contracts.md` (it wins any disagreement). Your build details: `shivin.md`, `brianna.md`, `seb.md`.

## Every sponsor causes the next thing

No stickers. Each sponsor makes the next moment possible.

1. **Photon (iMessage group chat) starts the memory and fills the room.** A clip dropped in the group chat comes back
   as a world link in the same thread, with a Roblox link and a map link, so everyone in that chat can get in.
2. **Gemini writes the world, then makes it interactive.** `/describe` writes the caption the world model uses to
   imagine everything the camera never saw. Inside the world, `/hotspots` pins floating labels on the things worth
   asking about, and you ask out loud and the room answers in a voice.
3. **The GPU's speed makes the live finale possible.** A warm worker (HiPerGator, or Seb's Vultr A40) builds a world
   in seconds, so a judge can do it for real on stage.
4. **Reality check (for the host sponsor, Vobile, who protect real content).** One toggle tints every part of the
   world the AI imagined. What the camera captured stays untinted.
5. **Roblox lets friends without a headset be there.** The same room becomes a Roblox map. Friends join from laptops
   and play tag with the person in the headset.
6. **DeepSpace remembers who was there and what they said.** Live presence and trails across headset, Roblox and web,
   and notes left inside the memory that pop up in the headset and stay for the next visitor.

Chain: **group chat → Gemini caption → GPU world → Gemini labels + voice → reality check → Roblox friends → DeepSpace presence + notes → the judge does it live.**

**Capital One (Nessie) is Seb's optional side quest.** His design, nothing depends on it, the demo works without it.
It gets 15 seconds only if it is ready and good.

## The demo: a staged skit, then "Now do it"

The skit uses worlds we built in advance and triggers them on cue, so it never waits. Everything shown is real
software doing real things; we only control the timing. Then the judge does it for real.

**Cast:** Ojasva (host, table laptop), Seb (drops the clip in the group chat), Shivin and Brianna (laptops: Roblox
players, Brianna leaves the note), the judge (Quest headset).

### What we film and capture (Sat by 2 PM, Ojasva runs it, everyone except Seb is in the clip)

- **The game-night clip (Video mode):** a staged group video-game session at the venue. Phone propped up and
  completely still, 1.5 to 3 m away, landscape, 15 to 20 s with sound. Start with a couple of seconds of the empty
  spot (the room is built from it), then everyone sits down and plays, a last-second upset, everyone yelling. The game
  screen must be visible and readable in frame (big results screen) so Gemini can read it. Leave one obvious empty
  seat on the couch: Seb's. Film 3 takes and keep the best.
- **Optional extra clip:** ping pong. The players look great; the tiny fast ball may flicker.
- **The digital world (Photo mode):** a clean, HUD-free frame of real Fortnite gameplay. On a Mac: Xbox Cloud Gaming
  in a browser (xbox.com/play, Fortnite is free with a Microsoft account; GeForce NOW free tier as backup). On a PC or
  console: Replay mode (hide the HUD, free camera). Record with Cmd+Shift+5 at a scenic, calm spot, then take one wide
  screenshot (or a slow 10 s pan and pick the best frame). Our own footage leads; Fortnite comes second.

### The beats

| Time | Beat | What really runs |
| --- | --- | --- |
| 0:00 | Host: "We had a game night. Seb skipped it. He's about to find out what he missed." Seb drops the clip in the group chat | Photon bot recognises the pre-registered demo clip (demo mode) and replies at once with the thumbnail, the world link, the Roblox link and the map link |
| 0:15 | The judge puts on the Quest and is inside the game-night memory: the room, the team in 3D, the upset, the yelling, with sound | Déjà View viewer, Video mode |
| 0:40 | Floating labels pin onto the screen, the controllers, the snacks. The judge points at the screen: "who won?" The room answers out loud | Gemini `/hotspots`, `/ask` (audio in, speech out) |
| 1:00 | Host flips the reality check: the AI-imagined parts of the room tint | Reality check (Vobile) |
| 1:10 | Shivin and Brianna join as Roblox avatars and play tag with the judge | Roblox presence relay, tag events |
| 1:40 | On the table laptop, the DeepSpace map shows everyone moving live with trails. Brianna clicks the couch and types "Seb's seat. He was too scared to show up." It pops up in the headset as a sticky note | DeepSpace realtime, notes |
| 2:00 | **"Now do it."** The judge lifts the headset, snaps a photo on the table iPhone (or texts one of their own) into the group chat | Photon live path, Gemini `/describe` |
| 2:10 | While it builds, the host drops the judge into the Fortnite world (skip if the build is already done) | pre-built Photo world |
| 2:25 | Their world is ready: the bot replies, the headset swaps into it, the room greets them, labels pop in. The same room appears in the Roblox picker and the DeepSpace gallery; Shivin hops in | warm GPU, Gemini `/narrate` + `/hotspots`, Roblox, DeepSpace |
| 2:45 | (Optional, 15 s) Seb's Capital One side quest, only if ready and good | Nessie |
| 3:00 | Close: "Every memory: shared, walkable, from a group chat." | |

Photo mode is guaranteed live (P0). Live Video is a stretch: only if a 15 s clip builds in under a minute.

**Demo mode:** the bot keeps a table of demo media SHA-256 hashes and keywords (`#dejaview gamenight`) mapped to
pre-built scene ids and replies instantly. Everything else takes the live upload path. Every beat has a recorded 10 s
fallback clip. Phone hotspot is the network fallback.

## Who builds what

| Person | Builds | Brief |
| --- | --- | --- |
| Ojasva | Server and viewer: Photo/Video worlds, presence relay, Roblox endpoints and map voxelizer, DeepSpace forwarder, notes, guide proxy, viewer pieces (ghosts, sticky notes, labels, voice button, narration, reality check, tag moments), public link, filming | `contracts.md` |
| Shivin | The Roblox experience: room loader, room picker (shows finale rooms too), presence, VR ghost, tag rounds, events | `shivin.md` |
| Brianna | Gemini only: `/describe`, `/hotspots`, `/narrate`, `/ask` | `brianna.md` |
| Seb | Vultr GPU (tonight), Photon group-chat bot (demo mode + live path), DeepSpace app (presence map, trails, notes, gallery, invites); Capital One side quest (optional) | `seb.md` |

## Timeline

| When | Milestone |
| --- | --- |
| Fri night | Accounts and keys done (Gemini key, Vultr GPU test, Photon line + group chat test, DeepSpace account, Roblox Studio). LAN address posted |
| Sat 10 AM | Ojasva's endpoints answer on the LAN. Every piece works alone against mocks or the LAN server |
| Sat 2 PM | Game-night clip filmed, Fortnite frame captured |
| Sat 4 PM | Public https link live; every piece talks to the real server |
| Sat 8 PM | Demo worlds built and frozen (game night, Fortnite, one backup photo world). Guide and bot running on the demo Mac |
| Sat 10 PM | Skit + finale run end to end twice, with a timer |
| Sun 2 AM | Third run; failure drills done |
| Sun 4 AM | Feature freeze; record a 10 s clip of every beat |
| Sun 8 AM | Submitted |

## Quality bar

- **One flow, live, on the table.** Every hand-off takes seconds and never needs a refresh or a restart.
- **Smooth:** positions are interpolated, nothing teleports, sounds land on cue.
- **One look:** dark UI, one acid-lime accent `#C6FF3D`, bold type, everywhere (bot, Roblox UI, DeepSpace, labels, notes).
- **Fallbacks for every hop:** pre-built worlds, recorded clips, phone hotspot.

**Rules for everyone:** write all your own code during the event, and credit the AI tools you used on Devpost, as the
hackathon rules require.
