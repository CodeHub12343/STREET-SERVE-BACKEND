/* eslint-disable no-console */
/**
 * Dev-only test data so the real backend flows are exercisable from the frontend (with
 * NEXT_PUBLIC_MAP_DEMO=false). Idempotent: re-running replaces the seeded set.
 *
 * Creates, around a synthetic vendor user:
 *   • a LIVE (parked) business with menu items  → order-ahead / wave-down / map pin
 *   • services + wide availability              → bookings
 *   • a hub (QR secret 'SS-STATION-01') + a product → consignment checkout
 * and grants every real (non-seed) user the `seller` role + accepts the Seller Agreement, so
 * whoever you sign in as can drive the seller/consignment flow.
 *
 * NOTE: placing an ORDER also charges via Stripe — that step needs real STRIPE_SECRET_KEY test
 * keys + a Connect account. Waves, bookings, and consignment checkout/log-sale/return do NOT charge
 * and work with this seed alone.
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { logger } from '../src/config/logger';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { geohashEncode } from '../src/shared/geo';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { UserModel, UserRoleModel } from '../src/modules/identity/identity.model';
import { BusinessModel, MenuItemModel } from '../src/modules/vendors/vendors.model';
import { LiveSessionModel } from '../src/modules/livemap/livemap.model';
import { ServiceModel, AvailabilityWindowModel } from '../src/modules/scheduling/scheduling.model';
import {
  HubModel,
  ProductModel,
  SellerAgreementAcceptanceModel,
} from '../src/modules/consignment/consignment.model';

// Modesto, CA — the pilot city (DEFAULT_CITY=modesto-ca).
const LNG = -120.9969;
const LAT = 37.6391;
const VENDOR_AUTH_ID = 'seed-vendor-1';
const HUB_QR_SECRET = 'SS-STATION-01'; // enter this in the QR "manual code" field at checkout

async function ensureRole(userId: string, role: string): Promise<void> {
  const has = await UserRoleModel.exists({ user_id: userId, role, revoked_at: null });
  if (!has) await UserRoleModel.create({ user_id: userId, role, granted_by: 'seed' });
}

async function run(): Promise<void> {
  await connectMongo();

  const category = await CategoryModel.findOne().exec();
  if (!category) throw new Error('No categories found — run `npm run migrate:up` first.');
  const categoryId = category._id;

  // ── Synthetic vendor user (owns the seeded business + hub) ────────────────────────────────
  const vendor =
    (await UserModel.findOne({ authProviderId: VENDOR_AUTH_ID }).exec()) ??
    (await UserModel.create({ authProviderId: VENDOR_AUTH_ID, email: 'vendor@seed.local' }));
  const vendorId = String(vendor._id);
  for (const r of ['vendor', 'hub', 'seller']) await ensureRole(vendorId, r);

  // ── Clean any prior seed owned by this vendor (idempotent re-run) ─────────────────────────
  const oldBiz = await BusinessModel.find({ owner_user_id: vendorId }).select('_id').lean().exec();
  const oldIds = oldBiz.map((b) => String(b._id));
  if (oldIds.length) {
    await MenuItemModel.deleteMany({ business_id: { $in: oldIds } });
    await ServiceModel.deleteMany({ business_id: { $in: oldIds } });
    await AvailabilityWindowModel.deleteMany({ business_id: { $in: oldIds } });
    await LiveSessionModel.deleteMany({ actor_id: { $in: oldIds } });
    const oldHubs = await HubModel.find({ owner_user_id: vendorId }).select('_id').lean().exec();
    await ProductModel.deleteMany({ hub_id: { $in: oldHubs.map((h) => String(h._id)) } });
    await HubModel.deleteMany({ owner_user_id: vendorId });
    await BusinessModel.deleteMany({ _id: { $in: oldIds } });
  }

  // ── Live business: menu (orders) + services/availability (bookings) + parked pin (waves) ──
  const biz = await BusinessModel.create({
    owner_user_id: vendorId,
    name: 'Seed Taco Truck',
    category_id: categoryId,
    description: 'Seeded test vendor — tacos, burritos, horchata.',
    service_area: { type: 'Point', coordinates: [LNG, LAT] },
    service_radius_m: 3000,
    status: 'active',
  });
  const bizId = String(biz._id);

  await MenuItemModel.insertMany([
    { business_id: biz._id, name: 'Street Taco', price_cents: 600, is_available: true },
    { business_id: biz._id, name: 'Burrito', price_cents: 900, is_available: true },
    { business_id: biz._id, name: 'Horchata', price_cents: 300, is_available: true },
  ]);

  await LiveSessionModel.create({
    actor_type: 'business',
    actor_id: bizId,
    current_location: { type: 'Point', coordinates: [LNG, LAT] },
    status: 'parked',
    geohash: geohashEncode(LNG, LAT),
    wave_sla_sec: 300,
  });

  await ServiceModel.insertMany([
    { business_id: bizId, name: 'Quick consult', duration_min: 30, price_cents: 6000, active: true },
    { business_id: bizId, name: 'Full session', duration_min: 60, price_cents: 12000, active: true },
  ]);
  // Wide daily windows (08:00–21:00, all 7 days) so open slots exist today whatever the time.
  await AvailabilityWindowModel.insertMany(
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      business_id: bizId,
      day_of_week: day,
      start_min: 8 * 60,
      end_min: 21 * 60,
    })),
  );

  // ── Hub + product (consignment checkout) ─────────────────────────────────────────────────
  const hubBiz = await BusinessModel.create({
    owner_user_id: vendorId,
    name: 'Seed Community Hub',
    category_id: categoryId,
    is_hub: true,
    service_area: { type: 'Point', coordinates: [LNG, LAT] },
    status: 'active',
  });
  const hub = await HubModel.create({
    business_id: String(hubBiz._id),
    owner_user_id: vendorId,
    checkout_qr_secret: HUB_QR_SECRET,
    location: { type: 'Point', coordinates: [LNG, LAT] },
    address: '1 Seed St, Modesto, CA',
  });
  await ProductModel.create({
    hub_id: String(hub._id),
    name: 'Handmade Candle',
    category_id: categoryId,
    unit_value_cents: 1500,
    consignment_split_percent: 60,
    return_window_hours: 24 * 7,
    listing_type: 'consignment',
    quantity_available: 10,
  });

  // ── Grant every real (non-seed) user seller access + accept the agreement ─────────────────
  const humans = await UserModel.find({ authProviderId: { $not: /^seed-/ } }).exec();
  for (const u of humans) {
    await ensureRole(String(u._id), 'seller');
    await SellerAgreementAcceptanceModel.updateOne(
      { seller_id: String(u._id), version: SELLER_AGREEMENT_VERSION },
      { $setOnInsert: { accepted_at: new Date() } },
      { upsert: true },
    );
  }

  logger.info(
    {
      business: bizId,
      hub: String(hub._id),
      hubQrSecret: HUB_QR_SECRET,
      grantedSellerTo: humans.length,
    },
    'dev seed complete',
  );
  await disconnectMongo();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
