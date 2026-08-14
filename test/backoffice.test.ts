import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { InvoiceEventModel } from '../src/modules/backoffice/backoffice.model';
import { backofficeService } from '../src/modules/backoffice/backoffice.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * 7.10 — back office: crew, expenses, invoices.
 *
 * Built on ADR-002: **engagements, not employment.** The tests that matter most here are not the
 * CRUD ones — they are mutual consent on crew membership, and the copy rule that keeps the product
 * from calling anyone an employee. Those words are what a regulator reads as a claim about a
 * relationship, and the platform's users are sole traders who cannot absorb that claim being made
 * on their behalf.
 */
const app = createApp();

async function vendor(prefix: string) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'food',
    requires_license: false,
  });
  const userId = await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Tacos`, categoryId: String(cat._id) });
  return { userId, token, businessId: biz.body.data.id as string };
}

async function worker(prefix: string) {
  const userId = await seedUser({ authProviderId: `${prefix}|worker`, roles: ['customer'] });
  return { userId, token: await mintToken(`${prefix}|worker`) };
}

describe('crew — engagements, not employment (7.10 / ADR-002)', () => {
  it('an invitation is not membership until the person accepts', async () => {
    // A list somebody can be added to without consenting is a list that will be used to imply a
    // relationship they never agreed to.
    const v = await vendor('bo-consent');
    const w = await worker('bo-consent');

    const invited = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/crew`)
      .set(...bearer(v.token))
      .send({ userId: w.userId, note: 'Saturday market' });
    expect(invited.status).toBe(201);
    expect(invited.body.data.status).toBe('invited');

    // Not yet offerable — the offer list is active members only.
    expect(await backofficeService.crewForOffer(v.businessId)).toEqual([]);

    const accepted = await request(app)
      .post(`/api/v1/crew/${invited.body.data.id}/respond`)
      .set(...bearer(w.token))
      .send({ accept: true });
    expect(accepted.body.data.status).toBe('active');
    expect(await backofficeService.crewForOffer(v.businessId)).toEqual([w.userId]);
  });

  it('only the invited person can answer their invitation', async () => {
    const v = await vendor('bo-answer');
    const w = await worker('bo-answer');
    const stranger = await worker('bo-answer-stranger');

    const invited = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/crew`)
      .set(...bearer(v.token))
      .send({ userId: w.userId });

    for (const token of [v.token, stranger.token]) {
      const res = await request(app)
        .post(`/api/v1/crew/${invited.body.data.id}/respond`)
        .set(...bearer(token))
        .send({ accept: true });
      expect(res.status).toBe(404);
    }
  });

  it('declining is recorded, not silently ignored', async () => {
    const v = await vendor('bo-decline');
    const w = await worker('bo-decline');
    const invited = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/crew`)
      .set(...bearer(v.token))
      .send({ userId: w.userId });

    const declined = await request(app)
      .post(`/api/v1/crew/${invited.body.data.id}/respond`)
      .set(...bearer(w.token))
      .send({ accept: false });
    expect(declined.body.data.status).toBe('declined');
    expect(await backofficeService.crewForOffer(v.businessId)).toEqual([]);
  });

  it('either side can end the arrangement', async () => {
    // A list only one party can leave is not a mutual arrangement.
    const v = await vendor('bo-leave');
    const w = await worker('bo-leave');
    const invited = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/crew`)
      .set(...bearer(v.token))
      .send({ userId: w.userId });
    await request(app)
      .post(`/api/v1/crew/${invited.body.data.id}/respond`)
      .set(...bearer(w.token))
      .send({ accept: true });

    const left = await request(app)
      .delete(`/api/v1/crew/${invited.body.data.id}`)
      .set(...bearer(w.token));
    expect(left.status).toBe(200);
    expect(await backofficeService.crewForOffer(v.businessId)).toEqual([]);
  });

  it('a stranger can neither end nor read a crew relationship', async () => {
    const v = await vendor('bo-crew-idor');
    const w = await worker('bo-crew-idor');
    const stranger = await worker('bo-crew-idor-x');
    const invited = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/crew`)
      .set(...bearer(v.token))
      .send({ userId: w.userId });

    const res = await request(app)
      .delete(`/api/v1/crew/${invited.body.data.id}`)
      .set(...bearer(stranger.token));
    expect(res.status).toBe(403);

    const mine = await request(app).get('/api/v1/users/me/crews').set(...bearer(stranger.token));
    expect(mine.body.data).toHaveLength(0);
  });

  it('the invitation says "work with", never "work for"', async () => {
    // ADR-002's copy rule at the point it is most likely to be broken.
    const v = await vendor('bo-copy');
    const w = await worker('bo-copy');
    await request(app)
      .post(`/api/v1/businesses/${v.businessId}/crew`)
      .set(...bearer(v.token))
      .send({ userId: w.userId });

    const inbox = await request(app)
      .get('/api/v1/users/me/notifications')
      .set(...bearer(w.token))
      .query({ limit: 10 });
    const invite = (inbox.body.data as { body: string }[]).find((n) => n.body.includes('regularly'));
    expect(invite).toBeDefined();
    expect(invite!.body).toContain('work with you');
    expect(invite!.body).toContain('does not commit you');
  });
});

