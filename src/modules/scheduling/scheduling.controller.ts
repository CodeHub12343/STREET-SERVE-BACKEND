import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  AvailabilityQuery,
  BookingIdParam,
  BusinessIdParam,
  CancelBookingBody,
  CreateBookingBody,
  CreateServiceBody,
  RescheduleBody,
  ServiceParams,
  SetAvailabilityBody,
  UpdateServiceBody,
} from './scheduling.schema';
import { schedulingService } from './scheduling.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const schedulingController = {
  addService: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateServiceBody>>(req);
    created(res, await schedulingService.addService(principal(req), id, input));
  },
  listServices: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await schedulingService.listServices(id));
  },
  updateService: async (req: Request, res: Response): Promise<void> => {
    const { id, serviceId } = params<z.infer<typeof ServiceParams>>(req);
    const patch = body<z.infer<typeof UpdateServiceBody>>(req);
    ok(res, await schedulingService.updateService(principal(req), id, serviceId, patch));
  },
  removeService: async (req: Request, res: Response): Promise<void> => {
    const { id, serviceId } = params<z.infer<typeof ServiceParams>>(req);
    ok(res, await schedulingService.removeService(principal(req), id, serviceId));
  },
  setAvailability: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const { windows } = body<z.infer<typeof SetAvailabilityBody>>(req);
    ok(res, await schedulingService.setAvailability(principal(req), id, windows));
  },
  listBusinessBookings: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await schedulingService.listForBusiness(principal(req), id, 100));
  },
  getAvailabilityWindows: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await schedulingService.getAvailabilityWindows(principal(req), id));
  },
  getAvailability: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const q = query<z.infer<typeof AvailabilityQuery>>(req);
    ok(res, await schedulingService.getAvailability(id, q.serviceId, q.date));
  },

  book: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CreateBookingBody>>(req);
    created(res, await schedulingService.book(principal(req), input));
  },
  reschedule: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BookingIdParam>>(req);
    const { scheduledAt } = body<z.infer<typeof RescheduleBody>>(req);
    ok(res, await schedulingService.reschedule(principal(req), id, scheduledAt));
  },
  cancel: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BookingIdParam>>(req);
    const { reason } = body<z.infer<typeof CancelBookingBody>>(req);
    ok(res, await schedulingService.cancel(principal(req), id, reason));
  },
  noShow: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BookingIdParam>>(req);
    ok(res, await schedulingService.markNoShow(principal(req), id));
  },
  complete: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BookingIdParam>>(req);
    ok(res, await schedulingService.complete(principal(req), id));
  },
  listMine: async (req: Request, res: Response): Promise<void> => {
    const q = PaginationQuery.parse(req.query);
    ok(res, await schedulingService.listMyBookings(principal(req).userId, q.limit));
  },
};
