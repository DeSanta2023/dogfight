// The game loop with FAKE timers: no real waiting, and the clock is ours. vi.useFakeTimers()
// replaces setTimeout/setInterval and performance.now(); requestAnimationFrame (which Node does not
// have) is stubbed on top of setTimeout at 60 Hz.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLoop } from '../src/loop.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) =>
    setTimeout(() => cb(performance.now()), 1000 / 60),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) =>
    clearTimeout(id),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function counters() {
  const simulate = vi.fn();
  const render = vi.fn();
  return { simulate, render };
}

test('fixed step: one simulated second is 60 steps, however many frames were drawn', () => {
  const { simulate, render } = counters();
  const loop = createLoop({ simulate, render });
  loop.start();
  vi.advanceTimersByTime(1000);
  loop.stop();
  expect(simulate.mock.calls.length).toBeGreaterThanOrEqual(58);
  expect(simulate.mock.calls.length).toBeLessThanOrEqual(61);
  expect(simulate.mock.calls.every(([dt]) => Math.abs(dt - 1 / 60) < 1e-12)).toBe(true);
  expect(render.mock.calls.length).toBeGreaterThanOrEqual(58);
});

test('a 30 Hz loop simulates 30 steps per second (the networked game)', () => {
  const { simulate, render } = counters();
  const loop = createLoop({ simulate, render, step: 1 / 30 });
  loop.start();
  vi.advanceTimersByTime(2000);
  loop.stop();
  expect(simulate.mock.calls.length).toBeGreaterThanOrEqual(58);
  expect(simulate.mock.calls.length).toBeLessThanOrEqual(61);
});

test('render gets alpha in [0, 1): where between two simulated states the frame falls', () => {
  const alphas: number[] = [];
  const loop = createLoop({
    simulate: () => {},
    render: (a) => alphas.push(a),
    step: 1 / 30,
  });
  loop.start();
  vi.advanceTimersByTime(500);
  loop.stop();
  expect(alphas.length).toBeGreaterThan(10);
  expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
  expect(new Set(alphas.map((a) => a.toFixed(2))).size).toBeGreaterThan(1); // it really varies
});

test('after a long stall the loop does not try to catch up on all of it (no spiral of death)', () => {
  const { simulate, render } = counters();
  const loop = createLoop({ simulate, render });
  loop.start();
  vi.advanceTimersByTime(100);
  const before = simulate.mock.calls.length;
  vi.setSystemTime(Date.now() + 10_000); // the tab was in the background for 10 s
  vi.advanceTimersByTime(40);
  const burst = simulate.mock.calls.length - before;
  loop.stop();
  expect(burst).toBeLessThanOrEqual(20); // the frame delta is clamped: ~0.25 s, not 10 s = 600 steps
});

test('stop() really stops: no more steps or frames, and start() twice does not double the speed', () => {
  const { simulate, render } = counters();
  const loop = createLoop({ simulate, render });
  loop.start();
  loop.start(); // second call is ignored
  vi.advanceTimersByTime(500);
  const steps = simulate.mock.calls.length;
  expect(steps).toBeLessThanOrEqual(32);
  loop.stop();
  vi.advanceTimersByTime(1000);
  expect(simulate.mock.calls.length).toBe(steps);
});

test('the interval scheduler works the same way (experiment 2 of Lab 2)', () => {
  const { simulate, render } = counters();
  const loop = createLoop({ simulate, render, scheduler: 'interval' });
  loop.start();
  vi.advanceTimersByTime(1000);
  loop.stop();
  expect(simulate.mock.calls.length).toBeGreaterThan(50);
});

test('stats are rolled every window: steps per second is measured, not assumed', () => {
  const { simulate, render } = counters();
  const loop = createLoop({ simulate, render });
  loop.start();
  vi.advanceTimersByTime(1500);
  loop.stop();
  expect(loop.stats.stepsPerSec).toBeGreaterThan(55);
  expect(loop.stats.stepsPerSec).toBeLessThan(65);
});
