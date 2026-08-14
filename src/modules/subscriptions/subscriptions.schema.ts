import { z } from 'zod';

import { SUBSCRIPTION_PLANS } from '../../config/constants';

const objectId = z.string().length(24);

export const SubscribeBody = z
  .object({ plan: z.enum(SUBSCRIPTION_PLANS), businessId: objectId.optional() })
  .strict();

export const PlanParam = z.object({ plan: z.enum(SUBSCRIPTION_PLANS) }).strict();

export const CancelBody = z.object({ businessId: objectId.optional() }).strict();

export const EntitlementsQuery = z.object({ businessId: objectId.optional() }).strict();
