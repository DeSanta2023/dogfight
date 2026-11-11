import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpError,
  abortableSleep,
  backoffDelay,
  fetchJson,
  isTransient,
  loadAll,
  loadAudio,
  loadImage,
  withRetry,
} from '../src/assets/loader.js';
import { applyChaos, parseChaos, withDelay } from '../src/assets/chaos.js';

// ---- a fake fetch: responds after `ms`, honours the AbortSignal like the real one ----------
function fakeFetch(routes, { ms = 0, log = [] } = {}) {
  return (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      log.push({ url, signal, at: performance.now() });
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      if (signal?.aborted) return onAbort();
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        const route = routes[url];
        if (route instanceof Error) return reject(route); // network failure
        const { status = 200, body = '{}' } = route ?? { status: 404 };
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => JSON.parse(body),
          blob: async () => ({ size: body.length }),
          arrayBuffer: async () => new ArrayBuffer(body.length),
        });
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

const noSleep = async () => {};

// ---- fetchJson ------------------------------------------------------------------------------
test('fetchJson returns the parsed body of a 200', async () => {
  const fetchImpl = fakeFetch({ '/a.json': { body: '{"x":1}' } });
  assert.deepEqual(await fetchJson('/a.json', { fetchImpl }), { x: 1 });
});

test('fetchJson turns a 404 (a FULFILLED fetch) into a rejection', async () => {
  const fetchImpl = fakeFetch({});
  await assert.rejects(fetchJson('/nope.json', { fetchImpl }), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 404);
    return true;
  });
});

test('fetchJson rejects with SyntaxError on corrupt JSON, not with an HTTP error', async () => {
  const fetchImpl = fakeFetch({ '/bad.json': { body: '{ "frames": { "ship": ' } });
  await assert.rejects(fetchJson('/bad.json', { fetchImpl }), SyntaxError);
});

test('fetchJson times out with a TimeoutError', async () => {
  const fetchImpl = fakeFetch({ '/slow.json': { body: '{}' } }, { ms: 200 });
  await assert.rejects(fetchJson('/slow.json', { fetchImpl, timeoutMs: 20 }), {
    name: 'TimeoutError',
  });
});

test('fetchJson honours the caller signal: abort rejects with AbortError', async () => {
  const fetchImpl = fakeFetch({ '/slow.json': { body: '{}' } }, { ms: 200 });
  const controller = new AbortController();
  const promise = fetchJson('/slow.json', { fetchImpl, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { name: 'AbortError' });
});

// ---- image / audio ---------------------------------------------------------------------------
test('loadImage and loadAudio hand the body to the decoder', async () => {
  const fetchImpl = fakeFetch({
    '/s.png': { body: 'PNGDATA' },
    '/s.wav': { body: 'WAVDATA' },
  });

  const bitmap = await loadImage('/s.png', {
    fetchImpl,
    decodeImage: async (blob) => ({ blob }),
  });
  assert.equal(bitmap.blob.size, 'PNGDATA'.length);

  const ctx = { decodeAudioData: async (buffer) => ({ duration: buffer.byteLength }) };
  const audio = await loadAudio(ctx, '/s.wav', { fetchImpl });
  assert.equal(audio.duration, 'WAVDATA'.length);
});

test('loadImage on a 404 rejects with HttpError 404 (so withRetry will not retry it)', async () => {
  await assert.rejects(loadImage('/missing.png', { fetchImpl: fakeFetch({}) }), (e) => {
    assert.equal(e.status, 404);
    assert.equal(isTransient(e), false);
    return true;
  });
});

// ---- which errors are worth retrying ----------------------------------------------------------
test('isTransient: 5xx, timeouts and network errors yes; 4xx, aborts, bad JSON no', () => {
  assert.equal(isTransient(new HttpError(503, '/x')), true);
  assert.equal(isTransient(new HttpError(500, '/x')), true);
  assert.equal(isTransient(new HttpError(404, '/x')), false);
  assert.equal(isTransient(new HttpError(429, '/x')), false);
  assert.equal(isTransient(new DOMException('t', 'TimeoutError')), true);
  assert.equal(isTransient(new TypeError('Failed to fetch')), true);
  assert.equal(isTransient(new DOMException('a', 'AbortError')), false);
  assert.equal(isTransient(new SyntaxError('Unexpected end of JSON input')), false);
});

// ---- withRetry --------------------------------------------------------------------------------
test('withRetry: succeeds on the 3rd try after two transient failures', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      if (++calls < 3) throw new HttpError(503, '/x');
      return 'ok';
    },
    { attempts: 4, sleep: noSleep },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry NEVER retries a 4xx: one call, same error', async () => {
  let calls = 0;
  const error = new HttpError(404, '/x');
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw error;
      },
      { attempts: 5, sleep: noSleep },
    ),
    (e) => e === error,
  );
  assert.equal(calls, 1);
});

