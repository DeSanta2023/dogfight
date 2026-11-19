import { z } from 'zod';
import type { ServerMessage } from '@dogfight/shared/codec.ts';
import {
  parseServerGameJson,
  type PlayerInfo,
  type RoomInfo,
} from '@dogfight/shared/protocol.ts';
import { Connection, type ConnectionOptions, type WireMessage } from './connection.ts';
import { assertNever } from '@dogfight/shared/brand.ts';
import { TypedEventTarget } from './typed-target.ts';

/**
 * Everything the client knows about "being in a room": who is there, the chat, and whether the
 * connection is healthy. It owns a Connection and speaks the server's protocol (see
 * shared/src/protocol.ts). It never touches the DOM: src/ui/room-view.ts listens to its events.
 *
 * Events (CustomEvent):
 *   "joined"    { room, you, players }   the server accepted us (also after a reconnect)
 *   "roster"    { players }
 *   "chat"      { from, text, at }
 *   "status"    { state, delayMs }       'connecting' | 'joined' | 'reconnecting' | 'closed'
 *   "game"      { data, size }           game traffic: an ArrayBuffer, or a parsed JSON snapshot/pong
 *   "rejected"  { code, message }        join failed for good (room full, name taken, ...)
 *   "ended"     { reason }               the connection is over and will not come back
 */
const REJOIN_DELAY_MS = 1500;
const MAX_REJOINS = 10;

