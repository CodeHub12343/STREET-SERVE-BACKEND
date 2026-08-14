import { describe, expect, it } from 'vitest';

import { STATIC_QR_SUNSET_AT } from '../src/config/constants';
import {
  staticQrAccepted,
  staticQrDaysRemaining,
  staticQrExpiresAt,
  staticQrNotice,
} from '../src/modules/consignment/staticQrSunset';

/**
 * 6.5 — the static hub QR phase-out.
 *
 * The security property under test: a hub that photographed its printed poster can be used to
 * reserve stock from anywhere. `allow_static_qr` was meant to be temporary grandfathering and had
 * nothing that made it end. These tests pin the three layers that now do — and, most importantly,
 * that the *absence* of a deadline fails closed rather than open.
 */
describe('static hub QR sunset (6.5)', () => {
  const before = new Date(STATIC_QR_SUNSET_AT.getTime() - 10 * 86_400_000);
  const after = new Date(STATIC_QR_SUNSET_AT.getTime() + 86_400_000);

  it('never accepts static for a hub that was not grandfathered', () => {
    expect(staticQrAccepted({ allow_static_qr: false }, before)).toBe(false);
    expect(staticQrAccepted({}, before)).toBe(false);
    expect(staticQrExpiresAt({ allow_static_qr: false })).toBeNull();
  });

  it('accepts a grandfathered hub before its own deadline', () => {
    const hub = { allow_static_qr: true, static_qr_deadline_at: new Date(before.getTime() + 86_400_000) };
    expect(staticQrAccepted(hub, before)).toBe(true);
  });

  it('stops accepting after the hub deadline passes', () => {
    const hub = { allow_static_qr: true, static_qr_deadline_at: new Date(before.getTime() - 86_400_000) };
    expect(staticQrAccepted(hub, before)).toBe(false);
    expect(staticQrDaysRemaining(hub, before)).toBe(0);
  });

  it('the platform sunset overrides a deadline set beyond it', () => {
    // Nobody gets to extend past the sunset by editing a row — that is the difference between a
    // phase-out and a flag.
    const hub = {
      allow_static_qr: true,
      static_qr_deadline_at: new Date(STATIC_QR_SUNSET_AT.getTime() + 365 * 86_400_000),
    };
    expect(staticQrExpiresAt(hub)).toEqual(STATIC_QR_SUNSET_AT);
    expect(staticQrAccepted(hub, after)).toBe(false);
  });

  it('a grandfathered hub with NO recorded deadline is capped at the sunset, not unlimited', () => {
    // The most important case. An exception whose end date nobody wrote down is exactly the one
    // that would otherwise live forever, so it inherits the platform sunset rather than defaulting
    // open.
    const hub = { allow_static_qr: true, static_qr_deadline_at: null };
    expect(staticQrExpiresAt(hub)).toEqual(STATIC_QR_SUNSET_AT);
    expect(staticQrAccepted(hub, before)).toBe(true);
    expect(staticQrAccepted(hub, after)).toBe(false);
  });

  it('everything is off after the sunset, whatever the flags say', () => {
    for (const deadline of [null, new Date('2099-01-01'), new Date('2020-01-01')]) {
      expect(staticQrAccepted({ allow_static_qr: true, static_qr_deadline_at: deadline }, after)).toBe(
        false,
      );
    }
  });

  describe('the notice shown on the station screen', () => {
    it('says nothing to a hub that never had static acceptance', () => {
      expect(staticQrNotice({ allow_static_qr: false })).toBeNull();
    });

    it('names the consequence, not just the deprecation, inside the warning window', () => {
      const hub = { allow_static_qr: true, static_qr_deadline_at: new Date(before.getTime() + 3 * 86_400_000) };
      const notice = staticQrNotice(hub, before);
      expect(notice).toContain('3 days');
      // A hub that reads "deprecated" and does nothing has its check-ins break with a seller
      // standing at the counter. The notice has to say what actually happens.
      expect(notice).toContain('take the printed poster down');
    });

    it('explains the security reason while there is still time to act on it', () => {
      // Well clear of the warning window — the sunset cap means "60 days from `before`" would still
      // land inside it, which is the whole point of the cap.
      const early = new Date(STATIC_QR_SUNSET_AT.getTime() - 100 * 86_400_000);
      const hub = { allow_static_qr: true, static_qr_deadline_at: new Date(early.getTime() + 60 * 86_400_000) };
      expect(staticQrNotice(hub, early)).toContain('photographed');
    });

    it('tells an expired hub what to do instead, in the present tense', () => {
      const hub = { allow_static_qr: true, static_qr_deadline_at: new Date(before.getTime() - 86_400_000) };
      expect(staticQrNotice(hub, before)).toContain('no longer works');
    });
  });
});
