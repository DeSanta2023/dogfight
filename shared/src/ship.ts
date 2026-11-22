import { ARENA, wrap, wrapPosition } from './arena.ts';
import { Entity } from './entity.ts';
import { Bullet } from './entities.ts';
import { isKind } from './kinds.ts';
import type { PickupType } from './entities.ts';
import { homing } from './behaviors.ts';
import { Vector2 } from './vector.ts';

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

/** Anything the simulation can read keys from: the keyboard, a test, bits from the network. */
export interface InputSource {
  isDown(code: string): boolean;
  justPressed?(code: string): boolean;
}

/** The plain-data ship the pure physics works on (Lab 1) and the browser predicts with (Lab 5). */
export interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly thrust: number;
}

/** Lab 1 plain-data ship. Kept: scripts/determinism.mjs and the experiments use it. */
export function createShip(): ShipState {
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    thrust: 0,
  };
}

/**
 * Experiment hook (Lab 05): a function applied to the result of every integrate() call, or null.
 * Production code never sets it. The "add Math.random() to integrate" experiment sets it in the
 * BROWSER only (?noise=), so prediction diverges from the server without editing this file.
 */
export const physicsHooks: { afterIntegrate: ((state: ShipState) => ShipState) | null } =
  {
    afterIntegrate: null,
  };

// A plain loop, not `codes.some((c) => input.isDown(c))`: that creates a closure on every call and
// this runs 4 times per ship per tick (Lab 07: it was the biggest allocator of the simulation).
function anyDown(input: InputSource, codes: readonly string[]): boolean {
  for (let i = 0; i < codes.length; i++)
    if (input.isDown(codes[i] as string)) return true;
  return false;
}

/**
 * Pure physics step: (ship, input, dt) -> new ship.
 * No DOM, no canvas, no globals, no mutation of `ship`. Same inputs => same output.
 * `input` is anything with isDown(code), so tests can pass a plain object.
 * The Ship class below delegates to it, so Lab 1's determinism guarantees still hold.
 */
export function integrate(ship: ShipState, input: InputSource, dt: number): ShipState {
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

  // wrapPosition() inlined: calling it spread the state into one more throw-away object.
  const next: ShipState = {
    x: wrap(ship.x + vx * dt, ARENA.width),
    y: wrap(ship.y + vy * dt, ARENA.height),
    vx,
    vy,
    angle,
    thrust,
  };
  return physicsHooks.afterIntegrate ? physicsHooks.afterIntegrate(next) : next;
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

const NO_INPUT: InputSource = Object.freeze({
  isDown: () => false,
  justPressed: () => false,
});

export interface ShipInit {
  pos?: Vector2;
  angle?: number;
  invulnerable?: number;
  slot?: number;
}

export class Ship extends Entity {
  static MAX_HP = SHIP.maxHp;

  declare kind: 'ship';

  #hp: number; // private: only takeDamage() may change it, so it can never leave 0..maxHp
  #cooldown = 0;
  #invulnerable = 0;

  thrust = 0;
  effects = new Map<PickupType, number>(); // effect name -> seconds left
  slot: number; // which player flies it (0 offline); bullets remember it so nobody shoots themselves
  inputSeq = 0; // sequence number of the input being applied (the server sets it; see Game)

  constructor({
    pos = new Vector2(ARENA.width / 2, ARENA.height / 2),
    angle = -Math.PI / 2,
    invulnerable = 0,
    slot = 0,
  }: ShipInit = {}) {
    super({ kind: 'ship', pos, angle, radius: SHIP.radius, edge: 'wrap' });
    this.#hp = SHIP.maxHp;
    this.#invulnerable = invulnerable;
    this.slot = slot;
  }

  get hp(): number {
    return this.#hp; // read-only from outside: `ship.hp = 99` is a compile error
  }

  get cooldown(): number {
    return this.#cooldown;
  }

  get invulnerableLeft(): number {
    return this.#invulnerable;
  }

  get invulnerable(): boolean {
    return this.#invulnerable > 0;
  }

  hasEffect(name: PickupType): boolean {
    return (this.effects.get(name) ?? 0) > 0;
  }

  addEffect(name: PickupType, seconds: number): void {
    this.effects.set(name, Math.max(this.effects.get(name) ?? 0, seconds));
  }

  /** Returns true if the hit actually landed (not absorbed by a shield / invulnerability). */
  takeDamage(amount: number, source: Entity | null = null): boolean {
    if (!this.alive || this.invulnerable || this.hasEffect('shield')) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    this.world?.emit({ type: 'hit', target: this, by: source }); // before kill(): hit, then destroyed
    if (this.#hp === 0) this.kill(source);
    else this.#invulnerable = SHIP.hitInvulnerability;
    return true;
  }

  override update(dt: number, input: InputSource = NO_INPUT): void {
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
  fire(): Bullet | null {
    if (!this.alive || this.#cooldown > 0) return null;
    if (!this.world) throw new Error('ship.fire(): the ship is not in a world');
    this.#cooldown = this.hasEffect('rapid') ? SHIP.rapidCooldown : SHIP.fireCooldown;

    const heading = Vector2.fromAngle(this.angle);
    const bullet = Bullet.acquire({
      pos: this.pos.add(heading.scale(this.radius + 4)),
      vel: this.vel.add(heading.scale(SHIP.bulletSpeed)),
      angle: this.angle,
      ownerId: this.id,
    });
    bullet.ownerSlot = this.slot;
    bullet.fireSeq = this.inputSeq; // lets the shooter's browser match its own predicted bullet
    // Composition: the same `homing` behavior an asteroid uses, attached to a bullet.
    if (this.hasEffect('homing')) {
      bullet.addBehavior(homing({ targetKind: 'asteroid', turnRate: 3.2, range: 420 }));
    }
    this.world.spawn(bullet);
    this.world.emit({ type: 'fired', entity: bullet, by: this });
    return bullet;
  }

  override onCollide(other: Entity): void {
    if (isKind(other, 'asteroid')) {
      if (this.takeDamage(1, other) && this.alive) {
        // Knock the ship away from the rock.
        const away = this.pos.sub(other.pos).normalize();
        this.vel = this.vel.add(away.scale(220));
      }
    } else if (isKind(other, 'pickup')) {
      other.apply(this);
    }
  }
}
