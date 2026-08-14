import { kv } from '../../shared/kv';

/**
 * Lightweight messaging presence, backed by the shared KV store (Redis in server/worker, in-memory
 * in dev/test — same posture as rate limiting). A user is "online" while any `/messages` socket
 * they hold refreshes their presence key; the key is TTL'd, so if every socket goes away the user
 * simply expires to offline without needing a reliable disconnect signal (which multi-socket +
 * network drops make unreliable anyway). `lastSeen` is written on disconnect and persists.
 *
 * This is deliberately not a pub/sub presence fabric: the thread header reads presence on load and
 * the client polls it, which is honest ("Active recently") without the fan-out machinery of
 * broadcasting every connect/disconnect to every interested thread.
 */
const ONLINE_TTL_SEC = 60;
const onlineKey = (userId: string) => `presence:on:${userId}`;
const lastSeenKey = (userId: string) => `presence:seen:${userId}`;

export const presence = {
  /** Mark (or refresh) a user online. Called on socket connect and on each heartbeat ping. */
  async touch(userId: string): Promise<void> {
    await kv().set(onlineKey(userId), '1', ONLINE_TTL_SEC);
  },

  /** Record when a user's socket went away, so the header can show "last seen …". */
  async markSeen(userId: string): Promise<void> {
    await kv().set(lastSeenKey(userId), new Date().toISOString());
  },

  /** Resolve online + lastSeen for a set of users in one pass (batched gets). */
  async lookup(userIds: string[]): Promise<Map<string, { online: boolean; lastSeen: string | null }>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const entries = await Promise.all(
      unique.map(async (id) => {
        const [on, seen] = await Promise.all([kv().get(onlineKey(id)), kv().get(lastSeenKey(id))]);
        return [id, { online: on !== null, lastSeen: seen }] as const;
      }),
    );
    return new Map(entries);
  },
};
