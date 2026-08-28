/**
 * LLM budget triage — deciding WHICH candidates are worth an API call.
 *
 * THE PROBLEM THIS SOLVES, with numbers. pump.fun emits ~18 mints/minute
 * (~26,000/day). The Gemini free tier allows 1,500 requests/day. So AT MOST
 * ~5.8% of launches can ever be screened by the model, no matter how good the
 * model is. Which 5.8% you spend the budget on therefore matters more than what
 * the model says about them. Before this file the bot had no answer: it would
 * screen whatever arrived while quota remained, i.e. a time-of-day sample.
 *
 * WHY THIS IS A RANKING AND EMPHATICALLY NOT A GATE.
 *
 * The strongest-looking entry signal in the literature — social-channel presence
 * in the metadata JSON (Telegram 0.166% -> 1.485% graduation, 8.94x; all three
 * channels 17.4x; Kamat, arXiv:2607.02823, N=832,941) — does NOT survive
 * adversarial review as a buy rule, for four reasons worth writing down so
 * nobody re-litigates them:
 *
 *   1. The outcome is wrong. It measures P(graduation), never returns. A 17.4x
 *      lift on a 0.11% base still leaves ~98% failures, and graduation is
 *      neither necessary nor sufficient for profit at an 11.1% breakeven.
 *   2. The endpoint is misstated. Corrigendum v1.3 establishes the collector
 *      had ~6 MINUTES of visibility, not 24 hours. Every rate in that paper is a
 *      fast-regime lower bound of unstated size. The author, verbatim: "We make
 *      no real-money trading or filter-deployment claims."
 *   3. Lift scales inversely with prevalence — Twitter 63.4% prevalence -> 1.53x,
 *      website 37.8% -> 1.66x, Telegram 2.43% -> 8.94x. That is the signature of
 *      a decaying RARITY proxy, not a durable causal signal.
 *   4. These are attacker-authored free strings. A telegram key costs a scammer
 *      one line of JSON. Gating on it selects precisely for creators who know it
 *      is gated. Goodhart applies immediately, and the paper never verified that
 *      a single link resolves.
 *
 * But all four objections are about spending MONEY on the signal. None touches
 * spending an API CALL on it. Under a fixed quota a false negative costs one
 * request, not capital — so a signal far too weak to trade on can still be the
 * right way to allocate a scarce screening budget. Telegram-present launches are
 * ~2.43% of flow (~633/day, inside a 1,500 RPD tier) and carry ~18.2% of
 * graduations: roughly 7.5x better graduations-per-call than sampling at the
 * same rate. That gain survives even if the causal story is entirely wrong,
 * because it is a ranking decision, not a buy decision.
 *
 * The model still decides BUY/SKIP. This only decides who gets asked.
 */

import { PumpTokenLaunch } from '../types';

export interface TriageInput {
  launch: PumpTokenLaunch;
  /** Successful bonding-curve trades observed so far. null when unknown. */
  tradeCount: number | null;
  /** Current virtual SOL in the curve (starts at 30, graduates at 115). */
  vSolInCurve: number | null;
}

export interface TriageScore {
  score: number;
  reasons: string[];
  /** Component scores, logged so the weighting can be audited offline. */
  parts: Record<string, number>;
}

/**
 * Liquidity velocity — the ONE entry-time signal that survived adversarial
 * verification at Tier A.
 *
 * Marino et al. (arXiv:2602.14860, N=655,770, 4,338 graduations): "for any fixed
 * vSol, tokens that reach that level with fewer trades exhibit substantially
 * higher graduation probabilities", and liquidity velocity "emerges as the single
 * most informative predictor of graduation among all variables considered".
 *
 * Critically it is NOT survivorship-biased: estimated over ALL tokens reaching
 * each vSol level rather than over graduates, and the conditioning variable
 * depends only on past information. The authors re-ran excluding near-instant
 * graduations and the ordering held.
 *
 * The paper publishes no numeric thresholds (the result is figure-only), so this
 * returns a normalised ratio for RANKING and deliberately hardcodes no cutoff.
 */
export function liquidityVelocity(vSolInCurve: number | null, tradeCount: number | null): number | null {
  if (vSolInCurve === null || tradeCount === null || tradeCount <= 0) return null;
  const gained = vSolInCurve - 30; // curve starts at 30 virtual SOL
  if (gained <= 0) return 0;
  return gained / tradeCount; // SOL of curve progress per trade — higher is better
}

