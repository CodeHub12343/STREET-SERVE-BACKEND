import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * ═══ E-1 — THE OUTCOME DATASET ═══
 *
 * One row per (seller, product) opportunity, carrying the WHOLE chain:
 *   recommendation shown → accepted → stock checked out → units sold → settled
 *
 * This is the single prerequisite for everything else in Phase E. A-4 closed the first hop by
 * feeding acceptance back into ranking, but acceptance only says someone *picked something up* —
 * it says nothing about whether it sold. An engine tuned on accepts optimises for appealing
 * listings; an engine tuned on THIS optimises for listings that earn people money. Those are
 * different products.
 *
 * Denormalised on purpose. The joins that produce a row are expensive (four collections, two of
 * them high-write), and a forecaster needs to sweep hundreds of thousands of rows by
 * (category × tile × hour). Recomputing that per request would be untenable; keeping the facts flat
 * makes the read a single indexed scan.
 *
 * Append-then-update, never delete: a row is created when stock is checked out and its outcome
 * fields fill in as reality arrives. That means a row is only COMPLETE once settled, which is
 * exactly why `settled` exists as a flag rather than being inferred from the numbers.
 */
const OutcomeFactSchema = new Schema(
  {
    // ── Keys ──
    checkout_id: { type: String, required: true, unique: true },
    seller_id: { type: String, required: true, index: true },
    product_id: { type: String, required: true },
    hub_id: { type: String, required: true },

    // ── Features present at decision time ──
    /** Category slug, the forecaster's primary grouping dimension. */
    category: { type: String, default: null, index: true },
    /** Geo tile of the HUB (where the stock came from), at DEMAND_TILE_DEGREES resolution. */
    tile: { type: String, default: null, index: true },
    /** UTC hour the stock was taken — the hour dimension of the forecast. */
    hour_utc: { type: Number, required: true },
    /** 0=Sun … 6=Sat. Cheap to store, and the strongest calendar signal in retail. */
    day_of_week: { type: Number, required: true },
    /** E-3 features, snapshotted so a forecast is reproducible from the row alone. */
    is_holiday: { type: Boolean, default: false },
    is_payday_window: { type: Boolean, default: false },
    /** E-2: weather at pickup. Null when no provider is configured — never guessed. */
    weather_code: { type: String, default: null },
    temp_c: { type: Number, default: null },
    /** E-4: expected attendance of any event near the hub at pickup time. 0 = none known. */
    event_attendance: { type: Number, default: 0 },

    // ── The chain ──
    /** Set when this checkout followed an accepted recommendation (A-4's signal). */
    recommendation_id: { type: String, default: null },
    was_recommended: { type: Boolean, default: false },
    unit_value_cents: { type: Number, required: true },
    quantity_out: { type: Number, required: true },

    // ── Outcome (fills in as reality arrives) ──
    quantity_sold: { type: Number, default: 0 },
    gross_cents: { type: Number, default: 0 },
    seller_net_cents: { type: Number, default: 0 },
    /**
     * THE label. Units sold ÷ units taken, 0–1. This is what a forecaster predicts and what an
     * engine should be ranked on — not clicks, not accepts.
     */
    sell_through: { type: Number, default: 0 },
    /** Hours from checkout to first sale. Null when nothing sold — the honest "no signal" value. */
    hours_to_first_sale: { type: Number, default: null },
    settled: { type: Boolean, default: false, index: true },
    settled_at: { type: Date, default: null },
    checked_out_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'outcome_facts' },
);

/** The forecaster's primary read: complete rows for one (category, tile, hour) cell. */
OutcomeFactSchema.index({ category: 1, tile: 1, hour_utc: 1, settled: 1 });
/** Recency windows — every forecast weights recent evidence more heavily. */
OutcomeFactSchema.index({ checked_out_at: -1 });
/** E-9's coach reads one seller's own history. */
OutcomeFactSchema.index({ seller_id: 1, checked_out_at: -1 });

export type OutcomeFactDoc = InferSchemaType<typeof OutcomeFactSchema>;
export const OutcomeFactModel = defineModel('OutcomeFact', OutcomeFactSchema);
