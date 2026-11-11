/**
 * Token bucket: the bucket holds up to `burst` tokens and refills at `perSecond`. Each message
 * costs one token. A client may burst (a few quick messages are normal) but cannot sustain more
 * than `perSecond` for long. `now` is injectable so tests need no real waiting.
 */
export class TokenBucket {
  #tokens;
  #last;

  constructor({ perSecond, burst, now = Date.now }) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  take(cost = 1) {
    const t = this.now();
    this.#tokens = Math.min(
      this.burst,
      this.#tokens + ((t - this.#last) / 1000) * this.perSecond,
    );
    this.#last = t;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
