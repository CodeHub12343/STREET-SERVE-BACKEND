import { z } from 'zod';

import { NonNegativeCents } from '../../shared/money';

const objectId = z.string().length(24);

/**
 * DAN-10 — where a delivery order is going.
 *
 * Coordinates are required rather than geocoded server-side: dispatch routes on the point, and a
 * broadcast that went out against a mis-geocoded address would send drivers to the wrong street with
 * no way for the customer to correct it. The client already has the map pin the customer confirmed.
 */
export const DeliveryDestination = z
  .object({
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).optional(),
    city: z.string().min(1).max(120),
    region: z.string().max(120).optional(),
    postalCode: z.string().max(20).optional(),
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    /** Access instructions. Shown to a driver only AFTER they accept (ADR-004 §6). */
    notes: z.string().max(280).optional(),
    contactPhone: z.string().max(32).optional(),
  })
  .strict();

export const PlaceOrderBody = z
  .object({
    businessId: objectId,
    items: z
      .array(z.object({ menuItemId: objectId, quantity: z.number().int().min(1).max(99) }).strict())
      .min(1)
      .max(50),
    tipCents: NonNegativeCents.optional(),
    roundUpCents: NonNegativeCents.optional(),
    /**
     * 7.5 / P-14 — request a future pickup slot. Omitted = order now, which requires the business
     * to be Parked; present = order ahead, which does not (see `orders/scheduling.ts`).
     */
    scheduledFor: z.string().datetime().optional(),
    /**
     * DAN-10 — deliver instead of collect. Presence of this field is what makes an order a delivery;
     * there is no separate mode flag to disagree with it.
     *
     * Gated per city by the `delivery` feature flag: the schema accepts it everywhere, the service
     * refuses it where the Delivery Assist Network has not launched. Accepting a delivery order in a
     * city with no drivers would produce an order nobody can fulfil.
     */
    destination: DeliveryDestination.optional(),
    /**
     * PIF-4 — opt IN to the community fund. Never automatic: accepting help is the customer's
     * decision to make, and quietly spending a stranger's gift on someone who did not ask for it
     * would be the wrong kind of surprise on both sides.
     */
    usePayItForward: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.scheduledFor && v.destination), {
    message: 'An order can be scheduled for pickup or delivered, not both',
    path: ['destination'],
  });

// Price preview (R9): same shape as placing, minus the idempotency requirement (no side effects).
export const QuoteOrderBody = PlaceOrderBody;

export const OrderIdParam = z.object({ id: objectId }).strict();
export const BusinessIdParam = z.object({ id: objectId }).strict();
export const CancelOrderBody = z.object({ reason: z.string().max(280).optional() }).strict();
export const RemoveItemBody = z.object({ menuItemId: objectId }).strict();
