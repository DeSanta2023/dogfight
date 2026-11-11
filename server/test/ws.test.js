import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { CLOSE } from '../protocol.js';
import { safeSend } from '../ws.js';
import { connect, sleep, startTestServer, until } from './helpers.js';

const servers = [];
const server = async (env) => {
  const t = await startTestServer(env);
  servers.push(t);
  return t;
};
afterEach(async () => {
  while (servers.length) await servers.pop().stop();
});

async function joined(t, name, room = 'quiet-orbit') {
  const c = connect(t.wsUrl);
  await c.opened;
  await c.next('welcome');
  c.send('join', { room, name });
  await c.next('joined');
  return c;
}

test('welcome, join, roster, chat between two clients', async () => {
  const t = await server();
  const a = await joined(t, 'Ace');
  const b = await joined(t, 'Bolt');
  const roster = await a.next('roster', { pred: (m) => m.players.length === 2 });
  assert.deepEqual(roster.players.map((p) => p.name).sort(), ['Ace', 'Bolt']);
  a.send('chat', { text: 'hello' });
  for (const c of [a, b]) {
    const m = await c.next('chat');
    assert.deepEqual([m.from, m.text], ['Ace', 'hello']);
  }
});

test('joined carries the room settings (arena) for the local game', async () => {
  const t = await server();
  const c = connect(t.wsUrl);
  await c.opened;
  c.send('join', { room: 'rock-garden', name: 'Ace' });
  const m = await c.next('joined');
  assert.equal(m.room.id, 'rock-garden');
  assert.equal(m.room.arena.asteroids, 9);
});

test('leaving (or closing) updates the roster, and an empty room is removed', async () => {
  const t = await server();
  const a = await joined(t, 'Ace', 'duel');
  const b = await joined(t, 'Bolt', 'duel');
  b.ws.close();
  await a.next('roster', { pred: (m) => m.players.length === 1 });
  a.send('leave');
  await until(() => t.app.rooms.size === 0);
  assert.equal(a.ws.readyState, WebSocket.OPEN); // leave() leaves the room, not the socket
});

test('join errors keep the socket open: name taken, room full, unknown room', async () => {
  const t = await server();
  await joined(t, 'Ace', 'duel');
  await joined(t, 'Bolt', 'duel');
  const c = connect(t.wsUrl);
  await c.opened;
  c.send('join', { room: 'duel', name: 'Cy' });
  assert.equal((await c.next('error')).code, 'room_full');
  c.send('join', { room: 'quiet-orbit', name: 'Ace' });
  await c.next('joined'); // a different room: fine, and the socket was never closed
  c.send('leave');
  c.send('join', { room: 'nowhere', name: 'Cy' });
  assert.equal((await c.next('error')).code, 'no_such_room');
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('chat before join is an error, not a crash', async () => {
  const t = await server();
  const c = connect(t.wsUrl);
  await c.opened;
  c.send('chat', { text: 'hi' });
  assert.equal((await c.next('error')).code, 'not_in_room');
});

test('violations close the socket with the right code', async () => {
  const t = await server();
  const cases = [
    ['not json', '{oops', CLOSE.INVALID_PAYLOAD],
    ['unknown type', JSON.stringify({ v: 1, type: 'hack' }), CLOSE.POLICY],
    ['wrong version', JSON.stringify({ v: 9, type: 'leave' }), CLOSE.POLICY],
    ['bad join shape', JSON.stringify({ v: 1, type: 'join', room: 7 }), CLOSE.POLICY],
  ];
  for (const [label, payload, code] of cases) {
    const c = connect(t.wsUrl);
    await c.opened;
    c.ws.send(payload);
    assert.equal((await c.closedPromise).code, code, label);
  }
  const bin = connect(t.wsUrl);
  await bin.opened;
  bin.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await bin.closedPromise).code, CLOSE.UNSUPPORTED);
});

test('maxPayload: an oversized frame is closed with 1009 by ws itself', async () => {
  const t = await server({ MAX_MESSAGE_BYTES: '128' });
  const c = connect(t.wsUrl);
  await c.opened;
  c.ws.send('x'.repeat(5000));
  assert.equal((await c.closedPromise).code, CLOSE.TOO_BIG);
});

test('join timeout: a silent client is closed with 4001', async () => {
  const t = await server({ JOIN_TIMEOUT_MS: '100' });
  const c = connect(t.wsUrl);
  await c.opened;
  const closed = await c.closedPromise;
  assert.equal(closed.code, CLOSE.JOIN_TIMEOUT);
});

