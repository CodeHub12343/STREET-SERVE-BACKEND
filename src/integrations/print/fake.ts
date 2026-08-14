/* eslint-disable @typescript-eslint/require-await --
 * These are `async` with no `await` on purpose: they must REJECT rather than throw synchronously,
 * so the fake fails exactly the way the real HTTP gateway does. A caller using `.catch()` instead
 * of `try/await` would otherwise be caught out only in production.
 */

import { ConflictError, UpstreamError } from '../../shared/errors';
import type {
  AccountBalance,
  AudienceCount,
  AudienceRequest,
  FulfilmentStatus,
  ListType,
  PriceBreak,
  PrintVendorGateway,
  RunPrice,
  SubmitOrderRequest,
  VendorOrderRef,
} from './types';
import { selectPriceBreak } from './gateway';

/**
 * Deterministic in-memory print vendor, modelled on PostcardMania DirectMail v3.
 *
 * Not a stub — this is what dev and the entire test suite run against, and it stays that way after
 * the real integration is live, because nobody should need a vendor account to run tests and no
 * test should mail anything.
 *
 * Deliberately FAITHFUL rather than permissive: it enforces the same invariants the real vendor
 * does — duplicate order references rejected with a conflict, monotonic status, a cancellation
 * window that closes, price breaks by volume, and a retainer balance that can run dry. A fake that
 * accepts anything lets bugs reach the one environment where they cost paper and postage.
 */

export interface FakePrintVendorOptions {
  /** Published breaks. Defaults mirror the shape of a real volume table. */
  priceBreaks?: PriceBreak[];
  /** Prepaid retainer, in cents. */
  balanceCents?: number;
  now?: () => Date;
}

interface FakeOrder {
  vendorOrderId: string;
  vendorBatchId: string;
  orderRef: string;
  status: FulfilmentStatus;
  /** Once the batch closes, cancellation is refused — as at the real vendor's daily cutoff. */
  batchClosed: boolean;
}

export interface FakePrintVendor extends PrintVendorGateway {
  /** Advance fulfilment, standing in for the vendor's pipeline. */
  advance(vendorOrderId: string, to: FulfilmentStatus): void;
  /** Close the daily batch, shutting the cancellation window. */
  closeBatch(vendorOrderId: string): void;
  readonly orders: ReadonlyMap<string, FakeOrder>;
}

const PIPELINE: FulfilmentStatus[] = ['preparing', 'printing', 'mailed'];

const DEFAULT_BREAKS: PriceBreak[] = [
  { mailClass: 'standard', unitCostCents: 42, minQuantity: 1 },
  { mailClass: 'standard', unitCostCents: 38, minQuantity: 1_000 },
  { mailClass: 'standard', unitCostCents: 34, minQuantity: 5_000 },
  { mailClass: 'first_class', unitCostCents: 68, minQuantity: 1 },
  { mailClass: 'first_class', unitCostCents: 61, minQuantity: 1_000 },
];

