// Lab 07: the simulation alone, no sockets, no browser, no timers. Steps a Game with N players
// as fast as possible and reports time per step and what the garbage collector had to do.
//
//   node perf/scripts/sim-bench.mjs [--label before|after] [--players 16] [--steps 20000]
//
// This is the most RELIABLE before/after number of the lab: nothing else runs, so the result does
// not depend on what the machine was doing (a browser run on a shared CPU is noisy).
import { mkdir, writeFile } from 'node:fs/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createSpatialHash } from '@dogfight/shared/collision.ts';
import { Game } from '@dogfight/shared/game.ts';
import { DT, inputFromBits } from '@dogfight/shared/input.ts';
import { createPilot } from '../lib/bots.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] ?? true]);
    return acc;
  }, []),
);
const label = args.label ?? 'run';
const semi = Number(args.semi ?? 0); // MB; run node with --min/max-semi-space-size=<semi> to use it
const players = Number(args.players ?? 16);
const steps = Number(args.steps ?? 20000);
const outDir = fileURLToPath(new URL('../../docs/perf/', import.meta.url));
await mkdir(outDir, { recursive: true });

const game = new Game({
  seed: 11,
  players: 0,
  cosmetics: args.cosmetics === '1',
  ...(args.collide === 'hash' && { collide: createSpatialHash() }),
  asteroids: 12,
  hunterChance: 0.3,
});
const pilots = [];
for (let slot = 0; slot < players; slot++) {
  game.addPlayer(slot);
  pilots.push(createPilot(100 + slot));
}
const inputs = new Map();
const stepOnce = () => {
  for (let slot = 0; slot < players; slot++)
    inputs.set(slot, inputFromBits(pilots[slot]()));
  game.stepInputs(DT, inputs);
};

for (let i = 0; i < 2000; i++) stepOnce(); // warm-up: let V8 optimise the hot code first

const gcs = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries())
    gcs.push({ kind: e.detail?.kind ?? e.kind, ms: e.duration });
});
observer.observe({ entryTypes: ['gc'] });

const per = new Float64Array(steps);
const heapBefore = process.memoryUsage().heapUsed;
const t0 = performance.now();
let entities = 0;
for (let i = 0; i < steps; i++) {
  const s = performance.now();
  stepOnce();
  per[i] = performance.now() - s;
  if (i % 1000 === 0) entities += game.world.size;
}
const total = performance.now() - t0;
await new Promise((r) => setTimeout(r, 50)); // gc entries are delivered asynchronously
observer.disconnect();

const sorted = Array.from(per).sort((a, b) => a - b);
const q = (p) => sorted[Math.min(steps - 1, Math.floor(p * steps))];
const r = (v) => Math.round(v * 1000) / 1000;
// node: kind 1 = scavenge (minor), 2 = mark-sweep-compact (major), 4 = incremental marking, 8 = weak callbacks
const minor = gcs.filter((g) => g.kind === 1);
const major = gcs.filter((g) => g.kind === 2 || g.kind === 4);
const result = {
  label,
  collide: args.collide ?? 'naive',
  players,
  steps,
  avgEntities: Math.round(entities / Math.ceil(steps / 1000)),
  msPerStep: {
    mean: r(total / steps),
    p50: r(q(0.5)),
    p99: r(q(0.99)),
    max: r(sorted[steps - 1]),
  },
  stepsPerSecond: Math.round((steps / total) * 1000),
  gc: {
    minorCount: minor.length,
    minorTotalMs: r(minor.reduce((a, g) => a + g.ms, 0)),
    majorCount: major.length,
    majorTotalMs: r(major.reduce((a, g) => a + g.ms, 0)),
    maxPauseMs: r(Math.max(0, ...gcs.map((g) => g.ms))),
    gcPer1000Steps: r((gcs.length / steps) * 1000),
  },
  // With the young generation pinned to `semi` MB, every scavenge means ~semi MB were allocated.
  allocKbPerStep: semi ? r((minor.length * semi * 1024) / steps) : null,
  heapDeltaMb: r((process.memoryUsage().heapUsed - heapBefore) / 1048576),
  node: process.version,
};
await writeFile(`${outDir}sim-${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
