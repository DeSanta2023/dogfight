import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { z } from 'zod';
import {
  startTestServer,
  connect,
  until,
  sleep,
  decodeFrame,
  snapshotFrom,
  readJson,
  type PongMessage,
  type Received,
  type TestServer,
} from './helpers.ts';
import { encodeInput, encodePing } from '@dogfight/shared/codec.ts';

async function join(
  server: TestServer,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const c = connect(server.wsUrl);
  await c.opened;
  await c.next('welcome');
  c.send('join', { room: 'duel', name, ...extra });
  const joined = await c.next('joined');
  return { c, joined };
}

test('two players in one room: slots 0 and 1, both receive binary snapshots at ~30/s', async () => {
  const server = await startTestServer();
  try {
    const a = await join(server, 'Ace');
    const b = await join(server, 'Bo');
    assert.equal(a.joined.slot, 0);
    assert.equal(b.joined.slot, 1);
    assert.equal(a.joined.tickHz, 30);
    await sleep(500);
    assert.ok(a.c.binary.length >= 8, `got ${a.c.binary.length} frames in 0.5 s`);
    const snap = snapshotFrom(a.c.binary.at(-1));
    assert.equal(snap.ships.length, 1);
    a.c.ws.close();
    b.c.ws.close();
  } finally {
    await server.stop();
  }
});

test('input moves the ship on the SERVER; the snapshot acknowledges the seq', async () => {
  const server = await startTestServer();
  try {
    const { c } = await join(server, 'Ace');
    await until(() => c.binary.length > 0);
    const before = snapshotFrom(c.binary.at(-1)).own;
    for (let seq = 1; seq <= 20; seq++) {
      c.ws.send(encodeInput(seq, [4])); // thrust
      await sleep(33);
    }
    await sleep(100);
    const after = snapshotFrom(c.binary.at(-1));
    assert.ok(after.ackSeq >= 15, `ackSeq=${after.ackSeq}`);
    assert.ok(after.own.alive && before.alive, 'the ship is alive');
    assert.ok(Math.hypot(after.own.vx, after.own.vy) > 10, 'it accelerated');
    assert.notEqual(after.own.x + after.own.y, before.x + before.y);
    c.ws.close();
  } finally {
    await server.stop();
  }
});

test('ping is answered with a pong that echoes the timestamp', async () => {
  const server = await startTestServer();
  try {
    const { c } = await join(server, 'Ace');
    c.ws.send(encodePing(12345.5));
    await until(() => c.binary.some((f) => decodeFrame(f).type === 'pong'));
    const pong = c.binary
      .map((f) => decodeFrame(f))
      .find((m): m is PongMessage => m.type === 'pong');
    assert.equal(pong?.t, 12345.5);
    c.ws.close();
  } finally {
    await server.stop();
  }
});

test('format=json: the same game over text frames', async () => {
  const server = await startTestServer();
  try {
    const { c } = await join(server, 'Ace', { format: 'json' });
    c.send('input', { seq: 1, bits: [4] });
    const snap: Received = await c.next('snapshot');
    assert.equal(typeof snap.tick, 'number');
    assert.ok('own' in snap && 'ships' in snap);
    assert.equal(c.binary.length, 0);
    c.ws.close();
  } finally {
    await server.stop();
  }
});

test('garbage binary frames close the socket; binary before join is refused', async () => {
  const server = await startTestServer();
  try {
    const raw = new WebSocket(server.wsUrl);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));
    const closed = new Promise<number>((resolve) =>
      raw.once('close', (code) => resolve(code)),
    );
    raw.send(encodeInput(1, [1])); // a perfectly good input, but nobody has joined yet
    assert.equal(await closed, 1008);

    const { c } = await join(server, 'Ace');
    c.ws.send(Uint8Array.from([1, 1, 0, 0, 0, 0, 3, 1])); // count says 3, only 1 byte follows
    assert.equal((await c.closedPromise).code, 1003);
  } finally {
    await server.stop();
  }
});

test('/health reports the real tick rate of the running match', async () => {
  const server = await startTestServer();
  try {
    const { c } = await join(server, 'Ace');
    await sleep(1200);
    const res = await fetch(`${server.url}/health`);
    const body = await readJson(
      res,
      z.object({ matches: z.object({ duel: z.object({ hz: z.number() }) }) }),
    );
    const stats = body.matches.duel;
    assert.ok(stats.hz > 27 && stats.hz < 33, `hz=${stats.hz}`);
    c.ws.close();
  } finally {
    await server.stop();
  }
});
