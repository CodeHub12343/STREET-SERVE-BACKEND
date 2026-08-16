import { OrderModel } from './orders.model';

interface OrderItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

/** DAN-10 — the persisted shape of a delivery destination. Null on every pickup order. */
export interface OrderDestination {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postal_code: string | null;
  location: { type: 'Point'; coordinates: number[] };
  notes: string | null;
  contact_phone: string | null;
}

export const ordersRepository = {
  createOrder(data: {
    customer_id: string;
    business_id: string;
    fulfillment_type?: 'pickup_now' | 'pickup_scheduled' | 'delivery';
    scheduled_for?: Date | null;
    destination?: OrderDestination | null;
    items: OrderItem[];
    subtotal_cents: number;
    discount_percent: number;
    discount_applied_cents: number;
    tax_cents: number;
    delivery_cents: number;
    service_fee_cents: number;
    processing_fee_cents: number;
    pay_it_forward_cents?: number;
    pay_it_forward_redemption_id?: string | null;
    status?: string;
    tip_cents: number;
    round_up_cents: number;
    total_cents: number;
    /** Null when the community fund covered the order in full — no card was charged. */
    transaction_id: string | null;
  }) {
    return OrderModel.create(data);
  },
  findById(id: string) {
    return OrderModel.findById(id).exec();
  },
  transition(id: string, from: string | string[], patch: Record<string, unknown>) {
    const statusFilter = Array.isArray(from) ? { $in: from } : from;
    return OrderModel.findOneAndUpdate(
      { _id: id, status: statusFilter },
      { $set: patch },
      { new: true },
    ).exec();
  },
  update(id: string, patch: Record<string, unknown>) {
    return OrderModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },
  listForCustomer(customerId: string, limit: number) {
    return OrderModel.find({ customer_id: customerId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  /**
   * The vendor's queue. `pending_payment` is EXCLUDED whatever is asked for: an order whose card has
   * not cleared is not a job, and showing one let a vendor accept it and start cooking for somebody
   * who had not paid and might simply close the tab.
   */
  listForBusiness(businessId: string, statuses: string[] | null, limit: number) {
    const filter = statuses
      ? { business_id: businessId, status: { $in: statuses.filter((x) => x !== 'pending_payment') } }
      : { business_id: businessId, status: { $ne: 'pending_payment' } };
    return OrderModel.find(filter).sort({ created_at: -1 }).limit(limit).lean().exec();
  },
};
