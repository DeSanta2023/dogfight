import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ship } from '@dogfight/shared/ship.ts';
import { Vector2 } from '@dogfight/shared/vector.ts';
import { ARENA } from '@dogfight/shared/arena.ts';
import { interpolateEntity } from '../src/render/interpolate.ts';

test('interpolateEntity: wrap-aware position and shortest-path angle', () => {
  const e = new Ship({ pos: new Vector2(ARENA.width - 2, 100), angle: 6.2 });
  e.snapshot();
  e.pos = new Vector2(2, 100); // crossed the right edge
  e.angle = 0.1; // crossed 2*PI

  const mid = interpolateEntity(e, 0.5);
  assert.ok(
    mid.x > ARENA.width - 3 || mid.x < 3,
    `no sweep across the arena, x=${mid.x}`,
  );
  const angleFromPrev = Math.abs(mid.angle - 6.2);
  assert.ok(angleFromPrev < 0.5, `short way round, got ${mid.angle}`);
});
