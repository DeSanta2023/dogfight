import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from './http.ts';
import { createMatchLog, type LogEvent, type MatchLog } from './log/matchlog.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { toError } from './errors.ts';
import { RoomManager } from './rooms.ts';
import { attachWebSocket } from './ws.ts';

/**
 * Builds the whole server from a validated config. It starts nothing by itself and touches no
 * process-wide state (no signal handlers, no process.exit): index.js does that. Tests call this
 * with port 0 and a temp log dir, and many servers can live in one test process.
 *
 * Every room gets a match log: the room's events go through a Transform to an NDJSON file
 * (see log/matchlog.js). The log is closed when the room is removed, and on shutdown.
 */
export interface AppDeps {
  config: Config;
  logger: Logger;
}

export function createApp({ config, logger }: AppDeps) {
  const rooms = new RoomManager({ maxRooms: config.maxRooms, idleMs: config.roomIdleMs });
  const logs = new Map<string, MatchLog>(); // roomId -> match log
  const pendingLogs = new Set<Promise<void>>(); // logs that are being closed: shutdown waits for them
  const closers = new Map<string, () => Promise<void>>(); // roomId -> finishes that room's log

  rooms.on('created', (room) => {
    const id = `${room.id}-${Date.now().toString(36)}`;
    // Every write to this room's log goes through ONE promise chain, so the order of events is the
    // order they happened in, and closing the log (below) waits for the last of them. Without the
    // chain, "room_closed" could be written after the file was already ended and silently lost.
    let chain = createMatchLog(config.logDir, id, {
      onError: (error) =>
        logger.error('match log failed', { room: room.id, error: error.message }),
    }).then((log) => {
      logs.set(room.id, log);
      log.write({ type: 'room_created', room: room.toJSON() });
      return log;
    });
    chain.catch((error: unknown) =>
      logger.error('cannot open match log', {
        room: room.id,
        error: toError(error).message,
      }),
    );
    const record = (event: LogEvent) => {
      chain = chain.then((log) => {
        log.write(event);
        return log;
      });
      chain.catch(() => {}); // already reported once above; never an unhandled rejection
    };
    room.on('joined', ({ player }) => record({ type: 'joined', player }));
    room.on('left', ({ player }) => record({ type: 'left', player }));
    room.on('chat', ({ from, text, at }) => record({ type: 'chat', from, text, at }));
    room.once('empty', () => record({ type: 'room_closed' }));
    closers.set(room.id, async () => {
      // 'removed' is emitted by the manager's own 'empty' listener, which runs BEFORE ours: wait one
      // tick so that the 'room_closed' record has joined the chain, then wait for the whole chain.
      await Promise.resolve();
      const log = await chain; // everything recorded so far has been written
      logs.delete(room.id);
      await log.end();
    });
  });

  rooms.on('removed', (room) => {
    const close = closers.get(room.id);
    closers.delete(room.id);
    if (!close) return;
    const closing = close()
      .catch((error: unknown) =>
        logger.error('closing match log failed', { error: toError(error).message }),
      )
      .finally(() => pendingLogs.delete(closing));
    pendingLogs.add(closing);
  });

  // Filled below: the http handler needs stats from the ws layer, which is built after it.
  const live: { ws?: ReturnType<typeof attachWebSocket> } = {};
  const httpServer = createServer(
    createHandler({
      config,
      rooms,
      logger,
      getStats: () => ({
        ws: live.ws?.stats,
        clients: live.ws?.clients.size,
        // Lab 05: is the game loop really running at 30 steps per second?
        matches: Object.fromEntries(
          [...(live.ws?.matches ?? [])].map(([id, match]) => [id, match.stats()]),
        ),
      }),
    }),
  );
  // Slow-loris protection: a client must finish its request headers quickly.
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 0; // downloads of big replays to slow clients may take long
  httpServer.on('clientError', (error, socket) => {
    logger.warn('client error', { error: error.message });
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  const ws = attachWebSocket(httpServer, { config, rooms, logger });
  live.ws = ws;

  return {
    httpServer,
    rooms,
    ws,
    async start(): Promise<{ port: number; url: string }> {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      const { port } = httpServer.address() as AddressInfo; // listening on a port, so never a pipe path
      return { port, url: `http://${config.host}:${port}` };
    },
    /** Order matters: stop new connections, say goodbye to sockets, close rooms, flush logs. */
    async stop(): Promise<void> {
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections?.();
      await ws.shutdown(config.shutdownGraceMs);
      rooms.closeAll();
      await Promise.all([...pendingLogs]);
      await Promise.all([...logs.values()].map((log) => log.end()));
      httpServer.closeAllConnections?.(); // anything still hanging on (a slow download)
      await closed;
    },
  };
}
