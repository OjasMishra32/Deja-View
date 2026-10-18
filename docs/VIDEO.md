# Déjà View: the film (4:00)

**Length:** 4:00. The Devpost rules say videos "must be no longer than 2 minutes"; we have the organizers' OK for
4:00, so keep that message handy in case a judge asks.
**Tone:** reminiscent and warm, but never slow. It opens on a real face, gets to the wow by second 6, goes deep on the
machine learning at speed, shows everyone playing together, and ends back on the family.
**Look:** Apple-minimal. Near-black frames, one accent (our lime `#C6FF3D`), white type in SF Pro / Inter. Motion is
push-ins, masked reveals, numbers that count up, splats that assemble. **No stock transitions, no glitch effects,
no AI-generated footage.** Every number on screen comes from our logs.
**Sound:** Olivia Rodrigo, "deja vu", ducked under the voice-over. Line up its first big lift with the VR reveal
(0:05), its loudest stretch with the cross-play rally, and bring it back up for the worlds; drop to near-silence for
the grandfather at the end. Real sounds punctuate: the fire crackling, the ping pong ball, a chess piece landing.
*Copyright check:* Content ID may mute or block a commercial song. Upload a private test first and keep a
royalty-free backup cut ready.
**Track:** Best Use of AI/ML, plus every sponsor challenge.

## The rules for every second

1. **The first frame is a person**, not a logo. No "Hi, we're team…", no title card before 0:18.
2. **Something new every 1–2 s for the first 20 s.** No shot over 4 s except the chess game and the ending.
3. **Show it in the same second you say it.** If the voice-over claims it, the picture proves it.
4. **People in every act:** faces, hands, reactions, and a real face at least every 15 s inside the technical act.
   Get real reactions: don't tell people what they'll see before the headset goes on.
5. **The match cut is the money shot:** the real place, then our splat of it, then the Roblox room, same framing.
6. **Captions on every voice-over line** (big, short, lower third), since judges often start muted.
7. **Technical shots are dense, real and animated:** real math, real data, one number to remember each. Never a
   slide, never a code editor.
8. **The website is seen in someone's hand** (QR, phone, gallery), and its address is the last frame.

---

## The cut, beat by beat

VO = voice-over. **G** = the grandchild (our teammate) in their own voice; **O** = Ojasva. If the grandchild would
rather not record, Ojasva reads the alternate lines marked *alt*.

### ACT 1 · Cold open: the person first (0:00–0:20)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:03 | The real phone video: the grandfather's face lit by the fire. | Real audio: the fire and his voice. | His words as a subtitle. | | have it |
| 2 | 0:03–0:05 | Hard cut, close-up: the grandchild at the hackathon table, pulling the Quest down over their eyes. Side light, shallow focus. | The song's first note. | | | film |
| 3 | 0:05–0:10 | Headset POV: the same fire, framed exactly like the phone clip. It holds for one beat, then the view leans a metre and the flat video becomes a room: grandfather and grandchild in 3D, firelight on their faces. | The song lifts. | | | Quest capture |
| 4 | 0:10–0:15 | Slow push-in on the grandfather in 3D. | **G:** "My grandpa has Alzheimer's. He forgets this week. Never nights like this." *(alt, O: "Our teammate's grandpa has Alzheimer's…")* | Caption | | Quest capture |
| 5 | 0:15–0:18 | The grandchild lifts the headset off. Their real face, a second of silence. | | | | film |
| 6 | 0:18–0:20 | Black: **Déjà View** fades in, then *walk back in.* | | Title | | render |

