/**
 * Logs: one JSON object per line on stdout (stderr for warn/error), written by pino.
 *
 *   {"level":"info","time":"2026-11-22T16:00:00.000Z","msg":"joined","room":"duel","player":"a1b2c3d4"}
 *
 * Why pino and not console.log: it is fast (a log line must not slow the 30 Hz tick down), it
 * writes the SAME shape every time, and `redact` guarantees that a field named password / token /
 * key never reaches the log even if someone passes it by mistake. `child({ room, player })` stamps
 * the room id and the player id on every line of that room or player, so one grep follows a match.
 *
 * `sink` is injectable (tests stay quiet and can assert); without it pino writes SYNCHRONOUSLY to
 * the file descriptor, so nothing is lost when the process exits right after the last line.
 */
import pino from 'pino';

export type Level = 'debug' | 'info' | 'warn' | 'error';

/** Extra fields of one log line: anything JSON can carry. */
export type LogFields = Readonly<Record<string, unknown>>;
export type LogFn = (msg: string, fields?: LogFields) => void;
export interface Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  /** A logger that adds `bindings` (room id, player id, ...) to every line. */
  child(bindings: LogFields): Logger;
}
export type Sink = (level: Level, line: string) => void;

/** Field names that must never be written, at the top level or one level down. */
export const REDACTED_FIELDS = [
  'password',
  'passwd',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'key',
  'authorization',
  'cookie',
] as const;
const REDACT_PATHS = [...REDACTED_FIELDS, ...REDACTED_FIELDS.map((f) => `*.${f}`)];

const LEVEL_NAME = /"level":"(\w+)"/;

export function createLogger({
  level = 'info',
  sink,
}: { level?: string; sink?: Sink } = {}): Logger {
  const options: pino.LoggerOptions = {
    level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) }, // "info", not 30
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    base: null, // no pid / hostname noise: the platform adds its own
  };
  const destination: pino.DestinationStream = sink
    ? {
        write(line) {
          const name = LEVEL_NAME.exec(line)?.[1] as Level | undefined;
          sink(name ?? 'info', line);
        },
      }
    : pino.destination({ fd: 1, sync: true });
  return wrap(pino(options, destination));
}

function wrap(base: pino.Logger): Logger {
  const log =
    (name: Level): LogFn =>
    (msg, fields) => {
      if (fields) base[name](fields, msg);
      else base[name](msg);
    };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (bindings) => wrap(base.child(bindings)),
  };
}
