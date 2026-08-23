export interface PumpTokenLaunch {
  mint: string;
  /**
   * Venue the token actually trades on, straight from the migration payload
   * (measured: 77x "pump-amm", 1x "raydium-cpmm" over 78 graduations).
   * Routing a freshly graduated token as "auto" resolves to the bonding curve
   * before the indexer catches up, and the buy dies with BondingCurveComplete.
   */
  pool?: string;
  name: string;
  symbol: string;
  description?: string;
  imageUri?: string;
  metadataUri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  creator: string;
  /**
   * Creator as reported by RugCheck. A fallback for migration payloads, which
   * carry no creator field at all — measured across all 178 recorded migrations.
   */
  rugCreator?: string;
  timestamp: number;
  initialBuy?: number;
  marketCapSol?: number;
  usdMarketCap?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  liquidityUsd?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  bondingProgress?: number;
  ageSeconds?: number;
  pairAgeSeconds?: number;
  bundledSupplyPct?: number;
  top10Pct?: number;
  devHoldingsPct?: number;
  washScore?: number;
  uniqueBuyers5m?: number;
  /** Curve progress gained over the trailing 5 min (pp) — free-tier demand signal. */
  progressVelocity5m?: number;
  priceUsd?: number;
  buys5m?: number;
  sells5m?: number;
  buyPressurePct?: number;
  priceChange5mPct?: number;
  priceChange1hPct?: number;
  turnover5m?: number;
  socialCount?: number;
  isBoosted?: boolean;
  hasLiveMarketData?: boolean;
  /**
   * True when `liquidityUsd` is the ~158-SOL migration ASSERTION rather than a
   * reading. DexScreener needs minutes to index a fresh pool, so at decision
   * time this is asserted for roughly every migration — which makes it the most
   * dangerous number in the payload if anything mistakes it for a measurement.
   * Never let a threshold treat an asserted value as evidence.
   */
  liquidityIsAsserted?: boolean;
}

export interface RugCheckRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: 'danger' | 'warn' | 'info' | string;
}

export interface RugCheckTopHolder {
  address?: string;
  owner?: string;
  pct: number;
  insider?: boolean;
}

export interface RugCheckReport {
  mint: string;
  score: number;
  token?: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    supply: number | string;
    decimals: number;
  };
  tokenMeta?: {
    name: string;
    symbol: string;
    uri: string;
  };
  risks?: RugCheckRisk[];
  markets?: Array<{
    lp?: {
      lpLocked: number;
      lpLockedPct: number;
      lpLockedUSD: number;
    };
  }>;
  totalMarketLiquidity?: number;
  totalLPPercent?: number;
  fileMeta?: any;
  topHolders?: RugCheckTopHolder[];
  isInferred?: boolean;
}

export interface FilterConfig {
  maxScore: number;
  maxWashScore: number;
  minScoreToTrade: number;
  minScoreUnverified: number;
  minDemandScore: number;
  minBuyPressurePct: number;
  honeypotMinBuysWithNoSells: number;
  maxNegativePriceChange5mPct: number;
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  minLpLockedPct: number;
  minMarketCapUsd: number;
  minFdvUsd: number;
  minVolume5mUsd: number;
  minLiquidityUsd: number;
  maxBundledSupplyPct: number;
  maxInsiderPct: number;
  maxSniperHoldingsPct: number;
  maxTop10Pct: number;
  maxSingleHolderPct: number;
  maxDevHoldingsPct: number;
}

/**
 * Gate 0 — MEASURED CHECKS ONLY.
 *
 * Ten fields used to live here that were assigned a literal `true` and never
 * computed: noToken2022Hooks, sellSimPassed, insiderPctClean,
 * sniperHoldingsPctClean, maxSingleHolderPctClean, devPriorRugRateClean,
 * devSoldAnyClean, buyPressureClean, notHoneypot, notDumping. They rendered as
 * ten green checkmarks in the dashboard and three of them were counted into
 * `allPassed`, which is what made "Gate 0 all passed" mean nothing — and what
 * let a score-based override treat that phrase as a safety verdict.
 *
 * They are gone rather than defaulted. A check that is not performed must not
 * have a field, because a field invites a checkmark.
 */
