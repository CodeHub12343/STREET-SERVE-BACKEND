import { Router } from 'express';

import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { requireModule } from '../../middleware/requireModule';
import { validate } from '../../middleware/validate';
import { ownsBusiness } from '../vendors/vendors.controller';
import { schedulingController } from './scheduling.controller';
import {
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

// Business-scoped scheduling config (mounted at /businesses).
export const schedulingBusinessRouter = Router();

schedulingBusinessRouter.post(
  '/:id/services',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam, body: CreateServiceBody }),
  requirePermission('service:manage', ownsBusiness),
  requireModule('services'),
  asyncHandler(schedulingController.addService),
);
schedulingBusinessRouter.get(
  '/:id/services',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(schedulingController.listServices),
);
schedulingBusinessRouter.patch(
  '/:id/services/:serviceId',
  rateLimit('write'),
  authenticate,
  validate({ params: ServiceParams, body: UpdateServiceBody }),
  requirePermission('service:manage', ownsBusiness),
  requireModule('services'),
  asyncHandler(schedulingController.updateService),
);
schedulingBusinessRouter.delete(
  '/:id/services/:serviceId',
  rateLimit('write'),
  authenticate,
  validate({ params: ServiceParams }),
  requirePermission('service:manage', ownsBusiness),
  requireModule('services'),
  asyncHandler(schedulingController.removeService),
);
schedulingBusinessRouter.put(
  '/:id/availability',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam, body: SetAvailabilityBody }),
  requirePermission('availability:manage', ownsBusiness),
  requireModule('booking'),
  asyncHandler(schedulingController.setAvailability),
);
schedulingBusinessRouter.get(
  '/:id/bookings',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('booking:manage', ownsBusiness),
  asyncHandler(schedulingController.listBusinessBookings),
);
schedulingBusinessRouter.get(
  '/:id/availability-windows',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('availability:manage', ownsBusiness),
  asyncHandler(schedulingController.getAvailabilityWindows),
);
schedulingBusinessRouter.get(
  '/:id/availability',
  rateLimit('read'),
  optionalAuth,
  validate({ params: BusinessIdParam, query: AvailabilityQuery }),
  asyncHandler(schedulingController.getAvailability),
);

// Bookings (mounted at /bookings).
export const bookingsRouter = Router();

bookingsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('booking:create'),
  validate({ body: CreateBookingBody }),
  asyncHandler(schedulingController.book),
);
bookingsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('booking:create'),
  asyncHandler(schedulingController.listMine),
);
bookingsRouter.patch(
  '/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('booking:create'),
  validate({ params: BookingIdParam, body: RescheduleBody }),
  asyncHandler(schedulingController.reschedule),
);
bookingsRouter.delete(
  '/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('booking:create'),
  validate({ params: BookingIdParam, body: CancelBookingBody }),
  asyncHandler(schedulingController.cancel),
);
bookingsRouter.post(
  '/:id/no-show',
  rateLimit('write'),
  authenticate,
  requirePermission('booking:manage'),
  validate({ params: BookingIdParam }),
  asyncHandler(schedulingController.noShow),
);
bookingsRouter.post(
  '/:id/complete',
  rateLimit('write'),
  authenticate,
  requirePermission('booking:manage'),
  validate({ params: BookingIdParam }),
  asyncHandler(schedulingController.complete),
);
