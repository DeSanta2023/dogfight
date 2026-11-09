import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Game } from '../src/sim/game.js';
import { Asteroid, Pickup } from '../src/sim/entities.js';
import { Vector2 } from '../src/sim/vector.js';

const STEP = 1 / 60;
const FIRE = { isDown: (code) => code === 'Space' };
const IDLE = { isDown: () => false };

/** Collect every event the game publishes, as [type, detail]. */
function record(game) {
  const log = [];
  for (const type of ['fired', 'hit', 'exploded', 'collected']) {
    game.events.addEventListener(type, (event) => log.push([type, event.detail]));
  }
  return log;
}

// A calm arena with ONE asteroid right in front of the ship, so the outcome is predictable.
function duel({ size = 1 } = {}) {
  const game = new Game({ seed: 3, asteroids: 0, pickups: false });
  const ship = game.ship; // starts in the middle, pointing up
  const rock = game.world.spawn(
    new Asteroid({
      pos: new Vector2(ship.pos.x, ship.pos.y - 120),
      vel: Vector2.ZERO,
      size,
    }),
  );
  return { game, ship, rock };
}

test('the simulation imports NO audio, HUD or rendering module', () => {
  const dir = new URL('../src/sim/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const imports = [...source.matchAll(/^\s*import[^;]*from\s+['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    );
    for (const spec of imports) {
      assert.match(
        spec,
        /^\.\/[\w-]+\.js$/,
        `${file} imports "${spec}": sim must stay self-contained`,
      );
      assert.doesNotMatch(spec, /audio|hud|render|canvas/i, `${file} imports ${spec}`);
    }
  }
});

test('firing publishes "fired" with plain-data detail', () => {
  const { game } = duel();
  const log = record(game);

  game.step(STEP, FIRE);

  const fired = log.filter(([type]) => type === 'fired');
  assert.equal(fired.length, 1);
  const detail = fired[0][1];
  assert.equal(detail.by, 'ship');
  assert.equal(typeof detail.x, 'number');
  assert.equal(typeof detail.y, 'number');
  assert.ok(
    Object.values(detail).every((v) => typeof v !== 'object'),
    'no entity leaks out',
  );
});

test('a bullet hitting an asteroid publishes "hit" then "exploded" with the points', () => {
  const { game } = duel({ size: 1 });
  const log = record(game);

  for (let i = 0; i < 90 && !log.some(([type]) => type === 'exploded'); i++)
    game.step(STEP, FIRE);

  const types = log.map(([type]) => type);
  assert.ok(
    types.indexOf('hit') !== -1 && types.indexOf('hit') < types.indexOf('exploded'),
  );
  const exploded = log.find(([type]) => type === 'exploded')[1];
  assert.equal(exploded.kind, 'asteroid');
  assert.equal(exploded.points, 50);
  assert.equal(game.score, 50);
});

test('an asteroid that is NOT shot down scores nothing in the event either', () => {
  const { game, rock } = duel({ size: 2 });
  const log = record(game);
  rock.pos = game.ship.pos; // ram the ship; there is no bullet involved
  for (let i = 0; i < 5; i++) game.step(STEP, IDLE);
  assert.ok(
    log.some(([type, d]) => type === 'hit' && d.target === 'ship' && d.by === 'asteroid'),
  );
  assert.equal(game.score, 0);
});

test('destroying the ship publishes "exploded" with kind "ship"', () => {
  const { game, ship } = duel();
  const log = record(game);
  ship.takeDamage(99, null);
  game.step(STEP, IDLE);
  const exploded = log.find(([type]) => type === 'exploded');
  assert.equal(exploded[1].kind, 'ship');
});

test('collecting a pickup publishes "collected" with its type', () => {
  const { game, ship } = duel();
  const log = record(game);
  game.world.spawn(new Pickup({ pos: ship.pos, type: 'homing' }));
  game.step(STEP, IDLE);
  const collected = log.find(([type]) => type === 'collected');
  assert.equal(collected[1].type, 'homing');
});

test('listening changes nothing: the match is identical with and without subscribers', () => {
  const play = (listen) => {
    const game = new Game({ seed: 11 });
    if (listen) record(game);
    for (let i = 0; i < 1500; i++) game.step(STEP, i % 40 < 20 ? FIRE : IDLE);
    return JSON.stringify([
      game.score,
      game.deaths,
      [...game.world].map((e) => e.pos.x.toFixed(6)),
    ]);
  };
  assert.equal(play(true), play(false));
});
