import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { z } from 'zod';
import { startTestServer, until, readJson, type TestServer } from './helpers.ts';
import { validateNewRoom, HttpError } from '../http.ts';

const roomShape = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number(),
  maxPlayers: z.number(),
  arena: z.object({}).loose(),
});
const roomsBody = z.object({ rooms: z.array(roomShape) });

let started: TestServer | undefined;
/** The server the tests talk to; `before` has started it by the time any test runs. */
const server = (): TestServer => {
  if (!started) throw new Error('test server is not running');
  return started;
};
const t = {
  get url() {
    return server().url;
  },
  get dir() {
    return server().dir;
  },
  get app() {
    return server().app;
  },
};
before(async () => {
  started = await startTestServer({ MAX_BODY_BYTES: '256' });
  await mkdir(join(t.dir, 'static'), { recursive: true });
  await writeFile(join(t.dir, 'static', 'index.html'), '<h1>client</h1>');
  await writeFile(join(t.dir, 'static', 'app.js'), 'export {}');
  await writeFile(join(t.dir, 'secret.txt'), 'top secret'); // OUTSIDE the static root
});
after(() => server().stop());

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) =>
  fetch(t.url + path, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('GET /health', async () => {
  const res = await fetch(`${t.url}/health`);
  assert.equal(res.status, 200);
  const body = await readJson(res, z.object({ status: z.string(), rssMb: z.unknown() }));
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.rssMb, 'number');
});

test('GET /api/rooms lists the presets', async () => {
  const { rooms } = await readJson(await fetch(`${t.url}/api/rooms`), roomsBody);
  assert.ok(rooms.length >= 4);
  assert.ok(rooms.every((r) => r.id && r.name && r.maxPlayers > 0));
});

test('POST /api/rooms creates a room that then shows up in the list', async () => {
  const res = await post('/api/rooms', { name: 'Test Arena', maxPlayers: 3 });
  assert.equal(res.status, 201);
  const { room } = await readJson(res, z.object({ room: roomShape }));
  assert.match(room.id, /^test-arena-[0-9a-f]{4}$/);
  assert.equal(res.headers.get('location'), `/api/rooms/${room.id}`);
  const { rooms } = await readJson(await fetch(`${t.url}/api/rooms`), roomsBody);
  assert.ok(rooms.some((r) => r.id === room.id));
});

test('POST /api/rooms: validation errors are 400 and name every problem', async () => {
  const res = await post('/api/rooms', {
    name: '',
    maxPlayers: 99,
    arena: { asteroids: -1 },
  });
  assert.equal(res.status, 400);
  const { error } = await readJson(res, z.object({ error: z.string() }));
  assert.match(error, /name/);
  assert.match(error, /maxPlayers/);
  assert.match(error, /asteroids/);
});

test('POST /api/rooms: wrong content type 415, not JSON 400, too big 413, wrong method 405', async () => {
  assert.equal(
    (await post('/api/rooms', '{}', { 'content-type': 'text/plain' })).status,
    415,
  );
  assert.equal((await post('/api/rooms', '{nope')).status, 400);
  assert.equal((await post('/api/rooms', { name: 'x'.repeat(1000) })).status, 413);
  const del = await fetch(`${t.url}/api/rooms`, { method: 'DELETE' });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get('allow'), 'GET, POST');
});

test('a body without Content-Length (chunked) is still capped', async () => {
  const res = await fetch(`${t.url}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100)));
        c.close();
      },
    }),
    duplex: 'half',
  });
  assert.equal(res.status, 413);
});

test('unknown API route is a JSON 404', async () => {
  const res = await fetch(`${t.url}/api/nope`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /json/);
});

test('static: index.html at /, correct MIME types, SPA-less 404', async () => {
  const root = await fetch(`${t.url}/`);
  assert.equal(await root.text(), '<h1>client</h1>');
  assert.match(root.headers.get('content-type') ?? '', /text\/html/);
  assert.match(
    (await fetch(`${t.url}/app.js`)).headers.get('content-type') ?? '',
    /javascript/,
  );
  assert.equal((await fetch(`${t.url}/missing.png`)).status, 404);
});

/** fetch() normalises `..` away before sending, so traversal attempts are sent as RAW requests. */
function raw(requestLine: string): Promise<string> {
  return new Promise((resolve) => {
    const url = new URL(t.url);
    const socket = net.connect(Number(url.port), url.hostname, () =>
      socket.write(`${requestLine} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
    );
    let data = '';
    socket.on('data', (d: Buffer) => (data += d.toString()));
    socket.on('close', () => resolve(data));
  });
}

test('path traversal is refused: plain, %-encoded, double-encoded, backslash, NUL', async () => {
  for (const path of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/a%00.txt',
    '/%252e%252e/secret.txt',
  ]) {
    const answer = await raw(`GET ${path}`);
    assert.doesNotMatch(answer, /top secret/, path);
    assert.match(
      answer,
      /^HTTP\/1\.1 (400|404)/,
      `${path} -> ${answer.split('\r\n')[0]}`,
    );
  }
});

test('a request target like // or * does not crash the server', async () => {
  assert.match(await raw('GET //'), /^HTTP\/1\.1 400/);
  await raw('GET *');
  assert.equal((await fetch(`${t.url}/health`)).status, 200); // still alive
});

test('malformed percent-escape is a 400', async () => {
  assert.match(await raw('GET /%E0%A4%A'), /^HTTP\/1\.1 400/);
});

test('/api/replays: lists, streams an existing log, rejects bad ids', async () => {
  const created = await readJson(
    await post('/api/rooms', { name: 'Replay' }),
    z.object({ room: roomShape }),
  );
  t.app.rooms.get(created.room.id)?.emit('chat', { from: 'x', text: 'y', at: 1 });
  const replaysBody = z.object({
    replays: z.array(z.object({ id: z.string(), bytes: z.number() })),
  });
  const mine = await until(async () => {
    const { replays } = await readJson(await fetch(`${t.url}/api/replays`), replaysBody);
    return replays.find((r) => r.id.startsWith('replay-') && r.bytes > 0);
  });
  const res = await fetch(`${t.url}/api/replays/${mine.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const lines = (await res.text())
    .trim()
    .split('\n')
    .map((l): unknown => JSON.parse(l));
  assert.equal(z.object({ type: z.string() }).parse(lines[0]).type, 'room_created');
  assert.equal((await fetch(`${t.url}/api/replays/..%2Fsecret`)).status, 400);
  assert.equal((await fetch(`${t.url}/api/replays/nope`)).status, 404);
});

test('validateNewRoom fills defaults', () => {
  const r = validateNewRoom({ name: ' Hi ' });
  assert.deepEqual([r.name, r.maxPlayers, r.arena.asteroids], ['Hi', 4, 5]);
  assert.throws(() => validateNewRoom([]), HttpError);
});
