import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Match } from '../match.ts';
import { NetGame } from '../../client/src/net/netgame.ts';
import { decodeClient, encodeSnapshot } from '@dogfight/shared/codec.ts';
import { BIT, DT } from '@dogfight/shared/input.ts';
import { physicsHooks } from '@dogfight/shared/ship.ts';

/**
 * Browser and server in ONE process with a fake network in between: a latency, and optionally
 * loss. Time is a number we advance by hand, so the test is fast and exactly repeatable.
 */
interface RunOptions {
  ticks?: number;
  latencyMs?: number;
  uplinkLoss?: number;
  seed?: number;
  pilot: (step: number) => number;
}
/** A datagram in flight on the fake network, due at time `at`. */
interface Packet {
  at: number;
  data: ArrayBuffer;
}

function run({
  ticks = 300,
  latencyMs = 100,
  uplinkLoss = 0,
  seed = 1,
  pilot,
}: RunOptions) {
  let t = 10_000;
  const up: Packet[] = [];
  const down: Packet[] = [];
  let n = seed;
  const rand = () => (n = (n * 1664525 + 1013904223) >>> 0) / 2 ** 32; // repeatable "random"

  const match = new Match({
    arena: { asteroids: 0, pickups: false, seed: 3 },
    onSnapshot: (slot, snap) => {
      if (slot === 0) down.push({ at: t + latencyMs / 2, data: encodeSnapshot(snap) });
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  match.join(0);
  match.join(1);
  const net = new NetGame({
    slot: 0,
    send: (data) => {
      // These tests run the binary format; a string would be the ?format=json flavour.
      if (data instanceof ArrayBuffer && rand() >= uplinkLoss)
        up.push({ at: t + latencyMs / 2, data });
    },
    now: () => t,
  });

  for (let i = 0; i < ticks; i++) {
    t += DT * 1000;
    net.step(pilot(i));
    for (const p of up.splice(0).filter((p) => (p.at > t ? (up.push(p), false) : true))) {
      const m = decodeClient(p.data);
      if (m.type === 'input') match.input(0, m.seq, m.bits);
    }
    match.input(1, i + 1, [0]); // the other player just sits there
    match.tick();
    for (const p of down
      .splice(0)
      .filter((p) => (p.at > t ? (down.push(p), false) : true)))
      net.receive(p.data, p.data.byteLength);
  }
  return { net, match };
}

const pilot = (i: number) =>
  i % 60 < 40 ? BIT.THRUST | (i % 120 < 60 ? BIT.LEFT : BIT.RIGHT) : 0;

test('prediction + reconciliation: with deterministic physics the corrections are exactly zero', () => {
  const { net } = run({ pilot });
  assert.ok(net.stats.snaps > 200, 'snapshots arrived');
  assert.ok(net.stats.corrections === 0, `corrections=${net.stats.corrections}`);
  assert.equal(net.stats.correctionMax, 0);
  assert.ok(
    net.pending.length >= 2 && net.pending.length <= 6,
    `pending=${net.pending.length}`,
  );
});

test('the predicted ship is AHEAD of the snapshot by the latency, yet the server agrees in the end', () => {
  const { net, match } = run({ pilot });
  const server = match.game.player(0)?.ship;
  assert.ok(server && net.own, 'both ships exist');
  // the server is a few inputs behind the browser; replaying them reproduces the browser's ship
  assert.ok(Math.hypot(net.own.x - server.pos.x, net.own.y - server.pos.y) > 0);
  assert.equal(net.stats.corrections, 0);
});

test('add Math.random() to the physics and the corrections grow (then remove it: back to 0)', () => {
  physicsHooks.afterIntegrate = (s) => ({ ...s, vx: s.vx + (Math.random() - 0.5) * 8 });
  try {
    const noisy = run({ pilot });
    assert.ok(
      noisy.net.stats.corrections > 50,
      `corrections=${noisy.net.stats.corrections}`,
    );
  } finally {
    physicsHooks.afterIntegrate = null;
  }
  assert.equal(run({ pilot }).net.stats.corrections, 0);
});

test('30 % of the input packets are lost: redundancy keeps the ship close to the server', () => {
  const { net, match } = run({ pilot, uplinkLoss: 0.3, ticks: 600 });
  assert.ok(net.stats.correctionMax < 40, `max correction ${net.stats.correctionMax}`);
  assert.ok(match.stats().starved < 25, `starved=${match.stats().starved}`);
});

test('stage 1 (predict off): the ship only moves after a snapshot, ~RTT behind the keys', () => {
  const t = 0;
  const sent: ArrayBuffer[] = [];
  const net = new NetGame({
    slot: 0,
    send: (d) => {
      if (d instanceof ArrayBuffer) sent.push(d);
    },
    predict: false,
    now: () => t,
  });
  net.step(BIT.THRUST);
  assert.equal(net.own, null, 'nothing is drawn from a key press alone');
});
