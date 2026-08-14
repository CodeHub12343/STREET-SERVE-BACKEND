import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Who may look at the books, and who may rewrite them.
 *
 * `finance:read_reconciliation` used to mean both, and was granted to `ops_finance` alone. The
 * admin console shipped a Reconciliation page that every admin could open and none could load — it
 * returned 403 and the screen rendered that as "try again in a moment", so the only visible symptom
 * was a page that appeared to be permanently, transiently broken.
 *
 * The separation of duties worth keeping is about WRITES: the party who can alter a balance must not
 * be the only party who can inspect it. So reading is open to admin, and repair — which rewrites
 * cached balances from entries — stays finance-only. That split is what these tests hold in place.
 */
const app = createApp();

const reconcile = (token: string, query: Record<string, string> = {}) =>
  request(app)
    .get('/api/v1/finance/reconciliation')
    .query(query)
    .set(...bearer(token));

async function tokenFor(prefix: string, roles: ('admin' | 'ops_finance' | 'customer')[]) {
  await seedUser({ authProviderId: `${prefix}|u`, roles });
  return mintToken(`${prefix}|u`);
}

describe('reconciliation access', () => {
  it('lets an admin read the report', async () => {
    const token = await tokenFor('recon-admin', ['admin']);
    const res = await reconcile(token);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      accountsChecked: expect.any(Number),
      healthy: expect.any(Boolean),
    });
  });

  it('lets finance ops read the report', async () => {
    const token = await tokenFor('recon-fin', ['ops_finance']);
    expect((await reconcile(token)).status).toBe(200);
  });

  it('refuses everyone else', async () => {
    const token = await tokenFor('recon-cust', ['customer']);
    expect((await reconcile(token)).status).toBe(403);
  });

  it('will not let an admin repair balances by adding ?repair=true', async () => {
    // The whole point of the split: read access must not smuggle in write access.
    const token = await tokenFor('recon-admin-repair', ['admin']);
    const res = await reconcile(token, { repair: 'true' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/finance ops/i);
  });

  it('lets finance ops repair balances', async () => {
    const token = await tokenFor('recon-fin-repair', ['ops_finance']);
    const res = await reconcile(token, { repair: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.data.repaired).toBeGreaterThanOrEqual(0);
  });

  it('treats ?repair=false as OFF, not as "any value means yes"', async () => {
    /**
     * `z.coerce.boolean()` is `Boolean(string)`, so it turned every non-empty value — including the
     * string "false" — into true. On a flag that rewrites ledger balances, asking not to repair and
     * being repaired anyway is the worst possible reading of the parameter.
     */
    const token = await tokenFor('recon-admin-false', ['admin']);
    const res = await reconcile(token, { repair: 'false' });

    // An admin may read but never repair, so "false" reaching the repair gate would 403 here.
    expect(res.status).toBe(200);
  });
});
