import WebSocket from 'ws';
import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  BotConfig,
  BotLogEntry,
  BotStatusResponse,
  FilterResult,
  LeniencyMode,
  MarketRegime,
  PlaybookType,
  Position,
  PumpTokenLaunch,
  TradeHistoryRecord,
  ExitCode
} from '../types';
import { RiskFilter } from '../filters/riskFilter';
import { RugCheckService } from './rugcheckService';
import { DexScreenerService, DexScreenerData } from './dexscreenerService';
import { WalletService, WalletStatus } from './walletService';
import { reportService } from './reportService';
import { realModeLock } from './realModeLock';
import { ActualFill, inspectFill } from './fillInspector';
import { RunReport } from '../types';
import { featureFlags } from './featureFlags';
import { latencyTimeline } from './latencyTimeline';
import { entryGateV2 } from './entryGateV2';
import { PriorityFeeService } from './priorityFeeService';
import { localTxBuilder } from './localTxBuilder';
import { computeAgeSeconds, detectMigration, realizedPnlInWindowUsd, computeEntrySizeSol, affordableStakeSol, sellAmountParam, trailingStopTargetUsd, isPoolDrained, acceptPeakUpdate, splitWalletIntoSlots, classifyExitReason, fitSlotsToWallet, minWalletForSlots } from './pipelineUtils';
import { breakevenPct, poolFromLaunch, simulateBuy, simulateSell, PoolSnapshot } from './paperSimulator';
import { routePlay, describeRoute, RouteDecision, PLAYBOOK_DEFAULTS, PlaybookConfig, playbookConfigFor } from './playbookRouter';
import { tokenWatchlist } from './tokenWatchlist';
import { inspectMintSafety, simulateSellPath } from './honeypotDetector';
import { devSellMonitor } from './devSellMonitor';
import { CurveWatcher, CurveUpdate } from './curveWatcher';

/**
 * Minimum real SOL that must sit in a bonding curve before we will buy into it.
 * Denominated in SOL, not USD, because the curve itself is: the graduation
 * ceiling is ~85 SOL regardless of what SOL is worth that day. Play 2's 30%
 * progress requirement (~25.5 SOL) is the binding constraint in practice; this
 * is the floor that stops us touching an empty curve.
 */
const MIN_CURVE_LIQUIDITY_SOL = 10;

/** A confirmed real trade: the signature plus what it actually did on-chain. */
interface TradeResult {
  txid: string;
  /** Null when the fill could not be read back — callers keep estimates. */
  fill: ActualFill | null;
}

export interface PriceTick {
  timestamp: number;
  priceUsd: number;
}

/**
 * Exit-check cadence. Every tick is one batched DexScreener request (up to 30
 * mints), so 1s costs ~60 req/min against a 240/min bucket that reserves 60 for
 * screening — comfortably inside it, and it halves the worst-case lag between a
 * stop-loss level being breached and the sell going out.
 */
const POSITION_MONITOR_INTERVAL_MS = 1000;

/**
 * How long a log line stays in the API feed. The console wipes on a 5s cycle,
 * so anything older is never rendered — and since SSE ships the whole status
 * object on every change (up to 10x/sec), holding more just inflates every
 * frame with verbose screening chatter nobody will see.
 */
const LOG_RETENTION_MS = 12_000;

/**
 * Minimum RugCheck holder rows before a concentration reading counts as a
 * measurement. Calibrated on 46 recorded graduations (2026-08-09): genuine
 * distributions arrive with 19 rows and hundreds of total holders, while the
 * garbage readings that let rugs through had 0-1 rows.
 */
const MIN_HOLDER_SAMPLE = 5;
const MIN_TOTAL_HOLDERS = 10;

/**
 * Ceiling on RugCheck's own aggregate risk score. Across those same 46
 * graduations every cleanly distributed token scored 1; everything RugCheck
 * flagged danger-level scored 2011+. Matches EntryGateV2's existing default.
 */
const MAX_RUGCHECK_SCORE = 1000;

export interface InternalPosition extends Position {
  priceTicks?: PriceTick[];
  realizedPnlUsd: number;
  /** Curve/pool state captured at entry, so paper exits price against the same pool. */
  pool?: PoolSnapshot;
  /** Simulated costs paid so far (paper mode with honestPaper). */
  simulatedFeesSol?: number;
  /**
   * Live price derived from the bonding-curve account (vSol/vTokens), kept
   * fresh by CurveWatcher. Pre-migration tokens have no DexScreener pair, so
   * without this the position had NO working price — and therefore no
   * stop-loss or take-profit — until the 30-minute time stop.
   */
  lastCurvePriceUsd?: number;
  lastCurvePriceAt?: number;
  /** Consecutive failed real sell attempts; drives the fee-burn backoff. */
  sellFailCount?: number;
  /** Epoch ms before which no automatic sell retry may be attempted. */
  sellRetryAfterMs?: number;
  /**
   * True when the last sellPctReal returned null because the backoff was still
   * running, not because an order failed. Lets the caller stay quiet instead of
   * logging "SELL FAILED — will retry next tick" once a second for 10 minutes
   * during which no attempt is made and no retry is scheduled.
   */
  sellBlockedByBackoff?: boolean;
  /**
   * Set when a structural stop has fired. Survives a failed sell so the exit is
   * retried (forced) on every subsequent tick — the alert itself latches inside
   * DevSellMonitor and will never be raised twice.
   */
  forceExitReason?: string;
  /** Forced-exit attempts made so far; bounded by config.maxForceExitAttempts. */
  forceExitAttempts?: number;
  /** True once the stranded-position error has been logged, so it logs once. */
  strandedLogged?: boolean;
  /** When this position first had ANY usable market data. Drives the no-data exit. */
  firstMarketDataAt?: number;
  /** A full exit simulated cleanly after the fill. */
  sellPathVerified?: boolean;
  /** A full exit simulated as REVERTING — the token is a honeypot. */
  honeypotConfirmed?: boolean;
  /** Legs recorded for this position so far; drives TradeHistoryRecord.legIndex. */
  legCount?: number;
}

export class SniperEngine {
  private config: BotConfig = {
    isBotActive: false,
    tradingMode: 'paper',
    leniencyMode: 'strict',  // the only supported profile — see updateConfig
    activePlaybook: 'ALL',
    // THIS IS A FULL UNIT, NOT THE PER-TRADE STAKE.
    //
    // The router awards a HALF unit until a candidate clears minScoreFullUnit
    // (71 strict), and the maximum score observed across 3,635 real candidates
    // is 66 — so in practice every entry is sized at half of this number.
    // 0.6 here means a 0.3 SOL stake, whose round-trip cost is 5.68%, inside
    // the 6% maxBreakevenPct. The previous 0.3 sized to 0.15 => 8.37%, which
    // the economics gate refused on every single candidate.
    //
    // Fixed costs do not scale down: 0.05 SOL carries a 19.1% round trip at the
    // shipped 0.003 priority fee. Small size is fatal, not conservative.
    //
    // Wallet needed: ~0.39 SOL for one position, ~1.16 SOL for three
    // concurrent. Checked loudly at arm time by preflightRealMode().
    //
    // With walletSplitSizing on (the default) this is only a FALLBACK — the
    // real stake is one slot of the run budget. See computeRunBudget().
    buyAmountSol: 0.6,
    walletSplitSizing: true,
    autoFitSlotsToWallet: true,
    takeProfitPct: 100,
    takeProfitRung2Pct: 400,
    // NO PRICE STOP-LOSS. Removed 2026-08-09, deliberately and permanently.
    // The -35% stop it replaces fired on ordinary pump.fun volatility and
    // turned noise into realized losses; the loss side is now carried by
    // structural exits (creator sell, curve/pool drain, sell-flow collapse)
    // plus the time stop. Do not reintroduce a price floor here.
    //
    // The trailing stop survives only as a MOONBAG RATCHET: it arms at 3x, not
    // at the old 1.3x. At 1.3x arm / 20% trail the forced exit sat at 1.04x —
    // inside the round-trip breakeven (5.68% at 0.3 SOL), so the
    // "profit-protecting" stop booked losses. At 3x arm / 30% trail the
    // earliest exit is 2.1x, far above any breakeven.
    trailingArmMultiple: 3.0,
    useTrailingStop: true,
    trailingStopPct: 30,
    maxHoldSeconds: 1800,
    poolDrainExitFraction: 0.5,
    sellFlowExitTicks: 3,
    // ALL-IN, ONE POSITION AT A TIME. Owner decision 2026-08-09 for a 0.2 SOL
    // wallet: at that size fixed Solana fees are ~0.0081 SOL per round trip
    // regardless of stake, so splitting into 2 or 3 slots pushes every slot's
    // breakeven to 8.45% / 11.33% against a 6% limit and NOTHING trades.
    //
    // The cost is explicit and accepted: one rug takes the whole deployable
    // balance. The 1/N survivability property is unaffordable at this size.
    // Raise this back to 3 when the wallet reaches ~0.55 SOL.
    maxActivePositions: 1,
    // 0.001, not 0.003. At a 0.2 SOL wallet the priority fee is paid twice per
    // round trip against a ~0.15 SOL stake, so 0.003 alone adds 4.0 percentage
    // points of breakeven and pushes the only viable config (1 slot, 100%
    // deployment) from 5.67% to 8.37% — above the limit, so nothing trades.
    //
    // ACCEPTED TRADE-OFF: a 0.001 priority fee loses races on congested slots,
    // and migrations are the only entry type this bot produces. Cheaper fills
    // mean fewer fills. Raise this once the stake is large enough to absorb it.
    priorityFeeSol: 0.001,
    maxPriorityFeeSol: 0.005,
    maxSlippagePct: 25,
    jitoTipSol: 0.001,   // NOT wired to anything — reserved for a future Jito bundle path
    solPriceUsd: 200,
    bankrollUsd: 100,
    // Scaled to the actual wallet. These were 70 / 200, sized for a 1.2 SOL
    // wallet — at a ~$15 wallet with a ~$11.6 position they could NEVER fire, so
    // all three breakers were dead weight giving false assurance. A breaker that
    // cannot trip is worse than no breaker.
    //
    // At all-in sizing one full loss is roughly the whole deployable balance, so
    // these trip after essentially one wipeout rather than after three.
    maxHourlyLossUsd: 12,
    // Roughly three full-slot losses in a day, and three losers in a row. Both
    // pause NEW ENTRIES only; open positions are always retained.
    maxDailyLossUsd: 16,
    maxConsecutiveLosses: 2,
    // 100%, not 60%. At 0.2 SOL a 60% cap leaves 0.117 SOL, which stakes 0.0897
    // at a 7.51% round trip — above the limit, so nothing trades. There is no
    // reserve at this size; the reserve IS funding the wallet properly.
    // Set this back to 60 the moment the balance can carry it.
    maxDeployedFractionPct: 100,
    // Leave a position that never gets a market rather than holding it blind for
    // the full 30-minute timer. Not a price stop — it never reads a price.
    noDataExitSeconds: 180,
    maxForceExitAttempts: 20,
    // Rug screening. A genuine graduation sits near 5:1; 20:1 rejects the thin
    // pools while leaving normal graduations alone. Tune from recorded data —
    // every rejection is logged with its measured ratio.
    maxMcapToLiquidityRatio: 20,
    sellSimDelayMs: 4000,
    minHolderSample: MIN_HOLDER_SAMPLE,
    minTotalHolders: MIN_TOTAL_HOLDERS,
    maxRugcheckScore: MAX_RUGCHECK_SCORE,
    minLpBurnedOrLockedPct: 90,
    // 15 made the economics gate decorative (0.05 SOL @ 11.1% passed). 6 is
    // the audit's number: refuse any trade that needs >6% just to break even.
    maxBreakevenPct: 6,
    privateKey: '',
    // Environment only — never a literal. The comment here used to claim the
    // hardcoded fallback had been removed while the key was still sitting in
    // the expression below it. Set HELIUS_API_KEY in .env (loaded natively via
    // --env-file-if-exists) or paste a key into Settings.
    heliusApiKey: process.env.HELIUS_API_KEY || '',
  };

  private marketRegime: MarketRegime = 'RISK_ON';
  private activePositions: InternalPosition[] = [];
  private tradeHistory: TradeHistoryRecord[] = [];
  private logs: BotLogEntry[] = [];
  private ws: WebSocket | null = null;
  private monitorInterval: NodeJS.Timeout | null = null;
  private walletSyncInterval: NodeJS.Timeout | null = null;
  private riskFilter: RiskFilter;
  private rugCheckService: RugCheckService;
  private solanaConnection: Connection;
  private wallet: WalletService;

  // Real Wallet Balance State
  private liveWalletSolBalance = 0;
  private availableTradeSol = 0;

  /**
   * Stake per position for THIS run, fixed when the bot was armed by splitting
   * the deployable balance into `maxActivePositions` slots. 0 means the run was
   * armed without wallet-split sizing (or with nothing to deploy) and entries
   * fall back to config.buyAmountSol.
   */
  private runSlotStakeSol = 0;

  /**
   * Mints with an entry in flight — claimed before the first await in
   * evaluatePlaybookTrigger and released when it settles. Without this the
   * concurrency cap only counted CONFIRMED positions, which arrive up to 30s
   * after submission, so the cap was advisory across that whole window.
   */
  private entriesInFlight = new Set<string>();

  // Stats & Tracking
  private consecutiveLosses = 0;
  private dailyPnlUsd = 0;
  private peakBankrollUsd = 100;
  private currentBankrollUsd = 100;

  // Cached stats. getStatus() is polled ~every 1.5s by the UI; recomputing four
  // full passes over tradeHistory on every poll is pure waste when the history
  // only changes on a fill.
  private statsCache: BotStatusResponse['stats'] | null = null;
  private lastRunReport: RunReport | null = null;

  // Guards against overlapping monitor ticks when a batch fetch runs long.
  private monitorTickInFlight = false;

  private priorityFeeService: PriorityFeeService;
  // One kill-switch trip per pause: reset when the bot is (re)started.
  private killSwitchTripped = false;
  /** SSE/UI subscribers notified the moment state changes. See onChange(). */
  private changeListeners = new Set<() => void>();
  // Migration event arrival times, so Play 3's 90-second window is measured
  // from the real graduation rather than guessed.
  private migrationSeenAt = new Map<string, number>();
  private watchlistPruneInterval: NodeJS.Timeout | null = null;
  /**
   * Curve progress over Helius. PumpPortal's trade stream requires a funded API
   * key and delivers nothing on the free tier (verified 2026-08-05), so the
   * bonding-curve account is subscribed directly instead.
   */
  private curveWatcher: CurveWatcher;
  /** Peak real SOL seen in each held position's curve, for drain detection. */
  private curvePeakSol = new Map<string, number>();

  constructor() {
    this.riskFilter = new RiskFilter();
    this.riskFilter.setLeniencyMode(this.config.leniencyMode);

    this.rugCheckService = new RugCheckService({
      maxRetries: 2,
      retryDelayMs: 300,
      rateLimitMs: 200,
    });

    const apiKey = this.config.heliusApiKey;
    if (!apiKey) {
      this.log('error', '❌ No Helius API key configured — RPC calls will fail. Set the HELIUS_API_KEY environment variable or enter a key in Settings.');
    }
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    this.solanaConnection = new Connection(rpcUrl, 'confirmed');
    this.wallet = new WalletService(this.solanaConnection);
    this.priorityFeeService = new PriorityFeeService(() => this.solanaConnection);
    this.curveWatcher = new CurveWatcher(
      () => `wss://mainnet.helius-rpc.com/?api-key=${this.config.heliusApiKey}`,
      (u) => { void this.handleCurveUpdate(u); },
      40
    );
    if (featureFlags.get('localTxBuild') || featureFlags.get('localTxShadowCompare')) {
      localTxBuilder.start(this.solanaConnection);
    }

    this.log('info', `⚡ Smart Sniper Engine Initialized (${this.config.leniencyMode.toUpperCase()} Mode Active)`);

    // Fail loudly rather than limping along with an unusable RPC URL: without a
    // key every balance read, fill inspection and submission silently errors.
    if (!this.config.heliusApiKey) {
      this.log('error', '❌ No HELIUS_API_KEY set. Add it to .env (or paste a key in Settings) — the RPC cannot be reached without one.');
    }

    if (this.wallet.isLinked()) {
      this.log('info', `🔗 Photon wallet auto-linked from ${this.wallet.getStatus(this.config.solPriceUsd).source.toUpperCase()}: ${this.wallet.getAddress()}`);
    }

    this.startPositionMonitoring();
    this.startWalletSync();
  }

  // ---------------- WALLET ----------------

  /** Sanitized wallet state for the API. Never contains key material. */
  public getWalletStatus(): WalletStatus {
    return this.wallet.getStatus(this.config.solPriceUsd, this.minBuySol());
  }

  private minBuySol(): number {
    return Math.max(0.005, Math.min(this.config.buyAmountSol, 0.01));
  }

  /**
   * The balance this run is allowed to deploy. Real mode reads the wallet; paper
   * uses the configured bankroll so the testbed stays usable on an unfunded key.
   */
  /**
   * The balance this run may deploy — the LINKED PHOTON WALLET, in both modes.
   *
   * Paper used to size off `bankrollUsd / solPrice`, a number the operator typed
   * ($100 => ~1.3 SOL). With a 0.2 SOL wallet that made paper rehearse trades
   * 6.5x larger than the wallet could ever fund, so paper's fills, fee ratios
   * and breakeven percentages predicted nothing about real execution — the exact
   * paper-vs-real gap this codebase already fought once.
   *
   * Falls back to the configured bankroll ONLY when no wallet is linked, so the
   * testbed still runs on a machine with no key.
   */
  private deployableForSizing(): number {
    if (this.wallet.isLinked()) return this.wallet.getDeployableSol();
    return Number((this.currentBankrollUsd / (this.config.solPriceUsd || 200)).toFixed(4));
  }

  /**
   * All-in SOL one in-flight entry ties up: the stake plus its slippage buffer,
   * protocol fees, priority fee and rent. Used to discount the live balance by
   * what concurrent entries have already claimed but not yet spent on-chain.
   */
  private reservedPerEntrySol(): number {
    const stake = this.runSlotStakeSol > 0 ? this.runSlotStakeSol : this.config.buyAmountSol;
    return stake * (1 + this.config.maxSlippagePct / 100 + 0.015) + this.sizingPriorityFee() + 0.0025;
  }

  private sizingPriorityFee(): number {
    return featureFlags.get('dynamicPriorityFee')
      ? Math.max(this.config.priorityFeeSol, this.config.maxPriorityFeeSol ?? 0.005)
      : this.config.priorityFeeSol;
  }

