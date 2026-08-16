import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requireFeature } from '../../middleware/requireFeature';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { rtoController } from './rto.controller';
import {
  AcceptRtoBody,
  AcknowledgeConditionBody,
  AgreementIdParam,
  ArrangementBody,
  ConditionReportSchema,
  DeferBody,
  PartialPaymentBody,
  PauseBody,
  ApproveSellerBody,
  BrowseListingsQuery,
  CreateListingBody,
  CityRtoBody,
  CitySlugParam,
  DiscloseBody,
  ListingIdParam,
  ListingStatusBody,
  RtoEligibilityQuery,
} from './rto.schema';

/**
 * Rent-to-Own (R20–R27). Every money route is gated by the city feature flag (`rto`) — RTO ships
 * only in compliance-cleared jurisdictions — plus role/approval checks in the service.
 */
export const rtoRouter = Router();

// Disclosure preview (U8) — read-only, still feature-gated so it isn't advertised where RTO is off.
rtoRouter.post(
  '/disclose',
  rateLimit('read'),
  requireFeature('rto'),
  authenticate,
  requirePermission('rto:accept'),
  validate({ body: DiscloseBody }),
  asyncHandler(rtoController.disclose),
);

/**
 * Pre-flight for the seller's offer form. Vendor-scoped (ownership enforced in the service), so a
 * business can ask about ITSELF without holding the admin approval permission.
 */
rtoRouter.get(
  '/eligibility',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ query: RtoEligibilityQuery }),
  asyncHandler(rtoController.eligibility),
);

// ─── Admin (R27/§60.3) — who may offer RTO at all ─────────────────────────────────────────
rtoRouter.post(
  '/approvals',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:admin_approve'),
  validate({ body: ApproveSellerBody }),
  asyncHandler(rtoController.approveSeller),
);
rtoRouter.get(
  '/approvals',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:admin_approve'),
  asyncHandler(rtoController.listApprovals),
);
rtoRouter.delete(
  '/approvals/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:admin_approve'),
  validate({ params: ListingIdParam }),
  asyncHandler(rtoController.revokeSeller),
);

// Markets: which cities and categories are open for RTO (§43/§60.3).
rtoRouter.get(
  '/markets',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:admin_markets'),
  asyncHandler(rtoController.getMarkets),
);
rtoRouter.patch(
  '/markets/cities/:slug',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:admin_markets'),
  validate({ params: CitySlugParam, body: CityRtoBody }),
  asyncHandler(rtoController.setCityRto),
);

// ─── Listings (§42/§44) — the seller's offer, and the source of every term ─────────────────
// Browse is PUBLIC: someone deciding whether RTO is for them should not have to sign up first.
rtoRouter.get(
  '/listings',
  rateLimit('read'),
  validate({ query: BrowseListingsQuery }),
  asyncHandler(rtoController.browseListings),
);
// Static path before `/listings/:id`, or "mine" would be read as an id.
rtoRouter.get(
  '/listings/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:sell'),
  asyncHandler(rtoController.myListings),
);
rtoRouter.post(
  '/listings',
  rateLimit('write'),
  requireFeature('rto'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ body: CreateListingBody }),
  asyncHandler(rtoController.createListing),
);
rtoRouter.patch(
  '/listings/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ params: ListingIdParam, body: ListingStatusBody }),
  asyncHandler(rtoController.setListingStatus),
);
/**
 * The §44 disclosure for one offer. Public for the same reason as browse — the whole point of §44
 * is that the full cost is visible BEFORE anyone commits to anything, including an account.
 */
rtoRouter.get(
  '/listings/:id',
  rateLimit('read'),
  validate({ params: ListingIdParam }),
  asyncHandler(rtoController.listingDisclosure),
);

// Customer accepts a disclosed agreement (money → idempotent).
rtoRouter.post(
  '/agreements',
  rateLimit('money'),
  requireFeature('rto'),
  authenticate,
  requirePermission('rto:accept'),
  idempotency,
  validate({ body: AcceptRtoBody }),
  asyncHandler(rtoController.accept),
);

rtoRouter.get(
  '/agreements/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:read_own'),
  asyncHandler(rtoController.listMine),
);
rtoRouter.get(
  '/agreements/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:read_own'),
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.dashboard),
);
// Per-party electronic statements (R19) — owner / managing business / platform.
rtoRouter.get(
  '/agreements/:id/statements',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:read_own'),
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.statements),
);
// Early payoff using the locked formula (R23) — money → idempotent.
rtoRouter.post(
  '/agreements/:id/payoff',
  rateLimit('money'),
  requireFeature('rto'),
  authenticate,
  requirePermission('rto:read_own'),
  idempotency,
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.payoff),
);

/**
 * Pay an instalment with the customer present: one the automatic charge could not take (an SCA
 * challenge, or no saved card), or simply the next one paid early. Money + idempotent, like every
 * other charge path — a double tap here would be a double instalment.
 */
rtoRouter.post(
  '/agreements/:id/pay-installment',
  rateLimit('money'),
  requireFeature('rto'),
  authenticate,
  requirePermission('rto:read_own'),
  idempotency,
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.payInstallment),
);

/**
 * §50 seller remedies. Every one is the SELLER's to grant — a customer who could pause their own
 * agreement or move their own due date would not be receiving forbearance, they would have an
 * option to stop paying. The service checks business ownership on each.
 */
rtoRouter.post(
  '/agreements/:id/defer',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ params: AgreementIdParam, body: DeferBody }),
  asyncHandler(rtoController.defer),
);
rtoRouter.post(
  '/agreements/:id/partial-payment',
  rateLimit('money'),
  authenticate,
  requirePermission('rto:sell'),
  idempotency,
  validate({ params: AgreementIdParam, body: PartialPaymentBody }),
  asyncHandler(rtoController.partialPayment),
);
rtoRouter.post(
  '/agreements/:id/arrangement',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ params: AgreementIdParam, body: ArrangementBody }),
  asyncHandler(rtoController.arrangement),
);
rtoRouter.post(
  '/agreements/:id/pause',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ params: AgreementIdParam, body: PauseBody }),
  asyncHandler(rtoController.pause),
);
rtoRouter.post(
  '/agreements/:id/reinstate',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:sell'),
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.reinstate),
);

// §51 — the customer sees what returning would mean BEFORE they ask for it.
rtoRouter.get(
  '/agreements/:id/return-preview',
  rateLimit('read'),
  authenticate,
  requirePermission('rto:read_own'),
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.returnPreview),
);
// Either party may start a return: the customer has a right to hand it back (§51), the seller a
// right to ask for it back (§50). The service decides which rule applies to the caller.
rtoRouter.post(
  '/agreements/:id/return',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:read_own'),
  validate({ params: AgreementIdParam }),
  asyncHandler(rtoController.requestReturn),
);
// The goods actually came back: records the §52 return report and settles the §51 outcome.
rtoRouter.post(
  '/agreements/:id/return/complete',
  rateLimit('money'),
  authenticate,
  requirePermission('rto:sell'),
  idempotency,
  validate({ params: AgreementIdParam, body: ConditionReportSchema }),
  asyncHandler(rtoController.completeReturn),
);
// §52 — the second signature, which is what makes a condition report an agreed fact.
rtoRouter.post(
  '/agreements/:id/condition/acknowledge',
  rateLimit('write'),
  authenticate,
  requirePermission('rto:read_own'),
  validate({ params: AgreementIdParam, body: AcknowledgeConditionBody }),
  asyncHandler(rtoController.acknowledgeCondition),
);
