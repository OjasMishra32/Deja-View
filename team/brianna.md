# Brianna: the room sees, points and talks back

Read `plan.md` first (the story), then this. `contracts.md` has the wiring for the whole team; where this page and
`contracts.md` disagree, `contracts.md` wins.

Everything below was checked against the live Gemini docs and SDK on Fri Oct 16, 2026. Where something could not be
checked, it says so and tells you how to check it. If something here turns out to be wrong on the night, tell Ojasva
right away and use the fallback listed for it.

**Change from earlier drafts:** Capital One Nessie is no longer yours. `plan.md` made it Seb's optional side quest.
You own Gemini, all of it.

---

## 1. What you are building, and the demo moments

You build **one small HTTP service** (call it "the guide") on port **8795**. Only the Déjà View server calls it. The
headset never talks to you directly.

| Time | What the judge sees and hears | Your endpoint |
| --- | --- | --- |
| before the demo, and 2:15 live | A photo arrives. Before the GPU builds the world, Gemini looks at it and writes the text prompt the world model uses to imagine everything the camera never saw | `POST /describe` |
| 0:40 | Inside the cooking memory, floating labels sit on the **pan**, the **spice rack**, the **window**. Gemini found them | `POST /hotspots` |
| 0:40 | The judge points at the pan and asks out loud "what is she making?". Within about 2 s the room answers in a voice, with a caption | `POST /ask` (with `target`, the video frame and the video summary from `POST /prepare`) |
| 2:15 | The judge's own photo becomes a world. On arrival the room greets them ("Nice place. Someone left every light on."), and labels pop in | `/describe`, `/narrate`, `/hotspots` live |

You are also on stage twice, on your laptop (section 2.3):
- **1:15:** you join as a **Roblox avatar** with Shivin and play tag with the judge.
- **1:45:** on Seb's DeepSpace map you click by the stove and type "Seb's seat. He was too scared to show up". It pops up in the
  headset as a sticky note.

And you are the star of the **cooking clip** (section 2.4): the Third Wheel memory is you cooking.

