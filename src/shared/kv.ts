import type { Redis } from '../config/redis';

/**
 * Small key/value abstraction backing rate limiting and idempotency. A Redis implementation is
 * used in server/worker; an in-memory fallback keeps app.ts testable without a live Redis and
 * matches the "Redis down → rate limiting degrades, money keeps working" posture
 * (BACKEND_ARCHITECTURE.md §6).
 */
export interface KVStore {
  /** Atomic increment; sets TTL on first write. Returns the new counter value. */
  incrWithTtl(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  /** Set only if absent (NX). Returns true when the value was written. */
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
}

// ─── In-memory fallback (single-process; dev/test only) ────────────────────────────────────
// Methods are async to satisfy the KVStore contract even though the memory backend is synchronous.
/* eslint-disable @typescript-eslint/require-await */
class MemoryStore implements KVStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) {
      this.store.set(key, { value: '1', expiresAt: Date.now() + ttlSec * 1000 });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = String(next);
    return next;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    return true;
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
/* eslint-enable @typescript-eslint/require-await */

// ─── Redis-backed implementation ───────────────────────────────────────────────────────────
class RedisStore implements KVStore {
  constructor(private readonly redis: Redis) {}

  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSec);
    return count;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    const res = await this.redis.set(key, value, 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec) await this.redis.set(key, value, 'EX', ttlSec);
    else await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }
}

// ─── Service locator ───────────────────────────────────────────────────────────────────────
let active: KVStore = new MemoryStore();

export function setKVStore(store: KVStore): void {
  active = store;
}

export function useRedisKV(redis: Redis): void {
  active = new RedisStore(redis);
}

export function kv(): KVStore {
  return active;
}
