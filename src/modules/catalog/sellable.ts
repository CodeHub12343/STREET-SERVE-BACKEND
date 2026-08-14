/**
 * A-8 / ADR-001 — the one shape a storefront renders.
 *
 * Products are bound to hubs (`products.hub_id`) and menu items to businesses, and the two models
 * differ in **ownership and settlement**, not in presentation. Five features (MS-1 storefronts, MS-5
 * used equipment, MS-6 wholesale, HR-9 vendor websites, M-40) sit on top of that distinction, and
 * built independently each would have resolved it differently — which is how a data model
 * fragments.
 *
 * The decision: **a storefront is a presentation layer, not a data model.** It renders a
 * `SellableItem`, which both existing models map onto. No third table.
 *
 * See `audit/2026-08-marketplace-spec/ADR-001-storefront-model.md` in the app repo for the reasoning
 * and for the migration path that MS-5/MS-6 will need (generalising `hub_id` to an owner).
 */

export type SellableKind = 'menu_item' | 'product';
export type SellableOwnerType = 'business' | 'hub' | 'seller';

/**
 * Terms that only a consigned item carries. **Optional, never zeroed** — a menu item rendered with
 * `splitPercent: 0` is indistinguishable from a misconfigured consignment product, whereas an absent
 * block cannot be misread.
 */
export interface ConsignmentTermsView {
  splitPercent: number;
  termDays: number | null;
  returnWindowHours: number;
  minTrustScore: number | null;
  requiredCertification: string | null;
}

export interface SellableItem {
  id: string;
  kind: SellableKind;
  name: string;
  description: string | null;
  photoUrl: string | null;
  /**
   * The customer-facing price. `price_cents` for a menu item, `unit_value_cents` for a product —
   * named identically here on purpose: a storefront that has to know which field to read is a
   * storefront that will eventually read the wrong one.
   */
  priceCents: number;
  available: boolean;
  owner: { type: SellableOwnerType; id: string };
  category: string | null;
  consignment?: ConsignmentTermsView;
}

interface MenuItemLike {
  _id: unknown;
  business_id: unknown;
  name: string;
  description?: string | null;
  photo_url?: string | null;
  price_cents: number;
  is_available?: boolean;
}

interface ProductLike {
  _id: unknown;
  hub_id: string;
  name: string;
  condition_requirements?: string | null;
  photos?: string[];
  unit_value_cents: number;
  quantity_available: number;
  category?: string | null;
  consignment_split_percent: number;
  term_days?: number | null;
  return_window_hours: number;
  min_seller_trust_score?: number | null;
  required_certification?: string | null;
}

export function menuItemToSellable(item: MenuItemLike): SellableItem {
  return {
    id: String(item._id),
    kind: 'menu_item',
    name: item.name,
    description: item.description ?? null,
    photoUrl: item.photo_url ?? null,
    priceCents: item.price_cents,
    available: item.is_available !== false,
    owner: { type: 'business', id: String(item.business_id) },
    category: null,
  };
}

export function productToSellable(product: ProductLike): SellableItem {
  return {
    id: String(product._id),
    kind: 'product',
    name: product.name,
    description: product.condition_requirements ?? null,
    photoUrl: product.photos?.[0] ?? null,
    priceCents: product.unit_value_cents,
    // Availability is stock, not a flag: a product with nothing left is not sellable, whatever the
    // hub's settings say.
    available: product.quantity_available > 0,
    owner: { type: 'hub', id: product.hub_id },
    category: product.category ?? null,
    consignment: {
      splitPercent: product.consignment_split_percent,
      termDays: product.term_days ?? null,
      returnWindowHours: product.return_window_hours,
      minTrustScore: product.min_seller_trust_score ?? null,
      requiredCertification: product.required_certification ?? null,
    },
  };
}
