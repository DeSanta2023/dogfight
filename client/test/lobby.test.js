import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Lobby, LobbyError } from '../src/lobby.js';
import { HttpError } from '../src/assets/loader.js';

const ROOMS = {
  rooms: [
    { id: 'a', name: 'Alpha', players: 1, maxPlayers: 4, arena: { asteroids: 3 } },
    { id: 'b', name: 'Bravo', players: 4, maxPlayers: 4, arena: { asteroids: 5 } },
  ],
};

/**
 * A fake fetch for /api/rooms. `script` is a list of behaviours, used one per request:
 *   { ms, body }  answer after `ms`        { status }  an HTTP error        { fail } network error
 * It honours the AbortSignal like the real fetch, and records how many requests ran at once.
 */
function fakeServer(script) {
  const stats = { calls: 0, active: 0, maxActive: 0, aborted: 0, signals: [] };
  const fetchImpl = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const step = script[Math.min(stats.calls, script.length - 1)];
      stats.calls++;
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      stats.signals.push(signal);
      const finish = () => stats.active--;
      const onAbort = () => {
        clearTimeout(timer);
        finish();
        stats.aborted++;
        reject(signal.reason);
      };
      if (signal?.aborted) return onAbort();
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        finish();
        if (step.fail) return reject(new TypeError('fetch failed'));
        const status = step.status ?? 200;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => (step.raw ? JSON.parse(step.raw) : (step.body ?? ROOMS)),
        });
      }, step.ms ?? 0);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  return { fetchImpl, stats };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the model is DOM-free -------------------------------------------------------------------
test('src/lobby.js uses no DOM: it extends EventTarget and renders nothing', () => {
  const source = readFileSync(new URL('../src/lobby.js', import.meta.url), 'utf8');
  assert.match(source, /class Lobby extends EventTarget/);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|innerHTML|querySelector/);
  assert.ok(new Lobby({ fetchImpl: () => {} }) instanceof EventTarget);
});

// ---- refresh ---------------------------------------------------------------------------------
test('refresh() loads the rooms and announces "status" then "rooms"', async () => {
  const { fetchImpl } = fakeServer([{ body: ROOMS }]);
  const lobby = new Lobby({ fetchImpl });
  const log = [];
  lobby.addEventListener('status', (e) => log.push(`status:${e.detail.status}`));
  lobby.addEventListener('rooms', (e) => log.push(`rooms:${e.detail.rooms.length}`));

  assert.equal(await lobby.refresh(), true);

  assert.deepEqual(log, ['status:loading', 'status:ok', 'rooms:2']);
  assert.equal(lobby.rooms[0].name, 'Alpha');
  assert.ok(lobby.updatedAt > 0);
});

test('a failed refresh becomes status "error" and KEEPS the last good list', async () => {
  const { fetchImpl } = fakeServer([{ body: ROOMS }, { status: 503 }]);
  const lobby = new Lobby({ fetchImpl });
  await lobby.refresh();
  assert.equal(await lobby.refresh(), false);

  assert.equal(lobby.status, 'error');
  assert.ok(lobby.error instanceof HttpError);
  assert.equal(lobby.error.status, 503);
  assert.equal(lobby.rooms.length, 2, 'the old list is still shown');
});

test('every request has a timeout: a silent server gives a TimeoutError, not a hang', async () => {
  const { fetchImpl } = fakeServer([{ ms: 500 }]);
  const lobby = new Lobby({ fetchImpl, timeoutMs: 30 });
  assert.equal(await lobby.refresh(), false);
  assert.equal(lobby.status, 'error');
  assert.equal(lobby.error.name, 'TimeoutError');
});

test('corrupt JSON and a malformed payload are errors, not crashes', async () => {
  let lobby = new Lobby({ fetchImpl: fakeServer([{ raw: '{"rooms": [' }]).fetchImpl });
  await lobby.refresh();
  assert.equal(lobby.status, 'error');
  assert.ok(lobby.error instanceof SyntaxError);

  lobby = new Lobby({ fetchImpl: fakeServer([{ body: { nope: true } }]).fetchImpl });
  await lobby.refresh();
  assert.equal(lobby.status, 'error');
  assert.match(lobby.error.message, /Malformed/);
});

test('a STALE answer (slow request overtaken by a newer one) is ignored', async () => {
  const slow = { ...ROOMS, rooms: [{ ...ROOMS.rooms[0], name: 'OLD' }] };
  const fresh = { ...ROOMS, rooms: [{ ...ROOMS.rooms[0], name: 'NEW' }] };
  const { fetchImpl, stats } = fakeServer([
    { ms: 80, body: slow },
    { ms: 5, body: fresh },
  ]);
  const lobby = new Lobby({ fetchImpl });

  const first = lobby.refresh(); // slow, started first
  const second = lobby.refresh(); // fast, started second: supersedes the first
  assert.equal(await second, true);
  assert.equal(await first, false, 'the superseded request reports "no fresh data"');

  assert.equal(lobby.rooms[0].name, 'NEW');
  assert.equal(stats.aborted, 1, 'and its fetch was actually aborted');
  assert.equal(lobby.status, 'ok');
});

