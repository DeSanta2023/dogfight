// Lab 03, README part (a): four microtask / task ordering puzzles that run in Node.
// The fifth (requestAnimationFrame) needs a browser: open /puzzles.html while `npm run dev` runs.
//
//   npm run puzzles
//
// Each puzzle has a PREDICTION written before running it. The runner executes the code, prints
// what really happened and exits with code 1 if the prediction was wrong.
import { fileURLToPath } from 'node:url';

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

export const puzzles = [
  {
    id: 1,
    title: '.then chain vs queueMicrotask',
    expected: ['A', 'E', 'B', 'D', 'C'],
    async run(log) {
      log('A');
      Promise.resolve()
        .then(() => log('B'))
        .then(() => log('C'));
      queueMicrotask(() => log('D'));
      log('E');
      await settle();
    },
  },
  {
    id: 2,
    title: 'await inside an async function',
    expected: ['f1', 'g1', 'sync', 'f2', 'p1', 'p2'],
    async run(log) {
      async function g() {
        log('g1');
      }
      async function f() {
        log('f1');
        await g();
        log('f2');
      }
      f();
      Promise.resolve()
        .then(() => log('p1'))
        .then(() => log('p2'));
      log('sync');
      await settle();
    },
  },
  {
    id: 3,
    title: 'setTimeout inside a .then',
    expected: ['S', 'M1', 'M2', 'T1', 'T3', 'T2'],
    async run(log) {
      setTimeout(() => log('T1'), 0);
      Promise.resolve()
        .then(() => {
          log('M1');
          setTimeout(() => log('T2'), 0);
        })
        .then(() => log('M2'));
      setTimeout(() => log('T3'), 0);
      log('S');
      await settle();
    },
  },
  {
    id: 4,
    title: 'returning a promise from an async function costs extra ticks',
    expected: ['a 1', 't1', 't2', 'b 2', 't3'],
    async run(log) {
      async function a() {
        return 1;
      }
      async function b() {
        return Promise.resolve(2);
      }
      a().then((v) => log(`a ${v}`));
      b().then((v) => log(`b ${v}`));
      Promise.resolve()
        .then(() => log('t1'))
        .then(() => log('t2'))
        .then(() => log('t3'));
      await settle();
    },
  },
];

export async function runPuzzle(puzzle) {
  const out = [];
  await puzzle.run((line) => out.push(line));
  return out;
}

// Run as a script (not when imported by the tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = 0;
  for (const puzzle of puzzles) {
    const actual = await runPuzzle(puzzle);
    const ok = JSON.stringify(actual) === JSON.stringify(puzzle.expected);
    if (!ok) failed++;
    console.log(`#${puzzle.id} ${puzzle.title}`);
    console.log(`   prediction  ${puzzle.expected.join(' → ')}`);
    console.log(`   actual      ${actual.join(' → ')}   ${ok ? 'OK' : 'MISMATCH'}`);
  }
  process.exit(failed ? 1 : 0);
}
