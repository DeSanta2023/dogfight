/**
 * Seeded PRNG (mulberry32) as a closure. The simulation must never call Math.random():
 * the same seed + the same inputs must give the same game (Lab 1: determinism, Lab 5: netcode).
 */
export function createRng(seed = 1) {
  let a = seed >>> 0;

  function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /** Float in [lo, hi). */
    range: (lo, hi) => lo + next() * (hi - lo),
    /** Random element of a non-empty array. */
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}
