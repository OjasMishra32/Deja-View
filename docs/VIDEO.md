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

| # | Time | Picture | Voice-over (Ojasva) | Sponsor on screen | Source |
|---|---|---|---|---|---|
| 1 | 0:00–0:12 | Black. Fire crackle. The real grandfather clip fades up, 1.5 s. | (none) | | have it |
| 2 | 0:12–0:25 | **First scene in VR:** headset POV inside the Alzheimer's memory. The frame starts exactly where the phone stood (the real footage), then the camera drifts and the flat video becomes a room: the two of them in 3D by the fire. | "My grandfather has Alzheimer's. He doesn't always remember this week. But he remembers the places." | | Quest capture (film) |
| 3 | 0:25–0:32 | Title on black, letter by letter: **Déjà View**. Under it: *walk back in.* | | | render |
| 4 | 0:32–0:50 | The website (deja-view.photo) on a laptop: hero, gallery of worlds scrolling slowly. Cut to the same site on a phone in a hand. | "Every family has photos and phone videos of places they can't go back to. Déjà View turns them into places you can walk into again: in a headset, a browser, or Roblox." | GoDaddy Registry: the URL types itself in the address bar | screen capture (render) + phone (film) |
| 5 | 0:50–1:02 | Three inputs fly in from the left (a photo, a video, a sentence), three ways in on the right (headset, phone, Roblox), one line between them that becomes a splat cloud. | "One photo, one video, or just a few words." | DeepSpace: "Add a memory" card dropping in | render |
| | | **THE ENGINE (1:02–2:12): music dips, the visuals take over** | | | |
| 6 | 1:02–1:16 | **What a Gaussian splat is.** One 3D Gaussian drawn as an ellipsoid with its parameters labelled: mean μ, covariance Σ = R S Sᵀ Rᵀ, opacity α, colour as spherical harmonics. Then thousands, then the Game Lawn assembling from 1.3 million of them. The compositing equation writes itself: C = Σ cᵢ αᵢ Πⱼ<ᵢ (1 − αⱼ). | "A world is made of Gaussians: millions of soft, coloured blobs in 3D that a GPU blends into a picture sixty times a second." | | render (real splats from `the-courts`) |
| 7 | 1:16–1:32 | **Photo to world in ~10 s.** A single photo; Gemini's caption types out beside it; a video diffusion model (FlashWorld, a distilled Wan2.2-5B) imagines a camera path around it and decodes Gaussians directly. Pie chart: only 14 to 23% of a Tilted Towers world was in the screenshot. A GPU grid lights up: HiPerGator RTX PRO 6000 Blackwell (96 GB) and Vultr cloud GPUs running at once. Bar: 5–7.5 s generation, ~10 s on a warm worker. | "Gemini tells the world model what it's looking at. The model imagines everything the camera never saw. On a warm GPU, a photo becomes a world in about ten seconds." | **Gemini**, **Vultr** (cloud GPUs in parallel with HiPerGator) | render (real numbers) |
| 8 | 1:32–1:46 | **Real places, trained from scratch.** COLMAP camera frustums popping in around the Game Lawn (305 views). Then our own training: the PSNR curve climbing from 10.6 dB to 25 dB over 30,000 steps while the render sharpens beside it; overlays for metric depth regularisation (Depth Anything V2), per-photo appearance, camera pose refinement, densification to 1.3 M Gaussians. | "For real places we train our own: camera poses from structure-from-motion, then thirty thousand optimisation steps, guided by metric depth, on HiPerGator." | Vultr / HiPerGator GPU strip | render (real `metrics.json`) |
| 9 | 1:46–1:56 | **Filling what nobody filmed.** A view looking up at the palm trees: holes and smears glow magenta (found from where people actually stand, 189 view-direction bins per splat); a vision-language model describes what continues into the gap; an image-edit model paints the crowns; depth lifts the paint back into 3D as new Gaussians. | "Look up, and photos run out. We find every gap from where you'll stand, paint what belongs there, and lift it back into 3D." | | render (genfill outputs) |
| 10 | 1:56–2:04 | **The reality check.** Toggle: everything imagined tints, everything captured stays clean. Diagram: each splat reprojected into the input camera and depth-tested. | "And you can always see which parts are real." | **Vobile** | render + viewer capture |
| 11 | 2:04–2:12 | **4D: people from a phone video.** A frame from the foosball clip → a body mesh estimate per frame (Multi-HMR 2 on the Anny body model) → tracked, put on the floor, textured from the real frames → the two players in 3D, walking round them while the clip plays. Side panel: the packed stream (RGB, metric depth in inverse-depth, person mask). | "From one phone video, the people come back too: in 3D, in time with their voices." | | render (avatar turntables) + viewer capture |
| | | **TOGETHER (2:12–3:12): music back up** | | | |
| 12 | 2:12–2:30 | **Roblox from splats.** The Game Lawn's splats collapse into coloured voxels (greedy-merged boxes, 2,000 to 6,000 parts in under 2 s), then the hand-built patio measured from them (walls found at 41° from a histogram of the splats), then the live Roblox room with the real tables, fitted to within 1% of a real 2.74 × 1.525 m table. | "The same place becomes a Roblox room, at life size, built from the splats themselves, with the real tables in the real spots." | **Roblox** | render + Roblox capture (film) |
| 13 | 2:30–2:48 | **Cross-play ping pong.** Split screen: left, headset POV swinging the controller; right, a laptop in Roblox. The ball crosses between them. Overlay: shared physics (gravity, drag, Magnus spin, 240 Hz steps), and "hits arrive late: checked against the ball's path, 0.8 s grace". | "Someone in the headset and someone on a laptop, on the same real table." | **Roblox** | film (both screens) |
| 14 | 2:48–2:58 | Quick montage: giant chess against the bot, foosball, Tilted Towers in VR, the old house kitchen, Seb cooking with the fridge door opening. | (music only) | | film + viewer capture |
| 15 | 2:58–3:12 | The guide: labels pop onto the room; someone holds a button, asks a question, the room answers out loud. Then a note left on the map pops up in the headset. | "Ask the room what happened here, and it answers." | **Gemini**, **DeepSpace** (our Supabase: storage, data and realtime for the memory board) | Quest capture (film) |
| | | **THE FAMILY (3:12–3:46): music swells** | | | |
| 16 | 3:12–3:26 | **Memory Keys.** A private memory: a phone shows a closed door; "Knock"; on the laptop, "Let in"; the door opens. | "A family's memories stay with the family. You decide who walks in." | **Auth0** | film (phone + laptop) |
| 17 | 3:26–3:36 | **Every visit remembered.** A heatmap fades onto the floor plan: where people stood longest; a timeline of visits. | "And every visit is remembered: which places he goes back to, and where he lingers." | **Tiger Data** | render (`/api/replay/<id>/heat`) |
| 18 | 3:36–3:46 | Back to the fire. The real interaction footage of the grandfather trying Déjà View (only with the family's OK). | "So his family can take him back. And sit there with him." | | have it |
| 19 | 3:46–4:00 | Numbers, one at a time on black: 10 worlds · 1.3 M Gaussians · ~10 s photo to world · 930+ tests. Then the team. End card: **Déjà View**, *deja-view.photo*. | "Déjà View. Walk back in." | all sponsor logos, small, in one row | render |

Timing totals 4:00. If it runs long, cut beat 14 first, then trim 9.

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
