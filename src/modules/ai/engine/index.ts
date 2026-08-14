import { aiProvider } from '../../../config/env';
import { ForecastEngine } from './forecast';
import { GeminiEngine } from './gemini';
import { RuleBasedEngine } from './ruleBased';
import type { RecommendationEngine } from './types';

/**
 * Recommendation-engine locator, selected by AI_PROVIDER:
 *   forecast    → E-6 statistical demand forecaster over `outcome_facts` + weather/calendar/events
 *   gemini      → deterministic ranking with Gemini-written explanations (see ./gemini)
 *   rule_based  → deterministic ranking and copy, no external calls (the default with no API key)
 *
 * `forecast` is NOT the default. It needs a populated `outcome_facts` (E-1) to say anything useful,
 * and on a cold dataset it falls back to a pessimistic baseline — correct, but no better than the
 * rule-based engine and slower. Switch it on once `GET /ai/outcomes/stats` reports readiness.
 *
 * Tests and a future Python/FastAPI ML service still inject via setRecommendationEngine() — no
 * consumer changes. That seam is what makes replacing this forecaster with a trained model a
 * one-line change, once there is enough history to validate one against.
 */
let engineImpl: RecommendationEngine | null = null;

export function setRecommendationEngine(next: RecommendationEngine): void {
  engineImpl = next;
}

export function engine(): RecommendationEngine {
  engineImpl ??=
    aiProvider === 'forecast'
      ? new ForecastEngine()
      : aiProvider === 'gemini'
        ? new GeminiEngine()
        : new RuleBasedEngine();
  return engineImpl;
}

export * from './types';