export const TRIAGE_WEIGHTS = {
  telegram: 3.0,
  twitter: 0.5,
  website: 0.6,
  allThree: 1.5,
  description: 0.4,
  velocity: 4.0,
  curveProgress: 2.0,
};

/**
 * Score a candidate for screening priority. Higher = spend a call on it sooner.
 * Never returns a decision — there is no threshold in this file.
 */
export function triageScore(input: TriageInput): TriageScore {
  const { launch } = input;
  const parts: Record<string, number> = {};
  const reasons: string[] = [];

  const hasTg = !!launch.telegram;
  const hasTw = !!launch.twitter;
  const hasWeb = !!launch.website;

  if (hasTg) { parts.telegram = TRIAGE_WEIGHTS.telegram; reasons.push('telegram present (rarest social, 2.43% of flow)'); }
  if (hasTw) parts.twitter = TRIAGE_WEIGHTS.twitter;
  if (hasWeb) parts.website = TRIAGE_WEIGHTS.website;
  if (hasTg && hasTw && hasWeb) { parts.allThree = TRIAGE_WEIGHTS.allThree; reasons.push('all three channels'); }
  if (launch.description && launch.description.trim().length > 20) parts.description = TRIAGE_WEIGHTS.description;

  const vel = liquidityVelocity(input.vSolInCurve, input.tradeCount);
  if (vel !== null && vel > 0) {
    // Squashed so one outlier trade cannot dominate the ranking.
    parts.velocity = TRIAGE_WEIGHTS.velocity * Math.min(1, vel / 0.5);
    reasons.push(`liquidity velocity ${vel.toFixed(3)} SOL/trade`);
  }

  // Conditional graduation rises steeply with curve progress (Marino Table I:
  // vSol=30 -> 0.6%, 50 -> 10.0%, 80 -> 35.4%, 100 -> 63.8%). Worth RANKING on,
  // not worth buying on: the breakeven probability rises quadratically over the
  // same range, which is exactly why later entries are not free money.
  if (input.vSolInCurve !== null && input.vSolInCurve > 30) {
    const progress = Math.min(1, (input.vSolInCurve - 30) / 85);
    parts.curveProgress = TRIAGE_WEIGHTS.curveProgress * progress;
    reasons.push(`curve at ${(progress * 100).toFixed(1)}% to graduation`);
  }

  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score, reasons, parts };
}

/**
 * A daily screening budget with a reserved random slice.
 *
 * The random slice is not politeness — it is the control group. If the bot only
 * ever screens what the triage ranks highly, the corpus it accumulates cannot
 * measure whether the triage was right, and the ranking becomes unfalsifiable.
 * KILL-CRITERIA demands lift with a confidence interval excluding 1.0; that is
 * uncomputable without a comparison arm.
 */
export class ScreeningBudget {
  private used = 0;
  private randomUsed = 0;
  private day: string;

  constructor(
    private dailyLimit = 1400,      // headroom under a 1,500 RPD free tier
    private randomFraction = 0.15,  // control group
    day = new Date().toISOString().slice(0, 10)
  ) { this.day = day; }

  private roll(nowIso: string): void {
    if (nowIso !== this.day) { this.day = nowIso; this.used = 0; this.randomUsed = 0; }
  }

  public remaining(nowIso = new Date().toISOString().slice(0, 10)): number {
    this.roll(nowIso);
    return Math.max(0, this.dailyLimit - this.used);
  }

  public randomRemaining(nowIso = new Date().toISOString().slice(0, 10)): number {
    this.roll(nowIso);
    return Math.max(0, Math.floor(this.dailyLimit * this.randomFraction) - this.randomUsed);
  }

  public spend(kind: 'ranked' | 'random', nowIso = new Date().toISOString().slice(0, 10)): boolean {
    this.roll(nowIso);
    if (this.remaining(nowIso) <= 0) return false;
    if (kind === 'random' && this.randomRemaining(nowIso) <= 0) return false;
    this.used++;
    if (kind === 'random') this.randomUsed++;
    return true;
  }

  public stats() {
    return { day: this.day, used: this.used, randomUsed: this.randomUsed, limit: this.dailyLimit };
  }
}
