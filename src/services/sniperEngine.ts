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
  TradeHistoryRecord
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
import { computeAgeSeconds, detectMigration, realizedPnlInWindowUsd } from './pipelineUtils';
import { breakevenPct, poolFromLaunch, simulateBuy, simulateSell, PoolSnapshot } from './paperSimulator';
import { routePlay, describeRoute, RouteDecision, PLAYBOOK_DEFAULTS } from './playbookRouter';
import { tokenWatchlist } from './tokenWatchlist';
import { inspectMintSafety } from './honeypotDetector';
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

export interface InternalPosition extends Position {
  priceTicks?: PriceTick[];
  realizedPnlUsd: number;
  /** Curve/pool state captured at entry, so paper exits price against the same pool. */
  pool?: PoolSnapshot;
  /** Simulated costs paid so far (paper mode with honestPaper). */
  simulatedFeesSol?: number;
}

export class SniperEngine {
  private config: BotConfig = {
    isBotActive: false,
    tradingMode: 'paper',
    leniencyMode: 'strict',  // the only supported profile — see updateConfig
    activePlaybook: 'ALL',
    buyAmountSol: 0.05,      // strict default ~$10 @ $200/SOL
    takeProfitPct: 100,
    takeProfitRung2Pct: 400,
    stopLossPct: 35,
    useTrailingStop: true,
    trailingStopPct: 20,
    maxHoldSeconds: 1800,
    maxActivePositions: 99999, // Unlimited active positions
    priorityFeeSol: 0.001,
    maxPriorityFeeSol: 0.005,
    maxSlippagePct: 15,
    jitoTipSol: 0.001,   // NOT wired to anything — reserved for a future Jito bundle path
    solPriceUsd: 200,
    bankrollUsd: 100,
    maxHourlyLossUsd: 25,
    maxBreakevenPct: 15,
    privateKey: '',
    // Prefer the environment; the literal fallback keeps existing setups
    // working but this key is exposed in source history — ROTATE it and set
    // HELIUS_API_KEY instead.
    heliusApiKey: process.env.HELIUS_API_KEY || 'dfc72823-152b-468b-936e-57935ae27b08',
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

    const apiKey = this.config.heliusApiKey || 'dfc72823-152b-468b-936e-57935ae27b08';
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
    if (mode === 'strict')  return 0.05;  // ~$10 @ $200/SOL
    if (mode === 'normal')  return 0.075; // ~$15 @ $200/SOL
    return 0.1;                           // lenient ~$20 @ $200/SOL
  }

