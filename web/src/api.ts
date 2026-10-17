// Typed client for the HTTP API and the /ws event stream (docs/ARCHITECTURE.md).

import type { HealthInfo, Scene, SceneMode, ServerEvent } from '../../shared/types.ts';
import { authHeaders } from './auth.ts';

export type { HealthInfo, Scene, SceneMode, ServerEvent };

/**
 * The two modes a person can pick, as the upload API names them:
 *   photo  one photo (or a prompt) becomes a world you walk into
 *   video  a still-camera video becomes a room with the real footage in 3D
 */
export type UploadMode = 'photo' | 'video';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    /** Technical details the server sent next to its message, for a collapsed block. */
    readonly details = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let apiBase = '';

/** Prefix for every request. Empty means same origin. */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, '');
}

export function apiUrl(path: string): string {
  return apiBase + path;
}

/** A details value as text: a string, or lines of a string array. */
function detailString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join('\n').trim();
  return '';
}

/** The message and optional technical details of an error response body. */
export function errorFromBody(body: unknown): { message?: string; details: string } {
  if (!body) return { details: '' };
  if (typeof body === 'string') {
    // A bare text body is not ours (a proxy page, say); an HTML page is never worth showing.
    const text = body.trim();
    return { message: text && !text.startsWith('<') ? text.slice(0, 300) : undefined, details: '' };
  }
  if (typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const message = [b.error, b.message].find((v): v is string => typeof v === 'string' && !!v.trim());
    const details = detailString(b.details);
    const detail = detailString(b.detail);
    if (message) return { message, details: details || detail };
    if (detail) return { message: detail, details };
    return { details };
  }
  return { details: '' };
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // a change carries the sign-in (server/auth); nothing is added when signed out or sign-in is off
    const signed = init?.method && init.method !== 'GET' && init.method !== 'HEAD' ? authHeaders() : {};
    res = await fetch(apiUrl(path), { ...init, headers: { Accept: 'application/json', ...signed, ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("Can't reach the server. Check that it is still running, then try again.", 0);
  }
  const body = parseBody(await res.text());
  if (!res.ok) {
    const { message, details } = errorFromBody(body);
    throw new ApiError(message ?? `The server answered ${`${res.status} ${res.statusText}`.trim()}.`, res.status, body, details);
  }
  return body as T;
}

export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>('/api/health');
}

export async function listScenes(): Promise<Scene[]> {
  const body = await request<Scene[] | { scenes: Scene[] }>('/api/scenes');
  const scenes = Array.isArray(body) ? body : Array.isArray(body?.scenes) ? body.scenes : [];
  return sortScenes(scenes);
}

export function getScene(id: string): Promise<Scene> {
  return request<Scene>(`/api/scenes/${encodeURIComponent(id)}`);
}

export async function retryScene(id: string): Promise<Scene | undefined> {
  const body = await request<Scene | { scene: Scene } | undefined>(`/api/scenes/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });
  if (body && typeof body === 'object' && 'id' in body) return body as Scene;
  if (body && typeof body === 'object' && 'scene' in body) return (body as { scene: Scene }).scene;
  return undefined;
}

export async function deleteScene(id: string): Promise<void> {
  await request<unknown>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Newest first, matching the server's ordering. */
export function sortScenes(scenes: Scene[]): Scene[] {
  return [...scenes].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export interface UploadFile {
  blob: Blob;
  name: string;
}

export interface CreateSceneInput {
  mode: UploadMode;
  name: string;
  prompt?: string;
  files: UploadFile[];
}

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0..1, or NaN when the browser cannot tell. */
  fraction: number;
}

export interface UploadHandle {
  promise: Promise<Scene>;
  abort(): void;
}

/** What to say when an upload is refused and the server sent no message of its own. */
export function uploadStatusMessage(status: number, statusText = ''): string {
  if (status === 413) return 'That file is too big to upload. Trim the clip (10 to 30 s is plenty) or pick a smaller file.';
  if (status === 415) return 'The server does not accept that file type. Use a photo (JPEG, PNG, HEIC) or a video (MP4, MOV, WebM).';
  if (status === 429) return 'The server is busy with other uploads. Try again in a moment.';
  if (status >= 500) return `The server hit a problem with this upload (${status}). Try again in a moment.`;
  return `The upload was refused (${`${status} ${statusText}`.trim()}).`;
}

/**
 * POST /api/scenes as multipart with mode=photo or mode=video.
 * Uses XMLHttpRequest because fetch has no upload progress.
 */
export function createScene(input: CreateSceneInput, onProgress?: (p: UploadProgress) => void): UploadHandle {
  const req = new XMLHttpRequest();
  const promise = new Promise<Scene>((resolve, reject) => {
    const form = new FormData();
    form.append('mode', input.mode);
    form.append('name', input.name);
    if (input.prompt && input.prompt.trim()) form.append('prompt', input.prompt.trim());
    for (const f of input.files) form.append('files', f.blob, f.name);
    req.open('POST', apiUrl('/api/scenes'));
    req.setRequestHeader('Accept', 'application/json');
    for (const [k, v] of Object.entries(authHeaders())) req.setRequestHeader(k, v);
    req.upload.onprogress = (e) => {
      onProgress?.({ loaded: e.loaded, total: e.total, fraction: e.lengthComputable ? e.loaded / e.total : NaN });
    };
    req.onload = () => {
      const body = parseBody(req.responseText);
      if (req.status >= 200 && req.status < 300) {
        const scene = body && typeof body === 'object' && 'scene' in body ? (body as { scene: Scene }).scene : (body as Scene);
        if (scene && typeof scene === 'object' && typeof scene.id === 'string') resolve(scene);
        else reject(new ApiError('The server took the upload but sent nothing back. Check the gallery before trying again.', req.status, body));
      } else {
        const { message, details } = errorFromBody(body);
        reject(new ApiError(message ?? uploadStatusMessage(req.status, req.statusText), req.status, body, details));
      }
    };
    req.onerror = () => reject(new ApiError('The connection dropped during the upload. Check that this device is on the same Wi-Fi as the laptop, then try again.', 0));
    req.ontimeout = () => reject(new ApiError('The upload timed out. Try again on a stronger connection.', 0));
    req.onabort = () => reject(new ApiError('Upload cancelled.', 0));
    req.send(form);
  });
  return { promise, abort: () => req.abort() };
}

/** URL of a file inside a scene directory. */
export function sceneAssetUrl(sceneId: string, file: string): string {
  if (/^(https?:)?\/\//.test(file) || file.startsWith('/')) return file;
  const clean = file.replace(/^\.?\//, '').split('/').map(encodeURIComponent).join('/');
  return apiUrl(`/data/scenes/${encodeURIComponent(sceneId)}/${clean}`);
}

/** Directory URL with a trailing slash, as createVideoLayer expects for its baseUrl. */
export function sceneBaseUrl(sceneId: string): string {
  return apiUrl(`/data/scenes/${encodeURIComponent(sceneId)}/`);
}

export function viewUrl(sceneId: string): string {
  return `/view?scene=${encodeURIComponent(sceneId)}`;
}

/**
 * Full URLs another device on the same network can open.
 * HealthInfo.lan may hold bare addresses ("192.168.1.20"), host:port, or full URLs.
 */
export function lanUrls(health: HealthInfo | undefined, loc: { protocol: string; port: string } = location): string[] {
  const out: string[] = [];
  const scheme = health?.https ? 'https:' : loc.protocol;
  for (const raw of health?.lan ?? []) {
    const entry = String(raw).trim();
    if (!entry) continue;
    let url: string;
    if (/^https?:\/\//.test(entry)) url = entry.replace(/\/+$/, '');
    else if (/:\d+$/.test(entry) || entry.startsWith('[')) url = `${scheme}//${entry}`;
    else url = `${scheme}//${entry}${loc.port ? `:${loc.port}` : ''}`;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

type EventOf<K extends ServerEvent['type']> = Extract<ServerEvent, { type: K }>;

/**
 * /ws client that reconnects with jittered exponential backoff, and immediately when the
 * page becomes visible again or the network comes back.
 */
export class LiveEvents {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(ev: ServerEvent) => void>>();
  private stateHandlers = new Set<(s: ConnectionState, attempt: number) => void>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private _state: ConnectionState = 'closed';
  private readonly url: string;
  private readonly minDelay: number;
  private readonly maxDelay: number;

  constructor(opts: { url?: string; minDelay?: number; maxDelay?: number } = {}) {
    this.url = opts.url ?? LiveEvents.defaultUrl();
    this.minDelay = opts.minDelay ?? 500;
    this.maxDelay = opts.maxDelay ?? 10_000;
  }

  static defaultUrl(): string {
    if (apiBase) return apiBase.replace(/^http/, 'ws') + '/ws';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  get state(): ConnectionState {
    return this._state;
  }

  on<K extends ServerEvent['type']>(type: K, fn: (ev: EventOf<K>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const h = fn as (ev: ServerEvent) => void;
    set.add(h);
    return () => set!.delete(h);
  }

  onState(fn: (s: ConnectionState, attempt: number) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.onVisibility);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setState('closed');
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.kick();
  };

  /** Reconnect now if we are waiting on a backoff timer. */
  private kick = () => {
    if (!this.running || this.ws) return;
    clearTimeout(this.timer);
    this.connect();
  };

  private setState(s: ConnectionState) {
    this._state = s;
    for (const fn of this.stateHandlers) fn(s, this.attempt);
  }

  private connect() {
    if (!this.running) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      let ev: ServerEvent;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object' || typeof (ev as { type?: unknown }).type !== 'string') return;
      const set = this.handlers.get(ev.type);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(ev);
        } catch (err) {
          console.error('ws handler failed', err);
        }
      }
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (!this.running) return;
    this.attempt++;
    this.setState('closed');
    const base = Math.min(this.maxDelay, this.minDelay * 2 ** Math.min(this.attempt - 1, 8));
    const delay = base * (0.8 + Math.random() * 0.4);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}

// ---------------------------------------------------------------------------------------------
// Text from the server and the pipelines (stage lines, captions, errors) is written as product
// sentences at its source and shown as is. The page only folds technical output into a details
// block and never shows where files live on the server.

/**
 * Absolute filesystem paths, so they can be cut down to the file name. A POSIX path may contain
 * single spaces ("/Users/me/Application Support/x") as long as more path follows the space.
 */
const ABS_PATH =
  /(?<![\w.:/~-])(?:~?\/[^\s"'()<>[\]{},;|/]+\/[^\s"'()<>[\]{},;|]*(?: [^\s"'()<>[\]{},;|/]+\/[^\s"'()<>[\]{},;|]*)*|[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)+[^\\\s"'<>|]*)/g;

/** Replaces absolute server paths with their last component: "/srv/data/jobs/x/out" -> "out". */
export function hideServerPaths(text: string): string {
  return text.replace(ABS_PATH, (path) => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  });
}

/** Where tool output starts inside a message that has no separate details: a log tag, a traceback, or a new line. */
const TOOL_OUTPUT = /\s*\(?\s*\[[^\]\n]{1,80} @ 0x[0-9a-f]+\]|\s*\(?\s*Traceback \(most recent call last\)|\n/;

export interface ErrorText {
  /** The sentence a person reads. */
  headline: string;
  /** Technical output for a collapsed details block; empty when there is none. */
  detail: string;
}

/**
 * The readable sentence and the technical details of an error, with server paths removed.
 * When the server sends details separately they go in the details block as they are; otherwise a
 * trailing traceback or tool log in the message is folded away so the sentence stands alone.
 */
export function errorText(message: string | undefined | null, details?: string | null): ErrorText {
  const msg = hideServerPaths(String(message ?? '').trim());
  const extra = hideServerPaths(String(details ?? '').trim());
  if (extra) return { headline: clip(msg, 400), detail: extra === msg ? '' : extra };
  const m = TOOL_OUTPUT.exec(msg);
  if (!m || m.index < 8) return { headline: clip(msg, 400), detail: '' };
  let headline = msg.slice(0, m.index).replace(/[\s:;,(]+$/, '');
  let detail = msg.slice(m.index).trim().replace(/^\(\s*/, '');
  if (m[0].includes('(') && detail.endsWith(')')) detail = detail.slice(0, -1).trimEnd();
  if (!/[.!?]$/.test(headline)) headline += '.';
  return { headline: clip(headline, 400), detail };
}

/** Technical details a scene carries next to its error, under whichever name the server uses. */
export function sceneErrorDetails(scene: Scene): string {
  const s = scene as Scene & Record<string, unknown>;
  for (const key of ['errorDetails', 'errorDetail', 'details']) {
    const v = detailString(s[key]);
    if (v) return v;
  }
  return '';
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Modes as people see them: Photo and Video.

export type ModeKind = 'photo' | 'video' | 'sample';

/** Which of the two modes a scene belongs to. Several-photo reconstructions count as Photo. */
export function modeKind(mode: string | undefined): ModeKind {
  if (mode === 'thirdwheel' || mode === 'video') return 'video';
  if (mode === 'sample') return 'sample';
  return 'photo';
}

export const MODE_NAME: Record<ModeKind, string> = { photo: 'Photo', video: 'Video', sample: 'Sample' };

// ---------------------------------------------------------------------------------------------

/** Human summary of where jobs will run, for the compute strip. */
export interface HealthSummary {
  gpu: { ok: boolean; label: string; detail: string };
  worker: { ok: boolean; label: string; detail: string };
  fallbacks: { ok: boolean; label: string; detail: string };
}

export function summarizeHealth(h: HealthInfo | undefined): HealthSummary {
  if (!h) {
    return {
      gpu: { ok: false, label: 'GPU cluster', detail: 'checking' },
      worker: { ok: false, label: 'Warm GPU', detail: 'checking' },
      fallbacks: { ok: false, label: 'Backup', detail: 'checking' },
    };
  }
  const w = h.hpg?.worker;
  const fb: string[] = [];
  if (h.space?.available) fb.push('cloud GPU');
  if (h.local?.python) fb.push('this laptop');
  return {
    gpu: {
      ok: !!h.hpg?.online,
      label: 'GPU cluster',
      detail: h.hpg?.online ? 'online' : 'offline',
    },
    worker: {
      ok: !!w?.alive,
      label: 'Warm GPU',
      detail: w?.alive ? [w.gpu, w.host].filter(Boolean).join(' on ') || 'ready' : 'asleep',
    },
    fallbacks: {
      ok: fb.length > 0,
      label: 'Backup',
      detail: fb.length ? fb.join(' + ') : 'none',
    },
  };
}