/**
 * ADR-002's copy prohibition, enforced the same way the `stock_waiver` rule is. These words are
 * claims about a legal relationship, and the platform must not make them on a user's behalf.
 */
describe('the employment copy rule (ADR-002)', () => {
  const FORBIDDEN = /\b(employee|employees|payroll|salary|salaried|wages?)\b/i;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('never calls a crew member an employee, or a rate a wage', () => {
    const dir = resolve(__dirname, '../src/modules/backoffice');
    const offenders: string[] = [];

    for (const file of walk(dir)) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        // Comments may DISCUSS the prohibition — that is how the reasoning survives. What must not
        // appear is the word in a string a user reads, or in an identifier.
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (!isComment && FORBIDDEN.test(line)) {
          offenders.push(`${file.split('backoffice')[1]}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, `ADR-002 forbids employment language:\n  ${offenders.join('\n  ')}`).toEqual(
      [],
    );
  });
});

describe('expenses (7.10 / M-23)', () => {
  it('records an expense and totals it by category', async () => {
    const v = await vendor('bo-exp');
    for (const [category, amountCents] of [
      ['fuel', 4500],
      ['fuel', 3000],
      ['permits', 12000],
    ] as const) {
      const res = await request(app)
        .post(`/api/v1/businesses/${v.businessId}/expenses`)
        .set(...bearer(v.token))
        .send({ category, amountCents, incurredOn: new Date().toISOString() });
      expect(res.status).toBe(201);
    }

    const summary = await request(app)
      .get(`/api/v1/businesses/${v.businessId}/expenses/summary`)
      .set(...bearer(v.token))
      .query({
        from: new Date(Date.now() - 86_400_000).toISOString(),
        to: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(summary.body.data.byCategory.fuel).toBe(7500);
    expect(summary.body.data.byCategory.permits).toBe(12000);
    expect(summary.body.data.totalCents).toBe(19500);
  });

  it('says what the summary is NOT, in the payload', async () => {
    // Revenue here is only what moved through the platform. A platform-computed "profit" would be
    // wrong in the direction that matters and would look authoritative while being so.
    const v = await vendor('bo-exp-disc');
    const summary = await request(app)
      .get(`/api/v1/businesses/${v.businessId}/expenses/summary`)
      .set(...bearer(v.token))
      .query({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() });
    expect(summary.body.data.disclosure).toContain('not a complete picture');
    expect(summary.body.data).not.toHaveProperty('profitCents');
  });

  it('refuses a future-dated expense', async () => {
    const v = await vendor('bo-exp-future');
    const res = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/expenses`)
      .set(...bearer(v.token))
      .send({
        category: 'fuel',
        amountCents: 1000,
        incurredOn: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot read another business's expenses", async () => {
    const v = await vendor('bo-exp-idor');
    const other = await vendor('bo-exp-idor-other');
    const res = await request(app)
      .get(`/api/v1/businesses/${v.businessId}/expenses`)
      .set(...bearer(other.token));
    expect([403, 404]).toContain(res.status);
  });
});

describe('invoices (7.10 / M-25)', () => {
  it('numbers invoices sequentially per business, with no gaps or collisions', async () => {
    // Two invoices sharing a number is precisely the defect a tax authority notices.
    const v = await vendor('bo-inv-seq');
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/api/v1/businesses/${v.businessId}/invoices`)
        .set(...bearer(v.token))
        .send({
          customerName: 'A Customer',
          lineItems: [{ description: 'Catering', quantity: 1, unitPriceCents: 25000 }],
        });
      numbers.push(res.body.data.number);
    }
    expect(numbers).toEqual(['INV-0001', 'INV-0002', 'INV-0003']);
  });

  it('allocates unique numbers under concurrency', async () => {
    const v = await vendor('bo-inv-race');
    const make = () =>
      request(app)
        .post(`/api/v1/businesses/${v.businessId}/invoices`)
        .set(...bearer(v.token))
        .send({
          customerName: 'A Customer',
          lineItems: [{ description: 'Catering', quantity: 1, unitPriceCents: 1000 }],
        });
    const results = await Promise.all([make(), make(), make(), make()]);
    const numbers = results.map((r) => r.body.data.number as string);
    expect(new Set(numbers).size).toBe(4);
  });

  it('totals the line items', async () => {
    const v = await vendor('bo-inv-total');
    const res = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/invoices`)
      .set(...bearer(v.token))
      .send({
        customerName: 'A Customer',
        lineItems: [
          { description: 'Catering', quantity: 3, unitPriceCents: 25000 },
          { description: 'Delivery', quantity: 1, unitPriceCents: 5000 },
        ],
        taxCents: 6500,
      });
    expect(res.body.data.subtotalCents).toBe(80000);
    expect(res.body.data.totalCents).toBe(86500);
  });

  it('walks draft → sent → paid and refuses to go backwards', async () => {
    const v = await vendor('bo-inv-state');
    const created = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/invoices`)
      .set(...bearer(v.token))
      .send({
        customerName: 'A Customer',
        lineItems: [{ description: 'Catering', quantity: 1, unitPriceCents: 25000 }],
      });
    const id = created.body.data.id as string;

    // Cannot mark paid before it was ever sent.
    const early = await request(app)
      .patch(`/api/v1/invoices/${id}`)
      .set(...bearer(v.token))
      .send({ status: 'paid' });
    expect(early.status).toBeGreaterThanOrEqual(400);

    await request(app).patch(`/api/v1/invoices/${id}`).set(...bearer(v.token)).send({ status: 'sent' });
    const paid = await request(app)
      .patch(`/api/v1/invoices/${id}`)
      .set(...bearer(v.token))
      .send({ status: 'paid' });
    expect(paid.body.data.status).toBe('paid');

    const reopen = await request(app)
      .patch(`/api/v1/invoices/${id}`)
      .set(...bearer(v.token))
      .send({ status: 'void' });
    expect(reopen.status).toBeGreaterThanOrEqual(400);
  });

  it('logs every state change immutably', async () => {
    // "It says paid now" is a much weaker answer than "it was marked paid on this date by this
    // person".
    const v = await vendor('bo-inv-log');
    const created = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/invoices`)
      .set(...bearer(v.token))
      .send({
        customerName: 'A Customer',
        lineItems: [{ description: 'Catering', quantity: 1, unitPriceCents: 1000 }],
      });
    const id = created.body.data.id as string;
    await request(app).patch(`/api/v1/invoices/${id}`).set(...bearer(v.token)).send({ status: 'sent' });

    const events = await InvoiceEventModel.find({ invoice_id: id }).sort({ created_at: 1 }).lean();
    expect(events.map((e) => e.to_status)).toEqual(['draft', 'sent']);
    expect(events[1]!.actor_id).toBe(v.userId);
  });

  it('says plainly that the platform did not process the payment', async () => {
    const v = await vendor('bo-inv-disc');
    const created = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/invoices`)
      .set(...bearer(v.token))
      .send({
        customerName: 'A Customer',
        lineItems: [{ description: 'Catering', quantity: 1, unitPriceCents: 1000 }],
      });
    expect(created.body.data.disclosure).toContain('did not process this payment');
  });
});
