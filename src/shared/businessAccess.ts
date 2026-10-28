import { Types } from 'mongoose';

import { BrandMembershipModel } from '../modules/brands/brands.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 0 access helper. ═══
 *
 * Single source of truth for "may this user act on this business, with what authority".
 * Every pre-existing `owner_user_id === principal.userId` check in the codebase is replaced
 * with a call to one of these four functions. The helper is the ONLY place that reads
 * `owner_user_id` and `brand_memberships` for authorization — later phases change what
 * authorization means (invites, operators, scoped roles) without re-visiting the ~15 call
 * sites that read it.
 *
 * **Phase 0 behaviour is identical to the pre-brand model.** For a single-owner business
 * (every existing row before migration), the only `BrandMembership` is `role: 'owner'` for
 * the business's `owner_user_id`, so each helper returns `true` for the owner and `false`
 * for everyone else — exactly as the `=== userId` comparison did.
 *
 * ## The four roles
 *
 * These are PRIVILEGE LEVELS, not labels. Each strictly includes the ones below it:
 *
 *  • `canOwn`     — may delete, change payout policy, invite/remove members (OWNER)
 *  • `canManage`  — may edit menu, hours, settings, promotions (OWNER | MANAGER)
 *  • `canOperate` — may go live, serve orders, claim wave-downs (OWNER | MANAGER | OPERATOR)
 *  • `canView`    — may read orders/earnings scoped to the user (OWNER | MANAGER | OPERATOR)
 *
 * The split matters because Phase 3 (invites) hands out `operator` memberships that are
 * allowed to go live and serve orders but must NOT be allowed to edit the brand's menu or
 * see other operators' payouts — those are the exact lines `canOperate` and `canManage` draw.
 *
 * ## What a `BusinessLike` is
 *
 * Each helper accepts either:
 *  • A full business doc / plain object with `owner_user_id` and optional `brand_id` and `_id`.
 *  • Or just a `{ owner_user_id, brand_id?, _id? }` subset — callers often have only this.
 *
 * The owner-user-id shortcut (`userId === business.owner_user_id`) is checked FIRST for every
 * level. That means a single-owner business with no brand_id still works end-to-end without
 * reading the memberships collection — the pre-brand hot path stays hot.
 */

export type BusinessRole = 'owner' | 'manager' | 'operator';

export interface BusinessLike {
  _id?: Types.ObjectId | string;
  owner_user_id: string;
  /** May be null during the Phase 0 backfill window; see `BusinessSchema.brand_id`. */
  brand_id?: Types.ObjectId | string | null;
}

interface AccessContext {
  userId: string;
  business: BusinessLike;
}

/**
 * Does a membership exist that grants at least `requiredRole` on this business? Resolves
 * `scoped_business_ids` — an empty list means "all businesses the brand has", a non-empty list
 * must contain this business's id. Returns false if the user is not a member of the brand at
 * all, or is only an `invited`/`revoked` row.
 */
async function hasMembershipAtLeast(
  { userId, business }: AccessContext,
  requiredRole: BusinessRole,
): Promise<boolean> {
  if (!business.brand_id) return false; // pre-migration row — fall back to the owner shortcut
  const row = await BrandMembershipModel.findOne({
    brand_id: business.brand_id,
    user_id: userId,
    status: 'active',
  })
    .lean()
    .exec();
  if (!row) return false;
  if (!roleAtLeast(row.role as BusinessRole, requiredRole)) return false;
  /**
   * Scoped operator: if `scoped_business_ids` is non-empty, this business id must be in it.
   * Empty array = all businesses. Owner/manager typically have empty; operator typically has
   * one entry (their truck).
   */
  const scope = row.scoped_business_ids ?? [];
  if (scope.length === 0 || !business._id) return true;
  const bizIdStr = String(business._id);
  return scope.some((s) => String(s) === bizIdStr);
}

/** Role ordering: owner > manager > operator. */
const ROLE_RANK: Record<BusinessRole, number> = { owner: 3, manager: 2, operator: 1 };
function roleAtLeast(held: BusinessRole, required: BusinessRole): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

/** May this user own this business — i.e. perform destructive / policy-change actions. */
export async function canOwn(userId: string, business: BusinessLike): Promise<boolean> {
  if (userId === business.owner_user_id) return true;
  return hasMembershipAtLeast({ userId, business }, 'owner');
}

/** May this user manage the business — menu/settings/promotions, but not delete it. */
export async function canManage(userId: string, business: BusinessLike): Promise<boolean> {
  if (userId === business.owner_user_id) return true;
  return hasMembershipAtLeast({ userId, business }, 'manager');
}

/** May this user operate the business — go live, serve orders, claim wave-downs. */
export async function canOperate(userId: string, business: BusinessLike): Promise<boolean> {
  if (userId === business.owner_user_id) return true;
  return hasMembershipAtLeast({ userId, business }, 'operator');
}

/**
 * May this user see the business's own data — orders scoped to them, earnings scoped to them.
 * Equal to `canOperate` for now. Kept as a separate function so later phases can split
 * read access from operate access (e.g. a finance role that can read but not act).
 */
export async function canView(userId: string, business: BusinessLike): Promise<boolean> {
  return canOperate(userId, business);
}

/**
 * ═══ Synchronous shortcuts — pre-brand fast path. ═══
 *
 * For call sites that already have the business in hand and only need the single-owner
 * answer (no DB round trip). Returns `true` iff the user is the business's `owner_user_id`.
 * These are the surgical drop-in replacements for `biz.owner_user_id === principal.userId`:
 * same answer, same cost, but every call site now routes through one place that later phases
 * can widen.
 *
 * Use these ONLY where a false negative is acceptable (an operator who IS a brand member
 * would be rejected). The async helpers above are the real gate. In practice most inline
 * `===` checks are already on records fetched for a specific principal, so the sync answer
 * is correct for the pre-brand world; code that needs the full picture should await the
 * async versions.
 */
export function isOwnerSync(userId: string, business: BusinessLike): boolean {
  return userId === business.owner_user_id;
}
