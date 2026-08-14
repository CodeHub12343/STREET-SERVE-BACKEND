import {
  EARN_DEFAULT_LIMIT,
  EARN_HOURS_TO_PAYOUT,
  EARN_PAYOUT_REF_CENTS,
  EARN_PROX_MAX_M,
  EARN_SPEED_REF_HOURS,
  EARN_WEIGHTS,
} from '../../config/constants';
import { distanceMeters } from '../../shared/geo';
import type { Principal } from '../../shared/types/principal';
import { consignmentRepository } from '../consignment/consignment.repository';
import { HubModel } from '../consignment/consignment.model';
import { feeService } from '../payments/fees';
import { jobsService } from '../jobs/jobs.service';
import { sellersService } from '../sellers/sellers.service';

export type OpportunityKind = 'consignment' | 'gig' | 'promotion';

export interface Opportunity {
  id: string;
  kind: OpportunityKind;
  title: string;
  subtitle: string;
  /** What the seller can realistically expect to take home, net of platform fees. */
  expectedPayoutCents: number;
  hoursToPayout: number;
  distanceM: number | null;
  score: number;
  /** Explainable, in the same style as the AI recommendations and Trending. */
  factors: string[];
  reasonSummary: string;
  /** Where tapping it goes. */
  href: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * ═══ D-1 — THE EARN HUB ═══
 *
 * "Earn Today" as one ranked list instead of three screens. Selling, gigs and promotions are
 * genuinely different shapes of work, so the merge only holds if there is a common unit — and there
 * is: what you'll take home, and how long until you have it.
 *
 * Ranking on payout alone would put a $90 four-hour gig above $18 of candles every time, ignoring
 * that the gig pays after the shift. Someone who needs money for a bed tonight is optimising the
 * second axis. So `speed` carries real weight, and every row states both numbers plainly rather than
 * hiding them behind a score.
 */
export const earnService = {
  async opportunities(
    principal: Principal,
    input: { lng?: number; lat?: number; limit?: number },
  ): Promise<{ items: Opportunity[]; profileComplete: boolean }> {
    const limit = input.limit ?? EARN_DEFAULT_LIMIT;
    const here =
      input.lng !== undefined && input.lat !== undefined
        ? ([input.lng, input.lat] as [number, number])
        : null;

    const [consignment, gigs, profile] = await Promise.all([
      this.consignmentOpportunities(here, limit),
      this.gigOpportunities(principal, here, limit),
      sellersService.matchingContext(principal.userId),
    ]);

    const scored = [...consignment, ...gigs].map((o) => {
      const payout = clamp01(o.expectedPayoutCents / EARN_PAYOUT_REF_CENTS);
      // Inverted: sooner is better, and anything past the reference horizon scores 0.
      const speed = clamp01(1 - o.hoursToPayout / EARN_SPEED_REF_HOURS);
      const proximity =
        o.distanceM === null ? 0.5 : clamp01(1 - o.distanceM / EARN_PROX_MAX_M);

      const factors = [...o.factors];
      if (payout > 0.5) factors.push('pays well for the time');
      if (speed > 0.8) factors.push('pays out today');
      if (o.distanceM !== null && proximity > 0.7) factors.push('close to you');

      /**
       * D-2 feeds in here: a seller who told us what they're good at gets those categories lifted.
       * Deliberately a modest nudge on top of the economics rather than a re-sort — someone who
       * needs money today should still see the best-paying nearby work first, whatever it is.
       */
      let affinity = 0;
      if (profile && o.kind === 'consignment') {
        const hay = `${o.title} ${o.subtitle}`.toLowerCase();
        if (profile.categories.some((c) => hay.includes(c.toLowerCase()))) {
          affinity = 1;
          factors.push('matches what you sell');
        } else if (profile.skills.some((s) => hay.includes(s.split('_')[0]!))) {
          affinity = 0.6;
          factors.push('matches your skills');
        }
      }

      const score =
        EARN_WEIGHTS.payout * payout +
        EARN_WEIGHTS.speed * speed +
        EARN_WEIGHTS.proximity * proximity +
        0.1 * affinity;

      return {
        ...o,
        score,
        factors,
        reasonSummary:
          factors.length > 0
            ? `Ranked because: ${factors.join('; ')}.`
            : 'Available near you right now.',
      };
    });

    return {
      items: scored.sort((a, b) => b.score - a.score).slice(0, limit),
      /** Drives the "tell us what you're good at" nudge — a blank profile is the cold start. */
      profileComplete: profile !== null,
    };
  },

  /**
   * Consignment stock as an earning opportunity.
   *
   * `expectedPayoutCents` is what the seller keeps if they sell ONE unit, net of the platform fee —
   * not the value of the whole pickup. Quoting the full stock value would be the flattering number
   * and the dishonest one: nobody sells out on day one, and a list that implies they will is how a
   * seller ends up with stock they can't move and a return they didn't plan for.
   */
  async consignmentOpportunities(
    here: [number, number] | null,
    limit: number,
  ): Promise<Array<Omit<Opportunity, 'score' | 'reasonSummary'>>> {
    const products = await consignmentRepository.availableProducts(limit * 3);
    if (products.length === 0) return [];

    const hubIds = [...new Set(products.map((p) => p.hub_id))];
    const hubs = await HubModel.find({ _id: { $in: hubIds } })
      .lean()
      .exec();
    const hubLoc = new Map(
      hubs
        .filter((h) => h.location?.coordinates?.length === 2)
        .map((h) => [String(h._id), h.location!.coordinates as [number, number]]),
    );

    const out: Array<Omit<Opportunity, 'score' | 'reasonSummary'>> = [];
    for (const p of products) {
      const unit = p.unit_value_cents;
      // Same registry the real settlement uses, so the quote matches the eventual payout.
      const fee = await feeService.resolveFee('consignment_digital', unit);
      const sellerNet = Math.floor(((unit - fee) * p.consignment_split_percent) / 100);
      if (sellerNet <= 0) continue;

      const loc = hubLoc.get(p.hub_id);
      const distanceM = here && loc ? Math.round(distanceMeters(here, loc)) : null;

      out.push({
        id: `product:${String(p._id)}`,
        kind: 'consignment',
        title: p.name,
        subtitle: `${p.quantity_available} available · you keep ${p.consignment_split_percent}%`,
        expectedPayoutCents: sellerNet,
        hoursToPayout: EARN_HOURS_TO_PAYOUT.consignment,
        distanceM,
        factors: ['no money needed upfront'],
        href: `/seller/product/${String(p._id)}`,
      });
    }
    return out;
  },

  /** Gigs. Pay is known upfront and lands same-day, which is the whole reason they rank well. */
  async gigOpportunities(
    principal: Principal,
    here: [number, number] | null,
    limit: number,
  ): Promise<Array<Omit<Opportunity, 'score' | 'reasonSummary'>>> {
    if (!here) return []; // the nearby feed is proximity-ranked and requires coordinates
    const jobs = await jobsService.nearby({ lng: here[0], lat: here[1], limit });

    return jobs.map((j) => {
      // An hourly gig's real value is rate × expected hours, not the rate — comparing a $22/hr
      // shift to a $60 flat gig on the rate alone would rank them backwards.
      const hours = j.durationHrs ?? 1;
      const expected = j.payUnit === 'hourly' ? j.payCents * hours : j.payCents;
      return {
        id: `job:${j.id}`,
        kind: 'gig' as const,
        title: j.title,
        subtitle: `${j.employerName}${j.durationHrs ? ` · ${j.durationHrs}h` : ''}`,
        expectedPayoutCents: expected,
        hoursToPayout: EARN_HOURS_TO_PAYOUT.gig,
        distanceM: j.distanceM ?? null,
        factors: ['pay agreed before you start'],
        href: `/seller/jobs/${j.id}`,
      };
    });
  },
};
