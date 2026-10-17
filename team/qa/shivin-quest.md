# QA: Shivin

Checklist: `team/SHIVIN-README.md` sections 1 and 2. Site: `https://deja-view.photo`.

## Checked from the laptop (Sat evening)

Done in a desktop browser plus a 375 px phone-size view, against the live site. These checks don't need a headset.

| Check | Result |
|---|---|
| Landing page: every world tile | **Pass.** 21 tiles link to 9 worlds, and every one opens: `scene.json` 200, status `ready`, splat file 200, `people.mp4` 200 for the three memories |
| Landing page at phone width (375 px) | **Pass.** No sideways scroll on the page; the world cards scroll inside their own carousel. "What it's for" reads well (19 px body text) |
| Worlds without a collider | `brick-apartment` and `old-house-kitchen` have no `world.collider` (walking uses the splat collider). The README says old-house is being rebuilt tonight; brick-apartment is worth a look on the Quest (walls) |
| Voice guide | **Fail.** `POST /api/guide/narrate` answers **502** every time the kitchen viewer asks, so the guide stays silent. For Ojasva and Brianna (Brianna Update 7: turn the Gemini guide on) |
| Load time, laptop | When the window was in front: kitchen about 16 s to walkable ("Building the collider" is the long step), old house about 8 s. Both under 20 s |

Not measured from the laptop: frame rate and walking feel. The browser pane was in the background, which throttles
rendering, so those numbers would be wrong. They're in the sections below.

## Quest 3S

| id | Loads < 20 s, spawn | Walk, turn, teleport, walls | 72 fps | Video: play, pause, seek, sync, walk round | Reality check | Notes |
|---|---|---|---|---|---|---|
| `the-courts` | | | | n/a | | walk to both tables |
| `chess-room` | | | | n/a | | board flat, real size |
| `kitchen` | | | | n/a | | whole strip, not through counters |
| `old-house-kitchen` | | | | n/a | | being rebuilt; note how it looks |
| `tilted-towers` | | | | n/a | | generated parts behind you |
| `brick-apartment` | | | | n/a | | spawn faces into the room; no collider |
| `courts-foosball` | | | | | | players in time with the sound |
| `kitchen-cooking` | | | | | | fridge doors, milk jug in his hand (13-36 s) |
| `chess-match` | | | | | | both players on the board, feet on the floor |

## Phone (Safari, iPhone)

- Landing page:
- Two worlds and one memory, touch walking:

## Laptop (Chrome, window in front)

- Two worlds and one memory, WASD + mouse, frame rate:
