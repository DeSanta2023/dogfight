import { KEYS, type InputSource } from './ship.ts';

/**
 * What the client sends to the server: not a position, only WHAT THE PLAYER IS HOLDING.
 * One byte: four bits. The server turns the same bits back into the `isDown(code)` object that
 * the Lab 1 physics (`integrate`) already understands, so browser and server run the same code.
 */
export const TICK_HZ = 30; // simulation steps per second, on the server AND in the browser
export const DT = 1 / TICK_HZ; // the one fixed time step of the networked game

export const BIT = Object.freeze({ LEFT: 1, RIGHT: 2, THRUST: 4, FIRE: 8 });

/** The four bits as one number 0..15. */
export type InputBits = number;

/** An input source that also remembers the bits it was made from. */
export interface BitsInput extends InputSource {
  readonly bits: InputBits;
}

const has = (codes: readonly string[], code: string): boolean => codes.includes(code);

// 16 possible inputs -> 16 frozen objects, built once: no allocation per step.
const TABLE: readonly BitsInput[] = Array.from({ length: 16 }, (_, bits) =>
  Object.freeze({
    bits,
    isDown: (code: string): boolean =>
      ((bits & BIT.LEFT) !== 0 && has(KEYS.left, code)) ||
      ((bits & BIT.RIGHT) !== 0 && has(KEYS.right, code)) ||
      ((bits & BIT.THRUST) !== 0 && has(KEYS.thrust, code)) ||
      ((bits & BIT.FIRE) !== 0 && has(KEYS.fire, code)),
    justPressed: (): boolean => false,
  }),
);

const NONE: BitsInput = Object.freeze({
  bits: 0,
  isDown: () => false,
  justPressed: () => false,
});

/** bits -> an input object for integrate() / Ship.update(). Unknown high bits are ignored. */
export const inputFromBits = (bits: InputBits): BitsInput => TABLE[bits & 15] ?? NONE;

/** anything with isDown(code) -> bits. */
export function bitsFromInput(input: InputSource): InputBits {
  const any = (codes: readonly string[]): boolean => codes.some((c) => input.isDown(c));
  return (
    (any(KEYS.left) ? BIT.LEFT : 0) |
    (any(KEYS.right) ? BIT.RIGHT : 0) |
    (any(KEYS.thrust) ? BIT.THRUST : 0) |
    (any(KEYS.fire) ? BIT.FIRE : 0)
  );
}
