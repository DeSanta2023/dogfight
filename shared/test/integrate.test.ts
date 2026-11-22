import { expect, test } from 'vitest';
import { ARENA } from '../src/arena.ts';
import { TUNING, createShip, integrate, type ShipState } from '../src/ship.ts';
import { DT, inputFromBits, BIT } from '../src/input.ts';
import { hold } from './helpers.ts';

const still: ShipState = { x: 100, y: 100, vx: 0, vy: 0, angle: 0, thrust: 0 };

test('integrate: no keys, no movement: a ship at rest stays at rest', () => {
  expect(integrate(still, hold(), DT)).toEqual(still);
});

test('integrate: thrust accelerates along the heading', () => {
  const next = integrate(still, hold('ArrowUp'), DT);
  expect(next.vx).toBeGreaterThan(0);
  expect(next.vy).toBeCloseTo(0, 12);
  expect(next.thrust).toBe(1);
  expect(next.x).toBeGreaterThan(still.x);
});

test('integrate: left and right turn in opposite directions, both together cancel', () => {
  const right = integrate(still, hold('ArrowRight'), DT).angle;
  const left = integrate(still, hold('ArrowLeft'), DT).angle;
  expect(right).toBeCloseTo(TUNING.turnRate * DT, 12);
  expect(left).toBeCloseTo(2 * Math.PI - TUNING.turnRate * DT, 12); // wrapped into [0, 2pi)
  expect(integrate(still, hold('ArrowLeft', 'ArrowRight'), DT).angle).toBe(0);
});

test('integrate: drag slows a coasting ship down, and it never reverses', () => {
  let ship: ShipState = { ...still, vx: 100 };
  for (let i = 0; i < 600; i++) {
    const next = integrate(ship, hold(), DT);
    expect(next.vx).toBeLessThanOrEqual(ship.vx);
    expect(next.vx).toBeGreaterThanOrEqual(0);
    ship = next;
  }
  expect(ship.vx).toBeLessThan(1);
});

test('integrate: speed is clamped to maxSpeed even with the throttle held forever', () => {
  let ship = createShip();
  for (let i = 0; i < 3000; i++) ship = integrate(ship, inputFromBits(BIT.THRUST), DT);
  expect(Math.hypot(ship.vx, ship.vy)).toBeLessThanOrEqual(TUNING.maxSpeed + 1e-9);
});

test('integrate: leaving the arena wraps to the other side', () => {
  const edge: ShipState = {
    x: ARENA.width - 0.1,
    y: 0.1,
    vx: 300,
    vy: -300,
    angle: 0,
    thrust: 0,
  };
  const next = integrate(edge, hold(), DT);
  expect(next.x).toBeGreaterThanOrEqual(0);
  expect(next.x).toBeLessThan(15); // came back in on the left
  expect(next.y).toBeGreaterThan(ARENA.height - 20); // and on the bottom
});

test('integrate is pure: it does not change its argument and gives the same answer twice', () => {
  const frozen = Object.freeze({ ...still, vx: 12 });
  const a = integrate(frozen, hold('ArrowUp', 'ArrowLeft'), DT);
  const b = integrate(frozen, hold('ArrowUp', 'ArrowLeft'), DT);
  expect(a).toEqual(b);
  expect(frozen.vx).toBe(12);
});

test('integrate: the arrow keys and WASD are the same keys', () => {
  expect(integrate(still, hold('KeyW', 'KeyA'), DT)).toEqual(
    integrate(still, hold('ArrowUp', 'ArrowLeft'), DT),
  );
});
