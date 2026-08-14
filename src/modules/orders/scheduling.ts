import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError } from '../../shared/errors/AppError';

/**
 * 7.5 / P-14 — scheduled pickup for goods orders.
 *
 * ## The one design decision that matters
 *
 * A `pickup_now` order requires the business to be **Parked** — you cannot collect from a truck
 * that is driving. A `pickup_scheduled` order deliberately **does not**, because ordering ahead is
 * the entire point: the vendor is on the road at 10am precisely so they can be at the pitch at
 * noon. Requiring them to already be parked to accept a noon order would make the feature useless
 * to exactly the vendors it is for.
 *
 * What replaces the Parked check is the vendor's own configuration: they opt in, they set how much
 * notice they need, and they set how far ahead they will take orders. That is a promise the vendor
 * made rather than a state the platform inferred.
 *
 * ## Why slots rather than free times
 *
 * A one-person truck handed orders at 12:01, 12:03, and 12:04 has three separate handovers in a
 * queue that is also serving walk-ups. Rounding to a slot means the vendor sees "three at 12:15",
 * which is a thing a person can actually do. The granularity is theirs to set.
 */

export interface ScheduledPickupConfig {
  enabled?: boolean;
  min_lead_minutes?: number;
  max_days_ahead?: number;
  slot_minutes?: number;
}

export const DEFAULT_SCHEDULED_PICKUP = {
  enabled: false,
  minLeadMinutes: 30,
  maxDaysAhead: 7,
  slotMinutes: 15,
};

export function scheduledPickupView(config: ScheduledPickupConfig | null | undefined) {
  return {
    enabled: config?.enabled ?? DEFAULT_SCHEDULED_PICKUP.enabled,
    minLeadMinutes: config?.min_lead_minutes ?? DEFAULT_SCHEDULED_PICKUP.minLeadMinutes,
    maxDaysAhead: config?.max_days_ahead ?? DEFAULT_SCHEDULED_PICKUP.maxDaysAhead,
    slotMinutes: config?.slot_minutes ?? DEFAULT_SCHEDULED_PICKUP.slotMinutes,
  };
}

/** Round a time UP to the next slot boundary. Up, never down: down would move a pickup earlier
 *  than the customer asked for, which is the direction that makes someone miss their food. */
export function roundToSlot(at: Date, slotMinutes: number): Date {
  const ms = slotMinutes * 60_000;
  return new Date(Math.ceil(at.getTime() / ms) * ms);
}

/**
 * Validate a requested pickup time against the vendor's configuration and return the slot it lands
 * in. Throws with a message that says what IS possible — a rejection reading "invalid time" leaves
 * the customer guessing, and guessing means abandoning the order.
 */
export function resolvePickupSlot(
  requested: Date,
  config: ScheduledPickupConfig | null | undefined,
  now: Date = new Date(),
): Date {
  const settings = scheduledPickupView(config);

  if (!settings.enabled) {
    throw BusinessRuleError(
      ERROR_CODES.BUSINESS_RULE,
      'This business does not take orders ahead of time',
    );
  }

  const slot = roundToSlot(requested, settings.slotMinutes);
  const leadMinutes = (slot.getTime() - now.getTime()) / 60_000;

  if (leadMinutes < settings.minLeadMinutes) {
    throw BusinessRuleError(
      ERROR_CODES.BUSINESS_RULE,
      `This business needs at least ${settings.minLeadMinutes} minutes' notice. Choose a later time, or order now if they are open.`,
    );
  }
  if (leadMinutes > settings.maxDaysAhead * 24 * 60) {
    throw BusinessRuleError(
      ERROR_CODES.BUSINESS_RULE,
      `This business takes orders up to ${settings.maxDaysAhead} day(s) ahead`,
    );
  }

  return slot;
}

/**
 * The bookable slots for a business, for a picker UI.
 *
 * Generated rather than stored: a slot is a computed consequence of "now" plus the vendor's
 * settings, and storing them would mean a nightly job to create tomorrow's and a bug the day it
 * failed to run.
 */
export function availableSlots(
  config: ScheduledPickupConfig | null | undefined,
  opts: { now?: Date; horizonHours?: number; limit?: number } = {},
): Date[] {
  const settings = scheduledPickupView(config);
  if (!settings.enabled) return [];

  const now = opts.now ?? new Date();
  const horizonMs = Math.min(
    (opts.horizonHours ?? 24) * 3_600_000,
    settings.maxDaysAhead * 86_400_000,
  );
  const first = roundToSlot(
    new Date(now.getTime() + settings.minLeadMinutes * 60_000),
    settings.slotMinutes,
  );

  const slots: Date[] = [];
  const step = settings.slotMinutes * 60_000;
  const limit = opts.limit ?? 96;
  for (let t = first.getTime(); t <= now.getTime() + horizonMs && slots.length < limit; t += step) {
    slots.push(new Date(t));
  }
  return slots;
}
