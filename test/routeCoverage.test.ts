import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A-1, server side — every route is exercised by at least one test.
 *
 * The frontend half of this gate (`scripts/check-reachability.mjs` in the app repo) catches
 * endpoints defined with no caller. This is the other direction, and the audit's wording for it was
 * blunt: *a route with no frontend caller and no test is dead weight that still carries attack
 * surface and maintenance cost.*
 *
 * The two halves cover different failures. An endpoint the UI never calls is a product problem — a
 * capability nobody can reach. A route no test touches is an engineering problem — code on a
 * public, authenticated surface whose behaviour nothing verifies, including its authorization.
 *
 * ## How "exercised" is determined
 *
 * A route's path template is normalised (`/rto/agreements/:id/payoff` → a regex that accepts any
 * value in the `:id` position) and matched against every request URL literal in `test/`. Method is
 * not checked: a path with a test is a path someone has reasoned about, and demanding
 * method-by-method coverage here would produce noise rather than signal.
 */

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const TEST = __dirname;

/**
 * The Phase 4 baseline: 39 of the ~250 mounted routes have no test. The ratchet is a NUMBER rather
 * than a named list — a list of 39 paths in a source file goes stale within a sprint, and the
 * failure message prints the current set anyway, which is more useful than a copy of it here.
 *
 * **Lower this when routes gain tests. Never raise it.** Raising it is the one edit that turns this
 * file from a gate into a formality, so it should be visible in a diff and argued for.
 *
 * The current 39 skew toward read-only listings (`/agreements/mine`, `/listings/mine`, `/markets`)
 * and operator surfaces (`/ledger/*`, `/:id/analytics`) — but they also include real money and
 * authorization paths: `/sales/:id/refunds`, `/:id/cancel-payment`, `/bank-account`,
 * `/:id/moderate-photos`. Those are the ones worth burning down first.
 */
const MAX_UNTESTED = 39;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Extract mounted paths. Routers declare paths relative to their mount point, so the literal in the
 * route file (`'/:id/payoff'`) is matched on its own — the mount prefix is irrelevant to whether a
 * test touches it, and reconstructing it would mean parsing `app.ts` mount order.
 */
function routePathsIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const pattern = /\w*[Rr]outer\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  return [...source.matchAll(pattern)].map((m) => m[2] ?? '').filter(Boolean);
}

describe('A-1 (server) · every route is exercised by a test', () => {
  const routeFiles = walk(SRC).filter((f) => f.endsWith('.routes.ts'));

  it('finds route files to check (the scan itself must not silently pass)', () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it('has no untested routes beyond the recorded baseline', () => {
    const testSource = walk(TEST)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    const untested: string[] = [];
    const seen = new Set<string>();

    for (const file of routeFiles) {
      for (const path of routePathsIn(file)) {
        const key = `${file.replace(SRC, 'src')} ${path}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // `/:id/payoff` → `/[^/'"`\s]+/payoff`, so any concrete id in a test URL matches.
        const asRegex = path
          .split('/')
          .map((segment) =>
            segment.startsWith(':')
              ? '[^/\'"`\\s]+'
              : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('/');
        // Trailing boundary: the path must END a URL literal or be followed by ? or / — otherwise
        // `/rto/agreements` would be vouched for by any test hitting `/rto/agreements/:id/payoff`.
        if (new RegExp(`${asRegex}(?:[?'"\`]|/?\\$\\{|\\s)`).test(testSource)) continue;
        untested.push(key);
      }
    }

    expect(
      untested.length,
      `${untested.length} route(s) have no test (baseline ${MAX_UNTESTED}). ` +
        `An untested route is unverified authorization on a public surface:\n  ` +
        untested.join('\n  '),
    ).toBeLessThanOrEqual(MAX_UNTESTED);
  });
});
