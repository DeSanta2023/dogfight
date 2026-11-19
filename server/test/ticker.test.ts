import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ticker, type TimerHandle } from '../ticker.ts';

interface FakeTimer {
  fn: () => void;
  at: number;
}

/** A fake clock: timers fire only when the test says time has passed. */
function fakeClock() {
  let t = 1000;
  const timers: FakeTimer[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): TimerHandle => {
      const timer: FakeTimer = { fn, at: t + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: TimerHandle) => {
      const index = timers.findIndex((candidate) => candidate === timer);
      if (index >= 0) timers.splice(index, 1);
    },
    /** Advance to `target`, firing timers; `lateBy` simulates timers that fire late. */
    run(until: number, lateBy = 0) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        t = next.at + lateBy;
        next.fn();
      }
      t = until;
    },
  };
}

test('late timers do not make the rate drift: 30 steps per second on average', () => {
  const clock = fakeClock();
  let ticks = 0;
  const ticker = new Ticker({ hz: 30, onTick: () => ticks++, ...clock });
  ticker.start();
  clock.run(1000 + 10_000, 2); // every timer fires 2 ms late
  assert.ok(ticks >= 299 && ticks <= 301, `ticks=${ticks}`);
  assert.equal(ticker.skipped, 0);
});

test('setInterval-style scheduling (next = now + period) WOULD drift: the contrast', () => {
  const clock = fakeClock();
  let ticks = 0;
  const period = 1000 / 30;
  const loop = () => {
    ticks++;
    clock.setTimer(loop, Math.ceil(period)); // what setInterval effectively does: whole ms, no catch-up
  };
  clock.setTimer(loop, Math.ceil(period));
  clock.run(1000 + 10_000, 2);
  assert.ok(ticks < 290, `a naive loop did ${ticks} steps in 10 s`);
});

test('after a long freeze it runs a few steps, then skips the rest and resynchronises', () => {
  const clock = fakeClock();
  const seen = [];
  const ticker = new Ticker({
    hz: 30,
    maxCatchUp: 5,
    onTick: (n) => seen.push(n),
    ...clock,
  });
  ticker.start();
  clock.run(1000 + 34); // one normal step
  clock.run(1000 + 34 + 3000, 3000); // frozen 3 s: the timer fires 3 s late
  assert.ok(ticker.skipped > 50, `skipped=${ticker.skipped}`);
  assert.ok(seen.length <= 1 + 5 + 5, 'no fast-forward spiral');
  clock.run(1000 + 34 + 3000 + 1000);
  assert.ok(seen.length > 25, 'and it keeps ticking afterwards');
});

test('stop() cancels the pending timer', () => {
  const clock = fakeClock();
  let ticks = 0;
  const ticker = new Ticker({ hz: 30, onTick: () => ticks++, ...clock });
  ticker.start();
  ticker.stop();
  clock.run(5000);
  assert.equal(ticks, 0);
});
