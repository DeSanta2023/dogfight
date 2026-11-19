import { ARENA } from './arena.ts';
import {
  Asteroid,
  Explosion,
  PICKUP_TYPES,
  Pickup,
  type PickupType,
} from './entities.ts';
import { createRng, type Rng } from './rng.ts';
import { Ship, type InputSource } from './ship.ts';
import { Vector2 } from './vector.ts';
import { World } from './world.ts';
import { GameEvents } from './events.ts';
import { assertNever, type EntityId } from './brand.ts';
import { isKind } from './kinds.ts';
import type { Entity, EntityKind } from './entity.ts';
import type { AsteroidSize, Bullet } from './entities.ts';

export const RESPAWN_DELAY = 2; // seconds between death and respawn
const RESPAWN_PROTECTION = 2; // seconds of invulnerability after respawning
const ASTEROID_REFILL = 3; // seconds before a missing asteroid is replaced
const KILL_BONUS = 100; // points for shooting down another player

/**
 * Rules of one match on top of a World: score, deaths, respawn, asteroid refill, pickups.
 * Pure simulation: no DOM, no canvas, no Math.random (seeded rng), so it runs in Node tests.
 */
export interface GameOptions {
  seed?: number;
  asteroids?: number;
  pickups?: boolean;
  hunterChance?: number;
  /** Ships that exist from the start (offline: 1; a server starts with 0). */
  players?: number;
  /** false = no explosion particles (the server has nobody to show them to). */
  cosmetics?: boolean;
}

/** One participant: a slot number, the current ship (null while waiting to respawn) and counters. */
export interface PlayerRecord {
  slot: number;
  ship: Ship | null;
  score: number;
  deaths: number;
  respawnIn: number;
}

export interface Hud {
  score: number;
  deaths: number;
  hp: number;
  effects: [PickupType, number][];
  respawnIn: number;
}

export class Game {
  world = new World();
  /**
   * Outbound notifications: "fired", "hit", "exploded", "collected"; each carries plain data (numbers and strings, never entities). Audio and the HUD subscribe;
   * the simulation imports neither, and nothing it does depends on who is listening.
   */
  events = new GameEvents();
  /** slot -> { slot, ship, score, deaths, respawnIn }. Offline there is one player: slot 0. */
  #players = new Map<number, PlayerRecord>();

  #rng: Rng;
  #config: Required<
    Pick<GameOptions, 'asteroids' | 'pickups' | 'hunterChance' | 'cosmetics'>
  >;
  #asteroidTimer = 0;
  #pickupTimer: number;

  /**
   * `players`: how many ships exist from the start (offline: 1). A server starts with 0 and calls
   * addPlayer(slot) when somebody joins. `cosmetics: false` = no explosion particles (the server
   * has nobody to show them to; each browser makes its own from the events).
   */
  constructor({
    seed = 1,
    asteroids = 5,
    pickups = true,
    hunterChance = 0.4,
    players = 1,
    cosmetics = true,
  }: GameOptions = {}) {
    this.#rng = createRng(seed);
    this.#config = { asteroids, pickups, hunterChance, cosmetics };
    this.#pickupTimer = this.#rng.range(6, 10);

    for (let slot = 0; slot < players; slot++) this.addPlayer(slot, { safe: slot > 0 });
    for (let i = 0; i < asteroids; i++) this.#spawnAsteroid();
  }

  // The offline game is "slot 0 is me": these keep Labs 1-4 code and tests unchanged.
  get ship(): Ship | null {
    return this.#players.get(0)?.ship ?? null;
  }
  get score(): number {
    return this.#players.get(0)?.score ?? 0;
  }
  get deaths(): number {
    return this.#players.get(0)?.deaths ?? 0;
  }

