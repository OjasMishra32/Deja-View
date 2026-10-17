# Brianna: Gemini, the AI brain

Read `START-HERE.md` (one page), then `plan.md` (the story), then this. `contracts.md` has the wiring for the whole
team; where this page and `contracts.md` disagree, `contracts.md` wins.

You own Gemini, all of it, and nothing else: four endpoints, `/describe`, `/hotspots`, `/narrate` and `/ask`.

Everything below was checked against the live Gemini docs and SDK on Fri Oct 16, 2026. Where something could not be
checked, it says so and tells you how to check it. If something here turns out to be wrong on the night, tell Ojasva
right away and use the fallback listed for it.

> **Update after your first push (Sat ~2 AM):** your service is merged into `main` (`integrations/guide/`), thanks.
> Two gaps against the contract, both needed for the 0:40 beat:
> 1. `/ask` must accept `audio` (the headset sends the spoken question as a webm data URL, no text): send it to Gemini
>    with the image, and return what was heard as `question` next to the `answer`.
> 2. `/ask` and `/narrate` must return `speech`: the answer as Gemini text-to-speech, a WAV data URL. Until then the
>    headset shows the answer as a caption only.

> **Update (Sat early morning):** the Photon group-chat bot is dropped (not a Devpost prize, and it did not work).
> Memories now come in through Seb's DeepSpace app ("Add a memory"). Wherever this page says "the bot" or "the group
> chat", read "Seb's app". Nothing else changes for you.

---

## 1. What you are building, and the demo moments

You build **one small HTTP service** (call it "the guide") on port **8795**. Only the Déjà View server calls it. The
headset never talks to you directly.

| Time | What the judge sees and hears | Your endpoint |
| --- | --- | --- |
| before the demo, and live at 2:00 | A photo (or a still-camera video) arrives. Before the GPU builds the world, Gemini looks at it and writes the caption the world model uses to imagine everything the camera never saw | `POST /describe` |
| 0:40 | Inside the game-night memory, floating labels sit on the **screen**, the **controllers**, the **snacks**. Gemini found them | `POST /hotspots` |
| 0:40 | The judge looks at the screen and asks out loud "who won?". Within about 2 s the room answers in a voice, with a caption | `POST /ask` (audio in, speech out) |
| 2:25 | The judge's own photo has become a world. On arrival the room greets them ("Nice place. Someone left every light on."), and labels pop in | `/narrate`, `/hotspots`, live |

Every sponsor causes the next thing (`plan.md`), and yours causes two of them: `/describe` writes the text that decides
what the world model imagines behind you (which is exactly what the reality-check toggle tints at 1:00), and
`/hotspots` + `/ask` turn a 3D picture into a room you can talk to.

You are also on stage twice, on your laptop (section 2.3):
- **1:10:** you join as a **Roblox avatar** with Shivin and play tag with the judge.
- **1:40:** on Seb's DeepSpace map you click the couch and type "Seb's seat. He was too scared to show up." It pops
  up in the headset as a sticky note.

And you are in the **game-night clip** (section 2.4) that the whole skit starts from.

Mode names: the two modes are **Photo** and **Video**, and the API uses exactly `"photo"` and `"video"`.

**Prize:** MLH "Best Use of Gemini API" (confirmed on https://swamphacks-xii.devpost.com/). Gemini also carries the
host sponsor's story (Vobile protects real content): it decides what the world model imagines, and the reality check
shows exactly that. Judges want the API doing real work in the product. Yours does: it writes the world, finds the
things worth pointing at, sees what you see, hears your voice and talks back.

---

## 2. Tonight: accounts, keys, tools (about 40 minutes)

Do these in order before you sleep. Write down anything that fails and message Ojasva.

### 2.1 Gemini API key (10 minutes)

1. Use a **personal Gmail account**. School-managed Google accounts can have AI Studio disabled. You must be 18+ (the
   hackathon already requires that).
2. Open https://aistudio.google.com/apikey and accept the terms. New users get a default project and key created
   automatically. Otherwise click **Create API key**.
3. Since May 28, 2026, new AI Studio keys are "auth keys". Old **unrestricted** keys are now rejected, so if you have an
   old key from last year, make a new one.
4. Put it in your `.env` as `GEMINI_API_KEY=...`. Never paste it into code, chat, Discord or a commit.
5. **Write down your free-tier limits.** Open https://aistudio.google.com/rate-limit and note the RPM (requests per
   minute) and RPD (requests per day) for `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.8-flash-lite-tts` and
   `gemini-3.8-flash-tts`. Google does not publish these numbers anywhere else, and they are per project. Send them
   to Ojasva.

If it is blocked: try another personal Google account. If AI Studio refuses you completely, ask Ojasva for a key from
his project and use `MOCK_GEMINI=1` (section 9) in the meantime, so you are never stuck.

