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

export function wrapPosition(ship) {
  return {
    ...ship,
    x: wrap(ship.x, ARENA.width),
    y: wrap(ship.y, ARENA.height),
  };
}
