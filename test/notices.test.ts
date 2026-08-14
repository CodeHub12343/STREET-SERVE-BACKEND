import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LoggingMessagingProvider,
  sendOutbound,
  setMessagingProvider,
  type MessagingProvider,
} from '../src/integrations/messaging';
import { NoticeDeliveryModel, noticesService } from '../src/modules/notifications/notices.service';
import { UserModel } from '../src/modules/identity/identity.model';
import { AuditLogModel } from '../src/shared/audit';

/**
 * 7.1 / A-9 — contractual notices.
 *
 * §38 (consignment expiry), §49 (five RTO reminders), and §53 (completion) are obligations a signed
 * agreement creates, not courtesies. Before this, they went only to the in-app inbox and web push —
 * so a user who declined the push prompt received nothing at all, and "it was in your inbox" was
 * the whole defence.
 *
 * What these tests pin is the honesty of the record: in-app alone is NOT delivery for a notice, an
 * unreachable user is recorded distinctly from a failed provider, and a send is never reported as
 * successful when nothing accepted it.
 */

class RecordingProvider implements MessagingProvider {
  readonly name = 'recording';
  emails: { to: string; subject: string; body: string }[] = [];
  sms: { to: string; body: string }[] = [];
  failEmail = false;
  failSms = false;

  sendEmail(to: string, subject: string, body: string): Promise<string> {
    if (this.failEmail) return Promise.reject(new Error('provider rejected'));
    this.emails.push({ to, subject, body });
    return Promise.resolve(`email_${this.emails.length}`);
  }

  sendSms(to: string, body: string): Promise<string> {
    if (this.failSms) return Promise.reject(new Error('carrier rejected'));
    this.sms.push({ to, body });
    return Promise.resolve(`sms_${this.sms.length}`);
  }
}

let provider: RecordingProvider;

beforeEach(() => {
  provider = new RecordingProvider();
  setMessagingProvider(provider);
});
afterEach(() => setMessagingProvider(new LoggingMessagingProvider()));

async function userWith(fields: { email?: string; phone?: string }): Promise<string> {
  const user = await UserModel.create({
    authProviderId: `notice|${Math.random()}`,
    email: fields.email ?? null,
    phone: fields.phone ?? null,
  });
  return String(user._id);
}

describe('outbound channel (7.1)', () => {
  it('sends on EVERY channel the recipient has, not the first that works', async () => {
    // Falling back only on failure sounds tidier and is wrong: an email accepted by a provider and
    // then silently spam-filtered reports success, so the SMS never goes and the user never learns
    // their payment is late.
    const outcomes = await sendOutbound({
      to: { email: 'a@test.dev', phone: '+15550001' },
      subject: 'S',
      body: 'B',
      idempotencyKey: 'k1',
    });
    expect(outcomes.map((o) => o.channel).sort()).toEqual(['email', 'sms']);
    expect(provider.emails).toHaveLength(1);
    expect(provider.sms).toHaveLength(1);
  });

  it('puts the subject inline on SMS — a bare body from an unknown number reads as spam', async () => {
    await sendOutbound({
      to: { phone: '+15550002' },
      subject: 'Your consignment ends tomorrow',
      body: 'Extend or arrange a return.',
      idempotencyKey: 'k2',
    });
    expect(provider.sms[0]!.body).toContain('Your consignment ends tomorrow');
    expect(provider.sms[0]!.body).toContain('Extend or arrange a return.');
  });

  it('never throws when a provider fails — a notice must not roll back what it notified about', async () => {
    // A consignment does not un-expire because an email bounced.
    provider.failEmail = true;
    const outcomes = await sendOutbound({
      to: { email: 'a@test.dev', phone: '+15550003' },
      subject: 'S',
      body: 'B',
      idempotencyKey: 'k3',
    });
    expect(outcomes.find((o) => o.channel === 'email')!.delivered).toBe(false);
    expect(outcomes.find((o) => o.channel === 'sms')!.delivered).toBe(true);
  });
});

