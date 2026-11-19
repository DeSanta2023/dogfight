import { Vector2 } from './vector.ts';
import { entityId, type EntityId } from './brand.ts';
import type { InputSource } from './ship.ts';
import type { World } from './world.ts';

export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion';
/** 'wrap' reappears on the opposite side, 'bounce' reflects off the wall. */
export type EdgeMode = 'wrap' | 'bounce';

/** A composed capability (homing, ...): a plain object, attached to any entity. */
export interface Behavior {
  readonly name: string;
  update(entity: Entity, dt: number, world: World | null): void;
}

export interface EntityInit {
  kind: EntityKind;
  pos?: Vector2;
  vel?: Vector2;
  angle?: number;
  radius?: number;
  edge?: EdgeMode;
  solid?: boolean;
}

/**
 * Base class of everything that lives in the World. The class tree is deliberately FLAT:
 * Entity <- Ship | Bullet | Asteroid | Pickup | Explosion, one level and no more.
 * Extra capabilities (homing, effects) are attached as composed `behaviors`, not by subclassing.
 *
 * Each subclass NARROWS `kind` to its own literal (`declare kind: 'ship'`), so `kind` is a
 * discriminant: after `if (e.kind === 'ship')` TypeScript knows `e` is a Ship.
 *
 * State is mutated in place (cheap, no garbage per step); `snapshot()` keeps an explicit copy of
 * the previous pose so the renderer can interpolate between steps (Lab 1, alpha).
 */
export class Entity {
  static #nextId = 1; // private static counter: nobody else can reset or skip ids

  id: EntityId = entityId(Entity.#nextId++); // World.spawn() gives the final, per-world id
  kind: EntityKind;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  edge: EdgeMode;
  solid: boolean; // takes part in collisions
  alive = true;
  world: World | null = null; // set by World.spawn()
  behaviors: Behavior[] = []; // composed capabilities
  prevPos: Vector2;
  prevAngle: number;

  constructor({
    kind,
    pos = Vector2.ZERO,
    vel = Vector2.ZERO,
    angle = 0,
    radius = 1,
    edge = 'wrap',
    solid = true,
  }: EntityInit) {
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
  snapshot(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Advance by one fixed step. `input` is only used by controllable entities. */
  update(dt: number, _input?: InputSource): void {
    this.runBehaviors(dt);
    this.move(dt);
  }

  move(dt: number): void {
    this.pos = this.pos.add(this.vel.scale(dt));
  }

  runBehaviors(dt: number): void {
    for (const behavior of this.behaviors) behavior.update(this, dt, this.world);
  }

  addBehavior(behavior: Behavior): this {
    this.behaviors.push(behavior);
    return this;
  }

  hasBehavior(name: string): boolean {
    return this.behaviors.some((b) => b.name === name);
  }

  /** Called by World for every colliding pair, once per side. Default: ignore. */
  onCollide(_other: Entity): void {}

  /** Mark dead because of damage and tell the world why (so the game can score / explode). */
  kill(by: Entity | null = null): void {
    if (!this.alive) return;
    this.alive = false;
    this.world?.emit({ type: 'destroyed', entity: this, by });
  }
}
