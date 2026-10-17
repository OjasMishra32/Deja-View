// The tab of one memory (/tab?scene=<id>, server/bank/tab.ts): what the night cost as a receipt, who owes whom as a
// Messages thread, the house rule for Roblox matches, and "Settle up", which makes the transfers in Capital One's
// Nessie sandbox and shows what Nessie confirmed. Mock money only.
//
// Data: GET /api/tab/:sceneId every 5 s while the page is visible. Changes go to POST /api/tab/:sceneId/purchase,
// /settle and /rules with the signed-in person's token when sign-in is on.

import type { TabPayment, TabView } from '../../server/bank/tab.ts';
import { errorFromBody, viewUrl } from './api.ts';
import * as auth from './auth.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const POLL_MS = 5000;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);

/** Apple's system colours, one per friend by name. */
const COLORS = ['#ff9500', '#34c759', '#5856d6', '#ff2d55', '#007aff', '#af52de', '#30b0c7', '#ff3b30', '#a2845e'];
function colorOf(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

function avatar(name: string): string {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return `<span class="t-ava" style="--c:${colorOf(name)}" aria-hidden="true">${esc(initial)}</span>`;
}

/** A Nessie id shortened for a caption: 64f1a2…9c0e. */
function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

const GAME_ICONS: Record<string, string> = { pool: '🎱', pingpong: '🏓', foosball: '⚽', chess: '♟️', tag: '🏃' };
const GAME_NAMES: Record<string, string> = { pool: 'pool', pingpong: 'ping pong', foosball: 'foosball', chess: 'chess', tag: 'tag' };
/** The game's entry in one of the tables above (a game Roblox calls "constructor" is not Object's). */
const lookup = (table: Record<string, string>, game: string) => (Object.hasOwn(table, game) ? table[game] : undefined);

// ---------------------------------------------------------------------------------------------
// State

const sceneId = new URLSearchParams(location.search).get('scene')?.trim() ?? '';
let tab: TabView | null = null;
let loading = false;
let settling = false;
let ruleBusy = false;
let lastSplitKey = '';
const splitOff = new Set<string>();

// ---------------------------------------------------------------------------------------------
// Requests

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...auth.authHeaders(), ...(init.headers ?? {}) },
    });
  } catch {
    throw new RequestError("Can't reach the laptop. Check the Wi-Fi and try again.", 0, null);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = errorFromBody(body).message ?? `Something went wrong (HTTP ${res.status}).`;
    throw new RequestError(msg, res.status, body);
  }
  return body as T;
}

const api = (rest = '') => `/api/tab/${encodeURIComponent(sceneId)}${rest}`;

function post<T>(rest: string, body: unknown): Promise<T> {
  return call<T>(api(rest), { method: 'POST', body: JSON.stringify(body ?? {}) });
}

