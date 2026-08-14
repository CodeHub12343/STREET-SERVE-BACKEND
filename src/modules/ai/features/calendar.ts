/**
 * ═══ E-3 — CALENDAR & SEASONALITY FEATURES ═══
 *
 * Pure functions, no dependencies, no network. Every one of these is a real demand driver for
 * street selling that the engine was previously blind to:
 *
 *  • DAY OF WEEK — the strongest signal in retail, and free.
 *  • HOLIDAYS — US federal holidays move foot traffic hard in both directions. A parade day is
 *    excellent for a park pitch and terrible for a transit hub.
 *  • PAYDAY PROXIMITY — the one most specific to this product's sellers and their customers.
 *    Discretionary street spending clusters around the 1st and 15th; a $20 item that sells on the
 *    2nd will not sell on the 12th, and no amount of product-quality signal explains that.
 *  • SCHOOL CALENDAR — approximated, and deliberately so (see below).
 *
 * Holidays are computed rather than tabled, so this doesn't silently expire in January. US federal
 * rules are stable and simple enough that a table would be a maintenance liability, not a
 * simplification.
 */

/** Nth given weekday of a month, e.g. 3rd Monday of January. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

/** Last given weekday of a month (Memorial Day). */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, 0 - offset));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * US federal holidays for a year, as `YYYY-MM-DD` → name.
 *
 * Observed dates are NOT shifted to the nearest weekday. That shift matters for whether an office
 * is open; it does not matter for whether people are out on the street, which is the only thing
 * this feature is used for.
 */
export function usFederalHolidays(year: number): Map<string, string> {
  const h = new Map<string, string>();
  h.set(`${year}-01-01`, "New Year's Day");
  h.set(iso(nthWeekday(year, 0, 1, 3)), 'Martin Luther King Jr. Day');
  h.set(iso(nthWeekday(year, 1, 1, 3)), "Presidents' Day");
  h.set(iso(lastWeekday(year, 4, 1)), 'Memorial Day');
  h.set(`${year}-06-19`, 'Juneteenth');
  h.set(`${year}-07-04`, 'Independence Day');
  h.set(iso(nthWeekday(year, 8, 1, 1)), 'Labor Day');
  h.set(iso(nthWeekday(year, 9, 1, 2)), 'Columbus Day');
  h.set(`${year}-11-11`, 'Veterans Day');
  h.set(iso(nthWeekday(year, 10, 4, 4)), 'Thanksgiving');
  h.set(`${year}-12-25`, 'Christmas Day');
  return h;
}

export interface CalendarFeatures {
  /** 0=Sun … 6=Sat. */
  dayOfWeek: number;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  /**
   * Within the payday window — the 1st–4th or 15th–18th, plus month-end. Discretionary street
   * spending clusters here, and it is the single most actionable calendar signal for this product.
   */
  isPaydayWindow: boolean;
  /** Rough US school-term heuristic — see `isSchoolTerm`. */
  isSchoolTerm: boolean;
  /** Meteorological season, for coarse seasonality. */
  season: 'winter' | 'spring' | 'summer' | 'autumn';
  /** Short human phrases, so a recommendation can say WHY without the caller re-deriving it. */
  factors: string[];
}

/**
 * School term, approximated: in session Sep–May, out Jun–Aug, with a late-December break.
 *
 * Deliberately approximate. Real district calendars vary by county and change yearly, and wiring a
 * per-district calendar source would be a large ingestion project for a signal that is only ever a
 * tiebreaker. An approximation that is right ~90% of the year beats an unbuilt exact one — but it
 * is weighted accordingly, and named `isSchoolTerm` rather than anything implying precision.
 */
export function isSchoolTerm(d: Date): boolean {
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  if (month >= 5 && month <= 7) return false; // Jun–Aug
  if (month === 11 && day >= 20) return false; // late Dec
  if (month === 0 && day <= 5) return false; // early Jan
  return true;
}

export function seasonOf(d: Date): CalendarFeatures['season'] {
  const m = d.getUTCMonth();
  if (m === 11 || m <= 1) return 'winter';
  if (m <= 4) return 'spring';
  if (m <= 7) return 'summer';
  return 'autumn';
}

export function calendarFeatures(at: Date = new Date()): CalendarFeatures {
  const dayOfWeek = at.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const key = at.toISOString().slice(0, 10);
  const holidayName = usFederalHolidays(at.getUTCFullYear()).get(key) ?? null;

  const dom = at.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const isPaydayWindow =
    (dom >= 1 && dom <= 4) || (dom >= 15 && dom <= 18) || dom >= daysInMonth - 1;

  const factors: string[] = [];
  if (holidayName) factors.push(`${holidayName} — more people out`);
  else if (isWeekend) factors.push('weekend footfall');
  if (isPaydayWindow) factors.push('payday week — people are spending');

  return {
    dayOfWeek,
    isWeekend,
    isHoliday: Boolean(holidayName),
    holidayName,
    isPaydayWindow,
    isSchoolTerm: isSchoolTerm(at),
    season: seasonOf(at),
    factors,
  };
}

/**
 * A single multiplier for the forecaster, centred on 1.0.
 *
 * Bounded to roughly ±35% deliberately. Calendar is a real effect but a MODEST one next to
 * "does this product sell at all" — letting it swing a forecast by 3× would let a Saturday make a
 * dead product look alive, which is precisely the failure mode that destroys trust in a forecast.
 */
export function calendarMultiplier(f: CalendarFeatures): number {
  let m = 1;
  if (f.isWeekend) m *= 1.18;
  if (f.isHoliday) m *= 1.2;
  if (f.isPaydayWindow) m *= 1.15;
  // Term-time weekdays put fewer casual browsers on the street in the daytime.
  if (f.isSchoolTerm && !f.isWeekend) m *= 0.95;
  if (f.season === 'winter') m *= 0.9;
  if (f.season === 'summer') m *= 1.08;
  return Math.max(0.65, Math.min(1.35, m));
}
