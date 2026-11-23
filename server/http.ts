import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LOG_ID } from './log/matchlog.ts';
import { listReplays, streamReplay } from './log/replay.ts';
import { RoomError, RoomManager, type RoomSpec } from './rooms.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { errorCode, describeError, toError } from './errors.ts';

export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export type Headers = Readonly<Record<string, string | number>>;

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly headers: Headers;
  constructor(status: number, message: string, headers: Headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Headers = {},
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

/**
 * Reads the request body, but never more than `limit` bytes: a client that sends a 2 GB body must
 * cost us `limit` bytes of memory, not 2 GB. Content-Length is checked first (cheap, early), and
 * the running total is checked too, because Content-Length can be missing or a lie (chunked).
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (declared > limit)
    return Promise.reject(new HttpError(413, `Body is larger than ${limit} bytes`));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop collecting NOW (memory stays at `limit`), but do not destroy the socket: the 413
        // answer still has to travel back on it. The handler closes the connection afterwards.
        req.off('data', onData);
        req.resume(); // drain and discard the rest of the upload
        chunks.length = 0;
        reject(
          new HttpError(413, `Body is larger than ${limit} bytes`, {
            Connection: 'close',
          }),
        );
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(toError(error)));
  });
}

const intIn = (min: number, max: number, what: string) =>
  z
    .number({ error: `${what}: integer ${min}..${max}` })
    .int(`${what}: integer ${min}..${max}`)
    .min(min, `${what}: integer ${min}..${max}`)
    .max(max, `${what}: integer ${min}..${max}`);

/**
 * POST /api/rooms body. The type of a clean room is DERIVED from this schema, so the validator
 * and the type cannot disagree. Defaults fill what the client left out.
 */
const newRoomSchema = z.object({
  name: z
    .string({ error: 'name: 1-32 characters' })
    .trim()
    .min(1, 'name: 1-32 characters')
    .max(32, 'name: 1-32 characters'),
  maxPlayers: intIn(2, 8, 'maxPlayers').default(4),
  arena: z
    .object({
      asteroids: intIn(0, 40, 'arena.asteroids').default(5),
      pickups: z.boolean({ error: 'arena.pickups: boolean' }).default(true),
      hunterChance: z
        .number({ error: 'arena.hunterChance: number 0..1' })
        .min(0, 'arena.hunterChance: number 0..1')
        .max(1, 'arena.hunterChance: number 0..1')
        .default(0),
      seed: intIn(0, 2 ** 31 - 1, 'arena.seed').default(1),
    })
    .default({ asteroids: 5, pickups: true, hunterChance: 0, seed: 1 }),
});
export type NewRoom = z.infer<typeof newRoomSchema>;

/** `body` is `unknown` (it came from JSON.parse): a clean room, or HttpError(400) listing every problem. */
export function validateNewRoom(body: unknown): NewRoom {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Body must be a JSON object');
  const parsed = newRoomSchema.safeParse(body);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => issue.message);
    throw new HttpError(400, `Invalid room: ${problems.join('; ')}`);
  }
  return parsed.data;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'room';

/** Busy loop on purpose: the event-loop demo of the README. NEVER do this in a real handler. */
export function blockFor(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

/** Hashed build files never change (a new build has new names); the entry points always revalidate. */
export function cacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (pathname === '/' || /\.(html|webmanifest)$|\/sw\.js$/.test(pathname))
    return 'no-cache';
  return 'public, max-age=3600';
}

export interface HandlerDeps {
  config: Config;
  rooms: RoomManager;
  logger: Logger;
  getStats: () => Record<string, unknown>;
  /** /ready: may we send players here? */
  isReady?: () => boolean;
  /** /metrics: the Prometheus text. */
  renderMetrics?: () => string;
  version?: string;
}

