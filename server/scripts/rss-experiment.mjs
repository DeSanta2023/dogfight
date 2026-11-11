// Lab 04 M3: does streaming a big match log to a SLOW client keep memory flat?
//
//   npm run rss-experiment --workspace server                 # 200 MB log, client reads 25 MB/s
//   npm run rss-experiment --workspace server -- --mb=50 --rate=10
//
// 1. A log of --mb megabytes is WRITTEN through the same Transform -> file pipeline the server uses
//    (honouring write()'s return value / 'drain').
// 2. It is downloaded by a throttled client (--rate MB/s) in two ways, each in its own process so the
//    numbers do not contaminate each other:
//      stream   server/log/replay.js -> pipeline(createReadStream(file), res)   (what the server does)
//      naive    readFile(file) then res.end(buffer)                              (the mistake)
// 3. The process's rss is sampled every 100 ms. Output: a CSV and docs/rss.svg (a plain line chart).
//
// Expected: `stream` stays flat (about one 64 KB chunk plus the socket buffers in flight), `naive`
// climbs by the size of the file, because the whole log sits in memory before the first byte leaves.
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createMatchLog } from '../log/matchlog.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=')),
);
const MB = Number(args.mb ?? 200);
const RATE = Number(args.rate ?? 25); // MB/s the client is willing to read
const SELF = fileURLToPath(import.meta.url);
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

// ---- child: serve one file one way, download it slowly, print rss samples as JSON ---------------
if (process.argv[2] === '--child') {
  const [, , , mode, file] = process.argv;
  const { size } = await stat(file);
  const server = createServer(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': size,
    });
    if (mode === 'naive') res.end(await readFile(file));
    else await pipeline(createReadStream(file), res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const samples = [];
  const t0 = performance.now();
  const sample = () =>
    samples.push([(performance.now() - t0) / 1000, mb(process.memoryUsage().rss)]);
  sample();
  const timer = setInterval(sample, 100);

  await new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${server.address().port}/`, (res) => {
      res.on('data', async (chunk) => {
        res.pause(); // a slow reader: take a chunk, then wait for as long as RATE says it takes
        await sleep((chunk.length / (RATE * 1048576)) * 1000);
        res.resume();
      });
      res.on('end', resolve);
      res.on('error', reject);
    }).on('error', reject);
  });
  clearInterval(timer);
  sample();
  server.close();
  console.log(JSON.stringify(samples));
  process.exit(0);
}

// ---- parent ----------------------------------------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dogfight-rss-'));
console.log(
  `writing a ${MB} MB match log through Transform -> file (backpressure honoured)…`,
);
const log = await createMatchLog(dir, 'big');
const rssWhileWriting = [];
const writeTimer = setInterval(
  () => rssWhileWriting.push(mb(process.memoryUsage().rss)),
  200,
);
const filler = 'x'.repeat(180);
let written = 0;
let drains = 0;
for (let i = 0; written < MB * 1048576; i++) {
  const ok = log.write({ type: 'chat', from: `p${i % 8}`, text: `${filler} #${i}` });
  written += 220;
  if (!ok) {
    drains++; // write() said "buffer full": wait until the file has caught up
    await log.drained();
  }
}
await log.end();
clearInterval(writeTimer);
const { size } = await stat(log.path);
console.log(
  `  done: ${mb(size)} MB on disk; the writer had to wait for 'drain' ${drains} times; rss while writing ${Math.min(...rssWhileWriting)}..${Math.max(...rssWhileWriting)} MB`,
);

function runChild(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SELF, '--child', mode, log.path, `--rate=${RATE}`],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: process.env,
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(JSON.parse(out))
        : reject(new Error(`${mode} exited with ${code}`)),
    );
  });
}

const results = {};
for (const mode of ['stream', 'naive']) {
  console.log(`downloading with "${mode}" at ${RATE} MB/s…`);
  results[mode] = await runChild(mode);
  const rss = results[mode].map(([, v]) => v);
  console.log(
    `  ${mode.padEnd(6)} took ${results[mode].at(-1)[0].toFixed(1)} s   rss min ${Math.min(...rss)} MB   max ${Math.max(...rss)} MB   growth ${(Math.max(...rss) - rss[0]).toFixed(1)} MB`,
  );
}

// CSV + SVG --------------------------------------------------------------------------------------
const outDir = join(dirname(SELF), '..', '..', 'docs');
await mkdir(outDir, { recursive: true });
const rows = ['mode,seconds,rss_mb'];
for (const [mode, s] of Object.entries(results))
  for (const [t, v] of s) rows.push(`${mode},${t.toFixed(2)},${v}`);
await writeFile(join(outDir, 'rss.csv'), `${rows.join('\n')}\n`);
await writeFile(join(outDir, 'rss.svg'), chart(results, MB, RATE));
console.log(`\nwrote docs/rss.csv and docs/rss.svg`);
await rm(dir, { recursive: true, force: true });

function chart(series, fileMb, rate) {
  const W = 760,
    H = 360,
    L = 64,
    R = 24,
    T = 48,
    B = 56;
  const maxT = Math.max(...Object.values(series).map((s) => s.at(-1)[0]));
  const maxV =
    Math.ceil(
      Math.max(
        ...Object.values(series)
          .flat()
          .map(([, v]) => v),
      ) / 50,
    ) * 50;
  const x = (t) => L + (t / maxT) * (W - L - R);
  const y = (v) => H - B - (v / maxV) * (H - T - B);
  const colors = { stream: '#1b9e77', naive: '#d95f02' };
  const labels = {
    stream: 'stream (pipeline + createReadStream)',
    naive: 'naive (readFile, then res.end)',
  };
  const grid = [];
  for (let v = 0; v <= maxV; v += 50)
    grid.push(
      `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#ccc" stroke-width="0.6"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
    );
  const ticks = [];
  const step = maxT > 60 ? 10 : 5;
  for (let t = 0; t <= maxT; t += step)
    ticks.push(`<text x="${x(t)}" y="${H - B + 18}" text-anchor="middle">${t}</text>`);
  const lines = Object.entries(series).map(
    ([mode, s]) =>
      `<polyline fill="none" stroke="${colors[mode]}" stroke-width="2.2" points="${s.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`,
  );
  const legend = Object.keys(series).map(
    (mode, i) =>
      `<rect x="${W - R - 270}" y="${H - B - 70 + i * 20}" width="14" height="4" fill="${colors[mode]}"/><text x="${W - R - 250}" y="${H - B - 64 + i * 20}">${labels[mode]}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12" role="img" aria-label="Server rss while a ${fileMb} MB log is downloaded at ${rate} MB/s">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${L}" y="24" font-size="15" font-weight="600" fill="#222">Server rss while a ${fileMb} MB match log is downloaded at ${rate} MB/s</text>
${grid.join('\n')}
${ticks.join('\n')}
<line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#555"/><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#555"/>
${lines.join('\n')}
${legend.join('\n')}
<text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle" fill="#333">time, seconds</text>
<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#333">rss, MB</text>
</svg>
`;
}
