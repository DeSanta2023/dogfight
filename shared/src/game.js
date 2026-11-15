import { ARENA } from './arena.js';
import { Asteroid, Explosion, PICKUP_TYPES, Pickup } from './entities.js';
import { createRng } from './rng.js';
import { Ship } from './ship.js';
import { Vector2 } from './vector.js';
import { World } from './world.js';

export const RESPAWN_DELAY = 2; // seconds between death and respawn
const RESPAWN_PROTECTION = 2; // seconds of invulnerability after respawning
const ASTEROID_REFILL = 3; // seconds before a missing asteroid is replaced
const NO_INPUTS = new Map();
const KILL_BONUS = 100; // points for shooting down another player

/**
 * Rules of one match on top of a World: score, deaths, respawn, asteroid refill, pickups.
 * Pure simulation: no DOM, no canvas, no Math.random (seeded rng), so it runs in Node tests.
 */
export class Game {
  world = new World();
  /**
   * Outbound notifications: "fired", "hit", "exploded", "collected" as CustomEvents whose
   * `detail` is plain data (numbers and strings, never entities). Audio and the HUD subscribe;
   * the simulation imports neither, and nothing it does depends on who is listening.
   */
  events = new EventTarget();
  /** slot -> { slot, ship, score, deaths, respawnIn }. Offline there is one player: slot 0. */
  #players = new Map();

  #rng;
  #config;
  #asteroidTimer = 0;
  #pickupTimer;

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
  } = {}) {
    this.#rng = createRng(seed);
    this.#config = { asteroids, pickups, hunterChance, cosmetics };
    this.#pickupTimer = this.#rng.range(6, 10);

    for (let slot = 0; slot < players; slot++) this.addPlayer(slot, { safe: slot > 0 });
    for (let i = 0; i < asteroids; i++) this.#spawnAsteroid();
  }

  // The offline game is "slot 0 is me": these keep Labs 1-4 code and tests unchanged.
  get ship() {
    return this.#players.get(0)?.ship ?? null;
  }
  get score() {
    return this.#players.get(0)?.score ?? 0;
  }
  get deaths() {
    return this.#players.get(0)?.deaths ?? 0;
  }

  get playerSlots() {
    return [...this.#players.keys()];
  }

  player(slot) {
    return this.#players.get(slot) ?? null;
  }

  addPlayer(slot, { safe = true } = {}) {
    if (this.#players.has(slot)) return this.#players.get(slot);
    const record = { slot, ship: null, score: 0, deaths: 0, respawnIn: 0 };
    this.#players.set(slot, record);
    const options = { slot };
    if (safe) options.pos = this.#safeSpot(180);
    record.ship = this.world.spawn(new Ship(options));
    return record;
  }

  /** The player left: the ship disappears without an explosion or a death. */
  removePlayer(slot) {
    const record = this.#players.get(slot);
    if (!record) return;
    if (record.ship) record.ship.alive = false;
    this.#players.delete(slot);
  }

  /** Read-only snapshot of one player's HUD numbers. */
  hudFor(slot) {
    const p = this.#players.get(slot);
    return {
      score: p?.score ?? 0,
      deaths: p?.deaths ?? 0,
      hp: p?.ship?.hp ?? 0,
      effects: p?.ship ? [...p.ship.effects] : [],
      respawnIn: p && !p.ship ? Math.max(0, p.respawnIn) : 0,
    };
  }

  get hud() {
    return this.hudFor(0);
  }

  /** Offline: one input source steers slot 0. */
  step(dt, input) {
    this.stepInputs(dt, new Map([[0, input]]));
  }

  /** `inputs`: Map<slot, input source>. A slot without an entry simply coasts. */
  stepInputs(dt, inputs) {
    const byShip = NO_INPUTS === inputs ? NO_INPUTS : new Map();
    for (const [slot, input] of inputs) {
      const ship = this.#players.get(slot)?.ship;
      if (ship) byShip.set(ship.id, input);
    }
    this.world.step(dt, byShip);
    this.#handleEvents();
    this.#runTimers(dt);
  }

  /** Offline (one player) every bullet is "mine"; online the bullet knows its owner's slot. */
  #ownerOf(bullet) {
    if (bullet?.kind !== 'bullet') return null;
    return (
      this.#players.get(bullet.ownerSlot) ??
      (this.#players.size === 1 ? this.player(this.playerSlots[0]) : null)
    );
  }

  #publish(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #handleEvents() {
    for (const event of this.world.drainEvents()) {
      if (event.type === 'fired') {
        const { entity, by } = event;
        this.#publish('fired', {
          x: entity.pos.x,
          y: entity.pos.y,
          by: by.kind,
          slot: by.slot ?? -1,
        });
        continue;
      }
      if (event.type === 'hit') {
        const { target, by } = event;
        this.#publish('hit', {
          x: target.pos.x,
          y: target.pos.y,
          target: target.kind,
          slot: target.slot ?? -1,
          by: by?.kind ?? null,
        });
        continue;
      }
      if (event.type === 'collected') {
        const { entity, by } = event;
        this.#publish('collected', {
          x: entity.pos.x,
          y: entity.pos.y,
          type: entity.type,
          by: by.kind,
        });
        continue;
      }
      if (event.type !== 'destroyed') continue;
      const { entity, by } = event;

      if (entity.kind === 'ship') {
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
        if (points) killer.score += points;
        this.#publish('exploded', {
          x: entity.pos.x,
          y: entity.pos.y,
          kind: 'ship',
          slot: entity.slot,
          points,
        });
      } else if (entity.kind === 'asteroid') {
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
        this.#publish('exploded', {
          x: entity.pos.x,
          y: entity.pos.y,
          kind: 'asteroid',
          size: entity.size,
          slot: owner?.slot ?? -1,
          points,
        });
      }
    }
  }

  #runTimers(dt) {
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

  #count(kind) {
    let n = 0;
    for (const _ of this.world.ofKind(kind)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** A random point at least `minDist` away from every asteroid (and the ship, if alive). */
  #safeSpot(minDist) {
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

  #spawnAsteroid() {
    const rng = this.#rng;
    const size = rng.pick([1, 2, 2, 3, 3]);
    const pos = this.#safeSpot(220);
    const vel = Vector2.fromAngle(rng.range(0, Math.PI * 2), rng.range(35, 90));
    const hunter = size === 1 && rng.next() < this.#config.hunterChance;
    this.world.spawn(new Asteroid({ pos, vel, size, hunter }));
  }
}
