import {
  LIMITS,
  clientMessageSchema,
  type ClientJsonMessage,
} from '@dogfight/shared/protocol.ts';

/**
 * The server's half of the protocol. The MESSAGES (shapes, limits, types) live in
 * @dogfight/shared/protocol.ts as Zod schemas, shared with the browser; this file decides what
 * the SERVER does with a frame that does not fit: it closes the socket (see CLOSE).
 *
 * The server never trusts the client, not even our own: whatever arrives is `unknown` until a
 * schema has said otherwise. A client that sends garbage is either broken or hostile, and
 * either way the server should not spend more time on it.
 */
export { PROTOCOL_VERSION, LIMITS, encode } from '@dogfight/shared/protocol.ts';

// WebSocket close codes: 1000-1015 are defined by RFC 6455, 4000-4999 are ours.
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  UNSUPPORTED: 1003, // binary frame before joining / a malformed binary frame
  INVALID_PAYLOAD: 1007, // not valid UTF-8 / JSON
  POLICY: 1008, // unknown type, wrong shape, rate limit
  TOO_BIG: 1009, // set by ws itself when maxPayload is exceeded
  TRY_LATER: 1013, // server is full
  INTERNAL: 1011, // a bug of ours
  JOIN_TIMEOUT: 4001, // no join within JOIN_TIMEOUT_MS
  HEARTBEAT: 4002, // missed pongs (terminated, so the code is only for logs)
  SLOW_CLIENT: 4003, // bufferedAmount kept growing
});

/** Parsing never throws on bad input: a bad frame is an expected event, not an exception. */
export type ParseResult =
  | { readonly ok: true; readonly message: ClientJsonMessage }
  | { readonly ok: false; readonly closeCode: number; readonly reason: string };

const fail = (closeCode: number, reason: string): ParseResult => ({
  ok: false,
  closeCode,
  reason,
});

/** What `ws` hands us is Buffer | ArrayBuffer | Buffer[]; anything else is not text we can use. */
function toText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw) && raw.every((part) => part instanceof Buffer))
    return Buffer.concat(raw).toString('utf8');
  return null;
}

/** Short and safe to send in a close frame (max 123 bytes). */
function describeIssue(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid message';
  const path = issue.path.map(String).join('.');
  return `${path || 'message'}: ${issue.message}`.slice(0, 100);
}

export function parseClientMessage(
  raw: unknown,
  isBinary: boolean,
  maxBytes: number,
): ParseResult {
  if (isBinary) return fail(CLOSE.UNSUPPORTED, 'text frames only');
  const text = toText(raw);
  if (text === null) return fail(CLOSE.UNSUPPORTED, 'text frames only');
  if (Buffer.byteLength(text) > maxBytes) return fail(CLOSE.TOO_BIG, 'message too big');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail(CLOSE.INVALID_PAYLOAD, 'not JSON');
  }
  const parsed = clientMessageSchema.safeParse(data);
  if (!parsed.success) return fail(CLOSE.POLICY, describeIssue(parsed.error));
  return { ok: true, message: parsed.data };
}
