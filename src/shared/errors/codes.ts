/**
 * Central error-code registry. Codes are a stable client contract — never repurpose a code's
 * meaning. Grouped by domain so they are discoverable and non-colliding.
 * See ERROR_HANDLING_STRATEGY.md §4.
 */
export const ERROR_CODES = {
  // Auth
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',

  // Authorization
  FORBIDDEN: 'FORBIDDEN',
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  NOT_OWNER: 'NOT_OWNER',
  TIER_TOO_LOW: 'TIER_TOO_LOW',
  CANNOT_SELF_GRANT_ROLE: 'CANNOT_SELF_GRANT_ROLE',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Generic
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE: 'DUPLICATE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  CONFLICT: 'CONFLICT',
  BUSINESS_RULE: 'BUSINESS_RULE',

  // Business modules (BUSINESS_MODULE_SYSTEM.md §6)
  MODULE_DISABLED: 'MODULE_DISABLED',
  MODULE_NOT_AVAILABLE: 'MODULE_NOT_AVAILABLE',
  MODULE_LOCKED: 'MODULE_LOCKED',
  MODULE_EXCLUSIVE: 'MODULE_EXCLUSIVE',

  // Live map / queue / reviews (Phase 2)
  LICENSE_REQUIRED: 'LICENSE_REQUIRED',
  NO_ACTIVE_SESSION: 'NO_ACTIVE_SESSION',
  WAVE_EXPIRED: 'WAVE_EXPIRED',
  QUEUE_CLOSED: 'QUEUE_CLOSED',
  ALREADY_IN_QUEUE: 'ALREADY_IN_QUEUE',
  NOT_IN_QUEUE: 'NOT_IN_QUEUE',
  INVALID_DISCOUNT_SCHEDULE: 'INVALID_DISCOUNT_SCHEDULE',
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',

  // Orders / scheduling / messaging (Phase 3)
  BUSINESS_AWAY: 'BUSINESS_AWAY',
  ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  NOT_PARTICIPANT: 'NOT_PARTICIPANT',

  // Consignment (Phase 4)
  OVERSELL: 'OVERSELL',
  AGREEMENT_REQUIRED: 'AGREEMENT_REQUIRED',
  LISTING_TYPE_UNSUPPORTED: 'LISTING_TYPE_UNSUPPORTED',
  TRUST_TOO_LOW: 'TRUST_TOO_LOW',
  CATEGORY_NOT_PERMITTED: 'CATEGORY_NOT_PERMITTED',

  // Launch hardening (Phase 8)
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // Jobs & Shelter (Phase 7)
  JOB_UNAVAILABLE: 'JOB_UNAVAILABLE',
  NOT_ON_SITE: 'NOT_ON_SITE',
  PARTNER_NOT_VERIFIED: 'PARTNER_NOT_VERIFIED',
  ALLOCATION_EXCEEDED: 'ALLOCATION_EXCEEDED',
  /** B-5: the resident starter course has to be passed before taking stock. */
  TRAINING_REQUIRED: 'TRAINING_REQUIRED',
  /** D-5: the product is gated on an Academy certification the seller doesn't hold. */
  CERTIFICATION_REQUIRED: 'CERTIFICATION_REQUIRED',
  /** F-5: a paid course's assessment was submitted without purchasing it. The material stays free. */
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',

  // Growth (Phase 5)
  SPOT_ME_INELIGIBLE: 'SPOT_ME_INELIGIBLE',
  PAID_SHARE_CAP_REACHED: 'PAID_SHARE_CAP_REACHED',
  GIFT_EXPIRED: 'GIFT_EXPIRED',
  GIFT_ALREADY_REDEEMED: 'GIFT_ALREADY_REDEEMED',
  GIVEAWAY_CAP_REACHED: 'GIVEAWAY_CAP_REACHED',
  BUDGET_DEPLETED: 'BUDGET_DEPLETED',

  // Pay It Forward (ADR-005)
  /** The pool has already helped this person at this business today (PIF-10a). */
  PAY_FORWARD_DAILY_LIMIT: 'PAY_FORWARD_DAILY_LIMIT',
  /** Nothing left in the pool, or nothing left within the vendor's caps. */
  PAY_FORWARD_UNAVAILABLE: 'PAY_FORWARD_UNAVAILABLE',

  /**
   * This month's free AI advice is used up and the caller has no AI Marketing Assistant plan.
   *
   * Its own code rather than FEATURE_DISABLED: the client has to tell "you cannot have this" apart
   * from "you have had your free ones", because only the second has an upgrade CTA attached.
   */
  AI_QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED',
  /** The business has switched off new contributions. */
  PAY_FORWARD_NOT_ACCEPTING: 'PAY_FORWARD_NOT_ACCEPTING',

  // Idempotency / rate limiting
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',

  // Upstream / system
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
