import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LOG_ID } from './log/matchlog.js';
import { listReplays, streamReplay } from './log/replay.js';
import { RoomError } from './rooms.js';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const json = (res, status, body, headers = {}) => {
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
export function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit)
    return Promise.reject(new HttpError(413, `Body is larger than ${limit} bytes`));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
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
    req.on('error', reject);
  });
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** POST /api/rooms body -> clean room settings, or HttpError(400) listing every problem. */
export function validateNewRoom(body) {
  const problems = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Body must be a JSON object');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 32) problems.push('name: 1-32 characters');
  const maxPlayers = body.maxPlayers ?? 4;
  if (!isInt(maxPlayers, 2, 8)) problems.push('maxPlayers: integer 2..8');
  const a = body.arena ?? {};
  if (typeof a !== 'object' || a === null || Array.isArray(a))
    problems.push('arena: object');
  const arena = {
    asteroids: a.asteroids ?? 5,
    pickups: a.pickups ?? true,
    hunterChance: a.hunterChance ?? 0,
    seed: a.seed ?? 1,
  };
  if (!isInt(arena.asteroids, 0, 40)) problems.push('arena.asteroids: integer 0..40');
  if (typeof arena.pickups !== 'boolean') problems.push('arena.pickups: boolean');
  if (
    typeof arena.hunterChance !== 'number' ||
    !(arena.hunterChance >= 0 && arena.hunterChance <= 1)
  )
    problems.push('arena.hunterChance: number 0..1');
  if (!isInt(arena.seed, 0, 2 ** 31 - 1)) problems.push('arena.seed: integer');
  if (problems.length) throw new HttpError(400, `Invalid room: ${problems.join('; ')}`);
  return { name, maxPlayers, arena };
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'room';

/** Busy loop on purpose: the event-loop demo of the README. NEVER do this in a real handler. */
export function blockFor(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

export function createHandler({ config, rooms, logger, getStats }) {
  const staticRoot = resolve(config.staticDir);

  async function serveStatic(req, res, pathname) {
    // Reject BEFORE touching the disk: `..` segments (also when %-encoded), NUL bytes, backslashes.
    let decoded;
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
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(file), res);
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const allow = (...methods) => {
      if (!methods.includes(method))
        throw new HttpError(405, `Use ${methods.join(' or ')}`, {
          Allow: methods.join(', '),
        });
    };

    if (pathname === '/health') {
      allow('GET', 'HEAD');
      return json(res, 200, {
        status: 'ok',
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
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Body is not valid JSON');
      }
      const settings = validateNewRoom(body);
      const id = `${slug(settings.name)}-${randomBytes(2).toString('hex')}`;
      const room = rooms.create({ id, ...settings, custom: true });
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
      const id = decodeURIComponent(replay[1]);
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
      return streamReplay(config.logDir, id, res);
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API route');
    allow('GET', 'HEAD');
    return serveStatic(req, res, pathname);
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      // `new URL('//x')` would treat x as a host: use only the raw path.
      if (!req.url.startsWith('/') || req.url.startsWith('//'))
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
        if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code))
          logger.warn('response aborted', { url: req.url, error: error.message });
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
      logger.error('request failed', { url: req.url, error: error.stack });
      json(res, 500, { error: 'Internal error' });
    }
  };
}
