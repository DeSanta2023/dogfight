/**
 * An object pool: instead of `new` + garbage for every bullet and every spark, take a used object
 * back with `release()` and hand it out again with `acquire()`.
 *
 * Why it matters (Lab 07): short-lived objects are cheap to allocate, but they all become garbage,
 * and every collection of the young generation stops JavaScript for a moment. A pool turns
 * "thousands of objects per second" into "the same few hundred objects, forever".
 *
 * The rule that makes a pool safe: `reset` must put EVERY field back to its initial value,
 * otherwise a reused object remembers its previous life (the classic pool bug).
 */
export class Pool<T> {
  readonly #free: T[] = [];
  readonly #create: () => T;
  readonly #max: number;
  /** How many objects `create` has made / how many acquires were served from the pool. */
  created = 0;
  reused = 0;

  constructor(create: () => T, max = 2048) {
    this.#create = create;
    this.#max = max;
  }

  acquire(): T {
    const item = this.#free.pop();
    if (item !== undefined) {
      this.reused++;
      return item;
    }
    this.created++;
    return this.#create();
  }

  /** Give an object back. Objects over the cap are left to the garbage collector. */
  release(item: T): void {
    if (this.#free.length < this.#max) this.#free.push(item);
  }

  get available(): number {
    return this.#free.length;
  }

  /** Fill the pool up front, so the first burst of bullets does not allocate either. */
  prewarm(count: number): void {
    while (this.#free.length < Math.min(count, this.#max)) {
      this.created++;
      this.#free.push(this.#create());
    }
  }

  clear(): void {
    this.#free.length = 0;
    this.created = 0;
    this.reused = 0;
  }
}
