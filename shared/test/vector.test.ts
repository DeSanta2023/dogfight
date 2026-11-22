import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { Vector2 } from '../src/vector.ts';

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
    // @ts-expect-error x is readonly: the compiler already refuses what the runtime throws on
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

test('Vector2: normalize of the zero vector is zero, not NaN', () => {
  const n = new Vector2(0, 0).normalize();
  expect([n.x, n.y]).toEqual([0, 0]);
});

test('Vector2: rotate by a quarter turn, and fromAngle agrees with it', () => {
  const r = new Vector2(1, 0).rotate(Math.PI / 2);
  expect(r.x).toBeCloseTo(0, 12);
  expect(r.y).toBeCloseTo(1, 12);
  const f = Vector2.fromAngle(Math.PI / 2, 3);
  expect([f.x, f.y]).toEqual([Math.cos(Math.PI / 2) * 3, Math.sin(Math.PI / 2) * 3]);
});

test('Vector2: add and sub are inverses, lengthSq equals length squared', () => {
  const a = new Vector2(3, -7);
  const b = new Vector2(-2, 5);
  const back = a.add(b).sub(b);
  expect([back.x, back.y]).toEqual([3, -7]);
  expect(a.lengthSq()).toBeCloseTo(a.length() ** 2, 9);
});