  public updateConfig(newConfig: Partial<BotConfig>): void {
    const wasActive = this.config.isBotActive;
    const prevMode = this.config.tradingMode;

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

    // STRICT is the only supported profile. Whatever a client sends, the
    // filter runs strict — a stale UI or an old saved payload cannot loosen it.
    if (this.config.leniencyMode !== 'strict') {
      if (newConfig.leniencyMode && newConfig.leniencyMode !== 'strict') {
        this.log('warn', `🎛️ Ignoring request for ${newConfig.leniencyMode.toUpperCase()} mode — this bot is locked to STRICT.`);
      }
      this.config.leniencyMode = 'strict';
    }
    this.riskFilter.setLeniencyMode('strict');

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

    // Drop logs older than 10s. Find the cutoff and splice once rather than
    // rebuilding the array — entries are already in timestamp order.
    if (this.logs.length > 0 && now - this.logs[0].timestamp > 10000) {
      let cut = 0;
      while (cut < this.logs.length && now - this.logs[cut].timestamp > 10000) cut++;
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

  private async executeRealMainnetTrade(action: 'buy' | 'sell', mint: string, solAmount: number, amountPct?: string): Promise<TradeResult | null> {
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
          amount: action === 'buy' ? solAmount : (amountPct || '100%'),
          slippage: this.config.maxSlippagePct,
          priorityFee: priorityFeeSol,
          // 'auto' routes bonding-curve and migrated (Raydium / pump-AMM) tokens
          // alike. Hardcoding 'pump' silently fails on anything post-migration.
          pool: 'auto'
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
        if (!confirmed) {
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
        void this.syncLiveWalletBalance();
        return { txid, fill };
      }
    } catch (err: any) {
      this.log('error', `❌ Mainnet ${action} failed for ${mint.slice(0, 6)}...: ${err.message}`);
    }
    return null;
  }

  private async confirmTransaction(txid: string, timeoutMs = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await this.solanaConnection.getSignatureStatus(txid);
        const value = status?.value;
        if (value) {
          if (value.err) return false;
          if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return true;
        }
      } catch {
        // RPC hiccup — keep polling until the deadline.
      }
      await new Promise(res => setTimeout(res, 1500));
    }
    return false;
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
        // reconnect does not silently blind the curve tracker.
        const watched = tokenWatchlist.all().map(t => t.mint);
        if (watched.length) {
          this.safeSendWs({ method: 'subscribeTokenTrade', keys: watched });
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
    if (featureFlags.get('timelineSlotSampling')) {
      void this.solanaConnection.getSlot('processed')
        .then(s => latencyTimeline.annotate(mint, { slotAtArrival: s }))
        .catch(() => {});
    }

    const launchData: Partial<PumpTokenLaunch> = {
      mint,
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
      bundledSupplyPct: useRealData ? 0 : 5,
      devHoldingsPct: useRealData ? 0 : 1,
      top10Pct: useRealData ? 0 : 12,
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
    const [report, dexData] = await Promise.all([
      this.rugCheckService.getReport(mint),
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
      if (report && !report.isInferred && meta && meta.holderSampleSize > 0) {
        if (typeof meta.top10Pct === 'number') launchData.top10Pct = meta.top10Pct;
        if (typeof meta.maxSingleHolderPct === 'number') {
          // No dedicated dev-holdings feed at this stage; the largest single
          // non-pool holder is the closest measured proxy and is strictly more
          // conservative than the hardcoded 1%.
          launchData.devHoldingsPct = Math.max(launchData.devHoldingsPct ?? 0, meta.maxSingleHolderPct);
        }
        if (typeof meta.insiderPct === 'number' && meta.insiderPct > 0) {
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
    const minLiquidityUsdOverride = onCurve
      ? MIN_CURVE_LIQUIDITY_SOL * this.config.solPriceUsd
      : undefined;

    const filterResult = this.riskFilter.evaluateToken(report, launchData, { minLiquidityUsdOverride });
    if (honeypotBlocked.length > 0) {
      filterResult.isSafe = false;
      filterResult.reasons = [...honeypotBlocked, ...(filterResult.reasons || [])];
    }

    // Gate V2 (real data only): entryGateV2 trades on it; shadowGateV2 runs it
    // silently next to the legacy gate and logs divergences — the required
    // evidence pass before anyone flips the real flag.
    const useV2 = featureFlags.get('entryGateV2');
    const runV2 = useV2 || featureFlags.get('shadowGateV2');
    const v2 = runV2 ? entryGateV2.evaluate(payload, report, isMigration) : null;

    const activeIsSafe = useV2 && v2 ? v2.isSafe : filterResult.isSafe;
    const activeReasons = useV2 && v2 ? v2.reasons : filterResult.reasons;
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
    await this.executeSell(pos, `SOLD ALL — structural stop: ${alert.detail}`);
    devSellMonitor.untrack(alert.mint);
  }

  /** Adds a fresh create to the curve watchlist and subscribes to its trades. */
  /**
   * Reacts to a bonding-curve account change: advances the watched token and
   * fires Play 2 when it enters the mid-curve window with real momentum. Also
   * drives the curve-drain structural stop for open positions.
   */
  private async handleCurveUpdate(u: CurveUpdate): Promise<void> {
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
    if (!stats || stats.progressVelocity5m < 2 || stats.buyPressurePct < 60) return;

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
    if (!tokenWatchlist.add(payload)) return;

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
    if (this.config.maxActivePositions < 99999 && this.activePositions.length >= this.config.maxActivePositions) {
      this.log('warn', `⚠️ Position limit reached (${this.activePositions.length}/${this.config.maxActivePositions}). Skipping buy for $${filterResult.tokenSymbol}.`);
      return;
    }

    if (this.activePositions.some(p => p.mint === filterResult.mint)) return;

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
        isBoosted: launchData.isBoosted,
        solPriceUsd: this.config.solPriceUsd,
      }, PLAYBOOK_DEFAULTS);

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

    let unitSizeSol = this.config.buyAmountSol * sizeMultiplier;

    if (this.config.tradingMode === 'real' && this.availableTradeSol > 0) {
      if (unitSizeSol > this.availableTradeSol) {
        unitSizeSol = this.availableTradeSol;
      }
      if (unitSizeSol < 0.005) {
        this.log('warn', `⚠️ Insufficient wallet balance (${this.liveWalletSolBalance} SOL available). Need at least 0.01 SOL to snipe.`);
        return;
      }
    }

    // Trade economics gate (flag enforceTradeEconomics): fixed costs — priority
    // fee x2, ATA rent, signatures — do not shrink with position size, so at
    // small size they dominate. 0.05 SOL needs +11.1% just to break even. A
    // strategy cannot out-trade its own cost stack; refuse rather than bleed.
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
      const result = await this.executeRealMainnetTrade('buy', filterResult.mint, solAmount);
      if (!result) {
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

    // Watch the creator from the moment we are exposed. Subscribing to this
    // token's trade stream is what makes the structural stop possible.
    if (featureFlags.get('devSellStop')) {
      const creator = (launchData?.creator as string) || undefined;
      devSellMonitor.track(filterResult.mint, creator);
      // Watch this position's curve so a sharp drain triggers the structural
      // stop. Identity-level dev-sell attribution needs the paid trade feed;
      // the drain itself is detectable for free.
      this.curveWatcher.start();
      this.curveWatcher.watch(filterResult.mint);
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
      } catch {
        // Never let one bad tick kill the monitor.
      } finally {
        this.monitorTickInFlight = false;
      }
    }, 2000);
  }

  private recordPartialSell(
    pos: InternalPosition,
    fractionSold: number,
    reason: string,
    actual?: { proceedsSol: number; tokensSold: number; txid: string }
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
    const record: TradeHistoryRecord = {
      id: `trade_${Date.now()}_${Math.floor(Math.random()*1000)}`,
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
      buyTxid: pos.buyTxid,
      sellTxid: actual?.txid,
      fillVerified: Boolean(actual && pos.fillVerified),
      entryTime: pos.entryTime,
      exitTime: Date.now(),
      holdTimeSeconds: Math.floor((Date.now() - pos.entryTime) / 1000),
      exitReason: `SOLD ${Math.round(fractionSold * 100)}% — ${partialPnlUsd >= 0 ? 'PROFIT' : 'LOSS'} ${partialPnlUsd >= 0 ? '+' : '-'}$${Math.abs(partialPnlUsd)}: ${reason}`,
      // With a real fill, all costs are already inside the balance deltas.
      feeDragUsd: actual ? 0 : 0.20,
    };

    this.pushTrade(record);

    // Adjust position remaining capital basis. With a fill, remove exactly the
    // tokens the chain says left the wallet.
    pos.tokensHeld = actual ? Math.max(0, tokensBefore - actual.tokensSold) : tokensBefore * (1 - fractionSold);
    pos.investedUsd = pos.investedUsd * (1 - fractionSold);
    pos.investedSol = pos.investedSol * (1 - fractionSold);
  }

  /**
   * Runs the on-chain leg of a partial sell.
   * Returns null when the sell did NOT happen (caller must not mutate state);
   * `{}` in paper mode; `{txid, actual?}` for a confirmed real sell.
   */
  private async sellPctReal(
    pos: InternalPosition,
    pct: number
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

    const result = await this.executeRealMainnetTrade('sell', pos.mint, 0, `${pct}%`);
    if (!result) return null;

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
    const limit = this.config.maxHourlyLossUsd ?? 25;
    if (limit <= 0) return;

    const hourPnl = realizedPnlInWindowUsd(this.tradeHistory, 60 * 60 * 1000);
    if (hourPnl <= -limit) {
      this.killSwitchTripped = true;
      this.log('error', `🛑 KILL SWITCH TRIPPED: ${hourPnl.toFixed(2)} USD realized in the last hour (limit -$${limit}). Bot paused; open positions retained.`);
      this.toggleBot(false);
    }
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
      if (!dexData.hasPair) {
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
      const currentPriceUsd = (featureFlags.get('playbookRouting') && dexData.hasPair && dexData.priceUsd > 0)
        ? dexData.priceUsd
        : currentMarketCap / 1000000000;
      pos.currentPriceUsd = currentPriceUsd;

      if (!pos.priceTicks) pos.priceTicks = [];
      pos.priceTicks.push({ timestamp: Date.now(), priceUsd: currentPriceUsd });
      if (pos.priceTicks.length > 60) pos.priceTicks.shift();

      if (currentPriceUsd > pos.highestPriceUsd) {
        pos.highestPriceUsd = currentPriceUsd;
      }

      const currentValuationUsd = pos.tokensHeld * currentPriceUsd;
      const unrealizedPnlUsd = currentValuationUsd - pos.investedUsd;
      pos.pnlUsd = Number((pos.realizedPnlUsd + unrealizedPnlUsd).toFixed(2));
      pos.pnlSol = Number((pos.pnlUsd / this.config.solPriceUsd).toFixed(4));
      pos.pnlPct = Number((((currentPriceUsd - pos.buyPriceUsd) / pos.buyPriceUsd) * 100).toFixed(1));

      if (this.config.useTrailingStop && pos.highestPriceUsd > pos.buyPriceUsd * 1.3) {
        pos.trailingStopTargetUsd = pos.highestPriceUsd * (1 - (this.config.trailingStopPct / 100));
      }

      const pullbackFromPeakPct = ((pos.highestPriceUsd - currentPriceUsd) / pos.highestPriceUsd) * 100;
      if (pos.pnlPct >= 60 && pullbackFromPeakPct >= 15 && !pos.principalRecovered) {
        // Sell first, book only what actually happened. Flags are set after a
        // confirmed sell so a failed exit is retried next tick instead of
        // silently recorded as banked profit.
        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;

        pos.principalRecovered = true;
        pos.status = 'PARTIAL_PROFIT';
        this.recordPartialSell(pos, 0.5, `price fell ${pullbackFromPeakPct.toFixed(0)}% from its peak while up ${pos.pnlPct}%`, sale.actual);
        this.log('sell', `📉 [SOLD 50%] $${pos.tokenSymbol} — was up +${pos.pnlPct}%, price dropped ${pullbackFromPeakPct.toFixed(0)}% from peak $${pos.highestPriceUsd.toFixed(6)}${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding 50%.`, pos.mint);
        return;
      }

      if (pos.pnlPct >= this.config.takeProfitPct && !pos.principalRecovered) {
        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;

        pos.principalRecovered = true;
        pos.status = 'PARTIAL_PROFIT';
        this.recordPartialSell(pos, 0.5, `hit take-profit target of +${this.config.takeProfitPct}%`, sale.actual);
        this.log('sell', `💰 [SOLD 50%] $${pos.tokenSymbol} — hit +${pos.pnlPct}% (target +${this.config.takeProfitPct}%)${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding 50%.`, pos.mint);
        return;
      }

      if (pos.pnlPct >= this.config.takeProfitRung2Pct && !pos.moonbagRiding) {
        const sale = await this.sellPctReal(pos, 50);
        if (sale === null) return;

        pos.moonbagRiding = true;
        this.recordPartialSell(pos, 0.5, `hit second take-profit target of +${this.config.takeProfitRung2Pct}%`, sale.actual);
        this.log('sell', `🔥 [SOLD 50%] $${pos.tokenSymbol} — hit +${pos.pnlPct}% (target +${this.config.takeProfitRung2Pct}%)${sale.actual ? ` — got ${sale.actual.proceedsSol.toFixed(4)} SOL` : ''}. Still holding the rest.`, pos.mint);
        return;
      }

      if (pos.trailingStopTargetUsd && currentPriceUsd <= pos.trailingStopTargetUsd) {
        await this.executeSell(pos, `SOLD ALL — trailing stop: price fell ${this.config.trailingStopPct}% from its peak of $${pos.highestPriceUsd.toFixed(6)}`);
        return;
      }

      if (pos.pnlPct <= -this.config.stopLossPct) {
        await this.executeSell(pos, `SOLD ALL — stop loss: down ${this.config.stopLossPct}% from entry`);
        return;
      }

      if (timeElapsedSec >= this.config.maxHoldSeconds) {
        await this.executeSell(pos, `SOLD ALL — max hold time reached (${Math.floor(this.config.maxHoldSeconds / 60)} min)`);
        return;
      }

    } catch (err: any) {
      // ignore
    }
  }

  public async executeSell(pos: InternalPosition, reason: string): Promise<void> {
    // Sell FIRST. Position state is only touched once we know what happened —
    // a failed real exit keeps the position tracked and retried, never dropped.
    const sale = await this.sellPctReal(pos, 100);
    if (sale === null) {
      this.log('warn', `⚠️ SELL FAILED for $${pos.tokenSymbol} (${reason}) — still holding, will retry next tick.`, pos.mint);
      return;
    }

    const exitTime = Date.now();
    const holdTimeSeconds = Math.floor((exitTime - pos.entryTime) / 1000);
    const tokensSold = sale.actual ? sale.actual.tokensSold : pos.tokensHeld;

    // Proceeds: on-chain SOL received when we have the fill, quote estimate otherwise.
    const proceedsUsd = sale.actual
      ? sale.actual.proceedsSol * this.config.solPriceUsd
      : pos.tokensHeld * pos.currentPriceUsd;
    const feeDragUsd = sale.actual ? 0 : 0.40;
    const finalPnlUsd = Number((proceedsUsd - pos.investedUsd - feeDragUsd).toFixed(2));
    const totalPositionPnlUsd = Number((pos.realizedPnlUsd + finalPnlUsd).toFixed(2));

    this.activePositions = this.activePositions.filter(p => p.id !== pos.id);
    devSellMonitor.untrack(pos.mint);

    const sellPriceUsd = tokensSold > 0 ? proceedsUsd / tokensSold : pos.currentPriceUsd;
    const finalPnlPct = pos.investedUsd > 0
      ? Number((((proceedsUsd - feeDragUsd - pos.investedUsd) / pos.investedUsd) * 100).toFixed(1))
      : 0;

    // Record only THIS leg's P&L. Any partial sells already wrote their own
    // records, so carrying the cumulative figure here would double-count every
    // partial when the history is summed for stats and the run report.
    const record: TradeHistoryRecord = {
      id: pos.id,
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

    await this.executeSell(pos, 'Manual User Force Sell Override');
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
  }
}

export const sniperEngine = new SniperEngine();
