import assert from 'node:assert/strict';
import type { InputSource } from '../src/ship.ts';

/** Narrow `T | null | undefined` to `T` (or fail the test with a readable message). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  assert.ok(value !== null && value !== undefined, `${what} is missing`);
  return value;
}

/** An input source that holds the given key codes. */
export const hold = (...codes: string[]): InputSource => ({
  isDown: (code) => codes.includes(code),
  justPressed: () => false,
});
