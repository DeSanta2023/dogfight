// Lab 08: how many players does ONE process hold, in rooms of the normal size (8 players)?
//   node perf/scripts/rooms-load.mjs [--rooms 1,5,10,25] [--seconds 10] [--label run]
// For every count a fresh server process is started, K rooms are created through the real HTTP API,
// 8 bots fly in each, and the numbers come from the server's own GET /metrics: the same ones an
// operator would watch.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnBots } from '../lib/bots.mjs';
import { startServer } from '../lib/server.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const counts = String(arg('rooms', '1,5,10,25')).split(',').map(Number);
const seconds = Number(arg('seconds', 10));
const label = arg('label', 'run');
const outDir = fileURLToPath(new URL('../../docs/perf/', import.meta.url));
await mkdir(outDir, { recursive: true });

const metric = (text, name) =>
  Number(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(text)?.[1]);
const rows = [];
for (const k of counts) {
  const server = await startServer({
    MAX_ROOMS: '100',
    MAX_CONNECTIONS: '1000',
    MAX_PLAYERS: '1000',
    MAX_CONNECTIONS_PER_IP: '1000',
  });
  const groups = [];
  for (let i = 0; i < k; i++) {
    const res = await fetch(`${server.url}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Load ${i}`,
        maxPlayers: 8,
        arena: { asteroids: 5, seed: i },
      }),
    });
    const { room } = await res.json();
    groups.push(
      await spawnBots({
        url: server.wsUrl,
        room: room.id,
        count: 8,
        prefix: `r${i}b`,
        seed: i + 1,
      }),
    );
  }
  await new Promise((r) => setTimeout(r, (seconds + 3) * 1000));
  const text = await (await fetch(`${server.url}/metrics`)).text();
  rows.push({
    rooms: k,
    players: metric(text, 'dogfight_players'),
    stepMeanMs: metric(text, 'dogfight_step_ms_mean'),
    stepP99Ms: metric(text, 'dogfight_step_ms_p99'),
    tickHzMin: metric(text, 'dogfight_tick_rate_hz'),
    eventLoopUtilization: metric(text, 'dogfight_event_loop_utilization'),
    eventLoopDelayP99Ms: metric(text, 'dogfight_event_loop_delay_p99_ms'),
    kbPerSecond: Math.round(metric(text, 'dogfight_bytes_sent_per_second') / 1024),
    rssMb: Math.round(metric(text, 'process_resident_memory_bytes') / 1048576),
  });
  console.log(rows.at(-1));
  for (const g of groups) g.stop();
  await server.stop();
}
await writeFile(
  `${outDir}rooms-${label}.json`,
  JSON.stringify({ label, seconds, rows }, null, 2),
);
