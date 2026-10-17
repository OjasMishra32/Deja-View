// Presence history for replays and heatmaps, kept in Postgres. On Tiger Data (TimescaleDB) the samples live in a
// hypertable, a continuous aggregate keeps a one-second track of everyone, and old chunks are compressed. On plain
// Postgres (local tests, a laptop fallback) the same questions are answered from the raw table, just more slowly.
//
// Everything is in the room frame, metres (team/contracts.md 3.1); times on the way in and out are Unix milliseconds.
//
//   dv_presence     t, scene_id, person_id, name, kind, x, y, z, yaw     one row per person per presence snapshot
//   dv_moments      t, scene_id, type, body (jsonb)                       Roblox tags and rounds, host cues
//   dv_presence_1s  scene_id, person_id, bucket, name, kind, x, y, z, yaw, n   (Tiger Data only) the per-second track

import { SQL } from 'bun';

export interface Sample {
  /** Unix milliseconds. */
  t: number;
  sceneId: string;
  personId: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface Moment {
  t: number;
  sceneId: string;
  type: string;
  body: Record<string, unknown>;
}

/** What the database can do. Everything but `postgres` stays false on plain Postgres. */
export interface Features {
  postgres: string;
  /** TimescaleDB version, or null. */
  timescale: string | null;
  hypertable: boolean;
  aggregate: boolean;
  compression: boolean;
}

/** One person's path, column by column (smaller on the wire than an object per sample). */
export interface Track {
  id: string;
  name: string;
  kind: string;
  /** Milliseconds after the replay's `from`. */
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  yaw: number[];
}

export interface HeatCell {
  /** Cell index on the floor: the cell covers [ix * cell, (ix + 1) * cell) in x, the same for z. */
  ix: number;
  iz: number;
  /** Person-seconds spent in the cell. */
  seconds: number;
  /** Different people seen in the cell. */
  people: number;
}

export interface Session {
  from: number;
  to: number;
  /** Seconds with at least one person in the memory. */
  seconds: number;
  names: string[];
}

export interface ReplayDb {
  readonly features: Features;
  insertSamples(rows: Sample[]): Promise<void>;
  insertMoments(rows: Moment[]): Promise<void>;
  tracks(sceneId: string, from: number, to: number, stepMs: number): Promise<Track[]>;
  moments(sceneId: string, from: number, to: number): Promise<Moment[]>;
  heat(sceneId: string, from: number, to: number, cell: number): Promise<HeatCell[]>;
  sessions(sceneId: string, gapSeconds?: number, limit?: number): Promise<Session[]>;
  /** Samples in a time range (to size a replay before fetching it). */
  count(sceneId: string, from: number, to: number): Promise<number>;
  close(): Promise<void>;
}

const BASE_DDL = [
  `CREATE TABLE IF NOT EXISTS dv_presence (
     t timestamptz NOT NULL,
     scene_id text NOT NULL,
     person_id text NOT NULL,
     name text NOT NULL,
     kind text NOT NULL,
     x real NOT NULL,
     y real NOT NULL,
     z real NOT NULL,
     yaw real NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS dv_presence_scene_t ON dv_presence (scene_id, t DESC)`,
  `CREATE TABLE IF NOT EXISTS dv_moments (
     t timestamptz NOT NULL,
     scene_id text NOT NULL,
     type text NOT NULL,
     body jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS dv_moments_scene_t ON dv_moments (scene_id, t DESC)`,
];

const HYPERTABLE_DDL = [
  `SELECT create_hypertable('dv_presence', by_range('t', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE)`,
  `SELECT create_hypertable('dv_moments', by_range('t', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE)`,
];

// Real-time (materialized_only = false): the newest seconds come from the raw table until the policy catches up, so a
// replay of the round that just ended is complete.
const AGGREGATE_DDL = [
  `CREATE MATERIALIZED VIEW IF NOT EXISTS dv_presence_1s
     WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
     SELECT scene_id, person_id, time_bucket(INTERVAL '1 second', t) AS bucket,
            last(name, t) AS name, last(kind, t) AS kind,
            avg(x)::real AS x, avg(y)::real AS y, avg(z)::real AS z, last(yaw, t) AS yaw, count(*) AS n
     FROM dv_presence
     GROUP BY scene_id, person_id, bucket
     WITH NO DATA`,
  `SELECT add_continuous_aggregate_policy('dv_presence_1s',
     start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
     schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)`,
];

// TimescaleDB 2.18 renamed compression to the columnstore; the old names still work there, the new ones are the retry.
const COMPRESSION_DDL: string[][] = [
  [
    `ALTER TABLE dv_presence SET (timescaledb.compress, timescaledb.compress_segmentby = 'scene_id, person_id', timescaledb.compress_orderby = 't DESC')`,
    `SELECT add_compression_policy('dv_presence', compress_after => INTERVAL '2 days', if_not_exists => TRUE)`,
  ],
  [
    `ALTER TABLE dv_presence SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'scene_id, person_id', timescaledb.orderby = 't DESC')`,
    `CALL add_columnstore_policy('dv_presence', after => INTERVAL '2 days', if_not_exists => TRUE)`,
  ],
];

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;
const ms = (d: unknown) => (d instanceof Date ? d.getTime() : Number(d));

/** True for a connection string that asks for TLS (Tiger Cloud's do: `?sslmode=require`). */
export function wantsTls(url: string): boolean {
  return /[?&]sslmode=(require|verify-ca|verify-full)\b/i.test(url);
}

/** The connection string without its password, for logs and the status route. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return '(unreadable connection string)';
  }
}

/** Opens the database, creates what is missing and returns the queries. Throws when the database cannot be reached. */
export async function openReplayDb(url: string, opts: { log?: (msg: string) => void; max?: number } = {}): Promise<ReplayDb> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const sql = new SQL({ url, max: opts.max ?? 4, idleTimeout: 30, connectionTimeout: 10, ...(wantsTls(url) ? { tls: true } : {}) });
  try {
    const features = await migrate(sql, log);
    return makeDb(sql, features);
  } catch (e) {
    await sql.close({ timeout: 1 }).catch(() => {});
    throw e;
  }
}

