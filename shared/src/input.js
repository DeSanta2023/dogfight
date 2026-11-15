import { KEYS } from './ship.js';

/**
 * What the client sends to the server: not a position, only WHAT THE PLAYER IS HOLDING.
 * One byte: four bits. The server turns the same bits back into the `isDown(code)` object that
 * the Lab 1 physics (`integrate`) already understands, so browser and server run the same code.
 */
export const TICK_HZ = 30; // simulation steps per second, on the server AND in the browser
export const DT = 1 / TICK_HZ; // the one fixed time step of the networked game

export const BIT = Object.freeze({ LEFT: 1, RIGHT: 2, THRUST: 4, FIRE: 8 });

const has = (codes, code) => codes.includes(code);

// 16 possible inputs -> 16 frozen objects, built once: no allocation per step.
const TABLE = Array.from({ length: 16 }, (_, bits) =>
  Object.freeze({
    bits,
    isDown: (code) =>
      (bits & BIT.LEFT && has(KEYS.left, code)) ||
      (bits & BIT.RIGHT && has(KEYS.right, code)) ||
      (bits & BIT.THRUST && has(KEYS.thrust, code)) ||
      (bits & BIT.FIRE && has(KEYS.fire, code)) ||
      false,
    justPressed: () => false,
  }),
);

/** bits -> an input object for integrate() / Ship.update(). Unknown high bits are ignored. */
export const inputFromBits = (bits) => TABLE[bits & 15];

/** anything with isDown(code) -> bits. */
export function bitsFromInput(input) {
  const any = (codes) => codes.some((c) => input.isDown(c));
  return (
    (any(KEYS.left) ? BIT.LEFT : 0) |
    (any(KEYS.right) ? BIT.RIGHT : 0) |
    (any(KEYS.thrust) ? BIT.THRUST : 0) |
    (any(KEYS.fire) ? BIT.FIRE : 0)
  );
}
