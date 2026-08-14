import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { errorHandler } from '../src/middleware/errorHandler';
import { idempotency } from '../src/middleware/idempotency';
import { setStripeGateway } from '../src/integrations/stripe';
import { SubscriptionModel } from '../src/modules/subscriptions/subscriptions.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 1.2 — the idempotency middleware.
 *
 * This middleware is the only thing standing between a double-tapped "Pay" button and a double
 * charge, so its failure modes are money failures. Three defects were fixed here and each has a
 * test below that fails against the previous implementation:
 *
 *  1. **check-then-act race** — `get` then a `setNx` whose result was thrown away, so two
 *     concurrent retries could both conclude they were first and both run the handler.
 *  2. **order-dependent body hash** — `JSON.stringify` preserves insertion order, so the same
 *     request serialised with its keys in a different order was rejected as a body mismatch.
 *  3. **failures cached as results** — every response was stored, so a transient 500 was pinned
 *     for the 24h TTL and replayed to the client as a successful idempotent hit.
 *
 * The race is not reproducible through a real money route (its own locking would mask it), so the
 * middleware is exercised directly on a minimal app. The end-to-end section then pins the property
 * that actually matters on a real money-in route: replaying a charge charges once.
 */

// ─── A minimal app carrying just the middleware ────────────────────────────────────────────
type Behaviour = () => Promise<{ status: number; body: unknown }>;

let behaviour: Behaviour;
let handlerCalls = 0;

function harness(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.principal = {
      userId: 'user_idem_harness',
      authProviderId: 'auth_idem_harness',
      roles: ['customer'],
      verificationTier: 'tier0',
      status: 'active',
    };
    next();
  });
  app.post('/thing', idempotency, (req: Request, res: Response, next: NextFunction) => {
    handlerCalls += 1;
    behaviour()
      .then(({ status, body }) => {
        res.status(status).json(body);
      })
      .catch(next);
  });
  app.use(errorHandler);
  return app;
}

const app = harness();

/** Release the reservation between cases: the store is process-wide and keys are per user+key. */
function post(key: string, body: unknown) {
  return request(app)
    .post('/thing')
    .set('Idempotency-Key', key)
    .send(body as object);
}

beforeEach(() => {
  handlerCalls = 0;
  behaviour = () => Promise.resolve({ status: 201, body: { data: { charged: true } } });
});

