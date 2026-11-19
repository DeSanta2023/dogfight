import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, RESPAWN_DELAY } from '../src/game.ts';
import { Ship, createShip, integrate } from '../src/ship.ts';
import { Asteroid } from '../src/entities.ts';
import { Vector2 } from '../src/vector.ts';
import { hold, must } from './helpers.ts';

const STEP = 1 / 60;

function stateOf(game: Game) {
  return [...game.world].map((e) => [e.kind, e.pos.x, e.pos.y, e.vel.x, e.vel.y]);
}

test('REGRESSION (Lab 1): alone in the arena the Ship still reproduces the Lab 1 trajectory', () => {
  const game = new Game({ asteroids: 0, pickups: false });
  let plain = createShip();
  for (let i = 0; i < 301; i++) {
    game.step(STEP, hold('ArrowUp'));
    plain = integrate(plain, hold('ArrowUp'), STEP);
  }
  const ship = must(game.ship);
  assert.equal(ship.pos.x, plain.x);
  assert.equal(ship.pos.y, plain.y);
  assert.equal(ship.pos.y.toFixed(3), '114.293'); // the number in the Lab 1 README
});

test('the match is deterministic: same seed + same inputs => identical world', () => {
  const run = (seed: number) => {
    const game = new Game({ seed });
    for (let i = 0; i < 1200; i++) {
      const keys = [];
      if (i % 90 < 45) keys.push('ArrowLeft');
      if (i % 50 < 30) keys.push('ArrowUp');
      if (i % 7 < 4) keys.push('Space');
      game.step(STEP, hold(...keys));
    }
    return { state: stateOf(game), score: game.score, deaths: game.deaths };
  };
  assert.deepEqual(run(42), run(42));
  assert.notDeepEqual(run(42).state, run(43).state);
});

test('a destroyed ship respawns after RESPAWN_DELAY, protected, and deaths are counted', () => {
  const game = new Game({ asteroids: 0, pickups: false });
  const first = must(game.ship);
  first.takeDamage(Ship.MAX_HP); // instant kill
  game.step(STEP, hold());

  const wreck = game.ship; // read into a variable: TypeScript narrows `game.ship` to null below
  assert.equal(wreck, null);
  assert.equal(game.deaths, 1);
  assert.ok(game.hud.respawnIn > 0);
  assert.equal([...game.world.ofKind('explosion')].length, 1, 'explosion spawned');

  const steps = Math.ceil(RESPAWN_DELAY / STEP) + 2;
  for (let i = 0; i < steps; i++) game.step(STEP, hold());

  assert.ok(game.ship, 'respawned');
  assert.notEqual(game.ship, first);
  const born = must(game.ship);
  assert.equal(born.hp, Ship.MAX_HP);
  assert.equal(born.invulnerable, true);
});

test('shooting an asteroid scores its points and spawns an explosion', () => {
  const game = new Game({ asteroids: 0, pickups: false });
  const target = game.world.spawn(
    new Asteroid({ pos: new Vector2(640, 200), vel: Vector2.ZERO, size: 1 }),
  );
  // The ship starts at the arena centre pointing up: the rock is straight ahead.
  for (let i = 0; i < 90 && target.alive; i++) game.step(STEP, hold('Space'));

  assert.equal(target.alive, false);
  assert.equal(game.score, 50);
  assert.ok([...game.world.ofKind('explosion')].length >= 1);
});

test('destroyed asteroids are refilled after a delay', () => {
  const game = new Game({ seed: 3, asteroids: 3, pickups: false });
  for (const a of [...game.world.ofKind('asteroid')]) a.kill();
  game.step(STEP, hold());
  assert.equal([...game.world.ofKind('asteroid')].length, 0);

  for (let i = 0; i < 3 * 60 + 5; i++) game.step(STEP, hold());
  assert.equal([...game.world.ofKind('asteroid')].length, 1);
});

test('pickups spawn over time and respect the cap', () => {
  const game = new Game({ seed: 9, asteroids: 0, pickups: true });
  for (let i = 0; i < 60 * 60; i++) {
    game.step(STEP, hold());
    assert.ok([...game.world.ofKind('pickup')].length <= 2);
  }
});

test('the ship may never leave 0..maxHp, whatever happens', () => {
  const game = new Game({ seed: 5 });
  for (let i = 0; i < 60 * 40; i++) {
    game.step(STEP, hold('ArrowUp', 'Space', i % 120 < 60 ? 'ArrowLeft' : 'ArrowRight'));
    const hp = game.hud.hp;
    assert.ok(hp >= 0 && hp <= Ship.MAX_HP);
  }
});
