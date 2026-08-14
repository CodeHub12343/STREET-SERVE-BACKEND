import type { HydratedDocument } from 'mongoose';

import { POSTCARD_MAX_ARTWORK_BYTES } from '../../config/constants';
import { isAllowedArtworkType, storage } from '../../integrations/storage';
import { logger } from '../../config/logger';
import { bizMetrics } from '../../observability/bizMetrics';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { agreementsService } from '../agreements/agreements.service';
import { vendorsService } from '../vendors/vendors.service';
import { PostcardAssetModel, type PostcardAssetDoc } from './postcards.model';
import { findProduct } from './postcards.pricing';
import { PREPRESS_HEADER_BYTES, readArtworkMetadata } from './prepress';
import { evaluateArtwork, prepressSpecFor } from './prepress.rules';
import { contentScreener } from './screening';

/**
 * ═══ ARTWORK: upload, pre-press, moderation (PC-1, NF-2, F-7) ═══
 *
 * ## The order of operations is the design
 *
 * Validate BEFORE checkout, never after (`ARCHITECTURAL_IMPROVEMENTS.md` §7). An artwork problem
 * found before payment is a re-export; the same problem found after payment is a refund
 * conversation about something already charged, and — past submission — about something already
 * printed. Every gate in this file sits on the cheap side of that line.
 *
 * ## Uploads never touch this server
 *
 * The browser PUTs bytes straight to object storage against a presigned URL. That is good for
 * throughput and it means the server cannot inspect a file as it arrives, so validation is a
 * separate, explicit step that fetches the header back. It also means the storage key must be
 * server-generated: the asset row is created when the URL is issued, and everything afterwards
 * addresses it by ID, so a client never names a path.
 */

const log = logger.child({ module: 'postcards.artwork' });

async function ensureOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) {
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  }
}

function shapeAsset(a: PostcardAssetDoc & { _id: unknown }) {
  return {
    id: String(a._id),
    prepressStatus: a.prepress_status,
    moderationStatus: a.moderation_status,
    format: a.detected_format,
    widthPx: a.width_px,
    heightPx: a.height_px,
    /** Resolution at printed size — the number that decides whether it looks good. */
    effectiveDpi: a.effective_dpi,
    colorSpace: a.color_space,
    sizeBytes: a.size_bytes,
    errors: a.prepress_errors,
    warnings: a.prepress_warnings,
    validatedSku: a.validated_sku,
    moderationReason: a.moderation_reason,
    /**
     * Screening flags are NOT exposed to the buyer. They are hints for a reviewer, and showing
     * someone "we flagged your file as unusually small" invites gaming the heuristics.
     */
  };
}