### ACT 2 · Everyone, everywhere (0:20–0:55)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 7 | 0:20–0:25 | A friend's phone scans the QR on our table card. **deja-view.photo** fills the screen for half a second; the site loads; a thumb flicks through the gallery: Alzheimer's memory, the Game Lawn, giant chess, the kitchen, Tilted Towers. | **O:** "Déjà View turns the photos and videos you already have into places you can walk back into." | the URL, big | **GoDaddy Registry** · Easy On the Eyes | film + phone screen recording |
| 8 | 0:25–0:28 | Tap: they're inside the Game Lawn on the phone, turning it with a thumb. | **O:** "On a phone." | | | film |
| 9 | 0:28–0:31 | Over the shoulder: someone on a laptop runs into the same place in Roblox. | **O:** "In Roblox." | | **Roblox** | film + screen recording |
| 10 | 0:31–0:34 | The headset again: someone ducks under the palm trees. | **O:** "Or right back inside." | | | film |
| 11 | 0:34–0:38 | **Match cut, about 1.3 s each:** a real swing at the real Game Lawn ping pong table → the same swing, same angle, in our splat → the same angle in Roblox. | The ball's sound on each cut. | | **Roblox** | film + render + Roblox capture |
| 12 | 0:38–0:55 | **Cross-play.** One wide shot with both real people in frame: one in the Quest swinging, one at a laptop (3 s). Split screen, headset left, Roblox right: a rally, the ball crossing the seam (8 s). A point; both laugh (3 s). Slow motion of the ball crossing the seam (3 s). | Song at its loudest. **O:** "A headset and a laptop. One real table. One ball. The same physics runs on both sides, so a hit is a hit." | lime overlay: *same physics both sides · 240 Hz · gravity, drag, Magnus spin · late hits checked against the ball's path* | **Roblox** | film (clap to sync) |

### ACT 3 · The machine (0:55–2:15). The song ducks; the visuals talk.

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 13 | 0:55–1:01 | Hands on a phone in the DeepSpace app: "Add a memory", a photo drops in, and a lime line carries it into a diagram: DeepSpace (storage, data, realtime) → our pipeline → a world. | **O:** "It starts in DeepSpace, our backbone, like our Supabase. Add a photo, and it's in the pipeline." | | **DeepSpace** | film + render |
| 14 | 1:01–1:09 | **What a splat is.** One 3D Gaussian with its parameters labelled: mean μ, covariance Σ = R S Sᵀ Rᵀ, opacity α, colour as spherical harmonics. It projects onto the screen (Σ′ = J W Σ Wᵀ Jᵀ), sorts by depth, and blends: C = Σᵢ cᵢ αᵢ Πⱼ<ᵢ (1 − αⱼ). Then the Game Lawn assembles from 1.3 M of them. | **O:** "Every world is millions of 3D Gaussians, projected to the screen, sorted by depth and blended, every frame." | the equations | | render (real splats) |
| 15 | 1:09–1:12 | A hacker's face lit by a laptop as a world appears in front of them. | | | | film |
| 16 | 1:12–1:24 | **One photo → a world.** The photo; Gemini's description types out beside it; a video diffusion model (FlashWorld, a distilled Wan2.2-5B) orbits the scene and decodes 3D Gaussians. A pie fills: only **14–23%** of a Tilted Towers world was ever in the screenshot. A GPU grid lights up, HiPerGator's RTX PRO 6000 Blackwells and Vultr cloud GPUs side by side; bars: **5–7.5 s** to generate; a timer stops at **~10 s** end to end. | **O:** "Gemini describes the scene. A video diffusion model imagines a camera moving through it and decodes 3D Gaussians. Most of this world was never in the photo. HiPerGator and Vultr GPUs in parallel: about ten seconds." | pie, GPU grid, bars, timer | **Gemini** · **Vultr** | render (real numbers) |
| 17 | 1:24–1:36 | **Real places, trained from scratch.** 305 camera frustums snap in around the Game Lawn (structure from motion), the sparse points seed Gaussians, and the loss writes itself: L = (1 − λ)·L₁ + λ·L_D-SSIM + λ_d·L_depth. The PSNR curve climbs **10.6 → 25 dB** over 30,000 steps while the render sharpens beside it; a counter densifies to **1.3 M** Gaussians; the frustums nudge as their poses are refined. Chips: metric depth (Depth Anything V2) · per-photo appearance. | **O:** "Real places, we train ourselves: structure from motion solves three hundred and five cameras, then thirty thousand steps, guided by metric depth, fit 1.3 million Gaussians to every photo." | the loss, curve, counter | Vultr / HiPerGator | render (`metrics.json`, `cameras.json`) |
| 18 | 1:36–1:39 | Someone in the headset slowly looks straight up at the palms. | | | | film |
| 19 | 1:39–1:49 | **Filling the gaps.** A sphere of **189** direction bins around where people stand; the unseen ones light up. Holes and smears glow magenta on the palm crowns. A vision-language model (Qwen2.5-VL) describes what belongs there, an image-edit model (Qwen-Image-Edit) paints it, and depth (Depth Anything V2) lifts the paint back into 3D as new Gaussians. Inset: Gemini scoring a reconstruction sheet (shape · texture · scale · artifacts). | **O:** "Look up, and the photos run out. We check 189 directions from everywhere people stand, and Gemini works with our other models to fill the gaps." | sphere, model chain, score card | **Gemini** | render (genfill + judge outputs) |
| 20 | 1:49–1:54 | **The reality check.** One toggle: everything imagined tints, everything captured stays clean. Inset: a splat reprojected into the input camera and depth-tested. | **O:** "One switch shows what was real, and what was imagined." | | **Vobile** | viewer capture + render |
| 21 | 1:54–2:05 | **4D people.** A phone-video frame → people masked (DeepLabV3) and painted out (LaMa) to rebuild the empty room → per-frame metric depth aligned to it in inverse depth → the people as live depth meshes in the room. For bodies you can walk all the way around: Multi-HMR 2 on the Anny body model, tracked, grounded and textured from the real frames. Inset: the packed stream (colour · depth · mask). | **O:** "From one phone video, the people come back too: we lift them out, rebuild the empty room, find every body in every frame, and put them back in 3D." | pipeline strip | | render + viewer capture |
| 22 | 2:05–2:15 | **Roblox from our splats.** Splats → coloured voxels (2,000–6,000 greedy-merged boxes in under 2 s) → the patio rebuilt from measurements (walls found at 41° from a splat histogram) → the real tables within 1% (3.57 studs per metre). Then the netcode: headset ⇄ our relay (long-poll) ⇄ the Roblox server as referee; 240 Hz on both sides; a 0.8 s grace for late hits. | **O:** "And every place becomes a life-size Roblox world built from our splats, real tables in the real spots. Roblox referees, and our relay carries the headset's hits in." | voxel counter, netcode diagram | **Roblox** | render + Roblox capture |

