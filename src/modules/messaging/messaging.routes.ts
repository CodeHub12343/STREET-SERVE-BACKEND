import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { MESSAGE_MAX_LEN } from '../../config/constants';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { messagingService } from './messaging.service';

export const messageThreadsRouter = Router();

// customerId is the vendor-initiated path: the business owner opening the thread with a customer.
const StartThreadBody = z
  .object({ businessId: z.string().length(24), customerId: z.string().max(64).optional() })
  .strict();
const ThreadIdParam = z.object({ id: z.string().length(24) }).strict();
const SendMessageBody = z.object({ body: z.string().min(1).max(MESSAGE_MAX_LEN) }).strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

messageThreadsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('message:participate'),
  validate({ body: StartThreadBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { businessId, customerId } = body<z.infer<typeof StartThreadBody>>(req);
    created(res, await messagingService.startThread(principal(req), businessId, customerId));
  }),
);

messageThreadsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('message:participate'),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await messagingService.listThreads(principal(req)));
  }),
);

messageThreadsRouter.get(
  '/:id/messages',
  rateLimit('read'),
  authenticate,
  requirePermission('message:participate'),
  validate({ params: ThreadIdParam, query: PaginationQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof ThreadIdParam>>(req);
    const q = query<z.infer<typeof PaginationQuery>>(req);
    const page = await messagingService.listMessages(principal(req), id, {
      cursor: q.cursor,
      limit: q.limit,
    });
    ok(res, page.items, { nextCursor: page.nextCursor });
  }),
);

messageThreadsRouter.post(
  '/:id/messages',
  rateLimit('write'),
  authenticate,
  requirePermission('message:participate'),
  validate({ params: ThreadIdParam, body: SendMessageBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof ThreadIdParam>>(req);
    const { body: text } = body<z.infer<typeof SendMessageBody>>(req);
    created(res, await messagingService.sendMessage(principal(req), id, text));
  }),
);

messageThreadsRouter.post(
  '/:id/read',
  rateLimit('write'),
  authenticate,
  requirePermission('message:participate'),
  validate({ params: ThreadIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof ThreadIdParam>>(req);
    ok(res, await messagingService.markRead(principal(req), id));
  }),
);
