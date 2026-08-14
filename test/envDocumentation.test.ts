import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 6.2 — every environment variable the app reads must be documented in `.env.example`.
 *
 * The review found six undocumented, three of which were `CUSTOMER_SERVICE_FEE_ENABLED`,
 * `PROCESSING_FEE_ENABLED`, and `WAVE_CONVENIENCE_FEE_ENABLED` — the flags that decide whether
 * customers are charged fees at all. An operator reading `.env.example` to configure a deployment
 * had no way to learn those existed, which makes "the fees are off at launch" a fact about one
 * developer's machine rather than a documented default.
 *
 * This is a drift guard, not a style rule: the failure mode is silent, and it only shows up as a
 * misconfigured production deploy.
 */
describe('env documentation (6.2)', () => {
  const root = resolve(__dirname, '..');
  const schema = readFileSync(resolve(root, 'src/config/env.ts'), 'utf8');
  const example = readFileSync(resolve(root, '.env.example'), 'utf8');

  /** Keys declared in the zod env schema — two-space indented `NAME: z…`. */
  const declared = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] ?? '');
  const documented = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? ''),
  );

  it('parses the schema (a vacuous pass would defeat the point)', () => {
    expect(declared.length).toBeGreaterThan(20);
    expect(declared).toContain('STRIPE_SECRET_KEY');
  });

  it('documents every variable the app reads', () => {
    const missing = declared.filter((name) => !documented.has(name));
    expect(
      missing,
      `Undocumented environment variables — add them to .env.example with a comment saying what ` +
        `happens if they are wrong:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('never puts a real-looking secret in the example file', () => {
    // `.env.example` is committed. A placeholder that looks like a key is how a real one eventually
    // gets pasted in next to it and nobody notices in review.
    const livePatterns = [
      /sk_live_[A-Za-z0-9]{10,}/,
      /sk_test_[A-Za-z0-9]{20,}/,
      /whsec_[A-Za-z0-9]{20,}/,
      /AIza[A-Za-z0-9_-]{30,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const pattern of livePatterns) {
      expect(pattern.test(example), `.env.example matches ${pattern}`).toBe(false);
    }
  });
});
