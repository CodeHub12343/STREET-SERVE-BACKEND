/**
 * Domain event catalog. Modules communicate via published events for anything asynchronous or
 * fan-out shaped, keeping the request path fast and modules decoupled (BACKEND_ARCHITECTURE.md §5).
 * Phase 0 wires the bus + a handful of foundational events; later phases extend this map.
 */
export interface DomainEvents {
  'user.provisioned': { userId: string };
  'role.granted': { userId: string; role: string };
  'user.suspended': { userId: string; reason: string };
  'verification.tier_changed': { userId: string; tier: string };
  'connected_account.updated': { ownerType: string; ownerId: string; payoutsEnabled: boolean };
  'transaction.completed': { transactionId: string; counterpartyId: string; amountCents: number };
  'transaction.refunded': { transactionId: string };
  'business.created': { businessId: string; ownerId: string };
  'license.approved': { businessId: string; categoryId: string };
  'live_session.started': { sessionId: string; actorType: string; actorId: string };
  'live_session.status_changed': { sessionId: string; status: string };
  'live_session.stopped': { sessionId: string };
  'wave_down.created': { waveDownId: string; targetId: string; customerId: string };
  'wave_down.accepted': { waveDownId: string; customerId: string };
  'wave_down.cancelled': { waveDownId: string; customerId: string };
  'review.created': { reviewId: string; subjectId: string; rating: number };
  'booking.created': { bookingId: string; businessId: string };
  'booking.cancelled': { bookingId: string; businessId: string };
  'booking.no_show': { bookingId: string; businessId: string; customerId: string };
  'order.placed': { orderId: string; businessId: string; customerId: string };
  'order.status_changed': { orderId: string; status: string };
  'message.sent': { threadId: string; senderId: string };
  /** A seller reserved stock that needs the hub owner's decision before it can leave (H-03). */
  'inventory.approval_requested': { checkoutId: string; sellerId: string; hubId: string };
  'inventory.approval_declined': { checkoutId: string; sellerId: string; hubId: string };
  'inventory.checked_out': { checkoutId: string; sellerId: string; hubId: string };
  'inventory.sold': { checkoutId: string; sellerId: string };
  /** A customer paid in-app and the money reached the platform balance (Phase 2 digital rail). */
  'sale.paid': { saleId: string; checkoutId: string; sellerId: string; amountCents: number };
  // ── Phase 3 cash rail ──
  'debt.created': { sellerId: string; debtId: string; amountCents: number; origin: string };
  'debt.repaid': { sellerId: string; debtId: string; amountCents: number };
  'debt.limit_reached': { sellerId: string; outstandingCents: number };
  // ── Phase 4 refunds + disputes ──
  'sale.refunded': { saleId: string; refundId: string; amountCents: number; sellerId: string };
  'payouts.frozen': { ownerType: string; ownerId: string; reason: string };
  'inventory.settled': { checkoutId: string; sellerId: string };
  'inventory.overdue': { checkoutId: string; sellerId: string };
  'dispute.opened': { disputeId: string; subjectType: string; subjectId: string };
  'dispute.resolved': { disputeId: string; subjectType: string; subjectId: string };
  'trust_score.recomputed': { subjectType: string; subjectId: string; score: number };
  'ping.logged': { pingId: string; businessId: string; isPaid: boolean };
  'ping.qualified': { pingId: string; businessId: string; tipCents: number };
  'gift.created': { giftId: string; businessId: string };
  'gift.redeemed': { giftId: string };
  'spot_me.requested': { spotMeId: string; requesterId: string };
  'spot_me.defaulted': { spotMeId: string; requesterId: string };
  'block_party.detected': { eventId: string; participantCount: number };
  'recommendation.shown': { sellerId: string; type: string; count: number };
  'job.posted': { jobId: string; posterBusinessId: string | null };
  'job.claimed': { jobId: string; applicantId: string };
  'job.completed': { jobId: string; applicantId: string; payoutCents: number };
  'job.cancelled': { jobId: string; applicantId: string | null };
  'shelter_partner.verified': { partnerId: string };
  // `residentUserId` is null for an invite that hasn't been claimed yet (B-1).
  'resident.enrolled': { partnerId: string; residentUserId: string | null };
  // Phase B: the shelter program's own lifecycle.
  'resident.starter_grant_used': { residentUserId: string; partnerId: string; valueCents: number };
  /** A starter-grant loss the cosigning shelter absorbed — no debt was written against the resident. */
  'resident.starter_grant_loss': {
    residentUserId: string;
    partnerId: string;
    checkoutId: string;
    valueCents: number;
  };
  'training.completed': { userId: string; courseSlug: string; scorePercent: number };
  // Phase D: the Academy and the seller profile.
  /** D-4: a course awarding a certification was passed — gates real access, so it's a first-class event. */
  'certification.issued': { userId: string; certification: string; courseSlug: string };
  'seller_profile.updated': { userId: string };
  // Phase E.
  'event.alerted': { eventId: string; notified: number };
  // Phase F — monetization.
  /** F-4: the platform declined to collect a debt it was owed. Its cost of goods, so it's tracked. */
  'waiver.applied': { userId: string; checkoutId: string; waivedCents: number };
  'campaign.exhausted': { placementId: string; spentCents: number };
  /** A placement's charge settled, so it may start delivering. Nothing serves before this. */
  'placement.activated': { placementId: string };
  // Phase 3: Rent-to-Own (R20–R27).
  'rto.agreement_accepted': { agreementId: string; customerId: string };
  'rto.completed': { agreementId: string; customerId: string };
  // Placeholders for later phases:
  // 'live_session.location_updated', 'inventory.settled',
  // 'dispute.resolved', 'ping.qualified', 'block_party.detected'
}

export type DomainEventName = keyof DomainEvents;
export type DomainEventPayload<K extends DomainEventName> = DomainEvents[K];
