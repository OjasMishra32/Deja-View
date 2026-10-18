// Memory Keys: private memories with an owner, guests and a knock on the door, on top of Auth0 sign-in.
//
// A memory (a scene) is public unless its owner makes it private. A private memory opens only for its owner and the
// guests they let in; everyone else sees its name and can knock. The owner sees the knock on their phone and allows
// or declines it; an allowed knock makes the visitor a guest. Who is asking also shapes what the Gemini guide says:
// in a private memory, the family (owner and guests) hears who is who and how the moment ended, a visitor only the
// place itself (server/integrations/guide.ts `viewer`, integrations/guide/notes.mjs).
//
// Storage: data/memory-keys/<sceneId>.json beside data/scenes/ (never inside a scene folder, which is served as
// files). No file means public and unowned, so every existing world stays as it is.
//
// The world's files (/data/scenes/<id>/...) are plain URLs the viewer and the headset fetch without headers, so a
// member gets a memory pass: an HttpOnly cookie, HMAC-signed by this server, naming the scene, the person and an
// expiry. Requests with a valid pass, or a bearer token of a member, get the files; others get 403.
//
// Routes (JSON):
//   GET    /api/memory/:id                    what this person may do: {visibility, role, owner, knock?, guests?, knocks?}
//   PUT    /api/memory/:id         {private}  owner: make the memory private or public
//   POST   /api/memory/:id/claim             the first owner: a signed-in person on this machine, or an admin
//                                             (MEMORY_KEYS_ADMINS, comma-separated emails), of an unowned memory
//   POST   /api/memory/:id/knock             a signed-in visitor asks to walk in (one open knock each)
//   POST   /api/memory/:id/knocks/:kid {allow}  owner: allow (the visitor becomes a guest) or decline
//   POST   /api/memory/:id/guests/remove {sub}  owner: a guest loses access
//   POST   /api/memory/:id/pass              a member (or anyone, for a public memory): sets the memory pass cookie
//   GET    /api/memory                       the signed-in person's own memories, with open knocks (the owner's panel)

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Auth0User, Auth0Verifier } from './auth0.ts';

export type Visibility = 'public' | 'private';
export type Role = 'owner' | 'guest' | 'visitor' | 'anonymous';

export interface Person {
  sub: string;
  name?: string;
  email?: string;
}

export interface Guest extends Person {
  addedAt: string;
}

export interface Knock extends Person {
  id: string;
  at: string;
  status: 'pending' | 'allowed' | 'declined';
  decidedAt?: string;
}

export interface MemoryAccess {
  visibility: Visibility;
  owner?: Person;
  guests: Guest[];
  knocks: Knock[];
  updatedAt?: string;
}

export interface MemoryKeysOptions {
  /** data/scenes/<id> for an id (SceneStore.sceneDir): the keys live in data/memory-keys/ next to data/scenes/. */
  sceneDir: (id: string) => string;
  /** Whether a scene exists (SceneStore.get). */
  sceneExists: (id: string) => Promise<boolean>;
  verifier: Auth0Verifier | null;
  /** HMAC key for memory passes. Default: MEMORY_KEYS_SECRET, else random per process (passes end on restart). */
  secret?: string;
  /** Emails allowed to claim any unowned memory. Default: MEMORY_KEYS_ADMINS. */
  admins?: string[];
  /** How long a memory pass lasts, seconds. Default 12 hours. */
  passSeconds?: number;
  now?: () => number;
}

export interface RequestFacts {
  /** The request comes from this machine (the host laptop, scripts, tests). */
  local: boolean;
  /** The API token or DV_KEY let it through already. */
  trusted?: boolean;
}

export interface MemoryKeys {
  read(id: string): Promise<MemoryAccess>;
  /** The person's role in a memory, and the memory's visibility. */
  roleOf(id: string, user: Auth0User | null): Promise<{ role: Role; visibility: Visibility }>;
  /** Whether this request may have the memory's world and files (members, a valid pass, local or trusted callers). */
  mayEnter(req: Request, id: string, facts: RequestFacts): Promise<boolean>;
  /** What the guide may tell this request about the memory: 'family' (everything), 'visitor' (the place only), or
   *  undefined for a public memory. */
  guideAccess(req: Request, id: string, facts: RequestFacts): Promise<'family' | 'visitor' | undefined>;
  /** /data/scenes/<id>/... of a private memory without the right to enter: the 403 to return, else null. */
  gate(req: Request, facts: RequestFacts): Promise<Response | null>;
  /** The /api/memory routes: a Response, or null for other paths. */
  handle(req: Request, facts: RequestFacts): Promise<Response | null>;
  passCookieName(id: string): string;
}

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const MAX_GUESTS = 64;
const MAX_KNOCKS = 64;

