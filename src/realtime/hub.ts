import type { Server } from 'socket.io';

/**
 * Realtime emit layer. Services call `realtime.*` to broadcast; the hub fans to the correct
 * Socket.IO namespace/room via the Redis adapter when a server is attached (API process). When no
 * server is attached (worker process or tests) emits are no-ops, except a test sink can capture
 * them. This keeps domain services free of socket wiring and fully testable.
 * See REALTIME_ARCHITECTURE.md §6.
 */
let io: Server | null = null;

export function setRealtimeServer(server: Server | null): void {
  io = server;
}

/** Test hook: capture every emit as (channel, event, payload). */
export type EmitSink = (channel: string, event: string, payload: unknown) => void;
let sink: EmitSink | null = null;
export function setEmitSink(fn: EmitSink | null): void {
  sink = fn;
}

function dispatch(namespace: string, room: string, event: string, payload: unknown): void {
  if (sink) sink(`${namespace}#${room}`, event, payload);
  if (io) io.of(namespace).to(room).emit(event, payload);
}

export const realtime = {
  pinUpdate(cell: string, payload: unknown): void {
    dispatch('/live', `cell:${cell}`, 'pin:update', payload);
  },
  pinRemove(cell: string, sessionId: string): void {
    dispatch('/live', `cell:${cell}`, 'pin:remove', { sessionId });
  },
  queueUpdate(ownerId: string, payload: unknown): void {
    dispatch('/queue', `queue:${ownerId}`, 'queue:update', payload);
  },
  popupDelay(ownerId: string, payload: unknown): void {
    dispatch('/queue', `queue:${ownerId}`, 'popup:delay', payload);
  },
  waveAccepted(userId: string, payload: unknown): void {
    dispatch('/notifications', `user:${userId}`, 'wave:accepted', payload);
  },
  notify(userId: string, payload: unknown): void {
    dispatch('/notifications', `user:${userId}`, 'notify', payload);
  },
  messageNew(threadId: string, payload: unknown): void {
    dispatch('/messages', `thread:${threadId}`, 'message:new', payload);
  },
  /** The other participant read the thread — lets the sender's UI flip its messages to "Seen" live. */
  messageRead(threadId: string, payload: unknown): void {
    dispatch('/messages', `thread:${threadId}`, 'message:read', payload);
  },

  // ─── Delivery (A-7) ───────────────────────────────────────────────────────────────────────
  /**
   * Its own namespace, deliberately. Every emitter above is low-frequency and event-shaped — a pin
   * moves when a vendor moves, a queue updates when someone joins. `deliveryPosition` is the
   * platform's first SUSTAINED stream, and isolating it means it can be rate-limited, sampled, or
   * shed without touching `/live`, `/queue` or `/messages` — which matters, because the map route is
   * already close to its performance budget.
   */

  /** A new offer, fanned to one driver's own room. Never broadcast to a public room. */
  deliveryOffer(driverId: string, payload: unknown): void {
    dispatch('/delivery', `driver:${driverId}`, 'delivery:offer', payload);
  },
  /** Somebody took it — every other driver's card should disappear rather than fail on tap. */
  deliveryClaimed(driverId: string, deliveryId: string): void {
    dispatch('/delivery', `driver:${driverId}`, 'delivery:claimed', { deliveryId });
  },
  /**
   * Courier position, to the watchers of ONE delivery.
   *
   * Room membership is the privacy control: a position must reach the customer of this delivery and
   * nobody else, and only between acceptance and completion. That is enforced server-side at join,
   * never by trusting a client to unsubscribe.
   */
  deliveryPosition(deliveryId: string, payload: unknown): void {
    dispatch('/delivery', `delivery:${deliveryId}`, 'delivery:position', payload);
  },
  deliveryStatus(deliveryId: string, payload: unknown): void {
    dispatch('/delivery', `delivery:${deliveryId}`, 'delivery:status', payload);
  },
};
