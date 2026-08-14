import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  AssetIdParam,
  BusinessIdParam,
  CreateUploadBody,
  ModerateBody,
  PilotAddBody,
  PilotRemoveBody,
  QueueQuery,
  SkuParam,
  ValidateArtworkBody,
  CancelOrderBody,
  ConfigureOrderBody,
  CreateAudienceBody,
  CreateOrderBody,
  ListOrdersQuery,
  OrderIdParam,
  RefundOrderBody,
  SettlementIdParam,
  ConfirmSettlementBody,
  VoidSettlementBody,
  SettlementListQuery,
} from './postcards.schema';
import { postcardsService } from './postcards.service';
import { artworkService } from './artwork.service';
import { pilotService } from './pilot.service';
import { pilotReviewService } from './pilotReview.service';
import { settlementService } from './settlement.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const postcardsController = {
  /** Public: the catalogue is a price list, not a secret. Synchronous — it is a config read. */
  products: (_req: Request, res: Response): void => {
    ok(res, postcardsService.products());
  },

  /** Exact artwork requirements for a size — the "template pack" (4.4). Public, like the catalogue. */
  artworkSpec: (req: Request, res: Response): void => {
    const { sku } = params<z.infer<typeof SkuParam>>(req);
    ok(res, postcardsService.artworkSpec(sku));
  },

  // ─── Artwork ──────────────────────────────────────────────────────────────────────────────
  createUploadTarget: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateUploadBody>>(req);
    created(res, await artworkService.createUploadTarget(principal(req), businessId, input));
  },

  validateArtwork: async (req: Request, res: Response): Promise<void> => {
    const { assetId } = params<z.infer<typeof AssetIdParam>>(req);
    const { sku } = body<z.infer<typeof ValidateArtworkBody>>(req);
    ok(res, await artworkService.validate(principal(req), assetId, sku));
  },

  getArtwork: async (req: Request, res: Response): Promise<void> => {
    const { assetId } = params<z.infer<typeof AssetIdParam>>(req);
    ok(res, await artworkService.get(principal(req), assetId));
  },

  // ─── Moderation (staff) ───────────────────────────────────────────────────────────────────
  moderationQueue: async (req: Request, res: Response): Promise<void> => {
    const { limit } = query<z.infer<typeof QueueQuery>>(req);
    ok(res, await artworkService.queue(limit));
  },

  moderateArtwork: async (req: Request, res: Response): Promise<void> => {
    const { assetId } = params<z.infer<typeof AssetIdParam>>(req);
    const { decision, reason } = body<z.infer<typeof ModerateBody>>(req);
    ok(res, await artworkService.decide(principal(req), assetId, decision, reason));
  },

  // ─── Money (Phase 5) ──────────────────────────────────────────────────────────────────────
  pay: async (req: Request, res: Response): Promise<void> => {
    const { orderId } = params<z.infer<typeof OrderIdParam>>(req);
    // Recorded for the audit trail; the Stripe key is derived from the order, not from this header.
    const key = String(req.header('idempotency-key') ?? '');
    ok(res, await postcardsService.payOrder(principal(req), orderId, key));
  },

  refund: async (req: Request, res: Response): Promise<void> => {
    const { orderId } = params<z.infer<typeof OrderIdParam>>(req);
    const { reason } = body<z.infer<typeof RefundOrderBody>>(req);
    ok(res, await postcardsService.refundOrder(principal(req), orderId, reason));
  },

  // ─── Vendor settlement (finance) ──────────────────────────────────────────────────────────
  listSettlements: async (req: Request, res: Response): Promise<void> => {
    const { limit } = query<z.infer<typeof SettlementListQuery>>(req);
    ok(res, await settlementService.list(limit));
  },

  exposure: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await settlementService.exposure());
  },

  closeSettlement: async (_req: Request, res: Response): Promise<void> => {
    created(res, await settlementService.closePeriod());
  },

  confirmSettlement: async (req: Request, res: Response): Promise<void> => {
    const { settlementId } = params<z.infer<typeof SettlementIdParam>>(req);
    const { externalReference } = body<z.infer<typeof ConfirmSettlementBody>>(req);
    ok(res, await settlementService.confirmPaid(principal(req), settlementId, externalReference));
  },

  voidSettlement: async (req: Request, res: Response): Promise<void> => {
    const { settlementId } = params<z.infer<typeof SettlementIdParam>>(req);
    const { reason } = body<z.infer<typeof VoidSettlementBody>>(req);
    ok(res, await settlementService.voidSettlement(principal(req), settlementId, reason));
  },

  // ─── Pilot (Phase 8) — staff only ─────────────────────────────────────────────────────────
  pilotRoster: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await pilotService.list());
  },

  pilotAdd: async (req: Request, res: Response): Promise<void> => {
    const { businessId, note } = body<z.infer<typeof PilotAddBody>>(req);
    created(res, await pilotService.add(principal(req), businessId, note));
  },

  pilotRemove: async (req: Request, res: Response): Promise<void> => {
    const { businessId, reason } = body<z.infer<typeof PilotRemoveBody>>(req);
    ok(res, await pilotService.remove(principal(req), businessId, reason));
  },

  /** 8.2 — the numbers that decide whether this goes general. */
  pilotReview: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await pilotReviewService.build());
  },

  /** The vendor's list types, fetched live so their catalogue is not mirrored and left to rot. */
  listTypes: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await postcardsService.listTypes());
  },

  createAudience: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateAudienceBody>>(req);
    created(res, await postcardsService.createAudience(principal(req), businessId, input));
  },

  createOrder: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateOrderBody>>(req);
    created(res, await postcardsService.createOrder(principal(req), businessId, input));
  },

  listOrders: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = params<z.infer<typeof BusinessIdParam>>(req);
    const { page, perPage } = query<z.infer<typeof ListOrdersQuery>>(req);
    const { results, total } = await postcardsService.listOrders(
      principal(req),
      businessId,
      page,
      perPage,
    );
    ok(res, results, { pagination: { page, perPage, total } });
  },

  getOrder: async (req: Request, res: Response): Promise<void> => {
    const { orderId } = params<z.infer<typeof OrderIdParam>>(req);
    ok(res, await postcardsService.getOrder(principal(req), orderId));
  },

  configureOrder: async (req: Request, res: Response): Promise<void> => {
    const { orderId } = params<z.infer<typeof OrderIdParam>>(req);
    const input = body<z.infer<typeof ConfigureOrderBody>>(req);
    ok(res, await postcardsService.configureOrder(principal(req), orderId, input));
  },

  quoteOrder: async (req: Request, res: Response): Promise<void> => {
    const { orderId } = params<z.infer<typeof OrderIdParam>>(req);
    ok(res, await postcardsService.quoteOrder(principal(req), orderId));
  },

  cancelOrder: async (req: Request, res: Response): Promise<void> => {
    const { orderId } = params<z.infer<typeof OrderIdParam>>(req);
    const { reason } = body<z.infer<typeof CancelOrderBody>>(req);
    ok(res, await postcardsService.cancelOrder(principal(req), orderId, reason));
  },
};
