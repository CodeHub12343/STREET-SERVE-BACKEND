import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { AI_FREE_REQUESTS_PER_MONTH } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * The AI Marketing Assistant paywall.
 *
 * The plan sold "unlimited AI coaching, pricing and marketing copy" for $19.99/month and nothing
 * read the entitlement: every AI route was open to everyone, so a subscriber received exactly what
 * a non-subscriber already had. These tests are the difference between a plan and a donation.
 */
const app = createApp();
beforeAll(() => setStripeGateway(new FakeStripeGateway()));

/** A metered call. `sales-coaching` is the cheapest of the five — no fixtures, deterministic reply. */
function coach(token: string) {
  return request(app)
    .post('/api/v1/ai/sales-coaching')
    .set(...bearer(token))
    .send({ objection: 'price' });
}

async function seller(prefix: string): Promise<string> {
  await seedUser({ authProviderId: `${prefix}|seller`, roles: ['seller'] });
  return mintToken(`${prefix}|seller`);
}

describe('AI free allowance', () => {
  it('allows exactly the free allowance, then requires the plan', async () => {
    const token = await seller('aiq-limit');

    for (let i = 1; i <= AI_FREE_REQUESTS_PER_MONTH; i += 1) {
      const res = await coach(token);
      expect(res.status).toBe(200);
      // Counted down on every response, not just the last — a seller has to see it running out.
      expect(res.headers['x-ai-quota-remaining']).toBe(
        String(AI_FREE_REQUESTS_PER_MONTH - i),
      );
    }

    const refused = await coach(token);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('AI_QUOTA_EXCEEDED');
    // Its own code, so the client can attach an upgrade CTA to this and not to other refusals.
    expect(refused.body.error.message).toMatch(/AI Marketing Assistant/);
  });

  it('does not meter a subscriber', async () => {
    const token = await seller('aiq-sub');
    await request(app)
      .post('/api/v1/subscriptions')
      .set(...bearer(token))
      .set('Idempotency-Key', 'aiq-sub-1')
      .send({ plan: 'ai_assistant' });

    // Comfortably past the free allowance — the plan's whole promise is that this keeps working.
    for (let i = 0; i < AI_FREE_REQUESTS_PER_MONTH + 3; i += 1) {
      const res = await coach(token);
      expect(res.status).toBe(200);
      expect(res.headers['x-ai-quota-remaining']).toBe('unlimited');
    }
  });

  it('gives the allowance back when the request fails', async () => {
    /**
     * A seller must not lose one of five free suggestions to a rejected request — and a client
     * retrying a failure would otherwise burn the rest of the month in a loop.
     */
    const token = await seller('aiq-refund');

    const bad = await request(app)
      .post('/api/v1/ai/sales-coaching')
      .set(...bearer(token))
      .send({}); // no objection → validation failure
    expect(bad.status).toBe(400);

    const quota = await request(app).get('/api/v1/ai/quota').set(...bearer(token));
    expect(quota.body.data.used).toBe(0);
    expect(quota.body.data.remaining).toBe(AI_FREE_REQUESTS_PER_MONTH);
  });

  it('reports the allowance without spending one', async () => {
    // Asking how many are left must not cost one, and someone who has run out still needs to see it.
    const token = await seller('aiq-status');
    await coach(token);

    const first = await request(app).get('/api/v1/ai/quota').set(...bearer(token));
    expect(first.status).toBe(200);
    expect(first.body.data.used).toBe(1);
    expect(first.body.data.unlimited).toBe(false);
    expect(first.body.data.period).toMatch(/^\d{4}-\d{2}$/);

    const second = await request(app).get('/api/v1/ai/quota').set(...bearer(token));
    expect(second.body.data.used).toBe(1); // unchanged by asking
  });

  it('leaves acting on a recommendation unmetered', async () => {
    /**
     * Accepting is the follow-through of advice already given. Metering it would show a seller a
     * recommendation and then refuse to let them take it — and it would starve the outcome dataset
     * that the forecaster is trained on, which is the opposite of what the platform wants.
     */
    const token = await seller('aiq-accept');
    for (let i = 0; i < AI_FREE_REQUESTS_PER_MONTH; i += 1) await coach(token);
    expect((await coach(token)).status).toBe(403); // exhausted

    const accept = await request(app)
      .post('/api/v1/ai/recommendations/000000000000000000000000/accept')
      .set(...bearer(token))
      .send({});
    // 404 for the unknown id, NOT 403 — it reached the handler rather than being refused for quota.
    expect(accept.status).not.toBe(403);
  });

  it('counts each seller separately', async () => {
    const a = await seller('aiq-a');
    const b = await seller('aiq-b');
    for (let i = 0; i < AI_FREE_REQUESTS_PER_MONTH; i += 1) await coach(a);
    expect((await coach(a)).status).toBe(403);

    // One seller exhausting theirs must not touch anyone else's.
    expect((await coach(b)).status).toBe(200);
  });
});
