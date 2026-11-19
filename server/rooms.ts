import { EventEmitter } from 'node:events';

/**
 * Rooms know nothing about sockets or HTTP: a Room is a roster plus chat, and it TELLS the
 * outside world what happens by emitting events. ws.js, the match log and the tests are all just
 * listeners. (EventEmitter calls listeners synchronously, in registration order.)
 *
 * Room events (all payloads are plain data):
 *   "joined"  { player, players }   "left"  { player, players }   "chat"  { from, text, at }
 *   "empty"   {}                    the last player left: RoomManager deletes the room
 */
/** Machine-readable reasons a room operation fails: a closed set, so a typo cannot compile. */
export type RoomErrorCode =
  | 'room_full'
  | 'name_taken'
  | 'no_such_room'
  | 'room_exists'
  | 'too_many_rooms'
  | 'already_joined'
  | 'not_in_room';

export class RoomError extends Error {
  override name = 'RoomError';
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Who is in a room. `slot` is which ship is theirs in the game. */
export interface Player {
  readonly id: string;
  readonly name: string;
  readonly slot: number;
}

/** The arena settings of a room: what the Game is built from. */
export interface ArenaSettings {
  asteroids?: number;
  pickups?: boolean;
  hunterChance?: number;
  seed?: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  arena: ArenaSettings;
}

export interface RoomSpec {
  id: string;
  name: string;
  maxPlayers: number;
  arena: ArenaSettings;
  custom?: boolean;
}

/** One entry per event: the tuple is the argument list of its listeners. */
interface RoomEvents {
  joined: [{ player: Player; players: Player[] }];
  left: [{ player: Player; players: Player[] }];
  chat: [{ from: string; text: string; at: number }];
  empty: [Record<string, never>];
}

export class Room extends EventEmitter<RoomEvents> {
  #players = new Map<string, Player>();
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: ArenaSettings;
  readonly custom: boolean;
  readonly createdAt: number;

  constructor({ id, name, maxPlayers, arena, custom = false }: RoomSpec) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.custom = custom;
    this.createdAt = Date.now();
  }

  get size(): number {
    return this.#players.size;
  }

  get players(): Player[] {
    return [...this.#players.values()].map(({ id, name, slot }) => ({ id, name, slot }));
  }

  /** The player's slot (0..maxPlayers-1): which ship is theirs in the game. */
  slotOf(playerId: string): number {
    return this.#players.get(playerId)?.slot ?? -1;
  }

  has(playerId: string): boolean {
    return this.#players.has(playerId);
  }

  join(player: { id: string; name: string }): void {
    if (this.#players.has(player.id))
      throw new RoomError('already_joined', 'Already in the room');
    if (this.#players.size >= this.maxPlayers)
      throw new RoomError('room_full', 'Room is full');
    const lower = player.name.toLowerCase();
    for (const other of this.#players.values())
      if (other.name.toLowerCase() === lower)
        throw new RoomError(
          'name_taken',
          `The callsign "${player.name}" is already used here`,
        );
    // The lowest free slot: a player who leaves frees theirs for the next one.
    const used = new Set([...this.#players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    this.#players.set(player.id, { id: player.id, name: player.name, slot });
    this.emit('joined', {
      player: { id: player.id, name: player.name, slot },
      players: this.players,
    });
  }

  leave(playerId: string): boolean {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    this.emit('left', { player, players: this.players });
    if (this.#players.size === 0) this.emit('empty', {});
    return true;
  }

  chat(playerId: string, text: string): void {
    const player = this.#players.get(playerId);
    if (!player) throw new RoomError('not_in_room', 'Join the room first');
    this.emit('chat', { from: player.name, text, at: Date.now() });
  }

  toJSON(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }
}

/** The four arenas of Lab 03. A preset becomes a live Room the moment someone joins it. */
export const PRESETS: readonly RoomSpec[] = [
  {
    id: 'quiet-orbit',
    name: 'Quiet Orbit',
    maxPlayers: 4,
    arena: { asteroids: 3, pickups: false, hunterChance: 0, seed: 101 },
  },
  {
    id: 'rock-garden',
    name: 'Rock Garden',
    maxPlayers: 6,
    arena: { asteroids: 9, pickups: true, hunterChance: 0.2, seed: 202 },
  },
  {
    id: 'hunters-nest',
    name: "Hunters' Nest",
    maxPlayers: 8,
    arena: { asteroids: 10, pickups: true, hunterChance: 1, seed: 303 },
  },
  {
    id: 'duel',
    name: 'Duel (2 players)',
    maxPlayers: 2,
    arena: { asteroids: 5, pickups: true, hunterChance: 0.4, seed: 404 },
  },
];

/**
 * Owns all rooms. An EMPTY room is deleted, so the manager never leaks them. To keep the lobby
 * from being empty, list() also shows the presets that have no live room (0 players); joining
 * one creates the room on demand.
 *
 * Manager events: "created" (room), "removed" (room).
 */
interface ManagerEvents {
  created: [Room];
  removed: [Room];
}

export class RoomManager extends EventEmitter<ManagerEvents> {
  #rooms = new Map<string, Room>();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly maxRooms: number;
  readonly idleMs: number;
  readonly presets: readonly RoomSpec[];

  constructor({
    maxRooms = 50,
    idleMs = 60_000,
    presets = PRESETS,
  }: { maxRooms?: number; idleMs?: number; presets?: readonly RoomSpec[] } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.idleMs = idleMs;
    this.presets = presets;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  /** Existing room, or a new one from a preset. Throws RoomError otherwise. */
  getOrCreate(id: string): Room {
    const live = this.#rooms.get(id);
    if (live) return live;
    const preset = this.presets.find((p) => p.id === id);
    if (!preset) throw new RoomError('no_such_room', `No room "${id}"`);
    return this.create(preset);
  }

  create({ id, name, maxPlayers, arena, custom = false }: RoomSpec): Room {
    if (this.#rooms.has(id))
      throw new RoomError('room_exists', `Room "${id}" already exists`);
    if (this.#rooms.size >= this.maxRooms)
      throw new RoomError('too_many_rooms', 'Too many rooms');
    const room = new Room({ id, name, maxPlayers, arena, custom });
    this.#rooms.set(id, room);
    room.on('empty', () => this.#remove(room));
    // A room created over HTTP that nobody ever joins would live forever: give it a deadline.
    if (custom) {
      const timer = setTimeout(() => room.size === 0 && this.#remove(room), this.idleMs);
      timer.unref();
      this.#idleTimers.set(id, timer);
    }
    this.emit('created', room);
    return room;
  }

  #remove(room: Room): void {
    if (this.#rooms.get(room.id) !== room) return;
    const timer = this.#idleTimers.get(room.id);
    if (timer) clearTimeout(timer);
    this.#idleTimers.delete(room.id);
    this.#rooms.delete(room.id);
    this.emit('removed', room);
  }

  /** Every preset (live room if there is one, else 0 players), then custom rooms. */
  list(): RoomInfo[] {
    const presetIds = new Set(this.presets.map((p) => p.id));
    const fromPresets = this.presets.map(
      (p): RoomInfo =>
        this.#rooms.get(p.id)?.toJSON() ?? {
          id: p.id,
          name: p.name,
          players: 0,
          maxPlayers: p.maxPlayers,
          arena: p.arena,
        },
    );
    const custom = [...this.#rooms.values()].filter((r) => !presetIds.has(r.id));
    return [...fromPresets, ...custom.map((r) => r.toJSON())];
  }

  closeAll(): void {
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    for (const room of [...this.#rooms.values()]) this.#remove(room);
  }
}