test('withRetry does not retry corrupt JSON either', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new SyntaxError('bad json');
      },
      { attempts: 5, sleep: noSleep },
    ),
    SyntaxError,
  );
  assert.equal(calls, 1);
});

test('withRetry gives up after `attempts` and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        throw new HttpError(500, `/x#${++calls}`);
      },
      { attempts: 3, sleep: noSleep },
    ),
    (e) => e.url === '/x#3',
  );
  assert.equal(calls, 3);
});

test('backoff is exponential and jitter stays within [0, cap]', () => {
  const max = { random: () => 1, baseMs: 100, maxMs: 1000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => backoffDelay(n, max)),
    [100, 200, 400, 800, 1000], // doubles, then is capped at maxMs
  );
  assert.equal(backoffDelay(3, { ...max, random: () => 0 }), 0);
  assert.equal(backoffDelay(3, { ...max, random: () => 0.5 }), 200);
});

test('withRetry sleeps the jittered backoff between attempts (and reports it)', async () => {
  const slept = [];
  const seen = [];
  await assert.rejects(
    withRetry(
      async () => {
        throw new HttpError(502, '/x');
      },
      {
        attempts: 4,
        baseMs: 100,
        random: () => 0.5,
        sleep: async (ms) => slept.push(ms),
        onRetry: ({ attempt, delayMs }) => seen.push([attempt, delayMs]),
      },
    ),
  );
  assert.deepEqual(slept, [50, 100, 200]); // 0.5 * (100, 200, 400)
  assert.deepEqual(seen, [
    [1, 50],
    [2, 100],
    [3, 200],
  ]);
});

test('withRetry stops waiting the moment the signal aborts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = withRetry(
    async () => {
      calls++;
      throw new HttpError(503, '/x');
    },
    { attempts: 5, baseMs: 10_000, random: () => 1, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  const started = performance.now();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.ok(performance.now() - started < 1000, 'did not sit through the 10 s backoff');
});

test('abortableSleep resolves after the delay and cleans up', async () => {
  const controller = new AbortController();
  await abortableSleep(5, controller.signal);
  controller.abort(); // must not throw or reject anything now
});

// ---- loadAll ----------------------------------------------------------------------------------
const MANIFEST = {
  a: { type: 'json', url: '/a.json', onError: 'fail' },
  b: { type: 'json', url: '/b.json', onError: 'fail' },
  c: { type: 'json', url: '/c.json', onError: 'fallback' },
  d: { type: 'json', url: '/d.json', onError: 'skip' },
};
const OK = { body: '{"ok":true}' };
const ALL_OK = { '/a.json': OK, '/b.json': OK, '/c.json': OK, '/d.json': OK };

test('loadAll runs the requests concurrently: total ≈ the slowest, not the sum', async () => {
  const log = [];
  const fetchImpl = fakeFetch(ALL_OK, { ms: 60, log });
  const { assets, failed, elapsedMs } = await loadAll(MANIFEST, { fetchImpl });

  assert.deepEqual(Object.keys(assets).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(failed.length, 0);
  assert.ok(
    elapsedMs < 60 * 2.5,
    `concurrent: ${elapsedMs.toFixed(0)} ms (sum would be 240)`,
  );
  const starts = log.map((entry) => entry.at);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 30, 'all four started together');
});

test('loadAll with concurrent:false is the sequential baseline: total ≈ the sum', async () => {
  const fetchImpl = fakeFetch(ALL_OK, { ms: 40 });
  const { elapsedMs } = await loadAll(MANIFEST, { fetchImpl, concurrent: false });
  assert.ok(
    elapsedMs >= 40 * 4 * 0.9,
    `sequential: ${elapsedMs.toFixed(0)} ms (expected ≥ 160)`,
  );
});

test('loadAll reports real per-asset progress, one step per finished asset', async () => {
  const fetchImpl = fakeFetch(ALL_OK, { ms: 5 });
  const steps = [];
  await loadAll(MANIFEST, { fetchImpl, onProgress: (p) => steps.push(p) });

  assert.deepEqual(
    steps.map((p) => p.loaded),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    steps.map((p) => p.fraction),
    [0.25, 0.5, 0.75, 1],
  );
  assert.ok(steps.every((p) => p.total === 4 && p.ok === true));
});

test('a failed fallback/skip asset does not stop the load, and is reported', async () => {
  const routes = {
    ...ALL_OK,
    '/c.json': { status: 404 },
    '/d.json': { body: '{ broken' },
  };
  const steps = [];
  const { assets, failed } = await loadAll(MANIFEST, {
    fetchImpl: fakeFetch(routes),
    onProgress: (p) => steps.push(p),
  });

  assert.deepEqual(Object.keys(assets).sort(), ['a', 'b']);
  assert.deepEqual(failed.map((f) => [f.id, f.onError]).sort(), [
    ['c', 'fallback'],
    ['d', 'skip'],
  ]);
  assert.equal(failed.find((f) => f.id === 'c').error.status, 404);
  assert.ok(failed.find((f) => f.id === 'd').error instanceof SyntaxError);
  assert.equal(steps.at(-1).loaded, 4, 'the bar still reaches 100 %');
  assert.equal(steps.filter((p) => !p.ok).length, 2);
});