// ---- polling ---------------------------------------------------------------------------------
test('start() polls on an interval and never has two requests in flight', async () => {
  const { fetchImpl, stats } = fakeServer([{ ms: 15 }]);
  const lobby = new Lobby({ fetchImpl, intervalMs: 20 });
  lobby.start();
  await sleep(220);
  await lobby.stop();

  assert.ok(stats.calls >= 4, `polled repeatedly (got ${stats.calls})`);
  assert.equal(
    stats.maxActive,
    1,
    'chained sleeps: the next request waits for the previous',
  );
});

test('start() is idempotent: calling it twice does not double the polling', async () => {
  const { fetchImpl, stats } = fakeServer([{ ms: 0 }]);
  const lobby = new Lobby({ fetchImpl, intervalMs: 50 });
  lobby.start();
  lobby.start();
  await sleep(30);
  await lobby.stop();
  assert.equal(stats.calls, 1);
});

test('stop() aborts the request in flight and no further request is ever made', async () => {
  const { fetchImpl, stats } = fakeServer([{ ms: 1000 }]);
  const lobby = new Lobby({ fetchImpl, intervalMs: 10 });
  lobby.start();
  await sleep(20);
  assert.equal(stats.active, 1, 'a request is in flight');

  await lobby.stop();

  assert.equal(stats.active, 0, 'it was cancelled, not left running');
  assert.equal(stats.aborted, 1);
  assert.equal(lobby.polling, false);
  await sleep(60);
  assert.equal(stats.calls, 1, 'nothing is orphaned: no new request after stop()');
});

test('stop() during the pause between requests also ends the loop immediately', async () => {
  const { fetchImpl, stats } = fakeServer([{ ms: 0 }]);
  const lobby = new Lobby({ fetchImpl, intervalMs: 10_000 });
  lobby.start();
  await sleep(20); // first request done, now sleeping for 10 s
  const t = performance.now();
  await lobby.stop();
  assert.ok(performance.now() - t < 100, 'did not wait for the 10 s pause');
  assert.equal(stats.calls, 1);
});

test('a late answer after stop() cannot touch the lobby (no "rooms" event)', async () => {
  const { fetchImpl } = fakeServer([{ ms: 40 }]);
  const lobby = new Lobby({ fetchImpl });
  let rooms = 0;
  lobby.addEventListener('rooms', () => rooms++);
  lobby.start();
  await sleep(5);
  await lobby.stop();
  await sleep(60);
  assert.equal(rooms, 0);
  assert.deepEqual(lobby.rooms, []);
});

test('the lobby can be started again after stop() (back from the game)', async () => {
  const { fetchImpl, stats } = fakeServer([{ ms: 0 }]);
  const lobby = new Lobby({ fetchImpl, intervalMs: 1000 });
  lobby.start();
  await sleep(20);
  await lobby.stop();
  lobby.start();
  await sleep(20);
  await lobby.stop();
  assert.equal(stats.calls, 2);
});

// ---- join ------------------------------------------------------------------------------------
test('join() announces "joined" and stops polling (leaving the lobby)', async () => {
  const { fetchImpl, stats } = fakeServer([{ ms: 0 }]);
  const lobby = new Lobby({ fetchImpl, intervalMs: 10 });
  lobby.start();
  await sleep(30);
  let joined = null;
  lobby.addEventListener('joined', (e) => (joined = e.detail));

  lobby.join('a', '  Maverick ');

  assert.deepEqual(joined.room.id, 'a');
  assert.equal(joined.name, 'Maverick', 'the callsign is trimmed');
  assert.equal(lobby.polling, false);
  const calls = stats.calls;
  await sleep(60);
  assert.equal(stats.calls, calls, 'no request after joining');
});

test('join() rejects what a player can fix: no name, full room, unknown room', async () => {
  const lobby = new Lobby({ fetchImpl: fakeServer([{}]).fetchImpl });
  await lobby.refresh();

  assert.throws(() => lobby.join('a', '   '), LobbyError);
  assert.throws(() => lobby.join('b', 'Maverick'), /full/);
  assert.throws(() => lobby.join('zzz', 'Maverick'), /Unknown room/);
  assert.equal(lobby.rooms.length, 2, 'nothing changed');
});

test('the url may be a function (chaos delays only the first request)', async () => {
  const urls = [];
  const lobby = new Lobby({
    url: () => (urls.length === 0 ? 'api/rooms?delay=9' : 'api/rooms'),
    fetchImpl: (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: async () => ROOMS });
    },
  });
  await lobby.refresh();
  await lobby.refresh();
  assert.deepEqual(urls, ['api/rooms?delay=9', 'api/rooms']);
});
