import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/sim/world.js';
import { Asteroid, Bullet } from '../src/sim/entities.js';
import { Ship } from '../src/sim/ship.js';
import { findCollisions } from '../src/sim/collision.js';
import { homing } from '../src/sim/behaviors.js';
import { ARENA } from '../src/sim/arena.js';
import { Vector2 } from '../src/sim/vector.js';

const STEP = 1 / 60;
const rock = (x, y, extra = {}) =>
  new Asteroid({ pos: new Vector2(x, y), vel: Vector2.ZERO, ...extra });

test('World is iterable and ofKind is a lazy generator', () => {
  const world = new World();
  const a = world.spawn(rock(100, 100));
  const ship = world.spawn(new Ship());
  const b = world.spawn(rock(300, 300));

  assert.deepEqual([...world], [a, ship, b], 'spawn order');
  assert.deepEqual([...world.ofKind('asteroid')], [a, b]);

  const gen = world.ofKind('ship');
  assert.equal(typeof gen.next, 'function', 'a generator, not an array');
  assert.equal(gen.next().value, ship);
});

test('despawn is deferred: the entity stays stored until the end-of-step sweep', () => {
  const world = new World();
  const a = world.spawn(rock(100, 100));
  world.despawn(a.id);

  assert.equal(a.alive, false);
  assert.equal(world.size, 1, 'still stored');
  assert.equal(world.get(a.id), undefined, 'but invisible to lookups');
  assert.deepEqual([...world], [], 'and to iteration');

  world.step(STEP);
  assert.equal(world.size, 0, 'swept');
});

test('despawning while iterating the world is safe', () => {
  const world = new World();
  for (let i = 0; i < 10; i++) world.spawn(rock(50 + i * 100, 100));

  const seen = [];
  for (const entity of world) {
    seen.push(entity.id);
    world.despawn(entity.id);
  }
  assert.equal(seen.length, 10);
  world.step(STEP);
  assert.equal(world.size, 0);
});

test('entities spawned during a step start updating on the next step', () => {
  const world = new World();
  const ship = world.spawn(new Ship({ angle: 0 }));
  const input = { isDown: (c) => c === 'Space' };

  world.step(STEP, new Map([[ship.id, input]]));
  const bullet = [...world.ofKind('bullet')][0];
  assert.ok(bullet);
  assert.equal(bullet.ttl, 1.1, 'not updated in the step that spawned it');

  world.step(STEP, new Map([[ship.id, input]]));
  assert.ok(bullet.ttl < 1.1);
});

test('wrap edge: ships and bullets reappear on the opposite side', () => {
  const world = new World();
  const ship = world.spawn(
    new Ship({ pos: new Vector2(ARENA.width - 1, 100), angle: 0 }),
  );
  ship.vel = new Vector2(300, 0);
  world.step(STEP);
  assert.ok(ship.pos.x < 20, `wrapped to the left side, got ${ship.pos.x}`);
});

test('bounce edge: asteroids reflect off the walls and stay inside', () => {
  const world = new World();
  const r = world.spawn(rock(20, 300, { size: 2 }));
  r.vel = new Vector2(-200, 0);
  for (let i = 0; i < 30; i++) world.step(STEP);
  assert.ok(r.vel.x > 0, 'velocity flipped');
  assert.ok(r.pos.x >= r.radius && r.pos.x <= ARENA.width - r.radius);
});

test('collision system is swappable and only reports pairs', () => {
  const world = new World();
  const a = world.spawn(rock(100, 100));
  const b = world.spawn(rock(110, 100));
  world.spawn(rock(900, 600));

  const pairs = findCollisions(world);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], [a, b]);

  const seen = [];
  const custom = new World({
    collide: (w) => {
      seen.push(w.size);
      return [];
    },
  });
  custom.spawn(rock(1, 1));
  custom.step(STEP);
  assert.deepEqual(seen, [1]);
});

test('a bullet damages an asteroid; hp 0 destroys it and the event names the killer', () => {
  const world = new World();
  const target = world.spawn(rock(400, 300, { size: 1 }));
  const bullet = world.spawn(
    new Bullet({ pos: new Vector2(400, 300), vel: Vector2.ZERO, angle: 0, ownerId: -1 }),
  );

  world.step(STEP);

  assert.equal(target.alive, false);
  assert.equal(bullet.alive, false);
  const events = world.drainEvents();
  assert.deepEqual(
    events.map((e) => e.type),
    ['hit', 'destroyed'],
    'the hit lands first, then the asteroid is destroyed',
  );
  assert.equal(events[0].target, target);
  assert.equal(events[1].entity, target);
  assert.equal(events[1].by, bullet);
  assert.deepEqual(world.drainEvents(), [], 'queue is cleared');
});

test('a big asteroid survives one bullet', () => {
  const world = new World();
  const target = world.spawn(rock(400, 300, { size: 3 }));
  world.spawn(
    new Bullet({ pos: new Vector2(400, 300), vel: Vector2.ZERO, angle: 0, ownerId: -1 }),
  );
  world.step(STEP);
  assert.equal(target.alive, true);
  assert.equal(target.hp, 2);
});

test('an asteroid hurts the ship once, then the ship is briefly invulnerable', () => {
  const world = new World();
  const ship = world.spawn(new Ship({ pos: new Vector2(400, 300) }));
  world.spawn(rock(405, 300, { size: 2 }));

  world.step(STEP);
  assert.equal(ship.hp, Ship.MAX_HP - 1);
  world.step(STEP);
  assert.equal(ship.hp, Ship.MAX_HP - 1);
});

test('homing steers one behavior object onto BOTH a bullet and an asteroid', () => {
  const world = new World();
  world.spawn(rock(500, 100, { size: 3 })); // the bullet's target, up and to the right
  const bullet = world.spawn(
    new Bullet({
      pos: new Vector2(100, 300),
      vel: new Vector2(400, 0),
      angle: 0,
      ownerId: -1,
    }),
  );
  bullet.addBehavior(homing({ targetKind: 'asteroid', turnRate: 3 }));
  const before = bullet.vel.angle();
  for (let i = 0; i < 20; i++) world.step(STEP);
  assert.ok(bullet.vel.angle() < before, 'turned toward the target (up = negative y)');
  assert.ok(Math.abs(bullet.vel.length() - 400) < 1e-6, 'speed preserved');

  const ship = world.spawn(new Ship({ pos: new Vector2(900, 600) }));
  const hunter = world.spawn(rock(700, 600, { size: 1, hunter: true }));
  hunter.vel = new Vector2(0, -60);
  for (let i = 0; i < 60; i++) world.step(STEP);
  assert.ok(hunter.vel.x > 0, 'hunter asteroid curved toward the ship');
  assert.ok(ship.alive);
});
