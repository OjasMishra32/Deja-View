// The public scoreboard (/scores): every Roblox match played in a Déjà View world, newest first, each with a link to
// its signed memo on Solana devnet, plus the players with the most wins. /scores?scene=<id> shows one world.
//
// Data: GET /api/scores, or /api/scores/<sceneId> (server/scores/scoreboard.ts), every 5 s while the tab is visible.

import type { Leader, ScoreRow, ScoresView } from '../../server/scores/scoreboard.ts';

const POLL_MS = 5000;
const GAMES: Record<string, string> = { pingpong: 'Ping pong', pool: 'Pool', foosball: 'Foosball', chess: 'Chess', tag: 'Tag' };

const ICON_CHECK =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#34c759"/><path d="M5.6 10.3l2.9 2.9 5.9-6.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WAIT =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="#aeaeb2" stroke-width="2"/><path d="M10 5.8V10l2.8 1.8" fill="none" stroke="#aeaeb2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FAIL =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#ff3b30"/><path d="M10 5.2v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.3" fill="#fff"/></svg>';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const sceneId = (() => {
  const s = new URLSearchParams(location.search).get('scene')?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9-]{0,95}$/.test(s) ? s : null;
})();

let loaded = false;
let lastHtml = '';
let lastOk = 0;
const seen = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------------------------
// Words

