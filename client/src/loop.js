/**
 * Game loop: fixed-timestep simulation + variable-rate rendering with interpolation.
 * See Glenn Fiedler, "Fix Your Timestep!".
 *
 * Normal usage needs only { step, simulate, render }.
 * `scheduler` and `fixedStep` exist ONLY so Lab 01 experiments 2 and 3 can break the loop
 * on purpose. The defaults are the correct behaviour.
 */

const STATS_WINDOW_MS = 500;
const MAX_FRAME_DELTA = 0.25; // seconds; clamp so a hitch never causes a "spiral of death"

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  scheduler = 'raf', // 'raf' | 'interval' (experiment 2)
  fixedStep = true, // false = variable timestep (experiment 3)
}) {
  let running = false;
  let rafId = 0;
  let intervalId = 0;
  let last = 0;
  let accumulator = 0;

  // Rolling-window counters (private state captured by the closure).
  let windowStart = 0;
  let steps = 0;
  let frames = 0;
  let workSum = 0;
  let deltaSum = 0;
  let deltaSqSum = 0;
  let deltaMax = 0;

  const stats = {
    stepsPerSec: 0,
    framesPerSec: 0,
    frameTime: 0, // ms, average time between frames (what the player experiences)
    frameJitter: 0, // ms, standard deviation of frame time in the window
    frameMax: 0, // ms, worst frame in the window
    workTime: 0, // ms, average CPU time spent in simulate + render
  };

  function frame(now = performance.now()) {
    const t0 = performance.now();
    const deltaMs = Math.max(0, now - last);
    last = now;

    let alpha;
    if (fixedStep) {
      accumulator += Math.min(deltaMs / 1000, MAX_FRAME_DELTA);
      while (accumulator >= step) {
        simulate(step);
        accumulator -= step;
        steps++;
      }
      alpha = accumulator / step; // [0, 1): how far we are between two simulated states
    } else {
      simulate(Math.min(deltaMs / 1000, MAX_FRAME_DELTA)); // WRONG on purpose (experiment 3)
      steps++;
      alpha = 1;
    }

    render(alpha, stats);
    frames++;

    // --- bookkeeping ---
    const t1 = performance.now();
    workSum += t1 - t0;
    deltaSum += deltaMs;
    deltaSqSum += deltaMs * deltaMs;
    deltaMax = Math.max(deltaMax, deltaMs);

    const elapsed = t1 - windowStart;
    if (elapsed >= STATS_WINDOW_MS) {
      const mean = deltaSum / frames;
      stats.stepsPerSec = (steps * 1000) / elapsed;
      stats.framesPerSec = (frames * 1000) / elapsed;
      stats.frameTime = mean;
      stats.frameJitter = Math.sqrt(Math.max(0, deltaSqSum / frames - mean * mean));
      stats.frameMax = deltaMax;
      stats.workTime = workSum / frames;
      windowStart = t1;
      steps = frames = 0;
      workSum = deltaSum = deltaSqSum = deltaMax = 0;
    }

    if (running && scheduler === 'raf') rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    windowStart = last;
    accumulator = 0;
    steps = frames = 0;
    if (scheduler === 'raf') rafId = requestAnimationFrame(frame);
    else intervalId = setInterval(() => frame(), 16);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(intervalId);
  }

  return { start, stop, stats };
}