Free tier facts (https://ai.google.dev/gemini-api/docs/pricing and https://ai.google.dev/gemini-api/docs/rate-limits):
- All four models above are "Free of charge" on the free tier. On the free tier, Google may use what you send to
  improve its products. That is fine for a demo, but don't send anything private.
- Limits are **per project**, not per key. Daily limits reset at **midnight Pacific = 3:00 AM Eastern**. A heavy
  Saturday of testing can use up the daily quota before the 10 PM run. Cache aggressively (section 6.6).
- If the free tier is too tight, one teammate links billing and prepays the **$5 minimum** (Tier 1, usually applies
  instantly; https://ai.google.dev/gemini-api/docs/billing). At paid prices the whole weekend costs well under $1.
  Decide who by Sat 4 PM, before the 10 PM run.

### 2.2 Tools on your laptop (10 minutes)

- **Node 20 or newer** (`node -v`). Ojasva's demo Mac has Node 26, so Node is the safe choice for the hand-off.
  Python 3.10+ with `google-genai` also works if you prefer it (the request fields are the same snake_case names).
  Bun is fine too.
- `npm install @google/genai` (latest is 2.30.0, released Oct 15; the text-to-speech models need 2.24.0 or newer).
- `jq` and `ffmpeg` for test scripts (`brew install jq ffmpeg` on a Mac).

### 2.3 Your stage roles (15 minutes tonight, 10 minutes Saturday)

These are not builds, just accounts so you are ready for your two beats.
- **Roblox (tonight):** make a Roblox account if you don't have one, install the Roblox app on your laptop, and send
  Shivin a **friend request** (username to him in the team chat). On a user-owned game, only friends can get the Edit
  permission that lets you join his private experience. Shivin adds you as a collaborator after that.
- **DeepSpace (Saturday, once Seb deploys):** open Seb's app on your laptop and sign in with Google. Practise the note:
  on the room map, click the couch, type, send. It appears on the map at once; once Ojasva's notes relay is live it
  also pops up in the headset within about 2.5 s.

### 2.4 The game-night clip (Saturday, by 2 PM, staged at the venue)

The Video memory at 0:15 is **the team's game-night session**, and you are in it. Ojasva runs the shoot by Sat 2 PM so he
can build and freeze the world by 8 PM:
- Filmed **on the table iPhone**, so the file Seb sends at 0:00 is exactly the file the world was built from (demo mode in
  Seb's app recognises it).
- The phone propped up and **completely still**, 1.5 to 3 m away, landscape. Everyone except Seb on a couch or around
  a table with controllers. The room is built from the still background, so the camera must not move.
- 15 to 20 seconds with sound: a couple of seconds of the empty spot first, then everyone sits down and plays, a
  last-second upset, everyone yelling.
- **The game screen must be visible and readable in frame**, ideally a big results screen at the end: that is how
  Gemini can answer "who won?" from what it sees. Say a name or two out loud ("Shivin, no!"), so the answer can use
  real names.
- Snacks on the table and controllers in hands: those are the labels at 0:40. Leave one obvious empty seat on the
  couch: Seb's (your note at 1:40).

---

## 3. How your piece fits

```
 Quest 3S headset (viewer, WebXR)          Déjà View server (Ojasva, Bun)              Your guide service (:8795)
 ───────────────────────────────          ──────────────────────────────              ───────────────────────────
 enter a world: capture the view  ───────▶ POST /api/guide/hotspots  ───────────────▶ POST /hotspots ─▶ Gemini boxes
 (labels are stored, so this runs once)    + scene context            ◀── labels with x, y (viewer finds the 3D spot)

 hold the button, ask out loud:            POST /api/guide/ask       ───────────────▶ POST /ask
 mic (webm/opus) + the view as a JPEG      + scene context                             ├─▶ Gemini: image + audio -> JSON
 plays `speech`, shows the caption ◀───────  returns your JSON unchanged ◀────────────  └─▶ Gemini TTS -> WAV

 enter a Photo world ───────────────────▶ POST /api/guide/narrate   ───────────────▶ POST /narrate (cached per scene)

 (server, every new upload, before the GPU job)  ──────────────────────────────────▶ POST /describe ─▶ caption = world prompt
 (server, scene ready)                           ──────────────────────────────────▶ POST /narrate (cache warm-up)
```

Who calls whom:
- The headset only calls the Déjà View server (`BASE/api/guide/<name>`). The server forwards the body to
  `GUIDE_URL/<name>`, adds the scene context, and returns your status and body unchanged.
- You call Google (Gemini). You never need to call Ojasva's server, except to download a fixture or the game-night
  clip (section 6.7).
- The 3D placement of labels is Ojasva's job: you return 2D positions on the image you were given, and his viewer
  casts a ray through each one into the room.

Network and ports:
- Your service: plain HTTP, port **8795** (not 8790 or 8791: Ojasva's test harnesses use those).
- While building (Saturday): Ojasva sets `GUIDE_URL=http://<your-laptop-ip>:8795`. Find your IP with
  `ipconfig getifaddr en0` (Mac) or `ipconfig` (Windows).
- Ojasva's server for you: `BASE` = `http://<ojasva-ip>:8788` on the same Wi-Fi (plain HTTP, so `curl` needs no `-k`
  and Node's `fetch` works). Campus Wi-Fi may block laptop-to-laptop traffic: then both of you join one phone hotspot.
- For the demo: your service runs **on Ojasva's Mac**, `GUIDE_URL=http://127.0.0.1:8795`, so the demo does not depend
  on your laptop or on Wi-Fi between laptops.
- No CORS needed: no browser calls you (except your own test page, section 8, which you serve from your own server).

Auth (recommended): put a random `GUIDE_KEY` in your `.env` (`openssl rand -hex 24`) and give it to Ojasva in person.
When it is set, every request except `GET /health` must carry `X-Guide-Key: <GUIDE_KEY>`; missing or wrong:
`401 {"error":"bad guide key"}`. Without it, anyone on the hackathon Wi-Fi could burn your Gemini quota.

Formats and units (used everywhere):
- Images: data URLs, `data:image/jpeg;base64,...` (PNG and WebP also fine). The headset sends a JPEG of what the person
  sees, about 1024 × 768 and 50 to 200 KB. `/describe` and the narrate warm-up get the scene's `thumb.jpg`.
- Audio in: data URL from the Quest's MediaRecorder, normally `data:audio/webm;codecs=opus;base64,...`, 1 to 8 seconds.
- Audio out (`speech`): `data:audio/wav;base64,...`, 24 kHz, mono, 16-bit. About 48 KB per second of speech. `null`
  when text-to-speech failed (the headset then shows the caption only).
- Positions (`x`, `y`): 0 to 1 in the image you were sent, x to the right, y down, (0, 0) = top-left.
- JSON bodies can reach about 2 MB. Accept at least 15 MB (Express's default limit is only 100 KB:
  `express.json({ limit: "15mb" })`).
- Extra fields: the server ignores fields it does not know, so you may add `ms`, `degraded`, `cached` and so on.
  Never remove or rename a field listed in section 5.

---

## 4. What Ojasva is building around you (and when)

Already live in the Déjà View server today: `GET/POST /api/scenes`, `GET /api/scenes/:id` (a Scene has `id`, `name`,
`mode`, `caption`, `thumb`, `input.files`), files at `/data/scenes/:id/<file>`, the viewer at `/view?scene=<id>`, `/ws`.

Ojasva builds these for you (`contracts.md` sections 8 and 12):

| By | Ojasva provides |
| --- | --- |
| Fri night | The LAN `BASE`, so you can download real fixtures: `BASE/data/scenes/test-tw-local/thumb.jpg` (a kitchen, from a Video scene) |
| Sat 10 AM | Proxy routes on the LAN: `POST BASE/api/guide/hotspots`, `/narrate`, `/ask` and `GET BASE/api/guide/health`, forwarding to `GUIDE_URL` with your `X-Guide-Key`, filling in `scene`, returning your JSON unchanged. Timeouts: 10 s, hotspots 15 s. (`/describe` has no proxy route: the server calls it itself.) Plus 3 real request bodies captured from the headset (a view JPEG and a recorded question), saved as JSON files, so you can test with the exact Quest formats |
| Sat 4 PM | The upload flow calls your `POST /describe` with a **5 s timeout** and uses `caption` as the world model's text prompt (and as `scene.caption`). On timeout the job falls back to its built-in captioner, so a slow `/describe` never blocks a world. Warm-up: when a scene becomes ready, the server calls `/narrate` with the thumbnail |
| Sat 6 PM | Headset: hotspot pins from your positions, hold-to-talk with captions and speech playback, a "thinking" click on release, the greeting on entry |
| Sat 8 PM | Your service running on his Mac from your folder |

If any of these slip, keep testing with curl and your fixtures. Nothing in your build order depends on his side
before Saturday afternoon.

---

## 5. The contract: every endpoint

All requests and responses are JSON (`Content-Type: application/json`). When `GUIDE_KEY` is set, all except `/health`
need `X-Guide-Key`.

**`scene`** (filled in by Ojasva's server from its store, on `/hotspots`, `/narrate` and `/ask`):

```json
{ "id": "game-night-k3x9a", "name": "Game night", "mode": "video",
  "caption": "A small lounge with a grey couch facing a TV on a low cabinet, carpet tiles and warm lamp light; a door and a bookshelf are likely just behind the camera.",
  "hotspots": [ { "label": "screen", "blurb": "Scene of the crime" } ] }
```

`mode` is `"photo"` or `"video"` (bundled samples may say something else: treat anything that is not `video` as a
place). `caption` is what your own `/describe` wrote. `hotspots` (optional) lists the labels already pinned in this
world. Any field may be missing: never crash on it.

### 5.1 `GET /health`

```json
{ "ok": true, "gemini": "ok", "mock": false,
  "models": { "fast": "gemini-3.5-flash-lite", "spatial": "gemini-3.8-flash", "tts": "gemini-3.8-flash-lite-tts" },
  "voice": "Sulafat", "uptimeS": 5321 }
```
`gemini` is `"ok"`, `"degraded"` (last call failed, using fallback) or `"off"` (mock mode). Ojasva's host page shows it.

### 5.2 `POST /describe {image}` → `{caption}`: Gemini decides what gets imagined

The world model builds a whole walkable room from one image, and it fills in everything the camera missed from a
**text prompt**. Today that prompt comes from a small local captioner or a neutral default sentence. Yours replaces it.

Request:
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ..." }
```
Response:
```json
{ "caption": "A small sunlit dorm room with a white lofted bed, a pine desk under a wide window, grey carpet and warm afternoon light. Just outside the frame: a narrow closet with mirror doors on the left, a mini fridge and a hallway door behind the camera, posters on pale painted walls.",
  "ms": { "understand": 900 } }
```
- `caption`: **one or two sentences** (about 25 to 50 words) describing the place for a world generator: layout,
  main objects, materials, colours, light, then what is likely just outside the frame and behind the camera, in the same
  style. **No people** (for a video, the image is the empty spot from the first second; if someone is in it anyway,
  describe the room only). No text or signs, no words like "photo", "image" or "camera angle".
- **A frame from a video game** (one demo world is a clean, HUD-free Fortnite frame): describe that game world in its
  own art style (stylised, bright, not photoreal), and what lies beyond the frame in the same style, for example "A
  bright stylised hillside with wooden cabins, a winding dirt path and round cartoon trees under a clear sky; beyond the
  frame, more cabins, a small lake and rolling green hills in the same game art style."
- The server uses `caption` as the world model's text prompt (the uploader's own text, if any, goes first) and stores
  it as `scene.caption`. Seb's gallery may show it, and your own `/narrate` and `/ask` later get it
  back as context.
- Target 1.5 s, hard limit 5 s (Ojasva's timeout). Use image `resolution: "medium"` here: detail matters more than
  speed, and nobody watches this call.
- Failure: `200 {"caption": "", "degraded": true, "error": "..."}`. The server then uses its built-in captioner.

### 5.3 `POST /hotspots {image, scene}` → `{hotspots:[{label, x, y, blurb}]}`: the floating labels

Request (what the headset sees right now, captured with a known camera):
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "scene": { "id": "game-night-k3x9a", "name": "Game night", "mode": "video", "caption": "A small lounge ..." } }
```
Response:
```json
{ "hotspots": [
    { "label": "screen", "x": 0.52, "y": 0.31, "blurb": "Scene of the crime" },
    { "label": "controllers", "x": 0.36, "y": 0.62, "blurb": "Still warm" },
    { "label": "snacks", "x": 0.60, "y": 0.75, "blurb": "Mostly crumbs now" } ],
  "cached": false, "degraded": false, "ms": { "understand": 2400 } }
```
- `x`, `y`: the **centre of the object** in the image you received, 0 to 1 (x right, y down). Gemini gives you a box
  (section 6.3); convert it: `x = (xmin + xmax) / 2000`, `y = (ymin + ymax) / 2000`. Ojasva casts a ray through that
  point, so the point must sit on the object itself, not on the gap next to it. A tight box gives a good centre.
- `label`: 1 to 3 lowercase words, the plain name of the object. `blurb`: at most 5 words, in the room's voice, shown
  under the label.
- **3 to 6 items**, the most interesting things in the shot: screens, game controllers, snacks and food, instruments,
  windows, art, furniture with character. Never label people, faces, walls, the floor or the ceiling. Controllers in
  someone's hands are fine: box the controller, not the hand. Skip anything smaller than about 3% of the image or cut
  off at the edge.
- You may also return `box` (`[ymin, xmin, ymax, xmax]`, 0 to 1000) per item for your own test page; the server
  ignores it.
- Cache by `scene.id` plus a hash of the image. Remember the labels per `scene.id` too: `/ask` uses them. Nobody
  waits on this for the demo worlds (they are labelled in rehearsal and stored by Ojasva). For the live world at 2:25,
  aim for under 4 s.
- Failure: `200 {"hotspots": [], "degraded": true, "error": "..."}`. No labels is better than wrong labels.

### 5.4 `POST /narrate {image, scene}` → `{answer, speech}`: the greeting when someone enters

Request:
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "scene": { "id": "judge-photo-x8d1f", "name": "Judge's photo", "mode": "photo", "caption": "A bright living room ..." } }
```
Response:
```json
{ "answer": "Nice place. Someone left every light on, and that radiator has seen things.",
  "speech": "data:audio/wav;base64,UklGRi...",
  "speechSeconds": 3.1, "cached": false, "degraded": false, "ms": { "understand": 780, "tts": 640, "total": 1440 } }
```
- `answer`: one funny line, one or two short spoken sentences, 8 to 22 words, naming one specific thing that is
  really visible.
- Ojasva's server calls this **before** anyone enters, with the scene thumbnail, the moment the scene becomes ready.
  The headset's own call on entering a Photo world is then a cache hit and the greeting plays instantly.
- Cache by `scene.id` for 30 minutes; a hit returns in milliseconds. `image` may be missing on a cache hit. No cache and
  no image: `400 {"error":"image required"}`.
- In the skit, Video worlds do not play a greeting (the video's own sound is playing), but keep it working.

### 5.5 `POST /ask {image, audio | question, scene, history}` → `{question, answer, speech, hotspot?}`

Request:
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "audio": "data:audio/webm;codecs=opus;base64,GkXfo59C...",
  "scene": { "id": "game-night-k3x9a", "name": "Game night", "mode": "video", "caption": "A small lounge ...",
             "hotspots": [ { "label": "screen", "blurb": "Scene of the crime" },
                           { "label": "controllers", "blurb": "Still warm" } ] },
  "history": [ { "q": "where am I?", "a": "Game night. You missed it. Everyone noticed." } ] }
```
- `image`: exactly what the judge is looking at right now (in a Video world it includes the footage playing in 3D).
- `audio` is the spoken question (Gemini understands audio directly; no speech-to-text step). `question` is typed text
  instead (desktop, Ojasva's host page). Exactly one of them is set.
- `history`: the last few turns, `[{q, a}]`; use at most the last 4.

Response:
```json
{ "question": "who won?",
  "answer": "Shivin, on the very last second. The couch has not recovered.",
  "speech": "data:audio/wav;base64,UklGRi...",
  "hotspot": { "label": "screen", "x": 0.52, "y": 0.31 },
  "speechSeconds": 3.6, "degraded": false, "ms": { "understand": 910, "tts": 620, "total": 1560 } }
```
- `question`: what was asked, word for word (drop filler like "um"). `answer`: one or two short spoken sentences, at
  most 30 words, specific to the image, a little funny.
- `hotspot` (optional): when the answer is about one visible thing, its label (reuse a label from `scene.hotspots` when
  it matches) and its centre in the image. The headset highlights that pin. Leave it out when the answer is not about
  one thing.
- Empty or unclear audio: return `200` with `question: ""` and an answer like "Sorry, I missed that. Hold the button
  and try again." Skip Gemini when the decoded audio is under about 2 KB (a fraction of a second).
- **Under 2 s** for the whole call (section 6.6).

### 5.6 Errors

| Status | When | Body |
| --- | --- | --- |
| 400 | malformed JSON, `image`/`audio` not a base64 data URL, both `audio` and `question` missing, `/narrate` with no image and no cache | `{ "error": "audio must be a base64 data URL" }` |
| 401 | `GUIDE_KEY` set and the header is missing or wrong | `{ "error": "bad guide key" }` |
| 413 | body over 15 MB | `{ "error": "too large" }` |
| 200 + `degraded: true` | Gemini or TTS failed or timed out and a fallback answered | the normal body plus `"error": "gemini timeout"` |

Rule: on these four routes you never return a 500. Every failure becomes a fallback answer with `degraded: true`, so
the headset always has something to say.

---

## 6. Gemini: models, calls and prompts

### 6.1 Which models (verified at https://ai.google.dev/gemini-api/docs/models)

| Job | Model | Why |
| --- | --- | --- |
| `/ask`, `/narrate`, `/describe` (image + audio in, JSON out) | `gemini-3.5-flash-lite` | Stable. Google calls it its "fastest, most cost-effective 3.5 model". Inputs: text, image, video, audio, PDF. Structured output supported. Thinking defaults to `minimal` (the fastest) |
| `/hotspots` (boxes) | `gemini-3.8-flash`, `thinking_level: "low"` | Google's object-detection docs show bounding boxes with this model (https://ai.google.dev/gemini-api/docs/image-understanding). The 3.5 Flash-Lite page does not list detection. Try 3.5 Flash-Lite too and keep whichever draws tighter boxes |
| Backup if answers feel dumb | `gemini-3.6-flash` with `thinking_level: "minimal"` | Smarter, a bit slower. Supports `minimal` |
| Video notes for the game-night clip (section 6.7, optional) | `gemini-3.8-flash` with `thinking_level: "low"` | Best Flash model, latency doesn't matter here. **`minimal` is not supported on 3.8 Flash and returns an error** (https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| Text to speech | `gemini-3.8-flash-lite-tts` | Stable, built for real-time voice agents: fast |
| TTS backup | `gemini-3.8-flash-tts` | Same request format, more expressive, slower |

Don't use models from old tutorials: `gemini-2.0-flash` and `gemini-3.1-flash-lite-preview` are shut down, and the
2.5 models are limited to accounts that used them before. Put model names in `.env` so you can switch without code
changes.

### 6.2 Which API

The docs show every example with the **Interactions API** (`ai.interactions.create`, snake_case fields like
`mime_type`). It is labelled Beta, and the older `ai.models.generateContent` (camelCase `inlineData`, `mimeType`)
"remains fully supported" (https://ai.google.dev/gemini-api/docs/interactions). Use Interactions, because the 3.8
text-to-speech and object-detection docs are written for it. **Don't mix field styles from the two APIs**: that is the
most common way to lose an hour. If a call fails in a way you can't explain, check you have `@google/genai` 2.24 or
newer.

Docs you will use:
- Audio input: https://ai.google.dev/gemini-api/docs/audio
- Images and object detection: https://ai.google.dev/gemini-api/docs/image-understanding
- Text-to-speech: https://ai.google.dev/gemini-api/docs/speech-generation
- JSON output: https://ai.google.dev/gemini-api/docs/structured-output
- Thinking levels: https://ai.google.dev/gemini-api/docs/thinking
- Video: https://ai.google.dev/gemini-api/docs/video-understanding

### 6.3 Facts that matter

- Audio input MIME types accepted: `audio/wav`, `audio/mp3`, `audio/aiff`, `audio/aac`, `audio/ogg`, `audio/flac`,
  `audio/mpeg`, `audio/m4a`, `audio/l16`, `audio/opus`, `audio/alaw`, `audio/mulaw`, **`audio/webm`**. So the Quest's
  webm/opus works directly with no conversion. Send the base MIME type `audio/webm` (strip `;codecs=opus`).
- Inline data (base64 in the request) is fine up to **20 MB total request size**. A view JPEG plus 8 s of opus is
  about 0.3 MB.
- Audio costs 32 tokens per second. An image up to 384 × 384 costs 258 tokens; larger images are cut into 768 × 768
  tiles of 258 tokens each. You can set `resolution: "low"` on an image part for fewer tokens and lower latency.
- Put the text part **before** the image in `input` (Google's own tip).
- **Boxes:** the model is trained to return `box_2d` as `[ymin, xmin, ymax, xmax]` normalized to 0 to 1000. Ask for
  exactly that key and order in your schema and prompt, then convert to the 0-to-1 centre point (section 5.3). For
  detection, Google recommends the lowest thinking level the model allows.
- TTS output on a normal (non-streaming) request is a **complete WAV file with header**: 24 kHz, mono, 16-bit. You do
  not need to add a WAV header. Older TTS models returned raw PCM and old tutorials wrap it in a header manually:
  don't, unless the response's `mime_type` is `audio/l16` (snippet in 6.4).
- 3.8 TTS reads `text` **word for word**. "Say cheerfully: hello" will be read out loud. Put delivery in
  `speech_metadata.style`, and only short tags inline, like `<laugh>`, `<sigh>`, `<short pause>`.
- 30 prebuilt voices. Good candidates for "the room": **Sulafat** (warm), **Achird** (friendly), **Puck** (upbeat),
  **Zubenelgenubi** (casual). Try all four on Saturday morning, pick one, and keep it for the whole weekend.
- Videos: inline only under 20 MB per request. A phone clip can easily be 15 MB or more (about 20 MB as base64), too
  close to the limit. Use the Files API (upload, poll until `ACTIVE`; section 6.7).

### 6.4 Snippets (the parts that remove guesswork, not your whole server)

These shapes come from Google's docs and the SDK's own type definitions (v2.30.0). They could not be run without a
key, so your first smoke test confirms them. If the API rejects `store`, `resolution` or `max_output_tokens`, delete
that one field and carry on: none of them is essential.

Client, and splitting a data URL:
```js
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// "data:audio/webm;codecs=opus;base64,AAAA" -> { mime: "audio/webm", data: "AAAA" }
function splitDataUrl(url) {
  const m = /^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(url ?? "");
  return m ? { mime: m[1], data: m[2] } : null;
}

// Gemini box [ymin, xmin, ymax, xmax] (0-1000) -> centre point (0-1), the contract's x, y
const centre = ([ymin, xmin, ymax, xmax]) =>
  ({ x: +((xmin + xmax) / 2000).toFixed(3), y: +((ymin + ymax) / 2000).toFixed(3) });
```

Understanding call for `/ask` (image + audio in, JSON out):
```js
const ASK_SCHEMA = {
  type: "object",
  properties: {
    question:       { type: "string", description: "What the person asked, word for word. Empty if no speech." },
    answer:         { type: "string", description: "1-2 short spoken sentences, max 30 words." },
    hotspot_label:  { type: "string", description: "Label of the one visible thing the answer is about, or empty." },
    hotspot_box_2d: { type: "array", items: { type: "integer" },
                      description: "[ymin, xmin, ymax, xmax] 0-1000 of that thing, or empty." },
  },
  required: ["question", "answer", "hotspot_label", "hotspot_box_2d"],
};

const img = splitDataUrl(body.image), aud = splitDataUrl(body.audio);
const input = [{ type: "text", text: contextText }];             // text first
if (img) input.push({ type: "image", data: img.data, mime_type: img.mime, resolution: "low" });
if (aud) input.push({ type: "audio", data: aud.data, mime_type: aud.mime });

const res = await ai.interactions.create({
  model: process.env.MODEL_FAST,                                  // gemini-3.5-flash-lite
  store: false,                                                   // don't keep the judge's voice on Google's side
  system_instruction: ASK_SYSTEM,
  input,
  response_format: { type: "text", mime_type: "application/json", schema: ASK_SCHEMA },
  generation_config: { thinking_level: "minimal", temperature: 0.9, max_output_tokens: 256 },
}, { timeout_ms: 6000, retries: { strategy: "none" } });   // you do your own single retry

const out = JSON.parse(res.output_text);
const hotspot = out.hotspot_label && out.hotspot_box_2d?.length === 4
  ? { label: out.hotspot_label, ...centre(out.hotspot_box_2d) } : undefined;
```
`contextText` is plain text you build: scene name and mode, `scene.caption`, the labels in `scene.hotspots` (or the ones
you remembered for `scene.id`), the video notes for this `scene.id` if you made them (6.7), the last 4 history turns,
and the typed `question` if there is no audio. For `/narrate` use the same call without audio and with `{ answer }`
only.

Hotspots call (boxes):
```js
const HOTSPOT_SCHEMA = {
  type: "object",
  properties: {
    hotspots: { type: "array", items: { type: "object", properties: {
      label:  { type: "string" },
      box_2d: { type: "array", items: { type: "integer" }, description: "[ymin, xmin, ymax, xmax] normalized to 0-1000" },
      blurb:  { type: "string" },
    }, required: ["label", "box_2d", "blurb"] } },
  },
  required: ["hotspots"],
};

const res = await ai.interactions.create({
  model: process.env.MODEL_SPATIAL,                               // gemini-3.8-flash
  store: false,
  system_instruction: HOTSPOTS_SYSTEM,
  input: [{ type: "text", text: contextText }, { type: "image", data: img.data, mime_type: img.mime }],
  response_format: { type: "text", mime_type: "application/json", schema: HOTSPOT_SCHEMA },
  generation_config: { thinking_level: "low", temperature: 0.4 },
}, { timeout_ms: 12000, retries: { strategy: "none" } });
const hotspots = JSON.parse(res.output_text).hotspots
  .filter(h => h.box_2d?.length === 4 && h.box_2d.every(n => n >= 0 && n <= 1000))
  .slice(0, 6)
  .map(h => ({ label: h.label, ...centre(h.box_2d), blurb: h.blurb, box: h.box_2d }));
```
Check the points with your eyes before trusting them: draw the boxes and centre dots on the image in your test page
(section 8). If they are consistently shifted, you are probably sending another image size than you think, or
swapping x and y.

Text to speech:
```js
const tts = await ai.interactions.create({
  model: process.env.MODEL_TTS,                                   // gemini-3.8-flash-lite-tts
  input: [{ type: "user_input", content: [{
    type: "text", text: answerText,
    annotations: [{ type: "speech_metadata", style: "warm, dry, amused, quick conversational pace" }],
  }]}],
  response_format: { type: "audio" },
  generation_config: { speech_config: [{ voice: process.env.VOICE }] },  // e.g. "Sulafat"
}, { timeout_ms: 5000, retries: { strategy: "none" } });

const a = tts.output_audio;                     // { data: <base64>, mime_type: "audio/wav" }
let wav = Buffer.from(a.data, "base64");
if ((a.mime_type ?? "").includes("l16")) wav = pcmToWav(wav);   // only if you ever get raw PCM
const speech = `data:audio/wav;base64,${wav.toString("base64")}`;
const speechSeconds = +((wav.length - 44) / 48000).toFixed(2); // 24000 Hz * 2 bytes
```

Raw PCM to WAV (only needed if `mime_type` is `audio/l16`):
```js
function pcmToWav(pcm, rate = 24000) {           // 16-bit little-endian mono samples
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
```

Python equivalents are the same shapes: `client = genai.Client()`, `client.interactions.create(model=..., input=[...],
response_format={...}, generation_config={...})`, `interaction.output_text`, `interaction.output_audio.data`.

### 6.5 Prompt design

The voice is **the room itself**: dry, warm, observant, a little funny, like a friend who has been here before. It
notices one specific thing. It teases objects and situations, never people's bodies or looks. It never sounds like an
assistant.

`NARRATE_SYSTEM` (starting point, tune it with real screenshots):
```
You are the voice of a room in Déjà View. People walk into 3D copies of real places and memories wearing a VR
headset. You ARE the room, greeting whoever just walked in.
Rules:
- One or two short spoken sentences, 8 to 22 words in total. It is read aloud.
- Mention one specific thing that is really visible: an object, a colour, where it is. Never generic praise.
- Warm, dry, a little funny. Tease objects and situations, never people's bodies, faces or clothes.
- No markdown, emoji, lists, quotation marks or stage directions.
- Never mention images, photos, screenshots, rendering, 3D, AI, blur or pixels. Talk as if you are really there.
- mode "photo": a place. Be the honest friend showing them around. If it is a video game world, play along.
- mode "video": a recorded moment with real people that the listener missed. Welcome them back into it.
```
Examples (good):
- Bright living room, old radiator: "Nice place. Someone left every light on, and that radiator has seen things."
- Small bedroom, desk under the window: "Cozy. The desk gets the window, so you have no excuse not to study."
- Video memory, game night: "Welcome back to game night. You missed a lot, and the couch remembers."

Bad (reject in testing): "What a lovely and inviting space!" (generic), "In this image I can see a bed." (breaks the
illusion), "Hello! How can I help you today?" (assistant voice).

`ASK_SYSTEM`:
```
You are the voice of the room in Déjà View. The person is standing inside a 3D copy of this place wearing a VR headset.
They asked you a question out loud (the audio clip) or typed it (text). The image is exactly what they are looking at.
In a video memory, real footage of real people plays inside the room; a game screen in the image may show the score.
Return JSON:
- question: what they asked, word for word (drop filler like "um"). Empty string if there is no speech.
- answer: one or two short spoken sentences, at most 30 words. Answer the actual question. Use what is visible first,
  then the video notes, then the scene notes. Be specific about objects, colours and positions (left, right, by the
  window, behind you). Dry and a little funny, never mean about people.
- hotspot_label and hotspot_box_2d: if the answer is about one visible thing, its label (reuse a listed label when it
  matches) and its tight box [ymin, xmin, ymax, xmax] normalized to 0-1000; otherwise "" and [].
If you can't see the answer, say so honestly and playfully, then make your best guess from context.
No markdown, emoji or lists. Never mention images, photos, screenshots, rendering, AI or 3D.
```
Examples:
| Question | Good answer |
| --- | --- |
| "who won?" (results screen visible) | "Shivin, on the very last second. The couch has not recovered." |
| "what's by the window?" | "A little herb pot and a stack of mail you are definitely not supposed to read." |
| "is there a TV?" | "No TV. Just a very confident beanbag facing a blank wall." |
| "who is that?" (Video world) | "Grey cap. Lost by a hair, and blamed the controller." |

`HOTSPOTS_SYSTEM`:
```
You pick the objects in a room that a visitor would want to point at and ask about, and you label them.
Return JSON: hotspots, 3 to 6 items, each with
- label: the plain name, 1 to 3 lowercase words ("screen", "controllers", "snacks").
- box_2d: a tight bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000.
- blurb: at most 5 words, dry and a little funny, about this object here ("Scene of the crime").
Prefer screens, game controllers, snacks and food, instruments, windows, art, plants and furniture with character.
Never label people, faces, body parts, walls, the floor or the ceiling. A controller in someone's hands is fine: box the
controller only. Skip anything tiny or cut off at the edge.
Never label the same object twice.
```

`DESCRIBE_SYSTEM` (for the world model, not for people):
```
You write the text prompt for a 3D world generator that turns ONE image into a walkable room. The generator must
invent everything outside the image, so tell it what is there.
Return JSON: caption, one or two sentences, 25 to 50 words. First what is visible: kind of place, layout, main objects,
materials, colours, light. Then the most likely things just outside the frame and behind the camera, consistent with
the style and era of the place. No people, no text or signs, no words about photos or cameras.
If the image is a video game frame, describe the game world in its own art style (stylised, not photoreal) and keep
that style for what lies beyond the frame.
```
Judge it by walking the result with Ojasva: if the generated room has odd things behind you, make the "outside the
frame" part more conservative (furniture the visible style implies, not surprises).

### 6.6 Latency plan (targets measured inside your service)

| Call | Target p50 | Hard ceiling | How |
| --- | --- | --- | --- |
| `/ask` total | **under 2.0 s** | 3.0 s | understanding at most 1.2 s plus TTS at most 0.8 s |
| `/narrate` | **under 50 ms** on a cache hit | 2.5 s cold | Ojasva warms it with the thumbnail when the scene is ready |
| `/hotspots` | 4 s | 12 s | runs once per world; demo worlds are stored in rehearsal |
| `/describe` | 1.5 s | 5 s (Ojasva's timeout) | runs right after upload, nobody watches it |

What makes it fast:
1. `gemini-3.5-flash-lite`, thinking `minimal`, image `resolution: "low"` (try `"medium"` if answers miss details,
   for example a small score on the game screen), a short system prompt.
2. Keep answers short. TTS time grows with text length.
3. Warm up on startup: send one tiny request to each model so the first real request doesn't pay for the connection
   setup.
4. Log `ms` for every stage of every request and print a line like `ask 1540ms (understand 900, tts 640)`. Run each
   fixture 5 times, write down the median, and send it to Ojasva by Sat 10 AM.
5. Cache speech by exact text (a `Map` from text to data URL). Fallback lines repeat a lot.
6. For the demo question, warm the connection: before each run, ask "who won?" 3 times. Nothing about the answer is
   cached, so it is still live.
7. Ojasva plays a short "thinking" click on button release, so the first half second never feels dead.

Latency of the real models could not be measured without a key. Measuring it is your first job once the key works.

### 6.7 Optional: video notes for the game-night memory (after Sat 2 PM, about 45 min)

"Who won?" must land at 0:40. The first line of defence is the clip itself: the results screen is big and readable,
and names are said out loud. The second is a one-time summary of the clip, made once with the Files API and added as
context to `/ask` and `/narrate` whenever `scene.id` is the game-night scene. This changes nothing in the contract.

1. Get the clip: AirDrop from the table iPhone, or download it from Ojasva's server:
   `GET BASE/api/scenes/<id>` → `input.files[0]` (for example `input/video.mov`) →
   `curl -o cache/video/<id>.mov BASE/data/scenes/<id>/input/video.mov`.
2. Run a small script (not an endpoint):
```js
const file = await ai.files.upload({ file: `cache/video/${sceneId}.mov`, config: { mimeType: "video/quicktime" } });
let f = await ai.files.get({ name: file.name });
while (f.state === "PROCESSING") { await new Promise(r => setTimeout(r, 2000)); f = await ai.files.get({ name: file.name }); }
if (f.state === "FAILED") throw new Error("video processing failed");
const res = await ai.interactions.create({
  model: process.env.MODEL_VIDEO,                                 // gemini-3.8-flash
  store: false,
  input: [ { type: "text", text: VIDEO_PROMPT }, { type: "video", uri: f.uri, mime_type: f.mimeType } ],
  response_format: { type: "text", mime_type: "application/json", schema: VIDEO_SCHEMA },
  generation_config: { thinking_level: "low" },
}, { timeout_ms: 90000 });
// save res.output_text to cache/video/<sceneId>.json
```
   `files.upload` uses camelCase `mimeType` in `config` (as in Google's own example), while the content parts use
   `mime_type`. iPhone clips are usually `.mov` (`video/quicktime`); pass the real type.
3. `VIDEO_PROMPT`: "Watch this short video of friends playing a game. Return JSON: oneLine (max 20 words), activity,
   people (short neutral descriptions by clothing or position; add a name only if it is spoken in the video), objects
   (list), outcome (who won or how it ended, one line), moments (up to 6, each {t: seconds, what}), funnyDetail (one
   line). Describe what happens, not how people look."
4. Read the JSON yourself. If the outcome is wrong, fix it by hand in the file: you were there.

---

## 7. Build order (with checkpoints)

Recommended layout:
```
guide/
  package.json          "type": "module", "start": "node server.mjs"
  .env.example          every variable, no values
  .gitignore            .env, node_modules/, cache/
  README.md             how to start, env vars, endpoints (short)
  server.mjs            routing, optional key check, body limit, errors, timing logs
  gemini.mjs            understand(), boxes(), speak(), warmup()
  prompts.mjs           system prompts, schemas, examples
  fallback.mjs          canned lines, macOS `say` speech
  scripts/video-notes.mjs   section 6.7 (optional)
  public/test.html      your test page (section 8) and voice-client.js
  test/fixtures/        rooms, gaming setup, kitchen.jpg, q-won.webm, q-window.webm, *.json bodies
  test/*.sh             curl scripts
  cache/                narrate, hotspots, video notes (gitignored)
```

`.env.example`:
```
PORT=8795
GUIDE_KEY=
GEMINI_API_KEY=
MODEL_FAST=gemini-3.5-flash-lite
MODEL_SPATIAL=gemini-3.8-flash
MODEL_VIDEO=gemini-3.8-flash
MODEL_TTS=gemini-3.8-flash-lite-tts
VOICE=Sulafat
MOCK_GEMINI=0
```

**By Sat 10 AM (steps 1 to 8): all four endpoints working via curl.**

| Step | Time | You should now see |
| --- | --- | --- |
| 1. Skeleton: `/health`, optional `X-Guide-Key` check, 15 MB body limit, JSON errors, one log line per request with ms | 30 min | `curl localhost:8795/health` prints `ok: true`; with `GUIDE_KEY` set, a request without the key gets 401 |
| 2. Text-to-speech helper `speak(text)` + `test/speak.sh` | 40 min | a WAV file that `afplay` plays. Try the 4 voices, pick one |
| 3. `/narrate` with an image | 45 min | a one-line greeting that names something really in the photo, plus speech; a second call for the same `scene.id` is a cache hit in under 50 ms |
| 4. `/describe` | 30 min | for 3 room photos and the gaming-setup screenshot, a one or two sentence caption that describes the visible place and a believable rest of it, no people |
| 5. `/hotspots` + boxes and centre dots drawn in your test page | 60 min | on a game-room photo: 3 to 6 points sitting on real objects (screen, controllers, snacks), none on people or walls. Compare `gemini-3.8-flash` with `gemini-3.5-flash-lite` and keep the better one |
| 6. `/ask` with audio | 60 min | `q-won.webm` on the gaming-setup screenshot comes back with `question: "who won?"`, an answer about the screen and `hotspot.label: "screen"`; typed `question` works too |
| 7. Latency pass | 30 min | median `/ask` under 2 s written down; `resolution: "low"` vs `"medium"` compared; warmup on boot |
| 8. Fallbacks and mock mode (section 9) | 45 min | with the Gemini key removed, everything still answers with `degraded: true` |

**Saturday afternoon:**

| Step | Time | You should now see |
| --- | --- | --- |
| 9. The game-night frame (after the Sat 2 PM shoot) and, optionally, video notes (6.7) | 45 min | `/ask` "who won?" on a real game-night frame names the right winner |
| 10. Connect to Ojasva's server (`GUIDE_URL`, `GUIDE_KEY`) | 30 min | the headset shows your labels and answers through `BASE/api/guide/*` |
| 11. Prompt polish with real headset views | rest of the evening | 10 questions in a row with no generic or broken answers; labels on the right things in all three demo worlds |

Making test fixtures: room photos (take 3 with your phone, export as JPEG), **a screenshot of a gaming setup** (a TV or
monitor with a game results screen, controllers, snacks; your own photo or a screenshot), and Ojasva's existing Video
scene thumbnail.
```bash
B=http://<ojasva-ip>:8788      # Ojasva's server, plain HTTP
curl -s -o test/fixtures/kitchen.jpg $B/data/scenes/test-tw-local/thumb.jpg
# from Sat 2 PM, once Ojasva posts the game-night scene id as $GN:
curl -s $B/api/scenes/$GN | jq -r .thumb          # then download $B/data/scenes/$GN/<thumb>

# repeatable spoken questions (macOS); record your own voice too
say -o /tmp/q.aiff "Who won?"              && ffmpeg -y -i /tmp/q.aiff -c:a libopus -b:a 32k test/fixtures/q-won.webm
say -o /tmp/q.aiff "What's by the window?" && ffmpeg -y -i /tmp/q.aiff -c:a libopus -b:a 32k test/fixtures/q-window.webm
# real mic, 4 seconds (macOS):  ffmpeg -f avfoundation -i ":0" -t 4 -c:a libopus test/fixtures/q-real.webm

# build request bodies (big base64 goes through files, not command-line arguments)
base64 -i test/fixtures/gaming.jpg | tr -d '\n' > /tmp/img.b64        # Linux: base64 -w0 file
base64 -i test/fixtures/q-won.webm | tr -d '\n' > /tmp/aud.b64
SCENE='{"id":"test-gaming","name":"Game room","mode":"video","caption":""}'
jq -n --rawfile img /tmp/img.b64 '{image:("data:image/jpeg;base64,"+$img)}' > test/fixtures/describe-gaming.json
jq -n --rawfile img /tmp/img.b64 --argjson scene "$SCENE" \
  '{image:("data:image/jpeg;base64,"+$img), scene:$scene}' > test/fixtures/hotspots-gaming.json
jq -n --rawfile img /tmp/img.b64 --rawfile aud /tmp/aud.b64 --argjson scene "$SCENE" \
  '{image:("data:image/jpeg;base64,"+$img), audio:("data:audio/webm;codecs=opus;base64,"+$aud),
    scene:$scene, history:[]}' > test/fixtures/ask-won.json

# call them, show the text, play the voice
H=(-H 'Content-Type: application/json' -H "X-Guide-Key: $GUIDE_KEY")
curl -s -X POST localhost:8795/describe "${H[@]}" --data @test/fixtures/describe-gaming.json | jq .caption
curl -s -X POST localhost:8795/hotspots "${H[@]}" --data @test/fixtures/hotspots-gaming.json | jq -c '.hotspots[] | {label, x, y, blurb}'
curl -s -X POST localhost:8795/ask "${H[@]}" --data @test/fixtures/ask-won.json > /tmp/out.json
jq '{question, answer, hotspot, ms}' /tmp/out.json
jq -r .speech /tmp/out.json | sed 's/^data:audio\/wav;base64,//' | base64 -d > /tmp/out.wav && afplay /tmp/out.wav
```
On Windows, write the body builder as a 10-line Node script instead of `base64`/`jq`.

---

## 8. Your test page (Saturday morning, about 1 hour, worth it)

Serve `public/test.html` from your own server (no CORS needed). It has:
- a file picker for an image, which draws your `/hotspots` boxes and centre dots on top (a `<canvas>` over the image:
  dot at `x * width`, `y * height`; box from `box[1] / 1000 * width`, `box[0] / 1000 * height` and so on). This is how
  you judge label quality;
- a hold-to-talk button (`MediaRecorder`, `audio/webm;codecs=opus`) that calls `/ask` with the picked image, shows the
  question and answer, plays the speech and rings the returned `hotspot`;
- a latency readout from `ms`.

Put the recording and playback code in a separate, dependency-free `public/voice-client.js` with three functions:
`start()`, `stop()` (returns a promise of `{ dataUrl, mimeType, seconds }`) and `play(speechDataUrl)` (returns a promise
that resolves when playback ends). It produces exactly the audio format the Quest sends, it is your desktop backup on
the night, and Ojasva may drop it straight into the headset to save himself an hour. Send it to him by Sat 4 PM.

Anything you draw uses the Déjà View look: near-black background (#0B0B0F), white text, one acid-lime accent
**#C6FF3D**, bold type (700 to 800 weight).

---

## 9. Fallbacks (built in, tested before Saturday 10 PM)

| What breaks | What your service does automatically | What you do |
| --- | --- | --- |
| Gemini understanding fails, times out (6 s) or hits quota (429) | canned line chosen by mode and keywords (won, who, window, what), `degraded: true`; one retry on 429/503 after 300 ms | check `/health`, switch `MODEL_FAST` to `gemini-3.6-flash`, or move to Tier 1 ($5) |
| `/hotspots` fails | `hotspots: []`, `degraded: true` | the three demo worlds are already stored on Ojasva's server, so the demo does not notice |
| `/describe` fails | `caption: ""`, `degraded: true` | the server uses its built-in captioner; the world still builds |
| TTS fails | macOS fallback: `say -o out.wav --file-format=WAVE --data-format=LEI16@24000 "<text>"` (about 1 s, works on Ojasva's Mac); otherwise `speech: null` and the headset shows the caption | pre-generate speech for the fixed lines (greetings for the demo worlds) and cache them on disk |
| No Gemini key at all | `MOCK_GEMINI=1`: realistic canned JSON in the exact shapes, with a short fake delay; mock hotspots return 3 fixed points | lets Ojasva integrate against you before your key works |
| Venue Wi-Fi blocks laptop-to-laptop | | phone hotspot for both laptops, or move your folder onto Ojasva's Mac early (the plan for the demo anyway) |
| Internet down | everything degrades to canned lines | phone hotspot. The recorded 10 s clips are the last resort |

Canned lines must sound like the room too, for example "Give me a second, I'm still moving in. Ask me again." /
"Honestly? I was looking the other way. Ask me again."

---

## 10. Quality bar for the demo

- **Speed:** `/ask` p50 under 2.0 s, never over 3 s. The greeting is instant because it is warmed up.
- **Labels:** 3 to 6 per world, all on real, askable things, the point right on the object, never on people. Walk all
  three demo worlds with Ojasva on Sat 8 PM and fix any label that is wrong or floating in the wrong place.
- **Voice:** one voice and one style everywhere (greeting, answers). Answers of 1 or 2 sentences.
- **Content:** specific to what is visible, short, dry, funny, never mean about people, never "As an AI" or "In this
  image". Ten questions in a row without a generic answer before you call it done.
- **Describe:** the walked world behind you looks like a believable continuation of the photo.
- **Robustness:** no 500s on the four routes, no crash on missing optional fields, every failure becomes a fallback.

Stretch (only after section 7 is done): use `history` so follow-ups work ("and what's next to it?").

---

## 11. Milestones

| When | Done means |
| --- | --- |
| Tonight (Fri) | Gemini key works (one successful curl). Free-tier limits written down and sent to Ojasva. Roblox account made and friend request sent to Shivin |
| **Sat 10 AM** | `/health`, `/describe`, `/hotspots`, `/narrate`, `/ask` answer real fixtures (room photos, the gaming-setup screenshot) via curl; median `/ask` measured and sent to Ojasva (goal under 2 s); `MOCK_GEMINI` works |
| Sat 2 PM | In the game-night clip with the team |
| **Sat afternoon (by 4 PM)** | `GUIDE_KEY` handed to Ojasva in person; connected through his server (`GUIDE_URL`) and at least one real headset question answered end to end; "who won?" right on a real game-night frame; `voice-client.js` sent |
| Sat 8 PM | Running on Ojasva's Mac; labels checked in all three demo worlds |
| **Sat 10 PM** | Full skit + finale run twice with a timer: labels, "who won?", your Roblox avatar at 1:10, your note at 1:40, the live world's greeting at 2:25. Fallbacks tested: Gemini key removed, Wi-Fi off |
| **Sun 4 AM** | Feature freeze. Record 10 s clips: labels popping in, the spoken "who won?" answer, the greeting in the live world |
| Sun 8 AM | Submitted (Ojasva submits; you send your Devpost lines by 6 AM) |

---

## 12. Hand-off

1. **Saturday afternoon (connect):** on the same Wi-Fi, send Ojasva `http://<your-ip>:8795` and give him `GUIDE_KEY`
   in person. He sets `GUIDE_URL` and `GUIDE_KEY` on his server.
2. **By Sat 8 PM (move to his Mac):** send a zip of your folder **without** `.env`, `node_modules/` or `cache/`, with
   `.env.example` and a README whose start command is one line (`npm install && npm start`). Type `GEMINI_API_KEY` and
   `GUIDE_KEY` into the `.env` on his Mac in person, never in code, never in the zip, never in a group channel. He puts
   the folder in the repo at `integrations/guide/` and runs it with `GUIDE_URL=http://127.0.0.1:8795`.
   Copy `cache/hotspots/` and `cache/video/` across too (they are not secret), so the demo worlds are warm.
3. **Also send:** your chosen voice, the free-tier limits, your median latencies, and 2 or 3 sentences per endpoint for
   Devpost (what Gemini does at each step).
4. **Test together:** one full headset run (labels, "who won?", the live world's greeting) before Saturday 10 PM.

## 13. Rules

- Write all your own code during the event (from 8 PM Friday). Open-source libraries are fine, and get credited in the
  README.
- If you use AI tools while building, list them on Devpost: the hackathon rules require crediting them.
- Keys stay in `.env`. Before every zip, load your `.env` into the shell (`set -a; . ./.env; set +a`) and search for the
  real key values. This must print nothing:
  `grep -rnF --exclude=.env --exclude-dir=node_modules -e "$GEMINI_API_KEY" -e "$GUIDE_KEY" .`