// ---------------------------------------------------------------------------------------------
// Feedback

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, bad = false): void {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function banner(html: string | null): void {
  const b = $('#banner');
  b.hidden = !html;
  b.innerHTML = html ?? '';
}

/** A refused change: a sign-in prompt when that is why, else the server's sentence. */
function refused(e: unknown): void {
  const err = e as RequestError;
  if (err.status === 401 && (err.body as { signIn?: boolean } | null)?.signIn) {
    banner('Sign in to change the tab. <button type="button" id="sign-in">Sign in</button>');
    $('#sign-in')?.addEventListener('click', () => void auth.signIn());
    return;
  }
  toast(err.message || 'That did not go through.', true);
}

// ---------------------------------------------------------------------------------------------
// Rendering

function renderHero(t: TabView): void {
  document.title = `${t.scene.name} · The tab · Déjà View`;
  $('#title').textContent = t.scene.name;
  const people = t.friends.length;
  const items = t.purchases.length;
  $('#sub').textContent = items
    ? `${people} ${people === 1 ? 'friend' : 'friends'} · ${items} ${items === 1 ? 'purchase' : 'purchases'}`
    : 'Nothing on the tab yet';
  $('#total').textContent = money(t.totalCents);
  const img = $<HTMLImageElement>('#thumb-img');
  if (t.scene.thumb && img.getAttribute('src') !== t.scene.thumb) {
    img.src = t.scene.thumb;
    img.onload = () => (img.hidden = false);
    img.onerror = () => (img.hidden = true);
  }
  const open = $<HTMLAnchorElement>('#open-world');
  open.href = viewUrl(t.sceneId);
  open.hidden = false;
  $('#mode-note').textContent =
    t.mode === 'nessie' ? 'Every purchase and transfer here is a real call to the Nessie sandbox.' : 'Demo bank: this server has no Nessie key, so transfers stay on this laptop.';
}

function renderReceipt(t: TabView): void {
  const el = $('#receipt');
  if (!t.purchases.length) {
    el.innerHTML = '<div class="t-empty">Add what the night cost, and who paid.</div>';
    return;
  }
  const rows = t.purchases.map((p) => {
    const ways = p.split.length;
    const meta = [p.merchant !== p.description ? p.merchant : null, `paid by ${p.payerName}`, ways > 1 ? `split ${ways} ways` : ways === 1 && p.split[0] !== p.payer ? 'for one' : null]
      .filter(Boolean)
      .join(' · ');
    const covered = p.coveredCents > 0 ? `<span class="t-line-note">${money(p.coveredCents)} covered by the match${p.coveredCents >= p.amountCents ? '' : 'es so far'}</span>` : '';
    const bank = p.bank === 'nessie' ? 'Nessie' : 'Demo';
    const booked = p.nessieId ? `<span class="t-booked" title="${bank} purchase ${esc(p.nessieId)}">${bank} ${esc(shortId(p.nessieId))}</span>` : '';
    return `<div class="t-line">
      ${avatar(p.payerName)}
      <div class="t-line-main">
        <span class="t-line-what">${esc(p.description)}${p.table ? '<span class="t-tag">Table</span>' : ''}</span>
        <span class="t-line-meta">${esc(meta)}</span>
        ${covered}${booked}
      </div>
      <span class="t-line-amt">${money(p.amountCents)}</span>
    </div>`;
  });
  el.innerHTML = `${rows.join('')}<div class="t-receipt-total"><span>Total</span><span>${money(t.totalCents)}</span></div>`;
}

function captionOf(p: TabPayment & { fromName: string; toName: string }): string {
  const id = p.nessieId ? `<span class="t-id">${esc(shortId(p.nessieId))}</span>` : '';
  if (p.status === 'unconfirmed') return '<span class="t-cap t-cap-bad">Nessie did not confirm in time</span>';
  if (p.status === 'pending') return '<span class="t-cap">Sending to Nessie…</span>';
  const where = p.bank === 'nessie' ? 'Nessie transfer' : 'Demo transfer';
  return `<span class="t-cap">${where} ${id}${id ? ' · ' : ''}Paid</span>`;
}

function renderThread(t: TabView): void {
  const el = $('#thread');
  const parts: string[] = [];
  for (const p of t.settled) {
    const text =
      p.kind === 'table'
        ? `${esc(p.fromName)} covered the table for ${esc(p.toName)} <span class="t-amt">${money(p.amountCents)}</span>`
        : `${esc(p.fromName)} paid ${esc(p.toName)} <span class="t-amt">${money(p.amountCents)}</span>`;
    parts.push(`<div class="t-msg t-msg-out${p.status === 'paid' ? '' : ' t-msg-warn'}"><div class="t-bubble">${text}</div>${captionOf(p)}</div>`);
  }
  for (const x of t.transfers) {
    parts.push(`<div class="t-msg t-msg-in">${avatar(x.fromName)}<div class="t-bubble"><b>${esc(x.fromName)}</b> owes <b>${esc(x.toName)}</b> <span class="t-amt">${money(x.amountCents)}</span></div></div>`);
  }
  if (t.square) {
    parts.push(
      '<div class="t-square"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#34c759"/><path d="M5.6 10.3l2.9 2.9 5.9-6.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>All square</div>',
    );
  } else if (!parts.length) {
    parts.push('<div class="t-thread-empty">Nobody owes anybody yet.</div>');
  }
  el.innerHTML = parts.join('');
  const n = t.transfers.length;
  $('#owe-summary').textContent = n ? `${n} ${n === 1 ? 'transfer' : 'transfers'} to even it out` : '';
}

function renderGames(t: TabView): void {
  const section = $('#games-section');
  const games = t.games.slice(-8).reverse();
  section.hidden = !games.length;
  if (!games.length) return;
  $('#games').innerHTML = games
    .map((g) => {
      const name = lookup(GAME_NAMES, g.game) ?? g.game;
      const title =
        g.winnerName && g.loserName
          ? g.draw
            ? `${g.winnerName} and ${g.loserName} drew at ${name}`
            : `${g.winnerName} beat ${g.loserName} at ${name}`
          : `${g.loserName ?? 'Someone'} lost at ${name}`;
      const sub =
        g.status === 'charged' && g.charge !== undefined
          ? `${g.loserName} covers ${money(g.chargeCents ?? 0)} of the table for ${g.payeeName}`
          : g.status === 'covered'
            ? (g.note ?? 'The table stays on them.')
            : (g.note ?? '');
      return `<div class="t-game">
        <span class="t-game-icon" aria-hidden="true">${lookup(GAME_ICONS, g.game) ?? '🎮'}</span>
        <div class="t-game-main"><span class="t-game-title">${esc(title)}${g.score ? ` · ${esc(g.score)}` : ''}</span><span class="t-game-sub">${esc(sub)}</span></div>
      </div>`;
    })
    .join('');
}

function renderRules(t: TabView): void {
  const sw = $<HTMLButtonElement>('#rule-switch');
  sw.setAttribute('aria-checked', String(t.rules.loserCoversTable));
  sw.disabled = ruleBusy;
  $('#fee-row').hidden = !t.rules.loserCoversTable;
  const fee = $<HTMLInputElement>('#fee');
  if (document.activeElement !== fee) fee.value = t.rules.tableFeeCents === null ? '' : (t.rules.tableFeeCents / 100).toFixed(2);
}

function renderDock(t: TabView | null): void {
  const b = $<HTMLButtonElement>('#settle');
  b.classList.remove('square');
  if (settling) {
    b.disabled = true;
    b.innerHTML = '<span class="t-spin" aria-hidden="true"></span>Settling with Nessie…';
    return;
  }
  if (!t || !t.purchases.length) {
    b.disabled = true;
    b.textContent = 'Settle up';
    return;
  }
  if (!t.transfers.length) {
    b.disabled = true;
    b.classList.add('square');
    b.textContent = 'All square';
    return;
  }
  const n = t.transfers.length;
  b.disabled = false;
  b.textContent = `Settle up · ${n} ${n === 1 ? 'transfer' : 'transfers'}`;
}

/** The form's lists follow the tab: friends to pick, merchants already used, who shares (all by default). */
function renderForm(t: TabView): void {
  $('#friends').innerHTML = t.friends.map((f) => `<option value="${esc(f.name)}"></option>`).join('');
  const merchants = [...new Set([t.scene.name, ...t.purchases.map((p) => p.merchant)])];
  $('#merchants').innerHTML = merchants.map((m) => `<option value="${esc(m)}"></option>`).join('');
  const merchant = $<HTMLInputElement>('#f-merchant');
  if (!merchant.value && document.activeElement !== merchant) merchant.placeholder = t.scene.name;
  const key = t.friends.map((f) => f.id).join('|');
  if (key === lastSplitKey) return;
  lastSplitKey = key;
  $('#f-split-wrap').hidden = !t.friends.length;
  $('#f-split').innerHTML = t.friends
    .map((f) => `<button type="button" class="t-chip-btn" data-id="${esc(f.id)}" data-name="${esc(f.name)}" aria-pressed="${!splitOff.has(f.id)}">${esc(f.name)}</button>`)
    .join('');
}

function render(): void {
  if (!tab) return;
  renderHero(tab);
  renderReceipt(tab);
  renderThread(tab);
  renderGames(tab);
  renderRules(tab);
  renderForm(tab);
  renderDock(tab);
}

// ---------------------------------------------------------------------------------------------
// Loading

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    tab = await call<TabView>(api());
    if ($('#banner').textContent?.startsWith("Can't")) banner(null);
    render();
  } catch (e) {
    const err = e as RequestError;
    if (err.status === 404) {
      banner("We couldn't find that memory. Open the tab from a memory's page.");
      $('#title').textContent = 'No such memory';
    } else banner(esc(err.message));
    renderDock(tab);
  } finally {
    loading = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Actions

function showConfirmations(made: (TabPayment & { fromName?: string; toName?: string })[]): void {
  const names = new Map((tab?.friends ?? []).map((f) => [f.id, f.name]));
  const paid = made.filter((p) => p.status !== 'failed');
  $('#sheet-title').textContent = paid.length === made.length ? 'Settled up' : paid.length ? 'Partly settled' : 'Not settled';
  const total = paid.reduce((s, p) => s + p.amountCents, 0);
  $('#sheet-sub').textContent = paid.length
    ? `${paid.length} ${paid.length === 1 ? 'transfer' : 'transfers'} · ${money(total)} moved ${tab?.mode === 'nessie' ? 'in Capital One Nessie' : 'in the demo bank'}`
    : 'Nessie did not take the transfers. Try again in a moment.';
  $('#confirms').innerHTML = made
    .map((p) => {
      const from = names.get(p.from) ?? p.from;
      const to = names.get(p.to) ?? p.to;
      const bad = p.status === 'failed';
      const icon = bad
        ? '<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><circle cx="11" cy="11" r="11" fill="#ff3b30"/><path d="M11 5.8v6.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="11" cy="15.8" r="1.3" fill="#fff"/></svg>'
        : '<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><circle cx="11" cy="11" r="11" fill="#34c759"/><path d="M6.2 11.3l3.2 3.2 6.4-6.8" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const detail = bad
        ? esc(p.error ?? "Didn't go through.")
        : p.status === 'unconfirmed'
          ? 'Sent; Nessie did not confirm in time'
          : p.nessieId
            ? `${p.bank === 'nessie' ? 'Nessie' : 'Demo'} transfer ${esc(p.nessieId)}`
            : p.bank === 'nessie'
              ? 'Sent to Nessie'
              : 'Sent';
      return `<li class="t-confirm${bad ? ' t-confirm-bad' : ''}">${icon}<span><span class="t-confirm-who">${esc(from)} → ${esc(to)}</span><span class="t-confirm-id">${detail}</span></span><span class="t-confirm-amt">${money(p.amountCents)}</span></li>`;
    })
    .join('');
  $('#sheet').hidden = false;
  $<HTMLButtonElement>('#sheet-done').focus();
}

async function settleUp(): Promise<void> {
  if (settling || !tab?.transfers.length) return;
  settling = true;
  renderDock(tab);
  try {
    const r = await call<{ ok: boolean; already: boolean; made: TabPayment[]; tab: TabView; error?: string }>(api('/settle'), { method: 'POST', body: '{}' }).catch(
      (e: RequestError) => {
        // 502 still carries the tab and what was tried
        const b = e.body as { made?: TabPayment[]; tab?: TabView } | null;
        if (e.status === 502 && b?.tab && b.made) return { ok: false, already: false, made: b.made, tab: b.tab, error: e.message };
        throw e;
      },
    );
    tab = r.tab;
    settling = false;
    render();
    if (r.already) toast('Already square. Nothing to send.');
    else showConfirmations(r.made);
  } catch (e) {
    settling = false;
    renderDock(tab);
    refused(e);
  }
}

async function setRule(on: boolean, feeText?: string): Promise<void> {
  if (ruleBusy) return;
  let tableFee: number | null | undefined;
  if (feeText !== undefined) {
    const s = feeText.replace(/[$\s]/g, '');
    if (!s) tableFee = null;
    else if (/^\d{1,3}(\.\d{1,2})?$/.test(s) && Number(s) > 0 && Number(s) <= 500) tableFee = Number(s);
    else {
      toast('The fee is dollars, up to $500.', true);
      return;
    }
  }
  ruleBusy = true;
  if (tab) renderRules({ ...tab, rules: { ...tab.rules, loserCoversTable: on } });
  try {
    const r = await post<{ tab: TabView }>('/rules', { loserCoversTable: on, ...(tableFee !== undefined ? { tableFee } : {}) });
    tab = r.tab;
    ruleBusy = false;
    render();
    if (feeText === undefined) toast(on ? 'The loser covers the table from now on.' : 'Matches no longer touch the tab.');
  } catch (e) {
    ruleBusy = false;
    if (tab) renderRules(tab);
    refused(e);
  }
}

function openForm(open: boolean): void {
  $('#add-form').hidden = !open;
  $('#add-open').hidden = open;
  $('#add-error').hidden = true;
  if (open) $<HTMLInputElement>('#f-desc').focus();
}

async function addPurchase(ev: Event): Promise<void> {
  ev.preventDefault();
  const err = $('#add-error');
  const desc = $<HTMLInputElement>('#f-desc').value.trim();
  const merchantInput = $<HTMLInputElement>('#f-merchant');
  const merchant = merchantInput.value.trim() || tab?.scene.name || '';
  const amount = $<HTMLInputElement>('#f-amount').value.replace(/[$\s]/g, '');
  const payer = $<HTMLInputElement>('#f-payer').value.trim();
  const show = (m: string) => {
    err.textContent = m;
    err.hidden = false;
  };
  if (!payer) return show('Who paid?');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 500) return show('The amount is dollars and cents, up to $500.');
  const chips = [...document.querySelectorAll<HTMLButtonElement>('#f-split .t-chip-btn')];
  let split: string[] | undefined;
  if (chips.length) {
    split = chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.name!);
    // someone new paying shares their own purchase
    if (!chips.some((c) => c.dataset.name!.toLowerCase() === payer.toLowerCase())) split.push(payer);
    if (!split.length) return show('Pick who shares it.');
  }
  const submit = $<HTMLButtonElement>('#add-submit');
  submit.disabled = true;
  submit.textContent = 'Booking in Nessie…';
  try {
    const r = await post<{ tab: TabView }>('/purchase', {
      payer,
      merchant,
      amount: Number(amount),
      ...(desc ? { description: desc } : {}),
      ...(split ? { split } : {}),
      table: $<HTMLInputElement>('#f-table').checked,
    });
    tab = r.tab;
    render();
    ($('#add-form') as HTMLFormElement).reset();
    openForm(false);
    toast(`Added ${money(Math.round(Number(amount) * 100))} for ${payer}.`);
  } catch (e) {
    const x = e as RequestError;
    if (x.status === 401) refused(e);
    else show(x.message);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Add to the tab';
  }
}

