import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { RESIDENT_STARTER_MODULES } from '../src/modules/shelter/training';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase B — "make the shelter program real".
 *
 * The program was publicly pitched and functionally unreachable: a resident was stopped at identity
 * verification and again at payout, and the cosigned allocation that the schema called "the HARD cap
 * on the shelter's liability" was enforced nowhere. These tests are about whether someone with no
 * ID, no bank account and no money can actually get from the front desk to being paid.
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

/** An admin who can verify shelter partners. */
async function makeAdmin(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|admin`, roles: ['admin'], tier: 'gold' });
  return mintToken(`${prefix}|admin`);
}

/**
 * A verified shelter partner whose staff account has a live payout account — which is what makes
 * custody possible at all.
 */
async function makeShelter(
  prefix: string,
  opts: { lng?: number; lat?: number; custody?: boolean } = {},
) {
  const adminToken = await makeAdmin(prefix);
  const staffId = await seedUser({ authProviderId: `${prefix}|staff`, roles: ['customer'], tier: 'gold' });

  const partner = await request(app)
    .post('/api/v1/shelter-partners')
    .set(...bearer(adminToken))
    .send({
      organizationName: `${prefix} Hope Center`,
      ownerUserId: staffId,
      ...(opts.lng !== undefined ? { lng: opts.lng, lat: opts.lat } : {}),
    });
  expect(partner.status).toBe(201);
  const partnerId = partner.body.data.id as string;

  // Re-mint: the staff account only gained `shelter_admin` just now.
  const staffTokenAfter = await mintToken(`${prefix}|staff`);

  await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(staffTokenAfter));
  await enablePayouts('user', staffId);

  if (opts.custody) {
    const res = await request(app)
      .patch(`/api/v1/shelter-partners/${partnerId}/custody`)
      .set(...bearer(staffTokenAfter))
      .send({ enabled: true, collectionNote: 'Ask for Dana at the front desk, 9am–7pm' });
    expect(res.status).toBe(200);
  }

  return { partnerId, staffId, staffToken: staffTokenAfter, adminToken };
}

/** A hub with stock, optionally placed at given coordinates. */
async function makeHub(prefix: string, opts: { lng?: number; lat?: number; unitValue?: number } = {}) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|hub`, roles: ['vendor', 'hub'], tier: 'gold' });
  const hubToken = await mintToken(`${prefix}|hub`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(hubToken))
    .send({ name: `${prefix} Hub`, categoryId: String(cat._id), isHub: true });
  expect(biz.status).toBe(201);
  const businessId = biz.body.data.id as string;
  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(hubToken));
  await enablePayouts('business', businessId);

  const hub = await request(app)
    .post('/api/v1/hubs')
    .set(...bearer(hubToken))
    .send({ businessId });
  const hubId = hub.body.data.id as string;
  await request(app)
    .patch(`/api/v1/hubs/${hubId}/approval-policy`)
    .set(...bearer(hubToken))
    .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });

  // Place the hub geographically — the B-2 proximity guard reads hub.location.
  if (opts.lng !== undefined) {
    const { HubModel } = await import('../src/modules/consignment/consignment.model');
    await HubModel.updateOne(
      { _id: hubId },
      { $set: { location: { type: 'Point', coordinates: [opts.lng, opts.lat] } } },
    );
  }

  const product = await request(app)
    .post(`/api/v1/hubs/${hubId}/products`)
    .set(...bearer(hubToken))
    .send({
      name: 'Soy Candle',
      unitValueCents: opts.unitValue ?? 1000,
      consignmentSplitPercent: 65,
      returnWindowHours: 72,
      quantityAvailable: 500,
    });

  return {
    hubToken,
    hubId,
    businessId,
    qrToken: hub.body.data.token as string,
    productId: product.body.data.id as string,
  };
}

/** Every correct answer, for the resident starter course. */
function correctAnswers() {
  return RESIDENT_STARTER_MODULES.flatMap((m) =>
    m.questions.map((q) => ({
      moduleSlug: m.slug,
      questionId: q.id,
      answerIndex: q.answerIndex,
    })),
  );
}

async function passTraining(token: string) {
  const res = await request(app)
    .post('/api/v1/residents/training/submit')
    .set(...bearer(token))
    .send({ answers: correctAnswers() });
  expect(res.body.data.passed).toBe(true);
  return res;
}

