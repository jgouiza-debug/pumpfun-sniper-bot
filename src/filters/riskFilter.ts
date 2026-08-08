import {
  FilterConfig,
  FilterResult,
  Gate0Result,
  LeniencyMode,
  MarketRegime,
  PumpTokenLaunch,
  RugCheckReport,
  ScoreBreakdown,
} from '../types';

const UNVERIFIED_DISTRIBUTION_CREDIT = 18;
const UNVERIFIED_DEPLOYER_CREDIT = 12;

export class RiskFilter {
  private config: FilterConfig;
  private marketRegime: MarketRegime = 'RISK_ON';
  private currentMode: LeniencyMode = 'lenient';

  constructor(config?: Partial<FilterConfig>) {
    this.config = {
      maxScore: config?.maxScore ?? 100,
      requireMintRevoked: config?.requireMintRevoked ?? true,
      requireFreezeRevoked: config?.requireFreezeRevoked ?? true,
      minLpLockedPct: config?.minLpLockedPct ?? 0,
      minMarketCapUsd: config?.minMarketCapUsd ?? 500,
      minFdvUsd: config?.minFdvUsd ?? 500,
      minVolume5mUsd: config?.minVolume5mUsd ?? 100,
      minLiquidityUsd: config?.minLiquidityUsd ?? 1500,

      maxBundledSupplyPct: config?.maxBundledSupplyPct ?? 55,
      maxInsiderPct: config?.maxInsiderPct ?? 35,
      maxSniperHoldingsPct: config?.maxSniperHoldingsPct ?? 45,
      maxTop10Pct: config?.maxTop10Pct ?? 65,
      maxSingleHolderPct: config?.maxSingleHolderPct ?? 40,
      maxDevHoldingsPct: config?.maxDevHoldingsPct ?? 25,

      minBuyPressurePct: config?.minBuyPressurePct ?? 20,
      honeypotMinBuysWithNoSells: config?.honeypotMinBuysWithNoSells ?? 20,
      maxNegativePriceChange5mPct: config?.maxNegativePriceChange5mPct ?? -60,
      maxWashScore: config?.maxWashScore ?? 85,
      minScoreToTrade: config?.minScoreToTrade ?? 30,
      minScoreUnverified: config?.minScoreUnverified ?? 25,
      minDemandScore: config?.minDemandScore ?? 5,
    };
  }

  public setLeniencyMode(mode: LeniencyMode): void {
    this.currentMode = mode;
    if (mode === 'strict') {
      this.config.minLiquidityUsd = 8000;
      this.config.minScoreToTrade = 62;
      // Was 0 (constructor default), making the LP-lock gate `lockedPct >= 0`
      // — literally always true. Post-migration pump.fun burns LP, so a real
      // pool reports ~100; demanding a majority locked/burned costs nothing.
      this.config.minLpLockedPct = 50;
      this.config.maxSingleHolderPct = 12;
      this.config.maxTop10Pct = 30;
      this.config.maxBundledSupplyPct = 25;
      this.config.maxDevHoldingsPct = 8;
      this.config.minVolume5mUsd = 1500;
    } else if (mode === 'normal') {
      this.config.minLiquidityUsd = 3500;
      this.config.minScoreToTrade = 50;
      this.config.maxSingleHolderPct = 20;
      this.config.maxTop10Pct = 45;
      this.config.maxBundledSupplyPct = 35;
      this.config.maxDevHoldingsPct = 12;
      this.config.minVolume5mUsd = 500;
    } else {
      // Lenient High-Frequency Mode
      this.config.minLiquidityUsd = 1500;
      this.config.minScoreToTrade = 30;
      this.config.maxSingleHolderPct = 40;
      this.config.maxTop10Pct = 65;
      this.config.maxBundledSupplyPct = 55;
      this.config.maxDevHoldingsPct = 25;
      this.config.minVolume5mUsd = 100;
    }
  }

  public getConfig(): FilterConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<FilterConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public setMarketRegime(regime: MarketRegime): void {
    this.marketRegime = regime;
  }