export interface Gate0Result {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  bundledSupplyPctClean: boolean;
  top10PctClean: boolean;
  devHoldingsPctClean: boolean;
  liquidityMinClean: boolean;
  washScoreClean: boolean;
  /** RugCheck's own aggregate risk score is within the configured ceiling. */
  rugcheckScoreClean?: boolean;
  marketRegimeValid: boolean;
  allPassed: boolean;
  failedReasons: string[];
}

export interface ScoreBreakdown {
  distributionScore: number;
  deployerScore: number;
  demandScore: number;
  narrativeScore: number;
  penalties: number;
  totalScore: number;
  notes?: string[];
}

export interface FilterResult {
  mint: string;
  tokenName: string;
  tokenSymbol: string;
  isSafe: boolean;
  score: number;
  marketCapUsd: number;
  fdvUsd: number;
  volume5mUsd: number;
  liquidityUsd: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpLockedPct: number;
  reasons: string[];
  evaluatedAt: number;
  photonUrl: string;
  rugCheckUrl: string;
  gate0?: Gate0Result;
  scoreBreakdown?: ScoreBreakdown;
  bondingProgress?: number;
  uniqueBuyers5m?: number;
  washScore?: number;
  devHoldingsPct?: number;
  top10Pct?: number;
  bundledSupplyPct?: number;
  priceUsd?: number;
  buyPressurePct?: number;
  priceChange5mPct?: number;
  turnover5m?: number;
  hasLiveMarketData?: boolean;
  dataVerified?: boolean;
}

export type PlaybookType = 'PLAY_1' | 'PLAY_2' | 'PLAY_3' | 'PLAY_4' | 'PLAY_5';
export type LeniencyMode = 'strict' | 'normal' | 'lenient';

