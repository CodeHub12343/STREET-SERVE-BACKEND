import { createHash } from 'node:crypto';

/**
 * Legal agreement registry (R28 / DEBT7). Each transaction type has a versioned, hashed body; a
 * clickwrap acceptance captures the version + content hash so it is tamper-evident (S5). The bodies
 * below are PLACEHOLDERS pending attorney review (spec §60) — the reviewed final text drops in by
 * bumping `version` and replacing `body`, and every prior acceptance keeps the exact hash it agreed
 * to. Content is the single source of truth: the hash is derived, never stored by hand.
 */
export const AGREEMENT_TYPES = [
  'bailment',
  'regular_sale',
  'rto',
  'consignment_rto',
  // ── Community network (Phase 2.6). Two of the three govern money held for third parties, which
  // is a higher bar than the four above: those may ship on placeholder text while the flows that
  // bind are gated, but no real contribution may be taken against unreviewed custodial terms.
  'driver_engagement',
  'community_contribution',
  'campaign_contribution',
  // ── Postcard Marketing (ADR-007). The platform physically prints and mails whatever is uploaded,
  // so the buyer has to warrant what it is and who owns it BEFORE the file reaches a press.
  'postcard_artwork',
] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

interface AgreementDefinition {
  version: string;
  title: string;
  body: string;
  /**
   * §60 — has an attorney signed this text off?
   *
   * Declarative rather than inferred, and `false` for every agreement until counsel returns. Flows
   * that create binding obligations check this and refuse: shipping the code must not mean shipping
   * clickwrap on unreviewed terms, and acceptance records collected against a placeholder would all
   * have to be re-collected.
   *
   * When the reviewed text lands, it arrives WITH `reviewed: true` in the same edit — so the flag
   * cannot drift away from the thing it describes.
   */
  reviewed: boolean;
}