export const artworkService = {
  /**
   * Issues a presigned upload URL and records the asset it will hold.
   *
   * Gated on the acceptable-use agreement, and gated HERE rather than at submission: the platform
   * is about to accept a file it will print and mail, and the warranties about ownership and
   * content should be given before the file arrives, not after it is sitting in our bucket.
   */
  async createUploadTarget(
    principal: Principal,
    businessId: string,
    input: { contentType: string },
  ) {
    await ensureOwner(principal, businessId);
    await agreementsService.assertAccepted(principal.userId, 'postcard_artwork');

    if (!isAllowedArtworkType(input.contentType)) {
      throw ValidationError('Artwork must be a JPG, PNG or PDF.');
    }

    // The key is generated inside the storage gateway; the client never proposes one.
    const target = await storage().createUploadUrl({
      prefix: 'postcard_artwork',
      contentType: input.contentType,
    });

    const asset = await PostcardAssetModel.create({
      business_id: businessId,
      created_by: principal.userId,
      storage_key: target.key,
      declared_content_type: input.contentType,
      prepress_status: 'awaiting_upload',
      moderation_status: 'pending',
    });

    return {
      assetId: String(asset._id),
      uploadUrl: target.uploadUrl,
      /** Deliberately no storage key: the client has no reason to know it and no use for it. */
    };
  },

  /**
   * Fetches the uploaded file's header and runs pre-press against a chosen product.
   *
   * Idempotent by re-running: validating twice is harmless and re-validating against a different
   * size is a legitimate thing to want, since the same file can pass for one card and fail another.
   */
  async validate(principal: Principal, assetId: string, sku: string) {
    const asset = await PostcardAssetModel.findById(assetId).exec();
    if (!asset) throw NotFoundError('Artwork not found');
    await ensureOwner(principal, asset.business_id);

    const product = findProduct(sku);
    if (!product) throw ValidationError('That postcard size is not available.');

    const object = await storage().readObjectHead(asset.storage_key, PREPRESS_HEADER_BYTES);
    if (!object) {
      // The normal "upload never completed" case, not an error worth a stack trace.
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'We have not received that file yet. Finish the upload and try again.',
      );
    }

    const spec = prepressSpecFor(product);

    if (object.head.sizeBytes > POSTCARD_MAX_ARTWORK_BYTES) {
      return this.recordFailure(asset, sku, object.head.sizeBytes, [
        {
          code: 'too_large',
          message: `That file is larger than ${Math.floor(
            POSTCARD_MAX_ARTWORK_BYTES / (1024 * 1024),
          )} MB. Export it again at a smaller file size — 300 DPI is plenty for print.`,
        },
      ]);
    }

    /**
     * Format comes from the bytes, never from the declared content type or the extension. Both are
     * attacker-controlled, and an HTML document named `.png` is the classic stored-XSS upload.
     */
    const metadata = readArtworkMetadata(object.bytes);
    if (!metadata) {
      return this.recordFailure(asset, sku, object.head.sizeBytes, [
        {
          code: 'unsupported_format',
          message:
            'We could not read that file as a JPG, PNG or PDF. If you exported it from a design ' +
            'tool, try exporting again as a print-ready PDF.',
        },
      ]);
    }

    const verdict = evaluateArtwork(metadata, spec);
    const screening = await contentScreener()
      .screen({
        declaredContentType: asset.declared_content_type,
        metadata,
        sizeBytes: object.head.sizeBytes,
      })
      .catch((err: unknown) => {
        // Screening is advisory; a screener outage must not block a legitimate upload.
        log.warn({ err, assetId }, 'content screening failed; asset still goes to human review');
        return { flags: ['screening_unavailable'] };
      });

    asset.set({
      prepress_status: verdict.passed ? 'passed' : 'failed',
      validated_sku: sku,
      detected_format: metadata.format,
      width_px: metadata.widthPx,
      height_px: metadata.heightPx,
      effective_dpi: verdict.effectiveDpi,
      color_space: metadata.colorSpace,
      size_bytes: object.head.sizeBytes,
      prepress_errors: verdict.errors,
      prepress_warnings: verdict.warnings,
      validated_at: new Date(),
      screening_flags: screening.flags,
      /**
       * Re-validating resets moderation to pending. A file approved for one product and then
       * re-pointed at another has not been re-reviewed, and carrying the old approval forward would
       * let a reviewer's decision attach to something they never saw in that context.
       */
      moderation_status: 'pending',
      moderation_reason: null,
      moderated_by: null,
      moderated_at: null,
    });
    await asset.save();

    return shapeAsset(asset.toObject() as PostcardAssetDoc & { _id: unknown });
  },

  /** Shared failure path, so a rejection always leaves the same shape of record behind. */
  async recordFailure(
    asset: HydratedDocument<PostcardAssetDoc>,
    sku: string,
    sizeBytes: number,
    errors: { code: string; message: string }[],
  ) {
    asset.set({
      prepress_status: 'failed',
      validated_sku: sku,
      size_bytes: sizeBytes,
      prepress_errors: errors,
      prepress_warnings: [],
      validated_at: new Date(),
    });
    await asset.save();
    return shapeAsset(asset.toObject() as PostcardAssetDoc & { _id: unknown });
  },

  /**
   * Refreshes the moderation-queue gauges (7.5, TD-8).
   *
   * Depth AND age of the oldest item, because depth alone hides the failure that actually matters:
   * a queue of three that nobody has looked at for two days is worse than a queue of thirty being
   * worked. Called from the maintenance heartbeat rather than on every write — it is a periodic
   * observation, not a counter.
   */
  async refreshQueueMetrics(): Promise<{ depth: number; oldestSeconds: number }> {
    const pending = { moderation_status: 'pending', prepress_status: 'passed' };
    const [depth, oldest] = await Promise.all([
      PostcardAssetModel.countDocuments(pending).exec(),
      PostcardAssetModel.findOne(pending).sort({ created_at: 1 }).lean().exec(),
    ]);
    const oldestAt = (oldest as { created_at?: Date } | null)?.created_at ?? null;
    const oldestSeconds = oldestAt ? Math.floor((Date.now() - oldestAt.getTime()) / 1000) : 0;

    bizMetrics.postcardModerationQueueDepth.set(depth);
    bizMetrics.postcardModerationOldestSeconds.set(oldestSeconds);
    return { depth, oldestSeconds };
  },

  async get(principal: Principal, assetId: string) {
    const asset = await PostcardAssetModel.findById(assetId).lean().exec();
    if (!asset) throw NotFoundError('Artwork not found');
    await ensureOwner(principal, asset.business_id);
    return shapeAsset(asset as PostcardAssetDoc & { _id: unknown });
  },

  // ─── Moderation (F-7) ─────────────────────────────────────────────────────────────────────
  /**
   * The reviewer queue.
   *
   * Only pre-press PASSES appear: a file that will not print does not need a content decision, and
   * putting it in front of a reviewer wastes the scarcest resource in the pipeline.
   */
  async queue(limit: number) {
    const rows = await PostcardAssetModel.find({
      moderation_status: 'pending',
      prepress_status: 'passed',
    })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    return rows.map((a) => ({
      ...shapeAsset(a as PostcardAssetDoc & { _id: unknown }),
      businessId: a.business_id,
      /** Reviewer-only, and the reason `shapeAsset` withholds these from the buyer. */
      screeningFlags: a.screening_flags,
      uploadedAt: (a as { created_at?: Date }).created_at ?? null,
    }));
  },

  /**
   * A moderator's decision.
   *
   * Atomic and one-way: `findOneAndUpdate` guarded on `pending` means two reviewers opening the
   * same item cannot both record a verdict, and a decision cannot be quietly overwritten later.
   * Reversing one is a new decision with its own audit entry, not an edit to this row.
   */
  async decide(
    principal: Principal,
    assetId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ) {
    if (decision === 'rejected' && !reason?.trim()) {
      // A rejection the buyer cannot act on is just a dead end. The reason is the product.
      throw ValidationError('Give a reason for the rejection — the business will be shown it.');
    }

    const updated = await PostcardAssetModel.findOneAndUpdate(
      { _id: assetId, moderation_status: 'pending' },
      {
        $set: {
          moderation_status: decision,
          moderation_reason: reason?.trim() ?? null,
          moderated_by: principal.userId,
          moderated_at: new Date(),
        },
      },
      { new: true },
    ).exec();

    if (!updated) {
      const exists = await PostcardAssetModel.exists({ _id: assetId });
      if (!exists) throw NotFoundError('Artwork not found');
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This artwork has already been reviewed.');
    }

    await writeAudit({
      actorId: principal.userId,
      action: `postcards.artwork_${decision}`,
      entityType: 'postcard_asset',
      entityId: assetId,
      metadata: { reason: reason?.trim() ?? null },
    });

    return shapeAsset(updated.toObject() as PostcardAssetDoc & { _id: unknown });
  },
};
