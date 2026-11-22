import { expect, test } from 'vitest';
import { Bullet, Explosion, bulletPool, particlePool } from '../src/entities.ts';
import { Game } from '../src/game.ts';
import { DT, BIT, inputFromBits } from '../src/input.ts';
import { Pool } from '../src/pool.ts';
import { createRng } from '../src/rng.ts';
import { Vector2 } from '../src/vector.ts';
import { World } from '../src/world.ts';

test('Pool: acquire makes an object only when the pool is empty, release makes it reusable', () => {
  const pool = new Pool(() => ({ n: 0 }));
  const a = pool.acquire();
  pool.release(a);
  expect(pool.acquire()).toBe(a); // the same object comes back
  expect([pool.created, pool.reused]).toEqual([1, 1]);
});

test('Pool: the cap keeps the pool from hoarding; prewarm fills it up front', () => {
  const pool = new Pool(() => ({}), 3);
  const items = Array.from({ length: 10 }, () => pool.acquire());
  items.forEach((i) => pool.release(i));
  expect(pool.available).toBe(3);
  const warm = new Pool(() => ({}), 100);
  warm.prewarm(20);
  expect(warm.available).toBe(20);
  warm.clear();
  expect(warm.available).toBe(0);
});

test('Bullet.acquire gives a bullet in exactly the state `new Bullet` would, even after a hard life', () => {
  const fresh = new Bullet({
    pos: new Vector2(5, 6),
    vel: new Vector2(1, 2),
    angle: 0.5,
  });
  // a used one: every field dirty
  const used = Bullet.acquire({
    pos: new Vector2(9, 9),
    vel: new Vector2(9, 9),
    angle: 3,
    ownerId: 7 as never,
  });
  used.ttl = 0.01;
  used.damage = 99;
  used.ownerSlot = 4;
  used.fireSeq = 123;
  used.alive = false;
  used.addBehavior({ name: 'homing', update() {} });
  used.recycle();
  const again = Bullet.acquire({
    pos: new Vector2(5, 6),
    vel: new Vector2(1, 2),
    angle: 0.5,
  });
  expect(again).toBe(used); // it IS the recycled object...
  for (const key of [
    'ttl',
    'damage',
    'ownerSlot',
    'fireSeq',
    'alive',
    'radius',
    'angle',
    'prevAngle',
    'edge',
    'solid',
  ] as const)
    expect(again[key]).toEqual(fresh[key]); // ...and it carries nothing over
  expect(again.behaviors).toEqual([]);
  expect(again.ownerId).toBeUndefined();
  expect([again.pos.x, again.pos.y, again.prevPos.x]).toEqual([5, 6, 5]);
});

test('World gives dead bullets back to the pool when it sweeps them', () => {
  bulletPool.clear();
  const world = new World();
  const bullet = world.spawn(
    Bullet.acquire({ pos: new Vector2(1, 1), vel: Vector2.ZERO, angle: 0 }),
  );
  bullet.alive = false;
  world.step(DT);
  expect(bulletPool.available).toBe(1);
  expect(world.size).toBe(0);
});

test('a long fight allocates a bounded number of bullets: the pool is doing its job', () => {
  bulletPool.clear();
  const game = new Game({ seed: 3, players: 1, asteroids: 0, pickups: false });
  for (let i = 0; i < 3000; i++) game.step(DT, inputFromBits(BIT.FIRE | BIT.THRUST));
  const shots = bulletPool.created + bulletPool.reused;
  expect(shots).toBeGreaterThan(300);
  expect(bulletPool.created).toBeLessThan(shots / 10); // 90 %+ of the bullets were recycled
});

test('Explosion particles come from the particle pool and go back when it ends', () => {
  particlePool.clear();
  const world = new World();
  const boom = world.spawn(
    new Explosion({ pos: new Vector2(1, 1), rng: createRng(1), count: 16 }),
  );
  expect(boom.particles).toHaveLength(16);
  for (let i = 0; i < 60 && boom.alive; i++) world.step(DT);
  expect(boom.alive).toBe(false);
  expect(particlePool.available).toBe(16);
  const second = new Explosion({ pos: new Vector2(2, 2), rng: createRng(1), count: 16 });
  expect(particlePool.reused).toBe(16);
  expect(second.particles[0]?.x).toBe(2); // fully re-initialised
});

test('pooling is invisible: a game with a clean pool and one with a dirty pool play the same match', () => {
  const play = () => {
    const game = new Game({ seed: 21, players: 2, asteroids: 8 });
    const inputs = new Map();
    for (let i = 0; i < 1200; i++) {
      inputs.set(
        0,
        inputFromBits(
          BIT.THRUST |
            (i % 50 < 25 ? BIT.LEFT : BIT.RIGHT) |
            (i % 3 === 0 ? BIT.FIRE : 0),
        ),
      );
      inputs.set(1, inputFromBits(BIT.FIRE | BIT.RIGHT));
      game.stepInputs(DT, inputs);
    }
    return JSON.stringify([...game.world].map((e) => [e.kind, e.id, e.pos.x, e.pos.y]));
  };
  bulletPool.clear();
  particlePool.clear();
  const clean = play();
  const dirty = play(); // now the pools are full of used objects
  expect(bulletPool.reused).toBeGreaterThan(0);
  expect(dirty).toBe(clean);
});
