import { MAX_DISCOUNT_PERCENT, type PriceDiscount } from '../orders/discounts';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import { writeAudit } from '../../shared/audit';
import type { Principal } from '../../shared/types/principal';
import { vendorsService } from '../vendors/vendors.service';
import { FlashSaleModel } from './promotions.model';

/**
 * 7.6 / P-15 — flash sales.
 *
 * Built on A-7's contest, not beside it: this module produces `PriceDiscount` candidates and hands
 * them over. It never decides what a customer pays.
 *
 * ## The three constraints, and why each exists
 *
 * 1. **A sale cannot exceed `MAX_DISCOUNT_PERCENT`.** The contest clamps anyway; rejecting at
 *    creation means the vendor learns the limit while they are setting the price, rather than
 *    discovering that the 95% they advertised charged 90%.
 * 2. **A sale cannot start in the past.** Backdating would re-price orders already placed at the
 *    old price — the same discipline as snapshotted consignment terms, applied to promotions.
 * 3. **A window has a maximum length.** A "flash sale" running for a year is just a price change,
 *    and a price change should edit the price so the menu tells the truth. This is a product
 *    constraint, not a technical one, and it is the one most likely to be argued with — hence
 *    stating it here rather than burying it in a validator.
 */

/** A flash sale may not run longer than this. Beyond it, change the price instead. */
export const MAX_FLASH_SALE_DAYS = 14;

interface FlashSaleLike {
  _id: unknown;
  business_id: string;
  menu_item_id?: string | null;
  percent: number;
  label?: string | null;
  starts_at: Date;
  ends_at: Date;
  cancelled_at?: Date | null;
}

/** Public shape — what a customer-facing badge renders from. */
export function flashSaleView(sale: FlashSaleLike) {
  return {
    id: String(sale._id),
    businessId: sale.business_id,
    menuItemId: sale.menu_item_id ?? null,
    percent: sale.percent,
    label: sale.label ?? `${sale.percent}% off — limited time`,
    startsAt: sale.starts_at,
    endsAt: sale.ends_at,
    cancelled: Boolean(sale.cancelled_at),
    live: !sale.cancelled_at && sale.starts_at <= new Date() && new Date() < sale.ends_at,
  };
}

/**
 * Convert a stored sale into a contest candidate.
 *
 * `scope.kind` is `product` for an item-scoped sale and `business` otherwise, matching the
 * abstraction's vocabulary — the contest only needs to know how broadly the discount reaches.
 */
function toDiscount(sale: FlashSaleLike): PriceDiscount {
  return {
    source: 'flash_sale',
    scope: sale.menu_item_id
      ? { kind: 'product', productId: sale.menu_item_id }
      : { kind: 'business', businessId: sale.business_id },
    percent: sale.percent,
    window: { startsAt: sale.starts_at, endsAt: sale.ends_at },
    label: sale.label ?? `${sale.percent}% off — limited time`,
  };
}

async function assertOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) {
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  }
}

export const promotionsService = {
  async create(
    principal: Principal,
    input: {
      businessId: string;
      menuItemId?: string;
      percent: number;
      label?: string;
      startsAt: string;
      endsAt: string;
    },
  ) {
    await assertOwner(principal, input.businessId);

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const now = new Date();

    if (endsAt <= startsAt) {
      throw BusinessRuleError(ERROR_CODES.VALIDATION_ERROR, 'A sale must end after it starts');
    }
    // Backdating would re-price orders already placed. A minute of slack absorbs clock skew between
    // the vendor's device and the server without opening the door to it.
    if (startsAt.getTime() < now.getTime() - 60_000) {
      throw BusinessRuleError(
        ERROR_CODES.VALIDATION_ERROR,
        'A sale cannot start in the past — it would re-price orders already placed',
      );
    }
    if (endsAt.getTime() - startsAt.getTime() > MAX_FLASH_SALE_DAYS * 86_400_000) {
      throw BusinessRuleError(
        ERROR_CODES.VALIDATION_ERROR,
        `A flash sale may run at most ${MAX_FLASH_SALE_DAYS} days. For anything longer, change the item's price so the menu shows what customers actually pay.`,
      );
    }
    if (input.percent > MAX_DISCOUNT_PERCENT) {
      throw BusinessRuleError(
        ERROR_CODES.VALIDATION_ERROR,
        `A discount may not exceed ${MAX_DISCOUNT_PERCENT}%`,
      );
    }

    const sale = await FlashSaleModel.create({
      business_id: input.businessId,
      menu_item_id: input.menuItemId ?? null,
      percent: input.percent,
      label: input.label ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: principal.userId,
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'flash_sale.created',
      entityType: 'business',
      entityId: input.businessId,
      metadata: {
        saleId: String(sale._id),
        percent: input.percent,
        menuItemId: input.menuItemId ?? null,
        startsAt,
        endsAt,
      },
    });
    return flashSaleView(sale);
  },

  /**
   * Cancel early. The row survives with `cancelled_at` set rather than being deleted: a customer
   * who saw the sale price needs an explanation, and a deleted sale explains nothing.
   */
  async cancel(principal: Principal, saleId: string) {
    const sale = await FlashSaleModel.findById(saleId);
    if (!sale) throw NotFoundError('Sale not found');
    await assertOwner(principal, sale.business_id);
    if (sale.cancelled_at) return flashSaleView(sale);

    sale.cancelled_at = new Date();
    await sale.save();
    await writeAudit({
      actorId: principal.userId,
      action: 'flash_sale.cancelled',
      entityType: 'business',
      entityId: sale.business_id,
      metadata: { saleId },
    });
    return flashSaleView(sale);
  },

  /** Owner view: everything, including finished and cancelled sales. */
  async listForBusiness(principal: Principal, businessId: string) {
    await assertOwner(principal, businessId);
    const sales = await FlashSaleModel.find({ business_id: businessId })
      .sort({ starts_at: -1 })
      .limit(100)
      .lean();
    return sales.map(flashSaleView);
  },

  /** Public view: only what is live right now, which is all a customer can act on. */
  async listLive(businessId: string) {
    const now = new Date();
    const sales = await FlashSaleModel.find({
      business_id: businessId,
      cancelled_at: null,
      starts_at: { $lte: now },
      ends_at: { $gt: now },
    })
      .lean();
    return sales.map(flashSaleView);
  },

  /**
   * The contest candidates for one order.
   *
   * Item-scoped sales are returned only for items actually in the cart — a 50%-off sale on a drink
   * nobody ordered must not discount the tacos. Business-wide sales always apply.
   */
  async candidatesFor(
    businessId: string,
    menuItemIds: string[],
    now: Date = new Date(),
  ): Promise<PriceDiscount[]> {
    const sales = await FlashSaleModel.find({
      business_id: businessId,
      cancelled_at: null,
      starts_at: { $lte: now },
      ends_at: { $gt: now },
    }).lean();

    const inCart = new Set(menuItemIds);
    return sales
      .filter((s) => !s.menu_item_id || inCart.has(s.menu_item_id))
      .map((s) => toDiscount(s));
  },
};
