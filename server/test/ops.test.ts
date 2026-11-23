// Lab 08: what an operator needs. /health vs /ready, /metrics, Origin, per-IP limit, player limit,
// shutdown order, logs without secrets.
import { test, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createLogger } from '../logger.ts';
import { clientIp, isOriginAllowed } from '../origin.ts';
import { cacheControl } from '../http.ts';
import { loadConfig, ConfigError } from '../config.ts';
import type { Env } from '../config.ts';
import { connect, until, startTestServer, type TestServer } from './helpers.ts';

const servers: TestServer[] = [];
const server = async (env?: Env) => {
  const t = await startTestServer(env);
  servers.push(t);
  return t;
};
afterEach(async () => {
  for (let t = servers.pop(); t; t = servers.pop()) await t.stop();
});

const get = async (t: TestServer, path: string) => fetch(`${t.url}${path}`);

async function joined(t: TestServer, name: string, room = 'quiet-orbit', headers = {}) {
  const c = connect(t.wsUrl);
  void headers;
  await c.opened;
  await c.next('welcome');
  c.send('join', { room, name });
  return c;
}

// ---- /health, /ready ------------------------------------------------------------------------

test('/health says who is running: version and the git commit of the build', async () => {
  const t = await server({ GIT_SHA: 'abc1234' });
  const body = (await (await get(t, '/health')).json()) as Record<string, unknown>;
  expect(body.status).toBe('ok');
  expect(body.gitSha).toBe('abc1234');
  expect(typeof body.version).toBe('string');
});

test('/ready is 200 while we can take players, and 503 when the connection limit is reached', async () => {
  const t = await server({ MAX_CONNECTIONS: '1' });
  expect((await get(t, '/ready')).status).toBe(200);
  const c = connect(t.wsUrl);
  await c.opened;
  await until(async () => (await get(t, '/ready')).status === 503);
  expect((await get(t, '/health')).status).toBe(200); // alive, just not accepting more
  c.ws.close();
});

test('during shutdown: /ready is 503, /health still answers, new sockets are refused, the old one gets 1001', async () => {
  const t = await server({ SHUTDOWN_GRACE_MS: '800' });
  // A client that completes the WebSocket handshake and then ignores everything, so the server
  // has to wait out the grace period (like a phone that went into a tunnel).
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = request(`${t.url}/ws`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (_res, s) => resolve(s));
    req.on('error', reject);
    req.end();
  });
  socket.on('error', () => {});
  await until(() => t.app.ws.clients.size === 1);

  const stopping = t.app.stop();
  await until(async () => (await get(t, '/ready')).status === 503, { timeout: 700 });
  const health = await get(t, '/health');
  expect(health.status).toBe(200);

  const refused = await new Promise<number>((resolve) => {
    const late = new WebSocket(t.wsUrl);
    late.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    late.on('error', () => {});
  });
  expect(refused).toBe(503);

  await stopping;
  socket.destroy();
  servers.pop(); // already stopped; the shared afterEach must not stop it twice
  await import('node:fs/promises').then((fs) =>
    fs.rm(t.dir, { recursive: true, force: true }),
  );
});

test('a connected player is told 1001 (going away) at shutdown', async () => {
  const t = await server({ SHUTDOWN_GRACE_MS: '1000' });
  const c = await joined(t, 'Ace');
  await c.next('joined');
  const stopping = t.app.stop();
  const closed = await c.closedPromise;
  expect(closed.code).toBe(1001);
  await stopping;
  servers.pop();
  await import('node:fs/promises').then((fs) =>
    fs.rm(t.dir, { recursive: true, force: true }),
  );
});

// ---- Origin and limits ----------------------------------------------------------------------

const status = (url: string, headers: Record<string, string>) =>
  new Promise<number | 'open'>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });

test('Origin: nothing configured = only the page this server serves; a foreign page gets 403', async () => {
  const t = await server();
  const host = new URL(t.url).host;
  expect(await status(t.wsUrl, { Origin: `http://${host}` })).toBe('open');
  expect(await status(t.wsUrl, { Origin: 'https://evil.example' })).toBe(403);
  expect(await status(t.wsUrl, { Origin: 'null' })).toBe(403);
  expect(await status(t.wsUrl, {})).toBe('open'); // not a browser: bots and tests send no Origin
  expect(t.app.ws.stats.rejected.origin).toBe(2);
});

test('Origin: ALLOWED_ORIGINS is a whitelist, and the same host is no longer enough', async () => {
  const t = await server({
    ALLOWED_ORIGINS: 'https://game.example, https://www.game.example',
  });
  expect(await status(t.wsUrl, { Origin: 'https://game.example' })).toBe('open');
  expect(await status(t.wsUrl, { Origin: `http://${new URL(t.url).host}` })).toBe(403);
  expect(await status(t.wsUrl, { Origin: 'https://game.example.evil.com' })).toBe(403);
});

test('one address may hold MAX_CONNECTIONS_PER_IP sockets; the next handshake gets 429, and a slot frees up on close', async () => {
  const t = await server({ MAX_CONNECTIONS_PER_IP: '2' });
  const a = connect(t.wsUrl);
  const b = connect(t.wsUrl);
  await Promise.all([a.opened, b.opened]);
  expect(await status(t.wsUrl, {})).toBe(429);
  a.ws.close();
  await b.next('welcome');
  await until(async () => (await status(t.wsUrl, {})) === 'open');
  expect(t.app.ws.stats.rejected.perIp).toBeGreaterThanOrEqual(1);
});

test('MAX_PLAYERS: the player over the limit gets a "server_full" error, not a hang', async () => {
  const t = await server({ MAX_PLAYERS: '1' });
  const a = await joined(t, 'Ace');
  await a.next('joined');
  const b = await joined(t, 'Bolt', 'other-room');
  const error = await b.next('error');
  expect(error.code).toBe('server_full');
});

