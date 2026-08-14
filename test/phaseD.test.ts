import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { COURSES, findCourse } from '../src/modules/academy/academy.catalog';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase D — Earning hub & Academy.
 *
 * D-3/D-4 generalise B-5's one course into a catalog on the same `training_completions` table.
 * D-5 gives hub owners a gate that a brand-new seller can clear TODAY, where the A-3 Trust gate
 * takes weeks. D-2 supplies the seller description the matching engine never had. D-1 merges three
 * kinds of work into one list ranked on payout AND time-to-payout.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
});

const ORIGIN = { lng: -120.9969, lat: 37.6391 };

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

async function makeSeller(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|seller`, roles: ['seller'], tier: 'gold' });
  const token = await mintToken(`${prefix}|seller`);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return token;
}

async function makeHub(
  prefix: string,
  products: Array<Record<string, unknown>> = [],
) {
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

  const productIds: string[] = [];
  for (const [i, extra] of products.entries()) {
    const res = await request(app)
      .post(`/api/v1/hubs/${hubId}/products`)
      .set(...bearer(hubToken))
      .send({
        name: `${prefix} item ${i}`,
        unitValueCents: 1000,
        consignmentSplitPercent: 65,
        returnWindowHours: 72,
        quantityAvailable: 20,
        ...extra,
      });
    expect(res.status).toBe(201);
    productIds.push(res.body.data.id as string);
  }
  return { hubToken, hubId, businessId, qrToken: hub.body.data.token as string, productIds };
}

/** Every correct answer for a catalog course. */
function answersFor(slug: string) {
  const course = findCourse(slug)!;
  return course.modules.flatMap((m) =>
    m.questions.map((q) => ({
      moduleSlug: m.slug,
      questionId: q.id,
      answerIndex: q.answerIndex,
    })),
  );
}

async function passCourse(token: string, slug: string) {
  const res = await request(app)
    .post(`/api/v1/academy/courses/${slug}/submit`)
    .set(...bearer(token))
    .send({ answers: answersFor(slug) });
  expect(res.body.data.passed).toBe(true);
  return res;
}

// ─── D-3 ─────────────────────────────────────────────────────────────────────────────────────
describe('D-3: the Academy', () => {
  it('lists the catalog with the caller’s own progress, and never ships answer keys', async () => {
    const token = await makeSeller('d3list');

    const list = await request(app).get('/api/v1/academy/courses').set(...bearer(token));
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(COURSES.length);
    expect(list.body.data.every((c: { passed: boolean }) => c.passed === false)).toBe(true);

    const detail = await request(app)
      .get('/api/v1/academy/courses/selling-basics')
      .set(...bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.modules.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(detail.body.data);
    expect(serialised).not.toContain('answerIndex');
    expect(serialised).not.toContain('explanation');
  });

  it('records a failure, explains every question, and allows an immediate retake', async () => {
    const token = await makeSeller('d3fail');
    const wrong = answersFor('selling-basics').map((a) => ({
      ...a,
      answerIndex: (a.answerIndex + 1) % 3,
    }));

    const failed = await request(app)
      .post('/api/v1/academy/courses/selling-basics/submit')
      .set(...bearer(token))
      .send({ answers: wrong });
    expect(failed.body.data.passed).toBe(false);
    // The explanation IS the teaching — withholding it from a failed attempt helps nobody.
    expect(failed.body.data.results.every((r: { explanation?: string }) => r.explanation)).toBe(true);

    await passCourse(token, 'selling-basics');
  });

  it('counts unanswered questions as wrong so skipping the hard half cannot pass', async () => {
    const token = await makeSeller('d3partial');
    const res = await request(app)
      .post('/api/v1/academy/courses/inventory-handling/submit')
      .set(...bearer(token))
      .send({ answers: answersFor('inventory-handling').slice(0, 1) });
    expect(res.body.data.passed).toBe(false);
    expect(res.body.data.totalCount).toBeGreaterThan(1);
  });

  it('reuses B-5’s table — the resident course appears in the catalog rather than being duplicated', async () => {
    const token = await makeSeller('d3shared');
    // Pass it through the SHELTER route (B-5's own endpoint)...
    const shelterSubmit = await request(app)
      .post('/api/v1/residents/training/submit')
      .set(...bearer(token))
      .send({ answers: answersFor('resident-starter') });
    expect(shelterSubmit.body.data.passed).toBe(true);

    // ...and the Academy sees it, because both write the same completions table.
    const list = await request(app).get('/api/v1/academy/courses').set(...bearer(token));
    const resident = list.body.data.find(
      (c: { slug: string }) => c.slug === 'resident-starter',
    );
    expect(resident.passed).toBe(true);
  });
});

// ─── D-4 ─────────────────────────────────────────────────────────────────────────────────────
describe('D-4: badges and certifications', () => {
  it('awards a badge for any course and a certification only for the certifying one', async () => {
    const token = await makeSeller('d4cred');

    await passCourse(token, 'selling-basics');
    let creds = await request(app).get('/api/v1/academy/me/credentials').set(...bearer(token));
    expect(creds.body.data.badges).toHaveLength(1);
    // A badge says "did this"; a certification is something access is gated on. Not the same thing.
    expect(creds.body.data.certifications).toHaveLength(0);

    const certified = await passCourse(token, 'inventory-handling');
    expect(certified.body.data.certificationAwarded.key).toBe('certified-handler');

    creds = await request(app).get('/api/v1/academy/me/credentials').set(...bearer(token));
    expect(creds.body.data.badges).toHaveLength(2);
    expect(creds.body.data.certifications).toHaveLength(1);
    expect(creds.body.data.certifications[0].label).toBe('Certified Handler');
    expect(creds.body.data.certifications[0].current).toBe(true);
  });
});

// ─── D-5 ─────────────────────────────────────────────────────────────────────────────────────
describe('D-5: certification-gated inventory', () => {
  it('blocks an uncertified seller and names the course that unlocks it', async () => {
    const hub = await makeHub('d5gate', [{ requiredCertification: 'certified-handler' }]);
    const token = await makeSeller('d5gate');

    const blocked = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({
        productId: hub.productIds[0],
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });

    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('CERTIFICATION_REQUIRED');
    /**
     * The refusal has to name the remedy. A certification gate is clearable TODAY, unlike a Trust
     * shortfall — telling someone to "build trust" when a ten-minute course would do it is the
     * difference between a door and a wall.
     */
    expect(blocked.body.error.message).toContain('Handling stock properly');
    expect(blocked.body.error.message).toMatch(/minutes/);

    await passCourse(token, 'inventory-handling');

    const allowed = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({
        productId: hub.productIds[0],
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(allowed.status).toBe(201);
  });

  it('leaves ungated stock alone', async () => {
    const hub = await makeHub('d5open', [{}]);
    const token = await makeSeller('d5open');
    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({
        productId: hub.productIds[0],
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(res.status).toBe(201);
  });

  it('surfaces the requirement on browse so the lock is visible before the trip', async () => {
    const hub = await makeHub('d5browse', [{ requiredCertification: 'certified-handler' }]);
    const token = await makeSeller('d5browse');
    const res = await request(app)
      .get(`/api/v1/products/${hub.productIds[0]}`)
      .set(...bearer(token));
    expect(res.body.data.requiredCertification).toBe('certified-handler');
  });
});

// ─── D-2 ─────────────────────────────────────────────────────────────────────────────────────
describe('D-2: the seller profile', () => {
  it('creates an empty profile on first read rather than 404ing', async () => {
    const token = await makeSeller('d2new');
    const res = await request(app).get('/api/v1/sellers/me/profile').set(...bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.skills).toEqual([]);
    expect(res.body.data.complete).toBe(false);
  });

  it('stores what the seller declares and keeps inferred signals separate', async () => {
    const token = await makeSeller('d2decl');
    const saved = await request(app)
      .patch('/api/v1/sellers/me/profile')
      .set(...bearer(token))
      .send({
        skills: ['talking_to_people', 'crafts_and_handmade'],
        venues: ['farmers_markets', 'car_events'],
        transport: 'bike',
        availableHours: [17, 9, 9],
      });

    expect(saved.status).toBe(200);
    expect(saved.body.data.skills).toContain('talking_to_people');
    // De-duplicated and sorted, so the stored shape doesn't depend on tap order.
    expect(saved.body.data.availableHours).toEqual([9, 17]);
    expect(saved.body.data.complete).toBe(true);

    /**
     * The two halves never merge. When what someone says disagrees with what they do, that
     * disagreement is the signal — and a seller must be able to see both separately.
     */
    expect(saved.body.data.inferred.sampleSize).toBe(0);
    expect(saved.body.data.inferred.confidence).toBe(0);
  });

  it('rejects a skill outside the closed vocabulary', async () => {
    const token = await makeSeller('d2vocab');
    const res = await request(app)
      .patch('/api/v1/sellers/me/profile')
      .set(...bearer(token))
      .send({ skills: ['juggling'] });
    expect(res.status).toBe(400);
  });

  it('serves the vocabulary so clients never hardcode it', async () => {
    const token = await makeSeller('d2opts');
    const res = await request(app).get('/api/v1/sellers/profile-options').set(...bearer(token));
    expect(res.body.data.skills).toContain('talking_to_people');
    expect(res.body.data.transport).toContain('on_foot');
  });
});

// ─── D-1 ─────────────────────────────────────────────────────────────────────────────────────
describe('D-1: the unified earn hub', () => {
  it('merges stock and gigs into one list, each with payout and time-to-payout', async () => {
    const hub = await makeHub('d1mix', [{}]);
    const token = await makeSeller('d1mix');

    // A gig at the same origin.
    const job = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(hub.hubToken))
      .send({
        lng: ORIGIN.lng,
        lat: ORIGIN.lat,
        title: 'Flyer round',
        payCents: 6_000,
        businessId: hub.businessId,
      });
    expect(job.status).toBe(201);

    const res = await request(app)
      .get(`/api/v1/earn?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`)
      .set(...bearer(token));

    expect(res.status).toBe(200);
    const kinds = new Set(res.body.data.items.map((i: { kind: string }) => i.kind));
    expect(kinds.has('gig')).toBe(true);
    expect(kinds.has('consignment')).toBe(true);

    // Both axes are stated outright rather than hidden behind a score.
    for (const item of res.body.data.items) {
      expect(item.expectedPayoutCents).toBeGreaterThan(0);
      expect(item.hoursToPayout).toBeGreaterThan(0);
      expect(item.reasonSummary).toBeTruthy();
    }
  });

  /**
   * The honesty check. A consignment row quotes what the seller keeps on ONE unit, net of the
   * platform fee — not the value of the whole pickup. Quoting the full stock value would be the
   * flattering number and the dishonest one.
   */
  it('quotes consignment payout per unit, net of fees — not the whole pickup', async () => {
    await makeHub('d1honest', [{}]);
    const token = await makeSeller('d1honest');

    const res = await request(app).get('/api/v1/earn').set(...bearer(token));
    const item = res.body.data.items.find((i: { kind: string }) => i.kind === 'consignment');
    expect(item).toBeDefined();

    // $10 unit, 8% digital fee, 65% split → $5.98. Emphatically not 20 units × $10.
    expect(item.expectedPayoutCents).toBe(598);
    expect(item.expectedPayoutCents).toBeLessThan(1000);
  });

  it('still returns stock without coordinates, and reports whether the profile is set up', async () => {
    await makeHub('d1noloc', [{}]);
    const token = await makeSeller('d1noloc');

    const res = await request(app).get('/api/v1/earn').set(...bearer(token));
    expect(res.status).toBe(200);
    // Gigs need coordinates (their feed is proximity-ranked); stock does not.
    expect(res.body.data.items.every((i: { kind: string }) => i.kind === 'consignment')).toBe(true);
    // Drives the "tell us what you're good at" nudge.
    expect(res.body.data.profileComplete).toBe(false);
  });
});
