import { ARENA, wrap, wrapPosition } from './arena.js';
import { Entity } from './entity.js';
import { Bullet } from './entities.js';
import { homing } from './behaviors.js';
import { Vector2 } from './vector.js';

// Tuning (see README "Tuning notes"). Units: world units, radians, seconds.
export const TUNING = Object.freeze({
  turnRate: 3.8, // rad/s
  thrustAccel: 380, // units/s^2
  drag: 0.5, // 1/s — fraction of velocity lost per second
  maxSpeed: 686, // units/s
});

export const KEYS = Object.freeze({
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  thrust: ['ArrowUp', 'KeyW'],
  fire: ['Space'],
});

/** Lab 1 plain-data ship. Kept: scripts/determinism.mjs and the experiments use it. */
export function createShip() {
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    thrust: 0,
  };
}

const anyDown = (input, codes) => codes.some((c) => input.isDown(c));

/**
 * Pure physics step: (ship, input, dt) -> new ship.
 * No DOM, no canvas, no globals, no mutation of `ship`. Same inputs => same output.
 * `input` is anything with isDown(code), so tests can pass a plain object.
 * The Ship class below delegates to it, so Lab 1's determinism guarantees still hold.
 */
export function integrate(ship, input, dt) {
  const turn = (anyDown(input, KEYS.right) ? 1 : 0) - (anyDown(input, KEYS.left) ? 1 : 0);
  const thrust = anyDown(input, KEYS.thrust) ? 1 : 0;

  const angle = wrap(ship.angle + turn * TUNING.turnRate * dt, 2 * Math.PI);

  // Accelerate along the heading, then apply linear drag.
  let vx = ship.vx + Math.cos(angle) * TUNING.thrustAccel * thrust * dt;
  let vy = ship.vy + Math.sin(angle) * TUNING.thrustAccel * thrust * dt;
  const damping = Math.max(0, 1 - TUNING.drag * dt);
  vx *= damping;
  vy *= damping;

  // Clamp speed.
  const speed = Math.hypot(vx, vy);
  if (speed > TUNING.maxSpeed) {
    const k = TUNING.maxSpeed / speed;
    vx *= k;
    vy *= k;
  }

  return wrapPosition({
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrust,
  });
}

// ---------------------------------------------------------------------------
// Ship entity
// ---------------------------------------------------------------------------
export const SHIP = Object.freeze({
  radius: 14,
  maxHp: 3,
  fireCooldown: 0.22,
  rapidCooldown: 0.08,
  bulletSpeed: 620,
  hitInvulnerability: 1.5,
});

const NO_INPUT = Object.freeze({ isDown: () => false, justPressed: () => false });

export class Ship extends Entity {
  static MAX_HP = SHIP.maxHp;

  #hp; // private: only takeDamage() may change it, so it can never leave 0..maxHp
  #cooldown = 0;
  #invulnerable = 0;

  thrust = 0;
  effects = new Map(); // effect name -> seconds left

  constructor({
    pos = new Vector2(ARENA.width / 2, ARENA.height / 2),
    angle = -Math.PI / 2,
    invulnerable = 0,
  } = {}) {
    super({ kind: 'ship', pos, angle, radius: SHIP.radius, edge: 'wrap' });
    this.#hp = SHIP.maxHp;
    this.#invulnerable = invulnerable;
  }

  get hp() {
    return this.#hp; // read-only from outside: `ship.hp = 99` throws in strict mode
  }

  get invulnerable() {
    return this.#invulnerable > 0;
  }

  hasEffect(name) {
    return (this.effects.get(name) ?? 0) > 0;
  }

  addEffect(name, seconds) {
    this.effects.set(name, Math.max(this.effects.get(name) ?? 0, seconds));
  }

  /** Returns true if the hit actually landed (not absorbed by a shield / invulnerability). */
  takeDamage(amount, source = null) {
    if (!this.alive || this.invulnerable || this.hasEffect('shield')) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    this.world?.emit({ type: 'hit', target: this, by: source }); // before kill(): hit, then destroyed
    if (this.#hp === 0) this.kill(source);
    else this.#invulnerable = SHIP.hitInvulnerability;
    return true;
  }

  update(dt, input = NO_INPUT) {
    // Physics is the pure Lab 1 function; the class only adapts its plain-data shape.
    const next = integrate(
      {
        x: this.pos.x,
        y: this.pos.y,
        vx: this.vel.x,
        vy: this.vel.y,
        angle: this.angle,
        thrust: this.thrust,
      },
      input,
      dt,
    );
    this.pos = new Vector2(next.x, next.y);
    this.vel = new Vector2(next.vx, next.vy);
    this.angle = next.angle;
    this.thrust = next.thrust;

    // The ship does not call super.update() (it has its own physics), so run the composed
    // behaviors explicitly: "any behavior works on any entity" must hold for ships too.
    this.runBehaviors(dt);

    this.#cooldown = Math.max(0, this.#cooldown - dt);
    this.#invulnerable = Math.max(0, this.#invulnerable - dt);
    for (const [name, left] of this.effects) {
      if (left - dt > 0) this.effects.set(name, left - dt);
      else this.effects.delete(name);
    }

    // `this.fire()` — implicit binding (object left of the dot), so `this` is the ship.
    if (anyDown(input, KEYS.fire)) this.fire();
  }

  /**
   * Spawn a bullet at the nose, inheriting the ship's velocity. Returns the bullet or null.
   * Uses `this` (cooldown, pose, world): detach it from the ship and it breaks — see the
   * "this bug" section of the README and scripts/this-bug.mjs.
   */
  fire() {
    if (!this.alive || this.#cooldown > 0) return null;
    this.#cooldown = this.hasEffect('rapid') ? SHIP.rapidCooldown : SHIP.fireCooldown;

    const heading = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(heading.scale(this.radius + 4)),
      vel: this.vel.add(heading.scale(SHIP.bulletSpeed)),
      angle: this.angle,
      ownerId: this.id,
    });
    // Composition: the same `homing` behavior an asteroid uses, attached to a bullet.
    if (this.hasEffect('homing')) {
      bullet.addBehavior(homing({ targetKind: 'asteroid', turnRate: 3.2, range: 420 }));
    }
    this.world.spawn(bullet);
    this.world.emit({ type: 'fired', entity: bullet, by: this });
    return bullet;
  }

  onCollide(other) {
    if (other.kind === 'asteroid') {
      if (this.takeDamage(1, other) && this.alive) {
        // Knock the ship away from the rock.
        const away = this.pos.sub(other.pos).normalize();
        this.vel = this.vel.add(away.scale(220));
      }
    } else if (other.kind === 'pickup') {
      other.apply(this);
    }
  }
}
