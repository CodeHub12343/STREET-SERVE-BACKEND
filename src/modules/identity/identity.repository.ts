import type { ClientSession } from 'mongoose';

import type { Role, Tier, UserStatus } from '../../config/constants';
import { UserModel, UserRoleModel, VerificationRecordModel } from './identity.model';

/**
 * Explicit profile patch shape. We avoid `Partial<UserDoc>` because Mongoose's InferSchemaType
 * emits a `[x: string]: NativeDate` index signature when custom timestamp field names are used,
 * which poisons partial-update typing.
 */
export interface UserProfilePatch {
  email?: string | null;
  phone?: string | null;
  display_name?: string | null;
  photo_url?: string | null;
  location_precision?: 'exact' | 'fuzzed';
  fuzz_radius_m?: number;
  home_location?: { type: 'Point'; coordinates: [number, number] };
}

/**
 * Repository layer — the only place identity Mongoose models are touched. No business rules here.
 */
export const identityRepository = {
  findUserByAuthId(authProviderId: string) {
    return UserModel.findOne({ authProviderId }).exec();
  },

  findUserById(id: string) {
    return UserModel.findById(id).exec();
  },

  findUsersNearLocation(lng: number, lat: number, radiusM: number, limit: number) {
    return UserModel.find({
      status: 'active',
      home_location: {
        $near: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: radiusM },
      },
    })
      .limit(limit)
      .select('_id')
      .lean()
      .exec();
  },

  createUser(
    data: { authProviderId: string; email?: string; phone?: string; display_name?: string },
    session?: ClientSession,
  ) {
    return UserModel.create([data], { session }).then((docs) => docs[0]!);
  },

  updateUserProfile(id: string, patch: UserProfilePatch) {
    return UserModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  setUserStatus(id: string, status: UserStatus) {
    return UserModel.findByIdAndUpdate(id, { $set: { status } }, { new: true }).exec();
  },

  activeRolesForUser(userId: string) {
    return UserRoleModel.find({ user_id: userId, revoked_at: null }).exec();
  },

  addRole(userId: string, role: Role, grantedBy: string | null, session?: ClientSession) {
    return UserRoleModel.create(
      [{ user_id: userId, role, granted_by: grantedBy }],
      session ? { session } : {},
    ).then((docs) => docs[0]!);
  },

  hasActiveRole(userId: string, role: Role) {
    return UserRoleModel.exists({ user_id: userId, role, revoked_at: null }).then(Boolean);
  },

  approvedVerifications(userId: string) {
    return VerificationRecordModel.find({ user_id: userId, status: 'approved' }).exec();
  },

  allVerifications(userId: string) {
    return VerificationRecordModel.find({ user_id: userId }).sort({ created_at: -1 }).exec();
  },

  createVerification(data: {
    user_id: string;
    tier: Tier;
    verification_type: 'id_document' | 'selfie_liveness' | 'bank_account' | 'shelter_cosign';
    provider?: string;
    provider_reference?: string;
  }) {
    return VerificationRecordModel.create(data);
  },

  findVerificationByProviderRef(providerReference: string) {
    return VerificationRecordModel.findOne({ provider_reference: providerReference }).exec();
  },

  findPendingVerification(
    userId: string,
    type: 'id_document' | 'selfie_liveness' | 'bank_account' | 'shelter_cosign',
  ) {
    return VerificationRecordModel.findOne({
      user_id: userId,
      verification_type: type,
      status: 'pending',
    }).exec();
  },

  setVerificationStatus(id: string, status: 'approved' | 'rejected' | 'expired') {
    return VerificationRecordModel.findByIdAndUpdate(
      id,
      { $set: { status, verified_at: status === 'approved' ? new Date() : null } },
      { new: true },
    ).exec();
  },
};
