import { buildRealGateway } from './gateway';
import type { StripeGateway } from './types';

/**
 * Service locator for the Stripe gateway. Production uses the real Connect gateway; tests inject
 * a fake via setStripeGateway(). Lazy so the app boots without live keys.
 */
let gateway: StripeGateway | null = null;

export function setStripeGateway(next: StripeGateway): void {
  gateway = next;
}

export function stripe(): StripeGateway {
  gateway ??= buildRealGateway();
  return gateway;
}

export * from './types';
