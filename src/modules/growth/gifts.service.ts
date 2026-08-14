import { createHash, randomBytes } from 'node:crypto';

import { GIFT_EXPIRY_DAYS, GIFT_EXPIRY_NOTICE_HOURS } from '../../config/constants';
import { publish } from '../../events/bus';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import { GiftModel } from './growth.model';

function code(): string {
  return randomBytes(6).toString('hex').toUpperCase();
}
function hashContact(contact: string): string {
  return createHash('sha256').update(contact.trim().toLowerCase()).digest('hex');
}

export const giftsService = {
  /** Buy a gift (prepaid to the business) with a redemption code + expiry (FR-6.1). */
  async create(
    principal: Principal,
    input: { businessId: string; itemName: string; amountCents: number; recipientContact: string },
    idempotencyKey: string,
  ) {
    const owner = await vendorsService.getBusinessOwner(input.businessId);
    if (!owner) throw NotFoundError('Business not found');

    const charge = await paymentsService.charge({
      customerId: principal.userId,
      counterpartyType: 'business',
      counterpartyId: input.businessId,
      amountCents: input.amountCents,
      idempotencyKey,
    });

    const expiresAt = new Date(Date.now() + GIFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const gift = await GiftModel.create({
      sender_id: principal.userId,
      business_id: input.businessId,
      recipient_contact_hash: hashContact(input.recipientContact),
      item_name: input.itemName,
      amount_cents: input.amountCents,
      transaction_id: charge.transactionId,
      redemption_code: code(),
      expires_at: expiresAt,
    });
    await publish('gift.created', { giftId: String(gift._id), businessId: input.businessId });
    return {
      giftId: String(gift._id),
      redemptionCode: gift.redemption_code,
      expiresAt,
      payment: charge,
    };
  },

  async redeem(_principal: Principal, redemptionCode: string) {
    const gift = await GiftModel.findOne({ redemption_code: redemptionCode }).exec();
    if (!gift) throw NotFoundError('Gift not found');
    if (gift.status === 'redeemed') {
      throw ConflictError(ERROR_CODES.GIFT_ALREADY_REDEEMED, 'Gift already redeemed');
    }
    if (gift.status === 'expired' || gift.expires_at.getTime() < Date.now()) {
      await GiftModel.updateOne(
        { _id: gift._id, status: 'pending' },
        { $set: { status: 'expired' } },
      ).exec();
      throw BusinessRuleError(ERROR_CODES.GIFT_EXPIRED, 'Gift has expired');
    }
    const updated = await GiftModel.findOneAndUpdate(
      { _id: gift._id, status: 'pending' },
      { $set: { status: 'redeemed', redeemed_at: new Date() } },
      { new: true },
    ).exec();
    if (!updated) throw ConflictError(ERROR_CODES.GIFT_ALREADY_REDEEMED, 'Gift already redeemed');
    await publish('gift.redeemed', { giftId: String(gift._id) });
    return { giftId: String(gift._id), status: 'redeemed', itemName: gift.item_name };
  },

  /** Sweep: notify senders 48h before expiry, and expire lapsed gifts. */
  async sweepExpiry(): Promise<{ noticed: number; expired: number }> {
    const now = Date.now();
    const noticeCutoff = new Date(now + GIFT_EXPIRY_NOTICE_HOURS * 60 * 60 * 1000);

    const toNotice = await GiftModel.find({
      status: 'pending',
      expiry_notice_sent: false,
      expires_at: { $lte: noticeCutoff, $gt: new Date(now) },
    })
      .limit(500)
      .exec();
    for (const g of toNotice) {
      notificationsService.notify(g.sender_id, {
        category: 'gift',
        title: 'Gift expiring soon',
        body: `Your gift "${g.item_name}" expires soon`,
        data: { giftId: String(g._id) },
      });
      await GiftModel.updateOne({ _id: g._id }, { $set: { expiry_notice_sent: true } }).exec();
    }

    const expiredRes = await GiftModel.updateMany(
      { status: 'pending', expires_at: { $lte: new Date(now) } },
      { $set: { status: 'expired' } },
    ).exec();
    return { noticed: toNotice.length, expired: expiredRes.modifiedCount };
  },
};
