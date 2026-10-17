# Shivin: how to help tonight

Your three Update 19 jobs (automatic walk zones, listing photos to a home, one command for a video memory) are all on
`main`, reviewed and fixed (`shivin.md` Update 21). This page is what's next. Everything here can be done by hand.
Still no Roblox and no Devpost.

The site is `https://deja-view.photo`. Every world opens at `https://deja-view.photo/view?scene=<id>`.

## Rules

- Work on a branch: `git switch -c shivin/<task>` off an up-to-date `main`, push the branch, tell Ojasva. Never commit
  to `main`.
- Run `git config core.hooksPath .githooks` once. No attribution lines and no timestamps in commit messages.
- Never paste or commit keys. Nothing goes to Roblox. Never delete anything (move it to `data/archive/`).
- Before you push: `bun run test` and `.venv/bin/python -m pytest -q tests/pipeline` both pass.

## 1. Headset QA on the Quest 3S (first, about 45 min)

Open `https://deja-view.photo` in the Quest browser and go into each of these, in the headset (Enter VR):

| id | what it is | check especially |
|---|---|---|
| `the-courts` | Infinity Hall Game Lawn (Photo) | walk to both tables; walls stop you |
| `chess-room` | Giant chess (Photo) | the board is flat and at real size |
| `kitchen` | the kitchen (Photo) | walk the whole strip; you can't walk through counters |
| `old-house-kitchen` | the old house in Pennsylvania (Photo) | being rebuilt tonight; note how it looks now |
| `tilted-towers` | Tilted Towers (Photo) | the generated parts behind you |
| `brick-apartment` | Brick House apartment (Photo) | spawn faces into the room |
| `courts-foosball` | Foosball at the Game Lawn (Video) | the players move in time with the sound |
| `kitchen-cooking` | Sebastian cooking (Video) | the fridge doors open, the milk jug moves with his hand |
| `chess-match` | Giant chess match (Video) | both players stand on the board, feet on the floor |

For each one, check:
- It loads in under 20 s, and you start on the floor facing something worth seeing.
- Walking (left stick), snap turn (right stick) and teleport all work; you never fall through the floor or walk
  through a wall.
- It holds 72 fps (no stutter when you turn your head). Note any spot where it drops.
- Video memories: play, pause and seek; the people stay in sync; walk all the way around them while it plays.
- The reality check toggle tints the imagined parts.
- Anything that looks broken: where you stood and which way you looked.

Write it up in `team/qa/shivin-quest.md` (one section per id, pass or a short note, plus photos from the Quest's
camera if useful) on a branch `shivin/qa`, push it and tell Ojasva.

## 2. Phone and laptop QA (about 20 min)

Same list, no headset: Safari on an iPhone and Chrome on a laptop. Check the landing page (`/`) first: every tile
opens its world, the "What it's for" section reads well on the phone, nothing overflows sideways. Then walk with
touch (phone) and WASD + mouse (laptop) in two worlds and one memory. Add a "Phone" and a "Laptop" section to the
same file.

## 3. Three small code fixes (each about 30 min, with a test)

Found while reviewing your code. One branch each (`shivin/fix-listing-flag`, `shivin/fix-stale-files`,
`shivin/memory-resume`).

1. **`listing` from a form.** `pipeline/run_job.py` line 352: `bool(job.params.get("listing"))` treats the string
   `"false"` as true. Accept `true`, `"true"`, `"1"`, `1` as on and everything else as off. Done when a test in
   `tests/pipeline/test_listing.py` covers `"false"`, `"0"`, `""` and missing.
2. **Old walk zone files after a rebuild.** `server/jobs.ts` line 272: `WORLD_DERIVED` doesn't list `collider.glb`,
   `walkzone.json` and `walkzone-topdown.png`, so rebuilding a scene without a walk zone leaves the old ones in the
   scene folder. Line 663 deletes stale files today (`unlink`); change it to move them into
   `data/archive/scenes/<id>/` instead, since we never delete. Done when a test in `tests/server-jobs.test.ts`
   rebuilds a scene that had a walk zone and the old files are gone from the scene folder and kept in the archive.
3. **Resume a video memory chain.** `pipeline/memory_job.py`: a second `--submit` starts again from the cut and redoes
   about 40 minutes of work. Add `--from <step>` (one of the step names in the plan) that reuses the job folder and
   submits only that step and the ones after it, with the same checks. Done when `tests/pipeline/test_memory_job.py`
   has a test that `--from photofit --dry-run` plans photofit and install only, and refuses when the earlier
   step's outputs are missing.

## 4. Optional: a new place to walk into

If you're near a room worth keeping (your dorm, a study room, a lounge), capture it:
- **Photos:** 30 to 40, walking slowly around the room at chest height, each one overlapping the last by about two
  thirds. Include the corners, the floor and the ceiling edge. No people, nothing private on screens or papers.
- **One clip:** 20 to 30 s, a slow walk through the middle of the room.
- AirDrop them to Ojasva with the room's name. He runs the rebuild on HiPerGator.
- Old listing photos of a home your family lived in work too (4 to 10 photos from the listing), for a second
  "your old home" world. Those never go to Roblox.
