/**
 * Deliberate, URL-controlled failures for the README "failure gallery" and the loading-time
 * experiment. Nothing here runs unless the page URL asks for it.
 *
 *   ?chaos=404       sprite sheet URL points to a file that does not exist     -> HTTP 404
 *   ?chaos=json      the sprite atlas is replaced by a truncated JSON file     -> SyntaxError
 *   ?chaos=timeout   the arena config is delayed far beyond the request timeout -> TimeoutError
 *   ?chaos=abort     requests are slowed to ABORT_LATENCY_MS and the load is aborted
 *                    ABORT_AFTER_MS after it starts, i.e. mid-flight          -> AbortError
 *   ?chaos=rooms     the lobby's /api/rooms request is delayed beyond its timeout
 *   ?latency=300     every asset request is delayed by 300 ms (dev server only)
 *
 * Flags combine: ?chaos=404,json. They apply to the FIRST load attempt only, so pressing the
 * "Retry" button afterwards succeeds, which is exactly what a flaky network looks like.
 */

export const SLOW_MS = 8000;
export const ABORT_AFTER_MS = 400;
export const ABORT_LATENCY_MS = 1500; // slow enough that the abort always lands mid-load

export function parseChaos(params) {
  const flags = new Set((params.get('chaos') ?? '').split(',').filter(Boolean));
  const latency = Number(params.get('latency')) || 0;
  return { flags, latency };
}

/** `?delay=` is understood by the dev server middleware (tools/dev-api.js). */
export function withDelay(url, ms) {
  if (!ms || /[?&]delay=/.test(url)) return url; // keep an explicit delay (the timeout chaos)
  return `${url}${url.includes('?') ? '&' : '?'}delay=${ms}`;
}

/** Returns a modified COPY of the manifest. */
export function applyChaos(manifest, { flags = new Set(), latency = 0 } = {}) {
  const out = Object.fromEntries(
    Object.entries(manifest).map(([id, entry]) => [id, { ...entry }]),
  );
  const patch = (id, fn) => {
    if (out[id]) out[id].url = fn(out[id].url);
  };

  if (flags.has('404')) patch('sprites', () => 'assets/missing-sprites.png');
  if (flags.has('json')) patch('atlas', () => 'assets/chaos/corrupt.json');
  if (flags.has('timeout')) patch('arena', (url) => withDelay(url, SLOW_MS));

  // Locally everything loads in a few ms, so an abort would arrive after the load is over.
  const delay = flags.has('abort') ? Math.max(latency, ABORT_LATENCY_MS) : latency;
  if (delay)
    for (const entry of Object.values(out)) entry.url = withDelay(entry.url, delay);
  return out;
}
