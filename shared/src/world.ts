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
  #collide: CollisionSystem;
  #nextId = 1; // ids are per WORLD, so two worlds that do the same things agree on every id

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
    const batch = this.#scratch;
    batch.length = 0;
    for (const entity of this.#entities.values()) batch.push(entity);

    for (const entity of batch) {
      if (!entity.alive) continue;
      entity.snapshot();
      entity.update(dt, inputs.get(entity.id));
      applyEdge(entity);
    }

    for (const [a, b] of this.#collide(this)) {
      if (!a.alive || !b.alive) continue;
      a.onCollide(b);
      if (a.alive && b.alive) b.onCollide(a);
    }

    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }
  }
}
