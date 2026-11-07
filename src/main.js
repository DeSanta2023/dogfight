import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { createShip, integrate } from './sim/ship.js';
import { createCanvas } from './render/canvas.js';
import { applyWorldTransform, drawArena, drawShip, drawHud } from './render/draw.js';
import { interpolateShip } from './render/interpolate.js';

// ---------------------------------------------------------------------------
// Lab 01 experiment switches (URL query string). Normal play: no parameters.
//   ?exp=block      experiment 1: 100 ms busy-wait inside render every 60th frame
//   ?exp=interval   experiment 2: setInterval(frame, 16) instead of requestAnimationFrame
//   ?exp=variable   experiment 3: variable timestep instead of the fixed accumulator
//   &autopilot=1    hold "thrust" automatically and log the position after 5 s of simulated time
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const experiment = params.get('exp');
const autopilot = params.has('autopilot');

const canvasApi = createCanvas(document.getElementById('game'));
const { ctx, view } = canvasApi;

const input = autopilot
  ? { isDown: (code) => code === 'ArrowUp', justPressed: () => false, endStep: () => {} }
  : createInput(window);

// Simulation state: we keep the previous AND the current state so render can interpolate.
let previous = createShip();
let current = previous;
let simTime = 0;
let autopilotResult = '';

function simulate(dt) {
  if (input.justPressed('KeyR')) {
    current = createShip();
    previous = current;
  }
  previous = current;
  current = integrate(current, input, dt);
  input.endStep();

  simTime += dt;
  if (autopilot && !autopilotResult && simTime >= 5) {
    autopilotResult = `5 s thrust -> x=${current.x.toFixed(3)} y=${current.y.toFixed(3)}`;
    console.log(`[${experiment ?? 'fixed'}] ${autopilotResult}`);
  }
}

let frameCounter = 0;

function render(alpha, stats) {
  frameCounter++;
  if (experiment === 'block' && frameCounter % 60 === 0) {
    const t = performance.now();
    while (performance.now() < t + 100) {
      // busy-wait: nothing else can run on the main thread meanwhile
    }
  }

  canvasApi.begin();
  ctx.save();
  applyWorldTransform(ctx, view);
  drawArena(ctx);
  drawShip(ctx, interpolateShip(previous, current, alpha));
  ctx.restore();

  const extra = [
    `mode       ${experiment ?? 'normal (rAF + fixed step)'}`,
    `alpha      ${alpha.toFixed(2)}   dpr ${view.dpr}`,
  ];
  if (autopilotResult) extra.push(autopilotResult);
  else extra.push('arrows / WASD: fly   R: reset');
  drawHud(ctx, stats, extra);
}

const loop = createLoop({
  step: 1 / 60,
  simulate,
  render,
  scheduler: experiment === 'interval' ? 'interval' : 'raf',
  fixedStep: experiment !== 'variable',
});

loop.start();