test('a failed REQUIRED asset rejects with the root cause and aborts its siblings', async () => {
  const log = [];
  const routes = { ...ALL_OK, '/a.json': { status: 404 } };
  // a fails fast (404), the others are slow: they must be cancelled, not left running
  const base = fakeFetch(routes, { ms: 100, log });
  const fetchImpl = (url, options) =>
    url === '/a.json'
      ? fakeFetch(routes, { ms: 5, log })(url, options)
      : base(url, options);

  await assert.rejects(loadAll(MANIFEST, { fetchImpl }), (e) => {
    assert.ok(
      e instanceof HttpError,
      'the 404, not an AbortError of a cancelled sibling',
    );
    assert.equal(e.status, 404);
    return true;
  });
  const siblings = log.filter((entry) => entry.url !== '/a.json');
  assert.equal(siblings.length, 3);
  assert.ok(
    siblings.every((entry) => entry.signal.aborted),
    'siblings were aborted',
  );
});

test('aborting from outside mid-load rejects with AbortError', async () => {
  const controller = new AbortController();
  const fetchImpl = fakeFetch(ALL_OK, { ms: 200 });
  const promise = loadAll(MANIFEST, { fetchImpl, signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(promise, { name: 'AbortError' });
});

test('loadAll retries a transient failure and then succeeds', async () => {
  let hits = 0;
  const fetchImpl = (url, options) => {
    if (url === '/a.json' && ++hits < 3)
      return Promise.resolve({ ok: false, status: 503 });
    return fakeFetch(ALL_OK)(url, options);
  };
  const retried = [];
  const { assets } = await loadAll(MANIFEST, {
    fetchImpl,
    retry: { attempts: 4, baseMs: 1, onRetry: (r) => retried.push(r.attempt) },
  });
  assert.ok(assets.a);
  assert.equal(hits, 3);
  assert.deepEqual(retried, [1, 2]);
});

test('loadAll does not retry a 404 at all', async () => {
  const log = [];
  const manifest = { x: { type: 'json', url: '/x.json', onError: 'fallback' } };
  const { failed } = await loadAll(manifest, {
    fetchImpl: fakeFetch({}, { log }),
    retry: { attempts: 5, baseMs: 1 },
  });
  assert.equal(failed.length, 1);
  assert.equal(log.length, 1, 'requested exactly once');
});

test('a per-request timeout is retried, then reported when it keeps timing out', async () => {
  const log = [];
  const manifest = { slow: { type: 'json', url: '/slow.json', onError: 'fallback' } };
  const { failed } = await loadAll(manifest, {
    fetchImpl: fakeFetch({ '/slow.json': OK }, { ms: 500, log }),
    timeoutMs: 15,
    retry: { attempts: 3, baseMs: 1 },
  });
  assert.equal(log.length, 3, 'three attempts');
  assert.equal(failed[0].error.name, 'TimeoutError');
});

// ---- chaos helpers ----------------------------------------------------------------------------
test('applyChaos returns a patched COPY and leaves the original manifest alone', () => {
  const copy = applyChaos(MANIFEST, { flags: new Set(['404']), latency: 0 });
  assert.equal(MANIFEST.a.url, '/a.json');
  assert.equal(copy.a.url, '/a.json');

  const real = {
    sprites: { type: 'image', url: 'assets/sprites.png' },
    atlas: { type: 'json', url: 'assets/sprites.json' },
    arena: { type: 'json', url: 'assets/arena.json' },
  };
  const out = applyChaos(real, {
    flags: new Set(['404', 'json', 'timeout']),
    latency: 120,
  });
  assert.match(out.sprites.url, /missing-sprites\.png\?delay=120$/);
  assert.match(out.atlas.url, /corrupt\.json\?delay=120$/);
  assert.match(
    out.arena.url,
    /arena\.json\?delay=8000$/,
    'an explicit delay wins over latency',
  );
  assert.equal(real.sprites.url, 'assets/sprites.png');
});

test('parseChaos / withDelay', () => {
  const { flags, latency } = parseChaos(
    new URLSearchParams('chaos=404,json&latency=250'),
  );
  assert.deepEqual([...flags], ['404', 'json']);
  assert.equal(latency, 250);
  assert.equal(withDelay('a.png', 0), 'a.png');
  assert.equal(withDelay('a.png?v=1', 50), 'a.png?v=1&delay=50');
});