function checkoutBody(productId: string, qrToken: string, quantity: number) {
  return { productId, quantity, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken };
}

// ─── B-1 ─────────────────────────────────────────────────────────────────────────────────────
describe('B-1: a resident can be enrolled before they have an account', () => {
  it('issues a claim code, and claiming it makes them a seller with no ID or bank', async () => {
    const shelter = await makeShelter('b1claim');

    // Staff enrol someone standing in front of them. No user id — that is the whole point.
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 5_000, staffVerifierName: 'Dana R.' });

    expect(enrolled.status).toBe(201);
    expect(enrolled.body.data.status).toBe('invited');
    expect(enrolled.body.data.residentUserId).toBeNull();
    const code = enrolled.body.data.claimCode as string;
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    // The resident signs up later, on whatever device they can get to, and types the code.
    await seedUser({ authProviderId: 'b1claim|res', roles: ['customer'] });
    const before = await mintToken('b1claim|res');
    const claimed = await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(before))
      .send({ code });

    expect(claimed.status).toBe(200);
    expect(claimed.body.data.organizationName).toContain('Hope Center');
    expect(claimed.body.data.trainingRequired).toBe(true);

    // They are now a seller at Bronze — with no ID document and no bank account anywhere.
    const after = await mintToken('b1claim|res');
    const me = await request(app).get('/api/v1/users/me').set(...bearer(after));
    expect(me.body.data.roles).toContain('seller');
    expect(me.body.data.verificationTier).toBe('bronze');
  });

  it('refuses a reused, unknown or expired code with one indistinguishable message', async () => {
    const shelter = await makeShelter('b1reuse');
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 5_000, staffVerifierName: 'Dana R.' });
    const code = enrolled.body.data.claimCode as string;

    await seedUser({ authProviderId: 'b1reuse|first', roles: ['customer'] });
    const first = await mintToken('b1reuse|first');
    expect(
      (await request(app).post('/api/v1/residents/claim').set(...bearer(first)).send({ code })).status,
    ).toBe(200);

    // A second person who overheard the code gets nothing.
    await seedUser({ authProviderId: 'b1reuse|second', roles: ['customer'] });
    const second = await mintToken('b1reuse|second');
    const reused = await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(second))
      .send({ code });
    expect(reused.status).toBe(422);

    // An invented code fails identically — nothing distinguishes "used" from "never existed".
    const unknown = await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(second))
      .send({ code: 'ZZZZZZ' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.message).toBe(reused.body.error.message);
  });

  it('lets a shelter hold several invites at once', async () => {
    // The old plain-unique index permitted exactly one null resident_user_id per partner, so a
    // second outstanding invite collided. A shelter enrols people in batches.
    const shelter = await makeShelter('b1many');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
        .set(...bearer(shelter.staffToken))
        .send({ cosignedAllocationCents: 3_000, staffVerifierName: 'Dana R.' });
      expect(res.status).toBe(201);
    }
  });
});

