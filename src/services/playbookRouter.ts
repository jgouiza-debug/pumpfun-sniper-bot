/**
 * Playbook phase classification and play routing.
 * Flag: playbookRouting. Implements Parts 1.3 and 6 of TRENCH WARFARE.
 *
 * WHY (audit + owner report, 2026-08): the legacy router calls a token a
 * migration when `vSolInBondingCurve >= 70`. Virtual SOL starts at 30, so that
 * threshold trips at 40 real SOL raised — roughly 47% of the way up a curve
 * that graduates at ~85 SOL. Combined with the fabricated-liquidity gate
 * (fresh launches get $3,500 vs an $8,000 strict floor, "migrations" get
 * $12,000), the bot could ONLY ever buy tokens already 47-100% up their curve.
 *
 * The pump.fun curve rises roughly an order of magnitude from first buy to
 * graduation and is symmetric on the way down, so entering at 47%+ progress
 * means buying the crowded top of the run and eating the full reversal. That
 * is precisely the "tokens are always at the end of their life" symptom.
 *
 * This module replaces the guess with measured curve position and routes to
 * the playbook's plays with their real triggers.
 */

/** Virtual SOL seeded at creation — real SOL raised = vSol - this. */
export const VIRTUAL_SOL_BASE = 30;
/** Real SOL that must accumulate for graduation (~$69k MC). */
export const GRADUATION_SOL = 85;

export type Phase =
  | 'BLOCK_0'        // < 2 min old: insider exit window, never enter
  | 'EARLY_CURVE'    // 0-30% progress: highest rug density
  | 'MID_CURVE'      // 30-60%: Play 2 zone
  | 'LATE_CURVE'     // 60-99%: pre-stage only, do not chase
  | 'MIGRATION'      // graduation event, 0-90s: Play 3
  | 'POST_MIGRATION' // 90s-24h: Play 4
  | 'MATURE';        // > 24h: Play 5 territory only

export type Play = 'PLAY_1' | 'PLAY_2' | 'PLAY_3' | 'PLAY_4' | 'PLAY_5' | 'NONE';

/**
 * Curve position as a percentage of the way to graduation.
 * Returns null when virtual reserves are unknown — never a guess.
 */
export function bondingProgressPct(vSolInBondingCurve?: number): number | null {
  const v = Number(vSolInBondingCurve);
  if (!isFinite(v) || v <= 0) return null;
  const realSol = v - VIRTUAL_SOL_BASE;
  if (realSol < 0) return 0;
  return Math.min(100, (realSol / GRADUATION_SOL) * 100);
}

export interface PhaseInput {
  /** true only for a genuine PumpPortal migrate event. */
  isMigrationEvent: boolean;
  /** Seconds since the migration fired, when known. */
  secondsSinceMigration?: number;
  /** Seconds since token creation. */
  ageSeconds: number;
  vSolInBondingCurve?: number;
  /** True once a DEX pair exists (token has graduated). */
  hasDexPair?: boolean;
  pairAgeSeconds?: number;
}

export function classifyPhase(
  input: PhaseInput,
  /** MIGRATION->POST_MIGRATION boundary. Risk tiers widen it (strict 90s, normal 180s). */
  migrationWindowS = 90
): { phase: Phase; progressPct: number | null } {
  const progressPct = bondingProgressPct(input.vSolInBondingCurve);

  if (input.isMigrationEvent) {
    const since = input.secondsSinceMigration ?? 0;
    return { phase: since <= migrationWindowS ? 'MIGRATION' : 'POST_MIGRATION', progressPct };
  }

  // A live DEX pair means it already graduated, whatever the stream said.
  if (input.hasDexPair) {
    const pairAge = input.pairAgeSeconds;
    // Age unknown is NOT age zero. Defaulting to 0 routed pools of unknown
    // age into the MIGRATION phase's snipe window as if freshly graduated.
    // Unknown age gets the conservative classification.
    if (pairAge === undefined) return { phase: 'POST_MIGRATION', progressPct };
    if (pairAge <= migrationWindowS) return { phase: 'MIGRATION', progressPct };
    if (pairAge <= 86_400) return { phase: 'POST_MIGRATION', progressPct };
    return { phase: 'MATURE', progressPct };
  }

  // Still on the curve. Under 2 minutes we are inside the insider exit window
  // (>50% of launches are sniped in their creation block, 85% of those exit
  // within 5 minutes) — that is their trade, not ours.
  if (input.ageSeconds < 120) return { phase: 'BLOCK_0', progressPct };

  if (progressPct === null) return { phase: 'EARLY_CURVE', progressPct };
  if (progressPct < 30) return { phase: 'EARLY_CURVE', progressPct };
  if (progressPct <= 60) return { phase: 'MID_CURVE', progressPct };
  return { phase: 'LATE_CURVE', progressPct };
}

