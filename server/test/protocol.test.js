import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE, ProtocolError, encode, parseClientMessage } from '../protocol.js';

const parse = (obj, { binary = false, max = 2048 } = {}) =>
  parseClientMessage(typeof obj === 'string' ? obj : JSON.stringify(obj), binary, max);
const bad = (input, code, opts) =>
  assert.throws(
    () => parse(input, opts),
    (e) => e instanceof ProtocolError && e.closeCode === code,
  );

test('a good join is cleaned (name trimmed)', () => {
  assert.deepEqual(parse({ v: 1, type: 'join', room: 'quiet-orbit', name: '  Ace  ' }), {
    type: 'join',
    room: 'quiet-orbit',
    name: 'Ace',
  });
});

test('unicode names and chat are fine, and size is counted in BYTES', () => {
  assert.equal(parse({ v: 1, type: 'join', room: 'a', name: 'Вадим' }).name, 'Вадим');
  // "é" is 2 bytes: 40 of them are 80 bytes, which does not fit into max = 64 even as 40 characters
  bad({ v: 1, type: 'chat', text: 'é'.repeat(40) }, CLOSE.TOO_BIG, { max: 64 });
});

test('binary frames are refused', () => bad('{}', CLOSE.UNSUPPORTED, { binary: true }));
test('not JSON', () => bad('{oops', CLOSE.INVALID_PAYLOAD));
test('not an object (null, array, number)', () => {
  for (const raw of ['null', '[1]', '5', '"x"']) bad(raw, CLOSE.POLICY);
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
});
test('chat: empty and too long', () => {
  bad({ v: 1, type: 'chat', text: '   ' }, CLOSE.POLICY);
  bad({ v: 1, type: 'chat', text: 'x'.repeat(301) }, CLOSE.POLICY);
  bad({ v: 1, type: 'chat', text: { toString: 'x' } }, CLOSE.POLICY);
});
test('extra fields are dropped, not passed on', () => {
  assert.deepEqual(parse({ v: 1, type: 'chat', text: 'hi', admin: true }), {
    type: 'chat',
    text: 'hi',
  });
});
test('encode adds the version', () => {
  assert.deepEqual(JSON.parse(encode('chat', { text: 'x' })), {
    v: 1,
    type: 'chat',
    text: 'x',
  });
});
