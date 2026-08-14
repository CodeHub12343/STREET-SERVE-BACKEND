import { LIVE_SESSION_TTL_SEC } from '../../config/constants';
import { kv } from '../../shared/kv';

/**
 * Redis hot mirror of live sessions (via the KV abstraction — Redis in prod, in-memory in tests).
 * Holds just enough to drive low-latency broadcast + cell-change diffing; the durable record is
 * the Mongo live_sessions row. See BACKEND_ARCHITECTURE.md §1 and REALTIME_ARCHITECTURE.md §4.
 */
export interface HotSession {
  cell: string;
  lng: number;
  lat: number;
  status: string;
}

function key(sessionId: string): string {
  return `live:session:${sessionId}`;
}

export const liveStore = {
  async upsert(sessionId: string, s: HotSession): Promise<HotSession | null> {
    const prevRaw = await kv().get(key(sessionId));
    const prev = prevRaw ? (JSON.parse(prevRaw) as HotSession) : null;
    // Short TTL so a crashed producer's pin ages out even without an explicit remove.
    await kv().set(key(sessionId), JSON.stringify(s), LIVE_SESSION_TTL_SEC * 2);
    return prev;
  },
  async get(sessionId: string): Promise<HotSession | null> {
    const raw = await kv().get(key(sessionId));
    return raw ? (JSON.parse(raw) as HotSession) : null;
  },
  async remove(sessionId: string): Promise<HotSession | null> {
    const prev = await this.get(sessionId);
    await kv().del(key(sessionId));
    return prev;
  },
};
