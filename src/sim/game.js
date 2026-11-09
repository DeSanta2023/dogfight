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
  ship = null;
  score = 0;
  deaths = 0;

  #rng;
  #config;
  #respawnIn = 0;
  #asteroidTimer = 0;
  #pickupTimer;

  constructor({ seed = 1, asteroids = 5, pickups = true, hunterChance = 0.4 } = {}) {
    this.#rng = createRng(seed);
    this.#config = { asteroids, pickups, hunterChance };
    this.#pickupTimer = this.#rng.range(6, 10);

    this.ship = this.world.spawn(new Ship());
    for (let i = 0; i < asteroids; i++) this.#spawnAsteroid();
  }

  /** Read-only snapshot for the HUD. */
  get hud() {
    return {
      score: this.score,
      deaths: this.deaths,
      hp: this.ship?.hp ?? 0,
      effects: this.ship ? [...this.ship.effects] : [],
      respawnIn: this.ship ? 0 : Math.max(0, this.#respawnIn),
    };
  }

  step(dt, input) {
    const inputs = this.ship ? new Map([[this.ship.id, input]]) : NO_INPUTS;
    this.world.step(dt, inputs);
    this.#handleEvents();
    this.#runTimers(dt);
  }

  #publish(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #handleEvents() {
    for (const event of this.world.drainEvents()) {
      if (event.type === 'fired') {
        const { entity, by } = event;
        this.#publish('fired', { x: entity.pos.x, y: entity.pos.y, by: by.kind });
        continue;
      }
      if (event.type === 'hit') {
        const { target, by } = event;
        this.#publish('hit', {
          x: target.pos.x,
          y: target.pos.y,
          target: target.kind,
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
        this.deaths++;
        this.ship = null;
        this.#respawnIn = RESPAWN_DELAY;
        this.#publish('exploded', {
          x: entity.pos.x,
          y: entity.pos.y,
          kind: 'ship',
          points: 0,
        });
      } else if (entity.kind === 'asteroid') {
        this.world.spawn(
          new Explosion({
            pos: entity.pos,
            rng: this.#rng,
            count: 8 + 4 * entity.size,
            speed: 140,
          }),
        );
        const points = by?.kind === 'bullet' ? entity.points : 0;
        this.score += points;
        this.#publish('exploded', {
          x: entity.pos.x,
          y: entity.pos.y,
          kind: 'asteroid',
          size: entity.size,
          points,
        });
      }
    }
  }

  #runTimers(dt) {
    if (!this.ship) {
      this.#respawnIn -= dt;
      if (this.#respawnIn <= 0) {
        const pos = this.#safeSpot(180);
        this.ship = this.world.spawn(new Ship({ pos, invulnerable: RESPAWN_PROTECTION }));
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
      if (this.ship && pos.distanceTo(this.ship.pos) < minDist) safe = false;
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
