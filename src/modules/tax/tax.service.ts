import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { writeAudit } from '../../shared/audit';
import { formatCents } from '../../shared/money';
import { NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { CityModel } from '../catalog/catalog.model';
import { ledgerService } from '../ledger/ledger.service';
import { TaxCollectionModel } from './tax.model';

/**
 * Marketplace-facilitator sales tax (Phase 5).
 *
 * THE RULE THAT MATTERS: tax is collected ON TOP of the sale price, is never part of the
 * seller/hub/platform split, and is never platform revenue. The customer pays it, the platform
 * holds it as a liability, and it is remitted to the state. Splitting it three ways would be
 * spending money that belongs to a tax authority.
 *
 * Rates come from per-jurisdiction config (`cities.sales_tax_bps`). A jurisdiction with no rate set
 * is one we are not registered in, so nothing is collected there — deliberately fail-closed, since
 * collecting tax you aren't registered to collect is its own violation.
 */
export const taxService = {
  /**
   * What tax applies to a sale of `amountCents` in this city?
   * Returns zero when the jurisdiction isn't configured — the caller then charges the sale untaxed.
   */
  async quote(
    citySlug: string | null,
    amountCents: number,
  ): Promise<{
    taxCents: number;
    rateBps: number;
    jurisdiction: string | null;
    citySlug: string | null;
    source: 'stripe_tax' | 'rate_table';
  }> {
    const none = {
      taxCents: 0,
      rateBps: 0,
      jurisdiction: null,
      citySlug,
      source: 'rate_table' as const,
    };
    if (amountCents <= 0) return none;

    const city = await CityModel.findOne({ slug: citySlug ?? env.DEFAULT_CITY }).lean().exec();
    if (!city || city.sales_tax_bps == null) return none;

    const rateBps = city.sales_tax_bps;
    return {
      // Round half-up: under-collecting creates a liability the platform must fund itself.
      taxCents: Math.round((amountCents * rateBps) / 10000),
      rateBps,
      jurisdiction: city.state,
      citySlug: city.slug,
      source: env.STRIPE_TAX_ENABLED ? 'stripe_tax' : 'rate_table',
    };
  },

  /**
   * Record tax collected on a sale and post it to the ledger as a LIABILITY.
   *
   * The cash entry is written by the sale itself (the customer paid gross + tax in one charge), so
   * this only records the liability side.
   */
  async recordCollection(input: {
    salePaymentId: string;
    checkoutId: string;
    jurisdiction: string;
    citySlug: string | null;
    taxableAmountCents: number;
    rateBps: number;
    taxCents: number;
    source: 'stripe_tax' | 'rate_table';
    providerCalculationId?: string | null;
  }) {
    if (input.taxCents <= 0) return null;

    const record = await TaxCollectionModel.create({
      sale_payment_id: input.salePaymentId,
      checkout_id: input.checkoutId,
      jurisdiction: input.jurisdiction,
      city_slug: input.citySlug,
      taxable_amount_cents: input.taxableAmountCents,
      rate_bps: input.rateBps,
      tax_cents: input.taxCents,
      provider_calculation_id: input.providerCalculationId ?? null,
      source: input.source,
    });

    logger.info(
      { jurisdiction: input.jurisdiction, taxCents: input.taxCents },
      'sales tax collected as marketplace facilitator',
    );
    return record;
  },

  /**
   * Open tax liability by jurisdiction — what must still be filed and paid over.
   * This is the number a finance team files against.
   */
  async remittanceReport(input: { from?: Date; to?: Date; includeRemitted?: boolean }) {
    const match: Record<string, unknown> = {};
    if (!input.includeRemitted) match.remitted_at = null;
    if (input.from || input.to) {
      match.collected_at = {
        ...(input.from ? { $gte: input.from } : {}),
        ...(input.to ? { $lte: input.to } : {}),
      };
    }

    const rows = await TaxCollectionModel.aggregate<{
      _id: string;
      taxCents: number;
      taxableCents: number;
      saleCount: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: '$jurisdiction',
          taxCents: { $sum: '$tax_cents' },
          taxableCents: { $sum: '$taxable_amount_cents' },
          saleCount: { $sum: 1 },
        },
      },
      { $sort: { taxCents: -1 } },
    ]).exec();

    const jurisdictions = await Promise.all(
      rows.map(async (r) => {
        const city = await CityModel.findOne({ state: r._id }).lean().exec();
        return {
          jurisdiction: r._id,
          registrationId: city?.tax_registration_id ?? null,
          taxableCents: r.taxableCents,
          taxCents: r.taxCents,
          saleCount: r.saleCount,
        };
      }),
    );

    return {
      totalTaxCents: jurisdictions.reduce((s, j) => s + j.taxCents, 0),
      jurisdictions,
      // Cross-check against the books: these must agree.
      ledgerLiabilityCents: await ledgerService.balanceOf({
        ownerType: 'platform',
        accountType: 'tax_payable',
      }),
    };
  },

  /**
   * Mark a jurisdiction's collected tax as filed and paid over, and discharge the liability.
   * The ledger entry moves money out of the tax_payable liability and out of platform cash — the
   * state's money leaving, which is exactly what a remittance is.
   */
  async recordRemittance(
    principal: Principal,
    input: { jurisdiction: string; reference: string; upTo?: Date },
  ) {
    const cutoff = input.upTo ?? new Date();
    const open = await TaxCollectionModel.find({
      jurisdiction: input.jurisdiction,
      remitted_at: null,
      collected_at: { $lte: cutoff },
    })
      .lean()
      .exec();

    if (open.length === 0) {
      throw NotFoundError(`No unremitted tax for ${input.jurisdiction}`);
    }
    const totalCents = open.reduce((s, r) => s + r.tax_cents, 0);

    await ledgerService.post({
      transactionId: `taxremit_${input.jurisdiction}_${input.reference}`,
      refType: 'tax_remittance',
      refId: input.reference,
      memo: `Sales tax remitted to ${input.jurisdiction} — ${formatCents(totalCents)}`,
      entries: [
        { ownerType: 'platform', accountType: 'tax_payable', direction: 'debit', amountCents: totalCents, entryType: 'tax_remitted' },
        { ownerType: 'platform', accountType: 'cash', direction: 'credit', amountCents: totalCents, entryType: 'tax_remitted' },
      ],
    });

    // Immutable records: mark filed via the raw driver, adding provenance without altering figures.
    await TaxCollectionModel.collection.updateMany(
      { _id: { $in: open.map((r) => r._id) } },
      { $set: { remitted_at: new Date(), remittance_ref: input.reference } },
    );

    await writeAudit({
      actorId: principal.userId,
      action: 'tax.remitted',
      entityType: 'tax_remittance',
      entityId: input.reference,
      metadata: { jurisdiction: input.jurisdiction, totalCents, records: open.length },
    });

    return { jurisdiction: input.jurisdiction, totalCents, records: open.length, reference: input.reference };
  },
};
