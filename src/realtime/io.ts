import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as HttpServer } from 'node:http';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { verifyToken } from '../integrations/auth/verifier';
import { identityService } from '../modules/identity/identity.service';
import { presence } from '../modules/messaging/presence';
import type { Principal } from '../shared/types/principal';
import { setRealtimeServer } from './hub';

/**
 * Socket.IO server with the Redis adapter (mandatory from day one for multi-instance correctness
 * — REALTIME_ARCHITECTURE.md §1). Phase 0 stands up the server, handshake auth, and the
 * `/notifications` namespace with per-user room authorization as the pattern; later phases add
 * `/live` (geohash cells), `/queue`, and `/messages`.
 */
export interface SocketData {
  principal: Principal;
}

export function createSocketServer(
  httpServer: HttpServer,
  pubClient: Redis,
  subClient: Redis,
): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    adapter: createAdapter(pubClient, subClient),
  });

  // Handshake auth: verify the same access JWT, reject suspended accounts. In Socket.IO v4,
  // `io.use()` runs ONLY for the main namespace — child namespaces (`/messages`, `/notifications`,
  // …) have independent middleware stacks. So this must be registered on each namespace that reads
  // `socket.data.principal`; otherwise the handshake never populates it and the connection handler
  // dereferences `undefined`, crashing the whole process on first connect.
  const authenticate = (socket: Socket, next: (err?: Error) => void): void => {
    const token =
      (socket.handshake.auth as { token?: string } | undefined)?.token ??
      socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('unauthorized'));

    verifyToken(token)
      .then((claims) => identityService.resolvePrincipal(claims))
      .then((principal) => {
        if (principal.status !== 'active') return next(new Error('forbidden'));
        (socket.data as SocketData).principal = principal;
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  };
  io.use(authenticate);

  const notifications = io.of('/notifications');
  notifications.use(authenticate);
  notifications.on('connection', (socket: Socket) => {
    const { principal } = socket.data as SocketData;
    // Defensive: `authenticate` should have rejected any principal-less socket. Never deref it
    // unguarded — a throw here reaches the process-wide uncaughtException handler and downs the server.
    if (!principal) return void socket.disconnect(true);
    // A user may only join their own notification room (room authorization).
    void socket.join(`user:${principal.userId}`);
    logger.debug({ userId: principal.userId }, 'notifications socket connected');
    socket.on('disconnect', () => {
      logger.debug({ userId: principal.userId }, 'notifications socket disconnected');
    });
  });

  // /live: clients subscribe to the geohash cells currently in their map viewport (bounded
  // fan-out). Reads are public-ish; location writes never come from arbitrary clients.
  const live = io.of('/live');
  live.on('connection', (socket: Socket) => {
    socket.on('live:subscribe', (cells: unknown) => {
      if (!Array.isArray(cells)) return;
      for (const cell of cells.slice(0, 64)) {
        if (typeof cell === 'string') void socket.join(`cell:${cell}`);
      }
    });
    socket.on('live:unsubscribe', (cells: unknown) => {
      if (!Array.isArray(cells)) return;
      for (const cell of cells) {
        if (typeof cell === 'string') void socket.leave(`cell:${cell}`);
      }
    });
  });

  // /queue: customers + the owner subscribe to a queue's live position/discount/pop-up updates.
  const queue = io.of('/queue');
  queue.on('connection', (socket: Socket) => {
    socket.on('queue:subscribe', (ownerId: unknown) => {
      if (typeof ownerId === 'string') void socket.join(`queue:${ownerId}`);
    });
  });

  // /messages: thread participants subscribe for live delivery (REST enforces authz on history).
  const messages = io.of('/messages');
  messages.use(authenticate);
  messages.on('connection', (socket: Socket) => {
    const { principal } = socket.data as SocketData;
    if (!principal) return void socket.disconnect(true);
    // Presence: holding a messages socket = online. The heartbeat refreshes the TTL; when the last
    // socket goes quiet the key simply expires. lastSeen is stamped on disconnect.
    void presence.touch(principal.userId);
    socket.on('presence:ping', () => void presence.touch(principal.userId));
    socket.on('messages:subscribe', (threadId: unknown) => {
      if (typeof threadId === 'string') void socket.join(`thread:${threadId}`);
    });
    socket.on('disconnect', () => void presence.markSeen(principal.userId));
  });

  setRealtimeServer(io);
  logger.info('socket.io server initialised');
  return io;
}
