// Uploads a painted room's tiles (pipeline/roblox_proxy.py) as Decals from ROBLOX_KEY_FILE's account and writes the
// game's ProxyTiles entry for the scene: bun data/tmp/proxy-upload.ts <tiles dir> <sceneId>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RobloxAssetUploader } from '../../server/social/roblox-model.ts';

const [dir, sceneId] = [process.argv[2]!, process.argv[3]!];
const key = readFileSync(process.env.ROBLOX_KEY_FILE!, 'utf8').trim();
const up = new RobloxAssetUploader({ apiKey: key, creatorId: '996768857', creatorType: 'user' });
const doc = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8'));
const S = doc.studsPerMeter as number;
const ledgerPath = join(dir, 'uploads.json');
const ledger: Record<string, string> = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
const tiles: any[] = [];
for (const t of doc.tiles) {
  if (!ledger[t.file]) {
    const bytes = new Uint8Array(readFileSync(join(dir, t.file)));
    const r = await up.upload(bytes, `Déjà View: ${sceneId} ${t.file.replace('.png', '')}`, `A painted ${t.kind} tile of ${sceneId} from Déjà View.`, { assetType: 'Decal', contentType: 'image/png', fileName: t.file });
    ledger[t.file] = String(r.assetId);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
    console.log(`${t.file} -> ${r.assetId}`);
  }
  const c = t.centre.map((v: number) => +(v * S).toFixed(3));
  const s = t.size.map((v: number) => +(v * S).toFixed(3));
  tiles.push({ asset: ledger[t.file], kind: t.kind, c, s, n: t.inward ?? null });
}
const lua = (v: any): string => Array.isArray(v) ? `{ ${v.map(lua).join(', ')} }` : v === null ? 'nil' : typeof v === 'string' ? JSON.stringify(v) : String(v);
const body = tiles.map((t) => `\t\t{ asset = ${lua(t.asset)}, kind = ${lua(t.kind)}, c = ${lua(t.c)}, s = ${lua(t.s)}${t.n ? `, n = ${lua(t.n)}` : ''} },`).join('\n');
const out = `-- Uploaded tiles of the painted rooms (ProxyRoom): per scene, each tile's Decal id, kind, centre and size in studs.
-- Written by data/tmp/proxy-upload.ts from pipeline/roblox_proxy.py's proxy.json and the upload ids.
return {
\t[${JSON.stringify(sceneId)}] = { tiles = {
${body}
\t} },
} :: { [string]: any }
`;
writeFileSync('roblox/src/server/DejaView/ProxyTiles.luau', out);
console.log(`wrote ${tiles.length} tiles for ${sceneId}`);
