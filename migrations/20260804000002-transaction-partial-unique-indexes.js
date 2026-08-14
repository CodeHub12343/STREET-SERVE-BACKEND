/* eslint-env node */
/**
 * Replace two SPARSE unique indexes on `transactions` with PARTIAL ones.
 *
 * ## The defect
 *
 * `payment_intent_ref` and `idempotency_key` both default to `null`, and a sparse unique index
 * **still indexes an explicit null**. Two transactions that simply had not been given a payment
 * intent yet therefore collided on a duplicate key.
 *
 * Sequentially this never fired: the first row's ref was written before the second was inserted, so
 * two nulls were never in flight at once. It surfaced when concurrent orders at the same business
 * became ordinary — which Pay It Forward makes routine, since one customer's card charge and
 * another's community-funded order now happen side by side.
 *
 * `UserSchema` already carries this exact correction for email/phone, with a comment saying why.
 * This brings `transactions` in line.
 *
 * ## Safety
 *
 * Index-only; no documents are touched. The new index is created BEFORE the old one is dropped, so
 * there is no window in which uniqueness is unenforced. Dropping a non-existent index is tolerated
 * so the migration is safe to re-run against an environment that never had the sparse version.
 */
const SPECS = [
  { field: 'payment_intent_ref', oldName: 'payment_intent_ref_1' },
  { field: 'idempotency_key', oldName: 'idempotency_key_1' },
];

async function dropIfExists(collection, name) {
  try {
    await collection.dropIndex(name);
  } catch (err) {
    // 27 = IndexNotFound. Anything else is a real problem and should surface.
    if (err.code !== 27 && !/index not found/i.test(err.message ?? '')) throw err;
  }
}

module.exports = {
  async up(db) {
    const transactions = db.collection('transactions');
    const existing = await transactions.indexes();

    for (const { field, oldName } of SPECS) {
      /**
       * The correct partial index may already exist under a different name.
       *
       * `20260705000003-phase1-indexes.js` creates exactly this key spec, unique and partial, as
       * `ux_txn_pi` / `ux_txn_idem`. This migration was written against a database where Mongoose
       * `autoIndex` had built a SPARSE `payment_intent_ref_1` instead — so it assumed that name and
       * that shape. MongoDB refuses a second index on the same key under a new name, so on a
       * properly migration-built database it aborted with:
       *
       *     Index already exists with a different name: ux_txn_pi
       *
       * Matching on the key spec rather than on a name makes this correct in both histories, and
       * idempotent on re-run.
       */
      const onField = existing.filter((i) => {
        const keys = Object.keys(i.key ?? {});
        return keys.length === 1 && keys[0] === field;
      });
      const alreadyCorrect = onField.find((i) => i.unique && i.partialFilterExpression);

      if (!alreadyCorrect) {
        await transactions.createIndex(
          { [field]: 1 },
          {
            name: `${field}_1_partial`,
            unique: true,
            partialFilterExpression: { [field]: { $type: 'string' } },
          },
        );
      }
      // Runs either way: the legacy sparse index is what this migration exists to remove.
      await dropIfExists(transactions, oldName);
    }
  },

  async down(db) {
    const transactions = db.collection('transactions');
    for (const { field, oldName } of SPECS) {
      await transactions.createIndex({ [field]: 1 }, { name: oldName, unique: true, sparse: true });
      await dropIfExists(transactions, `${field}_1_partial`);
    }
  },
};