export interface BotConfig {
  isBotActive: boolean;
  tradingMode: 'paper' | 'real';
  leniencyMode: LeniencyMode;
  activePlaybook: PlaybookType | 'ALL';
  buyAmountSol: number;
  /**
   * Spends 100% of deployable Photon wallet balance on every entry without budget caps,
   * conviction skipping, or breakeven ceilings.
   */
  allInSizing?: boolean;
  /**
   * Split the run's deployable balance into `maxActivePositions` equal slots at
   * arm time, and stake one slot per entry, instead of using the fixed
   * `buyAmountSol`. The budget is fixed for the run, so a slot that goes to zero
   * costs 1/N and does not shrink the others.
   */
  walletSplitSizing: boolean;
  /**
   * Reduce the slot count when the wallet cannot fund `maxActivePositions`
   * slots that each clear `maxBreakevenPct`. Fixed fees dominate at small size,
   * so splitting a small balance further makes every slot uneconomic and the
   * bot refuses every trade. Turning this OFF means an underfunded wallet
   * simply never trades rather than trading with less diversification.
   */
  autoFitSlotsToWallet?: boolean;
  takeProfitPct: number;
  takeProfitRung2Pct: number;
  /**
   * Peak multiple a position must reach before the trailing stop arms at all.
   * There is deliberately NO price stop-loss on this bot: on pump.fun a 20-35%
   * drawdown is noise, not a trend break, and a stop that fires inside the
   * entry band converts ordinary volatility into a realized loss. The loss side
   * is handled by structural exits (creator sell, curve/pool drain, sell-flow
   * collapse) and the time stop. See exit ladder in sniperEngine.
   */
  trailingArmMultiple: number;
  useTrailingStop: boolean;
  trailingStopPct: number;
  maxHoldSeconds: number;
  /**
   * Leave a position that has had NO usable market data this many seconds after
   * entry. Not a price stop — it never reads a price, only whether a market
   * exists. Covers the fresh-migration window where an unindexed pool leaves the
   * structural exits blind and the only fallback is maxHoldSeconds.
   */
  noDataExitSeconds?: number;
  // --- Exit policy: which automatic sells are allowed to fire ---
  //
  // Every loss-side exit is a switch the owner sets, not a policy baked into
  // the engine. Between 2026-08-12 and 2026-08-13 all of them were deleted
  // outright, which meant a position that rugged had exactly one exit — the
  // owner noticing. The switches restore the choice without taking it back:
  // turn any of these off and the bot goes back to warning and holding.
  //
  // The thresholds they act on are the existing fields above
  // (poolDrainExitFraction, sellFlowExitTicks, maxHoldSeconds,
  // noDataExitSeconds), which until now only tuned log lines.
  /** Sell 100% when pool liquidity drains past poolDrainExitFraction of peak. */
  exitOnPoolDrain?: boolean;
  /** Sell 50%, then 100%, after sellFlowExitTicks ticks of collapsed buy pressure. */
  exitOnSellFlowCollapse?: boolean;
  /** Sell 100% when the creator dumps (needs the devSellStop flag for detection). */
  exitOnDevSell?: boolean;
  /** Sell 100% when the post-buy sell simulation reverts (needs honeypotChecks). */
  exitOnHoneypot?: boolean;
  /** Sell 100% once the position is older than maxHoldSeconds. */
  exitOnMaxHold?: boolean;
  /** Sell 100% when no market data has appeared noDataExitSeconds after entry. */
  exitOnNoData?: boolean;
  /**
   * Sell 100% at a fixed drawdown from the verified fill price. OFF by owner
   * decision: on pump.fun a 20-35% dip is noise, and a stop inside the entry
   * band converts ordinary volatility into a realized loss. The structural
   * exits above cut rugs on evidence instead of on price.
   */
  exitOnPriceStop?: boolean;
  /** Drawdown percentage for the price stop. Only read when exitOnPriceStop. */
  stopLossPct?: number;
  /** Give up automatic retries of a forced exit after this many attempts. */
  maxForceExitAttempts?: number;
  /**
   * Refuse new entries once the launch feed has been silent for this many slots
   * (~400ms each). 0 disables. Trading on state of unknown age is worse than
   * not trading.
   */
  maxFeedStaleSlots?: number;
  /** Max entry ATTEMPTS per rolling hour. Counts attempts, not fills, because
   *  a failed attempt still pays its fee. 0 disables. */
  maxEntriesPerHour?: number;
  /** Trip the breaker after this many consecutive transactions fail to land. */
  maxConsecutiveTxFailures?: number;
  /**
   * Ceiling on the fraction of the deployable balance the run may commit across
   * all slots. Without it, wallet-split sizing deploys ~100% of the wallet.
   */
  maxDeployedFractionPct?: number;
  /** Pause new entries after this many consecutive losing trades. */
  maxConsecutiveLosses?: number;
  /** Realized loss (USD) in a rolling 24h that pauses the bot. */
  maxDailyLossUsd?: number;
  // --- Rug screening (every check on/off + threshold, no hardcoded numbers) ---
  /**
   * Reject when market cap exceeds this multiple of pool liquidity. A genuine
   * pump.fun graduation is ~5:1; a thin pool under a large notional is trivially
   * manipulable and cannot be exited at the quoted price. 0 disables.
   * Only applied when liquidity is MEASURED, never against an asserted number.
   */
  maxMcapToLiquidityRatio?: number;
  /** Milliseconds after a fill before the real sell simulation runs. */
  sellSimDelayMs?: number;
  /** Minimum RugCheck holder rows before concentration counts as measured. */
  minHolderSample?: number;
  /** Minimum total holders before concentration counts as measured. */
  minTotalHolders?: number;
  /** Reject above this RugCheck aggregate risk score. */
  maxRugcheckScore?: number;
  /** Reject when LP burned+locked is below this percentage. 0 disables. */
  minLpBurnedOrLockedPct?: number;
  /** Exit when pool liquidity falls to this fraction of its observed peak. */
  poolDrainExitFraction?: number;
  /** Exit after this many consecutive ticks of collapsed buy pressure. */
  sellFlowExitTicks?: number;
  // --- Launch snipe (Play 1, flag launchSnipe) ---
  /**
   * Real SOL (beyond the creator's own initial buy) that must flow into a fresh
   * curve before the snipe fires. 0 fires the instant the create event arrives —
   * pure block-0 entry with no confirmation at all. Momentum confirmation costs
   * a few seconds but skips the launches nobody else buys.
   */
  launchSnipeMinSolInflow?: number;
  /** Seconds after creation the snipe stays armed. Past this the token falls back to the normal Play 2 watchlist path. */
  launchSnipeWindowSeconds?: number;
  /** Skip launches whose creator initial buy exceeds this (dev owns the curve — their dump is the exit). */
  launchSnipeMaxDevBuySol?: number;
  /** Skip launches whose creator initial buy is below this (zero-commitment spam). 0 disables. */
  launchSnipeMinDevBuySol?: number;
  maxActivePositions: number;
  priorityFeeSol: number;
  /** Hard ceiling for the dynamic priority fee (flag dynamicPriorityFee). */
  maxPriorityFeeSol?: number;
  /** Buy-side slippage tolerance. Deliberately tighter than the sell side. */
  maxSlippagePct: number;
  /**
   * Sell-side tolerance, floored at maxSlippagePct. Exits may pay more than
   * entries: a missed buy costs nothing, an unsellable bag has no upper bound.
   * One capped retry on a 6004; buys never escalate at all.
   */
  maxSellSlippagePct?: number;
  /** Rolling-hour realized loss (USD) that trips the kill switch (flag killSwitch). */
  maxHourlyLossUsd?: number;
  /** Round-trip cost guideline as % of position size (flag enforceTradeEconomics). Advisory: entries above it warn but still trade. */
  maxBreakevenPct?: number;
  solPriceUsd: number;
  privateKey?: string;
  heliusApiKey?: string;
  /**
   * PumpPortal Data API key, per user, entered in Settings.
   *
   * Trading does NOT need this: `/api/trade-local` builds an unsigned
   * transaction for anyone and charges 0.5% per side. What the key buys is the
   * TRADE STREAM. Measured 2026-08-05, `subscribeTokenTrade` replies "only
   * available when connecting with an API key funded with at least 0.02 SOL"
   * and delivers zero events without one — which is why unique-buyer counts,
   * buy-pressure, Play 2 (the only entry that buys before the crowd) and the
   * creator-dump stops are all inert on the free tier.
   *
   * Per-user by design: it is funded with the holder's own SOL, so it must
   * never be baked into a shared build.
   */
  pumpPortalApiKey?: string;
  // --- Status-only mirrors. Never sent by the UI; set by getStatus() so the
  // dashboard can show whether a key exists without the key itself being
  // broadcast on every poll. ---
  heliusApiKeySet?: boolean;
  heliusApiKeyHint?: string;
  /**
   * Where the live key came from: 'stored' is the one saved from Settings
   * (.api-keys.json), 'env' is HELIUS_API_KEY / .env, 'none' means the bot is
   * on the rate-limited public endpoint. Reported because a stored key
   * outranks .env, so an operator who edits .env and sees no change has to be
   * able to see why.
   */
  heliusApiKeySource?: 'stored' | 'env' | 'none';
  pumpPortalApiKeySet?: boolean;
  pumpPortalApiKeyHint?: string;
  /**
   * Write-only signal from the UI: names credentials to erase from disk.
   * Erasing needs its own field because a blank key input already means
   * "leave it alone" — the status endpoint never returns a key, so every save
   * posts the field empty.
   */
  forgetStoredKeys?: Array<'heliusApiKey' | 'pumpPortalApiKey'>;
  bankrollUsd: number;
  instanceName?: string;
  instancePort?: number;
}

