import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE, encode, parseClientMessage, type ParseResult } from '../protocol.ts';

const parse = (
  input: unknown,
  { binary = false, max = 2048 }: { binary?: boolean; max?: number } = {},
): ParseResult =>
  parseClientMessage(
    typeof input === 'string' ? input : JSON.stringify(input),
    binary,
    max,
  );

/** The parsed message of a good frame (the test fails if the frame was refused). */
function good(input: unknown) {
  const result = parse(input);
  assert.ok(result.ok, `expected a good frame, got ${JSON.stringify(result)}`);
  return result.message;
}

/** A bad frame does NOT throw: it comes back as { ok: false, closeCode, reason }. */
function bad(input: unknown, code: number, opts?: { binary?: boolean; max?: number }) {
  const result = parse(input, opts);
  assert.ok(!result.ok, 'expected the frame to be refused');
  assert.equal(result.closeCode, code);
  assert.ok(Buffer.byteLength(result.reason) <= 123, 'fits a close frame');
}

test('a good join is cleaned (name trimmed)', () => {
  assert.deepEqual(good({ v: 1, type: 'join', room: 'quiet-orbit', name: '  Ace  ' }), {
    v: 1,
    type: 'join',
    room: 'quiet-orbit',
    name: 'Ace',
    format: 'binary', // Lab 05: binary game frames unless the client asks for JSON
  });
});

test('unicode names and chat are fine, and size is counted in BYTES', () => {
  const message = good({ v: 1, type: 'join', room: 'a', name: 'Вадим' });
  assert.ok(message.type === 'join'); // narrowing on `type`: only now is `.name` known to exist
  assert.equal(message.name, 'Вадим');
  // "é" is 2 bytes: 40 of them are 80 bytes, which does not fit into max = 64 even as 40 characters
  bad({ v: 1, type: 'chat', text: 'é'.repeat(40) }, CLOSE.TOO_BIG, { max: 64 });
});

test('binary frames are refused', () => bad('{}', CLOSE.UNSUPPORTED, { binary: true }));
test('not JSON: no exception, a result', () => bad('{oops', CLOSE.INVALID_PAYLOAD));
test('not an object (null, array, number)', () => {
  for (const raw of ['null', '[1]', '5', '"x"']) bad(raw, CLOSE.POLICY);
});
test('anything that is not text is refused too (the parameter is `unknown`)', () => {
  for (const raw of [undefined, 42, {}, ['x']]) {
    const result = parseClientMessage(raw, false, 2048);
    assert.ok(!result.ok);
  }
});
test('wrong or missing version', () => {
  bad({ type: 'leave' }, CLOSE.POLICY);
  bad({ v: 2, type: 'leave' }, CLOSE.POLICY);
});
test('unknown type, including names that exist on Object.prototype', () => {
  bad({ v: 1, type: 'teleport' }, CLOSE.POLICY);
  bad({ v: 1, type: 'constructor' }, CLOSE.POLICY);
  bad({ v: 1, type: '__proto__' }, CLOSE.POLICY);
});
test('join: bad room id / name', () => {
  bad({ v: 1, type: 'join', room: '../etc', name: 'a' }, CLOSE.POLICY);
  bad({ v: 1, type: 'join', room: 'a', name: '' }, CLOSE.POLICY);
  bad({ v: 1, type: 'join', room: 'a', name: 'x'.repeat(25) }, CLOSE.POLICY);
  bad({ v: 1, type: 'join', room: 'a', name: '<b>' }, CLOSE.POLICY);
  bad({ v: 1, type: 'join', room: 5, name: 'a' }, CLOSE.POLICY);
  bad({ v: 1, type: 'join', room: 'a', name: 'a', format: 'xml' }, CLOSE.POLICY);
});
test('chat: empty and too long', () => {
  bad({ v: 1, type: 'chat', text: '   ' }, CLOSE.POLICY);
  bad({ v: 1, type: 'chat', text: 'x'.repeat(301) }, CLOSE.POLICY);
  bad({ v: 1, type: 'chat', text: { toString: 'x' } }, CLOSE.POLICY);
});
test('JSON game messages: input and ping are checked field by field', () => {
  assert.deepEqual(good({ v: 1, type: 'input', seq: 7, bits: [1, 5] }), {
    v: 1,
    type: 'input',
    seq: 7,
    bits: [1, 5],
  });
  bad({ v: 1, type: 'input', seq: 0, bits: [1] }, CLOSE.POLICY); // seq starts at 1
  bad({ v: 1, type: 'input', seq: 1.5, bits: [1] }, CLOSE.POLICY);
  bad({ v: 1, type: 'input', seq: 1, bits: [] }, CLOSE.POLICY);
  bad({ v: 1, type: 'input', seq: 1, bits: [16] }, CLOSE.POLICY); // only 4 bits exist
  bad({ v: 1, type: 'input', seq: 1, bits: new Array(33).fill(0) }, CLOSE.POLICY);
  bad({ v: 1, type: 'ping', t: 'now' }, CLOSE.POLICY);
});
test('extra fields are dropped, not passed on', () => {
  assert.deepEqual(good({ v: 1, type: 'chat', text: 'hi', admin: true }), {
    v: 1,
    type: 'chat',
    text: 'hi',
  });
});
test('encode adds the version', () => {
  assert.deepEqual(JSON.parse(encode({ type: 'chat', from: 'a', text: 'x', at: 1 })), {
    v: 1,
    type: 'chat',
    from: 'a',
    text: 'x',
    at: 1,
  });
});
