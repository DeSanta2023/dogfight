import { Vector2 } from './vector.js';

// Logical arena size in world units. Independent of window size / pixel density.
export const ARENA = Object.freeze({ width: 1280, height: 720 });

/** Wrap a coordinate into [0, size). Works for negative values too. */
export function wrap(v, size) {
  return ((v % size) + size) % size;
}

/** Shortest signed distance from a to b on a wrapped axis of length `size`, in [-size/2, size/2). */
export function wrappedDelta(a, b, size) {
  return wrap(b - a + size / 2, size) - size / 2;
}

/** Shortest signed angle difference from a to b, in [-PI, PI). */
export function angleDelta(a, b) {
  return wrap(b - a + Math.PI, 2 * Math.PI) - Math.PI;
}

/** Lab 1 helper: wraps a plain {x, y, ...} state. Still used by the pure `integrate`. */
export function wrapPosition(ship) {
  return {
    ...ship,
    x: wrap(ship.x, ARENA.width),
    y: wrap(ship.y, ARENA.height),
  };
}

/**
 * What happens when an entity leaves the arena, selected by its `edge` field:
 *   'wrap'   — reappears on the opposite side (ships, bullets)
 *   'bounce' — reflects off the wall (asteroids)
 * Mutates the entity in place (positions are replaced, the Vector2s themselves are immutable).
 */
export function applyEdge(entity) {
  const { pos, vel, radius } = entity;

  if (entity.edge === 'wrap') {
    if (pos.x < 0 || pos.x >= ARENA.width || pos.y < 0 || pos.y >= ARENA.height) {
      entity.pos = new Vector2(wrap(pos.x, ARENA.width), wrap(pos.y, ARENA.height));
    }
    return;
  }

  if (entity.edge === 'bounce') {
    let { x, y } = pos;
    let { x: vx, y: vy } = vel;
    let hit = false;
    if (x < radius && vx < 0) {
      x = radius;
      vx = -vx;
      hit = true;
    } else if (x > ARENA.width - radius && vx > 0) {
      x = ARENA.width - radius;
      vx = -vx;
      hit = true;
    }
    if (y < radius && vy < 0) {
      y = radius;
      vy = -vy;
      hit = true;
    } else if (y > ARENA.height - radius && vy > 0) {
      y = ARENA.height - radius;
      vy = -vy;
      hit = true;
    }
    if (hit) {
      entity.pos = new Vector2(x, y);
      entity.vel = new Vector2(vx, vy);
    }
  }
}
