// Describes a Video memory (again) from its clip, for "who won?" (team/brianna.md Update 3): up to 8 frames go to
// the guide's POST /describe, and its caption becomes the scene's caption, which /ask then gets as scene.caption.
// Nothing but the guide and the data folder is involved: no admin route, no key for the server. A running server
// picks the new caption up on its next read of scene.json (the store re-reads a file that changed).
//
//   bun scripts/describe-clip.ts <scene id> [--video <file>] [--dry-run]     (or: bun run describe:clip <scene id>)
//
//   --video <file>   describe this clip instead of the scene's own (its uploaded video, else its video layer)
//   --dry-run        print the caption and change nothing
//
// Environment: GUIDE_URL and GUIDE_KEY as for the server (Bun reads .env), GUIDE_DESCRIBE_CLIP_TIMEOUT_MS,
// THIRDWHEEL_DATA. Exits 1 when no caption came back (the scene is left as it was).

import { join, resolve } from 'node:path';
import { isVideoScene } from '../server/copy.ts';
import { dataDir, hostOf, integrationsConfigFromEnv, prefixedLogger } from '../server/integrations/config.ts';
import { clipForScene, describeClipForJob } from '../server/integrations/describe.ts';
import { createGuideClient } from '../server/integrations/guide.ts';
import { SceneStore } from '../server/store.ts';

const USAGE = 'usage: bun scripts/describe-clip.ts <scene id> [--video <file>] [--dry-run]';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
let id = '';
let videoArg = '';
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--dry-run') dryRun = true;
  else if (a === '--video') videoArg = args[++i] ?? fail(USAGE);
  else if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (!a.startsWith('-') && !id) id = a;
  else fail(USAGE);
}
if (!id) fail(USAGE);

const store = new SceneStore(join(dataDir(), 'scenes'));
const scene = await store.get(id);
if (!scene) fail(`No scene "${id}" in ${store.dir}`);
if (!isVideoScene(scene) && !videoArg) fail(`${id} is a Photo world; pass --video <file> to describe a clip for it anyway`);

const sceneDir = store.sceneDir(id);
const clip = videoArg ? { path: resolve(videoArg), packed: false } : clipForScene(scene, sceneDir);
if (!clip) fail(`${id} has no clip on disk (no uploaded video, no video layer); pass --video <file>`);
if (!(await Bun.file(clip.path).exists())) fail(`No such file: ${clip.path}`);

const config = integrationsConfigFromEnv();
if (!config.guide.url) fail('GUIDE_URL is not set (put it in .env or the environment)');
const log = prefixedLogger('guide');
const client = createGuideClient({ config: config.guide, log });
const thumb = scene.thumb ? join(sceneDir, scene.thumb) : undefined;
console.log(`Describing ${id} from ${clip.path.split('/').slice(-3).join('/')} with the guide at ${hostOf(config.guide.url)}...`);
const t0 = Date.now();
const caption = await describeClipForJob(clip.path, scene, {
  client,
  timeoutMs: config.guide.timeouts.describeClip,
  imagePath: thumb && (await Bun.file(thumb).exists()) ? thumb : undefined,
  packed: clip.packed,
  log,
});
client.close();
if (!caption) fail(`No caption after ${Date.now() - t0} ms (guide down, slow or degraded, or the clip is unreadable); ${id} is unchanged`);

console.log(`Caption (${Date.now() - t0} ms): ${caption}`);
if (dryRun) {
  console.log('--dry-run: scene.json not changed');
} else {
  const next = await store.update(id, (s) => ({ ...s, caption, captionSource: 'guide' }));
  if (!next) fail(`${id} was deleted meanwhile`);
  console.log(`Saved as ${id}'s caption: /ask now gets it as scene.caption`);
}
