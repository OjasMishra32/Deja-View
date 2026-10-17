// Both teammate stand-ins in one process, for a full run on one laptop without the real services:
//
//   bun run demo:mocks            live map service on :8794, guide on :8795
//
// then start the server against them with the env line this prints. DS_MOCK_PORT / GUIDE_MOCK_PORT move them,
// DS_KEY sets the map service's key (default dev-ds-key), GUIDE_KEY makes the guide require one.
// Ctrl-C stops both.

import { connect } from 'node:net';
import { startMockDeepSpace } from '../tests/harness/mock-deepspace.ts';
import { startMockGuide } from '../tests/harness/mock-guide.ts';

/** Something already answers on this port (IPv4 or IPv6 loopback). */
function busy(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (v: boolean) => {
        s.destroy();
        resolve(v);
      };
      s.setTimeout(400, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b);
}

const dsPort = Number(process.env.DS_MOCK_PORT || 8794);
const guidePort = Number(process.env.GUIDE_MOCK_PORT || 8795);
const dsKey = process.env.DS_KEY || 'dev-ds-key';

for (const [name, port] of [['DS_MOCK_PORT', dsPort], ['GUIDE_MOCK_PORT', guidePort]] as const) {
  if (await busy(port)) {
    console.error(`Port ${port} is already in use. Stop whatever runs there, or pick another: ${name}=<port> bun run demo:mocks`);
    process.exit(1);
  }
}

const ds = startMockDeepSpace({ port: dsPort, key: dsKey, hostname: '127.0.0.1' });
const guide = startMockGuide({ port: guidePort, hostname: '127.0.0.1' });

console.log('\nStand-ins running:');
console.log(`  live map service  ${ds.url}   (map page: ${ds.url}/?dv=http://localhost:8787)`);
console.log(`  guide             ${guide.url}   (canned answers, real speech)`);
console.log('\nStart the server against them:');
console.log(`  DS_URL=${ds.url} DS_KEY=${dsKey} GUIDE_URL=${guide.url}${process.env.GUIDE_KEY ? ' GUIDE_KEY=<the same key>' : ''} THIRDWHEEL_HPG=off bun run dev\n`);

const stop = () => {
  ds.stop();
  guide.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
