import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * ═══ E-2 — WEATHER ═══
 *
 * Street selling is weather-bound in a way almost no other retail is. Rain doesn't reduce demand at
 * a shop; it ends the day for someone standing on a sidewalk. The engine was completely blind to it.
 *
 * Same shape as every other external dependency here (`gemini`, `stripe`, `kyc`): a narrow
 * interface, a swappable implementation, and a NULL provider that is the default. The null provider
 * returns `null` rather than fabricating a forecast — a made-up weather signal is worse than none,
 * because the engine would weight it as though it were real.
 */
export type WeatherCondition = 'clear' | 'clouds' | 'rain' | 'snow' | 'storm' | 'extreme';

export interface WeatherObservation {
  condition: WeatherCondition;
  tempC: number;
  /** 0–1. Above ~0.5 is a decision-changing number for someone deciding whether to go out. */
  precipitationProbability: number;
  windKph: number;
  observedAt: Date;
}

export interface WeatherGateway {
  readonly name: string;
  /** Current conditions for a point, or null when unavailable. Never throws to the caller. */
  current(lng: number, lat: number): Promise<WeatherObservation | null>;
}

/** The default. Honest absence: no key, no data, no guesses. */
class NullWeatherGateway implements WeatherGateway {
  readonly name = 'null';
  current(): Promise<WeatherObservation | null> {
    return Promise.resolve(null);
  }
}

/** Map OpenWeather's numeric condition groups onto our coarse vocabulary. */
function mapOpenWeatherCode(id: number): WeatherCondition {
  if (id >= 200 && id < 300) return 'storm';
  if (id >= 300 && id < 600) return 'rain';
  if (id >= 600 && id < 700) return 'snow';
  if (id >= 700 && id < 800) return 'extreme';
  if (id === 800) return 'clear';
  return 'clouds';
}

/**
 * OpenWeather implementation. Chosen because its free tier covers the pilot's request volume and it
 * needs no account provisioning beyond a key.
 *
 * Every failure path returns null rather than throwing: a weather outage must degrade the forecast,
 * never fail a seller's recommendation request.
 */
class OpenWeatherGateway implements WeatherGateway {
  readonly name = 'openweather';
  constructor(private readonly apiKey: string) {}

  async current(lng: number, lat: number): Promise<WeatherObservation | null> {
    try {
      const url = new URL('https://api.openweathermap.org/data/2.5/weather');
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lng));
      url.searchParams.set('units', 'metric');
      url.searchParams.set('appid', this.apiKey);

      // Short timeout: this sits in a request path, and a slow forecast is worse than none.
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'weather provider returned non-OK');
        return null;
      }
      const body = (await res.json()) as {
        weather?: Array<{ id?: number }>;
        main?: { temp?: number };
        wind?: { speed?: number };
        rain?: Record<string, number>;
      };

      const id = body.weather?.[0]?.id ?? 800;
      const condition = mapOpenWeatherCode(id);
      return {
        condition,
        tempC: body.main?.temp ?? 15,
        // The current-conditions endpoint has no PoP, so derive a coarse one from the condition.
        precipitationProbability:
          condition === 'rain' || condition === 'storm'
            ? 0.9
            : condition === 'snow'
              ? 0.8
              : condition === 'clouds'
                ? 0.2
                : 0.05,
        windKph: Math.round((body.wind?.speed ?? 0) * 3.6),
        observedAt: new Date(),
      };
    } catch (err) {
      logger.warn({ err }, 'weather lookup failed — forecast will run without it');
      return null;
    }
  }
}

let gateway: WeatherGateway | null = null;

/** Test seam, matching `setStripeGateway` / `setRecommendationEngine`. */
export function setWeatherGateway(next: WeatherGateway): void {
  gateway = next;
}

export function weather(): WeatherGateway {
  if (!gateway) {
    gateway =
      env.WEATHER_API_KEY && env.NODE_ENV !== 'test'
        ? new OpenWeatherGateway(env.WEATHER_API_KEY)
        : new NullWeatherGateway();
  }
  return gateway;
}

/**
 * The forecaster's multiplier, centred on 1.0.
 *
 * Weather gets a WIDER band than calendar (±60% vs ±35%) because its effect genuinely is larger:
 * a storm doesn't dampen street sales, it ends them. Returns exactly 1.0 with no observation, so an
 * absent provider is neutral rather than pessimistic.
 */
export function weatherMultiplier(obs: WeatherObservation | null): number {
  if (!obs) return 1;
  let m = 1;
  switch (obs.condition) {
    case 'storm':
    case 'extreme':
      m = 0.4;
      break;
    case 'snow':
      m = 0.55;
      break;
    case 'rain':
      m = 0.65;
      break;
    case 'clouds':
      m = 0.95;
      break;
    case 'clear':
      m = 1.1;
      break;
  }
  // Temperature extremes suppress footfall independently of precipitation.
  if (obs.tempC <= 2) m *= 0.8;
  else if (obs.tempC >= 35) m *= 0.85;
  else if (obs.tempC >= 18 && obs.tempC <= 27) m *= 1.08; // the pleasant band
  if (obs.windKph >= 40) m *= 0.85;
  return Math.max(0.4, Math.min(1.6, m));
}

/** Human phrase for the reason line — a forecast that can't explain itself isn't advisory, it's oracular. */
export function weatherFactor(obs: WeatherObservation | null): string | null {
  if (!obs) return null;
  if (obs.condition === 'storm' || obs.condition === 'extreme') return 'severe weather — expect a slow day';
  if (obs.condition === 'snow') return 'snow — footfall will be down';
  if (obs.condition === 'rain') return 'rain expected — fewer people out';
  if (obs.condition === 'clear' && obs.tempC >= 18 && obs.tempC <= 27) return 'good weather for selling';
  return null;
}
