import { applyEdge } from './arena.js';
import { findCollisions } from './collision.js';

const NO_INPUTS = new Map();

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
  #entities = new Map();
  #events = [];
  #scratch = []; // reused every step: no per-step array allocation
  #collide;

  constructor({ collide = findCollisions } = {}) {
    this.#collide = collide; // swappable collision system
  }

  spawn(entity) {
    entity.world = this;
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Deferred: marks the entity dead; step() sweeps it. */
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id) {
    const entity = this.#entities.get(id);
    return entity?.alive ? entity : undefined;
  }

  /** Number of stored entities, including dead ones that are waiting for the sweep. */
  get size() {
    return this.#entities.size;
  }

  /** Iterate live entities in spawn order. */
  *[Symbol.iterator]() {
    for (const entity of this.#entities.values()) if (entity.alive) yield entity;
  }

  /** Generator: live entities of one kind, produced lazily (no intermediate array). */
  *ofKind(kind) {
    for (const entity of this) if (entity.kind === kind) yield entity;
  }

  emit(event) {
    this.#events.push(event);
  }

  /** Hand over the events of the last step(s) and clear the queue. */
  drainEvents() {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /**
   * One fixed simulation step: update everything, resolve collisions, sweep the dead.
   * `inputs` maps entity id -> input source (only controllable entities need one).
   */
  step(dt, inputs = NO_INPUTS) {
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
