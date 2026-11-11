/**
 * Asset pipeline (Lab 03).
 *
 *   fetchJson / loadJson / loadImage / loadAudio   one asset each, all take an AbortSignal
 *   withRetry                                       exponential backoff + full jitter, never retries 4xx
 *   loadAll                                         Promise.all with per-item progress
 *
 * Every loader goes through fetchChecked(), which is the ONE place that turns "HTTP 404"
 * (a fulfilled fetch!) into a rejection. That is also what lets withRetry tell a 4xx
 * (our mistake, never retried) from a 5xx or a dropped connection (transient, retried).
 */

// ---------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export const isAbortError = (error) => error?.name === 'AbortError';
export const isTimeoutError = (error) => error?.name === 'TimeoutError';

/** A short, human-readable reason for the UI ("HTTP 404", "timed out", "corrupt data"…). */
export function describeError(error) {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (isAbortError(error)) return 'cancelled';
  if (isTimeoutError(error)) return 'timed out';
  if (error instanceof SyntaxError) return 'corrupt data';
  if (error instanceof TypeError) return 'network error';
  return error?.message ?? String(error);
}

/**
 * Is it worth trying again?
 *   5xx, timeouts, network failures (fetch rejects with TypeError)  -> yes, transient
 *   4xx, aborts, corrupt JSON (SyntaxError), undecodable data       -> no, retrying changes nothing
 */
export function isTransient(error) {
  if (error instanceof HttpError) return error.status >= 500;
  if (isAbortError(error)) return false;
  if (isTimeoutError(error)) return true;
  return error instanceof TypeError;
}

// ---------------------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------------------

/** Combine the caller's signal with a per-request timeout. */
function requestSignal(signal, timeoutMs) {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * fetch() resolves as soon as the headers arrive and does NOT reject on 404/500.
 * We turn a non-2xx answer into an HttpError. The signal stays attached to the response, so
 * abort/timeout also interrupt reading the body (the second `await`: json(), blob(), ...).
 */
async function fetchChecked(
  url,
  { signal, timeoutMs, fetchImpl = globalThis.fetch } = {},
) {
  const response = await fetchImpl(url, { signal: requestSignal(signal, timeoutMs) });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}

/** The shared JSON helper: checks `ok`, so a 404 page is never parsed as JSON. */
export async function fetchJson(url, options = {}) {
  const response = await fetchChecked(url, options);
  return response.json(); // a corrupt body rejects here with SyntaxError
}

export const loadJson = (url, options = {}) => fetchJson(url, options);

/**
 * Image via fetch -> blob -> createImageBitmap (rather than `new Image()`), because an <img>
 * error event cannot tell a 404 from a dead network, and withRetry must know the difference.
 * As a bonus the decode happens off the main thread.
 */
export async function loadImage(url, options = {}) {
  const { signal, decodeImage = (blob) => createImageBitmap(blob) } = options;
  const response = await fetchChecked(url, options);
  const blob = await response.blob();
  signal?.throwIfAborted();
  return decodeImage(blob);
}

/**
 * Audio: fetch -> arrayBuffer -> decodeAudioData. `ctx` is any BaseAudioContext; we decode on an
 * OfflineAudioContext during loading, so no user gesture (and no real AudioContext) is needed yet.
 */
export async function loadAudio(ctx, url, options = {}) {
  const response = await fetchChecked(url, options);
  const data = await response.arrayBuffer();
  options.signal?.throwIfAborted();
  return ctx.decodeAudioData(data);
}

// ---------------------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------------------

/** Full jitter: a random delay in [0, min(maxMs, baseMs * 2^(attempt-1))]. */
export function backoffDelay(
  attempt,
  { baseMs = 200, maxMs = 4000, random = Math.random } = {},
) {
  return random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

/** setTimeout as a promise that an AbortSignal can cut short. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` up to `attempts` times. Between attempts wait an exponentially growing, jittered
 * time (the jitter keeps many clients from retrying in lock-step). Gives up immediately on
 * errors that are not transient (4xx, bad JSON) and the moment `signal` aborts.
 */
export async function withRetry(
  fn,
  {
    attempts = 3,
    baseMs = 200,
    maxMs = 4000,
    signal,
    shouldRetry = isTransient,
    sleep = abortableSleep,
    random = Math.random,
    onRetry,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const delayMs = backoffDelay(attempt, { baseMs, maxMs, random });
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}

// ---------------------------------------------------------------------------------------
// loadAll
// ---------------------------------------------------------------------------------------

/** Manifest `{ id: { type, url, onError } }` -> a list, so the loop below is easy to read. */
function entriesOf(manifest) {
  return Object.entries(manifest).map(([id, entry]) => ({ id, ...entry }));
}

/**
 * Load every asset of the manifest.
 *
 *   concurrent: true  (default)  all requests start at once; Promise.all waits for the slowest
 *   concurrent: false            one after another (only for the README timing experiment)
 *
 * Failure policy per asset (`onError` in the manifest):
 *   'fail'      the game cannot start without it: reject, and abort the siblings that are still
 *               in flight (Promise.all alone would let them keep running to no purpose)
 *   'fallback'  the game starts with a built-in substitute; the failure is reported in `failed`
 *   'skip'      the asset is simply left out (e.g. a sound effect)
 *
 * Resolves to { assets, failed, elapsedMs }. `onProgress({ loaded, total, fraction, id, ok })`
 * fires after every single asset, so the progress bar is real, not a timer.
 */
export async function loadAll(
  manifest,
  {
    ctx,
    onProgress,
    signal,
    concurrent = true,
    timeoutMs = 4000,
    retry = {},
    fetchImpl,
    decodeImage,
  } = {},
) {
  const list = entriesOf(manifest);
  const total = list.length;
  const assets = {};
  const failed = [];
  const started = performance.now();

  const internal = new AbortController();
  const combined = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  let fatal = null;
  let loaded = 0;

  const options = { signal: combined, timeoutMs, fetchImpl, decodeImage };
  const loaders = {
    json: (url) => loadJson(url, options),
    image: (url) => loadImage(url, options),
    audio: (url) => loadAudio(ctx, url, options),
  };

  function report(id, ok) {
    loaded++;
    onProgress?.({ loaded, total, fraction: loaded / total, id, ok });
  }

  async function loadOne({ id, type, url, onError = 'fail' }) {
    if (!loaders[type]) throw new Error(`Unknown asset type "${type}" for "${id}"`);
    try {
      assets[id] = await withRetry(() => loaders[type](url), {
        ...retry,
        signal: combined,
      });
      report(id, true);
    } catch (error) {
      if (combined.aborted) throw error; // cancelled (by the caller or by a failed sibling)
      if (onError === 'fail') {
        fatal ??= error;
        internal.abort(error); // stop the siblings: Promise.all would not
        throw error;
      }
      failed.push({ id, url, type, onError, error });
      report(id, false);
    }
  }

  try {
    if (concurrent) {
      await Promise.all(list.map(loadOne));
    } else {
      for (const entry of list) await loadOne(entry);
    }
  } catch (error) {
    throw fatal ?? error; // the root cause, not an AbortError of a cancelled sibling
  }

  return { assets, failed, elapsedMs: performance.now() - started };
}
