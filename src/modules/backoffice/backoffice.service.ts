import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import { assertReconciles } from '../../shared/money';
import { writeAudit } from '../../shared/audit';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { vendorsService } from '../vendors/vendors.service';
import {
  CrewMemberModel,
  EXPENSE_CATEGORIES,
  ExpenseModel,
  InvoiceCounterModel,
  InvoiceEventModel,
  InvoiceModel,
  type ExpenseCategory,
} from './backoffice.model';

/**
 * 7.10 — the business back office: crew (M-21/M-22), expenses (M-23), invoices (M-25).
 *
 * See ADR-002 for the decision underneath all of this: **engagements, not employment.** A crew is a
 * saved list of people, not a payroll, and nothing here calls anyone an employee.
 */

async function assertOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) {
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  }
}

export const backofficeService = {
  // ─── Crew (M-21 / M-22) ──────────────────────────────────────────────────────────────────

  /**
   * Invite someone to a crew. An INVITE, never an add: a list somebody can be put on without
   * consenting is a list that will be used to imply a relationship they never agreed to.
   */
  async inviteCrew(
    principal: Principal,
    businessId: string,
    input: { userId: string; note?: string; defaultRateCents?: number },
  ) {
    await assertOwner(principal, businessId);
    if (input.userId === principal.userId) {
      throw BusinessRuleError(ERROR_CODES.VALIDATION_ERROR, 'You are already on your own crew');
    }

    const existing = await CrewMemberModel.findOne({
      business_id: businessId,
      user_id: input.userId,
    });
    if (existing && existing.status === 'active') {
      return this.crewView(existing);
    }

    const member = await CrewMemberModel.findOneAndUpdate(
      { business_id: businessId, user_id: input.userId },
      {
        $set: {
          note: input.note ?? null,
          default_rate_cents: input.defaultRateCents ?? null,
          status: 'invited',
          invited_at: new Date(),
          responded_at: null,
        },
      },
      { upsert: true, new: true },
    ).exec();

    const business = await vendorsService.getBusiness(businessId);
    notificationsService.notify(input.userId, {
      category: 'jobs',
      title: 'You’ve been invited to a crew',
      // Wording matters here: "work with" rather than "work for". ADR-002's copy rule.
      body: `${business.name} would like to work with you regularly. Accepting means they can offer you jobs first — it does not commit you to anything.`,
      data: { businessId, crewId: String(member._id) },
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'crew.invited',
      entityType: 'business',
      entityId: businessId,
      metadata: { userId: input.userId },
    });
    return this.crewView(member);
  },

  /** The invited person's answer. Only they can give it. */
  async respondToCrewInvite(principal: Principal, crewId: string, accept: boolean) {
    const member = await CrewMemberModel.findOneAndUpdate(
      { _id: crewId, user_id: principal.userId, status: 'invited' },
      { $set: { status: accept ? 'active' : 'declined', responded_at: new Date() } },
      { new: true },
    ).exec();
    if (!member) throw NotFoundError('Invitation not found');
    return this.crewView(member);
  },

  /**
   * Remove someone from a crew. Either side may: the business no longer works with them, or the
   * person no longer wants the offers. A list only one party can leave is not a mutual arrangement.
   */
  async removeFromCrew(principal: Principal, crewId: string) {
    const member = await CrewMemberModel.findById(crewId);
    if (!member) throw NotFoundError('Crew member not found');

    const owner = await vendorsService.getBusinessOwner(member.business_id);
    if (owner !== principal.userId && member.user_id !== principal.userId) {
      throw ForbiddenError('Not your crew', ERROR_CODES.NOT_OWNER);
    }

    member.status = 'removed';
    member.responded_at = new Date();
    await member.save();
    return { removed: true };
  },

  async listCrew(principal: Principal, businessId: string) {
    await assertOwner(principal, businessId);
    const members = await CrewMemberModel.find({
      business_id: businessId,
      status: { $ne: 'removed' },
    })
      .sort({ created_at: -1 })
      .lean();
    return members.map((m) => this.crewView(m));
  },

  /** The other side: the crews I am on, so someone can see and leave them. */
  async myCrews(principal: Principal) {
    const members = await CrewMemberModel.find({
      user_id: principal.userId,
      status: { $in: ['invited', 'active'] },
    })
      .sort({ created_at: -1 })
      .lean();
    return members.map((m) => this.crewView(m));
  },

  crewView(m: {
    _id: unknown;
    business_id: string;
    user_id: string;
    note?: string | null;
    default_rate_cents?: number | null;
    status: string;
  }) {
    return {
      id: String(m._id),
      businessId: m.business_id,
      userId: m.user_id,
      note: m.note ?? null,
      // Named `defaultRateCents`, never `wage` — see ADR-002.
      defaultRateCents: m.default_rate_cents ?? null,
      status: m.status,
    };
  },

  /** M-22 — who to offer a dated job to first. Active members only. */
  async crewForOffer(businessId: string): Promise<string[]> {
    const members = await CrewMemberModel.find({ business_id: businessId, status: 'active' })
      .select('user_id')
      .lean();
    return members.map((m) => m.user_id);
  },

  // ─── Expenses (M-23) ─────────────────────────────────────────────────────────────────────

  async addExpense(
    principal: Principal,
    businessId: string,
    input: {
      category: ExpenseCategory;
      amountCents: number;
      incurredOn: string;
      description?: string;
      receiptUrl?: string;
      vendorName?: string;
    },
  ) {
    await assertOwner(principal, businessId);
    const incurredOn = new Date(input.incurredOn);
    // A future-dated expense is a typo, and one that quietly inflates a period's deductions.
    if (incurredOn.getTime() > Date.now() + 86_400_000) {
      throw BusinessRuleError(ERROR_CODES.VALIDATION_ERROR, 'An expense cannot be dated in the future');
    }

    const expense = await ExpenseModel.create({
      business_id: businessId,
      created_by: principal.userId,
      category: input.category,
      amount_cents: input.amountCents,
      incurred_on: incurredOn,
      description: input.description ?? null,
      receipt_url: input.receiptUrl ?? null,
      vendor_name: input.vendorName ?? null,
    });
    return this.expenseView(expense);
  },

  async listExpenses(
    principal: Principal,
    businessId: string,
    opts: { from?: string; to?: string; category?: ExpenseCategory; limit?: number } = {},
  ) {
    await assertOwner(principal, businessId);
    const filter: Record<string, unknown> = { business_id: businessId, deleted_at: null };
    if (opts.category) filter.category = opts.category;
    if (opts.from || opts.to) {
      filter.incurred_on = {
        ...(opts.from ? { $gte: new Date(opts.from) } : {}),
        ...(opts.to ? { $lte: new Date(opts.to) } : {}),
      };
    }
    const rows = await ExpenseModel.find(filter)
      .sort({ incurred_on: -1 })
      .limit(opts.limit ?? 200)
      .lean();
    return rows.map((r) => this.expenseView(r));
  },

  /** Soft delete: a removed expense still happened, and a deleted row cannot be explained later. */
  async deleteExpense(principal: Principal, expenseId: string) {
    const expense = await ExpenseModel.findById(expenseId);
    if (!expense) throw NotFoundError('Expense not found');
    await assertOwner(principal, expense.business_id);
    expense.deleted_at = new Date();
    await expense.save();
    return { deleted: true };
  },

  /**
   * The summary a tax preparer asks for: totals by category over a period.
   *
   * Deliberately **not** combined with revenue into a "profit" figure. Revenue here is only what
   * moved through the platform; a vendor's cash sales and off-platform income are not, so a
   * platform-computed profit would be wrong in the direction that matters and would look
   * authoritative while being so.
   */
  async expenseSummary(
    principal: Principal,
    businessId: string,
    opts: { from: string; to: string },
  ) {
    await assertOwner(principal, businessId);
    const rows = await ExpenseModel.find({
      business_id: businessId,
      deleted_at: null,
      incurred_on: { $gte: new Date(opts.from), $lte: new Date(opts.to) },
    }).lean();

    const byCategory: Record<string, number> = {};
    for (const category of EXPENSE_CATEGORIES) byCategory[category] = 0;
    for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + row.amount_cents;

    const totalCents = Object.values(byCategory).reduce((a, b) => a + b, 0);
    assertReconciles(totalCents, Object.values(byCategory), 'expense summary');

    return {
      from: opts.from,
      to: opts.to,
      byCategory,
      totalCents,
      count: rows.length,
      withReceipt: rows.filter((r) => r.receipt_url).length,
      disclosure:
        'These are the expenses you recorded here. They are not a complete picture of your business — anything you paid for outside this app is not included, and neither is your income. Give this to whoever prepares your taxes alongside your own records.',
    };
  },

  expenseView(e: {
    _id: unknown;
    category: string;
    amount_cents: number;
    incurred_on: Date;
    description?: string | null;
    receipt_url?: string | null;
    vendor_name?: string | null;
  }) {
    return {
      id: String(e._id),
      category: e.category,
      amountCents: e.amount_cents,
      incurredOn: e.incurred_on,
      description: e.description ?? null,
      receiptUrl: e.receipt_url ?? null,
      vendorName: e.vendor_name ?? null,
    };
  },

  // ─── Invoices (M-25) ─────────────────────────────────────────────────────────────────────

  /**
   * Allocate the next invoice number for a business.
   *
   * One atomic `$inc` on a counter document rather than "max + 1" over the invoices, which races —
   * and two invoices sharing a number is precisely the defect a tax authority notices.
   */
  async nextInvoiceNumber(businessId: string): Promise<string> {
    const counter = await InvoiceCounterModel.findOneAndUpdate(
      { business_id: businessId },
      { $inc: { last_number: 1 } },
      { upsert: true, new: true },
    ).exec();
    // `new: true` returns the post-increment value, which IS the number just allocated.
    return `INV-${String(counter.last_number ?? 1).padStart(4, '0')}`;
  },

  async createInvoice(
    principal: Principal,
    businessId: string,
    input: {
      customerName: string;
      customerEmail?: string;
      lineItems: { description: string; quantity: number; unitPriceCents: number }[];
      taxCents?: number;
      notes?: string;
      dueOn?: string;
    },
  ) {
    await assertOwner(principal, businessId);

    const subtotal = input.lineItems.reduce(
      (sum, li) => sum + li.quantity * li.unitPriceCents,
      0,
    );
    const tax = input.taxCents ?? 0;
    const total = subtotal + tax;

    const invoice = await InvoiceModel.create({
      business_id: businessId,
      number: await this.nextInvoiceNumber(businessId),
      customer_name: input.customerName,
      customer_email: input.customerEmail ?? null,
      line_items: input.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unit_price_cents: li.unitPriceCents,
      })),
      subtotal_cents: subtotal,
      tax_cents: tax,
      total_cents: total,
      notes: input.notes ?? null,
      due_on: input.dueOn ? new Date(input.dueOn) : null,
    });

    await InvoiceEventModel.create({
      invoice_id: String(invoice._id),
      business_id: businessId,
      actor_id: principal.userId,
      from_status: 'none',
      to_status: 'draft',
    });
    return this.invoiceView(invoice);
  },

  /**
   * Move an invoice through its states.
   *
   * `paid` is the vendor asserting they were paid — **not** a platform payment. This invoice bills
   * work done outside the marketplace, and recording it as a platform payment would put money the
   * platform never saw into the ledger. Every transition is logged immutably, because "it says paid
   * now" is a much weaker answer than "it was marked paid on this date by this person".
   */
  async setInvoiceStatus(
    principal: Principal,
    invoiceId: string,
    to: 'sent' | 'paid' | 'void',
  ) {
    const invoice = await InvoiceModel.findById(invoiceId);
    if (!invoice) throw NotFoundError('Invoice not found');
    await assertOwner(principal, invoice.business_id);

    const allowed: Record<string, string[]> = {
      draft: ['sent', 'void'],
      sent: ['paid', 'void'],
      paid: [],
      void: [],
    };
    if (!allowed[invoice.status]?.includes(to)) {
      throw BusinessRuleError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `An invoice that is ${invoice.status} cannot be marked ${to}`,
      );
    }

    const from = invoice.status;
    invoice.status = to;
    if (to === 'sent') invoice.issued_on = new Date();
    if (to === 'paid') invoice.marked_paid_at = new Date();
    if (to === 'void') invoice.voided_at = new Date();
    await invoice.save();

    await InvoiceEventModel.create({
      invoice_id: invoiceId,
      business_id: invoice.business_id,
      actor_id: principal.userId,
      from_status: from,
      to_status: to,
    });
    return this.invoiceView(invoice);
  },

  async listInvoices(principal: Principal, businessId: string, opts: { status?: string } = {}) {
    await assertOwner(principal, businessId);
    const filter: Record<string, unknown> = { business_id: businessId };
    if (opts.status) filter.status = opts.status;
    const rows = await InvoiceModel.find(filter).sort({ created_at: -1 }).limit(200).lean();
    return rows.map((r) => this.invoiceView(r));
  },

  invoiceView(i: {
    _id: unknown;
    number: string;
    customer_name: string;
    customer_email?: string | null;
    line_items: { description: string; quantity: number; unit_price_cents: number }[];
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    status: string;
    issued_on?: Date | null;
    due_on?: Date | null;
    marked_paid_at?: Date | null;
    notes?: string | null;
  }) {
    return {
      id: String(i._id),
      number: i.number,
      customerName: i.customer_name,
      customerEmail: i.customer_email ?? null,
      lineItems: i.line_items.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unit_price_cents,
      })),
      subtotalCents: i.subtotal_cents,
      taxCents: i.tax_cents,
      totalCents: i.total_cents,
      status: i.status,
      issuedOn: i.issued_on ?? null,
      dueOn: i.due_on ?? null,
      paidAt: i.marked_paid_at ?? null,
      notes: i.notes ?? null,
      /** Said on every invoice: this is a record, not a payment the platform processed. */
      disclosure:
        'Marking this paid records what you tell us. StreetServe did not process this payment and does not hold these funds.',
    };
  },
};
