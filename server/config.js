import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The only place that reads process.env. Everything else gets a validated, typed config object,
 * so a typo like PORT=30o0 fails at start-up with a readable message instead of at 3 a.m. when
 * the first request hits the bad value.
 *
 * Each entry: [env name, default, parser]. A parser returns the value or throws a short reason.
 */
export class ConfigError extends Error {
  name = 'ConfigError';
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const int = (min, max) => (raw) => {
  if (!/^\d+$/.test(raw)) throw new Error(`"${raw}" is not a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${n} is outside ${min}..${max}`);
  return n;
};
const str = (raw) => {
  if (raw.trim() === '') throw new Error('must not be empty');
  return raw;
};
const bool = (raw) => {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`"${raw}" is not 0/1/true/false`);
};
const dir = (raw) => resolve(str(raw));

const SPEC = {
  port: ['PORT', '3000', int(0, 65535)], // 0 = pick a free port (tests)
  host: ['HOST', '127.0.0.1', str],
  logDir: ['LOG_DIR', './logs', dir],
  staticDir: [
    'STATIC_DIR',
    fileURLToPath(new URL('../client/dist', import.meta.url)),
    dir,
  ],
  maxMessageBytes: ['MAX_MESSAGE_BYTES', '2048', int(64, 1_048_576)],
  maxBodyBytes: ['MAX_BODY_BYTES', '4096', int(64, 1_048_576)],
  joinTimeoutMs: ['JOIN_TIMEOUT_MS', '5000', int(10, 600_000)],
  pingIntervalMs: ['PING_INTERVAL_MS', '15000', int(10, 600_000)],
  maxMissedPongs: ['MAX_MISSED_PONGS', '2', int(1, 10)],
  messagesPerSecond: ['MESSAGES_PER_SECOND', '10', int(1, 1000)],
  burst: ['MESSAGE_BURST', '20', int(1, 1000)],
  maxRooms: ['MAX_ROOMS', '50', int(1, 10_000)],
  maxConnections: ['MAX_CONNECTIONS', '200', int(1, 100_000)],
  slowClientBytes: ['SLOW_CLIENT_BYTES', '65536', int(1, 100_000_000)],
  roomIdleMs: ['ROOM_IDLE_MS', '60000', int(10, 86_400_000)],
  enableSlowRoute: ['ENABLE_SLOW_ROUTE', '1', bool],
  shutdownGraceMs: ['SHUTDOWN_GRACE_MS', '3000', int(0, 60_000)],
};

export function loadConfig(env = process.env) {
  const config = {};
  const problems = [];
  for (const [key, [name, fallback, parse]] of Object.entries(SPEC)) {
    const raw = env[name] ?? fallback;
    try {
      config[key] = parse(String(raw));
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}
