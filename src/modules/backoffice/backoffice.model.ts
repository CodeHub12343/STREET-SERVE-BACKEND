import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';

/**
 * 7.10 — business back office: crew, expenses, invoices.
 *
 * Built on ADR-002, which decided the platform models **engagements, not employment**. There is no
 * employee entity here and there will not be one: storing a wage, a schedule, and a job title
 * asserts an employment relationship, and in most US states the consequences follow the substance
 * rather than the label. StreetServe's users are sole traders; handing them an employer UI without
 * any of the compliance machinery being an employer requires would put them on the wrong side of a
 * payroll audit.
 *
 * A **crew** is therefore a saved list of people a business works with repeatedly, not a payroll.
 */

// ─── crew ──────────────────────────────────────────────────────────────────────────────────
export const CREW_STATUSES = ['invited', 'active', 'declined', 'removed'] as const;

const CrewMemberSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true },
    /** The person's own name for the relationship, e.g. "Saturday market". Never a job title. */
    note: { type: String, default: null },
    /**
     * Optional default rate for jobs offered to this person, in cents. A *rate for work offered*,
     * never a wage — ADR-002's copy rule forbids presenting it as one.
     */
    default_rate_cents: { type: Number, default: null },
    /**
     * Mutual by construction: the business invites, the person accepts. A list somebody can be
     * added to without consenting is a list that will be used to imply a relationship they never
     * agreed to.
     */
    status: { type: String, enum: CREW_STATUSES, default: 'invited' },
    invited_at: { type: Date, default: () => new Date() },
    responded_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'crew_members' },
);
CrewMemberSchema.index({ business_id: 1, user_id: 1 }, { unique: true });
CrewMemberSchema.index({ user_id: 1, status: 1 });

export type CrewMemberDoc = InferSchemaType<typeof CrewMemberSchema>;
export const CrewMemberModel = defineModel('CrewMember', CrewMemberSchema);

// ─── expenses ──────────────────────────────────────────────────────────────────────────────
/**
 * Categories chosen to match how a mobile vendor actually spends, and to line up with the
 * deduction categories a tax preparer asks about. Deliberately short: a list of forty categories is
 * a list nobody classifies correctly.
 */
export const EXPENSE_CATEGORIES = [
  'inventory',
  'fuel',
  'vehicle',
  'supplies',
  'permits',
  'pitch_fees',
  'equipment',
  'marketing',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

const ExpenseSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    created_by: { type: String, required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount_cents: { type: Number, required: true, min: 1 },
    /** The day the money went out, which is not always the day it was entered. */
    incurred_on: { type: Date, required: true },
    description: { type: String, default: null },
    /** A photographed receipt. The single most useful thing at tax time. */
    receipt_url: { type: String, default: null },
    vendor_name: { type: String, default: null },
    deleted_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'expenses' },
);
ExpenseSchema.index({ business_id: 1, incurred_on: -1 });
ExpenseSchema.index({ business_id: 1, category: 1, incurred_on: -1 });

export type ExpenseDoc = InferSchemaType<typeof ExpenseSchema>;
export const ExpenseModel = defineModel('Expense', ExpenseSchema);

// ─── invoices ──────────────────────────────────────────────────────────────────────────────
export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'] as const;

const InvoiceSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    /** Per-business sequence. Gapless within a business, which is what a tax authority expects. */
    number: { type: String, required: true },
    customer_name: { type: String, required: true },
    customer_email: { type: String, default: null },
    line_items: {
      type: [
        {
          _id: false,
          description: { type: String, required: true },
          quantity: { type: Number, required: true, min: 1 },
          unit_price_cents: { type: Number, required: true, min: 0 },
        },
      ],
      default: [],
    },
    subtotal_cents: { type: Number, required: true },
    tax_cents: { type: Number, default: 0 },
    total_cents: { type: Number, required: true },
    notes: { type: String, default: null },
    status: { type: String, enum: INVOICE_STATUSES, default: 'draft' },
    issued_on: { type: Date, default: null },
    due_on: { type: Date, default: null },
    /**
     * Recorded when the business says they were paid. **Not** a platform payment: this invoice is
     * for work billed outside the marketplace, and pretending otherwise would put money movement
     * we never saw into the ledger.
     */
    marked_paid_at: { type: Date, default: null },
    voided_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'invoices' },
);
InvoiceSchema.index({ business_id: 1, number: 1 }, { unique: true });
InvoiceSchema.index({ business_id: 1, status: 1, created_at: -1 });

export type InvoiceDoc = InferSchemaType<typeof InvoiceSchema>;
export const InvoiceModel = defineModel('Invoice', InvoiceSchema);

/**
 * The per-business invoice counter. A separate document so allocating a number is one atomic
 * `$inc` — computing "max + 1" from the invoices themselves races, and two invoices sharing a
 * number is precisely the defect a tax authority notices.
 */
const InvoiceCounterSchema = new Schema(
  {
    business_id: { type: String, required: true, unique: true },
    /** The last number ISSUED. `$inc` returns the newly allocated one, so no default is wanted:
     *  a default would be applied on insert and then incremented past, skipping INV-0001. */
    last_number: { type: Number },
  },
  { collection: 'invoice_counters' },
);
export const InvoiceCounterModel = defineModel('InvoiceCounter', InvoiceCounterSchema);

/**
 * An immutable record of every invoice state change. Invoices are financial documents someone may
 * be asked to justify; "it says paid now" is a much weaker answer than "it was marked paid on this
 * date by this person".
 */
const InvoiceEventSchema = new Schema(
  {
    invoice_id: { type: String, required: true, index: true },
    business_id: { type: String, required: true },
    actor_id: { type: String, required: true },
    from_status: { type: String, required: true },
    to_status: { type: String, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'invoice_events' },
);
InvoiceEventSchema.plugin(immutablePlugin);
export const InvoiceEventModel = defineModel('InvoiceEvent', InvoiceEventSchema);