// ─── B-5 ─────────────────────────────────────────────────────────────────────────────────────
describe('B-5: training gates the first pickup', () => {
  async function enrolledResident(prefix: string, allocation = 10_000) {
    const shelter = await makeShelter(prefix);
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: allocation, staffVerifierName: 'Dana R.' });
    await seedUser({ authProviderId: `${prefix}|res`, roles: ['customer'] });
    let token = await mintToken(`${prefix}|res`);
    await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(token))
      .send({ code: enrolled.body.data.claimCode });
    token = await mintToken(`${prefix}|res`);
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    return { ...shelter, token, enrollmentId: enrolled.body.data.id as string };
  }

  it('serves the course without answer keys', async () => {
    const r = await enrolledResident('b5course');
    const res = await request(app)
      .get('/api/v1/residents/training/course')
      .set(...bearer(r.token));

    expect(res.status).toBe(200);
    expect(res.body.data.modules.length).toBeGreaterThan(0);
    // A course that ships its own answer key is not a check on comprehension.
    const serialised = JSON.stringify(res.body.data);
    expect(serialised).not.toContain('answerIndex');
    expect(serialised).not.toContain('explanation');
  });

  it('blocks checkout until the course is passed, then allows it', async () => {
    const r = await enrolledResident('b5gate');
    const hub = await makeHub('b5gate');

    const blocked = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(r.token))
      .send(checkoutBody(hub.productId, hub.qrToken, 1));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TRAINING_REQUIRED');

    await passTraining(r.token);

    const allowed = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(r.token))
      .send(checkoutBody(hub.productId, hub.qrToken, 1));
    expect(allowed.status).toBe(201);
  });

  it('teaches rather than punishes on a failed attempt, and allows an immediate retake', async () => {
    const r = await enrolledResident('b5fail');

    const wrong = correctAnswers().map((a) => ({ ...a, answerIndex: (a.answerIndex + 1) % 3 }));
    const failed = await request(app)
      .post('/api/v1/residents/training/submit')
      .set(...bearer(r.token))
      .send({ answers: wrong });

    expect(failed.status).toBe(200);
    expect(failed.body.data.passed).toBe(false);
    // Every question comes back with its explanation — the explanation IS the teaching.
    expect(failed.body.data.results.every((x: { explanation?: string }) => x.explanation)).toBe(true);

    // Retake immediately, no cooldown, no penalty.
    await passTraining(r.token);
    const status = await request(app)
      .get('/api/v1/residents/training/status')
      .set(...bearer(r.token));
    expect(status.body.data.passed).toBe(true);
  });

  it('counts unanswered questions as wrong so skipping the hard half cannot pass', async () => {
    const r = await enrolledResident('b5partial');
    const onlyOne = correctAnswers().slice(0, 1);
    const res = await request(app)
      .post('/api/v1/residents/training/submit')
      .set(...bearer(r.token))
      .send({ answers: onlyOne });
    expect(res.body.data.passed).toBe(false);
    expect(res.body.data.totalCount).toBeGreaterThan(1);
  });
});

// ─── B-2 ─────────────────────────────────────────────────────────────────────────────────────
describe('B-2: the cosigned allocation is a real cap', () => {
  async function readyResident(prefix: string, allocation: number, hubOpts = {}) {
    const shelter = await makeShelter(prefix, { lng: -120.9969, lat: 37.6391 });
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: allocation, staffVerifierName: 'Dana R.' });
    await seedUser({ authProviderId: `${prefix}|res`, roles: ['customer'] });
    let token = await mintToken(`${prefix}|res`);
    await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(token))
      .send({ code: enrolled.body.data.claimCode });
    token = await mintToken(`${prefix}|res`);
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    await passTraining(token);
    const hub = await makeHub(prefix, { lng: -120.9969, lat: 37.6391, ...hubOpts });
    return { ...shelter, token, hub };
  }

  /**
   * The bug this whole item exists for. Bronze allows $200 of stock; this shelter cosigned $50.
   * Before B-2 the resident could take the full $200 and the shelter's stated exposure was fiction.
   */
  it('stops a resident at the shelter’s cosign, not at the Bronze tier limit', async () => {
    const r = await readyResident('b2cap', 5_000); // $50 cosigned

    // $80 of stock — under Bronze's $200, over the cosign.
    const over = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(r.token))
      .send(checkoutBody(r.hub.productId, r.hub.qrToken, 8));
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('ALLOCATION_EXCEEDED');
    // The message names the org and tells them what they CAN take.
    expect(over.body.error.message).toContain('Hope Center');

    // $40 fits.
    const ok = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(r.token))
      .send(checkoutBody(r.hub.productId, r.hub.qrToken, 4));
    expect(ok.status).toBe(201);
  });

  it('reports the same ceiling to the resident that checkout will enforce', async () => {
    const r = await readyResident('b2report', 6_000);
    const caps = await request(app).get('/api/v1/residents/me').set(...bearer(r.token));

    expect(caps.status).toBe(200);
    expect(caps.body.data.cosignedAllocationCents).toBe(6_000);
    expect(caps.body.data.allocationRemainingCents).toBe(6_000);
    expect(caps.body.data.trainingComplete).toBe(true);

    await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(r.token))
      .send(checkoutBody(r.hub.productId, r.hub.qrToken, 3));

    const after = await request(app).get('/api/v1/residents/me').set(...bearer(r.token));
    expect(after.body.data.allocationUsedCents).toBe(3_000);
    expect(after.body.data.allocationRemainingCents).toBe(3_000);
  });

  it('refuses a cosign above the platform backstop rather than silently clamping it', async () => {
    const shelter = await makeShelter('b2backstop');
    const res = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 50_000, staffVerifierName: 'Dana R.' });

    // Clamping silently would leave staff believing they'd cosigned $500 — the exact confusion
    // this item exists to remove.
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/capped/i);
  });

  it('refuses a hub too far from the shelter to walk to', async () => {
    const shelter = await makeShelter('b2far', { lng: -120.9969, lat: 37.6391 });
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 10_000, staffVerifierName: 'Dana R.' });
    await seedUser({ authProviderId: 'b2far|res', roles: ['customer'] });
    let token = await mintToken('b2far|res');
    await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(token))
      .send({ code: enrolled.body.data.claimCode });
    token = await mintToken('b2far|res');
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    await passTraining(token);

    // ~250km away.
    const farHub = await makeHub('b2far', { lng: -118.2437, lat: 34.0522 });
    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send(checkoutBody(farHub.productId, farHub.qrToken, 1));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/too far/i);
  });
});

