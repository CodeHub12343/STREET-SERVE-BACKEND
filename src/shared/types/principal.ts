import type { Role, Tier, UserStatus } from '../../config/constants';

/**
 * The authenticated actor, resolved on every request from the verified JWT + our DB.
 * Roles come from the DB (user_roles), NOT the token — the token proves identity, our data
 * is the authority on capabilities. See AUTHENTICATION_AND_AUTHORIZATION.md §1.
 */
export interface Principal {
  userId: string;
  authProviderId: string;
  roles: Role[];
  verificationTier: Tier;
  status: UserStatus;
  email?: string;
  phone?: string;
}

/** Claims we read off a verified token (provider-agnostic subset). */
export interface TokenClaims {
  sub: string;
  email?: string;
  phone_number?: string;
  [key: string]: unknown;
}
