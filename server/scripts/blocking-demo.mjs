// Lab 04, README "event loop": one slow handler freezes EVERY client.
//
//   npm run blocking-demo --workspace server
//
// Three runs against a real server, each with 8 clients asking GET /health every 50 ms for 3 s:
//   1. quiet       nothing else happens                       -> /health answers in ~1 ms
//   2. blocking    a client also calls GET /api/slow          -> that route spins the CPU for 300 ms
//   3. non-blocking the same 300 ms of "work", but as `await sleep(300)` (the thread is free)
// The clients run in a CHILD process: if they lived in the server's own thread they would be frozen
// together with it and could not even notice the freeze.
// The numbers that matter are the SLOWEST /health answers: with a blocked loop they jump to ~300 ms
// even though /health itself does no work.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { createLogger } from '../logger.js';

// ---- client mode: `node blocking-demo.mjs --client <base> <slowCalls>` ---------------------------
if (process.argv[2] === '--client') {
  const [, , , base, slowCalls] = process.argv;
  const latencies = [];
  let stop = false;
  const pollers = Array.from({ length: 8 }, async () => {
    while (!stop) {
      const t = performance.now();
      await (await fetch(`${base}/health`)).text();
      latencies.push(performance.now() - t);
      await sleep(50);
    }
  });
  const slow = (async () => {
    for (let i = 0; i < Number(slowCalls); i++) {
      await sleep(600);
      await fetch(`${base}/api/slow`);
    }
  })();
  await sleep(3000);
  stop = true;
  await Promise.all([...pollers, slow]);
  console.log(JSON.stringify(latencies));
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), 'dogfight-block-'));
const config = loadConfig({ PORT: '0', LOG_DIR: dir, ENABLE_SLOW_ROUTE: '1' });
const app = createApp({ config, logger: createLogger({ level: 'error' }) });
const { url } = await app.start();

// the non-blocking twin of /api/slow, on its own tiny server so http.js stays as it is
const twin = createServer(async (req, res) => {
  if (req.url === '/api/slow') {
    await sleep(300);
    return res.end('{"blockedMs":0}');
  }
  const r = await fetch(`${url}/health`);
  res.end(await r.text());
});
await new Promise((resolve) => twin.listen(0, '127.0.0.1', resolve));
const twinUrl = `http://127.0.0.1:${twin.address().port}`;

function runClients(base, slowCalls) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--client', base, String(slowCalls)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out)));
  });
}

async function run(label, base, slowCalls) {
  const latencies = await runClients(base, slowCalls);
  latencies.sort((a, b) => a - b);
  const q = (p) =>
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  console.log(
    `${label.padEnd(13)} requests ${String(latencies.length).padStart(4)}   p50 ${q(0.5).toFixed(1).padStart(6)} ms   p99 ${q(0.99).toFixed(1).padStart(6)} ms   max ${latencies.at(-1).toFixed(1).padStart(6)} ms`,
  );
}

console.log('GET /health latency seen by 8 polling clients, 3 s per run\n');
await run('quiet', url, 0);
await run('blocking', url, 4);
await run('non-blocking', twinUrl, 4);
console.log(
  '\nblocking: one handler holds the single JS thread for 300 ms, so every other request waits.\nnon-blocking: the same 300 ms as `await sleep()`; the event loop keeps serving /health.',
);

twin.close();
await app.stop();
await rm(dir, { recursive: true, force: true });
