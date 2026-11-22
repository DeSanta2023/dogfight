import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Match } from '../match.ts';
import { BIT, DT, inputFromBits } from '@dogfight/shared/input.ts';
import { createShip, integrate } from '@dogfight/shared/ship.ts';
import type { Snapshot } from '@dogfight/shared/snapshot.ts';

const arena = { asteroids: 0, pickups: false, seed: 7 };
function setup() {
  const snaps: [number, Snapshot][] = [];
  const match = new Match({
    arena,
    onSnapshot: (slot, snapshot) => snaps.push([slot, snapshot]),
    setTimer: () => 0, // we drive tick() by hand
    clearTimer: () => {},
  });
  match.join(0);
  match.join(1);
  const last = (slot: number): Snapshot => {
    const found = snaps.findLast(([s]) => s === slot);
    if (!found) throw new Error(`no snapshot for slot ${slot}`);
    return found[1];
  };
  return { match, snaps, last };
}

test('the server applies inputs, not coordinates: its ship equals integrate() of the same inputs', () => {
  const { match, last } = setup();
  const start = match.game.player(0)?.ship;
  assert.ok(start, 'player 0 has a ship');
  let expected = { ...createShip(), x: start.pos.x, y: start.pos.y, angle: start.angle };
  for (let seq = 1; seq <= 30; seq++) {
    const bits = BIT.THRUST | (seq < 15 ? BIT.LEFT : 0);
    match.input(0, seq, [bits]);
    match.tick();
    expected = integrate(expected, inputFromBits(bits), DT);
  }
  const own = last(0).own;
  assert.ok(own.alive, 'the ship is alive');
  assert.equal(last(0).ackSeq, 30);
  assert.equal(own.x, expected.x);
  assert.equal(own.y, expected.y);
  assert.equal(own.angle, expected.angle);
});

test('redundant packets: duplicates are ignored, a lost packet is repaired by the next one', () => {
  const { match, last } = setup();
  match.input(0, 1, [1]);
  match.input(1, 1, [1]);
  match.tick();
  // packet with seq 2 is LOST; seq 3 carries 2 and 3 again
  match.input(0, 2, [1, 1]);
  match.input(0, 2, [1, 1]); // exact duplicate
  match.input(1, 2, [1, 1]);
  match.tick();
  match.tick();
  assert.equal(last(0).ackSeq, 3);
  assert.equal(match.stats().starved, 0);
});

test('an empty queue repeats the last input (and counts it); a flooding client is capped', () => {
  const { match, last } = setup();
  match.input(0, 1, [BIT.THRUST]);
  match.tick();
  match.tick(); // nothing new: starved
  assert.equal(last(0).ackSeq, 1);
  assert.ok(match.stats().starved >= 2); // slot 1 starved on both ticks too

  const burst = Array.from({ length: 30 }, () => BIT.THRUST);
  match.input(0, 2, burst.slice(0, 8));
  match.input(0, 10, burst.slice(0, 8));
  match.input(0, 18, burst.slice(0, 8));
  assert.ok(match.stats().queued <= 6, 'queue is bounded');
  assert.ok(match.stats().dropped > 0);
});

test('every player gets their OWN snapshot; the other ship is in ships[]', () => {
  const { match, last } = setup();
  match.tick();
  assert.equal(last(0).ships.length, 1);
  assert.equal(last(0).ships[0]?.slot, 1);
  assert.equal(last(1).ships[0]?.slot, 0);
  const [mine, theirs] = [last(0).own, last(1).own];
  assert.ok(mine.alive && theirs.alive, 'both ships are alive');
  assert.notEqual(mine.x, theirs.x);
});

test('leaving removes the ship and the last player stops the loop', () => {
  const { match } = setup();
  match.leave(0);
  assert.equal(match.game.player(0), null);
  match.leave(1);
  assert.equal(match.running, false);
});
