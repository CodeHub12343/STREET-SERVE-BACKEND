import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  AcceptRtoBody,
  AcknowledgeConditionBody,
  ArrangementBody,
  ConditionReportSchema,
  DeferBody,
  PartialPaymentBody,
  PauseBody,
  AgreementIdParam,
  ApproveSellerBody,
  BrowseListingsQuery,
  CityRtoBody,
  CitySlugParam,
  CreateListingBody,
  DiscloseBody,
  ListingIdParam,
  ListingStatusBody,
  RtoEligibilityQuery,
} from './rto.schema';
import { rtoService } from './rto.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}
function idemKey(req: Request): string {
  const k = req.header('idempotency-key');
  if (!k) throw ValidationError('Idempotency-Key header is required');
  return k;
}

export const rtoController = {
  disclose: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof DiscloseBody>>(req);
    ok(res, await rtoService.disclose(input));
  },
  /** Answers "can I publish an RTO offer?" BEFORE the vendor fills the form in. */
  eligibility: async (req: Request, res: Response): Promise<void> => {
    const input = query<z.infer<typeof RtoEligibilityQuery>>(req);
    ok(res, await rtoService.getEligibility(principal(req), input));
  },

  approveSeller: async (req: Request, res: Response): Promise<void> => {
    const { sellerId, note } = body<z.infer<typeof ApproveSellerBody>>(req);
    created(res, await rtoService.approveSeller(principal(req), sellerId, note));
  },
  accept: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof AcceptRtoBody>>(req);
    created(res, await rtoService.accept(principal(req), input, idemKey(req)));
  },
  listMine: async (req: Request, res: Response): Promise<void> => {
    const q = PaginationQuery.parse(req.query);
    ok(res, await rtoService.listMine(principal(req), q.limit));
  },
  dashboard: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.getDashboard(principal(req), id));
  },
  /**
   * Pay an instalment with the customer present — one the sweep could not collect (SCA challenge,
   * no card on file), or simply the next one, paid ahead of its due date.
   */
  payInstallment: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.payInstallment(principal(req), id, idemKey(req)));
  },

  payoff: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.payoff(principal(req), id, idemKey(req)));
  },
  statements: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.getStatements(principal(req), id));
  },


  // ─── §50 seller remedies ─────────────────────────────────────────────────────────────────
  defer: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    const { days } = body<z.infer<typeof DeferBody>>(req);
    ok(res, await rtoService.deferPayment(principal(req), id, days));
  },
  partialPayment: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    const { amountCents } = body<z.infer<typeof PartialPaymentBody>>(req);
    ok(res, await rtoService.recordPartialPayment(principal(req), id, amountCents, idemKey(req)));
  },
  arrangement: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    const input = body<z.infer<typeof ArrangementBody>>(req);
    ok(res, await rtoService.agreeArrangement(principal(req), id, input));
  },
  pause: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    const { until } = body<z.infer<typeof PauseBody>>(req);
    ok(res, await rtoService.pauseAgreement(principal(req), id, until));
  },
  reinstate: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.reinstateAgreement(principal(req), id));
  },

  // ─── §51 voluntary return ────────────────────────────────────────────────────────────────
  returnPreview: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.previewReturn(principal(req), id));
  },
  requestReturn: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    ok(res, await rtoService.requestReturn(principal(req), id));
  },
  completeReturn: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    const condition = body<z.infer<typeof ConditionReportSchema>>(req);
    ok(res, await rtoService.completeReturn(principal(req), id, condition, idemKey(req)));
  },

  // ─── §52 condition reports ───────────────────────────────────────────────────────────────
  acknowledgeCondition: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof AgreementIdParam>>(req);
    const { report } = body<z.infer<typeof AcknowledgeConditionBody>>(req);
    ok(res, await rtoService.acknowledgeCondition(principal(req), id, report));
  },

  // ─── Admin ───────────────────────────────────────────────────────────────────────────────
  listApprovals: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await rtoService.listApprovedSellers());
  },
  revokeSeller: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof ListingIdParam>>(req);
    ok(res, await rtoService.revokeSeller(principal(req), id));
  },

  getMarkets: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await rtoService.getMarkets());
  },
  setCityRto: async (req: Request, res: Response): Promise<void> => {
    const { slug } = params<z.infer<typeof CitySlugParam>>(req);
    const { enabled } = body<z.infer<typeof CityRtoBody>>(req);
    ok(res, await rtoService.setCityRto(principal(req), slug, enabled));
  },

  // ─── Listings ────────────────────────────────────────────────────────────────────────────
  createListing: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CreateListingBody>>(req);
    created(res, await rtoService.createListing(principal(req), input));
  },
  myListings: async (req: Request, res: Response): Promise<void> => {
    const sellerId = (req.query as { sellerId?: string }).sellerId;
    if (!sellerId) throw ValidationError('sellerId is required');
    ok(res, await rtoService.listMyListings(principal(req), sellerId));
  },
  setListingStatus: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof ListingIdParam>>(req);
    const { status } = body<z.infer<typeof ListingStatusBody>>(req);
    ok(res, await rtoService.setListingStatus(principal(req), id, status));
  },
  browseListings: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof BrowseListingsQuery>>(req);
    ok(res, await rtoService.browseListings(q, q.limit ?? 50));
  },
  listingDisclosure: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof ListingIdParam>>(req);
    ok(res, await rtoService.getListingDisclosure(id));
  },
};