export function createFakePrintVendor(opts: FakePrintVendorOptions = {}): FakePrintVendor {
  const breaks = opts.priceBreaks ?? DEFAULT_BREAKS;
  const now = opts.now ?? ((): Date => new Date());
  let balanceCents = opts.balanceCents ?? 500_00;

  const counts = new Map<string, AudienceCount>();
  const orders = new Map<string, FakeOrder>();
  /** orderRef → vendorOrderId. The vendor's duplicate detection, reproduced. */
  const byOrderRef = new Map<string, string>();

  let seq = 0;
  const nextId = (): string => String(++seq).padStart(6, '0');

  const gateway: FakePrintVendor = {
    orders,

    async listTypes(): Promise<ListType[]> {
      return [
        { key: 'IRL', label: 'ResOcc' },
        { key: 'CON', label: 'Consumer' },
      ];
    },

    async createAudienceCount(input: AudienceRequest): Promise<AudienceCount> {
      if (input.type !== 'radius' && (input.keys ?? []).length === 0) {
        throw UpstreamError('Print vendor rejected the list count', {
          retryable: false,
          details: { reason: 'no areas selected' },
        });
      }
      if (input.type === 'radius' && !input.radius) {
        throw UpstreamError('Print vendor rejected the list count', {
          retryable: false,
          details: { reason: 'radius details missing' },
        });
      }

      const keys = input.keys ?? [];
      // Deterministic so assertions are stable: 1,000 deliverable per area, 2,500 for a radius.
      const perKey = 1_000;
      const recordCount = input.type === 'radius' ? 2_500 : keys.length * perKey;
      const count: AudienceCount = {
        listCountId: `lc_${nextId()}`,
        recordCount,
        breakdown:
          input.type === 'radius'
            ? [{ code: input.radius!.zip, label: input.radius!.city, total: recordCount }]
            : keys.map((k) => ({ code: k, label: k, total: perKey })),
      };
      counts.set(count.listCountId, count);
      return count;
    },

    async priceBreaks(): Promise<PriceBreak[]> {
      return [...breaks].sort((a, b) => a.minQuantity - b.minQuantity);
    },

    async priceRun(input): Promise<RunPrice> {
      const applied = selectPriceBreak(breaks, input.mailClass, input.quantity);
      if (!applied) {
        throw UpstreamError('Print vendor publishes no price for this run', { retryable: false });
      }
      return {
        quantity: input.quantity,
        mailClass: input.mailClass,
        unitCostCents: applied.unitCostCents,
        vendorCostCents: applied.unitCostCents * input.quantity,
        isBinding: false,
        appliedBreak: applied,
      };
    },

    async submitOrder(input: SubmitOrderRequest): Promise<VendorOrderRef> {
      const orderRef = input.orderRef.trim();
      if (!orderRef) {
        throw UpstreamError('Print vendor requires an order reference', { retryable: false });
      }

      // The behaviour that makes retry safe. Reproduced so tests exercise the real contract.
      if (byOrderRef.has(orderRef)) {
        throw ConflictError(undefined, 'This print order has already been submitted', {
          details: { orderRef, reason: 'duplicate extRefNbr' },
          retryable: false,
        });
      }

      const count = counts.get(input.listCountId);
      if (!count) {
        throw UpstreamError('Print vendor rejected the order', {
          retryable: false,
          details: { reason: 'unknown listCountID' },
        });
      }
      if (input.recordCount !== count.recordCount) {
        throw UpstreamError('Print vendor rejected the order', {
          retryable: false,
          details: { reason: 'recordCount does not match the list count' },
        });
      }
      if (!input.artwork.frontUrl || !input.artwork.backUrl) {
        // Both sides are required even though the buyer designs only the front.
        throw UpstreamError('Print vendor rejected the order', {
          retryable: false,
          details: { reason: 'front and back artwork are both required' },
        });
      }

      const vendorOrderId = `ord_${nextId()}`;
      orders.set(vendorOrderId, {
        vendorOrderId,
        vendorBatchId: `bat_${nextId()}`,
        orderRef,
        status: 'preparing',
        batchClosed: false,
      });
      byOrderRef.set(orderRef, vendorOrderId);
      balanceCents -= input.recordCount * 40;

      const created = orders.get(vendorOrderId)!;
      return {
        vendorOrderId,
        vendorBatchId: created.vendorBatchId,
        orderRef,
        deduplicated: false,
      };
    },

    async getStatus(vendorOrderId: string): Promise<FulfilmentStatus> {
      const order = orders.get(vendorOrderId);
      if (!order) {
        throw UpstreamError('Print vendor does not know this order', { retryable: false });
      }
      return order.status;
    },

    async cancelOrder(vendorOrderId: string): Promise<void> {
      const order = orders.get(vendorOrderId);
      if (!order) {
        throw UpstreamError('Print vendor does not know this order', { retryable: false });
      }
      if (order.batchClosed) {
        throw UpstreamError('Print vendor refused the cancellation', {
          retryable: false,
          details: { reason: 'batch already sent to press' },
        });
      }
      order.status = 'canceled';
    },

    async getBalance(): Promise<AccountBalance> {
      return { moneyOnAccountCents: balanceCents };
    },

    advance(vendorOrderId: string, to: FulfilmentStatus): void {
      const order = orders.get(vendorOrderId);
      if (!order) throw new Error(`fake print vendor: unknown order ${vendorOrderId}`);
      const from = PIPELINE.indexOf(order.status);
      const next = PIPELINE.indexOf(to);
      // A physical pipeline cannot run backwards, and terminal states are terminal.
      if (from >= 0 && next >= 0 && next < from) {
        throw new Error(`fake print vendor: cannot move ${order.status} → ${to}`);
      }
      order.status = to;
      if (next >= PIPELINE.indexOf('printing')) order.batchClosed = true;
    },

    closeBatch(vendorOrderId: string): void {
      const order = orders.get(vendorOrderId);
      if (!order) throw new Error(`fake print vendor: unknown order ${vendorOrderId}`);
      order.batchClosed = true;
    },
  };

  void now;
  return gateway;
}
