import { ARENA, wrap, wrapPosition } from './arena.js';

// Tuning (see README "Tuning notes"). Units: world units, radians, seconds.
export const TUNING = Object.freeze({
  turnRate: 3.8, // rad/s
  thrustAccel: 380, // units/s^2
  drag: 0.5, // 1/s — fraction of velocity lost per second
  maxSpeed: 686, // units/s
});

export const KEYS = Object.freeze({
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  thrust: ['ArrowUp', 'KeyW'],
});

export function createShip() {
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    thrust: 0,
  };
}

const anyDown = (input, codes) => codes.some((c) => input.isDown(c));

/**
 * Pure physics step: (ship, input, dt) -> new ship.
 * No DOM, no canvas, no globals, no mutation of `ship`. Same inputs => same output.
 * `input` is anything with isDown(code), so tests can pass a plain object.
 */
export function integrate(ship, input, dt) {
  const turn = (anyDown(input, KEYS.right) ? 1 : 0) - (anyDown(input, KEYS.left) ? 1 : 0);
  const thrust = anyDown(input, KEYS.thrust) ? 1 : 0;

  const angle = wrap(ship.angle + turn * TUNING.turnRate * dt, 2 * Math.PI);

  // Accelerate along the heading, then apply linear drag.
  let vx = ship.vx + Math.cos(angle) * TUNING.thrustAccel * thrust * dt;
  let vy = ship.vy + Math.sin(angle) * TUNING.thrustAccel * thrust * dt;
  const damping = Math.max(0, 1 - TUNING.drag * dt);
  vx *= damping;
  vy *= damping;

  // Clamp speed.
  const speed = Math.hypot(vx, vy);
  if (speed > TUNING.maxSpeed) {
    const k = TUNING.maxSpeed / speed;
    vx *= k;
    vy *= k;
  }

  return wrapPosition({
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrust,
  });
}
