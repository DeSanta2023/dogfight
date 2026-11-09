import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vite plugin: a tiny stand-in for the real server that arrives in Lab 04.
 *
 *   GET /api/rooms     the room list, read from public/api/rooms.json. The `players` counts
 *                      drift over time so that the lobby's periodic refresh is visible.
 *   any URL ?delay=N   wait N ms before answering. Used to simulate a slow network
 *                      (loading-bar demo, sequential vs concurrent timings, timeouts).
 *   /assets/*, /api/*  a file that does not exist is a real 404. Without this Vite's SPA fallback
 *                      answers 200 with index.html, and "a missing sprite" would never be a 404.
 *
 * Works in `vite` (dev) and `vite preview`. It is not part of the game bundle.
 */
const ROOMS_FILE = fileURLToPath(new URL('../public/api/rooms.json', import.meta.url));

function sleep(ms, req) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    req.on('close', () => {
      clearTimeout(timer); // client gave up (timeout / abort): do not keep the timer alive
      resolve();
    });
  });
}

/** players = base + a small, time-dependent wobble, never above maxPlayers (full rooms stay full). */
function livePlayers(room, index, now = Date.now()) {
  if (room.players >= room.maxPlayers) return room.players;
  const span = Math.min(2, room.maxPlayers - room.players);
  return room.players + ((Math.floor(now / 3000) + index) % (span + 1));
}

const handler = (staticDir) => async (req, res, next) => {
  // `//` or `*` as a request target would make new URL(target, base) throw (it reads `//x` as a
  // host). Parse against a fixed origin and answer 400 instead of crashing the dev server.
  let url;
  try {
    url = new URL(`http://localhost${req.url}`);
  } catch {
    res.statusCode = 400;
    return res.end('Bad request');
  }

  const delay = Number(url.searchParams.get('delay'));
  if (delay > 0) await sleep(Math.min(delay, 30_000), req);
  if (res.destroyed || req.destroyed) return;

  if (url.pathname !== '/api/rooms') {
    if (isMissingStatic(url.pathname, staticDir)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      return res.end(`Not found: ${url.pathname}`);
    }
    return next();
  }

  try {
    const { rooms } = JSON.parse(await readFile(ROOMS_FILE, 'utf8'));
    const live = rooms.map((room, i) => ({ ...room, players: livePlayers(room, i) }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ rooms: live }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error.message) }));
  }
};

/** /assets/* and /api/* must be real files (or the one live endpoint), otherwise 404. */
function isMissingStatic(pathname, staticDir) {
  if (!pathname.startsWith('/assets/') && !pathname.startsWith('/api/')) return false;
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return true; // malformed %-escape
  }
  const file = resolve(staticDir, `.${relative}`);
  if (!file.startsWith(staticDir + sep)) return true; // never look outside the static dir
  return !existsSync(file);
}

export function devApi() {
  return {
    name: 'dogfight-dev-api',
    // NOTE: these must NOT return anything. Vite treats a returned function as a "post hook"
    // and calls it, and `middlewares.use()` returns the connect app itself, which would be
    // called with no request and crash the server at start-up.
    configureServer(server) {
      server.middlewares.use(handler(resolve(server.config.publicDir)));
    },
    configurePreviewServer(server) {
      const { root, build } = server.config;
      server.middlewares.use(handler(resolve(root, build.outDir)));
    },
  };
}
