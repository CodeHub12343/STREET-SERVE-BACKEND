import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { HubModel } from '../src/modules/consignment/consignment.model';
import { UserModel } from '../src/modules/identity/identity.model';
import { LiveSessionModel } from '../src/modules/livemap/livemap.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase C — the map becomes the product.
 *
 * The map was the product's core metaphor and drew exactly one thing: live business sessions.
 * Consignment hubs (the supply side of the whole seller economy) were list-only, and the demand
 * signals the platform already collects were never drawn. These tests are about whether the layers
 * tell the truth — the counts, the privacy floor, and the "we don't know where this is" case.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
});

const ORIGIN = { lng: -120.9969, lat: 37.6391 };
/** A box comfortably around the origin. */
const BOX = {
  swLng: ORIGIN.lng - 0.05,
  swLat: ORIGIN.lat - 0.05,
  neLng: ORIGIN.lng + 0.05,
  neLat: ORIGIN.lat + 0.05,
};
const bboxQS = (b = BOX) =>
  `swLng=${b.swLng}&swLat=${b.swLat}&neLng=${b.neLng}&neLat=${b.neLat}`;

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

/** A hub placed at a real point, optionally stocked. */
async function makeHub(
  prefix: string,
  opts: { lng?: number; lat?: number; products?: Array<{ category?: string; qty: number; unitValue?: number }> } = {},
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

  await HubModel.updateOne(
    { _id: hubId },
    {
      $set: {
        location: {
          type: 'Point',
          coordinates: [opts.lng ?? ORIGIN.lng, opts.lat ?? ORIGIN.lat],
        },
      },
    },
  );

  const productIds: string[] = [];
  for (const [i, p] of (opts.products ?? []).entries()) {
    const res = await request(app)
      .post(`/api/v1/hubs/${hubId}/products`)
      .set(...bearer(hubToken))
      .send({
        name: `${prefix} item ${i}`,
        unitValueCents: p.unitValue ?? 1000,
        consignmentSplitPercent: 65,
        returnWindowHours: 72,
        quantityAvailable: p.qty,
        ...(p.category ? { category: p.category } : {}),
      });
    expect(res.status).toBe(201);
    productIds.push(res.body.data.id as string);
  }

  return { hubToken, hubId, businessId, qrToken: hub.body.data.token as string, productIds };
}

async function makeCustomer(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'], tier: 'bronze' });
  return mintToken(`${prefix}|cust`);
}

