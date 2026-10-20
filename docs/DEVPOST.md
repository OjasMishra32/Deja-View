# Deja View: Devpost fields

Paste each section into the field of the same name.

## Project name

Deja View

## Elevator pitch

Gaussian splatting and generative world models turn your photos and phone videos into 3D places you can walk back into, in VR, a browser or Roblox, beside someone starting to forget them.

## Thumbnail

`film/out/thumb/deja-view-thumbnail-3x2.jpg` (2400 x 1600, 3:2, 485 KB)

## Try it out links

- https://deja-view.photo
- https://github.com/OjasMishra32/Deja-View

## Video demo link

The YouTube link of `film/out/dejaview-film.mp4` (3:58), once uploaded.

## About the project

### Walk in first

Open **https://deja-view.photo**, scroll to All worlds and press Walk in. Everything there was built from photos and phone videos, and it runs in a browser on a laptop or a phone. On a Meta Quest, open the same link in the headset's browser and press Enter VR.

A few to start with:

- The Infinity Hall Game Lawn, from 25 photos and two phone clips: https://deja-view.photo/view?scene=the-courts
- Foosball at the Game Lawn, where both players from one phone video stand in the room in 3D: https://deja-view.photo/view?scene=courts-foosball
- The old house kitchen in Pennsylvania, from four photos in its old real-estate listing: https://deja-view.photo/view?scene=old-house-kitchen
- Tilted Towers, from Fortnite gameplay footage: https://deja-view.photo/view?scene=tilted-towers

Hold X in the headset (or the talk button on a laptop) and ask about anything you can see. Gemini answers out loud.

### Inspiration

Shivin's dad has struggled with Alzheimer's. The disease usually takes the newest memories first, and the old places and faces stay longest. Families already do the thing that helps on a good day: they sit together with old photos and ask "do you remember this?" A photo is flat, though. You can't turn around in it or sit back down at that table.

We wanted to give him the room back. The family already had the photos and the phone clips, so we rebuilt the place and the people in it in 3D and let him sit inside it next to the people who love him, in a headset or on a laptop. We tried it with him and filmed it; the first 16 seconds of our video are that moment.

The same idea works with less at stake. Every group chat has a camera roll full of nights someone missed, a 12 second clip and "you had to be there." Most of us also have a home we can't go back to, still online with its old listing photos. One of us rebuilt his family's old kitchen from four of those photos and walked around it again.

Two technical shifts made this possible this year: world models can now imagine the part of a room behind the camera from a single photo, and a Meta Quest 3S is cheap enough to leave on the table. Vobile, our host sponsor, protects real content, which raised a question we couldn't let go of. If a model invents most of a room, you should be able to see which parts it invented.

### What it does

Photo mode rebuilds a real place from the photos you took there. Each world is levelled, set to real scale with the floor at zero, and fenced to where the cameras actually went, so you never walk into a part nobody photographed. A single photo, a game screenshot or one sentence also works: a world model generates everything the camera missed. In three worlds built from single Tilted Towers screenshots, only 14%, 21.7% and 22.9% of the roughly one million splats were in the screenshot.

Video mode puts the people from a phone clip back in the rebuilt room as full 3D people, moving in time with the footage and its sound. You can walk around your friends at the foosball table, pause mid game and look at them from behind, or step back to where the phone was and watch the original video line up with them. This is 4D reconstruction from one handheld clip. The video of Shivin's dad by the fire is one of these memories, with two moments of it played in one room.

On top of the worlds:

- Reality check tints everything the model imagined, so you always know what a camera really saw.
- Gemini pins labels on what matters in each room and answers spoken questions out loud ("who won?").
- Roblox: every place is also a life size Roblox room. Friends on a laptop or phone play with the person in the headset, including cross-play ping pong on the real table.
- Memory Keys make a memory private. A stranger signs in and knocks, and the owner decides whether to let them in. The guide tells family the family stories and tells a visitor only about the room.
- Add a memory in the DeepSpace app, or drop a clip on the site, and the world joins a queue. A full rebuild from a phone video takes about 40 minutes.
- Notes left in a room appear in the headset where they were left, and every visit is recorded so a family can see which places someone returns to.

### How we built it

#### Gaussian splatting from phone footage

A scene is a set of anisotropic 3D Gaussians. Each has a mean, a covariance built from a scale and a rotation, an opacity and spherical harmonic colour. To render a pixel, the Gaussians are projected to 2D, sorted by depth and alpha composited front to back along the ray. Every step is differentiable, so the whole scene is fitted by gradient descent on a photometric loss (L1 plus D-SSIM) against the real photos.

