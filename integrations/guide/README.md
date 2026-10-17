# Déjà View guide

The Gemini guide service for Brianna's four contract endpoints: `/describe`, `/hotspots`, `/narrate`, and `/ask`.

## Start

1. Copy `.env.example` to `.env`, then set `GEMINI_API_KEY` and a random `GUIDE_KEY`.
2. Run `npm install && npm start`.
3. Check `http://127.0.0.1:8795/health` and open `http://127.0.0.1:8795/` for the local test page.

It starts in `MOCK_GEMINI=1` so teammates can integrate without spending API quota. Set it to `0` only when you are ready to use the Gemini API.

Requests are JSON and must include `image` as a base64 data URL. If `GUIDE_KEY` is set, all routes other than `/health` also require `X-Guide-Key`.

## Fixture tools on Windows

The project includes local `jq` and FFmpeg binaries. Use `npm run jq -- --version` and `npm run ffmpeg -- -version`; this avoids a machine-wide installation.

## Video memories

- `/describe` also takes `frames`: up to 8 JPEG data URLs from a clip, in order, next to or instead of `image`, plus an optional `scene` (`{id, name}`). It returns a two-sentence `caption`: who is playing what and who wins or is winning (for cooking, what they are making). A longer list keeps 8 evenly spaced frames. Calls with only `image` work exactly as before.
- `notes/<sceneId>.json` holds a checked summary of each clip (`sceneId, clip, oneLine, activity, people, objects, outcome, moments, funnyDetail, checkedBy, confidence`). `/ask`, `/narrate` and `/describe` with frames add the notes for `scene.id`, and for the place a memory happened in (`courts-foosball` is at `the-courts`, `chess-match` in `chess-room`, `kitchen-cooking` in `kitchen`). Files are read on every call, so a fix counts at once. When Gemini is off or fails, "who won?" and "what are they making?" are answered from `outcome`.
- Make a notes file with `npm run notes -- <sceneId> [clip] [--force]` (clip defaults to `cache/video/<sceneId>.mov`). It uploads the clip with the Files API, waits until it is `ACTIVE`, asks `MODEL_VIDEO` once for JSON, writes the file and deletes the upload. It never replaces an existing notes file without `--force`, so a hand-checked file wins. Read the result and fix it by hand.
- `prompts.mjs` has `WORLD_HINTS`, the things worth labelling in each demo world, which `/hotspots` and `/narrate` add to their prompts.

## Tests

`npm test` runs the `node:test` suites in `test/` against a stubbed Gemini client: no network, no key, and no `npm install` needed (the SDK is only loaded on the first real call). `NOTES_DIR` points the notes at another folder; the tests use a temporary one.

## Gemini features we use and where judges see them

- **Image understanding with JSON output** (`gemini-3.5-flash-lite`, `/describe`): writes the text the world model uses to imagine everything outside a new photo, so it shapes the room you walk around in.
- **Several images in one call** (`/describe` with `frames`): reads a clip's frames in order and says who is playing and who is winning, so "who won?" has an answer inside a video memory once the server sends the frames.
- **Object detection with bounding boxes** (`gemini-3.8-flash`, `box_2d`, `/hotspots`): finds the things worth pointing at; they become the floating labels in each world, steered by per-world hints.
- **Audio understanding** (`/ask`): the headset's recorded question (webm/opus) goes straight to Gemini with the current view, no separate speech-to-text. Hold the button and ask out loud.
- **Text to speech** (`gemini-3.8-flash-lite-tts`, voice Sulafat, `/ask` and `/narrate`): the room answers and greets you out loud.
- **Video understanding through the Files API, with a JSON schema** (`gemini-3.8-flash`, `scripts/video-notes.mjs`): one summary per clip in `notes/`, fed into `/ask` and `/narrate`.

## AI tools used

Gemini through the Google Gen AI SDK (`@google/genai`) in the product.
