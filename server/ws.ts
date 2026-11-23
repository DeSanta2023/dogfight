import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { CLOSE, LIMITS, encode, parseClientMessage } from './protocol.ts';
import type { ServerMessageInput, WireFormat } from '@dogfight/shared/protocol.ts';
import { Room, RoomError, RoomManager } from './rooms.ts';
import { clientIp, isOriginAllowed } from './origin.ts';
import { TokenBucket } from './ratelimit.ts';
import { Match } from './match.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { Snapshot } from '@dogfight/shared/snapshot.ts';
import {
  DecodeError,
  decodeClient,
  encodePong,
  encodePongJson,
  encodeSnapshot,
  encodeSnapshotJson,
} from '@dogfight/shared/codec.ts';
import { TICK_HZ } from '@dogfight/shared/input.ts';
import { assertNever } from '@dogfight/shared/brand.ts';

/** `ws` gives Buffer | ArrayBuffer | Buffer[]; the binary decoder wants one contiguous view. */
function toBytes(raw: RawData): Uint8Array | null {
  if (raw instanceof Buffer) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return null;
}

/**
 * Slow-client policy. ws.send() never blocks: if a client cannot keep up, the bytes pile up in
 * Node's memory as `bufferedAmount`. 30 snapshots/s to a 2G phone would grow that without limit.
 *
 *   bufferedAmount <= soft            send normally
 *   soft < bufferedAmount <= hard     droppable messages (chat) are SKIPPED for this client,
 *                                     important ones (roster, joined, errors) are still sent
 *   bufferedAmount > hard (4 x soft)  the client is not coming back: terminate it
 *
 * Returns 'sent' | 'dropped' | 'closed'.
 */
export type SendResult = 'sent' | 'dropped' | 'closed';
export interface SendOptions {
  soft: number;
  droppable?: boolean;
  onDrop?: () => void;
}

/** The four things safeSend needs from a socket: tests can pass a small fake, no cast. */
export interface SendableSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | ArrayBuffer, cb?: (error?: Error) => void): void;
  terminate(): void;
}

export function safeSend(
  ws: SendableSocket,
  data: string | ArrayBuffer,
  { soft, droppable = false, onDrop = () => {} }: SendOptions,
): SendResult {
  if (ws.readyState !== WebSocket.OPEN) return 'closed';
  const buffered = ws.bufferedAmount;
  if (buffered > soft * 4) {
    ws.terminate();
    return 'closed';
  }
  if (buffered > soft && droppable) {
    onDrop();
    return 'dropped';
  }
  ws.send(data, (error) => {
    if (error) ws.terminate(); // a failed send must never become an unhandled error
  });
  return 'sent';
}

/** Per-connection state. Lives in a Map next to the socket, not as a property glued onto it. */
interface Conn {
  readonly id: string;
  room: Room | null;
  name: string | null;
  slot: number;
  format: WireFormat;
  missedPongs: number;
  readonly inputBucket: TokenBucket;
  readonly bucket: TokenBucket;
}

export interface WsStats {
  connected: number;
  messages: number;
  dropped: number;
  closes: Record<number, number>;
  inputs: number;
  snapshots: number;
  snapshotBytes: number;
  badGameFrames: number;
  /** Handshakes refused before a socket existed: wrong Origin, too many from one address. */
  rejected: { origin: number; perIp: number };
}

export interface WsDeps {
  config: Config;
  rooms: RoomManager;
  logger: Logger;
  /** True once shutdown has begun: the handshake then answers 503 and nobody new gets in. */
  isShuttingDown?: () => boolean;
}

