# Déjà View: Devpost draft

**Tagline:** You've seen this before. Now walk around in it.

**Short description:** Turn the photos and phone videos you already have into places you can walk back into: with
friends in Roblox, in a VR headset or a browser, or sitting next to someone who is starting to forget them.

---

## Inspiration

One of our teammates' grandfather has Alzheimer's. The disease usually takes the newest memories first; the old
places and the old faces tend to stay the longest. Families already know what helps on a good day: you sit together
with the old photos and ask "do you remember this?" But a photo is flat. You can't turn around in it, and you can't
sit back down at that table.

So we asked what it would take to give him the room back. Take the photos and phone clips his family already has,
rebuild the place and the people in it in 3D, and let him sit inside it next to the people who love him, in a
headset or just on a laptop. Then we tried it with him, and filmed it.

Then we saw the same thing works for everyone, with less at stake. Every group chat has a camera roll full of nights you weren't at. You get a 12-second clip, a blurry photo and "you
had to be there." We wanted the next best thing to having been there: to actually stand in the room, turn around, and
see who was sitting where.

It goes further than a night out. Most of us have a home we can't go back to: the house you grew up in, sold years
ago, still up on a real-estate site with its old listing photos. One of us rebuilt his family's old kitchen in
Pennsylvania from four of those photos and walked around it again. And a phone clip can hold someone who isn't here
any more: Video mode stands them back in the room where it was filmed, so you can see them where they were.

Two other things pushed us. World models have gotten good enough to imagine the part of a room behind the camera from
a single photo, and a Meta Quest 3S is cheap enough to have one sitting on the table. Our host sponsor protects real
content, which raised a question we couldn't drop: if the AI made up most of the room, shouldn't you be able to see
which parts it made up?

## What it does

Déjà View has two modes.

- **Photo:** walk around a real place from the photos you took there. We rebuilt the Infinity Hall Game Lawn, a
  giant chess room and a kitchen from phone photos and clips: each one is levelled, set to real scale with the floor
  at zero, and you can walk wherever the camera went. A single photo, a game screenshot or just a sentence also
  works: the model generates everything the camera missed. We built three worlds from single OG Tilted Towers
  screenshots, and only 14%, 21.7% and 22.9% of each world's million splats were actually in the screenshot.
  Old real-estate listing photos work too: the watermarks and logos are found and removed on their own, and our
  teammate's old family kitchen in Pennsylvania came back from four of them.
- **Video:** the people in a clip become full 3D people standing in the rebuilt room, moving in time with the
  footage and its sound. Walk all the way around your friends at the foosball table, pause mid-game and look at
  them from behind, or step back to where the phone was and see the original video line up with them. In the
  kitchen, Seb opens the fridge and carries the milk out, and the door and the jug move with him. At the giant chess
  board, both players stand there mid-game. That's 4D reconstruction from one phone clip: the room in 3D, and the
  people in it in 3D, moving through time. The video of our teammate's grandfather by the fire is one of these
  memories now, "Alzheimer's memory": two moments of it, played in one room, and you can sit beside them while they
  talk.

Then the room becomes social:

- **Reality check:** one toggle tints everything the AI imagined, so what the camera captured stays honest.
- **Talk to the room:** Gemini pins floating labels on the interesting things. Hold a button, ask "who won?", and the
  room answers out loud.
- **Roblox:** the same room becomes a life-size Roblox map. Friends without a headset join from a laptop and play tag
  with the person in VR, who sees them as ghosts. The Infinity Hall Game Lawn is rebuilt by hand from its scan, at
  real size, with its real ping pong and foosball tables to play on.
- **Notes that stay:** leave a note in a room and it pops up in the headset as a sticky note where you left it, and
  stays for the next visitor.
- **A visit, not a game:** for someone who is forgetting, the same world becomes a place to sit with family. Put the
  old listing photos of the house and the birthday clips on one board, then walk in together: Grandpa in the headset
  or at the laptop, the grandkids beside him in Roblox, and the room answering "whose birthday was this?" out loud.
