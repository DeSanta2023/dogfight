import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { CLOSE, ProtocolError, encode, parseClientMessage, LIMITS } from './protocol.js';
import { RoomError } from './rooms.js';
import { TokenBucket } from './ratelimit.js';
import { Match } from './match.js';
import {
  DecodeError,
  decodeClient,
  encodePong,
  encodePongJson,
  encodeSnapshot,
  encodeSnapshotJson,
} from '@dogfight/shared/codec.js';
import { TICK_HZ } from '@dogfight/shared/input.js';

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
export function safeSend(ws, data, { soft, droppable = false, onDrop = () => {} }) {
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

export function attachWebSocket(httpServer, { config, rooms, logger }) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxMessageBytes, // ws closes with 1009 by itself, before we even parse
  });
  const clients = new Set(); // every open connection
  const sockets = new Map(); // roomId -> Map(playerId -> ws)
  const matches = new Map(); // roomId -> Match (the authoritative game of that room)
  const stats = {
    connected: 0,
    messages: 0,
    dropped: 0,
    closes: {},
    inputs: 0,
    snapshots: 0,
    snapshotBytes: 0,
    badGameFrames: 0,
  };
  const send = (ws, type, fields, droppable = false) =>
    safeSend(ws, encode(type, fields), {
      soft: config.slowClientBytes,
      droppable,
      onDrop: () => stats.dropped++,
    });

  const broadcast = (roomId, type, fields, droppable = false) => {
    for (const ws of sockets.get(roomId)?.values() ?? [])
      send(ws, type, fields, droppable);
  };

  /** One snapshot to one player, in the format that player asked for. Droppable: the next one
   * is 33 ms away, so a slow client simply skips some instead of building a queue. */
  const sendSnapshot = (roomId, slot, snapshot) => {
    for (const ws of sockets.get(roomId)?.values() ?? []) {
      if (ws.conn.slot !== slot) continue;
      const data =
        ws.conn.format === 'json'
          ? encodeSnapshotJson(snapshot)
          : encodeSnapshot(snapshot);
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
    room.on('joined', ({ players }) => broadcast(room.id, 'roster', { players }));
    room.on('left', ({ players }) => broadcast(room.id, 'roster', { players }));
    room.on('chat', ({ from, text, at }) =>
      broadcast(room.id, 'chat', { from, text, at }, true),
    );
  });
  rooms.on('removed', (room) => {
    sockets.delete(room.id);
    matches.get(room.id)?.stop();
    matches.delete(room.id);
  });

  const close = (ws, code, reason) => {
    stats.closes[code] = (stats.closes[code] ?? 0) + 1;
    ws.close(code, reason);
    // A peer that ignores the closing handshake must not keep the socket (and our memory) alive.
    setTimeout(() => ws.terminate(), 1000).unref();
  };

  wss.on('error', (error) => logger.error('wss error', { error: error.message }));

  wss.on('connection', (ws) => {
    // First listener, before anything can go wrong: an 'error' event without a listener is
    // thrown by EventEmitter and would take the whole server down (README: error-crash demo).
    ws.on('error', (error) => logger.warn('socket error', { error: error.message }));

    if (clients.size >= config.maxConnections)
      return close(ws, CLOSE.TRY_LATER, 'server full');

    const conn = {
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
    ws.conn = conn;
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
    const onGameMessage = (message) => {
      if (!conn.room) return close(ws, CLOSE.POLICY, 'join first');
      if (message.type === 'input') {
        stats.inputs++;
        matches.get(conn.room.id)?.input(conn.slot, message.seq, message.bits);
      } else if (message.type === 'ping') {
        const tick = matches.get(conn.room.id)?.tickNumber ?? 0;
        const data =
          conn.format === 'json'
            ? encodePongJson(message.t, tick)
            : encodePong(message.t, tick);
        safeSend(ws, data, { soft: config.slowClientBytes, droppable: true });
      }
    };

    ws.on('message', (raw, isBinary) => {
      stats.messages++;
      if (isBinary) {
        // Binary frames are game traffic only. Own rate limit; the first byte is a version.
        if (!conn.inputBucket.take()) return close(ws, CLOSE.POLICY, 'rate limit');
        if (raw.byteLength > 64) return close(ws, CLOSE.TOO_BIG, 'message too big');
        try {
          return onGameMessage(decodeClient(raw));
        } catch (error) {
          if (!(error instanceof DecodeError)) {
            logger.error('binary handler failed', { id: conn.id, error: error.stack });
            return close(ws, 1011, 'internal error');
          }
          stats.badGameFrames++;
          logger.info('bad binary frame', { id: conn.id, reason: error.message });
          return close(ws, CLOSE.UNSUPPORTED, error.message);
        }
      }
      let message;
      try {
        message = parseClientMessage(raw, isBinary, config.maxMessageBytes);
        // JSON game messages (?format=json) use the game bucket, everything else the chat one.
        const bucket =
          message.type === 'input' || message.type === 'ping'
            ? conn.inputBucket
            : conn.bucket;
        if (!bucket.take()) return close(ws, CLOSE.POLICY, 'rate limit');
        if (bucket === conn.inputBucket) return onGameMessage(message);
      } catch (error) {
        if (!(error instanceof ProtocolError)) {
          logger.error('parse failed', { id: conn.id, error: error.stack });
          return close(ws, 1011, 'internal error');
        }
        logger.info('protocol violation', { id: conn.id, reason: error.reason });
        return close(ws, error.closeCode, error.reason);
      }

      try {
        switch (message.type) {
          case 'join': {
            if (conn.room)
              return send(ws, 'error', {
                code: 'already_joined',
                message: 'Leave first',
              });
            const room = rooms.getOrCreate(message.room);
            room.join({ id: conn.id, name: message.name });
            conn.room = room;
            conn.name = message.name;
            conn.slot = room.slotOf(conn.id);
            conn.format = message.format;
            clearTimeout(joinTimer);
            sockets.get(room.id).set(conn.id, ws);
            // room.join() has already broadcast the new roster to the OTHER sockets; this one gets
            // a personal answer that also carries the room's settings (arena) for the local game.
            send(ws, 'joined', {
              room: room.toJSON(),
              you: conn.id,
              slot: conn.slot,
              tickHz: TICK_HZ,
              format: conn.format,
              players: room.players,
            });
            matches.get(room.id)?.join(conn.slot);
            break;
          }
          case 'chat':
            if (!conn.room)
              return send(ws, 'error', { code: 'not_in_room', message: 'Join first' });
            conn.room.chat(conn.id, message.text);
            break;
          case 'leave':
            leaveRoom();
            break;
        }
      } catch (error) {
        if (error instanceof RoomError) {
          send(ws, 'error', { code: error.code, message: error.message }); // not fatal: stay open
        } else {
          // A bug of ours. Never let it escape the handler: it would be an uncaught exception.
          logger.error('handler failed', { id: conn.id, error: error.stack });
          close(ws, 1011, 'internal error');
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      clients.delete(ws);
      leaveRoom();
    });

    send(ws, 'welcome', {
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
      if (ws.conn.missedPongs >= config.maxMissedPongs) {
        stats.closes[CLOSE.HEARTBEAT] = (stats.closes[CLOSE.HEARTBEAT] ?? 0) + 1;
        logger.info('heartbeat: terminating', { id: ws.conn.id });
        ws.terminate();
        continue;
      }
      ws.conn.missedPongs++;
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
    async shutdown(graceMs) {
      clearInterval(heartbeat);
      for (const match of matches.values()) match.stop();
      for (const ws of clients) ws.close(CLOSE.GOING_AWAY, 'server shutting down');
      await new Promise((resolve) => {
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
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