### ACT 4 · Every world (2:15–2:50). The song comes back up.

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 23 | 2:15–2:27 | **Giant chess.** Someone in Roblox drags a piece taller than they are; it lands with a thud; the bot answers; the winning move; the player throws their hands up. | Real sounds, no VO. | | **Roblox** | film + Roblox capture |
| 24 | 2:27–2:39 | Eight cuts on the beat, about 1.5 s each, a person in each: a foosball spin; someone ducking in Tilted Towers; Seb cooking as the fridge door opens; the old house kitchen; the courts; the grandfather's fire; a phone turning the Game Lawn; a laugh in the headset. | Real sounds on each cut. | world names, small | | film + viewer capture |
| 25 | 2:39–2:50 | Someone in the headset holds the button and asks, "Who won?" Labels pop onto the room and it answers out loud. | Real audio. | | **Gemini** | Quest capture |

### ACT 5 · What it's for (2:50–3:45)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 26 | 2:50–3:05 | **Reserved for Sebastian's asset piece** (15 s). Same rules: a real person using it on camera, one number on screen, one VO line. Fill in when he sends it; it may move once we see it. | TBD | TBD | TBD | Seb |
| 27 | 3:05–3:12 | Three quick worlds: Seb's kitchen, the old house kitchen, the courts mid-game. | **O:** "Your kitchen. The house you grew up in. The game you won." | | | viewer capture |
| 28 | 3:12–3:20 | **Memory Keys.** A private memory on a phone shows a closed door. "Knock." On the laptop, "Let in." The door opens. | **O:** "A family's memories stay with the family. They choose who walks in." | | **Auth0** | film (phone + laptop) |
| 29 | 3:20–3:27 | A heatmap blooms on the floor plan around the fire; a visit timeline ticks beside it. | **O:** "Every visit is remembered: where he goes back, where he lingers." | | **Tiger Data** | render (`/api/replay/<id>/heat`) |
| 30 | 3:27–3:35 | Headset POV: the grandchild sits down next to the grandfather in 3D by the fire. | Song down to almost nothing; the fire. | | | Quest capture |
| 31 | 3:35–3:45 | The real phone video: the second moment. Let it breathe. | **G:** "So we can take him back. And sit there with him." *(alt, O)* | | | have it |

