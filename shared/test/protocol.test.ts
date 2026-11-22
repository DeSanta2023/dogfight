import { expect, test } from 'vitest';
import fc from 'fast-check';
import {
  LIMITS,
  clientMessageSchema,
  encode,
  serverMessageSchema,
} from '../src/protocol.ts';

const roomId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
const name = fc.stringMatching(/^[A-Za-z0-9_.-]{1,20}$/);
const text = fc
  .stringMatching(/^[A-Za-z0-9 ,.!?]{1,100}$/)
  .filter((t) => t.trim().length > 0);

/** Messages the protocol allows. */
const validMessage = fc.oneof(
  fc.record({
    v: fc.constant(1),
    type: fc.constant('join'),
    room: roomId,
    name,
    format: fc.constantFrom('binary', 'json'),
  }),
  fc.record({ v: fc.constant(1), type: fc.constant('chat'), text }),
  fc.record({ v: fc.constant(1), type: fc.constant('leave') }),
  fc.record({
    v: fc.constant(1),
    type: fc.constant('ping'),
    t: fc.double({ noNaN: true, noDefaultInfinity: true }),
  }),
  fc.record({
    v: fc.constant(1),
    type: fc.constant('input'),
    seq: fc.integer({ min: 1, max: 0xffffffff }),
    bits: fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 1, maxLength: 32 }),
  }),
);

test('property: every valid client message is accepted', () => {
  fc.assert(
    fc.property(validMessage, (message) => {
      expect(clientMessageSchema.safeParse(message).success).toBe(true);
    }),
    { numRuns: 500 },
  );
});

test('property: breaking a valid message in any one way makes the parser refuse it', () => {
  const damage = fc.oneof(
    fc.constant((m: Record<string, unknown>) => ({ ...m, v: 2 })), // wrong protocol version
    fc.constant((m: Record<string, unknown>) => ({ ...m, type: 'hack' })), // unknown type
    fc.constant((m: Record<string, unknown>) => ({ ...m, type: undefined })),
    fc.constant((m: Record<string, unknown>) => ({ ...m, v: '1' })), // right value, wrong type
  );
  fc.assert(
    fc.property(validMessage, damage, (message, hurt) => {
      expect(clientMessageSchema.safeParse(hurt({ ...message })).success).toBe(false);
    }),
    { numRuns: 400 },
  );
});

test('property: limits are enforced: names, chat text and room ids that are too long are refused', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 500 }), (extra) => {
      const long = (n: number) => 'a'.repeat(n);
      expect(
        clientMessageSchema.safeParse({
          v: 1,
          type: 'chat',
          text: long(LIMITS.textMax + extra),
        }).success,
      ).toBe(false);
      expect(
        clientMessageSchema.safeParse({
          v: 1,
          type: 'join',
          room: 'x',
          name: long(LIMITS.nameMax + extra),
        }).success,
      ).toBe(false);
      expect(
        clientMessageSchema.safeParse({
          v: 1,
          type: 'join',
          room: long(LIMITS.roomIdMax + extra),
          name: 'n',
        }).success,
      ).toBe(false);
    }),
  );
});

test('property: arbitrary JSON values never crash the parser, they are either accepted or refused', () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      const result = clientMessageSchema.safeParse(value);
      expect(typeof result.success).toBe('boolean');
    }),
    { numRuns: 1000 },
  );
});

test('input: seq 0, negative, fractional and bits out of 0..15 are refused', () => {
  const base = { v: 1, type: 'input', seq: 1, bits: [0] };
  expect(clientMessageSchema.safeParse(base).success).toBe(true);
  for (const bad of [
    { seq: 0 },
    { seq: -1 },
    { seq: 1.5 },
    { bits: [16] },
    { bits: [] },
    { bits: Array(33).fill(0) },
  ])
    expect(clientMessageSchema.safeParse({ ...base, ...bad }).success).toBe(false);
});

test('encode() makes a message the server schema understands, with the version stamped in', () => {
  const text = encode({ type: 'roster', players: [] });
  expect(JSON.parse(text)).toEqual({ v: 1, type: 'roster', players: [] });
  expect(serverMessageSchema.safeParse(JSON.parse(text)).success).toBe(true);
});
