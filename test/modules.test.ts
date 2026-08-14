import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CORE_MODULES } from '../src/config/constants';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ServiceModel } from '../src/modules/scheduling/scheduling.model';
import { BusinessModel } from '../src/modules/vendors/vendors.model';
import { resolveModules, setEnabledModules } from '../src/modules/vendors/modules.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * BP-1 — Business module resolver (BUSINESS_MODULE_SYSTEM.md §3).
 * The resolver decides what every business can do, so the whole chain is asserted here:
 * archetype defaults → category overrides → owner's set → auto rules → core forced on.
 */
const app = createApp();

let seq = 0;
async function makeBusiness(opts: {
  archetype?: string | null;
  tab?: string;
  requiresLicense?: boolean;
  isHub?: boolean;
  overrides?: Record<string, boolean>;
  enabledModules?: string[];
  ownerId?: string;
}) {
  seq += 1;
  const category = await CategoryModel.create({
    slug: `mod-cat-${seq}`,
    name: `Module Cat ${seq}`,
    top_level_tab: opts.tab ?? 'services',
    ...(opts.archetype === undefined ? {} : { archetype: opts.archetype }),
    module_overrides: opts.overrides ?? {},
    requires_license: opts.requiresLicense ?? false,
  });
  const business = await BusinessModel.create({
    owner_user_id: opts.ownerId ?? `owner-${seq}`,
    name: `Module Biz ${seq}`,
    category_id: category._id,
    is_hub: opts.isHub ?? false,
    ...(opts.enabledModules === undefined ? {} : { enabled_modules: opts.enabledModules }),
  });
  return { businessId: String(business._id), categoryId: String(category._id) };
}

describe('module resolver: archetype defaults', () => {
  it('counter_serve gets menu/ordering/queue/wave_down and is never offered services or booking-by-default', async () => {
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', tab: 'food' });
    const r = await resolveModules(businessId);

    expect(r.archetype).toBe('counter_serve');
    expect(r.enabled).toEqual(expect.arrayContaining(['menu', 'ordering', 'queue', 'wave_down']));
    expect(r.enabled).not.toContain('services');
    expect(r.enabled).not.toContain('booking');
    // `services` is hidden entirely for a counter-serve business — not merely off.
    expect(r.available).not.toContain('services');
  });

  it('appointment_service gets services/booking and is NEVER offered a menu or queue', async () => {
    const { businessId } = await makeBusiness({ archetype: 'appointment_service' });
    const r = await resolveModules(businessId);

    expect(r.enabled).toEqual(expect.arrayContaining(['services', 'booking']));
    expect(r.enabled).not.toContain('menu');
    // The core promise of the matrix: a barber is never offered a menu or a line-up queue.
    expect(r.available).not.toContain('menu');
    expect(r.available).not.toContain('queue');
  });

  /**
   * on_demand_service leads with BOOKING, not wave_down. Two businesses under the same "services"
   * tab used to behave differently for no reason a customer could see — a cleaner offered "Book an
   * appointment" while a courier offered "Wave". `wave_down` stays available so a locksmith whose
   * whole trade is "come now" can switch it back on; the default changed, the capability didn't.
   */
  it('on_demand_service leads with services/booking; wave_down is available but off', async () => {
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service' });
    const r = await resolveModules(businessId);

    expect(r.enabled).toEqual(expect.arrayContaining(['services', 'booking']));
    expect(r.enabled).not.toContain('wave_down');
    expect(r.available).toContain('wave_down');
    expect(r.available).not.toContain('menu');
  });

  it('goods_seller gets catalog/ordering/consignment', async () => {
    const { businessId } = await makeBusiness({ archetype: 'goods_seller', tab: 'shopping' });
    const r = await resolveModules(businessId);

    expect(r.enabled).toEqual(expect.arrayContaining(['catalog', 'ordering', 'consignment']));
    expect(r.enabled).not.toContain('booking');
    expect(r.available).not.toContain('services');
  });
});

describe('module resolver: composition rules', () => {
  it('core modules are always enabled and always locked', async () => {
    const { businessId } = await makeBusiness({ archetype: 'appointment_service' });
    const r = await resolveModules(businessId);

    for (const m of CORE_MODULES) {
      expect(r.enabled).toContain(m);
      expect(r.locked).toContain(m);
    }
  });

  it('a category override can switch a module on (mobile-detailing: booking)', async () => {
    const { businessId } = await makeBusiness({
      archetype: 'on_demand_service',
      overrides: { booking: true },
    });
    const r = await resolveModules(businessId);
    expect(r.enabled).toContain('booking');
  });

  it('a category override can switch a default off', async () => {
    const { businessId } = await makeBusiness({
      archetype: 'counter_serve',
      tab: 'food',
      overrides: { queue: false },
    });
    const r = await resolveModules(businessId);
    expect(r.enabled).not.toContain('queue');
    // Still offerable — the vendor may turn it back on.
    expect(r.available).toContain('queue');
  });

  it('enabled_modules undefined means INHERIT defaults, not "no modules"', async () => {
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', tab: 'food' });
    const r = await resolveModules(businessId);
    // The whole no-backfill guarantee rests on this.
    expect(r.enabled).toEqual(expect.arrayContaining(['menu', 'ordering', 'queue', 'wave_down']));
  });

  it('an explicit empty set keeps only core (the owner turned everything optional off)', async () => {
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', enabledModules: [] });
    const r = await resolveModules(businessId);

    expect(r.enabled.sort()).toEqual([...CORE_MODULES].sort());
    expect(r.enabled).not.toContain('menu');
  });

  it('drops a stored module the current archetype does not offer (re-categorised business)', async () => {
    // Was a food truck (menu), later re-categorised as a barber: Menu must not survive.
    const { businessId } = await makeBusiness({
      archetype: 'appointment_service',
      enabledModules: ['menu', 'services'],
    });
    const r = await resolveModules(businessId);

    expect(r.enabled).not.toContain('menu');
    expect(r.enabled).toContain('services');
  });
});

