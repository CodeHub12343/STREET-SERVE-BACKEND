import { z } from 'zod';

import {
  BOOST_MAX_CONTRIBUTION_CENTS,
  BOOST_MAX_DEADLINE_DAYS,
  BOOST_MAX_GOAL_CENTS,
  BOOST_MIN_CONTRIBUTION_CENTS,
  BOOST_MIN_GOAL_CENTS,
} from '../../config/constants';

const objectId = z.string().length(24);

export const CampaignIdParam = z.object({ campaignId: objectId }).strict();
export const BusinessIdParam = z.object({ businessId: objectId }).strict();

export const CreateCampaignBody = z
  .object({
    title: z.string().min(3).max(120),
    goalCents: z.number().int().min(BOOST_MIN_GOAL_CENTS).max(BOOST_MAX_GOAL_CENTS),
    /** Bounded here as well as in the service. There is no "no deadline" option — ADR-006 §2. */
    deadlineDays: z.number().int().min(1).max(BOOST_MAX_DEADLINE_DAYS),
  })
  .strict();

export const ContributeBody = z
  .object({
    amountCents: z
      .number()
      .int()
      .min(BOOST_MIN_CONTRIBUTION_CENTS)
      .max(BOOST_MAX_CONTRIBUTION_CENTS),
    anonymous: z.boolean().optional(),
    displayName: z.string().min(1).max(60).optional(),
    /**
     * ADR-006 §5 — the contributor's choice for the likely outcome, made BEFORE they pay. Defaults
     * to a refund server-side when omitted: rolling money into a campaign somebody did not choose to
     * fund is deciding what to do with their money for them.
     */
    onUnmet: z.enum(['refund', 'roll_forward']).optional(),
  })
  .strict()
  .refine((v) => v.anonymous !== false || Boolean(v.displayName), {
    message: 'Give a name to be credited with, or contribute anonymously',
    path: ['displayName'],
  });

export const MailDateBody = z.object({ mailDate: z.string().datetime() }).strict();

export const CancelBody = z.object({ reason: z.string().max(280).optional() }).strict();

/** Ops-driven until a print vendor is contracted (MB-8). `delivered` is deliberately not a value. */
export const MailingStatusBody = z
  .object({ status: z.enum(['preparing', 'printing', 'mailed']) })
  .strict();

export const EstimateQuery = z.object({ amountCents: z.coerce.number().int().min(1) }).strict();
