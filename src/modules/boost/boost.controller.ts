import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  BusinessIdParam,
  CampaignIdParam,
  CancelBody,
  ContributeBody,
  CreateCampaignBody,
  EstimateQuery,
  MailDateBody,
  MailingStatusBody,
} from './boost.schema';
import { boostService } from './boost.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const boostController = {
  create: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateCampaignBody>>(req);
    created(res, await boostService.create(principal(req), businessId, input));
  },

  /** Public: a campaign nobody can see raises nothing. */
  current: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await boostService.currentFor(businessId));
  },

  get: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    ok(res, await boostService.get(campaignId));
  },

  contributions: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    ok(res, await boostService.contributions(campaignId));
  },

  contribute: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    const input = body<z.infer<typeof ContributeBody>>(req);
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) throw ValidationError('Idempotency-Key header is required');
    created(res, await boostService.contribute(principal(req), campaignId, input, idempotencyKey));
  },

  topUp: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) throw ValidationError('Idempotency-Key header is required');
    created(res, await boostService.topUp(principal(req), campaignId, idempotencyKey));
  },

  confirmMailDate: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    const { mailDate } = body<z.infer<typeof MailDateBody>>(req);
    ok(res, await boostService.confirmMailDate(principal(req), campaignId, new Date(mailDate)));
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    const { reason } = body<z.infer<typeof CancelBody>>(req);
    ok(res, await boostService.cancel(principal(req), campaignId, reason));
  },

  /** Ops-only until a print vendor's webhook can call it (MB-8). */
  advanceMailing: async (req: Request, res: Response): Promise<void> => {
    const { campaignId } = params<z.infer<typeof CampaignIdParam>>(req);
    const { status } = body<z.infer<typeof MailingStatusBody>>(req);
    ok(res, await boostService.advanceMailing(campaignId, status));
  },

  /**
   * MB-4 — how many postcards a sum buys. Returns `postcards: null` when the mailing rate cannot be
   * established; the client renders nothing rather than a fabricated number.
   *
   * Async now that the rate is read from the print vendor (cached) rather than a constant. The
   * response also itemises the disclosed service fee, so the figure can be explained rather than
   * merely asserted.
   */
  estimate: async (req: Request, res: Response): Promise<void> => {
    const { amountCents } = query<z.infer<typeof EstimateQuery>>(req);
    const est = await boostService.postcardEstimate(amountCents);
    ok(res, { ...est, amountCents, isEstimate: true });
  },
};
