// Lab 03 M1 "check": the same asset manifest loaded one-after-another vs all at once.
//
//   npm run load-timing [-- --latency=300 --runs=5]
//
// A tiny local HTTP server serves public/ and delays every response by `latency` ms (the same
// `?delay=` convention as tools/dev-api.js), so the numbers come from real requests, not from
// sleeps. Decoding is stubbed (Node has no createImageBitmap / AudioContext); what is measured
// is the thing the lab is about: waiting on the network.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from '../src/assets/loader.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const latency = Number(args.latency ?? 300);
const runs = Number(args.runs ?? 5);

const PUBLIC = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(`http://x${req.url}`);
  await new Promise((r) => setTimeout(r, Number(searchParams.get('delay')) || 0));
  const file = resolve(PUBLIC, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(PUBLIC + sep)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const real = globalThis.fetch;
const fetchImpl = (url, init) => real(new URL(url, base), init);

const { assets: files } = await (await fetchImpl('assets/manifest.json')).json();
const manifest = Object.fromEntries(
  Object.entries(files).map(([id, e]) => [
    id,
    { ...e, url: `${e.url}?delay=${latency}` },
  ]),
);
const count = Object.keys(manifest).length;

// Stand-ins for the browser decoders.
const decodeImage = async (blob) => ({ width: 0, height: 0, size: blob.size });
const ctx = { decodeAudioData: async (buffer) => ({ length: buffer.byteLength }) };

async function timeOnce(concurrent) {
  const t = performance.now();
  const { failed } = await loadAll(manifest, { ctx, decodeImage, fetchImpl, concurrent });
  if (failed.length) throw new Error(`unexpected failures: ${failed.map((f) => f.id)}`);
  return performance.now() - t;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = { sequential: [], concurrent: [] };
await timeOnce(true); // warm-up (module/JIT/connection setup), not counted
for (let i = 0; i < runs; i++) {
  results.sequential.push(await timeOnce(false));
  results.concurrent.push(await timeOnce(true));
}
server.close();

const fmt = (xs) => xs.map((x) => x.toFixed(0)).join(', ');
console.log(
  `${count} assets, ${latency} ms added latency per request, ${runs} runs each\n`,
);
for (const mode of ['sequential', 'concurrent']) {
  console.log(
    `${mode.padEnd(11)} median ${median(results[mode]).toFixed(0).padStart(5)} ms   (runs: ${fmt(results[mode])})`,
  );
}
const speedup = median(results.sequential) / median(results.concurrent);
console.log(
  `\nsequential ≈ ${count} × ${latency} = ${count * latency} ms (the SUM); concurrent ≈ ${latency} ms (the SLOWEST).`,
);
console.log(`concurrent is ${speedup.toFixed(1)}× faster here.`);
