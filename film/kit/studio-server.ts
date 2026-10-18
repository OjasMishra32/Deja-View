// A tiny local server for filming Roblox Studio frame by frame.
//   GET /s.lua?name=<script>   the Luau capture script (film/kit/studio/<script>.lua), for the command bar's loadstring
//   GET /shot?take=<t>&i=<n>   capture Studio's window now into film/assets/studio/<t>/<n>.png, then answer "ok"
// The Luau side moves the camera (or reveals parts), waits a couple of frames, then calls /shot, so every frame is
// exactly one step.
//
//   bun film/kit/studio-server.ts <window-id>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const WID = process.argv[2];
if (!WID) {
  console.error('usage: bun film/kit/studio-server.ts <CGWindowID>');
  process.exit(2);
}

Bun.serve({
  port: 8799,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/s.lua') {
      const name = (url.searchParams.get('name') ?? 'test').replace(/[^a-z0-9-]/gi, '');
      return new Response(Bun.file(join(import.meta.dir, 'studio', `${name}.lua`)));
    }
    if (url.pathname === '/shot') {
      const take = (url.searchParams.get('take') ?? 'take').replace(/[^a-z0-9-]/gi, '');
      const i = Number(url.searchParams.get('i') ?? 0);
      const dir = join(ROOT, 'film/assets/studio', take);
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${String(i).padStart(5, '0')}.png`);
      const p = Bun.spawn(['screencapture', '-x', '-o', `-l${WID}`, out]);
      await p.exited;
      return new Response('ok');
    }
    if (url.pathname === '/log') {
      console.log('[studio]', url.searchParams.get('m'));
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`filming window ${WID} on http://127.0.0.1:8799`);
