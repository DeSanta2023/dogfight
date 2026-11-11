import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

function start(env) {
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  const listening = new Promise((resolve) => {
    const timer = setInterval(() => {
      const m = /"url":"(http:\/\/[^"]+)"/.exec(out);
      if (m) {
        clearInterval(timer);
        resolve(m[1]);
      }
    }, 20);
    timer.unref(); // the bad-config test never prints a URL: do not keep the test process alive
  });
  return { child, exited, listening, output: () => ({ out, err }) };
}

// Windows has no POSIX signals: child.kill('SIGTERM') there is TerminateProcess, an instant kill with
// no chance to shut down. (Ctrl+C in a real terminal does reach the handler; a test cannot send it.)
const NO_SIGNALS =
  process.platform === 'win32' && 'Windows cannot deliver SIGINT/SIGTERM to a child';

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(
    `${signal}: sockets are closed, the log is written, the process exits with code 0`,
    { skip: NO_SIGNALS },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dogfight-proc-'));
      const s = start({ PORT: '0', LOG_DIR: dir, SHUTDOWN_GRACE_MS: '1000' });
      try {
        const url = await s.listening;
        const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
        await new Promise((resolve) => ws.on('open', resolve));
        ws.send(JSON.stringify({ v: 1, type: 'join', room: 'duel', name: 'Ace' }));
        ws.send(JSON.stringify({ v: 1, type: 'chat', text: 'before the end' }));
        await new Promise((r) => setTimeout(r, 150));
        const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
        s.child.kill(signal);
        assert.equal(await closed, 1001);
        assert.deepEqual(await s.exited, { code: 0, signal: null });
        assert.match(s.output().out, /"msg":"bye"/);
        const [file] = await readdir(dir);
        assert.match(await readFile(join(dir, file), 'utf8'), /before the end/);
      } finally {
        s.child.kill('SIGKILL');
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

test('a bad config stops the server at start-up with a readable message and exit code 1', async () => {
  const s = start({ PORT: 'abc', MAX_ROOMS: '0' });
  const { code } = await s.exited;
  assert.equal(code, 1);
  assert.match(s.output().err, /PORT/);
  assert.match(s.output().err, /MAX_ROOMS/);
});
