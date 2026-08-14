import { generateKeyPair, exportPKCS8, importPKCS8, type KeyLike } from 'jose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll } from 'vitest';

/**
 * Global test bootstrap. Runs BEFORE any test-file imports, so it must set the required env vars
 * before src/config/env.ts is evaluated. Provides:
 *   - an in-memory Mongo REPLICA SET (multi-document transactions need it)
 *   - a local RSA keypair wired into the auth verifier, so tests can mint valid tokens without a
 *     remote JWKS endpoint.
 */
const ISSUER = 'https://test.streetserve.local';
const AUDIENCE = 'streetserve-api';

// These MUST be set at module top-level (before test files import src/config/env.ts). The real
// Mongo URI is supplied to connectMongo() explicitly in beforeAll; the placeholder only satisfies
// the boot-time config validation.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://placeholder:27017/streetserve_test';
process.env.AUTH_ISSUER = ISSUER;
process.env.AUTH_AUDIENCE = AUDIENCE;
process.env.AUTH_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.KYC_WEBHOOK_SECRET = 'kyc-test-secret';
process.env.METRICS_ENABLED = 'true';
process.env.OPENAPI_ENABLED = 'true';
// Off in tests: no test asserts throttling, and with it on the money limiter (keyed by IP because
// rateLimit runs before authenticate) accumulates across every onboard call in a file and starts
// 429ing later ones — a flake that only appears when a Redis backend happens to be reachable.
process.env.RATE_LIMIT_ENABLED = 'false';

let replset: MongoMemoryReplSet;
let signingKey: KeyLike;

beforeAll(async () => {
  /**
   * The default launch timeout is 10s, which mongod misses on a loaded or cold machine — every suite
   * then reports its tests as SKIPPED rather than failed, so a run that verified nothing still looks
   * broadly green. The `beforeAll` hook already allows 120s; this lets mongod use it.
   *
   * It has to go on `instanceOpts` — the replica set forwards it per mongod instance, and setting it
   * on `replSet` is accepted silently and then ignored. (`MONGOMS_STARTUP_TIMEOUT`, the obvious
   * guess, is not a real variable in v10 either.)
   */
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 90_000 }],
  });
  const uri = replset.getUri('streetserve_test');

  // Import lazily so env validation has already passed with the placeholder above.
  const { connectMongo } = await import('../src/config/db');
  const { setKeyResolver } = await import('../src/integrations/auth/verifier');

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  setKeyResolver(publicKey);

  await connectMongo(uri);
}, 120_000);

afterAll(async () => {
  const { disconnectMongo } = await import('../src/config/db');
  await disconnectMongo();
  if (replset) await replset.stop();
});

/** Re-export a serialized signing key so helpers in the same worker can sign tokens. */
export function getSigningKey(): KeyLike {
  return signingKey;
}

export const TEST_ISSUER = ISSUER;
export const TEST_AUDIENCE = AUDIENCE;

// Round-trip helper kept for parity with real key handling (unused directly but documents intent).
export async function reimportKey(pkcs8: string): Promise<KeyLike> {
  return importPKCS8(pkcs8, 'RS256');
}
export async function exportKey(key: KeyLike): Promise<string> {
  return exportPKCS8(key);
}
