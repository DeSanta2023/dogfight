import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector2 } from '../src/sim/vector.js';

test('Vector2 methods are pure: they return new vectors and never mutate', () => {
  const a = new Vector2(3, 4);
  const b = new Vector2(1, 2);
  const sum = a.add(b);

  assert.notEqual(sum, a);
  assert.deepEqual([a.x, a.y], [3, 4]);
  assert.deepEqual([b.x, b.y], [1, 2]);
  assert.deepEqual([sum.x, sum.y], [4, 6]);
});

test('Vector2 instances are frozen: accidental mutation throws (modules are strict)', () => {
  const v = new Vector2(1, 1);
  assert.throws(() => {
    v.x = 5;
  }, TypeError);
});

test('Vector2 arithmetic', () => {
  const v = new Vector2(3, 4);
  assert.equal(v.length(), 5);
  assert.equal(v.dot(new Vector2(2, 1)), 10);
  assert.deepEqual(v.sub(new Vector2(1, 1)), new Vector2(2, 3));
  assert.deepEqual(v.scale(2), new Vector2(6, 8));
  assert.ok(Math.abs(v.normalize().length() - 1) < 1e-12);
  assert.equal(Vector2.ZERO.normalize(), Vector2.ZERO);
});

test('Vector2.fromAngle, rotate and angle agree', () => {
  const east = Vector2.fromAngle(0);
  const north = east.rotate(Math.PI / 2);
  assert.ok(Math.abs(north.x) < 1e-12 && Math.abs(north.y - 1) < 1e-12);
  assert.ok(Math.abs(Vector2.fromAngle(1.2, 7).angle() - 1.2) < 1e-12);
  assert.ok(Math.abs(Vector2.fromAngle(1.2, 7).length() - 7) < 1e-12);
});
