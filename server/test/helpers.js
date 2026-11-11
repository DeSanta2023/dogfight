import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';

/** A real server on a free port, a temp log dir, a quiet logger that records what it was told. */
export async function startTestServer(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dogfight-test-'));
  const config = loadConfig({
    PORT: '0',
    LOG_DIR: dir,
    STATIC_DIR: join(dir, 'static'),
    SHUTDOWN_GRACE_MS: '300',
    ...env,
  });
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    sink: (level, line) => lines.push({ level, ...JSON.parse(line) }),
  });
  const app = createApp({ config, logger });
  const { url, port } = await app.start();
  return {
    app,
    config,
    url,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    dir,
    lines,
    async stop() {
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A ws client that remembers every message, so a test can `await client.next('roster')` even if
 * the message arrived a moment before the test asked for it.
 */
export function connect(url) {
  const ws = new WebSocket(url);
  const seen = [];
  const waiting = [];
  const result = { ws, seen, closed: null };
  const check = () => {
    for (const w of [...waiting]) {
      const i = seen.findIndex(
        (m) => m.type === w.type && !m.taken && (!w.pred || w.pred(m)),
      );
      if (i >= 0) {
        seen[i].taken = true;
        waiting.splice(waiting.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(seen[i]);
      }
    }
  };
  ws.on('message', (data) => {
    seen.push(JSON.parse(data.toString()));
    check();
  });
  ws.on('error', () => {});
  result.closedPromise = new Promise((resolve) =>
    ws.on('close', (code, reason) => {
      result.closed = { code, reason: reason.toString() };
      resolve(result.closed);
    }),
  );
  result.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  result.next = (type, { timeout = 2000, pred } = {}) =>
    new Promise((resolve, reject) => {
      const w = { type, pred, resolve };
      w.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(w), 1);
        reject(
          new Error(
            `timed out waiting for "${type}"; got ${JSON.stringify(seen.map((m) => m.type))}`,
          ),
        );
      }, timeout);
      waiting.push(w);
      check();
    });
  result.send = (type, fields = {}) => ws.send(JSON.stringify({ v: 1, type, ...fields }));
  return result;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check()` is truthy (polling), instead of sleeping a guessed time: slow disks and CI are slower than a laptop. */
export async function until(check, { timeout = 5000, every = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`until(): condition not met in ${timeout} ms`);
    await sleep(every);
  }
}
