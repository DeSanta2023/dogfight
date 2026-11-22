// For the defence: the server + 8 bots in the room "Melee", and you open the game yourself.
//   npm run build && node perf/scripts/demo.mjs [--bots 8]
// Then open the printed URL in Chrome, join "Melee", and record DevTools > Performance.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnBots } from '../lib/bots.mjs';
import { startServer } from '../lib/server.mjs';

const i = process.argv.indexOf('--bots');
const count = i > 0 ? Number(process.argv[i + 1]) : 8;
const profileBuild = fileURLToPath(new URL('../../client/dist-profile', import.meta.url));
const server = await startServer({
  PORT: '3000',
  ...(existsSync(profileBuild) ? { STATIC_DIR: profileBuild } : {}),
});
const bots = await spawnBots({ url: server.wsUrl, room: 'melee', count });
console.log(
  `${bots.joined} bots are flying in "Melee".\nOpen ${server.url} and join the room "Melee". Ctrl+C to stop.`,
);
process.on('SIGINT', async () => {
  bots.stop();
  await server.stop();
  process.exit(0);
});
