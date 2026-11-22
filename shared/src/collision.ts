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

/**
 * Lab 07: the same system with a SPATIAL HASH (a uniform grid).
 *
 * The naive version compares every solid with every other: n(n-1)/2 distance checks, 8 128 for
 * 128 entities. Two things can only touch if they are in the same neighbourhood, so we put every
 * entity into the grid cells its bounding box covers and compare only entities that share a cell.
 *
 * The result is IDENTICAL to findCollisions, including the ORDER of the pairs (for each `a` in
 * world order, its partners in world order): World calls onCollide pair by pair, so a different
 * order would be a different game, and the server and the browser would no longer agree.
 * A property test (shared/test/collision.test.ts) checks this on random worlds.
 *
 * No garbage per call except the result: the grid is two typed arrays (a linked list per cell)
 * kept between calls and grown only when a record number of entities shows up.
 */
export function createSpatialHash({
  cellSize = 96,
  width = 1280,
  height = 720,
}: { cellSize?: number; width?: number; height?: number } = {}): CollisionSystem {
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const head = new Int32Array(cols * rows); // first entry of each cell, -1 = empty
  let next = new Int32Array(256); // entry -> next entry in the same cell
  let owner = new Int32Array(256); // entry -> index of the entity
  let stamp = new Int32Array(64); // entity -> last `a` that already paired with it
  let near = new Int32Array(64); // scratch: partners of the current `a`
  const solids: Entity[] = [];
  const clampCol = (x: number) =>
    Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
  const clampRow = (y: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));

  return (world) => {
    solids.length = 0;
    for (const entity of world) if (entity.solid) solids.push(entity);
    const n = solids.length;
    if (stamp.length < n) {
      stamp = new Int32Array(n * 2);
      near = new Int32Array(n * 2);
    }
    if (next.length < n * 4) {
      next = new Int32Array(n * 8);
      owner = new Int32Array(n * 8);
    }
    head.fill(-1);
    stamp.fill(-1, 0, n);

    let entries = 0;
    for (let i = 0; i < n; i++) {
      const e = solids[i] as Entity;
      const c0 = clampCol(e.pos.x - e.radius);
      const c1 = clampCol(e.pos.x + e.radius);
      const r0 = clampRow(e.pos.y - e.radius);
      const r1 = clampRow(e.pos.y + e.radius);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const cell = r * cols + c;
          owner[entries] = i;
          next[entries] = head[cell] as number;
          head[cell] = entries++;
        }
      }
    }

    const pairs: [Entity, Entity][] = [];
    for (let i = 0; i < n; i++) {
      const a = solids[i] as Entity;
      const c0 = clampCol(a.pos.x - a.radius);
      const c1 = clampCol(a.pos.x + a.radius);
      const r0 = clampRow(a.pos.y - a.radius);
      const r1 = clampRow(a.pos.y + a.radius);
      let count = 0;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          for (let k = head[r * cols + c] as number; k !== -1; k = next[k] as number) {
            const j = owner[k] as number;
            if (j <= i || stamp[j] === i) continue; // each pair once, and only j > i
            stamp[j] = i;
            const b = solids[j] as Entity;
            const dx = a.pos.x - b.pos.x;
            const dy = a.pos.y - b.pos.y;
            const rr = a.radius + b.radius;
            if (dx * dx + dy * dy <= rr * rr) near[count++] = j;
          }
        }
      }
      // Cells are visited in grid order, the naive loop in world order: sort the few partners.
      for (let x = 1; x < count; x++) {
        // insertion sort: `count` is tiny, and TypedArray.subarray() would allocate a view per entity
        const v = near[x] as number;
        let y = x - 1;
        while (y >= 0 && (near[y] as number) > v) {
          near[y + 1] = near[y] as number;
          y--;
        }
        near[y + 1] = v;
      }
      for (let k = 0; k < count; k++)
        pairs.push([a, solids[near[k] as number] as Entity]);
    }
    return pairs;
  };
}
