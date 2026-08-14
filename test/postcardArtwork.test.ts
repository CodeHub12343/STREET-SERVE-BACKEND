import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { POSTCARD_TEMPLATES_URL } from '../src/config/constants';
import { createFakePrintVendor, resetPrintVendor, setPrintVendor } from '../src/integrations/print';
import { setStorageGateway } from '../src/integrations/storage';
import { PostcardAssetModel } from '../src/modules/postcards/postcards.model';
import { resetContentScreener } from '../src/modules/postcards/screening';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { FakeStorageGateway } from './fakes';
import { PostcardPilotParticipantModel } from '../src/modules/postcards/pilot.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Phase 4 — Artwork: upload, pre-press and moderation.
 *
 * The through-line is ordering: **every gate sits before money moves.** A file that will print
 * badly is refused at upload; a file whose content is questionable is held before it can reach a
 * press. Both are cheap there and expensive anywhere later — after payment it is a refund, and
 * after submission it is paper in mailboxes that cannot be recalled.
 */

const app = createApp();
let storage: FakeStorageGateway;

beforeAll(() => setPrintVendor(createFakePrintVendor()));
beforeEach(() => {
  storage = new FakeStorageGateway();
  setStorageGateway(storage);
});
afterEach(() => {
  resetPrintVendor();
  setPrintVendor(createFakePrintVendor());
  resetContentScreener();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────

function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  // Padded so the file is not flagged as suspiciously small by the structural screener.
  return Buffer.concat([sig, ihdr, Buffer.alloc(80 * 1024)]);
}

/** 6" x 8.5" + bleed at 300 DPI — the size the spec endpoint asks for. */
const GOOD_ARTWORK = (): Buffer => png(1875, 2625);
const BLURRY_ARTWORK = (): Buffer => png(600, 840);

async function vendorAccount(prefix: string) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'food',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Tacos`, categoryId: String(cat._id) });

  /**
   * Phase 8: postcard ordering is behind an ops-managed pilot allowlist (default-deny). Tests enrol
   * their business explicitly rather than the gate being bypassed under test — a gate that is off in
   * the only place it is exercised is not a gate.
   */
  await PostcardPilotParticipantModel.create({
    business_id: biz.body.data.id as string,
    added_by: 'test',
  });

  return { token, businessId: biz.body.data.id as string };
}

async function acceptArtworkTerms(token: string) {
  return request(app)
    .post('/api/v1/agreements/postcard_artwork/accept')
    .set(...bearer(token))
    .send({});
}

/** Requests an upload target, plays the browser's PUT, and returns the asset id. */
async function upload(token: string, businessId: string, bytes: Buffer, contentType = 'image/png') {
  const res = await request(app)
    .post(`/api/v1/postcards/business/${businessId}/artwork`)
    .set(...bearer(token))
    .send({ contentType });
  if (res.status !== 201) return { res, assetId: null as string | null };

  const assetId = res.body.data.assetId as string;
  const asset = await PostcardAssetModel.findById(assetId).lean().exec();
  storage.put(asset!.storage_key, bytes, contentType);
  return { res, assetId };
}

const validate = (token: string, assetId: string, sku = '68') =>
  request(app)
    .post(`/api/v1/postcards/artwork/${assetId}/validate`)
    .set(...bearer(token))
    .send({ sku });

// ─── Artwork spec (4.4) ─────────────────────────────────────────────────────────────────────

describe('artwork spec — the numbers a designer needs', () => {
  it('is public, and states trim, bleed and the exact pixels required', async () => {
    // Public on purpose: the person making the artwork often is not the person with the login.
    const res = await request(app).get('/api/v1/postcards/products/68/artwork-spec');
    expect(res.status).toBe(200);

    const spec = res.body.data;
    expect(spec.trimWidthIn).toBe(6);
    expect(spec.fullWidthIn).toBeCloseTo(6.25, 2);
    expect(spec.recommendedWidthPx).toBe(1875);
    expect(spec.recommendedHeightPx).toBe(2625);
    // One DESIGNED side; the vendor composes the address side.
    expect(spec.designedSides).toBe(1);
    // We point at the vendor's own press-ready templates rather than inventing our own.
    expect(spec.templatesUrl).toBe(POSTCARD_TEMPLATES_URL);
  });

  it('404s a size that does not exist', async () => {
    const res = await request(app).get('/api/v1/postcards/products/nope/artwork-spec');
    expect(res.status).toBe(400);
  });
});

// ─── Upload (PC-1) ──────────────────────────────────────────────────────────────────────────

describe('artwork upload', () => {
  it('requires the acceptable-use agreement BEFORE the file arrives', async () => {
    /**
     * Gated at upload rather than at submission: the platform is about to accept a file it will
     * print and mail, so the warranties about ownership and content belong before it lands in our
     * bucket, not after.
     */
    const v = await vendorAccount('aw-agree');
    const res = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/artwork`)
      .set(...bearer(v.token))
      .send({ contentType: 'image/png' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AGREEMENT_REQUIRED');
  });

  it('never lets the client choose a storage path', async () => {
    // The key is generated server-side and recorded against the asset; the response carries an id
    // and a URL, and no key at all. "No user-controlled paths", enforced by shape.
    const v = await vendorAccount('aw-path');
    await acceptArtworkTerms(v.token);

    const res = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/artwork`)
      .set(...bearer(v.token))
      .send({ contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.data.assetId).toBeTruthy();
    expect(res.body.data.uploadUrl).toContain('https://');
    expect(res.body.data).not.toHaveProperty('key');
    expect(res.body.data).not.toHaveProperty('storageKey');
  });

  it('refuses formats the print vendor will not accept', async () => {
    // webp is fine for a product photo and useless here — better a 400 now than a rejection after
    // the buyer has paid.
    const v = await vendorAccount('aw-type');
    await acceptArtworkTerms(v.token);

    for (const contentType of ['image/webp', 'image/heic', 'image/svg+xml', 'text/html']) {
      const res = await request(app)
        .post(`/api/v1/postcards/business/${v.businessId}/artwork`)
        .set(...bearer(v.token))
        .send({ contentType });
      expect(res.status).toBe(400);
    }
  });

  it('will not let one business upload against another', async () => {
    const a = await vendorAccount('aw-own-a');
    const b = await vendorAccount('aw-own-b');
    await acceptArtworkTerms(b.token);

    const res = await request(app)
      .post(`/api/v1/postcards/business/${a.businessId}/artwork`)
      .set(...bearer(b.token))
      .send({ contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});

// ─── Pre-press (NF-2) ───────────────────────────────────────────────────────────────────────

describe('pre-press validation', () => {
  it('passes good artwork and records what it measured', async () => {
    const v = await vendorAccount('aw-pass');
    await acceptArtworkTerms(v.token);
    const { assetId } = await upload(v.token, v.businessId, GOOD_ARTWORK());

    const res = await validate(v.token, assetId!);
    expect(res.status).toBe(200);
    expect(res.body.data.prepressStatus).toBe('passed');
    expect(res.body.data.effectiveDpi).toBe(300);
    expect(res.body.data.format).toBe('png');
    expect(res.body.data.errors).toHaveLength(0);
  });

  it('fails blurry artwork with an explanation a non-designer can act on', async () => {
    const v = await vendorAccount('aw-blurry');
    await acceptArtworkTerms(v.token);
    const { assetId } = await upload(v.token, v.businessId, BLURRY_ARTWORK());

    const res = await validate(v.token, assetId!);
    expect(res.body.data.prepressStatus).toBe('failed');
    expect(res.body.data.errors[0].message).toMatch(/blurry/i);
  });

  it('says the upload has not arrived rather than erroring', async () => {
    // The common case: the browser never finished its PUT. That is a message, not a 500.
    const v = await vendorAccount('aw-missing');
    await acceptArtworkTerms(v.token);
    const created = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/artwork`)
      .set(...bearer(v.token))
      .send({ contentType: 'image/png' });

    const res = await validate(v.token, created.body.data.assetId);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/have not received/i);
  });

  it('rejects a file whose bytes are not what the content type claimed', async () => {
    /**
     * The declared type said PNG; the bytes are HTML. Trusting the header here is the classic
     * stored-XSS upload, so format comes from the magic bytes and nothing else.
     */
    const v = await vendorAccount('aw-lie');
    await acceptArtworkTerms(v.token);
    const html = Buffer.from('<html><script>alert(1)</script></html>'.repeat(2000), 'utf8');
    const { assetId } = await upload(v.token, v.businessId, html);

    const res = await validate(v.token, assetId!);
    expect(res.body.data.prepressStatus).toBe('failed');
    expect(res.body.data.errors[0].code).toBe('unsupported_format');
  });

  it('re-validating against a different size re-decides the verdict', async () => {
    // The same file can be fine on one card and unusable on another, so the verdict is bound to
    // the size it was checked against.
    const v = await vendorAccount('aw-resize');
    await acceptArtworkTerms(v.token);
    /**
     * 1875 x 2100 sits either side of the floor on purpose: 240 effective DPI on a 6 x 8.5 (fine),
     * but only 186 stretched over a 6 x 11 (below the 200 floor). One file, two honest verdicts.
     */
    const { assetId } = await upload(v.token, v.businessId, png(1875, 2100));

    const smaller = await validate(v.token, assetId!, '68');
    expect(smaller.body.data.prepressStatus).toBe('passed');
    expect(smaller.body.data.effectiveDpi).toBe(240);

    const bigger = await validate(v.token, assetId!, '611');
    expect(bigger.body.data.prepressStatus).toBe('failed');
    expect(bigger.body.data.validatedSku).toBe('611');
    expect(bigger.body.data.errors[0].code).toBe('too_low_resolution');
  });

  it('does not leak reviewer-only screening flags to the buyer', async () => {
    // Showing someone which heuristics fired invites gaming them.
    const v = await vendorAccount('aw-flags');
    await acceptArtworkTerms(v.token);
    const { assetId } = await upload(v.token, v.businessId, GOOD_ARTWORK());
    const res = await validate(v.token, assetId!);
    expect(res.body.data).not.toHaveProperty('screeningFlags');
  });
});

