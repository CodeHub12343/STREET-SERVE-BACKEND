import {
  DEMAND_MAX_TILES,
  DEMAND_MIN_TILE_WEIGHT,
  DEMAND_TILE_DEGREES,
  DEMAND_WEIGHT_QUEUE_JOIN,
  DEMAND_WEIGHT_WAVE_DOWN,
  DEMAND_WINDOW_HOURS,
  MAP_HUBS_MAX,
} from '../../config/constants';
import { HubModel, ProductModel } from '../consignment/consignment.model';
import { InventoryCheckoutModel } from '../consignment/consignment.model';
import { QueueEntryModel, QueueModel, WaveDownModel } from '../queue/queue.model';
import { BusinessModel } from '../vendors/vendors.model';
import { LiveSessionModel } from './livemap.model';

interface BBox {
  swLng: number;
  swLat: number;
  neLng: number;
  neLat: number;
}

function ring(swLng: number, swLat: number, neLng: number, neLat: number) {
  return [
    [
      [swLng, swLat],
      [neLng, swLat],
      [neLng, neLat],
      [swLng, neLat],
      [swLng, swLat],
    ],
  ];
}

/**
 * A `$geoWithin` filter for the viewport.
 *
 * A viewport that straddles the antimeridian has `neLng < swLng`, which would produce a polygon
 * wound the wrong way around the globe — Mongo would either error or match nearly everything. Split
 * it into the two real halves and OR them. Rare in the pilot market, silent and bizarre if wrong.
 */
function withinBox(b: BBox): Record<string, unknown> {
  const straddles = b.neLng < b.swLng;
  if (!straddles) {
    return {
      $geoWithin: { $geometry: { type: 'Polygon', coordinates: ring(b.swLng, b.swLat, b.neLng, b.neLat) } },
    };
  }
  return {
    $geoWithin: {
      $geometry: {
        type: 'MultiPolygon',
        coordinates: [
          ring(b.swLng, b.swLat, 180, b.neLat),
          ring(-180, b.swLat, b.neLng, b.neLat),
        ],
      },
    },
  };
}

/** Snap a coordinate to the south-west corner of its demand tile. */
function tileKey(lng: number, lat: number): string {
  const x = Math.floor(lng / DEMAND_TILE_DEGREES);
  const y = Math.floor(lat / DEMAND_TILE_DEGREES);
  return `${x}:${y}`;
}

function tileCenter(key: string): [number, number] {
  const [x, y] = key.split(':').map(Number);
  return [
    (x! + 0.5) * DEMAND_TILE_DEGREES,
    (y! + 0.5) * DEMAND_TILE_DEGREES,
  ];
}

/**
 * ═══ PHASE C — MAP LAYERS ═══
 *
 * The map was the product's core metaphor and showed one layer: live business sessions. Consignment
 * hubs — the supply side of the entire seller economy — were reachable only through a list, and the
 * demand signals the platform already collects were never drawn at all.
 *
 * These are read-only, viewport-scoped projections. Nothing here is authoritative; every number is
 * derived from the same collections the transactional paths write.
 */
