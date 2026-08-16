import { env } from '../../config/env';
import { CityModel } from '../catalog/catalog.model';

/**
 * Launch scoping (Phase 8). The consignment layer ships gated to launch cities where hub
 * partnerships + legal review are complete (Exec §7); expansion is a data/config change, not a
 * redeploy. Absence of a city row means "not yet configured" → default-enabled for the pilot.
 */
export const platformService = {
  async isFeatureEnabled(citySlug: string, feature: string): Promise<boolean> {
    const city = await CityModel.findOne({ slug: citySlug }).lean().exec();
    if (!city) return true; // pilot default — city config not yet loaded
    if (city.status !== 'live') return false;
    const flags = (city.feature_flags ?? {}) as Record<string, unknown>;
    return flags[feature] !== false;
  },

  /**
   * Default-DENY variant (A-6). `isFeatureEnabled` opens up for unconfigured cities, which is right
   * for rolling out ordinary features but wrong for anything with a legal precondition: a city
   * nobody has reviewed must not be treated as cleared. Requires a real, live city row with the
   * flag set to exactly `true`. A missing `citySlug` is itself a refusal.
   */
  async isFeatureExplicitlyEnabled(
    citySlug: string | null | undefined,
    feature: string,
  ): Promise<boolean> {
    if (!citySlug) return false;
    const city = await CityModel.findOne({ slug: citySlug }).lean().exec();
    if (!city || city.status !== 'live') return false;
    const flags = (city.feature_flags ?? {}) as Record<string, unknown>;
    return flags[feature] === true;
  },

  /**
   * The OPT-OUT counterpart to `isFeatureExplicitlyEnabled`.
   *
   * Deliberately a separate method rather than a negation of that one: `!isFeatureExplicitlyEnabled`
   * would also be true for an unknown city and a non-live one, quietly closing markets nobody meant
   * to close. This answers a narrower question — has someone actively turned this feature OFF here?
   * — so a feature that ships open stays open unless a person decides otherwise.
   *
   * Used by delivery, which the product owner opened everywhere. Compliance-gated features must
   * keep using the explicit-enable check.
   */
  async isFeatureExplicitlyDisabled(
    citySlug: string | null | undefined,
    feature: string,
  ): Promise<boolean> {
    if (!citySlug) return false;
    const city = await CityModel.findOne({ slug: citySlug }).lean().exec();
    if (!city) return false;
    const flags = (city.feature_flags ?? {}) as Record<string, unknown>;
    return flags[feature] === false;
  },

  async launchStatus() {
    const cities = await CityModel.find({ status: 'live' }).lean().exec();
    return {
      defaultCity: env.DEFAULT_CITY,
      liveCities: cities.map((c) => ({
        slug: c.slug,
        name: c.name,
        state: c.state,
        launchDate: c.launch_date,
        features: (c.feature_flags ?? {}) as Record<string, unknown>,
      })),
    };
  },
};