// ---- /metrics -------------------------------------------------------------------------------

test('/metrics: Prometheus text with players, rooms, messages, bytes, step time, loop utilisation, memory', async () => {
  const t = await server({ GIT_SHA: 'deadbee' });
  const a = await joined(t, 'Ace');
  await a.next('joined');
  await until(() => t.app.ws.stats.snapshots > 3);
  const res = await get(t, '/metrics');
  expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  const text = await res.text();
  const value = (name: string) =>
    Number(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(text)?.[1]);
  expect(value('dogfight_players')).toBe(1);
  expect(value('dogfight_rooms')).toBeGreaterThanOrEqual(1);
  expect(value('dogfight_ws_messages_total')).toBeGreaterThanOrEqual(1);
  expect(value('dogfight_bytes_sent_total')).toBeGreaterThan(0);
  expect(value('dogfight_snapshots_sent_total')).toBeGreaterThan(3);
  expect(value('dogfight_step_ms_p99')).toBeGreaterThanOrEqual(0);
  expect(value('dogfight_tick_rate_hz')).toBeGreaterThan(10);
  expect(value('dogfight_event_loop_utilization')).toBeGreaterThanOrEqual(0);
  expect(value('process_resident_memory_bytes')).toBeGreaterThan(1e6);
  expect(text).toContain('git_sha="deadbee"');
  expect(text).toMatch(/^# TYPE dogfight_bytes_sent_total counter$/m);
  // every sample line is "name value" or "name{labels} value" with a number
  for (const line of text
    .trim()
    .split('\n')
    .filter((l) => !l.startsWith('#')))
    expect(line).toMatch(/^[a-z0-9_]+(\{[^}]*\})? -?\d+(\.\d+)?(e[+-]?\d+)?$/);
});

// ---- pure helpers ---------------------------------------------------------------------------

test('isOriginAllowed: no Origin = allowed; same host; whitelist; garbage = refused', () => {
  expect(isOriginAllowed(undefined, 'a:1', [])).toBe(true);
  expect(isOriginAllowed('http://a:1', 'a:1', [])).toBe(true);
  expect(isOriginAllowed('http://b:1', 'a:1', [])).toBe(false);
  expect(isOriginAllowed('https://x.example', 'a:1', ['https://x.example'])).toBe(true);
  expect(isOriginAllowed('not a url', 'a:1', [])).toBe(false);
  expect(isOriginAllowed('http://a:1', undefined, [])).toBe(false);
});

test('clientIp: the socket address, or the LAST X-Forwarded-For entry (the one OUR proxy added) when trusted', () => {
  const req = (xff?: string) => ({
    headers: xff ? { 'x-forwarded-for': xff } : {},
    socket: { remoteAddress: '10.0.0.1' },
  });
  expect(clientIp(req('1.2.3.4') as never, false)).toBe('10.0.0.1');
  expect(clientIp(req('6.6.6.6, 1.2.3.4') as never, true)).toBe('1.2.3.4'); // the first one is forged by the client
  expect(clientIp(req() as never, true)).toBe('10.0.0.1');
});

test('cache headers: hashed assets are immutable; the page, the manifest and the service worker always revalidate', () => {
  expect(cacheControl('/assets/index-3f9a.js')).toMatch(/immutable/);
  expect(cacheControl('/')).toBe('no-cache');
  expect(cacheControl('/index.html')).toBe('no-cache');
  expect(cacheControl('/sw.js')).toBe('no-cache');
  expect(cacheControl('/manifest.webmanifest')).toBe('no-cache');
  expect(cacheControl('/icons/icon-192.png')).toMatch(/max-age=3600/);
});

// ---- config ---------------------------------------------------------------------------------

test('config: ALLOWED_ORIGINS is a list of real origins; a path, a typo or a trailing slash fails at start-up', () => {
  expect(
    loadConfig({ ALLOWED_ORIGINS: 'https://a.example, http://localhost:5173' })
      .allowedOrigins,
  ).toEqual(['https://a.example', 'http://localhost:5173']);
  expect(loadConfig({}).allowedOrigins).toEqual([]);
  for (const bad of [
    'a.example',
    'https://a.example/',
    'https://a.example/game',
    'ftp://a.example',
  ])
    expect(() => loadConfig({ ALLOWED_ORIGINS: bad }), bad).toThrow(ConfigError);
  expect(() => loadConfig({ MAX_CONNECTIONS_PER_IP: '0' })).toThrow(
    /MAX_CONNECTIONS_PER_IP/,
  );
  expect(() => loadConfig({ MAX_PLAYERS: 'many' })).toThrow(/MAX_PLAYERS/);
  expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
});

// ---- logs -----------------------------------------------------------------------------------

test('logs are JSON lines with the room and the player on them, and secrets never reach the output', () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_level, line) => lines.push(line),
  });
  logger.child({ room: 'duel', player: 'a1b2' }).info('joined', {
    password: 'hunter2',
    token: 't0k',
    nested: { apiKey: 'k', ok: 1 },
  });
  logger.warn('plain');
  const [first, second] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(first).toMatchObject({
    level: 'info',
    msg: 'joined',
    room: 'duel',
    player: 'a1b2',
    password: '[Redacted]',
    token: '[Redacted]',
  });
  expect((first?.nested as Record<string, unknown>).apiKey).toBe('[Redacted]');
  expect((first?.nested as Record<string, unknown>).ok).toBe(1);
  expect(lines.join('')).not.toMatch(/hunter2|t0k/);
  expect(second).toMatchObject({ level: 'warn', msg: 'plain' });
  expect(typeof first?.time).toBe('string');
});
