import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';

const result = spawnSync(ffmpeg, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
