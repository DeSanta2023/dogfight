/**
 * One JSON object per line on stdout (stderr for warn/error): easy to read by eye, easy to grep,
 * and a log collector can parse it. `sink` is injectable so tests stay quiet and can assert.
 */
import { writeSync } from 'node:fs';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Readonly<Record<Level, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Extra fields of one log line: anything JSON can carry. */
export type LogFields = Readonly<Record<string, unknown>>;
export type LogFn = (msg: string, fields?: LogFields) => void;
export interface Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
}
export type Sink = (level: Level, line: string) => void;

const isLevel = (name: string): name is Level => Object.hasOwn(LEVELS, name);

export function createLogger({
  level = 'info',
  sink,
}: { level?: string; sink?: Sink } = {}): Logger {
  const min = isLevel(level) ? LEVELS[level] : LEVELS.info;
  const write: Sink =
    sink ?? ((name, line) => writeSync(LEVELS[name] >= LEVELS.warn ? 2 : 1, line)); // sync: nothing is lost on process.exit
  const log =
    (name: Level): LogFn =>
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
