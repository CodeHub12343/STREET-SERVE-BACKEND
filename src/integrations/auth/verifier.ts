import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type KeyLike,
  errors as joseErrors,
} from 'jose';

import { env } from '../../config/env';
import { ERROR_CODES } from '../../shared/errors/codes';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { TokenClaims } from '../../shared/types/principal';

/**
 * Managed-auth (Clerk/Auth0) token verification at the API edge via JWKS. No shared secret and
 * no DB hit on the hot path. The provider is swappable — this adapter is the only place the
 * JWKS/issuer/audience config is applied (THIRD_PARTY_INTEGRATIONS.md §2).
 *
 * The key resolver is injectable so tests can sign tokens with a local key instead of standing
 * up a remote JWKS endpoint.
 */
type KeyResolver = JWTVerifyGetKey | KeyLike | Uint8Array;

let resolver: KeyResolver | null = null;

/** Test/bootstrap hook: supply a local verification key or a custom JWKS resolver. */
export function setKeyResolver(next: KeyResolver): void {
  resolver = next;
}

function getResolver(): KeyResolver {
  if (resolver) return resolver;
  if (!env.AUTH_JWKS_URL) {
    throw new Error('AUTH_JWKS_URL is not configured and no key resolver was set');
  }
  resolver = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));
  return resolver;
}

export async function verifyToken(token: string): Promise<TokenClaims> {
  try {
    const key = getResolver();
    const options = { issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE };
    const { payload } =
      typeof key === 'function'
        ? await jwtVerify(token, key, options)
        : await jwtVerify(token, key, options);
    if (!payload.sub) {
      throw UnauthenticatedError('Token has no subject', ERROR_CODES.TOKEN_INVALID);
    }
    return payload as TokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw UnauthenticatedError('Access token expired', ERROR_CODES.TOKEN_EXPIRED);
    }
    if (err instanceof joseErrors.JOSEError) {
      throw UnauthenticatedError('Invalid access token', ERROR_CODES.TOKEN_INVALID);
    }
    throw err;
  }
}