function reply(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function emptyAccess(): MemoryAccess {
  return { visibility: 'public', guests: [], knocks: [] };
}

function person(u: Auth0User): Person {
  const p: Person = { sub: u.sub };
  if (u.name) p.name = u.name.slice(0, 80);
  if (u.email) p.email = u.email.slice(0, 120);
  return p;
}

function shownName(p: Person | undefined): string | undefined {
  return p ? p.name || (p.email ? p.email.split('@')[0] : undefined) || 'Someone' : undefined;
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function createMemoryKeys(opts: MemoryKeysOptions): MemoryKeys {
  const now = opts.now ?? (() => Date.now());
  const secret = opts.secret || process.env.MEMORY_KEYS_SECRET || randomBytes(32).toString('hex');
  const admins = (opts.admins ?? (process.env.MEMORY_KEYS_ADMINS ?? '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const passSeconds = opts.passSeconds ?? 12 * 3600;
  const locks = new Map<string, Promise<unknown>>();

  function file(id: string): string {
    return join(dirname(dirname(opts.sceneDir(id))), 'memory-keys', `${id}.json`);
  }

  async function read(id: string): Promise<MemoryAccess> {
    if (!SCENE_ID.test(id)) return emptyAccess();
    try {
      const d = JSON.parse(await readFile(file(id), 'utf8')) as Partial<MemoryAccess>;
      return {
        visibility: d.visibility === 'private' ? 'private' : 'public',
        owner: d.owner && typeof d.owner.sub === 'string' ? d.owner : undefined,
        guests: Array.isArray(d.guests) ? d.guests.filter((g) => g && typeof g.sub === 'string') : [],
        knocks: Array.isArray(d.knocks) ? d.knocks.filter((k) => k && typeof k.id === 'string') : [],
        updatedAt: d.updatedAt,
      };
    } catch {
      return emptyAccess();
    }
  }

  /** Read-modify-write of one memory's keys, one at a time per memory. */
  function update<T>(id: string, fn: (a: MemoryAccess) => T | Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const a = await read(id);
      const out = await fn(a);
      a.updatedAt = new Date(now()).toISOString();
      const f = file(id);
      await mkdir(dirname(f), { recursive: true });
      const tmp = `${f}.tmp-${randomUUID().slice(0, 8)}`;
      await writeFile(tmp, JSON.stringify(a, null, 1));
      await rename(tmp, f);
      return out;
    });
    locks.set(id, run.catch(() => undefined));
    return run;
  }

  function roleIn(a: MemoryAccess, user: Auth0User | null): Role {
    if (!user) return 'anonymous';
    if (a.owner?.sub === user.sub) return 'owner';
    if (a.guests.some((g) => g.sub === user.sub)) return 'guest';
    return 'visitor';
  }

  async function userOf(req: Request): Promise<Auth0User | null> {
    if (!opts.verifier) return null;
    const r = await opts.verifier.fromRequest(req);
    return r?.ok ? r.user : null;
  }

  // --- memory passes ------------------------------------------------------------------------------------------------

  const passCookieName = (id: string) => `dv_pass_${id.replace(/[^a-z0-9]/g, '_')}`;

  function sign(payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function makePass(id: string, sub: string): string {
    const exp = Math.floor(now() / 1000) + passSeconds;
    const payload = `${id}.${Buffer.from(sub).toString('base64url')}.${exp}`;
    return `${payload}.${sign(payload)}`;
  }

  /** The person a valid pass for `id` names, or null. */
  function readPass(req: Request, id: string): string | null {
    const v = cookieValue(req, passCookieName(id));
    if (!v) return null;
    const parts = v.split('.');
    if (parts.length !== 4) return null;
    const [pid, sub64, exp, sig] = parts as [string, string, string, string];
    if (pid !== id || !/^\d+$/.test(exp) || Number(exp) * 1000 < now()) return null;
    const want = Buffer.from(sign(`${pid}.${sub64}.${exp}`));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return Buffer.from(sub64, 'base64url').toString();
  }

  // --- checks -------------------------------------------------------------------------------------------------------

  async function roleOf(id: string, user: Auth0User | null) {
    const a = await read(id);
    return { role: roleIn(a, user), visibility: a.visibility };
  }

  async function mayEnter(req: Request, id: string, facts: RequestFacts): Promise<boolean> {
    const a = await read(id);
    if (a.visibility === 'public' || facts.local || facts.trusted) return true;
    const passSub = readPass(req, id);
    // a pass stays good only while its person is still a member (a removed guest loses the world at once)
    if (passSub && (a.owner?.sub === passSub || a.guests.some((g) => g.sub === passSub))) return true;
    const role = roleIn(a, await userOf(req));
    return role === 'owner' || role === 'guest';
  }

  async function guideAccess(req: Request, id: string, facts: RequestFacts): Promise<'family' | 'visitor' | undefined> {
    const a = await read(id);
    if (a.visibility === 'public') return undefined;
    return (await mayEnter(req, id, facts)) ? 'family' : 'visitor';
  }

  async function gate(req: Request, facts: RequestFacts): Promise<Response | null> {
    const m = /^\/data\/scenes\/([^/]+)\//.exec(new URL(req.url).pathname);
    if (!m) return null;
    const id = decodeURIComponent(m[1]!);
    if (!SCENE_ID.test(id) || (await mayEnter(req, id, facts))) return null;
    return reply(403, { error: 'This memory is private. Knock to walk in.', private: true, scene: id });
  }

  // --- routes -------------------------------------------------------------------------------------------------------

  async function describe(id: string, user: Auth0User | null): Promise<Record<string, unknown>> {
    const a = await read(id);
    const role = roleIn(a, user);
    const out: Record<string, unknown> = { scene: id, visibility: a.visibility, role, owner: shownName(a.owner) ?? null };
    if (role === 'owner') {
      out.guests = a.guests.map((g) => ({ sub: g.sub, name: shownName(g), email: g.email, addedAt: g.addedAt }));
      out.knocks = a.knocks.filter((k) => k.status === 'pending').map((k) => ({ id: k.id, name: shownName(k), email: k.email, at: k.at }));
    } else if (user) {
      const mine = [...a.knocks].reverse().find((k) => k.sub === user.sub);
      if (mine) out.knock = { id: mine.id, status: mine.status, at: mine.at };
    }
    return out;
  }

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      const text = await req.text();
      if (text.length > 4096) return {};
      const v = text.trim() ? JSON.parse(text) : {};
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async function handle(req: Request, facts: RequestFacts): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '/api/memory' && !path.startsWith('/api/memory/')) return null;
    if (!opts.verifier) return reply(404, { error: 'Sign-in is off on this server, so every memory is public.' });
    const user = await userOf(req);
    const method = req.method;

    if (path === '/api/memory') {
      if (method !== 'GET') return reply(405, { error: 'Method not allowed.' });
      if (!user) return reply(401, { error: 'Sign in to see your memories.', signIn: true });
      const dir = join(dirname(dirname(opts.sceneDir('x'))), 'memory-keys');
      let ids: string[] = [];
      try {
        ids = (await (await import('node:fs/promises')).readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
      } catch {
        ids = [];
      }
      const mine = [];
      for (const id of ids) {
        const a = await read(id);
        if (a.owner?.sub === user.sub) mine.push(await describe(id, user));
      }
      return reply(200, { memories: mine });
    }

    const m = /^\/api\/memory\/([^/]+)(?:\/(claim|knock|pass|knocks\/([^/]+)|guests\/remove))?$/.exec(path);
    if (!m) return reply(404, { error: 'Not found.' });
    const id = decodeURIComponent(m[1]!);
    if (!SCENE_ID.test(id) || !(await opts.sceneExists(id))) return reply(404, { error: 'No such memory.' });
    const action = m[2];

    if (!action) {
      if (method === 'GET') return reply(200, await describe(id, user));
      if (method !== 'PUT') return reply(405, { error: 'Method not allowed.' });
      if (!user) return reply(401, { error: 'Sign in first.', signIn: true });
      const want = (await body(req)).private === true ? 'private' : 'public';
      const ok = await update(id, (a) => {
        if (a.owner?.sub !== user.sub) return false;
        a.visibility = want;
        return true;
      });
      return ok ? reply(200, await describe(id, user)) : reply(403, { error: 'Only the owner can change who may walk in.' });
    }

    if (method !== 'POST') return reply(405, { error: 'Method not allowed.' });

    if (action === 'pass') {
      if (!(await mayEnter(req, id, facts))) return reply(403, { error: 'This memory is private. Knock to walk in.', private: true });
      const sub = user?.sub ?? (facts.local ? 'local' : 'public');
      const cookie = `${passCookieName(id)}=${encodeURIComponent(makePass(id, sub))}; Path=/; Max-Age=${passSeconds}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
      return reply(200, { ok: true, expiresIn: passSeconds }, { 'Set-Cookie': cookie });
    }

    if (!user) return reply(401, { error: 'Sign in first.', signIn: true });

    if (action === 'claim') {
      const admin = !!user.email && admins.includes(user.email.toLowerCase());
      if (!facts.local && !facts.trusted && !admin) return reply(403, { error: 'Only the host can hand out a memory.' });
      const ok = await update(id, (a) => {
        if (a.owner && a.owner.sub !== user.sub) return false;
        a.owner = person(user);
        return true;
      });
      return ok ? reply(200, await describe(id, user)) : reply(409, { error: 'This memory already has an owner.' });
    }

    if (action === 'knock') {
      const r = await update(id, (a) => {
        const role = roleIn(a, user);
        if (role === 'owner' || role === 'guest') return { already: true };
        if (a.visibility === 'public') return { public: true };
        const open = a.knocks.find((k) => k.sub === user.sub && k.status === 'pending');
        if (open) return { knock: open };
        const k: Knock = { id: randomUUID().slice(0, 12), ...person(user), at: new Date(now()).toISOString(), status: 'pending' };
        a.knocks = [...a.knocks, k].slice(-MAX_KNOCKS);
        return { knock: k };
      });
      if ('already' in r) return reply(200, { ok: true, role: 'guest' });
      if ('public' in r) return reply(200, { ok: true, public: true });
      return reply(201, { ok: true, knock: { id: r.knock.id, status: r.knock.status, at: r.knock.at } });
    }

    if (action.startsWith('knocks/')) {
      const kid = decodeURIComponent(m[3]!);
      const allow = (await body(req)).allow === true;
      const r = await update(id, (a) => {
        if (a.owner?.sub !== user.sub) return 'forbidden' as const;
        const k = a.knocks.find((x) => x.id === kid);
        if (!k) return 'missing' as const;
        if (k.status !== 'pending') return 'done' as const;
        k.status = allow ? 'allowed' : 'declined';
        k.decidedAt = new Date(now()).toISOString();
        if (allow && !a.guests.some((g) => g.sub === k.sub)) {
          const g: Guest = { sub: k.sub, addedAt: k.decidedAt };
          if (k.name) g.name = k.name;
          if (k.email) g.email = k.email;
          a.guests = [...a.guests, g].slice(-MAX_GUESTS);
        }
        return 'ok' as const;
      });
      if (r === 'forbidden') return reply(403, { error: 'Only the owner can answer a knock.' });
      if (r === 'missing') return reply(404, { error: 'No such knock.' });
      if (r === 'done') return reply(409, { error: 'That knock was already answered.' });
      return reply(200, await describe(id, user));
    }

    // guests/remove
    const sub = (await body(req)).sub;
    if (typeof sub !== 'string') return reply(400, { error: 'Say which guest.' });
    const ok = await update(id, (a) => {
      if (a.owner?.sub !== user.sub) return false;
      a.guests = a.guests.filter((g) => g.sub !== sub);
      return true;
    });
    return ok ? reply(200, await describe(id, user)) : reply(403, { error: 'Only the owner can remove a guest.' });
  }

  return { read, roleOf, mayEnter, guideAccess, gate, handle, passCookieName };
}