// What the server may say, checked with Zod. Deliberately a little more forgiving than the
// server's own schema (missing numbers get the defaults the Lab 05 code used), so an older or
// simpler server still works; the SHAPE (types of the fields) is not negotiable.
const player = z.object({
  id: z.string(),
  name: z.string(),
  slot: z.number().int().default(-1),
});
const room = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int().default(0),
  maxPlayers: z.number().int().default(1),
  arena: z
    .object({
      asteroids: z.number().optional(),
      pickups: z.boolean().optional(),
      hunterChance: z.number().optional(),
      seed: z.number().optional(),
    })
    .default({}),
});
const control = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome') }),
  z.object({
    type: z.literal('joined'),
    room,
    you: z.string(),
    slot: z.number().int().default(-1),
    tickHz: z.number().default(30),
    players: z.array(player).default([]),
  }),
  z.object({ type: z.literal('roster'), players: z.array(player).default([]) }),
  z.object({
    type: z.literal('chat'),
    from: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
type Control = z.infer<typeof control>;

export type SessionState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'closed';
export interface ChatEntry {
  from: string;
  text: string;
  at: number;
}

export interface SessionEvents {
  joined: { room: RoomInfo; you: string; slot: number; players: PlayerInfo[] };
  roster: { players: PlayerInfo[] };
  chat: ChatEntry;
  status: { state: SessionState; delayMs?: number };
  game: { data: ArrayBuffer | ServerMessage; size: number };
  rejected: { code: string; message: string };
  ended: { reason: string };
}

export interface SessionOptions extends ConnectionOptions {
  format?: 'binary' | 'json';
}

export class RoomSession extends TypedEventTarget<SessionEvents> {
  state: SessionState = 'idle';
  room: RoomInfo | null = null;
  you: string | null = null;
  players: PlayerInfo[] = [];
  chat: ChatEntry[] = []; // the last CHAT_KEEP messages
  slot = -1; // which ship is ours (assigned by the room)
  tickHz = 30;
  format: 'binary' | 'json';

  #conn: Connection;
  #target: { room: string; name: string } | null = null;
  #everJoined = false;
  #rejoins = 0;
  #rejoinTimer: ReturnType<typeof setTimeout> | undefined;

  constructor({ format = 'binary', ...options }: SessionOptions) {
    super();
    this.format = format;
    this.#conn = new Connection(options);
    this.#conn.handshake = () =>
      this.#target ? [['join', { ...this.#target, format: this.format }]] : [];
    this.#conn.on('message', ({ message, size }) => this.#onMessage(message, size));
    this.#conn.on('binary', (detail) =>
      this.emit('game', { data: detail.data, size: detail.size }),
    );
    this.#conn.on('status', (detail) => this.#onStatus(detail));
    this.#conn.on('close', (detail) => {
      if (!detail.willRetry)
        this.#end(
          `the server closed the connection (${detail.code} ${detail.reason})`.trim(),
        );
    });
  }

  #set(state: SessionState, extra: { delayMs?: number } = {}): void {
    this.state = state;
    this.emit('status', { state, ...extra });
  }

  join(room: string, name: string): void {
    this.#target = { room, name };
    this.#set('connecting');
    this.#conn.connect();
  }

  /** Returns false when there is nothing to send (empty text) or no way to send it. */
  sendChat(text: unknown): boolean {
    const clean = String(text ?? '').trim();
    if (!clean || this.state === 'closed' || this.state === 'idle') return false;
    return this.#conn.send('chat', { text: clean });
  }

  /** Input / ping for the game. Not queued: see Connection.sendRaw. */
  sendGame(data: ArrayBuffer | string): boolean {
    return this.#conn.sendRaw(data);
  }

  leave(): void {
    clearTimeout(this.#rejoinTimer);
    if (this.state === 'joined') this.#conn.send('leave');
    this.#conn.close(1000, 'leave');
    this.#set('closed');
  }

  #onStatus({ state, delayMs }: { state: string; delayMs?: number }): void {
    if (state === 'waiting')
      this.#set('reconnecting', delayMs === undefined ? {} : { delayMs });
    else if (state === 'connecting' && this.state === 'reconnecting')
      this.#set('reconnecting', {});
  }

  #end(reason: string): void {
    clearTimeout(this.#rejoinTimer);
    if (this.state === 'closed') return;
    this.#set('closed');
    this.emit('ended', { reason });
  }

  #onMessage(wire: WireMessage, size = 0): void {
    if (wire.type === 'snapshot' || wire.type === 'pong') {
      // ?format=json: the game arrives as text. Zod checks it before the game ever sees it.
      const data = parseServerGameJson(wire);
      if (data) this.emit('game', { data, size });
      return;
    }
    const parsed = control.safeParse(wire);
    if (!parsed.success) return; // unknown or malformed message: ignored (and never an exception)
    const message: Control = parsed.data;
    switch (message.type) {
      case 'welcome':
        break; // nothing to do: the handshake already sent our join
      case 'joined':
        this.room = message.room;
        this.you = message.you;
        this.slot = message.slot;
        this.tickHz = message.tickHz;
        this.players = message.players;
        this.#everJoined = true;
        this.#rejoins = 0;
        this.#set('joined');
        this.emit('joined', {
          room: message.room,
          you: message.you,
          slot: this.slot,
          players: this.players,
        });
        break;
      case 'roster':
        this.players = message.players;
        this.emit('roster', { players: this.players });
        break;
      case 'chat': {
        const entry: ChatEntry = {
          from: message.from,
          text: message.text,
          at: message.at,
        };
        this.chat.push(entry);
        if (this.chat.length > 100) this.chat.shift();
        this.emit('chat', entry);
        break;
      }
      case 'error':
        this.#onError(message);
        break;
      default:
        assertNever(message);
    }
  }

  #onError({ code, message }: { code: string; message: string }): void {
    // After a network drop the server may still hold our OLD socket (it notices only at the
    // next heartbeat), so our own callsign looks "taken". Retry a few times before giving up.
    if (code === 'name_taken' && this.#everJoined && this.#rejoins < MAX_REJOINS) {
      this.#rejoins++;
      this.#rejoinTimer = setTimeout(() => {
        if (this.#target)
          this.#conn.send('join', { ...this.#target, format: this.format });
      }, REJOIN_DELAY_MS);
      return;
    }
    if (this.state === 'joined') return; // e.g. "not in room": nothing the player can act on
    this.#conn.close(1000, 'rejected');
    this.#set('closed');
    this.emit('rejected', { code, message });
  }
}
