# Memory Keys

A memory is someone's house. Memory Keys lets the person it belongs to keep it private, and lets other people knock to come in. It uses Auth0 sign-in, so it is off when the three `AUTH0_*` values are unset.

## Who is who

- **Owner.** The person who claimed the memory. They can make it private or public, let people in, and take people off the list.
- **Guest.** Someone the owner let in. They walk the memory like family, and the guide talks to them like family.
- **Visitor.** Anyone else. On a private memory they see a closed door and can knock. Public memories (the default) are open to everyone.

The server decides who is asking. The page can't say "I'm family"; the guide is told `viewer.access` by the server, from the signed-in token or the memory pass.

## What the guide says

For family (the owner and guests), the guide talks about the people and stories in the memory as it always has. For a visitor, it keeps to the place and the objects: no names, no family stories, no private notes. The opening greeting is cached separately for each kind of listener, so a visitor never gets family's greeting from the cache.

## The flow

1. The owner claims the memory on `/capture` (the panel under the capture grid). Claiming works from the host laptop, or for an email in `MEMORY_KEYS_ADMINS`.
2. The owner turns on **Private**.
3. A visitor opens `/view?scene=<id>`, sees the door, signs in, and taps **Ask to walk in**.
4. The knock shows up in the owner's panel. **Let in** adds them as a guest; **Not now** turns them away.
5. The visitor's door opens on its own. The server gives them a memory pass (an HttpOnly cookie, good for 12 hours), so the viewer can load the world files.

If the owner takes a guest off the list, their pass stops working right away, because the pass is checked against the list each time.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/memory/:id` | anyone | Owner, private or not, and your role |
| `PUT /api/memory/:id` `{private}` | owner | Make it private or public |
| `POST /api/memory/:id/claim` | host laptop or admin | Claim an unowned memory |
| `POST /api/memory/:id/knock` | signed in | Ask to come in |
| `POST /api/memory/:id/knocks/:kid` `{allow}` | owner | Let in or turn away |
| `POST /api/memory/:id/guests/remove` `{sub}` | owner | Take a guest off the list |
| `POST /api/memory/:id/pass` | owner or guest | Get the memory pass cookie |
| `GET /api/memory` | signed in | Your memories and their knocks |

While a memory is private, `/data/scenes/<id>/*` answers 403 unless the request has a valid pass or an owner or guest token.

Owners, guests and knocks are kept in `data/memory-keys/<id>.json`.

## Settings

- `MEMORY_KEYS_SECRET` signs the passes. Set it on the server so passes survive a restart.
- `MEMORY_KEYS_ADMINS` is a comma-separated list of emails that may claim any unowned memory.
- The Auth0 app needs `/view` in its Allowed Callback URLs and Allowed Logout URLs, since the door signs in from the viewer.

## Demo

1. On the host laptop, open `/capture`, sign in, claim `old-house-kitchen`, and turn on Private.
2. On a judge's phone, open `/view?scene=old-house-kitchen`. The door is closed. Sign in and knock.
3. On the laptop, tap **Let in**. The phone's door opens.
4. Ask the guide about the kitchen from both devices: the owner hears the family stories, and a visitor (before being let in, on a public memory) hears only about the room.

## Limits

- Only the viewer and its world files are gated. Roblox, the tab and other routes don't check Memory Keys yet.
- With no `MEMORY_KEYS_SECRET`, passes end when the server restarts; guests just tap through the door again.