  /**
   * Divides the run's deployable balance into `maxActivePositions` equal slots.
   *
   * Snapshotted at arm time into `runSlotStakeSol` and deliberately NOT
   * recomputed per entry: recomputing would shrink slots 2 and 3 after slot 1
   * lost money, which is the opposite of the intended risk model — three
   * independent bets, each survivable at a total loss.
   *
   * The router's conviction multiplier is NOT applied on top. A slot already IS
   * the per-trade risk unit, and halving it reintroduces the measured zero-trade
   * bug: the full-unit score band is 71 while the highest score seen across
   * 3,635 real candidates is 66, so every entry would take the half and land
   * above maxBreakevenPct. Conviction belongs in the decision to enter, not in
   * shaving an already-sized bet.
   */
  private computeRunBudget(): {
    deployableSol: number; deployedSol: number; slots: number;
    slotBudgetSol: number; stakePerSlotSol: number;
    requestedSlots: number; slotsReducedForEconomics: boolean;
  } {
    const deployableSol = this.deployableForSizing();
    const requestedSlots = Math.max(1, Math.min(this.config.maxActivePositions, 20));

    // Never commit the whole wallet. Without this ceiling the split deploys
    // ~100% of the deployable balance across its slots — on an asset class this
    // repo measures at a 60-80% rug rate, with no price stop-loss underneath it.
    // The remainder is not idle capital, it is the thing that lets a bad run end
    // with a wallet.
    const fraction = Math.min(100, Math.max(1, this.config.maxDeployedFractionPct ?? 60)) / 100;
    const deployedSol = deployableSol * fraction;
    const priorityFeeSol = this.sizingPriorityFee();

    // Fit the slot count to what the wallet can fund ECONOMICALLY. Fixed fees
    // dominate at small size, so dividing a small balance into more slots makes
    // every slot fail the breakeven gate and the bot trades nothing at all.
    // Measured on 0.2 SOL: 1 slot = 5.67%, 2 = 8.45%, 3 = 11.33% against a 6%
    // limit. Diversification you cannot afford is not diversification.
    let slots = requestedSlots;
    let slotsReducedForEconomics = false;
    if ((this.config.autoFitSlotsToWallet ?? true) && featureFlags.get('enforceTradeEconomics')) {
      const fit = fitSlotsToWallet({
        deployableSol: deployedSol,
        maxSlots: requestedSlots,
        maxSlippagePct: this.config.maxSlippagePct,
        priorityFeeSol,
        maxBreakevenPct: this.config.maxBreakevenPct ?? 6,
        breakevenOf: breakevenPct,
      });
      if (fit.slots > 0 && fit.slots < requestedSlots) {
        slots = fit.slots;
        slotsReducedForEconomics = true;
      }
    }

    const { slotBudgetSol, stakePerSlotSol } = splitWalletIntoSlots({
      deployableSol: deployedSol,
      slots,
      maxSlippagePct: this.config.maxSlippagePct,
      priorityFeeSol,
    });
    return { deployableSol, deployedSol, slots, slotBudgetSol, stakePerSlotSol, requestedSlots, slotsReducedForEconomics };
  }

  /**
   * Links a Photon wallet for live execution. The secret is handed straight to
   * WalletService and never stored on the config object, so it cannot leak back
   * out through /api/bot/status.
   */
  public async linkWallet(secret: string, persist = false): Promise<{ ok: boolean; error?: string; status: WalletStatus }> {
    const result = await this.wallet.link(secret, persist);
    if (result.ok) {
      this.log('info', `🔗 Photon wallet linked: ${this.wallet.getAddress()} | ${this.wallet.getSolBalance()} SOL (${result.status.deployableSol} SOL deployable)`);
      await this.syncLiveWalletBalance();
    } else {
      this.log('error', `❌ Wallet link failed: ${result.error}`);
    }
    return result;
  }

  /** Forces an on-chain balance re-read, for the UI refresh button. */
  public async refreshWallet(): Promise<WalletStatus> {
    await this.wallet.refreshBalance(true);
    await this.syncLiveWalletBalance();
    return this.getWalletStatus();
  }

  public unlinkWallet(deleteFile = false): WalletStatus {
    this.wallet.unlink(deleteFile);
    this.liveWalletSolBalance = 0;
    this.availableTradeSol = 0;

    if (this.config.tradingMode === 'real') {
      this.config.tradingMode = 'paper';
      this.config.isBotActive = false;
      this.unsubscribeStream();
      this.log('warn', '⚠️ Wallet unlinked while in REAL mode — bot stopped and switched to PAPER.');
    }
    this.log('info', '🔌 Photon wallet unlinked.');
    return this.getWalletStatus();
  }

  public getConfig(): BotConfig {
    return { ...this.config };
  }

  // Returns the recommended SOL buy size for a given leniency mode
  private defaultBuySolForMode(mode: LeniencyMode): number {
    // All ≥0.3 SOL: below that, fixed fees push round-trip breakeven past the
    // 6% economics gate and every entry is refused (correctly).
    if (mode === 'strict')  return 0.3;
    if (mode === 'normal')  return 0.35;
    return 0.4;
  }

  /**
   * Clamps every risk-bearing numeric field to a sane band.
   *
   * `/api/bot/config` passes `req.body` straight through with no validation of
   * any field, so a single POST could set maxActivePositions to a huge number
   * and remove the only exposure limit the bot has, or set maxSlippagePct to 100.
   * Values outside the band are corrected and logged rather than rejected, so a
   * fat-fingered UI entry degrades safely instead of failing the whole update.
   */
  private clampConfig(cfg: Partial<BotConfig>): Partial<BotConfig> {
    const out: Partial<BotConfig> = { ...cfg };
    const bands: Array<[keyof BotConfig, number, number]> = [
      ['maxActivePositions', 1, 20],
      ['maxSlippagePct', 1, 40],
      ['priorityFeeSol', 0, 0.05],
      ['maxPriorityFeeSol', 0, 0.05],
      ['maxBreakevenPct', 1, 15],
      ['buyAmountSol', 0.001, 100],
      ['takeProfitPct', 5, 100_000],
      ['takeProfitRung2Pct', 5, 1_000_000],
      ['trailingStopPct', 1, 90],
      ['trailingArmMultiple', 1.05, 100],
      ['maxHoldSeconds', 30, 86_400],
      ['noDataExitSeconds', 15, 86_400],
      ['maxDeployedFractionPct', 1, 100],
      ['poolDrainExitFraction', 0.05, 0.95],
      ['sellFlowExitTicks', 1, 600],
      ['maxHourlyLossUsd', 0, 1_000_000],
      ['maxDailyLossUsd', 0, 1_000_000],
      ['maxConsecutiveLosses', 1, 100],
      ['maxForceExitAttempts', 1, 1000],
    ];
    for (const [key, lo, hi] of bands) {
      const raw = out[key];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (!isFinite(n)) {
        this.log('warn', `⚠️ Config ${String(key)} was not a finite number — ignoring.`);
        delete out[key];
        continue;
      }
      const clamped = Math.min(hi, Math.max(lo, n));
      if (clamped !== n) {
        this.log('warn', `⚠️ Config ${String(key)}=${n} is outside the allowed range ${lo}..${hi} — clamped to ${clamped}.`);
      }
      (out as any)[key] = clamped;
    }
    return out;
  }

