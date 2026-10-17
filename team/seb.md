# Seb: the group chat opens it, the map remembers who was there

Read `plan.md` first (the story), then this. `contracts.md` has the wiring for the whole team; where this page and
`contracts.md` disagree, `contracts.md` wins.

Your work opens the demo (0:00, the clip in the group chat), comes back at 1:45 (the live map and the note that pops up
in the headset) and again at 2:15 (the judge's own photo becomes a world). This page is everything you need to build
it without asking anyone. Everything marked **Verified** was checked against the live docs or live APIs on Friday
night (Oct 16, ~11 PM).

---

## 0. The short version

You own these, in this priority order:

| # | What | Why it matters | Prize | Time budget |
| --- | --- | --- | --- | --- |
| 1 | **Vultr GPU access** (tonight) | The backup / demo GPU. New accounts can be blocked from GPUs, so find out tonight | MLH Best Use of Vultr | 30 min tonight |
| 2 | **Group-chat bot** (iMessage through Photon) with **demo mode** | The very first beat: a clip dropped in the chat comes back as a walkable memory | none listed (fact 1 below) | about 6 h |
| 3 | **DeepSpace app**: sign-in, gallery, **live presence map with trails**, **notes that pop up in the headset**, invites | The table-laptop screen at 1:45, and a real prize | DeepSpace: 1st = $1,000 credits + $250 cash | the rest of Saturday |
| 4 | Capital One Nessie side quest (section 12) | Optional. Nothing depends on it. 15 s at 2:40 if it is ready and good | Capital One Best Use of Nessie ($1,000 cash) | only after the Sat 10 PM run passes |

Six facts from tonight's checks that change the old brief:

1. **Photon is not a listed SwampHacks XII challenge.** It is not in the hacker guide, on Devpost or on the MLH prize
   page. Build the bot anyway (it opens the demo), but cap it and spend the rest on DeepSpace, which is a prize.
2. **Photon's free iMessage lines only talk to phone numbers you registered first** ("users"), and a shared line can
   never send the first message. So every phone that texts the bot is added beforehand (20 s each), and the demo
   phones are registered tonight.
3. **Group chats on the free plan are not guaranteed.** Photon's docs: shared lines (Free and Pro) cannot create
   groups and get no group membership events; existing group chats are listed as supported on cloud lines, but Photon
   recommends a dedicated line (Business, $250 per line per month) for group workflows. Different users are also
   assigned different bot numbers. So tonight you **test** a group on the free line, with a verified Plan B (section
   2.4).
4. **Vultr GPUs right now: only the NVIDIA A40 48 GB has enough memory, and only in New Jersey (`ewr`) and
   Los Angeles (`lax`).** No L40S or A100 anywhere, nothing in Miami, and Atlanta has only the 16 GB A16 (too small).
5. **DeepSpace: open the referral link and sign in there first.** Your DeepSpace account is created by your first
   Google/GitHub sign-in, so running `npx deepspace auth login` first loses the 5,000 free credits.
6. **The presence push goes to `https://<your-app>.app.space/api/ingest`** (under `/api/`, so the DeepSpace worker
   handles it before the static site does). Ojasva sets that full URL on his side.

---

## 1. Your moments in the demo, and what is going on with Ojasva

### 1.1 The skit, from your side

| Time | What the judge sees | Your piece |
| --- | --- | --- |
| 0:00 | You drop the cooking clip (Brianna cooking) into the group chat on the table iPhone. Within 3 s the bot replies in the same thread with a thumbnail and the world link | Bot, **demo mode**: it recognises the clip and answers with the pre-built world, no GPU wait |
| 0:00 | At the same moment, the Quest on the table loads that memory by itself | Bot calls Ojasva's cue endpoint |
| 0:20 to 1:00 | The judge walks into the memory; Gemini labels, voice, reality check | (Brianna, Ojasva) |
| 1:15 | Shivin and Brianna join as Roblox avatars; tag round | (Shivin) |
| 1:45 | The table laptop shows your **live map**: three dots moving, a lime VR dot with a view cone, trails. Brianna clicks by the stove on the map and types "Seb's seat. He was too scared to show up"; it pops up in the headset as a sticky note and stays on the map | DeepSpace `/live` + notes |
| 2:15 | The judge takes a photo with the table iPhone and sends it to the chat. The bot answers "Got it. Moving you in...", one progress text, then the thumbnail and link; the Quest swaps into the new world | Bot, normal mode (real generation on the warm GPU); the gallery shows the card building live |
| 2:40 | Optional: your Capital One side quest, 15 s | Section 12 |

### 1.2 What exists today vs what Ojasva is building

The Déjà View server (Bun, on Ojasva's Mac) **already works**: upload a photo or video, it generates a world on a GPU
(HiPerGator warm worker first, then a HiPerGator batch job, then a public FlashWorld Space, then a local fallback),
and serves the viewer that runs in the Quest 3S.

| Already there (use it now) | Ojasva still builds (you depend on it; `contracts.md` section 5) |
| --- | --- |
| `POST /api/scenes` (upload), `GET /api/scenes`, `GET /api/scenes/:id` | Plain-HTTP port **8788** for machines (tonight). Port 8787 is https with a self-signed certificate, for the Quest |
| `/data/scenes/:id/<file>` (thumbnails, worlds), with `Access-Control-Allow-Origin: *` | The public https link (Sat 12 PM, no later than 4 PM) |
| `/view?scene=<id>` (the viewer; works on phones, desktops, Quest) | Presence push to your DeepSpace app, 4 Hz (Sat 2 PM test, Sat 4 PM live) |
| `WS /ws` (live scene events: created, progress, ready, failed) | `POST /api/notes/<sceneId>` (Sat 2 PM) and notes in the headset (Sat 8 PM) |
| | `POST /api/host/cue` (Sat 4 PM), so your bot can make the Quest load a world |
| | `world.bounds` and **`world.topdown`** (a top-down image of the room) on the demo worlds (Sat 4 PM) |

HiPerGator note: the server reaches HiPerGator through one SSH socket on Ojasva's Mac that the login holder opens with
password + Duo, and it lasts 24 hours. The config uses the login `sbernalorta`. **If that is your account, Ojasva needs
you for one login on his Mac on Saturday morning and again about 24 hours later, before the demo.** Do it the moment
he asks.

---

## 2. Tonight: accounts and keys, in this order

Do these before writing code. Each one has a time box; if one is blocked, follow the fallback and move on.

### 2.1 Tools (10 min)

- **Node 24** (`node --version` shows v24.x). DeepSpace requires Node 22.15+, 24 or 26 (not 23 or 25), **and npm
  11.6+**. Node 22 ships npm 10, so take Node 24 (or run `npm i -g npm@latest`). **Verified** on the npm registry
  (`create-deepspace@0.42.3`, published Oct 13).
- **Bun 1.3+** for the bot (`curl -fsSL https://bun.sh/install | bash`). Node 20+ also works if you prefer it.
- git, a code editor, and your iPhone with iMessage on.

### 2.2 Vultr (30 min, tonight)

**Verified** facts: the MLH steps (mlh.com/partners/vultr), the gift-code link (`mlh.link/vultr-giftcode` redirects to
`my.vultr.com/billing/?promo=HACKATHON`), and the live GPU plans and stock (Vultr public API, checked 11 PM Friday).

1. **Get the code.** Register at `mlh.link/vultr-discover` (Company: University of Florida, Job title: Student) and
   check your email for the promo code. You can also get one from the "Log In To Claim Code" button on
   https://www.mlh.com/events/swamphacks-xii/prizes or from an MLH coach at the venue.
2. **Create the account** at `mlh.link/vultr-signup` and verify your email. Only one account per person.
3. **Redeem:** Billing → Gift Code → paste the code → you should see $100 of credit.
   - If Vultr asks for a card or PayPal before it lets you deploy, that is your call. If you would rather not, stop
     here and tell Ojasva; HiPerGator stays the main GPU.
4. **Check the limits:** Account → Limits (under Billing). A GPU box costs about $1,250 a month at the monthly rate. If
   the "maximum instance cost" is below that, click **Request Limit Increase** now (use case: "SwampHacks hackathon, one
   A40 GPU for about 24 hours"). Approvals take hours, which is why this happens tonight.
5. **Test deploy, then destroy.** Products → Compute → Deploy → **Cloud GPU** → location **New Jersey** → GPU
   **NVIDIA A40**, plan `vcg-a40-24c-120g-48vram` (48 GB GPU, 24 vCPU, 120 GB RAM, 1.4 TB disk, **$1.712/hour**) →
   Ubuntu 24.04 (the GPU images come with NVIDIA drivers) → Deploy. When it says **Running**, destroy it right away
   (server page → Destroy). That proves GPU access works. Cost: about one hour of billing at most.
   - A40 not offered in New Jersey? Try **Los Angeles**. Re-check stock from a terminal any time:
     `curl -s https://api.vultr.com/v2/regions/ewr/availability | grep -o 'vcg-a40[^"]*'`
   - Only A16 (16 GB) available? Do not deploy: it is too small for the world model. Tell Ojasva.
   - Error "not authorized" or "limit": open a support ticket (Support → New ticket) saying the same as in step 4.
6. **Tell Ojasva** in one message: "Vultr OK, A40 in ewr deploys" (or exactly what failed).

**Billing rule (Verified, Vultr Cloud GPU FAQ): a stopped GPU instance is billed exactly like a running one. Only
Destroy stops the charges.** $100 at $1.712/h is about 58 hours, so keep the real box under about 40 hours.

The real box comes later (section 7). Do not leave anything running tonight.

### 2.3 DeepSpace (10 min, tonight)

1. **Before anything else** open https://dashboard.deep.space/join/SWAMPHACKS2026 and sign in there with Google or
   GitHub. That first sign-in creates your account with the referral: 5,000 credits ($50). **Verified**: hacker guide;
   DeepSpace docs say accounts are OAuth-only and created on first sign-in.
   - Already have a DeepSpace account? Message DeepSpace privately (Discord DM, not a public channel) with your
     account email to get the credits.
   - Credits must be claimed **and used** by Oct 28, 11:59 PM ET. Optional: code `DEEPSPACE20` gives 20% off a first
     paid plan. You should not need a paid plan.
2. In a terminal: `npx deepspace auth login` and sign in with the **same** Google/GitHub account, then
   `npx deepspace auth whoami` should print your email.
3. Pick the app name now. It becomes `https://<name>.app.space`, is globally unique, lowercase letters, digits and
   dashes, 2 to 63 characters. Suggestion: `dejaview-live` (fallback `dejaview-swamp`). The name is shown on the
   table laptop, so keep it clean. Post it in the team chat.

### 2.4 Photon and the group chat (45 min, tonight)

What Photon is (**Verified**, photon.codes and its docs, Oct 16): an open-source TypeScript SDK called **Spectrum**
(`spectrum-ts`, v12.11.0, published Oct 15) plus a cloud that runs real iMessage lines for you. Your bot is a normal
Bun/Node process: it opens an outbound connection to Photon's cloud, so **you need no public URL and no webhook**.
It receives messages in a `for await` loop and replies with text, images, effects and links. The same code can also
answer on Telegram.

Plans (**Verified**, photon.codes/pricing and the beta plans page): **Free, $0**: a managed *shared* iMessage line
pool, up to 10 users (the beta plans page says 25 shared assignments; plan on 10), RCS/SMS fallback, Telegram. Each
user is assigned a line number that has never messaged them before, so **different people text different numbers**.
Quotas: 5,000 messages per day and 50 new conversations per line per day. Group creation is not available on shared
lines; Business ($250 per dedicated line per month) has full group messaging.

Use the stable dashboard **https://app.photon.codes** (not `app.beta.photon.codes`, which is "Photon 2.0" with a
different SDK and API).

1. Sign up at https://app.photon.codes (Get Started) and create a project (location `us-east`, Spectrum on).
   CLI alternative: `npx @photon-ai/cli login`, then
   `npx @photon-ai/cli projects create --name "Deja View" --location us-east --spectrum`.
2. Project → **Settings**: copy the **Project ID** and **Project secret** into `bot/.env` as `SPECTRUM_PROJECT_ID` and
   `SPECTRUM_PROJECT_SECRET`. Never commit this file.
3. Make sure iMessage is enabled for the project (dashboard platforms, or
   `photon spectrum platforms ls` / `photon spectrum platforms enable imessage`).
4. **Find each real iMessage handle:** open https://debug.photon.codes on the iPhone. It opens a chat with Photon's
   debug bot, which replies with the exact handle (phone number or email) Apple sends from. If it shows an email,
   switch iPhone Settings → Messages → Send & Receive → "Start new conversations from" to the number.
5. Project → **Users** → add that handle. The dashboard shows the **line number assigned to that user**: that is the
   number that user texts. Register: the **table iPhone** (the one used on stage), your phone, Brianna's, Shivin's.
6. Run the echo bot from section 4.5 and text "ping" to your assigned number. Then send a **photo** and a
   **5-second video** and check that the bot logs a MIME type, a byte count and a sha256 for each.
7. **The group test (15 min; the 0:00 beat depends on it).** On the table iPhone, create a new iMessage group with the
   bot number assigned to the table iPhone's user plus two teammates. Send "ping", a photo and a short video.
   **Pass** = the bot logs all three with `space` being the group, and its reply appears in the group for everyone.

If step 7 fails, go straight to Plan B. Tell Ojasva which plan won before you sleep.

**Plan B: the local iMessage provider (Verified: docs and npm, `@spectrum-ts/imessage-local` 12.11.0).** It reads the
Messages database on a Mac, needs no Photon credentials and no user registration, and supports existing DMs and group
chats (receive and send text and attachments). It has no message effects (no confetti) and typing indicators do
nothing.
- It needs a Mac signed into **Messages** with an Apple ID that is **not** the person sending the clip (the bot skips
  its own outbound messages, so it would ignore you if it ran as you). Best: a new Apple ID made just for the bot
  ("Déjà View"), signed into Messages on a teammate's Mac or on Ojasva's demo Mac (ask him first: his own iMessage
  leaves that Mac for the weekend). Add that Apple ID's handle to the demo group.
- Grant **Full Disk Access** to the terminal app that runs the bot (System Settings → Privacy & Security → Full Disk
  Access), so it can read `~/Library/Messages/chat.db`. On Node it needs `better-sqlite3`; Bun is fine.
- Config: `import { localIMessage } from "@spectrum-ts/imessage-local"` and
  `Spectrum({ providers: [localIMessage.config()] })`. `message.platform` is `"local_imessage"`.
- If the bot runs on a Mac other than Ojasva's, set `DV_API` to the public `BASE` (or his LAN `http://<ip>:8788`).

**Plan C:** a 1:1 thread with the bot on the table iPhone, using the cloud line. The host says "drops it in the chat".
Everything else stays the same.

**Checkpoint (tonight):** a photo and a video sent in the demo chat reach your laptop as bytes, and the bot can reply
into that chat. If any step is blocked for more than 30 minutes, take the next plan and keep going.

### 2.5 Fallback channel: Telegram (5 min, do it tonight anyway)

- In Telegram, message **@BotFather** → `/newbot` → pick a name → copy the token into `bot/.env` as
  `SPECTRUM_TELEGRAM_BOT_TOKEN`.
- Spectrum has a Telegram provider: add `telegram.config()` next to `imessage.config()` and the **same loop** answers
  on both (it uses your Photon project to register the webhook, so still no public URL). Telegram groups work with
  bots (turn privacy mode off in @BotFather with `/setprivacy` so the bot sees photos in the group).
- If Photon itself is down: talk to the Telegram Bot API directly with long polling (`getUpdates`), also no public URL.
- **Verified** limits (core.telegram.org/bots/api): a bot can download files up to **20 MB** (keep test videos short);
  photos you upload can be up to 10 MB.
- Not an option: **Twilio SMS/MMS**. It needs a paid number, and US texts from an unregistered 10-digit number are
  blocked until A2P 10DLC registration is approved (Twilio error 30034), which takes days.

---

## 3. How everything connects

```
  table iPhone ──iMessage group──▶ Photon cloud ◀──outbound gRPC── BOT (Bun, your laptop; the demo Mac for the skit)
                                   (or Plan B: Messages on a Mac)    │  POST /api/scenes (multipart photo/video)
                                                                     │  WS /ws (progress), GET /data/... (thumbnail)
                                                                     │  POST /api/host/cue (Quest loads the world)
                                                                     ▼
                         ┌────────────── Déjà View server (Ojasva's Mac; http :8788 for you, public https BASE)
  Quest 3S viewer ──────▶│  presence relay  ── GPU: HiPerGator / Vultr A40
  Roblox servers  ──────▶│  notes store ──WS──▶ headset (sticky notes)
                         └──── POST https://<app>.app.space/api/ingest  (~4 Hz per occupied scene, X-DejaView-Key)
                                       ▲                           │
              POST BASE/api/notes/<id> │                           ▼
                         DeepSpace app (Cloudflare Workers, yours)
                           worker /api/ingest ──▶ RecordRoom "live" row ──realtime──▶ every open map, 60 fps
                           browser ──GET BASE/api/scenes + WS BASE/ws──▶ gallery (CORS: *)
                           browser ──click on map──▶ notes record + POST BASE/api/notes/<id>
                           Google/GitHub sign-in, favourites, comments, visits, invites
```

Who calls whom:

| Caller | Callee | What | Auth |
| --- | --- | --- | --- |
| Bot | Photon cloud (or local Messages) | receive and send messages | `SPECTRUM_PROJECT_ID` + secret (env) |
| Bot | Déjà View `DV_API` | create scenes, watch progress, fetch thumbnails, cue the headset | `x-dejaview-key: <DV_KEY>` on `/api/host/cue` (not needed from the same Mac) |
| Déjà View server | DeepSpace `/api/ingest` | presence snapshots | header `X-DejaView-Key: <your ingest secret>` |
| DeepSpace page (browser) | Déjà View `dvBase` | scene list, thumbnails, top-down image, live scene events, **posting notes** | none (server sends CORS `*`) |
| DeepSpace page | DeepSpace worker + rooms | sign-in, records, realtime | DeepSpace JWT (handled by the SDK) |

URLs and ports:

| Name | Value | Notes |
| --- | --- | --- |
| `DV_API` (bot) | `http://<Ojasva LAN IP>:8788` while building; `http://localhost:8788` on Ojasva's Mac at the demo | plain HTTP (8787 is https with a self-signed certificate for the Quest: don't use it) |
| `DV_PUBLIC` (bot) / `dvBase` (DeepSpace) | the public https link, e.g. `https://xxxx.trycloudflare.com` | what goes into links people tap. It can change if the tunnel restarts, so keep it configurable (bot `.env`, DeepSpace `config` record) |
| `DS_URL` | `https://dejaview-live.app.space` | your app |
| DeepSpace local dev | `http://localhost:5173` | `npx deepspace dev start` |

Two network traps:
- A deployed DeepSpace page is https, so the browser **refuses** to fetch an `http://10.x...` LAN address (mixed
  content). Until the public link exists, build the gallery in local dev (`http://localhost:5173` may call http) or
  against mock JSON.
- Campus Wi-Fi often blocks laptop-to-laptop traffic. If you cannot reach Ojasva's LAN IP, both of you join one phone
  hotspot.

`/ws` sends more message types than `scene` (`cue`, `note`, `hotspots`, `roblox`, ...). **Ignore any type you don't
use.**

---

## 4. Part A: the group-chat bot

### 4.1 Behaviour (the spec)

| You receive | The bot does |
| --- | --- |
| media that matches a **demo cue** (4.2) | instant reply with the pre-built world, plus a `load` cue. No upload |
| 1 to 8 photos (any order, within 2.5 s) | Rent Free world. `mode=rentfree`, all photos (the server picks the best one) |
| 1 video | Third Wheel. `mode=thirdwheel`. If the text says "room", use `rentfree` instead (the server builds the room from the sharpest frame) |
| a photo and a video together (an iPhone **Live Photo** can arrive as HEIC + MOV) | keep the photo(s), drop the video, `rentfree` |
| in a DM: plain text that is not a command, at least 3 words ("a cozy cabin at night") | Rent Free from the prompt alone (`mode=rentfree`, `prompt=<text>`, no files) |
| text within 2.5 s of an attachment | becomes the memory's `name` (first 60 chars) |
| `rooms` | the 3 newest ready memories, each with its link |
| `map` | the live-map link for this chat's latest memory |
| `help` | one short help message |
| anything while this chat's previous memory is still building | "Still on your last one. I'll text you the second it's ready." |

**In a group chat**, react only to photos, videos and messages that start with a command word (`rooms`, `map`,
`help`, or `dejaview ...`). Never answer normal conversation: friends are talking to each other. **In a DM**, answer
everything (it keeps the line healthy).

Message timing and copy (keep every string in `copy.ts`; plain text, warm, short, a little funny; no emoji walls):

1. **Within 2 s of the last attachment:** typing indicator (cloud only), then "Got it. Moving you in..."
   (video: "Ooh, footage. Building the room around it...").
2. **One progress message, not more,** when the scene first reports `status: "running"` or `progress >= 0.3`:
   "Building the room: <stage, lowercased>". The server's `stage` strings are already human ("Generating the room").
3. **Ready:** the thumbnail as an image (with the iMessage **confetti** effect on cloud lines), then **one** text with
   three lines:
   ```
   Your memory is ready. Walk in: <DV_PUBLIC>/view?scene=<id>
   See who's inside: <DS_URL>/m/<id>
   No headset? Join in Roblox: https://www.roblox.com/games/start?placeId=<ROBLOX_PLACE_ID>&launchData=<id>
   ```
   (Shivin sends you `ROBLOX_PLACE_ID` by Sat 12 PM; leave the third line out until then.) Then, if the media came
   from the demo chat, `POST {DV_API}/api/host/cue` `{action:"load", sceneId, by:"bot"}` so the Quest loads it.
4. **Over 90 s and not ready:** "Still building. Big room. I'll text you when it's done." (once), keep waiting up to
   10 minutes.
5. **Failed:** a specific message. The server's `error` text is usually already friendly ("Third Wheel needs one video
   (film from a still, propped-up phone)"); pass it through, prefixed with "That one didn't work: ".
   Network error reaching Déjà View: "Our GPU is taking a breather. Try again in a minute." and retry the upload once
   after 5 s.

Pace: never send more than one message per second (Apple flags bursty lines). Links work well because users write
first.

### 4.2 Demo mode (the 0:00 beat)

The skit uses worlds generated in advance (`plan.md`). The bot must recognise the demo clip and answer instantly.
`bot/demo.json` (not secret, commit it):

```json
{ "demoSpaceId": "<the demo group's space id, logged the first time it messages the bot>",
  "cues": [
    { "name": "cooking", "kind": "video", "sceneId": "<pre-built Game night scene id from Ojasva>",
      "sha256": ["<hash the bot logged when the table iPhone sent the clip>"],
      "keywords": ["#dejaview cooking"] } ] }
```

Matching, in this order, only when `DEMO_MODE=1`:
1. **sha256 of the received bytes** equals one in `sha256`. iMessage may recompress media, so the hash the bot sees
   can differ from the file on your laptop: in rehearsal, send the clip from the table iPhone, copy the hash the bot
   logs into `demo.json`, restart, send it again and confirm the match.
2. **A keyword** in text that arrives within 2.5 s of the media (type `#dejaview cooking` as the caption).
3. **Armed cue:** you DM the bot `!arm cooking` from your own registered phone; the next video in the demo chat maps
   to that cue, once. Use this if the hash changes on the night.

On a match: send the scene's thumbnail (`GET {DV_API}/data/scenes/<id>/thumb.jpg`) and the ready text from 4.1
within 3 s, then the `load` cue. No upload, no progress text. Log `demo match: cooking (sha256)` so you can see why.

Everything that does not match (the judge's photo at 2:15) goes through the normal upload path, and its ready reply
also sends the `load` cue, because it came from the demo chat. Media from any other chat never cues the headset.

### 4.3 Files

```
bot/
  package.json        "type": "module"; deps: spectrum-ts pinned to 12.11.0 (+ @spectrum-ts/imessage-local 12.11.0 for Plan B)
  .env.example        names only: SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, DV_API, DV_PUBLIC, DV_KEY, DS_URL,
                      ROBLOX_PLACE_ID, DEMO_MODE, BOT_PROVIDER (cloud | local), SPECTRUM_TELEGRAM_BOT_TOKEN
  demo.json           demo cues (4.2)
  src/index.ts        Spectrum loop: route each inbound message, never block the loop
  src/collect.ts      per-chat 2.5 s collector (attachments + caption), "one active job per chat", group rules
  src/demo.ts         sha256, keyword and armed-cue matching
  src/dejaview.ts     createScene(), watchScene() (ws first, polling fallback), thumbnailBytes(), latestReady(), cue()
  src/copy.ts         every string the bot sends
  src/dev.ts          terminal-provider mode for testing without a phone: "/photo ./samples/room.jpg"
  samples/            room.jpg, room.heic, still-cooking.mov (under 20 MB)
```

### 4.4 The Déjà View API you call

**Create a memory (exists).** `POST {DV_API}/api/scenes`, `multipart/form-data`:

| Field | Value |
| --- | --- |
| `mode` | `rentfree` or `thirdwheel` |
| `name` | optional, up to 80 chars |
| `prompt` | optional text (alone = text-to-world) |
| `files` | one field per file. JPEG, PNG, HEIC and HEIF, MOV/MP4 are all fine; the server converts HEIC itself |

201 Created:
```json
{ "id": "dorm-room-k3x9a", "name": "Dorm room", "mode": "rentfree", "status": "queued", "stage": "Queued",
  "progress": 0, "createdAt": "2026-10-17T14:02:19.250Z", "updatedAt": "2026-10-17T14:02:19.250Z",
  "input": { "files": ["input/00.jpg"] }, "thumb": "thumb.jpg" }
```
Errors are `{ "error": "<human sentence>" }` with 400 (bad input: "Send photos or one video, not both",
"Third Wheel needs one video ..."), 413 (over 1 GB), 415 (not multipart), 500.

**Watch it (exists).** Either:
- WebSocket `ws://{DV_API host}/ws`. Every message is JSON: `{ "type": "health", ... }` (first, ignore),
  `{ "type": "scene", "scene": <Scene> }` (every change to any scene: filter by `id`), `{ "type": "scene_deleted", "id" }`,
  and other types you ignore.
- Or poll `GET {DV_API}/api/scenes/<id>` every 2 s. Same `Scene` shape.

`status` goes `queued` → (`uploading`) → `running` → (`downloading`) → `ready`, or `failed` with `error`.
`progress` is 0 to 1 when known. After `ready` the scene also has a `caption` written by Gemini (Brianna); you can
add it to the ready text.

**Ready (exists).** Thumbnail bytes: `GET {DV_API}/data/scenes/<id>/<scene.thumb>` (a JPEG; some bundled samples have no
`thumb`). Link to text back: `{DV_PUBLIC}/view?scene=<id>`.

**List (exists).** `GET {DV_API}/api/scenes` → `Scene[]`, newest first. It includes failed scenes; filter
`status === "ready"`.

**Cue the headset (Ojasva builds, Sat 4 PM).** `POST {DV_API}/api/host/cue`, JSON
`{ "action": "load", "sceneId": "<id>", "by": "bot" }`, header `x-dejaview-key: <DV_KEY>` (not needed when the bot
runs on Ojasva's Mac). Response `{ "ok": true }`. A failed cue is not an error for the chat: log it and move on.

### 4.5 Snippets that remove the guesswork

Echo bot (tonight's checkpoint). Spectrum reads `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` from the
environment (Bun loads `.env` automatically):

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createHash } from "node:crypto";

const app = await Spectrum({ providers: [imessage.config()] });

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const c = message.content;
  if (c.type === "attachment") {
    const bytes = await c.read(); // each read() downloads again: read once, keep it
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(space.id, message.sender?.id, c.name, c.mimeType, bytes.length, sha);
    await space.send(`got ${c.mimeType}, ${bytes.length} bytes`);
  } else if (c.type === "text") {
    await space.send(`echo: ${c.text}`);
  }
}
```

Inbound attachment content (**Verified**, Spectrum messages docs): `{ type: "attachment", id, name, mimeType,
size?, read(), stream() }`. Expect `image/heic` for iPhone photos and `video/quicktime` for iPhone videos, but route
on the `image/` or `video/` prefix and log what really arrives during the tonight checkpoint. Log `space.id` too:
that is how you tell the demo group from DMs (`demoSpaceId` in 4.2).

**Never `await` a whole job inside the loop.** One 30-second world would freeze every other conversation. Hand each
message to an async function and catch its errors:

```ts
for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  handle(space, message).catch((err) => console.error("[bot]", err));
}
```

Typing indicator around slow work (it is cleared even if your code throws; a no-op on Plan B):

```ts
await space.responding(async () => { await space.send(copy.ack(kind)); });
```

Upload to Déjà View (Bun and Node 20+ have `fetch`, `FormData` and `File` built in):

```ts
const form = new FormData();
form.set("mode", mode);                 // "rentfree" | "thirdwheel"
if (name) form.set("name", name);
if (prompt) form.set("prompt", prompt);
for (const f of files) form.append("files", new File([f.bytes], f.name, { type: f.mimeType }));
const res = await fetch(`${process.env.DV_API}/api/scenes`, { method: "POST", body: form });
const body = await res.json();          // 201: Scene. Otherwise { error }
```

Live progress over the server's WebSocket (reconnect on close; poll if it is down):

```ts
const ws = new WebSocket(process.env.DV_API!.replace(/^http/, "ws") + "/ws");
ws.onmessage = (e) => {
  const ev = JSON.parse(String(e.data));
  if (ev.type === "scene") onSceneUpdate(ev.scene); // look up which chat waits for ev.scene.id; ignore other types
};
```

Send the thumbnail with an effect, then the links (**Verified**, Spectrum attachments and message-effects docs):

```ts
import { attachment } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";

const jpg = Buffer.from(await (await fetch(`${DV_API}/data/scenes/${s.id}/${s.thumb}`)).arrayBuffer());
const pic = attachment(jpg, { name: "your-memory.jpg", mimeType: "image/jpeg" });
await space.send(message.platform === "imessage" ? effect(pic, imessage.effect.message.confetti) : pic);
await space.send(copy.ready(s.id));
await cue(s.id);  // POST /api/host/cue, only for the demo chat
```

Effects only apply on cloud iMessage; on Plan B and Telegram send the plain attachment. Spectrum also has
`richlink(url)`, but the preview comes from the page's own metadata, so a plain link plus your thumbnail looks better.

Telegram fallback in the same process:

```ts
import { telegram } from "spectrum-ts/providers/telegram";
const app = await Spectrum({
  providers: [imessage.config(), telegram.config({ botToken: process.env.SPECTRUM_TELEGRAM_BOT_TOKEN! })],
});
// message.platform tells you which one a message came from
```

Testing without a phone: the `terminal` provider (`spectrum-ts/providers/terminal`, no credentials) gives you a chat
UI in your terminal with the same `for await` loop. It downloads a small chat program (`tuichat`) the first time.
Add a dev-only text command `/photo <path>` that reads a local file and runs the exact same pipeline.

### 4.6 Build order and checkpoints

| Step | Do | You should now see |
| --- | --- | --- |
| A1 | `bun init`, `bun add spectrum-ts`, echo bot (4.5) | "ping" from your phone gets "echo: ping"; a photo logs `image/heic`, a byte count and a sha256 |
| A2 | the group test (2.4 step 7), Plan B if needed | the bot sees media in the demo group and its reply shows up there |
| A3 | `dejaview.ts`: `createScene` against Ojasva's LAN server (curl first, below) | `curl` and your function both return 201 with an `id`; the scene shows up at `http://<LAN IP>:8788/` |
| A4 | `watchScene` (ws + polling), test with a scene you created by curl | log lines: queued → running 0.4 → ready |
| A5 | collector (2.5 s window, Live Photo rule, caption → name), one job per chat, group rules | 3 photos sent quickly = 1 scene; photo + "Our kitchen" = a scene named "Our kitchen"; chatter in the group gets no reply |
| A6 | full flow with copy, effect and links | your phone: ack < 2 s, one progress text, thumbnail, one links message that opens |
| A7 | demo mode (4.2) with a sample scene id | the clip from the table iPhone gets the pre-built world in under 3 s, no upload in the server log |
| A8 | `cue()` once Ojasva's endpoint exists | the desktop viewer opened with `?follow=1` loads the world when the bot replies |
| A9 | errors: a PDF, two videos at once, a 25 MB clip on Telegram, the server stopped | every case gets one specific, friendly reply; the bot never crashes |
| A10 | `rooms`, `map`, `help`, text prompt in a DM; Telegram provider on | each command answers in under 1 s; the same flow works from Telegram |

### 4.7 Test alone first

```bash
# Is the server reachable? (Ojasva gives you the LAN IP)
curl -s http://10.x.x.x:8788/api/health

# Create a scene by hand, exactly what your bot will do
curl -s -F mode=rentfree -F name="Curl test room" -F files=@samples/room.jpg http://10.x.x.x:8788/api/scenes

# Watch it
curl -s http://10.x.x.x:8788/api/scenes/<id> | jq '{status, stage, progress, error, thumb, caption}'

# Prompt only
curl -s -F mode=rentfree -F prompt="a cozy cabin at night with a fireplace" http://10.x.x.x:8788/api/scenes

# Cue (from Sat 4 PM)
curl -s -X POST http://10.x.x.x:8788/api/host/cue -H 'Content-Type: application/json' -H "x-dejaview-key: $DV_KEY" \
  -d '{"action":"load","sceneId":"sample-painted-bedroom","by":"bot"}'
```

No server yet? Write a 30-line fake in Bun (`Bun.serve` on 8788) that answers `POST /api/scenes` with a fake id and
moves it to `ready` after 10 s, with a static `thumb.jpg`. The bot should not know the difference.

---

## 5. Part B: the DeepSpace app (the prize)

### 5.1 What the judges must see

DeepSpace's rule (**Verified**, hacker guide and Devpost): the SDK must be part of the project's working
functionality (a logo or mention alone doesn't count), you must explain which features you used and where to see
them, and there must be a live demo or testable build that does not expose secrets. Your app uses:

| DeepSpace feature | Where it does real work |
| --- | --- |
| **Auth** (Better Auth, Google/GitHub, `useAuth`, `AuthGate`) | sign in to leave notes, favourite, comment, invite; the table laptop is signed in |
| **Records + RBAC** (`RecordRoom`, collection schemas, `'*'`/member/admin rules, `uniqueOn`, `ownerField`) | `live`, `notes`, `visits`, `favorites`, `comments`, `invites`, `config` |
| **Realtime sync** (`useQuery` subscriptions) | the live map: one `live` row per room updated 4 times a second, pushed to every open map; new notes appear on every open map at once |
| **Worker routes + RBAC-bypass writes** (Hono route, the app's action tools) | `/api/ingest`: the Déjà View server pushes presence; the worker writes it into the room |
| **Secrets store** (`deepspace secrets set`) | the ingest key, never in code |
| **Presence room** (`usePresenceRoom`) | "watching now": everyone with the map open shows up as an avatar in the corner |
| **Cron room** (optional) | every minute, clear rooms nobody has pushed for 30 s |
| **Server action** (optional) | "text a memory": registers a judge's phone with Photon and shows a QR (5.10); the Nessie side quest (section 12) |
| **Deploy** (`deepspace deploy` to `*.app.space`) | the public URL on the laptop and in every bot reply |

### 5.2 Pages

| Route | File | Who | What |
| --- | --- | --- | --- |
| `/` | `src/pages/index.tsx` (static, no data hooks) | anyone | landing: "Every memory, shared." + button to `/gallery` |
| `/gallery` | `src/pages/(app)/gallery.tsx` | anyone; sign-in to act | grid of memories from Déjà View; live "building" cards; "3 inside now" badges from `live`; favourites |
| `/m/:id` | `src/pages/(app)/m/[id].tsx` | anyone; sign-in to leave notes | the big live map with notes, people list, "Step inside" (opens `{dvBase}/view?scene=<id>`), who has been here, comments, invite button, QR to this page |
| `/live` | `src/pages/(app)/live.tsx` | the table laptop | full-screen map with notes that **automatically follows the busiest room** (most people, most recent; switch only after 5 s of a clear lead); `?scene=<id>` pins one. No clicking needed during the demo |
| `/i/:code` | `src/pages/(app)/i/[code].tsx` | the invited friend | "Seb invited you into Kitchen" + Step inside button |
| `/admin` | `src/pages/(app)/(protected)/admin.tsx` | you (the app owner is always `admin`) | set `dvBase` (the public link) without a redeploy; feed health ("last ingest 0.2 s ago"); delete test notes |

Put pages only where the docs say: `src/pages/(app)/...` for pages with data (they work signed out too), and
`src/pages/(app)/(protected)/...` for pages that need sign-in. A new `(protected)` folder anywhere else is **not**
gated and has no data provider. Dynamic segments use `[id].tsx`.

### 5.3 Collections (`src/schemas/*.ts`, added to `src/schemas.ts`)

| Collection | Columns | Permissions | Written by |
| --- | --- | --- | --- |
| `live` | `sceneId` (text, required), `t` (number), `people` (json: `Person[]`) | everyone read; nobody writes from the browser | worker `/api/ingest` |
| `notes` | `sceneId`, `x` (number), `z` (number), `text` (≤ 120), `authorName`, `userId` (`userBound`) | everyone read; member create; delete own; admin delete | signed-in users, by clicking the map |
| `visits` | `sceneId`, `personId`, `name`, `kind`, `firstSeenAt` (number, unix s) | everyone read; no browser writes | worker, first time a person appears in a room |
| `favorites` | `sceneId`, `userId` (`userBound`, `immutable`) | read all; member create; delete own. `uniqueOn: ['sceneId','userId']`, `ownerField: 'userId'` | signed-in users |
| `comments` | `sceneId`, `text` (≤ 280), `authorName` | everyone read; member create; delete own | signed-in users |
| `invites` | `sceneId`, `code` (8 random chars), `inviteeName` | everyone read (codes are unguessable); member create; delete own | signed-in users |
| `config` | `key`, `value` | everyone read; admin create/update | you, on `/admin` |

One full example so the syntax is right (json columns take the array directly; never `JSON.stringify`):

```ts
// src/schemas/live-schema.ts
import type { CollectionSchema } from 'deepspace/schema'

const browserReadOnly = { read: true, create: false, update: false, delete: false }

export const liveSchema: CollectionSchema = {
  name: 'live',
  columns: [
    { name: 'sceneId', storage: 'text', interpretation: 'plain', required: true },
    { name: 't', storage: 'number', interpretation: 'plain' },
    { name: 'people', storage: 'text', interpretation: { kind: 'json' } },
  ],
  uniqueOn: ['sceneId'],
  permissions: { '*': browserReadOnly, viewer: browserReadOnly, member: browserReadOnly, admin: browserReadOnly },
}
```

Schemas are baked in at build time: every schema change needs a redeploy (new columns migrate automatically).
Do not store phone numbers or emails in any collection. How a `userBound` column is filled is not spelled out in the
docs: pass `useAuth().userId` when you create the record and check it in local dev.

### 5.4 The ingest endpoint (the contract with Ojasva)

`POST https://<app>.app.space/api/ingest` (local: `http://localhost:5173/api/ingest`)

Headers: `Content-Type: application/json`, `X-DejaView-Key: <shared secret>`

```json
{
  "sceneId": "game-night-k3x9a",
  "t": 1760710000.25,
  "people": [
    { "id": "quest-1",      "name": "Judge",   "kind": "vr",     "x": 0.4,  "y": 0, "z": -1.2, "yaw": 0.3 },
    { "id": "rbx-12345",    "name": "shivin",  "kind": "roblox", "x": 2.1,  "y": 0, "z": 0.3,  "yaw": 1.2 },
    { "id": "web-7f2a91c0", "name": "Maya",    "kind": "web",    "x": -1.0, "y": 0, "z": 0.8,  "yaw": 3.1 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `sceneId` | Déjà View scene id, `^[a-z0-9][a-z0-9-]{0,95}$` |
| `t` | server time in seconds (Unix, float) when the snapshot was taken |
| `people` | **everyone** in that scene right now (a full snapshot, not a diff). Empty array = room is empty |
| `id` | stable per person (`quest-1`, `rbx-<robloxUserId>`, `web-<8 hex>`) |
| `kind` | `vr` (headset), `roblox`, `web` (a browser viewer) |
| `x, y, z` | **metres in the room frame** (`contracts.md` 3.1): Y up, floor at y = 0, a camera at the origin looks down −Z. These are the person's **feet**, so `y` is about 0. The map uses x and z |
| `yaw` | radians, rotation about +Y like three.js `rotation.y`: **0 faces −Z, positive turns left** (counter-clockwise seen from above). Facing direction = (−sin yaw, −cos yaw) in (x, z) |

Ignore any extra fields you don't know (future-proofing).

Responses:
- `200 { "ok": true, "people": 3 }`
- `400 { "error": "people[1].x must be a finite number" }` (validate everything: `people` at most 32, finite numbers,
  known `kind`, names ≤ 40 chars)
- `401 { "error": "unauthorized" }` (wrong or missing key)
- `413` body over 32 KB
- `500 { "error": "..." }`

What Ojasva's server promises (`contracts.md` 5.7):
- Pushes about 4 times a second **only for scenes with people in them**, and at least once a second while anyone is
  there, even if nobody moved.
- Sends exactly one push with `"people": []` when the last person leaves.
- Fire-and-forget with a 2 s timeout: if the previous push for a scene is still in flight, it skips, it never queues.

The handler, so you do not have to dig. The template's `src/server/action-routes.ts` builds the "tools" that server
actions use to write records with RBAC off (`createActionTools`). It is a local function: add `export` to it and reuse
it. `tools.create(collection, data, recordId)` with a fixed `recordId` is an **upsert**: it merges into the existing
row. (**Verified** in the `create-deepspace@0.42.3` template and the server-actions docs.)

```ts
// src/server/ingest-routes.ts
import type { Hono } from 'hono'
import type { AppContext } from '../../worker.js'
import { createActionTools } from './action-routes.js' // add `export` to that function

const seen = new Map<string, Set<string>>() // per-isolate cache: sceneId -> person ids already logged as visits

export function registerIngestRoutes(app: Hono<AppContext>): void {
  app.post('/api/ingest', async (c) => {
    const key = c.env.DEJAVIEW_INGEST_KEY // if the secret is missing, refuse everything (undefined === undefined!)
    if (!key || c.req.header('X-DejaView-Key') !== key) return c.json({ error: 'unauthorized' }, 401)
    const body = await c.req.json().catch(() => null)
    // ...validate body (see the table above); on failure return c.json({ error: '...' }, 400)
    const tools = createActionTools(c.env, c.env.OWNER_USER_ID, '')
    const r = await tools.create('live', { sceneId: body.sceneId, t: body.t, people: body.people }, `live-${body.sceneId}`)
    if (!r.success) return c.json({ error: r.error }, 500)
    // for each person not yet in seen[sceneId]: tools.create('visits', {...}, `v-${sceneId}-${person.id}`) (idempotent)
    return c.json({ ok: true, people: body.people.length })
  })
}
```

The second argument is the identity the write is recorded as. Log `c.env.OWNER_USER_ID` once in local dev; if it is
empty there, pass a fixed string such as `'dejaview-ingest'`.

Wire it up: in `worker.ts` add `DEJAVIEW_INGEST_KEY: string` to `interface Env`, and call
`registerIngestRoutes(app)` right after `registerActionRoutes(app, resolveAuth)` (before the platform proxy and
static routes; order matters). Set the key with
`npx deepspace secrets set DEJAVIEW_INGEST_KEY=$(openssl rand -hex 24)`, restart dev, redeploy for production
(deployed apps only see secret changes after a deploy). Read it back with
`npx deepspace secrets get DEJAVIEW_INGEST_KEY --plain` to hand to Ojasva in person.

Whether 4 pushes a second cost DeepSpace credits or hit a platform rate limit is not documented. Watch the credit
balance on the dashboard after the first hour of real pushes on Saturday and tell Ojasva if it drops fast: he can push
at 2 Hz instead.

Optional stretch, only if Ojasva has time: `POST /api/event` with `{ "sceneId", "type": "tag", "by": "quest-1",
"target": "rbx-12345", "t" }`: the map flashes "TAGGED" on the target dot. Same key header.

### 5.5 The live map: smooth, not janky

Data: `useQuery('live', { where: { sceneId } })` gives you one row that changes about 4 times a second. **Do not render
the map with React state.** Push each row into a buffer kept in a `ref`, and draw on a `<canvas>` in a
`requestAnimationFrame` loop. React only re-renders the side panel.

Snapshot interpolation: draw everyone 300 ms in the past, between the two snapshots around that moment. Motion is then
continuous and evenly paced even though data arrives in steps:

```ts
type Sample = { t: number; x: number; z: number; yaw: number }
const buf = new Map<string, Sample[]>() // person id -> last ~10 samples
let offset: number | null = null         // local clock minus server clock, in seconds

export function onLiveRow(row: { t: number; people: Person[] }) {
  const local = performance.now() / 1000
  if (offset === null || Math.abs(local - row.t - offset) > 1) offset = local - row.t // resync on big drift
  for (const p of row.people) {
    const b = buf.get(p.id) ?? []
    if (!b.length || row.t > b[b.length - 1].t) b.push({ t: row.t, x: p.x, z: p.z, yaw: p.yaw })
    if (b.length > 10) b.shift()
    buf.set(p.id, b)
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a)) // shortest way round for yaw

export function poseAt(b: Sample[], renderT: number): Sample { // b holds at least one sample
  if (renderT <= b[0].t) return b[0]
  for (let i = 1; i < b.length; i++) {
    if (b[i].t >= renderT) {
      const a = b[i - 1], c = b[i], k = (renderT - a.t) / (c.t - a.t)
      return { t: renderT, x: a.x + (c.x - a.x) * k, z: a.z + (c.z - a.z) * k, yaw: a.yaw + wrap(c.yaw - a.yaw) * k }
    }
  }
  return b[b.length - 1] // no newer sample yet: hold the last pose (do not extrapolate more than 0.25 s)
}
// every frame: const renderT = performance.now() / 1000 - offset! - 0.3
```

Drawing rules:
- **Projection:** fit the room's x/z extent into the canvas with 24 px padding, same scale on both axes. Screen x =
  world x, screen y (downwards) = world z, so "forward" (−Z) points up. Use `devicePixelRatio` for a crisp canvas. Keep
  the inverse function too: clicks become world (x, z) for notes.
- **Floor plan:** `GET {dvBase}/api/scenes/<id>` → `world.topdown = { file, min: [x, z], max: [x, z] }`. Draw
  `{dvBase}/data/scenes/<id>/<file>` stretched exactly from `min` to `max` (image right = +X, image down = +Z), at
  about 70% opacity under the grid. This is what lets Brianna see the stove. Ojasva ships it for the demo worlds by
  Sat 4 PM. No `topdown`: use `world.bounds` x/z; no bounds either (the bundled samples): start with −4 to 4 m and grow
  smoothly to fit everyone seen, plus 1 m of margin.
- **Grid:** dark grid every 0.5 m, a slightly brighter line every 1 m, the extent as a soft rounded rectangle, a
  vignette at the edges. The scene thumbnail is a perspective photo, not a floor plan: show it as a card in the corner.
- **People:** VR = lime `#C6FF3D` dot with a slow pulsing ring and a translucent **view cone** (60°, 1.2 m) in the
  facing direction, so the room can see where the judge is looking. Roblox = white dot with a tiny block glyph. Web =
  grey outline dot. Name label above each in bold caps.
- **Trails** ("where everyone walked"): a fading line of each person's last 15 s, lime for VR, white for Roblox.
- **Join and leave:** fade and scale in over 300 ms; when someone disappears from `people`, fade out over 600 ms. No
  pops, no teleports.
- **Stale feed:** if the newest `t` is more than 5 s old, dim the map and show "No one here right now".
- **Watching now:** `usePresenceRoom('map:' + sceneId)` and show the people who have the map open as small avatars
  in a corner.
- **Labels (optional):** `GET {dvBase}/api/scenes/<id>/hotspots` → `{ hotspots: [{ label, x, z, ... }] }`. Draw them as
  small grey text at (x, z): Gemini's labels (pan, spice rack) on your map.

### 5.6 Notes: click the map, it appears in the headset

The 1:45 beat. Brianna, signed in on her laptop, clicks by the stove on `/live` or `/m/:id` and types "the onions were
Seb's fault". It appears on every open map at once and, within a second, as a sticky note in the headset at that spot.
Notes stay, so the next visitor finds them.

1. **Click** (signed in only; signed out shows "Sign in to leave a note"): open a small composer at the click point: one
   input, a 120-character counter, Enter sends, Esc cancels. Convert the click to world `(x, z)` with the inverse
   projection.
2. **Save in DeepSpace:** create a `notes` record with id `note-<8 random lowercase letters or digits>`
   `{ sceneId, x, z, text, authorName, userId }`.
3. **Send to the headset:** `POST {dvBase}/api/notes/<sceneId>` with JSON
   `{ "id": "<same id>", "x": 1.20, "z": -0.80, "text": "Seb's seat. He was too scared to show up", "author": "Brianna" }`.
   Expect `201 { ok: true, note }` (or `200` if that id was already stored, which makes retries safe). Retry up to 3
   times over 3 s. If it still fails, keep the note on the map with a small "not in the headset yet · retry" chip.
   `400 {error}` means a bad field (empty text, more than 120 characters, or a spot outside the room).
4. **Draw notes** from `useQuery('notes', { where: { sceneId } })`: a small lime square "sticky" with the first 24
   characters and the author, popping in with a 200 ms scale. Hover or tap shows the full text.

Why both: DeepSpace is the record and the realtime map (and it is the prize); Déjà View is what the headset listens
to and keeps notes on disk for the next person who walks in. The browser can call Déjà View directly because the
server sends CORS `*` and answers the JSON preflight. If DeepSpace's page turns out to block requests to other
origins (check in step B4: the gallery fetch hits the same rule), move step 3 into a worker route `POST /api/notes`
that does the same `fetch` from the worker.

### 5.7 The gallery reads Déjà View directly

- Fetch `{dvBase}/api/scenes` straight from the browser (the server sends `Access-Control-Allow-Origin: *`;
  **Verified** on the running server). Show `ready` scenes and the ones still building; hide `failed`.
- Thumbnail: a plain `<img>` with `src` = `{dvBase}/data/scenes/<id>/<thumb>` (images need no CORS). No `thumb`: a
  dark gradient card with the name. Show `caption` (written by Gemini) under the name.
- Live updates: open `new WebSocket(dvBase.replace(/^http/, 'ws') + '/ws')` and apply every
  `{ type: 'scene', scene }` event (insert, update in place) and `{ type: 'scene_deleted', id }`; ignore other types.
  That is what makes a new card appear the second the judge sends the photo at 2:15. If the socket drops (or the
  tunnel does not pass WebSockets: test it at B4), reconnect with backoff and poll the list every 2 s meanwhile.
- Badges per card: mode ("Room" / "Third Wheel"), status with a lime progress bar while building, "3 inside now" from
  `live`, favourites count, notes count, "Judge, shivin and 2 others have been here" from `visits`.
- `dvBase` comes from the `config` collection (key `dvBase`), with a hard-coded default. The tunnel URL can change on
  restart; you fix it on `/admin` in 10 seconds, without a redeploy.

### 5.8 Invites

On `/m/:id`, signed-in users click "Invite a friend", type a name, and get a link `https://<app>.app.space/i/<code>`
(plus a QR). The invite page shows the room and a big "Step inside" button that opens
`{dvBase}/view?scene=<id>&name=<inviteeName>`. When the viewer supports `?name=` (Ojasva, optional), the friend shows
up on the map as a grey "web" dot with their name: the invite visibly works on screen.

### 5.9 Build order and checkpoints

| Step | Do | You should now see |
| --- | --- | --- |
| B1 | `npm create deepspace@latest dejaview-live`, `cd dejaview-live`, `npx deepspace dev start` | the starter at `http://localhost:5173`; sign-in with Google works |
| B2 | first deploy right away: `git add -A && git commit -m init && npx deepspace deploy` | `https://dejaview-live.app.space` is live (deploys refuse uncommitted changes) |
| B3 | theme (5.11), landing page, `/gallery` from mock JSON (copy the shape in 4.4) | dark grid of cards with lime accents |
| B4 | gallery from Ojasva's server, then `/ws` live updates; once the public link exists, the same from the deployed app | a scene created by curl pops in as "Building", then flips to "Ready" with its thumbnail; note whether `wss://` works through the tunnel |
| B5 | schemas + `/api/ingest` + secret; curl it (5.12) | 200 `{ ok: true }`; 401 with a wrong key; the `live` row in the browser via a quick `useQuery` dump |
| B6 | fake feed script (5.12) + canvas map with interpolation and trails on `/m/:id` | three dots gliding at 60 fps, no stutter, with names, cone and trails |
| B7 | notes (5.6) against Ojasva's `POST /api/notes` (Sat 2 PM; before that, against a 10-line fake that answers 201) | click, type, Enter: the sticky appears on two open maps at once; Ojasva's server log shows the note |
| B8 | top-down floor plan, `/live` auto-follow, stale state, join/leave fades, watching-now avatars | start and stop fake people: they fade in and out; the screen follows the busiest room; the stove is visible |
| B9 | favourites, comments, visits, invites, `/admin` config | all work signed in; signed-out visitors can see but not write |
| B10 | deploy; give Ojasva the URL and key | his real pushes move dots on the deployed app; a note reaches the headset |
| B11 | stretch: cron cleanup, tag flash, labels on the map, "text a memory" QR (5.10) | only after B1 to B10 are rock solid |

### 5.10 Stretch: "text a memory" QR (Photon + DeepSpace together)

Lets a judge use **their own phone** in 20 seconds (cloud line only). On the laptop, a small form (signed in as you):
judge's name and phone. A **server action** `joinTextLine` calls Photon's management API (**Verified**, Spectrum API
OpenAPI at `https://spectrum.photon.codes/openapi/json`):

```
POST https://spectrum.photon.codes/projects/<PHOTON_PROJECT_ID>/users/
Authorization: Basic base64(<projectId>:<projectSecret>)
Content-Type: application/json

{ "type": "shared", "phoneNumber": "+13525550123", "firstName": "Judge" }
```

→ `{ "succeed": true, "data": { "id": "<uuid>", "assignedPhoneNumber": "+1...", ... } }`. Show a QR for
`https://spectrum.photon.codes/users/<id>/redirect?msg=Hi%20Deja%20View`. That link redirects to an `sms:` deep link
that opens Messages to their assigned line with the text pre-filled; they hit send, then attach a photo. Store the
Photon ID and secret with `deepspace secrets set`, never return the phone number, never save it in a collection,
and delete test users afterwards (the free plan holds about 10). In the skit the judge uses the table iPhone instead.

### 5.11 Look

Match the Déjà View site: background `#0b0b0d`, surfaces `#151519`, text `#f3f1ea`, muted `#a3a097`, accent **acid
lime `#C6FF3D`** (the team standard; lime is the only accent), danger `#ff6b5b`. Type: **Bricolage Grotesque** (700 to
800 for headings, tight tracking) and **JetBrains Mono** for numbers and labels, both from Google Fonts. Big bold
headings, generous spacing, 12 to 16 px radii, no gradients except the soft vignette on the map. Set `data-theme` in
`index.html` to a dark preset and override its CSS variables in `src/themes.css`. The table laptop shows `/live` full
screen: the room name huge in the top-left, a pulsing "LIVE" chip, a people count, and nothing else.

### 5.12 Test alone first

```bash
# One push (replace KEY)
curl -s -X POST http://localhost:5173/api/ingest \
  -H 'Content-Type: application/json' -H "X-DejaView-Key: $KEY" \
  -d '{"sceneId":"sample-painted-bedroom","t":'"$(date +%s)"',"people":[{"id":"quest-1","name":"Judge","kind":"vr","x":0.4,"y":0,"z":-1.2,"yaw":0.3}]}'

# Wrong key must be 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5173/api/ingest -H 'X-DejaView-Key: nope' -d '{}'

# Notes reach Déjà View (from Sat 2 PM)
curl -s -X POST http://10.x.x.x:8788/api/notes/sample-painted-bedroom -H 'Content-Type: application/json' \
  -d '{"id":"note-curl0001","x":0.5,"z":-1,"text":"curl note","author":"Seb"}'
```

Write `scripts/fake-feed.ts` (Bun, about 30 lines): every 250 ms, POST a snapshot for one scene with a VR person
walking a slow circle (radius 1.5 m, turning to face where they walk: `yaw = atan2(-vx, -vz)`), two Roblox people
running faster figure-eights, and a web person who joins after 20 s and leaves after 40 s. Add ±60 ms of random delay
to every send to imitate real network jitter, and once a minute pause for 3 s to test the stale state. Point it at
local or deployed with an env var. This feed is your rehearsal tool, and a demo fallback only if you say on stage that
it is a replay.

---

## 6. What Ojasva provides, and when

| What | Exact shape | By |
| --- | --- | --- |
| LAN address of the Déjà View server | `http://10.x.x.x:8788` (same Wi-Fi or one hotspot) | tonight, confirmed by Sat 9 AM |
| `DV_KEY` (for the cue endpoint, by DM) | random string | tonight |
| Public https link | a Cloudflare tunnel URL serving `/api/*`, `/data/*`, `/view`, `/ws` (wss). Not ngrok's free tier: 20,000 requests a month is far too few | Sat 12 PM, no later than 4 PM |
| The three pre-built demo scene ids (cooking night first) | strings, for `demo.json` | the cooking memory by Sat 8 PM; a sample id to test with right away |
| Presence push to your app | `POST <DS_URL>/api/ingest` as in 5.4, with your key | first test Sat 2 PM against your deployed app; live by Sat 4 PM |
| `POST /api/notes/<sceneId>` | `contracts.md` 5.8 | Sat 2 PM |
| `POST /api/host/cue` | 4.4 | Sat 4 PM |
| `world.topdown` + `world.bounds` on the demo worlds | `contracts.md` 5.3, metres | Sat 4 PM |
| Optional: hotspots on the map | `GET /api/scenes/<id>/hotspots` | Sat 4 PM |
| Optional: viewer `?name=` | the browser viewer reports itself as `kind: "web"` with that name | Sat 10 PM, or skip |
| Optional: tag events | `POST <DS_URL>/api/event` (5.4) | stretch |
| SSH public key for the Vultr box | one line, `ssh-ed25519 AAAA... ojasva` | when he is ready to set the GPU up |

From Shivin: `ROBLOX_PLACE_ID` (the join link format is in 4.1), by Sat 12 PM.

What you give Ojasva:

| What | By |
| --- | --- |
| "Vultr OK" (or the exact error); which Photon plan won the group test (cloud group, Plan B, Plan C); the DeepSpace app name | tonight |
| The DeepSpace URL, the ingest key (in person or DM, never in code or a group chat) | Sat 2 PM |
| `npx deepspace app collaborators add <Ojasva's email>` so he can redeploy in an emergency (this also gives him the secrets) | Sat 4 PM |
| The bot folder (no `.env`) with `demo.json` and a one-line start command; the Photon ID/secret typed in person on the Mac that runs the bot | Sat 10 PM |

---

## 7. The real Vultr box (when Ojasva asks)

1. Ojasva sends his SSH **public** key. Vultr: Account → SSH Keys → Add SSH Key → paste → save.
2. Deploy the same plan as tonight (A40 48 GB, New Jersey, Ubuntu 24.04), tick his SSH key, hostname
   `dejaview-gpu`. Send him the IPv4 address from the server page.
3. He installs the pipeline. Two facts for him: the A40 is compute capability **8.6** (build CUDA extensions with 8.6
   in the arch list), and 48 GB is below the world model's 51 GB no-offload footprint, so it runs with T5 offload
   (about 30 GB).
4. **Destroy it** after the demo on Sunday, or any time it will sit idle for more than a few hours. Stopped still bills.

---

## 8. Quality bar

| Thing | Target |
| --- | --- |
| Demo clip → reply in the chat | under 3 s (demo mode) |
| Bot first reply to a new photo | under 2 s after the photo arrives |
| World ready (warm GPU) | about 10 to 30 s; the bot keeps the person company with one progress text |
| Ready → thumbnail on the phone | under 2 s |
| New memory → card on the laptop | under 1 s (from `/ws`) |
| Presence → dot moving on the laptop | under 500 ms end to end, 60 fps, no teleports, no flicker |
| Note sent → on every map | under 0.5 s; in the headset under 1 s |
| App load | under 2 s on the laptop; skeleton cards, never a blank page or a spinner forever |
| Errors | always a sentence a judge understands, never a stack trace |

One product: the bot's copy, the gallery and the map must feel like the Déjà View site: dark, bold, one lime accent,
the same fonts. Name everything "Déjà View" (the bot calls itself that in `help`).

---

## 9. When something breaks on the night

| Breaks | Do this |
| --- | --- |
| Group delivery on the night | send the clip in the 1:1 thread with the bot (Plan C); the host says "the chat" |
| Photon iMessage (no delivery, no attachments) | Telegram through the same bot (2.5). Last resort: a QR to `{public link}/capture` (Ojasva's upload page) |
| Demo clip not recognised | `!arm cooking` from your phone, send again; or Ojasva loads the memory from his `/host` page |
| A judge's own phone | they take the photo with the table iPhone |
| Déjà View server unreachable from the bot | the bot says so politely; Ojasva opens a pre-generated world |
| GPU slow | bot copy covers it ("Big room."); pre-generated worlds |
| Note does not reach the headset | it still shows on the map; Brianna presses retry on the chip; Ojasva checks the tunnel |
| Ingest pushes stop | the map dims to "No one here right now" (it never freezes on old dots); run `fake-feed.ts` only if you clearly say on stage it is a replay |
| Deployed app broken | `npx deepspace dev start` on the table laptop (sign-in still works); point it at the public link |
| Venue Wi-Fi | phone hotspot for the laptop and Ojasva's Mac |
| Everything | the recorded 10 s clips (milestones) |

---

## 10. Milestones

| When | Done means |
| --- | --- |
| **Tonight** | Vultr: GPU deploy proven and destroyed (or the exact blocker sent to Ojasva). DeepSpace account with referral credits, `auth login` works, app name chosen. Photon: project made, the table iPhone and teammates' phones registered, echo bot gets photo bytes, **group test done and the winning plan reported**. Telegram token saved |
| **Sat 10 AM** | Text a photo → working world link on the LAN (A1 to A6). Demo mode matches the clip with a sample scene id. DeepSpace starter deployed once (B1, B2) |
| **Sat 4 PM** | DeepSpace: sign-in, gallery with live building cards, live map with trails driven by the fake feed **on the deployed app**, notes working end to end into Ojasva's server (B3 to B9). Ojasva's real pushes accepted. Bot cues the headset |
| **Sat 10 PM** | Full skit run twice with a timer: the clip at 0:00 answered by demo mode with the frozen cooking memory, real headset + Roblox dots on `/live`, Brianna's note in the headset, the judge's photo at 2:15; the bot running on the demo Mac (or the Plan B Mac) |
| **Sun 4 AM** | Feature freeze. Record 10 s clips: the clip in the chat and the reply; the gallery card going from building to ready; the live map with three dots and a note appearing |
| **Sun 8 AM** | Submitted (Ojasva). You make sure the DeepSpace features list (5.1) and the live URL are in the Devpost write-up |

---

## 11. Rules and hand-off

- **Write all your own code during the event** (it started Fri 8 PM). Open-source libraries and SDKs are fine and
  must be credited. If you use AI coding tools (the DeepSpace scaffold even ships agent instruction files), you must
  disclose them on Devpost; the rules require it.
- **Keys never in code, commits, screenshots or group chats.** Bot: `.env` (gitignored) plus a `.env.example` with names
  only. DeepSpace: `npx deepspace secrets set`. Hand keys over in person.
- Hand-off to Ojasva: `bot/` (no `.env`, with `README.md`: requirements, `bun install`, `bun run src/index.ts`, the env
  names) and the DeepSpace project folder (no `.dev.vars`). He puts them in the repo under `integrations/bot/` and
  `integrations/deepspace/`.
- For the DeepSpace judges (put this in the Devpost text): the live URL, "sign in with Google to leave a note,
  favourite and invite", and the feature table from 5.1 with where to see each one.

---

## 12. Side quest: Capital One Nessie (optional, only after the Sat 10 PM run passes)

`plan.md`: Nessie is a bonus, not a link in the chain. You decide what to build. Nothing else may depend on it. If it
is ready and good, it gets 15 seconds at 2:40. Cap it at 3 hours.

**Prize (Verified, Devpost):** "Capital One - The Best Use of Nessie!", $1,000 cash, 1 winner. They want projects that
"creatively integrate Nessie's endpoints to empower users and improve their financial lives".

**One idea that fits the product (take it or replace it):** a "Can we afford this place?" card on `/m/:id`. It takes
the live head count from the `live` row (VR + Roblox people in the room right now) and mock bank data from Nessie, and
shows the rent split per person with an honest verdict: "4 people in this room: 463 dollars each. Easy." The head count
changes live as Roblox friends join, which is the joke. Call Nessie from a **server action** with the key in
`deepspace secrets` (never in the browser), and cache the bank data for 60 s.

Nessie facts, **Verified** live on Oct 16:
- The site moved to **https://nessieisreal.com**. Sign-in is **GitHub only**; your API key is on the **Profile** page.
  Smoke test (prints `[]` for a fresh key): `curl -s "https://api.nessieisreal.com/customers?key=$NESSIE_API_KEY"`.
- **Use `https://`.** `http://api.nessieisreal.com` refuses connections (port 80 is closed), and most old tutorials
  use `http://`. `https://api.nessieisreal.com` and `https://prod-api.nessieisreal.com` answer in about 0.13 s.
- The key goes in the query string (`?key=...`); there is no auth header. Never log the URL.
- Endpoints: `POST/GET /customers`; `POST/GET /customers/{id}/accounts` (type `Checking`, `Savings` or `Credit Card`,
  `nickname`, `rewards`, `balance` as integers); `POST/GET /merchants` (`name`, `category`, `address`, `geocode`);
  `POST/GET /accounts/{id}/deposits` (`medium: "balance"`, `transaction_date`, `status`, integer `amount`,
  `description`); `POST/GET /accounts/{id}/bills` (`status: "recurring"`, `payee`, `payment_amount`,
  `recurring_date`); `POST/GET /accounts/{id}/purchases` (`merchant_id`, `medium`, integer `amount`). Spec:
  https://nessieisreal.com/nessie-openapi-spec.yaml.
- Gotchas: the purchases endpoints work but are **missing from the spec** (get-one is singular: `GET /purchase/{id}`).
  POST answers are short strings like `"Customer created"`, possibly without the new `_id`, so **list again and find
  your object by name**. `403 {"message":"Missing Authentication Token"}` means a wrong path, `401 Invalid API key.`
  means a bad key. Rate limits are not documented: wait 100 ms between seeding calls.
- Seed once with a script (reuse objects found by name so it can run twice): one customer, a paycheck of 1200 twice
  (income 2400), about 55 small purchases across food delivery 410, groceries 210, rides 140, coffee 95, shopping
  180, fun 120, gas 80, and 4 recurring bills totalling 275 (spending 1510). Save everything to
  `nessie-snapshot.json` as the offline fallback.
- The math, in code, never by a model: `perPerson = ceil(rent / people)`, `share = perPerson / income`,
  `left = income - spending - perPerson`; **easy** if share ≤ 0.30 and left ≥ 15% of income, **tight** if share ≤ 0.40
  and left ≥ 0, otherwise **nope**. With the seed and a 1,850 rent: 1 or 2 people nope, 3 tight, 4 easy.
