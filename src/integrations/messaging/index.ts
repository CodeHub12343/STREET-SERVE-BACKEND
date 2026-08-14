import { logger } from '../../config/logger';

/**
 * 7.1 / A-9 / D-8 — the outbound transactional channel (email + SMS).
 *
 * ## Why this is a compliance item, not a marketing one
 *
 * Before this, the platform could reach a user only through in-app notifications and web push.
 * That is fine for "your order is ready". It is **not** fine for the notices the specification
 * treats as contractual:
 *
 *   - **§38** — consignment expiry notices.
 *   - **§49** — the five RTO payment-reminder stages.
 *   - **§53** — completion notification and ownership transfer.
 *
 * A user who denies push permission — a large fraction on iOS, where the prompt is one tap to
 * dismiss — received **none** of them. "We sent it to your in-app inbox" is not a defence for a
 * notice a signed agreement says will be given, and the person most likely to have push off is the
 * person least likely to be opening the app daily. So the delivery channel is part of whether the
 * obligation was met, not an implementation detail below it.
 *
 * ## Shape
 *
 * A provider interface plus a registry, in the same style as `integrations/stripe`. Nothing here
 * knows about Postmark or Twilio specifically; a deployment installs an adapter. The default is a
 * **logging** adapter so a dev environment is honest about what it would have sent, rather than
 * silently dropping it.
 *
 * ## The rule this file exists to enforce
 *
 * **A contractual notice must not be reported as delivered when no channel accepted it.** Every
 * send returns a per-channel outcome, and the caller records it. Silence about a failed send is how
 * "we notified you" becomes untrue in a dispute — which is exactly the situation the notice was
 * supposed to prevent.
 */

export type MessageChannel = 'email' | 'sms';

export interface OutboundMessage {
  /** Recipient. At least one of these must be present or there is nothing to send to. */
  to: { email?: string | null; phone?: string | null };
  subject: string;
  /** Plain text. Deliberately not HTML: a legal notice should read identically everywhere. */
  body: string;
  /**
   * Stable key for this notice, so a retried job cannot send twice. Providers vary in whether they
   * honour it; the send log is the backstop.
   */
  idempotencyKey: string;
}

export interface DeliveryOutcome {
  channel: MessageChannel;
  delivered: boolean;
  providerRef?: string | null;
  error?: string | null;
}

export interface MessagingProvider {
  readonly name: string;
  sendEmail(to: string, subject: string, body: string, idempotencyKey: string): Promise<string>;
  sendSms(to: string, body: string, idempotencyKey: string): Promise<string>;
}

/**
 * The default provider: logs what it would have sent and reports success.
 *
 * Reporting success is deliberate and worth defending. The alternative — reporting failure in dev —
 * would make every notice path look broken locally and train people to ignore delivery failures,
 * which is the exact signal this system exists to surface. What keeps it honest is that the
 * provider NAME is recorded on every send, so a production send log full of `log` entries is
 * immediately visible as "no provider is configured" rather than as successful delivery.
 */
export class LoggingMessagingProvider implements MessagingProvider {
  readonly name = 'log';

  sendEmail(to: string, subject: string, body: string, key: string): Promise<string> {
    logger.info({ to, subject, body, key, channel: 'email' }, '[messaging:log] email not sent — no provider configured');
    return Promise.resolve(`log_email_${key}`);
  }

  sendSms(to: string, body: string, key: string): Promise<string> {
    logger.info({ to, body, key, channel: 'sms' }, '[messaging:log] sms not sent — no provider configured');
    return Promise.resolve(`log_sms_${key}`);
  }
}

let provider: MessagingProvider = new LoggingMessagingProvider();

export function setMessagingProvider(next: MessagingProvider): void {
  provider = next;
  logger.info({ provider: next.name }, 'messaging provider registered');
}

export function messagingProviderName(): string {
  return provider.name;
}

/**
 * Send on every channel the recipient has an address for.
 *
 * **Both channels are attempted, not one.** Falling back only on failure sounds tidier and is
 * wrong for a contractual notice: an email that is accepted by a provider and then silently
 * spam-filtered reports success, so the SMS never goes, and the user never learns their payment is
 * late. Two independent channels is the point.
 *
 * Never throws. A notice that fails to send must not roll back the thing it was notifying about —
 * a consignment does not un-expire because an email bounced.
 */
export async function sendOutbound(message: OutboundMessage): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];

  if (message.to.email) {
    try {
      const ref = await provider.sendEmail(
        message.to.email,
        message.subject,
        message.body,
        `${message.idempotencyKey}:email`,
      );
      outcomes.push({ channel: 'email', delivered: true, providerRef: ref });
    } catch (err) {
      logger.error({ err, key: message.idempotencyKey }, 'outbound email failed');
      outcomes.push({ channel: 'email', delivered: false, error: String(err) });
    }
  }

  if (message.to.phone) {
    try {
      const ref = await provider.sendSms(
        message.to.phone,
        // SMS carries the subject inline: a bare body arriving from an unknown number reads as spam.
        `${message.subject}\n\n${message.body}`,
        `${message.idempotencyKey}:sms`,
      );
      outcomes.push({ channel: 'sms', delivered: true, providerRef: ref });
    } catch (err) {
      logger.error({ err, key: message.idempotencyKey }, 'outbound sms failed');
      outcomes.push({ channel: 'sms', delivered: false, error: String(err) });
    }
  }

  return outcomes;
}