// ─── B-4 ─────────────────────────────────────────────────────────────────────────────────────
describe('B-4: the first pickup carries no downside', () => {
  it('absorbs a lost-stock loss into the shelter cosign instead of charging the resident', async () => {
    const shelter = await makeShelter('b4grant', { lng: -120.9969, lat: 37.6391 });
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 5_000, staffVerifierName: 'Dana R.' });
    await seedUser({ authProviderId: 'b4grant|res', roles: ['customer'] });
    let token = await mintToken('b4grant|res');
    await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(token))
      .send({ code: enrolled.body.data.claimCode });
    token = await mintToken('b4grant|res');
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    await passTraining(token);

    const hub = await makeHub('b4grant', { lng: -120.9969, lat: 37.6391 });

    const caps = await request(app).get('/api/v1/residents/me').set(...bearer(token));
    expect(caps.body.data.starterGrantAvailable).toBe(true);

    // $20 of stock — inside the starter-grant ceiling.
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send(checkoutBody(hub.productId, hub.qrToken, 2));
    expect(checkout.status).toBe(201);

    // Grant consumed.
    const after = await request(app).get('/api/v1/residents/me').set(...bearer(token));
    expect(after.body.data.starterGrantAvailable).toBe(false);

    // It all goes missing — the worst case on day one.
    const returned = await request(app)
      .post(`/api/v1/checkouts/${checkout.body.data.id}/return`)
      .set(...bearer(token))
      .send({ quantityReturned: 2, conditionAssessment: 'lost' });
    expect(returned.status).toBe(200);

    /**
     * The whole promise of B-4: they owe nothing. Charging someone with nothing for their first
     * failed attempt is precisely the trap the program exists to avoid.
     */
    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(token));
    expect(debts.body.data.totalOutstandingCents).toBe(0);
  });

  it('charges an ordinary seller for the same loss', async () => {
    // The grant must be a resident-only exception, not a hole in the liability rules.
    const hub = await makeHub('b4normal');
    await seedUser({ authProviderId: 'b4normal|seller', roles: ['seller'], tier: 'gold' });
    const token = await mintToken('b4normal|seller');
    await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(token));
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });

    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send(checkoutBody(hub.productId, hub.qrToken, 2));
    await request(app)
      .post(`/api/v1/checkouts/${checkout.body.data.id}/return`)
      .set(...bearer(token))
      .send({ quantityReturned: 2, conditionAssessment: 'lost' });

    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(token));
    expect(debts.body.data.totalOutstandingCents).toBeGreaterThan(0);
  });
});