// bailment version intentionally matches the legacy SELLER_AGREEMENT_VERSION so migrated rows are
// already at the current version.
const DEFINITIONS: Record<AgreementType, AgreementDefinition> = {
  postcard_artwork: {
    reviewed: false, // §60 — pending attorney review
    version: 'v1-2026-08',
    title: 'Postcard Artwork & Acceptable Use',
    body: [
      'POSTCARD ARTWORK AND ACCEPTABLE USE (PLACEHOLDER — pending legal review, spec §60).',
      '',
      'You are asking StreetServe to have physical mail printed and delivered to households on',
      'your behalf. By submitting artwork you confirm all of the following.',
      '',
      '1. OWNERSHIP. You own the artwork, or have permission to use it. That includes photographs,',
      '   fonts, logos and any trademark appearing in it. You have not used another business’s name',
      '   or branding in a way that suggests they endorse you.',
      '',
      '2. TRUTHFULNESS. Every claim, price and offer in the artwork is accurate, and you will honour',
      '   it. Mailed advertising is subject to the same consumer-protection rules as any other',
      '   advertising.',
      '',
      '3. PROHIBITED CONTENT. The artwork does not contain adult or sexual content, hate speech,',
      '   harassment of or reference to a specific private individual, threats, unlawful goods or',
      '   services, or anything the USPS will not carry.',
      '',
      '4. ELECTIONS AND REGULATED CLAIMS. Political material and regulated categories (health,',
      '   finance, legal, cannabis) carry disclosure requirements. Meeting them is your',
      '   responsibility.',
      '',
      '5. REVIEW AND REFUSAL. StreetServe reviews artwork before printing and may refuse it. A',
      '   refusal happens BEFORE your order goes to press and is refunded in full. Review is a',
      '   safeguard for the platform — it is not approval of your claims, and it does not transfer',
      '   responsibility for them to us.',
      '',
      '6. AFTER IT IS PRINTED. Once an order goes to press it cannot be recalled, corrected or',
      '   refunded. Paper cannot be unprinted.',
      '',
      '7. INDEMNITY. You are responsible for claims arising from what your artwork says or shows.',
    ].join('\n'),
  },
  bailment: {
    reviewed: false, // §60 — pending attorney review
    version: 'v1-2026-07',
    title: 'Consignment Bailment Agreement',
    body: [
      'CONSIGNMENT BAILMENT AGREEMENT (PLACEHOLDER — pending legal review, spec §60).',
      'You (the Seller) place goods with a Hub as a bailment. Title remains with you until sale.',
      'The Hub holds the goods with reasonable care and remits your net proceeds per the agreed split.',
      'Unsold goods must be returned within the stated return window; overdue items follow the platform return policy.',
    ].join('\n'),
  },
  regular_sale: {
    reviewed: false, // §60 — pending attorney review
    version: 'v1-2026-07',
    title: 'Seller Terms of Sale',
    body: [
      'SELLER TERMS OF SALE (PLACEHOLDER — pending legal review, spec §60).',
      'You agree to sell only goods/services you are authorized to sell, at the prices you set.',
      'The platform retains its marketplace fee per the fee schedule; you are paid your net per your payout tier.',
      'You are responsible for fulfillment, applicable taxes, and compliance with local law and licensing.',
    ].join('\n'),
  },
  /**
   * The per-listing obligations §44 requires — maintenance, damage, return rights, cancellation
   * notice, delivery fee, tax — are NOT in this body. They vary between listings, so they are
   * structured fields snapshotted onto each agreement (`rto.terms.ts`), which is what makes them
   * validatable, comparable, and renderable. This body carries only what is true of EVERY RTO deal.
   */
  rto: {
    reviewed: false, // §60 — pending attorney review
    version: 'v1-2026-07',
    title: 'Rent-to-Own Agreement',
    body: [
      'RENT-TO-OWN AGREEMENT (PLACEHOLDER — pending legal review, spec §60).',
      'The customer pays in installments; ownership transfers only after the final scheduled payment.',
      'Missed installments follow the stated cure period and repossession terms; early payoff is permitted.',
      'Rent-to-own may cost more than buying the item outright; the total cost to own is disclosed before acceptance.',
      'Per-listing obligations (maintenance, damage, return rights, cancellation notice, delivery, tax)',
      'are recorded as the agreement’s own terms and shown to the customer before acceptance.',
    ].join('\n'),
  },
  /**
   * Likewise: §54's ten allocations are structured fields on the agreement, required at creation.
   * Three parties who have not written down who handles a missed payment have not made an agreement,
   * so those answers cannot live in boilerplate that says the same thing for every deal.
   */
  consignment_rto: {
    reviewed: false, // §60 — pending attorney review
    version: 'v1-2026-07',
    title: 'Consignment Rent-to-Own Agreement',
    body: [
      'CONSIGNMENT RENT-TO-OWN AGREEMENT (PLACEHOLDER — pending legal review, spec §60).',
      'Combines the bailment relationship with an installment purchase: the consigned good is sold RTO,',
      'with the seller net and hub share settled from installments per the agreed split and schedule.',
      'The allocation of ownership during the term, delivery, returns, support, damage, missed payments,',
      'early-payoff approval, and the ownership-transfer trigger are recorded as the agreement’s own',
      'terms and must be agreed by the product owner and the managing business before the listing is live.',
    ].join('\n'),
  },

  /**
   * ADR-004. Every clause here restates a decision from that ADR rather than inventing one, because
   * the classification is the product design: the prohibitions on assignment, acceptance-rate
   * pressure, and exclusivity are what make "engagement" true rather than merely asserted.
   *
   * The insurance clause is the one to get right. ADR-003 §2 declined to be an insurance
   * intermediary, and the copy rule (CR-3) forbids telling a driver they are covered. This text
   * therefore states the driver's own obligation and says nothing about what the platform's policy
   * does or does not do for them.
   */
  driver_engagement: {
    reviewed: false, // §60 — pending attorney review
    version: 'v1-2026-08',
    title: 'Delivery Partner Terms of Engagement',
    body: [
      'DELIVERY PARTNER TERMS OF ENGAGEMENT (PLACEHOLDER — pending legal review, spec §60).',
      'You are an independent party engaged for individual deliveries. This is not employment, and',
      'nothing here creates a schedule, a minimum, or an exclusive arrangement.',
      'Each delivery is an OFFER. You may accept or decline any offer for any reason. Declining is',
      'free: it is not recorded against you, does not affect the offers you receive, and is never a',
      'ground for removal.',
      'The price for a delivery is shown before you accept it, and does not change afterwards.',
      'You must hold a valid driving licence and valid insurance covering your use of the vehicle for',
      'delivery. You are responsible for confirming that your own cover permits this use. The platform',
      'does not provide, arrange, or advise on insurance for you, and does not assess your cover.',
      'You must keep your licence and insurance details current. If either lapses, you will not',
      'receive offers until it is renewed.',
      'You may not collect cash, and may not carry alcohol, tobacco, pharmacy goods, or any other',
      'age-restricted or licensed item.',
      'A customer’s exact address is shown to you only after you accept a delivery, and only until it',
      'is completed. You may not retain, record, or use it for any other purpose.',
    ].join('\n'),
  },

  /**
   * ADR-005. The two clauses that matter most to a contributor are the ones a generic donation
   * boilerplate would omit: that this is **not** a tax-deductible charitable gift, and what happens
   * to money nobody redeems.
   */
  community_contribution: {
    reviewed: false, // §60 — pending attorney review — REQUIRED before any real contribution
    version: 'v1-2026-08',
    title: 'Pay It Forward Contribution Terms',
    body: [
      'PAY IT FORWARD CONTRIBUTION TERMS (PLACEHOLDER — pending legal review, spec §60).',
      'Your contribution goes into a community fund held for a specific business and is used to pay',
      'for purchases made by other customers at that business.',
      'This is a gift, not a charitable donation. The business is not a charity, and your contribution',
      'is not tax-deductible.',
      'The platform holds the money; it is not the business’s money and cannot be withdrawn by them.',
      'It can only be used to pay for a purchase at that business, returned to you, or expired as',
      'described below.',
      'You may ask for your contribution back within 24 hours if it has not yet been used. After that,',
      'or once it has been used, it cannot be returned.',
      'Contributions that nobody uses within 12 months are redistributed to community funds at other',
      'businesses in the same city. They are never kept by the business or by the platform.',
      'You may give anonymously. If you choose to be named, only the name you provide is shown. The',
      'person who receives your contribution is never identified to you or to anyone else.',
      'No fee is charged on your contribution. The business pays the platform’s ordinary sale fee when',
      'the fund is used, exactly as it would on any other sale.',
    ].join('\n'),
  },

  /**
   * ADR-006. The unmet-goal outcome is stated first because it is the most likely outcome, and a
   * contributor who learns it only after the deadline has been misled by ordering.
   */
  campaign_contribution: {
    reviewed: false, // §60 — pending attorney review — REQUIRED before any real contribution
    version: 'v1-2026-08',
    title: 'Marketing Boost Contribution Terms',
    body: [
      'MARKETING BOOST CONTRIBUTION TERMS (PLACEHOLDER — pending legal review, spec §60).',
      'Your contribution helps fund a specific marketing campaign for a specific business, up to a',
      'stated goal and by a stated deadline.',
      'If the campaign does not reach its goal by its deadline, you are refunded in full and',
      'automatically. You do not need to ask. The refund is the full amount you gave.',
      'You may instead choose, at the time you contribute, to have your contribution carried over to',
      'that business’s next campaign. This is optional and off by default.',
      'The business may make up a shortfall itself before the deadline, in which case the campaign',
      'proceeds as described.',
      'Your money is held by the platform until the campaign funds. It is not the business’s money',
      'and cannot be withdrawn by them.',
      'No fee is charged on your contribution. If the campaign funds, a service fee stated on the',
      'campaign page is deducted from the total raised before the campaign is bought.',
      'This is a contribution toward advertising, not a charitable donation, not an investment, and',
      'not tax-deductible. It gives you no ownership, revenue share, or other interest in the business.',
    ].join('\n'),
  },
};

