import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { notifyOps } from '../../integrations/messaging';
import { writeAudit } from '../../shared/audit';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { UserModel } from '../identity/identity.model';
import { BrandMembershipModel, BrandModel } from './brands.model';
import { BrandOperatorModel } from './brandOperator.model';
import { BrandInviteModel, type BrandInviteDoc } from './brandInvite.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 3 invite flow. ═══
 *
 * Who can invite: the brand owner, OR an existing manager of the brand. Enforced at the service
 * level, so adding a UI without the check is still safe.
 *
 * Lifecycle:
 *
 *   create → PENDING (invite row + email)
 *            ├── accept  → ACCEPTED (membership row + optional operator seat)
 *            ├── revoke  → REVOKED
 *            └── expiry  → EXPIRED (checked lazily on accept)
 *
 * A terminal row stays in the DB forever; it is the audit trail for who had access when. Only
 * `pending` is actionable.
 */

const INVITE_TTL_DAYS = 7;

function newInviteToken(): string {
  /** 32 bytes → 43-char base64url, unguessable by brute force. */
  return randomBytes(32).toString('base64url');
}

async function assertCanInvite(userId: string, brandId: string): Promise<void> {
  const brand = await BrandModel.findById(brandId).select('owner_user_id').lean().exec();
  if (!brand) throw NotFoundError('Brand not found');
  if (brand.owner_user_id === userId) return;
  const membership = await BrandMembershipModel.findOne({
    brand_id: brandId,
    user_id: userId,
    status: 'active',
    role: { $in: ['owner', 'manager'] },
  })
    .lean()
    .exec();
  if (!membership) {
    throw BusinessRuleError(
      ERROR_CODES.NOT_OWNER,
      'Only the brand owner or a manager can send invites.',
    );
  }
}

/**
 * The accept URL a human reads in email. Built from the frontend origin inferred from the
 * Stripe-Connect return URL — the one env var we're already confident points at the web app.
 * Falls back to a relative path so the email still works in local dev where the env is unset.
 */
function acceptUrlFor(token: string): string {
  let origin = '';
  try {
    origin = new URL(env.CONNECT_RETURN_URL).origin;
  } catch {
    origin = '';
  }
  return `${origin}/brand/accept/${encodeURIComponent(token)}`;
}

