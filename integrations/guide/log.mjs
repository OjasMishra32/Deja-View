// One line per guide request, so a busy night shows what was slow, cached, degraded or rate limited:
//   guide POST /narrate status=200 ms=812 scene=kitchen cached=0 degraded=1 gemini=429
// Only these fields. Never the image, the audio, the key, the question or the answer.

let sink = (line) => console.log(line);

/** Tests (and anything else) can catch the lines instead of the console. Returns the previous sink. */
export function setLogSink(fn) { const prev = sink; sink = fn || ((line) => console.log(line)); return prev; }

/** The HTTP status Gemini failed with, from its error text: 429 (quota), 503 (busy), or any other 4xx/5xx it names. */
export function geminiCode(error) {
  const text = String(error?.status ?? '') + ' ' + String(error?.message ?? error ?? '');
  const code = text.match(/\b(4\d\d|5\d\d)\b/);
  if (code) return Number(code[1]);
  if (/RESOURCE_EXHAUSTED|quota/i.test(text)) return 429;
  if (/UNAVAILABLE|high demand|overloaded/i.test(text)) return 503;
  return null;
}

const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The line for one request. `meta` comes from the handler: { scene, cached, degraded, error }. */
export function requestLine({ method, path, status, ms, meta = {} }) {
  const parts = ['guide', method, String(path || '').split('?')[0].slice(0, 32), `status=${status}`, `ms=${Math.round(ms)}`];
  if (typeof meta.scene === 'string' && SAFE.test(meta.scene)) parts.push(`scene=${meta.scene}`);
  if (meta.cached !== undefined) parts.push(`cached=${meta.cached ? 1 : 0}`);
  if (meta.degraded !== undefined) parts.push(`degraded=${meta.degraded ? 1 : 0}`);
  if (meta.error !== undefined && meta.error !== null && meta.error !== 'mock mode') {
    const code = geminiCode(meta.error);
    if (code) parts.push(`gemini=${code}`);
  }
  if (meta.mock) parts.push('mock=1');
  return parts.join(' ');
}

export function logRequest(entry) { try { sink(requestLine(entry)); } catch { /* logging never breaks a request */ } }
