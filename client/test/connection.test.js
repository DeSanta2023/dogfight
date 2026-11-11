import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/net/connection.js';
import { RoomSession } from '../src/net/session.js';

/** A WebSocket we control by hand: the test decides when it opens, what arrives, how it closes. */
class FakeSocket extends EventTarget {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
  // --- test controls ---
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(message) {
    this.dispatchEvent(
      Object.assign(new Event('message'), {
        data:
          typeof message === 'string' ? message : JSON.stringify({ v: 1, ...message }),
      }),
    );
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }
}
const last = () => FakeSocket.instances.at(-1);
const reset = () => (FakeSocket.instances.length = 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (extra = {}) =>
  new Connection({
    url: 'ws://x/ws',
    WebSocketImpl: FakeSocket,
    baseMs: 10,
    maxMs: 80,
    random: () => 0.5,
    ...extra,
  });

test('messages sent before the socket is open are queued and flushed IN ORDER on open', () => {
  reset();
  const c = make();
  c.connect();
  assert.equal(c.send('chat', { text: '1' }), true);
  c.send('chat', { text: '2' });
  assert.equal(c.queued, 2);
  assert.deepEqual(last().sent, []);
  last().open();
  assert.deepEqual(
    last().sent.map((m) => m.text),
    ['1', '2'],
  );
  assert.equal(c.queued, 0);
  c.send('chat', { text: '3' }); // open: goes out immediately
  assert.equal(last().sent.length, 3);
  assert.deepEqual(last().sent[0], { v: 1, type: 'chat', text: '1' });
});

test('the handshake goes first on every (re)connect, before the queue', async () => {
  reset();
  const c = make();
  c.handshake = () => [['join', { room: 'a', name: 'Ace' }]];
  c.connect();
  c.send('chat', { text: 'queued' });
  last().open();
  assert.deepEqual(
    last().sent.map((m) => m.type),
    ['join', 'chat'],
  );
  last().drop();
  c.send('chat', { text: 'while offline' });
  await wait(300);
  last().open();
  assert.deepEqual(
    last().sent.map((m) => m.type),
    ['join', 'chat'],
  );
  assert.equal(last().sent[1].text, 'while offline');
});

test('an unexpected close reconnects with growing, jittered delays; success resets the counter', async () => {
  reset();
  const c = make();
  const delays = [];
  c.addEventListener(
    'status',
    ({ detail }) => detail.state === 'waiting' && delays.push(detail.delayMs),
  );
  c.connect();
  for (let i = 0; i < 4; i++) {
    last().drop(); // never opened: a failed attempt
    await wait(300);
  }
  // random() = 0.5 -> delay = cap/2 + cap/4 = 0.75 * cap; cap = 10, 20, 40, 80
  assert.deepEqual(delays, [8, 15, 30, 60]);
  last().open();
  assert.equal(c.attempt, 0);
  last().drop();
  assert.equal(delays.at(-1), 8); // back to the start
  c.close();
});

test('jitter: the delay is never 0 and never above the cap', () => {
  reset();
  for (const r of [0, 0.999999]) {
    const c = make({ random: () => r, baseMs: 100, maxMs: 1000 });
    let delay;
    c.addEventListener(
      'status',
      ({ detail }) => detail.state === 'waiting' && (delay = detail.delayMs),
    );
    c.connect();
    last().drop();
    assert.ok(delay >= 50 && delay <= 100, `delay ${delay}`);
    c.close();
  }
});

test('codes that mean "you did something wrong" do not reconnect', async () => {
  for (const code of [1008, 1009, 1003, 1007, 1000]) {
    reset();
    const c = make();
    const events = [];
    c.addEventListener('close', ({ detail }) => events.push(detail.willRetry));
    c.connect();
    last().open();
    last().drop(code);
    await wait(150);
    assert.equal(FakeSocket.instances.length, 1, `code ${code} must not reconnect`);
    assert.deepEqual(events, [false]);
    assert.equal(c.state, 'closed');
  }
});

test('a server shutdown (1001) and a dropped network (1006) DO reconnect', async () => {
  for (const code of [1001, 1006, 1013, 4002, 4003]) {
    reset();
    const c = make();
    c.connect();
    last().open();
    last().drop(code);
    await wait(150);
    assert.equal(FakeSocket.instances.length, 2, `code ${code} should reconnect`);
    c.close();
  }
});

test('close(): no reconnect, the queue is discarded, send() reports false', async () => {
  reset();
  const c = make();
  c.connect();
  c.send('chat', { text: 'x' });
  c.close();
  await wait(150);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(c.queued, 0);
  assert.equal(c.send('chat', { text: 'y' }), false);
});

test('the queue has a limit: the oldest messages are dropped, and counted', () => {
  reset();
  const c = make({ maxQueue: 3 });
  c.connect();
  for (let i = 1; i <= 5; i++) c.send('chat', { text: String(i) });
  assert.equal(c.dropped, 2);
  last().open();
  assert.deepEqual(
    last().sent.map((m) => m.text),
    ['3', '4', '5'],
  );
});

test('garbage from the server is ignored and counted, valid messages are announced', () => {
  reset();
  const c = make();
  const got = [];
  c.addEventListener('message', ({ detail }) => got.push(detail.message));
  c.connect();
  last().open();
  for (const bad of [
    '{oops',
    '[]',
    'null',
    JSON.stringify({ type: 'chat' }),
    JSON.stringify({ v: 2, type: 'chat' }),
  ])
    last().receive(bad);
  last().receive({ type: 'chat', from: 'a', text: 'b' });
  assert.equal(c.invalid, 5);
  assert.deepEqual(
    got.map((m) => m.type),
    ['chat'],
  );
});

test('events of a replaced socket are ignored (a late "close" must not trigger a second reconnect)', async () => {
  reset();
  const c = make();
  c.connect();
  const first = last();
  first.open();
  first.drop();
  await wait(150);
  const second = last();
  assert.notEqual(first, second);
  first.drop(1006); // a stale event from the old socket
  await wait(150);
  assert.equal(FakeSocket.instances.length, 2);
  c.close();
});

test('a constructor that throws (bad URL) becomes a retry, not an exception', async () => {
  reset();
  let calls = 0;
  class Throwing {
    constructor() {
      calls++;
      throw new SyntaxError('bad url');
    }
  }
  const c = make({ WebSocketImpl: Throwing });
  c.connect();
  await wait(150);
  assert.ok(calls >= 2);
  c.close();
});

// ---- RoomSession -----------------------------------------------------------------------------
const session = () =>
  new RoomSession({
    url: 'ws://x/ws',
    WebSocketImpl: FakeSocket,
    baseMs: 10,
    maxMs: 40,
    random: () => 0.5,
  });
const events = (s, ...names) => {
  const log = [];
  for (const n of names) s.addEventListener(n, ({ detail }) => log.push([n, detail]));
  return log;
};

test('session: join is sent on open, "joined" fills the room state', () => {
  reset();
  const s = session();
  const log = events(s, 'joined', 'roster', 'chat');
  s.join('duel', 'Ace');
  last().open();
  assert.deepEqual(last().sent, [{ v: 1, type: 'join', room: 'duel', name: 'Ace' }]);
  last().receive({ type: 'welcome', id: 'p1' });
  last().receive({
    type: 'joined',
    room: { id: 'duel', name: 'Duel', arena: { asteroids: 5 } },
    you: 'p1',
    players: [{ id: 'p1', name: 'Ace' }],
  });
  last().receive({
    type: 'roster',
    players: [
      { id: 'p1', name: 'Ace' },
      { id: 'p2', name: 'Bolt' },
    ],
  });
  last().receive({ type: 'chat', from: 'Bolt', text: 'hi', at: 1 });
  assert.equal(s.state, 'joined');
  assert.equal(s.players.length, 2);
  assert.deepEqual(
    log.map(([n]) => n),
    ['joined', 'roster', 'chat'],
  );
  assert.equal(s.chat[0].text, 'hi');
  s.leave();
});

test('session: a rejected join (name taken, room full) is reported and closes for good', async () => {
  reset();
  const s = session();
  const log = events(s, 'rejected', 'ended');
  s.join('duel', 'Ace');
  last().open();
  last().receive({ type: 'error', code: 'room_full', message: 'Room is full' });
  assert.equal(log[0][0], 'rejected');
  assert.equal(log[0][1].code, 'room_full');
  await wait(150);
  assert.equal(FakeSocket.instances.length, 1); // no reconnect
});

test('session: after a drop it reconnects and joins again by itself', async () => {
  reset();
  const s = session();
  const statuses = [];
  s.addEventListener('status', ({ detail }) => statuses.push(detail.state));
  s.join('duel', 'Ace');
  last().open();
  last().receive({
    type: 'joined',
    room: { id: 'duel', name: 'Duel', arena: {} },
    you: 'p1',
    players: [],
  });
  last().drop(1006);
  assert.equal(s.state, 'reconnecting');
  await wait(150);
  last().open();
  assert.deepEqual(last().sent, [{ v: 1, type: 'join', room: 'duel', name: 'Ace' }]); // a new socket knows nothing: join again
  last().receive({
    type: 'joined',
    room: { id: 'duel', name: 'Duel', arena: {} },
    you: 'p9',
    players: [],
  });
  assert.equal(s.state, 'joined');
  assert.equal(s.you, 'p9');
  assert.ok(statuses.includes('reconnecting'));
  s.leave();
});

test('session: our own ghost after a drop ("name_taken") is retried, not shown as an error', async () => {
  reset();
  const s = session();
  const log = events(s, 'rejected');
  s.join('duel', 'Ace');
  last().open();
  last().receive({
    type: 'joined',
    room: { id: 'duel', name: 'Duel', arena: {} },
    you: 'p1',
    players: [],
  });
  last().drop(1006);
  await wait(150);
  last().open();
  last().receive({ type: 'error', code: 'name_taken', message: 'taken' }); // the server still holds the old socket
  assert.equal(log.length, 0);
  await wait(1700); // REJOIN_DELAY_MS
  assert.equal(last().sent.filter((m) => m.type === 'join').length, 2);
  s.leave();
});

test('session: a fatal server close ends the session; empty chat is not sent', async () => {
  reset();
  const s = session();
  const log = events(s, 'ended');
  s.join('duel', 'Ace');
  last().open();
  last().receive({
    type: 'joined',
    room: { id: 'duel', name: 'Duel', arena: {} },
    you: 'p1',
    players: [],
  });
  assert.equal(s.sendChat('   '), false);
  assert.equal(s.sendChat(' hi '), true);
  assert.equal(last().sent.at(-1).text, 'hi');
  last().drop(1008);
  assert.equal(log.length, 1);
  assert.match(log[0][1].reason, /1008/);
  assert.equal(s.state, 'closed');
});