- **It starts on the memory board:** add a photo or clip with "Add a memory" in the DeepSpace app, and the card comes
  back with the world link, the Roblox link and the map link.

### The sponsor chain

Each sponsor makes the next moment possible. **DeepSpace** brings the memory in: "Add a memory" keeps the clip in
DeepSpace storage and hands it to our server, and the card it shows puts everyone one tap from the room. **Gemini**
writes the caption the world model uses to imagine what the camera never saw, then makes the room interactive with
labels and spoken answers. **HiPerGator** and a **Vultr** cloud GPU, working in parallel, build a world in seconds,
which is the only reason a judge can make one live at the table. The **reality check**, built for **Vobile**,
separates what was captured from what was imagined. **Roblox** lets friends without a headset be there. Our own domain,
**deja-view.photo**, gives Roblox, the headset and every phone one link that never changes.

### Sponsor challenges: what each one does and where to see it

- **DeepSpace:** how a memory gets in. "Add a memory" in the DeepSpace app takes the photo or clip someone adds and
  hands it to our pipeline, which turns it into the world; the card comes back with the links to walk in.
- **Gemini (MLH):** writes the caption the world model imagines from, pins labels on things in the room, greets you,
  and answers spoken questions out loud. *See it:* in the headset or at `/view`: the labels, then hold the button
  and ask "who won?".
- **HiPerGator and Vultr, in parallel:** GPU work ran on both at once, on HiPerGator's GPUs and a rented Vultr cloud GPU,
  with the same worker code on each. A warm worker turns a photo into a finished world in about 10 seconds. *See it:* the live build at the table and the GPU tile on `/host`.
- **Vobile (reality check):** one toggle tints every part of the world the AI imagined. *See it:* "Reality check" on
  `/host`, in the headset.
- **Roblox:** each real place is also a Roblox room built from the same scan: a block map of the place at life size
  (3.57 studs per metre) with proper collisions, and the Game Lawn rebuilt by hand from its measurements. The server also
  tells the game where the real ping-pong table, foosball table and chessboard are, so the games are played on the
  real furniture. Friends join from the Roblox app and play tag with the person in the headset, who sees them as
  ghosts. Nothing from a real place reaches Roblox unchecked: every texture is scanned for text, faces, logos and QR
  codes, a person approves that exact file (the approval is tied to its hash), and only then is it uploaded. *See
  it:* the Roblox app on a laptop or phone, next to the headset.
- **Solana (devnet):** when a Roblox match ends and the game reports it (`game.result`), the server writes it to
  Solana devnet as one signed Memo transaction: world, game, round, winner, loser, score, time, and whether it was a
  draw. A retry from Roblox never writes a second memo, the transaction signature is saved before it is sent, and the
  server checks the cluster's genesis hash before signing anything, so it only writes to devnet. No real money. On with
  `SOLANA_SCOREBOARD=1`. *See it:* `/scores` lists the latest 50 matches across all worlds, each with a Solana
  Explorer link to its transaction, plus a link to the account that signs them all and a leaderboard (draws and
  games against the computer don't count). JSON at `/api/scores`. [Confirm before submitting: the devnet account
  has SOL from the faucet, and the Roblox games send `game.result`.]
- **Capital One Nessie:** every memory of a night out gets a tab. A purchase at the place is booked as a Nessie
  purchase on the payer's checking account (each friend gets a Nessie customer and checking account the first time),
  split evenly; the page shows who owes whom and the fewest transfers that even it out, and "Settle up" makes them as
  Nessie transfers between the friends' accounts. With "loser covers the table" on, a Roblox match result moves the
  table fee onto the loser (a draw or a game against the computer moves nothing). Mock money only; no account number
  is stored. Needs `NESSIE_API_KEY` (without it the same page runs on a built-in demo bank). *See it:*
  `/tab?scene=the-courts`, seeded with `bun scripts/nessie-seed.ts`.