export interface RouteInput extends PhaseInput {
  score: number;
  marketCapUsd: number;
  liquidityUsd: number;
  uniqueBuyers5m?: number;
  buyPressurePct?: number;
  volume5mUsd?: number;
  /**
   * Curve progress gained over the trailing 5 minutes (percentage points).
   * The free-tier demand signal: Helius account updates reveal curve position
   * but not trader identity, so unique-buyer counts are structurally
   * unavailable (they read 0-1). Without this fallback Play 2 can never fire.
   */
  progressVelocity5m?: number;
  /** DexScreener 5m buy count — the post-migration fallback for unique buyers. */
  buys5m?: number;
  holderCount?: number;
  isBoosted?: boolean;
  /** Live SOL price, used to convert the SOL-denominated liquidity floors. */
  solPriceUsd?: number;
}

export interface RouteDecision {
  phase: Phase;
  progressPct: number | null;
  play: Play;
  eligible: boolean;
  /** 1 = full unit, 0.5 = half unit, 0 = no trade. */
  sizeMultiplier: number;
  reasons: string[];
}

export interface PlaybookConfig {
  /** Block-0 sniping: insider-dominated, disabled below a $5k bankroll. */
  enablePlay1: boolean;
  enablePlay2: boolean;
  enablePlay3: boolean;
  enablePlay4: boolean;
  minScoreFullUnit: number;
  minScoreHalfUnit: number;
  /** Play 3: past this MC the discovery window has closed. */
  play3MaxMarketCapUsd: number;
  /** Play 3: hard cancel if we could not act within this many seconds. */
  play3MaxSecondsSinceMigration: number;
  play4MaxMarketCapUsd: number;
  /**
   * Liquidity floors are denominated in SOL, not USD.
   *
   * The playbook writes "Liquidity ≥ $8k post-migration (≈30+ SOL)" — the
   * parenthetical is the real rule; $8k was simply what 30 SOL cost when it was
   * written (SOL ≈ $266). A pump.fun token graduates with ~85 SOL in its pool,
   * so at SOL = $74 that pool is worth ~$6,290 and a hardcoded $8,000 floor
   * rejects EVERY graduation — verified 2026-08-05 on TNOS and AORP, both
   * healthy at ~$6,287. A USD threshold on a SOL-denominated quantity silently
   * changes meaning every time the market moves.
   */
  play4MinLiquiditySol: number;
  minLiquiditySol: number;
  /** Play 2 trigger: minimum curve fill over the trailing 5m (percentage points). */
  play2MinVelocity5m: number;
  /** Play 2 trigger: minimum net buy pressure (% of curve flow that is buys). */
  play2MinBuyPressurePct: number;
  /** Play 2 trigger: minimum unique 5m buyers, when the feed provides attribution. */
  play2MinUniqueBuyers5m: number;
}

export const PLAYBOOK_DEFAULTS: PlaybookConfig = {
  enablePlay1: false,
  enablePlay2: true,
  enablePlay3: true,
  enablePlay4: true,
  minScoreFullUnit: 71,
  minScoreHalfUnit: 55,
  play3MaxMarketCapUsd: 250_000,
  play3MaxSecondsSinceMigration: 90,
  play4MaxMarketCapUsd: 1_000_000,
  /** Play 4 wants a deeper pool than a bare graduation: ~55 SOL. */
  play4MinLiquiditySol: 55,
  /** The playbook's "≈30+ SOL" for any Phase 4+ entry. */
  minLiquiditySol: 30,
  play2MinVelocity5m: 2,
  play2MinBuyPressurePct: 60,
  play2MinUniqueBuyers5m: 20,
};

