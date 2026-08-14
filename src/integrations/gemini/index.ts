/**
 * Google Gemini (Generative Language API) client.
 *
 * Deliberately a small `fetch` wrapper rather than the `@google/genai` SDK: we use exactly one
 * endpoint (`:generateContent`) with structured output, and a dependency-free client keeps the
 * boot surface small and the failure modes ours to control.
 *
 * ── The contract every caller relies on ─────────────────────────────────────────────────────────
 * `generateJson` NEVER throws and NEVER returns partial junk. A missing key, a timeout, a 429 from
 * the free tier, a malformed candidate — all resolve to `null`, and the caller uses its own
 * deterministic output. AI here is an enhancement layer over first-party data; a seller's dashboard
 * must not break because a model was rate-limited.
 */
import { env, aiProvider } from '../../config/env';
import { logger } from '../../config/logger';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const log = logger.child({ integration: 'gemini' });

/** Minimal shape of the parts of the response we read. */
interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

export interface GenerateJsonOptions {
  /** The instruction + facts. Keep facts explicit — the model must not invent numbers. */
  prompt: string;
  /** OpenAPI-subset schema (Gemini `responseSchema`) the reply is forced to satisfy. */
  schema: Record<string, unknown>;
  /** Use GEMINI_FAST_MODEL (flash-lite) for short, high-volume rewrites. */
  fast?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /** Persona/rules applied out-of-band from the user-supplied facts. */
  systemInstruction?: string;
}

/**
 * 2.5 models think by default, which burns output tokens and latency on tasks like "rewrite this
 * sentence". Flash and flash-lite accept a 0 budget to switch it off; **pro does not** (its minimum
 * is 128), and sending 0 there is a 400. Since GEMINI_MODEL is expected to move to 2.5-pro once
 * billing is enabled, decide per-model instead of hardcoding.
 */
function canDisableThinking(model: string): boolean {
  return !/pro/i.test(model);
}

export const gemini = {
  /** True when a real key is configured and Gemini is the selected provider. */
  get available(): boolean {
    return aiProvider === 'gemini' && Boolean(env.GEMINI_API_KEY);
  },

  /**
   * Ask for a JSON object matching `schema`. Returns `null` on any failure — see the file header.
   *
   * Retries once on a transient upstream 5xx (observed in practice: flash-lite answering 503 "high
   * demand"). Deliberately NOT retried: 429, where an immediate retry just burns more of the same
   * exhausted quota, and 4xx, which will fail identically every time.
   */
  async generateJson<T>(opts: GenerateJsonOptions): Promise<T | null> {
    if (!this.available) return null;
    const first = await this.attempt<T>(opts);
    if (first.result !== null || !first.retryable) return first.result;
    await new Promise((r) => setTimeout(r, 250));
    return (await this.attempt<T>(opts)).result;
  },

  /** One request. `retryable` marks a failure worth a second try. */
  async attempt<T>(opts: GenerateJsonOptions): Promise<{ result: T | null; retryable: boolean }> {
    const model = opts.fast ? env.GEMINI_FAST_MODEL : env.GEMINI_MODEL;
    const started = Date.now();

    try {
      const res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': env.GEMINI_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
          ...(opts.systemInstruction
            ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } }
            : {}),
          generationConfig: {
            temperature: opts.temperature ?? 0.4,
            maxOutputTokens: opts.maxOutputTokens ?? 512,
            responseMimeType: 'application/json',
            responseSchema: opts.schema,
            ...(canDisableThinking(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
        signal: AbortSignal.timeout(env.GEMINI_TIMEOUT_MS),
      });

      const json = (await res.json()) as GenerateContentResponse;

      if (!res.ok) {
        // 429 is the free tier's per-minute cap — expected, and not an error worth alarming on.
        log[res.status === 429 ? 'info' : 'warn'](
          { status: res.status, model, message: json.error?.message },
          res.status === 429
            ? 'gemini rate limited — using deterministic copy'
            : 'gemini request failed',
        );
        return { result: null, retryable: res.status >= 500 };
      }

      const candidate = json.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text.trim()) {
        // MAX_TOKENS here means the JSON was cut mid-object and cannot be parsed. Retrying would
        // truncate at the same place, so this one is final.
        log.warn({ model, finishReason: candidate?.finishReason }, 'gemini returned no usable text');
        return { result: null, retryable: false };
      }

      const parsed = JSON.parse(text) as T;
      log.debug(
        { model, ms: Date.now() - started, tokens: json.usageMetadata?.totalTokenCount },
        'gemini ok',
      );
      return { result: parsed, retryable: false };
    } catch (err) {
      // AbortSignal.timeout rejects with TimeoutError; JSON.parse throws SyntaxError.
      const name = err instanceof Error ? err.name : 'Error';
      log.warn({ err, name, model, ms: Date.now() - started }, 'gemini call failed — falling back');
      // A timeout already consumed the whole budget; retrying would double a wait the caller
      // declared too long. Network blips (fetch TypeError) are worth one more try.
      return { result: null, retryable: name === 'TypeError' };
    }
  },
};
