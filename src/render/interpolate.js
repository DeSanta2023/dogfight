import { ARENA, wrap, wrappedDelta, angleDelta } from '../sim/arena.js';

/**
 * Blend two consecutive simulation states for display. alpha in [0, 1].
 *
 * Two classic bugs are handled here:
 *  1. Wrap-around: if the ship crossed an edge between prev and cur, a naive lerp of x would
 *     sweep the ship across the whole arena for one frame. We lerp along the SHORTEST wrapped
 *     path instead, then wrap the result.
 *  2. Angle: lerping 359° -> 1° naively spins the ship the long way round. angleDelta gives
 *     the shortest signed difference.
 */
export function interpolateShip(prev, cur, alpha) {
  return {
    x: wrap(prev.x + wrappedDelta(prev.x, cur.x, ARENA.width) * alpha, ARENA.width),
    y: wrap(prev.y + wrappedDelta(prev.y, cur.y, ARENA.height) * alpha, ARENA.height),
    angle: prev.angle + angleDelta(prev.angle, cur.angle) * alpha,
    thrust: cur.thrust,
  };
}
