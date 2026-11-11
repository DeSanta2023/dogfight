import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { CLOSE, ProtocolError, encode, parseClientMessage, LIMITS } from './protocol.js';
import { RoomError } from './rooms.js';
import { TokenBucket } from './ratelimit.js';

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
  const stats = { connected: 0, messages: 0, dropped: 0, closes: {} };
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

  // One place wires every room (created now or later) to the sockets that are in it.
  rooms.on('created', (room) => {
    sockets.set(room.id, new Map());
    room.on('joined', ({ players }) => broadcast(room.id, 'roster', { players }));
    room.on('left', ({ players }) => broadcast(room.id, 'roster', { players }));
    room.on('chat', ({ from, text, at }) =>
      broadcast(room.id, 'chat', { from, text, at }, true),
    );
  });
  rooms.on('removed', (room) => sockets.delete(room.id));

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
      missedPongs: 0,
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
      sockets.get(room.id)?.delete(conn.id);
      room.leave(conn.id); // may emit 'left' and 'empty'
    };

    ws.on('message', (raw, isBinary) => {
      stats.messages++;
      if (!conn.bucket.take()) return close(ws, CLOSE.POLICY, 'rate limit');
      let message;
      try {
        message = parseClientMessage(raw, isBinary, config.maxMessageBytes);
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
            clearTimeout(joinTimer);
            sockets.get(room.id).set(conn.id, ws);
            // room.join() has already broadcast the new roster to the OTHER sockets; this one gets
            // a personal answer that also carries the room's settings (arena) for the local game.
            send(ws, 'joined', {
              room: room.toJSON(),
              you: conn.id,
              players: room.players,
            });
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
    /** Graceful: tell every client we are going away, then wait for the sockets to end. */
    async shutdown(graceMs) {
      clearInterval(heartbeat);
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
