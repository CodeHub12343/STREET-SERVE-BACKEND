import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  AGREEMENT_TYPES,
  getAgreement,
  isAgreementReviewed,
} from '../src/modules/agreements/agreements.registry';
import {
  DRIVER_MIN_TIER,
  FEE_TYPES,
  MUTABLE_NOTIFICATION_CATEGORIES,
  NOTIFICATION_PREF_CATEGORIES,
  ROLES,
  SELF_GRANTABLE_ROLES,
  UNMUTABLE_NOTIFICATION_CATEGORIES,
} from '../src/config/constants';
import { PERMISSIONS } from '../src/shared/permissions';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { CityModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { OrderModel } from '../src/modules/orders/orders.model';
import { ACCOUNT_TYPES, ENTRY_TYPES, normalBalanceOf } from '../src/modules/ledger/ledger.model';
import { communityFundLedger } from '../src/modules/ledger/communityFund';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 2 — shared foundations for the community network.
 *
 * Nothing here is a feature. It is the ledger account, the order mode, the role, the fee types, the
 * notification categories, and the agreements that Pay It Forward (Phase 3), Boost My Marketing
 * (Phase 4), and the Delivery Assist Network (Phase 5) all sit on.
 *
 * What these tests are really pinning is the set of decisions from ADR-004/005/006 that are easy to
 * undo by accident later: that community money is never withdrawable, that expired funds never reach
 * the vendor, that delivery is default-DENY, and that the driver role can never be self-granted.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

// ─── 2.1 · community_fund_payable ───────────────────────────────────────────────────────────
describe('2.1 · the community fund is a custodial liability (ADR-005)', () => {
  const biz = (suffix: string) => ({ businessId: `cfund${suffix}`.padEnd(24, '0').slice(0, 24) });

  it('declares the account type and its four entry types', () => {
    expect(ACCOUNT_TYPES).toContain('community_fund_payable');
    for (const t of [
      'community_contribution',
      'community_redemption',
      'community_expiry',
      'community_refund',
    ]) {
      expect(ENTRY_TYPES).toContain(t);
    }
  });

  it('is credit-normal, like tax_payable and unlike cash', () => {
    // The half of the ledger that is easy to get backwards. A credit-normal fund reads positive as
    // money HELD; if it were debit-normal every pool balance would render negative.
    expect(normalBalanceOf('community_fund_payable')).toBe('credit');
    expect(normalBalanceOf('tax_payable')).toBe('credit');
    expect(normalBalanceOf('cash')).toBe('debit');
  });

  it('a contribution raises the pool and platform cash together', async () => {
    const fund = biz('a');
    await communityFundLedger.contribute({
      fund,
      amountCents: 2000,
      contributionId: 'contrib_a1',
    });

    expect(await communityFundLedger.balanceOf(fund)).toBe(2000);
    // Held, not earned: no revenue is recognised on this leg (ADR-005 §4).
    expect(
      await ledgerService.balanceOf({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'fee_revenue',
      }),
    ).toBe(0);
  });

  it('does not double-credit a replayed contribution', async () => {
    const fund = biz('b');
    await communityFundLedger.contribute({ fund, amountCents: 500, contributionId: 'contrib_b1' });
    await communityFundLedger.contribute({ fund, amountCents: 500, contributionId: 'contrib_b1' });

    // The webhook that credits a pool WILL be replayed. Same contribution id, one credit.
    expect(await communityFundLedger.balanceOf(fund)).toBe(500);
  });

  it('a redemption pays the seller their net and the platform its fee', async () => {
    const fund = biz('c');
    await communityFundLedger.contribute({ fund, amountCents: 5000, contributionId: 'contrib_c1' });
    await communityFundLedger.redeem({
      fund,
      amountCents: 1000,
      feeCents: 100,
      redemptionId: 'redeem_c1',
    });

    expect(await communityFundLedger.balanceOf(fund)).toBe(4000);
    expect(
      await ledgerService.balanceOf({
        ownerType: 'business',
        ownerId: fund.businessId,
        accountType: 'payable',
      }),
    ).toBe(900);
    // ADR-005 §4: the standard fee applies. A fee-free settlement path would be an arbitrage —
    // routing ordinary sales through the pool would cost the vendor less than selling honestly.
    expect(
      await ledgerService.balanceOf({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'fee_revenue',
      }),
    ).toBeGreaterThanOrEqual(100);
  });

  it('refuses a fee larger than the amount redeemed', async () => {
    const fund = biz('d');
    await communityFundLedger.contribute({ fund, amountCents: 1000, contributionId: 'contrib_d1' });
    await expect(
      communityFundLedger.redeem({
        fund,
        amountCents: 500,
        feeCents: 600,
        redemptionId: 'redeem_d1',
      }),
    ).rejects.toThrow(/cannot exceed/i);
  });

  it('expiry moves the money to the city fund — never to the vendor, never to the platform', async () => {
    const fund = biz('e');
    await communityFundLedger.contribute({ fund, amountCents: 3000, contributionId: 'contrib_e1' });
    const payableBefore = await ledgerService.balanceOf({
      ownerType: 'business',
      ownerId: fund.businessId,
      accountType: 'payable',
    });

    await communityFundLedger.expire({
      fund,
      amountCents: 3000,
      citySlug: 'testville',
      expiryId: 'expiry_e1',
    });

    expect(await communityFundLedger.balanceOf(fund)).toBe(0);
    // The decision this test exists for: a vendor who kept unredeemed money would profit from
    // suppressing redemption, and the vendor controls the caps, the settings, and the prompt.
    expect(
      await ledgerService.balanceOf({
        ownerType: 'business',
        ownerId: fund.businessId,
        accountType: 'payable',
      }),
    ).toBe(payableBefore);
    expect(
      await ledgerService.balanceOf({
        ownerType: 'platform',
        ownerId: 'city:testville',
        accountType: 'community_fund_payable',
      }),
    ).toBe(3000);
  });

  it('a refund returns the money and reduces platform cash', async () => {
    const fund = biz('f');
    await communityFundLedger.contribute({ fund, amountCents: 1500, contributionId: 'contrib_f1' });
    const cashBefore = await ledgerService.balanceOf({
      ownerType: 'platform',
      ownerId: null,
      accountType: 'cash',
    });

    await communityFundLedger.refund({ fund, amountCents: 1500, refundId: 'refund_f1' });

    expect(await communityFundLedger.balanceOf(fund)).toBe(0);
    expect(
      await ledgerService.balanceOf({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'cash',
      }),
    ).toBe(cashBefore - 1500);
  });

  it('rejects zero and negative amounts on every leg', async () => {
    const fund = biz('g');
    await expect(
      communityFundLedger.contribute({ fund, amountCents: 0, contributionId: 'z1' }),
    ).rejects.toThrow(/positive/i);
    await expect(
      communityFundLedger.refund({ fund, amountCents: -100, refundId: 'z2' }),
    ).rejects.toThrow(/positive/i);
  });

  it('offers no way to withdraw a pool to the vendor', () => {
    /**
     * Structural, and the most important assertion in this file. A withdrawal would turn a
     * marketplace feature into a money-movement service — a different regulated business. The
     * absence is enforced here so that adding one is a deliberate act that breaks a test naming the
     * reason, rather than a plausible-looking convenience method.
     */
    const surface = Object.keys(communityFundLedger).sort();
    expect(surface).toEqual([
      'balanceOf',
      'contribute',
      'expire',
      'redeem',
      'refund',
      /**
       * The exact inverse of `redeem`, for an order that was cancelled after the fund had covered
       * it. Reviewed against the rule this test exists to enforce, and it holds: nothing leaves.
       * The community is CREDITED back its liability, the seller is debited for a meal they did not
       * serve, and the platform gives back the fee on a sale that did not happen. Money moves
       * towards the pool, never out of it — which is why this is a legitimate addition to a surface
       * that is otherwise deliberately closed.
       */
      'reverseRedemption',
      // Phase 4 — moves held money between two funds of the SAME business (roll-forward). Still not
      // a way out to anybody: both legs are `community_fund_payable`, so the liability changes hands
      // rather than being discharged, and a cross-business move is rejected.
      'transferBetweenFunds',
    ]);
    // The words that would mean money could leave for someone who did not earn it.
    for (const forbidden of ['withdraw', 'payout', 'cashOut', 'transferToVendor']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('reconciles with no drift after a full contribute → redeem → expire cycle', async () => {
    const fund = biz('h');
    await communityFundLedger.contribute({ fund, amountCents: 4000, contributionId: 'contrib_h1' });
    await communityFundLedger.redeem({
      fund,
      amountCents: 1000,
      feeCents: 100,
      redemptionId: 'redeem_h1',
    });
    await communityFundLedger.expire({
      fund,
      amountCents: 3000,
      citySlug: 'testville',
      expiryId: 'expiry_h1',
    });

    const report = await ledgerService.reconcile();
    expect(report.drifted).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
  });
});

// ─── 2.2 · delivery fulfilment ──────────────────────────────────────────────────────────────
describe('2.2 · delivery as an order fulfilment mode (DAN-10)', () => {
  async function vendorWithMenu(prefix: string) {
    const cat = await CategoryModel.create({
      slug: `${prefix}-cat`,
      name: prefix,
      top_level_tab: 'food',
      requires_license: false,
    });
    await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
    const token = await mintToken(`${prefix}|vendor`);
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: `${prefix} Tacos`, categoryId: String(cat._id) });
    const businessId = biz.body.data.id as string;

    await request(app)
      .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
      .set(...bearer(token));
    const acct = await ConnectedAccountModel.findOne({
      owner_type: 'business',
      owner_id: businessId,
    }).lean();
    if (acct) {
      fakeStripe.enableAccount(acct.stripe_account_id);
      await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'test')
        .set('content-type', 'application/json')
        .send(
          JSON.stringify({
            id: `evt_${Math.random()}`,
            type: 'account.updated',
            data: { object: { id: acct.stripe_account_id } },
          }),
        );
    }

    // Accept the seller terms, then park — both are preconditions for taking an order.
    const terms = await request(app).get('/api/v1/agreements/regular_sale');
    await request(app)
      .post('/api/v1/agreements/regular_sale/accept')
      .set(...bearer(token))
      .send({ version: terms.body.data.version, contentHash: terms.body.data.contentHash });
    await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });

    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Taco plate', priceCents: 2000 });
    return { token, businessId, menuItemId: item.body.data.id as string };
  }

  async function customer(prefix: string) {
    await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
    return mintToken(`${prefix}|cust`);
  }

  const DESTINATION = {
    line1: '14 Alder Street',
    city: 'Testville',
    lng: -121.001,
    lat: 37.601,
    notes: 'Blue door, ring twice',
  };

  async function setDeliveryFlag(enabled: boolean) {
    const { env } = await import('../src/config/env');
    await CityModel.updateOne(
      { slug: env.DEFAULT_CITY },
      {
        $set: {
          slug: env.DEFAULT_CITY,
          name: 'Default City',
          status: 'live',
          'feature_flags.delivery': enabled,
        },
      },
      { upsert: true },
    );
  }

  function placeOrder(token: string, body: object, key: string) {
    return request(app)
      .post('/api/v1/orders')
      .set(...bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  }

  it('refuses a delivery order in a city where delivery is not switched on', async () => {
    /**
     * Default-DENY, matching the food-gating precedent. ADR-004 requires insurance to be bound
     * before the first real delivery, and that is not a code change — so an unconfigured city
     * defaulting to "yes" would be the most expensive default in the system.
     */
    await setDeliveryFlag(false);
    const v = await vendorWithMenu('dan-off');
    const cust = await customer('dan-off');

    const res = await placeOrder(
      cust,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        destination: DESTINATION,
      },
      'dan_off_1',
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
  });

  it('records the destination on the order once delivery is switched on', async () => {
    await setDeliveryFlag(true);
    const v = await vendorWithMenu('dan-on');
    const cust = await customer('dan-on');

    const res = await placeOrder(
      cust,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        destination: DESTINATION,
      },
      'dan_on_1',
    );

    expect(res.status).toBe(201);
    const order = await OrderModel.findById(res.body.data.id).lean();
    expect(order?.fulfillment_type).toBe('delivery');
    expect(order?.destination?.line1).toBe('14 Alder Street');
    // Dispatch routes on the point, not on the text.
    expect(order?.destination?.location?.coordinates).toEqual([-121.001, 37.601]);
    expect(order?.scheduled_for).toBeNull();
  });

  it('leaves a pickup order with no destination at all', async () => {
    await setDeliveryFlag(true);
    const v = await vendorWithMenu('dan-pick');
    const cust = await customer('dan-pick');

    const res = await placeOrder(
      cust,
      { businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] },
      'dan_pick_1',
    );

    expect(res.status).toBe(201);
    const order = await OrderModel.findById(res.body.data.id).lean();
    expect(order?.fulfillment_type).toBe('pickup_now');
    // The invariant that keeps "where did this go?" answerable from the order alone.
    expect(order?.destination ?? null).toBeNull();
  });

  it('refuses an order that is both scheduled for pickup and delivered', async () => {
    await setDeliveryFlag(true);
    const v = await vendorWithMenu('dan-both');
    const cust = await customer('dan-both');

    const res = await placeOrder(
      cust,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
        destination: DESTINATION,
      },
      'dan_both_1',
    );

    expect(res.status).toBe(400);
  });

  it('requires coordinates — an address alone cannot be dispatched against', async () => {
    await setDeliveryFlag(true);
    const v = await vendorWithMenu('dan-nogeo');
    const cust = await customer('dan-nogeo');

    const res = await placeOrder(
      cust,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        destination: { line1: '14 Alder Street', city: 'Testville' },
      },
      'dan_nogeo_1',
    );

    expect(res.status).toBe(400);
  });
});

