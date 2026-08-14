import {
  BOOKING_CUTOFF_DEFAULT_MIN,
  BOOKING_REMINDER_1H_SEC,
  BOOKING_REMINDER_24H_SEC,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { UserModel } from '../identity/identity.model';
import { notificationsService } from '../notifications/notifications.service';
import { feeService } from '../payments/fees';
import { vendorsService } from '../vendors/vendors.service';
import { BusinessModel } from '../vendors/vendors.model';
import { schedulingRepository as repo } from './scheduling.repository';
import { ServiceModel } from './scheduling.model';

async function assertBusinessOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId)
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
}

/** Minutes-from-midnight + weekday for a scheduled instant. TZ is simplified to UTC for the pilot. */
function minutesOfDay(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const schedulingService = {
  // ─── Services ─────────────────────────────────────────────────────────────────────────────
  async addService(
    principal: Principal,
    businessId: string,
    dto: {
      name: string;
      durationMin: number;
      priceCents: number;
      photoUrl?: string;
      cutoffMin?: number;
    },
  ) {
    await assertBusinessOwner(principal, businessId);
    const s = await repo.createService({
      business_id: businessId,
      name: dto.name,
      duration_min: dto.durationMin,
      price_cents: dto.priceCents,
      photo_url: dto.photoUrl ?? null,
      cutoff_min: dto.cutoffMin ?? null,
    });
    return {
      id: String(s._id),
      name: s.name,
      durationMin: s.duration_min,
      priceCents: s.price_cents,
      photoUrl: s.photo_url ?? null,
    };
  },

  async updateService(
    principal: Principal,
    businessId: string,
    serviceId: string,
    patch: {
      name?: string;
      durationMin?: number;
      priceCents?: number;
      photoUrl?: string | null;
      cutoffMin?: number | null;
    },
  ) {
    await assertBusinessOwner(principal, businessId);
    const existing = await repo.findServiceById(serviceId);
    if (!existing || existing.business_id !== businessId) throw NotFoundError('Service not found');

    const s = await repo.updateService(serviceId, {
      name: patch.name,
      duration_min: patch.durationMin,
      price_cents: patch.priceCents,
      photo_url: patch.photoUrl,
      cutoff_min: patch.cutoffMin,
    });
    if (!s) throw NotFoundError('Service not found');
    return {
      id: String(s._id),
      name: s.name,
      durationMin: s.duration_min,
      priceCents: s.price_cents,
      photoUrl: s.photo_url ?? null,
    };
  },

  /**
   * Retire a service. Deliberately a SOFT delete: `bookings.service_id` is a bare reference with
   * no name/price snapshot (unlike order line items), so hard-deleting would leave a customer's
   * existing appointment unable to say what it is for. `listServices` already filters `active`,
   * so it disappears from the vendor's list and the customer's profile either way.
   */
  async removeService(principal: Principal, businessId: string, serviceId: string) {
    await assertBusinessOwner(principal, businessId);
    const existing = await repo.findServiceById(serviceId);
    if (!existing || existing.business_id !== businessId) throw NotFoundError('Service not found');

    await repo.updateService(serviceId, { active: false });
    await writeAudit({
      actorId: principal.userId,
      action: 'service.retired',
      entityType: 'service',
      entityId: serviceId,
      metadata: { businessId },
    });
    return { id: serviceId, removed: true };
  },

  async listServices(businessId: string) {
    const services = await repo.listServices(businessId);
    return services.map((s) => ({
      id: String(s._id),
      name: s.name,
      durationMin: s.duration_min,
      priceCents: s.price_cents,
      photoUrl: s.photo_url ?? null,
    }));
  },

  // ─── Availability ─────────────────────────────────────────────────────────────────────────
  async setAvailability(
    principal: Principal,
    businessId: string,
    windows: { dayOfWeek: number; startMin: number; endMin: number }[],
  ) {
    await assertBusinessOwner(principal, businessId);
    for (const w of windows) {
      if (w.startMin < 0 || w.endMin > 1440 || w.startMin >= w.endMin) {
        throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Invalid availability window');
      }
    }
    await repo.replaceWindows(
      businessId,
      windows.map((w) => ({ day_of_week: w.dayOfWeek, start_min: w.startMin, end_min: w.endMin })),
    );
    return { windows: windows.length };
  },

  /** The configured weekly windows (owner's editor prefill — distinct from computed slots). */
  async getAvailabilityWindows(principal: Principal, businessId: string) {
    await assertBusinessOwner(principal, businessId);
    const windows = await repo.listWindows(businessId);
    return {
      windows: windows.map((w) => ({
        dayOfWeek: w.day_of_week,
        startMin: w.start_min,
        endMin: w.end_min,
      })),
    };
  },

  /** Open slots for a service on a given date (YYYY-MM-DD), minus already-booked slots. */
  async getAvailability(businessId: string, serviceId: string, dateISO: string) {
    const service = await repo.findServiceById(serviceId);
    if (!service || service.business_id !== businessId) throw NotFoundError('Service not found');

    const dayStart = new Date(`${dateISO}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime()))
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Invalid date');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const windows = await repo.windowsForDay(businessId, dayStart.getUTCDay());
    const booked = await repo.bookingsOnDate(businessId, dayStart, dayEnd, serviceId);
    const takenStarts = new Set(booked.map((b) => b.scheduled_at.getTime()));

    const slots: string[] = [];
    for (const w of windows) {
      for (let m = w.start_min; m + service.duration_min <= w.end_min; m += service.duration_min) {
        const slot = new Date(dayStart.getTime() + m * 60 * 1000);
        if (slot.getTime() <= Date.now()) continue; // no past slots
        if (!takenStarts.has(slot.getTime())) slots.push(slot.toISOString());
      }
    }
    return { serviceId, date: dateISO, durationMin: service.duration_min, slots };
  },

  async assertValidSlot(
    businessId: string,
    serviceId: string,
    scheduledAt: Date,
    durationMin: number,
  ) {
    const windows = await repo.windowsForDay(businessId, scheduledAt.getUTCDay());
    const start = minutesOfDay(scheduledAt);
    const fits = windows.some((w) => w.start_min <= start && start + durationMin <= w.end_min);
    if (!fits)
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Requested time is outside availability');

    const end = new Date(scheduledAt.getTime() + durationMin * 60 * 1000);
    const overlaps = await repo.overlappingBookings(serviceId, scheduledAt, end);
    if (overlaps.length > 0)
      throw ConflictError(ERROR_CODES.CONFLICT, 'That slot is already booked');
  },

  // ─── Bookings ─────────────────────────────────────────────────────────────────────────────
  async book(
    principal: Principal,
    input: { businessId: string; serviceId: string; scheduledAt: string; recurrenceRule?: string },
  ) {
    const service = await repo.findServiceById(input.serviceId);
    if (!service || service.business_id !== input.businessId)
      throw NotFoundError('Service not found');
    const scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'scheduledAt must be a future time');
    }
    await this.assertValidSlot(
      input.businessId,
      input.serviceId,
      scheduledAt,
      service.duration_min,
    );

    const booking = await repo.createBooking({
      customer_id: principal.userId,
      business_id: input.businessId,
      service_id: input.serviceId,
      scheduled_at: scheduledAt,
      duration_min: service.duration_min,
      recurrence_rule: input.recurrenceRule ?? null,
    });
    const owner = await vendorsService.getBusinessOwner(input.businessId);
    if (owner) {
      notificationsService.notify(owner, {
        category: 'booking',
        title: 'New booking',
        body: `${service.name} booked`,
        data: { bookingId: String(booking._id), audience: 'vendor' },
      });
    }
    // Confirm to the customer too — the booking is their receipt, not just the vendor's ticket.
    const business = await BusinessModel.findById(input.businessId, { name: 1 }).lean().exec();
    notificationsService.notify(principal.userId, {
      category: 'booking',
      title: 'Booking confirmed',
      body: `${service.name} at ${business?.name ?? 'the business'} is confirmed.`,
      data: { bookingId: String(booking._id), audience: 'customer' },
    });
    await publish('booking.created', {
      bookingId: String(booking._id),
      businessId: input.businessId,
    });
    return this.view(booking);
  },

  async reschedule(principal: Principal, bookingId: string, newAtISO: string) {
    const booking = await repo.findBookingById(bookingId);
    if (!booking) throw NotFoundError('Booking not found');
    if (booking.customer_id !== principal.userId) {
      throw ForbiddenError('Not your booking', ERROR_CODES.NOT_OWNER);
    }
    if (booking.status !== 'booked') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Booking is ${booking.status}`);
    }
    await this.assertBeforeCutoff(booking.business_id, booking.service_id, booking.scheduled_at);

    const newAt = new Date(newAtISO);
    if (Number.isNaN(newAt.getTime()) || newAt.getTime() <= Date.now()) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'New time must be in the future');
    }
    await this.assertValidSlot(
      booking.business_id,
      booking.service_id,
      newAt,
      booking.duration_min,
    );
    const updated = await repo.updateBooking(bookingId, {
      scheduled_at: newAt,
      reminder_sent_24h: false,
      reminder_sent_1h: false,
    });
    return this.view(updated!);
  },

  async cancel(principal: Principal, bookingId: string, reason?: string) {
    const booking = await repo.findBookingById(bookingId);
    if (!booking) throw NotFoundError('Booking not found');
    const owner = await vendorsService.getBusinessOwner(booking.business_id);
    const isCustomer = booking.customer_id === principal.userId;
    const isOwner = owner === principal.userId;
    if (!isCustomer && !isOwner) throw ForbiddenError('Not a participant', ERROR_CODES.NOT_OWNER);
    // Customers must cancel before the cutoff; the business may cancel any time.
    if (isCustomer && !isOwner) {
      await this.assertBeforeCutoff(booking.business_id, booking.service_id, booking.scheduled_at);
    }
    const updated = await repo.transitionBooking(bookingId, 'booked', {
      status: 'cancelled',
      cancelled_reason: reason ?? null,
    });
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Booking not active');
    const notifyUser = isCustomer ? owner : booking.customer_id;
    if (notifyUser) {
      notificationsService.notify(notifyUser, {
        category: 'booking',
        title: 'Booking cancelled',
        body: reason ?? 'A booking was cancelled',
        // The cancel notice goes to whichever side didn't cancel — route it to their booking view.
        data: { bookingId, audience: isCustomer ? 'vendor' : 'customer' },
      });
    }
    await publish('booking.cancelled', { bookingId, businessId: booking.business_id });
    return { id: bookingId, status: 'cancelled' };
  },

  async markNoShow(principal: Principal, bookingId: string) {
    const booking = await repo.findBookingById(bookingId);
    if (!booking) throw NotFoundError('Booking not found');
    await assertBusinessOwner(principal, booking.business_id);
    if (booking.scheduled_at.getTime() > Date.now()) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Cannot mark no-show before the scheduled time',
      );
    }
    const updated = await repo.transitionBooking(bookingId, 'booked', { status: 'no_show' });
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Booking not active');
    // No-show is a Trust Score input (applied by the trust module in Phase 4).
    await publish('booking.no_show', {
      bookingId,
      businessId: booking.business_id,
      customerId: booking.customer_id,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'booking.no_show',
      entityType: 'booking',
      entityId: bookingId,
      metadata: { customerId: booking.customer_id },
    });
    return { id: bookingId, status: 'no_show' };
  },

  /**
   * Complete a booking (§32 booking/service fee).
   *
   * A booking is a sale of a service, and the platform's fee is charged on it like any other
   * completed sale — bookings were the one transaction type that produced revenue for the vendor and
   * none for the platform, purely because nobody had wired the fee. Recorded on completion, not at
   * booking time: a slot that was reserved and never served has not earned anyone anything.
   *
   * `booking` is its own fee-type rather than reusing `marketplace` so the rate can move
   * independently later without re-pricing every other sale on the platform.
   */
  async complete(principal: Principal, bookingId: string) {
    const booking = await repo.findBookingById(bookingId);
    if (!booking) throw NotFoundError('Booking not found');
    await assertBusinessOwner(principal, booking.business_id);
    const updated = await repo.transitionBooking(bookingId, 'booked', { status: 'completed' });
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Booking not active');

    const service = await ServiceModel.findById(booking.service_id, { price_cents: 1 }).lean().exec();
    const priceCents = service?.price_cents ?? 0;
    const platformFeeCents = priceCents > 0 ? await feeService.resolveFee('booking', priceCents) : 0;
    if (platformFeeCents > 0) {
      await repo.setBookingFee(bookingId, platformFeeCents);
      await writeAudit({
        actorId: principal.userId,
        action: 'booking.fee_recorded',
        entityType: 'booking',
        entityId: bookingId,
        metadata: { priceCents, platformFeeCents },
      });
    }
    return { id: bookingId, status: 'completed', priceCents, platformFeeCents };
  },

  async listMyBookings(customerId: string, limit: number) {
    const bookings = await repo.listCustomerBookings(customerId, limit);
    if (bookings.length === 0) return [];
    // The customer's history row names the business + service; resolve both in one read each.
    const [bizzes, services] = await Promise.all([
      BusinessModel.find({ _id: { $in: [...new Set(bookings.map((b) => b.business_id))] } }, { name: 1 })
        .lean()
        .exec(),
      ServiceModel.find(
        { _id: { $in: [...new Set(bookings.map((b) => b.service_id))] } },
        { name: 1, price_cents: 1 },
      )
        .lean()
        .exec(),
    ]);
    const bizName = new Map(bizzes.map((b) => [String(b._id), b.name]));
    const svcById = new Map(services.map((s) => [String(s._id), s]));
    return bookings.map((b) => ({
      ...this.view(b),
      businessName: bizName.get(b.business_id) ?? 'Business',
      serviceName: svcById.get(b.service_id)?.name ?? 'Service',
      priceCents: svcById.get(b.service_id)?.price_cents ?? 0,
    }));
  },

  /**
   * The vendor's worklist (V-07): the business's bookings with the customer's NAME and the
   * service — the vendor-bookings screen previously read the caller's own customer bookings
   * (/bookings/mine), which for a vendor is almost always empty.
   */
  async listForBusiness(principal: Principal, businessId: string, limit: number) {
    await assertBusinessOwner(principal, businessId);
    const bookings = await repo.listBusinessBookings(businessId, limit);
    if (bookings.length === 0) return [];
    const [users, services] = await Promise.all([
      UserModel.find(
        { _id: { $in: [...new Set(bookings.map((b) => b.customer_id))] } },
        { display_name: 1 },
      )
        .lean()
        .exec(),
      ServiceModel.find(
        { _id: { $in: [...new Set(bookings.map((b) => b.service_id))] } },
        { name: 1, price_cents: 1 },
      )
        .lean()
        .exec(),
    ]);
    const nameById = new Map(users.map((u) => [String(u._id), u.display_name]));
    const svcById = new Map(services.map((s) => [String(s._id), s]));
    return bookings.map((b) => ({
      ...this.view(b),
      customerName: nameById.get(b.customer_id) || 'A customer',
      serviceName: svcById.get(b.service_id)?.name ?? 'Service',
      priceCents: svcById.get(b.service_id)?.price_cents ?? 0,
    }));
  },

  // ─── Reminders sweep (24h + 1h) ────────────────────────────────────────────────────────────
  async sendDueReminders(): Promise<{ sent24h: number; sent1h: number }> {
    const now = new Date();
    let sent24h = 0;
    let sent1h = 0;

    const due24 = await repo.dueReminders(
      '24h',
      new Date(now.getTime() + BOOKING_REMINDER_24H_SEC * 1000),
      now,
      500,
    );
    for (const b of due24) {
      notificationsService.notify(b.customer_id, {
        category: 'booking',
        title: 'Booking reminder',
        body: 'You have a booking in 24 hours',
        data: { bookingId: String(b._id) },
      });
      await repo.updateBooking(String(b._id), { reminder_sent_24h: true });
      sent24h += 1;
    }
    const due1 = await repo.dueReminders(
      '1h',
      new Date(now.getTime() + BOOKING_REMINDER_1H_SEC * 1000),
      now,
      500,
    );
    for (const b of due1) {
      notificationsService.notify(b.customer_id, {
        category: 'booking',
        title: 'Booking reminder',
        body: 'You have a booking in 1 hour',
        data: { bookingId: String(b._id) },
      });
      await repo.updateBooking(String(b._id), { reminder_sent_1h: true });
      sent1h += 1;
    }
    return { sent24h, sent1h };
  },

  async assertBeforeCutoff(businessId: string, serviceId: string, scheduledAt: Date) {
    const service = await repo.findServiceById(serviceId);
    const cutoffMin = service?.cutoff_min ?? BOOKING_CUTOFF_DEFAULT_MIN;
    if (scheduledAt.getTime() - Date.now() < cutoffMin * 60 * 1000) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Changes must be made at least ${cutoffMin} minutes ahead`,
      );
    }
  },

  view(b: {
    _id: unknown;
    customer_id: string;
    business_id: string;
    service_id: string;
    scheduled_at: Date;
    status: string;
    duration_min: number;
  }) {
    return {
      id: String(b._id),
      customerId: b.customer_id,
      businessId: b.business_id,
      serviceId: b.service_id,
      scheduledAt: b.scheduled_at,
      durationMin: b.duration_min,
      status: b.status,
    };
  },
};