export interface ResolvedAgreement {
  type: AgreementType;
  version: string;
  title: string;
  body: string;
  contentHash: string;
  reviewed: boolean;
}

/** sha256 of the exact body text — the tamper-evidence anchor. */
export function hashAgreementBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function getAgreement(type: AgreementType): ResolvedAgreement {
  const def = DEFINITIONS[type];
  return {
    type,
    version: def.version,
    title: def.title,
    body: def.body,
    contentHash: hashAgreementBody(def.body),
    reviewed: def.reviewed,
  };
}

/** §60 launch gate: may a flow create binding obligations under this agreement yet? */
export function isAgreementReviewed(type: AgreementType): boolean {
  return DEFINITIONS[type].reviewed;
}

/**
 * TEST ONLY — pretend an agreement has cleared review, so the flows it gates can be exercised.
 *
 * Refuses outright in production. The alternative was sniffing NODE_ENV inside the gate itself,
 * which would have meant the gate was never the thing the tests ran against. Returns a restore
 * function so a test cannot leak the override into its neighbours.
 */
export function setAgreementReviewedForTest(type: AgreementType, reviewed: boolean): () => void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setAgreementReviewedForTest must never be called in production');
  }
  const previous = DEFINITIONS[type].reviewed;
  DEFINITIONS[type].reviewed = reviewed;
  return () => {
    DEFINITIONS[type].reviewed = previous;
  };
}