async function migrate(sql: SQL, log: (msg: string) => void): Promise<Features> {
  const [{ server_version }] = await sql`SHOW server_version`;
  const features: Features = { postgres: String(server_version), timescale: null, hypertable: false, aggregate: false, compression: false };

  // The extension comes first: create_hypertable migrates rows, but an empty table is the clean case.
  try {
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS timescaledb');
  } catch {
    // plain Postgres: the extension is not installed, which is fine
  }
  const ext = await sql`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`;
  features.timescale = ext[0]?.extversion ?? null;

  for (const ddl of BASE_DDL) await sql.unsafe(ddl);
  if (!features.timescale) return features;

  try {
    for (const ddl of HYPERTABLE_DDL) await sql.unsafe(ddl);
    features.hypertable = true;
  } catch (e) {
    log(`[replay] hypertables not created: ${(e as Error).message}`);
    return features;
  }
  try {
    for (const ddl of AGGREGATE_DDL) await sql.unsafe(ddl);
    features.aggregate = true;
  } catch (e) {
    log(`[replay] continuous aggregate not created: ${(e as Error).message}`);
  }
  for (const attempt of COMPRESSION_DDL) {
    try {
      for (const ddl of attempt) await sql.unsafe(ddl);
      features.compression = true;
      break;
    } catch (e) {
      // already compressed with these settings, or the other spelling is needed
      if (/already/i.test((e as Error).message)) {
        features.compression = true;
        break;
      }
    }
  }
  if (!features.compression) log('[replay] compression policy not set (the replays work without it)');
  return features;
}

