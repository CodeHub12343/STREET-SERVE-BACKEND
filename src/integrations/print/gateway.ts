import {
  PRINT_QUOTE_MAX_UNIT_COST_CENTS,
  PRINT_QUOTE_MIN_UNIT_COST_CENTS,
  PRINT_VENDOR_MAX_RETRIES,
  PRINT_VENDOR_RETRY_BASE_MS,
  PRINT_VENDOR_TIMEOUT_MS,
  PRINT_VENDOR_TOKEN_SKEW_MS,
} from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ConflictError, UnavailableError, UpstreamError } from '../../shared/errors';
import type {
  AccountBalance,
  AudienceCount,
  AudienceRequest,
  FulfilmentStatus,
  ListType,
  MailClass,
  PriceBreak,
  PrintVendorGateway,
  RunPrice,
  SubmitOrderRequest,
  VendorOrderRef,
} from './types';
import {
  WIRE,
  audiencePath,
  buildAudienceBody,
  buildLoginBody,
  buildSubmitBody,
  parseAudienceCount,
  parseBalance,
  parseListTypes,
  parseLogin,
  parseOrderStatus,
  parsePriceBreaks,
  parseSubmit,
} from './wire';

/**
 * The real print-vendor gateway (PostcardMania DirectMail v3).
 *
 * Owns everything the domain must not see: the login/token lifecycle, timeouts, the retry policy,
 * error translation, and price sanity bounds. The vendor's wire format lives in `wire.ts`.
 */

const log = logger.child({ integration: 'print' });

interface Credentials {
  apiKey: string;
  apiSecret: string;
}

function requireCredentials(): Credentials {
  const apiKey = env.PCM_API_KEY;
  const apiSecret = env.PCM_API_SECRET;
  if (!apiKey || !apiSecret) {
    /**
     * The vendor authenticates with a KEY + SECRET PAIR, not a single token — a detail only their
     * spec revealed. Both come from the portal's API Keys tab, and which environment they belong
     * to is what decides whether an order becomes real paper.
     */
    throw UnavailableError('Print vendor is not configured', {
      details: {
        reason: !apiKey ? 'PCM_API_KEY missing' : 'PCM_API_SECRET missing',
        hint: 'Both the API key and its secret come from the PCM portal (My Account → API Keys).',
      },
    });
  }
  return { apiKey, apiSecret };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Module-scoped so one token is shared by every call in the process. */
let cachedToken: { token: string; expiresAt: number } | null = null;

/** Exposed for tests; a stale token across suites would be a confusing failure. */
export function resetPrintVendorToken(): void {
  cachedToken = null;
}

async function rawFetch(
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: unknown },
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(new URL(path, env.PCM_API_BASE_URL), {
    method: init.method,
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(PRINT_VENDOR_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

/**
 * Exchanges the key/secret pair for a bearer JWT, cached until shortly before it expires.
 *
 * Re-authenticating on every call would work and would be wasteful; caching without a safety
 * margin would race the expiry and fail intermittently, which is the worst kind of failure on a
 * money path. `PRINT_VENDOR_TOKEN_SKEW_MS` is that margin.
 */
async function getToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + PRINT_VENDOR_TOKEN_SKEW_MS) {
    return cachedToken.token;
  }
  const { apiKey, apiSecret } = requireCredentials();
  const res = await rawFetch(WIRE.paths.login, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: buildLoginBody(apiKey, apiSecret),
  });

  if (!res.ok) {
    // 401/404 both mean bad credentials per their spec. Never log the key or secret.
    log.error({ status: res.status }, 'print vendor login failed');
    throw UpstreamError('Print vendor authentication failed', {
      retryable: res.status >= 500,
      details: { status: res.status },
    });
  }

  const parsed = parseLogin(JSON.parse(res.text));
  cachedToken = { token: parsed.token, expiresAt: parsed.expiresAt.getTime() };
  return parsed.token;
}

interface CallOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  /** Retry is opt-in per call, never a transport default. */
  retryable: boolean;
  /** Map a 409 to a domain conflict instead of a generic upstream error. */
  conflictAs?: (bodyText: string) => never;
}

