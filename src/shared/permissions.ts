import { ROLES, TIER_RANK, type Role, type Tier } from '../config/constants';
import type { Principal } from './types/principal';

/**
 * THE central permission matrix. Authorization is declarative here, not scattered through
 * controllers, so it is auditable in one place — the mitigation for the product's highest-risk
 * area, broken access control (SECURITY_GUIDELINES.md §5, AUTHENTICATION_AND_AUTHORIZATION.md §3).
 *
 * A rule declares the coarse gate (roles + minimum verification tier). Fine-grained
 * resource-ownership is enforced separately at the route via an ownership resolver, because it
 * needs the loaded resource — see requireOwnership in middleware/rbac.ts.
 */
export interface PermissionRule {
  roles: Role[];
  minTier?: Tier;
  /** Documentation flag: true means the route MUST also attach an ownership resolver. */
  requiresOwnership?: boolean;
}

/**
 * Every role — used for customer-side actions any authenticated user may take.
 *
 * Derived from `ROLES` rather than re-listed, so a new role cannot be added to the platform and
 * silently omitted here. That omission is not a small bug: it would leave the new role unable to
 * read its own profile or manage its own notifications, and the failure would surface as a
 * confusing 403 far from its cause. `authz.test.ts` pins the two lists together.
 */
const ALL_ROLES: Role[] = [...ROLES];

