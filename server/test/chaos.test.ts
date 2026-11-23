// Lab 08, chaos: things that go wrong on the internet. The server must neither crash nor let one
// bad client hurt the others.
import { test, expect, afterEach } from 'vitest';
import { connect, until, sleep, startTestServer, type TestServer } from './helpers.ts';
import { CLOSE } from '../protocol.ts';
import type { Env } from '../config.ts';
import { encodeInput } from '@dogfight/shared/codec.ts';

const servers: TestServer[] = [];
const server = async (env?: Env) => {
  const t = await startTestServer(env);
  servers.push(t);
  return t;
};
afterEach(async () => {
  for (let t = servers.pop(); t; t = servers.pop()) await t.stop();
});

async function join(t: TestServer, name: string, room: string) {
  const c = connect(t.wsUrl);
  await c.opened;
  await c.next('welcome');
  c.send('join', { room, name, format: 'binary' });
  await c.next('joined');
  return c;
}

test('a client that vanishes mid-match (socket dies, no close frame): the others see it leave, the match goes on', async () => {
  const t = await server();
  const stayer = await join(t, 'Stayer', 'quiet-orbit');
  const ghost = await join(t, 'Ghost', 'quiet-orbit');
  await stayer.next('roster', { pred: (m) => (m.players as unknown[]).length === 2 });

  ghost.ws.terminate(); // like unplugging the cable: TCP just ends, no goodbye

  const roster = await stayer.next('roster', {
    pred: (m) => (m.players as unknown[]).length === 1,
  });
  expect(roster.players).toHaveLength(1);
  // ...and the room still ticks and still sends snapshots to the one who stayed
  const before = t.app.ws.stats.snapshots;
  await until(() => t.app.ws.stats.snapshots > before + 5);
  expect(t.app.ws.clients.size).toBe(1);
});

test('a half-dead client (answers nothing) is dropped by the heartbeat, not kept forever', async () => {
  const t = await server({ PING_INTERVAL_MS: '50', MAX_MISSED_PONGS: '1' });
  const c = await join(t, 'Frozen', 'quiet-orbit');
  // a frozen tab: the socket stays open but nothing is read or answered
  (c.ws as unknown as { _socket: { pause(): void } })._socket.pause();
  await until(() => t.app.ws.clients.size === 0, { timeout: 3000 });
});

/** 1000 broken frames per second for 2 seconds, as fast as a timer allows. */
async function flood(
  c: ReturnType<typeof connect>,
  seconds: number,
  make: (i: number) => Uint8Array | string,
) {
  let sent = 0;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end && c.ws.readyState === c.ws.OPEN) {
    for (let k = 0; k < 10 && c.ws.readyState === c.ws.OPEN; k++) c.ws.send(make(sent++));
    await sleep(10); // 10 frames every 10 ms = 1000 per second
  }
  return sent;
}

test('a client that sends ~1000 broken frames per second is disconnected, and a match in another room is not slowed down', async () => {
  const t = await server();
  const victim = await join(t, 'Calm', 'quiet-orbit');
  victim.ws.send(new Uint8Array(encodeInput(1, [0])));
  await sleep(1200); // let the neighbour room settle
  const matchOf = (room: string) => t.app.ws.matches.get(room)!;
  const baseline = matchOf('quiet-orbit').stepStats().total;

  const attacker = await join(t, 'Flooder', 'melee');
  const sent = await flood(
    attacker,
    2,
    (i) => (i % 2 ? new Uint8Array([9, 9, 9, i & 255]) : '{"v":1,"type":"nonsense"'), // bad binary version / broken JSON
  );
  const closed = await attacker.closedPromise;

  // thrown out on the FIRST broken frame, not after the 1000th
  expect([CLOSE.UNSUPPORTED, CLOSE.POLICY, CLOSE.INVALID_PAYLOAD]).toContain(closed.code);
  expect(sent).toBeLessThan(100);
  expect(t.app.ws.clients.size).toBe(1);

  // the other room kept its 30 Hz, and its step time did not grow: 33.3 ms is the budget
  const after = matchOf('quiet-orbit').stepStats().total;
  expect(after.p99).toBeLessThan(33.3);
  expect(after.p99).toBeLessThan(baseline.p99 * 4 + 5);
  expect(matchOf('quiet-orbit').stats().hz).toBeGreaterThan(25);
  expect(victim.closed).toBeNull(); // the calm player was never touched
});

test('valid inputs faster than the limit (a client with a stuck key-repeat loop) are cut off too', async () => {
  const t = await server({ INPUTS_PER_SECOND: '60', INPUT_BURST: '60' });
  const c = await join(t, 'Spammer', 'quiet-orbit');
  const sent = await flood(c, 2, (i) => new Uint8Array(encodeInput(i + 1, [4])));
  const closed = await c.closedPromise;
  expect(closed.code).toBe(CLOSE.POLICY);
  expect(sent).toBeLessThan(400);
});

test('an uncaught problem in one socket handler cannot take the server down: the next client still joins', async () => {
  const t = await server();
  const bad = connect(t.wsUrl);
  await bad.opened;
  bad.ws.send(Buffer.from([0xff, 0xff, 0xff])); // not a protocol frame at all
  await bad.closedPromise;
  const good = await join(t, 'Fine', 'quiet-orbit');
  expect(good.closed).toBeNull();
});
