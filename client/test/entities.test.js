import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Entity } from '../src/sim/entity.js';
import { Asteroid, Bullet, Explosion, Pickup } from '../src/sim/entities.js';
import { Ship } from '../src/sim/ship.js';
import { World } from '../src/sim/world.js';
import { Vector2 } from '../src/sim/vector.js';
import { createRng } from '../src/sim/rng.js';

const STEP = 1 / 60;

test('inheritance is exactly one level deep for every entity class', () => {
  for (const Class of [Ship, Bullet, Asteroid, Pickup, Explosion]) {
    assert.equal(Object.getPrototypeOf(Class.prototype), Entity.prototype, Class.name);
  }
  assert.equal(Object.getPrototypeOf(Entity.prototype), Object.prototype);
});

test('entity ids come from a private static counter: unique, increasing, not reachable', () => {
  const a = new Asteroid({ pos: Vector2.ZERO, vel: Vector2.ZERO });
  const b = new Asteroid({ pos: Vector2.ZERO, vel: Vector2.ZERO });
  assert.ok(b.id > a.id);
  assert.equal(Entity.nextId, undefined);
  assert.equal(Entity['#nextId'], undefined);
});

test('Ship hp is private: readable through the getter, not writable', () => {
  const ship = new Ship();
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.throws(() => {
    ship.hp = 99;
  }, TypeError);
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.equal(Object.keys(ship).includes('hp'), false);
  assert.equal(ship['#hp'], undefined);
});

test('takeDamage lowers hp, grants temporary invulnerability, and kills at 0', () => {
  const world = new World();
  const ship = world.spawn(new Ship());

  assert.equal(ship.takeDamage(1), true);
  assert.equal(ship.hp, 2);
  assert.equal(ship.takeDamage(1), false, 'invulnerable right after a hit');
  assert.equal(ship.hp, 2);

  const dying = world.spawn(new Ship());
  dying.takeDamage(1);
  // wait out the invulnerability, then finish it off
  for (let i = 0; i < 100; i++) dying.update(STEP);
  dying.takeDamage(1);
  for (let i = 0; i < 100; i++) dying.update(STEP);
  dying.takeDamage(1);
  assert.equal(dying.hp, 0);
  assert.equal(dying.alive, false);
});

test('a shield absorbs hits without losing hp', () => {
  const ship = new Ship();
  ship.addEffect('shield', 5);
  assert.equal(ship.takeDamage(1), false);
  assert.equal(ship.hp, Ship.MAX_HP);
});

test('fire(): bullet appears at the nose and inherits the ship velocity', () => {
  const world = new World();
  const ship = world.spawn(new Ship({ pos: new Vector2(100, 100), angle: 0 }));
  ship.vel = new Vector2(50, 20);

  const bullet = ship.fire();

  assert.equal(bullet.kind, 'bullet');
  assert.equal(world.get(bullet.id), bullet);
  assert.equal(bullet.pos.x, 100 + ship.radius + 4);
  assert.equal(bullet.pos.y, 100);
  assert.equal(bullet.vel.x, 50 + 620);
  assert.equal(bullet.vel.y, 20);
  assert.equal(bullet.ownerId, ship.id);
});

test('fire() respects the cooldown; rapid fire shortens it', () => {
  const world = new World();
  const ship = world.spawn(new Ship());
  assert.ok(ship.fire());
  assert.equal(ship.fire(), null, 'still cooling down');

  const countShots = (rapid) => {
    const w = new World();
    const s = w.spawn(new Ship());
    if (rapid) s.addEffect('rapid', 10);
    let shots = 0;
    for (let i = 0; i < 120; i++) {
      s.update(STEP, { isDown: (c) => c === 'Space' });
      shots = [...w.ofKind('bullet')].length + shots * 0;
    }
    return shots;
  };
  assert.ok(countShots(true) > countShots(false));
});

test('THE this BUG: a detached fire() breaks (loudly or silently), and the fixes work', () => {
  const world = new World();
  const ship = world.spawn(new Ship());
  const bulletCount = () => [...world.ofKind('bullet')].length;

  // Loud variant: called as a bare function, `this` is undefined (modules are strict).
  const detached = ship.fire;
  assert.throws(() => detached(), TypeError);

  // Silent variant: what a DOM listener / setTimeout does, `this` is some OTHER object
  // (window, the element, a Timeout). `this.alive` is undefined, the guard returns early,
  // no error, no bullet. The player just sees "the fire key does nothing".
  assert.equal(detached.call({}), null);
  assert.equal(bulletCount(), 0);

  const wrapped = () => ship.fire(); // fix 1: arrow wrapper
  assert.ok(wrapped());
  assert.equal(bulletCount(), 1);

  for (let i = 0; i < 20; i++) ship.update(STEP); // let the cooldown expire
  const bound = ship.fire.bind(ship); // fix 2: bind
  assert.ok(bound());
  assert.equal(bulletCount(), 2);
});

test('Bullet expires after its TTL and does not hit its owner', () => {
  const world = new World();
  const ship = world.spawn(new Ship());
  const bullet = ship.fire();
  for (let i = 0; i < 200; i++) world.step(STEP);
  assert.equal(world.get(bullet.id), undefined);
  assert.equal(ship.hp, Ship.MAX_HP);
});

test('Pickup grants its effect to a ship and disappears', () => {
  const world = new World();
  const ship = world.spawn(new Ship({ pos: new Vector2(300, 300) }));
  const pickup = world.spawn(new Pickup({ pos: new Vector2(300, 300), type: 'shield' }));

  world.step(STEP);

  assert.equal(ship.hasEffect('shield'), true);
  assert.equal(world.get(pickup.id), undefined);
});

test('Explosion is deterministic for a given seed and dies when its particles do', () => {
  const make = () =>
    new Explosion({ pos: new Vector2(10, 10), rng: createRng(5), count: 6, life: 0.5 });
  const a = make();
  const b = make();
  assert.deepEqual(a.particles, b.particles);

  for (let i = 0; i < 60; i++) a.update(STEP);
  assert.equal(a.alive, false);
});

test('behaviors compose onto ANY entity, including a Ship that has its own update()', () => {
  const world = new World();
  const ship = world.spawn(new Ship());
  const seen = [];
  ship.addBehavior({
    name: 'probe',
    update: (entity, dt) => seen.push([entity.kind, dt]),
  });

  world.step(STEP);

  assert.deepEqual(seen, [['ship', STEP]]);
  assert.equal(ship.hasBehavior('probe'), true);
});