function gameName(g: string): string {
  return GAMES[g] ?? g.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function duration(s: number | null): string {
  if (!s || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** Only links to the Solana explorer are ever made clickable. */
const explorerHref = (u: unknown): string | null => (typeof u === 'string' && u.startsWith('https://explorer.solana.com/') ? u : null);

// ---------------------------------------------------------------------------------------------
// Rendering

function proofHtml(r: ScoreRow): string {
  const href = explorerHref(r.explorer);
  const link = (cls: string, icon: string, label: string) =>
    href ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${icon}${label} ↗</a>` : `<span class="${cls}">${icon}${label}</span>`;
  if (r.status === 'confirmed') return link('s-ok', ICON_CHECK, 'Verified on Solana');
  if (r.status === 'pending') return link('s-pending', ICON_WAIT, href ? 'Confirming on Solana' : 'Writing to Solana');
  return `<span class="s-failed">${ICON_FAIL}Not recorded on Solana</span>`;
}

function rowHtml(r: ScoreRow, now: number, fresh: boolean): string {
  const players = r.draw
    ? `<span class="s-win">${esc(r.winner)}</span> <span class="s-beat">drew with</span> <span class="s-win">${esc(r.loser)}</span>`
    : r.loser
      ? `<span class="s-win">${esc(r.winner)}</span> <span class="s-beat">beat</span> <span class="s-lose">${esc(r.loser)}</span>`
      : `<span class="s-win">${esc(r.winner)}</span> <span class="s-beat">won</span>`;
  const where = [sceneId ? null : r.sceneName || r.scene, ago(r.time, now), duration(r.durationS)].filter(Boolean).map(esc).join(' · ');
  const score = r.draw && /^draw$/i.test(r.score) ? 'Draw' : r.score.replace(/^(\d+)\s*-\s*(\d+)$/, '$1–$2');
  return `<li class="s-row${fresh ? ' s-new' : ''}">
    <div class="s-row-main">
      <div class="s-game">${esc(gameName(r.game))}</div>
      <div class="s-players">${players}</div>
      <div class="s-where">${where}</div>
    </div>
    <div class="s-score">${esc(score)}</div>
    <div class="s-proof">${proofHtml(r)}</div>
  </li>`;
}

function leaderHtml(l: Leader, i: number): string {
  const record = `${l.wins} ${l.wins === 1 ? 'win' : 'wins'}${l.losses ? ` · ${l.losses} ${l.losses === 1 ? 'loss' : 'losses'}` : ''}`;
  return `<li class="s-leader"><div class="s-rank">${i + 1}</div><div class="s-leader-name">${esc(l.name)}</div><div class="s-record">${esc(record)}</div></li>`;
}

function notice(title: string, body: string): void {
  const n = $('notice');
  n.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  n.hidden = false;
}

function render(v: ScoresView): void {
  const now = Date.now();
  const list = $('list');
  list.removeAttribute('aria-busy');
  $('notice').hidden = true;

  if (sceneId) {
    const name = v.sceneName || sceneId;
    $('title').textContent = name;
    $('lede').textContent = `Every match played in ${name}, written to Solana the moment it ends.`;
    document.title = `${name} · Déjà View Scoreboard`;
    $('all-worlds').hidden = false;
  }
  $('network').textContent = v.cluster === 'localnet' ? 'Local Solana validator' : 'Solana devnet';
  const ledger = $<HTMLAnchorElement>('ledger');
  const accountHref = explorerHref(v.accountExplorer);
  ledger.hidden = !accountHref;
  if (accountHref) ledger.href = accountHref;

  if (!v.enabled) {
    list.innerHTML = '';
    lastHtml = '';
    $('count').textContent = '';
    $('leaders-section').hidden = true;
    $('foot').hidden = true;
    notice('The scoreboard is off', v.error ?? 'This server is not writing results to Solana right now. Matches still play as usual.');
    return;
  }

  const rows = v.scores;
  $('count').textContent = rows.length ? `${rows.length === 50 ? 'Latest 50' : rows.length} ${rows.length === 1 ? 'match' : 'matches'}` : '';
  if (!rows.length) {
    list.innerHTML = '';
    lastHtml = '';
    notice('No matches yet', 'Finish a game of ping pong, pool, foosball, chess or tag in a Roblox world and it shows up here, signed on Solana.');
  } else {
    const html = rows
      .map((r) => {
        const key = `${r.scene}|${r.round}`;
        const fresh = loaded && !seen.has(key);
        seen.add(key);
        return rowHtml(r, now, fresh);
      })
      .join('');
    // the same rows and times: leave the list alone (no re-announce, no restarted animation)
    if (html.replace(/ s-new/g, '') !== lastHtml) {
      list.innerHTML = html;
      lastHtml = html.replace(/ s-new/g, '');
    }
  }

  const leaders = v.leaders ?? [];
  $('leaders-section').hidden = leaders.length < 1;
  $('leaders').innerHTML = leaders.map(leaderHtml).join('');

  const foot = $('foot');
  if (v.account) {
    foot.hidden = false;
    foot.innerHTML =
      `Each result is a memo signed by account <span title="${esc(v.account)}">${esc(shortAddress(v.account))}</span> on ` +
      `${v.cluster === 'localnet' ? 'a local Solana validator' : 'Solana devnet, a public test network'}. ` +
      'Once it is confirmed, nobody can change it, including us.';
  } else {
    foot.hidden = true;
  }
  loaded = true;
}

function setLive(state: 'ok' | 'warn' | 'wait', text: string): void {
  const el = $('live');
  el.dataset.state = state;
  el.textContent = text;
}

// ---------------------------------------------------------------------------------------------
// Polling

async function refresh(): Promise<void> {
  try {
    const res = await fetch(sceneId ? `/api/scores/${encodeURIComponent(sceneId)}` : '/api/scores', { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as (ScoresView & { error?: string }) | null;
    if (res.status === 404) {
      render({ enabled: true, cluster: 'devnet', account: null, accountExplorer: null, scores: [], leaders: [] });
      notice('No such world', 'This link points at a world that does not exist. Try all worlds instead.');
      $('all-worlds').hidden = false;
      setLive('ok', 'Live');
      return;
    }
    if (!res.ok || !body || !Array.isArray(body.scores)) throw new Error(body?.error ?? `HTTP ${res.status}`);
    render(body);
    lastOk = Date.now();
    setLive(body.enabled ? 'ok' : 'wait', body.enabled ? 'Live' : 'Off');
  } catch {
    if (!loaded) {
      $('list').innerHTML = '';
      $('list').removeAttribute('aria-busy');
      notice("Can't reach the scoreboard", 'Trying again every few seconds.');
    }
    // one missed poll is not worth a word; three are
    if (Date.now() - lastOk > 15_000) setLive('warn', 'Reconnecting');
  }
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    if (document.visibilityState === 'hidden') return;
    await refresh();
    schedule(POLL_MS);
  }, ms);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') schedule(0);
});

schedule(0);
