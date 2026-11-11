import { Connection } from './connection.js';

/**
 * Everything the client knows about "being in a room": who is there, the chat, and whether the
 * connection is healthy. It owns a Connection and speaks the server's protocol (see
 * server/protocol.js). It never touches the DOM: src/ui/room-view.js listens to its events.
 *
 * Events (CustomEvent):
 *   "joined"    { room, you, players }   the server accepted us (also after a reconnect)
 *   "roster"    { players }
 *   "chat"      { from, text, at }
 *   "status"    { state, delayMs }       'connecting' | 'joined' | 'reconnecting' | 'closed'
 *   "rejected"  { code, message }        join failed for good (room full, name taken, ...)
 *   "ended"     { reason }               the connection is over and will not come back
 */
const REJOIN_DELAY_MS = 1500;
const MAX_REJOINS = 10;

export class RoomSession extends EventTarget {
  state = 'idle';
  room = null;
  you = null;
  players = [];
  chat = []; // the last CHAT_KEEP messages

  #conn;
  #target = null;
  #everJoined = false;
  #rejoins = 0;
  #rejoinTimer = null;

  constructor(options) {
    super();
    this.#conn = new Connection(options);
    this.#conn.handshake = () => (this.#target ? [['join', this.#target]] : []);
    this.#conn.addEventListener('message', ({ detail }) =>
      this.#onMessage(detail.message),
    );
    this.#conn.addEventListener('status', ({ detail }) => this.#onStatus(detail));
    this.#conn.addEventListener('close', ({ detail }) => {
      if (!detail.willRetry)
        this.#end(
          `the server closed the connection (${detail.code} ${detail.reason})`.trim(),
        );
    });
  }

  #set(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, ...extra } }));
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  join(room, name) {
    this.#target = { room, name };
    this.#set('connecting');
    this.#conn.connect();
  }

  /** Returns false when there is nothing to send (empty text) or no way to send it. */
  sendChat(text) {
    const clean = String(text ?? '').trim();
    if (!clean || this.state === 'closed' || this.state === 'idle') return false;
    return this.#conn.send('chat', { text: clean });
  }

  leave() {
    clearTimeout(this.#rejoinTimer);
    if (this.state === 'joined') this.#conn.send('leave');
    this.#conn.close(1000, 'leave');
    this.#set('closed');
  }

  #onStatus({ state, delayMs }) {
    if (state === 'waiting') this.#set('reconnecting', { delayMs });
    else if (state === 'connecting' && this.state === 'reconnecting')
      this.#set('reconnecting', {});
  }

  #end(reason) {
    clearTimeout(this.#rejoinTimer);
    if (this.state === 'closed') return;
    this.#set('closed');
    this.#emit('ended', { reason });
  }

  #onMessage(message) {
    switch (message.type) {
      case 'joined':
        this.room = message.room;
        this.you = message.you;
        this.players = message.players ?? [];
        this.#everJoined = true;
        this.#rejoins = 0;
        this.#set('joined');
        this.#emit('joined', { room: this.room, you: this.you, players: this.players });
        break;
      case 'roster':
        this.players = message.players ?? [];
        this.#emit('roster', { players: this.players });
        break;
      case 'chat': {
        const entry = {
          from: String(message.from),
          text: String(message.text),
          at: message.at,
        };
        this.chat.push(entry);
        if (this.chat.length > 100) this.chat.shift();
        this.#emit('chat', entry);
        break;
      }
      case 'error':
        this.#onError(message);
        break;
      // 'welcome' needs no action: the handshake already sent our join.
    }
  }

  #onError({ code, message }) {
    // After a network drop the server may still hold our OLD socket (it notices only at the
    // next heartbeat), so our own callsign looks "taken". Retry a few times before giving up.
    if (code === 'name_taken' && this.#everJoined && this.#rejoins < MAX_REJOINS) {
      this.#rejoins++;
      this.#rejoinTimer = setTimeout(() => {
        if (this.#target) this.#conn.send('join', this.#target);
      }, REJOIN_DELAY_MS);
      return;
    }
    if (this.state === 'joined') return; // e.g. "not in room": nothing the player can act on
    this.#conn.close(1000, 'rejected');
    this.#set('closed');
    this.#emit('rejected', { code, message });
  }
}
