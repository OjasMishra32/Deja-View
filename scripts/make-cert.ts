// Self-signed TLS certificate for the dev server, so the Quest Browser gets a secure context (WebXR) over the LAN.
//
//   bun run cert            create certs/cert.pem + certs/key.pem (kept if they still cover every LAN address)
//   bun run cert --force    always make a new one

import { mkdir, rm } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const CERTS = join(ROOT, 'certs');
const CERT = join(CERTS, 'cert.pem');
const KEY = join(CERTS, 'key.pem');
const PORT = Number(process.env.PORT || 8787);
const OPENSSL = process.env.OPENSSL_BIN || (Bun.which('openssl', { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin' }) ?? 'openssl');
const force = process.argv.includes('--force');

function lanIPv4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return [...new Set(out)];
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([OPENSSL, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

const ips = lanIPv4();
const host = hostname().replace(/\.local$/, '');
const dns = ['localhost', `${host}.local`];
const san = [...dns.map((d) => `DNS:${d}`), 'IP:127.0.0.1', 'IP:::1', ...ips.map((ip) => `IP:${ip}`)].join(',');

let reuse = false;
if (!force && (await Bun.file(CERT).exists()) && (await Bun.file(KEY).exists())) {
  const ext = await run(['x509', '-in', CERT, '-noout', '-ext', 'subjectAltName']);
  const fresh = await run(['x509', '-in', CERT, '-noout', '-checkend', String(7 * 86400)]);
  reuse = ext.code === 0 && fresh.code === 0 && ips.every((ip) => ext.out.includes(`IP Address:${ip}`));
}

if (!reuse) {
  await mkdir(CERTS, { recursive: true });
  await rm(CERT, { force: true });
  await rm(KEY, { force: true });
  const r = await run([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '397',
    '-keyout', KEY, '-out', CERT,
    '-subj', '/CN=ThirdWheel dev server/O=ThirdWheel',
    '-addext', `subjectAltName=${san}`,
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
  ]);
  if (r.code !== 0) {
    console.error(`openssl failed:\n${r.out}`);
    process.exit(1);
  }
}

const fp = await run(['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256', '-enddate']);
const lines = fp.out.trim().split('\n');

console.log(`${reuse ? 'Keeping' : 'Created'} ${CERT}`);
console.log(`  covers   localhost, 127.0.0.1, ::1, ${dns[1]}${ips.length ? ', ' + ips.join(', ') : ''}`);
for (const l of lines) console.log(`  ${l.replace('sha256 Fingerprint=', 'sha256   ').replace('notAfter=', 'expires  ')}`);
console.log(`
Quest 3S
  1. Put the headset on the same Wi-Fi as this Mac.
  2. Start the server with HTTPS:   bun run https
  3. In the Quest Browser open:     ${ips.length ? ips.map((ip) => `https://${ip}:${PORT}`).join('  or  ') : `https://<this Mac's LAN IP>:${PORT}`}
  4. "Your connection is not private": tap Advanced, then "Proceed to ... (unsafe)". This is needed once per certificate.
  5. Open a scene and tap Enter VR.
  No Wi-Fi? Plug the Quest in with USB, run  adb reverse tcp:${PORT} tcp:${PORT}  and open http://localhost:${PORT}
  (localhost is a secure context, so no certificate is needed).
  Run this again when the Mac gets a new LAN address (it keeps the certificate if nothing changed).`);