// ---------------------------------------------------------------------------------------------
// Start

function wire(): void {
  $('#settle').addEventListener('click', () => void settleUp());
  $('#sheet-done').addEventListener('click', () => ($('#sheet').hidden = true));
  $('#sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('#sheet').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#sheet').hidden = true;
  });
  $('#rule-switch').addEventListener('click', () => {
    if (tab) void setRule(!tab.rules.loserCoversTable);
  });
  const fee = $<HTMLInputElement>('#fee');
  const saveFee = () => {
    if (!tab) return;
    const current = tab.rules.tableFeeCents === null ? '' : (tab.rules.tableFeeCents / 100).toFixed(2);
    if (fee.value.trim() !== current) void setRule(tab.rules.loserCoversTable, fee.value);
  };
  fee.addEventListener('change', saveFee);
  fee.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fee.blur();
  });
  $('#add-open').addEventListener('click', () => openForm(true));
  $('#add-cancel').addEventListener('click', () => openForm(false));
  $('#add-form').addEventListener('submit', (e) => void addPurchase(e));
  $('#f-split').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.t-chip-btn');
    if (!chip) return;
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    if (on) splitOff.delete(chip.dataset.id!);
    else splitOff.add(chip.dataset.id!);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void load();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !settling) void load();
  }, POLL_MS);
}

async function start(): Promise<void> {
  wire();
  if (!sceneId) {
    banner('Open the tab from a memory: <b>/tab?scene=&lt;memory id&gt;</b>.');
    $('#title').textContent = 'No memory picked';
    $('#receipt').innerHTML = '<div class="t-empty">No memory picked.</div>';
    return;
  }
  const { error } = await auth.ready().catch(() => ({ error: null }));
  if (error) toast(error, true);
  await load();
}

void start();
