// Starts the game server as a CHILD PROCESS (so its CPU and memory are its own, like in real life)
// and waits until it prints where it listens.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('./serve.mjs', import.meta.url));

export async function startServer(env = {}, rooms = []) {
  const logDir = await mkdtemp(join(tmpdir(), 'dogfight-perf-'));
  const child = spawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      PORT: '0',
      LOG_DIR: logDir,
      LOG_LEVEL: 'warn',
      PERF_ROOMS: JSON.stringify(rooms),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const found = output.match(/http:\/\/[\d.]+:\d+/);
      if (found) resolve(found[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited (${code}): ${output}`)));
    setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15000);
  });
  return {
    url,
    wsUrl: url.replace('http', 'ws') + '/ws',
    async health() {
      return (await fetch(`${url}/health`)).json();
    },
    stop() {
      child.kill('SIGTERM');
      return new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