Our pipeline on UF HiPerGator keeps the sharpest frame in each window of a clip, masks out people, and solves camera poses with COLMAP 3.11. For the Game Lawn, 163 views registered (25 photos and 138 video frames) with 57,048 triangulated points and a mean reprojection error of 1.0 px. Symmetric furniture was the hardest part of the solve. A ping pong table looks the same from either end, and COLMAP placed whole stretches of video on a mirrored copy of the room until we limited matching to nearby frames.

Training is our own gsplat loop with MCMC densification (Gaussians are treated as samples and dead ones are relocated instead of cloned), a depth term, a per clip colour correction and pose refinement for video frames. 30,000 steps take 11.1 minutes on one RTX PRO 6000 Blackwell and reach about 30 dB PSNR on training views and 18.6 dB PSNR / 0.71 SSIM on held-out frames. We then measure the floor and the real scale on the splats themselves, crop to the room, and render a grid of eye-height viewpoints in eight directions to find where a person can stand. The fence and the collider are built from the viewpoints that render cleanly.

#### One photo, one world model

Photo mode uses FlashWorld, a model distilled from the Wan2.2-TI2V-5B video diffusion model that decodes 3D Gaussians directly instead of frames. Gemini writes the scene caption that conditions it, which matters more than we expected: ask for a Fortnite street without stating the art style and the parts behind you drift photoreal. Generation takes 5 to 7.5 s on an RTX PRO 6000. We keep a warm worker so the model never pays its six minute cold load, then level the result, find the floor, put the spawn at the input camera and prune about 4 million splats to 1 million (15 to 17 MB as SPZ). Many photos of one place go through AnySplat, a feed-forward model on a VGGT backbone, in about 3 s.

#### Reality check

Every splat is projected into the cameras that filmed the room and tested against their depth. A splat that is behind every camera, outside every frame or hidden behind surfaces a camera saw is marked as imagined, and the viewer can tint that set blue. The split is real data: the old house kitchen is 279,024 seen splats and 800,394 imagined ones (26% seen), the chess match 77% seen, foosball 54%, Seb cooking 48%.

#### Filling the gaps

A reconstruction only knows what the footage saw. Look up from where people walk and you find the ceiling past the top of every photo. We measure this directly: 72 standing spots times 32 viewing directions gives 2,304 probe renders. One backward pass gives each splat's blending weight in each training view, so every pixel can be classed as a hole (alpha under 0.5), a smear (mostly made of splats fewer than 3 cameras saw well) or an unseen direction. Missing area grows with pitch, from 0.5% looking 30 degrees down to 18.5% looking 75 degrees up.

To fill a region, Qwen2.5-VL describes only what is hidden and how the visible edges continue, Qwen-Image-Edit-2511 paints it, and metric Depth Anything V2 lifts the painting into 3D, aligned to the rendered depth with RANSAC and Cauchy-weighted least squares. Each new Gaussian is oriented along the depth map's normal and sized from the pixel footprint. A short optimisation then trains only the new splats with everything the cameras saw frozen, and a gate re-renders every training view: if the mean drops under 45 dB or any view under 35 dB against the original, that fill is undone. What the footage saw cannot change.

#### People in 3D from one phone video

Multi-HMR 2 estimates every person's body in every frame. We track each person, refine the bodies against their silhouettes and fit them to the Anny body model, then fit the texture to the footage itself and fill the parts the camera never saw from the clothes' colours. Each person is a skinned glTF (163 joints) whose animation is keyed to the video clock, so pausing and seeking stay in sync. From a single moving phone a person's distance is the least certain coordinate, so a foosball player could end up inside the table. We push bodies back along the camera ray until they clear the measured furniture. On held-out frames the final people overlap the real outlines at 84 to 87% IoU, up from 72%.

The room behind them is built in five passes: an empty-room plate (Big LaMa fills the spots nobody ever moved out of), Depth Anything V2 on every frame, a DeepLabV3 person mask joined with change detection against the plate, and per-frame depth aligned to the plate and smoothed over time. The viewer draws it as a relief mesh in a custom shader that drops triangles across depth jumps and composites the result with the splats.

#### From splat to playable Roblox world

