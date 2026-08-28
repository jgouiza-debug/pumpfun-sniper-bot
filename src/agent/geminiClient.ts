/**
 * Gemini decision client.
 *
 * Deliberately thin. It sends one dossier, gets one structured intent back, and
 * records what it cost and how long it took. It holds no wallet, cannot execute,
 * and its return value is a SUGGESTION — broker.ts decides whether anything
 * happens.
 *
 * MODEL CHOICE: default is a Flash-Lite class model at the lowest thinking
 * level. This is a rule-application job, not a research job. Higher thinking
 * tiers on a task like this mostly buy longer, more confident justifications for
 * the same call, at 4x the output-token bill and several extra seconds of
 * latency. If you want deep reasoning, spend it offline on the outcome corpus,
 * not per-decision in the hot path.
 *
 * PINNING: model id and thinking level are part of the policy hash. Google ships
 * fast (3.6 Flash 31 Jul 2026, 3.7 Flash 13 Aug 2026) and aliases move. Pin an
 * explicit version string; a silent upgrade mid-run invalidates the measurement
 * exactly like editing the prompt would.
 */

import { INTENT_SCHEMA, SYSTEM_PROMPT, TradeIntent, policyHash } from './schema';
import { TokenDossier, renderDossier, assertWithinBudget, estimateTokens } from './dossier';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AgentConfig {
  apiKey: string;
  /** Pin explicitly. Do not use a floating alias. */
  model: string;
  thinkingLevel: 'low' | 'medium' | 'high';
  /** Abort budget. A decision that misses this window is worthless anyway. */
  timeoutMs: number;
}

export const AGENT_DEFAULTS: Omit<AgentConfig, 'apiKey'> = {
  model: 'gemini-3.1-flash-lite',
  thinkingLevel: 'low',
  timeoutMs: 4000,
};

export interface AgentDecision {
  intent: TradeIntent | null;
  /** Why there is no intent: timeout, malformed, refused, http error. */
  failure: string | null;
  latencyMs: number;
  promptTokens: number;
  /** Includes billed thinking tokens, which are not visible in the text. */
  outputTokens: number;
  policy: string;
  model: string;
  rawText: string | null;
}

function estimateCostUsd(promptTokens: number, outputTokens: number): number {
  // Introductory Flash pricing; Flash-Lite is lower. Deliberately over-estimates.
  return (promptTokens / 1e6) * 0.75 + (outputTokens / 1e6) * 3.75;
}

export async function decide(
  dossier: TokenDossier,
  cfg: AgentConfig,
  /**
   * The agent's own book, rendered by portfolio.renderPortfolio. Optional so the
   * offline replay harness — which has no live positions — still works, but in
   * the live lane this should ALWAYS be supplied: without it the model cannot
   * see that it is about to open its fourth correlated position of the morning.
   */
  portfolioContext?: string
): Promise<AgentDecision> {
  const rendered = portfolioContext
    ? `${portfolioContext}

${renderDossier(dossier)}`
    : renderDossier(dossier);
  assertWithinBudget(rendered);

  const policy = policyHash(cfg.model, cfg.thinkingLevel);
  const started = Date.now();

  const base: AgentDecision = {
    intent: null,
    failure: null,
    latencyMs: 0,
    promptTokens: estimateTokens(SYSTEM_PROMPT) + estimateTokens(rendered),
    outputTokens: 0,
    policy,
    model: cfg.model,
    rawText: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${ENDPOINT}/${cfg.model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': cfg.apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: rendered }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: INTENT_SCHEMA,
          thinkingConfig: { thinkingLevel: cfg.thinkingLevel },
        },
      }),
    });

    base.latencyMs = Date.now() - started;

    if (!res.ok) {
      base.failure = `http_${res.status}`;
      return base;
    }

    const body: any = await res.json();
    const usage = body?.usageMetadata ?? {};
    base.promptTokens = usage.promptTokenCount ?? base.promptTokens;
    base.outputTokens =
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

    const text: string | undefined = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      base.failure = 'empty_response';
      return base;
    }
    base.rawText = text;

    let parsed: TradeIntent;
    try {
      parsed = JSON.parse(text);
    } catch {
      base.failure = 'unparseable_json';
      return base;
    }

    // Shape checks. The schema is enforced server-side, but never trust that
    // alone — this is the boundary between a remote model and a spend decision.
    if (parsed.action !== 'BUY' && parsed.action !== 'SKIP') {
      base.failure = 'bad_action';
      return base;
    }
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(parsed.conviction)) {
      base.failure = 'bad_conviction';
      return base;
    }
    if (!['SCALP', 'BALANCED', 'RUNNER'].includes(parsed.exitShape)) {
      // Not fatal: the shape is inert while shapeOverride is pinned, and an
      // unusable shape must not cost us an otherwise valid entry decision.
      parsed.exitShape = 'BALANCED';
    }

    base.intent = parsed;
    return base;
  } catch (err: any) {
    base.latencyMs = Date.now() - started;
    base.failure = err?.name === 'AbortError' ? 'timeout' : `error_${err?.message ?? 'unknown'}`;
    return base;
  } finally {
    clearTimeout(timer);
  }
}

export { estimateCostUsd };

// ---------------------------------------------------------------------------
// Position review call — the second of exactly two places the model is asked
// anything. Same pinning rules as decide(): model id and thinking level are in
// the policy hash, and any change restarts the measurement clock.
// ---------------------------------------------------------------------------

import { REVIEW_SCHEMA, REVIEW_PROMPT, ReviewIntent, isValidExit } from './positionReview';

export interface ReviewResult {
  intent: ReviewIntent | null;
  failure: string | null;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
}

export async function reviewPosition(
  rendered: string,
  cfg: AgentConfig
): Promise<ReviewResult> {
  const started = Date.now();
  const out: ReviewResult = { intent: null, failure: null, latencyMs: 0, promptTokens: 0, outputTokens: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs * 2); // reviews are off the hot path

  try {
    const res = await fetch(`${ENDPOINT}/${cfg.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: REVIEW_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: rendered }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: REVIEW_SCHEMA,
          thinkingConfig: { thinkingLevel: cfg.thinkingLevel },
        },
      }),
    });
    out.latencyMs = Date.now() - started;
    if (!res.ok) { out.failure = `http_${res.status}`; return out; }

    const body: any = await res.json();
    const usage = body?.usageMetadata ?? {};
    out.promptTokens = usage.promptTokenCount ?? 0;
    out.outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

    const text: string | undefined = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) { out.failure = 'empty_response'; return out; }

    let parsed: ReviewIntent;
    try { parsed = JSON.parse(text); } catch { out.failure = 'unparseable_json'; return out; }

    if (!['HOLD', 'RESHAPE', 'EXIT'].includes(parsed.assessment)) { out.failure = 'bad_assessment'; return out; }
    // The load-bearing check: an EXIT with no structural cause is DOWNGRADED to
    // HOLD, not honoured. The model does not get to exit on vibes.
    if (parsed.assessment === 'EXIT' && !isValidExit(parsed)) {
      out.failure = 'exit_without_cause_downgraded';
      parsed = { ...parsed, assessment: 'HOLD' };
    }
    out.intent = parsed;
    return out;
  } catch (err: any) {
    out.latencyMs = Date.now() - started;
    out.failure = err?.name === 'AbortError' ? 'timeout' : `error_${err?.message ?? 'unknown'}`;
    return out;
  } finally {
    clearTimeout(timer);
  }
}
