/// Upload one object GLB to Roblox as a Model asset.
/// The key comes from ROBLOX_API_KEY; this script never reads or prints a key file.
/// It refuses unless preflight/approval.json next to the GLB is approved for these exact bytes (same SHA1).
/// Bun loads the repo .env on its own, so nothing uploads unless ROBLOX_UPLOAD=1 is typed on the command line
/// (the same switch the server uses) and ROBLOX_CREATOR_ID names the account.
///   ROBLOX_UPLOAD=1 ROBLOX_API_KEY=... ROBLOX_CREATOR_ID=... bun scripts/roblox-upload-object.ts <glb> [name]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RobloxAssetUploader } from '../server/social/roblox-model.ts';

const [file, name = 'DejaView object'] = process.argv.slice(2);
if (!file) throw new Error('usage: bun scripts/roblox-upload-object.ts <glb> [name]');
const bytes = new Uint8Array(await readFile(file));
const sha1 = createHash('sha1').update(bytes).digest('hex');
let approval: { approved?: unknown; sha1?: unknown } | null = null;
try {
  approval = JSON.parse(await readFile(join(dirname(file), 'preflight', 'approval.json'), 'utf8'));
} catch {
  approval = null;
}
if (approval?.approved !== true || approval.sha1 !== sha1) {
  console.error('No upload: no personal approval for this exact file (not approved, or the file changed).');
  process.exit(2);
}
if (process.env.ROBLOX_UPLOAD?.trim() !== '1') {
  console.error('No upload: uploads are off. Set ROBLOX_UPLOAD=1 on the command line to upload.');
  process.exit(2);
}
const apiKey = process.env.ROBLOX_API_KEY?.trim();
if (!apiKey) throw new Error('ROBLOX_API_KEY is missing');
const creatorId = process.env.ROBLOX_CREATOR_ID?.trim();
if (!creatorId) throw new Error('ROBLOX_CREATOR_ID is missing');
const uploader = new RobloxAssetUploader({ apiKey, creatorId, creatorType: 'user' });
console.log(`uploading ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
const result = await uploader.upload(bytes, name, 'DejaView object mesh from the scan');
console.log(`asset ${result.assetId}`);
