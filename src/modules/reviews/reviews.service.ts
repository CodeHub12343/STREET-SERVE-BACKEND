import { REVIEW_PHOTO_REPORT_THRESHOLD } from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { TransactionModel } from '../payments/payments.model';
import { ReviewModel } from './reviews.model';

export const reviewsService = {
  /**
   * Create a review. Only the customer of a COMPLETED transaction may review, and only the
   * counterparty of that transaction, once (unique on transaction_id).
   */
  async create(
    principal: Principal,
    input: {
      subjectType: 'business' | 'seller';
      subjectId: string;
      rating: number;
      comment?: string;
      /** CU-30 — presigned-uploaded photo URLs. */
      photos?: string[];
      transactionId: string;
    },
  ) {
    const txn = await TransactionModel.findById(input.transactionId).lean().exec();
    if (!txn) throw NotFoundError('Transaction not found');
    if (txn.customer_id !== principal.userId) {
      throw ForbiddenError(
        'You can only review your own transactions',
        ERROR_CODES.REVIEW_NOT_ELIGIBLE,
      );
    }
    if (txn.status !== 'completed') {
      throw ConflictError(ERROR_CODES.REVIEW_NOT_ELIGIBLE, 'Transaction is not completed');
    }
    if (txn.counterparty_type !== input.subjectType || txn.counterparty_id !== input.subjectId) {
      throw ForbiddenError(
        'Subject does not match the transaction',
        ERROR_CODES.REVIEW_NOT_ELIGIBLE,
      );
    }

    try {
      const review = await ReviewModel.create({
        author_id: principal.userId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        rating: input.rating,
        comment: input.comment ?? null,
        photos: input.photos ?? [],
        transaction_id: input.transactionId,
      });
      await publish('review.created', {
        reviewId: String(review._id),
        subjectId: input.subjectId,
        rating: input.rating,
      });
      return { id: String(review._id), rating: review.rating };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw ConflictError(ERROR_CODES.DUPLICATE, 'This transaction has already been reviewed');
      }
      throw err;
    }
  },

  async listForSubject(subjectType: 'business' | 'seller', subjectId: string, limit: number) {
    const reviews = await ReviewModel.find({ subject_type: subjectType, subject_id: subjectId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
    const count = reviews.length;
    const avg = count ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
    return {
      average: Math.round(avg * 10) / 10,
      count,
      reviews: reviews.map((r) => ({
        rating: r.rating,
        comment: r.comment,
        authorId: r.author_id,
        createdAt: r.created_at,
        /**
         * Moderation hides the PHOTOS, never the review. A business that could bury criticism by
         * reporting the picture attached to it would have been handed a takedown button.
         */
        photos: r.photo_moderation === 'visible' ? (r.photos ?? []) : [],
        photosHidden: r.photo_moderation !== 'visible' && (r.photos ?? []).length > 0,
      })),
    };
  },

  /**
   * Report a review's photos. Anyone signed in can report — the people who see a bad image first
   * are passers-by, not moderators — and it hides the photos immediately at the threshold rather
   * than queueing them for a human first. An explicit image on a vendor's profile is worse for
   * everyone than a wrongly-hidden photo, and the review itself is untouched either way.
   */
  async reportPhotos(principal: Principal, reviewId: string, reason?: string) {
    const review = await ReviewModel.findById(reviewId).lean().exec();
    if (!review) throw NotFoundError('Review not found');
    if ((review.photos ?? []).length === 0) {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This review has no photos');
    }
    const updated = await ReviewModel.findByIdAndUpdate(
      reviewId,
      [
        {
          $set: {
            photo_reports: { $add: [{ $ifNull: ['$photo_reports', 0] }, 1] },
            photo_moderation: {
              $cond: [
                { $gte: [{ $add: [{ $ifNull: ['$photo_reports', 0] }, 1] }, REVIEW_PHOTO_REPORT_THRESHOLD] },
                'hidden',
                '$photo_moderation',
              ],
            },
            photo_hidden_reason: reason ?? null,
          },
        },
      ],
      { new: true },
    ).exec();
    await writeAudit({
      actorId: principal.userId,
      action: 'review.photos_reported',
      entityType: 'review',
      entityId: reviewId,
      metadata: { reason: reason ?? null, reports: updated?.photo_reports ?? 0 },
    });
    return { reviewId, hidden: updated?.photo_moderation === 'hidden' };
  },

  /** Admin override — restore photos a report hid, or hide ones a report did not catch. */
  async moderatePhotos(principal: Principal, reviewId: string, visible: boolean, reason?: string) {
    const updated = await ReviewModel.findByIdAndUpdate(
      reviewId,
      {
        $set: {
          photo_moderation: visible ? 'visible' : 'hidden',
          photo_hidden_reason: visible ? null : (reason ?? 'moderator'),
          ...(visible ? { photo_reports: 0 } : {}),
        },
      },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Review not found');
    await writeAudit({
      actorId: principal.userId,
      action: visible ? 'review.photos_restored' : 'review.photos_hidden',
      entityType: 'review',
      entityId: reviewId,
      metadata: { reason: reason ?? null },
    });
    return { reviewId, visible };
  },
};
