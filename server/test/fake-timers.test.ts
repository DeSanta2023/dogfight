// Rate limiting and the tick loop, tested with FAKE time: a "second" costs nothing, and a test can
// ask "what if the event loop stalled for half a second?" without sleeping.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TokenBucket } from '../ratelimit.ts';
import { Ticker } from '../ticker.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('Ticker at 30 Hz runs 30 ticks in one second of fake time', () => {
  const onTick = vi.fn();
  const ticker = new Ticker({ hz: 30, onTick });
  ticker.start();
  vi.advanceTimersByTime(1000);
  ticker.stop();
  expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(29);
  expect(onTick.mock.calls.length).toBeLessThanOrEqual(31);
});

test('Ticker: ticks are numbered 1, 2, 3, ... with no gaps', () => {
  const seen: number[] = [];
  const ticker = new Ticker({ hz: 30, onTick: (n) => seen.push(n) });
  ticker.start();
  vi.advanceTimersByTime(500);
  ticker.stop();
  expect(seen).toEqual(seen.map((_, i) => i + 1));
});

test('Ticker: stop() cancels the pending timer, nothing fires afterwards', () => {
  const onTick = vi.fn();
  const ticker = new Ticker({ hz: 30, onTick });
  ticker.start();
  vi.advanceTimersByTime(100);
  ticker.stop();
  const count = onTick.mock.calls.length;
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(1000);
  expect(onTick.mock.calls.length).toBe(count);
  expect(ticker.running).toBe(false);
});

test('Ticker: when the process stalls it catches up a few ticks and then skips the rest', () => {
  const onTick = vi.fn();
  const ticker = new Ticker({ hz: 30, onTick, maxCatchUp: 5, now: () => Date.now() }); // the fake clock
  ticker.start();
  vi.advanceTimersByTime(100);
  const before = onTick.mock.calls.length;
  // a 2 s freeze of the event loop: the clock jumps, no timers run during it
  vi.setSystemTime(Date.now() + 2000);
  vi.advanceTimersByTime(34);
  const burst = onTick.mock.calls.length - before;
  ticker.stop();
  expect(burst).toBeLessThanOrEqual(6); // maxCatchUp + the regular one, not 60 ticks in a row
  expect(ticker.skipped).toBeGreaterThan(0); // the rest was given up and counted
});

test('TokenBucket on the real clock API: a burst, then exactly the refill rate', () => {
  const bucket = new TokenBucket({
    perSecond: 20,
    burst: 10,
    now: () => performance.now(),
  });
  let taken = 0;
  for (let i = 0; i < 30; i++) if (bucket.take()) taken++;
  expect(taken).toBe(10); // the burst, all at the same instant
  vi.advanceTimersByTime(1000);
  taken = 0;
  for (let i = 0; i < 30; i++) if (bucket.take()) taken++;
  expect(taken).toBe(10); // 20 tokens came back, capped at the burst of 10
});

test('TokenBucket: a client that sends at exactly the allowed rate is never refused', () => {
  const bucket = new TokenBucket({
    perSecond: 90,
    burst: 180,
    now: () => performance.now(),
  });
  let refused = 0;
  for (let i = 0; i < 900; i++) {
    vi.advanceTimersByTime(1000 / 90);
    if (!bucket.take()) refused++;
  }
  expect(refused).toBe(0);
});
