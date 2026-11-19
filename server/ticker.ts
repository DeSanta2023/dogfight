/**
 * A fixed-rate loop WITHOUT setInterval.
 *
 * setInterval(fn, 33.33) waits "at least" 33.33 ms AFTER the previous callback was scheduled, and
 * the timer is rounded to whole milliseconds. Every callback runs a little late and the lateness
 * is never paid back, so the rate drifts below the target (and the drift grows with load).
 *
 * This ticker keeps the TARGET time of the next step, `next = start + n * period`, and after each
 * run sleeps only until that target (`setTimeout(next - now)`). A late step makes the next sleep
 * shorter: the error does not accumulate. If the process was frozen for a long time we run at
 * most `maxCatchUp` steps back-to-back and then SKIP the rest (resynchronise) instead of
 * spiralling: a game that is 2 s behind is better off dropping those 2 s than fast-forwarding.
 *
 * `now`, `setTimer` and `clearTimer` are injectable so the tests need no real waiting.
 */
/** What a timer handle is: Node's Timeout, or whatever object a test's fake clock returns. */
export type TimerHandle = object | number;

export interface TickerOptions {
  hz: number;
  onTick: (tick: number) => void;
  maxCatchUp?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface TickerStats {
  tick: number;
  hz: number;
  meanLateMs: number;
  maxLateMs: number;
  skipped: number;
}

export class Ticker {
  #period: number;
  #now: () => number;
  #setTimer: (fn: () => void, ms: number) => TimerHandle;
  #clearTimer: (handle: TimerHandle) => void;
  #onTick: (tick: number) => void;
  #maxCatchUp: number;
  #next = 0;
  #startedAt = 0;
  #timer: TimerHandle | null = null;
  #running = false;
  #lateSum = 0;

  tick = 0; // steps executed since start()
  skipped = 0; // steps given up by a resynchronisation
  maxLateMs = 0;

  constructor({
    hz,
    onTick,
    maxCatchUp = 5,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    // the default handle IS a Node Timeout (setTimer above made it); `object` is only the wider test type
    clearTimer = (handle) => clearTimeout(handle as NodeJS.Timeout),
  }: TickerOptions) {
    this.#period = 1000 / hz;
    this.#onTick = onTick;
    this.#maxCatchUp = maxCatchUp;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = this.#now();
    this.#next = this.#startedAt + this.#period;
    this.tick = 0;
    this.skipped = 0;
    this.maxLateMs = 0;
    this.#lateSum = 0;
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  #arm() {
    const delay = Math.max(0, Math.ceil(this.#next - this.#now()));
    this.#timer = this.#setTimer(() => this.#run(), delay);
    if (
      typeof this.#timer === 'object' &&
      'unref' in this.#timer &&
      typeof this.#timer.unref === 'function'
    )
      this.#timer.unref(); // the ticker alone must not keep the process alive
  }

  #run() {
    if (!this.#running) return;
    const t = this.#now();
    let ran = 0;
    while (this.#next <= t && ran < this.#maxCatchUp && this.#running) {
      const late = t - this.#next;
      this.#lateSum += late;
      this.maxLateMs = Math.max(this.maxLateMs, late);
      this.#next += this.#period; // the TARGET moves by exactly one period: no drift
      this.tick++;
      ran++;
      try {
        this.#onTick(this.tick);
      } catch (error) {
        this.stop();
        throw error;
      }
    }
    if (this.#running && this.#next <= t) {
      // Still behind after the catch-up budget: drop the missed steps and realign.
      const missed = Math.floor((t - this.#next) / this.#period) + 1;
      this.skipped += missed;
      this.#next += missed * this.#period;
    }
    if (this.#running) this.#arm();
  }

  /** Steps per second since start(): the number the README compares with setInterval. */
  stats(): TickerStats {
    const elapsed = (this.#now() - this.#startedAt) / 1000;
    return {
      tick: this.tick,
      hz: elapsed > 0 ? +(this.tick / elapsed).toFixed(2) : 0,
      meanLateMs: this.tick ? +(this.#lateSum / this.tick).toFixed(2) : 0,
      maxLateMs: +this.maxLateMs.toFixed(2),
      skipped: this.skipped,
    };
  }
}
