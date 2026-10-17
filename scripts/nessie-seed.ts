// Seeds the demo tab of the-courts (Infinity Hall Game Lawn): Ojasva, Seb, Shivin and Brianna, the lawn's pool
// table and snacks and a pizza run, with "loser covers the table" on, so /tab?scene=the-courts has a night to settle.
//
//   bun scripts/nessie-seed.ts                       writes data/tab/the-courts.json, booking in the bank the
//                                                    environment picks (NESSIE_API_KEY: Capital One's Nessie sandbox;
//                                                    unset: the demo bank)
//   bun scripts/nessie-seed.ts --url http://localhost:8788
//                                                    the same through a running server's /api/tab routes, in its bank
//   --scene <id>   another memory        --fresh   start the tab over (the old file is kept as <id>.json.bak)
//   --game         with --url: also send a game.result (Shivin loses at pool) to /api/roblox/<id>/event (as
//                  game_result when the event route does not take the dot yet)
//
// With --url the server's own keys from .env go along (THIRDWHEEL_API_TOKEN for the tab routes, DV_KEY for the event
// route off this machine), so a server that requires them still takes the seed.
//
// A tab that already has purchases is left alone (run with --fresh to redo it). Mock money only.

import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { nessieFromEnv } from '../server/bank/nessie.ts';
import { createTab, type PurchaseInput, type TabView } from '../server/bank/tab.ts';
import { DATA_DIR, SCENES_DIR } from '../server/config.ts';
import { SceneStore } from '../server/store.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const sceneId = option('--scene') ?? 'the-courts';
const serverUrl = option('--url')?.replace(/\/+$/, '');
const PLACE = 'Infinity Hall Game Lawn';
const PIZZA = 'Lawnside Pizza Co.';
const FRIENDS = ['Ojasva', 'Seb', 'Shivin', 'Brianna'];

const PURCHASES: PurchaseInput[] = [
  { payer: 'Seb', merchant: PLACE, amount: 12, description: 'Pool table, two hours', split: FRIENDS, table: true, category: 'entertainment' },
  { payer: 'Ojasva', merchant: PLACE, amount: 9.75, description: 'Chips and sodas', split: FRIENDS, category: 'food' },
  { payer: 'Brianna', merchant: PIZZA, amount: 31.4, description: 'Two large pizzas', split: FRIENDS, category: 'food' },
  { payer: 'Shivin', merchant: PIZZA, amount: 8.5, description: 'Garlic knots', split: ['Shivin', 'Seb'], category: 'food' },
];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function summary(tab: TabView): void {
  console.log(`\n${tab.scene.name}: ${tab.purchases.length} purchases, ${money(tab.totalCents)} (${tab.mode === 'nessie' ? 'Capital One Nessie' : 'demo bank'})`);
  for (const p of tab.purchases) console.log(`  ${p.payerName.padEnd(8)} ${money(p.amountCents).padStart(8)}  ${p.description} · ${p.merchant}${p.nessieId ? `  [${p.bank === 'nessie' ? 'Nessie' : 'demo'} ${p.nessieId}]` : ''}`);
  console.log('  Who owes whom:');
  for (const t of tab.transfers) console.log(`    ${t.fromName} -> ${t.toName}  ${money(t.amountCents)}`);
  if (!tab.transfers.length) console.log('    nobody');
  console.log(`  Loser covers the table: ${tab.rules.loserCoversTable ? 'on' : 'off'}`);
}

async function viaServer(base: string): Promise<void> {
  const keys: Record<string, string> = {};
  const token = process.env.THIRDWHEEL_API_TOKEN?.trim();
  const dvKey = process.env.DV_KEY?.trim();
  if (token) keys['X-DejaView-Token'] = token;
  if (dvKey) keys['X-DejaView-Key'] = dvKey;
  const send = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, body === undefined ? { headers: keys } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...keys }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { res, data };
  };
  const call = async (path: string, body?: unknown) => {
    const { res, data } = await send(path, body);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${String(data?.error ?? '')}`);
    return data;
  };
  let tab = (await call(`/api/tab/${sceneId}`)) as unknown as TabView;
  if (tab.purchases.length) {
    console.log(`${sceneId} already has a tab (${tab.purchases.length} purchases); --fresh only works without --url.`);
  } else {
    for (const p of PURCHASES) tab = ((await call(`/api/tab/${sceneId}/purchase`, p)) as { tab: TabView }).tab;
    tab = ((await call(`/api/tab/${sceneId}/rules`, { loserCoversTable: true, tableFee: null })) as { tab: TabView }).tab;
  }
  if (flag('--game')) {
    const round = `seed-${Date.now()}`;
    const result = { type: 'game.result', game: 'pool', round, winner: 'rbx-1001', winnerName: 'Seb', loser: 'rbx-1002', loserName: 'Shivin', score: '7-4', durationS: 312 };
    const first = await send(`/api/roblox/${sceneId}/event`, result);
    if (first.res.status === 400) await call(`/api/roblox/${sceneId}/event`, { ...result, type: 'game_result' });
    else if (!first.res.ok) throw new Error(`/api/roblox/${sceneId}/event: HTTP ${first.res.status} ${String(first.data?.error ?? '')}`);
    console.log(`Sent ${first.res.ok ? 'game.result' : 'game_result'} ${round}: Seb beat Shivin at pool.`);
    await Bun.sleep(1500);
    tab = (await call(`/api/tab/${sceneId}`)) as unknown as TabView;
  }
  summary(tab);
  console.log(`\nOpen ${base}/tab?scene=${sceneId}\n`);
}

async function direct(): Promise<void> {
  const store = new SceneStore(SCENES_DIR);
  const getScene = async (id: string): Promise<Scene | null> => {
    const s = await store.get(id).catch(() => null);
    if (s) return s;
    if (id !== 'the-courts') return null;
    console.warn(`(no scene.json for ${id} under ${SCENES_DIR}; seeding with the name "${PLACE}")`);
    return { id, name: PLACE, mode: 'reconstruct', status: 'ready', createdAt: '', updatedAt: '' } as Scene;
  };
  if (!(await getScene(sceneId))) {
    console.error(`No memory called ${sceneId} under ${SCENES_DIR}.`);
    process.exit(1);
  }
  const file = join(DATA_DIR, 'tab', `${sceneId}.json`);
  if (flag('--fresh') && (await Bun.file(file).exists())) {
    await copyFile(file, `${file}.bak`);
    await rm(file);
    console.log(`Started ${sceneId}'s tab over (the old one is ${file}.bak).`);
  }
  const nessie = nessieFromEnv();
  const tabs = createTab({ getScene, dataDir: DATA_DIR, nessie, log: (m) => console.warn(m) });
  let tab = await tabs.view(sceneId);
  if (tab.purchases.length) {
    console.log(`${sceneId} already has a tab (${tab.purchases.length} purchases). Run with --fresh to redo it.`);
  } else {
    console.log(`Booking ${PURCHASES.length} purchases in ${nessie.mode === 'nessie' ? 'Capital One Nessie' : 'the demo bank'}…`);
    for (const p of PURCHASES) tab = (await tabs.addPurchase(sceneId, p)).tab;
    tab = await tabs.setRules(sceneId, { loserCoversTable: true, tableFee: null });
  }
  summary(tab);
  console.log(`\nWrote ${file}. Open /tab?scene=${sceneId} on the server.\n`);
}

try {
  if (serverUrl) await viaServer(serverUrl);
  else await direct();
} catch (e) {
  console.error(`Seeding failed: ${(e as Error).message}`);
  process.exit(1);
}