describe('contractual notices (7.1)', () => {
  it('records what was sent, to what, and that it was accepted', async () => {
    const userId = await userWith({ email: 'seller@test.dev' });

    const result = await noticesService.send({
      userId,
      type: 'consignment_expiry',
      entityType: 'checkout',
      entityId: 'chk-1',
      subject: 'Consignment term ending',
      body: 'Your term ends in 3 days.',
      category: 'consignment',
      idempotencyKey: 'notice-1',
    });

    expect(result.delivered).toBe(true);
    const record = await NoticeDeliveryModel.findOne({ idempotency_key: 'notice-1' }).lean();
    expect(record).not.toBeNull();
    expect(record!.delivered).toBe(true);
    expect(record!.notice_type).toBe('consignment_expiry');
    // The evidence a dispute asks for: which channels, and did any accept.
    expect(record!.channels.map((c) => c.channel).sort()).toEqual(['email', 'in_app']);
  });

  it('does NOT count in-app alone as delivery', async () => {
    // The whole point of A-9. A user with push off and no email has not been reached; recording
    // that as success makes the record useless in exactly the case it exists for.
    const userId = await userWith({});

    const result = await noticesService.send({
      userId,
      type: 'rto_payment_reminder',
      entityType: 'rto_agreement',
      entityId: 'agr-1',
      subject: 'Payment due',
      body: 'Your payment is due tomorrow.',
      category: 'payments',
      idempotencyKey: 'notice-2',
    });

    expect(result.delivered).toBe(false);
    expect(result.undeliverable).toBe(true);
    const record = await NoticeDeliveryModel.findOne({ idempotency_key: 'notice-2' }).lean();
    expect(record!.delivered).toBe(false);
    // In-app still went — the user sees it if they open the app. It just is not delivery.
    expect(record!.channels.map((c) => c.channel)).toEqual(['in_app']);
  });

  it('distinguishes an unreachable user from a failed provider', async () => {
    // Different problems needing different responses: one is missing contact data, the other is a
    // broken integration. Collapsing them into "failed" sends ops chasing the wrong thing.
    provider.failEmail = true;
    const userId = await userWith({ email: 'bounces@test.dev' });

    const result = await noticesService.send({
      userId,
      type: 'consignment_terminated',
      entityType: 'rto_agreement',
      entityId: 'agr-2',
      subject: 'Payment late',
      body: 'Your payment is late.',
      category: 'payments',
      idempotencyKey: 'notice-3',
    });

    expect(result.delivered).toBe(false);
    expect(result.undeliverable).toBe(false); // they HAVE an address; the provider refused it
    const record = await NoticeDeliveryModel.findOne({ idempotency_key: 'notice-3' }).lean();
    expect(record!.channels.find((c) => c.channel === 'email')!.error).toContain('provider rejected');
  });

  it('audits an undelivered notice so it is findable, not just logged', async () => {
    const userId = await userWith({});
    await noticesService.send({
      userId,
      type: 'rto_completed',
      entityType: 'rto_agreement',
      entityId: 'agr-audit',
      subject: 'Ownership transferred',
      body: 'It is yours.',
      category: 'rto',
      idempotencyKey: 'notice-audit',
    });

    const entries = await AuditLogModel.find({
      action: 'notice.undelivered',
      entityId: 'agr-audit',
    }).lean();
    expect(entries).toHaveLength(1);
  });

  it('is idempotent — a re-run of a sweep cannot notify the same person twice', async () => {
    const userId = await userWith({ email: 'twice@test.dev' });
    const input = {
      userId,
      type: 'consignment_expiry' as const,
      entityType: 'checkout',
      entityId: 'chk-idem',
      subject: 'Ending',
      body: 'Soon.',
      category: 'consignment',
      idempotencyKey: 'notice-idem',
    };

    await noticesService.send(input);
    await noticesService.send(input);

    expect(await NoticeDeliveryModel.countDocuments({ idempotency_key: 'notice-idem' })).toBe(1);
    expect(provider.emails).toHaveLength(1);
  });

  it('produces every notice sent about one entity, for a dispute', async () => {
    const userId = await userWith({ email: 'disputer@test.dev' });
    for (const days of [14, 7, 3]) {
      await noticesService.send({
        userId,
        type: 'consignment_expiry',
        entityType: 'checkout',
        entityId: 'chk-dispute',
        subject: 'Consignment term ending',
        body: `Ends in ${days} days.`,
        category: 'consignment',
        idempotencyKey: `notice-dispute-${days}`,
      });
    }

    const history = await noticesService.listForEntity('checkout', 'chk-dispute');
    expect(history).toHaveLength(3);
    expect(history.every((h) => h.delivered)).toBe(true);
  });

  it('lists undelivered notices for the ops queue', async () => {
    const userId = await userWith({});
    await noticesService.send({
      userId,
      type: 'rto_payment_reminder',
      entityType: 'rto_agreement',
      entityId: 'agr-ops',
      subject: 'Due',
      body: 'Due.',
      category: 'payments',
      idempotencyKey: 'notice-ops',
    });

    const undelivered = await noticesService.listUndelivered(30);
    expect(undelivered.some((n) => n.entity_id === 'agr-ops')).toBe(true);
  });
});

describe('the default provider (7.1)', () => {
  it('reports success but names itself, so an unconfigured production is visible', async () => {
    // Reporting failure in dev would make every notice path look broken locally and train people to
    // ignore delivery failures. What keeps it honest is the provider name on every record: a
    // production send log full of `log` entries reads as "nothing is configured", not as delivery.
    setMessagingProvider(new LoggingMessagingProvider());
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcomes = await sendOutbound({
      to: { email: 'dev@test.dev' },
      subject: 'S',
      body: 'B',
      idempotencyKey: 'k-log',
    });
    expect(outcomes[0]!.delivered).toBe(true);
    expect(outcomes[0]!.providerRef).toContain('log_email');
    spy.mockRestore();
  });
});
