/**
 * Wire mapping for PostcardMania DirectMail API **v3**.
 *
 * **Verified against their published OpenAPI spec** (`DirectMail-API-v3.json`, `x-stoplight.id`
 * `84aca6606cef4`), replacing the earlier guessed mapping. Paths, field names, enums, and the auth
 * flow below come from that document, not from inference.
 *
 * Still unverified: live response behaviour. The spec says what they intend to return; only a
 * sandbox run proves it. `npm run probe:print -- --real` is that check.
 *
 * ## What the spec corrected
 *
 * - Host is `v3.pcmintegrations.com`, **not** `api.pcmintegrations.com` — which is why every
 *   earlier probe 404'd. The api host is a redirect to their docs.
 * - Auth is a **login exchange**, not a static key header: `POST /auth/login` with an
 *   apiKey + apiSecret PAIR returns a short-lived bearer JWT.
 * - There is **no quote endpoint**; pricing comes from published per-design price breaks.
 * - There are **no outbound status webhooks**; status is polled.
 */

import type {
  AudienceBreakdownRow,
  AudienceCount,
  AudienceRequest,
  FulfilmentStatus,
  ListType,
  MailClass,
  PriceBreak,
  SubmitOrderRequest,
  VendorOrderRef,
} from './types';

/** Confirmed from the spec's `servers` block. */
export const PCM_BASE_URL = 'https://v3.pcmintegrations.com';

export const WIRE = {
  paths: {
    login: '/auth/login',
    listTypes: '/list/types',
    countZip: '/list/count/zipcode',
    countCarrierRoute: '/list/count/carrier-route',
    countRadius: '/list/count/radius',
    galleryDesigns: '/gallery/designs',
    submitPostcard: '/order/postcard/with-list-count',
    order: '/order/:id',
    balance: '/integration/balance',
  },
} as const;

// ─── Enums ──────────────────────────────────────────────────────────────────────────────────

/** Postcard size keys the vendor accepts. `46`/`46S` are First Class only, per their docs. */
export const POSTCARD_SIZE_KEYS = ['46S', '46', '58', '68', '69', '611'] as const;
export const FIRST_CLASS_ONLY_SIZES = new Set(['46S', '46']);

const MAIL_CLASS_TO_WIRE: Record<MailClass, string> = {
  first_class: 'FirstClass',
  standard: 'Standard',
};
const MAIL_CLASS_FROM_WIRE: Record<string, MailClass> = {
  FirstClass: 'first_class',
  Standard: 'standard',
};

export const toWireMailClass = (m: MailClass): string => MAIL_CLASS_TO_WIRE[m];
export const fromWireMailClass = (raw: unknown): MailClass | null =>
  MAIL_CLASS_FROM_WIRE[String(raw)] ?? null;

/**
 * Vendor status vocabulary → ours. Covers BOTH the Order and Batch enums, because an order's
 * observable state is split across the two: `Mailing` only ever appears on the batch.
 *
 * `Delivered` maps to `mailed` deliberately. The vendor defines it as *"scanned by the last postal
 * facility and will start hitting mailboxes"* — real signal, but not delivery to a mailbox, and
 * surfacing it as "delivered" would overclaim to the buyer. See types.ts.
 */
const STATUS_MAP: Record<string, FulfilmentStatus> = {
  // In flight
  Pending: 'preparing',
  Processing: 'printing',
  Processed: 'printing',
  Complete: 'mailed',
  Mailing: 'mailed',
  Delivered: 'mailed',
  // Terminal
  Canceled: 'canceled',
  Undeliverable: 'undeliverable',
  Failed: 'failed',
  'Pending Payment': 'payment_hold',
  'Failed Payment': 'payment_hold',
};

export function mapStatus(raw: unknown): FulfilmentStatus {
  const mapped = STATUS_MAP[String(raw ?? '').trim()];
  if (!mapped) {
    // Never advance an order on a value we do not understand.
    throw new Error(`unmapped vendor status: ${JSON.stringify(raw)}`);
  }
  return mapped;
}

// ─── Parsing helpers ────────────────────────────────────────────────────────────────────────

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Vendor prices are DOLLARS as floats; everything internal is integer cents. */
export const dollarsToCents = (d: number): number => Math.round(d * 100);

// ─── Auth ───────────────────────────────────────────────────────────────────────────────────

export function buildLoginBody(apiKey: string, apiSecret: string): unknown {
  return { apiKey, apiSecret };
}

export function parseLogin(body: unknown): { token: string; expiresAt: Date } {
  const r = rec(body);
  const token = str(r.token);
  if (!token) throw new Error('login response missing token');
  const rawExpiry = str(r.expires);
  const expiresAt = rawExpiry ? new Date(rawExpiry) : new Date(Date.now() + 30 * 60_000);
  return {
    token,
    expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(Date.now() + 30 * 60_000) : expiresAt,
  };
}

// ─── List types ─────────────────────────────────────────────────────────────────────────────

