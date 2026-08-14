#!/usr/bin/env node
/**
 * 6.1 — dependency CVE gate.
 *
 * ## Why this exists instead of `npm audit --audit-level=high`
 *
 * The plain command was already in CI here, and it is the wrong shape for two reasons:
 *
 * 1. **It audits dev dependencies.** Storybook and webpack advisories are real, and they are
 *    build-time issues in packages that never reach a user. Failing a deploy on a Storybook CVE
 *    trains people to add `--force` or delete the step, which is how a security gate dies.
 * 2. **It is all-or-nothing.** When a transitive advisory has no fix available, the only options are
 *    "ship broken CI" or "remove the check". Neither is a decision anyone would defend out loud.
 *
 * This script audits **production dependencies only** and supports a reviewed-exception list where
 * every entry carries a reason and an **expiry date**. An expired entry fails the build. That is the
 * mechanism that stops an exception list from silently becoming a permanent waiver — the same
 * ratchet the Phase 4 gates use.
 *
 * Dev-dependency advisories are still printed, as information. Visible, not blocking.
 *
 * Run:  node scripts/check-vulnerabilities.mjs
 */
import { execFileSync } from 'node:child_process';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];
const FAIL_AT = 'high';

/**
 * Advisories reviewed and accepted, with the reason and the date the acceptance expires.
 *
 * **An entry here is a decision, not a mute.** It says: someone looked at this advisory, understood
 * how it reaches (or does not reach) this application, and accepted the risk until a date. On that
 * date the build fails and someone looks again.
 */
const REVIEWED = {
  // (empty — production dependencies are currently clean)
  // Shape:
  // 'GHSA-xxxx-xxxx-xxxx': {
  //   package: 'some-lib',
  //   reason: 'Why this does not reach us, or why the fix is not available yet.',
  //   until: '2026-11-01',
  // },
};

function severityAtLeast(severity, threshold) {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

function audit(omitDev) {
  const args = ['audit', '--json'];
  if (omitDev) args.push('--omit=dev');
  try {
    // `npm audit` exits non-zero when it finds anything, so a throw is the normal path.
    return JSON.parse(execFileSync('npm', args, { encoding: 'utf8', shell: true }));
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

/** Flatten npm's advisory tree into { id, package, severity, title, url }. */
function advisoriesFrom(report) {
  const out = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if (!out.has(id)) {
        out.set(id, {
          id,
          package: via.name ?? name,
          severity: via.severity ?? entry.severity,
          title: via.title ?? '(no title)',
          url: via.url,
        });
      }
    }
  }
  return [...out.values()];
}

function main() {
  const today = new Date().toISOString().slice(0, 10);

  const prod = advisoriesFrom(audit(true)).filter((a) => severityAtLeast(a.severity, FAIL_AT));
  const blocking = [];
  const accepted = [];
  const expired = [];

  for (const advisory of prod) {
    const exception = REVIEWED[advisory.id];
    if (!exception) blocking.push(advisory);
    else if (exception.until < today) expired.push({ ...advisory, ...exception });
    else accepted.push({ ...advisory, ...exception });
  }

  // Reviewed entries for advisories that no longer appear — a fixed dependency should not leave a
  // standing exception behind, because the next advisory on that package would inherit the waiver.
  const present = new Set(prod.map((a) => a.id));
  const stale = Object.keys(REVIEWED).filter((id) => !present.has(id));

  // Informational: dev-only advisories. Never blocking — they do not ship.
  const devOnly = advisoriesFrom(audit(false))
    .filter((a) => severityAtLeast(a.severity, FAIL_AT))
    .filter((a) => !prod.some((p) => p.id === a.id));

  if (devOnly.length > 0) {
    console.log(`\nℹ  ${devOnly.length} dev-dependency advisor(ies) at ${FAIL_AT}+ (not shipped, not blocking):`);
    for (const a of devOnly) console.log(`     ${a.severity.padEnd(8)} ${a.package} — ${a.title}`);
  }
  if (accepted.length > 0) {
    console.log(`\n⏳ ${accepted.length} reviewed exception(s) still in force:`);
    for (const a of accepted) console.log(`     ${a.package} (${a.id}) until ${a.until} — ${a.reason}`);
  }

  if (blocking.length === 0 && expired.length === 0 && stale.length === 0) {
    console.log(`\n✔ No unreviewed ${FAIL_AT}+ advisories in production dependencies.\n`);
    return;
  }

  console.error('\n✖ Dependency vulnerability check FAILED\n');
  if (blocking.length > 0) {
    console.error(`  ${blocking.length} unreviewed ${FAIL_AT}+ advisor(ies) in PRODUCTION dependencies.`);
    console.error('  Upgrade, or add to REVIEWED with a reason and an expiry date:\n');
    for (const a of blocking) {
      console.error(`    ${a.severity.padEnd(8)} ${a.package}  ${a.id}`);
      console.error(`             ${a.title}`);
      console.error(`             ${a.url}`);
    }
    console.error('');
  }
  if (expired.length > 0) {
    console.error(`  ${expired.length} reviewed exception(s) have EXPIRED — re-review them:\n`);
    for (const a of expired) console.error(`    ${a.package} (${a.id}) expired ${a.until} — ${a.reason}`);
    console.error('');
  }
  if (stale.length > 0) {
    console.error(`  ${stale.length} REVIEWED entr(ies) no longer match any advisory — delete them,`);
    console.error('  or the next advisory on that package inherits the waiver:\n');
    for (const id of stale) console.error(`    ${id}`);
    console.error('');
  }
  process.exit(1);
}

main();
