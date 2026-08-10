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

export interface Gate0Result {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  noToken2022Hooks: boolean;
  lpBurnedOrLocked: boolean;
  sellSimPassed: boolean;
  bundledSupplyPctClean: boolean;
  insiderPctClean: boolean;
  sniperHoldingsPctClean: boolean;
  top10PctClean: boolean;
  maxSingleHolderPctClean: boolean;
  devHoldingsPctClean: boolean;
  devPriorRugRateClean: boolean;
  devSoldAnyClean: boolean;
  liquidityMinClean: boolean;
  washScoreClean: boolean;
  buyPressureClean?: boolean;
  notHoneypot?: boolean;
  notDumping?: boolean;
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
  /** Exit when pool liquidity falls to this fraction of its observed peak. */
  poolDrainExitFraction?: number;
  /** Exit after this many consecutive ticks of collapsed buy pressure. */
  sellFlowExitTicks?: number;
  maxActivePositions: number;
  priorityFeeSol: number;
  /** Hard ceiling for the dynamic priority fee (flag dynamicPriorityFee). */
  maxPriorityFeeSol?: number;
  maxSlippagePct: number;
  /** Reserved for a future Jito bundle path — currently NOT wired to anything. */
  jitoTipSol: number;
  /** Rolling-hour realized loss (USD) that trips the kill switch (flag killSwitch). */
  maxHourlyLossUsd?: number;
  /** Max acceptable round-trip cost as % of position size (flag enforceTradeEconomics). */
  maxBreakevenPct?: number;
  solPriceUsd: number;
  privateKey?: string;
  heliusApiKey?: string;
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
  principalRecovered: boolean;
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

export interface TradeHistoryRecord {
  id: string;
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

  // Trades
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRatePct: number;

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