  get playerSlots(): number[] {
    return [...this.#players.keys()];
  }

  player(slot: number): PlayerRecord | null {
    return this.#players.get(slot) ?? null;
  }

  addPlayer(slot: number, { safe = true }: { safe?: boolean } = {}): PlayerRecord {
    const existing = this.#players.get(slot);
    if (existing) return existing;
    const record: PlayerRecord = { slot, ship: null, score: 0, deaths: 0, respawnIn: 0 };
    this.#players.set(slot, record);
    record.ship = this.world.spawn(
      new Ship(safe ? { slot, pos: this.#safeSpot(180) } : { slot }),
    );
    return record;
  }

  /** The player left: the ship disappears without an explosion or a death. */
  removePlayer(slot: number): void {
    const record = this.#players.get(slot);
    if (!record) return;
    if (record.ship) record.ship.alive = false;
    this.#players.delete(slot);
  }

  /** Read-only snapshot of one player's HUD numbers. */
  hudFor(slot: number): Hud {
    const p = this.#players.get(slot);
    return {
      score: p?.score ?? 0,
      deaths: p?.deaths ?? 0,
      hp: p?.ship?.hp ?? 0,
      effects: p?.ship ? [...p.ship.effects] : [],
      respawnIn: p && !p.ship ? Math.max(0, p.respawnIn) : 0,
    };
  }

  get hud(): Hud {
    return this.hudFor(0);
  }

  /** Offline: one input source steers slot 0. */
  step(dt: number, input: InputSource): void {
    this.stepInputs(dt, new Map([[0, input]]));
  }

  /** `inputs`: Map<slot, input source>. A slot without an entry simply coasts. */
  stepInputs(dt: number, inputs: ReadonlyMap<number, InputSource>): void {
    const byShip = new Map<EntityId, InputSource>();
    for (const [slot, input] of inputs) {
      const ship = this.#players.get(slot)?.ship;
      if (ship) byShip.set(ship.id, input);
    }
    this.world.step(dt, byShip);
    this.#handleEvents();
    this.#runTimers(dt);
  }

  /** Offline (one player) every bullet is "mine"; online the bullet knows its owner's slot. */
  #ownerOf(by: Entity | null): PlayerRecord | null {
    if (!by || !isKind(by, 'bullet')) return null;
    const bullet: Bullet = by;
    const owner = this.#players.get(bullet.ownerSlot);
    if (owner) return owner;
    const only = this.#players.values().next().value;
    return this.#players.size === 1 && only ? only : null;
  }

  #handleEvents(): void {
    for (const event of this.world.drainEvents()) {
      switch (event.type) {
        case 'fired': {
          const { entity, by } = event;
          this.events.emit('fired', {
            x: entity.pos.x,
            y: entity.pos.y,
            by: by.kind,
            slot: by.slot,
          });
          break;
        }
        case 'hit': {
          const { target, by } = event;
          this.events.emit('hit', {
            x: target.pos.x,
            y: target.pos.y,
            target: target.kind,
            slot: target.kind === 'ship' ? target.slot : -1,
            by: by?.kind ?? null,
          });
          break;
        }
        case 'collected': {
          const { entity, by } = event;
          this.events.emit('collected', {
            x: entity.pos.x,
            y: entity.pos.y,
            type: entity.type,
            by: by.kind,
          });
          break;
        }
        case 'destroyed':
          this.#onDestroyed(event.entity, event.by);
          break;
        default:
          // A new kind of world event without a handler here fails to COMPILE.
          return assertNever(event);
      }
    }
  }

  #onDestroyed(entity: Entity, by: Entity | null): void {
    if (isKind(entity, 'ship')) {
      if (this.#config.cosmetics)
        this.world.spawn(
          new Explosion({
            pos: entity.pos,
            rng: this.#rng,
            count: 30,
            speed: 260,
            life: 1,
            variant: 'ship',
          }),
        );
      const victim = this.#players.get(entity.slot);
      if (victim && victim.ship === entity) {
        victim.deaths++;
        victim.ship = null;
        victim.respawnIn = RESPAWN_DELAY;
      }
      // Shot down by ANOTHER player's bullet: a kill bonus for the shooter.
      const killer = this.#ownerOf(by);
      const points = killer && killer.slot !== entity.slot ? KILL_BONUS : 0;
      if (killer && points) killer.score += points;
      this.events.emit('exploded', {
        x: entity.pos.x,
        y: entity.pos.y,
        kind: 'ship',
        slot: entity.slot,
        points,
      });
    } else if (isKind(entity, 'asteroid')) {
      if (this.#config.cosmetics)
        this.world.spawn(
          new Explosion({
            pos: entity.pos,
            rng: this.#rng,
            count: 8 + 4 * entity.size,
            speed: 140,
          }),
        );
      const owner = this.#ownerOf(by);
      const points = owner ? entity.points : 0;
      if (owner) owner.score += points;
      this.events.emit('exploded', {
        x: entity.pos.x,
        y: entity.pos.y,
        kind: 'asteroid',
        size: entity.size,
        slot: owner?.slot ?? -1,
        points,
      });
    }
  }

  #runTimers(dt: number): void {
    for (const p of this.#players.values()) {
      if (p.ship) continue;
      p.respawnIn -= dt;
      if (p.respawnIn <= 0) {
        const pos = this.#safeSpot(180);
        p.ship = this.world.spawn(
          new Ship({ pos, invulnerable: RESPAWN_PROTECTION, slot: p.slot }),
        );
      }
    }

    if (this.#count('asteroid') < this.#config.asteroids) {
      this.#asteroidTimer += dt;
      if (this.#asteroidTimer >= ASTEROID_REFILL) {
        this.#asteroidTimer = 0;
        this.#spawnAsteroid();
      }
    } else {
      this.#asteroidTimer = 0;
    }

    if (this.#config.pickups) {
      this.#pickupTimer -= dt;
      if (this.#pickupTimer <= 0) {
        this.#pickupTimer = this.#rng.range(8, 12);
        if (this.#count('pickup') < 2) {
          const type = this.#rng.pick(PICKUP_TYPES);
          this.world.spawn(new Pickup({ pos: this.#safeSpot(60), type }));
        }
      }
    }
  }

  #count(kind: EntityKind): number {
    let n = 0;
    for (const _ of this.world.ofKind(kind)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** A random point at least `minDist` away from every asteroid (and the ship, if alive). */
  #safeSpot(minDist: number): Vector2 {
    const rng = this.#rng;
    for (let attempt = 0; attempt < 40; attempt++) {
      const pos = new Vector2(
        rng.range(60, ARENA.width - 60),
        rng.range(60, ARENA.height - 60),
      );
      let safe = true;
      for (const asteroid of this.world.ofKind('asteroid')) {
        if (pos.distanceTo(asteroid.pos) < asteroid.radius + minDist) safe = false;
      }
      for (const p of this.#players.values())
        if (p.ship && pos.distanceTo(p.ship.pos) < minDist) safe = false;
      if (safe) return pos;
    }
    return new Vector2(ARENA.width / 2, ARENA.height / 2);
  }

  #spawnAsteroid(): void {
    const rng = this.#rng;
    const size = rng.pick<AsteroidSize>([1, 2, 2, 3, 3]);
    const pos = this.#safeSpot(220);
    const vel = Vector2.fromAngle(rng.range(0, Math.PI * 2), rng.range(35, 90));
    const hunter = size === 1 && rng.next() < this.#config.hunterChance;
    this.world.spawn(new Asteroid({ pos, vel, size, hunter }));
  }
}