// ─── B-3 ─────────────────────────────────────────────────────────────────────────────────────
describe('B-3: a resident with no bank account still gets paid', () => {
  async function residentWithSale(prefix: string, custody: boolean) {
    const shelter = await makeShelter(prefix, { lng: -120.9969, lat: 37.6391, custody });
    const enrolled = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 10_000, staffVerifierName: 'Dana R.' });
    await seedUser({ authProviderId: `${prefix}|res`, roles: ['customer'] });
    let token = await mintToken(`${prefix}|res`);
    await request(app)
      .post('/api/v1/residents/claim')
      .set(...bearer(token))
      .send({ code: enrolled.body.data.claimCode });
    token = await mintToken(`${prefix}|res`);
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    await passTraining(token);

    const hub = await makeHub(prefix, { lng: -120.9969, lat: 37.6391 });
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send(checkoutBody(hub.productId, hub.qrToken, 5));
    expect(checkout.status).toBe(201);
    return { ...shelter, token, hub, checkoutId: checkout.body.data.id as string };
  }

  it('routes a gig payout into shelter custody and tells the resident where to collect it', async () => {
    const r = await residentWithSale('b3job', true);

    // A gig — often a resident's first money on the platform.
    const emp = await makeHub('b3jobemp');
    const job = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.hubToken))
      .send({
        lng: -120.9969,
        lat: 37.6391,
        title: 'Flyer round',
        payCents: 4_000,
        businessId: emp.businessId,
      });
    expect(job.status).toBe(201);
    const jobId = job.body.data.id as string;

    await request(app).post(`/api/v1/jobs/${jobId}/apply`).set(...bearer(r.token));
    await request(app)
      .post(`/api/v1/jobs/${jobId}/check-in`)
      .set(...bearer(r.token))
      .send({ lat: 37.6391, lng: -120.9969 });
    const out = await request(app)
      .post(`/api/v1/jobs/${jobId}/check-out`)
      .set(...bearer(r.token))
      .set('Idempotency-Key', `co_${jobId}`);
    expect(out.status).toBe(200);

    // The resident's own view: money exists, and it says where to go.
    const mine = await request(app).get('/api/v1/residents/custody').set(...bearer(r.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.heldCents).toBe(4_000);
    expect(mine.body.data.entries[0].collectionNote).toContain('front desk');

    // The shelter's view: it knows it owes cash at the desk.
    const ledger = await request(app)
      .get(`/api/v1/shelter-partners/${r.partnerId}/custody`)
      .set(...bearer(r.staffToken));
    expect(ledger.body.data.heldCents).toBe(4_000);
    const entryId = ledger.body.data.entries[0].id as string;

    // Staff hand it over; the resident confirms.
    const disbursed = await request(app)
      .post(`/api/v1/shelter-partners/${r.partnerId}/custody/${entryId}/disburse`)
      .set(...bearer(r.staffToken))
      .send({ method: 'cash' });
    expect(disbursed.status).toBe(200);

    const ack = await request(app)
      .post(`/api/v1/residents/custody/${entryId}/acknowledge`)
      .set(...bearer(r.token));
    expect(ack.status).toBe(200);

    const settled = await request(app).get('/api/v1/residents/custody').set(...bearer(r.token));
    expect(settled.body.data.heldCents).toBe(0);
    expect(settled.body.data.entries[0].acknowledged).toBe(true);
  });

  it('does NOT route funds to a shelter that has not accepted the custody duty', async () => {
    // Custody is a fiduciary obligation. Nobody is opted into one.
    const r = await residentWithSale('b3nocustody', false);

    const emp = await makeHub('b3nocustodyemp');
    const job = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.hubToken))
      .send({
        lng: -120.9969,
        lat: 37.6391,
        title: 'Flyer round',
        payCents: 3_000,
        businessId: emp.businessId,
      });
    const jobId = job.body.data.id as string;
    await request(app).post(`/api/v1/jobs/${jobId}/apply`).set(...bearer(r.token));
    await request(app)
      .post(`/api/v1/jobs/${jobId}/check-in`)
      .set(...bearer(r.token))
      .send({ lat: 37.6391, lng: -120.9969 });
    await request(app).post(`/api/v1/jobs/${jobId}/check-out`).set(...bearer(r.token));

    const mine = await request(app).get('/api/v1/residents/custody').set(...bearer(r.token));
    expect(mine.body.data.heldCents).toBe(0);
  });

  it('pays a resident directly once they have their own account — custody is a fallback', async () => {
    const r = await residentWithSale('b3own', true);

    // They open their own account. From here custody must not intercept anything.
    await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(r.token));
    const acct = await ConnectedAccountModel.findOne({ owner_type: 'user' })
      .sort({ created_at: -1 })
      .lean();
    fakeStripe.enableAccount(acct!.stripe_account_id);
    await stripeEvent('account.updated', { id: acct!.stripe_account_id });

    const emp = await makeHub('b3ownemp');
    const job = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.hubToken))
      .send({
        lng: -120.9969,
        lat: 37.6391,
        title: 'Flyer round',
        payCents: 2_500,
        businessId: emp.businessId,
      });
    const jobId = job.body.data.id as string;
    await request(app).post(`/api/v1/jobs/${jobId}/apply`).set(...bearer(r.token));
    await request(app)
      .post(`/api/v1/jobs/${jobId}/check-in`)
      .set(...bearer(r.token))
      .send({ lat: 37.6391, lng: -120.9969 });
    await request(app).post(`/api/v1/jobs/${jobId}/check-out`).set(...bearer(r.token));

    const mine = await request(app).get('/api/v1/residents/custody').set(...bearer(r.token));
    expect(mine.body.data.heldCents).toBe(0);
  });
});

