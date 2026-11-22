// Lab 07: naive all-pairs collisions vs the spatial hash, on the same random worlds.
//   node perf/scripts/collision-bench.mjs [--label after]
// Entities are circles of Dogfight's real sizes, spread over the real arena.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ARENA } from '@dogfight/shared/arena.ts';
import { createSpatialHash, findCollisions } from '@dogfight/shared/collision.ts';
import { Vector2 } from '@dogfight/shared/vector.ts';

const outDir = fileURLToPath(new URL('../../docs/perf/', import.meta.url));
await mkdir(outDir, { recursive: true });

function world(n, seed) {
  let a = seed;
  const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: n }, () => ({
    solid: true,
    radius: [3, 3, 3, 16, 26, 40, 12][Math.floor(rnd() * 7)],
    pos: new Vector2(rnd() * ARENA.width, rnd() * ARENA.height),
  }));
}
const hash = createSpatialHash();
const rows = [];
for (const n of [16, 32, 64, 128, 256, 512, 1024]) {
  const w = world(n, n);
  const time = (fn) => {
    for (let i = 0; i < 50; i++) fn(w); // warm-up
    const reps = Math.max(20, Math.floor(200000 / n));
    const t0 = performance.now();
    let pairs = 0;
    for (let i = 0; i < reps; i++) pairs = fn(w).length;
    return { ms: (performance.now() - t0) / reps, pairs };
  };
  const naive = time(findCollisions);
  const fast = time(hash);
  rows.push({
    entities: n,
    pairs: naive.pairs,
    samePairs: naive.pairs === fast.pairs,
    naiveMs: +naive.ms.toFixed(4),
    hashMs: +fast.ms.toFixed(4),
    speedup: +(naive.ms / fast.ms).toFixed(2),
  });
}
console.table(rows);
await writeFile(`${outDir}collisions.json`, JSON.stringify(rows, null, 2));
