import { Schema, type InferSchemaType } from 'mongoose';

import { WEATHER_CACHE_TILE_DEGREES, WEATHER_CACHE_TTL_MIN } from '../../../config/constants';
import { logger } from '../../../config/logger';
import { defineModel } from '../../../shared/defineModel';
import { weather, type WeatherObservation } from '../../../integrations/weather';

/**
 * ═══ E-2 — WEATHER CACHE ═══
 *
 * Keyed by (geo tile, hour) rather than by exact coordinates, for two reasons:
 *
 *  1. COST. Weather does not vary meaningfully across ~5km, but seller coordinates vary constantly.
 *     Caching per-coordinate would mean a provider call per request; per-tile means one call per
 *     area per hour, which keeps a free tier viable at pilot scale.
 *  2. DETERMINISM. Two sellers standing 200m apart must see the same weather signal, or the same
 *     product ranks differently for them for no explicable reason.
 *
 * The tile is deliberately COARSER than the demand tile (~5km vs ~550m): demand is local, weather
 * is not, and using the demand resolution would multiply provider calls ~80× for no added accuracy.
 */
const WeatherCacheSchema = new Schema(
  {
    tile: { type: String, required: true },
    /** Truncated to the hour — the cache key's time dimension. */
    hour_bucket: { type: String, required: true },
    condition: { type: String, required: true },
    temp_c: { type: Number, required: true },
    precipitation_probability: { type: Number, default: 0 },
    wind_kph: { type: Number, default: 0 },
    observed_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'weather_observations' },
);
WeatherCacheSchema.index({ tile: 1, hour_bucket: 1 }, { unique: true });
/** Observations are only useful while fresh; expire them rather than growing forever. */
WeatherCacheSchema.index({ created_at: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export type WeatherCacheDoc = InferSchemaType<typeof WeatherCacheSchema>;
export const WeatherCacheModel = defineModel('WeatherObservation', WeatherCacheSchema);

export function weatherTile(lng: number, lat: number): string {
  const x = Math.floor(lng / WEATHER_CACHE_TILE_DEGREES);
  const y = Math.floor(lat / WEATHER_CACHE_TILE_DEGREES);
  return `${x}:${y}`;
}

function hourBucket(at: Date): string {
  return at.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Cached current conditions for a point.
 *
 * Returns null on every failure path — no provider, provider down, nothing cached. The forecaster
 * treats null as neutral (multiplier 1.0), so weather being unavailable degrades the forecast
 * rather than skewing it.
 */
export async function observedWeather(
  lng: number,
  lat: number,
  at: Date = new Date(),
): Promise<WeatherObservation | null> {
  const tile = weatherTile(lng, lat);
  const bucket = hourBucket(at);

  const cached = await WeatherCacheModel.findOne({ tile, hour_bucket: bucket }).lean().exec();
  if (cached) {
    const ageMin = (Date.now() - new Date(cached.observed_at).getTime()) / 60_000;
    if (ageMin <= WEATHER_CACHE_TTL_MIN) {
      return {
        condition: cached.condition as WeatherObservation['condition'],
        tempC: cached.temp_c,
        precipitationProbability: cached.precipitation_probability,
        windKph: cached.wind_kph,
        observedAt: cached.observed_at,
      };
    }
  }

  const fresh = await weather().current(lng, lat);
  if (!fresh) return null;

  try {
    await WeatherCacheModel.updateOne(
      { tile, hour_bucket: bucket },
      {
        $set: {
          condition: fresh.condition,
          temp_c: fresh.tempC,
          precipitation_probability: fresh.precipitationProbability,
          wind_kph: fresh.windKph,
          observed_at: fresh.observedAt,
        },
      },
      { upsert: true },
    ).exec();
  } catch (err) {
    // A cache write failing must never cost the caller their forecast.
    logger.warn({ err, tile }, 'weather cache write failed');
  }
  return fresh;
}
