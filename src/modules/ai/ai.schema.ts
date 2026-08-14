import { z } from 'zod';

import { OBJECTION_CATEGORIES } from './coaching';

export const RecommendQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    hourUtc: z.coerce.number().int().min(0).max(23).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export const PricingQuery = z.object({ productId: z.string().length(24) }).strict();

export const CoachingBody = z
  .object({
    objection: z.enum(OBJECTION_CATEGORIES),
    /** Optional free text: what the customer actually said. Bounded — it reaches a model prompt. */
    context: z.string().trim().max(400).optional(),
  })
  .strict();

export const RecIdParam = z.object({ id: z.string().length(24) }).strict();
export const HubIdParam = z.object({ id: z.string().length(24) }).strict();

/** E-9: an income goal, with optional position so the plan can rank real nearby stock. */
export const CoachPlanBody = z
  .object({
    goalCents: z.number().int().min(100).max(1_000_000),
    lng: z.coerce.number().min(-180).max(180).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    hourUtc: z.coerce.number().int().min(0).max(23).optional(),
  })
  .strict();

/** E-4 admin event entry. */
export const CreateEventBody = z
  .object({
    name: z.string().min(2).max(200),
    venue: z.string().max(200).optional(),
    lng: z.coerce.number().min(-180).max(180),
    lat: z.coerce.number().min(-90).max(90),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    expectedAttendance: z.number().int().min(0).max(1_000_000).optional(),
    category: z.string().max(60).optional(),
    url: z.string().url().max(2048).optional(),
  })
  .strict();

export const NearbyEventsQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusM: z.coerce.number().int().min(100).max(50_000).optional(),
    withinHours: z.coerce.number().int().min(1).max(336).optional(),
  })
  .strict();

/**
 * 7.9 / P-21 — the festivals directory reaches further than the nearby feed in both dimensions,
 * because working a festival in three weeks is a planning decision rather than a "where do I go
 * now" one.
 */
export const FestivalsQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusM: z.coerce.number().int().min(1_000).max(200_000).optional(),
    withinDays: z.coerce.number().int().min(1).max(180).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