**Prize:** MLH "Best Use of Gemini API" (confirmed on https://swamphacks-xii.devpost.com/). Gemini also carries the
Vobile "Best Overall" story: it decides what the world model imagines, and the reality check shows exactly that.
Judges want the API doing real work in the product. Yours does: it writes the world, finds the things worth
pointing at, sees what you see, hears your voice, watches the video and talks back.

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
- `npm install @google/genai` (latest is 2.30.0, released Oct 15; the text-to-speech models need 2.24.0 or newer).
- `jq` and `ffmpeg` for test scripts (`brew install jq ffmpeg` on a Mac).

### 2.3 Your stage roles (15 minutes tonight, 10 minutes Saturday)

- **Roblox (tonight):** make a Roblox account if you don't have one, install the Roblox app on your laptop, and send
  Shivin a **friend request** (username to him in the team chat). On a user-owned game, only friends can get the Edit
  permission that lets you join his private experience. Shivin adds you as a collaborator after that.
- **DeepSpace (Saturday, once Seb deploys):** open Seb's app on your laptop and sign in with Google. Practise the note:
  on the room map, click by the stove, type, send. You should see it appear on the map at once; from Sat 8 PM it
  also appears in the headset.

### 2.4 The cooking clip (Saturday, by 4 PM)

The Third Wheel memory at 0:20 is **you cooking**. Film it by Sat 4 PM so Ojasva can generate and freeze the memory
by 8 PM:
- A phone propped up and **completely still** (on a shelf or a stack of books), landscape, the whole stove and counter
  in frame, good light. The room is generated from the still background, so the camera must not move.
- 30 to 40 seconds, with sound. Cook something visible: onions in a pan are perfect ("Seb's seat. He was too scared to show up").
  Talk a little. Leave the frame for the last 3 seconds.
- AirDrop the original file to Ojasva and Seb. Seb's bot recognises this exact file at 0:00, so the table iPhone must
  send this same file.
- No kitchen available: the existing smoothie clip (`test-tw-local`) is the fallback, and the host changes his line.

---

## 3. How your piece fits

```
 Quest 3S headset (viewer, WebXR)          Déjà View server (Ojasva, Bun)              Your guide service (:8795)
 ───────────────────────────────          ──────────────────────────────              ───────────────────────────
 enter a world: capture the view  ───────▶ POST /api/guide/hotspots  ───────────────▶ POST /hotspots ─▶ Gemini boxes
 (labels are stored, so this runs once)    + X-Guide-Key, + scene    ◀── labels + 2D boxes (viewer finds the 3D spot)

 point at a label, hold the button:        POST /api/guide/ask       ───────────────▶ POST /ask
 mic (webm/opus) + current view JPEG       adds X-Guide-Key, scene,                    ├─▶ Gemini: image + audio -> JSON
 + target label + video frame              people, names                               └─▶ Gemini TTS -> WAV
 plays `speech`, shows the caption ◀───────  returns your JSON unchanged ◀────────────

 enter a world with no video playing ────▶ POST /api/guide/narrate   ───────────────▶ POST /narrate (cached per scene)

 (server, every new upload, before the GPU job)  ──────────────────────────────────▶ POST /describe ─▶ world prompt
 (server, scene ready)                           ──────────────────────────────────▶ POST /narrate (pre-warm)
 (server, Third Wheel scene ready)               ──────────────────────────────────▶ POST /prepare ─▶ Gemini watches the video
```

Who calls whom:
- The headset only calls the Déjà View server. The server forwards to you. You answer the server.
- You call Google (Gemini). You never need to call Ojasva's server, except to download a video for `/prepare` when
  he passes a `videoUrl`.
- The 3D placement of labels is Ojasva's job: you return 2D boxes on the image you were given, and his viewer casts a
  ray through the box centre into the room.

Network and ports:
- Your service: plain HTTP, port **8795** (not 8790 or 8791: Ojasva's test harnesses use those).
- While building (Saturday): Ojasva sets `GUIDE_URL=http://<your-laptop-ip>:8795`. Find your IP with
  `ipconfig getifaddr en0` (Mac) or `ipconfig` (Windows).
- Ojasva's server for you: `http://<ojasva-ip>:8788` (plain HTTP, so `curl` needs no `-k` and Node's `fetch` works).
- For the demo: your service runs **on Ojasva's Mac**, `GUIDE_URL=http://127.0.0.1:8795`. So the demo does not depend
  on your laptop or on Wi-Fi between laptops.
- No CORS needed: no browser calls you (except your own test page, section 8, which you serve from your own server).

Auth: every request except `GET /health` must carry `X-Guide-Key: <GUIDE_KEY>` (a random string you put in `.env` and
give Ojasva in person). Without it, anyone on the hackathon Wi-Fi could burn your Gemini quota. Missing or wrong key:
`401 {"error":"bad guide key"}`.

Formats and units (used everywhere):
- Images: data URLs, `data:image/jpeg;base64,...` (PNG and WebP also fine). The headset sends JPEG, 768 × 576, about
  50 to 150 KB.
- Audio in: data URL from the Quest's MediaRecorder, normally `data:audio/webm;codecs=opus;base64,...`, 1 to 8 seconds.
- Audio out: `data:audio/wav;base64,...`, 24 kHz, mono, 16-bit. About 48 KB per second of speech.
- Boxes: `[ymin, xmin, ymax, xmax]`, integers 0 to 1000 relative to the image you were sent (Gemini's own format;
  never convert it to pixels).
- Times: milliseconds in `ms` fields. `speechSeconds` is the length of the spoken audio. `videoTime` is seconds.
- JSON bodies can reach about 2 MB. Accept at least 15 MB (Express's default limit is only 100 KB:
  `express.json({ limit: "15mb" })`).

---

## 4. What Ojasva is building around you (and when)

Already live in the Déjà View server today: `GET/POST /api/scenes`, `GET /api/scenes/:id` (a Scene has `id`, `name`,
`mode`, `caption`, `thumb`, `input.files`), files at `/data/scenes/:id/<file>`, the viewer at `/view?scene=<id>`, `/ws`.

Not built yet. Ojasva builds these for you, by these times (`contracts.md` sections 5.9, 6.3 to 6.5):

| By | Ojasva provides |
| --- | --- |
| Sat 9 AM | The LAN URL `http://<ip>:8788`, so you can download real fixtures: `/data/scenes/test-tw-local/thumb.jpg` (a kitchen) and its 40 s video `/data/scenes/test-tw-local/input/video.mp4` |
| Sat 2 PM | Proxy routes `POST /api/guide/narrate`, `/ask`, `/speak`, `/hotspots` and `GET /api/guide/health`, forwarding to `GUIDE_URL` with your `X-Guide-Key`, adding `scene` (and `people`/`names` for `/ask`), returning your JSON unchanged. Timeouts: 10 s, hotspots 15 s |
| Sat 2 PM | 3 real request bodies captured from the headset (a view JPEG plus a recorded question), saved as JSON files, so you can test with the exact Quest formats |
| Sat 4 PM | The upload flow calls your `POST /describe` with a **5 s timeout** and uses `prompt` as the world's text prompt, `caption` and `imagined` on the scene. On timeout the job falls back to its built-in captioner, so a slow `/describe` never blocks a world |
| Sat 4 PM | Pre-warm: when a scene becomes ready, the server calls `/narrate` with the thumbnail. When a Third Wheel scene becomes ready, it calls `/prepare` |
| Sat 6 PM | Headset: hotspot labels from your boxes, pointing, hold-to-talk with captions and speech playback, a "thinking" click on release, the greeting on entry |
| Sat 8 PM | Your service running on his Mac from your folder |

If any of these slip, keep testing with curl and your fixtures. Nothing in your build order depends on his side
before Saturday 2 PM.

---

## 5. The contract: every endpoint

All requests and responses are JSON (`Content-Type: application/json`). All except `/health` need `X-Guide-Key`.

### 5.1 `GET /health`

```json
{ "ok": true, "gemini": "ok", "mock": false,
  "models": { "fast": "gemini-3.5-flash-lite", "spatial": "gemini-3.8-flash", "video": "gemini-3.8-flash",
              "tts": "gemini-3.8-flash-lite-tts" },
  "voice": "Sulafat", "prepared": ["game-night-k3x9a"], "uptimeS": 5321 }
```
`gemini` is `"ok"`, `"degraded"` (last call failed, using fallback) or `"off"` (mock mode). `prepared` lists the
scenes with a cached video summary.

### 5.2 `POST /describe`: Gemini decides what gets imagined

The world model (FlashWorld) builds a whole walkable room from one photo, and it fills in everything the camera missed
from a **text prompt**. Today that prompt comes from a small local captioner or a neutral default sentence. Yours
replaces it.

Request:
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ...", "mode": "rentfree", "name": "Dorm room", "userPrompt": null }
```
Response:
```json
{ "prompt": "A small sunlit dorm room with a white lofted bed, a pine desk under a wide window, grey carpet and warm afternoon light. Beyond the frame: a narrow closet with sliding mirror doors to the left, a mini fridge and a door to the hallway behind the camera, posters on pale painted walls. Static, realistic, consistent lighting.",
  "caption": "Sunny dorm room. Closet, fridge and door imagined behind you.",
  "imagined": ["closet with mirror doors", "mini fridge", "hallway door"],
  "ms": { "understand": 900 } }
```
- `prompt`: 40 to 70 words, one paragraph. First what is visible (kind of place, main objects, materials, colours,
  light), then the most likely things just outside the frame and behind the camera, in the same style. Static scene,
  no people, no text, no words like "photo" or "camera angle".
- `caption`: at most 12 words, for the gallery card and the bot reply. It becomes `scene.caption`, which your own
  `/narrate` and `/ask` later receive as context.
- `imagined`: 2 to 4 short items. They become the legend of the **reality check** toggle (Ojasva tints what the AI
  imagined). This is the Vobile moment at 1:00.
- `mode: "thirdwheel"`: the image is a frame of the video. Describe the room only, never the people.
- If `userPrompt` is set, keep the user's words first and add yours after them.
- Target 1.5 s, hard limit 5 s (Ojasva's timeout). Use image `resolution: "medium"` here: detail matters more than speed.

### 5.3 `POST /hotspots`: the floating labels

Request (the headset's current view, or the thumbnail):
```json
{ "sceneId": "game-night-k3x9a",
  "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "scene": { "name": "Game night", "mode": "thirdwheel", "caption": "Brianna's kitchen, mid-onion" },
  "max": 6 }
```
Response:
```json
{ "hotspots": [
    { "label": "pan", "box": [598, 402, 731, 588], "blurb": "Onions, mid-disaster", "ask": "What is she making?" },
    { "label": "spice rack", "box": [212, 640, 330, 802], "blurb": "Alphabetised, sort of", "ask": "Which spice is that?" },
    { "label": "window", "box": [80, 90, 420, 330], "blurb": "Zero view, great light", "ask": "What's outside?" } ],
  "cached": false, "degraded": false, "ms": { "understand": 2400 } }
```
- `label`: 1 to 3 lowercase words, the plain name of the object.
- `box`: `[ymin, xmin, ymax, xmax]`, integers 0 to 1000 on **the image you received**. Ojasva casts a ray through the
  box centre, so a tight box around the object matters more than anything else.
- `blurb`: at most 5 words, in the room's voice, shown under the label. `ask`: a question of at most 6 words the judge
  might ask about it (shown as a hint).
- 3 to `max` items. Pick things a visitor would point at and ask about: cookware, appliances, food, instruments,
  windows, art, furniture with character. Never label people, faces, walls, the floor or the ceiling. Avoid things
  smaller than about 3% of the image.
- Cache by `sceneId` plus a hash of the image. Nobody waits on this live: the demo worlds are labelled in rehearsal
  and stored by Ojasva. For the live world at 2:15, aim for under 4 s.
- If Gemini fails: `200 {"hotspots": [], "degraded": true, "error": "..."}`. No labels is better than wrong labels.

### 5.4 `POST /narrate`: the greeting when someone enters

Request:
```json
{ "sceneId": "dorm-k3x9",
  "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "scene": { "name": "Dorm room", "mode": "rentfree", "caption": "Sunny dorm room. Closet, fridge and door imagined behind you." },
  "fresh": false }
```
- `image` is optional when the scene is already cached. Ojasva's server calls this **before** anyone enters, with the
  scene thumbnail, so the greeting is ready the moment the headset loads. The headset's own call is then a cache hit.
- Cache the result by `sceneId` for 30 minutes. A cache hit returns in milliseconds. `fresh: true` skips the cache.
  No cache and no image: `400 {"error":"image required"}`.
- `mode`: `rentfree` (a place), `thirdwheel` (a video memory with real people), `reconstruct` or `sample` (a place).
  In the skit, Third Wheel worlds do not play a greeting (the video's own sound is playing), but keep it working.

Response:
```json
{ "answer": "Nice place. Someone left every light on, and that radiator has seen things.",
  "speech": "data:audio/wav;base64,UklGRi...", "speechSeconds": 3.1,
  "cached": false, "degraded": false, "ms": { "understand": 780, "tts": 640, "total": 1440 } }
```

### 5.5 `POST /ask`: point, hold a button and speak

Request:
```json
{ "sceneId": "game-night-k3x9a",
  "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "frame": "data:image/jpeg;base64,/9j/4AAQ...",
  "videoTime": 21.4,
  "audio": "data:audio/webm;codecs=opus;base64,GkXfo59C...",
  "question": null,
  "target": { "id": "h1", "label": "pan", "blurb": "Onions, mid-disaster" },
  "scene": { "name": "Game night", "mode": "thirdwheel", "caption": "Brianna's kitchen, mid-onion" },
  "history": [ { "q": "where am I?", "a": "Brianna's kitchen, about four minutes before the smoke alarm." } ],
  "people": 3,
  "names": ["Judge", "shivin", "brianna"],
  "speak": true }
```
- `audio` is the spoken question. `question` is typed text instead (desktop). Exactly one of them is set.
- `target` (optional): the label the judge is pointing at. Treat "she", "that", "this" in the question as referring
  to it, and to whatever is in that part of the view.
- `frame` (optional, Third Wheel): the current video frame as a JPEG, sharper than the 3D view. `videoTime`: seconds
  into the video. Use the `/prepare` summary moment closest to `videoTime`.
- `history`: the last few turns (keep only the last 4).
- `people`/`names`: who is in the room right now (filled in by Ojasva's server), for context only ("your friends in
  Roblox"). If missing, use 1 and `["You"]`.
- `speak: false` skips text-to-speech. The headset can then show the caption at once and call `/speak` itself.
  Default `true`.

Response:
```json
{ "question": "what is she making?",
  "answer": "Caramelised onions, allegedly. The smoke alarm has strong opinions.",
  "speech": "data:audio/wav;base64,UklGRi...", "speechSeconds": 3.6,
  "degraded": false, "ms": { "understand": 910, "tts": 620, "total": 1560 } }
```

Empty or unclear audio: return `200` with `question: ""` and an answer like "Sorry, I missed that. Hold the button and
try again." Skip Gemini when the decoded audio is under about 2 KB (a fraction of a second).

### 5.6 `POST /speak`

Request `{ "text": "Welcome back.", "style": "warm" }` (style optional). Response
`{ "speech": "data:audio/wav;base64,...", "speechSeconds": 0.9, "ms": { "tts": 520 } }`.

### 5.7 `POST /prepare`: Gemini watches a Third Wheel video once

Request:
```json
{ "sceneId": "game-night-k3x9a",
  "scene": { "name": "Game night", "mode": "thirdwheel", "caption": "" },
  "videoPath": "/absolute/path/to/data/scenes/game-night-k3x9a/input/video.mp4",
  "videoUrl": null }
```
Send either `videoPath` (a file on the same machine) or `videoUrl` (a URL to download).
- **On the demo Mac**, Ojasva's server passes `videoPath`: no download.
- **While you run on your laptop**, it passes `videoUrl: "http://<ojasva-ip>:8788/data/scenes/<id>/input/video.mp4"`
  (plain HTTP, so Node's `fetch` works). Download it to `cache/video/<sceneId>.mp4` first.

Then upload it with the Files API, wait for it to finish processing, and ask the video model for a summary. Save the
result to `cache/prepare/<sceneId>.json` and keep it in memory. It takes 10 to 60 s, and nobody waits on it live.
Answer `202 {"status":"preparing"}` at once and do the work in the background; `GET /prepare/<sceneId>` returns the
result when it is done (`404` before).

Result:
```json
{ "sceneId": "game-night-k3x9a",
  "summary": {
    "oneLine": "Brianna fries onions, they burn a little, and she blames the stove.",
    "people": ["a cook in a green apron", "someone off camera laughing"],
    "activity": "frying onions for pasta sauce",
    "food": ["onions", "garlic", "pasta"],
    "moments": [ { "t": 6, "what": "drops the onions in all at once, oil spits" },
                 { "t": 21, "what": "smoke, waves a towel at the alarm" } ],
    "funnyDetail": "The towel did nothing." },
  "ms": { "download": 900, "upload": 2100, "processing": 8000, "model": 6100 } }
```
`/narrate`, `/ask` and `/hotspots` for that `sceneId` then include this summary as text context. That is what makes
"What is she making?" land correctly at 0:40 even when the current frame is blurry.

### 5.8 Errors

| Status | When | Body |
| --- | --- | --- |
| 400 | malformed JSON, `image`/`audio` not a base64 data URL, both `audio` and `question` missing | `{ "error": "audio must be a base64 data URL" }` |
| 401 | missing or wrong `X-Guide-Key` | `{ "error": "bad guide key" }` |
| 404 | `GET /prepare/<id>` not prepared yet | `{ "error": "not prepared" }` |
| 413 | body over 15 MB | `{ "error": "too large" }` |
| 200 + `degraded: true` | Gemini or TTS failed or timed out and a fallback answered | normal body plus `"error": "gemini timeout"` |

Rule: on the demo path you never return a 500. Every failure becomes a fallback answer with `degraded: true`, so the
headset always has something to say.

---

## 6. Gemini: models, calls and prompts

### 6.1 Which models (verified at https://ai.google.dev/gemini-api/docs/models)

| Job | Model | Why |
| --- | --- | --- |
| `/ask`, `/narrate`, `/describe` (image + audio in, JSON out) | `gemini-3.5-flash-lite` | Stable. Google calls it its "fastest, most cost-effective 3.5 model". Inputs: text, image, video, audio, PDF. Structured output supported. Thinking defaults to `minimal` (the fastest) |
| `/hotspots` (boxes) | `gemini-3.8-flash`, `thinking_level: "low"` | Google's object-detection docs show bounding boxes with this model (https://ai.google.dev/gemini-api/docs/image-understanding). The 3.5 Flash-Lite page does not list detection. Try 3.5 Flash-Lite too and keep whichever draws tighter boxes |
| Backup if answers feel dumb | `gemini-3.6-flash` with `thinking_level: "minimal"` | Smarter, a bit slower. Supports `minimal` |
| `/prepare` (watch the video once) | `gemini-3.8-flash` with `thinking_level: "low"` | Best Flash model, latency doesn't matter here. **`minimal` is not supported on 3.8 Flash and returns an error** (https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| Text to speech | `gemini-3.8-flash-lite-tts` | Stable, built for real-time voice agents: fast |
| TTS backup | `gemini-3.8-flash-tts` | Same request format, more expressive, slower |

Don't use models from old tutorials: `gemini-2.0-flash` and `gemini-3.1-flash-lite-preview` are shut down, and the
2.5 models are limited to accounts that used them before. Put model names in `.env` so you can switch without code
changes.

### 6.2 Which API

The current docs show every example with the **Interactions API** (`ai.interactions.create`, snake_case fields like
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
- Inline data (base64 in the request) is fine up to **20 MB total request size**. A view JPEG plus a frame plus 8 s of
  opus is about 0.4 MB.
- Audio costs 32 tokens per second. An image up to 384 × 384 costs 258 tokens; larger images are cut into 768 × 768
  tiles of 258 tokens each. You can set `resolution: "low"` on an image part for fewer tokens and lower latency.
- Put the text part **before** the image in `input` (Google's own tip).
- **Boxes:** the model is trained to return `box_2d` as `[ymin, xmin, ymax, xmax]` normalized to 0 to 1000. Ask for
  exactly that key and order in your schema and prompt, then return it as `box` unchanged. For detection, Google
  recommends the lowest thinking level the model allows.
- TTS output on a normal (non-streaming) request is a **complete WAV file with header**: 24 kHz, mono, 16-bit. You do
  not need to add a WAV header. Older TTS models returned raw PCM and old tutorials wrap it in a header manually:
  don't, unless the response's `mime_type` is `audio/l16` (snippet in 6.4).
- 3.8 TTS reads `text` **word for word**. "Say cheerfully: hello" will be read out loud. Put delivery in
  `speech_metadata.style`, and only short tags inline, like `<laugh>`, `<sigh>`, `<short pause>`.
- 30 prebuilt voices. Good candidates for "the room": **Sulafat** (warm), **Achird** (friendly), **Puck** (upbeat),
  **Zubenelgenubi** (casual). Try all four on Saturday morning, pick one, and keep it for the whole weekend.
- Videos: inline only under 20 MB per request. A 40 s phone clip is often 15 MB or more (about 20 MB as base64), too
  close to the limit. Use the Files API (upload, poll until `ACTIVE`).

### 6.4 Snippets (the parts that remove guesswork, not your whole server)

These shapes come from Google's docs and the SDK's own type definitions (v2.30.0). They could not be run without a
key, so your first smoke test on Saturday confirms them. If the API rejects `store`, `resolution` or
`max_output_tokens`, delete that one field and carry on: none of them is essential.

Client, and splitting a data URL:
```js
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// "data:audio/webm;codecs=opus;base64,AAAA" -> { mime: "audio/webm", data: "AAAA" }
function splitDataUrl(url) {
  const m = /^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(url ?? "");
  return m ? { mime: m[1], data: m[2] } : null;
}
```

Understanding call for `/ask` (image + frame + audio in, JSON out):
```js
const ASK_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "What the person asked, word for word. Empty if no speech." },
    answer:   { type: "string", description: "1-2 short spoken sentences, max 30 words." },
  },
  required: ["question", "answer"],
};

