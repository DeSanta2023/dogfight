import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { homing } from './behaviors.js';

// ---------------------------------------------------------------------------
// Bullet
// ---------------------------------------------------------------------------
export const BULLET = Object.freeze({ radius: 3, ttl: 1.1, damage: 1 });

export class Bullet extends Entity {
  ttl = BULLET.ttl;
  damage = BULLET.damage;
  ownerId;

  constructor({ pos, vel, angle, ownerId }) {
    super({ kind: 'bullet', pos, vel, angle, radius: BULLET.radius, edge: 'wrap' });
    this.ownerId = ownerId;
  }

  update(dt) {
    super.update(dt);
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false; // expired: not "destroyed", no event
  }

  onCollide(other) {
    if (other.id === this.ownerId) return;
    if (other.kind === 'ship' || other.kind === 'asteroid') {
      other.takeDamage(this.damage, this);
      this.alive = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Asteroid
// ---------------------------------------------------------------------------
const ASTEROID_RADIUS = Object.freeze({ 1: 16, 2: 26, 3: 40 });

export class Asteroid extends Entity {
  size;
  hp;
  hunter;

  /** `size` 1..3. A `hunter` drifts like the others but slowly steers toward the ship. */
  constructor({ pos, vel, size = 2, hunter = false }) {
    super({ kind: 'asteroid', pos, vel, radius: ASTEROID_RADIUS[size], edge: 'bounce' });
    this.size = size;
    this.hp = size; // plain public field: an asteroid has no invariants to protect
    this.hunter = hunter;
    if (hunter)
      this.addBehavior(homing({ targetKind: 'ship', turnRate: 0.7, range: 800 }));
  }

  get points() {
    return 50 * this.size;
  }

  takeDamage(amount, source) {
    this.hp -= amount;
    if (this.hp <= 0) this.kill(source);
  }
}

// ---------------------------------------------------------------------------
// Pickup: stationary, collidable, collected by a ship. Not a ship itself.
// ---------------------------------------------------------------------------
export const PICKUP_DURATION = Object.freeze({ shield: 8, rapid: 8, homing: 10 });
export const PICKUP_TYPES = Object.freeze(Object.keys(PICKUP_DURATION));

export class Pickup extends Entity {
  type;
  ttl = 12;

  constructor({ pos, type }) {
    super({ kind: 'pickup', pos, radius: 14, edge: 'wrap' });
    this.type = type;
  }

  update(dt) {
    this.ttl -= dt; // stationary: no movement, no behaviors
    if (this.ttl <= 0) this.alive = false;
  }

  /** Give the effect to whoever picked it up. Duck-typed: anything with addEffect() works. */
  apply(collector) {
    collector.addEffect(this.type, PICKUP_DURATION[this.type]);
    this.alive = false;
  }
}

// ---------------------------------------------------------------------------
// Explosion: one entity that owns a burst of short-lived particles.
// ---------------------------------------------------------------------------
export class Explosion extends Entity {
  particles;
  variant;

  /** `rng` is the game's seeded generator, so explosions are deterministic too. */
  constructor({ pos, rng, count = 16, speed = 180, life = 0.7, variant = 'rock' }) {
    super({ kind: 'explosion', pos, radius: 0, solid: false });
    this.variant = variant;
    this.particles = Array.from({ length: count }, () => {
      const velocity = Vector2.fromAngle(
        rng.range(0, Math.PI * 2),
        rng.range(0.25, 1) * speed,
      );
      return {
        x: pos.x,
        y: pos.y,
        px: pos.x,
        py: pos.y,
        vx: velocity.x,
        vy: velocity.y,
        life: rng.range(0.4, 1) * life,
        maxLife: life,
      };
    });
  }

  update(dt) {
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
