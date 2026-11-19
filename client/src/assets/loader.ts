import type { Manifest, ManifestEntry } from './chaos.ts';

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
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Errors arrive as `unknown` (a catch variable, a rejection): look at the name, not the type. */
const nameOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name) // checked above: `name` exists
    : undefined;

export const isAbortError = (error: unknown): boolean => nameOf(error) === 'AbortError';
export const isTimeoutError = (error: unknown): boolean =>
  nameOf(error) === 'TimeoutError';

/** A short, human-readable reason for the UI ("HTTP 404", "timed out", "corrupt data"…). */
export function describeError(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (isAbortError(error)) return 'cancelled';
  if (isTimeoutError(error)) return 'timed out';
  if (error instanceof SyntaxError) return 'corrupt data';
  if (error instanceof TypeError) return 'network error';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Is it worth trying again?
 *   5xx, timeouts, network failures (fetch rejects with TypeError)  -> yes, transient
 *   4xx, aborts, corrupt JSON (SyntaxError), undecodable data       -> no, retrying changes nothing
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500;
  if (isAbortError(error)) return false;
  if (isTimeoutError(error)) return true;
  return error instanceof TypeError;
}

// ---------------------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------------------

/** Combine the caller's signal with a per-request timeout. */
function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * fetch() resolves as soon as the headers arrive and does NOT reject on 404/500.
 * We turn a non-2xx answer into an HttpError. The signal stays attached to the response, so
 * abort/timeout also interrupt reading the body (the second `await`: json(), blob(), ...).
 */
export type FetchImpl = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<Response>;
export interface LoadOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchImpl | undefined;
}

async function fetchChecked(
  url: string,
  { signal, timeoutMs, fetchImpl = globalThis.fetch }: LoadOptions = {},
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...(signal || timeoutMs ? { signal: requestSignal(signal, timeoutMs) } : {}),
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}

/** The shared JSON helper: checks `ok`, so a 404 page is never parsed as JSON. */
export async function fetchJson(
  url: string,
  options: LoadOptions = {},
): Promise<unknown> {
  const response = await fetchChecked(url, options);
  return response.json(); // a corrupt body rejects here with SyntaxError
}

export const loadJson = (url: string, options: LoadOptions = {}): Promise<unknown> =>
  fetchJson(url, options);

/**
 * Image via fetch -> blob -> createImageBitmap (rather than `new Image()`), because an <img>
 * error event cannot tell a 404 from a dead network, and withRetry must know the difference.
 * As a bonus the decode happens off the main thread.
 */
export interface ImageOptions extends LoadOptions {
  decodeImage?: ((blob: Blob) => Promise<ImageBitmap>) | undefined;
}

export async function loadImage(
  url: string,
  options: ImageOptions = {},
): Promise<ImageBitmap> {
  const { signal, decodeImage = (blob: Blob) => createImageBitmap(blob) } = options;
  const response = await fetchChecked(url, options);
  const blob = await response.blob();
  signal?.throwIfAborted();
  return decodeImage(blob);
}

/**
 * Audio: fetch -> arrayBuffer -> decodeAudioData. `ctx` is any BaseAudioContext; we decode on an
 * OfflineAudioContext during loading, so no user gesture (and no real AudioContext) is needed yet.
 */
export async function loadAudio(
  ctx: Pick<BaseAudioContext, 'decodeAudioData'>,
  url: string,
  options: LoadOptions = {},
): Promise<AudioBuffer> {
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
  attempt: number,
  {
    baseMs = 200,
    maxMs = 4000,
    random = Math.random,
  }: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  return random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

/** setTimeout as a promise that an AbortSignal can cut short. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
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
export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal | undefined;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 3,
    baseMs = 200,
    maxMs = 4000,
    signal,
    shouldRetry = isTransient,
    sleep = abortableSleep,
    random = Math.random,
    onRetry,
  }: RetryOptions = {},
): Promise<T> {
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
function entriesOf(manifest: Manifest): Array<ManifestEntry & { id: string }> {
  return Object.entries(manifest).map(([id, entry]) => ({ id, ...entry }));
}

export interface Failure {
  id: string;
  url: string;
  type: ManifestEntry['type'];
  onError: NonNullable<ManifestEntry['onError']>;
  error: unknown;
}
export interface Progress {
  loaded: number;
  total: number;
  fraction: number;
  id: string;
  ok: boolean;
}
export interface LoadAllOptions {
  ctx?: Pick<BaseAudioContext, 'decodeAudioData'> | undefined;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal | undefined;
  concurrent?: boolean;
  timeoutMs?: number;
  retry?: RetryOptions;
  fetchImpl?: FetchImpl | undefined;
  decodeImage?: ImageOptions['decodeImage'];
}
export interface LoadResult {
  assets: Record<string, unknown>;
  failed: Failure[];
  elapsedMs: number;
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
  manifest: Manifest,
  {
    ctx,
    onProgress,
    signal,
    concurrent = true,
    timeoutMs = 4000,
    retry = {},
    fetchImpl,
    decodeImage,
  }: LoadAllOptions = {},
): Promise<LoadResult> {
  const list = entriesOf(manifest);
  const total = list.length;
  const assets: Record<string, unknown> = {};
  const failed: Failure[] = [];
  const started = performance.now();

  const internal = new AbortController();
  const combined = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  let fatal: unknown = null;
  let loaded = 0;

  const options = { signal: combined, timeoutMs, fetchImpl, decodeImage };
  const loaders: Record<ManifestEntry['type'], (url: string) => Promise<unknown>> = {
    json: (url) => loadJson(url, options),
    image: (url) => loadImage(url, options),
    audio: (url) => {
      if (!ctx) throw new Error('loading audio needs a decoding context (ctx)');
      return loadAudio(ctx, url, options);
    },
  };

  function report(id: string, ok: boolean): void {
    loaded++;
    onProgress?.({ loaded, total, fraction: loaded / total, id, ok });
  }

  async function loadOne({
    id,
    type,
    url,
    onError = 'fail',
  }: ManifestEntry & { id: string }): Promise<void> {
    const load = loaders[type];
    if (!load) throw new Error(`Unknown asset type "${type}" for "${id}"`);
    try {
      assets[id] = await withRetry(() => load(url), {
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
