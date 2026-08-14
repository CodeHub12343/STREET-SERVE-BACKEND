import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A-2 — forbid unreachable enum values.
 *
 * The audit's F-3 finding was that `RtoAgreement.status` declared nine lifecycle states and only
 * four had a writer: `arrangement`, `paused`, `return_pending`, `cancelled`, and `disputed` could
 * never be reached. That was found by hand, by grepping for writers. This is that grep, run as a
 * test.
 *
 * Why it matters more than tidiness: **the schema is the primary documentation of a domain.** A
 * status enum that promises a lifecycle the service does not implement misleads every future reader,
 * produces permanently dead branches in every consumer that switches on it (dashboard filters,
 * analytics roll-ups, status badges), and — as F-3 showed — can hide the absence of an entire
 * specification requirement behind something that looks implemented.
 *
 * ## What counts as reachable
 *
 * The literal appears in the OWNING MODULE's source outside the enum declaration itself — a service
 * assignment, a query filter, a zod request schema, a guard. Scoping to the owning module is
 * deliberate: searching the whole tree would let a common word like `'pending'` (46 occurrences
 * across unrelated modules) vouch for a dead value here.
 *
 * Values legitimately written from OUTSIDE their module go in `CROSS_MODULE_WRITERS`, which names
 * the writing file — and the test verifies that file really does write it, so the escape hatch
 * cannot rot into a blanket exemption.
 *
 * ## This is a ratchet, not a proof
 *
 * `KNOWN_UNWRITTEN` is the baseline as of Phase 4. The test fails if that list GROWS (a new dead
 * value) and equally if an entry becomes stale (implemented but still listed) — so the baseline can
 * only shrink, and it cannot silently drift out of date.
 */

const SRC = resolve(__dirname, '../src');

/**
 * Values written by a module other than the one that declares them, with the file that writes them.
 * Verified, not asserted: if the named file stops writing the value, this test fails.
 */
const CROSS_MODULE_WRITERS: Record<string, string> = {
  // A city's launch state is platform-level policy, not the catalog module's business.
  'City.status.live': 'src/modules/platform/platform.service.ts',
  // The outbound channels are chosen by the messaging integration, which is where a delivery
  // outcome is constructed — the notices module only records what it is handed.
  'NoticeDelivery.channel.email': 'src/integrations/messaging/index.ts',
  'NoticeDelivery.channel.sms': 'src/integrations/messaging/index.ts',
};

/**
 * The declared-but-unwritten baseline as of Phase 4, each with what it would take to make it real.
 * **Every entry is a real gap** — a schema promising a capability the service does not have. They
 * are recorded rather than deleted because narrowing the enum would erase the record of the
 * intended behaviour, which is exactly the mistake F-3 warned against.
 *
 * Adding to this list is a decision that needs a justification. Removing from it is always welcome.
 */
const KNOWN_UNWRITTEN: Record<string, string> = {
  'InventoryCheckout.status.disputed':
    'No consignment dispute flow. Disputes are handled out of band today.',
  'SellerDebt.status.written_off':
    'No write-off path — an uncollectable debt stays open forever. Needs an admin action with an audit trail.',
  'SellerDebt.status.disputed': 'No debt dispute flow; the seller has no way to contest a balance.',
  'PingBudgetTopup.status.failed':
    'A failed ping-budget top-up is not recorded as failed — it stays pending. Needs the webhook failure branch.',
  'NotifyMe.status.expired':
    'Notify-me requests never expire; a request from a year ago still fires. Needs an expiry sweep.',
  'Queue.status.closed':
    'A queue can be opened and never closed. The read path already guards on it (QUEUE_CLOSED), so only the writer is missing.',
  'Refund.absorbed_by.seller':
    'The whole absorbed_by field is written only at its default. Refund cost attribution is not implemented (audit D-7).',
  'Refund.status.failed':
    'A failed Stripe refund leaves the row pending, so the customer appears refunded when they are not. The highest-value entry on this list.',
  'ShelterPartner.status.suspended': 'No partner suspension action.',
  'ShelterEnrollment.status.revoked': 'No enrollment revocation action.',
  'Subscription.status.past_due':
    'No dunning: a failed subscription renewal does not mark the subscription past due.',
  'Business.status.suspended': 'No vendor suspension action.',

  // Found by widening the scan beyond `*.model.ts` (Phase 7). Both are worse than they look: the
  // admin console renders a dismiss control, so the UI implies a resolution the backend never
  // writes — a flag can be raised and can never be closed.
  'FraudFlag.status.reviewed':
    'No fraud-flag resolution path. A raised flag stays open forever, and the admin UI offers a control that writes nothing.',
  'FraudFlag.status.dismissed':
    'Same: dismissal is offered in the console and unimplemented server-side.',
  'FraudFlag.type.lost':
    'No detector raises a `lost` flag. (`lost` IS written as a consignment condition_assessment, which is a different field on a different model — a near-miss worth naming so the next reader does not re-check it.)',
};

interface EnumDecl {
  file: string;
  moduleDir: string;
  model: string;
  field: string;
  values: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripEnumDeclarations(source: string): string {
  return source.replace(/enum\s*:\s*\[[^\]]*\]/gs, 'enum: []');
}

/**
 * Pull `field: { ... enum: ['a', 'b'] ... }` declarations out of a Mongoose model file, and attach
 * the nearest enclosing schema name so a key reads `Refund.status.failed` rather than `status.failed`
 * — three different models declare a `status.failed`.
 *
 * Textual rather than reflective on purpose: reading the model registry would require booting the
 * app and would miss enums on subdocument schemas, which is exactly where `condition_return` (F-4)
 * lived.
 */
