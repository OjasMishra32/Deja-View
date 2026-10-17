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