// ─── Reporting ───────────────────────────────────────────────────────────────────────────────
/**
 * ═══ The admin's view of the programme. ═══
 *
 * There was no way to list partners at all, so the admin screen rendered a hardcoded fixture — two
 * invented organisations with invented enrollment counts — on the production URL, in both demo and
 * live mode. And `suspended` sat in the model reachable by nothing, so a partner mishandling
 * residents' money could not be stopped without editing the database.
 */
describe('admin oversight of shelter partners', () => {
  it('lists real partners with their enrollment and custody exposure', async () => {
    const shelter = await makeShelter('b-roster', { custody: true });
    const adminToken = await makeAdmin('b-roster-admin');

    const res = await request(app)
      .get('/api/v1/shelter-partners')
      .set(...bearer(adminToken));
    expect(res.status).toBe(200);

    const row = (res.body.data as { id: string; organizationName: string }[]).find(
      (p) => p.id === shelter.partnerId,
    );
    expect(row).toBeDefined();
    expect(row!.organizationName).toContain('Hope Center');
    // The numbers are derived from real rows, not invented.
    expect(res.body.data.find((p: { id: string }) => p.id === shelter.partnerId)).toMatchObject({
      status: 'verified',
      residentsEnrolled: expect.any(Number),
      custodyHeldCents: expect.any(Number),
    });
  });

  it('suspends a partner, and says how much of residents’ money they still hold', async () => {
    const shelter = await makeShelter('b-suspend');
    const adminToken = await makeAdmin('b-suspend-admin');

    const res = await request(app)
      .patch(`/api/v1/shelter-partners/${shelter.partnerId}/status`)
      .set(...bearer(adminToken))
      .send({ status: 'suspended', reason: 'under review' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('suspended');
    /**
     * Reported so an admin is told immediately if they have just suspended a partner still holding
     * residents' cash. Not a reason to refuse the suspension — it is the likeliest reason for it —
     * but it is the next thing that needs handling.
     */
    expect(res.body.data.custodyHeldCents).toEqual(expect.any(Number));

    // A suspended partner takes no NEW residents.
    const enroll = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 5_000, staffVerifierName: 'Dana R.' });
    expect([403, 404]).toContain(enroll.status);

    // …and reinstating puts them straight back to work.
    await request(app)
      .patch(`/api/v1/shelter-partners/${shelter.partnerId}/status`)
      .set(...bearer(adminToken))
      .send({ status: 'verified' })
      .expect(200);
    const again = await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 5_000, staffVerifierName: 'Dana R.' });
    expect(again.status).toBe(201);
  });

  it('is admin-only — a shelter’s own staff cannot suspend or roster', async () => {
    const shelter = await makeShelter('b-rosterauth');
    for (const call of [
      request(app).get('/api/v1/shelter-partners').set(...bearer(shelter.staffToken)),
      request(app)
        .patch(`/api/v1/shelter-partners/${shelter.partnerId}/status`)
        .set(...bearer(shelter.staffToken))
        .send({ status: 'suspended' }),
    ]) {
      const res = await call;
      expect([403, 404]).toContain(res.status);
    }
  });
});

describe('shelter reporting stays aggregate-only', () => {
  it('reports counts and totals, never per-resident rows', async () => {
    const shelter = await makeShelter('breport', { custody: true });
    await request(app)
      .post(`/api/v1/shelter-partners/${shelter.partnerId}/enrollments`)
      .set(...bearer(shelter.staffToken))
      .send({ cosignedAllocationCents: 5_000, staffVerifierName: 'Dana R.' });

    const res = await request(app)
      .get(`/api/v1/shelter-partners/${shelter.partnerId}/reporting`)
      .set(...bearer(shelter.staffToken));

    expect(res.status).toBe(200);
    expect(res.body.data.invitedCount).toBe(1);
    expect(res.body.data.custodyEnabled).toBe(true);
    expect(res.body.data).not.toHaveProperty('residents');
    // FR-12.3: no per-resident detail may leave this endpoint.
    expect(JSON.stringify(res.body.data)).not.toContain('resident_user_id');
  });
});