export interface Position {
  id: string;
  mint: string;
  tokenName: string;
  tokenSymbol: string;
  playbook: PlaybookType;
  /**
   * Venue this position was filled on ("pump-amm", "raydium-cpmm", ...), so the
   * exit routes to the same place. Distinct from the engine's internal `pool`
   * reserves snapshot.
   */
  venue?: string;
  buyPriceUsd: number;
  currentPriceUsd: number;
  highestPriceUsd: number;
  tokensHeld: number;
  investedSol: number;
  investedUsd: number;
  entryTime: number;
  pnlPct: number;
  pnlUsd: number;
  pnlSol: number;
  status: 'OPEN' | 'PARTIAL_PROFIT' | 'CLOSED';
  /** True once any rung has banked principal. Kept for the UI and reporting. */
  principalRecovered: boolean;
  /**
   * Per-rung latches. These used to share `principalRecovered`, which made the
   * pullback rung and TP1 mutually exclusive — the first to fire consumed the
   * latch and the position took no further profit until TP2.
   */
  pullbackRungTaken?: boolean;
  tp1Taken?: boolean;
  moonbagRiding: boolean;
  autoSellReason?: string;
  score: number;
  bondingProgress?: number;
  trailingStopTargetUsd?: number;
  buyTxid?: string;
  /** True when cost basis and quantity were corrected from the on-chain fill. */
  fillVerified?: boolean;
  /**
   * Which feed produced `currentPriceUsd`. The three sources disagree by up to
   * 2x (marketCap/1e9 assumes a 1B supply), so a peak set from one source must
   * never arm a stop measured against another — the peak is re-anchored on any
   * source change.
   */
  priceSource?: 'curve' | 'dex' | 'mcap';
  /** Highest pool liquidity seen while holding — the POOL_DRAINED baseline. */
  peakLiquidityUsd?: number;
  /** Consecutive exit ticks with collapsed buy pressure (SELL_FLOW trigger). */
  lowBuyPressureTicks?: number;
  /** Consecutive trailing-stop triggers; the first sells half, the second all. */
  trailingTriggerCount?: number;
  /** Guards against two exits running concurrently for the same position. */
  exitInFlight?: boolean;
}

