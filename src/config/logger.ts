import pino from 'pino';

import { env, isProd, isTest } from './env';

/**
 * Structured JSON logger. No `console.*` anywhere else in app code (lint-enforced).
 * Redaction is mandatory: secrets, tokens, raw PII, OTP codes never reach the logs.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["idempotency-key"]',
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.otp',
      '*.code',
      '*.secret',
      '*.cardNumber',
      '*.bankAccount',
      'headers.authorization',
      /**
       * 6.2: pino's `*.secret` matches a property named exactly `secret` — it does NOT match
       * `checkout_qr_secret`, so logging a hub document printed the QR signing key in clear text.
       * That key is the whole proof of physical presence in the custody model: anyone holding it
       * can reserve stock without being at the hub.
       */
      '*.checkout_qr_secret',
      'hub.checkout_qr_secret',
      '*.qrToken',
      '*.qr_token',
      // Snake_case counterparts of the camelCase entries above — the DB layer uses snake_case, so
      // a logged document would otherwise slip straight past the list.
      '*.access_token',
      '*.refresh_token',
      '*.client_secret',
      '*.api_key',
      '*.webhook_secret',
      '*.stripe_secret_key',
      /**
       * Same lesson as `checkout_qr_secret` above: `*.api_key` matches a property named exactly
       * `api_key`, NOT `pcm_api_key`. This credential authorises spending real money on printing
       * and postage, and it has already leaked once over chat — it does not get to leak again
       * through a log line.
       */
      '*.pcm_api_key',
      '*.pcmApiKey',
      'headers["x-api-key"]',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'streetserve-backend' },
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
      },
});

export type Logger = typeof logger;
