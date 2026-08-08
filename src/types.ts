export interface PumpTokenLaunch {
  mint: string;
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
  stopLossPct: number;
  useTrailingStop: boolean;
  trailingStopPct: number;
  maxHoldSeconds: number;
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