/**
 * Structured exit trigger. The human `exitReason` string interpolates dollar
 * amounts, so bucketing on it produced one bucket per trade — the "by exit
 * reason" table degenerated into a list. Bucket on this instead.
 */
export type ExitCode =
  | 'PULLBACK_PARTIAL'
  | 'TP1'
  | 'TP2'
  | 'TRAILING_PARTIAL'
  | 'TRAILING_FULL'
  | 'TIME_STOP'
  | 'NO_DATA_STOP'
  | 'PRICE_STOP'
  /** Entry abandoned because the fill landed far above the decision price. */
  | 'BAD_FILL'
  | 'STRUCTURAL'
  | 'HONEYPOT'
  | 'MANUAL'
  | 'PARTIAL_FILL'
  | 'UNKNOWN';

export interface TradeHistoryRecord {
  id: string;
  /**
   * The position this leg belongs to. A position sells in up to four legs, and
   * win rate computed over LEGS is not win rate: a verified run reported 9
   * positions as "15 closed, 93.3% win rate". Group by this for real numbers.
   */
  positionId?: string;
  /** 0-based index of this leg within its position. */
  legIndex?: number;
  /** Machine-readable exit trigger; bucket on this, never on exitReason. */
  exitCode?: ExitCode;
  /**
   * Fees actually paid on this leg, in USD, for REPORTING only. Distinct from
   * feeDragUsd, which is the P&L adjustment and is 0 when a real fill already
   * has the costs inside its balance deltas. Without this the report printed
   * "Fees paid $0.00" — the one line built to expose the cost stack.
   */
  feesPaidUsd?: number;
  mint: string;
  tokenName: string;
  tokenSymbol: string;
  playbook: PlaybookType;
  buyPriceUsd: number;
  sellPriceUsd: number;
  investedSol: number;
  investedUsd: number;
  pnlPct: number;
  pnlUsd: number;
  pnlSol: number;
  entryTime: number;
  exitTime: number;
  holdTimeSeconds: number;
  exitReason: string;
  feeDragUsd: number;
  /** Token quantity this leg sold. */
  tokensSold?: number;
  /**
   * Share of the position this leg actually closed, 0-1, measured from the
   * on-chain fill where available. Anything below ~0.95 is a PARTIAL exit: the
   * position is still open and holding the remainder.
   */
  fractionSold?: number;
  buyTxid?: string;
  sellTxid?: string;
  /**
   * True when pnl figures come from on-chain balance deltas of the actual
   * transactions. False/absent means quote-based estimates (always the case in
   * paper mode; in real mode only when the fill could not be read back).
   */
  fillVerified?: boolean;
}

