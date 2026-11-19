import type { Entity } from './entity.ts';

/**
 * Collision detection as a standalone SYSTEM: world in, list of colliding pairs out.
 * It decides nothing about damage — World calls each entity's onCollide() — so this
 * function can later be replaced by a spatial hash with the same signature (Lab 7).
 *
 * Naive O(n^2) circle-vs-circle over solid entities. Distances are plain (not wrap-aware):
 * a ship straddling an edge does not collide with something on the other side of the seam.
 */
export type CollisionSystem = (world: Iterable<Entity>) => [Entity, Entity][];

export const findCollisions: CollisionSystem = (world) => {
  const solids: Entity[] = [];
  for (const entity of world) if (entity.solid) solids.push(entity);

  const pairs: [Entity, Entity][] = [];
  for (let i = 0; i < solids.length; i++) {
    const a = solids[i];
    if (!a) continue; // noUncheckedIndexedAccess: the index is in range, the type cannot know
    for (let j = i + 1; j < solids.length; j++) {
      const b = solids[j];
      if (!b) continue;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy <= r * r) pairs.push([a, b]);
    }
  }
  return pairs;
};
