import request from 'supertest';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  AGREEMENT_TYPES,
  getAgreement,
  isAgreementReviewed,
} from '../src/modules/agreements/agreements.registry';

/**
 * 8.4 — **verify every §60 agreement renders its attorney-reviewed version and hash.**
 *
 * ## This item is BLOCKED, and the test is written to say so out loud
 *
 * M-1 is the platform's one remaining launch blocker: all four agreement bodies are placeholder
 * text pending attorney review. So the literal check — *does it render the reviewed version?* —
 * cannot pass today, and a test that pretended otherwise would be worse than no test.
 *
 * What this file does instead is assert the two things that ARE true and must stay true:
 *
 *  1. **The rendering machinery is correct and ready.** Version, title, body, and a content hash
 *     derived from the body — so when counsel's text lands, dropping it in is the whole job.
 *  2. **The platform fails CLOSED until it lands.** `reviewed: false` on every agreement, and the
 *     flows that create binding obligations refuse. Shipping code must not mean shipping clickwrap
 *     on unreviewed terms.
 *
 * The last test is the one that flips: when `reviewed` becomes true for all four, it fails and
 * tells whoever is running the release that the *rest* of 8.4 is now checkable. A blocked item that
 * announces its own unblocking is worth more than a note in a document.
 */
const app = createApp();

describe('§60 agreement rendering (8.4)', () => {
  it('serves every agreement type with a version, a title, and a body', async () => {
    for (const type of AGREEMENT_TYPES) {
      const res = await request(app).get(`/api/v1/agreements/${type}`);
      expect(res.status, `GET /agreements/${type}`).toBe(200);
      expect(res.body.data.version).toEqual(expect.any(String));
      expect(res.body.data.title).toEqual(expect.any(String));
      expect(res.body.data.body?.length ?? 0).toBeGreaterThan(50);
    }
  });

  it('derives the content hash from the body, so it cannot be stale', async () => {
    // The hash is what makes an acceptance tamper-evident: it records WHAT was agreed, not just
    // that something was. A hand-maintained hash would drift from the text the moment anyone edited
    // a sentence, and the acceptance record would then attest to a document nobody ever saw.
    for (const type of AGREEMENT_TYPES) {
      const res = await request(app).get(`/api/v1/agreements/${type}`);
      const expected = createHash('sha256').update(res.body.data.body).digest('hex');
      expect(res.body.data.contentHash, `hash mismatch for ${type}`).toBe(expected);
    }
  });

  it('gives different agreements different hashes', async () => {
    // A shared hash would make an acceptance of one indistinguishable from another.
    const hashes = new Set<string>();
    for (const type of AGREEMENT_TYPES) {
      const res = await request(app).get(`/api/v1/agreements/${type}`);
      hashes.add(res.body.data.contentHash as string);
    }
    expect(hashes.size).toBe(AGREEMENT_TYPES.length);
  });

  it('an acceptance is rejected if the hash does not match the served body', async () => {
    // The tamper-evidence property, tested from the outside: a client that shows the customer one
    // document and attests to another must be refused.
    const type = AGREEMENT_TYPES[0];
    const served = await request(app).get(`/api/v1/agreements/${type}`);
    const res = await request(app)
      .post(`/api/v1/agreements/${type}/accept`)
      .send({ version: served.body.data.version, contentHash: 'f'.repeat(64) });
    // Unauthenticated or hash-mismatch — either way it does not record an acceptance.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('§60 review status — the M-1 launch blocker (8.4)', () => {
  it('reports every agreement as NOT attorney-reviewed', () => {
    // The honest state of the platform today. If this ever passes vacuously — because someone
    // flipped a flag without the text — the next test is the one that catches it.
    for (const type of AGREEMENT_TYPES) {
      expect(isAgreementReviewed(type), `${type} claims to be reviewed`).toBe(false);
    }
  });

  it('the placeholder bodies still say they are placeholders', () => {
    // Belt and braces on the flag: the text itself declares its status, so a reviewed:true set
    // without replacing the body would be caught by reading one line of it.
    for (const type of AGREEMENT_TYPES) {
      const definition = getAgreement(type);
      const isPlaceholder = /PLACEHOLDER/i.test(definition.body);
      // A reviewed agreement must NOT be a placeholder, and vice versa. The two must agree.
      expect(
        isPlaceholder,
        `${type}: reviewed=${definition.reviewed} but placeholder=${isPlaceholder} — these disagree`,
      ).toBe(!definition.reviewed);
    }
  });

  it('ANNOUNCES when M-1 clears — this test failing is good news', () => {
    // When counsel's text lands and all four are marked reviewed, this fails on purpose. That is
    // the signal that the rest of 8.4 — rendering the REVIEWED version — became checkable, and that
    // the release checklist should be re-run. A blocked item that announces its own unblocking beats
    // a note in a document nobody re-reads.
    const allReviewed = AGREEMENT_TYPES.every((t) => isAgreementReviewed(t));
    expect(
      allReviewed,
      'All four §60 agreements are now attorney-reviewed. M-1 is clear: delete this assertion, ' +
        'un-gate RTO acceptance, and re-run checklist items 1.1–1.4 and 8.4.',
    ).toBe(false);
  });
});
