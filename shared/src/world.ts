import { applyEdge } from './arena.ts';
import { findCollisions, type CollisionSystem } from './collision.ts';
import { entityId, type EntityId } from './brand.ts';
import type { Entity, EntityKind } from './entity.ts';
import type { InputSource } from './ship.ts';
import { isKind, type KindMap, type WorldEvent } from './kinds.ts';

const NO_INPUTS: ReadonlyMap<EntityId, InputSource> = new Map();

/**
 * Entity manager over a Map<id, Entity>.
 *
 * Why Map and not a plain object: numeric ids stay numbers (an object would turn them into
 * strings), insertion order is the update order (deterministic), `.size` is O(1), there are no
 * inherited keys like "constructor", and add/delete in a hot loop is what Map is built for.
 *
 * Despawning is DEFERRED: despawn() / kill() only mark an entity dead; the actual delete happens
 * in one sweep at the end of step(). Nothing is ever removed from the Map while we iterate it.
 */
export class World {
  #entities = new Map<EntityId, Entity>();
  #events: WorldEvent[] = [];
  #scratch: Entity[] = []; // reused every step: no per-step array allocation
  #living: Entity[] = []; // same idea: the live entities handed to the collision system
  #collide: CollisionSystem;
  #nextId = 1; // ids are per WORLD, so two worlds that do the same things agree on every id

  readonly #collectAll = (entity: Entity): void => void this.#scratch.push(entity);
  #snapshotList: Entity[] = [];
  readonly #collectForSnapshot = (entity: Entity): void => {
    if (entity.alive) this.#snapshotList.push(entity);
  };
  readonly #collectLiving = (entity: Entity): void => {
    if (entity.alive) this.#living.push(entity);
  };
  readonly #sweepOne = (entity: Entity, id: EntityId): void => {
    if (!entity.alive) {
      this.#entities.delete(id);
      entity.recycle();
    }
  };

  constructor({ collide = findCollisions }: { collide?: CollisionSystem } = {}) {
    this.#collide = collide; // swappable collision system
  }

  spawn<E extends Entity>(entity: E): E {
    entity.world = this;
    entity.id = entityId(this.#nextId++);
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Deferred: marks the entity dead; step() sweeps it. */
  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id: EntityId): Entity | undefined {
    const entity = this.#entities.get(id);
    return entity?.alive ? entity : undefined;
  }

  /** Number of stored entities, including dead ones that are waiting for the sweep. */
  get size(): number {
    return this.#entities.size;
  }

  /** Iterate live entities in spawn order. */
  *[Symbol.iterator](): Generator<Entity, void, undefined> {
    for (const entity of this.#entities.values()) if (entity.alive) yield entity;
  }

  /** Generator: live entities of one kind (typed as that kind's class), produced lazily. */
  *ofKind<K extends EntityKind>(kind: K): Generator<KindMap[K], void, undefined> {
    for (const entity of this) if (isKind(entity, kind)) yield entity;
  }

  /**
   * The live entities as an array in spawn order. The array is REUSED: it is valid until the next
   * call, do not keep it. `for (const e of world)` makes a generator and a {value, done} object per
   * entity; with 128 players the server captured a snapshot per player per tick and that showed up
   * as the 3rd biggest line of the CPU profile.
   */
  liveEntities(): readonly Entity[] {
    this.#snapshotList.length = 0;
    this.#entities.forEach(this.#collectForSnapshot);
    return this.#snapshotList;
  }

  /** How many live entities of a kind (no generator, no array: it is called every tick). */
  countOf(kind: EntityKind): number {
    let n = 0;
    this.#entities.forEach((entity) => {
      if (entity.alive && entity.kind === kind) n++;
    });
    return n;
  }

  emit(event: WorldEvent): void {
    this.#events.push(event);
  }

  /** Hand over the events of the last step(s) and clear the queue. */
  drainEvents(): WorldEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /**
   * One fixed simulation step: update everything, resolve collisions, sweep the dead.
   * `inputs` maps entity id -> input source (only controllable entities need one).
   */
  step(dt: number, inputs: ReadonlyMap<EntityId, InputSource> = NO_INPUTS): void {
    // Iterate a reused snapshot of the entities: things spawned during the pass (bullets)
    // start updating next step instead of being visited halfway through this one.
    // Map.forEach with callbacks made ONCE (see the constructor): `for...of map.values()` makes an
    // iterator and a {value, done} object per entity per step, forEach makes none.
    const batch = this.#scratch;
    batch.length = 0;
    this.#entities.forEach(this.#collectAll);

    for (const entity of batch) {
      if (!entity.alive) continue;
      entity.snapshot();
      entity.update(dt, inputs.get(entity.id));
      applyEdge(entity);
    }

    // An array, not the generator above: iterating a generator makes a {value, done} object per
    // entity per step (Lab 07: `next` was the 2nd biggest allocator of the whole simulation).
    const living = this.#living;
    living.length = 0;
    this.#entities.forEach(this.#collectLiving);
    for (const [a, b] of this.#collide(living)) {
      if (!a.alive || !b.alive) continue;
      a.onCollide(b);
      if (a.alive && b.alive) b.onCollide(a);
    }

    this.#entities.forEach(this.#sweepOne); // deleting while iterating a Map is allowed
  }
}
