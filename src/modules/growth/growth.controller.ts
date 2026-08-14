import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  BudgetStatusBody,
  BusinessIdParam,
  CreateGiftBody,
  CreateGiveawayBody,
  FundBudgetBody,
  GiftCodeParam,
  GiveawayIdParam,
  PingIdParam,
  QualifyBody,
  ShareBody,
  SpotMeDecideBody,
  SpotMeIdParam,
  SpotMeRequestBody,
} from './growth.schema';
import { pingService } from './ping.service';
import { giftsService } from './gifts.service';
import { giveawaysService } from './giveaways.service';
import { spotMeService } from './spotme.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}
function idempotencyKey(req: Request): string {
  const key = req.header('idempotency-key');
  if (!key) throw ValidationError('Idempotency-Key header is required');
  return key;
}

export const growthController = {
  // Ping budgets + pings
  getBudget: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await pingService.getBudget(principal(req), businessId));
  },
  fundBudget: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(
      res,
      await pingService.fundBudget(
        principal(req),
        businessId,
        body<z.infer<typeof FundBudgetBody>>(req),
      ),
    );
  },
  setBudgetStatus: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const { status } = body<z.infer<typeof BudgetStatusBody>>(req);
    ok(res, await pingService.setBudgetStatus(principal(req), businessId, status));
  },
  share: async (req: Request, res: Response): Promise<void> => {
    created(res, await pingService.share(principal(req), body<z.infer<typeof ShareBody>>(req)));
  },
  qualify: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof PingIdParam>>(req);
    ok(res, await pingService.qualify(principal(req), id, body<z.infer<typeof QualifyBody>>(req)));
  },
  listMyPings: async (req: Request, res: Response): Promise<void> => {
    const q = PaginationQuery.parse(req.query);
    ok(res, await pingService.listMine(principal(req).userId, q.limit));
  },

  // Gifts
  createGift: async (req: Request, res: Response): Promise<void> => {
    created(
      res,
      await giftsService.create(
        principal(req),
        body<z.infer<typeof CreateGiftBody>>(req),
        idempotencyKey(req),
      ),
    );
  },
  redeemGift: async (req: Request, res: Response): Promise<void> => {
    const { code } = params<z.infer<typeof GiftCodeParam>>(req);
    ok(res, await giftsService.redeem(principal(req), code));
  },

  // Giveaways
  createGiveaway: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CreateGiveawayBody>>(req);
    created(res, await giveawaysService.create(principal(req), input.businessId, input));
  },
  claimGiveaway: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof GiveawayIdParam>>(req);
    ok(res, await giveawaysService.claim(principal(req), id));
  },

  // Spot Me
  listMySpotMe: async (req: Request, res: Response): Promise<void> => {
    ok(res, await spotMeService.listMine(principal(req).userId));
  },
  requestSpotMe: async (req: Request, res: Response): Promise<void> => {
    created(
      res,
      await spotMeService.request(principal(req), body<z.infer<typeof SpotMeRequestBody>>(req)),
    );
  },
  decideSpotMe: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SpotMeIdParam>>(req);
    const { accept } = body<z.infer<typeof SpotMeDecideBody>>(req);
    ok(res, await spotMeService.decide(principal(req), id, accept));
  },
  repaySpotMe: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SpotMeIdParam>>(req);
    ok(res, await spotMeService.repay(principal(req), id));
  },
};
