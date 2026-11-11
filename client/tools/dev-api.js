import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Vite plugin: dev-only helpers for the Lab 03 loading experiments. (Lab 04 moved the real API
 * to server/: /api and /ws are proxied to it, see vite.config.js.)
 *
 *   any URL ?delay=N   wait N ms before answering. Used to simulate a slow network
 *                      (loading-bar demo, sequential vs concurrent timings, timeouts).
 *   /assets/*          a file that does not exist is a real 404. Without this Vite's SPA fallback
 *                      answers 200 with index.html, and "a missing sprite" would never be a 404.
 *
 * Works in `vite` (dev) and `vite preview`. It is not part of the game bundle.
 */
function sleep(ms, req) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    req.on('close', () => {
      clearTimeout(timer); // client gave up (timeout / abort): do not keep the timer alive
      resolve();
    });
  });
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

  if (isMissingStatic(url.pathname, staticDir)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    return res.end(`Not found: ${url.pathname}`);
  }
  return next();
};

/** /assets/* must be a real file, otherwise 404. */
function isMissingStatic(pathname, staticDir) {
  if (!pathname.startsWith('/assets/')) return false;
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
