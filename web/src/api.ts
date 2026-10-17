// Typed client for the ThirdWheel HTTP API and the /ws event stream (docs/ARCHITECTURE.md).

import type { HealthInfo, Scene, SceneMode, ServerEvent } from '../../shared/types.ts';

export type { HealthInfo, Scene, SceneMode, ServerEvent };

/** Modes a user can create (samples are bundled, never uploaded). */
export type CreatableMode = Exclude<SceneMode, 'sample'>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
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

function messageFromBody(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body.trim().slice(0, 300) || undefined;
  if (typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail']) {
      const v = b[key];
      if (typeof v === 'string' && v) return v;
    }
  }
  return undefined;
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
    res = await fetch(apiUrl(path), { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError('Cannot reach the ThirdWheel server. Is it still running?', 0);
  }
  const body = parseBody(await res.text());
  if (!res.ok) {
    throw new ApiError(messageFromBody(body) ?? `${res.status} ${res.statusText}`.trim(), res.status, body);
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
  mode: CreatableMode;
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

/**
 * POST /api/scenes as multipart. Uses XMLHttpRequest because fetch has no upload progress.
 */
export function createScene(input: CreateSceneInput, onProgress?: (p: UploadProgress) => void): UploadHandle {
  const form = new FormData();
  form.append('mode', input.mode);
  form.append('name', input.name);
  if (input.prompt && input.prompt.trim()) form.append('prompt', input.prompt.trim());
  for (const f of input.files) form.append('files', f.blob, f.name);

  const xhr = new XMLHttpRequest();
  const promise = new Promise<Scene>((resolve, reject) => {
    xhr.open('POST', apiUrl('/api/scenes'));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      onProgress?.({ loaded: e.loaded, total: e.total, fraction: e.lengthComputable ? e.loaded / e.total : NaN });
    };
    xhr.onload = () => {
      const body = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        const scene = body && typeof body === 'object' && 'scene' in body ? (body as { scene: Scene }).scene : (body as Scene);
        if (scene && typeof scene === 'object' && typeof scene.id === 'string') resolve(scene);
        else reject(new ApiError('The server accepted the upload but did not return a scene.', xhr.status, body));
      } else {
        reject(new ApiError(messageFromBody(body) ?? `Upload failed (${xhr.status} ${xhr.statusText})`, xhr.status, body));
      }
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: the connection dropped. Same Wi-Fi as the laptop?', 0));
    xhr.ontimeout = () => reject(new ApiError('Upload timed out.', 0));
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
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

/** Human summary of where jobs will run, for the health strip. */
export interface HealthSummary {
  gpu: { ok: boolean; label: string; detail: string };
  worker: { ok: boolean; label: string; detail: string };
  fallbacks: { ok: boolean; label: string; detail: string };
}

export function summarizeHealth(h: HealthInfo | undefined): HealthSummary {
  if (!h) {
    return {
      gpu: { ok: false, label: 'GPU', detail: 'checking' },
      worker: { ok: false, label: 'Warm worker', detail: 'checking' },
      fallbacks: { ok: false, label: 'Fallbacks', detail: 'checking' },
    };
  }
  const w = h.hpg?.worker;
  const fb: string[] = [];
  if (h.space?.available) fb.push('HF Space');
  if (h.local?.python) fb.push('local Mac');
  return {
    gpu: {
      ok: !!h.hpg?.online,
      label: 'HiPerGator',
      detail: h.hpg?.online ? 'online' : 'offline',
    },
    worker: {
      ok: !!w?.alive,
      label: 'Warm worker',
      detail: w?.alive ? [w.gpu, w.host].filter(Boolean).join(' on ') || 'alive' : 'asleep',
    },
    fallbacks: {
      ok: fb.length > 0,
      label: 'Fallbacks',
      detail: fb.length ? fb.join(' + ') : 'none',
    },
  };
}
