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
export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code; // machine-readable: 'room_full' | 'name_taken' | 'no_such_room' | ...
  }
}

export class Room extends EventEmitter {
  #players = new Map(); // id -> { id, name }

  constructor({ id, name, maxPlayers, arena, custom = false }) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.custom = custom;
    this.createdAt = Date.now();
  }

  get size() {
    return this.#players.size;
  }

  get players() {
    return [...this.#players.values()].map(({ id, name }) => ({ id, name }));
  }

  has(playerId) {
    return this.#players.has(playerId);
  }

  join(player) {
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
    this.#players.set(player.id, { id: player.id, name: player.name });
    this.emit('joined', {
      player: { id: player.id, name: player.name },
      players: this.players,
    });
  }

  leave(playerId) {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    this.emit('left', { player, players: this.players });
    if (this.#players.size === 0) this.emit('empty', {});
    return true;
  }

  chat(playerId, text) {
    const player = this.#players.get(playerId);
    if (!player) throw new RoomError('not_in_room', 'Join the room first');
    this.emit('chat', { from: player.name, text, at: Date.now() });
  }

  toJSON() {
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
export const PRESETS = [
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
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #idleTimers = new Map();

  constructor({ maxRooms = 50, idleMs = 60_000, presets = PRESETS } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.idleMs = idleMs;
    this.presets = presets;
  }

  get size() {
    return this.#rooms.size;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  /** Existing room, or a new one from a preset. Throws RoomError otherwise. */
  getOrCreate(id) {
    const live = this.#rooms.get(id);
    if (live) return live;
    const preset = this.presets.find((p) => p.id === id);
    if (!preset) throw new RoomError('no_such_room', `No room "${id}"`);
    return this.create(preset);
  }

  create({ id, name, maxPlayers, arena, custom = false }) {
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

  #remove(room) {
    if (this.#rooms.get(room.id) !== room) return;
    clearTimeout(this.#idleTimers.get(room.id));
    this.#idleTimers.delete(room.id);
    this.#rooms.delete(room.id);
    this.emit('removed', room);
  }

  /** Every preset (live room if there is one, else 0 players), then custom rooms. */
  list() {
    const presetIds = new Set(this.presets.map((p) => p.id));
    const fromPresets = this.presets.map((p) =>
      this.#rooms.has(p.id)
        ? this.#rooms.get(p.id).toJSON()
        : {
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

  closeAll() {
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    for (const room of [...this.#rooms.values()]) this.#remove(room);
  }
}
