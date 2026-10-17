# Déjà View in Roblox (Shivin)

Rojo project for the Roblox experience in `team/shivin.md`. All game code is Luau in `src/`.

## Get it into Studio

1. Install Roblox Studio, sign in, do the age check (`team/shivin.md` section 3).
2. Install the Rojo Studio plugin once: `rojo plugin install`.
3. `cd roblox && rojo serve`, then in Studio: open your published "Déjà View" place → Plugins → Rojo → **Connect**.
   (Or build a fresh place file: `rojo build -o DejaView.rbxlx` and open it.)
4. Experience Settings → Security → **Allow HTTP Requests: ON**. Rojo does NOT apply this for you; in an unpublished
   place run `game:GetService("HttpService").HttpEnabled = true` in the command bar.
5. Test: Test tab → **Server & Clients**, 2 clients, Play.

## Layout

| Path | In Studio | What |
| --- | --- | --- |
| `src/server/Main.server.luau` | ServerScriptService.Main | Boot, remotes, host actions |
| `src/server/DejaView/Config` | | Constants, `USE_MOCK`, Experience Configs (`dejaview_base`, `round_seconds`, `use_mock`, `max_parts`) |
| `src/server/DejaView/Api` | | The only HttpService code |
| `src/server/DejaView/MockServer` | | Same interface as Api: fixtures, procedural rooms, fake judge, 50-250 ms latency, 5% failures |
| `src/server/DejaView/Backend` | | Picks Mock or Api per call; event retries |
| `src/server/DejaView/MapBuilder` | | Map → anchored Parts in batches, bounds, baked fallback, spawn placement |
| `src/server/DejaView/Rooms` | | Room list (3 s), prefetch, swatches, votes, JOIN, auto-join, Follow |
| `src/server/DejaView/Presence` | | 4 Hz loop, snapshot buffers, ghost fan-out, banner/backoff |
| `src/server/DejaView/TagGame` | | Rounds, 10 Hz tag checks, lives, scores, events |
| `src/server/DejaView/World` | | Lobby at (0, 300, 0), lobby/room locations, host check |
| `src/server/DejaView/TransportTest` | | Section 9.3 check from the server console |
| `src/shared/*` | ReplicatedStorage.Shared | Theme, Interp, Fixtures, Util |
| `src/client/*` | StarterPlayerScripts | UI, board, ghost renderer, effects |

## Mock timeline (USE_MOCK = true)

- Boot builds the newest ready room (`fixture-room`, `mock-game-night`, stress rooms 6k/12k in the picker).
- 30 s: `mock-finale` turns ready, answers 202 ("Measuring the room...") for 5 s, then prefetches.
- 40 s: the mock judge moves into `mock-finale`; with Follow on, everyone in a room is moved there.
- Host bar (owner, or first player in Studio): Auto-join, Follow, Start/End round, Mock judge, All to lobby.

## Testing the real HTTP path locally

`python3 roblox/dev-server/stub.py` serves the contract's Roblox endpoints on `http://localhost:8788` (a circling fake
judge, a 202 "building" room, request logging). Set `Config.USE_MOCK = false` and press Play: Studio's local server can
reach localhost. Verified: scenes, maps with 202 retries, 4 Hz presence with `state`, round and tag events.

## Going live

- Creator Hub → Configs: `dejaview_base` = tunnel URL (no trailing slash), `round_seconds` = 90 (25 for the skit),
  `use_mock` = false. Publish now.
- Secrets: `dejaview_key` (domain = tunnel host). Studio: Local Secrets with the same name.
- For the skit set `Config.AUTO_JOIN_DEFAULT = false` (or toggle Auto-join off on the host bar).
- Join link: `https://www.roblox.com/games/start?placeId=<PLACE_ID>&launchData=<sceneId>`.

## Transport test (tonight)

```bash
./transport-test/run.sh
```

Copy the printed `https://….trycloudflare.com`, set it as `dejaview_base`, publish, join the live game, then in
the server console: `require(game.ServerScriptService.DejaView.TransportTest)()`.

## Sounds

`Theme.Sounds` uses built-in client sounds as placeholders. Swap in Roblox-made Creator Store audio and credit it on Devpost.