Roblox can't render Gaussians, so every room is converted. A voxelizer turns the splats into greedy-merged, colour-quantised boxes (2,000 to 6,000 parts in under 2 s) at 3.57 studs per metre, so the room is life size. Textured room meshes are baked from the splats (the Game Lawn is 299,000 triangles in 43 chunks with a 1024 px texture each). The Game Lawn and the giant chess room were written as Luau build scripts with a coding agent, part by part, from measurements taken off the splats: walls from a histogram of splat positions, tables fitted to within 1% of their real size. The server also sends where the real ping pong table, foosball table and chessboard stand, so the games are played on the real furniture.

Cross-play ping pong runs one physics model in two engines. The headset flies the ball with a line for line port of the Roblox physics (gravity, air drag and Magnus force from spin, stepped 240 times a second). The Roblox server referees and accepts a headset hit that arrives late if it matches the ball's recorded path, holding a point for 0.8 s before awarding it. Presence moves at 4 Hz in metres or studs, and each client draws others 0.3 s in the past so nobody teleports.

Objects go to Roblox only after a check. Grounding DINO and SAM 2.1 find objects in rendered views, TRELLIS turns them into meshes, and a preflight scans every texture atlas for QR codes, barcodes, text, faces and logos (a teammate's place was banned once over a QR code in a texture). A person then approves that exact file, the approval is tied to its SHA1, and only then is it uploaded.

#### The hub, the viewer and the tests

A Bun and TypeScript server stores scenes, runs the job queue, pushes live updates over WebSocket and serves video with HTTP range requests (the Quest needs them to seek). The viewer is three.js with Spark for splat rendering and WebXR, with a voxel collider, smooth locomotion, snap turn, teleport, a comfort vignette and a 72 Hz step-down on the Quest. Four of us built in parallel against one written contract (`team/contracts.md`) that fixes every endpoint, unit and coordinate frame. 874 TypeScript tests and 444 Python test functions pass, plus headless Chrome checks of the viewer and a WebXR emulator for the headset paths.

### How each sponsor is used

**Vobile:** the reality check. Per-splat provenance (seen by a camera, or imagined by a model) is computed by reprojection against depth and shown with one toggle in the headset, the browser and on `/host`. For someone whose memory is slipping, a made-up detail is worse than a gap.

**DeepSpace:** how a memory gets in. "Add a memory" in Seb's DeepSpace app sends the photo or clip to our pipeline, and the card comes back with the world link and the Roblox link when it is built.

**Gemini (MLH):** writes the caption that conditions the one-photo world model, inspects each reconstruction to pin labels on what matters, greets visitors and answers spoken questions out loud. The server tells it from the verified Auth0 token whether it is talking to family or a visitor, so a stranger can't learn a family's stories by asking.

**Vultr (MLH):** the same GPU worker code runs on a rented Vultr GPU and on HiPerGator at once, with atomic job claiming and requeueing of jobs a killed worker left behind. Two GPU sources mean a live build doesn't depend on one class allocation.

**Auth0 (MLH):** Universal Login with authorization code and PKCE, and RS256 access tokens checked against the tenant's key set (issuer, audience, expiry) on our own server. Anyone with the link can walk into a public memory, but adding or rebuilding one needs a signed-in person. Memory Keys put Auth0 in front of the memory itself: a private memory's files (splats, photos, 3D people) answer 403 to anyone not on the guest list, a guest holds an HttpOnly pass the server signs and re-checks on every request, and removing someone locks them out at once.

**Tiger Data (MLH):** every presence update from the headset, Roblox and the browser (up to 5 a second per world) is a row in a TimescaleDB hypertable on Tiger Cloud, with a one-second continuous aggregate and compression of older chunks. Roblox moments (rounds, match results) sit in a table beside it. The server answers replay queries from it: each visit (when, how long, who), everyone's path over a time range, and a heatmap of person-seconds per 0.5 m floor cell.

**GoDaddy Registry (MLH):** deja-view.photo is the one link for everything: the site, the headset, the Roblox server's base address, the QR codes and this page.

**Roblox:** the place everyone without a headset joins. Rooms built from our splats at real scale, games on the real furniture, cross-play with the person in VR, and the upload gate above.

**UF HiPerGator:** camera solves, splat training, gap filling, people reconstruction and the warm world-model worker all ran on its RTX PRO 6000 Blackwell GPUs.

### Challenges we ran into

The RTX PRO 6000 is sm_120, so we needed CUDA 12.8 PyTorch builds and compiled gsplat for three GPU architectures on a cluster where nothing heavy may run on the login node. Two GPUs were shared by a whole class, so the warm worker exits after 20 idle minutes and jobs are claimed atomically.

Coordinate frames were a constant fight: OpenCV against OpenGL axes, worlds with no real scale, floors nobody told us about, and Roblox studs. The headset, Roblox and the map have to agree on where you stand to within 30 cm.

Video in 3D is mostly edge cases: an arm in front of a torso, a blender in front of a cook, flickering depth. Each one made a rubber sheet until we handled it.

Privacy had to hold all the way down. Hiding a private memory's page isn't enough when the world is a set of files the viewer downloads, so the files themselves are checked, and so are the guide's answers.

WebXR needs HTTPS, the Quest has to reach the laptop, campus Wi-Fi blocks device to device traffic, and Roblox servers can't reach a LAN. We ended up with our own domain behind a Cloudflare tunnel that restarts itself.

### Accomplishments that we're proud of

Shivin's dad sat in a room rebuilt from one video of him by the fire. Real places come back at real scale from phone photos, and the people from a phone clip stand in them as full 3D people you can walk around. One room has three ways in: a headset, a browser and Roblox. The model's guesses are labelled splat by splat, and gap filling is gated so it can never change what a camera saw. More than 1,300 automated tests were written during the event.

### What we learned

Camera trajectory matters as much as the model: an orbit left far fewer holes around the spawn than spinning in place (16.5% empty against 25.4%). Keeping a model warm beats any amount of batch tuning when a person is waiting. Held-out metrics keep you honest: 30 dB on training views and 18.6 dB on held-out frames is the gap between a room that photographs well and one you can walk through. And people trust a world more when it shows its seams.

### What's next

Memory visits for families living with dementia, designed with caregivers and memory-care staff: a calm mode with no games and no labels, a family member's recorded voice in place of the guide's, and a way to keep each visit. Video builds fast enough to make one live at a table. Several clips of one night merged into one room. More of the GPU work on Vultr, and a permanent host instead of a laptop and a tunnel.

### Credits

All of our own code was written during the event. AI tools: Claude Code (Anthropic) helped with code, tests and docs. Inside the product, Gemini writes captions and labels and answers questions, and the generative models below fill in what cameras never saw.

Models: FlashWorld on Wan2.2-TI2V-5B (Wan-AI); AnySplat with VGGT (Meta); Depth Anything V2; DeepLabV3 (torchvision); Big LaMa; Qwen2.5-VL and Qwen-Image-Edit-2511; Multi-HMR 2 and the Anny body model (NAVER); SAM 2.1, Grounding DINO and TRELLIS. Libraries: three.js, Spark, three-mesh-bvh, gsplat (nerfstudio), spz (Niantic), COLMAP, PyTorch, OpenCV, Open3D, Hugging Face transformers and diffusers, ffmpeg, Bun, Rojo, Lune and Playwright. Media: "Quest 3S with controllers" by OG_MATTER (CC BY 4.0); "Tilted Towers Tour | Fortnite OG S2" free-camera footage by woodinjake. The Game Lawn, the chess room, the kitchen and the fire video are our own. Full list with licences: https://deja-view.photo/credits.html

Meta Quest, Roblox and Fortnite are trademarks of their owners; Deja View is not affiliated with or endorsed by them.

### Team

Ojasva built the server, the viewer, the GPU pipelines on HiPerGator, the Roblox map voxelizer, the presence relay, the reality check, Tiger Data replays, Auth0 sign-in and the domain. Shivin built the Roblox experience, automatic walk zones, listing photos to a home, the video memory chain and Memory Keys. Brianna built the Gemini guide: captions, labels, narration and spoken answers. Seb built the DeepSpace app, the Roblox games on the real furniture, the object maker and its upload gate, and the Vultr GPU.

## Built with

bun, typescript, three.js, spark, webxr, python, pytorch, cuda, gsplat, 3d-gaussian-splatting, colmap, flashworld, wan2.2, anysplat, vggt, depth-anything-v2, qwen2.5-vl, qwen-image-edit, deeplabv3, big-lama, multi-hmr, anny, sam2, grounding-dino, trellis, gltf, hugging-face, diffusers, opencv, open3d, ffmpeg, hipergator, slurm, vultr, gemini, roblox, luau, rojo, deepspace, auth0, tiger-data, timescaledb, postgresql, cloudflare-tunnel, godaddy-registry, meta-quest-3s