// ─── Attaching to an order ──────────────────────────────────────────────────────────────────

describe('attaching artwork to an order', () => {
  async function orderFor(prefix: string) {
    const v = await vendorAccount(prefix);
    await acceptArtworkTerms(v.token);
    const order = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/orders`)
      .set(...bearer(v.token))
      .send({ sku: '68', mailClass: 'standard' });
    return { ...v, orderId: order.body.data.id as string };
  }

  const attach = (token: string, orderId: string, assetId: string) =>
    request(app)
      .patch(`/api/v1/postcards/orders/${orderId}`)
      .set(...bearer(token))
      .send({ assetId });

  it('accepts artwork that passed for this size', async () => {
    const o = await orderFor('aw-attach');
    const { assetId } = await upload(o.token, o.businessId, GOOD_ARTWORK());
    await validate(o.token, assetId!, '68');

    const res = await attach(o.token, o.orderId, assetId!);
    expect(res.status).toBe(200);
    expect(res.body.data.assetId).toBe(assetId);
  });

  it('refuses artwork that has not passed pre-press', async () => {
    // The gate that keeps a bad file on the cheap side of payment.
    const o = await orderFor('aw-attach-bad');
    const { assetId } = await upload(o.token, o.businessId, BLURRY_ARTWORK());
    await validate(o.token, assetId!, '68');

    const res = await attach(o.token, o.orderId, assetId!);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/print checks/i);
  });

  it('refuses artwork validated for a different size', async () => {
    const o = await orderFor('aw-attach-size');
    const { assetId } = await upload(o.token, o.businessId, png(1875, 3400));
    await validate(o.token, assetId!, '611');

    const res = await attach(o.token, o.orderId, assetId!);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/different postcard size/i);
  });

  it("refuses another business's artwork", async () => {
    const mine = await orderFor('aw-attach-mine');
    const theirs = await vendorAccount('aw-attach-theirs');
    await acceptArtworkTerms(theirs.token);
    const { assetId } = await upload(theirs.token, theirs.businessId, GOOD_ARTWORK());
    await validate(theirs.token, assetId!, '68');

    const res = await attach(mine.token, mine.orderId, assetId!);
    expect(res.status).toBe(403);
  });
});

// ─── Moderation (F-7) ───────────────────────────────────────────────────────────────────────

describe('moderation', () => {
  async function staff(prefix: string) {
    await seedUser({ authProviderId: `${prefix}|admin`, roles: ['admin'] });
    return mintToken(`${prefix}|admin`);
  }

  async function pendingAsset(prefix: string) {
    const v = await vendorAccount(prefix);
    await acceptArtworkTerms(v.token);
    const { assetId } = await upload(v.token, v.businessId, GOOD_ARTWORK());
    await validate(v.token, assetId!, '68');
    return { ...v, assetId: assetId! };
  }

  it('keeps artwork pending until a human decides — nothing auto-approves', async () => {
    /**
     * The automated pass can raise suspicion but never clear it, so approval always has a person
     * behind it. A status implying otherwise would be a defensible-looking review nobody performed.
     */
    const a = await pendingAsset('mod-pending');
    const res = await request(app)
      .get(`/api/v1/postcards/artwork/${a.assetId}`)
      .set(...bearer(a.token));
    expect(res.body.data.moderationStatus).toBe('pending');
  });

  it('is staff-only', async () => {
    const a = await pendingAsset('mod-authz');
    // The person who made the artwork must not be the person who clears it.
    const queue = await request(app)
      .get('/api/v1/postcards/moderation/queue')
      .set(...bearer(a.token));
    expect(queue.status).toBe(403);

    const decide = await request(app)
      .post(`/api/v1/postcards/moderation/${a.assetId}`)
      .set(...bearer(a.token))
      .send({ decision: 'approved' });
    expect(decide.status).toBe(403);
  });

  it('queues only artwork that passed pre-press', async () => {
    // A file that will not print does not need a content decision — reviewers are the scarce part.
    const good = await pendingAsset('mod-queue-good');
    const bad = await vendorAccount('mod-queue-bad');
    await acceptArtworkTerms(bad.token);
    const { assetId: badId } = await upload(bad.token, bad.businessId, BLURRY_ARTWORK());
    await validate(bad.token, badId!, '68');

    const token = await staff('mod-queue');
    const res = await request(app)
      .get('/api/v1/postcards/moderation/queue')
      .set(...bearer(token));

    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(good.assetId);
    expect(ids).not.toContain(badId);
    // Reviewers DO see the flags the buyer does not.
    expect(res.body.data[0]).toHaveProperty('screeningFlags');
  });

  it('records an approval', async () => {
    const a = await pendingAsset('mod-approve');
    const token = await staff('mod-approve');
    const res = await request(app)
      .post(`/api/v1/postcards/moderation/${a.assetId}`)
      .set(...bearer(token))
      .send({ decision: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.data.moderationStatus).toBe('approved');
  });

  it('requires a reason on rejection, and shows it to the business', async () => {
    // A rejection the buyer cannot act on is a dead end; the reason is the product.
    const a = await pendingAsset('mod-reject');
    const token = await staff('mod-reject');

    const noReason = await request(app)
      .post(`/api/v1/postcards/moderation/${a.assetId}`)
      .set(...bearer(token))
      .send({ decision: 'rejected' });
    expect(noReason.status).toBe(400);

    const withReason = await request(app)
      .post(`/api/v1/postcards/moderation/${a.assetId}`)
      .set(...bearer(token))
      .send({ decision: 'rejected', reason: 'Uses a trademark you do not own.' });
    expect(withReason.status).toBe(200);

    const seen = await request(app)
      .get(`/api/v1/postcards/artwork/${a.assetId}`)
      .set(...bearer(a.token));
    expect(seen.body.data.moderationReason).toMatch(/trademark/i);
  });

  it('will not let two reviewers both decide the same item', async () => {
    // Guarded on `pending`, so a decision cannot be silently overwritten by a slower click.
    const a = await pendingAsset('mod-race');
    const token = await staff('mod-race');
    const url = `/api/v1/postcards/moderation/${a.assetId}`;

    const first = await request(app).post(url).set(...bearer(token)).send({ decision: 'approved' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(url)
      .set(...bearer(token))
      .send({ decision: 'rejected', reason: 'changed my mind' });
    expect(second.status).toBe(409);
  });

  it('sends artwork back to pending when it is re-validated', async () => {
    /**
     * An approval attaches to what the reviewer actually saw. Re-pointing the file at another
     * product is a different context, and carrying the old decision forward would let a human's
     * judgement apply to something they never looked at.
     */
    const a = await pendingAsset('mod-revalidate');
    const token = await staff('mod-revalidate');
    await request(app)
      .post(`/api/v1/postcards/moderation/${a.assetId}`)
      .set(...bearer(token))
      .send({ decision: 'approved' });

    await validate(a.token, a.assetId, '68');

    const after = await request(app)
      .get(`/api/v1/postcards/artwork/${a.assetId}`)
      .set(...bearer(a.token));
    expect(after.body.data.moderationStatus).toBe('pending');
  });
});
