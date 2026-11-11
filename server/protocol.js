/**
 * Wire protocol, version 1. JSON text frames: { "v": 1, "type": "...", ...fields }.
 *
 * client -> server              server -> client
 *   join  { room, name }          welcome { id, limits }          right after connecting
 *   chat  { text }                joined  { room, you, players }  answer to a good join
 *   leave {}                      roster  { players }             someone came or went
 *                                 chat    { from, text, at }
 *                                 error   { code, message }       the socket stays open
 *
 * The server never trusts the client, not even our own: parseClientMessage() checks size, JSON
 * syntax, version, type and every field. Anything wrong is a reason to CLOSE the socket (see
 * CLOSE), because a client that sends garbage is either broken or hostile, and either way
 * the server should not spend more time on it.
 */
export const PROTOCOL_VERSION = 1;

// WebSocket close codes: 1000-1015 are defined by RFC 6455, 4000-4999 are ours.
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  UNSUPPORTED: 1003, // binary frame: this protocol is text only
  INVALID_PAYLOAD: 1007, // not valid UTF-8 / JSON
  POLICY: 1008, // unknown type, wrong shape, rate limit
  TOO_BIG: 1009, // set by ws itself when maxPayload is exceeded
  TRY_LATER: 1013, // server is full
  JOIN_TIMEOUT: 4001, // no join within JOIN_TIMEOUT_MS
  HEARTBEAT: 4002, // missed pongs (terminated, so the code is only for logs)
  SLOW_CLIENT: 4003, // bufferedAmount kept growing
});

export const LIMITS = Object.freeze({ nameMax: 24, textMax: 300, roomIdMax: 40 });

const NAME = /^[\p{L}\p{N} _.-]+$/u;
const ROOM_ID = /^[a-z0-9][a-z0-9-]*$/;

export class ProtocolError extends Error {
  constructor(closeCode, reason) {
    super(reason);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
    this.reason = reason; // short, safe to send in a close frame (max 123 bytes)
  }
}

const validators = {
  join(m) {
    if (
      typeof m.room !== 'string' ||
      m.room.length > LIMITS.roomIdMax ||
      !ROOM_ID.test(m.room)
    )
      throw new ProtocolError(CLOSE.POLICY, 'join.room must be a room id');
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (name.length < 1 || name.length > LIMITS.nameMax || !NAME.test(name))
      throw new ProtocolError(
        CLOSE.POLICY,
        'join.name must be 1-24 letters, digits, space _ . -',
      );
    return { type: 'join', room: m.room, name };
  },
  chat(m) {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (text.length < 1 || text.length > LIMITS.textMax)
      throw new ProtocolError(CLOSE.POLICY, 'chat.text must be 1-300 characters');
    return { type: 'chat', text };
  },
  leave() {
    return { type: 'leave' };
  },
};

/**
 * @param {string | Buffer} raw  what ws gave us
 * @param {boolean} isBinary
 * @returns a clean message object, or throws ProtocolError
 */
export function parseClientMessage(raw, isBinary, maxBytes) {
  if (isBinary) throw new ProtocolError(CLOSE.UNSUPPORTED, 'text frames only');
  const bytes = Buffer.byteLength(raw); // bytes, not characters: "é" is 2 bytes in UTF-8
  if (bytes > maxBytes) throw new ProtocolError(CLOSE.TOO_BIG, 'message too big');
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ProtocolError(CLOSE.INVALID_PAYLOAD, 'not JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new ProtocolError(CLOSE.POLICY, 'message must be an object');
  if (data.v !== PROTOCOL_VERSION)
    throw new ProtocolError(
      CLOSE.POLICY,
      `unsupported version, expected ${PROTOCOL_VERSION}`,
    );
  const validate = Object.hasOwn(validators, data.type) ? validators[data.type] : null;
  if (!validate) throw new ProtocolError(CLOSE.POLICY, 'unknown message type');
  return validate(data);
}

export const encode = (type, fields = {}) =>
  JSON.stringify({ v: PROTOCOL_VERSION, type, ...fields });