export function parseListTypes(body: unknown): ListType[] {
  const rows = Array.isArray(body) ? body : [];
  return rows.map((r) => {
    const row = rec(r);
    const key = str(row.key);
    if (!key) throw new Error('list type row missing key');
    return { key, label: str(row.label) ?? key };
  });
}

// ─── Audience / list count ──────────────────────────────────────────────────────────────────

export function audiencePath(type: AudienceRequest['type']): string {
  switch (type) {
    case 'zip':
      return WIRE.paths.countZip;
    case 'carrier_route':
      return WIRE.paths.countCarrierRoute;
    case 'radius':
      return WIRE.paths.countRadius;
  }
}

export function buildAudienceBody(input: AudienceRequest): unknown {
  // `demographics` is required by the spec even when empty — omitting it is a 400.
  const base = { listType: input.listType, breakdownType: 'ZipCode', demographics: [] as unknown[] };
  switch (input.type) {
    case 'zip':
      return { ...base, zipCodes: input.keys ?? [] };
    case 'carrier_route':
      return { ...base, breakdownType: 'ZipCRRT', carrierRoutes: input.keys ?? [] };
    case 'radius': {
      const r = input.radius;
      if (!r) throw new Error('radius audience requires radius details');
      return {
        ...base,
        radius: {
          radius: r.miles,
          address: r.address,
          city: r.city,
          state: r.state,
          zip: r.zip,
        },
      };
    }
  }
}

export function parseAudienceCount(body: unknown): AudienceCount {
  const r = rec(body);
  const listCountId = num(r.listCountID) ?? str(r.listCountID);
  const recordCount = num(r.recordCount);
  if (listCountId === null) throw new Error('list count response missing listCountID');
  if (recordCount === null) throw new Error('list count response missing recordCount');

  const breakdown: AudienceBreakdownRow[] = [];
  for (const group of Array.isArray(r.breakdown) ? r.breakdown : []) {
    for (const d of Array.isArray(rec(group).data) ? (rec(group).data as unknown[]) : []) {
      const row = rec(d);
      breakdown.push({
        code: str(row.code) ?? '',
        label: str(row.text) ?? '',
        total: num(row.total) ?? 0,
      });
    }
  }
  return { listCountId: String(listCountId), recordCount, breakdown };
}

// ─── Pricing ────────────────────────────────────────────────────────────────────────────────

/**
 * Price breaks live on gallery designs, not on a pricing endpoint. We read them from any design of
 * the requested size — the breaks are a property of the product, not of the artwork.
 */
export function parsePriceBreaks(body: unknown, sizeKey: string): PriceBreak[] {
  const results = Array.isArray(rec(body).results) ? (rec(body).results as unknown[]) : [];
  const breaks: PriceBreak[] = [];
  const seen = new Set<string>();

  for (const d of results) {
    const design = rec(d);
    if (str(rec(design.size).key) !== sizeKey) continue;
    for (const p of Array.isArray(design.pricing) ? (design.pricing as unknown[]) : []) {
      const row = rec(p);
      const mailClass = fromWireMailClass(row.mailClass);
      const price = num(row.price);
      const minQuantity = num(row.breakQty);
      if (!mailClass || price === null || minQuantity === null) continue;
      const key = `${mailClass}:${minQuantity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      breaks.push({ mailClass, unitCostCents: dollarsToCents(price), minQuantity });
    }
  }
  return breaks.sort((a, b) => a.minQuantity - b.minQuantity);
}

// ─── Orders ─────────────────────────────────────────────────────────────────────────────────

export function buildSubmitBody(input: SubmitOrderRequest): unknown {
  return {
    mailClass: toWireMailClass(input.mailClass),
    size: input.sizeKey,
    /** Both sides required by the vendor even though the buyer designs only the front. */
    front: input.artwork.frontUrl,
    back: input.artwork.backUrl,
    listCountID: Number(input.listCountId),
    recordCount: input.recordCount,
    /** The idempotency key. A duplicate here is a 409, not a second print run. */
    extRefNbr: input.orderRef,
    mailDate: input.mailDate.toISOString().slice(0, 10),
    returnAddress: input.returnAddress,
  };
}

export function parseSubmit(body: unknown, orderRef: string): VendorOrderRef {
  const r = rec(body);
  const vendorOrderId = num(r.orderID) ?? str(r.orderID);
  const vendorBatchId = num(r.batchID) ?? str(r.batchID);
  if (vendorOrderId === null) throw new Error('order response missing orderID');
  return {
    vendorOrderId: String(vendorOrderId),
    vendorBatchId: vendorBatchId === null ? '' : String(vendorBatchId),
    orderRef: str(r.extRefNbr) ?? orderRef,
    deduplicated: false,
  };
}

export function parseOrderStatus(body: unknown): FulfilmentStatus {
  return mapStatus(rec(body).status);
}

export function parseBalance(body: unknown): { moneyOnAccountCents: number } {
  const dollars = num(rec(body).moneyOnAccount);
  if (dollars === null) throw new Error('balance response missing moneyOnAccount');
  return { moneyOnAccountCents: dollarsToCents(dollars) };
}