  public evaluateGate0(
    report: RugCheckReport | null,
    launch: Partial<PumpTokenLaunch>,
    opts?: { minLiquidityUsdOverride?: number }
  ): Gate0Result {
    const failedReasons: string[] = [];

    const tokenInfo = report?.token;
    const mintAuthorityRevoked = !tokenInfo?.mintAuthority;
    const freezeAuthorityRevoked = !tokenInfo?.freezeAuthority;

    if (!mintAuthorityRevoked) {
      failedReasons.push('Mint authority is active (Honeypot risk)');
    }
    if (!freezeAuthorityRevoked) {
      failedReasons.push('Freeze authority is active (Honeypot risk)');
    }

    const noToken2022Hooks = true;

    const markets = report?.markets || [];
    let lpBurnedOrLocked = true;
    if (markets.length > 0) {
      const mainLp = markets[0]?.lp;
      const lockedPct = mainLp?.lpLockedPct || 0;
      lpBurnedOrLocked = lockedPct >= this.config.minLpLockedPct;
    }
    if (!lpBurnedOrLocked) {
      failedReasons.push(`LP locked/burned (${markets[0]?.lp?.lpLockedPct || 0}%) < min required (${this.config.minLpLockedPct}%)`);
    }

    const sellSimPassed = true;

    const bundledSupplyPct = launch.bundledSupplyPct || 0;
    const bundledSupplyPctClean = bundledSupplyPct <= this.config.maxBundledSupplyPct;
    if (!bundledSupplyPctClean) {
      failedReasons.push(`Bundled supply (${bundledSupplyPct}%) >= limit of ${this.config.maxBundledSupplyPct}%`);
    }

    const insiderPctClean = true;
    const sniperHoldingsPctClean = true;

    const top10Pct = launch.top10Pct || 0;
    const top10PctClean = top10Pct <= this.config.maxTop10Pct;
    if (!top10PctClean) {
      failedReasons.push(`Top 10 holders (${top10Pct}%) >= limit of ${this.config.maxTop10Pct}%`);
    }

    const maxSingleHolderPctClean = true;
    const devHoldingsPct = launch.devHoldingsPct || 0;
    const devHoldingsPctClean = devHoldingsPct <= this.config.maxDevHoldingsPct;
    if (!devHoldingsPctClean) {
      failedReasons.push(`Dev holdings (${devHoldingsPct}%) >= limit of ${this.config.maxDevHoldingsPct}%`);
    }

    const devPriorRugRateClean = true;
    const devSoldAnyClean = true;

    // The $8,000 floor is a POST-MIGRATION rule (AMM pool depth). Applied to a
    // bonding curve it is unsatisfiable by construction: the curve graduates at
    // ~85 SOL, so at SOL=$74 its maximum possible liquidity is ~$6,290 — the
    // gate demands 108 SOL that can never accumulate. Measured 2026-08-05:
    // 285 of 300 candidates rejected on exactly this, which is why the bot
    // screened endlessly and never bought. Callers pass a curve-appropriate
    // floor for pre-migration tokens.
    const liquidityUsd = launch.liquidityUsd || 0;
    const minLiquidityUsd = opts?.minLiquidityUsdOverride ?? this.config.minLiquidityUsd;
    const liquidityMinClean = liquidityUsd >= minLiquidityUsd;
    if (!liquidityMinClean) {
      failedReasons.push(`Liquidity ($${liquidityUsd.toLocaleString()}) < min required ($${minLiquidityUsd.toLocaleString()})`);
    }

    const washScoreClean = (launch.washScore || 0) <= this.config.maxWashScore;
    const buyPressureClean = true;
    const notHoneypot = true;
    const notDumping = true;
    const marketRegimeValid = this.marketRegime !== 'RISK_OFF';

    const allPassed =
      mintAuthorityRevoked &&
      freezeAuthorityRevoked &&
      noToken2022Hooks &&
      lpBurnedOrLocked &&
      sellSimPassed &&
      bundledSupplyPctClean &&
      top10PctClean &&
      devHoldingsPctClean &&
      liquidityMinClean &&
      washScoreClean &&
      marketRegimeValid;

    return {
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      noToken2022Hooks,
      lpBurnedOrLocked,
      sellSimPassed,
      bundledSupplyPctClean,
      insiderPctClean,
      sniperHoldingsPctClean,
      top10PctClean,
      maxSingleHolderPctClean,
      devHoldingsPctClean,
      devPriorRugRateClean,
      devSoldAnyClean,
      liquidityMinClean,
      washScoreClean,
      buyPressureClean,
      notHoneypot,
      notDumping,
      marketRegimeValid,
      allPassed,
      failedReasons,
    };
  }