export const mapLayersService = {
  /**
   * C-1/C-2 — hubs in the viewport, each with what's actually checkoutable there right now.
   *
   * The inventory count is the point. A hub pin that only says "hub" tells a seller nothing about
   * whether the trip is worth making; a pin that says "12 items, from $4" is a decision. So the
   * count is computed from live availability rather than from the hub's total catalogue.
   */
  async hubsInView(input: { bbox: BBox; category?: string; limit?: number }) {
    const limit = Math.min(input.limit ?? MAP_HUBS_MAX, MAP_HUBS_MAX);

    const hubs = await HubModel.find({
      location: withinBox(input.bbox),
    })
      .limit(limit)
      .lean()
      .exec();
    if (hubs.length === 0) return [];

    const hubIds = hubs.map((h) => String(h._id));

    /**
     * One grouped read for every hub's availability, rather than a query per pin. `quantity_available`
     * already excludes stock that is out with a seller (it's decremented at checkout and restored on
     * return), so this is genuinely "can I collect this now".
     */
    const availability = await ProductModel.aggregate<{
      _id: string;
      itemCount: number;
      unitCount: number;
      minUnitValueCents: number;
      categories: string[];
    }>([
      {
        $match: {
          hub_id: { $in: hubIds },
          quantity_available: { $gt: 0 },
          // Only listing types a seller can actually take (A-1) — advertising stock nobody may
          // check out would send someone on a wasted trip.
          $or: [{ listing_type: 'consignment' }, { listing_type: { $exists: false } }],
          ...(input.category ? { category: input.category } : {}),
        },
      },
      {
        $group: {
          _id: '$hub_id',
          itemCount: { $sum: 1 },
          unitCount: { $sum: '$quantity_available' },
          minUnitValueCents: { $min: '$unit_value_cents' },
          categories: { $addToSet: '$category' },
        },
      },
    ]).exec();
    const availByHub = new Map(availability.map((a) => [String(a._id), a]));

    // Hub display names live on the business, not the hub row.
    const businesses = await BusinessModel.find(
      { _id: { $in: hubs.map((h) => h.business_id) } },
      { name: 1, logo_url: 1, status: 1 },
    )
      .lean()
      .exec();
    const bizById = new Map(businesses.map((b) => [String(b._id), b]));

    return (
      hubs
        .map((h) => {
          const biz = bizById.get(String(h.business_id));
          const avail = availByHub.get(String(h._id));
          const coords = h.location?.coordinates as [number, number] | undefined;
          return {
            hubId: String(h._id),
            businessId: String(h.business_id),
            name: biz?.name ?? 'Consignment hub',
            logoUrl: biz?.logo_url ?? null,
            address: h.address ?? null,
            lngLat: coords && coords.length === 2 ? coords : null,
            itemCount: avail?.itemCount ?? 0,
            unitCount: avail?.unitCount ?? 0,
            fromUnitValueCents: avail?.minUnitValueCents ?? null,
            categories: (avail?.categories ?? []).filter(Boolean),
            /** Suspended-business hubs are filtered below, never shown as "empty". */
            hasInventory: (avail?.itemCount ?? 0) > 0,
          };
        })
        // A hub with no coordinates cannot be drawn, and one whose business is suspended must not
        // be — the same cascade gap `nearby()` closes for live pins.
        .filter((h) => h.lngLat !== null && bizById.get(h.businessId)?.status === 'active')
        /**
         * When a category filter is applied, hubs with nothing matching are dropped entirely rather
         * than drawn empty: the filter means "show me where I can get this", and a pin that can't
         * satisfy it is a wasted trip.
         */
        .filter((h) => (input.category ? h.hasInventory : true))
    );
  },

  /**
   * C-3 — demand tiles.
   *
   * Wave-downs and queue entries carry no coordinates; they reference an OWNER. So demand is
   * located at that owner's live position and bucketed into a fixed-degree grid.
   *
   * Two deliberate constraints:
   *  • A fixed grid (not viewport-relative) means the same event always lands in the same tile, so
   *    the layer doesn't shimmer as the user pans.
   *  • `DEMAND_MIN_TILE_WEIGHT` suppresses thin tiles. One person waving once is not a hot zone —
   *    and drawing it as one would both mislead and disclose roughly where that person is.
   */
  async demandTiles(input: { bbox: BBox; windowHours?: number }) {
    const since = new Date(
      Date.now() - (input.windowHours ?? DEMAND_WINDOW_HOURS) * 60 * 60 * 1000,
    );

    // Owners currently live inside the viewport — the only ones whose demand we can place.
    const sessions = await LiveSessionModel.find(
      {
        ended_at: null,
        current_location: withinBox(input.bbox),
      },
      { actor_id: 1, actor_type: 1, current_location: 1 },
    )
      .limit(DEMAND_MAX_TILES * 4)
      .lean()
      .exec();
    if (sessions.length === 0) return [];

    const locByOwner = new Map<string, [number, number]>();
    for (const s of sessions) {
      const c = s.current_location?.coordinates as [number, number] | undefined;
      if (c?.length === 2) locByOwner.set(s.actor_id, c);
    }
    const ownerIds = [...locByOwner.keys()];

    const [waves, queues] = await Promise.all([
      WaveDownModel.aggregate<{ _id: string; count: number }>([
        { $match: { target_id: { $in: ownerIds }, requested_at: { $gte: since } } },
        { $group: { _id: '$target_id', count: { $sum: 1 } } },
      ]).exec(),
      // Queue entries reference a queue, which references the owner — so resolve the owner's queues
      // first and count joins against them.
      (async () => {
        const qs = await QueueModel.find({ owner_id: { $in: ownerIds } }, { _id: 1, owner_id: 1 })
          .lean()
          .exec();
        if (qs.length === 0) return [] as Array<{ _id: string; count: number }>;
        const ownerByQueue = new Map(qs.map((q) => [String(q._id), q.owner_id]));
        const rows = await QueueEntryModel.aggregate<{ _id: string; count: number }>([
          { $match: { queue_id: { $in: qs.map((q) => q._id) }, joined_at: { $gte: since } } },
          { $group: { _id: '$queue_id', count: { $sum: 1 } } },
        ]).exec();
        // Re-key from queue id to owner id.
        const byOwner = new Map<string, number>();
        for (const r of rows) {
          const owner = ownerByQueue.get(String(r._id));
          if (owner) byOwner.set(owner, (byOwner.get(owner) ?? 0) + r.count);
        }
        return [...byOwner].map(([_id, count]) => ({ _id, count }));
      })(),
    ]);

    const tiles = new Map<string, { weight: number; waves: number; queueJoins: number }>();
    const add = (ownerId: string, count: number, kind: 'wave' | 'queue') => {
      const loc = locByOwner.get(ownerId);
      if (!loc) return;
      const key = tileKey(loc[0], loc[1]);
      const cur = tiles.get(key) ?? { weight: 0, waves: 0, queueJoins: 0 };
      cur.weight +=
        count * (kind === 'queue' ? DEMAND_WEIGHT_QUEUE_JOIN : DEMAND_WEIGHT_WAVE_DOWN);
      if (kind === 'queue') cur.queueJoins += count;
      else cur.waves += count;
      tiles.set(key, cur);
    };
    for (const w of waves) add(String(w._id), w.count, 'wave');
    for (const q of queues) add(String(q._id), q.count, 'queue');

    return [...tiles]
      .filter(([, v]) => v.weight >= DEMAND_MIN_TILE_WEIGHT)
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, DEMAND_MAX_TILES)
      .map(([key, v]) => ({
        tileId: key,
        lngLat: tileCenter(key),
        weight: v.weight,
        waveDowns: v.waves,
        queueJoins: v.queueJoins,
      }));
  },

  /**
   * C-5 — where a hub's inventory physically is right now.
   *
   * A hub owner hands stock to people who then walk away with it. "Where is my inventory" was
   * answerable only as a list of names; this places each holder on the map using their live session,
   * which is the same signal the customer-facing map already trusts.
   *
   * Sellers with no live session are returned WITHOUT coordinates rather than omitted — "we don't
   * know where this is" is the single most important thing a hub owner can be told, and dropping
   * those rows would hide exactly the stock worth chasing.
   */
  async hubInventoryMap(hubId: string) {
    const checkouts = await InventoryCheckoutModel.find({
      hub_id: hubId,
      status: { $in: ['active', 'overdue', 'return_pending'] },
    })
      .lean()
      .exec();
    if (checkouts.length === 0) return { hubId, holders: [], locatedCount: 0 };

    const sellerIds = [...new Set(checkouts.map((c) => c.seller_id))];
    const [sessions, products, users] = await Promise.all([
      LiveSessionModel.find(
        { actor_type: 'seller', actor_id: { $in: sellerIds }, ended_at: null },
        { actor_id: 1, current_location: 1, status: 1, last_ping_at: 1 },
      )
        .lean()
        .exec(),
      ProductModel.find(
        { _id: { $in: [...new Set(checkouts.map((c) => c.product_id))] } },
        { name: 1 },
      )
        .lean()
        .exec(),
      (async () => {
        const { UserModel } = await import('../identity/identity.model');
        return UserModel.find({ _id: { $in: sellerIds } }, { display_name: 1 }).lean().exec();
      })(),
    ]);

    const sessionBySeller = new Map(sessions.map((s) => [s.actor_id, s]));
    const productName = new Map(products.map((p) => [String(p._id), p.name]));
    const displayName = new Map(users.map((u) => [String(u._id), u.display_name]));

    const holders = checkouts.map((c) => {
      const session = sessionBySeller.get(c.seller_id);
      const coords = session?.current_location?.coordinates as [number, number] | undefined;
      const outstanding = c.quantity - (c.quantity_sold ?? 0);
      return {
        checkoutId: String(c._id),
        sellerId: c.seller_id,
        sellerName: displayName.get(c.seller_id) ?? 'Seller',
        productName: productName.get(String(c.product_id)) ?? 'Item',
        quantity: c.quantity,
        quantitySold: c.quantity_sold ?? 0,
        outstanding,
        valueCents: outstanding * (c.unit_value_cents ?? 0),
        status: c.status,
        expectedReturnAt: c.expected_return_at,
        /** Null when the seller has no live session — the rows worth chasing. */
        lngLat: coords && coords.length === 2 ? coords : null,
        lastSeenAt: session?.last_ping_at ?? null,
        liveStatus: session?.status ?? null,
      };
    });

    return {
      hubId,
      holders,
      locatedCount: holders.filter((h) => h.lngLat !== null).length,
    };
  },
};
