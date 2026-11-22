// The server's front door, attacked with random input. parseClientMessage() takes `unknown` bytes
// from a socket and must ALWAYS return a result object: never throw, never accept junk.
import { expect, test } from 'vitest';
import fc from 'fast-check';
import { CLOSE, parseClientMessage } from '../protocol.ts';

const MAX = 2048;

test('property: any string at all gives a result, never an exception', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 3000 }), (text) => {
      const result = parseClientMessage(text, false, MAX);
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(Object.values(CLOSE)).toContain(result.closeCode);
    }),
    { numRuns: 1000 },
  );
});

test('property: valid messages are accepted, whatever the key order or spacing', () => {
  const valid = fc.record({
    v: fc.constant(1),
    type: fc.constant('chat'),
    text: fc.stringMatching(/^[a-zA-Z0-9]{1,50}$/),
  });
  fc.assert(
    fc.property(valid, fc.constantFrom(0, 2), (message, indent) => {
      const result = parseClientMessage(
        JSON.stringify(message, null, indent),
        false,
        MAX,
      );
      expect(result.ok).toBe(true);
    }),
  );
});

test('property: a valid message with ANY single character damaged is never accepted as something else', () => {
  const good = JSON.stringify({
    v: 1,
    type: 'join',
    room: 'lobby',
    name: 'Ace',
    format: 'binary',
  });
  fc.assert(
    fc.property(
      fc.nat(good.length - 1),
      fc.string({ minLength: 1, maxLength: 1 }),
      (at, ch) => {
        const damaged = good.slice(0, at) + ch + good.slice(at + 1);
        const result = parseClientMessage(damaged, false, MAX);
        if (result.ok) {
          // only harmless damage can survive: the message is still a legal join
          expect(result.message.type).toBe('join');
        } else {
          expect(result.ok).toBe(false);
        }
      },
    ),
    { numRuns: 600 },
  );
});

test('property: a frame over the size limit is refused with TOO_BIG, before it is even parsed', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5000 }), (extra) => {
      const result = parseClientMessage('x'.repeat(MAX + extra), false, MAX);
      expect(result).toMatchObject({ ok: false, closeCode: CLOSE.TOO_BIG });
    }),
  );
});

test('binary frames are refused on the JSON path, and Buffers are read as text', () => {
  expect(parseClientMessage(Buffer.from('{}'), true, MAX).ok).toBe(false);
  const asBuffer = parseClientMessage(
    Buffer.from(JSON.stringify({ v: 1, type: 'leave' })),
    false,
    MAX,
  );
  expect(asBuffer.ok).toBe(true);
});