### END (3:45–4:00)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 32 | 3:45–4:00 | Numbers stamp in, about 1 s each: 10 worlds · 1.3 M Gaussians · ~10 s photo to world · 305 cameras · 930+ tests (6 s). The four of us at the table, real (3 s). One row of sponsor logos (3 s). Last frame: **Déjà View**, *deja-view.photo* (3 s). | **O:** "Déjà View. Walk back in." The song's last note. | | all, small | film + render |

**If it runs long,** cut in this order: beat 15, beat 18, then trim beat 24 to five cuts.

---

## Tonight's shot list

### People to film (phone in 4K/60 if you can, or the Quest and screen recordings)

Shoot each one 3 times. Keep the phone still, light from the side, no notifications on any screen.

1. **The grandfather clip (beats 1, 31):** we have it. Pick the 3 s with his face lit and his words, and the
   second moment for the ending.
2. **The grandchild with the Quest (beats 2, 5):** close-up, side light, shallow focus: putting it on, and taking
   it off with their real face after.
3. **Headset POV of the Alzheimer's memory (beats 3–4, 30):** start exactly at the phone's spot, hold still 2 s,
   then lean or drift about a metre; 20 s. A second take: sit down next to the grandfather. Quest: Camera → Record
   video, or cast to the laptop and screen-record.
4. **The QR scan (beats 7–8):** a friend's phone scans the table card, the site loads, a thumb flicks the gallery
   and taps into the Game Lawn. Film over the shoulder **and** screen-record the phone for inserts.
5. **Roblox on a laptop (beat 9):** someone running into the Game Lawn. Over the shoulder, plus a screen recording.
6. **The match cut (beat 11):** one real swing at the real Game Lawn ping pong table from a fixed angle. Note
   where the phone stood; Claude renders the same angle in the splat and in Roblox. If you can't get to the
   table tonight, use a frame from the original capture.
7. **Cross-play (beat 12):** two people, one in the Quest, one at the laptop. One wide shot with both in frame,
   plus the Quest capture and the Roblox screen recording. **Clap once at the start** so all three sync. Play
   until you get a real celebration. Shoot the ball at 60 fps for the slow-motion.
8. **Reactions (beats 15, 18):** a hacker's face lit by the laptop as a world loads; someone in the headset
   looking straight up at the palms.
9. **Giant chess (beat 23):** a full short game in Roblox against the bot, ending on a win, with the player's
   reaction on a second phone.
10. **The montage (beat 24):** foosball, Tilted Towers, the kitchens, the courts. 5 s of each; we use about 1.5 s.
11. **The guide (beat 25):** hold the button, ask "Who won?", and let it answer. Record with the Quest's audio.
12. **Memory Keys (beat 28):** a phone and the laptop, hands only: knock, "Let in", the door opens.
13. **DeepSpace (beat 13):** hands on the phone: "Add a memory", a photo drops in.
14. **The team (beat 32):** the four of you at the table, 3 s.
15. **Voice-over:** a quiet room (a closet works), phone about 15 cm from your mouth, 3 takes per line, slow.
    The grandchild records lines 4 and 31 if they're willing.

### Claude renders (1080p/60 MP4 on near-black, one visual system)

1. The splat explainer: the parameters, the projection, depth sort and blending, the Game Lawn assembling (14).
2. Photo to world: Gemini's caption, the diffusion orbit, the seen-vs-imagined pie, the GPU grid, bars, timer (16).
3. Training: COLMAP frustums from `cameras.json`, the loss, the PSNR curve from `metrics.json`, the densify
   counter, the sharpening render (17).
4. Genfill: the 189-bin sphere, gap masks on the palms, the model chain, the fill landing, Gemini's score card (19).
5. The reality-check toggle with the reprojection inset (20).
6. 4D people: masks and plate, per-frame depth, the depth meshes, an avatar turntable, the packed stream (21).
7. Roblox: splats → voxels → rebuilt patio → tables, the netcode diagram, and the splat and Roblox halves of the
   match cut (11, 22).
8. DeepSpace → pipeline → world (13), the physics overlay (12).
9. The Tiger Data heatmap and visit timeline (29), the numbers and the end card (32).

Same font, same lime, same easing (ease-out, 600 ms), no drop shadows, no gradients except the splats themselves.

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
