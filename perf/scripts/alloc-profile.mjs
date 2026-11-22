// Lab 07: WHO makes the garbage of one simulation step? V8's sampling heap profiler, with the
// objects that were already collected included, attributes every allocation to a function.
//
//   node perf/scripts/alloc-profile.mjs [--label after]      -> docs/perf/alloc-<label>.json
//
// "KB/step" = bytes allocated per tick of a 16-player game (a Map entry, a Vector2, a closure,
// a generator result... all count). Run it before and after a change: lower is better.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector/promises';
import { Game } from '@dogfight/shared/game.ts';
import { DT, inputFromBits } from '@dogfight/shared/input.ts';
const game = new Game({
  seed: 11,
  players: 0,
  cosmetics: false,
  asteroids: 12,
  hunterChance: 0.3,
});
for (let s = 0; s < 16; s++) game.addPlayer(s);
const inputs = new Map();
let tick = 0;
const step = () => {
  tick++;
  for (let s = 0; s < 16; s++)
    inputs.set(
      s,
      inputFromBits(
        ((tick + s * 7) % 80 < 40 ? 1 : 2) | 4 | ((tick + s) % 9 === 0 ? 8 : 0),
      ),
    );
  game.stepInputs(DT, inputs);
};
for (let i = 0; i < 6000; i++) step();
const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');
await session.post('HeapProfiler.startSampling', {
  samplingInterval: 256,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
for (let i = 0; i < 3000; i++) step();
const { profile } = await session.post('HeapProfiler.stopSampling');
const m = new Map();
let tot = 0;
(function w(n) {
  const s = n.selfSize || 0;
  if (s) {
    const f = n.callFrame;
    const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    m.set(k, (m.get(k) || 0) + s);
    tot += s;
  }
  (n.children || []).forEach(w);
})(profile.head);
const label = process.argv[3] ?? 'run';
const top = [...m]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([fn, v]) => ({
    fn,
    kbPerStep: +(v / 3000 / 1024).toFixed(2),
    pct: +((v / tot) * 100).toFixed(1),
  }));
const result = { label, players: 16, kbPerStep: +(tot / 3000 / 1024).toFixed(1), top };
const outDir = fileURLToPath(new URL('../../docs/perf/', import.meta.url));
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}alloc-${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
