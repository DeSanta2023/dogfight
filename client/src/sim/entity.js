import { Vector2 } from './vector.js';

/**
 * Base class of everything that lives in the World. The class tree is deliberately FLAT:
 * Entity <- Ship | Bullet | Asteroid | Pickup | Explosion, one level and no more.
 * Extra capabilities (homing, effects) are attached as composed `behaviors`, not by subclassing.
 *
 * State is mutated in place (cheap, no garbage per step); `snapshot()` keeps an explicit copy of
 * the previous pose so the renderer can interpolate between steps (Lab 1, alpha).
 */
export class Entity {
  static #nextId = 1; // private static counter: nobody else can reset or skip ids

  id = Entity.#nextId++;
  kind;
  pos;
  vel;
  angle;
  radius;
  edge; // 'wrap' | 'bounce' — see applyEdge()
  solid; // takes part in collisions
  alive = true;
  world = null; // set by World.spawn()
  behaviors = []; // composed capabilities: { name, update(entity, dt, world) }
  prevPos;
  prevAngle;

  constructor({
    kind,
    pos = Vector2.ZERO,
    vel = Vector2.ZERO,
    angle = 0,
    radius = 1,
    edge = 'wrap',
    solid = true,
  }) {
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.edge = edge;
    this.solid = solid;
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  /** Remember the current pose. World.step() calls this right before update(). */
  snapshot() {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Advance by one fixed step. `input` is only used by controllable entities. */
  update(dt) {
    this.runBehaviors(dt);
    this.move(dt);
  }

  move(dt) {
    this.pos = this.pos.add(this.vel.scale(dt));
  }

  runBehaviors(dt) {
    for (const behavior of this.behaviors) behavior.update(this, dt, this.world);
  }

  addBehavior(behavior) {
    this.behaviors.push(behavior);
    return this;
  }

  hasBehavior(name) {
    return this.behaviors.some((b) => b.name === name);
  }

  /** Called by World for every colliding pair, once per side. Default: ignore. */
  onCollide() {}

  /** Mark dead because of damage and tell the world why (so the game can score / explode). */
  kill(by = null) {
    if (!this.alive) return;
    this.alive = false;
    this.world?.emit({ type: 'destroyed', entity: this, by });
  }
}