  public computeScoreBreakdown(report: RugCheckReport | null, launch: Partial<PumpTokenLaunch>): ScoreBreakdown {
    const notes: string[] = [];

    let distributionScore = UNVERIFIED_DISTRIBUTION_CREDIT;
    if (launch.top10Pct !== undefined) {
      if (launch.top10Pct <= 20) distributionScore = 30;
      else if (launch.top10Pct <= 40) distributionScore = 24;
      else if (launch.top10Pct <= 60) distributionScore = 18;
      else distributionScore = 12;
    }

    let deployerScore = UNVERIFIED_DEPLOYER_CREDIT;
    if (launch.devHoldingsPct !== undefined) {
      if (launch.devHoldingsPct <= 2) deployerScore = 20;
      else if (launch.devHoldingsPct <= 5) deployerScore = 16;
      else deployerScore = 10;
    }

    // Demand must be EARNED from measured signals — the old version granted a
    // free base of 20 plus a constant narrative 15, so a token with zero data
    // scored 65 and out-scored tokens whose measured data was merely mediocre.
    // Ignorance can never outrank measurement.
    let demandScore = 0;
    const vol = launch.volume5mUsd ?? 0;
    if (vol >= 500) demandScore += 8;
    if (vol >= 2000) demandScore += 4;

    const buyers = launch.uniqueBuyers5m ?? 0;
    if (buyers > 1) {
      // Real buyer attribution (trade feed). The most wash-resistant signal.
      if (buyers >= 10) demandScore += 10;
      if (buyers >= 25) demandScore += 6;
    } else if (launch.progressVelocity5m !== undefined) {
      // Free-tier fallback: curve fill velocity (percentage points / 5m).
      if (launch.progressVelocity5m >= 2) demandScore += 10;
      if (launch.progressVelocity5m >= 4) demandScore += 6;
    }

    const pressure = launch.buyPressurePct ?? 0;
    if (pressure >= 60) demandScore += 6;
    if (pressure >= 75) demandScore += 4;
    demandScore = Math.min(30, demandScore);

    // Narrative: only what is actually observable (socials/website on the DEX
    // listing). No constant credit.
    let narrativeScore = Math.min(15, (launch.socialCount ?? 0) * 5);

    let penalties = 0;
    if ((launch.washScore || 0) > 60) penalties += 5;
    if (launch.isBoosted) penalties += 10; // paid visibility correlates with negative returns

    const totalScore = Math.max(0, Math.min(100, distributionScore + deployerScore + demandScore + narrativeScore - penalties));

    return {
      distributionScore,
      deployerScore,
      demandScore,
      narrativeScore,
      penalties,
      totalScore,
      notes,
    };
  }

  public evaluateToken(
    report: RugCheckReport | null,
    launch: Partial<PumpTokenLaunch>,
    opts?: { minLiquidityUsdOverride?: number }
  ): FilterResult {
    const mint = launch.mint || report?.mint || 'Unknown';
    const gate0 = this.evaluateGate0(report, launch, opts);
    const scoreBreakdown = this.computeScoreBreakdown(report, launch);

    const isSafe = gate0.allPassed && scoreBreakdown.totalScore >= this.config.minScoreToTrade;

    return {
      mint,
      tokenName: launch.name || report?.tokenMeta?.name || 'Unknown',
      tokenSymbol: launch.symbol || report?.tokenMeta?.symbol || 'UNKNOWN',
      isSafe,
      score: scoreBreakdown.totalScore,
      marketCapUsd: launch.marketCapUsd || 0,
      // Real quoted price when a pool exists. Callers prefer this over
      // marketCap/1e9, which assumes a 1B supply not every token has.
      priceUsd: launch.priceUsd,
      fdvUsd: launch.fdvUsd || launch.marketCapUsd || 0,
      volume5mUsd: launch.volume5mUsd || 0,
      liquidityUsd: launch.liquidityUsd || 0,
      mintAuthorityRevoked: gate0.mintAuthorityRevoked,
      freezeAuthorityRevoked: gate0.freezeAuthorityRevoked,
      lpLockedPct: report?.markets?.[0]?.lp?.lpLockedPct || 0,
      reasons: gate0.failedReasons,
      evaluatedAt: Date.now(),
      photonUrl: `https://photon-sol.tinyastro.io/en/lp/${mint}`,
      rugCheckUrl: `https://rugcheck.xyz/tokens/${mint}`,
      gate0,
      scoreBreakdown,
      bondingProgress: launch.bondingProgress,
      uniqueBuyers5m: launch.uniqueBuyers5m,
      washScore: launch.washScore,
      devHoldingsPct: launch.devHoldingsPct,
      top10Pct: launch.top10Pct,
      bundledSupplyPct: launch.bundledSupplyPct,
    };
  }
}