function makeDb(sql: SQL, features: Features): ReplayDb {
  const ts = !!features.timescale;
  const agg = features.aggregate;

  /** The per-second track of a scene, as a subquery: the continuous aggregate on Tiger Data, the raw table otherwise. */
  const perSecond = (sceneId: string, from: Date, to: Date) =>
    agg
      ? sql`SELECT bucket, person_id, name, kind, x, z FROM dv_presence_1s
            WHERE scene_id = ${sceneId} AND bucket >= ${from} AND bucket < ${to}`
      : sql`SELECT date_bin(INTERVAL '1 second', t, TIMESTAMPTZ 'epoch') AS bucket, person_id,
                   (array_agg(name ORDER BY t DESC))[1] AS name, (array_agg(kind ORDER BY t DESC))[1] AS kind,
                   avg(x) AS x, avg(z) AS z
            FROM dv_presence WHERE scene_id = ${sceneId} AND t >= ${from} AND t < ${to}
            GROUP BY 1, 2`;

  return {
    features,

    async insertSamples(rows) {
      if (!rows.length) return;
      const values = rows.map((s) => ({
        t: new Date(s.t),
        scene_id: s.sceneId,
        person_id: s.personId,
        name: s.name,
        kind: s.kind,
        x: s.x,
        y: s.y,
        z: s.z,
        yaw: s.yaw,
      }));
      await sql`INSERT INTO dv_presence ${sql(values)}`;
    },

    async insertMoments(rows) {
      if (!rows.length) return;
      const values = rows.map((m) => ({ t: new Date(m.t), scene_id: m.sceneId, type: m.type, body: m.body }));
      await sql`INSERT INTO dv_moments ${sql(values)}`;
    },

    async tracks(sceneId, from, to, stepMs) {
      const step = `${Math.max(1, Math.round(stepMs))} milliseconds`;
      const f = new Date(from);
      const e = new Date(to);
      const rows: { b: Date; person_id: string; name: string; kind: string; x: number; y: number; z: number; yaw: number }[] = ts
        ? await sql`SELECT time_bucket(${step}::interval, t) AS b, person_id, last(name, t) AS name, last(kind, t) AS kind,
                           avg(x) AS x, avg(y) AS y, avg(z) AS z, last(yaw, t) AS yaw
                    FROM dv_presence WHERE scene_id = ${sceneId} AND t >= ${f} AND t < ${e}
                    GROUP BY b, person_id ORDER BY b`
        : await sql`SELECT date_bin(${step}::interval, t, TIMESTAMPTZ 'epoch') AS b, person_id,
                           (array_agg(name ORDER BY t DESC))[1] AS name, (array_agg(kind ORDER BY t DESC))[1] AS kind,
                           avg(x) AS x, avg(y) AS y, avg(z) AS z, (array_agg(yaw ORDER BY t DESC))[1] AS yaw
                    FROM dv_presence WHERE scene_id = ${sceneId} AND t >= ${f} AND t < ${e}
                    GROUP BY b, person_id ORDER BY b`;
      const byId = new Map<string, Track>();
      for (const r of rows) {
        let tr = byId.get(r.person_id);
        if (!tr) byId.set(r.person_id, (tr = { id: r.person_id, name: r.name, kind: r.kind, t: [], x: [], y: [], z: [], yaw: [] }));
        tr.name = r.name;
        tr.t.push(ms(r.b) - from);
        tr.x.push(r2(Number(r.x)));
        tr.y.push(r2(Number(r.y)));
        tr.z.push(r2(Number(r.z)));
        tr.yaw.push(r3(Number(r.yaw)));
      }
      return [...byId.values()];
    },

    async moments(sceneId, from, to) {
      const rows: { t: Date; type: string; body: Record<string, unknown> }[] =
        await sql`SELECT t, type, body FROM dv_moments
                  WHERE scene_id = ${sceneId} AND t >= ${new Date(from)} AND t < ${new Date(to)} ORDER BY t LIMIT 500`;
      return rows.map((r) => ({ t: ms(r.t), sceneId, type: r.type, body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body }));
    },

    async heat(sceneId, from, to, cell) {
      const rows: { ix: number; iz: number; seconds: string | number; people: string | number }[] = await sql`
        SELECT floor(x / ${cell})::int AS ix, floor(z / ${cell})::int AS iz, count(*) AS seconds, count(DISTINCT person_id) AS people
        FROM (${perSecond(sceneId, new Date(from), new Date(to))}) p
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 4000`;
      return rows.map((r) => ({ ix: r.ix, iz: r.iz, seconds: Number(r.seconds), people: Number(r.people) }));
    },

    async sessions(sceneId, gapSeconds = 60, limit = 20) {
      const rows: { from: Date; to: Date; seconds: string | number; names: string[] }[] = await sql`
        WITH p AS (${perSecond(sceneId, new Date(0), new Date(Date.now() + 86_400_000))}),
             b AS (SELECT DISTINCT bucket FROM p),
             g AS (SELECT bucket, CASE WHEN bucket - lag(bucket) OVER (ORDER BY bucket) > make_interval(secs => ${gapSeconds})
                                       THEN 1 ELSE 0 END AS brk FROM b),
             k AS (SELECT bucket, sum(brk) OVER (ORDER BY bucket) AS sess FROM g)
        SELECT min(k.bucket) AS "from", max(k.bucket) AS "to", count(DISTINCT k.bucket) AS seconds,
               array_agg(DISTINCT p.name) AS names
        FROM k JOIN p USING (bucket)
        GROUP BY k.sess ORDER BY 1 DESC LIMIT ${limit}`;
      // `to` is the start of the last second with someone in it: the session runs to the end of that second
      return rows.map((r) => ({ from: ms(r.from), to: ms(r.to) + 1000, seconds: Number(r.seconds), names: (r.names ?? []).filter(Boolean).sort() }));
    },

    async count(sceneId, from, to) {
      const [r] = await sql`SELECT count(*) AS n FROM dv_presence WHERE scene_id = ${sceneId} AND t >= ${new Date(from)} AND t < ${new Date(to)}`;
      return Number(r?.n ?? 0);
    },

    async close() {
      await sql.close({ timeout: 2 });
    },
  };
}
