import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { createShip, integrate } from '../src/ship.js';
import { BIT, DT, bitsFromInput, inputFromBits } from '../src/input.js';
import { captureSnapshot } from '../src/snapshot.js';
import {
  DecodeError,
  decodeClient,
  decodeServer,
  encodeInput,
  encodePing,
  encodePong,
  encodeSnapshot,
  encodeSnapshotJson,
  angleToInt16,
  int16ToAngle,
} from '../src/codec.js';
import { Vector2 } from '../src/vector.js';

// A scripted pilot: the same list of inputs for every run.
const script = Array.from({ length: 200 }, (_, i) =>
  i % 40 < 25
    ? BIT.THRUST | (i % 80 < 40 ? BIT.LEFT : BIT.RIGHT)
    : i % 7 === 0
      ? BIT.FIRE
      : 0,
);

test('input bits round-trip through the input objects', () => {
  for (let bits = 0; bits < 16; bits++)
    assert.equal(bitsFromInput(inputFromBits(bits)), bits);
});

test('the same inputs give the same ship in a Game and in the bare integrate() the browser uses', () => {
  const game = new Game({ seed: 5, asteroids: 0, pickups: false });
  let predicted = createShip();
  for (const bits of script) {
    game.stepInputs(DT, new Map([[0, inputFromBits(bits)]]));
    predicted = integrate(predicted, inputFromBits(bits), DT);
  }
  const ship = game.ship;
  assert.equal(ship.pos.x, predicted.x); // exactly equal: not "close", EQUAL
  assert.equal(ship.pos.y, predicted.y);
  assert.equal(ship.vel.x, predicted.vx);
  assert.equal(ship.vel.y, predicted.vy);
  assert.equal(ship.angle, predicted.angle);
});

test('two games with the same seed and inputs stay identical, including ids', () => {
  const run = () => {
    const game = new Game({ seed: 9, players: 2, asteroids: 6 });
    for (const bits of script)
      game.stepInputs(
        DT,
        new Map([
          [0, inputFromBits(bits)],
          [1, inputFromBits(bits ^ BIT.LEFT)],
        ]),
      );
    return [...game.world].map((e) => [e.id, e.kind, e.pos.x, e.pos.y]);
  };
  assert.deepEqual(run(), run());
});

test('the shared simulation never calls Math.random() or Date.now()', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(new URL(file, dir), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    assert.doesNotMatch(code, /Math\.random|Date\.now|performance\.now|node:/, file);
  }
});

test('PvP: a bullet hurts the OTHER player, never its owner, and a kill scores', () => {
  const game = new Game({ seed: 1, players: 2, asteroids: 0, pickups: false });
  const a = game.player(0).ship;
  const b = game.player(1).ship;
  a.pos = new Vector2(300, 300);
  a.angle = 0;
  b.pos = new Vector2(420, 300);
  const idle = inputFromBits(0);
  const fire = inputFromBits(BIT.FIRE);
  for (let i = 0; i < 90 && b.alive; i++)
    game.stepInputs(DT, new Map([[0, i % 7 === 0 ? fire : idle]]));
  assert.ok(game.player(1).ship === null || game.player(1).ship.hp < 3, 'b was hit');
  assert.equal(a.hp, 3, 'the shooter is untouched');
});

test('snapshot round trip: own ship exact, others quantised below 0.05 units', () => {
  const game = new Game({ seed: 3, players: 2, asteroids: 4 });
  for (let i = 0; i < 40; i++)
    game.stepInputs(DT, new Map([[0, inputFromBits(BIT.THRUST | BIT.FIRE)]]));
  const snap = captureSnapshot(game, { tick: 40, slot: 0, ackSeq: 39, events: [] });
  const back = decodeServer(encodeSnapshot(snap));
  assert.equal(back.tick, 40);
  assert.equal(back.ackSeq, 39);
  for (const k of ['x', 'y', 'vx', 'vy', 'angle']) assert.equal(back.own[k], snap.own[k]);
  assert.equal(back.ships.length, 1);
  assert.ok(Math.abs(back.ships[0].x - snap.ships[0].x) < 0.05);
  assert.equal(back.asteroids.length, snap.asteroids.length);
  assert.equal(back.bullets.length, snap.bullets.length);
  assert.ok(encodeSnapshot(snap).byteLength < encodeSnapshotJson(snap).length / 2);
});

test('angles: Int16 keeps the error under 0.0001 rad and wraps', () => {
  for (const a of [0, 1, -1, 3.1, -3.1, 6.2, 12.5]) {
    const back = int16ToAngle(angleToInt16(a));
    const diff = Math.abs(Math.atan2(Math.sin(back - a), Math.cos(back - a)));
    assert.ok(diff < 1e-4, `${a}: ${diff}`);
  }
});

test('client packets: input with redundancy, ping; garbage is rejected, not trusted', () => {
  const packet = decodeClient(encodeInput(1000, [1, 5, 13]));
  assert.deepEqual(packet, { type: 'input', seq: 1000, bits: [1, 5, 13] });
  assert.equal(decodeClient(encodePing(123.5)).t, 123.5);
  assert.equal(decodeServer(encodePong(7.25, 99)).tick, 99);
  assert.throws(() => decodeClient(new Uint8Array([2, 1]).buffer), DecodeError); // wrong version
  assert.throws(() => decodeClient(new Uint8Array([1, 9, 0]).buffer), DecodeError); // unknown type
  assert.throws(
    () => decodeClient(new Uint8Array([1, 1, 0, 0, 0, 0, 5, 1]).buffer),
    DecodeError,
  ); // count lies
  assert.throws(() => decodeServer(new Uint8Array([1, 1, 0]).buffer), DecodeError); // truncated
});

test('byte order is little-endian and fixed: the first bytes of an input packet', () => {
  const bytes = new Uint8Array(encodeInput(0x01020304, [8]));
  assert.deepEqual([...bytes], [1, 1, 0x04, 0x03, 0x02, 0x01, 1, 8]);
});