export interface BotLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'snipe' | 'sell' | 'gate0';
  message: string;
  mint?: string;
}

export type MarketRegime = 'RISK_ON' | 'RISK_OFF';

/** A position still open when the run ended — shown in the ledger as held. */
export interface RunReportOpenPosition {
  symbol: string;
  mint: string;
  boughtAt: number;
  tokensHeld: number;
  investedUsd: number;
  currentPriceUsd: number;
  unrealizedPnlUsd: number;
  fillVerified?: boolean;
  buyTxid?: string;
}

/** End-of-run data report. Written to reports/<runId>.json and .md on stop. */
export interface RunReport {
  runId: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  tradingMode: 'paper' | 'real';
  leniencyMode: string;
  walletAddress: string | null;
  solPriceUsd: number;

  // Screening funnel
  tokensSeen: number;
  tokensPassed: number;
  tokensRejected: number;
  passRatePct: number;
  topRejectionReasons: Array<{ reason: string; count: number }>;

  // Positions
  positionsOpened: number;
  positionsClosed: number;
  positionsStillOpen: number;

  // Trades. `totalTrades` counts LEGS (the ledger lists legs); win/loss and
  // winRatePct are per POSITION, which is the only meaningful denominator — a
  // profitable position exits in more legs than a losing one, so a leg-based
  // rate is structurally inflated.
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRatePct: number;
  /** Leg-level counts, kept for reconciliation against the ledger. */
  legWinCount?: number;
  legLossCount?: number;
  /** Mean realized P&L per closed position. */
  avgPnlPerPositionUsd?: number;

  // P&L
  realizedPnlUsd: number;
  realizedPnlSol: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;

  startingBankrollUsd: number;
  endingBankrollUsd: number;
  roiPct: number;
  startingWalletSol: number;
  endingWalletSol: number;

  bestTrade: { symbol: string; pnlUsd: number; pnlPct: number; mint: string } | null;
  worstTrade: { symbol: string; pnlUsd: number; pnlPct: number; mint: string } | null;
  avgHoldSeconds: number;

  byPlaybook: Record<string, { trades: number; pnlUsd: number; wins: number }>;
  byExitReason: Record<string, { count: number; pnlUsd: number }>;

  // ---- Ground truth & ledger ----
  /** Wallet SOL change over the run. In real mode this is the truth; everything else approximates it. */
  walletDeltaSol: number;
  walletDeltaUsd: number;
  /** Closed legs whose PnL came from on-chain fills vs. quote estimates. */
  fillVerifiedLegs: number;
  estimatedLegs: number;
  /** Full per-leg ledger, persisted so the MD table can always be regenerated. */
  trades: TradeHistoryRecord[];
  /** Positions still held when the run ended. */
  openPositions: RunReportOpenPosition[];
}

/** Wallet state safe to send to the browser. Contains no secret material. */
export interface WalletStatusPublic {
  linked: boolean;
  address: string | null;
  shortAddress: string | null;
  source: 'none' | 'runtime' | 'env' | 'file';
  solBalance: number;
  usdBalance: number;
  deployableSol: number;
  lastCheckedAt: number;
  rpcHealthy: boolean;
  blockers: string[];
}

