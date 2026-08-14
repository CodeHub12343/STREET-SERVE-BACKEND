import { describe, expect, it } from 'vitest';

import { menuItemToSellable, productToSellable } from '../src/modules/catalog/sellable';

/**
 * A-8 / ADR-001 — the storefront read contract. What is pinned here is the part that would
 * otherwise be re-decided by each of the five features that depend on it.
 */
describe('SellableItem contract (A-8)', () => {
  const menuItem = {
    _id: 'm1',
    business_id: 'biz1',
    name: 'Birria taco',
    description: 'Slow-cooked beef',
    photo_url: 'https://example.test/taco.jpg',
    price_cents: 450,
    is_available: true,
  };

  const product = {
    _id: 'p1',
    hub_id: 'hub1',
    name: 'Folding table',
    condition_requirements: 'Return clean',
    photos: ['https://example.test/table.jpg'],
    unit_value_cents: 4500,
    quantity_available: 3,
    category: 'shopping',
    consignment_split_percent: 70,
    term_days: 30,
    return_window_hours: 48,
    min_seller_trust_score: 60,
    required_certification: null,
  };

  it('gives both models the same price field name', () => {
    // price_cents and unit_value_cents both surface as priceCents. A storefront that has to know
    // which source field to read is a storefront that will eventually read the wrong one.
    expect(menuItemToSellable(menuItem).priceCents).toBe(450);
    expect(productToSellable(product).priceCents).toBe(4500);
  });

  it('omits the consignment block on a menu item rather than zeroing it', () => {
    // A menu item with splitPercent: 0 would be indistinguishable from a misconfigured consignment
    // product. An absent block cannot be misread.
    expect(menuItemToSellable(menuItem).consignment).toBeUndefined();
    expect(productToSellable(product).consignment).toEqual({
      splitPercent: 70,
      termDays: 30,
      returnWindowHours: 48,
      minTrustScore: 60,
      requiredCertification: null,
    });
  });

  it('carries the owner explicitly, because settlement differs by owner and presentation does not', () => {
    expect(menuItemToSellable(menuItem).owner).toEqual({ type: 'business', id: 'biz1' });
    expect(productToSellable(product).owner).toEqual({ type: 'hub', id: 'hub1' });
  });

  it('treats a product with no stock as unavailable, whatever the hub configured', () => {
    expect(productToSellable({ ...product, quantity_available: 0 }).available).toBe(false);
  });

  it('defaults a menu item to available when the flag is absent', () => {
    const { is_available: _omitted, ...withoutFlag } = menuItem;
    expect(menuItemToSellable(withoutFlag).available).toBe(true);
  });
});
