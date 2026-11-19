import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import type { z } from 'zod';
import { decodeServer, type ServerMessage } from '@dogfight/shared/codec.ts';
import { createApp } from '../app.ts';
import { loadConfig, type Env } from '../config.ts';
import { createLogger, type Level } from '../logger.ts';

/** One log line as the tests see it: the level plus whatever JSON the logger wrote. */
export type LogLine = { level: Level; msg?: string } & Record<string, unknown>;

/** A real server on a free port, a temp log dir, a quiet logger that records what it was told. */
export async function startTestServer(env: Env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dogfight-test-'));
  const config = loadConfig({
    PORT: '0',
    LOG_DIR: dir,
    STATIC_DIR: join(dir, 'static'),
    SHUTDOWN_GRACE_MS: '300',
    ...env,
  });
  const lines: LogLine[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (level, line) => {
      const parsed: unknown = JSON.parse(line);
      lines.push({ level, ...(typeof parsed === 'object' ? parsed : {}) });
    },
  });
  const app = createApp({ config, logger });
  const { url, port } = await app.start();
  return {
    app,
    config,
    url,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    dir,
    lines,
    async stop() {
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A JSON message the server sent. Tests read fields they expect, so the index is open. */
export type Received = { type: string; taken?: boolean } & Record<string, unknown>;
export interface Closed {
  code: number;
  reason: string;
}
export interface NextOptions {
  timeout?: number;
  pred?: (m: Received) => boolean;
}
export interface TestClient {
  readonly ws: WebSocket;
  readonly seen: Received[];
  readonly binary: RawData[];
  closed: Closed | null;
  readonly closedPromise: Promise<Closed>;
  readonly opened: Promise<void>;
  next(type: string, options?: NextOptions): Promise<Received>;
  send(type: string, fields?: Record<string, unknown>): void;
}

interface Waiter {
  type: string;
  pred: ((m: Received) => boolean) | undefined;
  resolve: (m: Received) => void;
  timer?: NodeJS.Timeout;
}

const isReceived = (value: unknown): value is Received =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string';

/**
 * A ws client that remembers every message, so a test can `await client.next('roster')` even if
 * the message arrived a moment before the test asked for it.
 */
export function connect(url: string): TestClient {
  const ws = new WebSocket(url);
  const seen: Received[] = [];
  const binary: RawData[] = []; // game frames (snapshots, pongs) kept apart from the JSON messages
  const waiting: Waiter[] = [];
  const check = () => {
    for (const w of [...waiting]) {
      const message = seen.find(
        (m) => m.type === w.type && !m.taken && (!w.pred || w.pred(m)),
      );
      if (message) {
        message.taken = true;
        waiting.splice(waiting.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(message);
      }
    }
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      binary.push(data);
      return;
    }
    const parsed: unknown = JSON.parse(data.toString());
    if (isReceived(parsed)) seen.push(parsed);
    check();
  });
  ws.on('error', () => {});
  const client: TestClient = {
    ws,
    seen,
    binary,
    closed: null,
    closedPromise: new Promise<Closed>((resolve) =>
      ws.on('close', (code, reason) => {
        client.closed = { code, reason: reason.toString() };
        resolve(client.closed);
      }),
    ),
    opened: new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    }),
    next: (type, { timeout = 2000, pred }: NextOptions = {}) =>
      new Promise<Received>((resolve, reject) => {
        const w: Waiter = { type, pred, resolve };
        w.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(w), 1);
          reject(
            new Error(
              `timed out waiting for "${type}"; got ${JSON.stringify(seen.map((m) => m.type))}`,
            ),
          );
        }, timeout);
        waiting.push(w);
        check();
      }),
    send: (type, fields = {}) => ws.send(JSON.stringify({ v: 1, type, ...fields })),
  };
  return client;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check()` is truthy (polling), instead of sleeping a guessed time: slow disks and CI are slower than a laptop. */
export async function until<T>(
  check: () => T | Promise<T>,
  { timeout = 5000, every = 20 }: { timeout?: number; every?: number } = {},
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`until(): condition not met in ${timeout} ms`);
    await sleep(every);
  }
}

/** A binary frame as bytes (ws hands out a Buffer, an ArrayBuffer or a list of Buffers). */
export function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/** Decode a game frame the server sent. */
export function decodeFrame(data: RawData | undefined): ServerMessage {
  if (!data) throw new Error('no binary frame has arrived yet');
  return decodeServer(toBytes(data));
}

export type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
export type PongMessage = Extract<ServerMessage, { type: 'pong' }>;

/** Decode a frame that must be a snapshot. */
export function snapshotFrom(data: RawData | undefined): SnapshotMessage {
  const message = decodeFrame(data);
  if (message.type !== 'snapshot')
    throw new Error(`expected a snapshot, got ${message.type}`);
  return message;
}

/** `await res.json()` is `any` in lib.dom; this keeps it `unknown` until a schema has checked it. */
export async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await res.json();
  return schema.parse(body);
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;