export interface BotStatusResponse {
  isBotActive: boolean;
  tradingMode: 'paper' | 'real';
  marketRegime: MarketRegime;
  bankrollUsd: number;
  grindStackUsd: number;
  moonshotStackUsd: number;
  activePositions: Position[];
  tradeHistory: TradeHistoryRecord[];
  logs: BotLogEntry[];
  /** Never carries `privateKey` — the key lives in WalletService, not config. */
  config: BotConfig;
  /** Linked Photon wallet, address and balance only. */
  wallet: WalletStatusPublic;
  /** Live snapshot of the in-progress run, or null when the bot is stopped. */
  run: Partial<RunReport> | null;
  stats: {
    totalTrades: number;
    winCount: number;
    lossCount: number;
    winRatePct: number;
    totalNetPnlUsd: number;
    totalNetPnlSol: number;
  };
  /** What the next entry would actually stake, recomputed from the live balance. */
  sizing: {
    /** Wallet balance minus the gas float. */
    deployableSol: number;
    /** Deployable minus slippage/fee headroom — the real order size. */
    nextBuySol: number;
    nextBuyUsd: number;
    /** How many entries of this size the deployable balance funds, fees included. */
    tradesAffordable: number;
    /** Round-trip cost as a % of the position — what a trade must beat to profit. */
    breakevenPct: number;
    /**
     * False when this stake's round trip exceeds the economics guideline —
     * every entry starts that far underwater. Advisory: trades still happen,
     * this only says whether they begin at a structural loss.
     */
    economicsOk?: boolean;
    /** Set only when the balance physically cannot fund a single order. */
    blockedReason?: string;
    /** Slots actually in use this run, after fitting to the wallet. */
    slots?: number;
    /** Slots requested via maxActivePositions, before economic fitting. */
    requestedSlots?: number;
    /** True when the balance forced fewer slots than requested. */
    slotsReducedForEconomics?: boolean;
  };
  /**
   * RPC and feed liveness.
   *
   * Added because "RPC is barely working" and "the feed died an hour ago" both
   * presented identically: a bot that logged nothing and bought nothing. On
   * 2026-08-13, 70.9% of candidates were discarded on a failed RPC read and the
   * launch feed went silent at 13:16 with no error — neither was visible
   * anywhere in the UI.
   */
  health?: {
    rpc: {
      ok: number;
      failed: number;
      consecutiveFailures: number;
      /** The provider is rejecting the key itself — retrying will not help. */
      credentialRejected: boolean;
      successRate: number;
      lastError: string | null;
      /**
       * Which endpoint the bot is REALLY talking to, host only — the query
       * string carries the credential and is never sent to the browser.
       *
       * Present because "valid key, RPC still down" had no diagnosis path: a
       * stale SOLANA_RPC_URL silently outranks the key and nothing reported it.
       */
      endpointHost?: string;
      endpointSource?: 'env-override' | 'helius' | 'fallback-env' | 'public';
      /** A Helius key is configured but something else won — the key is unused. */
      keyOverridden?: boolean;
    };
    feed: {
      connected: boolean;
      /** Null before the first frame of the session. */
      lastMessageAgoMs: number | null;
      reconnectAttempts: number;
    };
  };
}

export interface BotInstanceInfo {
  id: string;
  name: string;
  port: number;
  status: 'active' | 'paused';
  tradingMode: 'paper' | 'real';
  leniencyMode: LeniencyMode;
}

export interface PeriodicReportSummary {
  timestamp: number;
  intervalMinutes: number;
  totalEvaluated: number;
  passedCount: number;
  failedCount: number;
  safeTokens: FilterResult[];
}

// ---------------- COPY TRADING ----------------

/**
 * How a copy buy is sized relative to the leader's buy.
 *  - 'fixed': always stake `fixedBuySol`, regardless of the leader's size.
 *  - 'proportional': stake `proportionalPct`% of the leader's SOL amount,
 *    clamped to `maxBuySol`.
 */
export type CopyBuySizeMode = 'fixed' | 'proportional';

/**
 * What a leader sell does to the copied position.
 *  - 'mirror': sell the same fraction of holdings the leader sold, measured
 *    from the leader's post-trade balance in the stream payload (exact — the
 *    payload carries `newTokenBalance`).
 *  - 'full': any leader sell closes the whole copied position.
 */
export type CopySellMode = 'mirror' | 'full';