- **Tiger Data:** with `TIGER_DATA_URL` set, every presence update (headset, Roblox and browser, up to 5 a second per
  world) is stored as one row per person in a TimescaleDB hypertable, with a one-second continuous aggregate and
  compression of older data; Roblox moments (tags, rounds, match results) go in a moments table next to it. The
  server answers replay questions from it: each visit to a memory (when, how long, who), everyone's path over a time
  range with the Roblox moments in it, and a heatmap of person-seconds per 0.5 m floor cell. *See it:* the JSON at
  `/api/replay/status`, `/api/replay/<world>/sessions`, `/api/replay/<world>` and `/api/replay/<world>/heat`, and
  the tables in the Tiger Cloud console. There is no replay page yet.
- **Auth0 (MLH):** with `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_AUDIENCE` set, anyone with the public link can
  still walk into a memory, but adding or rebuilding one, sending headset cues from `/host` and changing a tab need
  a signed-in person. Nobody can delete a memory through the website at all. The pages use Auth0 Universal Login (authorization code with PKCE, no
  client secret), and the server checks the access token's RS256 signature against the tenant's key set, plus its
  issuer, audience and expiry, without an SDK. The host laptop itself, and scripts holding the API token or the
  event key, are not asked. *See it:* the "Sign in" button on `/capture` and `/host` (and on `/tab` when a change
  needs it); `/api/auth/config` says whether sign-in is on.

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

**Real places** go through our own reconstruction pipeline on HiPerGator. We keep the sharpest frame in each window of
a clip and mask people out, COLMAP 3.11 solves the cameras, and our own gsplat training loop (MCMC densification, a
depth term, per-clip colour, pose refinement for video frames) trains the splats in about 12 minutes on one RTX PRO
6000. Then we measure the floor and the real scale on the splats themselves, put the floor at zero, crop to the room,
and let you walk only where the camera actually went, so you never step into a part nobody photographed. The walk
zone is found automatically: we render the world from a grid of spots at eye height in eight directions, keep the
spots that look good, and build the fence and collider around them. The surprise
was symmetric furniture: a ping-pong table looks the same from either end, and COLMAP put whole stretches of video on
a mirrored copy of the room until we limited matching to nearby frames.

**People in 3D:** Multi-HMR 2 estimates every person's body in every frame. We track each person, nudge the bodies to
match their outlines, and fit them to the Anny body model. The texture is then fitted to the footage itself, with the
parts the camera never saw filled from the clothes' colours, and each person is exported as a skinned glTF (163
joints) whose animation is keyed to the video's clock. The viewer plays it with the video's current time, so the
people stay in sync when you pause, seek or play. A last pass keeps people out of measured furniture: from one moving
phone, a body's distance is its least certain coordinate, so a foosball player could end up inside the table. We push
them back along the camera's ray until they clear it. On frames of the clip held out from fitting, the final people
overlap the real outlines by 84 to 87% (IoU), up from 72%.

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

**The social layer:** a real place becomes a Roblox room by fusing depth from every camera into one surface, snapping
the floor and walls to flat planes, and projecting the photos onto them as textures, with a sky beyond the open
sides. It is one textured mesh plus simple collision boxes, centred, at 3.57 studs per metre so the room is life size.
(Generated worlds use a faster voxelizer: greedy-merged, colour-quantised boxes, 2,000 to 6,000 parts in under 2 s.) A presence relay
moves everyone at 4 Hz in metres or studs, and the headset draws other people about 0.3 s in the past so nobody
teleports. New notes reach the headset over a WebSocket within a couple of seconds. The reality check reprojects every splat
into the input camera and checks it against depth: anything behind the camera, outside the frame or hidden behind
something the camera saw is marked as imagined.

**Testing:** more than 850 TypeScript tests and more than 450 Python tests pass, plus opt-in headless-Chrome checks
of the viewer and the guide, and a WebXR emulator for the headset code paths. We also built mock versions of the
guide and DeepSpace services so every hop could be tested before the real ones existed.

**AI tools used:** Claude Code (Anthropic) for engineering help while we built it: code, tests and docs. Inside the
product, Google Gemini writes the captions and labels and answers spoken questions, and the generative models listed
in our credits fill in what the camera never saw.

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
- Real places rebuilt from phone photos at real scale, and the people from a phone clip standing in them as full 3D
  people you can walk around, in sync with the video and its sound.
