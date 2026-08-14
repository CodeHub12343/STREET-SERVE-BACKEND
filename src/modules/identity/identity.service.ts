import { mongoose } from '../../config/db';
import {
  DEFAULT_ROLE,
  SELF_GRANTABLE_ROLES,
  TIER_RANK,
  type Role,
  type Tier,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal, TokenClaims } from '../../shared/types/principal';
import { identityRepository as repo, type UserProfilePatch } from './identity.repository';
import type { UserSyncEvent } from '../../integrations/auth/webhook';

function effectiveTier(approved: Array<{ tier: Tier }>): Tier {
  return approved.reduce<Tier>(
    (best, rec) => (TIER_RANK[rec.tier] > TIER_RANK[best] ? rec.tier : best),
    'tier0',
  );
}

async function buildPrincipal(
  user: NonNullable<Awaited<ReturnType<typeof repo.findUserByAuthId>>>,
): Promise<Principal> {
  const userId = String(user._id);
  const [roleDocs, approved] = await Promise.all([
    repo.activeRolesForUser(userId),
    repo.approvedVerifications(userId),
  ]);
  return {
    userId,
    authProviderId: user.authProviderId,
    roles: roleDocs.map((r) => r.role),
    verificationTier: effectiveTier(approved.map((v) => ({ tier: v.tier }))),
    status: user.status,
    email: user.email ?? undefined,
    phone: user.phone ?? undefined,
  };
}

export const identityService = {
  /**
   * Resolve the Principal for a verified token. First authenticated request JIT-provisions the
   * user with the default customer role (AUTHENTICATION_AND_AUTHORIZATION.md §1).
   */
  async resolvePrincipal(claims: TokenClaims): Promise<Principal> {
    const existing = await repo.findUserByAuthId(claims.sub);
    if (existing) return buildPrincipal(existing);

    const session = await mongoose.startSession();
    try {
      let created!: Awaited<ReturnType<typeof repo.createUser>>;
      await session.withTransaction(async () => {
        created = await repo.createUser(
          {
            authProviderId: claims.sub,
            email: claims.email,
            phone: claims.phone_number,
          },
          session,
        );
        await repo.addRole(String(created._id), DEFAULT_ROLE, 'system', session);
      });
      await writeAudit({
        actorId: String(created._id),
        action: 'user.provisioned',
        entityType: 'user',
        entityId: String(created._id),
        reason: 'jit_first_auth',
      });
      const fresh = await repo.findUserByAuthId(claims.sub);
      return buildPrincipal(fresh!);
    } finally {
      await session.endSession();
    }
  },

  /** Account age in whole days (used by ping/Spot-Me eligibility gates). */
  async getAccountAgeDays(userId: string): Promise<number> {
    const user = await repo.findUserById(userId);
    if (!user) throw NotFoundError('User not found');
    const created = (user as { created_at?: Date }).created_at ?? new Date();
    return Math.floor((Date.now() - created.getTime()) / (24 * 60 * 60 * 1000));
  },

  /** User ids whose home_location is within `radiusM` of a point (Block Party broadcast target). */
  async findUserIdsNearLocation(
    lng: number,
    lat: number,
    radiusM: number,
    limit: number,
  ): Promise<string[]> {
    const users = await repo.findUsersNearLocation(lng, lat, radiusM, limit);
    return users.map((u) => String(u._id));
  },

  async getMe(userId: string) {
    const user = await repo.findUserById(userId);
    if (!user) throw NotFoundError('User not found');
    const [roles, approved] = await Promise.all([
      repo.activeRolesForUser(userId),
      repo.approvedVerifications(userId),
    ]);
    return {
      id: userId,
      email: user.email,
      phone: user.phone,
      displayName: user.display_name,
      photoUrl: user.photo_url,
      homeLocation: user.home_location ?? null,
      locationPrecision: user.location_precision,
      status: user.status,
      roles: roles.map((r) => r.role),
      verificationTier: effectiveTier(approved.map((v) => ({ tier: v.tier }))),
    };
  },

  async updateMe(userId: string, patch: UserProfilePatch) {
    const updated = await repo.updateUserProfile(userId, patch);
    if (!updated) throw NotFoundError('User not found');
    return this.getMe(userId);
  },

  /**
   * Additive role grant. A user may self-grant only seller/vendor/hub; admin/finance/sponsor/
   * shelter_admin are never self-grantable (AUTHENTICATION_AND_AUTHORIZATION.md §2).
   */
  async addRoleSelf(principal: Principal, role: Role) {
    if (!SELF_GRANTABLE_ROLES.includes(role)) {
      throw ForbiddenError(
        `Role "${role}" cannot be self-granted`,
        ERROR_CODES.CANNOT_SELF_GRANT_ROLE,
      );
    }
    // Additive-role model: already holding the role is an idempotent no-op success (matching
    // grantRole), so re-running onboarding or re-selecting a held role proceeds instead of erroring.
    if (principal.roles.includes(role)) {
      return this.getMe(principal.userId);
    }
    await repo.addRole(principal.userId, role, principal.userId);
    await writeAudit({
      actorId: principal.userId,
      action: 'role.granted',
      entityType: 'user',
      entityId: principal.userId,
      reason: 'self_service',
      metadata: { role },
    });
    return this.getMe(principal.userId);
  },

  /** Grant a role to a user by an authorized actor (e.g. shelter enrollment grants `seller`). */
  async grantRole(userId: string, role: Role, grantedBy: string): Promise<void> {
    const has = await repo.hasActiveRole(userId, role);
    if (has) return;
    await repo.addRole(userId, role, grantedBy);
    await writeAudit({
      actorId: grantedBy,
      action: 'role.granted',
      entityType: 'user',
      entityId: userId,
      reason: 'granted_by_authority',
      metadata: { role },
    });
  },

  /**
   * Shelter-cosigned verification — the alternate KYC path (Flow 1b). Grants an approved
   * Bronze-tier `shelter_cosign` record so a resident can transact without standard ID/bank
   * checks, with the shelter as guarantor (FR-12.2, Q4).
   */
  async grantShelterCosign(userId: string, partnerId: string): Promise<void> {
    const record = await repo.createVerification({
      user_id: userId,
      tier: 'bronze',
      verification_type: 'shelter_cosign',
      provider: 'shelter_cosign',
      provider_reference: partnerId,
    });
    await repo.setVerificationStatus(String(record._id), 'approved');
    await writeAudit({
      actorId: userId,
      action: 'verification.approved',
      entityType: 'verification',
      entityId: String(record._id),
      reason: 'shelter_cosign',
      metadata: { partnerId },
    });
    await publish('verification.tier_changed', { userId, tier: 'bronze' });
  },

  /** Apply a provider user-sync webhook event (create/update/soft-delete). */
  async applyUserSyncEvent(event: UserSyncEvent): Promise<void> {
    const existing = await repo.findUserByAuthId(event.authProviderId);
    if (event.type === 'user.deleted') {
      if (existing) await repo.setUserStatus(String(existing._id), 'deleted');
      return;
    }
    if (!existing) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const user = await repo.createUser(
            {
              authProviderId: event.authProviderId,
              email: event.email,
              phone: event.phone,
              display_name: event.displayName,
            },
            session,
          );
          await repo.addRole(String(user._id), DEFAULT_ROLE, 'webhook', session);
        });
      } finally {
        await session.endSession();
      }
      return;
    }
    await repo.updateUserProfile(String(existing._id), {
      email: event.email ?? existing.email,
      phone: event.phone ?? existing.phone,
      display_name: event.displayName ?? existing.display_name,
    });
  },
};
