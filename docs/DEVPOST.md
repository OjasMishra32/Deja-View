# Déjà View: Devpost draft

**Tagline:** You've seen this before. Now walk around in it.

**Short description:** Add a photo or a video to your friends' shared memory board, and everyone can walk inside it
from a VR headset, a browser or Roblox, and leave notes for the next person who visits.

---

## Inspiration

Every group chat has a camera roll full of nights you weren't at. You get a 12-second clip, a blurry photo and "you
had to be there." We wanted the next best thing to having been there: to actually stand in the room, turn around, and
see who was sitting where.

Two other things pushed us. World models have gotten good enough to imagine the part of a room behind the camera from
a single photo, and a Meta Quest 3S is cheap enough to have one sitting on the table. Our host sponsor protects real
content, which raised a question we couldn't drop: if the AI made up most of the room, shouldn't you be able to see
which parts it made up?

## What it does

Déjà View has two modes.

- **Photo:** one photo, a game screenshot, or just a sentence becomes a walkable world. The model generates everything
  the camera missed. We built three worlds from single OG Tilted Towers screenshots, and only 14%, 21.7% and 22.9% of
  each world's million splats were actually in the screenshot. The model imagined the rest, including everything
  behind the camera.
- **Video:** prop a phone and record. Whatever stays still becomes the room, and the real footage stands inside it in
  3D with the original sound. You can walk around your friends mid-celebration.

Then the room becomes social:

- **Reality check:** one toggle tints everything the AI imagined, so what the camera captured stays honest.
- **Talk to the room:** Gemini pins floating labels on the interesting things. Hold a button, ask "who won?", and the
  room answers out loud.
- **Roblox:** the same room becomes a life-size Roblox map. Friends without a headset join from a laptop and play tag
  with the person in VR, who sees them as ghosts.
- **Notes that stay:** click the room on the DeepSpace map and type a note. It pops up in the headset as a sticky note
  where you clicked and stays for the next visitor.
- **It starts on the memory board:** add a photo or clip with "Add a memory" in the DeepSpace app, and the card comes
  back with the world link, the Roblox link and the map link.

### The sponsor chain

Each sponsor makes the next moment possible. **DeepSpace** brings the memory in: "Add a memory" keeps the clip in
DeepSpace storage and hands it to our server, and the card it shows puts everyone one tap from the room. **Gemini**
writes the caption the world model uses to imagine what the camera never saw, then makes the room interactive with
labels and spoken answers. **HiPerGator** (with a **Vultr** A40 as the planned second GPU) builds a world in seconds,
which is the only reason a judge can make one live at the table. The **reality check**, built for **Vobile**,
separates what was captured from what was imagined. **Roblox** lets friends without a headset be there, and
**DeepSpace** remembers who was there and what they said, with live presence and notes that persist. [Confirm before
submitting: a free **GoDaddy Registry** domain gives Roblox, the headset and every phone one link that never changes.]

## How we built it

**The hub** is a Bun + TypeScript server on a Mac. It stores scenes, runs jobs, pushes live updates over WebSocket,
serves video with HTTP range requests (the Quest needs them to seek), and is the only thing every other piece talks
to. Four of us built in parallel against one written contract (`team/contracts.md`) that specifies every endpoint,
unit and coordinate frame.

**Photo worlds** come from FlashWorld, a distilled Wan2.2-5B video diffusion model that decodes 3D Gaussians, running
on UF's HiPerGator on an RTX PRO 6000 Blackwell. Generation takes 5 to 7.5 s. A warm worker keeps the model loaded and
turns a photo into a finished world in about 9 to 11 s, compared with about 6 minutes just to load the model cold. We
level each world, scale it, find the floor, put the spawn at the input camera, and trim its roughly 4 million splats
to 1,000,000 (15 to 17 MB as SPZ). For many photos of one place there is an AnySplat path (3 s inference). With no warm
worker, jobs fall back to a batch Slurm job, then the public FlashWorld Space, then the Mac.

**Video rooms** run a five-pass pipeline. It samples frames to build an empty-room background plate (Big LaMa fills
the spots nobody ever moved out of), runs Depth Anything V2 on every frame, unites a DeepLabV3 person mask with
change-from-plate detection, aligns each frame's depth to the plate and smooths it over time, and packs RGB, depth and
mask into one video with the original audio. The
viewer draws that video as a relief mesh in a custom shader. It drops triangles that would stretch across depth
jumps, adds a back sheet behind occluders, and composites the result with the splats so people stand in the room
instead of floating in front of it. iPhone HDR clips are tone-mapped with our own LUTs, because the ffmpeg build we
had couldn't do it.

