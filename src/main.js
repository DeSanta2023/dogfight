import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { Game } from './sim/game.js';
import { createCanvas } from './render/canvas.js';
import { applyWorldTransform, drawArena, drawHud } from './render/draw.js';
import { drawEntity, drawGameHud } from './render/draw-world.js';

// ---------------------------------------------------------------------------
// URL switches. Normal play: no parameters.
//   Lab 01 experiments:
//   ?exp=block      experiment 1: 100 ms busy-wait inside render every 60th frame
//   ?exp=interval   experiment 2: setInterval(frame, 16) instead of requestAnimationFrame
//   ?exp=variable   experiment 3: variable timestep instead of the fixed accumulator
//   &autopilot=1    hold "thrust" automatically (alone in an empty arena, fixed seed)
//                   and report the position after 5 s of simulated time
//   Lab 02:
//   ?seed=123       fixed random seed: the same asteroids and pickups every run
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const experiment = params.get('exp');
const autopilot = params.has('autopilot');
const seedParam = Number(params.get('seed'));

const canvasApi = createCanvas(document.getElementById('game'));
const { ctx, view } = canvasApi;

const input = autopilot
  ? { isDown: (code) => code === 'ArrowUp', justPressed: () => false, endStep: () => {} }
  : createInput(window);

// The sim never calls Math.random(); the seed is chosen HERE, at the edge of the program.
function newGame() {
  if (autopilot) return new Game({ seed: 1, asteroids: 0, pickups: false });
  const seed = seedParam || Math.floor(Math.random() * 2 ** 32);
  return new Game({ seed });
}

let game = newGame();
let simTime = 0;
let autopilotResult = '';

function simulate(dt) {
  if (input.justPressed('KeyR')) game = newGame();

  game.step(dt, input);
  input.endStep();

  simTime += dt;
  if (autopilot && !autopilotResult && simTime >= 5 && game.ship) {
    const { x, y } = game.ship.pos;
    autopilotResult = `5 s thrust -> x=${x.toFixed(3)} y=${y.toFixed(3)}`;
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
  for (const entity of game.world) drawEntity(ctx, entity, alpha);
  ctx.restore();

  drawGameHud(ctx, view, game.hud);

  const extra = [
    `mode       ${experiment ?? 'normal (rAF + fixed step)'}`,
    `alpha      ${alpha.toFixed(2)}   dpr ${view.dpr}   entities ${game.world.size}`,
  ];
  if (autopilotResult) extra.push(autopilotResult);
  else extra.push('arrows/WASD: fly   SPACE: fire   R: restart');
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

// Handy in the DevTools console: dogfight.game.world, dogfight.game.ship.hp, ...
if (import.meta.env?.DEV)
  globalThis.dogfight = {
    loop,
    get game() {
      return game;
    },
  };
