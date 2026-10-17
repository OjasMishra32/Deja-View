// The guide's request log line (log.mjs): the fields it carries and the ones it must never carry.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { geminiCode, requestLine } from '../log.mjs';

describe('request log line', () => {
  test('carries endpoint, status, total ms, scene, cached, degraded and the Gemini code', () => {
    const line = requestLine({ method: 'POST', path: '/narrate', status: 200, ms: 811.6,
      meta: { scene: 'kitchen', cached: false, degraded: true, error: 'got status: 429 Too Many Requests' } });
    assert.equal(line, 'guide POST /narrate status=200 ms=812 scene=kitchen cached=0 degraded=1 gemini=429');
  });
  test('a cached answer, a bad request and a 404 stay short', () => {
    assert.equal(requestLine({ method: 'POST', path: '/hotspots', status: 200, ms: 3, meta: { scene: 'the-courts', cached: true, degraded: false } }),
      'guide POST /hotspots status=200 ms=3 scene=the-courts cached=1 degraded=0');
    assert.equal(requestLine({ method: 'POST', path: '/ask', status: 400, ms: 1 }), 'guide POST /ask status=400 ms=1');
    assert.equal(requestLine({ method: 'GET', path: '/nope?x=1', status: 404, ms: 0 }), 'guide GET /nope status=404 ms=0');
  });
  test('Gemini error codes from the error text', () => {
    assert.equal(geminiCode(new Error('[503 Service Unavailable] The model is overloaded')), 503);
    assert.equal(geminiCode('RESOURCE_EXHAUSTED: quota exceeded'), 429);
    assert.equal(geminiCode('UNAVAILABLE: high demand'), 503);
    assert.equal(geminiCode({ status: 429 }), 429);
    assert.equal(geminiCode('fetch failed'), null);
  });
  test('never a scene id that could smuggle text, never mock mode as an error', () => {
    const line = requestLine({ method: 'POST', path: '/ask', status: 200, ms: 5,
      meta: { scene: 'x" answer="secret', degraded: true, error: 'mock mode', mock: true } });
    assert.equal(line, 'guide POST /ask status=200 ms=5 degraded=1 mock=1');
  });
});