/** An Error is what we expect in a catch; anything else (a thrown string) is still logged. */
const describe = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export function attachWebSocket(
  httpServer: HttpServer,
  { config, rooms, logger, isShuttingDown = () => false }: WsDeps,
) {
  const perIp = new Map<string, number>(); // address -> open connections
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxMessageBytes, // ws closes with 1009 by itself, before we even parse
    // The HANDSHAKE is the cheapest place to say no: no socket object, no timers, no memory.
    verifyClient: ({ req }, done) => {
      const ip = clientIp(req, config.trustProxy);
      const origin = req.headers.origin;
      if (isShuttingDown()) return done(false, 503, 'Shutting down');
      if (!isOriginAllowed(origin, req.headers.host, config.allowedOrigins)) {
        stats.rejected.origin++;
        logger.warn('websocket origin rejected', { origin, ip });
        return done(false, 403, 'Origin not allowed');
      }
      if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
        stats.rejected.perIp++;
        logger.warn('too many connections from one address', { ip });
        return done(false, 429, 'Too many connections');
      }
      done(true);
    },
  });
  const clients = new Set<WebSocket>(); // every open connection
  const conns = new Map<WebSocket, Conn>();
  const sockets = new Map<string, Map<string, WebSocket>>(); // roomId -> playerId -> ws
  const matches = new Map<string, Match>(); // roomId -> the authoritative game of that room
  const stats: WsStats = {
    connected: 0,
    messages: 0,
    dropped: 0,
    closes: {},
    inputs: 0,
    snapshots: 0,
    snapshotBytes: 0,
    badGameFrames: 0,
    rejected: { origin: 0, perIp: 0 },
  };
  const send = (ws: WebSocket, message: ServerMessageInput, droppable = false) =>
    safeSend(ws, encode(message), {
      soft: config.slowClientBytes,
      droppable,
      onDrop: () => stats.dropped++,
    });

  const broadcast = (roomId: string, message: ServerMessageInput, droppable = false) => {
    for (const ws of sockets.get(roomId)?.values() ?? []) send(ws, message, droppable);
  };

  /** One snapshot to one player, in the format that player asked for. Droppable: the next one
   * is 33 ms away, so a slow client simply skips some instead of building a queue. */
  const sendSnapshot = (roomId: string, slot: number, snapshot: Snapshot) => {
    for (const ws of sockets.get(roomId)?.values() ?? []) {
      const conn = conns.get(ws);
      if (!conn || conn.slot !== slot) continue;
      const data =
        conn.format === 'json' ? encodeSnapshotJson(snapshot) : encodeSnapshot(snapshot);
      const result = safeSend(ws, data, {
        soft: config.slowClientBytes,
        droppable: true,
        onDrop: () => stats.dropped++,
      });
      if (result === 'sent') {
        stats.snapshots++;
        stats.snapshotBytes +=
          typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      }
    }
  };

  // One place wires every room (created now or later) to the sockets that are in it.
  rooms.on('created', (room) => {
    sockets.set(room.id, new Map());
    matches.set(
      room.id,
      new Match({
        arena: room.arena,
        onSnapshot: (slot, snapshot) => sendSnapshot(room.id, slot, snapshot),
      }),
    );
    room.on('joined', ({ players }) => broadcast(room.id, { type: 'roster', players }));
    room.on('left', ({ players }) => broadcast(room.id, { type: 'roster', players }));
    room.on('chat', ({ from, text, at }) =>
      broadcast(room.id, { type: 'chat', from, text, at }, true),
    );
  });
  rooms.on('removed', (room) => {
    sockets.delete(room.id);
    matches.get(room.id)?.stop();
    matches.delete(room.id);
  });

  const close = (ws: WebSocket, code: number, reason: string) => {
    stats.closes[code] = (stats.closes[code] ?? 0) + 1;
    ws.close(code, reason);
    // A peer that ignores the closing handshake must not keep the socket (and our memory) alive.
    setTimeout(() => ws.terminate(), 1000).unref();
  };

  wss.on('error', (error) => logger.error('wss error', { error: error.message }));

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req, config.trustProxy);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    // First listener, before anything can go wrong: an 'error' event without a listener is
    // thrown by EventEmitter and would take the whole server down (README: error-crash demo).
    ws.on('error', (error) => logger.warn('socket error', { error: error.message }));

    if (clients.size >= config.maxConnections)
      return close(ws, CLOSE.TRY_LATER, 'server full');

    const conn: Conn = {
      id: randomUUID().slice(0, 8),
      room: null,
      name: null,
      slot: -1,
      format: 'binary',
      missedPongs: 0,
      inputBucket: new TokenBucket({
        perSecond: config.inputsPerSecond,
        burst: config.inputBurst,
      }),
      bucket: new TokenBucket({
        perSecond: config.messagesPerSecond,
        burst: config.burst,
      }),
    };
    conns.set(ws, conn);
    clients.add(ws);
    stats.connected++;

    const joinTimer = setTimeout(() => {
      if (!conn.room) close(ws, CLOSE.JOIN_TIMEOUT, 'join timeout');
    }, config.joinTimeoutMs);

    ws.on('pong', () => {
      conn.missedPongs = 0;
    });

    const leaveRoom = () => {
      if (!conn.room) return;
      const room = conn.room;
      conn.room = null;
      matches.get(room.id)?.leave(conn.slot);
      conn.slot = -1;
      sockets.get(room.id)?.delete(conn.id);
      room.leave(conn.id); // may emit 'left' and 'empty'
    };

    /** Game traffic (input / ping), already decoded: the same code for binary and JSON. */
    const onGameMessage = (
      message:
        | { type: 'input'; seq: number; bits: readonly number[] }
        | { type: 'ping'; t: number },
    ) => {
      const room = conn.room;
      if (!room) return close(ws, CLOSE.POLICY, 'join first');
      switch (message.type) {
        case 'input':
          stats.inputs++;
          matches.get(room.id)?.input(conn.slot, message.seq, message.bits);
          return;
        case 'ping': {
          const tick = matches.get(room.id)?.tickNumber ?? 0;
          const data =
            conn.format === 'json'
              ? encodePongJson(message.t, tick)
              : encodePong(message.t, tick);
          safeSend(ws, data, { soft: config.slowClientBytes, droppable: true });
          return;
        }
        default:
          return assertNever(message);
      }
    };

    /** A binary frame is game traffic only. Own rate limit; the first byte is a version. */
    const onBinary = (raw: RawData) => {
      if (!conn.inputBucket.take()) return close(ws, CLOSE.POLICY, 'rate limit');
      const bytes = toBytes(raw);
      if (bytes === null || bytes.byteLength > 64)
        return close(ws, CLOSE.TOO_BIG, 'message too big');
      try {
        onGameMessage(decodeClient(bytes));
      } catch (error) {
        if (!(error instanceof DecodeError)) {
          logger.error('binary handler failed', { id: conn.id, error: describe(error) });
          return close(ws, CLOSE.INTERNAL, 'internal error');
        }
        stats.badGameFrames++;
        logger.info('bad binary frame', { id: conn.id, reason: error.message });
        return close(ws, CLOSE.UNSUPPORTED, error.message);
      }
    };

    ws.on('message', (raw, isBinary) => {
      stats.messages++;
      if (isBinary) return onBinary(raw);

      // Parsing never throws on a bad frame: it says why, we write it down and close the socket.
      const parsed = parseClientMessage(raw, isBinary, config.maxMessageBytes);
      if (!parsed.ok) {
        logger.info('protocol violation', { id: conn.id, reason: parsed.reason });
        return close(ws, parsed.closeCode, parsed.reason);
      }
      const message = parsed.message;
      // JSON game messages (?format=json) use the game bucket, everything else the chat one.
      const isGame = message.type === 'input' || message.type === 'ping';
      if (!(isGame ? conn.inputBucket : conn.bucket).take())
        return close(ws, CLOSE.POLICY, 'rate limit');

      try {
        switch (message.type) {
          case 'input':
          case 'ping':
            return onGameMessage(message);
          case 'join': {
            if (conn.room)
              return void send(ws, {
                type: 'error',
                code: 'already_joined',
                message: 'Leave first',
              });
            let playing = 0;
            for (const c of conns.values()) if (c.room) playing++;
            if (playing >= config.maxPlayers)
              throw new RoomError('server_full', 'The server is full, try again later');
            const room = rooms.getOrCreate(message.room);
            room.join({ id: conn.id, name: message.name });
            conn.room = room;
            conn.name = message.name;
            conn.slot = room.slotOf(conn.id);
            conn.format = message.format;
            clearTimeout(joinTimer);
            sockets.get(room.id)?.set(conn.id, ws);
            // room.join() has already broadcast the new roster to the OTHER sockets; this one gets
            // a personal answer that also carries the room's settings (arena) for the local game.
            send(ws, {
              type: 'joined',
              room: room.toJSON(),
              you: conn.id,
              slot: conn.slot,
              tickHz: TICK_HZ,
              format: conn.format,
              players: room.players,
            });
            matches.get(room.id)?.join(conn.slot);
            return;
          }
          case 'chat':
            if (!conn.room)
              return void send(ws, {
                type: 'error',
                code: 'not_in_room',
                message: 'Join first',
              });
            conn.room.chat(conn.id, message.text);
            return;
          case 'leave':
            leaveRoom();
            return;
          default:
            // A new message type without a handler stops compiling HERE.
            return assertNever(message);
        }
      } catch (error) {
        if (error instanceof RoomError) {
          send(ws, { type: 'error', code: error.code, message: error.message }); // not fatal
        } else {
          // A bug of ours. Never let it escape the handler: it would be an uncaught exception.
          logger.error('handler failed', { id: conn.id, error: describe(error) });
          close(ws, CLOSE.INTERNAL, 'internal error');
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
      clients.delete(ws);
      leaveRoom();
      conns.delete(ws);
    });

    send(ws, {
      type: 'welcome',
      id: conn.id,
      limits: {
        text: LIMITS.textMax,
        name: LIMITS.nameMax,
        message: config.maxMessageBytes,
      },
    });
  });

  // Heartbeat: one timer for everybody. A client that did not answer the previous ping
  // has missedPongs > 0; after `maxMissedPongs` unanswered pings it is dead (laptop lid closed,
  // phone out of coverage: TCP alone would not notice for minutes).
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      const conn = conns.get(ws);
      if (!conn) continue;
      if (conn.missedPongs >= config.maxMissedPongs) {
        stats.closes[CLOSE.HEARTBEAT] = (stats.closes[CLOSE.HEARTBEAT] ?? 0) + 1;
        logger.info('heartbeat: terminating', { id: conn.id });
        ws.terminate();
        continue;
      }
      conn.missedPongs++;
      ws.ping();
    }
  }, config.pingIntervalMs);
  heartbeat.unref();

  return {
    wss,
    clients,
    stats,
    matches,
    /** Graceful: tell every client we are going away, then wait for the sockets to end. */
    async shutdown(graceMs: number): Promise<void> {
      clearInterval(heartbeat);
      for (const match of matches.values()) match.stop();
      for (const ws of clients) ws.close(CLOSE.GOING_AWAY, 'server shutting down');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const ws of clients) ws.terminate();
          resolve();
        }, graceMs);
        // NOT unref'd: these two timers are what keeps the process alive while we say goodbye.
        const poll = setInterval(() => {
          if (clients.size === 0) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
