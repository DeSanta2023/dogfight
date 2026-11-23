// Run against a RUNNING container:  node graceful-stop-check.mjs http://127.0.0.1:3000 <container-id>
// What the lab asks of `docker stop`:
//   - a connected player is told "going away" (WebSocket close code 1001), not just cut off
//   - the container exits with code 0
//   - in less than 10 seconds (after that Docker sends SIGKILL)
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const [base, container] = process.argv.slice(2);
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws'); // Node 22 has WebSocket built in
const closed = new Promise((resolve) =>
  ws.addEventListener('close', (e) => resolve(e.code)),
);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', () =>
    reject(new Error('cannot connect to the container')),
  );
});
ws.send(
  JSON.stringify({
    v: 1,
    type: 'join',
    room: 'melee',
    name: 'StopCheck',
    format: 'binary',
  }),
);
await new Promise((r) => setTimeout(r, 500));

const t0 = Date.now();
// ASYNC on purpose: a blocking call here would freeze THIS process too, and the player could not
// answer the server's close frame until `docker stop` returned.
await run('docker', ['stop', container]);
const seconds = (Date.now() - t0) / 1000;
const code = await Promise.race([
  closed,
  new Promise((r) => setTimeout(() => r('timeout'), 2000)),
]);
const exit = Number(
  execFileSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', container]).toString(),
);

console.log(
  `docker stop took ${seconds.toFixed(1)} s, player close code ${code}, container exit code ${exit}`,
);
const problems = [];
if (code !== 1001) problems.push(`the player should get close code 1001, got ${code}`);
if (exit !== 0) problems.push(`exit code should be 0, got ${exit}`);
if (seconds >= 10)
  problems.push(`docker stop took ${seconds} s (>= 10 s: Docker would SIGKILL)`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
