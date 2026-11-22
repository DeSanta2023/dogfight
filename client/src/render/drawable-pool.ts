import {
  ASTEROID_RADIUS,
  type AsteroidSize,
  type PickupType,
} from '@dogfight/shared/entities.ts';
import type {
  DrawableAsteroid,
  DrawableBullet,
  DrawablePickup,
  DrawableShip,
  EffectName,
} from './drawable.ts';

/**
 * Lab 07: the objects the renderer draws, made ONCE and reused every frame.
 *
 * Before, NetGame.view() built about 40 fresh objects per frame (a pose, a position, a closure for
 * hasEffect, a Map per kind...), 60 times a second: the Chrome heap profiler listed `interpolateEntity`,
 * `#viewWorld` and `bullet` at the top of the allocators. Now `begin()` rewinds the pools and every
 * `ship()/bullet()/...` call hands out an object that already exists. Nothing is allocated unless
 * the number of things on screen is a new record.
 *
 * Rules: an object from here is valid until the next `begin()`. Never keep one.
 * The same hidden class (all fields set in the constructor, in the same order, with the same
 * types) keeps the property accesses in drawEntity monomorphic: V8's inline cache sees ONE shape.
 */
interface MutablePoint {
  x: number;
  y: number;
}

abstract class PooledBase {
  id = 0;
  readonly pos: MutablePoint = { x: 0, y: 0 };
  readonly prevPos: MutablePoint = this.pos; // a picture is made once per frame: prev = current
  angle = 0;
  prevAngle = 0;
  radius = 0;
  place(id: number, x: number, y: number, angle: number): void {
    this.id = id;
    this.pos.x = x;
    this.pos.y = y;
    this.angle = angle;
    this.prevAngle = angle;
  }
}

export class PooledShip extends PooledBase implements DrawableShip {
  readonly kind = 'ship';
  slot = 0;
  thrust = 0;
  invulnerable = false;
  shield = false;
  rapid = false;
  homing = false;
  // A method on the prototype: ONE function for all ships, not a new closure per ship per frame.
  hasEffect(name: EffectName): boolean {
    return name === 'shield' ? this.shield : name === 'rapid' ? this.rapid : this.homing;
  }
}

export class PooledBullet extends PooledBase implements DrawableBullet {
  readonly kind = 'bullet';
  homing = false;
  hasBehavior(name: string): boolean {
    return name === 'homing' && this.homing;
  }
}

export class PooledAsteroid extends PooledBase implements DrawableAsteroid {
  readonly kind = 'asteroid';
  size: AsteroidSize = 2;
  hunter = false;
}

export class PooledPickup extends PooledBase implements DrawablePickup {
  readonly kind = 'pickup';
  type: PickupType = 'shield';
}

/** A growing array of reusable objects with a cursor that `rewind()` sets back to 0. */
class Bank<T> {
  readonly items: T[] = [];
  cursor = 0;
  readonly #make: () => T;
  constructor(make: () => T) {
    this.#make = make;
  }
  next(): T {
    let item = this.items[this.cursor];
    if (!item) {
      item = this.#make();
      this.items.push(item);
    }
    this.cursor++;
    return item;
  }
}

export class DrawablePool {
  readonly #ships = new Bank(() => new PooledShip());
  readonly #bullets = new Bank(() => new PooledBullet());
  readonly #asteroids = new Bank(() => new PooledAsteroid());
  readonly #pickups = new Bank(() => new PooledPickup());

  /** Start a frame: every object becomes available again. */
  begin(): void {
    this.#ships.cursor = 0;
    this.#bullets.cursor = 0;
    this.#asteroids.cursor = 0;
    this.#pickups.cursor = 0;
  }

  ship(slot: number, x: number, y: number, angle: number, radius: number): PooledShip {
    const s = this.#ships.next();
    s.place(1000 + slot, x, y, angle);
    s.radius = radius;
    s.slot = slot;
    s.thrust = 0;
    s.invulnerable = false;
    s.shield = s.rapid = s.homing = false;
    return s;
  }

  bullet(
    id: number,
    x: number,
    y: number,
    angle: number,
    homing: boolean,
    radius: number,
  ): PooledBullet {
    const b = this.#bullets.next();
    b.place(id, x, y, angle);
    b.radius = radius;
    b.homing = homing;
    return b;
  }

  asteroid(
    id: number,
    x: number,
    y: number,
    size: AsteroidSize,
    hunter: boolean,
  ): PooledAsteroid {
    const a = this.#asteroids.next();
    a.place(id, x, y, 0);
    a.radius = ASTEROID_RADIUS[size];
    a.size = size;
    a.hunter = hunter;
    return a;
  }

  pickup(id: number, x: number, y: number, type: PickupType): PooledPickup {
    const p = this.#pickups.next();
    p.place(id, x, y, 0);
    p.radius = 14;
    p.type = type;
    return p;
  }

  /** For tests and the README: how many objects exist (the high-water mark of each kind). */
  get size(): number {
    return (
      this.#ships.items.length +
      this.#bullets.items.length +
      this.#asteroids.items.length +
      this.#pickups.items.length
    );
  }
}