// Actions are `<resource>:<verb>`. Later phases extend this map; Phase 0 ships the foundational
// set plus a couple of representative money/tier-gated actions to exercise the full matrix.
export const PERMISSIONS = {
  'users:read_self': {
    roles: ALL_ROLES,
  },
  'users:update_self': {
    roles: ALL_ROLES,
  },
  'roles:add_self': {
    roles: ALL_ROLES,
  },

  // Notification inbox + push subscriptions — any authenticated user manages their own.
  'notifications:read_self': { roles: ALL_ROLES },
  'notifications:manage_self': { roles: ALL_ROLES },

  'catalog:read': {
    roles: ALL_ROLES,
  },

  // Trust & Safety admin surface. Overview is readable by finance too (shared ops snapshot).
  'admin:read_overview': { roles: ['admin', 'ops_finance'] },
  'admin:read_audit': { roles: ['admin'] },
  'admin:suspend_user': { roles: ['admin'] },
  'admin:manage_categories': { roles: ['admin'] },
  /**
   * E-4: curating the event calendar. Its own permission rather than folding into
   * `manage_categories`, because events drive seller ALERTS — a bad entry pushes a notification to
   * every seller near a venue, which is a different blast radius from a taxonomy edit.
   */
  'admin:manage_events': { roles: ['admin'] },

  // Finance surface (separation of duties — not a superset of admin).
  'finance:hold_payout': { roles: ['ops_finance'] },
  /**
   * Reading the books is an ops concern shared with admin. The separation of duties that matters is
   * about WRITES: the party that can alter balances must not be the only party who can investigate
   * them.
   *
   * These were one permission, which conflated the two — so the admin console's own reconciliation
   * page 403'd for every admin, and the only fix on offer was handing admins the power to rewrite
   * balances. Reading the report is now open to admin; repairing stays finance-only.
   */
  'finance:read_reconciliation': { roles: ['ops_finance', 'admin'] },
  'finance:repair_reconciliation': { roles: ['ops_finance'] },
  'finance:read_ledger': { roles: ['ops_finance', 'admin'] },

  // ─── Phase 1: verification, payments, vendors ─────────────────────────────────────────────
  'verification:manage_self': {
    roles: ALL_ROLES,
  },
  // Any authenticated user may link a payout account — gig workers and ping forwarders earn too.
  'payments:onboard_self': { roles: ALL_ROLES },
  'transaction:create': { roles: ['customer', 'seller', 'vendor', 'hub'] },
  'transaction:read_own': { roles: ['customer', 'seller', 'vendor', 'hub'] },
  'transaction:refund': { roles: ['admin', 'ops_finance'] },

  'business:create': { roles: ['vendor', 'hub'] },
  'business:manage_own': { roles: ['vendor', 'hub'], requiresOwnership: true },
  'menu:manage_own': { roles: ['vendor', 'hub'], requiresOwnership: true },
  'license:submit_own': { roles: ['vendor', 'hub'], requiresOwnership: true },
  'category_suggestion:create': { roles: ['vendor', 'hub'], requiresOwnership: true },
  'admin:review_category_suggestion': { roles: ['admin'] },
  'admin:review_license': { roles: ['admin'] },

  // ─── Phase 2: live map, wave-down, queue, reviews ─────────────────────────────────────────
  // Broadcasting is role-gated here; actor ownership (own business / own seller identity) is
  // enforced in the service layer where the session/actor is loaded.
  /**
   * `driver` broadcasts a position too — going on shift is a live session like any other, and the
   * service's `assertActorControl` still requires the session be their own. Without this a driver
   * could never go on shift, and dispatch would have nobody to offer work to.
   */
  'live:broadcast': { roles: ['vendor', 'seller', 'driver'] },
  'discount:manage': { roles: ['vendor', 'seller'] },
  'wave:respond': { roles: ['vendor', 'seller'] },
  // Customer-side actions — allowed for any authenticated role (everyone can act as a customer).
  'wave:create': {
    roles: ALL_ROLES,
  },
  'queue:join': {
    roles: ALL_ROLES,
  },
  'queue:checkout': {
    roles: ALL_ROLES,
  },
  'follow:manage': {
    roles: ALL_ROLES,
  },
  'review:create': {
    roles: ALL_ROLES,
  },

  // ─── Phase 3: scheduling, orders, messaging, dashboard ────────────────────────────────────
  'service:manage': { roles: ['vendor', 'hub'], requiresOwnership: true },
  'availability:manage': { roles: ['vendor', 'hub'], requiresOwnership: true },
  'booking:manage': { roles: ['vendor', 'hub'] }, // no-show / complete (service checks ownership)
  'order:manage_business': { roles: ['vendor', 'hub'] }, // accept/ready/complete/remove-item
  'dashboard:view': { roles: ['vendor', 'hub'], requiresOwnership: true },
  // Customer-side — any authenticated role can act as a customer (service checks participation).
  'booking:create': {
    roles: ALL_ROLES,
  },
  'order:create': {
    roles: ALL_ROLES,
  },
  'order:read_own': {
    roles: ALL_ROLES,
  },
  'order:cancel': {
    roles: ALL_ROLES,
  },
  'message:participate': {
    roles: ALL_ROLES,
  },

  // ─── Phase 4: consignment, trust, disputes, storage ──────────────────────────────────────
  'hub:register': { roles: ['hub'], requiresOwnership: true },
  'hub:manage': { roles: ['hub'] }, // service checks hub ownership
  'seller:agreement': { roles: ['seller'] },
  // Checkout is gated on the Bronze tier (Flow 1b); the seller is the actor (no resource ownership).
  'checkout:create': { roles: ['seller'], minTier: 'bronze' },
  'checkout:manage_own': { roles: ['seller'] }, // service checks checkout ownership
  /**
   * Ending a consignment is MUTUAL (spec §37): the seller may hand the goods back, and the hub —
   * whose property it is — must be able to recall them. `checkout:manage_own` is seller-only, so
   * reusing it left the owner with no way to end a no-limit term at all. The service resolves
   * which party the caller is and rejects anyone who is neither.
   */
  'checkout:end': { roles: ['seller', 'hub'] },
  // Phase 2 digital rail: collect a customer card payment for consignment stock the seller holds.
  'sale:collect_payment': { roles: ['seller'], minTier: 'bronze' },
  // Phase 3 cash rail: a seller sees and clears what they owe from cash sales.
  // Phase 4: either party to a sale may refund it; the service enforces participation.
  'sale:refund': { roles: ['seller', 'hub', 'admin'] },
  // Phase 5: a seller may retrieve their own tax statement.
  'tax:read_own': { roles: ['seller', 'vendor', 'hub'] },
  'debt:read_own': { roles: ['seller'] },
  'debt:repay_own': { roles: ['seller'] },
  'checkout:premium': { roles: ['seller'], minTier: 'gold' },
  'dispute:open': {
    roles: ALL_ROLES,
  },
  'dispute:participate': {
    roles: ALL_ROLES,
  },
  'dispute:resolve': { roles: ['admin'] },
  'storage:upload': { roles: ALL_ROLES },

  // ─── Phase 5: growth mechanics ────────────────────────────────────────────────────────────
  'ping:manage_budget': { roles: ['vendor', 'hub'] }, // service checks business ownership
  'giveaway:manage': { roles: ['vendor', 'hub'] }, // service checks business ownership
  'ping:share': { roles: ALL_ROLES },
  'ping:qualify': { roles: ALL_ROLES },
  'gift:create': { roles: ALL_ROLES },

  // ─── Pay It Forward (ADR-005) ─────────────────────────────────────────────────────────────
  /** Anyone may give. No tier gate: contributing is not a risk to anyone but the giver. */
  'payforward:contribute': { roles: ALL_ROLES },
  'payforward:manage': { roles: ['vendor', 'hub'] }, // service checks business ownership

  // ─── Boost My Marketing (ADR-006) ─────────────────────────────────────────────────────────
  /** Anyone may chip in — including other vendors, which is the brief's own best idea. */
  'boost:contribute': { roles: ALL_ROLES },
  'boost:manage': { roles: ['vendor', 'hub'] }, // service checks business ownership
  /** Moving the print pipeline by hand, until a vendor's webhook can do it (MB-8). */
  'boost:administer': { roles: ['admin', 'ops_finance'] },

  // ─── Postcard Marketing (ADR-007) ─────────────────────────────────────────────────────────
  /**
   * Ordering a mailing spends real money in one click, so it is NOT folded into `boost:manage`
   * (audit F-14): editing a campaign title and committing several hundred dollars to print and
   * postage are different risks and deserve different grants. The service additionally checks
   * business ownership on every route — the permission establishes the role, not the resource.
   */
  'postcards:order': { roles: ['vendor', 'hub'] },
  /**
   * Reviewing artwork the platform is about to print and mail into households (F-7). Staff only,
   * and separate from ordering: the whole value of the gate is that the person who made the
   * artwork is not the person who clears it.
   */
  'postcards:moderate': { roles: ['admin', 'ops_finance'] },
  /**
   * Running the pilot: who is allowed in, and reading the review that decides whether it ends.
   * Separate from `postcards:moderate` because approving one design and deciding which businesses
   * may spend money on printing are different powers.
   */
  'postcards:administer': { roles: ['admin'] },
  /**
   * Closing and confirming vendor settlements. Finance, not ops-general: confirming a settlement
   * asserts that money left the company, and it discharges a liability in the ledger.
   */
  'postcards:settle': { roles: ['admin', 'ops_finance'] },

  // ─── Delivery Assist Network (ADR-004) ────────────────────────────────────────────────────
  /** Asking for a driver is a vendor action on their own order. */
  'delivery:request': { roles: ['vendor', 'hub'] },
  /**
   * Taking a delivery. Role-gated to `driver` AND tier-gated — but the real gate is the eligibility
   * check in the service, which also needs an approved profile, a passed background check, and both
   * attestations in date.
   */
  'delivery:drive': { roles: ['driver'], minTier: 'silver' },
  'driver:administer': { roles: ['admin', 'ops_finance'] },
  'gift:redeem': { roles: ALL_ROLES },
  'giveaway:claim': { roles: ALL_ROLES },
  'spot_me:request': { roles: ALL_ROLES },
  'spot_me:decide': { roles: ALL_ROLES },
  'spot_me:repay': { roles: ALL_ROLES },

  // ─── Phase 6: AI layer v1 ─────────────────────────────────────────────────────────────────
  'ai:recommend': { roles: ['seller'] },
  'ai:coaching': { roles: ['seller'] },
  'ai:pricing': { roles: ['seller', 'hub'] },
  'ai:hub_dashboard': { roles: ['hub'] }, // service checks hub ownership

  // ─── Phase 7: Jobs & Shelter ──────────────────────────────────────────────────────────────
  'job:post': { roles: ['vendor', 'hub', 'admin'] }, // business owner or platform admin
  'job:read': { roles: ALL_ROLES },
  'job:apply': { roles: ALL_ROLES },
  'job:manage_application': { roles: ALL_ROLES }, // service checks it's the applicant's own
  'shelter:register_partner': { roles: ['admin'] },
  'shelter:enroll': { roles: ['shelter_admin'] }, // service checks partner ownership + verified
  'shelter:report': { roles: ['shelter_admin'] },

  // ─── Phase 8: launch hardening ────────────────────────────────────────────────────────────
  'admin:manage_sponsors': { roles: ['admin'] },

  // ─── Phase 3 (RTO): rent-to-own (R20–R27) — jurisdiction- + approval-gated ────────────────
  'rto:manage_seller': { roles: ['seller', 'vendor', 'hub'] }, // list + manage own RTO offers
  'rto:accept': { roles: ALL_ROLES }, // any authenticated user can enter an RTO as the customer
  'rto:read_own': { roles: ALL_ROLES }, // service checks participation (customer or seller)
  'rto:admin_approve': { roles: ['admin'] }, // approve a seller for RTO (compliance)
  /**
   * Publish and manage RTO offers. Separate from `rto:accept` because offering credit terms and
   * taking them are opposite sides of the deal — and this side is additionally approval-gated per
   * business in the service (§60.3).
   */
  'rto:sell': { roles: ['vendor', 'hub', 'admin'] },
  /** Open or close a city / category for RTO — a compliance decision, so admin only (§43/§60.3). */
  'rto:admin_markets': { roles: ['admin'] },

  // ─── Phase 3 (monetization): subscriptions (R29/R30) ──────────────────────────────────────
  'subscription:manage': { roles: ALL_ROLES }, // buy/cancel; business-plan ownership checked in service
  'subscription:read': { roles: ALL_ROLES },
} satisfies Record<string, PermissionRule>;

export type Action = keyof typeof PERMISSIONS;

export type AuthzDenial = { ok: false; reason: 'role' | 'tier' };
export type AuthzResult = { ok: true } | AuthzDenial;

/** Coarse check: does this principal's role + tier satisfy the action's rule? */
export function can(principal: Principal, action: Action): AuthzResult {
  const rule: PermissionRule = PERMISSIONS[action];
  const hasRole = principal.roles.some((r) => rule.roles.includes(r));
  if (!hasRole) return { ok: false, reason: 'role' };
  if (rule.minTier && TIER_RANK[principal.verificationTier] < TIER_RANK[rule.minTier]) {
    return { ok: false, reason: 'tier' };
  }
  return { ok: true };
}

export function ruleFor(action: Action): PermissionRule {
  return PERMISSIONS[action];
}