async function call<T>(opts: CallOptions, parse: (body: unknown) => T): Promise<T> {
  const attempts = opts.retryable ? PRINT_VENDOR_MAX_RETRIES + 1 : 1;
  let lastError: unknown;
  let reauthed = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const token = await getToken();
      const res = await rawFetch(opts.path, {
        method: opts.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: opts.body,
      });

      if (res.ok) return parse(res.text.length ? JSON.parse(res.text) : {});

      /**
       * A 401 mid-flight means the cached token expired earlier than advertised. Re-authenticate
       * once and retry immediately — this is not a retry of a failed operation, it is the same
       * operation with a valid credential, so it is safe even for non-retryable calls.
       */
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        await getToken(true);
        continue;
      }

      if (res.status === 409 && opts.conflictAs) opts.conflictAs(res.text);

      const transient = res.status >= 500 || res.status === 429;
      /**
       * The vendor's own explanation goes in the log, not only into the thrown error's `details`.
       *
       * A 400 from a print vendor says WHICH field it disliked, and without it the operator sees
       * "Print vendor request failed (400)" on a paid order with no way to act: the reason existed,
       * was captured, and was visible nowhere anyone would look. Truncated because a vendor error
       * body can be a whole HTML page.
       */
      log.warn(
        {
          status: res.status,
          path: opts.path,
          attempt,
          transient,
          vendorBody: res.text.slice(0, 400),
        },
        'print vendor returned an error',
      );
      if (transient && attempt < attempts) {
        await sleep(PRINT_VENDOR_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw UpstreamError(`Print vendor request failed (${res.status})`, {
        retryable: transient,
        details: { status: res.status, body: res.text.slice(0, 500) },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err;
      lastError = err;
      if (attempt < attempts) {
        await sleep(PRINT_VENDOR_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  log.error({ err: lastError, path: opts.path }, 'print vendor unreachable');
  throw UpstreamError('Print vendor is unreachable', { retryable: true, cause: lastError });
}

/**
 * Rejects an absurd price instead of charging it.
 *
 * More important here than it would be against a quote endpoint: we compute the run cost from
 * their published table, so a bad break row becomes our arithmetic rather than their quote.
 */
function assertUnitCostSane(unitCostCents: number, context: string): void {
  if (
    !Number.isFinite(unitCostCents) ||
    unitCostCents < PRINT_QUOTE_MIN_UNIT_COST_CENTS ||
    unitCostCents > PRINT_QUOTE_MAX_UNIT_COST_CENTS
  ) {
    log.error({ unitCostCents, context }, 'rejecting implausible vendor unit cost');
    throw UpstreamError('Print vendor returned an implausible price', {
      retryable: false,
      details: {
        unitCostCents,
        band: [PRINT_QUOTE_MIN_UNIT_COST_CENTS, PRINT_QUOTE_MAX_UNIT_COST_CENTS],
      },
    });
  }
}

/** The break that applies at a quantity is the highest one the quantity reaches. */
export function selectPriceBreak(
  breaks: PriceBreak[],
  mailClass: MailClass,
  quantity: number,
): PriceBreak | null {
  return (
    breaks
      .filter((b) => b.mailClass === mailClass && quantity >= b.minQuantity)
      .sort((a, b) => b.minQuantity - a.minQuantity)[0] ?? null
  );
}

export function buildRealGateway(): PrintVendorGateway {
  const gateway: PrintVendorGateway = {
    async listTypes(): Promise<ListType[]> {
      return call({ method: 'GET', path: WIRE.paths.listTypes, retryable: true }, parseListTypes);
    },

    async createAudienceCount(input: AudienceRequest): Promise<AudienceCount> {
      /**
       * Retryable despite being a POST: creating a count reserves nothing and costs nothing. It is
       * a read that needs a body. (Contrast `submitOrder`.)
       */
      return call(
        {
          method: 'POST',
          path: audiencePath(input.type),
          body: buildAudienceBody(input),
          retryable: true,
        },
        parseAudienceCount,
      );
    },

    async priceBreaks(sizeKey: string): Promise<PriceBreak[]> {
      const breaks = await call(
        {
          method: 'GET',
          path: `${WIRE.paths.galleryDesigns}?size=${encodeURIComponent(sizeKey)}&perPage=50`,
          retryable: true,
        },
        (body) => parsePriceBreaks(body, sizeKey),
      );
      for (const b of breaks) assertUnitCostSane(b.unitCostCents, `price break ${b.minQuantity}`);
      return breaks;
    },

    async priceRun(input): Promise<RunPrice> {
      const breaks = await gateway.priceBreaks(input.sizeKey);
      const applied = selectPriceBreak(breaks, input.mailClass, input.quantity);
      if (!applied) {
        throw UpstreamError('Print vendor publishes no price for this run', {
          retryable: false,
          details: { sizeKey: input.sizeKey, mailClass: input.mailClass, quantity: input.quantity },
        });
      }
      assertUnitCostSane(applied.unitCostCents, 'selected break');
      return {
        quantity: input.quantity,
        mailClass: input.mailClass,
        unitCostCents: applied.unitCostCents,
        vendorCostCents: applied.unitCostCents * input.quantity,
        isBinding: false,
        appliedBreak: applied,
      };
    },

    async submitOrder(input: SubmitOrderRequest): Promise<VendorOrderRef> {
      const orderRef = input.orderRef.trim();
      if (!orderRef) {
        throw UpstreamError('Refusing to submit a print order without an order reference', {
          retryable: false,
        });
      }

      /**
       * ⚠️ The call that spends money.
       *
       * Retry is now SAFE, and that is a fact established from the vendor's spec rather than
       * assumed: `extRefNbr` is a duplicate-detecting reference, and a repeat submission returns
       * 409 instead of producing a second print run. That resolves audit F-6 — the earlier design
       * disabled retry precisely because this was unknown.
       *
       * A 409 is therefore not a failure: it means our earlier attempt landed. It is surfaced as a
       * ConflictError so the caller can reconcile by looking the order up, rather than treating a
       * successfully-placed order as failed and placing another.
       */
      return call(
        {
          method: 'POST',
          path: WIRE.paths.submitPostcard,
          body: buildSubmitBody({ ...input, orderRef }),
          retryable: true,
          conflictAs: (): never => {
            log.warn({ orderRef }, 'print vendor rejected a duplicate order reference');
            throw ConflictError(undefined, 'This print order has already been submitted', {
              details: { orderRef, reason: 'duplicate extRefNbr' },
              retryable: false,
            });
          },
        },
        (body) => parseSubmit(body, orderRef),
      );
    },

    async getStatus(vendorOrderId: string): Promise<FulfilmentStatus> {
      return call(
        {
          method: 'GET',
          path: WIRE.paths.order.replace(':id', encodeURIComponent(vendorOrderId)),
          retryable: true,
        },
        parseOrderStatus,
      );
    },

    async cancelOrder(vendorOrderId: string): Promise<void> {
      /**
       * Real until the vendor's daily batch cutoff, after which they refuse it — orders go to
       * press. Not retried: a 4xx here is a definitive "too late", and repeating it only delays
       * telling someone.
       */
      await call(
        {
          method: 'DELETE',
          path: WIRE.paths.order.replace(':id', encodeURIComponent(vendorOrderId)),
          retryable: false,
        },
        () => undefined,
      );
    },

    async getBalance(): Promise<AccountBalance> {
      return call({ method: 'GET', path: WIRE.paths.balance, retryable: true }, parseBalance);
    },
  };

  return gateway;
}