function parseEnums(file: string): EnumDecl[] {
  const source = readFileSync(file, 'utf8');
  const moduleDir = resolve(file, '..');
  const decls: EnumDecl[] = [];
  const pattern = /(\w+)\s*:\s*\{[^{}]*?enum\s*:\s*\[([^\]]*)\]/gs;

  for (const match of source.matchAll(pattern)) {
    const field = match[1] ?? '';
    const values = [...(match[2] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    if (values.length === 0) continue;

    // Walk backwards to the `const XSchema = new Schema(` that encloses this field.
    const before = source.slice(0, match.index ?? 0);
    const schemaNames = [...before.matchAll(/const\s+(\w+?)Schema\s*=\s*new Schema/g)];
    const model = schemaNames.at(-1)?.[1] ?? 'Unknown';
    decls.push({ file, moduleDir, model, field, values });
  }
  return decls;
}

describe('A-2 · every declared enum value is reachable', () => {
  /**
   * Any file that declares a Mongoose schema — not only `*.model.ts`.
   *
   * Phase 7 exposed the blind spot: `notices.service.ts` declared six notice types and wrote three
   * of them, and the gate said nothing because the schema was not in a file called `.model.ts`.
   * Several modules declare schemas beside their service (`waiver.service.ts`, `weatherCache.ts`,
   * `corridors.service.ts`, `loyalty.service.ts`), so a filename-based filter was never the right
   * test — "does it declare a schema" is.
   */
  const modelFiles = walk(SRC).filter((f) =>
    /new Schema\s*\(/.test(readFileSync(f, 'utf8')),
  );

  it('finds model files to check (the scan itself must not silently pass)', () => {
    // A scan that finds nothing passes vacuously. This is the guard against that.
    expect(modelFiles.length).toBeGreaterThan(20);
  });

  it('has no NEW declared-but-unwritten enum values', () => {
    const sourceByModule = new Map<string, string>();
    const dead: string[] = [];
    const seen = new Set<string>();

    for (const file of modelFiles) {
      for (const decl of parseEnums(file)) {
        if (!sourceByModule.has(decl.moduleDir)) {
          sourceByModule.set(
            decl.moduleDir,
            walk(decl.moduleDir)
              .map((f) => stripEnumDeclarations(readFileSync(f, 'utf8')))
              .join('\n'),
          );
        }
        const haystack = sourceByModule.get(decl.moduleDir) ?? '';

        for (const value of decl.values) {
          const key = `${decl.model}.${decl.field}.${value}`;
          const literal = new RegExp(
            `['"\`]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`,
          );
          if (literal.test(haystack)) continue;
          if (CROSS_MODULE_WRITERS[key]) continue;
          seen.add(key);
          if (KNOWN_UNWRITTEN[key]) continue;
          dead.push(`${key}  (declared in ${file.replace(SRC, 'src')})`);
        }
      }
    }

    // Reported as a list rather than one-at-a-time so a schema change shows every value it orphaned.
    expect(
      dead,
      `Enum values with no writer. Either implement the transition, or — if the value is genuinely ` +
        `not built yet — add it to KNOWN_UNWRITTEN with what it would take:\n  ${dead.join('\n  ')}`,
    ).toEqual([]);

    // The other direction: the baseline must not rot. An entry that has since been implemented (or
    // whose field was renamed away) has to come off the list, or the list stops describing reality.
    const stale = Object.keys(KNOWN_UNWRITTEN).filter((key) => !seen.has(key));
    expect(
      stale,
      `KNOWN_UNWRITTEN entries that are no longer unwritten — delete them:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('cross-module writers actually write the value they claim to', () => {
    for (const [key, writerFile] of Object.entries(CROSS_MODULE_WRITERS)) {
      const value = key.split('.').at(-1) ?? '';
      const field = key.split('.').at(-2) ?? '';
      const source = readFileSync(resolve(SRC, '..', writerFile), 'utf8');
      expect(
        new RegExp(`${field}\\s*:\\s*['"\`]${value}['"\`]`).test(source),
        `${writerFile} is listed as the writer of ${key} but does not write it`,
      ).toBe(true);
    }
  });

  it('would have caught F-3 — the check is not vacuous', () => {
    // The regression guard on the guard: without this, a broken parser would report "no dead values"
    // forever and the gate would be decorative.
    const decls = parseEnums(resolve(SRC, 'modules/rto/rto.model.ts'));
    const statusDecl = decls.find(
      (d) => d.field === 'status' && d.values.includes('return_pending'),
    );
    expect(
      statusDecl,
      'expected rto.model.ts to declare a status enum including return_pending',
    ).toBeDefined();

    const haystack = walk(resolve(SRC, 'modules/rto'))
      .map((f) => stripEnumDeclarations(readFileSync(f, 'utf8')))
      .join('\n');

    // A value that was never in the enum must not be found — proving the search can say "no".
    expect(/['"`]never_a_real_rto_status['"`]/.test(haystack)).toBe(false);
    // And the five values F-3 called dead must now be found — proving Phase 3 made them writable.
    for (const value of ['arrangement', 'paused', 'return_pending', 'cancelled', 'disputed']) {
      expect(
        new RegExp(`['"\`]${value}['"\`]`).test(haystack),
        `${value} should now have a writer (F-3)`,
      ).toBe(true);
    }
  });
});
