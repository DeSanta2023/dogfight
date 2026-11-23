import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The only place that reads process.env. Everything else gets a validated, typed config object,
 * so a typo like PORT=30o0 fails at start-up with a readable message instead of at 3 a.m. when
 * the first request hits the bad value.
 *
 * Environment variables are ALWAYS strings (or missing): a Zod schema says what each one must
 * look like, converts it, and the `Config` type is derived from that same schema.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const withDefault = <Out>(fallback: string, schema: z.ZodType<Out, string>) =>
  z.string().default(fallback).pipe(schema);

const int = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'is not a whole number')
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, `is outside ${min}..${max}`)
        .max(max, `is outside ${min}..${max}`),
    );
const text = z.string().refine((s) => s.trim() !== '', 'must not be empty');
const dir = text.transform((s) => resolve(s));
const flag = z
  .enum(['1', 'true', '0', 'false'], { error: 'is not 0/1/true/false' })
  .transform((s) => s === '1' || s === 'true');

/** "https://a.example, https://b.example" -> ['https://a.example', 'https://b.example'] (empty = none). */
const originList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z.string().refine((o) => {
        try {
          const u = new URL(o);
          return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o;
        } catch {
          return false;
        }
      }, 'must be an origin like https://game.example (scheme + host, no path, no trailing slash)'),
    ),
  );

const STATIC = fileURLToPath(new URL('../client/dist', import.meta.url));

/** env name -> [config key, schema]. One table, so the name and the type cannot drift apart. */
const envSchema = z.object({
  PORT: withDefault('3000', int(0, 65535)), // 0 = pick a free port (tests)
  HOST: withDefault('127.0.0.1', text),
  LOG_DIR: withDefault('./logs', dir),
  STATIC_DIR: withDefault(STATIC, dir),
  MAX_MESSAGE_BYTES: withDefault('2048', int(64, 1_048_576)),
  MAX_BODY_BYTES: withDefault('4096', int(64, 1_048_576)),
  JOIN_TIMEOUT_MS: withDefault('5000', int(10, 600_000)),
  PING_INTERVAL_MS: withDefault('15000', int(10, 600_000)),
  MAX_MISSED_PONGS: withDefault('2', int(1, 10)),
  MESSAGES_PER_SECOND: withDefault('10', int(1, 1000)),
  MESSAGE_BURST: withDefault('20', int(1, 1000)),
  // Game traffic has its own bucket: 30 inputs/s + 1 ping/s is normal, 90/s leaves room for jitter.
  INPUTS_PER_SECOND: withDefault('90', int(1, 10_000)),
  INPUT_BURST: withDefault('180', int(1, 10_000)),
  MAX_ROOMS: withDefault('50', int(1, 10_000)),
  MAX_CONNECTIONS: withDefault('200', int(1, 100_000)),
  SLOW_CLIENT_BYTES: withDefault('65536', int(1, 100_000_000)),
  ROOM_IDLE_MS: withDefault('60000', int(10, 86_400_000)),
  ENABLE_SLOW_ROUTE: withDefault('1', flag),
  SHUTDOWN_GRACE_MS: withDefault('3000', int(0, 60_000)),
  // Lab 08: the public internet.
  /** Pages that may open a WebSocket. Empty = only the page this server itself serves (same host). */
  ALLOWED_ORIGINS: withDefault('', originList),
  MAX_CONNECTIONS_PER_IP: withDefault('20', int(1, 100_000)),
  /** All players in all rooms together: one Node process only has so much CPU. */
  MAX_PLAYERS: withDefault('200', int(1, 100_000)),
  /** Behind a reverse proxy (Render, Fly, nginx) the client's address is in X-Forwarded-For. */
  TRUST_PROXY: withDefault('0', flag),
  /** The commit this build was made from; the Docker build passes it in. Shown by /health. */
  GIT_SHA: withDefault('dev', text),
});

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logDir: string;
  readonly staticDir: string;
  readonly maxMessageBytes: number;
  readonly maxBodyBytes: number;
  readonly joinTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly maxMissedPongs: number;
  readonly messagesPerSecond: number;
  readonly burst: number;
  readonly inputsPerSecond: number;
  readonly inputBurst: number;
  readonly maxRooms: number;
  readonly maxConnections: number;
  readonly slowClientBytes: number;
  readonly roomIdleMs: number;
  readonly enableSlowRoute: boolean;
  readonly shutdownGraceMs: number;
  readonly allowedOrigins: readonly string[];
  readonly maxConnectionsPerIp: number;
  readonly maxPlayers: number;
  readonly trustProxy: boolean;
  readonly gitSha: string;
}

/** Anything with string values: process.env, or a plain object in a test. */
export type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): Readonly<Config> {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // One line per bad variable, named after the variable the operator has to fix.
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  return Object.freeze({
    port: e.PORT,
    host: e.HOST,
    logDir: e.LOG_DIR,
    staticDir: e.STATIC_DIR,
    maxMessageBytes: e.MAX_MESSAGE_BYTES,
    maxBodyBytes: e.MAX_BODY_BYTES,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    pingIntervalMs: e.PING_INTERVAL_MS,
    maxMissedPongs: e.MAX_MISSED_PONGS,
    messagesPerSecond: e.MESSAGES_PER_SECOND,
    burst: e.MESSAGE_BURST,
    inputsPerSecond: e.INPUTS_PER_SECOND,
    inputBurst: e.INPUT_BURST,
    maxRooms: e.MAX_ROOMS,
    maxConnections: e.MAX_CONNECTIONS,
    slowClientBytes: e.SLOW_CLIENT_BYTES,
    roomIdleMs: e.ROOM_IDLE_MS,
    enableSlowRoute: e.ENABLE_SLOW_ROUTE,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    allowedOrigins: Object.freeze(e.ALLOWED_ORIGINS),
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    maxPlayers: e.MAX_PLAYERS,
    trustProxy: e.TRUST_PROXY,
    gitSha: e.GIT_SHA,
  });
}
