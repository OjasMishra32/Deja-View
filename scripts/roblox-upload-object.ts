/// Upload one object GLB to Roblox as a Model asset.
/// The publish script passes the key in ROBLOX_API_KEY; this script never reads or prints a key file.
///   scripts/roblox-publish.sh --upload-object <glb> [name]
import { readFile } from 'node:fs/promises';
import { RobloxAssetUploader } from '../server/social/roblox-model.ts';

const [file, name = 'DejaView object'] = process.argv.slice(2);
if (!file) throw new Error('usage: bun scripts/roblox-upload-object.ts <glb> [name]');
const apiKey = process.env.ROBLOX_API_KEY?.trim();
if (!apiKey) throw new Error('ROBLOX_API_KEY is missing');
let creatorId = process.env.ROBLOX_CREATOR_ID?.trim();
if (!creatorId) {
  const user = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: ['VvortexX56'], excludeBannedUsers: true }),
  });
  const found = (await user.json()) as { data?: Array<{ id?: number }> };
  creatorId = String(found.data?.[0]?.id ?? '');
  if (!creatorId) throw new Error('could not resolve the Roblox creator id');
}
const uploader = new RobloxAssetUploader({ apiKey, creatorId, creatorType: 'user' });
const bytes = new Uint8Array(await readFile(file));
console.log(`uploading ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
const result = await uploader.upload(bytes, name, 'DejaView object mesh from the scan');
console.log(`asset ${result.assetId}`);
