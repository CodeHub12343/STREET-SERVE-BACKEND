import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 8.2 — runbook rehearsal, the part a machine can do.
 *
 * ## What a rehearsal actually needs, and what this covers
 *
 * A real rehearsal is a person following the runbook during a drill and finding out where it lies.
 * That cannot be automated and is recorded as still-open in `PRODUCTION_READINESS.md`.
 *
 * What *can* be automated is the failure mode that makes a rehearsal pointless: **a runbook that
 * refers to things which no longer exist.** A metric that was renamed, an endpoint that moved, a
 * script that was deleted — each turns a step into a dead end at the exact moment someone is under
 * pressure and least able to improvise. That is what this file checks, on every commit.
 *
 * It deliberately does NOT check prose, judgement, or completeness. A runbook can be accurate and
 * still be wrong about what to do; only a drill finds that.
 */

const ROOT = resolve(__dirname, '..');
const RUNBOOKS = readFileSync(join(ROOT, 'RUNBOOKS.md'), 'utf8');
const SUPPORT = readFileSync(join(ROOT, 'SUPPORT_RUNBOOKS.md'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SRC = walk(join(ROOT, 'src'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * Every route path the app mounts.
 *
 * Two sources, because routers declare paths relative to their mount point: the literal path in the
 * route file, plus — for the common `router.post('/')` shape — the mount prefix from `app.ts`.
 * Without the second, `POST /disputes` looks missing when it is simply declared as `'/'`.
 */
const ROUTE_PATHS = new Set(
  [...SRC.matchAll(/\w*[Rr]outer\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g)]
    .map((m) => m[1] ?? '')
    .filter(Boolean),
);
for (const m of readFileSync(join(ROOT, 'src/app.ts'), 'utf8').matchAll(
  /api\.use\(\s*['"`](\/[\w-]*)['"`]/g,
)) {
  if (m[1] && m[1] !== '/') ROUTE_PATHS.add(m[1]);
}

describe('runbook rehearsal — the references still resolve (8.2)', () => {
  it('every metric an on-call runbook keys off still exists', () => {
    // A page that says "check `foo_total`" against a metric renamed six months ago sends the
    // responder to an empty graph and makes them doubt the alert rather than the runbook.
    const metrics = [...RUNBOOKS.matchAll(/`([a-z][a-z0-9_]*_(?:total|cents|seconds))[`{]/g)].map(
      (m) => m[1] ?? '',
    );
    expect(metrics.length, 'parsed no metrics — the check would pass vacuously').toBeGreaterThan(3);

    const missing = [...new Set(metrics)].filter((name) => !SRC.includes(name));
    expect(missing, `metrics referenced by RUNBOOKS.md that no longer exist:\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('every script a runbook tells you to run still exists', () => {
    const scripts = [
      ...RUNBOOKS.matchAll(/scripts\/([\w.-]+\.(?:ts|mjs|js))/g),
      ...SUPPORT.matchAll(/scripts\/([\w.-]+\.(?:ts|mjs|js))/g),
    ].map((m) => m[1] ?? '');

    const available = new Set(readdirSync(join(ROOT, 'scripts')));
    const missing = [...new Set(scripts)].filter((s) => !available.has(s));
    expect(
      missing,
      `scripts referenced by a runbook that do not exist:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every API path the support runbook tells you to call is a real route', () => {
    // The support runbooks name specific endpoints. If one moves, support follows a dead link while
    // a seller waits — the least forgivable moment for documentation to be stale.
    const referenced = [...SUPPORT.matchAll(/`?(?:GET|POST|PATCH|DELETE) (\/api\/v1)?(\/[\w:/-]+)/g)]
      .map((m) => m[2] ?? '')
      .filter((p) => p.length > 1);

    expect(referenced.length, 'parsed no endpoints — vacuous').toBeGreaterThan(8);

    const missing = referenced.filter((path) => {
      // Routers mount relative to a prefix, so match on the tail: `/rto/agreements/:id/payoff`
      // is declared as `/agreements/:id/payoff`.
      const segments = path.split('/').filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        const tail = '/' + segments.slice(i).join('/');
        if (ROUTE_PATHS.has(tail)) return false;
      }
      return true;
    });

    expect(
      [...new Set(missing)],
      `endpoints named in SUPPORT_RUNBOOKS.md with no matching route:\n  ${[...new Set(missing)].join('\n  ')}`,
    ).toEqual([]);
  });

  it('the notice-period figures in the support runbook match the code', () => {
    // These are the numbers support quotes to a seller who is losing their stock. A runbook that is
    // a week out of date on a notice period is a runbook that makes the platform look like it
    // changed the rules mid-consignment.
    expect(SRC).toContain('TERMINATION_NOTICE_LOW_DAYS = 3');
    expect(SRC).toContain('TERMINATION_NOTICE_STANDARD_DAYS = 7');
    expect(SRC).toContain('TERMINATION_NOTICE_HIGH_DAYS = 14');
    expect(SUPPORT).toContain('3 days');
    expect(SUPPORT).toContain('7 days');
    expect(SUPPORT).toContain('14 days');

    expect(SRC).toContain('DISPUTE_SLA_DAYS = 5');
    expect(SUPPORT).toContain('5 business days');
  });

  it('the RTO grace periods quoted to customers match the code', () => {
    // Quoted verbatim in the delinquency runbook, because "how long do I have?" is the first
    // question and a wrong answer is a broken promise.
    expect(SUPPORT).toMatch(/daily 1 day, weekly 3, biweekly and twice-monthly 5,\s*\n?monthly 7/);
    for (const [freq, days] of [
      ['daily', 1],
      ['weekly', 3],
      ['biweekly', 5],
      ['twice_monthly', 5],
      ['monthly', 7],
    ] as const) {
      expect(SRC, `RTO grace for ${freq}`).toContain(`${freq}: ${days}`);
    }
  });

  it('names an escalation path in every support procedure', () => {
    // A runbook without an exit tells someone to keep trying. Each procedure has to say when to stop
    // and hand over.
    const escalations = SUPPORT.match(/### Escalate to engineering when/g) ?? [];
    expect(escalations.length).toBe(3); // RTO delinquency, consignment termination, disputes
  });

  it('states plainly what support cannot do', () => {
    // The section exists so nobody promises a customer something the product will not honour.
    expect(SUPPORT).toContain('What support cannot do');
    expect(SUPPORT).toMatch(/Edit a balance/i);
    expect(SUPPORT).toMatch(/M-1/);
  });
});
