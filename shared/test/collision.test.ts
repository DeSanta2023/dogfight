import { expect, test } from 'vitest';
import fc from 'fast-check';
import { createSpatialHash, findCollisions } from '../src/collision.ts';
import { Asteroid, Bullet } from '../src/entities.ts';
import type { Entity } from '../src/entity.ts';
import { Vector2 } from '../src/vector.ts';
import { World } from '../src/world.ts';
import { circle } from './arbitraries.ts';

const rock = (x: number, y: number, size: 1 | 2 | 3 = 2) =>
  new Asteroid({ pos: new Vector2(x, y), vel: Vector2.ZERO, size });
const names = (pairs: [Entity, Entity][]) => pairs.map(([a, b]) => [a.id, b.id]);

test('collisions: two circles that overlap are a pair, two that are apart are not', () => {
  expect(findCollisions([rock(0, 0), rock(30, 0)])).toHaveLength(1); // radii 26 + 26 > 30
  expect(findCollisions([rock(0, 0), rock(100, 0)])).toHaveLength(0);
});

test('collisions: touching exactly counts as a hit (<=), a hair further does not', () => {
  expect(findCollisions([rock(0, 0), rock(52, 0)])).toHaveLength(1);
  expect(findCollisions([rock(0, 0), rock(52.001, 0)])).toHaveLength(0);
});

test('collisions: entities that are not solid never collide', () => {
  const ghost = rock(1, 1);
  ghost.solid = false;
  expect(findCollisions([rock(0, 0), ghost])).toHaveLength(0);
});

test('collisions: n entities in one spot give n(n-1)/2 pairs, each exactly once', () => {
  const pile = Array.from({ length: 6 }, () => rock(10, 10));
  expect(findCollisions(pile)).toHaveLength(15);
});

test('collisions: the system only reports, it does not touch the entities', () => {
  const a = rock(0, 0);
  const b = rock(10, 0);
  findCollisions([a, b]);
  expect([a.alive, b.alive, a.pos.x, b.pos.x]).toEqual([true, true, 0, 10]);
});

test('collisions in a World: a bullet destroys the asteroid it hits through onCollide', () => {
  const world = new World();
  const target = world.spawn(rock(100, 100, 1));
  world.spawn(
    Bullet.acquire({ pos: new Vector2(100, 100), vel: Vector2.ZERO, angle: 0 }),
  );
  world.step(1 / 30);
  expect(target.hp).toBe(0);
  expect(target.alive).toBe(false);
});

// ---- the spatial hash must be the naive system, only faster ---------------------------------
test('spatial hash: finds a pair whose circles straddle a cell border', () => {
  const hash = createSpatialHash({ cellSize: 96 });
  expect(hash([rock(95, 50), rock(100, 50)])).toHaveLength(1); // 95 | 96 is a cell border
});

test('spatial hash: a big circle that covers several cells is still found once', () => {
  const hash = createSpatialHash({ cellSize: 32 });
  const pairs = hash([rock(200, 200, 3), rock(210, 205, 3)]); // radius 40 > cell: 3x3 cells each
  expect(pairs).toHaveLength(1);
});

test('spatial hash: entities exactly on, or slightly outside, the arena edge do not break it', () => {
  const hash = createSpatialHash();
  const pairs = hash([rock(0, 0), rock(-5, -5), rock(1280, 720), rock(1285, 725)]);
  expect(pairs).toHaveLength(2);
});

test('spatial hash: empty and one-entity worlds', () => {
  const hash = createSpatialHash();
  expect(hash([])).toEqual([]);
  expect(hash([rock(1, 1)])).toEqual([]);
});

test('property: the spatial hash returns EXACTLY the pairs of the naive check, in the same order', () => {
  const hash = createSpatialHash();
  fc.assert(
    fc.property(fc.array(circle, { maxLength: 150 }), (circles) => {
      const entities = circles.map((c, i) => {
        const e = new Asteroid({
          pos: new Vector2(c.pos.x, c.pos.y),
          vel: Vector2.ZERO,
          size: 1,
        });
        e.radius = c.radius;
        e.id = i as never;
        return e;
      });
      expect(names(hash(entities))).toEqual(names(findCollisions(entities)));
    }),
    { numRuns: 300 },
  );
});

test('property: calling the same hash twice (its buffers are reused) gives the same answer', () => {
  const hash = createSpatialHash();
  fc.assert(
    fc.property(
      fc.array(circle, { maxLength: 80 }),
      fc.array(circle, { maxLength: 200 }),
      (small, big) => {
        const make = (list: typeof small) =>
          list.map((c, i) => {
            const e = rock(c.pos.x, c.pos.y, 1);
            e.radius = c.radius;
            e.id = i as never;
            return e;
          });
        const first = names(hash(make(big)));
        hash(make(small)); // a different, smaller world in between
        expect(names(hash(make(big)))).toEqual(first);
      },
    ),
    { numRuns: 100 },
  );
});
