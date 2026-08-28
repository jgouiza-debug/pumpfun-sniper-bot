import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { Connection, LAMPORTS_PER_SOL, PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from '@solana/web3.js';
import {
  CopyFeedEvent,
  CopyPosition,
  CopyStatusResponse,
  CopyTradeRecord,
  CopyTraderConfig,
  TrackedWalletPublic,
} from '../types';
import { sniperEngine, type TradeResult } from './sniperEngine';
import { rpcEndpoint, rpcWsEndpoint, connectionConfig, isRateLimitError } from './rpcHealth';
import { affordableStakeSol, sellAmountParam } from './pipelineUtils';
import { installPath } from './installPaths';
import { appendBotLog } from './fileLogger';
import { DexScreenerService } from './dexscreenerService';
import { attachKeepalive, reconnectDelayMs, KeepaliveHandle } from './wsKeepalive';
import { WalletLogWatcher, type WalletLogEvent } from './walletLogWatcher';
import { tradeEventsFromLogs, tradeEventPriceSol, PUMP_TOKEN_DECIMALS } from './pumpEventDecoder';
import { bondingCurvePda } from './curveWatcher';
import {
  detectVenue, classifyFlow, netSolFlowSol, paperExitPrice, isCopyableMint, resolveBuyPool,
} from './leaderTxClassifier';
import {
  ExitQueue, leaderSellFraction, sellVenueCandidates, sellRetryDelayMs, copySellSlippagePct,
  COPY_SELL_MAX_ATTEMPTS,
} from './copyExitPolicy';

/**
 * Mirrors EVERY buy of chosen leader wallets — and, with `copySells` on,
 * their sells too. Auto-sells were removed 2026-08-12 and restored as a
 * toggle on 2026-08-13 (see onLeaderSell); with the toggle off, leader sells
 * surface in the feed as signals and the only sell path is the manual button.
 *
 * Two signal feeds, deduplicated by transaction signature:
 *
 *  1. HELIUS ON-CHAIN WATCHER (the complete feed). Each tracked wallet gets a
 *     `logsSubscribe` on our own Helius websocket (WalletLogWatcher: keepalive
 *     watchdog, 'processed' commitment, so the signal arrives before the
 *     cluster has even confirmed the leader's tx); the transaction is then
 *     fetched and its SOL + token balance deltas read. A swap is a swap
 *     regardless of venue — pump.fun, Raydium, Jupiter, anything — because
 *     the wallet's balances move the same way. This is what makes "copy ALL
 *     of their trades" literal.
 *
 *  2. PUMPPORTAL FAST LANE. subscribeAccountTrade delivers pump.fun trades
 *     with less latency and richer metadata (symbol, venue, post-trade
 *     balance). When both feeds see the same trade, whichever arrives first
 *     wins and the other is dropped by the signature dedup.
 *
 * Execution in real mode goes through SniperEngine.executeExternalTrade() —
 * the sniper's own trade-local → sign → confirm → fill-inspection path, with
 * pool 'auto' when the venue is unknown (PumpPortal routes pump, pump-amm and
 * Raydium pools). Paper mode fills at the LEADER'S realized price with a
 * slippage haircut, falling back to a DexScreener quote when the trade
 * carried no usable price.
 *
 * This service deliberately owns its own sockets instead of piggybacking on
 * the engine's: the engine drops every message while the sniper is switched
 * off, and copy trading must keep working when the sniper is idle.
 */

// Install-relative when packaged (installPaths), cwd otherwise — a foreign cwd
// must not split this state file away from the rest of the per-install files.
const STATE_FILE = installPath('.copy-trader.json');

/**
 * Schema version of `.copy-trader.json`.
 *
 * 1 (implicit, no field) — written any time before 2026-08-13. `copySells`
 *   may say true, but auto-sells did not exist, so the value reflects a
 *   default nobody acted on rather than a decision.
 * 2 — auto-sells are live and `copySells` means what it says.
 */
const COPY_CONFIG_VERSION = 2;

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Paper fills assume this much slippage vs. the leader's realized price. */
const PAPER_SLIPPAGE_PCT = 1.5;

/** Token-balance noise floor — below this a delta is rounding, not a trade. */
const TOKEN_DELTA_EPSILON = 1e-9;

/** Reprice a held position from DexScreener when its last tick is older than this. */
const PRICE_STALE_MS = 1500;

const FEED_LIMIT = 120;
const HISTORY_LIMIT = 200;
const MONITOR_INTERVAL_MS = 250;
const PROCESSED_SIG_LIMIT = 3000;

/**
 * Polling budget for reading a leader transaction after its 'processed' log.
 * `getTransaction` only answers at 'confirmed', which typically lands 0.4–1s
 * behind 'processed'.
 */
const TX_FETCH_DEADLINE_MS = 8000;
const TX_FETCH_INTERVAL_MS = 250;
/** One paced re-read of a leader tx that outlived the polling budget — long enough for an RPC 429 storm to pass. */
const TX_REFETCH_DELAY_MS = 20_000;
/** How long a signature-less PumpPortal copy blocks the delayed Helius re-read of the same mint+side. */
const UNSIGNED_COPY_DEDUP_MS = 90_000;

/**
 * A token MOVE below this fraction of the leader's bag is a shuffle, not an
 * exit — mirroring it would burn a whole sell's fees on dust (measured
 * 2026-08-23: a 0.4% move at 21:39:50 eleven minutes before the real full
 * exit). A full exit (remaining 0) always mirrors regardless.
 */
const TOKEN_MOVE_MIN_FRACTION = 0.02;

/**
 * SOL held back per open copy position so its eventual sell can pay its
 * priority fee and base fees and still leave the fee payer rent-exempt. The
 * engine's 0.005 gas float is one buffer for the whole wallet; every
 * position needs its own exit funded on top. Measured 2026-08-23: two copy
 * buys left 0.00162 SOL in the wallet and the exit could not land at the
 * configured fee — the position was stuck until a top-up.
 */
const COPY_EXIT_GAS_RESERVE_SOL = 0.002;

/** A leader trade normalized from either feed into one shape. */
interface LeaderSignal {
  signature?: string;
  mint: string;
  side: 'buy' | 'sell';
  /** SOL the leader spent (buy) or received (sell). 0 for token→token legs. */
  solAmount: number;
  /** Tokens the leader gained (buy) or disposed of (sell). */
  tokenAmount: number;
  /** Leader's post-trade balance of the mint, when known — exact sell fraction. */
  remainingTokens?: number;
  /** Venue hint for execution routing; undefined → 'auto'. */
  pool?: string;
  symbol?: string;
  via: 'pumpportal' | 'helius' | 'manual';
  /** True when this leg is half of a token→token swap (no SOL amount to scale from). */
  isTokenSwap?: boolean;
  /** Leader's realized price in SOL per token for this leg, when the trade carried one. */
  priceSol?: number;
  /**
   * 'transfer' = tokens moved with no SOL against them (airdrop, dust, a bag
   * moved between the leader's own wallets). Surfaced in the feed, never
   * copied — treating these as trades bought airdrops and sold positions the
   * leader had only moved.
   */
  kind?: 'trade' | 'transfer';
  /** Decoded from the log lines at 'processed' — no transaction fetch stood between the leader and our order. */
  fast?: boolean;
}

interface TrackedWalletInternal extends TrackedWalletPublic {
  /** Epoch ms of the last COPIED buy — drives the per-wallet cooldown. */
  lastCopiedBuyAt: number | null;
}

interface CopyPositionInternal extends CopyPosition {
  realizedPnlUsd: number;
  realizedPnlSol: number;
  lastPriceAt: number | null;
}

const DEFAULT_CONFIG: CopyTraderConfig = {
  enabled: false,
  tradingMode: 'paper',
  buySizeMode: 'fixed',
  fixedBuySol: 0.05,
  proportionalPct: 10,
  maxBuySol: 0.5,
  // 0 = copy EVERY buy, which is the whole point of a wallet copier. Raise it
  // only to deliberately ignore the leader's dust.
  minLeaderBuySol: 0,
  // Live again since 2026-08-13 (see onLeaderSell). ON by default because a
  // copy position whose leader has left is a position with no thesis behind
  // it — the whole reason it was opened was that the leader was in it.
  // 'mirror' sells the same fraction they did; 'full' exits completely on any
  // leader sell. Set copySells false to hold through their exit instead.
  copySells: true,
  sellMode: 'mirror',
  // ON: some leaders' exit infra (measured 2026-08-23 on the tracked wallet)
  // never sells from the tracked wallet at all — the bag MOVES out as a plain
  // token transfer, no SOL back, and is disposed of elsewhere. For a mint we
  // hold, that outflow is the exit. Only fires with an open copy position and
  // copySells on; buys arriving as transfers (airdrops) are still ignored.
  mirrorLeaderTokenMoves: true,
  // OFF: a leader adding to a bag adds to ours (DCA mirror) instead of being
  // skipped. Turn on to copy only the first entry per mint.
  blockRepeatBuys: false,
  maxOpenPositions: 10,
  maxSlippagePct: 25,
  perWalletCooldownSec: 0,
  // INERT since 2026-08-12 — no time- or price-based exits. Leader sells
  // (copySells) and the manual button are the only ways out.
  maxHoldSeconds: 0,
  takeProfitPct: 0,
  // Feed lines older than this fall off on their own; 0 keeps them until the
  // CLEAR button. Two minutes, per the owner (2026-08-23): at leader-bot
  // signal rates a longer feed is noise. Receipts (history) are never
  // auto-cleared — they are the audit trail of real money.
  feedAutoClearMinutes: 2,
};

export class CopyTraderService {
  private config: CopyTraderConfig = { ...DEFAULT_CONFIG };
  private wallets = new Map<string, TrackedWalletInternal>();
  private positions: CopyPositionInternal[] = [];
  private history: CopyTradeRecord[] = [];
  private feed: CopyFeedEvent[] = [];

  // PumpPortal fast lane
  private ws: WebSocket | null = null;
  private streamConnected = false;
  private wsKeepalive: KeepaliveHandle | null = null;
  private wsReconnectAttempt = 0;
  /** Mints currently subscribed for price ticks (open positions). */
  private subscribedMints = new Set<string>();

  // Helius on-chain watcher
  private heliusConn: Connection | null = null;
  private heliusKeyInUse: string | null = null;
  /** Latches the no-key warning so it is stated once per start, not per poll. */
  private warnedNoHeliusKey = false;
  /** Our own logsSubscribe socket — see WalletLogWatcher for why not Connection.onLogs. */
  private logWatcher: WalletLogWatcher | null = null;
  /** Signatures whose transaction is being fetched right now ('processed' logs can repeat). */
  private analyzingSigs = new Set<string>();
  /**
   * Running tally of each leader's token balance per mint (`address:mint`),
   * so a pump.fun SELL decoded from the log lines can be sized as a fraction
   * of their bag without waiting for the transaction. Reconciled against the
   * chain's own balances as soon as each transaction is readable.
   */
  private leaderBalances = new Map<string, number>();

  /** Signatures already handled — the cross-feed dedup. FIFO-pruned. */
  private processedSigs = new Set<string>();
  private processedSigOrder: string[] = [];

  /**
   * One trade at a time per MINT — buys and exits alike — in arrival order,
   * never dropped. A sell waits for the buy it belongs to. See
   * copyExitPolicy.ExitQueue for the bug this replaces.
   */
  private tradeQueue = new ExitQueue();
  /** Position ids whose operator pressed SELL while an automatic retry was backing off. */
  private manualExitRequested = new Set<string>();

  /**
   * SOL claimed by real copy buys currently in flight, by mint. The queue only
   * serializes per MINT — buys of two different mints size concurrently, and
   * without this ledger both would size against the same balance snapshot and
   * jointly overdraft the wallet (the cross-mint variant of the 2026-08-23
   * drain). Same-mint repeats are already serialized by the queue itself.
   */
  private inFlightBuySol = new Map<string, number>();

  /** Limit concurrent getParsedTransaction RPC calls so bursts of logs do not trigger 429 storms. */
  private txFetchInFlight = 0;
  private static readonly MAX_CONCURRENT_TX_FETCH = 2;
  private txFetchQueue: Array<() => void> = [];
  /** Throttle feed congestion warnings per leader wallet to avoid spamming the UI feed. */
  private lastFeedWarnAt = new Map<string, number>();

  private async acquireTxFetchSlot(): Promise<() => void> {
    while (this.txFetchInFlight >= CopyTraderService.MAX_CONCURRENT_TX_FETCH) {
      await new Promise<void>((resolve) => this.txFetchQueue.push(resolve));
    }
    this.txFetchInFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.txFetchInFlight--;
      const next = this.txFetchQueue.shift();
      if (next) next();
    };
  }

  /** Signatures with a scheduled 20s re-read — a redelivered 'processed' log must not start a second fetch loop. */
  private pendingRetrySigs = new Set<string>();

  /** Last observed watcher connectivity, to detect reconnects (which invalidate the fast-lane tallies). */
  private watcherWasConnected = false;

  /**
   * `mint:side` → time of a copy executed from a SIGNATURE-LESS PumpPortal
   * payload. Cross-lane dedup is by signature; when PumpPortal omits it, this
   * is the fallback that stops the delayed Helius re-read of the same trade
   * from copying it twice.
   */
  private unsignedCopies = new Map<string, number>();

  private monitorInterval: NodeJS.Timeout | null = null;
  private dexPollInFlight = false;
  private changeListeners = new Set<() => void>();
  private persistTimer: NodeJS.Timeout | null = null;
  private idCounter = 0;

  constructor() {
    this.loadState();
    this.startMonitor();
    if (this.config.enabled && this.enabledWalletAddresses().length) {
      this.startSignalFeeds();
    }
  }

  // ---------------- PUBLIC API ----------------

  public getStatus(): CopyStatusResponse {
    const solPriceUsd = sniperEngine.getSolPriceUsd();
    const open = this.positions.filter(p => p.status !== 'CLOSED');
    const unrealizedPnlUsd = open.reduce((sum, p) => sum + p.pnlUsd, 0);
    const sells = this.history.filter(h => h.side === 'sell');
    const winCount = sells.filter(h => h.pnlUsd > 0).length;
    const lossCount = sells.filter(h => h.pnlUsd <= 0).length;
    const walletList = [...this.wallets.values()].sort((a, b) => b.addedAt - a.addedAt);

    return {
      enabled: this.config.enabled,
      streamConnected: this.streamConnected,
      heliusConnected: this.logWatcher?.isHealthy() ?? false,
      tradingMode: this.config.tradingMode,
      config: { ...this.config },
      wallets: walletList.map(w => this.publicWallet(w)),
      positions: open.map(p => this.publicPosition(p)),
      history: this.history.slice(0, 60),
      feed: this.feed.slice(0, 80),
      solPriceUsd,
      wallet: sniperEngine.getWalletStatus(),
      stats: {
        signalsSeen: walletList.reduce((s, w) => s + w.buysSeen + w.sellsSeen, 0),
        copiedBuys: walletList.reduce((s, w) => s + w.copiedBuys, 0),
        copiedSells: walletList.reduce((s, w) => s + w.copiedSells, 0),
        skippedSignals: walletList.reduce((s, w) => s + w.skippedSignals, 0),
        openPositions: open.length,
        realizedPnlUsd: round2(this.positions.reduce((s, p) => s + p.realizedPnlUsd, 0)),
        realizedPnlSol: round4(this.positions.reduce((s, p) => s + p.realizedPnlSol, 0)),
        unrealizedPnlUsd: round2(unrealizedPnlUsd),
        winCount,
        lossCount,
        winRatePct: winCount + lossCount > 0 ? Math.round((winCount / (winCount + lossCount)) * 100) : 0,
      },
    };
  }

  public setEnabled(enabled: boolean): { ok: boolean; error?: string } {
    if (enabled && this.config.tradingMode === 'real') {
      const blockers = sniperEngine.getWalletStatus().blockers;
      if (blockers.length) {
        return { ok: false, error: `Cannot arm REAL copy trading: ${blockers.join(' ')}` };
      }
    }
    this.config.enabled = enabled;
    if (enabled) {
      this.startSignalFeeds();
    } else {
      this.stopSignalFeeds();
    }
    this.persist();
    this.emitChange();
    return { ok: true };
  }

  public updateConfig(partial: Partial<CopyTraderConfig>): { ok: boolean; error?: string } {
    const next = { ...this.config, ...sanitizeConfig(partial) };

    // Arming real mode requires a usable signer NOW, not at the first signal —
    // same principle as the sniper's preflight.
    if (next.tradingMode === 'real' && this.config.tradingMode !== 'real' && next.enabled) {
      const blockers = sniperEngine.getWalletStatus().blockers;
      if (blockers.length) {
        return { ok: false, error: `Cannot switch to REAL mode: ${blockers.join(' ')}` };
      }
    }

    const enabledChanged = next.enabled !== this.config.enabled;
    this.config = next;
    if (enabledChanged) {
      if (next.enabled) this.startSignalFeeds();
      else this.stopSignalFeeds();
    }
    this.persist();
    this.emitChange();
    return { ok: true };
  }

  public addWallet(address: string, nickname?: string): { ok: boolean; error?: string } {
    const trimmed = (address || '').trim();
    try {
      // Validates base58 + length; throws on garbage.
      new PublicKey(trimmed);
    } catch {
      return { ok: false, error: 'Not a valid Solana wallet address.' };
    }
    if (this.wallets.has(trimmed)) {
      return { ok: false, error: 'That wallet is already being tracked.' };
    }

    this.wallets.set(trimmed, {
      address: trimmed,
      shortAddress: shortAddr(trimmed),
      nickname: (nickname || '').trim() || shortAddr(trimmed),
      enabled: true,
      addedAt: Date.now(),
      lastSeenAt: null,
      buysSeen: 0,
      sellsSeen: 0,
      copiedBuys: 0,
      copiedSells: 0,
      skippedSignals: 0,
      realizedPnlUsd: 0,
      lastCopiedBuyAt: null,
    });

    this.restartSignalFeeds();
    this.persist();
    this.emitChange();
    return { ok: true };
  }

  public removeWallet(address: string): boolean {
    const removed = this.wallets.delete(address);
    if (removed) {
      this.restartSignalFeeds();
      this.persist();
      this.emitChange();
    }
    return removed;
  }

  public updateWallet(address: string, patch: { enabled?: boolean; nickname?: string }): boolean {
    const w = this.wallets.get(address);
    if (!w) return false;
    if (typeof patch.enabled === 'boolean') w.enabled = patch.enabled;
    if (typeof patch.nickname === 'string' && patch.nickname.trim()) w.nickname = patch.nickname.trim();
    this.restartSignalFeeds();
    this.persist();
    this.emitChange();
    return true;
  }

  public async manualSellPosition(positionId: string): Promise<boolean> {
    const pos = this.positions.find(p => p.id === positionId && p.status !== 'CLOSED');
    if (!pos) return false;
    // A leader-triggered sell that is mid-backoff yields to the button: the
    // operator pressing SELL means "now", not "after five more retries".
    this.manualExitRequested.add(pos.id);
    const owner = this.wallets.get(pos.leaderWallet) ?? this.standInWallet(pos);
    const manualSig: LeaderSignal = {
      mint: pos.mint, side: 'sell', solAmount: 0, tokenAmount: 0, symbol: pos.tokenSymbol, via: 'manual',
    };
    await this.closePosition(pos, 1, 'Manual force sell from copy page', manualSig, owner);
    return true;
  }

  public forceClosePosition(positionId: string, reason = 'Liquidated / dismissed by operator'): boolean {
    const pos = this.positions.find(p => p.id === positionId && p.status !== 'CLOSED');
    if (!pos) return false;
    pos.status = 'CLOSED';
    pos.tokensHeld = 0;
    this.unsubscribeMintIfIdle(pos.mint);
    this.pushHistory({
      id: `ct_${Date.now()}_${++this.idCounter}`,
      positionId: pos.id,
      mint: pos.mint,
      tokenSymbol: pos.tokenSymbol,
      leaderWallet: pos.leaderWallet,
      leaderNickname: pos.leaderNickname,
      side: 'sell',
      solAmount: 0,
      tokensMoved: 0,
      priceSol: pos.currentPriceSol || pos.entryPriceSol,
      pnlUsd: round2(pos.pnlUsd),
      pnlSol: round4(pos.pnlSol),
      pnlPct: Math.round(pos.pnlPct * 10) / 10,
      timestamp: Date.now(),
      txid: pos.buyTxid,
      fillVerified: false,
      exitReason: reason,
    });
    this.persist();
    this.emitChange();
    return true;
  }

  public clearHistory(): void {
    this.history = [];
    this.feed = [];
    this.positions = this.positions.filter(p => p.status !== 'CLOSED');
    for (const w of this.wallets.values()) w.realizedPnlUsd = 0;
    this.persist();
    this.emitChange();
  }

  public onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  // ---------------- SIGNAL FEED LIFECYCLE ----------------

  private enabledWalletAddresses(): string[] {
    return [...this.wallets.values()].filter(w => w.enabled).map(w => w.address);
  }

  private startSignalFeeds(): void {
    this.connectPumpPortal();
    this.startHeliusWatcher();
  }

  private stopSignalFeeds(): void {
    this.disconnectPumpPortal();
    this.stopHeliusWatcher();
  }

  /**
   * Wallet set changed. PumpPortal takes its key list in the subscribe
   * message, so that socket is rebuilt; the on-chain watcher diffs its
   * subscriptions in place and keeps its socket. User-action rate.
   */
  private restartSignalFeeds(): void {
    if (!this.config.enabled) return;
    this.disconnectPumpPortal();
    this.connectPumpPortal();
    this.startHeliusWatcher();
  }

  // ---------------- HELIUS ON-CHAIN WATCHER ----------------

  /**
   * One `logsSubscribe` per tracked wallet on our own Helius websocket. Every
   * transaction touching the wallet is pulled and read as balance deltas —
   * venue-agnostic by construction.
   *
   * This used to be `Connection.onLogs` at 'confirmed'. Two problems, both
   * behind "the copy sell is late or never happens": web3.js reconnects only
   * from `close`, so a half-open socket kept ON-CHAIN reading OK while
   * delivering nothing; and 'confirmed' is the slowest moment to learn about
   * a trade. WalletLogWatcher owns the socket, pings it, and subscribes at
   * 'processed'.
   */
  private startHeliusWatcher(): void {
    const addresses = this.enabledWalletAddresses();
    if (!addresses.length) {
      // Every wallet disabled or removed: drop the subscriptions, keep the socket.
      this.logWatcher?.setAddresses([]);
      this.emitChange();
      return;
    }

    const key = sniperEngine.getConfig().heliusApiKey || process.env.HELIUS_API_KEY || '';
    if (!key) {
      // Silent `return` here was half of "the copy trader never sells". With no
      // Helius key this lane simply did not start, and the other lane
      // (subscribeAccountTrade) delivers nothing on the free PumpPortal tier —
      // so BOTH sources of a leader-sell signal were dead and the feed showed
      // no error at all. Say it once, loudly, per start.
      if (!this.warnedNoHeliusKey) {
        this.warnedNoHeliusKey = true;
        console.warn('[CopyTrader] ⚠️ No Helius key — the on-chain wallet watcher cannot start. Combined with the free PumpPortal tier this means NO leader buy or sell will ever be seen. Add a Helius key in Settings.');
      }
      return;
    }
    this.warnedNoHeliusKey = false;

    // Rebuild both the HTTP connection and the socket when the operator
    // changed the key in settings.
    if (!this.heliusConn || this.heliusKeyInUse !== key) {
      this.stopHeliusWatcher();
      this.heliusConn = new Connection(rpcEndpoint(key), connectionConfig());
      this.heliusKeyInUse = key;
    }

    if (!this.logWatcher) {
      this.logWatcher = new WalletLogWatcher({
        getWsUrl: () => rpcWsEndpoint(this.heliusKeyInUse),
        commitment: 'processed',
        onLog: (ev) => {
          if (ev.err) return; // failed tx — nothing moved
          // Real-time curve price extraction for any held position straight from log lines
          const allEvents = tradeEventsFromLogs(ev.logs);
          let repriced = false;
          for (const te of allEvents) {
            const held = this.positions.find(p => p.mint === te.mint && p.status !== 'CLOSED');
            if (held) {
              let pSol = 0;
              if (te.virtualSolReserves > 0n && te.virtualTokenReserves > 0n) {
                pSol = Number(te.virtualSolReserves) / Number(te.virtualTokenReserves);
              } else {
                pSol = tradeEventPriceSol(te);
              }
              if (pSol > 0) {
                held.lastPriceAt = Date.now();
                this.repricePosition(held, pSol);
                repriced = true;
              }
            }
          }
          // One push per notification, not one per decoded event — each emit
          // serializes the whole status for every SSE client.
          if (repriced) this.emitChange();
          // Failed on-chain transactions never change token balances or make trades
          if (ev.err) return;
          if (this.processedSigs.has(ev.signature) || this.analyzingSigs.has(ev.signature)) return;
          // Fast lane: a pump.fun trade is fully described by the event in
          // the log lines already in hand — no RPC, no wait for confirmation.
          // Everything else takes the on-chain analysis path.
          if (this.handleFastLog(ev)) return;
          void this.handleWalletLog(ev.address, ev.signature);
        },
        log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[CopyTrader] ${msg}`),
        onStatusChange: () => {
          // A reconnect means a gap: leader buys during the outage were never
          // seen (logsSubscribe has no backfill), so every fast-lane tally
          // may be stale-LOW and a partial sell sized from one would
          // oversell. Clear them; the analysis path re-sizes from the
          // chain's real balances until reconciliation repopulates.
          const connected = this.logWatcher?.isConnected() ?? false;
          if (connected && !this.watcherWasConnected) this.leaderBalances.clear();
          this.watcherWasConnected = connected;
          this.emitChange();
        },
      });
    }
    this.logWatcher.setAddresses(addresses);
    this.logWatcher.start();
    this.emitChange();
  }

  private stopHeliusWatcher(): void {
    this.logWatcher?.stop();
    this.logWatcher = null;
    this.emitChange();
  }

  private async handleWalletLog(leaderAddress: string, signature: string, isRetry = false): Promise<void> {
    const wallet = this.wallets.get(leaderAddress);
    if (!wallet || !wallet.enabled || !this.config.enabled || !this.heliusConn) return;
    // The retry path re-enters here after a delay — the other lane may have
    // claimed the signature in the meantime. And while a retry is pending,
    // a redelivered copy of the same 'processed' log (fork, reconnect replay)
    // must not burn a second 8s fetch loop against an already-limited RPC.
    if (this.processedSigs.has(signature) || (isRetry && this.analyzingSigs.has(signature))) return;
    if (!isRetry && this.pendingRetrySigs.has(signature)) return;

    // A 'processed' log can be delivered more than once (two forks, or a
    // reconnect replaying the slot); one fetch per signature at a time.
    this.analyzingSigs.add(signature);
    let signals: LeaderSignal[] | 'fetch_failed';
    try {
      signals = await this.analyzeLeaderTx(leaderAddress, signature);
    } finally {
      this.analyzingSigs.delete(signature);
    }
    if (signals === 'fetch_failed') {
      const hasOpenPos = this.positions.some(p => p.leaderWallet === leaderAddress && p.status !== 'CLOSED');
      const sigNote: LeaderSignal = {
        mint: '',
        symbol: `tx ${signature.slice(0, 8)}…`,
        side: hasOpenPos ? 'sell' : 'buy',
        solAmount: 0,
        tokenAmount: 0,
        via: 'helius',
      };
      const now = Date.now();
      const lastWarn = this.lastFeedWarnAt.get(leaderAddress) ?? 0;
      const shouldPushFeed = (now - lastWarn > 6000) || hasOpenPos;

      if (!isRetry) {
        if (shouldPushFeed) {
          this.lastFeedWarnAt.set(leaderAddress, now);
          this.pushFeed(wallet, sigNote, 'pending',
            hasOpenPos
              ? `Could not read leader tx ${signature.slice(0, 8)}… within ${TX_FETCH_DEADLINE_MS / 1000}s (RPC congested) — retrying once in ${TX_REFETCH_DELAY_MS / 1000}s.`
              : `Leader tx ${signature.slice(0, 8)}… unreadable within ${TX_FETCH_DEADLINE_MS / 1000}s (RPC congested) — retrying once in ${TX_REFETCH_DELAY_MS / 1000}s.`);
        }
        this.pendingRetrySigs.add(signature);
        setTimeout(() => {
          this.pendingRetrySigs.delete(signature);
          void this.handleWalletLog(leaderAddress, signature, true);
        }, TX_REFETCH_DELAY_MS);
      } else {
        if (shouldPushFeed) {
          this.lastFeedWarnAt.set(leaderAddress, now);
          this.pushFeed(wallet, sigNote, 'failed',
            hasOpenPos
              ? `Could not read leader tx ${signature.slice(0, 8)}… after a retry — SIGNAL DROPPED. If the leader sold, mirror it manually with the SELL button.`
              : `Leader tx ${signature.slice(0, 8)}… unreadable after retry — signal dropped.`);
        }
        // The dropped tx may have been a BUY: the fast-lane tally for this
        // leader is now stale-LOW, and a partial sell sized from it would
        // OVERSELL (50 of a stale 100 reads as 50%, not the true 5%). Drop
        // the tally so sells route through the analysis path's real balances
        // until reconciliation repopulates it.
        for (const key of [...this.leaderBalances.keys()]) {
          if (key.startsWith(`${leaderAddress}:`)) this.leaderBalances.delete(key);
        }
      }
      return;
    }
    if (!signals.length) return;

    // Claim the signature only once we know it was a trade, so the PumpPortal
    // lane is not blocked by unrelated transfers sharing the dedup set.
    if (this.processedSigs.has(signature)) return;
    this.markSigProcessed(signature);

    for (const sig of signals) {
      // A Helius delivery — fast lane, this analysis path, or the 20s re-read —
      // may match a trade already copied from a PumpPortal payload that carried
      // no signature, the one case signature dedup cannot see. Mirroring it
      // twice sells (or buys) twice. This must run on EVERY Helius path, not
      // only the retry branch it used to live in.
      if (this.alreadyCopiedUnsigned(sig.mint, sig.side)) {
        this.pushFeed(wallet, sig, 'skipped',
          'Leader tx matches a trade already copied from the PumpPortal lane — not copied twice.');
        continue;
      }
      await this.handleLeaderSignal(wallet, sig);
    }
  }

  /**
   * True when this mint+side was already copied from a signature-less PumpPortal
   * payload within the dedup window — and consumes the marker so exactly one
   * Helius delivery is dropped, letting the leader's genuine NEXT trade in the
   * same mint through. See handlePumpPortalMessage for why the marker exists.
   */
  private alreadyCopiedUnsigned(mint: string, side: 'buy' | 'sell'): boolean {
    const key = `${mint}:${side}`;
    const at = this.unsignedCopies.get(key);
    if (at !== undefined && Date.now() - at < UNSIGNED_COPY_DEDUP_MS) {
      this.unsignedCopies.delete(key);
      return true;
    }
    return false;
  }

  /**
   * FAST LANE for pump.fun trades. The TradeEvent in the notification's own
   * log lines carries mint, side, SOL, tokens and trader, so the copy order
   * leaves at 'processed' — typically 0.5–1.2s before the leader's
   * transaction is even readable at 'confirmed', which is what the analysis
   * path has to wait for. Returns false when the notification is not a
   * pump.fun trade by this wallet (other venue, transfer), or when a SELL
   * cannot be sized exactly without the transaction; those take the
   * analysis path unchanged.
   */
  private handleFastLog(ev: WalletLogEvent): boolean {
    const wallet = this.wallets.get(ev.address);
    if (!wallet || !wallet.enabled || !this.config.enabled) return false;

    const events = tradeEventsFromLogs(ev.logs).filter(e => e.user === ev.address);
    if (!events.length) return false;

    const signals: LeaderSignal[] = [];
    const tallyUpdates: Array<[string, number]> = [];
    for (const e of events) {
      const tokens = Number(e.tokenRaw) / 10 ** PUMP_TOKEN_DECIMALS;
      const sol = Number(e.solLamports) / LAMPORTS_PER_SOL;
      const key = `${ev.address}:${e.mint}`;
      const tracked = this.leaderBalances.get(key);
      let remainingTokens: number | undefined;
      if (e.isBuy) {
        tallyUpdates.push([key, (tracked ?? 0) + tokens]);
      } else {
        // The mirror needs the leader's post-trade balance, which the event
        // does not carry. Our running tally is exact once a transaction has
        // been reconciled against the chain; until then — the first sell of a
        // bag we never saw them buy, or one larger than we tracked — the
        // analysis path sizes it from the real balances.
        if (tracked === undefined || tracked + 1e-6 < tokens) return false;
        remainingTokens = Math.max(0, tracked - tokens);
        tallyUpdates.push([key, remainingTokens]);
      }
      signals.push({
        signature: ev.signature,
        mint: e.mint,
        side: e.isBuy ? 'buy' : 'sell',
        solAmount: round4(sol),
        tokenAmount: tokens,
        remainingTokens,
        priceSol: tradeEventPriceSol(e) || undefined,
        pool: 'pump',
        via: 'helius',
        kind: 'trade',
        fast: true,
      });
    }
    for (const [key, value] of tallyUpdates) this.leaderBalances.set(key, value);

    this.markSigProcessed(ev.signature);
    // Keep the tally honest against the chain without slowing the order: once
    // the transaction is readable, the leader's real post-trade balances
    // replace whatever was inferred here.
    void this.reconcileLeaderBalances(ev.address, ev.signature);
    void (async () => {
      for (const sig of signals) {
        // The tally above is already updated (the leader's balance is real
        // regardless of whether we copy); only the COPY is skipped when this
        // trade was already mirrored from a signature-less PumpPortal payload.
        if (this.alreadyCopiedUnsigned(sig.mint, sig.side)) {
          this.pushFeed(wallet, sig, 'skipped',
            'Leader tx matches a trade already copied from the PumpPortal lane — not copied twice.');
          continue;
        }
        await this.handleLeaderSignal(wallet, sig);
      }
    })();
    return true;
  }

  private async reconcileLeaderBalances(leaderAddress: string, signature: string): Promise<void> {
    if (this.txFetchQueue.length > 4) return;
    const parsed = await this.fetchParsedTx(signature);
    if (!parsed || !parsed.meta || parsed.meta.err) return;
    this.recordLeaderBalances(leaderAddress, parsed.meta.preTokenBalances, parsed.meta.postTokenBalances);
  }

  /** The leader's post-transaction balance per mint, from the transaction's own token balance lists. */
  private recordLeaderBalances(
    leaderAddress: string,
    pre: TokenBalance[] | null | undefined,
    post: TokenBalance[] | null | undefined
  ): void {
    const balances = new Map<string, number>();
    for (const tb of post ?? []) {
      if (tb.owner !== leaderAddress || tb.mint === WSOL_MINT) continue;
      balances.set(tb.mint, (balances.get(tb.mint) ?? 0) + (tb.uiTokenAmount?.uiAmount ?? 0));
    }
    for (const tb of pre ?? []) {
      // Present before, absent after: the account was closed — balance is zero.
      if (tb.owner === leaderAddress && tb.mint !== WSOL_MINT && !balances.has(tb.mint)) balances.set(tb.mint, 0);
    }
    for (const [mint, balance] of balances) this.leaderBalances.set(`${leaderAddress}:${mint}`, balance);
  }

  /**
   * Read OUR wallet's current on-chain balance of `mint`, in UI (human) units,
   * summed across all token accounts for that mint. Returns null when it cannot
   * be determined (no connection, no wallet, RPC error) — callers MUST treat
   * null as "unknown", never as zero. Used to decide whether a bag a failed
   * sell left behind is actually gone before closing the position.
   */
  private async getOwnedTokenAmount(mint: string): Promise<number | null> {
    const address = sniperEngine.getWalletStatus().address;
    if (!this.heliusConn || !address) return null;
    try {
      const res = await this.heliusConn.getParsedTokenAccountsByOwner(
        new PublicKey(address),
        { mint: new PublicKey(mint) },
        'confirmed',
      );
      let total = 0;
      for (const { account } of res.value) {
        const amt = (account.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === 'number' && isFinite(amt)) total += amt;
      }
      return total;
    } catch {
      return null;
    }
  }

  /**
   * Poll for the leader's transaction until the RPC can serve it at
   * 'confirmed'. The log arrives at 'processed', so the first polls are
   * expected to miss; a thrown 429 or socket reset is a reason to wait, not
   * to give up — giving up here is a leader sell we never mirror. (The old
   * code made one fetch, one 700ms retry, and dropped the signal on any
   * exception.)
   */
  private async fetchParsedTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    if (!this.heliusConn) return null;
    const release = await this.acquireTxFetchSlot();
    try {
      const deadline = Date.now() + TX_FETCH_DEADLINE_MS;
      await sleep(350);
      let pollDelay = TX_FETCH_INTERVAL_MS;
      while (Date.now() < deadline) {
        try {
          const parsed = await this.heliusConn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (parsed) return parsed;
          await sleep(pollDelay);
          pollDelay = Math.min(1000, pollDelay + 150);
        } catch (err) {
          const is429 = isRateLimitError(err);
          await sleep(is429 ? 2000 : 500);
        }
      }
      console.warn(`[CopyTrader] Could not read leader tx ${signature.slice(0, 8)}… within ${TX_FETCH_DEADLINE_MS / 1000}s.`);
      return null;
    } finally {
      release();
    }
  }

  /**
   * Read a transaction as the leader wallet's balance deltas and classify:
   * token up + SOL down = BUY; token down + SOL up = SELL; token down + other
   * token up = token→token swap (a sell leg and a buy leg). WSOL moves count
   * as SOL — aggregators route through wrapped SOL and unwrap in the same tx.
   * Tokens that move with no SOL against them are a TRANSFER (airdrop, dust,
   * wallet-to-wallet) — surfaced in the feed, never copied.
   */
  private async analyzeLeaderTx(leaderAddress: string, signature: string): Promise<LeaderSignal[] | 'fetch_failed'> {
    const parsed = await this.fetchParsedTx(signature);
    // Unreadable and failed-on-chain are different verdicts: the first may be
    // a trade we cannot see yet (the caller retries), the second moved nothing.
    if (!parsed) return 'fetch_failed';
    if (!parsed.meta || parsed.meta.err) return [];

    const meta = parsed.meta;
    const keys = parsed.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
    const leaderIndex = keys.indexOf(leaderAddress);
    if (leaderIndex < 0) return [];

    // Native SOL flow for the leader, with the network fee added back when
    // they paid it (the fee payer is always account 0).
    let effSolDelta = netSolFlowSol(
      meta.preBalances[leaderIndex] ?? 0, meta.postBalances[leaderIndex] ?? 0, meta.fee ?? 0, leaderIndex === 0
    );

    // Token deltas by mint, WSOL folded into the SOL side.
    const deltaByMint = new Map<string, number>();
    const postByMint = new Map<string, number>();
    const touch = (arr: typeof meta.preTokenBalances, sign: 1 | -1) => {
      for (const tb of arr ?? []) {
        if (tb.owner !== leaderAddress) continue;
        const amount = tb.uiTokenAmount?.uiAmount ?? 0;
        if (tb.mint === WSOL_MINT) {
          effSolDelta += sign * amount;
        } else {
          deltaByMint.set(tb.mint, (deltaByMint.get(tb.mint) ?? 0) + sign * amount);
          if (sign === 1) postByMint.set(tb.mint, (postByMint.get(tb.mint) ?? 0) + amount);
        }
      }
    };
    touch(meta.preTokenBalances, -1);
    touch(meta.postTokenBalances, 1);
    if (!deltaByMint.size) return []; // plain SOL transfer / staking / rent
    // Exact balances for the fast lane's tally, whichever path handled this tx.
    this.recordLeaderBalances(leaderAddress, meta.preTokenBalances, meta.postTokenBalances);

    // The venue, from the programs the transaction invoked. Routes our exit,
    // and on its own proves a balance change was a trade and not a transfer.
    const venue = detectVenue(keys);

    // pump.fun curve trades: the curve PDA's own lamport delta is the exact
    // SOL that crossed the curve — no network fee, no rent, no unrelated
    // transfer riding in the same transaction.
    const exactSolByMint = new Map<string, number>();
    if (venue === 'pump') {
      for (const mint of deltaByMint.keys()) {
        let pda: string;
        try { pda = bondingCurvePda(mint).toBase58(); } catch { continue; }
        const idx = keys.indexOf(pda);
        if (idx < 0) continue;
        exactSolByMint.set(mint, Math.abs(((meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0)) / LAMPORTS_PER_SOL));
      }
    }

    const buys: Array<{ mint: string; tokens: number }> = [];
    const sells: Array<{ mint: string; tokens: number; remaining: number }> = [];
    for (const [mint, delta] of deltaByMint) {
      if (delta > TOKEN_DELTA_EPSILON) buys.push({ mint, tokens: delta });
      else if (delta < -TOKEN_DELTA_EPSILON) {
        sells.push({ mint, tokens: -delta, remaining: Math.max(0, postByMint.get(mint) ?? 0) });
      }
    }
    if (!buys.length && !sells.length) return [];

    const solSpent = Math.max(0, -effSolDelta);
    const solReceived = Math.max(0, effSolDelta);
    const isTokenSwap = buys.length > 0 && sells.length > 0;
    const venueKnown = venue !== undefined;

    const signals: LeaderSignal[] = [];
    // Sells first so a token→token swap frees the old bag before the new buy.
    for (const s of sells) {
      const tradeSol = exactSolByMint.get(s.mint) ?? solReceived / sells.length;
      signals.push({
        signature,
        mint: s.mint,
        side: 'sell',
        solAmount: round4(tradeSol),
        tokenAmount: s.tokens,
        remainingTokens: s.remaining,
        priceSol: tradeSol > 0 && s.tokens > 0 ? tradeSol / s.tokens : undefined,
        pool: venue,
        via: 'helius',
        isTokenSwap,
        kind: classifyFlow({ side: 'sell', tradeSol, venueKnown, isTokenSwap }),
      });
    }
    for (const b of buys) {
      const tradeSol = exactSolByMint.get(b.mint) ?? solSpent / buys.length;
      signals.push({
        signature,
        mint: b.mint,
        side: 'buy',
        solAmount: round4(tradeSol),
        tokenAmount: b.tokens,
        priceSol: tradeSol > 0 && b.tokens > 0 ? tradeSol / b.tokens : undefined,
        pool: venue,
        via: 'helius',
        isTokenSwap: isTokenSwap && solSpent <= TOKEN_DELTA_EPSILON,
        kind: classifyFlow({ side: 'buy', tradeSol, venueKnown, isTokenSwap }),
      });
    }
    return signals;
  }

  private markSigProcessed(signature: string): void {
    this.processedSigs.add(signature);
    this.processedSigOrder.push(signature);
    while (this.processedSigOrder.length > PROCESSED_SIG_LIMIT) {
      const old = this.processedSigOrder.shift();
      if (old) this.processedSigs.delete(old);
    }
  }

  // ---------------- PUMPPORTAL FAST LANE ----------------

  private connectPumpPortal(): void {
    if (this.ws) return;

    try {
      // Same user-supplied key as the sniper. subscribeAccountTrade — the whole
      // basis of copy trading — is per-trade data, so on the free tier this
      // socket connects and then reports nothing at all.
      const socket = new WebSocket(sniperEngine.pumpPortalDataUrl());
      this.ws = socket;

      // Same watchdog as the sniper's launch feed: a socket that dies without
      // a FIN never fires `close`, so reconnect-on-close alone left this lane
      // "connected" and deaf. Silence past the threshold terminates it, which
      // synthesises `close` and runs the reconnect below.
      this.wsKeepalive = attachKeepalive(socket, {
        onStale: (silentMs) => {
          console.warn(`[CopyTrader] PumpPortal lane silent for ${(silentMs / 1000).toFixed(0)}s (no data, no pong) — forcing a reconnect.`);
        },
      });

      socket.on('open', () => {
        if (this.ws !== socket) return; // superseded by a restart
        this.wsReconnectAttempt = 0;
        this.streamConnected = true;
        if (!sniperEngine.hasPumpPortalKey()) {
          console.warn('[CopyTrader] ⚠️ Connected on the FREE PumpPortal tier — subscribeAccountTrade delivers no events, so no leader trade can ever be mirrored. Add a funded PumpPortal key in Settings.');
        }
        this.subscribedMints.clear();
        const keys = this.enabledWalletAddresses();
        if (keys.length) this.sendWs({ method: 'subscribeAccountTrade', keys });
        // Re-subscribe held mints so price ticks survive a reconnect.
        const held = this.positions.filter(p => p.status !== 'CLOSED').map(p => p.mint);
        if (held.length) {
          this.sendWs({ method: 'subscribeTokenTrade', keys: held });
          held.forEach(m => this.subscribedMints.add(m));
        }
        this.emitChange();
      });

      socket.on('message', (data: WebSocket.Data) => {
        if (this.ws !== socket) return;
        this.wsKeepalive?.touch();
        try {
          const payload = JSON.parse(data.toString());
          void this.handlePumpPortalMessage(payload);
        } catch { /* malformed frame */ }
      });

      socket.on('error', () => { /* close handler drives reconnect */ });

      socket.on('close', () => {
        // An old socket closing after a restart must not null out the live one
        // — that used to leave an orphan socket delivering duplicate ticks.
        if (this.ws !== socket) return;
        this.wsKeepalive?.stop();
        this.wsKeepalive = null;
        this.ws = null;
        this.streamConnected = false;
        this.emitChange();
        if (this.config.enabled) {
          setTimeout(() => this.connectPumpPortal(), reconnectDelayMs(this.wsReconnectAttempt++));
        }
      });
    } catch {
      this.ws = null;
      this.streamConnected = false;
    }
  }

  private disconnectPumpPortal(): void {
    const socket = this.ws;
    this.ws = null;
    this.wsKeepalive?.stop();
    this.wsKeepalive = null;
    if (socket) {
      try { socket.close(); } catch { /* dying socket */ }
    }
    this.streamConnected = false;
    this.subscribedMints.clear();
  }

  private sendWs(payload: object): boolean {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
        return true;
      }
    } catch { /* dead socket */ }
    return false;
  }

  private subscribeMint(mint: string): void {
    if (this.subscribedMints.has(mint)) return;
    if (this.sendWs({ method: 'subscribeTokenTrade', keys: [mint] })) {
      this.subscribedMints.add(mint);
    }
  }

  private unsubscribeMintIfIdle(mint: string): void {
    const stillHeld = this.positions.some(p => p.mint === mint && p.status !== 'CLOSED');
    if (stillHeld || !this.subscribedMints.has(mint)) return;
    this.sendWs({ method: 'unsubscribeTokenTrade', keys: [mint] });
    this.subscribedMints.delete(mint);
  }

  private async handlePumpPortalMessage(payload: any): Promise<void> {
    if (!payload || !payload.mint) return;
    const trader: string | undefined = payload.traderPublicKey;
    const wallet = trader ? this.wallets.get(trader) : undefined;
    const isLeaderSignal = Boolean(wallet?.enabled);

    // Every trade on a held mint reprices the position — including the
    // leader's own, so a leader signal is never lost as "just a tick".
    if (payload.txType === 'buy' || payload.txType === 'sell') {
      this.applyPriceTick(payload);
    }

    if (!isLeaderSignal || !this.config.enabled) return;
    if (payload.txType !== 'buy' && payload.txType !== 'sell') return;

    const signature: string | undefined = typeof payload.signature === 'string' ? payload.signature : undefined;
    if (signature) {
      if (this.processedSigs.has(signature)) return; // Helius lane won the race
      this.markSigProcessed(signature);
    } else {
      // No signature — this trade CANNOT be deduped against the Helius lane,
      // which delivers the same transaction with its signature moments later.
      // Executing from both lanes copies the trade twice (a 50% mirror twice
      // is 75% out). If THIS leader's Helius subscription is live it will drive
      // the execution; this payload has already served as the price tick above.
      // Only when this leader's on-chain lane is down does the unsigned payload
      // become the sole source. Keyed per-leader, not on global isHealthy():
      // isHealthy() is false whenever ANY other tracked wallet is mid-ack (e.g.
      // just after add-wallet), which used to let an unsigned copy fire for a
      // leader whose own subscription was live — and Helius then copied it AGAIN.
      if (this.logWatcher?.isAddressLive(trader!) ?? false) return;
      this.unsignedCopies.set(`${payload.mint}:${payload.txType}`, Date.now());
      if (this.unsignedCopies.size > 50) {
        const cutoff = Date.now() - UNSIGNED_COPY_DEDUP_MS;
        for (const [k, t] of this.unsignedCopies) if (t < cutoff) this.unsignedCopies.delete(k);
      }
    }

    await this.handleLeaderSignal(wallet!, {
      signature,
      mint: payload.mint,
      side: payload.txType,
      solAmount: Number(payload.solAmount) || 0,
      tokenAmount: Number(payload.tokenAmount) || 0,
      remainingTokens: isFinite(Number(payload.newTokenBalance)) ? Math.max(0, Number(payload.newTokenBalance)) : undefined,
      pool: typeof payload.pool === 'string' ? payload.pool : undefined,
      symbol: typeof payload.symbol === 'string' ? payload.symbol : undefined,
      priceSol: Number(payload.solAmount) > 0 && Number(payload.tokenAmount) > 0
        ? Number(payload.solAmount) / Number(payload.tokenAmount)
        : undefined,
      via: 'pumpportal',
      kind: 'trade',
    });
  }

  // ---------------- COPY LOGIC ----------------

  private async handleLeaderSignal(wallet: TrackedWalletInternal, sig: LeaderSignal): Promise<void> {
    wallet.lastSeenAt = Date.now();

    if (sig.kind === 'transfer') {
      // Tokens moved, SOL did not: an airdrop, a dust attack, or a bag moved
      // between the leader's own wallets. Classifying by token delta alone is
      // what made the copy trader buy airdrops and dump a position the leader
      // had merely moved.
      //
      // EXCEPT an outflow of a mint WE HOLD. On-chain verified 2026-08-23:
      // the tracked leader's exit infra never sold from the tracked wallet —
      // the entire 15,496,462-token 8jXp bag left at 21:51:05 as a plain
      // transfer (no SOL back, no venue program) and was disposed of from
      // another wallet, while this branch filed it under "not a sell" and
      // the copy position sat stranded. For a held mint, the leader's bag
      // leaving IS the exit signal; where they route the proceeds is their
      // bookkeeping. Buys stay ignored (airdrop protection), un-held mints
      // stay ignored (nothing to exit), and the copySells toggle still rules
      // inside onLeaderSell.
      if (sig.side === 'sell' && this.config.mirrorLeaderTokenMoves) {
        const held = this.positions.find(p => p.mint === sig.mint && p.status !== 'CLOSED');
        const buyInFlight = !held && this.tradeQueue.isBusy(sig.mint);
        if (held || buyInFlight) {
          const fraction = leaderSellFraction(sig.tokenAmount, sig.remainingTokens);
          if (fraction < TOKEN_MOVE_MIN_FRACTION && fraction < 0.999) {
            wallet.skippedSignals++;
            this.pushFeed(wallet, sig, 'skipped',
              `Leader moved ${(fraction * 100).toFixed(1)}% of their bag out (no SOL back) — dust-level shuffle, HOLDING.`);
            return;
          }
          this.pushFeed(wallet, sig, 'pending',
            `Leader MOVED ${(fraction * 100).toFixed(0)}% of their bag out with no SOL received — their exit runs through another wallet. Treating it as an EXIT.`);
          wallet.sellsSeen++;
          await this.onLeaderSell(wallet, sig);
          return;
        }
      }
      wallet.skippedSignals++;
      this.pushFeed(wallet, sig, 'skipped', sig.side === 'buy'
        ? 'Leader RECEIVED tokens with no SOL paid (airdrop / wallet-to-wallet) — not a buy, ignored.'
        : 'Leader MOVED tokens out with no SOL received (wallet-to-wallet / deposit) — not a sell, ignored. Use SELL if you want out.');
      return;
    }

    // Every leader trade on a held mint is a fresh price — on the free
    // PumpPortal tier it is the only real-time price the copy trader gets.
    if (sig.priceSol && sig.priceSol > 0) {
      const held = this.positions.find(p => p.mint === sig.mint && p.status !== 'CLOSED');
      if (held) {
        held.lastPriceAt = Date.now();
        this.repricePosition(held, sig.priceSol);
      }
    }

    if (sig.side === 'buy') {
      wallet.buysSeen++;
      await this.onLeaderBuy(wallet, sig);
    } else {
      wallet.sellsSeen++;
      await this.onLeaderSell(wallet, sig);
    }
  }

  /** SOL claimed by in-flight real copy buys of OTHER mints (same-mint work is queue-serialized). */
  private inFlightBuyReservedSol(excludeMint: string): number {
    let sum = 0;
    for (const [m, sol] of this.inFlightBuySol) {
      if (m !== excludeMint) sum += sol;
    }
    return sum;
  }

  private async onLeaderBuy(wallet: TrackedWalletInternal, sig: LeaderSignal): Promise<void> {
    const mint = sig.mint;
    const symbol = this.symbolFor(sig);

    const skip = (detail: string) => {
      wallet.skippedSignals++;
      this.pushFeed(wallet, sig, 'skipped', detail);
    };

    if (!isCopyableMint(mint)) {
      // Measured 2026-08-23: a tracked wallet that also market-makes produced
      // 210 copied "buys" of USDC in two minutes.
      return skip(`$${symbol} is a stablecoin / wrapped major, not a memecoin — not copied.`);
    }
    // Venue routing for the order. A known executable venue routes directly.
    // An unknown one is NOT a reason to refuse by itself — measured
    // 2026-08-23: 9 of 10 Jupiter-routed swaps expose none of our venue
    // programs (the legs run through Orca / Meteora / private pools), which
    // made v1.0.4 skip essentially every aggregator-using leader and "never
    // buy". A launchpad mint ('pump' / 'bonk' suffix) is executable via
    // PumpPortal's 'auto' wherever the leader happened to trade it; only a
    // token that is neither on a known venue nor a launchpad mint is skipped.
    const buyPool = sig.via === 'helius' ? resolveBuyPool(sig.pool, mint) : sig.pool;
    if (sig.via === 'helius' && buyPool === undefined) {
      return skip('Leader bought on a venue this bot cannot execute on (not pump.fun / PumpSwap / Raydium / LaunchLab, and not a pump/bonk mint) — not copied.');
    }

    if (this.config.minLeaderBuySol > 0 && !sig.isTokenSwap && sig.solAmount < this.config.minLeaderBuySol) {
      return skip(`Leader buy ${sig.solAmount.toFixed(4)} SOL is below the ${this.config.minLeaderBuySol} SOL minimum.`);
    }

    const existing = this.positions.find(p => p.mint === mint && p.status !== 'CLOSED');
    if (existing && this.config.blockRepeatBuys) {
      return skip('Already holding this mint and repeat buys are blocked.');
    }

    if (!existing) {
      const openCount = this.positions.filter(p => p.status !== 'CLOSED').length;
      if (openCount >= this.config.maxOpenPositions) {
        return skip(`Max open copy positions reached (${openCount}/${this.config.maxOpenPositions}) — SELL a position to free a slot, or raise the limit in Copy Settings.`);
      }
    }

    if (sniperEngine.getHeldMints().has(mint)) {
      // A '100%' PumpPortal sell moves the WALLET's whole balance of the mint.
      // Sharing a mint with the sniper would make either bot's exit dump both
      // positions, so the overlap is refused outright.
      return skip('The sniper engine already holds this mint — refusing to share a position.');
    }

    if (this.config.perWalletCooldownSec > 0 && wallet.lastCopiedBuyAt) {
      const sinceSec = (Date.now() - wallet.lastCopiedBuyAt) / 1000;
      if (sinceSec < this.config.perWalletCooldownSec) {
        return skip(`Cooldown: ${Math.ceil(this.config.perWalletCooldownSec - sinceSec)}s until this wallet's next copy.`);
      }
    }

    // Sizing — the REQUESTED size only. Real mode clamps to the wallet at
    // execution time, INSIDE the queue, against a freshly read balance.
    let copySol: number;
    if (this.config.buySizeMode === 'fixed') {
      copySol = this.config.fixedBuySol;
    } else {
      if (sig.solAmount <= 0) {
        return skip('Token→token swap carries no SOL size to scale from — switch to fixed sizing to copy these.');
      }
      copySol = sig.solAmount * (this.config.proportionalPct / 100);
    }
    copySol = round4(Math.min(copySol, this.config.maxBuySol));
    if (copySol <= 0) {
      return skip('Computed copy size is 0 SOL — check buy sizing in Copy Settings.');
    }

    // The leader's realized price straight from their fill — exact for
    // pump.fun curve trades; DexScreener as the fallback when the trade
    // carried no usable price (token→token legs).
    let leaderPriceSol = sig.priceSol && sig.priceSol > 0
      ? sig.priceSol
      : (sig.tokenAmount > 0 && sig.solAmount > 0 ? sig.solAmount / sig.tokenAmount : 0);

    // Execution is serialised per mint together with the exits. A leader who
    // flips inside a few seconds has their SELL arrive while this buy is
    // still landing; it must wait for the bag to exist — not find nothing and
    // walk away, which left the bag orphaned with the leader already out.
    await this.tradeQueue.run(mint, async () => {
      // The DexScreener price fallback runs INSIDE the queue: the claim
      // happens synchronously at run(), so a leader flip-sell arriving during
      // this HTTP hop queues behind the buy instead of finding no position
      // and walking away — the exact drop the queue exists to prevent.
      if (leaderPriceSol <= 0) {
        leaderPriceSol = await this.quotePriceSol(mint);
      }

      // Re-resolve at execution time: a second leader buy that queued behind
      // this one must fold into the position this one opens, not open a twin.
      const existingNow = this.positions.find(p => p.mint === mint && p.status !== 'CLOSED');

      // Re-check the book cap HERE too: the arrival-time check cannot see
      // buys of other mints that are still landing (positions are recorded
      // only after confirmation), so N concurrent signals could all pass it.
      if (!existingNow) {
        const openNow = this.positions.filter(p => p.status !== 'CLOSED').length;
        const landingNew = [...this.inFlightBuySol.keys()]
          .filter(m => m !== mint && !this.positions.some(p => p.mint === m && p.status !== 'CLOSED')).length;
        if (openNow + landingNew >= this.config.maxOpenPositions) {
          wallet.skippedSignals++;
          this.pushFeed(wallet, sig, 'skipped',
            `Max open copy positions reached at execution time (${openNow} open + ${landingNew} landing) — not opened.`);
          return;
        }
      }

      if (this.config.tradingMode === 'real') {
        const blockers = sniperEngine.getWalletStatus().blockers;
        if (blockers.length) {
          wallet.skippedSignals++;
          this.pushFeed(wallet, sig, 'failed', `Wallet not tradable: ${blockers.join(' ')}`);
          return;
        }

        // Affordability is decided HERE, inside the queue, against a balance
        // read AFTER whatever traded ahead of us settled. Sizing before the
        // queue used the 8s-cached balance: two leader buys 4s apart were
        // both sized from the same snapshot, the second overdrafted the gas
        // float, and the wallet was left too poor to pay for its own exit
        // (measured 2026-08-23 — the "bot did not sell" session).
        //
        // Exit gas is reserved per position that will need one: what a buy
        // leaves behind must still fund every open position's sell. This
        // TRIMS the order (never refuses a fundable one — owner posture);
        // only a literal zero after the reserve is skipped, and it says why.
        let clampNote = '';
        // Balance-only forced read, bounded so a hung RPC socket cannot pin
        // this mint's queue while a leader flip-sell waits behind the buy.
        await Promise.race([sniperEngine.refreshWalletBalance(), sleep(1500)]);
        const openAfterThisBuy = this.positions.filter(p => p.status !== 'CLOSED').length + (existingNow ? 0 : 1);
        const reservedForExits = round4(COPY_EXIT_GAS_RESERVE_SOL * openAfterThisBuy);
        // SOL claimed by concurrent buys of OTHER mints (they run in their
        // own queues against the same snapshot) — without this, two leaders
        // or one leader buying two tokens re-creates the drain cross-mint.
        const reservedInFlight = this.inFlightBuyReservedSol(mint);
        // The sniper signs with this same wallet — its in-flight entries have
        // claimed SOL the raw balance still shows as free.
        const reservedBySniper = sniperEngine.getInFlightEntryReservedSol();
        // Worst-case fee: with dynamicPriorityFee on, execution can pay up
        // to maxPriorityFeeSol — budgeting the static value eats the float.
        const sizingFeeSol = sniperEngine.getSizingPriorityFeeSol();
        const deployableSol = Math.max(0,
          sniperEngine.getWalletStatus().deployableSol - reservedForExits - reservedInFlight - reservedBySniper);
        const affordable = round4(affordableStakeSol(
          copySol, deployableSol, this.config.maxSlippagePct, sizingFeeSol
        ));
        if (affordable <= 0) {
          wallet.skippedSignals++;
          this.pushFeed(wallet, sig, 'skipped',
            `Copy size is 0 SOL after reserving exit gas (${reservedForExits} SOL for ${openAfterThisBuy} position${openAfterThisBuy === 1 ? '' : 's'}) — top up the wallet to keep copying.`);
          return;
        }
        if (affordable < copySol) {
          clampNote = ` (clamped from ${copySol} SOL — all the wallet can fund after the exit-gas reserve)`;
        }
        copySol = affordable;

        // Claim the full worst-case outflow (stake + slippage reserve +
        // protocol fees + priority fee + rent) for the duration of the order —
        // plus the exit gas the NEW position will need, so a concurrent buy of
        // another mint reserves for this position before it is recorded.
        this.inFlightBuySol.set(mint,
          copySol * (1 + this.config.maxSlippagePct / 100 + 0.015) + sizingFeeSol + 0.0025
          + (existingNow ? 0 : COPY_EXIT_GAS_RESERVE_SOL));
        let result: TradeResult | null;
        try {
          result = await sniperEngine.executeExternalTrade(
            'buy', mint, copySol, undefined, buyPool, this.config.maxSlippagePct
          );
        } finally {
          this.inFlightBuySol.delete(mint);
        }
        if (!result) {
          this.pushFeed(wallet, sig, 'failed', `Real BUY of ${copySol} SOL failed — see engine log.`);
          return;
        }

        // Balance deltas are facts; quotes are opinions. Use the fill when the
        // inspector could read it, estimates otherwise.
        const fill = result.fill;
        const tokensBought = fill && fill.tokenDelta > 0
          ? fill.tokenDelta
          : (leaderPriceSol > 0 ? copySol / leaderPriceSol : 0);
        const solSpent = fill ? Math.abs(Math.min(0, fill.solDelta)) : copySol;
        const entryPriceSol = tokensBought > 0 ? solSpent / tokensBought : leaderPriceSol;

        this.recordBuy(wallet, sig, existingNow, {
          tokens: tokensBought,
          solSpent,
          priceSol: entryPriceSol,
          txid: result.txid,
          fillVerified: Boolean(fill),
        });
        this.pushFeed(wallet, sig, 'copied',
          `REAL BUY ${copySol} SOL of $${symbol}${existingNow ? ' (added to position)' : ''}${clampNote} @ ${fmtPrice(entryPriceSol)} SOL/token`,
          copySol, result.txid);
      } else {
        // Paper: fill at the leader's realized price plus a slippage haircut —
        // we would have landed AFTER them, never at a better price.
        if (leaderPriceSol <= 0) {
          wallet.skippedSignals++;
          this.pushFeed(wallet, sig, 'skipped', 'No usable price for this mint (leader fill and DexScreener both silent) — cannot simulate.');
          return;
        }
        const paperPriceSol = leaderPriceSol * (1 + PAPER_SLIPPAGE_PCT / 100);
        const tokensBought = copySol / paperPriceSol;
        const txid = `sim_copy_${Date.now()}_${++this.idCounter}`;

        this.recordBuy(wallet, sig, existingNow, {
          tokens: tokensBought,
          solSpent: copySol,
          priceSol: paperPriceSol,
          txid,
          fillVerified: false,
        });
        this.pushFeed(wallet, sig, 'copied',
          `PAPER BUY ${copySol} SOL of $${symbol}${existingNow ? ' (added to position)' : ''} @ ${fmtPrice(paperPriceSol)} SOL/token`,
          copySol, txid);
      }

      this.subscribeMint(mint);
      this.persist();
      this.emitChange();
    });
  }

  /** Open a new copy position, or fold a repeat buy into the existing one. */
  private recordBuy(
    wallet: TrackedWalletInternal,
    sig: LeaderSignal,
    existing: CopyPositionInternal | undefined,
    fill: { tokens: number; solSpent: number; priceSol: number; txid?: string; fillVerified: boolean }
  ): void {
    const solPriceUsd = sniperEngine.getSolPriceUsd();
    let pos: CopyPositionInternal;

    if (existing) {
      // DCA merge: re-average the entry price over the combined bag.
      const prevTokens = existing.tokensHeld;
      const combined = prevTokens + fill.tokens;
      existing.entryPriceSol = combined > 0
        ? (existing.entryPriceSol * prevTokens + fill.priceSol * fill.tokens) / combined
        : fill.priceSol;
      existing.tokensHeld = combined;
      existing.investedSol = round4(existing.investedSol + fill.solSpent);
      existing.investedUsd = round2(existing.investedUsd + fill.solSpent * solPriceUsd);
      existing.fillVerified = existing.fillVerified && fill.fillVerified;
      this.repricePosition(existing, existing.currentPriceSol || fill.priceSol);
      pos = existing;
    } else {
      pos = {
        id: `cp_${Date.now()}_${++this.idCounter}`,
        mint: sig.mint,
        tokenSymbol: this.symbolFor(sig),
        tokenName: sig.symbol ? sig.symbol : 'Copied Token',
        leaderWallet: wallet.address,
        leaderNickname: wallet.nickname,
        pool: sig.pool,
        tokensHeld: fill.tokens,
        investedSol: round4(fill.solSpent),
        investedUsd: round2(fill.solSpent * solPriceUsd),
        entryPriceSol: fill.priceSol,
        currentPriceSol: fill.priceSol,
        pnlPct: 0,
        pnlUsd: 0,
        pnlSol: 0,
        entryTime: Date.now(),
        buyTxid: fill.txid,
        fillVerified: fill.fillVerified,
        status: 'OPEN',
        realizedPnlUsd: 0,
        realizedPnlSol: 0,
        lastPriceAt: Date.now(),
      };
      this.positions.unshift(pos);
    }

    wallet.copiedBuys++;
    wallet.lastCopiedBuyAt = Date.now();

    this.pushHistory({
      id: `ct_${Date.now()}_${++this.idCounter}`,
      positionId: pos.id,
      mint: pos.mint,
      tokenSymbol: pos.tokenSymbol,
      leaderWallet: wallet.address,
      leaderNickname: wallet.nickname,
      side: 'buy',
      solAmount: round4(fill.solSpent),
      tokensMoved: fill.tokens,
      priceSol: fill.priceSol,
      pnlUsd: 0,
      pnlSol: 0,
      pnlPct: 0,
      timestamp: Date.now(),
      txid: fill.txid,
      fillVerified: fill.fillVerified,
      exitReason: '',
    });
  }

  /**
   * Mirrors a leader's exit, when `copySells` says to.
   *
   * HISTORY, because this reversed twice: auto-sells were stripped out
   * entirely on 2026-08-12 — `copySells` and `sellMode` stayed in the config
   * purely so old saved files still parsed, and this method only ever wrote a
   * "HOLDING" line to the feed. Restored 2026-08-13 as a toggle, per the
   * owner's exits model: an auto-sell is a setting, and it fires on EVIDENCE
   * rather than on price. A tracked leader dumping their bag is evidence —
   * it is not a stop-loss, and nothing here reacts to the price falling.
   *
   * `copySells: false` returns the previous behaviour exactly.
   *
   * The exit is queued per MINT behind whatever is already running for it —
   * another exit, or the BUY this sell belongs to. A leader who flips inside
   * a few seconds used to have their sell arrive while our buy was still
   * landing, find no position, and be dropped as "nothing held".
   */
  private async onLeaderSell(wallet: TrackedWalletInternal, sig: LeaderSignal): Promise<void> {
    const held = this.positions.find(p => p.mint === sig.mint && p.status !== 'CLOSED');
    const buyInFlight = !held && this.tradeQueue.isBusy(sig.mint);

    if (!held && !buyInFlight) {
      // Visible but cheap: the leader disposed of something we never copied
      // (bought before tracking, airdrop, transfer-in).
      this.pushFeed(wallet, sig, 'skipped', 'No copy position in this mint — nothing held.');
      return;
    }

    // Exact sell fraction from the leader's post-trade balance. Both feeds
    // supply it: PumpPortal as newTokenBalance, Helius from post balances.
    const fraction = leaderSellFraction(sig.tokenAmount, sig.remainingTokens);

    const exitedFully = fraction >= 0.999;
    const describeLeader = exitedFully
      ? `Leader ${wallet.nickname} EXITED FULLY`
      : `Leader ${wallet.nickname} sold ${(fraction * 100).toFixed(0)}% of their bag`;

    if (!this.config.copySells) {
      wallet.skippedSignals++;
      this.pushFeed(wallet, sig, 'skipped',
        `${describeLeader} — HOLDING (copy-sells are off; sell manually if you want out).`);
      return;
    }

    // 'mirror' matches their exit proportionally; 'full' treats any leader sell
    // as the exit signal and closes the whole position.
    const sellFraction = this.config.sellMode === 'full' ? 1 : fraction;
    if (sellFraction <= 0) {
      this.pushFeed(wallet, sig, 'skipped', `${describeLeader} — no measurable fraction to mirror.`);
      return;
    }

    const pct = (sellFraction * 100).toFixed(0);
    const queued = this.tradeQueue.isBusy(sig.mint);
    this.pushFeed(wallet, sig, queued ? 'pending' : 'copied',
      !queued
        ? `${describeLeader} — mirroring ${pct}% exit.`
        : buyInFlight
          ? `${describeLeader} — our BUY is still landing; ${pct}% exit QUEUED behind it.`
          : `${describeLeader} — ${pct}% exit QUEUED behind the sell already in flight.`);

    const reason = exitedFully && this.config.sellMode !== 'full'
      ? `leader ${wallet.nickname} exited fully`
      : `leader ${wallet.nickname} sold ${(fraction * 100).toFixed(0)}%`;

    await this.tradeQueue.run(sig.mint, async () => {
      // Resolve the position NOW — it may have been opened by the buy this
      // sell waited for, or emptied by an exit ahead of it in the queue.
      const pos = this.positions.find(p => p.mint === sig.mint && p.status !== 'CLOSED');
      if (!pos) {
        this.pushFeed(wallet, sig, 'skipped', `${describeLeader} — our buy did not land, nothing to sell.`);
        return;
      }
      // runExit, not closePosition: this already runs inside the mint's queue.
      await this.runExit(pos, sellFraction, reason, sig, wallet);
    });
  }

  /**
   * Mark a real position closed because the wallet no longer holds the bag —
   * the tokens were exited outside the bot (manually on Photon/Dex) or there was
   * nothing left to sell. Call ONLY after getOwnedTokenAmount has confirmed the
   * balance is effectively zero; a blind close strands a real bag (H2).
   */
  private closeAsExternallyExited(pos: CopyPositionInternal): void {
    pos.status = 'CLOSED';
    pos.tokensHeld = 0;
    this.unsubscribeMintIfIdle(pos.mint);
    this.pushHistory({
      id: `ct_${Date.now()}_${++this.idCounter}`,
      positionId: pos.id,
      mint: pos.mint,
      tokenSymbol: pos.tokenSymbol,
      leaderWallet: pos.leaderWallet,
      leaderNickname: pos.leaderNickname,
      side: 'sell',
      solAmount: 0,
      tokensMoved: 0,
      priceSol: pos.currentPriceSol || pos.entryPriceSol,
      pnlUsd: round2(pos.pnlUsd),
      pnlSol: round4(pos.pnlSol),
      pnlPct: Math.round(pos.pnlPct * 10) / 10,
      timestamp: Date.now(),
      txid: pos.buyTxid,
      fillVerified: false,
      exitReason: 'Closed after confirmed external exit (wallet no longer holds the bag)',
    });
    this.persist();
    this.emitChange();
  }

  /**
   * Sell `fraction` (0-1] of a copy position. Real mode routes through the
   * engine's execution path as a percentage-of-holdings order; paper mode
   * fills at the last observed price with the same slippage haircut as entry.
   *
   * Exits for one position run strictly one after another, in the order the
   * signals arrived — never dropped. Each queued fraction applies to what is
   * LEFT when its turn comes, which is exactly how the leader's own sequence
   * of partial sells composes: "50%, then the rest" leaves us flat, like them.
   */
  private closePosition(
    pos: CopyPositionInternal,
    fraction: number,
    reason: string,
    leaderSig?: LeaderSignal,
    wallet?: TrackedWalletInternal
  ): Promise<void> {
    return this.tradeQueue.run(pos.mint, () => this.runExit(pos, fraction, reason, leaderSig, wallet));
  }

  private async runExit(
    pos: CopyPositionInternal,
    fraction: number,
    reason: string,
    leaderSig?: LeaderSignal,
    wallet?: TrackedWalletInternal
  ): Promise<void> {
    const feedSig: LeaderSignal = leaderSig
      ?? { mint: pos.mint, side: 'sell', solAmount: 0, tokenAmount: 0, symbol: pos.tokenSymbol, via: 'manual' };
    const isManual = feedSig.via === 'manual';
    if (isManual) this.manualExitRequested.delete(pos.id);

    if (pos.status === 'CLOSED' || pos.tokensHeld <= 1e-9) {
      // An earlier queued exit already emptied the bag (a 'full'-mode sell, or
      // a leader who sold "the rest" twice). Nothing left to mirror.
      if (wallet) this.pushFeed(wallet, feedSig, 'skipped', `$${pos.tokenSymbol} position is already closed — nothing left to sell.`);
      return;
    }

    // Execution follows the POSITION's provenance, not the current mode. A
    // real position exited while the mode is paper must be refused — booking
    // a simulated fill would mark it CLOSED while the real tokens sit in the
    // wallet with nothing watching them (the stranded-bag failure again).
    const realPosition = !(pos.buyTxid ?? '').startsWith('sim_');
    if (realPosition && this.config.tradingMode !== 'real') {
      if (wallet) {
        this.pushFeed(wallet, feedSig, 'failed',
          `$${pos.tokenSymbol} is a REAL position but trading mode is PAPER — switch back to REAL mode to exit it. Position kept, tokens untouched.`);
      }
      return;
    }

    pos.exitInFlight = true;
    try {
      fraction = Math.max(0, Math.min(1, fraction));
      const solPriceUsd = sniperEngine.getSolPriceUsd();
      const isFull = fraction >= 0.999;
      let tokensSold = pos.tokensHeld * fraction;
      let solReceived: number;
      let txid: string | undefined;
      let fillVerified = false;

      // Real positions sell for real; PAPER-bought bags (sim_ txid) simulate.
      // Requiring a buyTxid to exist here booked a phantom "paper" sell for a
      // real position whose txid was missing — history showed an exit that
      // never happened while the tokens stayed in the wallet.
      if (realPosition) {
        const result = await this.executeRealSell(pos, fraction, feedSig, wallet);
        if (!result) {
          // executeRealSell already kept the position and surfaced the failure.
          // A null result is a FAILED sell (illiquid venue, RPC storm, tight
          // slippage) far more often than an already-completed external exit —
          // so the bag is almost always STILL in the wallet. Only close when the
          // wallet on-chain no longer holds it; otherwise leave the position open
          // for the SELL button to retry. Closing blind here zeroed tokensHeld
          // and dropped a real bag from tracking to ride to zero unwatched (H2).
          if (isManual) {
            const held = await this.getOwnedTokenAmount(pos.mint);
            const expected = pos.tokensHeld || 0;
            const effectivelyGone = held !== null && held <= Math.max(0, expected * 0.05);
            if (effectivelyGone) {
              this.closeAsExternallyExited(pos);
            } else if (wallet) {
              const note = held === null
                ? 'on-chain balance could not be read'
                : `${held} tokens are still in the wallet`;
              this.pushFeed(wallet, feedSig, 'failed',
                `$${pos.tokenSymbol}: liquidation did not complete and ${note} — position KEPT. Retry with SELL; use the ✕ dismiss only if you already sold this elsewhere.`);
            }
          }
          return;
        }
        txid = result.txid;
        const fill = result.fill;
        if (fill) {
          fillVerified = true;
          solReceived = Math.max(0, fill.solDelta);
          tokensSold = Math.abs(Math.min(0, fill.tokenDelta)) || tokensSold;
        } else {
          solReceived = tokensSold * pos.currentPriceSol;
        }
      } else {
        // Paper exit at the LEADER's realized exit price when the signal
        // carried one — it is the price that actually printed — else the
        // freshest price we hold. Haircut for slippage either way. Filling at
        // our own price (often stale, often still the entry on the free tier)
        // booked ≈ −3% on every paper sell regardless of what the leader got.
        const leaderExit = leaderSig?.priceSol;
        if (leaderExit && leaderExit > 0) {
          pos.currentPriceSol = leaderExit;
          pos.lastPriceAt = Date.now();
        }
        const exitPriceSol = paperExitPrice(leaderExit, pos.currentPriceSol, PAPER_SLIPPAGE_PCT);
        solReceived = tokensSold * exitPriceSol;
        txid = `sim_copy_${Date.now()}_${++this.idCounter}`;
      }

      const costBasisSol = pos.entryPriceSol * tokensSold;
      const pnlSol = solReceived - costBasisSol;
      const pnlUsd = pnlSol * solPriceUsd;
      const pnlPct = costBasisSol > 0 ? (pnlSol / costBasisSol) * 100 : 0;

      pos.tokensHeld = Math.max(0, pos.tokensHeld - tokensSold);
      pos.realizedPnlSol += pnlSol;
      pos.realizedPnlUsd += pnlUsd;
      pos.status = isFull || pos.tokensHeld <= 1e-9 ? 'CLOSED' : 'PARTIAL';
      if (pos.status === 'CLOSED') pos.tokensHeld = 0;
      this.repricePosition(pos, pos.currentPriceSol);

      const owner = wallet ?? this.wallets.get(pos.leaderWallet);
      if (owner) {
        owner.realizedPnlUsd = round2(owner.realizedPnlUsd + pnlUsd);
        if (!isManual) owner.copiedSells++;
      }

      this.pushHistory({
        id: `ct_${Date.now()}_${++this.idCounter}`,
        positionId: pos.id,
        mint: pos.mint,
        tokenSymbol: pos.tokenSymbol,
        leaderWallet: pos.leaderWallet,
        leaderNickname: pos.leaderNickname,
        side: 'sell',
        solAmount: round4(solReceived),
        tokensMoved: tokensSold,
        priceSol: tokensSold > 0 ? solReceived / tokensSold : 0,
        pnlUsd: round2(pnlUsd),
        pnlSol: round4(pnlSol),
        pnlPct: Math.round(pnlPct * 10) / 10,
        timestamp: Date.now(),
        txid,
        fillVerified,
        exitReason: reason,
      });

      if (wallet) {
        // Label from what EXECUTED, not from the mode: a paper-bought bag
        // exited while the mode is real still simulated its fill.
        this.pushFeed(wallet, feedSig, 'copied',
          `${(txid ?? '').startsWith('sim_') ? 'PAPER' : 'REAL'} SELL ${(fraction * 100).toFixed(0)}% of $${pos.tokenSymbol} — ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${reason})`,
          round4(solReceived), txid);
      }

      if (pos.status === 'CLOSED') this.unsubscribeMintIfIdle(pos.mint);
      this.persist();
      this.emitChange();
    } catch (err: any) {
      // Nothing below is expected to throw, but an exit that did would become
      // an unhandled rejection — and on Node that ends the process with the
      // bag still in the wallet. Report it where the operator is looking.
      if (wallet) this.pushFeed(wallet, feedSig, 'failed', `Exit of $${pos.tokenSymbol} threw: ${err?.message ?? err} — position kept.`);
      console.error(`[CopyTrader] Exit of ${pos.mint} threw:`, err);
    } finally {
      pos.exitInFlight = false;
    }
  }

  /**
   * The real-mode sell, with the retry policy the sniper's own exits already
   * had and copy exits did not: up to COPY_SELL_MAX_ATTEMPTS attempts with
   * backoff, alternating between the leader's sell venue and 'auto'.
   *
   * Venue: the leader's SELL carries the venue that is live right now. The
   * venue recorded at BUY time is stale the moment the token graduates, and a
   * sell routed to a completed bonding curve fails on-chain every time.
   *
   * Slippage: the wider of the copy setting and the engine's own sell band.
   * Passing the copy buy-side number as the override used to bypass the
   * engine's looser sell tolerance exactly when the leader's dump was moving
   * the price.
   */
  private async executeRealSell(
    pos: CopyPositionInternal,
    fraction: number,
    feedSig: LeaderSignal,
    wallet?: TrackedWalletInternal
  ): Promise<TradeResult | null> {
    const pctParam = sellAmountParam(fraction * 100);
    const pct = (fraction * 100).toFixed(0);
    const venues = sellVenueCandidates(feedSig.pool);
    const slippage = copySellSlippagePct(this.config.maxSlippagePct, sniperEngine.getConfig().maxSellSlippagePct);
    const isManual = feedSig.via === 'manual';

    for (let attempt = 1; attempt <= COPY_SELL_MAX_ATTEMPTS; attempt++) {
      const pool = venues[(attempt - 1) % venues.length];
      if (attempt > 1) {
        if (!isManual && this.manualExitRequested.has(pos.id)) {
          // The operator pressed SELL while this was backing off: "now", not
          // "after five more retries". The manual exit is queued right behind.
          if (wallet) this.pushFeed(wallet, feedSig, 'pending', `Automatic retries for $${pos.tokenSymbol} stopped — the SELL button takes over.`);
          return null;
        }
        const delayMs = sellRetryDelayMs(attempt - 1);
        if (wallet) {
          this.pushFeed(wallet, feedSig, 'pending',
            `Real SELL ${pct}% of $${pos.tokenSymbol} failed (attempt ${attempt - 1}/${COPY_SELL_MAX_ATTEMPTS}) — retrying in ${(delayMs / 1000).toFixed(1)}s via ${pool}.`);
        }
        await sleep(delayMs);
        // The operator may have switched to paper mid-retry; a real order must
        // not follow from a stale decision.
        if (this.config.tradingMode !== 'real') return null;
      }
      const result = await sniperEngine.executeExternalTrade('sell', pos.mint, 0, pctParam, pool, slippage);
      if (result && result.timedOut) {
        // The submitted tx can still land until its blockhash expires. A
        // blind resubmit of a percentage sell that then lands TWICE sells
        // more than the mirror intended and corrupts the books — resolve the
        // outcome first, retry only when it definitively failed or expired.
        if (wallet) {
          this.pushFeed(wallet, feedSig, 'pending',
            `SELL ${pct}% of $${pos.tokenSymbol} submitted but unconfirmed — watching the transaction before any retry (a blind resubmit can sell twice).`);
        }
        const outcome = await sniperEngine.resolveTimedOutSell(result.txid, pos.mint);
        if (outcome !== 'failed' && outcome !== 'expired') return outcome; // landed late — book it
      } else if (result) {
        return result;
      }
    }

    if (wallet) {
      const ws = sniperEngine.getWalletStatus();
      const gasHint = ws.solBalance > 0 && ws.solBalance <= 0.005
        ? ` Wallet gas is critically low (${ws.solBalance} SOL): sell fees are auto-reduced to fit, but top up ~0.01 SOL to make exits reliable.`
        : '';
      this.pushFeed(wallet, feedSig, 'failed',
        `Real SELL ${pct}% of $${pos.tokenSymbol} failed ${COPY_SELL_MAX_ATTEMPTS}x (venues tried: ${venues.join(', ')}) — position kept. The SELL button retries; the engine log has the on-chain errors.${gasHint}`);
    }
    return null;
  }

  // ---------------- PRICING & MONITOR ----------------

  /** Live DexScreener quote in SOL per token; 0 when unavailable. */
  private async quotePriceSol(mint: string): Promise<number> {
    try {
      const data = await DexScreenerService.getTokenMarketData(mint);
      const solPriceUsd = sniperEngine.getSolPriceUsd();
      if (data.hasPair && data.priceUsd > 0 && solPriceUsd > 0) {
        return data.priceUsd / solPriceUsd;
      }
    } catch { /* no pair or rate-limited */ }
    return 0;
  }

  /** Reprice any held position from a live PumpPortal trade tick on its mint. */
  private applyPriceTick(payload: any): void {
    const pos = this.positions.find(p => p.mint === payload.mint && p.status !== 'CLOSED');
    if (!pos) return;

    // Curve state gives the marginal price; the trade's own ratio is the
    // realized price. Prefer curve reserves when present (post-trade state).
    let priceSol = 0;
    const vSol = Number(payload.vSolInBondingCurve);
    const vTokens = Number(payload.vTokensInBondingCurve);
    if (isFinite(vSol) && isFinite(vTokens) && vTokens > 0) {
      priceSol = vSol / vTokens;
    } else {
      const solAmt = Number(payload.solAmount) || 0;
      const tokAmt = Number(payload.tokenAmount) || 0;
      if (solAmt > 0 && tokAmt > 0) priceSol = solAmt / tokAmt;
    }
    if (priceSol <= 0) return;

    pos.lastPriceAt = Date.now();
    this.repricePosition(pos, priceSol);
    this.emitChange();
  }

  private repricePosition(pos: CopyPositionInternal, priceSol: number): void {
    const solPriceUsd = sniperEngine.getSolPriceUsd();
    pos.currentPriceSol = priceSol;
    const unrealizedSol = pos.tokensHeld * (priceSol - pos.entryPriceSol);
    pos.pnlSol = round4(unrealizedSol);
    pos.pnlUsd = round2(unrealizedSol * solPriceUsd);
    pos.pnlPct = pos.entryPriceSol > 0
      ? Math.round(((priceSol - pos.entryPriceSol) / pos.entryPriceSol) * 1000) / 10
      : 0;
  }

  /**
   * 1s tick: DexScreener repricing for positions PumpPortal cannot see
   * (non-pump venues), plus the feed's automatic clearing. NO EXITS — the
   * take-profit and max-hold exits that lived here were removed 2026-08-12
   * (owner decision: nothing sells on price or time).
   */
  private startMonitor(): void {
    if (this.monitorInterval) return;
    this.monitorInterval = setInterval(() => {
      const open = this.positions.filter(p => p.status !== 'CLOSED' && !p.exitInFlight);

      // Batch-reprice stale positions. PumpPortal ticks cover pump.fun mints;
      // everything else has no push feed, so it is polled here. The service
      // has its own TTL cache and rate limiter, so a 1s loop is safe.
      const stale = open.filter(p => !p.lastPriceAt || Date.now() - p.lastPriceAt > PRICE_STALE_MS);
      if (stale.length && !this.dexPollInFlight) {
        this.dexPollInFlight = true;
        const solPriceUsd = sniperEngine.getSolPriceUsd();
        DexScreenerService.getManyTokenMarketData(stale.map(p => p.mint))
          .then(results => {
            let changed = false;
            for (const pos of stale) {
              const data = results.get(pos.mint);
              if (data && data.hasPair && data.priceUsd > 0 && solPriceUsd > 0) {
                pos.lastPriceAt = Date.now();
                this.repricePosition(pos, data.priceUsd / solPriceUsd);
                changed = true;
              }
            }
            if (changed) this.emitChange();
          })
          .catch(() => { /* rate-limited or offline — next tick retries */ })
          .finally(() => { this.dexPollInFlight = false; });
      }

      // Automatic feed clearing: lines older than the configured window fall
      // off. Newest-first storage, so the oldest line is the last element and
      // one comparison decides whether anything needs pruning.
      const clearMin = this.config.feedAutoClearMinutes;
      if (clearMin > 0 && this.feed.length) {
        const cutoff = Date.now() - clearMin * 60_000;
        if (this.feed[this.feed.length - 1].timestamp < cutoff) {
          this.feed = this.feed.filter(ev => ev.timestamp >= cutoff);
          this.emitChange();
        }
      }

      // No price-based exits here. closePosition is reached from onLeaderSell
      // (when copySells is on) and from the manual sell button; takeProfitPct
      // and maxHoldSeconds stay in the config for compatibility but are inert.
    }, MONITOR_INTERVAL_MS);
  }

  // ---------------- FEED / HISTORY / HELPERS ----------------

  private symbolFor(sig: { symbol?: string; mint: string }): string {
    if (sig.symbol && sig.symbol.trim()) return sig.symbol.trim();
    return sig.mint ? `${sig.mint.slice(0, 4)}…` : '???';
  }

  private pushFeed(
    wallet: TrackedWalletInternal,
    sig: LeaderSignal,
    action: CopyFeedEvent['action'],
    detail: string,
    copySol?: number,
    txid?: string
  ): void {
    this.feed.unshift({
      id: `cf_${Date.now()}_${++this.idCounter}`,
      timestamp: Date.now(),
      leaderWallet: wallet.address,
      leaderNickname: wallet.nickname,
      mint: sig.mint,
      tokenSymbol: this.symbolFor(sig),
      side: sig.side,
      leaderSolAmount: round4(sig.solAmount),
      action,
      detail: sig.fast ? `⚡ ${detail}` : detail,
      copySol,
      txid,
      via: sig.via,
    });
    if (this.feed.length > FEED_LIMIT) this.feed.length = FEED_LIMIT;
    // The feed is memory-only and auto-clears; the durable copy is what makes
    // a dead session diagnosable (2026-08-23: a stranded position left no
    // trace on disk at all).
    appendBotLog(`[copy-feed] ${action.toUpperCase()} ${sig.side} ${this.symbolFor(sig)} — ${detail}`);
    this.emitChange();
  }

  private pushHistory(record: CopyTradeRecord): void {
    this.history.unshift(record);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  /**
   * Feed attribution for a position whose leader wallet has since been
   * removed from tracking — the manual SELL button must still report.
   */
  private standInWallet(pos: CopyPositionInternal): TrackedWalletInternal {
    return {
      address: pos.leaderWallet,
      shortAddress: shortAddr(pos.leaderWallet),
      nickname: pos.leaderNickname,
      enabled: false,
      addedAt: 0,
      lastSeenAt: null,
      buysSeen: 0,
      sellsSeen: 0,
      copiedBuys: 0,
      copiedSells: 0,
      skippedSignals: 0,
      realizedPnlUsd: 0,
      lastCopiedBuyAt: null,
    };
  }

  private publicWallet(w: TrackedWalletInternal): TrackedWalletPublic {
    const { lastCopiedBuyAt, ...rest } = w;
    return rest;
  }

  private publicPosition(p: CopyPositionInternal): CopyPosition {
    const { realizedPnlUsd, realizedPnlSol, lastPriceAt, ...rest } = p;
    return rest;
  }

  // ---------------- PERSISTENCE ----------------

  /**
   * Wallets, config, open positions and receipts survive a restart. Real copy
   * positions represent tokens actually sitting in the wallet — dropping them
   * on restart would orphan real holdings with no exit watching them.
   */
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
          // Stamped so the copySells opt-out migration runs exactly once.
          configVersion: COPY_CONFIG_VERSION,
          config: this.config,
          wallets: [...this.wallets.values()],
          positions: this.positions.filter(p => p.status !== 'CLOSED'),
          history: this.history.slice(0, HISTORY_LIMIT),
        }, null, 2));
      } catch { /* persistence is best-effort */ }
    }, 500);
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

      if (raw.config && typeof raw.config === 'object') {
        this.config = { ...DEFAULT_CONFIG, ...sanitizeConfig(raw.config) };
        // Never auto-arm REAL trading from a file on disk. Paper may resume;
        // real requires the operator to flip the switch this session.
        if (this.config.tradingMode === 'real') this.config.enabled = false;

        // MIGRATION to schema 2 (auto-sells restored 2026-08-13).
        //
        // `copySells` defaulted to true through the whole period when it did
        // nothing at all — auto-sells were removed on 2026-08-12 and the field
        // survived only so old files still parsed. So every config written
        // before today claims copySells:true while its owner has only ever
        // seen a bot that holds. Honouring that value on upgrade would switch
        // real accounts to automatic selling on the strength of a setting
        // nobody chose. Opt them out once; the toggle is theirs afterwards.
        if (Number(raw.configVersion) < COPY_CONFIG_VERSION || raw.configVersion === undefined) {
          if (this.config.copySells) {
            this.config.copySells = false;
            console.warn('[CopyTrader] Automatic selling is now available and is OFF for this install. Your saved config predates the feature, so it was not switched on for you — enable "copy sells" in the Copy Trading tab if you want the bot to mirror leader exits.');
          }
          // Write the stamp NOW. persist() otherwise only fires on a change, so
          // the file kept its old shape and the migration re-ran on every start
          // — re-disabling the toggle each boot for anyone who had turned it on
          // but not since touched another setting. (Observed on the first
          // smoke test: the warning printed but configVersion stayed unset.)
          this.persist();
        }
      }

      if (Array.isArray(raw.wallets)) {
        for (const w of raw.wallets) {
          if (w && typeof w.address === 'string') {
            this.wallets.set(w.address, {
              address: w.address,
              shortAddress: shortAddr(w.address),
              nickname: typeof w.nickname === 'string' ? w.nickname : shortAddr(w.address),
              enabled: w.enabled !== false,
              addedAt: Number(w.addedAt) || Date.now(),
              lastSeenAt: Number(w.lastSeenAt) || null,
              buysSeen: Number(w.buysSeen) || 0,
              sellsSeen: Number(w.sellsSeen) || 0,
              copiedBuys: Number(w.copiedBuys) || 0,
              copiedSells: Number(w.copiedSells) || 0,
              skippedSignals: Number(w.skippedSignals) || 0,
              realizedPnlUsd: Number(w.realizedPnlUsd) || 0,
              lastCopiedBuyAt: null,
            });
          }
        }
      }

      if (Array.isArray(raw.positions)) {
        // Junk from before the classifier existed (v1.0.3 and earlier copied
        // stablecoin legs): PAPER positions in non-copyable mints are fiction,
        // and they were found permanently occupying every slot — the book read
        // 10/10 and no buy could ever open again. Real positions are real
        // tokens and are always kept.
        const restorable = raw.positions.filter((p: any) => p && typeof p.mint === 'string' && p.status !== 'CLOSED');
        const junk = restorable.filter((p: any) => !isCopyableMint(p.mint) && (!p.buyTxid || String(p.buyTxid).startsWith('sim_')));
        if (junk.length) {
          console.warn(`[CopyTrader] Dropped ${junk.length} paper position(s) in stablecoins/majors left by the pre-classifier copier — they were blocking the book.`);
        }
        this.positions = restorable
          .filter((p: any) => !junk.includes(p))
          .map((p: any) => ({
            ...p,
            realizedPnlUsd: Number(p.realizedPnlUsd) || 0,
            realizedPnlSol: Number(p.realizedPnlSol) || 0,
            lastPriceAt: null,
            exitInFlight: false,
          }));
      }

      if (Array.isArray(raw.history)) {
        this.history = raw.history.slice(0, HISTORY_LIMIT);
      }

      console.log(`[CopyTrader] Restored ${this.wallets.size} tracked wallet(s), ${this.positions.length} open position(s) from ${STATE_FILE}`);
    } catch (err: any) {
      console.warn(`[CopyTrader] Could not read ${STATE_FILE}: ${err.message}`);
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      try { listener(); } catch { /* dead SSE socket */ }
    }
  }
}

