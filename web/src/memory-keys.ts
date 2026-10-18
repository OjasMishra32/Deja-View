// Memory Keys on the pages (server/auth/memory-keys.ts): the door of a private memory in the viewer (sign in, knock,
// wait for the owner, walk in) and the owner's panel on /capture (who may walk in, knocks to answer, guests).

import { authConfig, authHeaders, current, ready, signIn } from './auth.ts';

export interface MemoryInfo {
  scene: string;
  visibility: 'public' | 'private';
  role: 'owner' | 'guest' | 'visitor' | 'anonymous';
  owner: string | null;
  knock?: { id: string; status: 'pending' | 'allowed' | 'declined'; at: string };
  guests?: { sub: string; name: string; email?: string; addedAt: string }[];
  knocks?: { id: string; name: string; email?: string; at: string }[];
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const enc = encodeURIComponent;
export const memory = {
  info: (id: string) => api<MemoryInfo>('GET', `/api/memory/${enc(id)}`),
  pass: (id: string) => api<{ ok: boolean }>('POST', `/api/memory/${enc(id)}/pass`),
  knock: (id: string) => api<{ knock?: MemoryInfo['knock'] }>('POST', `/api/memory/${enc(id)}/knock`),
  setPrivate: (id: string, on: boolean) => api<MemoryInfo>('PUT', `/api/memory/${enc(id)}`, { private: on }),
  answer: (id: string, kid: string, allow: boolean) => api<MemoryInfo>('POST', `/api/memory/${enc(id)}/knocks/${enc(kid)}`, { allow }),
  removeGuest: (id: string, sub: string) => api<MemoryInfo>('POST', `/api/memory/${enc(id)}/guests/remove`, { sub }),
  claim: (id: string) => api<MemoryInfo>('POST', `/api/memory/${enc(id)}/claim`),
  mine: () => api<{ memories: MemoryInfo[] }>('GET', '/api/memory'),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// The door (viewer)

const DOOR_CSS = `
.mk-door{position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:rgba(10,12,18,.72);backdrop-filter:blur(14px);font:15px/1.45 system-ui,-apple-system,sans-serif;color:#f4f5f8}
.mk-card{width:min(420px,calc(100vw - 32px));padding:28px 26px;border-radius:22px;background:rgba(28,31,40,.94);box-shadow:0 24px 60px rgba(0,0,0,.45);text-align:center}
.mk-lock{width:52px;height:52px;margin:0 auto 14px;border-radius:16px;display:grid;place-items:center;background:#2b3040;font-size:26px}
.mk-card h2{margin:0 0 6px;font-size:22px;font-weight:700;letter-spacing:-.01em}
.mk-card p{margin:0 0 18px;color:#b9bdca}
.mk-btn{appearance:none;border:0;border-radius:999px;padding:12px 22px;font:600 15px system-ui,sans-serif;cursor:pointer;background:#5b7cfa;color:#fff}
.mk-btn[disabled]{opacity:.55;cursor:default}
.mk-btn.mk-quiet{background:#323748}
.mk-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.mk-wait{display:inline-flex;align-items:center;gap:10px;color:#d6d9e3}
.mk-dot{width:10px;height:10px;border-radius:50%;background:#5b7cfa;animation:mk-pulse 1.2s ease-in-out infinite}
@keyframes mk-pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Before the viewer loads a world: a public memory (or a server with sign-in off) opens at once; a private one opens
 * for its owner and guests (after a memory pass, so the world's files load), and shows the door to everyone else.
 * Resolves when the person may walk in. Never resolves for someone who stays outside.
 */
export async function memoryDoor(sceneId: string, sceneName: string): Promise<void> {
  const cfg = await authConfig().catch(() => ({ enabled: false }));
  if (!cfg.enabled) return;
  await ready().catch(() => null);
  const first = await memory.info(sceneId).catch(() => null);
  if (!first || first.status !== 200 || !first.data || first.data.visibility === 'public') return;
  if (first.data.role === 'owner' || first.data.role === 'guest') {
    await memory.pass(sceneId);
    return;
  }

  const style = el('style');
  style.textContent = DOOR_CSS;
  document.head.append(style);
  const door = el('div', 'mk-door');
  door.setAttribute('role', 'dialog');
  door.setAttribute('aria-label', 'This memory is private');
  const card = el('div', 'mk-card');
  door.append(card);
  document.body.append(door);
  const info = first.data;
  const owner = info.owner ? `${info.owner}'s` : 'a family';

  function show(title: string, note: string, ...actions: HTMLElement[]): void {
    card.replaceChildren(el('div', 'mk-lock', '🔒'), el('h2', '', title), el('p', '', note));
    if (actions.length) {
      const row = el('div', 'mk-row');
      row.append(...actions);
      card.append(row);
    }
  }

  return new Promise<void>((resolve) => {
    const enter = async () => {
      show('Come in', `Opening ${sceneName}…`);
      await memory.pass(sceneId);
      door.remove();
      style.remove();
      resolve();
    };

    const waitForOwner = async () => {
      const wait = el('div', 'mk-wait');
      wait.append(el('span', 'mk-dot'), el('span', '', 'Waiting for the door to open…'));
      show('You knocked', `${info.owner ?? 'The owner'} gets your knock on their phone.`, wait);
      for (;;) {
        await sleep(2500);
        const r = await memory.info(sceneId).catch(() => null);
        const d = r?.data;
        if (d && (d.role === 'guest' || d.role === 'owner' || d.visibility === 'public')) return enter();
        if (d?.knock?.status === 'declined') {
          show('Not this time', `This memory stays with ${owner} family for now.`, link('Back to the gallery', '/'));
          return;
        }
      }
    };

    const knockButton = () => {
      const b = el('button', 'mk-btn', 'Ask to walk in');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await memory.knock(sceneId);
        if (r.status === 200 || r.status === 201) {
          if ((r.data as { role?: string; public?: boolean } | null)?.role === 'guest') return enter();
          return waitForOwner();
        }
        b.disabled = false;
        b.textContent = 'Try again';
      });
      return b;
    };

    if (!current()) {
      const b = el('button', 'mk-btn', 'Sign in to knock');
      b.type = 'button';
      b.addEventListener('click', () => void signIn());
      show(sceneName, `This memory is private to ${owner} family. Sign in and knock, and they can let you in.`, b, link('Back', '/'));
    } else if (info.knock?.status === 'pending') {
      void waitForOwner();
    } else {
      show(sceneName, `This memory is private to ${owner} family. Knock, and they can let you in from their phone.`, knockButton(), link('Back', '/'));
    }
  });
}

