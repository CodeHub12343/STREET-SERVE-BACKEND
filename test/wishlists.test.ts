import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { NotificationModel } from '../src/modules/notifications/notifications.model';
import { wishlistsService } from '../src/modules/wishlists/wishlists.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * 7.2 / M-16 — wish lists with back-in-stock notification.
 *
 * A wish list without the alert is a bookmark. What these tests protect is the alert's restraint:
 * it fires on the false → true EDGE, once per wish. A menu item flickers in and out of availability
 * across a service, and a feature that notified on every toggle would be uninstalled by lunchtime.
 */
const app = createApp();

async function vendorWithItem(prefix: string) {
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
    .send({ name: 'Birria Taco', priceCents: 1000 });
  return { token, businessId, menuItemId: item.body.data.id as string };
}

async function customer(prefix: string) {
  const userId = await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  return { userId, token: await mintToken(`${prefix}|cust`) };
}

function setAvailability(v: { token: string; businessId: string; menuItemId: string }, available: boolean) {
  return request(app)
    .patch(`/api/v1/businesses/${v.businessId}/menu/${v.menuItemId}`)
    .set(...bearer(v.token))
    .send({ isAvailable: available });
}

/**
 * Notifications persist fire-and-forget, so a read can beat the write. Poll rather than sleeping a
 * fixed amount: fast when it is fast, and it cannot start passing for the wrong reason on a slow
 * machine — which is exactly where a fixed sleep gives up.
 */
async function waitForCount(
  filter: Record<string, unknown>,
  atLeast: number,
): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const n = await NotificationModel.countDocuments(filter);
    if (n >= atLeast) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
  return NotificationModel.countDocuments(filter);
}

/** For the negative case: settle briefly, then assert nothing arrived. */
async function settle(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('wish lists (7.2)', () => {
  it('adds, lists, and removes an item', async () => {
    const v = await vendorWithItem('wl-crud');
    const c = await customer('wl-crud');

    const added = await request(app)
      .post('/api/v1/users/me/wishlist')
      .set(...bearer(c.token))
      .send({ subjectType: 'menu_item', subjectId: v.menuItemId });
    expect(added.status).toBe(201);
    // The label is captured at add time so the list survives a rename or a deletion.
    expect(added.body.data.label).toBe('Birria Taco');

    const list = await request(app).get('/api/v1/users/me/wishlist').set(...bearer(c.token));
    expect(list.body.data).toHaveLength(1);

    const removed = await request(app)
      .delete(`/api/v1/users/me/wishlist/${added.body.data.id}`)
      .set(...bearer(c.token));
    expect(removed.status).toBe(200);
    const after = await request(app).get('/api/v1/users/me/wishlist').set(...bearer(c.token));
    expect(after.body.data).toHaveLength(0);
  });

  it('adding twice is not an error — it is already what the user wanted', async () => {
    const v = await vendorWithItem('wl-dupe');
    const c = await customer('wl-dupe');
    const body = { subjectType: 'menu_item', subjectId: v.menuItemId };

    const first = await request(app).post('/api/v1/users/me/wishlist').set(...bearer(c.token)).send(body);
    const second = await request(app).post('/api/v1/users/me/wishlist').set(...bearer(c.token)).send(body);

    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    const list = await request(app).get('/api/v1/users/me/wishlist').set(...bearer(c.token));
    expect(list.body.data).toHaveLength(1);
  });

  it('notifies when a menu item comes back, exactly once', async () => {
    const v = await vendorWithItem('wl-alert');
    const c = await customer('wl-alert');

    await setAvailability(v, false);
    await request(app)
      .post('/api/v1/users/me/wishlist')
      .set(...bearer(c.token))
      .send({ subjectType: 'menu_item', subjectId: v.menuItemId });

    await setAvailability(v, true);
    await waitForCount({ user_id: c.userId, category: 'wishlist' }, 1);

    const alerts = await NotificationModel.find({
      user_id: c.userId,
      category: 'wishlist',
    }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toContain('Birria Taco');
  });

  it('does not re-alert when the item toggles again', async () => {
    // A food menu flickers all service. One wish, one alert.
    const v = await vendorWithItem('wl-flicker');
    const c = await customer('wl-flicker');

    await setAvailability(v, false);
    await request(app)
      .post('/api/v1/users/me/wishlist')
      .set(...bearer(c.token))
      .send({ subjectType: 'menu_item', subjectId: v.menuItemId });

    for (let i = 0; i < 3; i++) {
      await setAvailability(v, true);
      await setAvailability(v, false);
    }
    // One alert must arrive; the assertion is that a SECOND never does, so settle after it lands.
    await waitForCount({ user_id: c.userId, category: 'wishlist' }, 1);
    await settle();
    expect(
      await NotificationModel.countDocuments({ user_id: c.userId, category: 'wishlist' }),
    ).toBe(1);
  });

  it('does not alert on a save that leaves an already-available item available', async () => {
    // Only the false → true edge. Otherwise every unrelated edit re-notifies.
    const v = await vendorWithItem('wl-edge');
    const c = await customer('wl-edge');

    await request(app)
      .post('/api/v1/users/me/wishlist')
      .set(...bearer(c.token))
      .send({ subjectType: 'menu_item', subjectId: v.menuItemId });

    await setAvailability(v, true); // it was already available
    await settle();

    expect(
      await NotificationModel.countDocuments({ user_id: c.userId, category: 'wishlist' }),
    ).toBe(0);
  });

  it('reports how many people are waiting — a reason for the vendor to restock', async () => {
    const v = await vendorWithItem('wl-count');
    const a = await customer('wl-count-a');
    const b = await customer('wl-count-b');

    for (const c of [a, b]) {
      await request(app)
        .post('/api/v1/users/me/wishlist')
        .set(...bearer(c.token))
        .send({ subjectType: 'menu_item', subjectId: v.menuItemId });
    }

    expect(await wishlistsService.waitingCount('menu_item', v.menuItemId)).toBe(2);
  });

  it('refuses to wish for something that does not exist', async () => {
    const c = await customer('wl-missing');
    const res = await request(app)
      .post('/api/v1/users/me/wishlist')
      .set(...bearer(c.token))
      .send({ subjectType: 'menu_item', subjectId: 'a'.repeat(24) });
    expect(res.status).toBe(404);
  });

  it("cannot remove someone else's wish", async () => {
    const v = await vendorWithItem('wl-idor');
    const owner = await customer('wl-idor-owner');
    const intruder = await customer('wl-idor-intruder');

    const added = await request(app)
      .post('/api/v1/users/me/wishlist')
      .set(...bearer(owner.token))
      .send({ subjectType: 'menu_item', subjectId: v.menuItemId });

    const res = await request(app)
      .delete(`/api/v1/users/me/wishlist/${added.body.data.id}`)
      .set(...bearer(intruder.token));
    expect(res.status).toBe(404);
  });
});
