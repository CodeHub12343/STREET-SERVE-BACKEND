import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import { logger } from './config/logger';
import { asyncHandler } from './middleware/asyncHandler';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { metricsHandler, metricsMiddleware } from './observability/metrics';
import { authRouter, usersRouter } from './modules/identity/identity.routes';
import { verificationRouter } from './modules/identity/verification.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { catalogRouter } from './modules/catalog/catalog.routes';
import { healthRouter } from './modules/health/health.routes';
import { paymentsRouter, transactionsRouter } from './modules/payments/payments.routes';
import { businessesRouter, categorySuggestionsRouter } from './modules/vendors/vendors.routes';
import { vendorsAdminRouter } from './modules/vendors/vendors.admin.routes';
import {
  engagementRouter,
  favoritesRouter,
  liveSessionsRouter,
  mapRouter,
} from './modules/livemap/livemap.routes';
import { queuesRouter, waveDownsRouter } from './modules/queue/queue.routes';
import { reviewsRouter } from './modules/reviews/reviews.routes';
import { bookingsRouter, schedulingBusinessRouter } from './modules/scheduling/scheduling.routes';
import { businessOrdersRouter, ordersRouter } from './modules/orders/orders.routes';
import { messageThreadsRouter } from './modules/messaging/messaging.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import {
  checkoutsRouter,
  hubsRouter,
  productsRouter,
  sellerAgreementRouter,
} from './modules/consignment/consignment.routes';
import { financeRouter } from './modules/ledger/ledger.routes';
import { payRouter, salesRouter } from './modules/salepayments/salepayments.routes';
import { debtsRouter } from './modules/debt/debt.routes';
import { taxRouter } from './modules/tax/tax.routes';
import { publicRefundRouter, refundsRouter } from './modules/refunds/refunds.routes';
import { agreementsRouter } from './modules/agreements/agreements.routes';
import { rtoRouter } from './modules/rto/rto.routes';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes';
import { disputesRouter } from './modules/disputes/disputes.routes';
import { trustRouter } from './modules/trust/trust.routes';
import { storageRouter } from './modules/storage/storage.routes';
import {
  giftsRouter,
  giveawaysRouter,
  pingBudgetsRouter,
  pingsRouter,
  spotMeRouter,
} from './modules/growth/growth.routes';
import { payforwardRouter } from './modules/payforward/payforward.routes';
import { boostRouter } from './modules/boost/boost.routes';
import { postcardsRouter } from './modules/postcards/postcards.routes';
import { deliveryRouter, driversRouter } from './modules/delivery/delivery.routes';
import { aiRouter } from './modules/ai/ai.routes';
import { jobsRouter } from './modules/jobs/jobs.routes';
import { residentRouter, shelterRouter } from './modules/shelter/shelter.routes';
import { academyRouter } from './modules/academy/academy.routes';
import { sellersRouter } from './modules/sellers/sellers.routes';
import { earnRouter } from './modules/earn/earn.routes';
import { eventsRouter } from './modules/events/events.routes';
import { adsRouter } from './modules/ads/ads.routes';
import { promotionsRouter } from './modules/promotions/promotions.routes';
import { wishlistsRouter } from './modules/wishlists/wishlists.routes';
import { loyaltyRouter } from './modules/loyalty/loyalty.routes';
import { corridorsRouter, mileageRouter } from './modules/livemap/corridors.routes';
import { backofficeRouter } from './modules/backoffice/backoffice.routes';
import { platformRouter } from './modules/platform/platform.routes';
import {
  preregistrationsRouter,
  sponsorsAdminRouter,
  sponsorsPublicRouter,
} from './modules/sponsors/sponsors.routes';
import { authWebhookRouter } from './webhooks/auth.webhook';
import { stripeWebhookRouter } from './webhooks/stripe.webhook';
import { kycWebhookRouter } from './webhooks/kyc.webhook';
import { printWebhookRouter } from './webhooks/print.webhook';
import { buildOpenApiDocument } from './openapi';

