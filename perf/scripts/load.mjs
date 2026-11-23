// Lab 07, part 7: how many players can ONE room hold before a server step no longer fits in the
// 33.3 ms budget (30 ticks per second)?
//
//   node perf/scripts/load.mjs [--label before|after] [--counts 8,32,64,128] [--seconds 10]
//
// For every count a FRESH server process is started, N bots join one room and play for a few
// seconds, then the server's own step timer (Match.stepStats, read from GET /health) is read.
// Results: docs/perf/load-<label>.json and an SVG graph docs/perf/load-<label>.svg.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnBots } from '../lib/bots.mjs';
import { startServer } from '../lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] ?? true]);
    return acc;
  }, []),
);
const label = args.label ?? 'run';
const counts = String(args.counts ?? '8,32,64,128')
  .split(',')
  .map(Number);
const seconds = Number(args.seconds ?? 10);
const BUDGET_MS = 1000 / 30;
const outDir = fileURLToPath(new URL('../../docs/perf/', import.meta.url));
await mkdir(outDir, { recursive: true });

const room = {
  id: 'load',
  name: 'Load',
  maxPlayers: 255,
  arena: { asteroids: 12, pickups: true, hunterChance: 0.3, seed: 7 },
};
const rows = [];
for (const count of counts) {
  const server = await startServer(
    { MAX_CONNECTIONS: '300', MAX_CONNECTIONS_PER_IP: '1000', MAX_PLAYERS: '1000' },
    [room],
  );
  const bots = await spawnBots({ url: server.wsUrl, room: 'load', count });
  await new Promise((r) => setTimeout(r, 3000)); // warm-up: JIT, first snapshots
  // The ring buffer in Match holds the last ~10 s of steps, so it is all measured time by now.
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const health = await server.health();
  const m = health.matches.load;
  rows.push({
    players: count,
    joined: bots.joined,
    hz: m.hz,
    skippedTicks: m.skipped,
    simMeanMs: m.step.sim.mean,
    stepMeanMs: m.step.total.mean,
    stepP50Ms: m.step.total.p50,
    stepP99Ms: m.step.total.p99,
    stepMaxMs: m.step.total.max,
    overBudget: m.step.total.p50 > BUDGET_MS,
    rssMb: health.rssMb,
  });
  console.log(rows.at(-1));
  bots.stop();
  await server.stop();
}

const firstOver = rows.find((r) => r.stepP50Ms > BUDGET_MS)?.players ?? null;
const firstP99Over = rows.find((r) => r.stepP99Ms > BUDGET_MS)?.players ?? null;
const result = {
  label,
  budgetMs: BUDGET_MS,
  seconds,
  rows,
  firstOverBudget: firstOver,
  firstP99OverBudget: firstP99Over,
};
await writeFile(`${outDir}load-${label}.json`, JSON.stringify(result, null, 2));
await writeFile(`${outDir}load-${label}.svg`, chart(rows, label));
console.log(
  `\nfirst count whose MEDIAN step exceeds ${BUDGET_MS.toFixed(1)} ms: ${firstOver ?? 'none'}`,
);
console.log(
  `first count whose p99 step exceeds ${BUDGET_MS.toFixed(1)} ms: ${firstP99Over ?? 'none'}`,
);

/** A small hand-made SVG line chart: players on x (log2), step time on y, the 33.3 ms budget line. */
function chart(rows, title) {
  const W = 640,
    H = 360,
    L = 60,
    R = 20,
    T = 40,
    B = 50;
  const maxY = Math.max(BUDGET_MS * 1.3, ...rows.map((r) => r.stepP99Ms)) * 1.1;
  const xs = rows.map((r) => Math.log2(r.players));
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs);
  const X = (n) => L + ((Math.log2(n) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (v) => H - B - (v / maxY) * (H - T - B);
  const line = (key, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="2" points="${rows.map((r) => `${X(r.players)},${Y(r[key])}`).join(' ')}"/>` +
    rows
      .map(
        (r) => `<circle cx="${X(r.players)}" cy="${Y(r[key])}" r="3.5" fill="${color}"/>`,
      )
      .join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="12">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${L}" y="22" font-size="14" font-weight="600">Server step time vs players in one room (${title})</text>
${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="#e5e7eb"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" fill="#555">${t.toFixed(0)}</text>`).join('')}
${rows.map((r) => `<text x="${X(r.players)}" y="${H - B + 18}" text-anchor="middle" fill="#555">${r.players}</text>`).join('')}
<text x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle" fill="#555">players in the room (log scale)</text>
<text x="14" y="${(T + H - B) / 2}" fill="#555" transform="rotate(-90 14 ${(T + H - B) / 2})" text-anchor="middle">step time, ms</text>
<line x1="${L}" x2="${W - R}" y1="${Y(BUDGET_MS)}" y2="${Y(BUDGET_MS)}" stroke="#dc2626" stroke-dasharray="6 4"/>
<text x="${W - R}" y="${Y(BUDGET_MS) - 6}" text-anchor="end" fill="#dc2626">budget 33.3 ms (30 ticks/s)</text>
${line('stepMeanMs', '#2563eb')}${line('stepP99Ms', '#f59e0b')}
<g transform="translate(${L + 10},${T + 4})"><rect width="150" height="44" fill="#fff" stroke="#e5e7eb"/>
<line x1="8" x2="30" y1="14" y2="14" stroke="#2563eb" stroke-width="2"/><text x="36" y="18">mean step</text>
<line x1="8" x2="30" y1="32" y2="32" stroke="#f59e0b" stroke-width="2"/><text x="36" y="36">p99 step</text></g>
</svg>`;
}