const img = splitDataUrl(body.image), frm = splitDataUrl(body.frame), aud = splitDataUrl(body.audio);
const input = [{ type: "text", text: contextText }];             // text first
if (img) input.push({ type: "image", data: img.data, mime_type: img.mime, resolution: "low" });
if (frm) input.push({ type: "image", data: frm.data, mime_type: frm.mime, resolution: "low" });
if (aud) input.push({ type: "audio", data: aud.data, mime_type: aud.mime });

const res = await ai.interactions.create({
  model: process.env.MODEL_FAST,                                  // gemini-3.5-flash-lite
  store: false,                                                   // don't keep the judge's voice on Google's side
  system_instruction: ASK_SYSTEM,
  input,
  response_format: { type: "text", mime_type: "application/json", schema: ASK_SCHEMA },
  generation_config: { thinking_level: "minimal", temperature: 0.9, max_output_tokens: 256 },
}, { timeout_ms: 6000, retries: { strategy: "none" } });   // you do your own single retry

const out = JSON.parse(res.output_text);  // { question, answer }
```
`contextText` is plain text you build: scene name and mode, caption, "They are pointing at: the pan (Onions,
mid-disaster)" when `target` is set, the `/prepare` summary and the moment nearest `videoTime`, the last 4 history
turns, the people present, and the typed `question` if there is no audio. Say which image is which ("Image 1: what
they see. Image 2: the video frame."). For `/narrate` use the same call without audio and with `{ answer }` only.

Hotspots call (boxes):
```js
const HOTSPOT_SCHEMA = {
  type: "object",
  properties: {
    hotspots: { type: "array", items: { type: "object", properties: {
      label:  { type: "string" },
      box_2d: { type: "array", items: { type: "integer" }, description: "[ymin, xmin, ymax, xmax] normalized to 0-1000" },
      blurb:  { type: "string" },
      ask:    { type: "string" },
    }, required: ["label", "box_2d", "blurb", "ask"] } },
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
const boxes = JSON.parse(res.output_text).hotspots
  .filter(h => h.box_2d?.length === 4 && h.box_2d.every(n => n >= 0 && n <= 1000))
  .map(({ box_2d, ...h }) => ({ ...h, box: box_2d }));
```
Check the boxes with your eyes before trusting them: draw them on the image in your test page (section 8). If they
are consistently shifted, you are probably sending a different image size than you think, or swapping x and y.

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

Video for `/prepare` (Files API):
```js
const file = await ai.files.upload({ file: `cache/video/${sceneId}.mp4`, config: { mimeType: "video/mp4" } });
let f = await ai.files.get({ name: file.name });
while (f.state === "PROCESSING") { await new Promise(r => setTimeout(r, 2000)); f = await ai.files.get({ name: file.name }); }
if (f.state === "FAILED") throw new Error("video processing failed");
const res = await ai.interactions.create({
  model: process.env.MODEL_VIDEO,                                 // gemini-3.8-flash
  store: false,
  input: [ { type: "text", text: PREPARE_PROMPT }, { type: "video", uri: f.uri, mime_type: f.mimeType } ],
  response_format: { type: "text", mime_type: "application/json", schema: PREPARE_SCHEMA },
  generation_config: { thinking_level: "low" },
}, { timeout_ms: 90000 });
```
`files.upload` uses camelCase `mimeType` in `config` (as in Google's own example), while the content parts use
`mime_type`. iPhone clips are often `.mov` (`video/quicktime`): pass the real type.

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
- mode "rentfree", "reconstruct" or "sample": a place. Be the honest friend showing them around.
- mode "thirdwheel": a recorded moment with real people that the listener missed. Welcome them back into it.
```
Examples (good):
- Bright living room, old radiator: "Nice place. Someone left every light on, and that radiator has seen things."
- Small bedroom, desk under the window: "Cozy. The desk gets the window, so you have no excuse not to study."
- Third Wheel kitchen: "Welcome back to Saturday's kitchen. Someone is definitely about to burn the onions."

Bad (reject in testing): "What a lovely and inviting space!" (generic), "In this image I can see a bed." (breaks the
illusion), "Hello! How can I help you today?" (assistant voice).

`ASK_SYSTEM`:
```
You are the voice of the room in Déjà View. The person is standing inside a 3D copy of this place wearing a VR headset.
They asked you a question out loud (the audio clip) or typed it (text). Image 1 is exactly what they are looking at.
If there is an Image 2, it is the real video frame playing right now. If they are pointing at a labelled object, the
notes say which one: "she", "it", "that" and "this" usually mean that object or the person using it.
Return JSON:
- question: what they asked, word for word (drop filler like "um"). Empty string if there is no speech.
- answer: one or two short spoken sentences, at most 30 words. Answer the actual question. Use what is visible first,
  then the video notes, then the scene notes. Be specific about objects, colours and positions (left, right, by the
  window, behind you). Dry and a little funny, never mean about people.
If you can't see the answer, say so honestly and playfully, then make your best guess from context.
No markdown, emoji or lists. Never mention images, photos, screenshots, rendering, AI or 3D.
```
Examples:
| Question | Good answer |
| --- | --- |
| "what is she making?" (pointing at the pan, with summary) | "Caramelised onions, allegedly. The smoke alarm has strong opinions." |
| "what's by the window?" | "A little herb pot and a stack of mail you are definitely not supposed to read." |
| "is there a TV?" | "No TV. Just a very confident beanbag facing a blank wall." |
| "who is that?" (Third Wheel) | "That's tonight's chef. The one laughing behind the camera is the friend who filmed it." |

`HOTSPOTS_SYSTEM`:
```
You pick the objects in a room that a visitor would want to point at and ask about, and you label them.
Return JSON: hotspots, 3 to 6 items, each with
- label: the plain name, 1 to 3 lowercase words ("pan", "spice rack", "window").
- box_2d: a tight bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000.
- blurb: at most 5 words, dry and a little funny, about this object here ("Onions, mid-disaster").
- ask: a question a visitor might ask about it, at most 6 words.
Prefer cookware, appliances, food, instruments, windows, art, plants and furniture with character.
Never label people, faces, body parts, walls, the floor or the ceiling. Skip anything tiny or cut off at the edge.
Never label the same object twice.
```

`PREPARE_PROMPT`: "Watch this short video of friends. Return JSON: oneLine (max 20 words), people (short neutral
descriptions, no names unless spoken in the video), activity, food (list), moments (up to 6, each `{t: seconds,
what}`), funnyDetail (one line). Describe what happens, not how people look."

`DESCRIBE_SYSTEM` (for the world model, not for people):
```
You write the text prompt for a 3D world generator that turns ONE photo into a walkable room. The generator must invent
everything outside the photo, so tell it what is there.
Return JSON:
- prompt: one paragraph, 40 to 70 words. First what is visible: kind of place, main objects, materials, colours, light.
  Then the most likely things just outside the frame and behind the camera, consistent with the style and era of the room.
  End with "Static, realistic, consistent lighting." No people, no text or signs, no words about photos or cameras.
- caption: at most 12 words for a gallery card, saying what was added ("Closet and door imagined behind you").
- imagined: 2 to 4 short names of things you added that are not in the photo.
```
Judge it by walking the result: if the generated room has odd things behind you, make the "outside the frame" part
more conservative (furniture that the visible style implies, not surprises).

### 6.6 Latency plan (targets measured inside your service)

| Call | Target p50 | Hard ceiling | How |
| --- | --- | --- | --- |
| `/ask` total | **2.0 s** | 3.0 s | understanding at most 1.2 s plus TTS at most 0.8 s |
| `/narrate` | **under 50 ms** on a cache hit | 2.5 s cold | Ojasva pre-warms with the thumbnail when the scene is ready |
| `/hotspots` | 4 s | 12 s | runs once per world; demo worlds are stored in rehearsal |
| `/speak` | 0.8 s | 2 s | |
| `/describe` | 1.5 s | 5 s (Ojasva's timeout) | runs right after upload, nobody watches it |

What makes it fast:
1. `gemini-3.5-flash-lite`, thinking `minimal`, image `resolution: "low"` (try `"medium"` if answers miss details), a
   short system prompt.
2. Keep answers short. TTS time grows with text length.
3. Warm up on startup: send one tiny request to each model so the first real request doesn't pay for the connection
   setup.
4. Log `ms` for every stage of every request and print a line like `ask 1540ms (understand 900, tts 640)`. Run each
   fixture 5 times, write down the median, and send it to Ojasva by Sat 10 AM.
5. If `/ask` is still over 2 s: the headset calls with `speak: false`, shows the caption at about 1 s, then calls
   `/speak` (the voice arrives about 0.7 s later). Ojasva also plays a short "thinking" click on button release.
6. Cache speech by exact text (a `Map` from text to data URL). Fallback lines repeat a lot.
7. For the demo question, pre-warm: on Sat 10 PM, ask "what is she making?" 3 times so the connection is hot. Nothing
   about the answer is cached, so it is still live.

Latency of the real models could not be measured without a key. Measuring it is your first job on Saturday morning.

---

## 7. Build order (with checkpoints)

Recommended layout:
```
guide/
  package.json          "type": "module", "start": "node server.mjs"
  .env.example          every variable, no values
  .gitignore            .env, node_modules/, cache/
  README.md             how to start, env vars, endpoints (short)
  server.mjs            routing, auth header, body limit, errors, timing logs
  gemini.mjs            understand(), boxes(), speak(), summarizeVideo(), warmup()
  prompts.mjs           system prompts, schemas, examples
  fallback.mjs          canned lines, macOS `say` speech
  public/test.html      your test page (section 8) and voice-client.js
  test/fixtures/        kitchen.jpg, room1.jpg, q-making.webm, q-window.webm, *.json bodies
  test/*.sh             curl scripts
  cache/                narrate, hotspots and prepare results (gitignored)
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

| Step | Time | You should now see |
| --- | --- | --- |
| 1. Skeleton: `/health`, `X-Guide-Key` check, 15 MB body limit, JSON errors, one log line per request with ms | 30 min | `curl localhost:8795/health` prints `ok: true`; a request without the key gets 401 |
| 2. `/speak` with TTS | 40 min | `test/speak.sh "Nice place."` writes `out.wav`, `afplay out.wav` plays it. Try the 4 voices, pick one |
| 3. `/narrate` with an image | 45 min | a 1 to 2 sentence greeting that names something really in the photo, plus speech; a second call is a cache hit in under 50 ms |
| 4. `/describe` | 30 min | for 3 room photos, a 40 to 70 word prompt that describes the visible room and a believable rest of it; Ojasva can run it through the world model and compare with the default caption |
| 5. `/hotspots` + boxes drawn on the image in your test page | 60 min | on the kitchen thumbnail: 3 to 6 tight boxes on real objects, none on people or walls. Compare `gemini-3.8-flash` with `gemini-3.5-flash-lite` and keep the better one |
| 6. `/ask` with audio and `target` | 60 min | `q-making.webm` + `target: pan` comes back with `question: "what is she making?"` and a specific answer; typed `question` works too |
| 7. Latency pass | 30 min | median `/ask` written down; `resolution: "low"` vs `"medium"` compared; warmup on boot |
| 8. `/prepare` on the kitchen video | 60 min | summary JSON in `cache/prepare/<id>.json`; "what is she making?" now names the dish even with a blurry frame |
| 9. Fallbacks and mock mode (section 9) | 45 min | with the Gemini key removed, everything still answers with `degraded: true` |
| 10. Connect to Ojasva's server | 30 min | the headset shows your labels and answers through `/api/guide/*` |
| 11. Prompt polish with real headset views | rest of the evening | 10 questions in a row with no generic or broken answers; labels on the right things in all three demo worlds |

Making test fixtures:
```bash
D=http://<ojasva-ip>:8788      # Ojasva's server, plain HTTP
curl -s -o test/fixtures/kitchen.jpg $D/data/scenes/test-tw-local/thumb.jpg
curl -s -o cache/video/test-tw-local.mp4 $D/data/scenes/test-tw-local/input/video.mp4

# repeatable spoken questions (macOS); record your own voice too
say -o /tmp/q.aiff "What is she making?"   && ffmpeg -y -i /tmp/q.aiff -c:a libopus -b:a 32k test/fixtures/q-making.webm
say -o /tmp/q.aiff "What's by the window?" && ffmpeg -y -i /tmp/q.aiff -c:a libopus -b:a 32k test/fixtures/q-window.webm
# real mic, 4 seconds (macOS):  ffmpeg -f avfoundation -i ":0" -t 4 -c:a libopus test/fixtures/q-real.webm

# build a request body (big base64 goes through files, not command-line arguments)
base64 -i test/fixtures/kitchen.jpg   | tr -d '\n' > /tmp/img.b64     # Linux: base64 -w0 file
base64 -i test/fixtures/q-making.webm | tr -d '\n' > /tmp/aud.b64
jq -n --rawfile img /tmp/img.b64 --rawfile aud /tmp/aud.b64 '{sceneId:"test-tw-local",
  image:("data:image/jpeg;base64,"+$img), frame:null, videoTime:12,
  audio:("data:audio/webm;codecs=opus;base64,"+$aud), question:null,
  target:{id:"h1", label:"pan", blurb:"Onions, mid-disaster"}, history:[], people:3, names:["Judge","shivin","brianna"],
  scene:{name:"Kitchen", mode:"thirdwheel", caption:""}}' > test/fixtures/ask-making.json
jq -n --rawfile img /tmp/img.b64 '{sceneId:"test-tw-local", image:("data:image/jpeg;base64,"+$img), max:6,
  scene:{name:"Kitchen", mode:"thirdwheel", caption:""}}' > test/fixtures/hotspots-kitchen.json

# call them, show the text, play the voice
H=(-H 'Content-Type: application/json' -H "X-Guide-Key: $GUIDE_KEY")
curl -s -X POST localhost:8795/hotspots "${H[@]}" --data @test/fixtures/hotspots-kitchen.json | jq -c '.hotspots[] | {label, box}'
curl -s -X POST localhost:8795/ask "${H[@]}" --data @test/fixtures/ask-making.json > /tmp/out.json
jq '{question, answer, ms}' /tmp/out.json
jq -r .speech /tmp/out.json | sed 's/^data:audio\/wav;base64,//' | base64 -d > /tmp/out.wav && afplay /tmp/out.wav

# prepare the video, then poll
curl -s -X POST localhost:8795/prepare "${H[@]}" \
  -d '{"sceneId":"test-tw-local","scene":{"name":"Kitchen","mode":"thirdwheel"},"videoPath":"'"$PWD"'/cache/video/test-tw-local.mp4"}'
curl -s localhost:8795/prepare/test-tw-local -H "X-Guide-Key: $GUIDE_KEY" | jq .summary.oneLine
```
On Windows, write the body builder as a 10-line Node script instead of `base64`/`jq`.

---

## 8. Your test page (Saturday, about 1 hour, worth it)

Serve `public/test.html` from your own server (no CORS needed). It has:
- a file picker for an image, which draws your `/hotspots` boxes on top (a `<canvas>` over the image:
  `x = box[1] / 1000 * width`, `y = box[0] / 1000 * height`, and so on). This is how you judge box quality;
- a hold-to-talk button (`MediaRecorder`, `audio/webm;codecs=opus`), a target dropdown filled from the boxes, and an
  audio player for the answer;
- a latency readout from `ms`.

Put the recording and playback code in a separate, dependency-free `public/voice-client.js` with three functions:
`start()`, `stop()` (returns a promise of `{ dataUrl, mimeType, seconds }`) and `play(speechDataUrl)` (returns a promise
that resolves when playback ends). It produces exactly the audio format the Quest sends, it is your desktop backup on
the night, and Ojasva may drop it straight into the headset to save himself an hour. Send it to him by Sat 4 PM.

---

## 9. Fallbacks (built in, tested before Saturday 10 PM)

| What breaks | What your service does automatically | What you do |
| --- | --- | --- |
| Gemini understanding fails, times out (6 s) or hits quota (429) | canned line chosen by mode and keywords (window, making/cook, who, what), `degraded: true`; one retry on 429/503 after 300 ms | check `/health`, switch `MODEL_FAST` to `gemini-3.6-flash`, or move to Tier 1 ($5) |
| `/hotspots` fails | `hotspots: []`, `degraded: true` | the three demo worlds are already stored on Ojasva's server, so the demo does not notice |
| TTS fails | macOS fallback: `say -o out.wav --file-format=WAVE --data-format=LEI16@24000 "<text>"` (about 1 s, works on Ojasva's Mac); otherwise `speech: null` and the headset shows the caption | pre-generate speech for the fixed lines (greetings for demo scenes) and cache them on disk |
| No Gemini key at all | `MOCK_GEMINI=1`: realistic canned JSON in the exact shapes, with a short fake delay; mock hotspots return 3 fixed boxes | lets Ojasva integrate against you before your key works |
| Venue Wi-Fi blocks laptop-to-laptop | | phone hotspot for both laptops, or move your folder onto Ojasva's Mac early (the plan for the demo anyway) |
| Internet down | everything degrades to canned lines | phone hotspot. Devpost clips recorded at freeze are the last resort |

Canned lines must sound like the room too, for example "Give me a second, I'm still moving in. Ask me again." /
"Honestly? I was looking the other way. Ask me again."

---

## 10. Quality bar for the demo

- **Speed:** `/ask` p50 at most 2.0 s, never over 3 s. The greeting is instant because it is pre-warmed.
- **Labels:** 3 to 6 per world, all on real, askable things, tight boxes, never on people. Walk all three demo worlds
  with Ojasva on Sat 8 PM and fix any label that is wrong or floating in the wrong place.
- **Voice:** one voice and one style everywhere (greeting, answers). Answers of 1 or 2 sentences.
- **Content:** specific to what is visible, short, dry, funny, never mean about people, never "As an AI" or "In this
  image". Ten questions in a row without a generic answer before you call it done.
- **Look:** the labels and captions are drawn by Ojasva from your JSON. Anything you draw yourself (the test page) uses
  the Déjà View look: near-black background (#0B0B0F), white text, one acid-lime accent **#C6FF3D**, bold type (700 to
  800 weight).
- **Robustness:** no 500s on the demo path, no crash on missing optional fields, every failure becomes a fallback.

Stretch (only after section 7 is done): use `history` so follow-ups work ("and what's next to it?"); a "what's that?"
question with no label pointed at uses the centre of the view.

---

## 11. Milestones

| When | Done means |
| --- | --- |
| Tonight (Fri) | Gemini key works (one successful curl). Free-tier limits written down and sent to Ojasva. Roblox account made and friend request sent to Shivin |
| **Sat 10 AM** | `/health`, `/speak`, `/narrate`, `/describe`, `/hotspots`, `/ask` answer real fixtures via curl; median `/ask` measured and sent to Ojasva (goal 2.0 s, at most 2.5 s for now); `MOCK_GEMINI` works |
| **Sat 4 PM** | Cooking clip filmed and sent. `/prepare` works on the kitchen video; `/describe` wired into Ojasva's upload flow; connected through Ojasva's server (`GUIDE_URL`) and at least one real headset question answered end to end; `voice-client.js` sent |
| **Sat 10 PM** | Running on Ojasva's Mac. Full skit run twice with a timer: labels, "what is she making?", your Roblox avatar at 1:15, your note at 1:45, the live world at 2:15. Fallbacks tested: Gemini key removed, Wi-Fi off |
| **Sun 4 AM** | Feature freeze. Record 10 s clips: labels popping in, pointing at the pan and the spoken answer, the greeting in the live world |
| Sun 8 AM | Submitted (Ojasva submits; you send your Devpost lines by 6 AM) |

---

## 12. Hand-off

1. **Sat ~2 PM (connect):** on the same Wi-Fi, send Ojasva `http://<your-ip>:8795` and give him `GUIDE_KEY` in person.
   He sets `GUIDE_URL` and `GUIDE_KEY` on his server.
2. **By Sat 8 PM (move to his Mac):** send a zip of your folder **without** `.env`, `node_modules/` or `cache/`, with
   `.env.example` and a README whose start command is one line (`npm install && npm start`). Type `GEMINI_API_KEY` and
   `GUIDE_KEY` into the `.env` on his Mac in person, never in code, never in the zip, never in a group channel. He puts
   the folder in the repo at `integrations/guide/` and runs it with `GUIDE_URL=http://127.0.0.1:8795`.
   Copy `cache/prepare/` and `cache/hotspots/` across too (they are not secret), so the demo worlds are warm.
3. **Also send:** your chosen voice, the free-tier limits, your median latencies, and 2 or 3 sentences per feature for
   Devpost (what Gemini does at each step).
4. **Test together:** one full headset run (labels, pointing at the pan, the answer, the live world greeting) before
   Saturday 10 PM.

## 13. Rules

- Write all your own code during the event (from 8 PM Friday). Open-source libraries are fine, and get credited in the
  README.
- If you use AI tools while building, list them on Devpost: the hackathon rules require crediting them.
- Keys stay in `.env`. Before every zip, load your `.env` into the shell (`set -a; . ./.env; set +a`) and search for the
  real key values. This must print nothing:
  `grep -rnF --exclude=.env --exclude-dir=node_modules -e "$GEMINI_API_KEY" -e "$GUIDE_KEY" .`