**The viewer** is three.js + Spark for splat rendering + WebXR. It estimates the floor from the splats, builds a voxel
collider so you can't walk through walls, and adds smooth locomotion, snap turn, a teleport arc, a comfort vignette,
72 Hz with a performance step-down on the Quest, and a desktop and phone fallback.

**The social layer:** a Roblox voxelizer turns the splats into greedy-merged, colour-quantised boxes. Our maps have
about 2,000 to 6,000 parts and build in under 2 s, at 3.57 studs per metre so the room is life size. A presence relay
moves everyone at 4 Hz in metres or studs, and the headset draws other people about 0.3 s in the past so nobody
teleports. Notes live in DeepSpace; the server polls them every 2 s and pushes new ones to the headset over a
WebSocket, so a note typed on the map shows up within a couple of seconds. The reality check reprojects every splat
into the input camera and checks it against depth: anything behind the camera, outside the frame or hidden behind
something the camera saw is marked as imagined.

**Testing:** more than 500 TypeScript tests and more than 200 Python tests pass, plus opt-in headless-Chrome checks
of the viewer and the guide, and a WebXR emulator for the headset code paths. We also built mock versions of the
guide and DeepSpace services so every hop could be tested before the real ones existed.

**AI tools used: [team to fill in]**

## Challenges we ran into

- **Blackwell GPUs.** The RTX PRO 6000 is sm_120, so we needed CUDA 12.8 PyTorch builds and had to compile gsplat for
  three GPU architectures on a cluster where nothing heavy may run on the login node.
- **Two GPUs for an entire class.** We had to be good citizens: one warm worker that exits after 20 idle minutes,
  atomic job claiming, and requeueing the jobs a killed worker left behind.
- **Coordinate frames.** OpenCV vs OpenGL axes, worlds with no real scale, a floor nobody told us about, and Roblox
  studs. The headset, Roblox and the map all have to agree on where you are to within 30 cm.
- **The imagined parts drift.** Ask for a Fortnite street and the parts behind you turn photoreal unless the prompt
  insists on the art style.
- **Video in 3D is mostly edge cases.** An arm in front of a torso, a blender in front of a cook, flickering depth.
  Each one made a rubber sheet until we handled it.
- **Networking at a hackathon.** WebXR needs HTTPS, the Quest needs to reach the laptop, campus Wi-Fi can block
  device-to-device traffic, and Roblox servers can't reach a LAN at all. We ended up with self-signed certificates,
  `adb reverse` and a Cloudflare tunnel that watches itself.

## Accomplishments that we're proud of

- A walkable world from one screenshot in about 10 seconds, with roughly 80% of it imagined, and a toggle that shows
  you exactly which 80%.
- Real people from a phone video standing in a room in VR, with sound.
- One room, three ways in: a headset, a browser, Roblox.
- More than 700 automated tests across TypeScript and Python, written during the event.

## What we learned

- Camera trajectory matters as much as the model. An orbit trajectory left far fewer holes around the spawn than
  spinning in place (16.5% empty vs 25.4%).
- Keeping a model warm beats any amount of batch tuning when a person is waiting.
- Writing the contract first let four people build four very different things (a GPU pipeline, a Roblox game, a
  Gemini service and a DeepSpace app) that fit together.
- People believe a world more when it shows its seams.

## What's next

- Live Video builds in under a minute, so the "now do it" moment works for clips too.
- A Vultr GPU worker next to HiPerGator, so we're not borrowing a class's GPUs.
- Several clips of one night stitched into one room.
- A permanent host instead of a laptop and a tunnel.

## Built with

bun, typescript, three.js, spark, webxr, python, pytorch, flashworld, wan2.2, anysplat, vggt, depth-anything-v2,
deeplabv3, big-lama, gsplat, hugging-face, diffusers, opencv, ffmpeg, hipergator, slurm, cloudflare-tunnel, gemini,
roblox, luau, deepspace, meta-quest-3s

## Team

- **Ojasva:** server, viewer, GPU pipelines on HiPerGator, Roblox map voxelizer, presence and notes relays, reality
  check
- **Shivin:** the Roblox experience: room loader, room picker, VR ghost, tag rounds
- **Brianna:** the Gemini guide: captions, labels, narration, spoken answers
- **Seb:** the DeepSpace app ("Add a memory", live map, trails, notes, gallery), the Vultr GPU, the domain
