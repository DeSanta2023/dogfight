// Lab 04, README "what if 'error' has no listener": run each case in a CHILD process and show how
// it ends. A crash is the point here, so it must not take this script down with it.
//
//   npm run error-crash --workspace server
import { spawnSync } from 'node:child_process';

const cases = [
  {
    title: "emit('error') with NO listener",
    code: `import { EventEmitter } from 'node:events';
           const room = new EventEmitter();
           room.emit('error', new Error('socket exploded'));
           console.log('still alive');`,
  },
  {
    title: "emit('error') WITH a listener",
    code: `import { EventEmitter } from 'node:events';
           const room = new EventEmitter();
           room.on('error', (e) => console.log('handled:', e.message));
           room.emit('error', new Error('socket exploded'));
           console.log('still alive');`,
  },
  {
    title: 'rejected promise nobody awaits (the Promise equivalent)',
    code: `Promise.reject(new Error('disk full'));
           setTimeout(() => console.log('still alive'), 100);`,
  },
  {
    title: 'the same rejection with .catch / process handler for logging',
    code: `process.on('unhandledRejection', (r) => { console.log('logged:', r.message); process.exit(1); });
           Promise.reject(new Error('disk full'));`,
  },
];

for (const { title, code } of cases) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
  });
  const firstError =
    r.stderr
      .split('\n')
      .find(
        (l) =>
          /^(\w*Error\b|Uncaught|Error \[ERR_|\[Error|node:)/.test(l.trim()) &&
          !l.includes('('),
      ) ??
    r.stderr.split('\n').find((l) => l.includes('Error')) ??
    '';
  console.log(`\n# ${title}`);
  console.log(`  exit code : ${r.status}`);
  console.log(`  stdout    : ${r.stdout.trim() || '(nothing)'}`);
  if (r.status !== 0 && firstError) console.log(`  stderr    : ${firstError.trim()}`);
}
console.log(
  `\nIn server/ws.js every socket gets ws.on('error', ...) as its FIRST listener, and index.js ends\nwith process.on('uncaughtException' / 'unhandledRejection'): log, exit non-zero, let a supervisor restart.`,
);
