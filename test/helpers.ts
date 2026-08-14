import { SignJWT } from 'jose';

import type { Role, Tier } from '../src/config/constants';
import {
  UserModel,
  UserRoleModel,
  VerificationRecordModel,
} from '../src/modules/identity/identity.model';
import { getSigningKey, TEST_AUDIENCE, TEST_ISSUER } from './setup';

/** Mint a signed access token for a given auth-provider subject. */
export async function mintToken(
  sub: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(sub)
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSigningKey());
}

/** Create a user with explicit roles + verification tier directly (bypassing JIT provisioning). */
export async function seedUser(opts: {
  authProviderId: string;
  roles?: Role[];
  tier?: Tier;
  email?: string;
  displayName?: string;
  createdDaysAgo?: number;
}): Promise<string> {
  const user = await UserModel.create({
    authProviderId: opts.authProviderId,
    email: opts.email ?? null,
    display_name: opts.displayName ?? null,
  });
  if (opts.createdDaysAgo && opts.createdDaysAgo > 0) {
    const created = new Date(Date.now() - opts.createdDaysAgo * 24 * 60 * 60 * 1000);
    // created_at is immutable under Mongoose timestamps — write via the raw driver to backdate it.
    await UserModel.collection.updateOne({ _id: user._id }, { $set: { created_at: created } });
  }
  const roles = opts.roles ?? ['customer'];
  await UserRoleModel.create(roles.map((role) => ({ user_id: user._id, role })));
  if (opts.tier && opts.tier !== 'tier0') {
    await VerificationRecordModel.create({
      user_id: user._id,
      tier: opts.tier,
      verification_type: 'id_document',
      status: 'approved',
      verified_at: new Date(),
    });
  }
  return String(user._id);
}

export function bearer(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}