export function createHandler({
  config,
  rooms,
  logger,
  getStats,
  isReady = () => true,
  renderMetrics,
  version = 'dev',
}: HandlerDeps) {
  const staticRoot = resolve(config.staticDir);

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // Reject BEFORE touching the disk: `..` segments (also when %-encoded), NUL bytes, backslashes.
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad path encoding');
    }
    if (
      decoded.includes('\0') ||
      decoded.includes('\\') ||
      decoded.split('/').includes('..')
    )
      throw new HttpError(400, 'Bad path');

    let file = resolve(staticRoot, `.${decoded}`);
    // Second line of defence: whatever the path was, the result must still be inside the root.
    if (file !== staticRoot && !file.startsWith(staticRoot + sep))
      throw new HttpError(400, 'Bad path');
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      const rootExists = await stat(staticRoot).catch(() => null);
      if (!rootExists)
        throw new HttpError(
          503,
          'The client is not built yet. Run "npm run build" first.',
        );
      throw new HttpError(404, 'Not found');
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      // Never let the HTTP cache keep the page, the service worker or the manifest: they are what
      // tells the browser that a new version exists. Hashed files in /assets/ never change.
      'Cache-Control': cacheControl(pathname),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(createReadStream(file), res);
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const { pathname } = url;
    const method = req.method ?? 'GET';
    const allow = (...methods: string[]) => {
      if (!methods.includes(method))
        throw new HttpError(405, `Use ${methods.join(' or ')}`, {
          Allow: methods.join(', '),
        });
    };

    // Two different questions, two endpoints (Kubernetes calls them liveness and readiness):
    //   /health  "is the PROCESS alive?"        200 as long as the event loop answers.
    //   /ready   "should I send you PLAYERS?"   503 while shutting down or when full.
    // A load balancer stops routing on /ready; the orchestrator restarts the process on /health.
    if (pathname === '/ready') {
      allow('GET', 'HEAD');
      const ready = isReady();
      return json(res, ready ? 200 : 503, { ready });
    }

    if (pathname === '/metrics') {
      allow('GET', 'HEAD');
      const body = renderMetrics?.() ?? '';
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (pathname === '/health') {
      allow('GET', 'HEAD');
      return json(res, 200, {
        status: 'ok',
        version,
        gitSha: config.gitSha,
        uptimeSec: Math.round(process.uptime()),
        rooms: rooms.size,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        ...getStats(),
      });
    }

    if (pathname === '/api/rooms') {
      allow('GET', 'POST');
      if (method === 'GET') return json(res, 200, { rooms: rooms.list() });
      if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? ''))
        throw new HttpError(415, 'Content-Type must be application/json');
      const raw = await readBody(req, config.maxBodyBytes);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Body is not valid JSON');
      }
      const settings = validateNewRoom(body);
      const id = `${slug(settings.name)}-${randomBytes(2).toString('hex')}`;
      const spec: RoomSpec = { id, ...settings, custom: true };
      const room = rooms.create(spec);
      return json(res, 201, { room: room.toJSON() }, { Location: `/api/rooms/${id}` });
    }

    if (pathname === '/api/slow' && config.enableSlowRoute) {
      allow('GET');
      blockFor(300); // README: the event-loop demo
      return json(res, 200, { blockedMs: 300 });
    }

    if (pathname === '/api/replays') {
      allow('GET');
      return json(res, 200, { replays: await listReplays(config.logDir) });
    }

    const replay = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replay) {
      allow('GET');
      const id = decodeURIComponent(replay[1] ?? '');
      if (!LOG_ID.test(id)) throw new HttpError(400, 'Bad replay id');
      const file = await stat(join(config.logDir, `${id}.ndjson`)).catch(() => null);
      if (!file?.isFile()) throw new HttpError(404, 'No such replay');
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="${id}.ndjson"`,
        'Cache-Control': 'no-store',
      });
      // The file goes to the socket chunk by chunk; when the client is slow, pipeline pauses the
      // file reader (backpressure) and memory stays flat. See "Backpressure" in the README.
      return streamReplay(config.logDir, id, res satisfies Writable);
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API route');
    allow('GET', 'HEAD');
    return serveStatic(req, res, pathname);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      const target = req.url ?? '';
      url = new URL(target, 'http://localhost');
      // `new URL('//x')` would treat x as a host: use only the raw path.
      if (!target.startsWith('/') || target.startsWith('//'))
        throw new Error('bad target');
    } catch {
      return json(res, 400, { error: 'Bad request target' });
    }
    try {
      await route(req, res, url);
    } catch (error) {
      if (res.headersSent) {
        // Mid-stream failure (client went away, disk error): nothing more can be said, just stop.
        if (!res.destroyed) res.destroy();
        if (
          !['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(errorCode(error) ?? '')
        )
          logger.warn('response aborted', {
            url: req.url,
            error: toError(error).message,
          });
        return;
      }
      if (error instanceof HttpError) {
        if (error.status === 413) res.once('finish', () => req.socket.destroySoon());
        return json(res, error.status, { error: error.message }, error.headers);
      }
      if (error instanceof RoomError) {
        const status = error.code === 'too_many_rooms' ? 503 : 409;
        return json(res, status, { error: error.message, code: error.code });
      }
      logger.error('request failed', { url: req.url, error: describeError(error) });
      json(res, 500, { error: 'Internal error' });
    }
  };
}
