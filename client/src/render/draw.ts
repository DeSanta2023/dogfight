import type { LoopStats } from '../loop.ts';
import type { Pose } from './interpolate.ts';
import { ARENA } from '@dogfight/shared/arena.ts';
import { createRng } from '@dogfight/shared/rng.ts';

// ---- deterministic starfield (seeded PRNG so it looks the same every run) ----
const { next: rand } = createRng(1337);
const STARS = Array.from({ length: 140 }, () => ({
  x: rand() * ARENA.width,
  y: rand() * ARENA.height,
  r: 0.6 + rand() * 1.4,
  a: 0.25 + rand() * 0.6,
}));

/** Fit the logical arena into the window (letterboxed), return the transform used. */
export function applyWorldTransform(
  ctx: CanvasRenderingContext2D,
  view: { width: number; height: number },
): { scale: number; ox: number; oy: number } {
  const scale = Math.min(view.width / ARENA.width, view.height / ARENA.height);
  const ox = (view.width - ARENA.width * scale) / 2;
  const oy = (view.height - ARENA.height * scale) / 2;
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  return { scale, ox, oy };
}

/**
 * The background never changes: 140 stars, a grid, a frame. Drawing it as ~170 path operations 60
 * times a second was one of the biggest allocators in the heap profile (every beginPath/arc makes
 * garbage inside Chrome). Lab 07: paint it ONCE into an offscreen canvas, then blit it each frame
 * with a single drawImage. The cache is rebuilt only when the on-screen scale changes (resize).
 */
let backdrop: HTMLCanvasElement | null = null;
let backdropScale = 0;

function paintArena(ctx: CanvasRenderingContext2D): void {
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

export function drawArena(ctx: CanvasRenderingContext2D): void {
  const scale = ctx.getTransform().a || 1;
  if (typeof document === 'undefined') return paintArena(ctx); // no DOM (tests): draw directly
  if (!backdrop || Math.abs(scale - backdropScale) > 1e-6) {
    backdrop ??= document.createElement('canvas');
    backdrop.width = Math.ceil(ARENA.width * scale);
    backdrop.height = Math.ceil(ARENA.height * scale);
    const bctx = backdrop.getContext('2d');
    if (!bctx) return paintArena(ctx);
    bctx.scale(scale, scale);
    paintArena(bctx);
    backdropScale = scale;
  }
  ctx.drawImage(backdrop, 0, 0, ARENA.width, ARENA.height);
}

/** Draw the ship at the origin pointing right (+x), then move/rotate the canvas to place it. */
function drawShipBody(ctx: CanvasRenderingContext2D, thrust: number): void {
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
export function drawShip(
  ctx: CanvasRenderingContext2D,
  ship: Pose,
  { blink = false, shield = false }: { blink?: boolean; shield?: boolean } = {},
): void {
  const margin = 20;
  // The ghost copy's offset (0 = none). Two small arrays per ship per frame were garbage: counters.
  const ex =
    ship.x < margin ? ARENA.width : ship.x > ARENA.width - margin ? -ARENA.width : 0;
  const ey =
    ship.y < margin ? ARENA.height : ship.y > ARENA.height - margin ? -ARENA.height : 0;

  for (let i = 0; i <= (ex !== 0 ? 1 : 0); i++) {
    const dx = i === 0 ? 0 : ex;
    for (let j = 0; j <= (ey !== 0 ? 1 : 0); j++) {
      const dy = j === 0 ? 0 : ey;
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

export function drawHud(
  ctx: CanvasRenderingContext2D,
  stats: LoopStats,
  extraLines: readonly string[] = [],
): void {
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