test('a client that joined is NOT closed by the join timeout', async () => {
  const t = await server({ JOIN_TIMEOUT_MS: '100' });
  const c = await joined(t, 'Ace');
  await sleep(250);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('rate limit: flooding closes the socket with 1008', async () => {
  const t = await server({ MESSAGES_PER_SECOND: '5', MESSAGE_BURST: '5' });
  const c = await joined(t, 'Ace');
  for (let i = 0; i < 30; i++) c.send('chat', { text: `spam ${i}` });
  const closed = await c.closedPromise;
  assert.equal(closed.code, CLOSE.POLICY);
  assert.equal(closed.reason, 'rate limit');
  await until(() => t.app.rooms.size === 0); // it left the room (the server's 'close' fires a moment after the client sees the frame)
});

test('heartbeat: a client that never answers pings is terminated after 2 missed pongs', async () => {
  const t = await server({ PING_INTERVAL_MS: '50', MAX_MISSED_PONGS: '2' });
  const ws = new WebSocket(t.wsUrl, { autoPong: false }); // a client that is "dead": no pong
  ws.on('error', () => {});
  const closed = new Promise((resolve) => ws.on('close', resolve));
  const started = Date.now();
  await closed;
  assert.ok(Date.now() - started < 1000);
  assert.equal(t.app.ws.stats.closes[CLOSE.HEARTBEAT], 1);
});

test('heartbeat: a healthy client (auto pong) stays connected', async () => {
  const t = await server({ PING_INTERVAL_MS: '50', MAX_MISSED_PONGS: '2' });
  const c = await joined(t, 'Ace');
  await sleep(400);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('connection cap: the next client gets 1013', async () => {
  const t = await server({ MAX_CONNECTIONS: '1' });
  await joined(t, 'Ace');
  const c = connect(t.wsUrl);
  await c.opened;
  assert.equal((await c.closedPromise).code, CLOSE.TRY_LATER);
});

test('an error on one socket does not take the server down', async () => {
  const t = await server();
  const a = await joined(t, 'Ace');
  const [serverSide] = [...t.app.ws.clients];
  serverSide.emit('error', new Error('simulated socket failure')); // would throw without a listener
  assert.ok(t.lines.some((l) => l.msg === 'socket error'));
  a.send('chat', { text: 'still here' });
  assert.equal((await a.next('chat')).text, 'still here');
});

test('match log records joins, chat and leaves', async () => {
  const t = await server();
  const a = await joined(t, 'Ace', 'quiet-orbit');
  a.send('chat', { text: 'for the record' });
  await a.next('chat');
  a.send('leave');
  const { listReplays, replayEvents } = await import('../log/replay.js');
  // The log is written asynchronously (and slower on some disks): poll, do not guess a delay.
  let types = [];
  for (let i = 0; i < 100 && !types.includes('room_closed'); i++) {
    await sleep(50);
    const [first] = await listReplays(t.config.logDir);
    types = [];
    if (first)
      for await (const e of replayEvents(`${t.config.logDir}/${first.id}.ndjson`))
        types.push(e.type);
  }
  assert.deepEqual(types, ['room_created', 'joined', 'chat', 'left', 'room_closed']);
});

test('safeSend: normal, drop droppable above soft limit, terminate above 4x', () => {
  const calls = [];
  const fake = (buffered) => ({
    readyState: WebSocket.OPEN,
    bufferedAmount: buffered,
    send: (data) => calls.push(['send', data]),
    terminate: () => calls.push(['terminate']),
  });
  const opts = { soft: 100 };
  assert.equal(safeSend(fake(50), 'a', opts), 'sent');
  assert.equal(safeSend(fake(150), 'chat', { ...opts, droppable: true }), 'dropped');
  assert.equal(safeSend(fake(150), 'roster', opts), 'sent'); // important messages still go
  assert.equal(safeSend(fake(450), 'x', opts), 'closed');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['send', 'send', 'terminate'],
  );
  assert.equal(safeSend({ readyState: WebSocket.CLOSED }, 'x', opts), 'closed');
});

test('graceful shutdown: clients get 1001 and the match log is complete on disk', async () => {
  const t = await server();
  const a = await joined(t, 'Ace');
  a.send('chat', { text: 'last words' });
  await a.next('chat');
  await t.app.stop();
  assert.equal((await a.closedPromise).code, CLOSE.GOING_AWAY);
  const { listReplays, replayEvents } = await import('../log/replay.js');
  const [{ id }] = await listReplays(t.config.logDir);
  const types = [];
  for await (const e of replayEvents(`${t.config.logDir}/${id}.ndjson`))
    types.push(e.type);
  assert.ok(types.includes('chat'), `log has ${types}`);
  servers.pop(); // already stopped; only the temp dir is left
  await import('node:fs/promises').then((fs) =>
    fs.rm(t.dir, { recursive: true, force: true }),
  );
});
