// npm run wire-size  — the same snapshot as binary and as JSON.
import { Game } from '../src/game.js';
import { BIT, DT, inputFromBits } from '../src/input.js';
import { captureSnapshot } from '../src/snapshot.js';
import {
  encodeInput,
  encodeInputJson,
  encodeSnapshot,
  encodeSnapshotJson,
} from '../src/codec.js';

const game = new Game({
  seed: 404,
  players: 2,
  asteroids: 5,
  pickups: true,
  hunterChance: 0.4,
});
const sizes = [];
for (let i = 0; i < 600; i++) {
  const bits = i % 50 < 30 ? BIT.THRUST | BIT.FIRE | BIT.LEFT : BIT.FIRE;
  game.stepInputs(
    DT,
    new Map([
      [0, inputFromBits(bits)],
      [1, inputFromBits(BIT.THRUST)],
    ]),
  );
  if (i % 30 === 0 && i > 0) {
    const snap = captureSnapshot(game, { tick: i, slot: 0, ackSeq: i - 2, events: [] });
    sizes.push({
      bin: encodeSnapshot(snap).byteLength,
      json: encodeSnapshotJson(snap).length,
      entities:
        snap.bullets.length +
        snap.asteroids.length +
        snap.pickups.length +
        snap.ships.length,
    });
  }
}
const avg = (k) => sizes.reduce((s, x) => s + x[k], 0) / sizes.length;
const bin = avg('bin');
const json = avg('json');
const row = (label, b, j) =>
  console.log(
    `${label.padEnd(26)} ${String(b.toFixed(0)).padStart(7)} ${String(j.toFixed(0)).padStart(7)}   x${(j / b).toFixed(1)}`,
  );
console.log(`${''.padEnd(26)}  binary    JSON`);
row('snapshot (avg bytes)', bin, json);
row('snapshots, 30/s (B/s)', bin * 30, json * 30);
const ib = encodeInput(1000, [13, 13, 13, 13, 13, 13, 13, 13]).byteLength;
const ij = encodeInputJson(1000, [13, 13, 13, 13, 13, 13, 13, 13]).length;
row('input packet (8 redundant)', ib, ij);
row('inputs, 30/s (B/s)', ib * 30, ij * 30);
console.log(
  `\n${sizes.length} snapshots sampled, ${avg('entities').toFixed(1)} entities each on average`,
);
