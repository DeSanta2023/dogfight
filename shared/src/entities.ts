import { Entity } from './entity.ts';
import { isKind } from './kinds.ts';
import { Vector2 } from './vector.ts';
import { Pool } from './pool.ts';
import { homing } from './behaviors.ts';
import type { EntityId } from './brand.ts';
import type { Rng } from './rng.ts';
import type { Ship } from './ship.ts';

// ---------------------------------------------------------------------------
// Bullet
// ---------------------------------------------------------------------------
export const BULLET = Object.freeze({ radius: 3, ttl: 1.1, damage: 1 });

export interface BulletInit {
  pos: Vector2;
  vel: Vector2;
  angle: number;
  ownerId?: EntityId;
}

/** Used bullets wait here. `Bullet.acquire()` takes one, World gives it back via `recycle()`. */
export const bulletPool = new Pool<Bullet>(
  () => new Bullet({ pos: Vector2.ZERO, vel: Vector2.ZERO, angle: 0 }),
  1024,
);

export class Bullet extends Entity {
  declare kind: 'bullet';

  /** A bullet from the pool (or a new one), in exactly the state `new Bullet(init)` would give. */
  static acquire(init: BulletInit): Bullet {
    const bullet = bulletPool.acquire();
    bullet.reset(init);
    return bullet;
  }

  ttl: number = BULLET.ttl;
  damage: number = BULLET.damage;
  ownerId: EntityId | undefined;
  ownerSlot = -1; // the PLAYER who fired it: scoring and "no friendly fire on yourself"
  fireSeq = 0; // input sequence number that fired it (Lab 05)

  constructor({ pos, vel, angle, ownerId }: BulletInit) {
    super({ kind: 'bullet', pos, vel, angle, radius: BULLET.radius, edge: 'wrap' });
    this.ownerId = ownerId;
  }

  /** Every field back to its initial value: this is what makes pooling invisible. */
  reset({ pos, vel, angle, ownerId }: BulletInit): void {
    this.pos = pos;
    this.vel = vel;
    this.prevPos = pos;
    this.angle = angle;
    this.prevAngle = angle;
    this.radius = BULLET.radius;
    this.edge = 'wrap';
    this.solid = true;
    this.alive = true;
    this.world = null;
    this.behaviors.length = 0;
    this.ttl = BULLET.ttl;
    this.damage = BULLET.damage;
    this.ownerId = ownerId;
    this.ownerSlot = -1;
    this.fireSeq = 0;
  }

  override recycle(): void {
    this.world = null;
    bulletPool.release(this);
  }

  override update(dt: number): void {
    super.update(dt);
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false; // expired: not "destroyed", no event
  }

  override onCollide(other: Entity): void {
    if (other.id === this.ownerId) return;
    if (isKind(other, 'ship')) {
      if (other.slot === this.ownerSlot) return; // the shooter's own (old) ship
      other.takeDamage(this.damage, this);
      this.alive = false;
    } else if (isKind(other, 'asteroid')) {
      other.takeDamage(this.damage, this);
      this.alive = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Asteroid
// ---------------------------------------------------------------------------
export type AsteroidSize = 1 | 2 | 3;
export const ASTEROID_RADIUS: Readonly<Record<AsteroidSize, number>> = Object.freeze({
  1: 16,
  2: 26,
  3: 40,
});

export interface AsteroidInit {
  pos: Vector2;
  vel: Vector2;
  size?: AsteroidSize;
  hunter?: boolean;
}

export class Asteroid extends Entity {
  declare kind: 'asteroid';

  size: AsteroidSize;
  hp: number;
  hunter: boolean;

  /** `size` 1..3. A `hunter` drifts like the others but slowly steers toward the ship. */
  constructor({ pos, vel, size = 2, hunter = false }: AsteroidInit) {
    super({ kind: 'asteroid', pos, vel, radius: ASTEROID_RADIUS[size], edge: 'bounce' });
    this.size = size;
    this.hp = size; // plain public field: an asteroid has no invariants to protect
    this.hunter = hunter;
    if (hunter)
      this.addBehavior(homing({ targetKind: 'ship', turnRate: 0.7, range: 800 }));
  }

  get points(): number {
    return 50 * this.size;
  }

  takeDamage(amount: number, source: Entity | null): void {
    this.hp -= amount;
    this.world?.emit({ type: 'hit', target: this, by: source }); // before kill(): hit, then destroyed
    if (this.hp <= 0) this.kill(source);
  }
}

// ---------------------------------------------------------------------------
// Pickup: stationary, collidable, collected by a ship. Not a ship itself.
// ---------------------------------------------------------------------------
export type PickupType = 'shield' | 'rapid' | 'homing';
export const PICKUP_DURATION: Readonly<Record<PickupType, number>> = Object.freeze({
  shield: 8,
  rapid: 8,
  homing: 10,
});
export const PICKUP_TYPES: readonly PickupType[] = ['shield', 'rapid', 'homing'];

export interface PickupInit {
  pos: Vector2;
  type: PickupType;
}

export class Pickup extends Entity {
  declare kind: 'pickup';

  type: PickupType;
  ttl = 12;

  constructor({ pos, type }: PickupInit) {
    super({ kind: 'pickup', pos, radius: 14, edge: 'wrap' });
    this.type = type;
  }

  override update(dt: number): void {
    this.ttl -= dt; // stationary: no movement, no behaviors
    if (this.ttl <= 0) this.alive = false;
  }

  /** Give the effect to whoever picked it up. */
  apply(collector: Ship): void {
    collector.addEffect(this.type, PICKUP_DURATION[this.type]);
    this.alive = false;
    this.world?.emit({ type: 'collected', entity: this, by: collector });
  }
}

// ---------------------------------------------------------------------------
// Explosion: one entity that owns a burst of short-lived particles.
// ---------------------------------------------------------------------------
export interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export interface ExplosionInit {
  pos: Vector2;
  rng: Rng;
  count?: number;
  speed?: number;
  life?: number;
  variant?: 'rock' | 'ship';
}

const EMPTY_PARTICLES: readonly Particle[] = Object.freeze([]);
/** Sparks are recycled too: an explosion needs 16 of them for 0.7 s, then they come back. */
export const particlePool = new Pool<Particle>(
  () => ({ x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, life: 0, maxLife: 0 }),
  4096,
);

export class Explosion extends Entity {
  declare kind: 'explosion';

  particles: readonly Particle[];
  variant: 'rock' | 'ship';

  /** `rng` is the game's seeded generator, so explosions are deterministic too. */
  constructor({
    pos,
    rng,
    count = 16,
    speed = 180,
    life = 0.7,
    variant = 'rock',
  }: ExplosionInit) {
    super({ kind: 'explosion', pos, radius: 0, solid: false });
    this.variant = variant;
    const particles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      // The order of the rng calls is part of the simulation: angle, speed, life. Do not reorder.
      const angle = rng.range(0, Math.PI * 2);
      const magnitude = rng.range(0.25, 1) * speed;
      const p = particlePool.acquire();
      p.x = p.px = pos.x;
      p.y = p.py = pos.y;
      p.vx = Math.cos(angle) * magnitude;
      p.vy = Math.sin(angle) * magnitude;
      p.life = rng.range(0.4, 1) * life;
      p.maxLife = life;
      particles.push(p);
    }
    this.particles = particles;
  }

  override recycle(): void {
    for (const p of this.particles) particlePool.release(p);
    this.particles = EMPTY_PARTICLES;
  }

  override update(dt: number): void {
    let anyAlive = false;
    for (const p of this.particles) {
      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life > 0) anyAlive = true;
    }
    this.alive = anyAlive;
  }
}
