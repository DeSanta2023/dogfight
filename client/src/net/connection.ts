import { TypedEventTarget } from './typed-target.ts';

/**
 * A WebSocket that survives the network: a wrapper with a SEND QUEUE and RECONNECT.
 *
 *   send()      while the socket is not open the message waits in a queue (max `maxQueue`,
 *               oldest dropped) and goes out, in order, after the next successful connect.
 *   reconnect   after an unexpected close we wait and try again. The wait grows
 *               exponentially (base * 2^attempt, capped at maxMs) and is JITTERED: if the server
 *               restarts, 500 clients must not all come back at the same millisecond.
 *   handshake   a function returning the messages that must be sent FIRST on every (re)connect,
 *               before the queue: for us that is "join" (a fresh socket knows nothing about us).
 *
 * Which closes are worth retrying: the server going away (1001), a dropped network (1006), "try
 * later" (1013), our own 4xxx codes (heartbeat, slow client). Which are not: 1000 (we closed it),
 * 1003/1007/1008/1009 (the server told us WE sent something wrong: retrying would repeat the
 * mistake forever).
 *
 * Events (CustomEvent): "status" { state, attempt, delayMs }  state: connecting | open | waiting | closed
 *                       "message" { message, size }            a parsed server message
 *                       "binary" { data, size }                a binary frame (Lab 05 game traffic)
 *                       "close" { code, reason, willRetry }
 */
const NO_RETRY = new Set([1000, 1003, 1007, 1008, 1009]);

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'waiting' | 'closed';

/** A control message as it arrives: `v` is checked here, everything else by the session (Zod). */
export interface WireMessage {
  type: string;
  [field: string]: unknown;
}
/** One message to send: [type, fields]. `v` is added when it is written. */
export type Outgoing = [type: string, fields: Record<string, unknown>];

export interface ConnectionEvents {
  status: {
    state: ConnectionState;
    attempt: number;
    delayMs?: number;
    code?: number;
    reason?: string;
  };
  message: { message: WireMessage; size: number };
  binary: { data: ArrayBuffer; size: number };
  close: { code: number; reason: string; willRetry: boolean };
}

export interface ConnectionOptions {
  url: string;
  WebSocketImpl?: typeof WebSocket;
  baseMs?: number;
  maxMs?: number;
  maxQueue?: number;
  random?: () => number;
}

/** Narrow `unknown` to a WireMessage: an object with protocol version 1 and a string type. */
function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { v, type } = value as { v?: unknown; type?: unknown }; // reading two fields of an object we just checked
  return v === 1 && typeof type === 'string';
}

export class Connection extends TypedEventTarget<ConnectionEvents> {
  state: ConnectionState = 'idle';
  attempt = 0; // failed attempts since the last successful open
  dropped = 0; // messages thrown away because the queue was full
  invalid = 0; // server frames that were not valid protocol messages
  handshake: () => Outgoing[] = () => [];

  #url: string;
  #WebSocket: typeof WebSocket;
  #baseMs: number;
  #maxMs: number;
  #maxQueue: number;
  #random: () => number;
  #socket: WebSocket | null = null;
  #queue: Outgoing[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    baseMs = 500,
    maxMs = 15_000,
    maxQueue = 50,
    random = Math.random,
  }: ConnectionOptions) {
    super();
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
    this.#maxQueue = maxQueue;
    this.#random = random;
  }

  get queued(): number {
    return this.#queue.length;
  }

  #setState(
    state: ConnectionState,
    extra: { delayMs?: number; code?: number; reason?: string } = {},
  ): void {
    this.state = state;
    this.emit('status', { state, attempt: this.attempt, ...extra });
  }

  connect(): void {
    if (this.state === 'connecting' || this.state === 'open') return;
    clearTimeout(this.#timer);
    this.#setState('connecting');
    let socket: WebSocket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch {
      // A malformed URL throws synchronously: treat it like any other failed attempt.
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.binaryType = 'arraybuffer'; // game frames: an ArrayBuffer, not a Blob (DataView needs bytes now)
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return;
      this.attempt = 0;
      this.#setState('open');
      for (const [type, fields] of this.handshake()) this.#write(type, fields);
      const queued = this.#queue.splice(0);
      for (const [type, fields] of queued) this.#write(type, fields);
    });
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return;
      if (typeof event.data !== 'string') {
        // Binary frame = game traffic (snapshot / pong): hand over the raw bytes.
        // binaryType is 'arraybuffer', so a non-string frame is an ArrayBuffer.
        if (event.data instanceof ArrayBuffer)
          this.emit('binary', { data: event.data, size: event.data.byteLength });
        else this.invalid++;
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        message = null; // bad JSON is counted, never thrown (an exception here would kill the listener)
      }
      if (!isWireMessage(message)) {
        this.invalid++;
        return;
      }
      this.emit('message', { message, size: event.data.length });
    });
    // 'error' carries no information in browsers (by design); the 'close' that follows does.
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return; // an old socket we already replaced
      this.#socket = null;
      if (this.state === 'closed') return;
      const willRetry = !NO_RETRY.has(event.code);
      this.emit('close', { code: event.code, reason: event.reason, willRetry });
      if (willRetry) this.#scheduleRetry();
      else this.#setState('closed', { code: event.code, reason: event.reason });
    });
  }

  #scheduleRetry(): void {
    const cap = Math.min(this.#maxMs, this.#baseMs * 2 ** this.attempt);
    const delayMs = Math.round(cap / 2 + (this.#random() * cap) / 2); // "equal jitter": never 0
    this.attempt++;
    this.#setState('waiting', { delayMs });
    this.#timer = setTimeout(() => this.connect(), delayMs);
  }

  #write(type: string, fields: Record<string, unknown>): void {
    this.#socket?.send(JSON.stringify({ v: 1, type, ...fields }));
  }

  /** Send now if the socket is open, otherwise queue. Returns false when the connection is closed for good. */
  send(type: string, fields: Record<string, unknown> = {}): boolean {
    if (this.state === 'closed' || this.state === 'idle') return false;
    if (this.state === 'open' && this.#socket?.readyState === 1) {
      this.#write(type, fields);
      return true;
    }
    if (this.#queue.length >= this.#maxQueue) {
      this.#queue.shift();
      this.dropped++;
    }
    this.#queue.push([type, fields]);
    return true;
  }

  /**
   * Game traffic (input, ping): sent now or not at all. A stale input is worse than none, so it
   * is never queued for a reconnect. Accepts an ArrayBuffer or a string.
   */
  sendRaw(data: ArrayBuffer | string): boolean {
    if (this.state !== 'open' || this.#socket?.readyState !== 1) return false;
    this.#socket.send(data);
    return true;
  }

  /** Closes on purpose: no reconnect, the queue is thrown away. */
  close(code = 1000, reason = 'bye'): void {
    clearTimeout(this.#timer);
    this.#queue.length = 0;
    const socket = this.#socket;
    this.#socket = null;
    if (this.state !== 'closed') this.#setState('closed', { code });
    if (socket && socket.readyState <= 1) socket.close(code, reason);
  }
}
