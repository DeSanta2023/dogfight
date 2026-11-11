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
 *                       "message" { message }                  a parsed server message
 *                       "close" { code, reason, willRetry }
 */
const NO_RETRY = new Set([1000, 1003, 1007, 1008, 1009]);

export class Connection extends EventTarget {
  state = 'idle'; // idle | connecting | open | waiting | closed
  attempt = 0; // failed attempts since the last successful open
  dropped = 0; // messages thrown away because the queue was full
  invalid = 0; // server frames that were not valid protocol messages
  handshake = () => [];

  #url;
  #WebSocket;
  #baseMs;
  #maxMs;
  #maxQueue;
  #random;
  #socket = null;
  #queue = [];
  #timer = null;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    baseMs = 500,
    maxMs = 15_000,
    maxQueue = 50,
    random = Math.random,
  }) {
    super();
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
    this.#maxQueue = maxQueue;
    this.#random = random;
  }

  get queued() {
    return this.#queue.length;
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(
      new CustomEvent('status', { detail: { state, attempt: this.attempt, ...extra } }),
    );
  }

  connect() {
    if (this.state === 'connecting' || this.state === 'open') return;
    clearTimeout(this.#timer);
    this.#setState('connecting');
    let socket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch {
      // A malformed URL throws synchronously: treat it like any other failed attempt.
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
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
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        message = null;
      }
      if (!message || message.v !== 1 || typeof message.type !== 'string') {
        this.invalid++;
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: { message } }));
    });
    // 'error' carries no information in browsers (by design); the 'close' that follows does.
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return; // an old socket we already replaced
      this.#socket = null;
      if (this.state === 'closed') return;
      const willRetry = !NO_RETRY.has(event.code);
      this.dispatchEvent(
        new CustomEvent('close', {
          detail: { code: event.code, reason: event.reason, willRetry },
        }),
      );
      if (willRetry) this.#scheduleRetry();
      else this.#setState('closed', { code: event.code, reason: event.reason });
    });
  }

  #scheduleRetry() {
    const cap = Math.min(this.#maxMs, this.#baseMs * 2 ** this.attempt);
    const delayMs = Math.round(cap / 2 + (this.#random() * cap) / 2); // "equal jitter": never 0
    this.attempt++;
    this.#setState('waiting', { delayMs });
    this.#timer = setTimeout(() => this.connect(), delayMs);
  }

  #write(type, fields) {
    this.#socket.send(JSON.stringify({ v: 1, type, ...fields }));
  }

  /** Send now if the socket is open, otherwise queue. Returns false when the connection is closed for good. */
  send(type, fields = {}) {
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

  /** Closes on purpose: no reconnect, the queue is thrown away. */
  close(code = 1000, reason = 'bye') {
    clearTimeout(this.#timer);
    this.#queue.length = 0;
    const socket = this.#socket;
    this.#socket = null;
    if (this.state !== 'closed') this.#setState('closed', { code });
    if (socket && socket.readyState <= 1) socket.close(code, reason);
  }
}
