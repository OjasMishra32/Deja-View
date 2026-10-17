// HealthInfo with cached probes: HPG socket (10 s), HPG worker heartbeat (30 s), FlashWorld Space (60 s).

import { networkInterfaces } from 'node:os';
import type { HealthInfo } from '../shared/types.ts';
import { hpgConfig, offlineReason, socketAlive, workerAlive, type HpgConfig, type WorkerStatus } from './hpg.ts';

export interface Cached<T> {
  get(force?: boolean): Promise<T>;
  peek(): T | undefined;
}

/** Memoizes an async probe for `ttlMs`; concurrent callers share one in-flight probe. */
export function cached<T>(ttlMs: number, fn: () => Promise<T>): Cached<T> {
  let value: T | undefined;
  let at = 0;
  let inflight: Promise<T> | null = null;
  return {
    async get(force = false) {
      if (!force && value !== undefined && Date.now() - at < ttlMs) return value;
      if (inflight) return inflight;
      inflight = fn()
        .then((v) => {
          value = v;
          at = Date.now();
          return v;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    peek: () => value,
  };
}

/** Non-internal IPv4 addresses, private LAN ranges first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

export interface SpaceStatus {
  available: boolean;
  stage?: string;
  reason?: string;
}

export interface HealthOptions {
  version: string;
  https: boolean;
  port: number;
  hpg?: () => HpgConfig;
  space: () => Promise<SpaceStatus>;
  local: () => Promise<boolean>;
}

export class HealthMonitor {
  readonly hpgOnline: Cached<{ online: boolean; reason?: string }>;
  readonly worker: Cached<WorkerStatus>;
  readonly space: Cached<SpaceStatus>;

  constructor(private opts: HealthOptions) {
    const cfg = opts.hpg ?? (() => hpgConfig());
    this.hpgOnline = cached(10_000, async () => {
      const c = cfg();
      const online = await socketAlive(c);
      return online ? { online } : { online, reason: offlineReason(c) };
    });
    this.worker = cached(30_000, async () => ((await this.hpgOnline.get()).online ? workerAlive(cfg()) : { alive: false }));
    this.space = cached(60_000, () => opts.space().catch((e) => ({ available: false, reason: String(e?.message ?? e) })));
  }

  lanUrls(): string[] {
    const proto = this.opts.https ? 'https' : 'http';
    return lanAddresses().map((ip) => `${proto}://${ip}:${this.opts.port}`);
  }

  async info(force = false): Promise<HealthInfo> {
    const [hpg, worker, space, local] = await Promise.all([
      this.hpgOnline.get(force),
      this.worker.get(force),
      this.space.get(force),
      this.opts.local().catch(() => false),
    ]);
    const c = (this.opts.hpg ?? (() => hpgConfig()))();
    return {
      ok: true,
      version: this.opts.version,
      https: this.opts.https,
      lan: this.lanUrls(),
      hpg: {
        online: hpg.online,
        user: c.user,
        worker: {
          alive: worker.alive,
          ...(worker.host ? { host: worker.host } : {}),
          ...(worker.gpu ? { gpu: worker.gpu } : {}),
          ...(worker.lastBeat ? { lastBeat: worker.lastBeat } : {}),
        },
      },
      space: { available: space.available },
      local: { python: local },
    };
  }
}
