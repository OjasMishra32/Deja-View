// scripts/tunnel.ts: URL parsing, the install hint, and the restart loop with a fake cloudflared.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloudflaredArgs, parseTunnelUrl, tunnelEnv, tunnelOptionsFromEnv } from '../scripts/tunnel.ts';

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'tunnel.ts');
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dv-tunnel-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('parsing cloudflared output', () => {
  test('finds the quick-tunnel address in the banner line', () => {
    expect(parseTunnelUrl('2026-10-17T14:02:19Z INF |  https://gentle-rivers-sing-quietly.trycloudflare.com                    |')).toBe(
      'https://gentle-rivers-sing-quietly.trycloudflare.com',
    );
    expect(parseTunnelUrl('visit https://Abc-123.TryCloudflare.com/view')).toBe('https://abc-123.trycloudflare.com');
  });

  test("ignores the service's own api host and unrelated lines", () => {
    expect(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp')).toBeNull();
    expect(parseTunnelUrl('INF Registered tunnel connection connIndex=0')).toBeNull();
    expect(parseTunnelUrl('http://plain.trycloudflare.com')).toBeNull();
  });

  test('arguments: quick tunnel, https origin, named tunnel', () => {
    expect(cloudflaredArgs('http://localhost:8788', null)).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://localhost:8788']);
    expect(cloudflaredArgs('https://localhost:8787', null)).toEqual(['tunnel', '--no-autoupdate', '--no-tls-verify', '--url', 'https://localhost:8787']);
    expect(cloudflaredArgs('http://localhost:8788', 'dejaview')).toEqual(['tunnel', '--no-autoupdate', 'run', '--url', 'http://localhost:8788', 'dejaview']);
    // the domain's dashboard tunnel: the token goes in cloudflared's own TUNNEL_TOKEN, never on the command line
    expect(cloudflaredArgs('http://localhost:8788', null, true)).toEqual(['tunnel', '--no-autoupdate', 'run']);
    const env = tunnelEnv({ PATH: '/bin', TUNNEL_TOKEN_FILE: '/x', TUNNEL_TOKEN: 'old' }, 'tok-123');
    expect(env).toEqual({ PATH: '/bin', TUNNEL_TOKEN: 'tok-123' });
    expect(tunnelEnv({ PATH: '/bin', TUNNEL_TOKEN: 'leftover' }, null)).toEqual({ PATH: '/bin' });
  });

  test('the token comes from TUNNEL_TOKEN or a file; an unreadable file is an error', async () => {
    const f = join(root, 'token.txt');
    await writeFile(f, '  eyJhIjoi-token  \n');
    expect(tunnelOptionsFromEnv({ PATH: '/nowhere', TUNNEL_TOKEN_FILE: f, TUNNEL_HOSTNAME: 'https://dejaview.example.com/' })).toMatchObject({ token: 'eyJhIjoi-token', hostname: 'dejaview.example.com' });
    expect(tunnelOptionsFromEnv({ PATH: '/nowhere', TUNNEL_TOKEN: 'direct' }).token).toBe('direct');
    const missing = tunnelOptionsFromEnv({ PATH: '/nowhere', TUNNEL_TOKEN_FILE: join(root, 'nope.txt') });
    expect(missing.token).toBeNull();
    expect(missing.tokenError).toContain('nope.txt');
  });

  test('options from the environment', () => {
    const o = tunnelOptionsFromEnv({ PATH: '/nowhere', THIRDWHEEL_DATA: '/tmp/dv-data', TUNNEL_TARGET: 'http://localhost:8788/' });
    expect(o.bin).toBeNull();
    expect(o.target).toBe('http://localhost:8788');
    expect(o.urlFile).toBe('/tmp/dv-data/public-url.txt');
  });
});

async function runScript(env: Record<string, string>, ms = 5000) {
  const p = Bun.spawn([process.execPath, SCRIPT], { env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill('SIGKILL'), ms);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { out, err, code };
}

describe('the tunnel script', () => {
  test('cloudflared missing: prints the one-line install command and exits non-zero', async () => {
    const a = await runScript({ PATH: '/usr/bin:/bin', HOME: root });
    expect(a.code).not.toBe(0);
    expect(a.err).toContain('brew install cloudflared');
    const b = await runScript({ PATH: '/usr/bin:/bin', HOME: root, CLOUDFLARED_BIN: join(root, 'nope', 'cloudflared') });
    expect(b.code).not.toBe(0);
    expect(b.err).toContain('brew install cloudflared');
  });

  test('writes the address, prints it, restarts cloudflared when it dies, and cleans up on stop', async () => {
    const fake = join(root, 'cloudflared');
    const args = join(root, 'args.txt');
    const count = join(root, 'count.txt');
    const pidFile = join(root, 'pid.txt');
    const urlFile = join(root, 'data', 'public-url.txt');
    await writeFile(
      fake,
      [
        '#!/bin/sh',
        `echo "$@" >> "${args}"`,
        `n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"`,
        'echo "2026-10-17T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
        'echo "2026-10-17T00:00:00Z INF |  https://fake-run-$n.trycloudflare.com                |" >&2',
        'echo "2026-10-17T00:00:01Z INF Registered tunnel connection connIndex=0 location=mia01" >&2',
        'if [ "$n" -lt 2 ]; then sleep 1; echo "2026-10-17T00:00:02Z ERR connection lost" >&2; exit 1; fi',
        `echo $$ > "${pidFile}"`,
        'exec sleep 30',
      ].join('\n'),
    );
    await chmod(fake, 0o755);
    const p = Bun.spawn([process.execPath, SCRIPT], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        CLOUDFLARED_BIN: fake,
        TUNNEL_URL_FILE: urlFile,
        TUNNEL_TARGET: 'http://127.0.0.1:9',
        TUNNEL_PROBE: '0',
        TUNNEL_MIN_RESTART_MS: '200',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const outP = new Response(p.stdout).text();
    let url = '';
    for (let i = 0; i < 100 && url !== 'https://fake-run-2.trycloudflare.com'; i++) {
      await Bun.sleep(50);
      url = existsSync(urlFile) ? (await readFile(urlFile, 'utf8')).trim() : '';
    }
    expect(url).toBe('https://fake-run-2.trycloudflare.com');
    const lines = (await readFile(args, 'utf8')).trim().split('\n');
    expect(lines).toEqual(['tunnel --no-autoupdate --url http://127.0.0.1:9', 'tunnel --no-autoupdate --url http://127.0.0.1:9']);
    const childPid = Number((await readFile(pidFile, 'utf8')).trim());
    p.kill('SIGTERM');
    const code = await p.exited;
    const out = await outP;
    expect(code).toBe(0);
    expect(out).toContain('DÉJÀ VIEW IS PUBLIC');
    expect(out).toContain('https://fake-run-1.trycloudflare.com');
    expect(out).toContain('https://fake-run-2.trycloudflare.com');
    expect(out).toContain('restarting in 0.2 s');
    expect(out).toContain('connection lost');
    expect(existsSync(urlFile)).toBe(false);
    await Bun.sleep(100);
    expect(() => process.kill(childPid, 0)).toThrow(); // cloudflared was stopped with us
  }, 15_000);

  test('with the domain token: runs `tunnel run` with the token in the environment and publishes the fixed hostname', async () => {
    const fake = join(root, 'cloudflared-token');
    const seen = join(root, 'token-seen.txt');
    const urlFile = join(root, 'data2', 'public-url.txt');
    const tokenFile = join(root, 'dash-token.txt');
    await writeFile(tokenFile, 'dash-token-xyz\n');
    await writeFile(
      fake,
      ['#!/bin/sh', `echo "args=$@ token=$TUNNEL_TOKEN" > "${seen}"`, 'echo "2026-10-17T00:00:01Z INF Registered tunnel connection connIndex=0" >&2', 'exec sleep 30'].join('\n'),
    );
    await chmod(fake, 0o755);
    const p = Bun.spawn([process.execPath, SCRIPT], {
      env: { PATH: '/usr/bin:/bin', HOME: root, CLOUDFLARED_BIN: fake, TUNNEL_URL_FILE: urlFile, TUNNEL_TARGET: 'http://127.0.0.1:9', TUNNEL_PROBE: '0', TUNNEL_TOKEN_FILE: tokenFile, TUNNEL_HOSTNAME: 'dejaview.example.com' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const outP = new Response(p.stdout).text();
    for (let i = 0; i < 100 && !(existsSync(seen) && existsSync(urlFile)); i++) await Bun.sleep(50);
    expect((await readFile(urlFile, 'utf8')).trim()).toBe('https://dejaview.example.com');
    expect((await readFile(seen, 'utf8')).trim()).toBe('args=tunnel --no-autoupdate run token=dash-token-xyz');
    p.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    const out = await outP;
    expect(out).toContain('https://dejaview.example.com');
    expect(out).not.toContain('dash-token-xyz');
    // a token without the hostname it serves is refused
    const bad = await runScript({ PATH: '/usr/bin:/bin', HOME: root, CLOUDFLARED_BIN: fake, TUNNEL_TOKEN: 'x' });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('TUNNEL_HOSTNAME');
  }, 15_000);
});