  public updateConfig(newConfig: Partial<BotConfig>): void {
    const wasActive = this.config.isBotActive;
    const prevMode = this.config.tradingMode;

    newConfig = this.clampConfig(newConfig);
    this.config = { ...this.config, ...newConfig };

    // Changing execution mode mid-run must go through the full start preflight
    // (wallet checks + the exclusive live lock), not slide past it via settings.
    if (wasActive && newConfig.tradingMode && newConfig.tradingMode !== prevMode) {
      this.config.isBotActive = false;
      this.unsubscribeStream();
      realModeLock.release();
      this.finishRun();
      this.log('warn', `⏸️ Trading mode changed ${prevMode.toUpperCase()} -> ${newConfig.tradingMode.toUpperCase()} mid-run. Bot stopped — press START to arm the new mode with full preflight.`);
    }

    // Risk tiers. STRICT and NORMAL are supported; NORMAL is the owner's
    // "take a bit of risk" profile (wider concentration caps, wider score
    // bands and windows). LENIENT stays locked out: 65% top-10 / 40% single
    // holder admits the exact rug shapes the last soaks measured — that is not
    // risk appetite, it is the donation tier. The lock used to force STRICT
    // because fabricated inputs made every looser tier suicidal; inputs are
    // real now.
    if (this.config.leniencyMode === 'lenient') {
      this.log('warn', '🎛️ LENIENT requested — coercing to NORMAL. Lenient caps (top10 65%, single holder 40%) admit the measured rug profile outright.');
      this.config.leniencyMode = 'normal';
    }
    this.applyRiskTier(this.config.leniencyMode);

    if (newConfig.heliusApiKey) {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${this.config.heliusApiKey}`;
      this.solanaConnection = new Connection(rpcUrl, 'confirmed');
      this.wallet.setConnection(this.solanaConnection);
      if (featureFlags.get('localTxBuild') || featureFlags.get('localTxShadowCompare')) {
        localTxBuilder.start(this.solanaConnection);
      }
      this.log('info', `🚀 Helius Dedicated RPC Engine Updated: ${rpcUrl.slice(0, 42)}...`);
    }

    // A key arriving through the config endpoint is routed into WalletService
    // and immediately scrubbed from config, so it can never be echoed back by
    // /api/bot/status (which returns the whole config object every poll).
    if (newConfig.privateKey) {
      const secret = newConfig.privateKey;
      this.config.privateKey = '';
      void this.linkWallet(secret, false);
    } else {
      this.config.privateKey = '';
    }

    this.log('info', `⚙️ Strategy Config Updated: Mode: ${this.config.tradingMode.toUpperCase()} | Leniency: ${this.config.leniencyMode.toUpperCase()} | Wallet: ${this.wallet.isLinked() ? this.wallet.getStatus(this.config.solPriceUsd).shortAddress : 'None'}`);
    this.syncLiveWalletBalance();
  }

  public toggleBot(active?: boolean): boolean {
    const newState = active !== undefined ? active : !this.config.isBotActive;

    if (newState) {
      // Preflight: refuse to arm live mode on an unusable wallet rather than
      // discovering it on the first failed buy.
      if (this.config.tradingMode === 'real') {
        if (!this.wallet.isLinked()) {
          this.log('error', '❌ Cannot start in REAL mode: no Photon wallet linked. Link one in Wallet settings first.');
          this.config.isBotActive = false;
          return false;
        }
        const blockers = this.wallet.getBlockers(this.minBuySol());
        if (blockers.length > 0) {
          this.log('error', `❌ Cannot start in REAL mode: ${blockers.join(' ')}`);
          this.config.isBotActive = false;
          return false;
        }

        // Economics preflight. Measured 2026-08-08: an 89-minute live run
        // screened 2,952 tokens, passed 102 and opened ZERO positions, because
        // every candidate was silently refused by the breakeven gate — a
        // per-token `warn` that never reaches the run report's funnel. Fail
        // loudly here instead of looking busy for an hour and trading nothing.
        const preflight = this.preflightRealMode();
        if (!preflight.ok) {
          for (const reason of preflight.reasons) this.log('error', `❌ Cannot start in REAL mode: ${reason}`);
          this.config.isBotActive = false;
          return false;
        }

        // One live instance at a time, machine-wide. Every instance signs with
        // the same wallet; two armed at once would double-spend the balance.
        // Paper instances are unlimited.
        const lock = realModeLock.acquire(
          this.config.instancePort ?? 3001,
          this.config.instanceName ?? 'Bot'
        );
        if (!lock.ok) {
          const h = lock.holder;
          this.log('error', h
            ? `❌ Cannot start in REAL mode: "${h.instanceName}" (port ${h.port}, pid ${h.pid}) is already trading live with this wallet. Stop it first, or run this instance in PAPER mode.`
            : '❌ Cannot start in REAL mode: could not acquire the live-trading lock.');
          this.config.isBotActive = false;
          return false;
        }

        this.log('info', `🔑 REAL execution armed (exclusive lock held). Wallet ${this.wallet.getAddress()} | ${this.wallet.getSolBalance()} SOL (${this.wallet.getDeployableSol()} deployable)`);
      }

      this.config.isBotActive = true;
      this.killSwitchTripped = false;

      // Carve the run budget ONCE, here. Every entry this run stakes one slot,
      // so a position that goes to zero costs exactly 1/N of the run and leaves
      // the other slots at full size.
      if (this.config.walletSplitSizing) {
        const budget = this.computeRunBudget();
        this.runSlotStakeSol = budget.stakePerSlotSol;
        if (this.runSlotStakeSol > 0) {
          const be = breakevenPct(this.runSlotStakeSol, this.config.priorityFeeSol);
          const pct = this.config.maxDeployedFractionPct ?? 60;
          const src = this.wallet.isLinked() ? 'Photon wallet' : 'configured bankroll (NO WALLET LINKED)';
          this.log('info',
            `💰 RUN BUDGET from ${src}: ${budget.deployableSol.toFixed(4)} SOL deployable, committing ${pct}% (${budget.deployedSol.toFixed(4)} SOL) across ${budget.slots} slot${budget.slots === 1 ? '' : 's'} — ` +
            `${this.runSlotStakeSol.toFixed(4)} SOL staked per position (${budget.slotBudgetSol.toFixed(4)} SOL all-in per slot, ` +
            `breakeven ${be}%). A position going to zero costs 1/${budget.slots} of the committed budget; ` +
            `${(budget.deployableSol - budget.deployedSol).toFixed(4)} SOL is held back.`);

          if (budget.slotsReducedForEconomics) {
            this.log('warn',
              `⚠️ CONCENTRATION CHANGED: you asked for ${budget.requestedSlots} slots, but ${budget.deployedSol.toFixed(4)} SOL split ${budget.requestedSlots} ways ` +
              `is too small to clear the ${this.config.maxBreakevenPct ?? 6}% round-trip limit — every trade would be refused. ` +
              `Running ${budget.slots} slot${budget.slots === 1 ? '' : 's'} instead. ` +
              `A single dead position now costs ${Math.round(100 / budget.slots)}% of the committed budget, not ${Math.round(100 / budget.requestedSlots)}%. ` +
              `Fund more SOL to get the diversification back.`);
          }
        } else {
          this.log('warn', `⚠️ Wallet-split sizing found nothing deployable — entries fall back to the fixed ${this.config.buyAmountSol} SOL stake.`);
        }
      } else {
        this.runSlotStakeSol = 0;
      }

      if (featureFlags.get('playbookRouting') || featureFlags.get('devSellStop')) {
        this.curveWatcher.start();
      }

      reportService.start(
        this.config,
        this.currentBankrollUsd,
        this.wallet.getSolBalance(),
        this.wallet.getAddress()
      );

      this.log('info', `🚀 SMART SNIPER BOT STARTED! Listening for ${this.config.leniencyMode.toUpperCase()} mode sniping opportunities... (run ${reportService.getRunId()})`);
      this.subscribeStream();
    } else {
      this.config.isBotActive = false;
      this.unsubscribeStream();
      realModeLock.release();
      // The budget belongs to the run. Clearing it means the next START re-reads
      // the wallet and re-splits, rather than staking slots sized for a balance
      // this run has since spent.
      this.runSlotStakeSol = 0;
      this.log('warn', '⏸️ SMART SNIPER BOT PAUSED. Automatic buying disabled.');
      this.finishRun();
    }
    return this.config.isBotActive;
  }

  /** Closes the active run, prints the report and keeps it for the API/UI. */
  private finishRun(): RunReport | null {
    if (!reportService.isRunning()) return null;

    const unrealized = this.activePositions.reduce(
      (acc, p) => acc + (p.tokensHeld * p.currentPriceUsd - p.investedUsd),
      0
    );

    // Positions still held go into the ledger — their cost is real money that
    // left the wallet even though no sell has been recorded yet.
    const openPositions = this.activePositions.map(p => ({
      symbol: p.tokenSymbol,
      mint: p.mint,
      boughtAt: p.entryTime,
      tokensHeld: p.tokensHeld,
      investedUsd: Number(p.investedUsd.toFixed(2)),
      currentPriceUsd: p.currentPriceUsd,
      unrealizedPnlUsd: Number((p.tokensHeld * p.currentPriceUsd - p.investedUsd).toFixed(2)),
      fillVerified: p.fillVerified,
      buyTxid: p.buyTxid,
    }));

    const report = reportService.finish(
      this.currentBankrollUsd,
      this.wallet.getSolBalance(),
      this.activePositions.length,
      unrealized,
      this.config.solPriceUsd,
      openPositions
    );

    if (report) {
      this.lastRunReport = report;
      console.log(reportService.toConsole(report));
      const truth = report.tradingMode === 'real'
        ? `Wallet Δ ${report.walletDeltaSol >= 0 ? '+' : ''}${report.walletDeltaSol} SOL`
        : `Realized ${report.realizedPnlUsd >= 0 ? '+' : ''}$${report.realizedPnlUsd}`;
      this.log(
        'info',
        `📊 RUN REPORT ${report.runId} | Seen ${report.tokensSeen} → bought ${report.positionsOpened} → closed ${report.positionsClosed} | ${truth} | Win ${report.winRatePct}% | Saved to reports/`
      );
    }
    return report;
  }

  public getLastRunReport(): RunReport | null {
    return this.lastRunReport;
  }

  public getLiveRunSummary() {
    const unrealized = this.activePositions.reduce(
      (acc, p) => acc + (p.tokensHeld * p.currentPriceUsd - p.investedUsd),
      0
    );
    return reportService.getLiveSummary(this.activePositions.length, unrealized);
  }

  private async syncLiveWalletBalance(): Promise<void> {
    try {
      // Keep the SOL price fresh so every USD figure (sizing, PnL, bankroll)
      // tracks the market instead of a constant.
      const livePrice = await DexScreenerService.getSolPriceUsd();
      if (livePrice > 0) this.config.solPriceUsd = Number(livePrice.toFixed(2));

      if (!this.wallet.isLinked()) return;

      const solBalance = await this.wallet.refreshBalance();
      this.liveWalletSolBalance = solBalance;
      this.availableTradeSol = this.wallet.getDeployableSol();

      // Only let the real wallet drive the bankroll in real mode — otherwise a
      // linked wallet would silently overwrite the paper-trading balance.
      if (this.config.tradingMode === 'real') {
        const bankrollUsd = Number((solBalance * this.config.solPriceUsd).toFixed(2));
        this.currentBankrollUsd = bankrollUsd;
        this.config.bankrollUsd = bankrollUsd;
        if (bankrollUsd > this.peakBankrollUsd) this.peakBankrollUsd = bankrollUsd;
      }
    } catch {
      // Silently ignore any RPC/network error (429, timeout, etc.)
      // — the next 10-second tick will retry automatically.
    }
  }

  private startWalletSync(): void {
    if (this.walletSyncInterval) clearInterval(this.walletSyncInterval);
    // Immediately, not in 10 seconds — the dashboard should show the real
    // balance and live SOL price from the first status frame.
    void this.syncLiveWalletBalance();
    this.walletSyncInterval = setInterval(() => {
      void this.syncLiveWalletBalance();
    }, 10000);
  }

  /**
   * Recomputes trade stats only when the history has actually changed.
   * The UI polls status roughly once a second; four full passes over the
   * history on every poll is work nobody asked for.
   */
  private computeStats(): BotStatusResponse['stats'] {
    if (this.statsCache) return this.statsCache;

    let winCount = 0;
    let totalNetPnlUsd = 0;
    for (const t of this.tradeHistory) {
      if (t.pnlUsd > 0) winCount++;
      totalNetPnlUsd += t.pnlUsd;
    }

    const totalTrades = this.tradeHistory.length;
    totalNetPnlUsd = Number(totalNetPnlUsd.toFixed(2));

    this.statsCache = {
      totalTrades,
      winCount,
      lossCount: totalTrades - winCount,
      winRatePct: totalTrades > 0 ? Number(((winCount / totalTrades) * 100).toFixed(1)) : 0,
      totalNetPnlUsd,
      totalNetPnlSol: Number((totalNetPnlUsd / (this.config.solPriceUsd || 1)).toFixed(4)),
    };
    return this.statsCache;
  }

  public getStatus(): BotStatusResponse {
    const now = Date.now();

    // Age out old logs. Find the cutoff and splice once rather than rebuilding
    // the array — entries are already in timestamp order. The window was 10s,
    // which was shorter than a single confirmation wait: the "submitted" line
    // for a trade could expire before its "confirmed" line ever arrived.
    if (this.logs.length > 0 && now - this.logs[0].timestamp > LOG_RETENTION_MS) {
      let cut = 0;
      while (cut < this.logs.length && now - this.logs[cut].timestamp > LOG_RETENTION_MS) cut++;
      this.logs.splice(0, cut);
    }

    // priceTicks are strictly internal chart state — up to 60 points per
    // position. Serializing them on every poll bloats the payload for data the
    // UI never reads.
    const publicPositions = this.activePositions.map(({ priceTicks, realizedPnlUsd, ...pos }) => pos);

    // The private key is deliberately never held on config, but strip it
    // defensively so no future edit can leak one through this endpoint.
    const { privateKey, ...safeConfig } = this.config;

    return {
      isBotActive: this.config.isBotActive,
      tradingMode: this.config.tradingMode,
      marketRegime: this.marketRegime,
      bankrollUsd: Number(this.currentBankrollUsd.toFixed(2)),
      grindStackUsd: Number((this.currentBankrollUsd * 0.8).toFixed(2)),
      moonshotStackUsd: Number((this.currentBankrollUsd * 0.2).toFixed(2)),
      activePositions: publicPositions,
      tradeHistory: this.tradeHistory.slice(0, 100),
      logs: this.logs,
      config: safeConfig as BotConfig,
      wallet: this.getWalletStatus(),
      run: this.getLiveRunSummary(),
      stats: this.computeStats(),
      sizing: this.getSizingPreview(),
    };
  }

  /**
   * What the next entry would actually stake, through the same maths the buy
   * path uses — so the dashboard figure and the real order can never disagree.
   */
  private getSizingPreview(): BotStatusResponse['sizing'] {
    const deployableSol = this.deployableForSizing();
    const sizingPriorityFeeSol = this.sizingPriorityFee();

    // With wallet-split sizing the stake is one slot of the run budget. While
    // the bot is armed that is the snapshot taken at arm time, so the dashboard
    // shows what the next order will REALLY stake rather than what a fresh
    // split would produce from a balance that has since moved.
    const budget = this.computeRunBudget();
    const budgetSlots = budget.slots;
    const budgetRequestedSlots = budget.requestedSlots;
    const budgetReduced = budget.slotsReducedForEconomics;

    let nextBuySol: number;
    if (this.config.walletSplitSizing) {
      nextBuySol = this.config.isBotActive && this.runSlotStakeSol > 0
        ? this.runSlotStakeSol
        : budget.stakePerSlotSol;
    } else {
      nextBuySol = deployableSol > 0
        ? affordableStakeSol(this.config.buyAmountSol, deployableSol, this.config.maxSlippagePct, sizingPriorityFeeSol)
        : this.config.buyAmountSol;
    }

    // How many entries of this size the budget actually funds. Each one costs
    // the stake plus its priority fee plus base fees and ATA rent, so dividing
    // the balance by the stake alone overstates it by roughly a trade.
    const perTradeCostSol = nextBuySol + sizingPriorityFeeSol + 0.0025;
    const affordable = nextBuySol > 0 && perTradeCostSol > 0
      ? Math.floor(deployableSol / perTradeCostSol)
      : 0;
    // No "unlimited" branch: maxActivePositions is clamped to 1..20 and is the
    // exposure limit, so it always applies.
    const concurrencyCap = Math.min(affordable, this.config.maxActivePositions);

    // "Affordable" is not the same as "tradeable". The balance can fund N orders
    // while every one of them would be refused by the economics gate — which is
    // exactly the 0.2 SOL case, and exactly how a bot screens 2,952 tokens and
    // buys nothing while the dashboard claims 3 trades are affordable.
    const be = nextBuySol > 0 ? breakevenPct(Number(nextBuySol.toFixed(6)), sizingPriorityFeeSol) : 0;
    const maxBe = this.config.maxBreakevenPct ?? 6;
    const enforced = featureFlags.get('enforceTradeEconomics');
    const economicsOk = nextBuySol > 0 && (!enforced || be <= maxBe);

    let blockedReason: string | undefined;
    if (nextBuySol <= 0) {
      blockedReason = `Balance ${deployableSol.toFixed(4)} SOL cannot fund a single order.`;
    } else if (!economicsOk) {
      blockedReason =
        `${deployableSol.toFixed(4)} SOL across ${budgetSlots} slot${budgetSlots === 1 ? '' : 's'} stakes ` +
        `${nextBuySol.toFixed(4)} SOL — a ${be}% round trip against the ${maxBe}% limit. Every trade would be refused.`;
    }

    return {
      deployableSol,
      nextBuySol: Number(nextBuySol.toFixed(4)),
      nextBuyUsd: Number((nextBuySol * this.config.solPriceUsd).toFixed(2)),
      // Report 0 tradeable when nothing would actually be bought.
      tradesAffordable: economicsOk ? Math.max(0, concurrencyCap) : 0,
      breakevenPct: be,
      economicsOk,
      blockedReason,
      slots: budgetSlots,
      requestedSlots: budgetRequestedSlots,
      slotsReducedForEconomics: budgetReduced,
    };
  }

  private getKeypairFromPrivateKey(pkStr: string): Keypair | null {
    try {
      const trimmed = pkStr.trim();
      if (!trimmed) return null;

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const arr = Uint8Array.from(JSON.parse(trimmed));
        return Keypair.fromSecretKey(arr);
      }

      if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
        const arr = Uint8Array.from(Buffer.from(trimmed, 'hex'));
        return Keypair.fromSecretKey(arr);
      }

      const decoded = bs58.decode(trimmed);
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(decoded);
      } else if (decoded.length === 32) {
        return Keypair.fromSeed(decoded);
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  private async executeRealMainnetTrade(action: 'buy' | 'sell', mint: string, solAmount: number, amountPct?: string, pool?: string): Promise<TradeResult | null> {
    const keypair = this.wallet.getKeypair();
    if (!keypair) {
      this.log('error', '❌ Cannot execute real trade: no Photon wallet linked.');
      return null;
    }

    try {
      this.log('info', `📡 Building ${action.toUpperCase()} for ${mint.slice(0,6)}... from ${keypair.publicKey.toBase58().slice(0,6)}...`);

      // Dynamic priority fee (flag dynamicPriorityFee): p75 of recent fees,
      // floored at the static config value, capped by maxPriorityFeeSol and
      // 5% of position size. Cached 10s, so this await is usually instant.
      let priorityFeeSol = this.config.priorityFeeSol;
      if (featureFlags.get('dynamicPriorityFee')) {
        try {
          const dyn = await this.priorityFeeService.getPriorityFeeSol(
            this.config.priorityFeeSol,
            this.config.maxPriorityFeeSol ?? 0.005,
            solAmount || this.config.buyAmountSol
          );
          if (dyn.feeSol !== priorityFeeSol) {
            this.log('info', `⛽ Dynamic priority fee: ${dyn.feeSol} SOL (${dyn.source})`, mint);
          }
          priorityFeeSol = dyn.feeSol;
        } catch { /* static fee remains */ }
      }

      // Local build (flag localTxBuild): only with structural parity proven by
      // shadow compare in this session, and only for bonding-curve buys — the
      // builder refuses migrated tokens and every failure falls back here.
      let tx: VersionedTransaction | null = null;
      let remoteTxBytes: Uint8Array | null = null;
      let buildSource: 'local' | 'trade-local' = 'trade-local';

      if (action === 'buy' && featureFlags.get('localTxBuild')) {
        if (localTxBuilder.hasRecentParity()) {
          const built = await localTxBuilder.buildBuy({
            user: keypair.publicKey,
            mint,
            solAmount,
            slippagePct: this.config.maxSlippagePct,
            priorityFeeSol,
          });
          if (built) {
            tx = built.tx;
            buildSource = 'local';
          } else {
            this.log('warn', `⚠️ Local build unavailable (${localTxBuilder.getParityStatus().detail}) — using trade-local.`, mint);
          }
        } else {
          this.log('warn', '⚠️ localTxBuild is ON but no shadow parity this session — using trade-local. Run with localTxShadowCompare first.', mint);
        }
      }

      if (!tx) {
        const response = await axios.post('https://pumpportal.fun/api/trade-local', {
          publicKey: keypair.publicKey.toBase58(),
          action,
          mint,
          denominatedInSol: action === 'buy' ? 'true' : 'false',
          // Sells are a PERCENTAGE of holdings and the '%' must survive — see
          // sellAmountParam. Without it PumpPortal sells that many raw tokens.
          amount: action === 'buy' ? solAmount : sellAmountParam(amountPct),
          slippage: this.config.maxSlippagePct,
          priorityFee: priorityFeeSol,
          // Route to the venue the migration payload named, falling back to
          // 'auto' when we genuinely do not know.
          //
          // 'auto' is NOT safe for a token that just graduated: PumpPortal
          // resolves it against an index that has not caught up yet, sends the
          // order to the pump.fun bonding curve, and the program rejects it
          // with BondingCurveComplete (0x1775). Measured 2026-08-09 — two of
          // four failed buys died exactly this way, both on migrations, which
          // is the bot's main strategy.
          pool: pool || 'auto'
        }, {
          responseType: 'arraybuffer',
          timeout: 10000
        });

        if (response.status !== 200) return null;
        remoteTxBytes = new Uint8Array(response.data);
        tx = VersionedTransaction.deserialize(remoteTxBytes);
      }

      {
        tx.sign([keypair]);
        latencyTimeline.stamp(mint, 't5BuiltSignedMs');

        const txid = await this.solanaConnection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });
        latencyTimeline.stamp(mint, 't6SubmittedMs');
        if (buildSource === 'local') {
          this.log('info', `🛠️ Submitted locally built tx (no trade-local hop).`, mint);
        }

        // Shadow compare runs AFTER submission, fire-and-forget: evidence
        // collection must never add latency to a live order.
        if (action === 'buy' && remoteTxBytes && featureFlags.get('localTxShadowCompare')) {
          const cmpBytes = remoteTxBytes;
          void localTxBuilder.shadowCompare(
            cmpBytes,
            { user: keypair.publicKey, mint, solAmount, slippagePct: this.config.maxSlippagePct, priorityFeeSol },
            (level, msg) => this.log(level, msg, mint)
          );
        }

        // A signature is not a fill. Confirm before mutating any state.
        const confirmed = await this.confirmTransaction(txid);
        if (confirmed === 'failed') {
          // Definitive on-chain rejection: everything rolled back, only the fee
          // was spent. There is nothing to track — opening a position here
          // would invent tokens the wallet never bought.
          this.log('error', `❌ ${action.toUpperCase()} tx FAILED on-chain — no tokens moved, only the fee was burned. Inspect: https://solscan.io/tx/${txid}`, mint);
          void this.syncLiveWalletBalance();
          return null;
        }
        if (confirmed === 'timeout') {
          if (action === 'sell') {
            this.log('warn', `⚠️ Sell ${txid.slice(0, 8)}... not confirmed in time. Holdings left untouched.`, mint);
            return null;
          }
          // A buy that can't be confirmed: report the txid so the caller can
          // still open the position (funds may have moved), but with no fill.
          this.log('warn', `⚠️ Buy ${txid.slice(0, 8)}... not confirmed in time — accounting will use estimates.`, mint);
          void this.syncLiveWalletBalance();
          return { txid, fill: null };
        }

        latencyTimeline.stamp(mint, 't7ConfirmedMs');

        // Quotes are opinions; balance deltas are facts. Read what the swap
        // actually did to the wallet and let the accounting use that.
        const fill = await inspectFill(this.solanaConnection, txid, keypair.publicKey.toBase58(), mint);
        if (fill) latencyTimeline.annotate(mint, { landedSlot: fill.slot });
        if (fill) {
          this.log('info', `📗 [FILL] ${action.toUpperCase()} ${mint.slice(0, 6)}... | SOL ${fill.solDelta >= 0 ? '+' : ''}${fill.solDelta.toFixed(6)} | tokens ${fill.tokenDelta >= 0 ? '+' : ''}${Math.round(fill.tokenDelta).toLocaleString()} | fee ${fill.feeSol.toFixed(6)} SOL`, mint);
        } else {
          this.log('warn', `⚠️ Could not read fill for ${txid.slice(0, 8)}... — this leg's PnL will be estimated.`, mint);
        }

        this.log('snipe', `✅ [${action.toUpperCase()} CONFIRMED] TxID: ${txid} | Photon: https://photon-sol.tinyastro.io/en/lp/${mint} | Solscan: https://solscan.io/tx/${txid}`, mint);

        try {
          const { exec } = require('child_process');
          exec(`cmd /c start "" "https://photon-sol.tinyastro.io/en/lp/${mint}"`);
          if (txid && !txid.startsWith('sim_')) {
            exec(`cmd /c start "" "https://solscan.io/tx/${txid}"`);
          }
        } catch { /* ignore browser spawn errors */ }

        void this.syncLiveWalletBalance();
        return { txid, fill };
      }
    } catch (err: any) {
      this.log('error', `❌ Mainnet ${action} failed for ${mint.slice(0, 6)}...: ${err.message}`);
    }
    return null;
  }

  /**
   * 'failed' is a definitive on-chain rejection — the tx executed and was
   * rolled back, so no tokens moved (only the fee burned). 'timeout' means we
   * simply don't know yet; funds may have moved. Callers must treat the two
   * differently: a failed buy must never open a position.
   */
  private async confirmTransaction(txid: string, timeoutMs = 30000): Promise<'confirmed' | 'failed' | 'timeout'> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await this.solanaConnection.getSignatureStatus(txid);
        const value = status?.value;
        if (value) {
          if (value.err) {
            this.log('warn', `❌ Tx ${txid.slice(0, 8)}... failed on-chain: ${JSON.stringify(value.err)}`);
            return 'failed';
          }
          if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return 'confirmed';
        }
      } catch {
        // RPC hiccup — keep polling until the deadline.
      }
      await new Promise(res => setTimeout(res, 1500));
    }
    return 'timeout';
  }

  private safeSendWs(payload: object): boolean {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
        return true;
      }
    } catch {
      // Ignore websocket send errors on closing/dead sockets
    }
    return false;
  }

  private subscribeStream(): void {
    if (this.ws) return;

    try {
      this.ws = new WebSocket('wss://pumpportal.fun/api/data');

      this.ws.on('open', () => {
        this.log('info', '📡 WebSocket connected to PumpPortal (wss://pumpportal.fun/api/data)');
        this.safeSendWs({ method: 'subscribeNewToken' });
        this.safeSendWs({ method: 'subscribeMigration' });

        // Re-subscribe to trades for anything already being watched, so a
        // reconnect does not silently blind the curve tracker. Open positions
        // are included: they carry real money and their creator/insider stops
        // read this same stream, so a reconnect must not drop them.
        const watched = new Set(tokenWatchlist.all().map(t => t.mint));
        for (const p of this.activePositions) watched.add(p.mint);
        if (watched.size) {
          this.safeSendWs({ method: 'subscribeTokenTrade', keys: [...watched] });
        }
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        if (!this.config.isBotActive) return;
        // T1 is stamped here, before parse, so the timeline captures true
        // in-process arrival — not "whenever we got around to it".
        const arrivalMs = Date.now();

        try {
          const payload = JSON.parse(data.toString());
          if (!payload.mint) return;

          if (payload.txType === 'migrate') {
            this.migrationSeenAt.set(payload.mint, arrivalMs);
          }

          // Structural stop first: a creator sell on a token we hold outranks
          // every other rule, and must be acted on before anything else in this
          // handler can return early.
          if (featureFlags.get('devSellStop') &&
              (payload.txType === 'buy' || payload.txType === 'sell') &&
              devSellMonitor.isTracked(payload.mint)) {
            const alert = devSellMonitor.onTrade(payload, arrivalMs);
            if (alert) await this.handleStructuralAlert(alert);
          }

          // Trade events on a watched token update its curve position rather
          // than being re-screened as new launches.
          if (featureFlags.get('playbookRouting') &&
              (payload.txType === 'buy' || payload.txType === 'sell') &&
              tokenWatchlist.has(payload.mint)) {
            await this.handleWatchedTrade(payload, arrivalMs);
            return;
          }

          await this.processIncomingToken(payload, arrivalMs);
        } catch (e) {
          // ignore
        }
      });

      this.ws.on('error', (err) => {
        this.log('warn', `WebSocket notice: ${err.message}`);
      });

      this.ws.on('close', () => {
        this.ws = null;
        if (this.config.isBotActive) {
          setTimeout(() => this.subscribeStream(), 2000);
        }
      });
    } catch (err: any) {
      this.log('error', `WebSocket connection failed: ${err.message}`);
    }
  }

  private unsubscribeStream(): void {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  public async processIncomingToken(payload: any, arrivalMs: number = Date.now()): Promise<FilterResult | null> {
    const mint = payload.mint;
    // Legacy detection also fires on vSolInBondingCurve >= 70 (a big-dev-buy
    // create); flag strictMigrationDetect narrows it to real migrate events.
    const isMigration = detectMigration(payload, featureFlags.get('strictMigrationDetect'));
    const useRealData = featureFlags.get('playbookRouting');

    latencyTimeline.begin(mint, {
      t1ArrivalMs: arrivalMs,
      mode: this.config.tradingMode,
      symbol: payload.symbol || undefined,
      txType: payload.txType,
      payload,
    });
    latencyTimeline.stamp(mint, 't2ParsedMs');

    // Screening chatter, level `gate0` so the UI can style it apart from trade
    // events. One line on arrival and one verdict line per token — at the
    // observed ~0.6 tokens/sec that is a readable few lines per refresh cycle.
    this.log('gate0',
      `🔍 ${isMigration ? 'MIGRATION' : 'new'} ${payload.symbol ? '$' + payload.symbol : mint.slice(0, 6) + '…'} — querying RugCheck${isMigration ? ' (waiting for holders)' : ''}`,
      mint);
    if (featureFlags.get('timelineSlotSampling')) {
      void this.solanaConnection.getSlot('processed')
        .then(s => latencyTimeline.annotate(mint, { slotAtArrival: s }))
        .catch(() => {});
    }

    const launchData: Partial<PumpTokenLaunch> = {
      mint,
      // Destination venue, present on migration payloads. Carried all the way
      // to the order so a graduated token is never routed at the dead curve.
      pool: typeof payload.pool === 'string' ? payload.pool : undefined,
      // Do NOT default these. Migration events carry no name/symbol, and a
      // truthy placeholder here shadows the RugCheck metadata fallback in
      // RiskFilter.evaluateToken (`launch.name || report?.tokenMeta?.name`),
      // which is why every migration-bought token was displayed as "$PUMP".
      // Leaving them undefined lets the real on-chain metadata through.
      name: payload.name || undefined,
      symbol: payload.symbol || undefined,
      creator: payload.traderPublicKey || payload.creator || 'Unknown',
      timestamp: Date.now(),
      marketCapSol: payload.marketCapSol || 30,
      marketCapUsd: (payload.marketCapSol || 30) * this.config.solPriceUsd,
      fdvUsd: (payload.marketCapSol || 30) * this.config.solPriceUsd,
      bondingProgress: payload.bondingProgress || (isMigration ? 90 : 35),
      // The placeholder metrics below are what the LEGACY gate grades when no
      // DexScreener pair exists (i.e. every fresh launch — measured 0/8
      // indexed under 10s). They are fabrications, kept only so legacy
      // behavior stays bit-identical while flags are off. EntryGateV2 ignores
      // every one of them and reads the real payload + RugCheck instead.
      // With playbookRouting these start at ZERO — unknown, to be filled in
      // from the curve, DexScreener or RugCheck. The non-zero values are the
      // legacy fabrications, kept only so behavior is unchanged when the flag
      // is off. Leaving them non-zero leaked $12,000 of imaginary liquidity
      // into migration candidates even after the real-data wiring landed.
      volume5mUsd: useRealData ? 0 : 1500,
      liquidityUsd: useRealData ? 0 : (isMigration ? 12000 : 3500),
      uniqueBuyers5m: useRealData ? undefined : 25,
      washScore: useRealData ? 0 : 10,
      // UNDEFINED, not 0. These are only filled in below from measured RugCheck
      // holder data. A 0 here reads as "0% concentration — perfectly
      // distributed" to both Gate 0 and the score, which is how unverified
      // tokens scored 50/100 on no data at all and were bought.
      bundledSupplyPct: useRealData ? undefined : 5,
      devHoldingsPct: useRealData ? undefined : 1,
      top10Pct: useRealData ? undefined : 12,
      // Fixed (audit bug B1): PumpPortal sends no `timestamp`, and the old
      // `|| 120` fallback aged every fresh token to 120s, defeating the
      // skip-DexScreener-under-45s branch below on 100% of creates.
      ageSeconds: computeAgeSeconds(payload.timestamp),
    };

    // A mint seconds old cannot have a DexScreener pair yet — indexing takes
    // longer than that. Skipping the lookup for these saves the majority of
    // calls on a busy stream and keeps the rate limiter free for open positions.
    const ageSeconds = launchData.ageSeconds ?? 0;
    const wantDexLookup = ageSeconds >= 45 || isMigration;

    // RugCheck and DexScreener are independent — fetch them concurrently
    // (previously sequential, paying both round-trips back to back). The
    // entry-path DexScreener call keeps a 60-token reserve in the rate bucket
    // so screening can never starve the exit monitor.
    // Candidates we could actually trade get the patient RugCheck read: a
    // migration, or a watchlist token re-screened because it walked into the
    // mid-curve window. Everything else is a fresh create the playbook refuses
    // on phase alone, so spending seconds waiting on its holder list would be
    // latency for a token we were never going to buy.
    const isTradeableCandidate = useRealData && (isMigration || Boolean(payload.__watchlistStats));

    const [report, dexData] = await Promise.all([
      isTradeableCandidate
        ? this.rugCheckService.getReportWithHolders(mint)
        : this.rugCheckService.getReport(mint),
      wantDexLookup ? DexScreenerService.getTokenMarketData(mint, 60) : Promise.resolve(null),
    ]);

    // Migration payloads carry ONLY {signature, mint, txType, pool} — measured
    // 2026-08-04, four consecutive migrate events. No name, no symbol, no
    // reserves, no market cap. RugCheck is the only real source at that moment,
    // so use its liquidity when DexScreener has not indexed the new pool yet.
    if (report && !report.isInferred && typeof report.totalMarketLiquidity === 'number' && report.totalMarketLiquidity > 0) {
      if (!dexData?.hasPair) launchData.liquidityUsd = report.totalMarketLiquidity;
    }
    if (payload.__watchlistStats) {
      launchData.uniqueBuyers5m = payload.__watchlistStats.uniqueBuyers5m;
      launchData.buyPressurePct = payload.__watchlistStats.buyPressurePct;
      launchData.volume5mUsd = payload.__watchlistStats.volume5mSol * this.config.solPriceUsd;
      // Curve fill velocity — the demand signal that actually exists on the
      // free tier. Without it Play 2's buyer gate is unsatisfiable.
      launchData.progressVelocity5m = payload.__watchlistStats.progressVelocity5m;
    }


    // Replace the fabricated liquidity/market-cap placeholders with the curve's
    // REAL numbers. On a bonding curve the exit liquidity is exactly the real
    // SOL banked in it (vSol minus the 30 virtual), and market cap comes
    // straight from the payload. Without this the legacy gate keeps grading
    // invented values and rejects every pre-migration token on a constant,
    // which is what made mid-curve entries unreachable.
    if (featureFlags.get('playbookRouting')) {
      const vSol = Number(payload.vSolInBondingCurve);
      if (isFinite(vSol) && vSol > 0) {
        launchData.vSolInBondingCurve = vSol;
        launchData.vTokensInBondingCurve = Number(payload.vTokensInBondingCurve) || undefined;
        const realSolInCurve = Math.max(0, vSol - 30);
        launchData.liquidityUsd = Number((realSolInCurve * this.config.solPriceUsd).toFixed(2));
        launchData.bondingProgress = (realSolInCurve / 85) * 100;
      }

      // Holder concentration: RugCheck measures this for real (pool-owned
      // balances already excluded in normalizeReport). Feed the measured
      // numbers to the gate instead of the optimistic placeholders above.
      // Only ever overwrite with a REAL reading — never relax a value to a
      // friendlier one when the data is missing.
      const meta: any = report?.fileMeta;
      // `concentrationAnomaly` means the holder percentages summed past 100, so
      // the reading is not measuring what it claims. Leave the fields unset and
      // let the gate refuse on "unverified" rather than trust a broken number.
      // A sample of one holder is not a distribution. $TNOS was bought
      // 2026-08-09 on holderSampleSize=1 / totalHolders=0 reporting a lovely
      // "top10 = 2.01%"; by the time it settled, one wallet held 79.32% and
      // RugCheck flagged three danger-level risks. Requiring a meaningful
      // sample is the difference between measuring concentration and reading a
      // single row and calling it a distribution.
      const holderDataUsable = Boolean(
        report && !report.isInferred && meta
        && meta.holderSampleSize >= MIN_HOLDER_SAMPLE
        && meta.totalHolders >= MIN_TOTAL_HOLDERS
        && !meta.concentrationAnomaly
      );
      if (holderDataUsable) {
        if (typeof meta.top10Pct === 'number') launchData.top10Pct = meta.top10Pct;
        if (typeof meta.maxSingleHolderPct === 'number') {
          // No dedicated dev-holdings feed at this stage; the largest single
          // non-pool holder is the closest measured proxy and is strictly more
          // conservative than the hardcoded 1%.
          launchData.devHoldingsPct = Math.max(launchData.devHoldingsPct ?? 0, meta.maxSingleHolderPct);
        }
        // Zero insiders is a MEASURED result — the best one available — not
        // missing data. Gating this on `> 0` left bundledSupplyPct undefined on
        // every clean token, so the verified-concentration rule refused exactly
        // the tokens whose distribution was flawless. Measured 2026-08-09:
        // $Drage (top10 19.2%, 19 owners) and TOADHOUSE (24.5%) were both
        // refused as "unverified" while genuine rugs at 79% and 89.7% were
        // refused for the same reason — the gate could not tell them apart.
        if (typeof meta.insiderPct === 'number') {
          launchData.bundledSupplyPct = Math.max(launchData.bundledSupplyPct ?? 0, meta.insiderPct);
        }
      }
    }

    if (dexData && dexData.hasPair) {
      launchData.hasLiveMarketData = true;
      launchData.priceUsd = dexData.priceUsd || launchData.priceUsd;
      launchData.volume5mUsd = dexData.volume5mUsd;
      launchData.marketCapUsd = dexData.marketCapUsd > 0 ? dexData.marketCapUsd : launchData.marketCapUsd;
      launchData.fdvUsd = dexData.fdvUsd > 0 ? dexData.fdvUsd : launchData.fdvUsd;
      launchData.liquidityUsd = dexData.liquidityUsd > 0 ? dexData.liquidityUsd : launchData.liquidityUsd;
      launchData.buys5m = dexData.buys5m;
      launchData.sells5m = dexData.sells5m;
      launchData.buyPressurePct = dexData.buyPressurePct;
      launchData.priceChange5mPct = dexData.priceChange5mPct;
      launchData.turnover5m = dexData.turnover5m;
      launchData.socialCount = dexData.socialCount;
      launchData.isBoosted = dexData.isBoosted;
      launchData.pairAgeSeconds = dexData.pairAgeSeconds;
    }

    // A genuine migration moves the curve's ~79 SOL (85 raised minus the
    // graduation fee) into the new pool, plus the matching token side — both
    // sides worth ~158 SOL, known a priori from the program. DexScreener takes
    // minutes to index a fresh pool (measured tonight: liquidity read 0 even
    // with hasPair true), so waiting for the indexer made Play 3's 90-second
    // window structurally unreachable. Only assert when the indexer has no
    // real reading — never overwrite a measured number with an assumption.
    if (featureFlags.get('playbookRouting') && isMigration && !((dexData?.liquidityUsd ?? 0) > 0)) {
      launchData.liquidityUsd = Math.max(launchData.liquidityUsd ?? 0, 2 * 79 * this.config.solPriceUsd);
    }
    latencyTimeline.stamp(mint, 't3FiltersDoneMs');

    // Sell-path safety. Replaces the hardcoded sellSimPassed/notHoneypot stubs
    // with an actual look at the mint: freeze authority, Token-2022 hooks/fees,
    // and RugCheck's own danger flags. Only runs for candidates that are still
    // live prospects, so it costs one RPC call on a small minority of tokens.
    let honeypotBlocked: string[] = [];
    if (featureFlags.get('honeypotChecks')) {
      const verdict = await inspectMintSafety(this.solanaConnection, mint, report);
      if (!verdict.safe) {
        honeypotBlocked = verdict.reasons;
        latencyTimeline.annotate(mint, { decision: 'rejected' });
        this.log('warn', `🍯 [SELL-PATH RISK] $${payload.symbol ?? mint.slice(0, 6)} — ${verdict.reasons[0]}`, mint);
      }

      // Unknown is not safe. `unverified` was computed and thrown away, so an
      // unreachable RPC returned {safe:true} and the token sailed through with
      // its mint and freeze authorities never actually read — the exact
      // fail-open the rest of the pipeline is built to refuse. Only the mint
      // account itself is fatal; a missing RugCheck risks array is common and
      // is already covered by the concentration rules.
      const fatalUnverified = verdict.unverified.filter(u => u !== 'rugcheckRisks');
      if (fatalUnverified.length > 0) {
        const why = `Sell-path safety unverifiable (${fatalUnverified.join(', ')}) — unknown is not safe`;
        honeypotBlocked = [...honeypotBlocked, why];
        latencyTimeline.annotate(mint, { decision: 'rejected' });
        this.log('warn', `🍯 [UNVERIFIED] $${payload.symbol ?? mint.slice(0, 6)} — ${why}`, mint);
      }
    }

    // Phase-aware liquidity floor. A token still on its bonding curve cannot
    // hold the post-migration $8,000 (the curve graduates at ~85 SOL, worth
    // ~$6,290 at SOL=$74), so applying that floor pre-migration rejects 100% of
    // curve tokens forever. On a curve the exit liquidity IS the curve's SOL
    // reserve, and it is denominated in SOL — so the floor must be too, or it
    // silently breaks every time SOL moves.
    const onCurve = useRealData
      && (launchData.vSolInBondingCurve ?? 0) > 0
      && !launchData.hasLiveMarketData;
    // Off-curve under routing, the floor is ALSO SOL-denominated (the
    // playbook's "≈30+ SOL"): the strict $8,000 USD floor equals ~111 SOL at
    // SOL=$72 — tonight's data shows it rejecting 11/11 real graduations,
    // exactly the failure mode the curve override fixed one phase earlier.
    // The router still applies its stricter play-specific floors after this.
    const minLiquidityUsdOverride = onCurve
      ? MIN_CURVE_LIQUIDITY_SOL * this.config.solPriceUsd
      : (useRealData && (isMigration || launchData.hasLiveMarketData))
        ? this.activePlaybook().minLiquiditySol * this.config.solPriceUsd
        : undefined;

    // Liquidity depth vs market cap. Previously ABSENT: every liquidity rule in
    // the codebase was an absolute floor, so a $12k-liquidity / $400k-mcap token
    // (33:1) passed everything. A thin pool against a large notional is what
    // makes a price trivially manipulable and an exit impossible at the quoted
    // price. A genuine pump.fun graduation is ~5:1.
    //
    // Only applied when BOTH numbers are real: the migration liquidity assertion
    // below fabricates ~$12,044, and a ratio computed against a constant is
    // theatre.
    const mcapRatioBlocked: string[] = [];
    if (this.config.maxMcapToLiquidityRatio && this.config.maxMcapToLiquidityRatio > 0) {
      const liq = launchData.liquidityUsd ?? 0;
      const mcap = launchData.marketCapUsd ?? 0;
      const liquidityIsMeasured = Boolean(dexData?.hasPair && (dexData?.liquidityUsd ?? 0) > 0);
      if (liquidityIsMeasured && liq > 0 && mcap > 0) {
        const ratio = mcap / liq;
        if (ratio > this.config.maxMcapToLiquidityRatio) {
          mcapRatioBlocked.push(
            `Market cap $${Math.round(mcap).toLocaleString()} is ${ratio.toFixed(1)}x the $${Math.round(liq).toLocaleString()} pool ` +
            `(limit ${this.config.maxMcapToLiquidityRatio}x) — too thin to exit at the quoted price`
          );
          this.log('warn', `💧 [THIN POOL] $${payload.symbol ?? mint.slice(0, 6)} — mcap/liquidity ${ratio.toFixed(1)}x > ${this.config.maxMcapToLiquidityRatio}x`, mint);
        }
      }
    }

    const filterResult = this.riskFilter.evaluateToken(report, launchData, {
      minLiquidityUsdOverride,
      // On the real-data path, concentration we could not measure must reject
      // rather than pass. Legacy (flag off) still supplies its placeholders.
      requireVerifiedConcentration: useRealData,
      // RugCheck's verdict as an independent second opinion, not just its raw
      // holder rows. Legacy keeps its old behaviour of ignoring the score.
      maxRugcheckScore: useRealData ? MAX_RUGCHECK_SCORE : undefined,
    });
    if (honeypotBlocked.length > 0 || mcapRatioBlocked.length > 0) {
      filterResult.isSafe = false;
      filterResult.reasons = [...honeypotBlocked, ...mcapRatioBlocked, ...(filterResult.reasons || [])];
    }

    // Gate V2 (real data only): entryGateV2 trades on it; shadowGateV2 runs it
    // silently next to the legacy gate and logs divergences — the required
    // evidence pass before anyone flips the real flag.
    const useV2 = featureFlags.get('entryGateV2');
    const runV2 = useV2 || featureFlags.get('shadowGateV2');
    const v2 = runV2 ? entryGateV2.evaluate(payload, report, isMigration) : null;

    let activeIsSafe = useV2 && v2 ? v2.isSafe : filterResult.isSafe;
    let activeReasons = useV2 && v2 ? v2.reasons : filterResult.reasons;

    // Under playbookRouting, Gate 0 owns SAFETY and the router owns STRATEGY.
    // The monolithic strict-62 score bar was calibrated when fabricated inputs
    // scored every token 95; on real data a clean migration-moment token
    // scores ~55-60 (its volume/socials simply aren't indexed yet) and the 62
    // bar rejected 100% of otherwise-clean graduations — the measured reason
    // the bot "never tries anything". The router applies the playbook's own
    // bands instead: 55 = half-unit eligibility, 71 = full unit. Hard safety
    // (authorities, concentration, liquidity, honeypot) is unchanged.
    if (!useV2 && featureFlags.get('playbookRouting')
        && honeypotBlocked.length === 0
        && filterResult.gate0?.allPassed
        && !activeIsSafe) {
      const halfUnitFloor = this.activePlaybook().minScoreHalfUnit;
      if (filterResult.score >= halfUnitFloor) {
        activeIsSafe = true;
      } else {
        activeReasons = [`Score ${filterResult.score} below router half-unit floor (${halfUnitFloor})`];
      }
    }
    latencyTimeline.stamp(mint, 't4DecisionMs');

    latencyTimeline.annotate(mint, {
      // Migration payloads carry no symbol, so the timeline seed defaults to
      // "PUMP". Overwrite it with the name RugCheck actually resolved.
      symbol: filterResult.tokenSymbol,
      launchData,
      rug: report ? {
        score: report.score,
        token: report.token,
        fileMeta: report.fileMeta,
        isInferred: report.isInferred,
        markets: report.markets?.slice(0, 1),
      } : null,
      gateV1: { gate: 'v1-legacy', isSafe: filterResult.isSafe, score: filterResult.score, reasons: filterResult.reasons },
      gateV2: v2 ? { gate: 'v2-realdata', isSafe: v2.isSafe, reasons: v2.reasons, unverifiedFields: v2.unverifiedFields } : undefined,
      divergence: v2 ? v2.isSafe !== filterResult.isSafe : undefined,
      activeGate: useV2 ? 'v2-realdata' : 'v1-legacy',
      decision: activeIsSafe ? 'passed_no_buy' : 'rejected',
    });

    if (!useV2 && v2 && v2.isSafe !== filterResult.isSafe) {
      this.log('info', `👥 [SHADOW GATE V2] Divergence on $${filterResult.tokenSymbol}: legacy=${filterResult.isSafe ? 'PASS' : 'REJECT'} v2=${v2.isSafe ? 'PASS' : 'REJECT'} | ${(v2.isSafe ? filterResult.reasons : v2.reasons)[0] || ''}`, mint);
    }

    reportService.recordScreened(activeIsSafe, activeReasons?.[0]);

    if (!activeIsSafe) {
      // Fresh creates fail here constantly and by design — logging all of them
      // would bury the feed. But a migration or a matured watchlist token was a
      // real trade candidate, so say out loud why it was refused.
      if (isTradeableCandidate) {
        this.log('warn', `⛔ [REFUSED] $${filterResult.tokenSymbol} (score ${filterResult.score}) — ${activeReasons?.[0] ?? 'failed Gate 0'}`, mint);
      } else {
        this.log('gate0', `✗ $${filterResult.tokenSymbol} (score ${filterResult.score}) — ${activeReasons?.[0] ?? 'failed Gate 0'}`, mint);
      }
      // A create that fails today's gate can still mature into a Play 2 setup,
      // so keep watching its curve instead of discarding it.
      if (payload.txType !== 'migrate' && !payload.__watchlistStats) this.enrollInWatchlist(payload);
      latencyTimeline.complete(mint);
      return useV2 && v2 ? { ...filterResult, isSafe: false, reasons: v2.reasons } : filterResult;
    }

    this.log('info', `✅ [PASSED ${useV2 ? 'GATE V2 — REAL DATA' : this.config.leniencyMode.toUpperCase() + ' GATE 0 & SCORING'}] $${filterResult.tokenSymbol} | Score: ${filterResult.score}/100 | MC: $${filterResult.marketCapUsd.toLocaleString()} | 5m Vol: $${filterResult.volume5mUsd.toLocaleString()}`, mint);

    if (this.config.isBotActive) {
      await this.evaluatePlaybookTrigger(filterResult, launchData, isMigration);
    }

    latencyTimeline.complete(mint);
    return useV2 && v2 ? { ...filterResult, isSafe: true } : filterResult;
  }

  /**
   * Folds a trade on a watched token into its curve state and fires Play 2 the
   * moment it walks into the mid-curve window with real demand behind it.
   *
   * This is the only path by which the bot can enter a token EARLY: the
   * new-token stream shows each mint exactly once, at 0% progress, inside the
   * block-0 window the playbook forbids trading.
   */
  private async handleWatchedTrade(payload: any, arrivalMs: number): Promise<void> {
    const token = tokenWatchlist.recordTrade(payload, arrivalMs);
    if (!token || token.triggered || !this.config.isBotActive) return;

    // Cheap pre-check before spending a RugCheck call: only tokens actually
    // inside the Play 2 window are worth screening.
    if (token.progressPct < 30 || token.progressPct > 60) return;
    if (Date.now() - token.createdAt < 600_000) return; // needs 10 min of history
    if (this.activePositions.some(p => p.mint === token.mint)) return;

    const stats = tokenWatchlist.stats(token.mint, arrivalMs);
    if (!stats || stats.uniqueBuyers5m < 20 || stats.buyPressurePct < 60) return;

    tokenWatchlist.markTriggered(token.mint);
    this.log('info', `📈 [MID-CURVE CANDIDATE] $${token.symbol ?? '?'} at ${token.progressPct.toFixed(0)}% of the curve | ${stats.uniqueBuyers5m} unique buyers/5m | ${stats.buyPressurePct}% buys`, token.mint);

    // Screen it through the full pipeline with its CURRENT curve state.
    await this.processIncomingToken({
      ...payload,
      txType: 'create',
      name: token.name,
      symbol: token.symbol,
      traderPublicKey: token.creator,
      vSolInBondingCurve: token.vSolInBondingCurve,
      vTokensInBondingCurve: token.vTokensInBondingCurve,
      marketCapSol: token.marketCapSol,
      timestamp: token.createdAt,
      __watchlistStats: stats,
    }, arrivalMs);
  }

  /**
   * Structural stop handler. The playbook ranks this above time, price and
   * profit rules: insider exits complete in one or two transactions, so the
   * first sell IS the event. Exit the whole position immediately — price is
   * secondary to being out.
   *
   * This does NOT tighten any of the owner's chosen price/time exits; it adds
   * an on-chain trigger that previously did not exist at all.
   */
  private async handleStructuralAlert(alert: { mint: string; kind: string; detail: string }): Promise<void> {
    const pos = this.activePositions.find(p => p.mint === alert.mint);
    if (!pos) {
      devSellMonitor.untrack(alert.mint);
      return;
    }
    this.log('sell', `🚨 [STRUCTURAL STOP: ${alert.kind}] $${pos.tokenSymbol} — ${alert.detail}. Selling everything now.`, alert.mint);

    // Latch the reason on the position, not on the monitor. DevSellMonitor sets
    // `devSold = true` permanently on the first creator sell, so an alert whose
    // exit fails can never be raised a second time. With the price stop-loss
    // gone this is the position's only remaining loss-side exit, so the intent
    // to leave has to outlive one failed transaction: the exit ladder retries a
    // forced full exit every tick until the tokens are actually gone.
    pos.forceExitReason = `structural stop: ${alert.detail}`;
    await this.executeSell(pos, `SOLD ALL — structural stop: ${alert.detail}`, true);

    // Only stop watching once the position is genuinely closed. Untracking after
    // a failed sell discards the creator subscription for a bag we still hold.
    if (!this.activePositions.some(p => p.id === pos.id)) devSellMonitor.untrack(alert.mint);
  }

  /** Adds a fresh create to the curve watchlist and subscribes to its trades. */
  /**
   * Reacts to a bonding-curve account change: advances the watched token and
   * fires Play 2 when it enters the mid-curve window with real momentum. Also
   * drives the curve-drain structural stop for open positions.
   */
  private async handleCurveUpdate(u: CurveUpdate): Promise<void> {
    // Keep held positions priced off the live curve. This is what gives an
    // on-curve position a real chart: DexScreener has nothing pre-migration.
    const held = this.activePositions.find(p => p.mint === u.mint);
    if (held && u.vSolInBondingCurve > 0 && u.vTokensInBondingCurve > 0) {
      held.pool = {
        vSolInBondingCurve: u.vSolInBondingCurve,
        vTokensInBondingCurve: u.vTokensInBondingCurve,
      };
      held.lastCurvePriceUsd = (u.vSolInBondingCurve / u.vTokensInBondingCurve) * this.config.solPriceUsd;
      held.lastCurvePriceAt = u.at;
      // Curve updates arrive over the Helius websocket, so an on-curve position
      // can repaint the instant its price moves rather than on the next tick.
      this.emitChange();
    }

    // --- Structural stop for anything we currently hold ---
    if (featureFlags.get('devSellStop')) {
      const pos = this.activePositions.find(p => p.mint === u.mint);
      if (pos) {
        const peak = Math.max(this.curvePeakSol.get(u.mint) ?? 0, u.realSolInCurve);
        this.curvePeakSol.set(u.mint, peak);
        // A sharp withdrawal is a large holder cashing out. Account updates
        // carry no trader identity, so this cannot be attributed to the dev
        // specifically — but the drain IS the event worth acting on, and it is
        // visible without the paid feed.
        if (peak >= 5 && u.realSolInCurve <= peak * 0.6) {
          await this.handleStructuralAlert({
            mint: u.mint,
            kind: 'CURVE_DRAINED',
            detail: `curve fell from ${peak.toFixed(1)} to ${u.realSolInCurve.toFixed(1)} SOL (-${(100 - (u.realSolInCurve / peak) * 100).toFixed(0)}%)`,
          });
          this.curvePeakSol.delete(u.mint);
          return;
        }
      }
    }

    if (!featureFlags.get('playbookRouting') || !this.config.isBotActive) return;

    const token = tokenWatchlist.recordCurveUpdate(u);
    if (!token || token.triggered) return;
    if (u.complete) { this.curveWatcher.unwatch(u.mint); return; }

    if (token.progressPct < 30 || token.progressPct > 60) return;
    if (Date.now() - token.createdAt < 600_000) return;
    if (this.activePositions.some(p => p.mint === token.mint)) return;

    const stats = tokenWatchlist.stats(token.mint);
    // Unique-buyer counts require the paid trade feed, so demand is judged by
    // how fast the curve is filling plus net buy pressure. This is weaker: it
    // cannot tell one whale from twenty buyers.
    const play2 = this.activePlaybook();
    if (!stats || stats.progressVelocity5m < play2.play2MinVelocity5m || stats.buyPressurePct < play2.play2MinBuyPressurePct) return;

    tokenWatchlist.markTriggered(token.mint);
    this.log('info', `📈 [MID-CURVE CANDIDATE] $${token.symbol ?? '?'} at ${token.progressPct.toFixed(0)}% | +${stats.progressVelocity5m}%/5m | ${stats.buyPressurePct}% net buying`, token.mint);

    await this.processIncomingToken({
      mint: token.mint,
      txType: 'create',
      name: token.name,
      symbol: token.symbol,
      traderPublicKey: token.creator ?? u.creator,
      vSolInBondingCurve: u.vSolInBondingCurve,
      vTokensInBondingCurve: u.vTokensInBondingCurve,
      marketCapSol: token.marketCapSol,
      timestamp: token.createdAt,
      __watchlistStats: stats,
    }, Date.now());
  }

  private enrollInWatchlist(payload: any): void {
    if (!featureFlags.get('playbookRouting')) return;
    if (payload.txType === 'migrate' || tokenWatchlist.has(payload.mint)) return;
    const enrolled = tokenWatchlist.add(payload);
    if (!enrolled.added) return;
    // The watchlist evicted a token to make room — release its curve
    // subscription too, or the slot (and the Helius credits) leak.
    if (enrolled.evicted) this.curveWatcher.unwatch(enrolled.evicted);

    // Curve progress comes from Helius accountSubscribe on the bonding-curve
    // PDA. PumpPortal's subscribeTokenTrade is NOT used: it requires an API key
    // funded with 0.02 SOL and returns zero events on the free tier (verified
    // 2026-08-05 across 18 tokens / 6 minutes), which made this watchlist —
    // and therefore Play 2 — silently dead code.
    if (!this.curveWatcher.watch(payload.mint)) {
      const evicted = this.curveWatcher.evictOldest();
      if (evicted) tokenWatchlist.remove(evicted);
      this.curveWatcher.watch(payload.mint);
    }

    if (!this.watchlistPruneInterval) {
      this.watchlistPruneInterval = setInterval(() => {
        for (const mint of tokenWatchlist.prune()) this.curveWatcher.unwatch(mint);
      }, 60_000);
      this.watchlistPruneInterval.unref?.();
    }
  }

  private async evaluatePlaybookTrigger(filterResult: FilterResult, launchData: Partial<PumpTokenLaunch>, isMigration: boolean): Promise<void> {
    // Claim the slot SYNCHRONOUSLY, before the first await.
    //
    // A position only joins activePositions after confirmTransaction, which
    // polls for up to 30s. The websocket handler is `on('message', async ...)`
    // and is not awaited, so up to 8 candidates run concurrently (measured).
    // Counting only activePositions therefore made maxActivePositions advisory
    // across a 30-second window: N candidates could all read "0 open" and all
    // buy. entriesInFlight closes that window — it is claimed here and released
    // in the finally below, so the count is exact at every instant.
    if (this.entriesInFlight.has(filterResult.mint)) return;
    if (this.activePositions.some(p => p.mint === filterResult.mint)) return;

    const committed = this.activePositions.length + this.entriesInFlight.size;
    if (committed >= this.config.maxActivePositions) {
      this.log('warn', `⚠️ Position limit reached (${this.activePositions.length} open + ${this.entriesInFlight.size} in flight / ${this.config.maxActivePositions}). Skipping buy for $${filterResult.tokenSymbol}.`);
      return;
    }

    this.entriesInFlight.add(filterResult.mint);
    try {
      await this.evaluatePlaybookTriggerInner(filterResult, launchData, isMigration);
    } finally {
      this.entriesInFlight.delete(filterResult.mint);
    }
  }

  private async evaluatePlaybookTriggerInner(filterResult: FilterResult, launchData: Partial<PumpTokenLaunch>, isMigration: boolean): Promise<void> {
    const score = filterResult.score;
    const progress = filterResult.bondingProgress || 35;

    let selectedPlay: PlaybookType = 'PLAY_2';
    let sizeMultiplier = 1;

    if (featureFlags.get('playbookRouting')) {
      // Route on MEASURED curve position and real market data. The legacy
      // branch below routes on fabricated inputs and treats anything with
      // vSol >= 70 (~47% up the curve) as a migration.
      const ageSeconds = launchData.ageSeconds ?? 0;
      const migratedAt = this.migrationSeenAt.get(filterResult.mint);
      const decision: RouteDecision = routePlay({
        isMigrationEvent: isMigration,
        secondsSinceMigration: migratedAt ? (Date.now() - migratedAt) / 1000 : undefined,
        ageSeconds,
        vSolInBondingCurve: launchData.vSolInBondingCurve,
        hasDexPair: launchData.hasLiveMarketData,
        pairAgeSeconds: launchData.pairAgeSeconds,
        score,
        marketCapUsd: filterResult.marketCapUsd,
        liquidityUsd: filterResult.liquidityUsd,
        uniqueBuyers5m: launchData.uniqueBuyers5m,
        buyPressurePct: launchData.buyPressurePct,
        volume5mUsd: filterResult.volume5mUsd,
        progressVelocity5m: launchData.progressVelocity5m,
        buys5m: launchData.buys5m,
        isBoosted: launchData.isBoosted,
        solPriceUsd: this.config.solPriceUsd,
      }, this.activePlaybook());

      latencyTimeline.annotate(filterResult.mint, {
        gateV2: {
          gate: 'v2-realdata',
          isSafe: decision.eligible,
          reasons: decision.reasons,
          unverifiedFields: [],
        },
      });

      if (!decision.eligible) {
        this.log('info', `⏭️ [NO TRADE] $${filterResult.tokenSymbol} — ${describeRoute(decision)}: ${decision.reasons[0] ?? 'no trigger'}`, filterResult.mint);
        return;
      }

      selectedPlay = decision.play === 'NONE' ? 'PLAY_2' : decision.play;
      sizeMultiplier = decision.sizeMultiplier;

      this.log('info', `🎯 [TRIGGER] $${filterResult.tokenSymbol} — ${describeRoute(decision)}`, filterResult.mint);
    } else {
      if (isMigration || progress >= 70) {
        selectedPlay = 'PLAY_3';
      } else if (filterResult.volume5mUsd >= 500) {
        selectedPlay = 'PLAY_4';
      } else if (filterResult.liquidityUsd >= 2000) {
        selectedPlay = 'PLAY_5';
      }
    }

    if (this.config.activePlaybook !== 'ALL' && this.config.activePlaybook !== selectedPlay) return;

    // Read the wallet as it is right now: the background sync only runs every
    // 10s, and sizing against a stale balance either leaves cash idle or
    // overdrafts the order.
    //
    // The on-chain balance does NOT yet reflect entries that are submitted but
    // unconfirmed, so subtract what concurrent entries have already claimed.
    // This assignment used to overwrite availableTradeSol wholesale on every
    // entry, erasing the reservation executeBuy had just made and letting two
    // concurrent buys each size against the full balance.
    if (this.config.tradingMode === 'real') {
      await this.wallet.refreshBalance(true);
      const reservedByPeers = Math.max(0, this.entriesInFlight.size - 1) * this.reservedPerEntrySol();
      this.availableTradeSol = Math.max(0, this.wallet.getDeployableSol() - reservedByPeers);
    }

    // Size against the worst-case priority fee: with dynamicPriorityFee the
    // actual fee is resolved later and may exceed the static config value.
    const sizingPriorityFeeSol = this.sizingPriorityFee();

    // One slot of the run budget, carved at arm time. The conviction multiplier
    // is deliberately not applied — see computeRunBudget().
    let unitSizeSol = this.runSlotStakeSol > 0
      ? this.runSlotStakeSol
      : computeEntrySizeSol({
          buyAmountSol: this.config.buyAmountSol,
          sizeMultiplier,
        });

    // Never order more than the balance can actually fund, fees and the
    // slippage buffer included.
    if (this.config.tradingMode === 'real' && this.availableTradeSol > 0) {
      unitSizeSol = affordableStakeSol(
        unitSizeSol,
        this.availableTradeSol,
        this.config.maxSlippagePct,
        sizingPriorityFeeSol
      );
    }

    if (unitSizeSol <= 0.0001) {
      this.log('warn', `⚠️ Insufficient balance (${unitSizeSol.toFixed(4)} SOL computed).`);
      return;
    }

    const be = breakevenPct(unitSizeSol, this.config.priorityFeeSol);
    if (featureFlags.get('enforceTradeEconomics')) {
      const maxBe = this.config.maxBreakevenPct ?? 6;
      if (be > maxBe) {
        this.log('warn', `⚠️ Skipping $${filterResult.tokenSymbol}: round-trip cost ${be}% of a ${unitSizeSol} SOL position exceeds the ${maxBe}% limit. Increase buyAmountSol or lower priorityFeeSol.`, filterResult.mint);
        return;
      }
    }

    await this.executeBuy(filterResult, selectedPlay, unitSizeSol, be, launchData);
  }

  private async executeBuy(
    filterResult: FilterResult,
    playbook: PlaybookType,
    solAmount: number,
    breakevenPctValue = 0,
    launchData?: Partial<PumpTokenLaunch>
  ): Promise<void> {
    // Estimates first — they are all paper mode has, and the fallback when a
    // real fill cannot be read back.
    let investedSol = solAmount;
    let investedUsd = Number((solAmount * this.config.solPriceUsd).toFixed(2));
    // Real quoted price first; marketCap/1e9 only as a fallback, since that
    // divisor assumes a 1B supply that not every pump token actually has.
    let buyPriceUsd = (featureFlags.get('playbookRouting') && (filterResult.priceUsd ?? 0) > 0)
      ? filterResult.priceUsd!
      : (filterResult.marketCapUsd > 0 ? (filterResult.marketCapUsd / 1000000000) : 0.00005);
    let tokensHeld = buyPriceUsd > 0 ? investedUsd / buyPriceUsd : 1000000;
    let buyTxid: string | undefined;
    let fillVerified = false;
    let simulatedFeesSol = 0;
    const positionId = `pos_${Date.now()}_${Math.floor(Math.random()*1000)}`;

    // Pool state at entry: the real curve when pre-migration, the AMM pool
    // afterwards. Paper exits price against this same pool.
    const pool = poolFromLaunch(launchData, {
      liquidityUsd: filterResult.liquidityUsd,
      priceUsd: filterResult.priceUsd ?? buyPriceUsd,
    });

    latencyTimeline.annotate(filterResult.mint, { decision: 'buy_attempted' });

    // Paper mode with honestPaper: price the fill against the real curve and
    // charge the full cost stack, so paper P&L is comparable to live P&L.
    if (this.config.tradingMode === 'paper' && featureFlags.get('honestPaper')) {
      const fill = simulateBuy(solAmount, pool, this.config.solPriceUsd, this.config.priorityFeeSol, true);
      if (fill.tokenDelta > 0) {
        investedSol = Number((-fill.solDelta).toFixed(6));
        investedUsd = Number((investedSol * this.config.solPriceUsd).toFixed(2));
        tokensHeld = fill.tokenDelta;
        buyPriceUsd = investedUsd / tokensHeld;
        simulatedFeesSol = fill.feeSol;
        this.log('info', `🧪 [SIM FILL] Entry impact+fees ${fill.priceImpactPct}% | paid ${investedSol} SOL for ${Math.round(tokensHeld).toLocaleString()} tokens | breakeven ${breakevenPctValue}%`, filterResult.mint);
      } else {
        this.log('warn', `⚠️ Simulated buy produced no tokens for $${filterResult.tokenSymbol} (no pool data) — skipping.`, filterResult.mint);
        return;
      }
    }

    if (this.config.tradingMode === 'real') {
      // Reserve the stake against concurrent entries until the fill (or the
      // failure) resolves the real balance.
      this.availableTradeSol = Math.max(0, this.availableTradeSol - solAmount);
      const result = await this.executeRealMainnetTrade('buy', filterResult.mint, solAmount, undefined, launchData?.pool);
      if (!result) {
        void this.syncLiveWalletBalance();
        latencyTimeline.annotate(filterResult.mint, { decision: 'buy_failed' });
        this.log('error', `❌ Photon real buy failed for $${filterResult.tokenSymbol}. Skipping position creation.`);
        return;
      }
      buyTxid = result.txid;

      // Replace every estimate with what the chain says actually happened:
      // true cost (slippage + all fees included) and true token quantity.
      if (result.fill && result.fill.tokenDelta > 0) {
        investedSol = Number((-result.fill.solDelta).toFixed(6));
        investedUsd = Number((investedSol * this.config.solPriceUsd).toFixed(2));
        tokensHeld = result.fill.tokenDelta;
        buyPriceUsd = investedUsd / tokensHeld;
        fillVerified = true;

        const estUsd = Number((solAmount * this.config.solPriceUsd).toFixed(2));
        const impactPct = estUsd > 0 ? Number((((investedUsd - estUsd) / estUsd) * 100).toFixed(1)) : 0;
        if (Math.abs(impactPct) >= 1) {
          this.log('info', `📗 Entry cost ${investedUsd >= estUsd ? 'above' : 'below'} quote by ${Math.abs(impactPct)}% (real: $${investedUsd} vs quoted: $${estUsd})`, filterResult.mint);
        }
      }
    }

    const position: InternalPosition = {
      id: positionId,
      mint: filterResult.mint,
      tokenName: filterResult.tokenName,
      tokenSymbol: filterResult.tokenSymbol,
      playbook,
      venue: launchData?.pool,
      buyPriceUsd,
      currentPriceUsd: buyPriceUsd,
      highestPriceUsd: buyPriceUsd,
      tokensHeld,
      investedSol,
      investedUsd,
      buyTxid,
      fillVerified,
      entryTime: Date.now(),
      pnlPct: 0,
      pnlUsd: 0,
      pnlSol: 0,
      status: 'OPEN',
      principalRecovered: false,
      moonbagRiding: false,
      score: filterResult.score,
      bondingProgress: filterResult.bondingProgress,
      priceTicks: [{ timestamp: Date.now(), priceUsd: buyPriceUsd }],
      realizedPnlUsd: 0,
      pool,
      simulatedFeesSol,
    };

    this.activePositions.push(position);

    // Watch the creator from the moment we are exposed.
    //
    // This comment used to claim that subscribing to the token's trade stream
    // "is what makes the structural stop possible" while the code only
    // registered the creator and never sent the subscription. The dev-sell
    // handler fires on PumpPortal trade events for tracked mints, and the only
    // subscribeTokenTrade the engine ever sent was a reconnect replay for
    // WATCHLIST mints — a held position was never among them. DEV_SOLD,
    // LINKED_WALLET_SOLD and LARGE_SELL_CLUSTER could therefore never fire for
    // a position we actually held, independently of the free-tier problem.
    //
    // The subscription is sent here now. On an unfunded PumpPortal key it is a
    // no-op (the endpoint requires a key funded with 0.02 SOL and returns zero
    // events), so this changes nothing until that key is funded — at which
    // point the three creator/insider stops start working with no further code
    // change. Until then the loss side rests on CURVE_DRAINED, POOL_DRAINED,
    // SELL_FLOW and the time stop.
    if (featureFlags.get('devSellStop')) {
      // Resolve the creator from every source we have, in order of reliability.
      //
      // Measured: all 178 migrate payloads carry only {signature, mint, txType,
      // pool} — no creator — so 19 of 20 bought tokens had creator 'Unknown'
      // and devSellMonitor.track() returned immediately at its own guard. The
      // three creator stops were therefore dead for a reason INDEPENDENT of the
      // unfunded PumpPortal trade feed, and funding that key would not have
      // fixed them.
      //
      // CurveWatcher already decodes the creator out of the bonding-curve
      // account (curveWatcher.ts:61), and RugCheck reports carry it too. Both
      // are already in memory; neither costs an RPC.
      const creator =
        (launchData?.creator as string | undefined) ||
        this.curveWatcher.getLast(filterResult.mint)?.creator ||
        (launchData?.rugCreator as string | undefined) ||
        undefined;

      if (creator && creator !== 'Unknown') {
        devSellMonitor.track(filterResult.mint, creator);
        this.safeSendWs({ method: 'subscribeTokenTrade', keys: [filterResult.mint] });
      } else {
        this.log('warn', `⚠️ No creator address for $${filterResult.tokenSymbol} — DEV_SOLD, LINKED_WALLET_SOLD and LARGE_SELL_CLUSTER cannot fire on this position.`, filterResult.mint);
      }
    }

    // Watch this position's curve while it is still pre-migration: the curve
    // account is the ONLY live price source (exit ladder) and also powers the
    // drain structural stop. A held position outranks any screening candidate
    // for one of the 40 subscription slots.
    if ((featureFlags.get('devSellStop') || featureFlags.get('playbookRouting')) && pool.vSolInBondingCurve) {
      this.curveWatcher.start();
      if (!this.curveWatcher.isWatching(filterResult.mint) && !this.curveWatcher.watch(filterResult.mint)) {
        const evicted = this.curveWatcher.evictOldest();
        if (evicted) tokenWatchlist.remove(evicted);
        this.curveWatcher.watch(filterResult.mint);
      }
    }

    // Real honeypot test, a few seconds after the fill so the tokens exist.
    // Deliberately not awaited: it must not delay anything on the entry path.
    if (featureFlags.get('honeypotChecks') && this.config.tradingMode === 'real') {
      const delayMs = this.config.sellSimDelayMs ?? 4000;
      setTimeout(() => {
        if (this.activePositions.some(p => p.id === position.id)) {
          void this.verifySellPath(position).catch(() => { /* never let this throw into the timer */ });
        }
      }, delayMs).unref?.();
    }

    reportService.recordPositionOpened();
    latencyTimeline.annotate(filterResult.mint, { decision: 'buy_confirmed' });
    this.log('snipe', `🎯 [BOUGHT] $${filterResult.tokenSymbol} (${filterResult.mint.slice(0,6)}...) | Spent ${investedSol.toFixed(4)} SOL ($${investedUsd}) | Got ${Math.round(tokensHeld).toLocaleString()} tokens @ $${buyPriceUsd.toFixed(8)} | Needs +${breakevenPctValue}% to break even | ${this.config.tradingMode.toUpperCase()}`, filterResult.mint);
  }

  private startPositionMonitoring(): void {
    if (this.monitorInterval) clearInterval(this.monitorInterval);

    this.monitorInterval = setInterval(async () => {
      if (this.activePositions.length === 0 || this.monitorTickInFlight) return;
      this.monitorTickInFlight = true;

      try {
        // One batched request per 30 positions instead of one per position.
        // At 40 open positions this is 2 requests per tick, not 40.
        const mints = this.activePositions.map(p => p.mint);
        const quotes = await DexScreenerService.getManyTokenMarketData(mints);

        // Snapshot first: exits mutate activePositions mid-loop.
        const snapshot = [...this.activePositions];
        if (featureFlags.get('concurrentExits')) {
          // One slow real sell (30s confirm + fill read) must not freeze exit
          // checks for every other position. Triggers/levels are unchanged —
          // this only removes the serialization.
          await Promise.allSettled(
            snapshot.map(pos => this.updateAndCheckPositionExit(pos, quotes.get(pos.mint)))
          );
        } else {
          for (const pos of snapshot) {
            await this.updateAndCheckPositionExit(pos, quotes.get(pos.mint));
          }
        }
        // Repaint with the prices this tick just resolved.
        this.emitChange();
      } catch {
        // Never let one bad tick kill the monitor.
      } finally {
        this.monitorTickInFlight = false;
      }
    }, POSITION_MONITOR_INTERVAL_MS);
  }

  /**
   * Modelled fee stack for one leg, in USD, for the report's "Fees paid" line.
   *
   * Real fills bury their costs inside the balance deltas, so feeDragUsd is
   * correctly 0 for P&L — but that made the report print "Fees paid $0.00",
   * hiding the entire cost stack the economics gate exists to control. This is
   * the modelled figure: protocol fees on the notional plus the flat costs.
   */
  private legFeesUsd(notionalSol: number): number {
    const protocolSol = Math.max(0, notionalSol) * 0.015;
    const flatSol = this.config.priorityFeeSol + 0.000005;
    return Number(((protocolSol + flatSol) * this.config.solPriceUsd).toFixed(4));
  }

  private recordPartialSell(
    pos: InternalPosition,
    fractionSold: number,
    reason: string,
    actual?: { proceedsSol: number; tokensSold: number; txid: string },
    exitCode: ExitCode = 'UNKNOWN'
  ): void {
    // With a real fill, everything derives from chain deltas: the fraction is
    // tokens-actually-sold over tokens held, proceeds are SOL-actually-received
    // (all fees inside), and the cost basis is the pro-rata share of the
    // actual entry cost. Quotes are only used when there is nothing better.
    const tokensBefore = pos.tokensHeld;
    if (actual && tokensBefore > 0) {
      fractionSold = Math.min(1, actual.tokensSold / tokensBefore);
    }

    const proceedsUsd = actual
      ? actual.proceedsSol * this.config.solPriceUsd
      : (tokensBefore * fractionSold) * pos.currentPriceUsd;
    const costBasisUsd = pos.investedUsd * fractionSold;
    const partialPnlUsd = Number((proceedsUsd - costBasisUsd).toFixed(2));
    const partialPnlSol = Number((partialPnlUsd / this.config.solPriceUsd).toFixed(4));
    const partialPnlPct = costBasisUsd > 0
      ? Number((((proceedsUsd - costBasisUsd) / costBasisUsd) * 100).toFixed(1))
      : 0;

    // Update cumulative totals immediately
    pos.realizedPnlUsd += partialPnlUsd;
    this.currentBankrollUsd += partialPnlUsd;
    this.dailyPnlUsd += partialPnlUsd;
    if (this.currentBankrollUsd > this.peakBankrollUsd) {
      this.peakBankrollUsd = this.currentBankrollUsd;
    }

    const tokensSold = actual ? actual.tokensSold : tokensBefore * fractionSold;
    const sellPriceUsd = tokensSold > 0 ? proceedsUsd / tokensSold : pos.currentPriceUsd;

    // Record trade history entry for this partial sell
    pos.legCount = (pos.legCount ?? 0) + 1;
    const record: TradeHistoryRecord = {
      id: `trade_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      positionId: pos.id,
      legIndex: pos.legCount - 1,
      exitCode,
      mint: pos.mint,
      tokenName: pos.tokenName,
      tokenSymbol: pos.tokenSymbol,
      playbook: pos.playbook,
      buyPriceUsd: pos.buyPriceUsd,
      sellPriceUsd,
      investedSol: Number((pos.investedSol * fractionSold).toFixed(4)),
      investedUsd: Number(costBasisUsd.toFixed(2)),
      pnlPct: partialPnlPct,
      pnlUsd: partialPnlUsd,
      pnlSol: partialPnlSol,
      tokensSold,
      fractionSold,
      buyTxid: pos.buyTxid,
      sellTxid: actual?.txid,
      fillVerified: Boolean(actual && pos.fillVerified),
      entryTime: pos.entryTime,
      exitTime: Date.now(),
      holdTimeSeconds: Math.floor((Date.now() - pos.entryTime) / 1000),
      exitReason: `SOLD ${Math.round(fractionSold * 100)}% — ${partialPnlUsd >= 0 ? 'PROFIT' : 'LOSS'} ${partialPnlUsd >= 0 ? '+' : '-'}$${Math.abs(partialPnlUsd)}: ${reason}`,
      // With a real fill, all costs are already inside the balance deltas.
      feeDragUsd: actual ? 0 : 0.20,
      feesPaidUsd: this.legFeesUsd(pos.investedSol * fractionSold),
    };

    this.pushTrade(record);

    // Adjust position remaining capital basis. With a fill, remove exactly the
    // tokens the chain says left the wallet.
    pos.tokensHeld = actual ? Math.max(0, tokensBefore - actual.tokensSold) : tokensBefore * (1 - fractionSold);
    pos.investedUsd = pos.investedUsd * (1 - fractionSold);
    pos.investedSol = pos.investedSol * (1 - fractionSold);

    // Give the surviving bag its own room. `highestPriceUsd` is a monotonic
    // ratchet that was never lowered, so after a partial the trailing target
    // stayed pinned to the all-time peak — the remainder was then force-sold on
    // the next tick a few percent lower, taking the whole position out on one
    // wick. Re-anchoring makes the stop re-arm from here, which is the entire
    // point of scaling out.
    if (pos.tokensHeld > 0 && pos.currentPriceUsd > 0) {
      pos.highestPriceUsd = pos.currentPriceUsd;
      pos.trailingStopTargetUsd = undefined;
      // Reset the trigger count with the anchor. Without this the counter is
      // cumulative for the life of the position, so the SECOND trigger ever —
      // even hours later, after a full re-arm from a new 3x peak — liquidates
      // 100%. That defeats the re-arm design: each armed cycle should get its
      // own scale-out, not inherit the previous cycle's count.
      pos.trailingTriggerCount = 0;
    }
  }

  /**
   * Runs the on-chain leg of a partial sell.
   * Returns null when the sell did NOT happen (caller must not mutate state);
   * `{}` in paper mode; `{txid, actual?}` for a confirmed real sell.
   *
   * `force` bypasses the fee-burn backoff. Structural stops and manual exits
   * MUST pass it: the backoff reaches 10 minutes after 8 failures, and a
   * creator dump completes in one or two transactions. Now that there is no
   * price stop-loss behind them, a muted structural stop is no exit at all.
   */
  private async sellPctReal(
    pos: InternalPosition,
    pct: number,
    force = false
  ): Promise<{ txid?: string; actual?: { proceedsSol: number; tokensSold: number; txid: string } } | null> {
    if (this.config.tradingMode !== 'real') {
      // Paper with honestPaper: walk the same pool the real sell would hit and
      // charge the same fees, so exits are not paid out at an imaginary
      // infinite-depth quote.
      if (featureFlags.get('honestPaper') && pos.pool) {
        const tokensToSell = pos.tokensHeld * (pct / 100);
        if (tokensToSell <= 0) return {};
        const livePool: PoolSnapshot = pos.pool.vSolInBondingCurve
          ? pos.pool
          : { liquidityUsd: pos.pool.liquidityUsd, priceUsd: pos.currentPriceUsd };
        const fill = simulateSell(tokensToSell, livePool, this.config.solPriceUsd, this.config.priorityFeeSol);
        pos.simulatedFeesSol = (pos.simulatedFeesSol ?? 0) + fill.feeSol;
        return {
          actual: {
            proceedsSol: fill.solDelta,
            tokensSold: tokensToSell,
            txid: `sim_${Date.now().toString(36)}`,
          },
        };
      }
      return {};
    }

    // Fee-burn guard. Measured 2026-08-09: a position whose sell kept failing
    // on-chain was retried every ~2s exit tick — 35 failed txs and 0.035 SOL
    // of fees in under a minute. Every failed attempt still pays the full fee,
    // so retries back off exponentially (5s doubling, capped at 10 min).
    const now = Date.now();
    if (!force && pos.sellRetryAfterMs && now < pos.sellRetryAfterMs) {
      pos.sellBlockedByBackoff = true;
      return null;
    }
    pos.sellBlockedByBackoff = false;

    // Exit on the same venue the entry filled on, for the same reason.
    const result = await this.executeRealMainnetTrade('sell', pos.mint, pos.investedSol || this.config.buyAmountSol, `${pct}%`, pos.venue);
    if (!result) {
      pos.sellFailCount = (pos.sellFailCount ?? 0) + 1;
      const delayMs = Math.min(10 * 60_000, 5_000 * Math.pow(2, pos.sellFailCount - 1));
      pos.sellRetryAfterMs = now + delayMs;
      this.log('warn', `⏳ Sell failed ${pos.sellFailCount}x in a row for $${pos.tokenSymbol} — backing off ${Math.round(delayMs / 1000)}s before the next attempt (each failed tx burns the fee). LIQUIDATE retries immediately.`, pos.mint);
      return null;
    }
    pos.sellFailCount = 0;
    pos.sellRetryAfterMs = undefined;

    if (result.fill && result.fill.tokenDelta < 0) {
      return {
        txid: result.txid,
        actual: {
          proceedsSol: Math.max(0, result.fill.solDelta),
          tokensSold: -result.fill.tokenDelta,
          txid: result.txid,
        },
      };
    }
    // Confirmed but the fill couldn't be read — proceed on estimates.
    return { txid: result.txid };
  }

  /** Single write path for trade history: keeps the cache, report and cap in sync. */
  private pushTrade(record: TradeHistoryRecord): void {
    this.tradeHistory.unshift(record);
    if (this.tradeHistory.length > 1000) this.tradeHistory.length = 1000;
    this.statsCache = null;
    reportService.recordTrade(record);
    this.checkKillSwitch();
  }

  /**
   * Flag killSwitch: pause the bot when realized losses over the trailing hour
   * exceed config.maxHourlyLossUsd. Open positions are RETAINED — exits stay
   * on the owner's hold-biased rules; this only stops new entries.
   */
  private checkKillSwitch(): void {
    if (!featureFlags.get('killSwitch') || this.killSwitchTripped || !this.config.isBotActive) return;

    const trip = (why: string) => {
      this.killSwitchTripped = true;
      this.log('error', `🛑 KILL SWITCH TRIPPED: ${why}. Bot paused; open positions retained.`);
      this.toggleBot(false);
    };

    // 1. Rolling-hour realized loss.
    const hourLimit = this.config.maxHourlyLossUsd ?? 70;
    if (hourLimit > 0) {
      const hourPnl = realizedPnlInWindowUsd(this.tradeHistory, 60 * 60 * 1000);
      if (hourPnl <= -hourLimit) return trip(`${hourPnl.toFixed(2)} USD realized in the last hour (limit -$${hourLimit})`);
    }

    // 2. Rolling-24h realized loss. `dailyPnlUsd` was written on every close and
    // read by nothing — no conditional, no log, not even the status payload.
    const dayLimit = this.config.maxDailyLossUsd ?? 0;
    if (dayLimit > 0) {
      const dayPnl = realizedPnlInWindowUsd(this.tradeHistory, 24 * 60 * 60 * 1000);
      if (dayPnl <= -dayLimit) return trip(`${dayPnl.toFixed(2)} USD realized in the last 24h (limit -$${dayLimit})`);
    }

    // 3. Consecutive losses. Same story: incremented, decremented, never read.
    const lossLimit = this.config.maxConsecutiveLosses ?? 0;
    if (lossLimit > 0 && this.consecutiveLosses >= lossLimit) {
      return trip(`${this.consecutiveLosses} consecutive losing trades (limit ${lossLimit})`);
    }
  }

  /** Router/gate thresholds for the current risk tier. */
  private activePlaybook(): PlaybookConfig {
    return playbookConfigFor(this.config.leniencyMode);
  }

  /**
   * Applies one risk tier to every gate coherently: Gate 0 concentration caps
   * (RiskFilter), the real-data gate (EntryGateV2) and — via activePlaybook()
   * — the router bands and Play 2 triggers. One knob, not five.
   */
  private applyRiskTier(mode: LeniencyMode): void {
    this.riskFilter.setLeniencyMode(mode);
    entryGateV2.updateConfig(mode === 'strict'
      ? { maxTop10Pct: 30, maxSingleHolderPct: 12, maxDevInitialBuyPct: 6, maxInsiderPct: 35, minDevInitialBuySol: 0.1 }
      : { maxTop10Pct: 45, maxSingleHolderPct: 20, maxDevInitialBuyPct: 10, maxInsiderPct: 45, minDevInitialBuySol: 0.05 });
    // Deliberately NOT loosened at any tier: requireVerifiedConcentration
    // (unknown is not safe) and maxDevInitialBuySol (the mayhem ban).
  }

  /**
   * Can this configuration actually open a position with this wallet?
   *
   * Answers, at arm time, the two questions that silently produced a 0-trade
   * 89-minute live run: is the stake the router will actually size big enough
   * to clear maxBreakevenPct, and can the balance fund it?
   *
   * Sized against a HALF unit deliberately — the router awards a full unit only
   * above minScoreFullUnit (71 strict), and the highest score observed across
   * 3,635 real candidates is 66. The half unit is the realistic case, not the
   * pessimistic one.
   */
  public preflightRealMode(): { ok: boolean; reasons: string[]; stakeSol: number; breakevenPct: number; requiredSol: number } {
    const reasons: string[] = [];
    const sizingPriorityFeeSol = this.sizingPriorityFee();
    const maxBe = this.config.maxBreakevenPct ?? 6;
    const deployable = this.wallet.getDeployableSol();

    // What the next entry would actually stake: one slot of the run budget with
    // wallet-split sizing, otherwise the router's half unit.
    const budget = this.computeRunBudget();
    const stakeSol = this.config.walletSplitSizing
      ? budget.stakePerSlotSol
      : this.config.buyAmountSol * 0.5;
    const be = stakeSol > 0 ? breakevenPct(stakeSol, this.config.priorityFeeSol) : 0;

    // Smallest stake whose round-trip cost fits the limit: fixed costs are
    // 2 priority fees + 2 base fees + ATA rent, variable is 3% of stake.
    const fixedSol = sizingPriorityFeeSol * 2 + 0.00001 * 2 + 0.00203928;
    const minEconomicStake = (maxBe / 100) > 0.03 ? fixedSol / ((maxBe / 100) - 0.03) : Infinity;

    if (stakeSol <= 0) {
      reasons.push(
        this.config.walletSplitSizing
          ? `nothing deployable to split. Deployable ${deployable.toFixed(4)} SOL across ${budget.slots} slots leaves no fundable stake.`
          : `computed stake is zero.`
      );
    } else if (featureFlags.get('enforceTradeEconomics') && be > maxBe) {
      if (this.config.walletSplitSizing) {
        // Per slot the wallet must hold the stake plus its own buffer; scale up
        // by the slot count for the whole run, plus the gas float.
        const perSlotWallet = minEconomicStake * (1 + this.config.maxSlippagePct / 100 + 0.015) + sizingPriorityFeeSol + 0.0025;
        const fraction = Math.min(100, Math.max(1, this.config.maxDeployedFractionPct ?? 60)) / 100;

        reasons.push(
          `each slot is too small to trade economically. ${deployable.toFixed(4)} SOL deployable, committing ` +
          `${Math.round(fraction * 100)}% split ${budget.slots} way${budget.slots === 1 ? '' : 's'}, stakes ` +
          `${stakeSol.toFixed(4)} SOL per position — a ${be}% round trip against the ${maxBe}% limit, so EVERY candidate would be refused.`
        );

        // Name the concrete ways out, computed rather than hand-waved.
        //
        // The first question is whether ANY slot count works at this balance.
        // Reporting only "fund X to keep N slots" is misleading when even one
        // slot fails — it implies the slot count is the problem when the wallet
        // is. Check the best case (1 slot, everything deployed) first.
        const fixes: string[] = [];
        const bestCase = fitSlotsToWallet({
          deployableSol: deployable, maxSlots: 1,
          maxSlippagePct: this.config.maxSlippagePct, priorityFeeSol: sizingPriorityFeeSol,
          maxBreakevenPct: maxBe, breakevenOf: breakevenPct,
        });

        if (bestCase.slots === 0) {
          // Nothing works at this balance. Say so, and give the real number.
          const minWallet = minWalletForSlots({
            slots: 1, maxSlippagePct: this.config.maxSlippagePct,
            priorityFeeSol: sizingPriorityFeeSol, maxBreakevenPct: maxBe,
          });
          reasons.push(
            `NO configuration can trade at this balance — not even 1 slot with 100% deployed. ` +
            `This is wallet size, not settings: fixed Solana costs are ~${(sizingPriorityFeeSol * 2 + 0.00203928 + 0.00001).toFixed(4)} SOL per round trip ` +
            `no matter how small the stake, so below a certain size fees alone exceed the ${maxBe}% limit.`
          );
          fixes.push(`fund at least ~${minWallet.toFixed(2)} SOL for a single position at the current ${sizingPriorityFeeSol} priority fee`);
          const cheapWallet = minWalletForSlots({
            slots: 1, maxSlippagePct: this.config.maxSlippagePct,
            priorityFeeSol: 0.001, maxBreakevenPct: maxBe,
          });
          if (cheapWallet < minWallet) {
            fixes.push(`or ~${cheapWallet.toFixed(2)} SOL if you also drop priorityFeeSol to 0.001 (cheaper fills lose migration races)`);
          }
          fixes.push(`raising maxBreakevenPct instead would let it trade, but every trade would then need >${be}% just to break even — that is how a wallet bleeds out with no rug involved`);
        } else {
          // One slot works; the requested slot count is the thing to change.
          const needFullWallet = (perSlotWallet * budget.slots) / fraction + 0.005;
          fixes.push(`set maxActivePositions to ${bestCase.slots} — ${bestCase.stakePerSlotSol.toFixed(4)} SOL at ${bestCase.breakevenPct}%, which clears the limit today`);
          fixes.push(`or fund ~${needFullWallet.toFixed(2)} SOL to keep ${budget.slots} slot${budget.slots === 1 ? '' : 's'} at the current ${Math.round(fraction * 100)}% cap`);
          if (fraction < 1) {
            fixes.push(`or raise maxDeployedFractionPct to 100`);
          }
        }
        reasons.push(`Options: ${fixes.join('; ')}.`);
      } else {
        reasons.push(
          `position size too small. The router sizes a half unit (${stakeSol.toFixed(4)} SOL of your ${this.config.buyAmountSol} SOL unit), ` +
          `whose round-trip cost is ${be}% — above the ${maxBe}% limit, so EVERY candidate would be refused. ` +
          `Raise buyAmountSol to about ${(minEconomicStake * 2).toFixed(2)} SOL, or lower priorityFeeSol.`
        );
      }
    }

    // What the balance must hold to fund one order: stake x (1 + slippage +
    // protocol fees) + priority fee + overhead + the gas float.
    const requiredPerPosition = stakeSol * (1 + this.config.maxSlippagePct / 100 + 0.015) + sizingPriorityFeeSol + 0.0025;
    const requiredSol = Number((requiredPerPosition + 0.005).toFixed(4));

    if (stakeSol > 0 && deployable > 0 && deployable < requiredPerPosition) {
      reasons.push(
        `wallet cannot fund one position. Deployable ${deployable.toFixed(4)} SOL, need ${requiredPerPosition.toFixed(4)} SOL for a ${stakeSol.toFixed(4)} SOL stake at ${this.config.maxSlippagePct}% slippage.`
      );
    }

    return { ok: reasons.length === 0, reasons, stakeSol, breakevenPct: be, requiredSol };
  }

  /**
   * The only REAL honeypot test in the codebase: build the sell we would
   * actually send and ask the RPC to run it without submitting.
   *
   * `simulateSellPath` has existed, correct and unused, with zero call sites —
   * while the pre-buy gate carried `sellSimPassed = true` as a hardcoded
   * constant. A honeypot is a blocked SELL, which no buy-side check can catch,
   * so until now the entire blocked-sell scam class was undetectable.
   *
   * Runs a few seconds AFTER the fill (it needs the tokens to exist) and off the
   * hot path, so it costs the entry nothing. A failure latches a forced exit —
   * which will itself fail if the token truly cannot be sold, and is then capped
   * by maxForceExitAttempts and reported as STRANDED rather than burning fees
   * forever.
   */
  private async verifySellPath(pos: InternalPosition): Promise<void> {
    if (!featureFlags.get('honeypotChecks')) return;
    if (this.config.tradingMode !== 'real') return;

    const keypair = this.wallet.getKeypair();
    if (!keypair) return;

    const result = await simulateSellPath(
      this.solanaConnection,
      async () => {
        try {
          const response = await axios.post('https://pumpportal.fun/api/trade-local', {
            publicKey: keypair.publicKey.toBase58(),
            action: 'sell',
            mint: pos.mint,
            denominatedInSol: 'false',
            amount: sellAmountParam('100%'),
            slippage: this.config.maxSlippagePct,
            priorityFee: this.config.priorityFeeSol,
            pool: pos.venue || 'auto',
          }, { responseType: 'arraybuffer', timeout: 8000 });
          if (response.status !== 200) return null;
          return VersionedTransaction.deserialize(new Uint8Array(response.data));
        } catch {
          return null;
        }
      },
      (msg: string) => this.log('warn', `🍯 [SELL SIM] $${pos.tokenSymbol}: ${msg}`, pos.mint)
    );

    if (result === false) {
      this.log('error', `🍯 [HONEYPOT CONFIRMED] $${pos.tokenSymbol} — a full sell SIMULATES AS REVERTING. Exiting immediately; if the sell truly cannot land this position will be marked STRANDED.`, pos.mint);
      pos.forceExitReason = 'honeypot: sell simulation reverts';
      pos.honeypotConfirmed = true;
    } else if (result === true) {
      pos.sellPathVerified = true;
      this.log('info', `✅ [SELL PATH OK] $${pos.tokenSymbol} — a full exit simulates cleanly.`, pos.mint);
    }
    // null = could not simulate; leave the position alone rather than acting on
    // an unknown. The structural exits and the time stop still apply.
  }

  /** Immediate manual stop for the API: pause entries, keep positions. */
  public emergencyStop(): { stopped: boolean } {
    if (this.config.isBotActive) this.toggleBot(false);
    this.log('warn', '🛑 EMERGENCY STOP invoked via API. Entries disabled; open positions retained.');
    return { stopped: true };
  }

  private async updateAndCheckPositionExit(pos: InternalPosition, prefetched?: DexScreenerData): Promise<void> {
    try {
      const dexData = prefetched ?? await DexScreenerService.getTokenMarketData(pos.mint);

      let currentMarketCap = dexData.hasPair && dexData.marketCapUsd > 0 ? dexData.marketCapUsd : pos.buyPriceUsd * 1000000000;

      const timeElapsedSec = Math.floor((Date.now() - pos.entryTime) / 1000);

      // A structural stop that already fired outranks every other rule and keeps
      // retrying until the bag is gone.
      //
      // This sits AFTER dexData is fetched and BELOW the price update further
      // down only in the sense that it re-runs each tick — but it deliberately
      // still short-circuits, because once we have decided to leave, nothing
      // below can change that decision. What it must NOT do is retry forever:
      // executeSell passes force=true, which bypasses the 5s..10min fee-burn
      // backoff, so an unsellable token (honeypot, dead pool) would submit a
      // full-fee failing transaction every second indefinitely. Precedent: 35
      // failed txs and 0.035 SOL in under a minute.
      if (pos.forceExitReason) {
        pos.forceExitAttempts = (pos.forceExitAttempts ?? 0) + 1;
        const capExceeded = pos.forceExitAttempts > (this.config.maxForceExitAttempts ?? 20);
        const agedOut = timeElapsedSec >= this.config.maxHoldSeconds;

        if (capExceeded || agedOut) {
          if (!pos.strandedLogged) {
            pos.strandedLogged = true;
            this.log('error',
              `🧟 STRANDED: $${pos.tokenSymbol} could not be sold after ${pos.forceExitAttempts} forced attempts (${pos.forceExitReason}). ` +
              `Halting automatic retries to stop burning fees — the position stays open and LIQUIDATE still works.`, pos.mint);
          }
          return;
        }
        await this.executeSell(pos, `SOLD ALL — ${pos.forceExitReason}`, true);
        return;
      }

      // Fresh-migration blind window. Play 3 — the only play this bot actually
      // reaches — enters at graduation, when DexScreener has typically not
      // indexed the new pool yet (measured: 51 of 71 rows had hasLiveMarketData
      // true with liquidityUsd 0). POOL_DRAINED and SELL_FLOW both require an
      // indexed pair, and a migrated position gets no curve subscription, so for
      // those first minutes the ONLY loss-side exit is the 30-minute timer.
      //
      // This is the no-price-stop replacement for that hole: if a position has
      // had NO usable market data at all for noDataExitSeconds, leave. It cannot
      // fire on volatility because it never looks at a price — only at whether a
      // market exists.
      const hasUsableMarket =
        (dexData.hasPair && (dexData.priceUsd > 0 || dexData.liquidityUsd > 0)) ||
        (pos.lastCurvePriceUsd ?? 0) > 0;
      if (hasUsableMarket) {
        pos.firstMarketDataAt = pos.firstMarketDataAt ?? Date.now();
      } else if (!pos.firstMarketDataAt) {
        const blindSec = this.config.noDataExitSeconds ?? 180;
        if (timeElapsedSec >= blindSec) {
          this.log('warn', `⏱️ [NO-DATA EXIT] $${pos.tokenSymbol} — no market data ${blindSec}s after entry. Leaving rather than holding blind to the ${Math.floor(this.config.maxHoldSeconds / 60)}-minute timer.`, pos.mint);
          await this.executeSell(pos, `SOLD ALL — no market data ${blindSec}s after entry (never indexed)`);
          return;
        }
      }

      // Pre-migration: no DexScreener pair exists, but the bonding curve
      // account IS the market — CurveWatcher streams its reserves. A fresh
      // curve price (<30s) lets the full exit ladder (stop-loss, take-profit,
      // trailing stop) protect on-curve positions that previously could only
      // ever time out.
      const curvePriceFresh =
        (pos.lastCurvePriceUsd ?? 0) > 0 &&
        pos.lastCurvePriceAt !== undefined &&
        Date.now() - pos.lastCurvePriceAt < 30_000;

      if (!dexData.hasPair && !curvePriceFresh) {
        if (this.config.tradingMode === 'real') {
          // Real money: never act on an invented price — no stop-loss or
          // take-profit off a random walk. But a token that never indexes on
          // DexScreener must still age out, or it becomes an unsellable
          // position held forever. PumpPortal sells by percentage, so the
          // exit needs no price; the fill tells us what it was worth.
          if (timeElapsedSec >= this.config.maxHoldSeconds) {
            await this.executeSell(pos, `Time stop with no market data (${Math.floor(this.config.maxHoldSeconds / 60)} min, pair never indexed)`);
          }
          return;
        }
        // honestPaper: paper behaves exactly like real money here — an unpriced
        // position sits at its entry price and ages out. It does NOT get an
        // invented chart.
        //
        // The legacy line below multiplies price by 1 + (rand*0.12 - 0.048)
        // every 2s. Measured: +1.127% geometric drift per tick = +40.2% per
        // minute. Across 200,000 simulated positions under the engine's own
        // exit rules, 95.1% hit the +100% take-profit (median 114s) and 0.0%
        // ever hit the stop-loss. That is the whole reason paper looked
        // profitable while the live wallet shrank.
        if (featureFlags.get('honestPaper')) {
          if (timeElapsedSec >= this.config.maxHoldSeconds) {
            await this.executeSell(pos, `SOLD ALL — max hold time reached (${Math.floor(this.config.maxHoldSeconds / 60)} min), price never available`);
          }
          return;
        }
        const mockFluctuation = 1 + ((Math.random() * 0.12) - 0.048);
        currentMarketCap = currentMarketCap * mockFluctuation;
      }

      // Prefer the QUOTED price over marketCap/1e9. That divisor assumes every
      // token has exactly 1B supply — verified counter-example 2026-08-05:
      // mint 243zZgun...pump ($SMISKI) carries 2B supply, which makes the
      // derived price 2x wrong and corrupts P&L and every exit trigger on that
      // position. DexScreener publishes the real per-token price already.
      const priceSource: 'curve' | 'dex' | 'mcap' = (!dexData.hasPair && curvePriceFresh)
        ? 'curve'
        : (featureFlags.get('playbookRouting') && dexData.hasPair && dexData.priceUsd > 0)
          ? 'dex'
          : 'mcap';
      const currentPriceUsd = priceSource === 'curve'
        ? pos.lastCurvePriceUsd!
        : priceSource === 'dex'
          ? dexData.priceUsd
          : currentMarketCap / 1000000000;

      const prevPriceUsd = pos.currentPriceUsd;
      pos.currentPriceUsd = currentPriceUsd;

      if (!pos.priceTicks) pos.priceTicks = [];
      pos.priceTicks.push({ timestamp: Date.now(), priceUsd: currentPriceUsd });
      if (pos.priceTicks.length > 60) pos.priceTicks.shift();

      // The three price feeds are not comparable. `mcap/1e9` assumes a 1B supply
      // (verified 2x wrong on the 2B-supply $SMISKI), and a curve price and a
      // DexScreener quote for the same token routinely differ across migration.
      // A peak recorded under one source must never arm a stop measured under
      // another: re-anchor on any source change so a bogus high cannot strand
      // the position at 0.7x an invented peak with no recovery path.
      if (pos.priceSource && pos.priceSource !== priceSource) {
        pos.highestPriceUsd = currentPriceUsd;
        pos.trailingStopTargetUsd = undefined;
        pos.lowBuyPressureTicks = 0;
      }
      pos.priceSource = priceSource;

      // Reject an implausible single-tick spike for PEAK purposes only. A >300%
      // jump in one second is a bad quote, and the peak is permanent once set.
      if (acceptPeakUpdate({
        candidatePriceUsd: currentPriceUsd,
        prevPriceUsd,
        currentPeakUsd: pos.highestPriceUsd,
      })) {
        pos.highestPriceUsd = currentPriceUsd;
      }

      const currentValuationUsd = pos.tokensHeld * currentPriceUsd;
      const unrealizedPnlUsd = currentValuationUsd - pos.investedUsd;
      pos.pnlUsd = Number((pos.realizedPnlUsd + unrealizedPnlUsd).toFixed(2));
      pos.pnlSol = Number((pos.pnlUsd / this.config.solPriceUsd).toFixed(4));
      pos.pnlPct = Number((((currentPriceUsd - pos.buyPriceUsd) / pos.buyPriceUsd) * 100).toFixed(1));

      // STRUCTURAL EXIT — pool drained. The post-migration twin of CURVE_DRAINED
      // (which only sees the bonding curve). `dexData.liquidityUsd` was already
      // being fetched on every exit tick and thrown away. Liquidity leaving the
      // pool is the event that actually makes a bag unsellable, and unlike a
      // price stop it cannot be triggered by ordinary volatility.
      if (dexData.hasPair && dexData.liquidityUsd > 0) {
        const drainFraction = this.config.poolDrainExitFraction ?? 0.5;
        if (isPoolDrained({
          peakLiquidityUsd: pos.peakLiquidityUsd ?? 0,
          currentLiquidityUsd: dexData.liquidityUsd,
          drainFraction,
        })) {
          const pct = Math.round((1 - dexData.liquidityUsd / pos.peakLiquidityUsd!) * 100);
          this.log('sell', `🚨 [STRUCTURAL STOP: POOL_DRAINED] $${pos.tokenSymbol} — liquidity fell ${pct}% from $${Math.round(pos.peakLiquidityUsd!).toLocaleString()} to $${Math.round(dexData.liquidityUsd).toLocaleString()}. Selling everything now.`, pos.mint);
          pos.forceExitReason = `structural stop: pool liquidity drained ${pct}% from its peak`;
          await this.executeSell(pos, `SOLD ALL — structural stop: pool liquidity drained ${pct}%`, true);
          return;
        }
        pos.peakLiquidityUsd = Math.max(pos.peakLiquidityUsd ?? 0, dexData.liquidityUsd);
      }

      // STRUCTURAL EXIT — sell flow. Buy pressure collapsing across consecutive
      // ticks on a pool that is still trading is the crowd leaving, which is a
      // different event from the price wobbling. Requires real volume so a dead
      // pair with no trades cannot trip it.
      const sellFlowTicks = this.config.sellFlowExitTicks ?? 3;
      if (dexData.hasPair && dexData.volume5mUsd > 0 && typeof dexData.buyPressurePct === 'number') {
        if (dexData.buyPressurePct < 25) {
          pos.lowBuyPressureTicks = (pos.lowBuyPressureTicks ?? 0) + 1;
          if (pos.lowBuyPressureTicks >= sellFlowTicks) {
            this.log('sell', `🚨 [STRUCTURAL STOP: SELL_FLOW] $${pos.tokenSymbol} — buy pressure ${dexData.buyPressurePct.toFixed(0)}% for ${pos.lowBuyPressureTicks} consecutive ticks. Selling everything now.`, pos.mint);
            pos.forceExitReason = `structural stop: buy pressure collapsed to ${dexData.buyPressurePct.toFixed(0)}%`;
            await this.executeSell(pos, `SOLD ALL — structural stop: buy pressure collapsed to ${dexData.buyPressurePct.toFixed(0)}%`, true);
            return;
          }
        } else {
          pos.lowBuyPressureTicks = 0;
        }
      }

      // Moonbag ratchet. Arms only once the position has genuinely run
      // (trailingArmMultiple, default 3x). The old 1.3x arm made this the bot's
      // primary liquidator: it forced an exit at 1.04x — below the 5.68%
      // round-trip breakeven — and any position peaking between 1.30x and
      // 1.8824x cleared no profit rung at all before being fully liquidated on
      // one 20% wick, which on pump.fun is noise.
      const armedTarget = trailingStopTargetUsd({
        highestPriceUsd: pos.highestPriceUsd,
        buyPriceUsd: pos.buyPriceUsd,
        armMultiple: this.config.trailingArmMultiple ?? 3.0,
        trailingStopPct: this.config.trailingStopPct,
        useTrailingStop: this.config.useTrailingStop,
      });
      if (armedTarget !== undefined) pos.trailingStopTargetUsd = armedTarget;

      const pullbackFromPeakPct = ((pos.highestPriceUsd - currentPriceUsd) / pos.highestPriceUsd) * 100;
      // Each profit rung has its OWN latch. They used to share
      // `principalRecovered`, which made them mutually exclusive: whichever
      // fired first consumed the latch, so a token that pulled back at +65% and
      // then ran to +100% took exactly one 50% sale and nothing more until
      // +400%. A 2.9x round trip banked one leg near +65% and rode the rest to
      // the time stop.
      if (pos.pnlPct >= 60 && pullbackFromPeakPct >= 15 && !pos.pullbackRungTaken) {
        // Sell first, book only what actually happened. Flags are set after a
        // confirmed sell so a failed exit is retried next tick instead of
        // silently recorded as banked profit.
        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;

        pos.pullbackRungTaken = true;
        pos.principalRecovered = true;
        pos.status = 'PARTIAL_PROFIT';
        this.recordPartialSell(pos, 0.5, `price fell ${pullbackFromPeakPct.toFixed(0)}% from its peak while up ${pos.pnlPct}%`, sale.actual, 'PULLBACK_PARTIAL');
        this.log('sell', `📉 [SOLD 50%] $${pos.tokenSymbol} — was up +${pos.pnlPct}%, price dropped ${pullbackFromPeakPct.toFixed(0)}% from peak $${pos.highestPriceUsd.toFixed(6)}${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding 50%.`, pos.mint);
        return;
      }

      if (pos.pnlPct >= this.config.takeProfitPct && !pos.tp1Taken) {
        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;

        pos.tp1Taken = true;
        pos.principalRecovered = true;
        pos.status = 'PARTIAL_PROFIT';
        this.recordPartialSell(pos, 0.5, `hit take-profit target of +${this.config.takeProfitPct}%`, sale.actual, 'TP1');
        this.log('sell', `💰 [SOLD 50%] $${pos.tokenSymbol} — hit +${pos.pnlPct}% (target +${this.config.takeProfitPct}%)${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding 50%.`, pos.mint);
        return;
      }

      if (pos.pnlPct >= this.config.takeProfitRung2Pct && !pos.moonbagRiding) {
        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;

        pos.moonbagRiding = true;
        this.recordPartialSell(pos, 0.5, `hit second take-profit target of +${this.config.takeProfitRung2Pct}%`, sale.actual, 'TP2');
        this.log('sell', `🔥 [SOLD 50%] $${pos.tokenSymbol} — hit +${pos.pnlPct}% (target +${this.config.takeProfitRung2Pct}%)${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding the rest.`, pos.mint);
        return;
      }

      // Trailing stop: scale out, do not liquidate. The first trigger takes half
      // and re-anchors (recordPartialSell clears the target), so a single wick
      // can no longer take the whole position — the old code sold 50% at
      // 0.85x peak and then force-sold the remainder at 0.80x peak on the very
      // next tick. Only a second, independently re-armed trigger closes it.
      if (pos.trailingStopTargetUsd && currentPriceUsd <= pos.trailingStopTargetUsd) {
        pos.trailingTriggerCount = (pos.trailingTriggerCount ?? 0) + 1;
        const trailReason = `trailing stop: price fell ${this.config.trailingStopPct}% from its peak of $${pos.highestPriceUsd.toFixed(6)}`;

        if (pos.trailingTriggerCount >= 2) {
          await this.executeSell(pos, `SOLD ALL — ${trailReason} (second trigger)`);
          return;
        }

        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;
        pos.status = 'PARTIAL_PROFIT';
        this.recordPartialSell(pos, 0.5, trailReason, sale.actual, 'TRAILING_PARTIAL');
        this.log('sell', `📉 [SOLD 50%] $${pos.tokenSymbol} — ${trailReason}${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding 50%; the stop must re-arm from here.`, pos.mint);
        return;
      }

      // NO PRICE STOP-LOSS. The `-stopLossPct` block that stood here was deleted
      // 2026-08-09 at the owner's direction: on this asset class a 35% drawdown
      // is routine intra-trade noise, and stopping out of it converted recoverable
      // volatility into realized losses. The loss side is now carried by the
      // structural exits above (creator sell, curve drain, pool drain, sell-flow
      // collapse) and the time stop below. A position on an intact pool that
      // simply bleeds is held to `maxHoldSeconds` — that is the accepted risk.

      if (timeElapsedSec >= this.config.maxHoldSeconds) {
        await this.executeSell(pos, `SOLD ALL — max hold time reached (${Math.floor(this.config.maxHoldSeconds / 60)} min)`);
        return;
      }

    } catch (err: any) {
      // ignore
    }
  }

  public async executeSell(pos: InternalPosition, reason: string, force = false): Promise<void> {
    // One exit at a time per position. The WS handler is `on('message', async
    // ...)`, so awaiting a ~30s sell confirmation does NOT defer later messages:
    // a structural alert could re-enter this method while a monitor-tick exit
    // was still in flight, booking the same position twice and double-crediting
    // the bankroll, the daily P&L and the kill-switch window.
    if (pos.exitInFlight) return;
    pos.exitInFlight = true;
    try {
      await this.executeSellInner(pos, reason, force);
    } finally {
      pos.exitInFlight = false;
    }
  }

  private async executeSellInner(pos: InternalPosition, reason: string, force: boolean): Promise<void> {
    // Sell FIRST. Position state is only touched once we know what happened —
    // a failed real exit keeps the position tracked and retried, never dropped.
    const sale = await this.sellPctReal(pos, 100, force);
    if (sale === null) {
      if (!pos.sellBlockedByBackoff) {
        this.log('warn', `⚠️ SELL FAILED for $${pos.tokenSymbol} (${reason}) — still holding, will retry next tick.`, pos.mint);
      }
      return;
    }

    // "Sold everything" must mean the tokens actually left the wallet. When the
    // chain says otherwise, book only what really sold and keep the position
    // open — closing it here strands a real bag behind a closed trade and
    // prices the whole cost basis against a sliver of proceeds (measured
    // 2026-08-09: 100 of 2206 $GREEN sold, reported as a closed -96.8%).
    if (sale.actual && pos.tokensHeld > 0) {
      const soldFraction = sale.actual.tokensSold / pos.tokensHeld;
      if (soldFraction < 0.95) {
        this.log('error',
          `❌ [PARTIAL EXIT] $${pos.tokenSymbol}: exit filled only ${Math.round(sale.actual.tokensSold).toLocaleString()} of ${Math.round(pos.tokensHeld).toLocaleString()} tokens (${(soldFraction * 100).toFixed(1)}%). Position stays OPEN with the remainder — it was NOT closed.`,
          pos.mint);
        this.recordPartialSell(pos, soldFraction, `${reason} [partial fill — ${(soldFraction * 100).toFixed(1)}% only]`, sale.actual, 'PARTIAL_FILL');
        return;
      }
    }

    const exitTime = Date.now();
    const holdTimeSeconds = Math.floor((exitTime - pos.entryTime) / 1000);
    const tokensSold = sale.actual ? sale.actual.tokensSold : pos.tokensHeld;
    const fractionSold = pos.tokensHeld > 0 ? Math.min(1, tokensSold / pos.tokensHeld) : 1;

    // Proceeds: on-chain SOL received when we have the fill, quote estimate otherwise.
    const proceedsUsd = sale.actual
      ? sale.actual.proceedsSol * this.config.solPriceUsd
      : pos.tokensHeld * pos.currentPriceUsd;
    const feeDragUsd = sale.actual ? 0 : 0.40;
    const finalPnlUsd = Number((proceedsUsd - pos.investedUsd - feeDragUsd).toFixed(2));
    const totalPositionPnlUsd = Number((pos.realizedPnlUsd + finalPnlUsd).toFixed(2));

    this.activePositions = this.activePositions.filter(p => p.id !== pos.id);
    devSellMonitor.untrack(pos.mint);
    // Free the curve subscription slot unless the screening watchlist still
    // has a claim on this mint.
    if (!tokenWatchlist.has(pos.mint)) this.curveWatcher.unwatch(pos.mint);
    this.curvePeakSol.delete(pos.mint);

    const sellPriceUsd = tokensSold > 0 ? proceedsUsd / tokensSold : pos.currentPriceUsd;
    const finalPnlPct = pos.investedUsd > 0
      ? Number((((proceedsUsd - feeDragUsd - pos.investedUsd) / pos.investedUsd) * 100).toFixed(1))
      : 0;

    // Record only THIS leg's P&L. Any partial sells already wrote their own
    // records, so carrying the cumulative figure here would double-count every
    // partial when the history is summed for stats and the run report.
    pos.legCount = (pos.legCount ?? 0) + 1;
    const record: TradeHistoryRecord = {
      id: pos.id,
      positionId: pos.id,
      legIndex: pos.legCount - 1,
      exitCode: classifyExitReason(reason),
      mint: pos.mint,
      tokenName: pos.tokenName,
      tokenSymbol: pos.tokenSymbol,
      playbook: pos.playbook,
      buyPriceUsd: pos.buyPriceUsd,
      sellPriceUsd,
      investedSol: pos.investedSol,
      investedUsd: pos.investedUsd,
      pnlPct: finalPnlPct,
      pnlUsd: finalPnlUsd,
      pnlSol: Number((finalPnlUsd / this.config.solPriceUsd).toFixed(4)),
      tokensSold,
      fractionSold,
      buyTxid: pos.buyTxid,
      sellTxid: sale.actual?.txid ?? sale.txid,
      fillVerified: Boolean(sale.actual && pos.fillVerified),
      entryTime: pos.entryTime,
      exitTime,
      holdTimeSeconds,
      exitReason: pos.realizedPnlUsd !== 0
        ? `${reason} [final leg; position total ${totalPositionPnlUsd >= 0 ? '+' : ''}$${totalPositionPnlUsd}]`
        : reason,
      feeDragUsd,
      feesPaidUsd: this.legFeesUsd(pos.investedSol),
    };

    this.pushTrade(record);

    this.currentBankrollUsd += finalPnlUsd;
    this.dailyPnlUsd += finalPnlUsd;

    if (this.currentBankrollUsd > this.peakBankrollUsd) {
      this.peakBankrollUsd = this.currentBankrollUsd;
    }

    if (totalPositionPnlUsd < 0) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    const emoji = totalPositionPnlUsd >= 0 ? '🟢' : '🔴';
    const basis = record.fillVerified ? 'on-chain' : (this.config.tradingMode === 'paper' ? 'simulated' : 'estimated');
    const verdict = totalPositionPnlUsd >= 0 ? 'MADE' : 'LOST';
    this.log('sell', `${emoji} [SOLD ALL] $${pos.tokenSymbol} — ${verdict} ${totalPositionPnlUsd >= 0 ? '+' : '-'}$${Math.abs(totalPositionPnlUsd)} on the whole position (${basis}) | ${reason}`, pos.mint);
  }

  public async manualSellPosition(positionId: string): Promise<boolean> {
    const pos = this.activePositions.find(p => p.id === positionId);
    if (!pos) return false;

    // A human clicking LIQUIDATE overrides the automatic-retry backoff.
    pos.sellRetryAfterMs = undefined;
    await this.executeSell(pos, 'Manual User Force Sell Override', true);
    return true;
  }

  public clearTradeHistory(): void {
    this.tradeHistory = [];
    this.statsCache = null;
    this.dailyPnlUsd = 0;
    this.consecutiveLosses = 0;
    this.log('info', '🧹 Trade History & Performance Logs Reset.');
  }

  public resetAll(): void {
    // Close out any in-flight run first so the work isn't silently discarded.
    if (reportService.isRunning()) this.finishRun();

    this.config.isBotActive = false;
    this.unsubscribeStream();
    this.activePositions = [];
    this.tradeHistory = [];
    this.statsCache = null;
    this.logs = [];
    this.dailyPnlUsd = 0;
    this.consecutiveLosses = 0;
    this.currentBankrollUsd = 100;
    this.peakBankrollUsd = 100;
    this.log('info', '🧹 ALL BOTS & POSITIONS FULLY RESET TO CLEAN STATE.');
  }

  private log(level: BotLogEntry['level'], message: string, mint?: string): void {
    const now = Date.now();

    this.logs.push({
      id: `log_${now}_${Math.floor(Math.random() * 1000)}`,
      timestamp: now,
      level,
      message,
      mint,
    });

    // Hard cap only. Age-based pruning happens once per getStatus() rather than
    // rebuilding the whole array on every single log line.
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);

    console.log(`[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${message}`);
    this.emitChange();
  }

  // ---------------- CHANGE NOTIFICATION ----------------

  /**
   * Subscribe to "something happened worth pushing" — order submitted, fill
   * confirmed, position opened or closed, price moved.
   *
   * Without this the SSE endpoint could only re-send state on a fixed timer, so
   * a buy or sell surfaced up to a full second after it happened. Listeners are
   * expected to coalesce; this fires on every log line.
   *
   * @returns an unsubscribe function.
   */
  public onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      // A broken listener (dead SSE socket) must never break the engine.
      try { listener(); } catch { /* ignore */ }
    }
  }
}

export const sniperEngine = new SniperEngine();
