// Experiment 3, headless: does the trajectory depend on the frame rate?
// Runs the SAME pure integrate() for 5 simulated seconds of held thrust under different
// frame-time patterns, once with a fixed-step accumulator and once with a variable step.
// Usage: npm run determinism
import { createShip, integrate } from '../src/sim/ship.js';

const STEP = 1 / 60;
const MAX_DELTA = 0.25;
const holdThrust = { isDown: (code) => code === 'ArrowUp' };

// Frame-time patterns in ms between frames. Each entry is a FACTORY returning a fresh
// "next frame time" function, so every run starts from the same state (same jitter sequence).
const makeRng = (seed) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};
const constant = (ms) => () => () => ms;
const patterns = {
  '60 Hz  (16.667 ms)': constant(1000 / 60),
  '120 Hz (8.333 ms)': constant(1000 / 120),
  '144 Hz (6.944 ms)': constant(1000 / 144),
  'jittery 10-30 ms': () => {
    const rng = makeRng(42);
    return () => 10 + rng() * 20;
  },
  'throttled ~100 ms': constant(100),
};

function runFixed(nextFrameMs) {
  let ship = createShip();
  let acc = 0;
  let simTime = 0;
  let steps = 0;
  while (steps < 300) {
    acc += Math.min(nextFrameMs() / 1000, MAX_DELTA);
    while (acc >= STEP && steps < 300) {
      ship = integrate(ship, holdThrust, STEP);
      acc -= STEP;
      simTime += STEP;
      steps++;
    }
  }
  return { ship, simTime };
}

function runVariable(nextFrameMs) {
  let ship = createShip();
  let simTime = 0;
  while (simTime < 5) {
    const dt = Math.min(nextFrameMs() / 1000, MAX_DELTA);
    ship = integrate(ship, holdThrust, dt);
    simTime += dt;
  }
  return { ship, simTime };
}

const fmt = ({ ship, simTime }) =>
  `x=${ship.x.toFixed(3).padStart(9)} y=${ship.y.toFixed(3).padStart(9)}  (sim ${simTime.toFixed(3)} s)`;

for (const [title, run] of [
  ['FIXED step (accumulator, 300 steps of 1/60 s)', runFixed],
  ['VARIABLE step (simulate(dt) once per frame, ~5 s)', runVariable],
]) {
  console.log(`\n${title}`);
  for (const [name, makePattern] of Object.entries(patterns)) {
    console.log(`  ${name.padEnd(20)} ${fmt(run(makePattern()))}`);
  }
}