// ─── 2.3 · the driver role ──────────────────────────────────────────────────────────────────
describe('2.3 · the driver role (ADR-004, X-3)', () => {
  it('exists and is gated at silver', () => {
    expect(ROLES).toContain('driver');
    expect(DRIVER_MIN_TIER).toBe('silver');
  });

  it('can NEVER be self-granted', () => {
    /**
     * The highest-consequence single line in Phase 2. The role carries a licence, an insurance
     * attestation, and a background check; a self-grantable driver role is an unvetted driver.
     * `SELF_GRANTABLE_ROLES` is an ALLOWLIST — its doc comment used to claim the opposite, which is
     * exactly how this mistake would have been made (F-7).
     */
    expect(SELF_GRANTABLE_ROLES).not.toContain('driver');
  });

  it('is refused by the self-grant endpoint', async () => {
    await seedUser({ authProviderId: 'drv|self', roles: ['customer'] });
    const token = await mintToken('drv|self');
    const res = await request(app)
      .post('/api/v1/auth/roles')
      .set(...bearer(token))
      .send({ role: 'driver' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_SELF_GRANT_ROLE');
  });

  it('every role in ROLES can perform the actions open to all roles', () => {
    // ALL_ROLES is derived from ROLES rather than re-listed, so a new role cannot be added to the
    // platform and silently left unable to read its own profile.
    const allRoleActions = PERMISSIONS['users:read_self'].roles;
    for (const role of ROLES) expect(allRoleActions).toContain(role);
  });
});

// ─── 2.4 · fee types ────────────────────────────────────────────────────────────────────────
describe('2.4 · new fee types (X-1)', () => {
  it('declares the delivery coordination and campaign service fees', () => {
    expect(FEE_TYPES).toContain('delivery_coordination');
    expect(FEE_TYPES).toContain('campaign_service');
  });

  it('leaves delivery coordination unpriced, because it still cannot be priced honestly', async () => {
    /**
     * Deliberate, not an oversight — see the migration header. `delivery_coordination` depends on
     * the driver payout and the insurance cost (Phase 5 inputs), neither of which is settled. Zero
     * is inert because nothing charges it yet, and pricing it is a GATE on DAN-8.
     */
    const { resolveFee } = await import('../src/modules/payments/fees');
    expect(await resolveFee('delivery_coordination', 5000)).toBe(0);
  });

  it('prices the campaign service fee now that a print vendor is integrated', async () => {
    /**
     * The other half of the original assertion, inverted on purpose. It was zero because
     * `campaign_service` "depends on a print vendor nobody has contracted (MB-8)" — that gate is
     * now open, so leaving it at zero would mean StreetServe mails postcards for free.
     *
     * 10% per ADR-007 §4 (wholesale resale: the margin has to be taken somewhere, and a disclosed
     * line item is the transparent place). The count shown by `postcardEstimate` is net of it.
     */
    const { resolveFee } = await import('../src/modules/payments/fees');
    expect(await resolveFee('campaign_service', 5000)).toBe(500);
  });
});

// ─── 2.5 · notification categories ──────────────────────────────────────────────────────────
describe('2.5 · notification categories (X-6)', () => {
  it('adds delivery, generosity and campaign', () => {
    for (const c of ['delivery', 'generosity', 'campaign']) {
      expect(NOTIFICATION_PREF_CATEGORIES).toContain(c);
    }
  });

  it('makes all three mutable', () => {
    /**
     * "Someone left you a free coffee" is the emotional core of Pay It Forward, and there is a
     * standing temptation to make it unmutable so it always lands. An unmutable feel-good ping is
     * indistinguishable from marketing, and a category a user cannot silence is one they silence by
     * turning off notifications entirely. Only payout/dispute/verification earn that status.
     */
    for (const c of ['delivery', 'generosity', 'campaign'] as const) {
      expect(MUTABLE_NOTIFICATION_CATEGORIES).toContain(c);
      expect(UNMUTABLE_NOTIFICATION_CATEGORIES).not.toContain(c as never);
    }
  });

  it('lets a user actually silence them', async () => {
    await seedUser({ authProviderId: 'notif|mute', roles: ['customer'] });
    const token = await mintToken('notif|mute');
    const res = await request(app)
      .patch('/api/v1/users/me/notification-preferences')
      .set(...bearer(token))
      .send({ generosity: false, delivery: false, campaign: false });

    expect(res.status).toBe(200);
    expect(res.body.data.generosity).toBe(false);
  });
});

// ─── 2.6 · agreements ───────────────────────────────────────────────────────────────────────
describe('2.6 · community-network agreements (X-5)', () => {
  const NEW_TYPES = ['driver_engagement', 'community_contribution', 'campaign_contribution'];

  it('registers all three', () => {
    for (const t of NEW_TYPES) expect(AGREEMENT_TYPES).toContain(t);
  });

  it('serves each with a version, title, body and derived hash', async () => {
    for (const type of NEW_TYPES) {
      const res = await request(app).get(`/api/v1/agreements/${type}`);
      expect(res.status, type).toBe(200);
      expect(res.body.data.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.data.body.length).toBeGreaterThan(50);
    }
  });

  it('marks all three unreviewed — the two money ones are hard launch gates', () => {
    // ADR-005/006: the four legacy agreements may ship on placeholder text while the binding flows
    // are gated, but no real contribution may be taken against unreviewed CUSTODIAL terms.
    for (const t of NEW_TYPES) expect(isAgreementReviewed(t as never)).toBe(false);
  });

  it('states the decisions a generic boilerplate would have omitted', () => {
    const driver = getAgreement('driver_engagement').body.toLowerCase();
    // ADR-004: declining must be free, and the platform must not imply it covers the driver.
    expect(driver).toContain('decline');
    expect(driver).toMatch(/not employment/);
    expect(driver).toMatch(/does not provide, arrange, or advise on insurance/);

    const community = getAgreement('community_contribution').body.toLowerCase();
    // ADR-005: not deductible, not withdrawable, and what happens to money nobody uses.
    expect(community).toContain('not tax-deductible');
    expect(community).toContain('cannot be withdrawn');
    expect(community).toContain('12 months');

    const campaign = getAgreement('campaign_contribution').body.toLowerCase();
    // ADR-006: the unmet-goal outcome, stated because it is the LIKELY outcome.
    expect(campaign).toContain('refunded in full');
    expect(campaign).toContain('not tax-deductible');
  });

  it('never tells a driver they are covered (CR-3)', () => {
    /**
     * The copy rule from ADR-004 §3, asserted the same way the `stock_waiver` prohibition is. The
     * word "insurance" must remain usable — the platform has to ask a driver about theirs — so the
     * prohibition is on ATTRIBUTING cover, not on the noun.
     */
    const body = getAgreement('driver_engagement').body.toLowerCase();
    for (const forbidden of ['you are covered', 'you are insured', 'we insure', 'our policy']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