/**
 * One account, one commerce mode. The reported bug: a furniture seller's profile offered "Book an
 * appointment" next to "Order now", and the booking screen dead-ended on "this business hasn't
 * published any bookable services yet" — because nothing stopped `booking` being enabled for a
 * business that can't have services in the first place.
 */
describe('module resolver: commerce mode is exclusive', () => {
  it('no archetype can ever offer both ordering and booking', async () => {
    for (const archetype of [
      'counter_serve',
      'appointment_service',
      'on_demand_service',
      'goods_seller',
    ]) {
      const { businessId } = await makeBusiness({ archetype });
      const r = await resolveModules(businessId);
      const both = r.available.filter((m) => m === 'ordering' || m === 'booking');
      expect(both.length, `${archetype} offers ${both.join(' + ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('a goods seller is never offered booking — it has no services to be booked for', async () => {
    const { businessId } = await makeBusiness({ archetype: 'goods_seller', tab: 'shopping' });
    const r = await resolveModules(businessId);

    // Not merely off: absent, so the Modules screen never even shows the switch.
    expect(r.available).not.toContain('booking');
    expect(r.enabled).not.toContain('booking');
    expect(r.commerceMode).toBe('ordering');
  });

  it('an appointment business is never offered ordering — it has no menu to order from', async () => {
    const { businessId } = await makeBusiness({ archetype: 'appointment_service' });
    const r = await resolveModules(businessId);

    expect(r.available).not.toContain('ordering');
    expect(r.commerceMode).toBe('booking');
  });

  it('a category override cannot smuggle in a second commerce mode', async () => {
    // The override adds `booking` to a goods seller, which is exactly how the live business got
    // into this state. Rule A drops it: there is still nothing bookable behind it.
    const { businessId } = await makeBusiness({
      archetype: 'goods_seller',
      tab: 'shopping',
      overrides: { booking: true },
    });
    const r = await resolveModules(businessId);

    expect(r.enabled).not.toContain('booking');
    expect(r.commerceMode).toBe('ordering');
  });

  it('a legacy stored set holding BOTH resolves to the archetype’s mode, with no migration', async () => {
    // This is the live data fix: the furniture hub's dashboard showed Orders AND Bookings.
    const { businessId } = await makeBusiness({
      archetype: 'goods_seller',
      tab: 'shopping',
      overrides: { booking: true, services: true },
      enabledModules: ['menu', 'catalog', 'ordering', 'services', 'booking'],
    });
    const r = await resolveModules(businessId);

    expect(r.commerceMode).toBe('ordering');
    expect(r.enabled).toContain('ordering');
    expect(r.enabled).not.toContain('booking');
  });

  it('an on-demand trade that takes neither has no commerce mode at all', async () => {
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service' });
    // A locksmith runs purely on wave-downs. on_demand_service now DEFAULTS to booking, so this is
    // the owner opting out of both commerce modes — and the resolver must respect that rather than
    // forcing a mode on them, which would be the original bug inverted.
    const r = await setEnabledModules(businessId, [...CORE_MODULES, 'services', 'wave_down']);

    expect(r.commerceMode).toBeNull();
    expect(r.enabled).toContain('wave_down');
    expect(r.enabled).not.toContain('booking');
  });

  it('a mechanic may switch INTO booking — the mode is a choice, not a life sentence', async () => {
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service' });
    const r = await setEnabledModules(businessId, [...CORE_MODULES, 'services', 'booking']);

    expect(r.commerceMode).toBe('booking');
  });

  it('requesting both modes is rejected outright (422 MODULE_EXCLUSIVE), not silently resolved', async () => {
    const { businessId } = await makeBusiness({
      archetype: 'on_demand_service',
      overrides: { ordering: true, menu: true },
    });

    await expect(
      setEnabledModules(businessId, [...CORE_MODULES, 'services', 'booking', 'menu', 'ordering']),
    ).rejects.toMatchObject({ code: 'MODULE_EXCLUSIVE' });
  });
});

describe('module resolver: auto rules', () => {
  it('licensing is auto-enabled and locked for a regulated category', async () => {
    const { businessId } = await makeBusiness({
      archetype: 'counter_serve',
      tab: 'food',
      requiresLicense: true,
    });
    const r = await resolveModules(businessId);

    expect(r.enabled).toContain('licensing');
    expect(r.locked).toContain('licensing');
  });

  it('licensing stays off for an unregulated category', async () => {
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service' });
    const r = await resolveModules(businessId);
    expect(r.enabled).not.toContain('licensing');
  });

  it('hub_operations is auto-enabled only for a hub', async () => {
    const hub = await makeBusiness({ archetype: 'goods_seller', isHub: true });
    const notHub = await makeBusiness({ archetype: 'goods_seller' });

    expect((await resolveModules(hub.businessId)).enabled).toContain('hub_operations');
    // The reported bug: every vendor saw Hub screens. Non-hubs must never get them.
    expect((await resolveModules(notHub.businessId)).enabled).not.toContain('hub_operations');
  });

  it('auto modules survive an explicit empty set (they are not the owner’s to remove)', async () => {
    const { businessId } = await makeBusiness({
      archetype: 'counter_serve',
      requiresLicense: true,
      isHub: true,
      enabledModules: [],
    });
    const r = await resolveModules(businessId);

    expect(r.enabled).toContain('licensing');
    expect(r.enabled).toContain('hub_operations');
  });
});

describe('module resolver: legacy fallback', () => {
  it('a category with no archetype falls back by tab instead of crashing', async () => {
    const food = await makeBusiness({ archetype: null, tab: 'food' });
    const services = await makeBusiness({ archetype: null, tab: 'services' });
    const shopping = await makeBusiness({ archetype: null, tab: 'shopping' });

    expect((await resolveModules(food.businessId)).archetype).toBe('counter_serve');
    expect((await resolveModules(services.businessId)).archetype).toBe('on_demand_service');
    expect((await resolveModules(shopping.businessId)).archetype).toBe('goods_seller');
  });
});

describe('setEnabledModules', () => {
  it('persists a valid set and re-resolves', async () => {
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service' });
    const r = await setEnabledModules(businessId, [
      ...CORE_MODULES,
      'services',
      'wave_down',
      'booking',
    ]);
    expect(r.enabled).toContain('booking');

    const again = await resolveModules(businessId);
    expect(again.enabled).toContain('booking');
  });

  it('rejects a module the archetype does not offer (422 MODULE_NOT_AVAILABLE)', async () => {
    const { businessId } = await makeBusiness({ archetype: 'appointment_service' });
    await expect(setEnabledModules(businessId, [...CORE_MODULES, 'menu'])).rejects.toMatchObject({
      code: 'MODULE_NOT_AVAILABLE',
    });
  });

  it('rejects removing a locked module (422 MODULE_LOCKED)', async () => {
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service' });
    // Omits core modules → attempts to disable them.
    await expect(setEnabledModules(businessId, ['services'])).rejects.toMatchObject({
      code: 'MODULE_LOCKED',
    });
  });
});

describe('BP-3: registration persists what it asks for', () => {
  it('hours + service area + travel fee round-trip through GET /businesses/:id', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp3|owner', roles: ['vendor'] });
    const token = await mintToken('bp3|owner');
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service', ownerId });

    const patch = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(token))
      .send({
        hours: [
          { day: 1, open: '09:00', close: '17:30' },
          { day: 2, open: '09:00', close: '17:30' },
        ],
        serviceArea: [-120.9969, 37.6391],
        serviceRadiusM: 8000,
        travelFeeCents: 1500,
      });
    expect(patch.status).toBe(200);

    // The old wizard collected a service area and silently discarded it — prove it survives.
    const read = await request(app).get(`/api/v1/businesses/${businessId}`);
    expect(read.status).toBe(200);
    expect(read.body.data.hours).toHaveLength(2);
    expect(read.body.data.hours[0]).toMatchObject({ day: 1, open: '09:00', close: '17:30' });
    expect(read.body.data.serviceArea).toEqual([-120.9969, 37.6391]);
    expect(read.body.data.serviceRadiusM).toBe(8000);
    expect(read.body.data.travelFeeCents).toBe(1500);
  });

  it('rejects hours whose close is not after open', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp3|badhours', roles: ['vendor'] });
    const token = await mintToken('bp3|badhours');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const res = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(token))
      .send({ hours: [{ day: 1, open: '17:00', close: '09:00' }] });

    expect(res.status).toBe(422);
  });

  it('rejects a malformed time', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp3|badtime', roles: ['vendor'] });
    const token = await mintToken('bp3|badtime');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const res = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(token))
      .send({ hours: [{ day: 1, open: '9am', close: '5pm' }] });

    expect(res.status).toBe(400);
  });

  it('a partial patch does not wipe an existing service area', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp3|partial', roles: ['vendor'] });
    const token = await mintToken('bp3|partial');
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service', ownerId });

    await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(token))
      .send({ serviceArea: [-120.9969, 37.6391], serviceRadiusM: 5000 })
      .expect(200);

    // Renaming must not clear geo the vendor already set.
    await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(token))
      .send({ name: 'Renamed Co' })
      .expect(200);

    const read = await request(app).get(`/api/v1/businesses/${businessId}`);
    expect(read.body.data.serviceArea).toEqual([-120.9969, 37.6391]);
    expect(read.body.data.serviceRadiusM).toBe(5000);
  });

  it('a new business inherits archetype defaults rather than freezing a stored set', async () => {
    // The business is created through the API here, so the owner id comes from the token.
    await seedUser({ authProviderId: 'bp3|create', roles: ['vendor'] });
    const token = await mintToken('bp3|create');
    const category = await CategoryModel.create({
      slug: 'bp3-create-cat',
      name: 'BP3 Create Cat',
      top_level_tab: 'food',
      archetype: 'counter_serve',
    });

    const created = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'BP3 Created Co', categoryId: String(category._id) });
    expect(created.status).toBe(201);

    const businessId = created.body.data.id as string;
    const stored = await BusinessModel.findById(businessId).lean();
    // Deliberately NOT seeded — undefined means inherit, so improving a default reaches it later.
    expect(stored?.enabled_modules).toBeUndefined();

    const mods = await request(app).get(`/api/v1/businesses/${businessId}/modules`);
    expect(mods.body.data.enabled).toEqual(expect.arrayContaining(['menu', 'ordering', 'queue']));
  });
});

describe('BP-4: services CRUD + menu delete semantics', () => {
  it('a service business can create, edit and retire services', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|barber', roles: ['vendor'] });
    const token = await mintToken('bp4|barber');
    const { businessId } = await makeBusiness({ archetype: 'appointment_service', ownerId });

    const created = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Men’s haircut', durationMin: 30, priceCents: 2500 });
    expect(created.status).toBe(201);
    const serviceId = created.body.data.id as string;

    const edited = await request(app)
      .patch(`/api/v1/businesses/${businessId}/services/${serviceId}`)
      .set(...bearer(token))
      .send({ priceCents: 3000, durationMin: 45 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.priceCents).toBe(3000);
    expect(edited.body.data.durationMin).toBe(45);

    const removed = await request(app)
      .delete(`/api/v1/businesses/${businessId}/services/${serviceId}`)
      .set(...bearer(token));
    expect(removed.status).toBe(200);

    // Gone from the vendor list AND the customer profile (same endpoint).
    const list = await request(app).get(`/api/v1/businesses/${businessId}/services`);
    expect(list.body.data).toHaveLength(0);
  });

  it('retiring a service is a SOFT delete — bookings reference it with no snapshot', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|soft', roles: ['vendor'] });
    const token = await mintToken('bp4|soft');
    const { businessId } = await makeBusiness({ archetype: 'appointment_service', ownerId });

    const created = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Beard trim', durationMin: 15, priceCents: 1500 });
    const serviceId = created.body.data.id as string;

    await request(app)
      .delete(`/api/v1/businesses/${businessId}/services/${serviceId}`)
      .set(...bearer(token))
      .expect(200);

    // The row must survive so an existing appointment can still resolve what it is for.
    const doc = await ServiceModel.findById(serviceId).lean();
    expect(doc).not.toBeNull();
    expect(doc?.active).toBe(false);
  });

  it('a service business cannot touch another business’s service', async () => {
    const ownerA = await seedUser({ authProviderId: 'bp4|a', roles: ['vendor'] });
    const tokenA = await mintToken('bp4|a');
    const a = await makeBusiness({ archetype: 'appointment_service', ownerId: ownerA });

    await seedUser({ authProviderId: 'bp4|b', roles: ['vendor'] });
    const tokenB = await mintToken('bp4|b');

    const created = await request(app)
      .post(`/api/v1/businesses/${a.businessId}/services`)
      .set(...bearer(tokenA))
      .send({ name: 'Cut', durationMin: 30, priceCents: 2000 });

    const res = await request(app)
      .delete(`/api/v1/businesses/${a.businessId}/services/${created.body.data.id}`)
      .set(...bearer(tokenB));
    expect(res.status).toBe(403);
  });

  it('a counter-serve business cannot add services (module gate)', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|food', roles: ['vendor'] });
    const token = await mintToken('bp4|food');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const res = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Nope', durationMin: 30, priceCents: 1000 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  it('menu delete is a HARD delete — order line items snapshot name + price', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|menu', roles: ['vendor'] });
    const token = await mintToken('bp4|menu');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const created = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Birria Tacos', priceCents: 1100 });
    expect(created.status).toBe(201);
    const itemId = created.body.data.id as string;

    await request(app)
      .delete(`/api/v1/businesses/${businessId}/menu/${itemId}`)
      .set(...bearer(token))
      .expect(200);

    // Truly gone — this is what lets the derived setup checklist come back.
    const list = await request(app).get(`/api/v1/businesses/${businessId}/menu`);
    expect(list.body.data).toHaveLength(0);
  });

  it('deleting the Today’s Special item clears the pointer rather than dangling', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|special', roles: ['vendor'] });
    const token = await mintToken('bp4|special');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const created = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Special of the day', priceCents: 900 });
    const itemId = created.body.data.id as string;

    await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(token))
      .send({ todaySpecialMenuItemId: itemId })
      .expect(200);

    await request(app)
      .delete(`/api/v1/businesses/${businessId}/menu/${itemId}`)
      .set(...bearer(token))
      .expect(200);

    const read = await request(app).get(`/api/v1/businesses/${businessId}`);
    expect(read.body.data.todaySpecialMenuItemId).toBeNull();
  });
});

describe('BP-5: category & archetype governance', () => {
  async function seedAdmin(sub: string) {
    await seedUser({ authProviderId: sub, roles: ['admin'] });
    return mintToken(sub);
  }

  async function makeSuggestion(name: string) {
    const ownerId = await seedUser({ authProviderId: `bp5|sub-${name}`, roles: ['vendor'] });
    const token = await mintToken(`bp5|sub-${name}`);
    const { businessId } = await makeBusiness({ archetype: 'goods_seller', ownerId });
    const res = await request(app)
      .post('/api/v1/category-suggestions')
      .set(...bearer(token))
      .send({ businessId, proposedName: name });
    expect(res.status).toBe(201);
    return { id: res.body.data.id as string, businessId };
  }

  it('GET /admin/category-suggestions lists real pending suggestions with the submitter', async () => {
    const adminToken = await seedAdmin('bp5|admin-list');
    await makeSuggestion('Drone Photography');

    const res = await request(app)
      .get('/api/v1/admin/category-suggestions')
      .set(...bearer(adminToken));

    expect(res.status).toBe(200);
    const row = (res.body.data as { proposedName: string; businessName: string }[]).find(
      (s) => s.proposedName === 'Drone Photography',
    );
    expect(row).toBeDefined();
    expect(row?.businessName).toEqual(expect.any(String));
  });

  it('the suggestion queue requires admin', async () => {
    await seedUser({ authProviderId: 'bp5|notadmin', roles: ['vendor'] });
    const token = await mintToken('bp5|notadmin');
    const res = await request(app)
      .get('/api/v1/admin/category-suggestions')
      .set(...bearer(token));
    expect(res.status).toBe(403);
  });

  /**
   * THE BP-5 exit criterion: approving with an archetype means a business registering under the
   * brand-new category gets a complete, correct product with no code change.
   */
  it('approving with an archetype gives the new category a working product', async () => {
    const adminToken = await seedAdmin('bp5|admin-approve');
    const { id } = await makeSuggestion('Mobile Bike Fitting');

    const review = await request(app)
      .post(`/api/v1/admin/category-suggestions/${id}/review`)
      .set(...bearer(adminToken))
      .send({ approve: true, topLevelTab: 'services', archetype: 'appointment_service' });
    expect(review.status).toBe(200);

    const categoryId = review.body.data.createdCategoryId as string;
    expect(categoryId).toEqual(expect.any(String));

    // Register a business under it and confirm modules resolve from the chosen archetype.
    const ownerId = await seedUser({ authProviderId: 'bp5|newbiz', roles: ['vendor'] });
    const business = await BusinessModel.create({
      owner_user_id: ownerId,
      name: 'Fits R Us',
      category_id: categoryId,
    });

    const mods = await resolveModules(String(business._id));
    expect(mods.archetype).toBe('appointment_service');
    expect(mods.enabled).toEqual(expect.arrayContaining(['services', 'booking']));
    expect(mods.enabled).not.toContain('menu');
    expect(mods.available).not.toContain('menu');
  });

  it('approving without an archetype falls back to the tab default rather than nothing', async () => {
    const adminToken = await seedAdmin('bp5|admin-default');
    const { id } = await makeSuggestion('Mobile Tyre Fitting');

    const review = await request(app)
      .post(`/api/v1/admin/category-suggestions/${id}/review`)
      .set(...bearer(adminToken))
      .send({ approve: true, topLevelTab: 'services' });
    expect(review.status).toBe(200);

    const category = await CategoryModel.findById(review.body.data.createdCategoryId).lean();
    // services → on_demand_service, so one-click approval still yields a usable product.
    expect(category?.archetype).toBe('on_demand_service');
  });

  it('approving a regulated category cascades the licence gate to its businesses', async () => {
    const adminToken = await seedAdmin('bp5|admin-reg');
    const { id } = await makeSuggestion('Mobile Tattoo Studio');

    const review = await request(app)
      .post(`/api/v1/admin/category-suggestions/${id}/review`)
      .set(...bearer(adminToken))
      .send({
        approve: true,
        topLevelTab: 'services',
        archetype: 'appointment_service',
        requiresLicense: true,
        regulatedBy: 'County Health Dept',
      });

    const ownerId = await seedUser({ authProviderId: 'bp5|tattoo', roles: ['vendor'] });
    const business = await BusinessModel.create({
      owner_user_id: ownerId,
      name: 'Ink Van',
      category_id: review.body.data.createdCategoryId,
    });

    const mods = await resolveModules(String(business._id));
    expect(mods.enabled).toContain('licensing');
    expect(mods.locked).toContain('licensing');
  });

  it('rejecting creates no category', async () => {
    const adminToken = await seedAdmin('bp5|admin-reject');
    const { id } = await makeSuggestion('Something Odd');

    const res = await request(app)
      .post(`/api/v1/admin/category-suggestions/${id}/review`)
      .set(...bearer(adminToken))
      .send({ approve: false });

    expect(res.status).toBe(200);
    expect(res.body.data.createdCategoryId).toBeNull();
    expect(await CategoryModel.findOne({ name: 'Something Odd' }).lean()).toBeNull();
  });

  it('admins can list the taxonomy with archetype + licence metadata', async () => {
    const adminToken = await seedAdmin('bp5|admin-tax');
    await CategoryModel.create({
      slug: 'bp5-tax-cat',
      name: 'BP5 Tax Cat',
      top_level_tab: 'services',
      archetype: 'on_demand_service',
      requires_license: true,
      regulated_by: 'Some Board',
    });

    const res = await request(app).get('/api/v1/admin/categories').set(...bearer(adminToken));
    expect(res.status).toBe(200);
    const row = (res.body.data as { slug: string; archetype: string; regulatedBy: string }[]).find(
      (c) => c.slug === 'bp5-tax-cat',
    );
    expect(row?.archetype).toBe('on_demand_service');
    expect(row?.regulatedBy).toBe('Some Board');
  });

  it('an admin can correct a wrong archetype without a migration', async () => {
    const adminToken = await seedAdmin('bp5|admin-fix');
    const category = await CategoryModel.create({
      slug: 'bp5-wrong',
      name: 'BP5 Wrong Archetype',
      top_level_tab: 'services',
      archetype: 'counter_serve', // wrong: this is a service business
    });
    const ownerId = await seedUser({ authProviderId: 'bp5|fixbiz', roles: ['vendor'] });
    const business = await BusinessModel.create({
      owner_user_id: ownerId,
      name: 'Wrongly Categorised Co',
      category_id: category._id,
    });
    expect((await resolveModules(String(business._id))).enabled).toContain('menu');

    const res = await request(app)
      .patch(`/api/v1/admin/categories/${String(category._id)}`)
      .set(...bearer(adminToken))
      .send({ archetype: 'on_demand_service' });
    expect(res.status).toBe(200);

    // The correction reaches every business that never customised — no backfill needed.
    const after = await resolveModules(String(business._id));
    expect(after.archetype).toBe('on_demand_service');
    expect(after.enabled).toContain('services');
    expect(after.enabled).not.toContain('menu');
  });

  it('category governance requires admin', async () => {
    await seedUser({ authProviderId: 'bp5|vendor-tax', roles: ['vendor'] });
    const token = await mintToken('bp5|vendor-tax');
    expect((await request(app).get('/api/v1/admin/categories').set(...bearer(token))).status).toBe(
      403,
    );
  });
});

describe('BP-4: the menu API contract', () => {
  /**
   * Regression: listMenu returned raw lean docs (_id / price_cents / is_available), so every
   * client read undefined — the vendor menu rendered "$NaN" and delete hit /menu/undefined, and
   * the customer's order screen was broken the same way. Only demo mode hid it.
   */
  it('list returns the API contract, never raw Mongo fields', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|contract', roles: ['vendor'] });
    const token = await mintToken('bp4|contract');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Churros', priceCents: 500 })
      .expect(201);

    const res = await request(app).get(`/api/v1/businesses/${businessId}/menu`);
    expect(res.status).toBe(200);
    const item = res.body.data[0];

    expect(item.id).toEqual(expect.any(String));
    expect(item.priceCents).toBe(500);
    expect(item.available).toBe(true);
    // The raw shape must not leak — that is exactly what produced $NaN and /menu/undefined.
    expect(item._id).toBeUndefined();
    expect(item.price_cents).toBeUndefined();
    expect(item.is_available).toBeUndefined();
  });

  it('create and list agree on shape', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|shape', roles: ['vendor'] });
    const token = await mintToken('bp4|shape');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const created = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Horchata', priceCents: 350 });
    const listed = (await request(app).get(`/api/v1/businesses/${businessId}/menu`)).body.data[0];

    expect(Object.keys(created.body.data).sort()).toEqual(Object.keys(listed).sort());
    expect(created.body.data.id).toBe(listed.id);
  });
});

describe('product photos: the full lifecycle', () => {
  /**
   * Regression: UpdateMenuItemBody is .strict() and had no photoUrl, so a vendor could attach a
   * photo at create and then never fix a bad one — the picture was write-once.
   */
  const PHOTO = 'https://pub-test.r2.dev/product_photo/abc-123';
  const PHOTO_2 = 'https://pub-test.r2.dev/product_photo/def-456';

  async function itemWithPhoto(prefix: string) {
    const ownerId = await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
    const token = await mintToken(`${prefix}|vendor`);
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });
    const created = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Al Pastor Taco', priceCents: 400, photoUrl: PHOTO });
    return { token, businessId, itemId: created.body.data.id as string, created };
  }

  it('attaches a photo at create and serves it publicly', async () => {
    const { businessId, created } = await itemWithPhoto('photo|create');
    expect(created.status).toBe(201);
    expect(created.body.data.photoUrl).toBe(PHOTO);

    // The customer's order screen reads the public list — the photo has to survive the round trip.
    const listed = (await request(app).get(`/api/v1/businesses/${businessId}/menu`)).body.data[0];
    expect(listed.photoUrl).toBe(PHOTO);
  });

  it('replaces a bad photo', async () => {
    const { token, businessId, itemId } = await itemWithPhoto('photo|replace');

    const res = await request(app)
      .patch(`/api/v1/businesses/${businessId}/menu/${itemId}`)
      .set(...bearer(token))
      .send({ photoUrl: PHOTO_2 });
    expect(res.status).toBe(200);
    expect(res.body.data.photoUrl).toBe(PHOTO_2);

    const listed = (await request(app).get(`/api/v1/businesses/${businessId}/menu`)).body.data[0];
    expect(listed.photoUrl).toBe(PHOTO_2);
  });

  it('removes a photo with an explicit null', async () => {
    const { token, businessId, itemId } = await itemWithPhoto('photo|remove');

    await request(app)
      .patch(`/api/v1/businesses/${businessId}/menu/${itemId}`)
      .set(...bearer(token))
      .send({ photoUrl: null })
      .expect(200);

    const listed = (await request(app).get(`/api/v1/businesses/${businessId}/menu`)).body.data[0];
    expect(listed.photoUrl).toBeNull();
  });

  it('leaves the photo alone when the patch omits it', async () => {
    const { token, businessId, itemId } = await itemWithPhoto('photo|omit');

    // Toggling sold-out must not wipe the picture — omitted and null are different intents.
    await request(app)
      .patch(`/api/v1/businesses/${businessId}/menu/${itemId}`)
      .set(...bearer(token))
      .send({ isAvailable: false })
      .expect(200);

    const listed = (await request(app).get(`/api/v1/businesses/${businessId}/menu`)).body.data[0];
    expect(listed.photoUrl).toBe(PHOTO);
    expect(listed.available).toBe(false);
  });

  /**
   * z.string().url() defers to the URL constructor, which accepts `javascript:`, `data:` and
   * `file:` — so a non-http scheme could be stored on the item and later rendered. Media URLs here
   * are always R2 http(s) objects; see shared/url.ts.
   */
  it.each([
    ['javascript:alert(1)', 'javascript'],
    ['data:text/html,<script>alert(1)</script>', 'data'],
    ['file:///etc/passwd', 'file'],
    ['not-a-url-at-all', 'garbage'],
  ])('rejects a %s photoUrl', async (bad) => {
    const { token, businessId, itemId } = await itemWithPhoto(`photo|bad-${bad.slice(0, 6)}`);

    const res = await request(app)
      .patch(`/api/v1/businesses/${businessId}/menu/${itemId}`)
      .set(...bearer(token))
      .send({ photoUrl: bad });
    expect(res.status).toBe(400);

    // The stored photo must be untouched by a rejected patch.
    const listed = (await request(app).get(`/api/v1/businesses/${businessId}/menu`)).body.data[0];
    expect(listed.photoUrl).toBe(PHOTO);
  });

  it('rejects a non-http scheme at create too, not only on update', async () => {
    const ownerId = await seedUser({ authProviderId: 'photo|create-bad', roles: ['vendor'] });
    const token = await mintToken('photo|create-bad');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', ownerId });

    const res = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Sneaky', priceCents: 100, photoUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });
});

describe('BP-4: a goods seller can list products', () => {
  /**
   * Regression: registration posts a goods_seller's first product to /menu (name + price is the
   * same shape), so `menu` must be part of that archetype's defaults or the module gate rejects
   * the very first thing a Handmade seller does.
   */
  it('goods_seller has the menu module enabled by default', async () => {
    const { businessId } = await makeBusiness({ archetype: 'goods_seller', tab: 'shopping' });
    const r = await resolveModules(businessId);
    expect(r.enabled).toContain('menu');
  });

  it('a goods seller can POST their first product to /menu', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp4|goods', roles: ['vendor'] });
    const token = await mintToken('bp4|goods');
    const { businessId } = await makeBusiness({
      archetype: 'goods_seller',
      tab: 'shopping',
      ownerId,
    });

    const res = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Hand-thrown mug', priceCents: 3200 });

    expect(res.status).toBe(201);
  });
});

describe('requireModule gate (BP-2)', () => {
  it('blocks a menu write for an appointment business with 422 MODULE_DISABLED', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp2|barber', roles: ['vendor'] });
    const token = await mintToken('bp2|barber');
    const { businessId } = await makeBusiness({ archetype: 'appointment_service', ownerId });

    const res = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Latte', priceCents: 400 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  it('allows the same write for a counter-serve business', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp2|truck', roles: ['vendor'] });
    const token = await mintToken('bp2|truck');
    const { businessId } = await makeBusiness({
      archetype: 'counter_serve',
      tab: 'food',
      ownerId,
    });

    const res = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Birria Taco', priceCents: 400 });

    expect(res.status).toBe(201);
  });

  it('leaves READS open — disabling a module must not 404 existing data', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp2|reader', roles: ['vendor'] });
    const { businessId } = await makeBusiness({ archetype: 'appointment_service', ownerId });

    // `menu` is not enabled for this archetype, yet the public read still answers.
    const res = await request(app).get(`/api/v1/businesses/${businessId}/menu`);
    expect(res.status).toBe(200);
  });

  it('a service write is blocked for a counter-serve business', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp2|truck2', roles: ['vendor'] });
    const token = await mintToken('bp2|truck2');
    const { businessId } = await makeBusiness({
      archetype: 'counter_serve',
      tab: 'food',
      ownerId,
    });

    const res = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Oil change', durationMin: 30, priceCents: 5000 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  /**
   * The gate must be exercised against a module that is genuinely OFF for this business, or the
   * test proves nothing. `on_demand_service` now defaults to `booking`, so the category override
   * switches it off — a dispatch-only trade whose category says "we don't take appointments" —
   * leaving it available for the owner to opt into. That is the real toggle path, and the only
   * shape in which a gated module (menu/services/booking) starts off but reachable.
   */
  it('enabling a module via PUT immediately unblocks its write', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp2|toggler', roles: ['vendor'] });
    const token = await mintToken('bp2|toggler');
    const { businessId } = await makeBusiness({
      archetype: 'on_demand_service',
      overrides: { booking: false },
      ownerId,
    });

    // Guard the premise: `booking` must be OFF but offerable, else the 422 below is vacuous.
    const resolved = await resolveModules(businessId);
    expect(resolved.enabled).not.toContain('booking');
    expect(resolved.available).toContain('booking');

    const windows = { windows: [{ dayOfWeek: 1, startMin: 540, endMin: 1020 }] };

    const before = await request(app)
      .put(`/api/v1/businesses/${businessId}/availability`)
      .set(...bearer(token))
      .send(windows);
    expect(before.status).toBe(422);
    expect(before.body.error.code).toBe('MODULE_DISABLED');

    await request(app)
      .put(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(token))
      .send({ enabled: [...CORE_MODULES, 'services', 'wave_down', 'booking'] })
      .expect(200);

    const after = await request(app)
      .put(`/api/v1/businesses/${businessId}/availability`)
      .set(...bearer(token))
      .send(windows);
    expect(after.status).toBe(200);
  });

  /**
   * The inverse, and the one that actually matters for authorization: turning a module OFF must
   * re-block its write. Without this, "the gate works" rests entirely on defaults — and a gate that
   * only ever sees modules that were never enabled is not being tested at all.
   */
  it('disabling a module via PUT immediately re-blocks its write', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp2|untoggler', roles: ['vendor'] });
    const token = await mintToken('bp2|untoggler');
    const { businessId } = await makeBusiness({ archetype: 'counter_serve', tab: 'food', ownerId });

    const item = { name: 'Horchata', priceCents: 350 };
    await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send(item)
      .expect(201);

    // The owner turns `menu` off; the write surface must close behind it.
    await request(app)
      .put(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(token))
      .send({ enabled: [...CORE_MODULES, 'queue', 'wave_down'] })
      .expect(200);

    const after = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send(item);
    expect(after.status).toBe(422);
    expect(after.body.error.code).toBe('MODULE_DISABLED');

    // …but the existing data stays readable. Disabling a module hides a capability; it must never
    // 404 a customer's view of what the business already published.
    const read = await request(app).get(`/api/v1/businesses/${businessId}/menu`);
    expect(read.status).toBe(200);
  });
});

describe('GET/PUT /businesses/:id/modules', () => {
  it('GET is public — the customer profile needs it to pick Book vs Order', async () => {
    const { businessId } = await makeBusiness({ archetype: 'appointment_service' });
    const res = await request(app).get(`/api/v1/businesses/${businessId}/modules`);

    expect(res.status).toBe(200);
    expect(res.body.data.archetype).toBe('appointment_service');
    expect(res.body.data.enabled).toContain('booking');
  });

  it('PUT requires ownership', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp1|owner', roles: ['vendor'] });
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service', ownerId });

    await seedUser({ authProviderId: 'bp1|stranger', roles: ['vendor'] });
    const strangerToken = await mintToken('bp1|stranger');

    const res = await request(app)
      .put(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(strangerToken))
      .send({ enabled: [...CORE_MODULES, 'services'] });

    expect(res.status).toBe(403);
  });

  it('the owner can enable an available module', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp1|owner2', roles: ['vendor'] });
    const token = await mintToken('bp1|owner2');
    const { businessId } = await makeBusiness({ archetype: 'on_demand_service', ownerId });

    const res = await request(app)
      .put(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(token))
      .send({ enabled: [...CORE_MODULES, 'services', 'wave_down', 'booking'] });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toContain('booking');
  });

  it('rejects an unavailable module with 422', async () => {
    const ownerId = await seedUser({ authProviderId: 'bp1|owner3', roles: ['vendor'] });
    const token = await mintToken('bp1|owner3');
    const { businessId } = await makeBusiness({ archetype: 'appointment_service', ownerId });

    const res = await request(app)
      .put(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(token))
      .send({ enabled: [...CORE_MODULES, 'menu'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODULE_NOT_AVAILABLE');
  });
});