/**
 * Assembles the Express app WITHOUT starting listeners or connecting to datastores, so it can be
 * imported directly in tests. server.ts owns the network + datastore lifecycle.
 * Middleware order mirrors BACKEND_ARCHITECTURE.md §2.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Correlation + structured request logging (before anything that can fail).
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId ?? 'unknown',
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/metrics' },
    }),
  );

  // Security headers + CORS allowlist. The API serves JSON only, so lock CSP to `none` and enable
  // HSTS + referrer-policy + no-sniff (SECURITY_GUIDELINES.md §4). Any browser-served surface
  // (marketing/dashboards) lives on a separate origin with its own CSP.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 15552000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));

  // Metrics timing wrapper.
  app.use(metricsMiddleware);

  // Webhooks mount BEFORE the JSON body parser — they need the raw body for signature checks.
  app.use('/webhooks', authWebhookRouter);
  app.use('/webhooks', stripeWebhookRouter);
  app.use('/webhooks', kycWebhookRouter);
  // Print vendor status accelerator. Polling is the mechanism; this only prompts an early re-poll.
  app.use('/webhooks', printWebhookRouter);

  // JSON body parser (size-limited) for everything else.
  app.use(express.json({ limit: '1mb' }));

  // Operational endpoints (unversioned).
  app.use(healthRouter);
  if (env.METRICS_ENABLED) app.get('/metrics', asyncHandler(metricsHandler));
  if (env.OPENAPI_ENABLED && !['production'].includes(env.NODE_ENV)) {
    const doc = buildOpenApiDocument();
    app.get('/openapi.json', (_req: Request, res: Response) => res.json(doc));
  }

  // Versioned API surface.
  const api = express.Router();
  api.use('/users', usersRouter);
  api.use('/users', favoritesRouter); // GET /users/me/favorites
  api.use('/users', notificationsRouter); // GAP-3 inbox + GAP-4 push subscriptions
  api.use('/auth', authRouter);
  api.use('/verification', verificationRouter);
  api.use('/payments', paymentsRouter);
  api.use('/transactions', transactionsRouter);
  api.use('/live-sessions', liveSessionsRouter);
  api.use('/map', mapRouter);
  api.use('/queues', queuesRouter);
  api.use('/wave-downs', waveDownsRouter);
  api.use('/reviews', reviewsRouter);
  api.use('/bookings', bookingsRouter);
  api.use('/orders', ordersRouter);
  api.use('/message-threads', messageThreadsRouter);
  api.use('/hubs', hubsRouter);
  api.use('/products', productsRouter);
  api.use('/finance', financeRouter);
  api.use('/sales', salesRouter);
  api.use('/debts', debtsRouter);
  api.use('/tax', taxRouter);
  api.use('/', refundsRouter); // /sales/:id/refund, /hubs/:id/refunds
  api.use('/pay', publicRefundRouter); // public refund REQUEST from a receipt
  api.use('/pay', payRouter); // public customer payment surface (no auth by design)
  api.use('/seller-agreement', sellerAgreementRouter);
  api.use('/agreements', agreementsRouter);
  api.use('/rto', rtoRouter);
  api.use('/subscriptions', subscriptionsRouter);
  api.use('/checkouts', checkoutsRouter);
  api.use('/disputes', disputesRouter);
  api.use('/trust-scores', trustRouter);
  api.use('/storage', storageRouter);
  api.use('/ping-budgets', pingBudgetsRouter);
  api.use('/pings', pingsRouter);
  api.use('/gifts', giftsRouter);
  api.use('/giveaways', giveawaysRouter);
  api.use('/spot-me', spotMeRouter);
  api.use('/pay-it-forward', payforwardRouter);
  api.use('/boost', boostRouter);
  api.use('/postcards', postcardsRouter);
  api.use('/drivers', driversRouter);
  api.use('/deliveries', deliveryRouter);
  api.use('/ai', aiRouter);
  api.use('/jobs', jobsRouter);
  api.use('/shelter-partners', shelterRouter);
  // B-1/B-3/B-5: resident-facing shelter endpoints. Separate mount because none of these require
  // the shelter_admin permission — a resident must not need staff rights to see their own money.
  api.use('/residents', residentRouter);
  // Phase D — Academy (D-3/D-4), seller profile (D-2), and the unified earn hub (D-1).
  api.use('/academy', academyRouter);
  api.use('/sellers', sellersRouter);
  api.use('/earn', earnRouter);
  // Phase E — events power the forecaster's event signal, E-5 alerts and E-8 pricing.
  api.use('/events', eventsRouter);
  // Phase F — featured placement + ad inventory. Every served ad carries its disclosure label.
  api.use('/placements', adsRouter);
  // 7.6 — flash sales mount at the root because they span /businesses/:id/… and /flash-sales/….
  api.use('/', promotionsRouter);
  api.use('/users', wishlistsRouter); // 7.2 — /users/me/wishlist
  // 7.3 / 7.4 — spans /businesses/:id/loyalty and /users/me/{loyalty,referrals}.
  api.use('/', loyaltyRouter);
  api.use('/users', loyaltyRouter);
  api.use('/users', corridorsRouter); // 7.8 — /users/me/corridors
  api.use('/reports', mileageRouter); // 7.7 — /reports/mileage
  // 7.10 — spans /businesses/:id/{crew,expenses,invoices} and /users/me/crews.
  api.use('/', backofficeRouter);
  api.use('/users', backofficeRouter);
  api.use('/config', platformRouter);
  api.use('/sponsors', sponsorsPublicRouter);
  api.use('/preregistrations', preregistrationsRouter);
  api.use('/admin', sponsorsAdminRouter);
  api.use('/businesses', businessesRouter);
  api.use('/businesses', engagementRouter); // follow / notify-me
  api.use('/businesses', schedulingBusinessRouter); // services / availability
  api.use('/businesses', businessOrdersRouter); // vendor order queue
  api.use('/businesses', dashboardRouter); // vendor dashboard
  api.use('/category-suggestions', categorySuggestionsRouter);
  api.use('/catalog', catalogRouter);
  // Admin surface: core admin module + vendor-review routes share the /admin prefix.
  api.use('/admin', adminRouter);
  api.use('/admin', vendorsAdminRouter);
  app.use('/api/v1', api);

  // 404 + centralized error handling (last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
