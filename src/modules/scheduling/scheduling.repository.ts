import { AvailabilityWindowModel, BookingModel, ServiceModel } from './scheduling.model';

export const schedulingRepository = {
  // ─── Services ─────────────────────────────────────────────────────────────────────────────
  createService(data: {
    business_id: string;
    name: string;
    duration_min: number;
    price_cents: number;
    photo_url?: string | null;
    cutoff_min?: number | null;
  }) {
    return ServiceModel.create(data);
  },
  findServiceById(id: string) {
    return ServiceModel.findById(id).exec();
  },
  listServices(businessId: string) {
    return ServiceModel.find({ business_id: businessId, active: true }).lean().exec();
  },
  updateService(
    id: string,
    patch: {
      name?: string;
      duration_min?: number;
      price_cents?: number;
      photo_url?: string | null;
      cutoff_min?: number | null;
      active?: boolean;
    },
  ) {
    return ServiceModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  // ─── Availability ─────────────────────────────────────────────────────────────────────────
  replaceWindows(
    businessId: string,
    windows: { day_of_week: number; start_min: number; end_min: number }[],
  ) {
    return AvailabilityWindowModel.deleteMany({ business_id: businessId })
      .exec()
      .then(() =>
        AvailabilityWindowModel.insertMany(windows.map((w) => ({ ...w, business_id: businessId }))),
      );
  },
  listWindows(businessId: string) {
    return AvailabilityWindowModel.find({ business_id: businessId })
      .sort({ day_of_week: 1, start_min: 1 })
      .lean()
      .exec();
  },
  windowsForDay(businessId: string, dayOfWeek: number) {
    return AvailabilityWindowModel.find({ business_id: businessId, day_of_week: dayOfWeek })
      .sort({ start_min: 1 })
      .lean()
      .exec();
  },

  // ─── Bookings ─────────────────────────────────────────────────────────────────────────────
  createBooking(data: {
    customer_id: string;
    business_id: string;
    service_id: string;
    scheduled_at: Date;
    duration_min: number;
    recurrence_rule?: string | null;
  }) {
    return BookingModel.create(data);
  },
  /** §32 — stamp the platform fee taken on a completed booking. */
  setBookingFee(bookingId: string, platformFeeCents: number) {
    return BookingModel.updateOne(
      { _id: bookingId },
      { $set: { platform_fee_cents: platformFeeCents } },
    ).exec();
  },
  findBookingById(id: string) {
    return BookingModel.findById(id).exec();
  },
  /** Active bookings overlapping [start, end) for a service (slot-conflict detection). */
  overlappingBookings(serviceId: string, start: Date, end: Date) {
    return BookingModel.find({
      service_id: serviceId,
      status: 'booked',
      scheduled_at: { $lt: end, $gte: start },
    })
      .lean()
      .exec();
  },
  bookingsOnDate(businessId: string, dayStart: Date, dayEnd: Date, serviceId: string) {
    return BookingModel.find({
      business_id: businessId,
      service_id: serviceId,
      status: 'booked',
      scheduled_at: { $gte: dayStart, $lt: dayEnd },
    })
      .lean()
      .exec();
  },
  updateBooking(id: string, patch: Record<string, unknown>) {
    return BookingModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },
  transitionBooking(id: string, from: string, patch: Record<string, unknown>) {
    return BookingModel.findOneAndUpdate(
      { _id: id, status: from },
      { $set: patch },
      { new: true },
    ).exec();
  },
  /** A business's bookings, upcoming first. Cancelled excluded — the vendor's list is a worklist. */
  listBusinessBookings(businessId: string, limit: number) {
    return BookingModel.find({ business_id: businessId, status: { $ne: 'cancelled' } })
      .sort({ scheduled_at: 1 })
      .limit(limit)
      .lean()
      .exec();
  },
  listCustomerBookings(customerId: string, limit: number) {
    return BookingModel.find({ customer_id: customerId })
      .sort({ scheduled_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  dueReminders(kind: '24h' | '1h', before: Date, now: Date, limit: number) {
    const flag = kind === '24h' ? 'reminder_sent_24h' : 'reminder_sent_1h';
    return BookingModel.find({
      status: 'booked',
      scheduled_at: { $gt: now, $lte: before },
      [flag]: false,
    })
      .limit(limit)
      .exec();
  },
};