describe('idempotency · reservation', () => {
  it('runs the handler once and replays the cached response', async () => {
    const first = await post('rep-1', { amount: 100 });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const second = await post('rep-1', { amount: 100 });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);

    expect(handlerCalls).toBe(1);
  });

  /**
   * The regression that matters most: two concurrent retries of the same request must not both
   * reach the handler.
   *
   * This one drives the middleware directly rather than over HTTP. Two supertest requests do NOT
   * reproduce it — the first completes its middleware before the second arrives on the socket, so
   * the interleaving never happens and the test passes against the broken implementation too.
   * Invoking the handler twice without awaiting the first forces the interleaving the old
   * check-then-act ordering was vulnerable to: both read an empty key, both concluded they were
   * first, and both called `next()` — one charge per tap.
   */
  it('lets only one of two interleaved callers through to the handler', async () => {
    let passedThrough = 0;
    const rejections: unknown[] = [];

    function invoke() {
      const req = {
        header: (name: string) => (name.toLowerCase() === 'idempotency-key' ? 'race-1' : undefined),
        principal: {
          userId: 'user_idem_race',
          authProviderId: 'auth_idem_race',
          roles: ['customer'],
          verificationTier: 'tier0',
          status: 'active',
        },
        body: { amount: 100 },
      } as unknown as Request;
      const stub: {
        statusCode: number;
        setHeader: () => void;
        status: (c: number) => unknown;
        json: () => unknown;
      } = {
        statusCode: 200,
        setHeader: () => undefined,
        status: (code: number) => {
          stub.statusCode = code;
          return stub;
        },
        json: () => stub,
      };
      const res = stub as unknown as Response;

      return new Promise<void>((resolve) => {
        void idempotency(req, res, ((err?: unknown) => {
          if (err) rejections.push(err);
          else passedThrough += 1;
          resolve();
        }) as NextFunction);
      });
    }

    // Started together, deliberately not awaited in sequence.
    await Promise.all([invoke(), invoke()]);

    expect(passedThrough).toBe(1);
    expect(rejections).toHaveLength(1);
    expect((rejections[0] as { code?: string }).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects the same key with a genuinely different body', async () => {
    await post('conflict-1', { amount: 100 });
    const res = await post('conflict-1', { amount: 250 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(handlerCalls).toBe(1);
  });

  it('requires the header', async () => {
    const res = await request(app).post('/thing').send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });
});

describe('idempotency · body hashing is order-independent', () => {
  /**
   * Same request, keys serialised in a different order. Previously a 409 the caller could not
   * clear — on an endpoint whose entire purpose is to be safely retried.
   */
  it('treats reordered top-level keys as the same body', async () => {
    const first = await post('order-1', { amount: 100, note: 'hi', plan: 'pro' });
    expect(first.status).toBe(201);

    const second = await post('order-1', { plan: 'pro', note: 'hi', amount: 100 });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(handlerCalls).toBe(1);
  });

  it('treats reordered nested keys as the same body', async () => {
    await post('order-2', { outer: { a: 1, b: { c: 2, d: 3 } } });
    const second = await post('order-2', { outer: { b: { d: 3, c: 2 }, a: 1 } });

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(handlerCalls).toBe(1);
  });

  it('does not reorder arrays — element order is meaningful', async () => {
    await post('order-3', { items: ['a', 'b'] });
    const second = await post('order-3', { items: ['b', 'a'] });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('idempotency · what gets cached', () => {
  /**
   * A client error did nothing, so the key must not stay reserved against an operation that never
   * happened — otherwise a corrected retry is locked out for 24h.
   */
  it('releases the key after a 4xx so a corrected retry can proceed', async () => {
    behaviour = () => Promise.resolve({ status: 400, body: { error: { code: 'VALIDATION' } } });
    const bad = await post('release-1', { amount: -1 });
    expect(bad.status).toBe(400);

    behaviour = () => Promise.resolve({ status: 201, body: { data: { charged: true } } });
    const good = await post('release-1', { amount: 100 });
    expect(good.status).toBe(201);
    expect(good.headers['idempotent-replay']).toBeUndefined();
    expect(handlerCalls).toBe(2);
  });

  /**
   * A 5xx leaves the outcome UNKNOWN — the money may already have moved. The reservation stands,
   * and the retry is refused rather than risking a second attempt. Previously the 500 itself was
   * cached and replayed as though it were the settled answer.
   */
  it('holds the reservation after a 5xx and never replays the error as a result', async () => {
    behaviour = () => Promise.resolve({ status: 500, body: { error: { code: 'INTERNAL' } } });
    const boom = await post('hold-1', { amount: 100 });
    expect(boom.status).toBe(500);

    behaviour = () => Promise.resolve({ status: 201, body: { data: { charged: true } } });
    const retry = await post('hold-1', { amount: 100 });

    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(retry.headers['idempotent-replay']).toBeUndefined();
    // The handler did not get a second chance at an operation whose outcome is unknown.
    expect(handlerCalls).toBe(1);
  });

  it('holds the reservation when the handler throws', async () => {
    behaviour = () => Promise.reject(new Error('kaboom'));
    const boom = await post('hold-2', { amount: 100 });
    expect(boom.status).toBe(500);

    behaviour = () => Promise.resolve({ status: 201, body: { data: { charged: true } } });
    const retry = await post('hold-2', { amount: 100 });
    expect(retry.status).toBe(409);
    expect(handlerCalls).toBe(1);
  });
});

// ─── End-to-end on a real money-in route ────────────────────────────────────────────────────
describe('idempotency · a replayed charge charges once', () => {
  const realApp = createApp();

  it('creates one subscription however many times the request is replayed', async () => {
    setStripeGateway(new FakeStripeGateway());
    const userId = await seedUser({ authProviderId: 'idem_e2e_sub', roles: ['seller'] });
    const token = await mintToken('idem_e2e_sub');

    const send = (body: object) =>
      request(realApp)
        .post('/api/v1/subscriptions')
        .set(...bearer(token))
        .set('Idempotency-Key', 'idem_e2e_plan')
        .send(body);

    // A user-scoped plan: `pro` is business-scoped and would need a business to own.
    const first = await send({ plan: 'seller_plus' });
    expect(first.status).toBe(201);

    const replay = await send({ plan: 'seller_plus' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');

    const subs = await SubscriptionModel.find({
      subscriber_id: userId,
      plan: 'seller_plus',
    }).lean();
    expect(subs).toHaveLength(1);
  });
});