export const brandInviteService = {
  /**
   * Create a pending invite + fire the email. Idempotent on `(brand_id, invitee_email)`
   * for `pending` rows via a partial-unique index — a resend to the same address returns the
   * existing row (and resends the email) rather than creating a duplicate.
   */
  async create(
    principal: Principal,
    brandId: string,
    dto: {
      inviteeEmail: string;
      role: 'manager' | 'operator';
      scopedBusinessIds?: string[];
      seatOperator?: { businessId: string; displayName: string };
    },
  ) {
    await assertCanInvite(principal.userId, brandId);

    if (dto.role === 'operator' && !dto.seatOperator) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'An operator invite must name the truck the invitee will operate — set seatOperator.',
      );
    }

    const email = dto.inviteeEmail.trim().toLowerCase();
    const existing = await BrandInviteModel.findOne({
      brand_id: brandId,
      invitee_email: email,
      status: 'pending',
    }).exec();

    const scoped = (dto.scopedBusinessIds ?? []).map((id) => new Types.ObjectId(id));

    let invite: BrandInviteDoc & { _id: Types.ObjectId };
    let resent = false;
    if (existing) {
      /**
       * Treat the duplicate as a resend. The token stays stable so a previously-sent link still
       * works; expiry is extended so a resend after six days is useful. The role/scope are NOT
       * updated — if those need to change, revoke the invite and send a new one.
       */
      existing.expires_at = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
      await existing.save();
      invite = existing as unknown as BrandInviteDoc & { _id: Types.ObjectId };
      resent = true;
    } else {
      invite = (await BrandInviteModel.create({
        brand_id: new Types.ObjectId(brandId),
        invitee_email: email,
        role: dto.role,
        scoped_business_ids: scoped,
        seat_operator: dto.seatOperator
          ? {
              business_id: new Types.ObjectId(dto.seatOperator.businessId),
              display_name: dto.seatOperator.displayName,
            }
          : { business_id: null, display_name: null },
        token: newInviteToken(),
        status: 'pending',
        invited_by: principal.userId,
        expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      })) as unknown as BrandInviteDoc & { _id: Types.ObjectId };
    }

    /** Email + in-app notification. Best-effort — a mail failure must not fail the invite
     *  creation; the admin can re-send. */
    const brand = await BrandModel.findById(brandId).select('name').lean().exec();
    const brandName = brand?.name ?? 'StreetServe';
    const url = acceptUrlFor(invite.token);
    /**
     * If the invitee already has an account, drop an in-app notification too. The email is the
     * primary channel; the in-app message makes the invite discoverable the next time they sign
     * in without needing to find the email.
     */
    const user = await UserModel.findOne({ email: email }).select('_id').lean().exec();
    if (user?._id) {
      notificationsService.notify(String(user._id), {
        category: 'system',
        title: `${brandName} invited you`,
        body:
          dto.role === 'manager'
            ? `You've been invited to help manage ${brandName}. Accept the invite to get started.`
            : `You've been invited to run a truck for ${brandName}. Accept the invite to get started.`,
        data: { brandId, inviteToken: invite.token, url },
      });
    }
    void notifyOps(
      resent ? `Brand invite re-sent — ${brandName}` : `Brand invite sent — ${brandName}`,
      [
        `Brand: ${brandName}`,
        `Invitee: ${email}`,
        `Role: ${dto.role}`,
        dto.seatOperator
          ? `Seating as operator at business ${dto.seatOperator.businessId} ("${dto.seatOperator.displayName}")`
          : '',
        `Accept URL: ${url}`,
      ]
        .filter(Boolean)
        .join('\n'),
      `brand_invite_${String(invite._id)}`,
    );
    await writeAudit({
      actorId: principal.userId,
      action: resent ? 'brand.invite.resent' : 'brand.invite.created',
      entityType: 'brand_invite',
      entityId: String(invite._id),
      metadata: {
        brand_id: brandId,
        invitee_email: email,
        role: dto.role,
      },
    });
    return {
      id: String(invite._id),
      brandId,
      inviteeEmail: email,
      role: dto.role,
      token: invite.token,
      acceptUrl: url,
      expiresAt: invite.expires_at,
      status: invite.status,
      resent,
    };
  },

  async revoke(principal: Principal, inviteId: string, reason?: string) {
    const invite = await BrandInviteModel.findById(inviteId).exec();
    if (!invite) throw NotFoundError('Invite not found');
    await assertCanInvite(principal.userId, String(invite.brand_id));
    if (invite.status !== 'pending') {
      throw BusinessRuleError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `Invite is ${invite.status} — only pending invites can be revoked.`,
      );
    }
    invite.status = 'revoked';
    invite.revoked_at = new Date();
    invite.revoked_by = principal.userId;
    invite.revoked_reason = reason ?? null;
    await invite.save();
    await writeAudit({
      actorId: principal.userId,
      action: 'brand.invite.revoked',
      entityType: 'brand_invite',
      entityId: inviteId,
      metadata: { reason: reason ?? null },
    });
    return { id: inviteId, status: 'revoked' as const };
  },

  async listForBrand(principal: Principal, brandId: string) {
    await assertCanInvite(principal.userId, brandId);
    const rows = await BrandInviteModel.find({ brand_id: brandId })
      .sort({ created_at: -1 })
      .limit(200)
      .lean()
      .exec();
    return rows.map((r) => ({
      id: String(r._id),
      inviteeEmail: r.invitee_email,
      role: r.role,
      status: r.status,
      invitedBy: r.invited_by,
      expiresAt: r.expires_at,
      acceptedAt: r.accepted_at ?? null,
      createdAt: r.created_at ?? null,
    }));
  },

  /**
   * Public preview of an invite from its token — used by the accept page BEFORE the user
   * signs in, so they can see what they're being invited to without needing an account first.
   * Returns only the data a human would need to decide, never the inviter's user id.
   */
  async preview(token: string) {
    const invite = await BrandInviteModel.findOne({ token }).lean().exec();
    if (!invite) throw NotFoundError('Invite not found');
    const brand = await BrandModel.findById(invite.brand_id).select('name').lean().exec();
    return {
      brandName: brand?.name ?? 'StreetServe',
      inviteeEmail: invite.invitee_email,
      role: invite.role,
      status: invite.status,
      expired:
        invite.status === 'pending' && invite.expires_at
          ? invite.expires_at.getTime() < Date.now()
          : invite.status === 'expired',
      seatOperator: invite.seat_operator?.display_name
        ? { displayName: invite.seat_operator.display_name }
        : null,
    };
  },

  /**
   * Accept the invite — turns it into a `BrandMembership` + an optional `BrandOperator` seat.
   *
   * Guards:
   *   • Invite is `pending` AND not expired (an expired `pending` is moved to `expired` on
   *     attempt — lazy expiry so no background job is needed).
   *   • The authenticated user's email matches the invitee_email (case-insensitive). The
   *     token is unguessable, but even so we tie acceptance to the recipient of the invite,
   *     so a leaked link cannot be redeemed by someone else who happens to be signed in.
   *   • If a BrandMembership already exists for this user on this brand (owner or active
   *     member), the invite is marked accepted BUT no new membership is created — this is the
   *     "I was already in the brand" case, surfaced to the UI as a success with a diagnostic.
   *
   * Idempotency: the same user attempting to accept the same already-accepted invite returns
   * the existing membership rather than throwing.
   */
  async accept(principal: Principal, userEmail: string, token: string) {
    const invite = await BrandInviteModel.findOne({ token }).exec();
    if (!invite) throw NotFoundError('Invite not found');
    const now = new Date();

    if (invite.status === 'accepted' && invite.accepted_by_user_id === principal.userId) {
      /** Already accepted by this user — idempotent success. */
      const membership = await BrandMembershipModel.findOne({
        brand_id: invite.brand_id,
        user_id: principal.userId,
        status: 'active',
      })
        .lean()
        .exec();
      return {
        inviteId: String(invite._id),
        brandId: String(invite.brand_id),
        role: invite.role,
        membershipId: membership ? String(membership._id) : null,
        alreadyAccepted: true,
      };
    }
    if (invite.status !== 'pending') {
      throw BusinessRuleError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `This invite is ${invite.status}.`,
      );
    }
    if (invite.expires_at && invite.expires_at.getTime() < Date.now()) {
      invite.status = 'expired';
      await invite.save();
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This invite has expired.');
    }
    if (userEmail.trim().toLowerCase() !== invite.invitee_email) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'This invite was sent to a different email address. Sign in with that address and try again.',
      );
    }

    /**
     * If a membership already exists (owner, or a stale active row), skip the create but mark
     * the invite accepted so it doesn't sit pending for ever.
     */
    const existing = await BrandMembershipModel.findOne({
      brand_id: invite.brand_id,
      user_id: principal.userId,
      status: 'active',
    })
      .lean()
      .exec();
    let membershipId: string;
    if (existing) {
      membershipId = String(existing._id);
    } else {
      const created = await BrandMembershipModel.create({
        brand_id: invite.brand_id,
        user_id: principal.userId,
        role: invite.role,
        scoped_business_ids: invite.scoped_business_ids ?? [],
        invited_by: invite.invited_by,
        status: 'active',
        invited_at: invite.created_at ?? invite.expires_at,
        accepted_at: now,
      });
      membershipId = String(created._id);
    }

    /**
     * Operator seat: if the invite named a specific truck, create a BrandOperator row too so
     * the invitee has somewhere to go live from on day one. Idempotent via the partial unique
     * index — a repeat accept is a no-op on this side.
     */
    let operatorId: string | null = null;
    if (invite.seat_operator?.business_id && invite.seat_operator?.display_name) {
      const existingOp = await BrandOperatorModel.findOne({
        brand_id: invite.brand_id,
        business_id: invite.seat_operator.business_id,
        user_id: principal.userId,
        status: 'active',
      })
        .lean()
        .exec();
      if (existingOp) {
        operatorId = String(existingOp._id);
      } else {
        const op = await BrandOperatorModel.create({
          brand_id: invite.brand_id,
          business_id: invite.seat_operator.business_id,
          user_id: principal.userId,
          display_name: invite.seat_operator.display_name,
          status: 'active',
        });
        operatorId = String(op._id);
      }
    }

    invite.status = 'accepted';
    invite.accepted_at = now;
    invite.accepted_by_user_id = principal.userId;
    await invite.save();

    /** Inviter + the brand owner get told. Best-effort; a notification failure does not undo
     *  the acceptance (which already landed in the DB). */
    try {
      const brand = await BrandModel.findById(invite.brand_id).select('name owner_user_id').lean().exec();
      if (brand?.owner_user_id) {
        notificationsService.notify(brand.owner_user_id, {
          category: 'system',
          title: `${invite.invitee_email} joined ${brand.name ?? 'your brand'}`,
          body: `They are now a ${invite.role}.`,
          data: { brandId: String(invite.brand_id), membershipId },
        });
      }
      if (invite.invited_by && invite.invited_by !== brand?.owner_user_id) {
        notificationsService.notify(invite.invited_by, {
          category: 'system',
          title: `Invite accepted — ${invite.invitee_email}`,
          body: `Your invite to ${brand?.name ?? 'the brand'} has been accepted.`,
          data: { brandId: String(invite.brand_id), membershipId },
        });
      }
    } catch (err) {
      logger.error({ err }, 'invite acceptance notification failed');
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'brand.invite.accepted',
      entityType: 'brand_invite',
      entityId: String(invite._id),
      metadata: {
        brand_id: String(invite.brand_id),
        membership_id: membershipId,
        operator_id: operatorId,
      },
    });

    return {
      inviteId: String(invite._id),
      brandId: String(invite.brand_id),
      role: invite.role,
      membershipId,
      operatorId,
      alreadyAccepted: false,
    };
  },
};