// ---------------- MODULE HELPERS ----------------

function shortAddr(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

function fmtPrice(priceSol: number): string {
  if (!isFinite(priceSol) || priceSol <= 0) return '—';
  return priceSol < 0.000001 ? priceSol.toExponential(2) : priceSol.toFixed(9);
}

/** Clamp every numeric field into a sane range; drop unknown keys. */
function sanitizeConfig(partial: Partial<CopyTraderConfig>): Partial<CopyTraderConfig> {
  const out: Partial<CopyTraderConfig> = {};
  if (typeof partial.enabled === 'boolean') out.enabled = partial.enabled;
  if (partial.tradingMode === 'paper' || partial.tradingMode === 'real') out.tradingMode = partial.tradingMode;
  if (partial.buySizeMode === 'fixed' || partial.buySizeMode === 'proportional') out.buySizeMode = partial.buySizeMode;
  if (isFiniteNum(partial.fixedBuySol)) out.fixedBuySol = clamp(partial.fixedBuySol!, 0.001, 100);
  if (isFiniteNum(partial.proportionalPct)) out.proportionalPct = clamp(partial.proportionalPct!, 1, 200);
  if (isFiniteNum(partial.maxBuySol)) out.maxBuySol = clamp(partial.maxBuySol!, 0.001, 100);
  if (isFiniteNum(partial.minLeaderBuySol)) out.minLeaderBuySol = clamp(partial.minLeaderBuySol!, 0, 100);
  if (typeof partial.copySells === 'boolean') out.copySells = partial.copySells;
  if (partial.sellMode === 'mirror' || partial.sellMode === 'full') out.sellMode = partial.sellMode;
  if (typeof partial.mirrorLeaderTokenMoves === 'boolean') out.mirrorLeaderTokenMoves = partial.mirrorLeaderTokenMoves;
  if (isFiniteNum(partial.maxOpenPositions)) out.maxOpenPositions = Math.round(clamp(partial.maxOpenPositions!, 1, 50));
  if (isFiniteNum(partial.maxSlippagePct)) out.maxSlippagePct = clamp(partial.maxSlippagePct!, 1, 100);
  if (typeof partial.blockRepeatBuys === 'boolean') out.blockRepeatBuys = partial.blockRepeatBuys;
  if (isFiniteNum(partial.perWalletCooldownSec)) out.perWalletCooldownSec = clamp(partial.perWalletCooldownSec!, 0, 86400);
  if (isFiniteNum(partial.maxHoldSeconds)) out.maxHoldSeconds = clamp(partial.maxHoldSeconds!, 0, 86400);
  if (isFiniteNum(partial.takeProfitPct)) out.takeProfitPct = clamp(partial.takeProfitPct!, 0, 100000);
  if (isFiniteNum(partial.feedAutoClearMinutes)) out.feedAutoClearMinutes = Math.round(clamp(partial.feedAutoClearMinutes!, 0, 10080));
  return out;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const copyTrader = new CopyTraderService();
