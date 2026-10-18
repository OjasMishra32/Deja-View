# Déjà View: the film (4:00)

**Tone:** reminiscent, quiet, then awe. A family memory first; then how far down the machine learning goes; then
everyone playing together; then back to the family.
**Look:** Apple-minimal. Black or near-black frames, one accent (our lime `#C6FF3D`), white type in SF Pro / Inter,
generous space. Motion is slow push-ins, masked reveals, numbers that count up, splats that assemble. **No stock
transitions, no glitch effects, no AI-generated footage.** Every number on screen comes from our logs; every chart is
drawn from real data.
**Sound:** Olivia Rodrigo, "deja vu", low under the voice-over; it dips under the technical part and comes back for
the ending. Ojasva records the voice-over. *Copyright check:* YouTube's Content ID may mute or block a video with a
commercial song. Upload a private test first; if it gets claimed, keep a royalty-free backup cut ready, because a
muted demo is worse than a different song.
**Track:** Best Use of AI/ML, plus every sponsor challenge below.

---

## The cut, beat by beat

Music: "deja vu" low under everything; it dips to a hum under ACT 3 and comes back up for ACT 4 and the end.

### ACT 0 · The website first (0:00–0:30). Judges may never open the link, so the film opens on it.

| # | Time | Picture | Voice-over (Ojasva) | Sponsor | Source |
|---|---|---|---|---|---|
| 1 | 0:00–0:06 | Black. A cursor blinks in an empty address bar and types **deja-view.photo**; Enter; the page fades up. | "This is Déjà View." | **GoDaddy Registry** (the domain typing itself) | render |
| 2 | 0:06–0:22 | One slow, continuous scroll through the landing page: the hero with the Quest 3S, the "Step inside" row of looping flights through each world, the gallery cards (Alzheimer's memory, the Game Lawn, giant chess, the kitchen, Tilted Towers). | "The photos and phone videos you already have, turned into places you can walk back into: in a headset, on your phone, or in Roblox." | | render (screen capture) |
| 3 | 0:22–0:30 | The scroll stops on the **Alzheimer's memory** card. The cursor rests, clicks. Cut to black. | "Let me show you why we built it." | | render |

### ACT 1 · The memory (0:30–0:55)

| # | Time | Picture | Voice-over | Sponsor | Source |
|---|---|---|---|---|---|
| 4 | 0:30–0:42 | The real fire footage, 2 s. Then **headset POV**: the frame starts exactly where the phone stood, then drifts a metre and the flat video becomes a room: grandfather and grandchild in 3D by the fire. | "My grandfather has Alzheimer's. He doesn't always remember this week. But he remembers the places, and the people in them." | | Quest capture (film) |
| 5 | 0:42–0:50 | Still in the headset: the second moment, "Your father must be proud", in the same room. No voice; the song lifts. | (silence) | | Quest capture (film) |
| 6 | 0:50–0:55 | Title on black, letter by letter: **Déjà View**, then *walk back in.* | | | render |

### ACT 2 · Every way in (0:55–1:20)

| # | Time | Picture | Voice-over | Sponsor | Source |
|---|---|---|---|---|---|
| 7 | 0:55–1:05 | The same memory on a phone in a hand, dragged around with a thumb. Then the same place in Roblox on a laptop. | "No headset? It runs on a phone. Your friends can walk in from Roblox." | **Roblox** | film (phone, laptop) |
| 8 | 1:05–1:20 | Seb's DeepSpace app: "Add a memory", a photo drops in, the card comes back with "Walk in". Small diagram beside it: DeepSpace (storage, data, realtime) → our pipeline → the world. | "It starts where families already share things. DeepSpace is our backbone, like our Supabase: it holds the photos and clips, and hands each one to our pipeline." | **DeepSpace** | film (app) + render (diagram) |

### ACT 3 · The machine (1:20–2:35). Music down; the visuals carry it. Every number is from our logs.

| # | Time | Picture | Voice-over | Sponsor | Source |
|---|---|---|---|---|---|
| 9 | 1:20–1:35 | **What a Gaussian splat is.** One 3D Gaussian as an ellipsoid with its parameters labelled: mean μ, covariance Σ = R S Sᵀ Rᵀ, opacity α, colour as spherical harmonics. It multiplies into thousands, then the Game Lawn assembles from 1.3 million of them. The compositing equation writes itself: C = Σᵢ cᵢ αᵢ Πⱼ<ᵢ (1 − αⱼ). | "Every world is made of Gaussians: millions of soft, coloured ellipsoids that a GPU blends into a picture, sixty times a second." | | render (real splats) |
| 10 | 1:35–1:52 | **Photo to world in about ten seconds.** A single photo; Gemini's description types out beside it; a video diffusion model (FlashWorld, a distilled Wan2.2-5B) sweeps a camera around it and decodes Gaussians directly. Pie: only 14% to 23% of a Tilted Towers world was in the screenshot. A GPU grid lights up, HiPerGator's RTX PRO 6000 Blackwells and **Vultr** cloud GPUs running side by side; bars: 5 to 7.5 s generation, about 10 s end to end on a warm worker. | "Gemini tells the world model what it's looking at, and the model imagines everything the camera never saw. We ran it on HiPerGator and on Vultr cloud GPUs at the same time, so a photo becomes a world in about ten seconds." | **Gemini**, **Vultr** | render (real numbers) |
| 11 | 1:52–2:07 | **Real places, trained from scratch.** Camera frustums pop in around the Game Lawn (305 views solved by structure-from-motion). Our training run: the PSNR curve climbs from 10.6 dB to 25 dB over 30,000 steps while the render sharpens beside it; overlays for metric depth supervision (Depth Anything V2), per-photo appearance, camera-pose refinement and densification to 1.3 M Gaussians. | "For real places we train our own: camera poses from structure-from-motion, then thirty thousand optimisation steps, guided by metric depth." | **Vultr** / HiPerGator GPU strip | render (`metrics.json`) |
| 12 | 2:07–2:17 | **Filling what nobody filmed.** Looking up at the palm trees: holes and smears glow magenta, found from where people will actually stand. Gemini and a vision-language model describe what belongs there, an image-edit model paints the crowns, and depth lifts the paint back into 3D as new Gaussians. | "Look up, and the photos run out. Gemini works with our other models to fill the gaps: find them, describe what belongs there, paint it, and lift it back into 3D." | **Gemini** | render (genfill outputs) |
| 13 | 2:17–2:24 | **The reality check.** Toggle: everything imagined tints, everything captured stays clean. Diagram: each splat reprojected into the input camera and depth-tested. | "And you can always see which parts are real." | **Vobile** | render + viewer capture |
| 14 | 2:24–2:35 | **4D: people from one phone video.** A frame → a body estimate per frame (Multi-HMR 2 on the Anny body model) → tracked, grounded, textured from the real frames → the players in 3D, walked around mid-game. Side panel: the packed stream (colour, metric inverse depth aligned to the empty-room plate, person mask). | "From one phone video, the people come back too: in 3D, in time with their voices." | | render (avatar turntables) + viewer capture |

### ACT 4 · Together (2:35–3:20). Music back up.

| # | Time | Picture | Voice-over | Sponsor | Source |
|---|---|---|---|---|---|
| 15 | 2:35–2:48 | **Roblox from our splats.** The Game Lawn's splats collapse into coloured voxels (greedy-merged boxes, 2,000 to 6,000 parts in under 2 s), then the hand-built patio measured from them (walls found at 41° from a histogram of the splats), then the live Roblox room with the real tables, fitted to within 1% of a real 2.74 × 1.525 m table. | "The same place becomes a life-size Roblox world, generated from our splats, with the real tables in the real spots." | **Roblox** | render + Roblox capture (film) |
| 16 | 2:48–3:03 | **Cross-play ping pong.** Split screen: left, headset POV swinging the controller; right, a laptop in Roblox. The ball crosses between them. Overlay: one physics model in both (gravity, drag, Magnus spin, 240 Hz steps); "late hits checked against the ball's path, 0.8 s grace". | "Someone in the headset and someone on a laptop, on the same real table." | **Roblox** | film (both screens, synced with a clap) |
| 17 | 3:03–3:12 | Quick montage: giant chess against the bot, foosball, Tilted Towers in VR, Seb cooking with the fridge door opening, the old house kitchen. | (music only) | | film + viewer capture |
| 18 | 3:12–3:20 | The guide: labels pop onto the room; someone holds the button and asks a question; the room answers out loud. | "Ask the room what happened here, and it answers." | **Gemini** | Quest capture (film) |

### ACT 5 · The family (3:20–3:50). Music swells.

| # | Time | Picture | Voice-over | Sponsor | Source |
|---|---|---|---|---|---|
| 19 | 3:20–3:30 | **Memory Keys.** A private memory on a phone shows a closed door; "Knock"; on the laptop, "Let in"; the door opens. | "A family's memories stay with the family. You decide who walks in." | **Auth0** | film (phone + laptop) |
| 20 | 3:30–3:38 | **Every visit remembered.** A heatmap fades onto the floor plan, where people stood longest, then a timeline of visits. | "And every visit is remembered: which places he goes back to, and where he lingers." | **Tiger Data** | render (`/api/replay/<id>/heat`) |
| 21 | 3:38–3:50 | Back to the fire: the real footage of the grandfather trying Déjà View (only with the family's OK). | "So his family can take him back. And sit there with him." | | have it |

### ACT 6 · The end (3:50–4:00)

| # | Time | Picture | Voice-over | Sponsor | Source |
|---|---|---|---|---|---|
| 22 | 3:50–4:00 | Numbers on black, one at a time: 10 worlds · 1.3 M Gaussians · ~10 s photo to world · 930+ tests. The team. One row of sponsor logos. End card: **Déjà View**, *deja-view.photo*. | "Déjà View. Walk back in." | all, small | render |

If it runs long, cut beat 17 first, then trim 12 and 14.

---

## Who makes what

### Ojasva and the team film (phone, Quest, laptop)

1. **Quest captures** (Quest: Camera → Record video, or cast to the laptop and screen-record):
   - beat 2: the Alzheimer's memory, starting still at the spawn, then a slow 1 m drift to the side; 20 s;
   - beat 13: ping pong, 30 s of rallies (headset side);
   - beat 15: labels popping, one spoken question and the answer, and a note appearing; 30 s;
   - beat 14: Tilted Towers and the giant chess board, 10 s each.
2. **Laptop in Roblox** (screen recording, 1080p): beat 13's other side (same rally, same time; clap once at the
   start so the two sides sync); giant chess against the bot; foosball; walking into the Game Lawn.
3. **Phone in a hand:** beat 4 (the site on a phone), beat 16 (the knock). Film over a dark table, phone held
   steady, no notifications.
4. **People (b-roll):** someone putting the headset on; two people laughing at the ping pong; a hand on a phone.
   Shoot wide and slow, 4K if you can.
5. **Voice-over:** quiet room, phone close, one take per beat, read slowly. Lines are in the table.

### Claude renders (from our real data, as MP4 at 1080p/60, black background)

1. Website captures: hero, gallery scroll, a world opening, the URL typing in (beat 4).
2. Viewer flythroughs of each world from a scripted camera, plus the reality-check toggle (beats 10, 14).
3. The splat explainer: one Gaussian with labelled parameters, then the real Game Lawn assembling from its splats
   (beat 6).
4. The engine charts, animated: seen vs imagined pie, generation-time bars, GPU grid, the PSNR training curve from
   our `metrics.json`, COLMAP frustums from `cameras.json` (beats 7, 8).
5. Genfill: gap masks over the tree tops and the fill landing (beat 9).
6. 4D people: per-frame body estimate, avatar turntable, the packed RGB/depth/mask stream (beat 11).
7. Roblox: splats → voxels → hand-built room (beat 12), and the physics overlay for beat 13.
8. The Tiger Data heatmap and visit timeline (beat 17), the numbers and the end card (beats 3, 19).

All in one visual system: same font, same lime, same easing (ease-out, 600 ms), no drop shadows, no gradients
except the splats themselves.

---

## Sponsor lines (for the Devpost and the edit)

- **DeepSpace:** our Supabase. It holds the memory board: storage for the photos and clips people add, the data and
  realtime layer behind it, and "Add a memory" hands each one to our pipeline.
- **Roblox:** heavily integrated. Every real place becomes a life-size Roblox room generated from our own Gaussian
  splats (a voxelizer over the splats; the Game Lawn and the giant chess room rebuilt from measurements taken from
  them; table positions fitted from the splats to within 1%), with games on the real furniture and cross-play ping
  pong against the headset.
- **Gemini:** it works with our other models to fill the gaps, and it is our quality inspector. It writes the scene description the world
  model imagines the rest of a room from (most of each generated world lies outside the photo); it inspects our 3D
  reconstructions and scores what is wrong with them (shape, texture, scale, artifacts) from a sheet of mesh, splat,
  mask and difference views; and it runs the guide: labels, narration and spoken answers.
- **Gemini + Qwen, how the gaps get fixed:** Gemini flags what looks wrong in a reconstruction; our gap finder pins
  down exactly where (every hole and smear, from where people will stand); Qwen describes what belongs there and
  paints it; depth lifts the paint back into 3D.
- **Vultr:** cloud GPUs running alongside HiPerGator, so generation and training ran on several GPUs at once and the
  live build never waited on one class allocation.
- **Auth0:** Memory Keys: private family memories, knock to enter, and a guide that only tells family the family
  stories.
- **Tiger Data:** every visit as a time series (TimescaleDB hypertable, 1 s rollup, compression): visits, paths and
  a heatmap of where people stood.
- **GoDaddy Registry:** deja-view.photo, one permanent link for the headset, Roblox and every phone.
- **Vobile:** the reality check, so the family always knows what was really there.

**Keep it accurate:** Gemini flags problems and scores reconstructions; the holes themselves are located by our own
gap finder (`pipeline/genfill/gaps.py`), and Qwen does the describing and painting. Say it that way and every word
holds up if a judge reads the code.