// ─── C-1 / C-2 ───────────────────────────────────────────────────────────────────────────────
describe('C-1/C-2: hubs are on the map, with what is actually checkoutable', () => {
  it('returns hubs in the viewport with live availability counts', async () => {
    const hub = await makeHub('c1basic', {
      products: [
        { qty: 10, unitValue: 500 },
        { qty: 4, unitValue: 1200 },
      ],
    });
    const token = await makeCustomer('c1basic');

    const res = await request(app)
      .get(`/api/v1/map/hubs?${bboxQS()}`)
      .set(...bearer(token));

    expect(res.status).toBe(200);
    const mine = res.body.data.find((h: { hubId: string }) => h.hubId === hub.hubId);
    expect(mine).toBeDefined();
    expect(mine.itemCount).toBe(2);
    expect(mine.unitCount).toBe(14);
    // "from $5" is the number that makes the pin a decision rather than a label.
    expect(mine.fromUnitValueCents).toBe(500);
    expect(mine.hasInventory).toBe(true);
  });

  it('excludes hubs outside the viewport', async () => {
    const far = await makeHub('c1far', { lng: -118.2437, lat: 34.0522, products: [{ qty: 5 }] });
    const token = await makeCustomer('c1far');

    const res = await request(app)
      .get(`/api/v1/map/hubs?${bboxQS()}`)
      .set(...bearer(token));
    expect(res.body.data.map((h: { hubId: string }) => h.hubId)).not.toContain(far.hubId);
  });

  /**
   * Counts must reflect what a seller can collect NOW. Stock that has walked out with someone is
   * not available, and a pin that claims otherwise sends people on wasted trips.
   */
  it('drops checked-out stock from the count', async () => {
    const hub = await makeHub('c1out', { products: [{ qty: 10, unitValue: 1000 }] });
    const token = await makeCustomer('c1out');

    const before = await request(app).get(`/api/v1/map/hubs?${bboxQS()}`).set(...bearer(token));
    const beforeUnits = before.body.data.find(
      (h: { hubId: string }) => h.hubId === hub.hubId,
    ).unitCount;
    expect(beforeUnits).toBe(10);

    await seedUser({ authProviderId: 'c1out|seller', roles: ['seller'], tier: 'gold' });
    const seller = await mintToken('c1out|seller');
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(seller))
      .send({ version: SELLER_AGREEMENT_VERSION });
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(seller))
      .send({
        productId: hub.productIds[0],
        quantity: 4,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(co.status).toBe(201);

    const after = await request(app).get(`/api/v1/map/hubs?${bboxQS()}`).set(...bearer(token));
    expect(
      after.body.data.find((h: { hubId: string }) => h.hubId === hub.hubId).unitCount,
    ).toBe(6);
  });

  /**
   * C-2: with a category filter the question becomes "where can I get THIS", so a hub that can't
   * answer it is dropped entirely rather than drawn as an empty pin.
   */
  it('drops non-matching hubs entirely when a category filter is applied', async () => {
    const shopping = await makeHub('c2shop', { products: [{ category: 'shopping', qty: 6 }] });
    const empty = await makeHub('c2empty', { products: [] });
    const token = await makeCustomer('c2filter');

    const all = await request(app).get(`/api/v1/map/hubs?${bboxQS()}`).set(...bearer(token));
    const allIds = all.body.data.map((h: { hubId: string }) => h.hubId);
    // Unfiltered, an empty hub is still a real place and still appears.
    expect(allIds).toContain(shopping.hubId);
    expect(allIds).toContain(empty.hubId);

    const filtered = await request(app)
      .get(`/api/v1/map/hubs?${bboxQS()}&category=shopping`)
      .set(...bearer(token));
    const filteredIds = filtered.body.data.map((h: { hubId: string }) => h.hubId);
    expect(filteredIds).toContain(shopping.hubId);
    expect(filteredIds).not.toContain(empty.hubId);
  });

  it('rejects an inverted bounding box instead of returning a mysteriously empty layer', async () => {
    const token = await makeCustomer('c1bbox');
    const res = await request(app)
      .get(`/api/v1/map/hubs?swLng=${BOX.swLng}&swLat=${BOX.neLat}&neLng=${BOX.neLng}&neLat=${BOX.swLat}`)
      .set(...bearer(token));
    expect(res.status).toBe(400);
  });
});

// ─── C-3 ─────────────────────────────────────────────────────────────────────────────────────
describe('C-3: demand tiles', () => {
  /** A live business at a point, ready to receive wave-downs and queue joins. */
  async function makeLiveBusiness(prefix: string) {
    const cat = await CategoryModel.create({
      slug: `${prefix}-cat`,
      name: prefix,
      top_level_tab: 'food',
      requires_license: false,
    });
    await seedUser({ authProviderId: `${prefix}|v`, roles: ['vendor'], tier: 'gold' });
    const token = await mintToken(`${prefix}|v`);
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: `${prefix} Truck`, categoryId: String(cat._id) });
    const businessId = biz.body.data.id as string;
    // R28: a vendor accepts the Terms of Sale once before going live.
    await request(app)
      .post('/api/v1/agreements/regular_sale/accept')
      .set(...bearer(token))
      .send({});
    const session = await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'business', actorId: businessId, lng: ORIGIN.lng, lat: ORIGIN.lat, status: 'parked' });
    expect(session.status).toBe(201);
    return { token, businessId };
  }

  /**
   * The privacy floor. A single wave is not a hot zone — drawing it as one would both mislead and
   * disclose roughly where one identifiable person is standing.
   */
  it('suppresses tiles below the minimum weight', async () => {
    const biz = await makeLiveBusiness('c3thin');
    const cust = await makeCustomer('c3thin');

    await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: biz.businessId });

    const res = await request(app)
      .get(`/api/v1/map/demand?${bboxQS()}`)
      .set(...bearer(cust));
    expect(res.status).toBe(200);
    // One wave weighs 1, below DEMAND_MIN_TILE_WEIGHT — nothing is drawn.
    expect(res.body.data).toHaveLength(0);
  });

  it('aggregates enough demand into a weighted tile, and names neither the customers nor the target', async () => {
    const biz = await makeLiveBusiness('c3hot');
    const cust = await makeCustomer('c3hot');

    // Three separate customers wave — comfortably over the floor.
    for (let i = 0; i < 3; i += 1) {
      await seedUser({ authProviderId: `c3hot|c${i}`, roles: ['customer'], tier: 'bronze' });
      const t = await mintToken(`c3hot|c${i}`);
      await request(app)
        .post('/api/v1/wave-downs')
        .set(...bearer(t))
        .send({ targetType: 'business', targetId: biz.businessId });
    }

    const res = await request(app)
      .get(`/api/v1/map/demand?${bboxQS()}`)
      .set(...bearer(cust));

    expect(res.body.data.length).toBeGreaterThan(0);
    const tile = res.body.data[0];
    expect(tile.weight).toBeGreaterThanOrEqual(3);
    expect(tile.waveDowns).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(tile.lngLat)).toBe(true);

    /**
     * The whole privacy contract of this layer: it says WHERE demand is, never WHO is asking or
     * whom they're asking for.
     */
    const serialised = JSON.stringify(tile);
    expect(serialised).not.toContain(biz.businessId);
    expect(serialised).not.toContain('customer');
    expect(tile).not.toHaveProperty('targetId');
  });

  it('requires authentication — it is a commercial signal, not public discovery', async () => {
    const res = await request(app).get(`/api/v1/map/demand?${bboxQS()}`);
    expect(res.status).toBe(401);
  });
});

