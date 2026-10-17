# Ojas: recover the missing `the-courts` scene

Owner: Ojas.
Status: urgent. The Roblox court is playable only from a baked place file. The real scene
data is missing from this machine and from the local server.

## What is broken

- `data/scenes/the-courts` does not exist locally.
- `GET /api/roblox/the-courts/model` on the local server returns 404.
- The test place `119735023233195` currently runs version 19, which is the baked
  `roblox/DejaView-pingpong-v4.rbxlx`. The room and ping pong work, but the room is
  baked, not loaded from the scene pipeline.
- `roblox/src/server/DejaView/Config.luau` still has
  `BASE_FALLBACK = "https://prozac-covered-burke-oklahoma.trycloudflare.com"`, the dead
  old tunnel. `DEFAULT_SCENE = "the-courts"`.
- The DeepSpace gallery is empty because its feed URL was changed to the new quick
  tunnel and the quick tunnel is unreliable. The admin page is `/admin`; the fields are
  `baseUrl` and `robloxPlaceId`.

## What is not broken

- The baked court place contains the room, the ping pong table, and the game code. It is
  enough to play.
- The local kitchen scene is complete: `data/scenes/kitchen` with `world.spz`, views,
  masks, and objects. The object-layer work continues there.
- The admin page is signed in as the captain. `robloxPlaceId` is `106038900865360`.
- The test place is `119735023233195`; the team production place is `106038900865360`.
  Never publish or rename the team place.

## HPG: likely home of the scene

The HPG root is:

```
/blue/phz3152/sbernalota/thirdwheel
```

The reconstruction jobs are under:

```
/blue/phz3152/sbernalota/thirdwheel/jobs
/blue/phz3152/sbernalota/thirdwheel/data
```

The SSH config uses `User sbernalorta`, but the HPG root uses `sbernalota`. Confirm the
correct UF username before the login. The captain's WSL DNS is broken; use the Windows
SSH client or fix WSL DNS first:

```sh
sudo sh -c 'printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" > /etc/resolv.conf'
```

Search on HPG:

```sh
find /blue/phz3152/sbernalota/thirdwheel -maxdepth 5 \
  \( -iname '*the-courts*' -o -iname '*courts*' -o -name 'world.spz' \) 2>/dev/null
```

Look for the scene directory with:

- `scene.json`
- `world.spz`
- `roblox.glb`
- `roblox-model.json`
- `objects.json` if it exists
- `thumb.jpg` and `collider.glb`

The scene may be under a job output, a FlashWorld/AnySplat run, or a copied data
directory. If the video or photos still exist, the scene can be rebuilt, but recover the
built scene first.

## Task

1. Find the `the-courts` scene on HPG.
2. Copy it back to `data/scenes/the-courts/` on the Deja View machine. Keep the same
   files and the same room frame.
3. Do not delete or overwrite the existing `data/scenes/kitchen`, the sample scenes, or
   the baked place.
4. Restart the local Deja View server and verify:
   - `GET /api/scenes` includes `the-courts`
   - `GET /api/roblox/the-courts/model` returns 200
   - `GET /api/roblox/the-courts/objects` returns the object layer if one exists
5. Point the test place's live base at the working public feed. The code fallback in
   `Config.luau` is dead; use the `dejaview_base` Experience Config or update the
   fallback and republish.
6. Fix the gallery feed. Use a stable public URL, not a quick tunnel. The admin page
   `/admin` must show a reachable `baseUrl`, and the gallery must list the scenes again.
7. Confirm the gallery's "Join in Roblox" link uses `robloxPlaceId` and
   `launchData=<sceneId>`.
8. Report the exact HPG path of the recovered scene, the local path, the file sizes, and
   the verification output.

## Acceptance

- The `the-courts` scene is back on disk with the full reconstruction files.
- The local server serves the court model and lists the scene.
- The test place can load the court from the server, not only from the baked place.
- The gallery lists scenes and the Join link works.
- The baked version 19 remains as a fallback.
- No team-place publish, no scene deletion, no secret in chat.

## Guardrails

- Never publish or rename `106038900865360`.
- Never delete `data/scenes` or the baked `.rbxlx` files.
- Never paste API keys, passwords, or Duo codes in chat.
- Do not change the object-layer approvals or upload anything to Roblox.
- If the HPG scene is gone, report that plainly and fall back to the original capture.
  Do not invent a replacement scene.
