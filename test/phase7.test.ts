import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 7: Jobs & Shelter Program. Jobs — post → claim → check-in → check-out → same-day payout.
 * Shelter — admin-verified partner → capped cosign enrollment (Tier-1-equivalent, no KYC) →
 * aggregate privacy-preserving report.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
});

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

async function enablePayouts(ownerType: 'user' | 'business', ownerId: string) {
  const acct = await ConnectedAccountModel.findOne({
    owner_type: ownerType,
    owner_id: ownerId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
}

async function makeVendor(prefix: string): Promise<{ token: string; businessId: string }> {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'services',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Biz`, categoryId: String(cat._id) });
  return { token, businessId: biz.body.data.id as string };
}

describe('Jobs: post → claim → check-in → check-out → same-day payout', () => {
  it('runs the full gig lifecycle and pays the worker on checkout', async () => {
    const { token: vendorToken, businessId } = await makeVendor('p7j');

    const post = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(vendorToken))
      .send({
        title: 'Sign holding',
        lng: -121.0,
        lat: 37.6,
        payCents: 4000,
        payUnit: 'flat',
        businessId,
      });
    expect(post.status).toBe(201);
    const jobId = post.body.data.id as string;

    // A worker with a payout account.
    const workerId = await seedUser({ authProviderId: 'p7j|worker', roles: ['customer'] });
    const worker = await mintToken('p7j|worker');
    await request(app)
      .post('/api/v1/payments/connect/onboard')
      .set(...bearer(worker));
    await enablePayouts('user', workerId);

    // Ranked nearby feed includes the job with an explainable ranking.
    const nearby = await request(app)
      .get('/api/v1/jobs/nearby')
      .query({ lat: 37.6, lng: -121.0 })
      .set(...bearer(worker));
    expect(nearby.status).toBe(200);
    expect(nearby.body.data[0].id).toBe(jobId);
    expect(nearby.body.data[0].reasonSummary).toContain('pay');

    // Claim (self-serve apply/accept).
    const apply = await request(app)
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(...bearer(worker));
    expect(apply.status).toBe(200);
    expect(apply.body.data.status).toBe('accepted');

    // A second worker cannot claim the now-filled job.
    await seedUser({ authProviderId: 'p7j|worker2', roles: ['customer'] });
    const worker2 = await mintToken('p7j|worker2');
    const race = await request(app)
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(...bearer(worker2));
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('JOB_UNAVAILABLE');

    // On-site tap check-in (coords within tolerance).
    const checkIn = await request(app)
      .post(`/api/v1/jobs/${jobId}/check-in`)
      .set(...bearer(worker))
      .send({ lat: 37.6001, lng: -121.0001 });
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.data.status).toBe('checked_in');

    // Check-out → completed + same-day payout transfer to the worker.
    const transfersBefore = fakeStripe.transfers.length;
    const checkOut = await request(app)
      .post(`/api/v1/jobs/${jobId}/check-out`)
      .set(...bearer(worker))
      .set('Idempotency-Key', 'job-checkout-1');
    expect(checkOut.status).toBe(200);
    expect(checkOut.body.data.status).toBe('completed');
    expect(checkOut.body.data.payoutCents).toBe(4000);
    expect(checkOut.body.data.paid).toBe(true);
    expect(fakeStripe.transfers.length).toBe(transfersBefore + 1);
    expect(fakeStripe.transfers[fakeStripe.transfers.length - 1]!.amountCents).toBe(4000);
  });

  it('blocks check-in when the worker is not on-site', async () => {
    const { token: vendorToken, businessId } = await makeVendor('p7j2');
    const post = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(vendorToken))
      .send({ title: 'Delivery', lng: -121.0, lat: 37.6, payCents: 2000, businessId });
    const jobId = post.body.data.id as string;
    await seedUser({ authProviderId: 'p7j2|worker', roles: ['customer'] });
    const worker = await mintToken('p7j2|worker');
    await request(app)
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(...bearer(worker));

    const far = await request(app)
      .post(`/api/v1/jobs/${jobId}/check-in`)
      .set(...bearer(worker))
      .send({ lat: 38.0, lng: -122.0 }); // far away
    expect(far.status).toBe(422);
    expect(far.body.error.code).toBe('NOT_ON_SITE');
  });
});

describe('Shelter Partner Program', () => {
  it('verifies a partner, cosigns a resident into a Tier-1-equivalent, and reports aggregates only', async () => {
    // Admin registers + verifies the partner, granting the shelter-staff owner shelter_admin.
    await seedUser({ authProviderId: 'p7s|admin', roles: ['admin'] });
    const admin = await mintToken('p7s|admin');
    const staffId = await seedUser({ authProviderId: 'p7s|staff', roles: ['customer'] });

    const partner = await request(app)
      .post('/api/v1/shelter-partners')
      .set(...bearer(admin))
      .send({ organizationName: 'Grace Shelter', ownerUserId: staffId });
    expect(partner.status).toBe(201);
    const partnerId = partner.body.data.id as string;

    // The staff owner now holds shelter_admin and can enroll a resident (no prior KYC).
    const staff = await mintToken('p7s|staff');
    const residentId = await seedUser({ authProviderId: 'p7s|resident', roles: ['customer'] });
    const enroll = await request(app)
      .post(`/api/v1/shelter-partners/${partnerId}/enrollments`)
      .set(...bearer(staff))
      .send({
        residentUserId: residentId,
        cosignedAllocationCents: 5000,
        staffVerifierName: 'J. Staff',
      });
    expect(enroll.status).toBe(201);
    expect(enroll.body.data.cosignedAllocationCents).toBe(5000);

    // The resident is now Bronze (shelter-cosigned) and a seller — no ID/bank checks required.
    const resident = await mintToken('p7s|resident');
    const me = await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(resident));
    expect(me.body.data.verificationTier).toBe('bronze');
    expect(me.body.data.roles).toContain('seller');

    // Aggregate, privacy-preserving report — counts + totals, no per-resident rows.
    const report = await request(app)
      .get(`/api/v1/shelter-partners/${partnerId}/reporting`)
      .set(...bearer(staff));
    expect(report.status).toBe(200);
    expect(report.body.data.residentCount).toBe(1);
    expect(report.body.data.totalCosignedCents).toBe(5000);
    expect(report.body.data).not.toHaveProperty('residents');
    expect(report.body.data).not.toHaveProperty('enrollments');

    // A different shelter_admin cannot read this partner's report.
    await seedUser({ authProviderId: 'p7s|otherstaff', roles: ['shelter_admin'] });
    const other = await mintToken('p7s|otherstaff');
    const denied = await request(app)
      .get(`/api/v1/shelter-partners/${partnerId}/reporting`)
      .set(...bearer(other));
    expect(denied.status).toBe(403);
  });

  it('rejects enrollment by a non-admin (only admin registers partners)', async () => {
    await seedUser({ authProviderId: 'p7s2|nonadmin', roles: ['vendor'] });
    const nonAdmin = await mintToken('p7s2|nonadmin');
    const res = await request(app)
      .post('/api/v1/shelter-partners')
      .set(...bearer(nonAdmin))
      .send({ organizationName: 'Fake', ownerUserId: '507f1f77bcf86cd799439011' });
    expect(res.status).toBe(403);
  });
});