// ─── C-5 ─────────────────────────────────────────────────────────────────────────────────────
describe('C-5: a hub owner can see where their stock is', () => {
  it('plots located holders and still reports the ones it cannot find', async () => {
    const hub = await makeHub('c5map', { products: [{ qty: 20, unitValue: 1000 }] });

    /** A seller who checks stock out, optionally broadcasting a location. */
    async function seller(name: string, live: boolean) {
      await seedUser({ authProviderId: `c5map|${name}`, roles: ['seller'], tier: 'gold' });
      const token = await mintToken(`c5map|${name}`);
      await request(app)
        .post('/api/v1/seller-agreement/accept')
        .set(...bearer(token))
        .send({ version: SELLER_AGREEMENT_VERSION });
      const me = await request(app).get('/api/v1/users/me').set(...bearer(token));
      if (live) {
        await request(app)
          .post('/api/v1/live-sessions/start')
          .set(...bearer(token))
          .send({
            actorType: 'seller',
            actorId: me.body.data.id,
            lng: ORIGIN.lng + 0.01,
            lat: ORIGIN.lat + 0.01,
            status: 'parked',
          });
      }
      const co = await request(app)
        .post('/api/v1/checkouts')
        .set(...bearer(token))
        .send({
          productId: hub.productIds[0],
          quantity: 3,
          conditionPhotoUrl: 'https://cdn.test/c.jpg',
          qrToken: hub.qrToken,
        });
      expect(co.status).toBe(201);
      return token;
    }

    await seller('live', true);
    await seller('dark', false);

    const res = await request(app)
      .get(`/api/v1/hubs/${hub.hubId}/inventory-map`)
      .set(...bearer(hub.hubToken));

    expect(res.status).toBe(200);
    expect(res.body.data.holders).toHaveLength(2);
    expect(res.body.data.locatedCount).toBe(1);

    /**
     * The point of the whole screen: a seller with no live session is RETURNED, not omitted. "We
     * don't know where this is" is the most useful thing a hub owner can be told, and dropping
     * those rows would hide exactly the stock worth chasing.
     */
    const dark = res.body.data.holders.find(
      (h: { lngLat: unknown }) => h.lngLat === null,
    );
    expect(dark).toBeDefined();
    expect(dark.outstanding).toBe(3);
    expect(dark.valueCents).toBe(3_000);

    const live = res.body.data.holders.find((h: { lngLat: unknown }) => h.lngLat !== null);
    expect(live.lngLat).toHaveLength(2);
    expect(live.lastSeenAt).toBeTruthy();
  });

  /**
   * ═══ A seller who has gone home is not a seller we cannot find. ═══
   *
   * The query filtered on `ended_at: null`, so the only holders with a position were those live at
   * the instant the screen was opened. Between shifts — most of the day — every row came back
   * unlocatable and the map rendered empty, while the last known position of each seller sat in the
   * database being ignored. A hub owner chasing stock was told nothing when we could have told them
   * where it was last seen.
   *
   * The stale fix is returned and clearly LABELLED as stale, because a last-known position drawn as
   * a current one would be worse than none: it would send someone to the wrong place.
   */
  it('falls back to the last known position when a seller has gone offline', async () => {
    const hub = await makeHub('c5stale', { products: [{ qty: 10, unitValue: 1000 }] });

    await seedUser({ authProviderId: 'c5stale|gone', roles: ['seller'], tier: 'gold' });
    const token = await mintToken('c5stale|gone');
    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    const me = await request(app).get('/api/v1/users/me').set(...bearer(token));
    const sellerId = me.body.data.id as string;

    await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({
        actorType: 'seller',
        actorId: sellerId,
        lng: ORIGIN.lng + 0.02,
        lat: ORIGIN.lat + 0.02,
        status: 'parked',
      });
    await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({
        productId: hub.productIds[0],
        quantity: 2,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      })
      .expect(201);

    // They finish their shift. The session ends; the position it recorded does not evaporate.
    await LiveSessionModel.updateOne(
      { actor_type: 'seller', actor_id: sellerId },
      { $set: { ended_at: new Date() } },
    );

    const res = await request(app)
      .get(`/api/v1/hubs/${hub.hubId}/inventory-map`)
      .set(...bearer(hub.hubToken));
    expect(res.status).toBe(200);

    const holder = res.body.data.holders[0];
    // On the map — not thrown away…
    expect(holder.lngLat).toHaveLength(2);
    expect(res.body.data.locatedCount).toBe(1);
    // …but never presented as a live position.
    expect(holder.locationAge).toBe('last_known');
    expect(holder.liveStatus).toBeNull();
    expect(res.body.data.liveCount).toBe(0);
    expect(holder.lastSeenAt).toBeTruthy();
  });

  /**
   * Two rows both reading "Seller" is the failure of the entire screen: the hub owner cannot tell
   * which of two people holds which stock. `display_name` is nullable and only ever populated from
   * the auth provider, so the bare fallback hit anyone who signed up without one.
   */
  it('never renders two different sellers under the same fallback name', async () => {
    const hub = await makeHub('c5name', { products: [{ qty: 20, unitValue: 500 }] });

    for (const n of ['one', 'two']) {
      await seedUser({ authProviderId: `c5name|${n}`, roles: ['seller'], tier: 'gold' });
      const token = await mintToken(`c5name|${n}`);
      await request(app)
        .post('/api/v1/seller-agreement/accept')
        .set(...bearer(token))
        .send({ version: SELLER_AGREEMENT_VERSION });
      const me = await request(app).get('/api/v1/users/me').set(...bearer(token));
      // No display_name at all — the exact state that produced two identical rows.
      await UserModel.updateOne(
        { _id: me.body.data.id },
        { $set: { display_name: null, email: null, phone: null } },
      );
      await request(app)
        .post('/api/v1/checkouts')
        .set(...bearer(token))
        .send({
          productId: hub.productIds[0],
          quantity: 2,
          conditionPhotoUrl: 'https://cdn.test/c.jpg',
          qrToken: hub.qrToken,
        })
        .expect(201);
    }

    const res = await request(app)
      .get(`/api/v1/hubs/${hub.hubId}/inventory-map`)
      .set(...bearer(hub.hubToken));
    expect(res.status).toBe(200);

    const names = res.body.data.holders.map((h: { sellerName: string }) => h.sellerName);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2); // distinguishable, which "Seller" twice was not
  });

  it('refuses a non-owner — it discloses specific sellers’ live positions', async () => {
    const hub = await makeHub('c5auth', { products: [{ qty: 5 }] });
    const other = await makeHub('c5other');

    const res = await request(app)
      .get(`/api/v1/hubs/${hub.hubId}/inventory-map`)
      .set(...bearer(other.hubToken));
    expect(res.status).toBe(403);
  });
});