/**
 * Owner-selected NORMAL risk tier (leniencyMode 'normal' + playbookRouting).
 * Wider score bands and windows, shallower floors. What it deliberately does
 * NOT loosen: unknown-data handling (unverified still rejects) and the mayhem
 * dev-owns-the-curve ban — those aren't risk appetite, they're anti-donation.
 */
export const PLAYBOOK_NORMAL: PlaybookConfig = {
  ...PLAYBOOK_DEFAULTS,
  minScoreFullUnit: 65,
  minScoreHalfUnit: 50,
  play3MaxMarketCapUsd: 400_000,
  // 90s is the textbook discovery window; 3 min accepts a worse entry price
  // in exchange for roughly doubling eligible graduations.
  play3MaxSecondsSinceMigration: 180,
  play4MinLiquiditySol: 40,
  minLiquiditySol: 25,
  play2MinVelocity5m: 1,
  play2MinBuyPressurePct: 55,
  play2MinUniqueBuyers5m: 15,
};

export function playbookConfigFor(mode: 'strict' | 'normal' | 'lenient'): PlaybookConfig {
  return mode === 'strict' ? PLAYBOOK_DEFAULTS : PLAYBOOK_NORMAL;
}

export function routePlay(input: RouteInput, config: PlaybookConfig = PLAYBOOK_DEFAULTS): RouteDecision {
  const { phase, progressPct } = classifyPhase(input, config.play3MaxSecondsSinceMigration);
  const reasons: string[] = [];
  const base = { phase, progressPct };
  // Fall back to a conservative SOL price rather than 0, which would make every
  // liquidity floor trivially satisfiable.
  const solPrice = input.solPriceUsd && input.solPriceUsd > 0 ? input.solPriceUsd : 150;

  const scoreTier = input.score >= config.minScoreFullUnit ? 1
    : input.score >= config.minScoreHalfUnit ? 0.5 : 0;
  if (scoreTier === 0) reasons.push(`Score ${input.score} below minimum ${config.minScoreHalfUnit}`);

  // Paid DexScreener visibility correlates with -48% average returns.
  if (input.isBoosted) reasons.push('DexScreener boosted (paid visibility, negative expectancy)');

  switch (phase) {
    case 'BLOCK_0':
      reasons.push('Inside the block-0 / insider exit window (<2 min old) — never enter');
      return { ...base, play: 'NONE', eligible: false, sizeMultiplier: 0, reasons };

    case 'EARLY_CURVE':
      reasons.push(`Early curve (${progressPct === null ? 'progress unknown' : progressPct.toFixed(0) + '%'}) — highest rug density, ~70% die here on day one`);
      return { ...base, play: 'NONE', eligible: false, sizeMultiplier: 0, reasons };

    case 'MID_CURVE': {
      if (!config.enablePlay2) { reasons.push('Play 2 disabled'); return { ...base, play: 'PLAY_2', eligible: false, sizeMultiplier: 0, reasons }; }
      if (input.ageSeconds < 600) reasons.push('Age under 10 min — instant-pump curves are usually bundled momentum');
      // Demand check. Unique buyers when the trade feed provides them (values
      // >1 mean real attribution); otherwise curve velocity — the documented
      // free-tier fallback. Velocity is weaker (cannot tell one whale from
      // twenty buyers), so the score gate below stays at full-unit strictness.
      // These read the tier config. They used to be the bare literals 2 and 60,
      // which meant NORMAL's looser play2MinVelocity5m (1) and
      // play2MinBuyPressurePct (55) were declared, documented, surfaced — and
      // silently ignored. Every Play 2 tuning experiment on the NORMAL tier was
      // therefore a no-op against the STRICT numbers.
      const buyers2 = input.uniqueBuyers5m ?? 0;
      if (buyers2 > 1) {
        if (buyers2 < config.play2MinUniqueBuyers5m) reasons.push(`Unique 5m buyers ${buyers2} < ${config.play2MinUniqueBuyers5m}`);
      } else if ((input.progressVelocity5m ?? 0) < config.play2MinVelocity5m) {
        reasons.push(`No buyer attribution and curve velocity ${(input.progressVelocity5m ?? 0).toFixed(1)}%/5m < ${config.play2MinVelocity5m}%`);
      }
      if ((input.buyPressurePct ?? 0) < config.play2MinBuyPressurePct) {
        reasons.push(`Buy pressure ${(input.buyPressurePct ?? 0).toFixed(0)}% < ${config.play2MinBuyPressurePct}%`);
      }
      const ok2 = reasons.length === 0 && scoreTier === 1;
      if (scoreTier !== 1 && reasons.length === 0) reasons.push(`Play 2 requires score >= ${config.minScoreFullUnit}`);
      return { ...base, play: 'PLAY_2', eligible: ok2, sizeMultiplier: ok2 ? 1 : 0, reasons };
    }

    case 'LATE_CURVE':
      reasons.push(`Late curve (${progressPct?.toFixed(0)}%) — migration front-running zone, crowded and symmetric on the way down. Pre-stage only, do not chase`);
      return { ...base, play: 'NONE', eligible: false, sizeMultiplier: 0, reasons };

    case 'MIGRATION': {
      if (!config.enablePlay3) { reasons.push('Play 3 disabled'); return { ...base, play: 'PLAY_3', eligible: false, sizeMultiplier: 0, reasons }; }
      const since = input.secondsSinceMigration ?? input.pairAgeSeconds ?? 0;
      if (since > config.play3MaxSecondsSinceMigration) {
        reasons.push(`${since.toFixed(0)}s past migration > ${config.play3MaxSecondsSinceMigration}s window — five minutes late is buying the top`);
      }
      if (input.marketCapUsd > config.play3MaxMarketCapUsd) {
        reasons.push(`MC $${Math.round(input.marketCapUsd).toLocaleString()} > $${config.play3MaxMarketCapUsd.toLocaleString()} — past the discovery window`);
      }
      const minLiqUsd = config.minLiquiditySol * solPrice;
      if (input.liquidityUsd < minLiqUsd) {
        reasons.push(`Liquidity $${Math.round(input.liquidityUsd).toLocaleString()} < ${config.minLiquiditySol} SOL ($${Math.round(minLiqUsd).toLocaleString()})`);
      }
      const ok3 = reasons.length === 0 && scoreTier > 0;
      return { ...base, play: 'PLAY_3', eligible: ok3, sizeMultiplier: ok3 ? scoreTier : 0, reasons };
    }

    case 'POST_MIGRATION': {
      if (!config.enablePlay4) { reasons.push('Play 4 disabled'); return { ...base, play: 'PLAY_4', eligible: false, sizeMultiplier: 0, reasons }; }
      if (input.marketCapUsd > config.play4MaxMarketCapUsd) {
        reasons.push(`MC $${Math.round(input.marketCapUsd).toLocaleString()} > $${config.play4MaxMarketCapUsd.toLocaleString()}`);
      }
      const minLiq4Usd = config.play4MinLiquiditySol * solPrice;
      if (input.liquidityUsd < minLiq4Usd) {
        reasons.push(`Liquidity $${Math.round(input.liquidityUsd).toLocaleString()} < ${config.play4MinLiquiditySol} SOL ($${Math.round(minLiq4Usd).toLocaleString()})`);
      }
      // Post-migration demand: real unique buyers when attributed, otherwise
      // DexScreener's 5m buy count (txns, not wallets — weaker but measured).
      const buyers4 = input.uniqueBuyers5m ?? 0;
      if (buyers4 > 1) {
        if (buyers4 < 25) reasons.push(`Unique 5m buyers ${buyers4} < 25`);
      } else if ((input.buys5m ?? 0) < 25) {
        reasons.push(`5m buys ${input.buys5m ?? 0} < 25 (no unique-buyer feed)`);
      }
      const ok4 = reasons.length === 0 && scoreTier > 0;
      return { ...base, play: 'PLAY_4', eligible: ok4, sizeMultiplier: ok4 ? scoreTier : 0, reasons };
    }

    case 'MATURE':
      reasons.push('Over 24h old — Play 5 (dip-buy / CTO) is moonshot-stack only and not automated');
      return { ...base, play: 'NONE', eligible: false, sizeMultiplier: 0, reasons };
  }
}

/** One-line human summary for logs and the UI. */
export function describeRoute(d: RouteDecision): string {
  const prog = d.progressPct === null ? '' : ` ${d.progressPct.toFixed(0)}% up the curve`;
  return `${d.phase}${prog} -> ${d.play}${d.eligible ? ` (BUY ${d.sizeMultiplier}u)` : ' (no trade)'}`;
}
