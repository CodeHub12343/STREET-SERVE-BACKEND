import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env only outside production (in prod, config comes from the platform secret store).
if (process.env.NODE_ENV !== 'production') {
  loadDotenv();
}

const csv = (val: string): string[] =>
  val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * 12-factor config, validated at boot. The process fails fast on a missing/invalid
 * variable rather than blowing up deep in a request path later.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000').transform(csv),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  REDIS_URL: z.string().min(1).optional(),

  AUTH_PROVIDER: z.enum(['clerk', 'auth0']).default('clerk'),
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_AUDIENCE: z.string().min(1).optional(),
  AUTH_WEBHOOK_SECRET: z.string().min(1).optional(),

  // ─── Payments (Stripe Connect + Stripe Tax) ────────────────────────────────────────────────
  // Optional so Phase 0 dev and tests (which inject a fake gateway) run without live keys; the
  // real gateway throws if invoked without configuration.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_CONNECT_COUNTRY: z.string().length(2).default('US'),
  PLATFORM_CURRENCY: z.string().length(3).default('usd'),
  STRIPE_TAX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // ─── Customer-facing fee flags (R8/R10) — OFF at launch (transparency-first, §3 decision) ─────
  // The fee taxonomy is fully wired to the registry; these gate whether the customer is actually
  // charged. Flipping one adds its itemized line to the server-authoritative breakdown.
  CUSTOMER_SERVICE_FEE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PROCESSING_FEE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * §32.4 Waved Down convenience fee. Off at launch for the same reason as the other two: the spec
   * says the platform "may" charge it and explicitly suggests charging only the seller's 10% at
   * first "to keep checkout simple". The plumbing is complete and disclosed; this decides whether
   * the customer is actually charged.
   */
  WAVE_CONVENIENCE_FEE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ─── KYC (Stripe Identity / Persona) ───────────────────────────────────────────────────────
  KYC_PROVIDER: z.enum(['stripe_identity', 'persona']).default('stripe_identity'),
  KYC_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Dev-only: approve identity verification instantly instead of waiting for the provider webhook
  // (which can't fire locally without a real STRIPE_WEBHOOK_SECRET). Ignored in production — see the
  // `!isProd` guard in verification.service. Lets the verify → Bronze → checkout flow be walkable.
  KYC_DEV_AUTO_APPROVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Dev/staging only: let a customer accept a rent-to-own agreement whose text is still the
   * placeholder pending attorney review.
   *
   * The gate it relaxes exists so real customers cannot clickwrap unenforceable terms and build up
   * acceptance records that would all have to be re-collected. That reasoning does not apply to a
   * staging box with test accounts, where the alternative is that the whole RTO lifecycle cannot be
   * walked end to end before launch.
   *
   * Never honored in production — enforced in `assertAgreementReviewed`, not merely documented, and
   * the same convention as KYC_DEV_AUTO_APPROVE. Turning it on is therefore incapable of letting a
   * real customer accept placeholder terms, which is the property the original gate was protecting.
   */
  RTO_ALLOW_UNREVIEWED_AGREEMENT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  KYC_RETURN_URL: z.string().url().default('http://localhost:3000/verify/complete'),
  CONNECT_RETURN_URL: z.string().url().default('http://localhost:3000/payouts/complete'),
  /** Public app origin — used to build the customer-facing payment link a seller shows as a QR. */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  CONNECT_REFRESH_URL: z.string().url().default('http://localhost:3000/payouts/refresh'),

  // ─── Object storage (Cloudflare R2 / S3-compatible) ────────────────────────────────────────
  // Optional in dev/test (tests inject a fake); required for real presigned uploads.
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).default('streetserve-media'),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  R2_REGION: z.string().default('auto'),

  // ─── AI provider (Google Gemini) ────────────────────────────────────────────────────────────
  // Optional everywhere: with no key the AI module falls back to the deterministic rule-based
  // engine, which is fully functional on its own. Gemini adds the natural-language layer only.
  GEMINI_API_KEY: z.string().min(1).optional(),
  /**
   * E-2: OpenWeather key. Optional — without it the weather signal is simply absent, which the
   * forecaster treats as neutral rather than guessing.
   */
  WEATHER_API_KEY: z.string().min(1).optional(),
  /** E-4: Ticketmaster Discovery key for event ingestion. Manual admin entry works without it. */
  TICKETMASTER_API_KEY: z.string().min(1).optional(),
  /** Reasoning model for seller-facing copy. Free tier: 2.5-flash. Switch to 2.5-pro with billing. */
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  /** Cheap model for short, high-volume rewrites (recommendation "why" lines). */
  GEMINI_FAST_MODEL: z.string().min(1).default('gemini-2.5-flash-lite'),
  /** A seller's dashboard must not hang on a slow model — we fall back to deterministic copy. */
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  /**
   * E-6: `forecast` selects the statistical demand forecaster. Not the default — it should be
   * switched on once `outcome_facts` has enough settled rows to be worth forecasting from
   * (`GET /ai/outcomes/stats` reports readiness).
   */
  AI_PROVIDER: z.enum(['rule_based', 'gemini', 'forecast']).default('gemini'),

  // ─── Print / direct-mail vendor (PostcardMania "PCM Integrations") ─────────────────────────
  /**
   * Phase 0.1. The credential exists BEFORE the integration does, deliberately: the key was twice
   * transmitted in plaintext over chat, and the fix for that is a validated home for it, not a
   * later one. Optional everywhere — nothing reads it yet, and a missing key must never stop boot.
   *
   * Rotate at portal.pcmintegrations.com. Production values come from the platform secret store;
   * `.env` is gitignored and is for the SANDBOX key only. Never commit either.
   */
  PCM_API_KEY: z.string().min(1).optional(),
  /**
   * The vendor authenticates with a KEY + SECRET **pair** (`POST /auth/login` → short-lived JWT),
   * not a single static token. Both are generated together in the portal's API Keys tab. A key
   * without its secret cannot authenticate at all.
   */
  PCM_API_SECRET: z.string().min(1).optional(),
  /**
   * Sandbox and production keys are indistinguishable by shape — both are base64-wrapped UUIDs —
   * so nothing about the key itself can tell you which environment you are about to spend money in.
   * This is the only guard against pointing a dev box at the live print queue, which is why it is
   * declared explicitly rather than inferred from NODE_ENV.
   */
  PCM_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  /**
   * Confirmed from the vendor's OpenAPI `servers` block. Note this is **not**
   * `api.pcmintegrations.com` — that host only redirects to their documentation, which is why
   * early endpoint probing returned 404 for everything.
   */
  PCM_API_BASE_URL: z.string().url().default('https://v3.pcmintegrations.com'),
  /**
   * Signing secret for the vendor's status callbacks, if one is ever configured in their portal.
   *
   * Optional, and the receiver fails OPEN without it — deliberately. The callback is only an
   * accelerator: it carries no trusted data and can at most prompt a re-poll of an order we already
   * own. Rejecting unsigned calls would disable the accelerator without adding security. With a
   * secret set, an invalid signature is refused.
   */
  PCM_WEBHOOK_SECRET: z.string().min(1).optional(),
  /**
   * The address side of every postcard. The buyer designs the front; a mailed piece needs a back,
   * and the vendor requires both. Config because it is artwork, not code.
   */
  POSTCARD_BACK_TEMPLATE_URL: z.string().url().optional(),
  /**
   * Whether a postcard buyer is charged sales tax.
   *
   * OFF until ADR-007 §5 (merchant of record) is answered by an accountant. Under wholesale resale
   * StreetServe is plausibly the merchant for a taxable print-and-mail service in every destination
   * state — but charging tax we should not collect and failing to collect tax we owe are both real
   * harms, so this stays inert until someone qualified decides. Same convention as the other
   * customer-facing charge flags: plumbing complete, flag off, flipping it needs sign-off.
   *
   * Turning it on without wiring Stripe Tax fails loudly rather than guessing a rate.
   */
  POSTCARD_TAX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OPENAPI_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  DEFAULT_CITY: z.string().default('modesto-ca'),

  /**
   * The operator inbox: where StreetServe's own mail lands — public contact enquiries and the
   * system-generated notifications addressed to the platform rather than to a user (a sponsorship
   * awaiting logo review, a new pre-registration).
   *
   * This is deliberately NOT where user notices go. A consignment expiry or an RTO payment
   * reminder is addressed to the person it concerns and must keep going to them; redirecting those
   * here would break the contractual-notice guarantee `notices.service` exists to uphold. See
   * `notifyOps` in integrations/messaging.
   */
  OPS_EMAIL: z.string().email().default('jbowser727@gmail.com'),
});

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Cannot use the pino logger here — it depends on this module. Fail loudly and exit.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[config] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  const env = parsed.data;

  // Auth config is optional in test (tokens are signed with a local key), required elsewhere.
  if (env.NODE_ENV !== 'test') {
    const missing = (['AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE'] as const).filter(
      (k) => !env[k],
    );
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.error(`\n[config] Missing required auth config: ${missing.join(', ')}\n`);
      process.exit(1);
    }
  }

  /**
   * Webhook signing secret (Phase 2). Card payments are confirmed ONLY by the Stripe webhook — a
   * client can't be trusted to report that money arrived. With a placeholder secret every webhook
   * fails signature verification, so payments would silently never complete: the customer is
   * charged, the seller sees "waiting for payment" forever, and no one is told why.
   *
   * Fatal in production. Loud in development, where the fix is:
   *     stripe listen --forward-to localhost:8080/webhooks/stripe
   * and copying the printed whsec_… into STRIPE_WEBHOOK_SECRET.
   */
  if (env.NODE_ENV !== 'test') {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    const unusable = !secret || secret.includes('replace') || !secret.startsWith('whsec_');
    if (unusable && env.NODE_ENV === 'production') {
      // eslint-disable-next-line no-console
      console.error(
        '\n[config] STRIPE_WEBHOOK_SECRET is missing or still a placeholder.\n' +
          '         Card payments cannot be confirmed without it — refusing to start.\n',
      );
      process.exit(1);
    }
    if (unusable) {
      // eslint-disable-next-line no-console
      console.warn(
        '\n[config] ⚠  STRIPE_WEBHOOK_SECRET is a placeholder — card payments will NEVER confirm.\n' +
          '         Run:  stripe listen --forward-to localhost:8080/webhooks/stripe\n' +
          '         then put the printed whsec_… into STRIPE_WEBHOOK_SECRET.\n',
      );
    }
  }

  /**
   * Phase 0.1 — the live print queue spends real money on paper and postage, and a print run is
   * the one thing in this platform that cannot be rolled back. A dev or staging process holding a
   * PRODUCTION vendor key is therefore a fatal misconfiguration, not a warning: the failure mode is
   * physical mail sent to real households on someone else's dime, discovered days later.
   *
   * Sandbox and production keys are both base64-wrapped UUIDs, so the key cannot self-identify.
   * PCM_ENVIRONMENT is the only signal, which is exactly why it is checked here and not inferred.
   */
  if (env.PCM_ENVIRONMENT === 'production' && env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(
      `\n[config] PCM_ENVIRONMENT=production but NODE_ENV=${env.NODE_ENV}.\n` +
        '         This process would submit real print jobs at real cost. Refusing to start.\n' +
        '         Use the sandbox key locally, or set NODE_ENV=production deliberately.\n',
    );
    process.exit(1);
  }

  return env;
}

export const env = load();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * The AI provider actually in force. Asking for Gemini without a key is a config mistake, not a
 * reason to fail the boot: the rule-based engine is a complete implementation, so we degrade to it
 * and say so. Everything downstream reads this rather than sniffing for the key itself.
 *
 * Never Gemini under test. dotenv loads .env for NODE_ENV=test too, so a developer's real key would
 * otherwise silently point the suite at a live, non-deterministic, rate-limited model — tests that
 * assert exact recommendation copy must stay hermetic.
 */
export const aiProvider: 'rule_based' | 'gemini' | 'forecast' =
  env.AI_PROVIDER === 'forecast'
    ? 'forecast'
    : env.AI_PROVIDER === 'gemini' && env.GEMINI_API_KEY && env.NODE_ENV !== 'test'
      ? 'gemini'
      : 'rule_based';

if (!isTest && env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[config] ⚠  AI_PROVIDER=gemini but GEMINI_API_KEY is unset — using the rule-based engine.\n' +
      '         Get a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY.\n',
  );
}
