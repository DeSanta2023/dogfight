// Lab 04 theory check: who runs first, and is the order stable?
//
//   npm run event-loop-order --workspace server
//
// 1. process.nextTick vs promise microtask vs setTimeout vs setImmediate, from the main module.
// 2. setTimeout(0) vs setImmediate from the MAIN module, 200 runs: the order is NOT guaranteed
//    (it depends on how long process start-up took compared with 1 ms).
// 3. The same pair inside an I/O callback: setImmediate always wins, because the "check" phase
//    comes right after the "poll" phase where the I/O callback ran.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs';

const firstRun = `
  const log = [];
  setTimeout(() => log.push('setTimeout'), 0);
  setImmediate(() => log.push('setImmediate'));
  Promise.resolve().then(() => log.push('promise'));
  process.nextTick(() => log.push('nextTick'));
  queueMicrotask(() => log.push('queueMicrotask'));
  log.push('sync');
  setTimeout(() => console.log(log.join(' > ')), 20);
`;
console.log(
  '1. one run from the main module (microtasks first, nextTick before promises):',
);
console.log(
  '   ' +
    spawnSync(process.execPath, ['-e', firstRun], { encoding: 'utf8' }).stdout.trim(),
);

const probe = `
  setTimeout(() => process.stdout.write('T'), 0);
  setImmediate(() => process.stdout.write('I'));
`;
let timeoutFirst = 0;
const RUNS = 200;
for (let i = 0; i < RUNS; i++) {
  const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).stdout;
  if (out.startsWith('T')) timeoutFirst++;
}
console.log(
  `\n2. setTimeout(0) vs setImmediate from the main module, ${RUNS} fresh processes:\n   timeout first ${timeoutFirst} times, immediate first ${RUNS - timeoutFirst} times  -> not deterministic`,
);

let immediateFirst = 0;
const insideIo = () =>
  new Promise((resolve) => {
    readFile(new URL(import.meta.url), () => {
      let first = null;
      setTimeout(() => (first ??= 'timeout'), 0);
      setImmediate(() => (first ??= 'immediate'));
      setTimeout(() => resolve(first), 10);
    });
  });
for (let i = 0; i < RUNS; i++) if ((await insideIo()) === 'immediate') immediateFirst++;
console.log(
  `\n3. the same pair inside an I/O callback, ${RUNS} runs:\n   immediate first ${immediateFirst} of ${RUNS}  -> deterministic`,
);
