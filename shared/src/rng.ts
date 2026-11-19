/**
 * Seeded PRNG (mulberry32) as a closure. The simulation must never call Math.random():
 * the same seed + the same inputs must give the same game (Lab 1: determinism, Lab 5: netcode).
 */
export interface Rng {
  next(): number;
  /** Float in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Random element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed = 1): Rng {
  let a = seed >>> 0;

  function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    pick<T>(items: readonly T[]): T {
      // noUncheckedIndexedAccess: items[i] may be undefined, so an empty list must be an error.
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('rng.pick: the list is empty');
      return item;
    },
  };
}
