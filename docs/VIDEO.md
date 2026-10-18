# Déjà View: the film (1:55)

**Length:** the Devpost rules say "Demo videos submitted on Devpost must be no longer than 2 minutes." We cut to
**1:55**. (The longer 4:00 plan is in git history if we want a director's cut for the DEV post.)
**Tone:** reminiscent and warm, but never slow. It opens on a real face, gets to the wow by second 6, goes deep on the
machine learning at speed, shows everyone playing together, and ends back on the family.
**Look:** Apple-minimal. Near-black frames, one accent (our lime `#C6FF3D`), white type in SF Pro / Inter. Motion is
push-ins, masked reveals, numbers that count up, splats that assemble. **No stock transitions, no glitch effects,
no AI-generated footage.** Every number on screen comes from our logs.
**Sound:** Olivia Rodrigo, "deja vu", ducked under the voice-over. Line up its first big lift with the VR reveal
(0:05) and its loudest stretch with the cross-play rally; drop to near-silence for the grandfather at the end. Real
sounds punctuate: the fire crackling, the ping pong ball, a chess piece landing. *Copyright check:* Content ID may
mute or block a commercial song. Upload a private test first and keep a royalty-free backup cut ready.
**Track:** Best Use of AI/ML, plus every sponsor challenge.

## The rules for every second

1. **The first frame is a person**, not a logo. No "Hi, we're team…", no title card before 0:14.
2. **Something new every 1–2 s for the first 15 s**, and no shot longer than 4 s anywhere except the ending.
3. **Show it in the same second you say it.** If the voice-over claims it, the picture proves it.
4. **People in every act:** faces, hands, reactions. Get real reactions: don't tell people what they'll see
   before the headset goes on.
5. **The match cut is the money shot:** the real place, then our splat of it, then the Roblox room, same framing.
6. **Captions on every voice-over line** (big, short, lower third), since judges often start muted.
7. **Technical shots carry one idea and one number each, 4–6 s.** Dense, real, animated, never a slide.
8. **The website is seen in someone's hand** (QR, phone, gallery), and its address is the last frame.

---

## The cut, beat by beat

VO = voice-over. **G** = the grandchild (our teammate) in their own voice; **O** = Ojasva. If the grandchild would
rather not record, Ojasva reads the alternate lines marked *alt*.

### ACT 1 · Cold open: the person first (0:00–0:16)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:03 | The real phone video: the grandfather's face lit by the fire. | Real audio: the fire and his voice. | His words as a subtitle. | | have it |
| 2 | 0:03–0:05 | Hard cut, close-up: the grandchild at the hackathon table, pulling the Quest down over their eyes. Side light, shallow focus. | The song's first note. | | | film |
| 3 | 0:05–0:10 | Headset POV: the same fire, framed exactly like the phone clip. It holds for one beat, then the view leans a metre and the flat video becomes a room: grandfather and grandchild in 3D, firelight on their faces. | The song lifts. | | | Quest capture |
| 4 | 0:10–0:14 | Slow push-in on the grandfather in 3D. | **G:** "My grandpa has Alzheimer's. He forgets this week. Never nights like this." *(alt, O: "Our teammate's grandpa has Alzheimer's…")* | Caption | | Quest capture |
| 5 | 0:14–0:16 | Cut to black, 2 s: **Déjà View** fades in, then *walk back in.* | | Title | | render |

### ACT 2 · Everyone, everywhere (0:16–0:40)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 6 | 0:16–0:20 | A friend's phone scans the QR on our table card. **deja-view.photo** fills the screen for half a second; the site loads; a thumb flicks through the gallery: Alzheimer's memory, the Game Lawn, giant chess, the kitchen, Tilted Towers. | **O:** "Déjà View turns the photos and videos you already have into places you can walk back into." | the URL, big | **GoDaddy Registry** · Easy On the Eyes | film + phone screen recording |
| 7 | 0:20–0:23 | Tap: they're inside the Game Lawn on the phone, turning it with a thumb. | **O:** "On a phone." | | | film |
| 8 | 0:23–0:26 | Over the shoulder: someone on a laptop runs into the same place in Roblox. | **O:** "In Roblox." | | **Roblox** | film + screen recording |
| 9 | 0:26–0:28 | The headset again, someone ducking under the palm trees. | **O:** "Or right back inside." | | | film |
| 10 | 0:28–0:31 | **Match cut, 1 s each:** a real swing at the real Game Lawn ping pong table → the same swing, same angle, in our splat → the same angle in Roblox. | Ball sound on each cut. | | **Roblox** | film + render + Roblox capture |
| 11 | 0:31–0:40 | **Cross-play.** One wide shot of two real people: one in the Quest swinging, one at a laptop. Then split screen, headset view left, Roblox right; the ball crosses the seam; four hits; a point; both of them laugh. | Song at its loudest. **O:** "A headset and a laptop. One real table. One ball." | lime overlay: *same physics both sides · 240 Hz · drag + Magnus spin · late hits checked against the ball's path* | **Roblox** | film (clap to sync) |

### ACT 3 · The machine (0:40–1:17). The song ducks; the visuals talk.

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 12 | 0:40–0:44 | Hands on a phone in the DeepSpace app: "Add a memory", a photo drops in, and a lime line carries it into a three-box diagram: DeepSpace (storage, data, realtime) → our pipeline → a world. | **O:** "Add a photo in DeepSpace, our backbone. It's straight into our pipeline." | | **DeepSpace** | film + render |
| 13 | 0:44–0:49 | **What a splat is.** One 3D Gaussian, its parameters labelled: mean μ, covariance Σ = R S Sᵀ Rᵀ, opacity α, colour as spherical harmonics. It multiplies, and the Game Lawn assembles from 1.3 M of them while the compositing equation writes itself: C = Σᵢ cᵢ αᵢ Πⱼ<ᵢ (1 − αⱼ). | **O:** "Every world is millions of 3D Gaussians, blended sixty times a second." | the equations | | render (real splats) |
| 14 | 0:49–0:57 | **One photo → a world.** The photo; Gemini's description types out beside it; a video diffusion model (FlashWorld, a distilled Wan2.2-5B) orbits the scene and decodes Gaussians directly. A pie fills: only **14–23%** of a Tilted Towers world was ever in the screenshot. A GPU grid lights up, HiPerGator's RTX PRO 6000 Blackwells and Vultr cloud GPUs side by side; a timer stops at **~10 s**. | **O:** "Gemini describes the scene. A world model imagines everything the camera never saw. On HiPerGator and Vultr at once: about ten seconds." | pie, GPU grid, timer | **Gemini** · **Vultr** | render (real numbers) |
| 15 | 0:57–1:03 | **Real places, trained from scratch.** 305 camera frustums snap in around the Game Lawn (structure from motion). The PSNR curve climbs **10.6 → 25 dB** over 30,000 steps while the render sharpens beside it. Chips: metric depth (Depth Anything V2) · per-photo appearance · pose refinement · 1.3 M Gaussians. | **O:** "Real places, we train ourselves: three hundred views, thirty thousand steps, guided by metric depth." | curve, chips | Vultr / HiPerGator | render (`metrics.json`, `cameras.json`) |
| 16 | 1:03–1:07 | **Filling the gaps.** Looking up at the palms: holes and smears glow magenta. Gemini and a vision-language model describe what belongs there, an image-edit model paints the crowns, and depth lifts the paint back into 3D. | **O:** "Gemini works with our other models to fill the gaps." | | **Gemini** | render (genfill outputs) |
| 17 | 1:07–1:10 | **The reality check.** One toggle: everything imagined tints, everything captured stays clean. Inset: a splat reprojected into the input camera and depth-tested. | **O:** "And you always see what's real." | | **Vobile** | viewer capture + render |
| 18 | 1:10–1:14 | **4D people.** A frame from a phone video → a body per frame (Multi-HMR 2 on the Anny body model) → tracked, grounded, textured → the camera walks around the players mid-game. Inset: the packed stream (colour · metric inverse depth · person mask). | **O:** "From one phone video, the people come back too." | | | render + viewer capture |
| 19 | 1:14–1:17 | **Roblox from our splats.** Splats → coloured voxels (2–6k merged boxes in under 2 s) → the patio rebuilt from measurements (walls found at 41° from a splat histogram) → the real tables, within 1%. | **O:** "And every place becomes a life-size Roblox world, built from our splats." | | **Roblox** | render + Roblox capture |

### ACT 4 · Every world (1:17–1:31). The song comes back up.

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 20 | 1:17–1:25 | Six cuts on the beat, about 1.3 s each, a person in every one: someone drags a giant chess piece and it lands; a foosball spin; someone ducks in Tilted Towers; Seb cooking as the fridge door opens; the old house kitchen; the grandfather's fire. | Real sounds on each cut, no VO. | world names, small | | film + viewer capture |
| 21 | 1:25–1:31 | Someone in the headset holds the button and asks, "Who won?" Labels pop onto the room and it answers out loud. | Real audio. | | **Gemini** | Quest capture |

### ACT 5 · The family (1:31–1:50)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 22 | 1:31–1:37 | **Memory Keys.** A private memory on a phone shows a closed door. "Knock." On the laptop, "Let in." The door opens. | **O:** "A family's memories stay with the family. They choose who walks in." | | **Auth0** | film (phone + laptop) |
| 23 | 1:37–1:42 | A heatmap blooms on the floor plan around the fire; a visit timeline ticks beside it. | **O:** "Every visit is remembered: where he goes back, where he lingers." | | **Tiger Data** | render (`/api/replay/<id>/heat`) |
| 24 | 1:42–1:50 | Back to the real phone video: the grandfather and grandchild, the second moment. Let it breathe. | Song down to almost nothing. **G:** "So we can take him back. And sit there with him." *(alt, O)* | | | have it |

### END (1:50–1:55)

| # | Time | Picture | Sound / VO | On screen | Sponsor | Source |
|---|---|---|---|---|---|---|
| 25 | 1:50–1:55 | Numbers stamp in, about 0.6 s each: 10 worlds · 1.3 M Gaussians · ~10 s photo to world · 930+ tests. One real shot of the four of us at the table. One row of sponsor logos. Last frame: **Déjà View**, *deja-view.photo*. | Last note of the song. | | all, small | film + render |

**If it runs over 1:55,** cut in this order: beat 9, then beat 18, then trim beat 20 to four cuts.

---

## Tonight's shot list

### People to film (phone in 4K/60 if you can, or the Quest and screen recordings)

Shoot each one 3 times. Keep the phone still, light from the side, no notifications on any screen.

1. **The grandfather clip (beats 1, 24):** we have it. Pick the 3 s with his face lit and his words, and the
   second moment for the ending.
2. **The grandchild putting the Quest on (beat 2):** close-up, side light, shallow focus. If you can, film their
   face when they take it off too; a real reaction is gold.
3. **Headset POV of the Alzheimer's memory (beats 3–4):** start exactly at the phone's spot, hold still 2 s, then
   lean or drift about a metre; 20 s. Quest: Camera → Record video, or cast to the laptop and screen-record.
4. **The QR scan (beats 6–7):** a friend's phone scans the table card, the site loads, a thumb flicks the gallery
   and taps into the Game Lawn. Film over the shoulder **and** screen-record the phone for inserts.
5. **Roblox on a laptop (beat 8):** someone running into the Game Lawn. Over the shoulder, plus a screen recording.
6. **The match cut (beat 10):** one real swing at the real Game Lawn ping pong table from a fixed angle. Note
   where the phone stood; Claude renders the same angle in the splat and in Roblox. If you can't get to the
   table tonight, use a frame from the original capture.
7. **Cross-play (beat 11):** two people, one in the Quest, one at the laptop. One wide shot with both of them in
   frame, plus the Quest capture and the Roblox screen recording. **Clap once at the start** so the three sync.
   Play until you get a real celebration.
8. **The montage (beat 20):** a giant chess piece being dragged and landing, foosball, someone ducking in Tilted
   Towers, the kitchens. 5 s of each; we use about 1.3 s.
9. **The guide (beat 21):** hold the button, ask "Who won?", and let it answer. Record with the Quest's audio.
10. **Memory Keys (beat 22):** a phone and the laptop, hands only: knock, "Let in", the door opens.
11. **DeepSpace (beat 12):** hands on the phone: "Add a memory", a photo drops in.
12. **The team (beat 25):** the four of you at the table, 2 s, looking at the camera or at the headset.
13. **Voice-over:** a quiet room (a closet works), phone about 15 cm from your mouth, 3 takes per line, slow.
    The grandchild records lines 4 and 24 if they're willing.

### Claude renders (1080p/60 MP4 on near-black, one visual system)

1. The splat explainer and the Game Lawn assembling (beat 13).
2. Photo to world: Gemini's caption, the diffusion orbit, the seen-vs-imagined pie, the GPU grid and timer (14).
3. Training: COLMAP frustums from `cameras.json`, the PSNR curve from `metrics.json`, the sharpening render (15).
4. Genfill: gap masks over the palms and the fill landing (16).
5. The reality-check toggle with the reprojection inset (17).
6. 4D people: bodies per frame, an avatar turntable, the packed stream (18).
7. Roblox: splats → voxels → rebuilt patio → tables, and the splat and Roblox halves of the match cut (10, 19).
8. DeepSpace → pipeline → world diagram (12), the physics overlay (11).
9. The Tiger Data heatmap and visit timeline (23), the numbers and the end card (25).

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
