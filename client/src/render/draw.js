import { ARENA } from '../sim/arena.js';
import { createRng } from '../sim/rng.js';

// ---- deterministic starfield (seeded PRNG so it looks the same every run) ----
const { next: rand } = createRng(1337);
const STARS = Array.from({ length: 140 }, () => ({
  x: rand() * ARENA.width,
  y: rand() * ARENA.height,
  r: 0.6 + rand() * 1.4,
  a: 0.25 + rand() * 0.6,
}));

/** Fit the logical arena into the window (letterboxed), return the transform used. */
export function applyWorldTransform(ctx, view) {
  const scale = Math.min(view.width / ARENA.width, view.height / ARENA.height);
  const ox = (view.width - ARENA.width * scale) / 2;
  const oy = (view.height - ARENA.height * scale) / 2;
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  return { scale, ox, oy };
}

export function drawArena(ctx) {
  ctx.fillStyle = '#080c1a';
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);

  for (const s of STARS) {
    ctx.globalAlpha = s.a;
    ctx.fillStyle = '#cfe3ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Grid makes motion (and wrap-around) easy to see.
  ctx.strokeStyle = 'rgba(120, 160, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= ARENA.width; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.height);
  }
  for (let y = 0; y <= ARENA.height; y += 80) {
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.width, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
}

/** Draw the ship at the origin pointing right (+x), then move/rotate the canvas to place it. */
function drawShipBody(ctx, thrust) {
  if (thrust) {
    ctx.fillStyle = '#ff9d3c';
    ctx.beginPath();
    ctx.moveTo(-10, -5);
    ctx.lineTo(-10 - 14 - Math.random() * 10, 0); // flicker only affects visuals, not the sim
    ctx.lineTo(-10, 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#7fe3ff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, -10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/**
 * Draw a ship. Also draws "ghost" copies when it is near an edge so it appears to slide
 * through the border smoothly instead of popping out on the other side.
 */
export function drawShip(ctx, ship, { blink = false, shield = false } = {}) {
  const margin = 20;
  const xs = [0];
  const ys = [0];
  if (ship.x < margin) xs.push(ARENA.width);
  if (ship.x > ARENA.width - margin) xs.push(-ARENA.width);
  if (ship.y < margin) ys.push(ARENA.height);
  if (ship.y > ARENA.height - margin) ys.push(-ARENA.height);

  for (const dx of xs) {
    for (const dy of ys) {
      ctx.save();
      ctx.translate(ship.x + dx, ship.y + dy);
      ctx.rotate(ship.angle);
      ctx.globalAlpha = blink ? 0.3 : 1;
      drawShipBody(ctx, ship.thrust);
      ctx.globalAlpha = 1;
      if (shield) {
        ctx.strokeStyle = 'rgba(110, 255, 220, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 24, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

export function drawHud(ctx, stats, extraLines = []) {
  const lines = [
    `steps/s    ${stats.stepsPerSec.toFixed(1)}`,
    `frames/s   ${stats.framesPerSec.toFixed(1)}`,
    `frame time ${stats.frameTime.toFixed(2)} ms  (σ ${stats.frameJitter.toFixed(2)}, max ${stats.frameMax.toFixed(1)})`,
    `work/frame ${stats.workTime.toFixed(2)} ms`,
    ...extraLines,
  ];
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  const lh = 18;
  const w = 380;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(8, 8, w, lines.length * lh + 12);
  ctx.fillStyle = '#b8ffb8';
  lines.forEach((line, i) => ctx.fillText(line, 16, 14 + i * lh));
}
