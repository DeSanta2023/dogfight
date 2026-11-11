/**
 * One JSON object per line on stdout (stderr for warn/error): easy to read by eye, easy to grep,
 * and a log collector can parse it. `sink` is injectable so tests stay quiet and can assert.
 */
import { writeSync } from 'node:fs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', sink } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write =
    sink ?? ((name, line) => writeSync(LEVELS[name] >= LEVELS.warn ? 2 : 1, line)); // sync: nothing is lost on process.exit
  const log =
    (name) =>
    (msg, fields = {}) => {
      if (LEVELS[name] < min) return;
      write(
        name,
        `${JSON.stringify({ t: new Date().toISOString(), level: name, msg, ...fields })}\n`,
      );
    };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}
