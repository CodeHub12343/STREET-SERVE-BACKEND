import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  AcceptAgreementBody,
  AddProductBody,
  ApprovalPolicyBody,
  CheckoutBody,
  CheckoutIdParam,
  DeclineCheckoutBody,
  AutoRenewBody,
  CommissionBody,
  ExtendTermBody,
  FeePreviewQuery,
  HubIdParam,
  LogSaleBody,
  NearbyProductsQuery,
  ProductIdParam,
  ReducePriceBody,
  RegisterHubBody,
  ReturnBody,
} from './consignment.schema';
import { consignmentService } from './consignment.service';
import { hubAnalyticsService } from './hubAnalytics.service';
import { sellerAnalyticsService } from './sellerAnalytics.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const consignmentController = {
  myHubs: async (req: Request, res: Response): Promise<void> => {
    ok(res, await consignmentService.listMyHubs(principal(req)));
  },
  nearbyProducts: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof NearbyProductsQuery>>(req);
    ok(res, await consignmentService.listNearbyProducts(q));
  },
  discoveryProduct: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof ProductIdParam>>(req);
    ok(res, await consignmentService.getDiscoveryProduct(id));
  },
  registerHub: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof RegisterHubBody>>(req);
    created(
      res,
      await consignmentService.registerHub(
        principal(req),
        input.businessId,
        input.address,
        input.citySlug,
      ),
    );
  },
  addProduct: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    const input = body<z.infer<typeof AddProductBody>>(req);
    created(res, await consignmentService.addProduct(principal(req), id, input));
  },
  listHubProducts: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.listHubProducts(id));
  },
  /** H-08 hub analytics — consignment performance for the owner's hub. */
  hubAnalytics: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    const days = Number((req.query as { days?: string }).days ?? 30);
    ok(
      res,
      await hubAnalyticsService.overview(
        principal(req),
        id,
        Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 7), 90) : 30,
      ),
    );
  },

  /** The rotating check-in token for the hub's station display (Phase 6). */
  stationToken: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.stationToken(principal(req), id));
  },

  // ── Hub approval gate (H-03) ──
  pendingApprovals: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.pendingApprovals(principal(req), id));
  },
  getApprovalPolicy: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.getApprovalPolicy(principal(req), id));
  },
  setApprovalPolicy: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    const patch = body<z.infer<typeof ApprovalPolicyBody>>(req);
    ok(res, await consignmentService.setApprovalPolicy(principal(req), id, patch));
  },
  approveCheckout: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    ok(res, await consignmentService.approveCheckout(principal(req), id));
  },
  declineCheckout: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const input = body<z.infer<typeof DeclineCheckoutBody>>(req);
    ok(res, await consignmentService.declineCheckout(principal(req), id, input.reason));
  },
  hubHolders: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.hubHolders(principal(req), id));
  },
  /** C-5 — holders with live coordinates, for the hub owner's inventory map. */
  hubInventoryMap: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.hubInventoryMap(principal(req), id));
  },
  hubSettlements: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await consignmentService.hubSettlements(principal(req), id));
  },
  acceptAgreement: async (req: Request, res: Response): Promise<void> => {
    const { version } = body<z.infer<typeof AcceptAgreementBody>>(req);
    ok(res, await consignmentService.acceptAgreement(principal(req), version));
  },
  checkout: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CheckoutBody>>(req);
    created(res, await consignmentService.checkout(principal(req), input));
  },
  listMine: async (req: Request, res: Response): Promise<void> => {
    const q = PaginationQuery.parse(req.query);
    ok(res, await consignmentService.listMyCheckouts(principal(req).userId, q.limit));
  },
  /** S-15 seller analytics — performance, not a second payout ledger. */
  sellerAnalytics: async (req: Request, res: Response): Promise<void> => {
    const days = Number((req.query as { days?: string }).days ?? 30);
    ok(
      res,
      await sellerAnalyticsService.overview(
        principal(req),
        Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 7), 90) : 30,
      ),
    );
  },
  earnings: async (req: Request, res: Response): Promise<void> => {
    ok(res, await consignmentService.sellerEarnings(principal(req).userId));
  },
  feePreview: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof FeePreviewQuery>>(req);
    ok(res, await consignmentService.feePreview(q));
  },
  logSale: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const input = body<z.infer<typeof LogSaleBody>>(req);
    created(res, await consignmentService.logSale(principal(req), id, input));
  },
  returnInventory: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const input = body<z.infer<typeof ReturnBody>>(req);
    ok(res, await consignmentService.returnAndSettle(principal(req), id, input));
  },
  getSettlement: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    ok(res, await consignmentService.getSettlement(principal(req), id));
  },

  // ─── Lifecycle actions (R15/R18) ──
  extendTerm: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const input = body<z.infer<typeof ExtendTermBody>>(req);
    ok(res, await consignmentService.extendTerm(principal(req), id, input));
  },
  reducePrice: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const { unitPriceCents } = body<z.infer<typeof ReducePriceBody>>(req);
    ok(res, await consignmentService.reducePrice(principal(req), id, unitPriceCents));
  },
  setAutoRenew: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const input = body<z.infer<typeof AutoRenewBody>>(req);
    ok(res, await consignmentService.setAutoRenew(principal(req), id, input));
  },
  changeCommission: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    const { splitPercent } = body<z.infer<typeof CommissionBody>>(req);
    ok(res, await consignmentService.changeCommission(principal(req), id, splitPercent));
  },
  endConsignment: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    ok(res, await consignmentService.endConsignment(principal(req), id));
  },
};
