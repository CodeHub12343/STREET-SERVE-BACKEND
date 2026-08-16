import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  BusinessIdParam,
  ContributeBody,
  ContributionIdParam,
  FundSettingsBody,
} from './payforward.schema';
import { payforwardService } from './payforward.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const payforwardController = {
  /** Public: how much is in the pot, and the vendor's terms for using it. */
  getFund: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await payforwardService.getFund(businessId));
  },

  updateSettings: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const patch = body<z.infer<typeof FundSettingsBody>>(req);
    ok(res, await payforwardService.updateSettings(principal(req), businessId, patch));
  },

  contribute: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof ContributeBody>>(req);
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) throw ValidationError('Idempotency-Key header is required');
    created(
      res,
      await payforwardService.contribute(principal(req), businessId, input, idempotencyKey),
    );
  },

  /** The vendor's community-impact panel (PIF-11). Public: the numbers are the point. */
  impact: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await payforwardService.impact(businessId));
  },

  recent: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await payforwardService.recentContributions(businessId));
  },

  /** The caller's own gifts, including the ones that are still pending or that failed. */
  mine: async (req: Request, res: Response): Promise<void> => {
    ok(res, await payforwardService.myContributions(principal(req).userId));
  },

  /** ADR-005 §7 — take back the unspent part of a gift, within 24 hours. */
  refundContribution: async (req: Request, res: Response): Promise<void> => {
    const { contributionId } = params<z.infer<typeof ContributionIdParam>>(req);
    ok(res, await payforwardService.refundContribution(principal(req), contributionId));
  },
};
