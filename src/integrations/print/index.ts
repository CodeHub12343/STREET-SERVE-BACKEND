import { env, isProd, isTest } from '../../config/env';
import { buildRealGateway } from './gateway';
import { createFakePrintVendor } from './fake';
import type { PrintVendorGateway } from './types';

/**
 * Service locator for the print vendor, matching `integrations/stripe`.
 *
 * Lazy, so the app boots with no vendor configured — which is the normal state today and will
 * remain normal in test and CI forever.
 */
let gateway: PrintVendorGateway | null = null;

export function setPrintVendor(next: PrintVendorGateway): void {
  gateway = next;
}

/** Restores the default resolution. Tests that inject a fake should call this in teardown. */
export function resetPrintVendor(): void {
  gateway = null;
}

/**
 * Resolves the gateway.
 *
 * **Never the real vendor under test.** `dotenv` loads `.env` for `NODE_ENV=test` as well, so a
 * developer holding a vendor key would otherwise point the whole suite at a live print API — the
 * same trap already documented for Gemini in `config/env.ts`, except that this vendor prints and
 * mails physical objects and bills for them. A test run must never be able to spend postage.
 * This is not a test convenience; it is the blast-radius control.
 *
 * Outside test, with no API key we return the FAKE rather than a real gateway that throws on
 * every call, so a developer with no vendor account still gets a working postcard flow end to end
 * instead of a feature that looks broken. The real gateway separately refuses to run in
 * production while the wire format is unverified (`gateway.ts`), so this convenience cannot
 * quietly become the production path.
 */
export function printVendor(): PrintVendorGateway {
  // Requires BOTH halves of the credential pair — the vendor's login takes a key AND a secret.
  const configured = Boolean(env.PCM_API_KEY && env.PCM_API_SECRET);
  gateway ??= resolve(configured);
  return gateway;
}

function resolve(configured: boolean): PrintVendorGateway {
  if (isTest) return createFakePrintVendor();
  if (configured) return buildRealGateway();
  /**
   * **Production never silently falls back to the fake.** The convenience below is for a developer
   * without a vendor account; in production it would quote invented prices and accept orders that
   * can never be mailed — a failure the buyer discovers, not us. The real gateway throws a clear
   * "not configured" error instead, which is loud and correct.
   */
  if (isProd) return buildRealGateway();
  return createFakePrintVendor();
}

export * from './types';
export { createFakePrintVendor } from './fake';
export type { FakePrintVendor, FakePrintVendorOptions } from './fake';
export { selectPriceBreak, resetPrintVendorToken } from './gateway';
export { PCM_BASE_URL, POSTCARD_SIZE_KEYS, mapStatus } from './wire';
