/**
 * Who may open a WebSocket to us, and from where.
 *
 * Browsers do NOT apply the same-origin policy to WebSockets: a page on evil.example can open
 * `new WebSocket('wss://our.game/ws')` from the visitor's browser, with the visitor's cookies.
 * The one thing that tells us it happened is the `Origin` header, which the browser sets and a
 * page's script cannot change. So the handshake checks it ("cross-site WebSocket hijacking").
 *
 * A request WITHOUT an Origin is not a browser (a bot, curl, a test): the attack needs a browser,
 * so it is allowed; the per-IP limit and the rate limits are what protect us from those.
 */
import type { IncomingMessage } from 'node:http';

export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (allowed.length > 0) return allowed.includes(origin);
  // Nothing configured: only the page that THIS server serves (same host and port) may connect.
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false; // "null" (a sandboxed iframe, a file:// page) and garbage
  }
}

/** The client's address. Behind a trusted proxy the real one is the LAST entry of X-Forwarded-For. */
export function clientIp(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    const last = raw?.split(',').at(-1)?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
