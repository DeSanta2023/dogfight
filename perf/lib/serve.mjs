// Launcher used by the perf scripts: the real createApp(), plus optional extra room presets
// (PERF_ROOMS='[{"id":"load","name":"Load","maxPlayers":128,"arena":{"asteroids":10}}]') so the
// load test can have a room for 128 players without touching the production presets.
import { createApp } from '../../server/app.ts';
import { loadConfig } from '../../server/config.ts';
import { createLogger } from '../../server/logger.ts';
import { PRESETS } from '../../server/rooms.ts';

const config = loadConfig(process.env);
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'warn' });
const extra = JSON.parse(process.env.PERF_ROOMS ?? '[]');
const app = createApp({ config, logger, presets: [...PRESETS, ...extra] });
const { url } = await app.start();
console.log(`listening ${url}`);
process.on('SIGTERM', () => void app.stop().then(() => process.exit(0)));
process.on('SIGINT', () => void app.stop().then(() => process.exit(0)));
