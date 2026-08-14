import { z } from 'zod';

const objectId = z.string().length(24);

export const CreateIntentBody = z
  .object({
    checkoutId: objectId,
    quantity: z.number().int().min(1).max(10000),
    /**
     * Optional. When omitted the server prices from the checkout's snapshotted terms. When supplied
     * it is still validated against the owner's minimum authorized price — the client can never
     * set an amount the owner didn't authorise.
     */
    unitPriceCents: z.number().int().min(1).max(100_000_000).optional(),
    customerEmail: z.string().email().max(200).optional(),
    customerPhone: z.string().max(40).optional(),
  })
  .strict();

export const PayTokenParam = z.object({ token: z.string().length(32) }).strict();
export const SalePaymentIdParam = z.object({ id: objectId }).strict();
export const CheckoutIdParam = z.object({ id: objectId }).strict();