export interface CopyTraderConfig {
  /** Master switch — nothing is watched or traded while false. */
  enabled: boolean;
  tradingMode: 'paper' | 'real';
  buySizeMode: CopyBuySizeMode;
  fixedBuySol: number;
  /** % of the leader's SOL amount to copy when buySizeMode='proportional'. */
  proportionalPct: number;
  /** Hard per-trade ceiling in SOL, applied in both sizing modes. */
  maxBuySol: number;
  /** Ignore leader buys below this size. 0 (the default) copies EVERY buy. */
  minLeaderBuySol: number;
  copySells: boolean;
  sellMode: CopySellMode;
  maxOpenPositions: number;
  maxSlippagePct: number;
  /**
   * Skip a leader buy for a mint we already hold a copy position in. OFF by
   * default: a repeat buy ADDS to the copy position (mirroring a leader who
   * DCAs in), with the entry price re-averaged.
   */
  blockRepeatBuys: boolean;
  /** Seconds after a copied buy from a wallet before its next buy is copied. 0 = off. */
  perWalletCooldownSec: number;
  /**
   * Safety exits for copy positions, both OFF (0) by default: the copied
   * wallet's own exit is the strategy. maxHoldSeconds is a structural
   * abandon-ship timer, takeProfitPct an optional profit cap — deliberately
   * no price stop-loss, consistent with the sniper engine.
   */
  maxHoldSeconds: number;
  takeProfitPct: number;
}

/** A leader wallet being tracked, with per-wallet lifetime counters. */
export interface TrackedWalletPublic {
  address: string;
  shortAddress: string;
  nickname: string;
  enabled: boolean;
  addedAt: number;
  lastSeenAt: number | null;
  buysSeen: number;
  sellsSeen: number;
  copiedBuys: number;
  copiedSells: number;
  skippedSignals: number;
  realizedPnlUsd: number;
}

export interface CopyPosition {
  id: string;
  mint: string;
  tokenSymbol: string;
  tokenName: string;
  /** Leader wallet this position was copied from. */
  leaderWallet: string;
  leaderNickname: string;
  /** Venue from the leader's trade payload, reused for our exit routing. */
  pool?: string;
  tokensHeld: number;
  investedSol: number;
  investedUsd: number;
  entryPriceSol: number;
  currentPriceSol: number;
  pnlPct: number;
  pnlUsd: number;
  pnlSol: number;
  entryTime: number;
  buyTxid?: string;
  fillVerified?: boolean;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED';
  exitInFlight?: boolean;
}

/** One line in the live copy feed: every leader signal and what we did with it. */
export interface CopyFeedEvent {
  id: string;
  timestamp: number;
  leaderWallet: string;
  leaderNickname: string;
  mint: string;
  tokenSymbol: string;
  side: 'buy' | 'sell';
  leaderSolAmount: number;
  action: 'copied' | 'skipped' | 'failed';
  detail: string;
  copySol?: number;
  txid?: string;
  /**
   * Which feed delivered the signal: 'pumpportal' (pump.fun fast lane) or
   * 'helius' (on-chain wallet watcher — catches every venue).
   */
  via?: 'pumpportal' | 'helius';
}

/** A closed (or partially closed) copy leg — the copy page's receipt row. */
export interface CopyTradeRecord {
  id: string;
  positionId: string;
  mint: string;
  tokenSymbol: string;
  leaderWallet: string;
  leaderNickname: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokensMoved: number;
  priceSol: number;
  pnlUsd: number;
  pnlSol: number;
  pnlPct: number;
  timestamp: number;
  txid?: string;
  fillVerified?: boolean;
  exitReason: string;
}

export interface CopyStatusResponse {
  enabled: boolean;
  /** True while the PumpPortal account-trade stream is connected. */
  streamConnected: boolean;
  /**
   * True while the Helius on-chain wallet watcher holds live log
   * subscriptions for the tracked wallets. This is the feed that sees EVERY
   * buy and sell the leader makes, on any venue — PumpPortal only carries
   * pump.fun activity.
   */
  heliusConnected: boolean;
  tradingMode: 'paper' | 'real';
  config: CopyTraderConfig;
  wallets: TrackedWalletPublic[];
  positions: CopyPosition[];
  history: CopyTradeRecord[];
  feed: CopyFeedEvent[];
  solPriceUsd: number;
  /** Mirrors the engine wallet — copy real mode uses the same signer. */
  wallet: WalletStatusPublic;
  stats: {
    signalsSeen: number;
    copiedBuys: number;
    copiedSells: number;
    skippedSignals: number;
    openPositions: number;
    realizedPnlUsd: number;
    realizedPnlSol: number;
    unrealizedPnlUsd: number;
    winCount: number;
    lossCount: number;
    winRatePct: number;
  };
}