- One room, three ways in: a headset, a browser, Roblox.
- More than 1,300 automated tests across TypeScript and Python, written during the event.

## What we learned

- Camera trajectory matters as much as the model. An orbit trajectory left far fewer holes around the spawn than
  spinning in place (16.5% empty vs 25.4%).
- Keeping a model warm beats any amount of batch tuning when a person is waiting.
- Writing the contract first let four people build four very different things (a GPU pipeline, a Roblox game, a
  Gemini service and a DeepSpace app) that fit together.
- People believe a world more when it shows its seams.

## What's next

- Memory visits for families living with dementia, designed with caregivers and memory-care staff instead of
  guessed at: a calm mode with no games and no labels, a family member's recorded voice in place of the guide's, and
  a way to keep each visit. We've tried it with our teammate's grandfather (it's in our video); the next step is to
  build it with caregivers and memory-care staff, not on our own.
- Live Video builds in under a minute, so the "now do it" moment works for clips too.
- More of the GPU work on Vultr, so we're not borrowing a class's GPUs.
- Several clips of one night stitched into one room.
- A permanent host instead of a laptop and a tunnel.

## Built with

bun, typescript, three.js, spark, webxr, python, pytorch, flashworld, wan2.2, anysplat, vggt, depth-anything-v2,
deeplabv3, big-lama, gsplat, colmap, multi-hmr, anny, gltf, hugging-face, diffusers, opencv, ffmpeg, hipergator, slurm, cloudflare-tunnel, gemini,
roblox, luau, deepspace, meta-quest-3s, solana, capital-one-nessie, tiger-data, timescaledb, postgresql, auth0

## Credits

All of our own code was written during the event. It stands on open-source work, credited in full, with licences, at
https://deja-view.photo/credits.html. The main pieces:

- **Models:** FlashWorld (imlixinyang) on Wan2.2-TI2V-5B (Wan-AI) for Photo mode; AnySplat (InternRobotics) with VGGT
  (Meta) for many-photo worlds; Depth Anything V2; DeepLabV3 (torchvision); Big LaMa (advimman/lama); Qwen-Image-Edit
  for painting what the photos never saw; Multi-HMR 2 and the Anny body model (NAVER) for the 3D people; SAM 2.1,
  Grounding DINO and TRELLIS for objects.
- **Libraries and tools:** three.js, Spark, three-mesh-bvh, gsplat (nerfstudio), spz (Niantic), COLMAP, PyTorch,
  OpenCV, Open3D, Hugging Face transformers and diffusers, ffmpeg, Bun, rojo, lune, iwer and Playwright.
- **Media:** the "Quest 3S with controllers" 3D model by OG_MATTER (CC BY 4.0); "Tilted Towers Tour | Fortnite OG S2"
  free-camera footage by woodinjake (the Tilted Towers and Brick House worlds); a public greyscale demo room. The
  Game Lawn, the giant chess board, the kitchen and the fire video are our own photos and clips.
- **Services:** UF HiPerGator, Vultr, Hugging Face, Google Gemini, Cloudflare Tunnel, DeepSpace, Roblox, Auth0, Solana,
  Capital One Nessie and Tiger Data.

Meta Quest, Roblox and Fortnite are trademarks of their owners; Déjà View is not affiliated with or endorsed by them.

## Team

- **Ojasva:** server, viewer, GPU pipelines on HiPerGator, Roblox map voxelizer, presence and notes relays, reality
  check, the Solana scoreboard, the Nessie tab, Tiger Data replays, Auth0 sign-in, the deja-view.photo domain
- **Shivin:** the Roblox experience (room loader, room picker, VR ghost, tag rounds), automatic walk zones,
  listing photos to a home, and the one-command video memory chain
- **Brianna:** the Gemini guide: captions, labels, narration, spoken answers
- **Seb:** the DeepSpace app ("Add a memory": a photo or clip into our pipeline), the Roblox games on the real
  furniture, the object maker and its censor gate for Roblox uploads, the Vultr GPU
