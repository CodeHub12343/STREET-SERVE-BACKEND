import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { MAX_FLASH_SALE_DAYS } from '../src/modules/promotions/promotions.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * 7.6 / P-15 — flash sales.
 *
 * Built deliberately AFTER A-7 unified the discount model, so what these tests mostly assert is
 * that flash sales did **not** become a third parallel discount system: they produce candidates
 * for the one contest, and the contest decides.
 */
const app = createApp();

async function vendor(prefix: string) {
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
  const item = await request(app)
    .post(`/api/v1/businesses/${businessId}/menu`)
    .set(...bearer(token))
    .send({ name: 'Taco', priceCents: 1000 });
  return { token, businessId, menuItemId: item.body.data.id as string };
}

async function customer(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  return mintToken(`${prefix}|cust`);
}

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe('flash sales (7.6)', () => {
  it('discounts the quote a customer is shown', async () => {
    const v = await vendor('fs-basic');
    const custToken = await customer('fs-basic');

    const created = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({ percent: 25, startsAt: inMinutes(0), endsAt: inMinutes(60) });
    expect(created.status).toBe(201);
    expect(created.body.data.live).toBe(true);

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(custToken))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 2 }] });

    expect(quote.status).toBe(200);
    expect(quote.body.data.breakdown.subtotalCents).toBe(2000);
    expect(quote.body.data.breakdown.discountCents).toBe(500);
    // A receipt line reading "-25%" tells a customer nothing. The reason travels with the number.
    expect(quote.body.data.discount.source).toBe('flash_sale');
    expect(quote.body.data.discount.label).toContain('25%');
  });

  it('an item-scoped sale does not discount other items', async () => {
    // A 50%-off sale on a drink nobody ordered must not discount the tacos.
    const v = await vendor('fs-scope');
    const other = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/menu`)
      .set(...bearer(v.token))
      .send({ name: 'Horchata', priceCents: 400 });
    const custToken = await customer('fs-scope');

    await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({
        menuItemId: other.body.data.id,
        percent: 50,
        startsAt: inMinutes(0),
        endsAt: inMinutes(60),
      });

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(custToken))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    expect(quote.body.data.breakdown.discountCents).toBe(0);
    expect(quote.body.data.discount.source).toBeNull();
  });

  it('a sale outside its window does nothing', async () => {
    const v = await vendor('fs-window');
    const custToken = await customer('fs-window');

    await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({ percent: 40, startsAt: inMinutes(60), endsAt: inMinutes(120) });

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(custToken))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });
    expect(quote.body.data.breakdown.discountCents).toBe(0);

    // …and it is not shown as live to a customer either.
    const live = await request(app).get(`/api/v1/businesses/${v.businessId}/flash-sales`);
    expect(live.body.data).toHaveLength(0);
  });

  it('a cancelled sale stops discounting but is not deleted', async () => {
    // A customer who saw the sale price needs an explanation, and a deleted sale explains nothing.
    const v = await vendor('fs-cancel');
    const custToken = await customer('fs-cancel');

    const created = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({ percent: 30, startsAt: inMinutes(0), endsAt: inMinutes(60) });

    await request(app)
      .post(`/api/v1/flash-sales/${created.body.data.id}/cancel`)
      .set(...bearer(v.token));

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(custToken))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });
    expect(quote.body.data.breakdown.discountCents).toBe(0);

    const all = await request(app)
      .get(`/api/v1/businesses/${v.businessId}/flash-sales/all`)
      .set(...bearer(v.token));
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0].cancelled).toBe(true);
  });

  it('refuses a backdated sale — it would re-price orders already placed', async () => {
    const v = await vendor('fs-backdate');
    const res = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({ percent: 20, startsAt: inMinutes(-120), endsAt: inMinutes(60) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('past');
  });

  it('refuses a sale longer than the maximum — that is a price change, not a flash sale', async () => {
    const v = await vendor('fs-long');
    const res = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({
        percent: 20,
        startsAt: inMinutes(0),
        endsAt: new Date(Date.now() + (MAX_FLASH_SALE_DAYS + 1) * 86_400_000).toISOString(),
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // The message has to say what to do instead, or the vendor just retries with 13 days.
    expect(JSON.stringify(res.body)).toContain('price');
  });

  it('a non-owner cannot create or cancel a sale for someone else', async () => {
    const v = await vendor('fs-owner');
    const intruder = await vendor('fs-owner-other');

    const res = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(intruder.token))
      .send({ percent: 90, startsAt: inMinutes(0), endsAt: inMinutes(60) });
    expect([403, 404]).toContain(res.status);
  });

  it('does NOT stack with a queue discount — the single best one wins', async () => {
    // 20% queue + 30% flash would compound to 44%. Nobody authored that number, and a vendor
    // running a sale during a busy line-up should not accidentally give the shop away.
    const v = await vendor('fs-stack');
    const custToken = await customer('fs-stack');

    await request(app)
      .put(`/api/v1/queues/business/${v.businessId}/discount-schedule`)
      .set(...bearer(v.token))
      .send({ tiers: [{ position: 1, discount_percent: 20 }], capPercent: 20 });
    await request(app)
      .post(`/api/v1/queues/business/${v.businessId}/join`)
      .set(...bearer(custToken))
      .send({});
    await request(app)
      .post(`/api/v1/businesses/${v.businessId}/flash-sales`)
      .set(...bearer(v.token))
      .send({ percent: 30, startsAt: inMinutes(0), endsAt: inMinutes(60) });

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(custToken))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    // 30% of 1000 = 300, not 440.
    expect(quote.body.data.breakdown.discountCents).toBe(300);
    expect(quote.body.data.discount.source).toBe('flash_sale');
    // …and the customer can see the queue discount was considered, so nothing looks taken away.
    expect(quote.body.data.discount.alsoAvailable).toEqual([
      expect.objectContaining({ source: 'queue_position', percent: 20 }),
    ]);
  });
});