function link(label: string, href: string): HTMLAnchorElement {
  const a = el('a', 'mk-btn mk-quiet', label);
  a.href = href;
  a.style.textDecoration = 'none';
  return a;
}

// ---------------------------------------------------------------------------------------------------------------
// The owner's panel (/capture)

const PANEL_CSS = `
.mk-panel{margin:28px 0 0;padding:20px;border-radius:18px;background:var(--card,#f4f5f8);font:15px/1.45 system-ui,-apple-system,sans-serif}
.mk-panel h2{margin:0 0 4px;font-size:19px}
.mk-panel .mk-sub{margin:0 0 14px;color:#6b7080}
.mk-mem{padding:14px 0;border-top:1px solid rgba(0,0,0,.08)}
.mk-mem-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.mk-mem-head b{font-size:16px}
.mk-knock{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:10px 0 0;padding:10px 12px;border-radius:12px;background:#fff5d6}
.mk-guests{margin:8px 0 0;color:#6b7080;font-size:14px}
.mk-panel button{appearance:none;border:0;border-radius:999px;padding:8px 14px;font:600 14px system-ui,sans-serif;cursor:pointer;background:#e3e6ef;color:#1d2030}
.mk-panel button.mk-yes{background:#5b7cfa;color:#fff}
.mk-claim{display:flex;gap:8px;margin:14px 0 0}
.mk-claim input{flex:1;min-width:0;padding:8px 12px;border-radius:999px;border:1px solid #d5d8e2;font:14px system-ui,sans-serif}
`;

/** Mounts the owner's panel after `anchor` once the person is signed in. Polls every 3 s for new knocks. */
export async function mountOwnerPanel(anchor: HTMLElement | null): Promise<void> {
  const cfg = await authConfig().catch(() => ({ enabled: false }));
  if (!anchor || !cfg.enabled || !current()) return;
  const style = el('style');
  style.textContent = PANEL_CSS;
  document.head.append(style);
  const panel = el('section', 'mk-panel');
  panel.setAttribute('aria-label', 'Memory Keys');
  anchor.after(panel);
  let busy = false;

  async function render(): Promise<void> {
    if (busy) return;
    const r = await memory.mine().catch(() => null);
    const list = r?.data?.memories ?? [];
    const rows: HTMLElement[] = [el('h2', '', 'Memory Keys'), el('p', 'mk-sub', 'Who may walk into your memories. Knocks show up here as they happen.')];
    if (!list.length) rows.push(el('p', 'mk-sub', 'No memories of yours yet.'));
    for (const m of list) {
      const box = el('div', 'mk-mem');
      const head = el('div', 'mk-mem-head');
      const toggle = el('button', m.visibility === 'private' ? 'mk-yes' : '', m.visibility === 'private' ? 'Private' : 'Public');
      toggle.title = m.visibility === 'private' ? 'Only you and your guests can walk in. Click to open it to everyone.' : 'Anyone can walk in. Click to make it private.';
      toggle.addEventListener('click', () => act(() => memory.setPrivate(m.scene, m.visibility !== 'private')));
      const name = el('b');
      const a = el('a', '', m.scene);
      a.href = `/view?scene=${encodeURIComponent(m.scene)}`;
      name.append(a);
      head.append(name, toggle);
      box.append(head);
      for (const k of m.knocks ?? []) {
        const row = el('div', 'mk-knock');
        row.append(el('span', '', `🚪 ${k.name} is knocking`));
        const btns = el('span');
        const yes = el('button', 'mk-yes', 'Let in');
        yes.addEventListener('click', () => act(() => memory.answer(m.scene, k.id, true)));
        const no = el('button', '', 'Not now');
        no.addEventListener('click', () => act(() => memory.answer(m.scene, k.id, false)));
        btns.append(yes, ' ', no);
        row.append(btns);
        box.append(row);
      }
      const guests = m.guests ?? [];
      const g = el('div', 'mk-guests', guests.length ? 'Guests: ' : 'No guests yet.');
      for (const guest of guests) {
        const chip = el('button', '', `${guest.name} ×`);
        chip.title = `Remove ${guest.name}`;
        chip.addEventListener('click', () => act(() => memory.removeGuest(m.scene, guest.sub)));
        g.append(chip, ' ');
      }
      box.append(g);
      rows.push(box);
    }
    const claim = el('div', 'mk-claim');
    const input = el('input');
    input.placeholder = 'Memory id to take as yours (host laptop)';
    const take = el('button', '', 'Take');
    take.addEventListener('click', () => input.value.trim() && act(() => memory.claim(input.value.trim())));
    claim.append(input, take);
    rows.push(claim);
    panel.replaceChildren(...rows);
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
      await render();
    }
  }

  await render();
  setInterval(() => void render(), 3000);
}
