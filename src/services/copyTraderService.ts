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
import { rpcEndpoint, rpcWsEndpoint, connectionConfig, isRateLimitError, isFallbackEndpoint } from './rpcHealth';
import { tradeGovernor } from './tradeGovernor';
import { affordableStakeSol, sellAmountParam, splitWalletIntoSlots } from './pipelineUtils';
import { breakevenPct } from './paperSimulator';
import { installPath } from './installPaths';
import { appendBotLog } from './fileLogger';
import { DexScreenerService } from './dexscreenerService';
import { attachKeepalive, reconnectDelayMs, KeepaliveHandle } from './wsKeepalive';
import { WalletLogWatcher, type WalletLogEvent } from './walletLogWatcher';
import { tradeEventsFromLogs, tradeEventPriceSol, PUMP_TOKEN_DECIMALS, PumpTradeEvent } from './pumpEventDecoder';
import { bondingCurvePda } from './curveWatcher';
import {
  detectVenue, classifyFlow, netSolFlowSol, paperExitPrice, isCopyableMint, resolveBuyPool, sawSwapProgram } from './leaderTxClassifier';
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
/**
 * How often the open book is re-checked against the wallet's real balances.
 *
 * 90s: slow enough that a full book costs a trivial number of RPC reads, fast
 * enough that a position which does not match the chain — a drifted quantity, a
 * bag that was never actually bought, a bag sold elsewhere — is caught within a
 * couple of minutes instead of never.
 */
const POSITION_SYNC_INTERVAL_MS = 90_000;
/**
 * A position must be at least this old before the chain is allowed to
 * contradict it. A token account can lag a landed buy by several seconds; a
 * fresh position reading zero is propagation delay, not an absent bag, and
 * acting on it would delete real positions seconds after opening them.
 */
const POSITION_SYNC_MIN_AGE_MS = 60_000;
/** How often the resolved RPC endpoint is re-checked for drift. */
const ENDPOINT_DRIFT_CHECK_MS = 20_000;
/**
 * Concurrent fast-lane verifications allowed at once.
 *
 * Each is an unawaited poll loop, and an unawaited loop PER EVENT is exactly
 * how a diagnostic becomes the 429 storm it exists to diagnose: a 2400 tx/min
 * leader would have started ~800 of them, polling several hundred times a
 * second between them. It is anchored to real copy BUYS (bounded by the spend
 * governor) rather than to notifications, and capped here as well.
 */
const MAX_FAST_VERIFY_IN_FLIGHT = 4;

/** Host of a URL, for log lines. Never throws on a malformed value. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
const PROCESSED_SIG_LIMIT = 3000;

/**
 * Polling budget for reading a leader transaction after its 'processed' log.
 * `getTransaction` only answers at 'confirmed', which typically lands 0.4–1s
 * behind 'processed'.
 */
const TX_FETCH_DEADLINE_MS = 8000;
const TX_FETCH_INTERVAL_MS = 250;
/**
 * Tuning for the learned processed→confirmed wait. See estimatedConfirmWaitMs.
 *
 * The fractions are below 1 on purpose: sleeping the full estimate means the
 * first read lands exactly when the transaction becomes available on average,
 * which is a coin flip. Waking a little early costs one wasted call; waking
 * late costs latency on every single trade this lane handles.
 */
const CONFIRM_WAIT_ALPHA = 0.2;
const CONFIRM_WAIT_FRACTION = 0.8;
/** A live exit is worth one more speculative read than an entry is. */
const CONFIRM_WAIT_PRIORITY_FRACTION = 0.6;
const CONFIRM_WAIT_MIN_MS = 80;
const CONFIRM_WAIT_MAX_MS = 800;
/** One paced re-read of a leader tx that outlived the polling budget — long enough for an RPC 429 storm to pass. */
const TX_REFETCH_DELAY_MS = 20_000;
/**
 * Oldest a leader BUY signal may be and still be worth copying.
 *
 * The retry path can surface a buy ~28s after it happened
 * (TX_FETCH_DEADLINE_MS + TX_REFETCH_DELAY_MS), which on these tokens is an
 * eternity — the leader may already be out. Entering there is not copying the
 * leader, it is buying their exit liquidity.
 *
 * SELLS are deliberately NOT aged out: a late exit still gets us out, and
 * refusing one would strand the bag.
 */
const MAX_BUY_SIGNAL_AGE_MS = 15_000;
/**
 * How long UI change notifications are collected before one push goes out.
 *
 * Sits just below the server's own SSE_MIN_GAP_MS (25ms) so this never becomes
 * the binding constraint on how fresh the dashboard is — it exists to keep the
 * full-status rebuild off the notification handler's stack, not to slow the UI.
 */
const COPY_EMIT_COALESCE_MS = 25;
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

/**
 * What one exit ACTUALLY needs, given the fee the operator configured.
 *
 * The flat 0.002 above was measured against the default 0.001 priority fee. It
 * is not a constant of nature: `priorityFeeSol` is an operator setting and
 * `maxPriorityFeeSol` (with dynamic fees on) reaches 0.05. Reserving 0.002 per
 * position while each exit intends to spend up to 0.05 means the reserve is
 * short by more than an order of magnitude — the buys are allowed to consume
 * everything else, and when the leader dumps every mint at once,
 * affordableSellPriorityFeeSol clamps each exit's fee down to dust and the
 * sells miss the dump they were supposed to front-run.
 *
 * Scaled from the fee that will actually be paid, with the old flat value as a
 * floor so this can only ever reserve MORE, never less.
 */
function copyExitGasReserveSol(sizingPriorityFeeSol: number): number {
  const fee = Number.isFinite(sizingPriorityFeeSol) && sizingPriorityFeeSol > 0 ? sizingPriorityFeeSol : 0.001;
  // The priority fee, the base signature fee, and a little headroom so the fee
  // payer is still rent-exempt afterwards.
  return Math.max(COPY_EXIT_GAS_RESERVE_SOL, round4(fee + 0.0006));
}

/**
 * Ceiling on the slippage a copy BUY will accept. maxSlippagePct is clamped to
 * 1..100 for config, but a buy at 100% accepts paying double — a footgun on an
 * entry we can simply decline. Sells stay at the full configured tolerance
 * (copySellSlippagePct): exiting a bag we already hold is worth more slippage
 * than opening a new one.
 */
const COPY_BUY_MAX_SLIPPAGE_PCT = 30;

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
   * When the leader's transaction was FIRST OBSERVED, not when this signal
   * object was built. The two diverge on the retry path: a transaction the RPC
   * could not serve within TX_FETCH_DEADLINE_MS is re-read
   * TX_REFETCH_DELAY_MS later, so a signal can be produced ~28s after the
   * leader actually traded — long enough for them to have dumped the token
   * already. Carried through so onLeaderBuy can refuse to chase a stale entry.
   */
  observedAt?: number;
  /**
   * 'transfer' = tokens moved with no SOL against them (airdrop, dust, a bag
   * moved between the leader's own wallets). Surfaced in the feed, never
   * copied — treating these as trades bought airdrops and sold positions the
   * leader had only moved.
   */
  kind?: 'trade' | 'transfer';
  /** Decoded from the log lines at 'processed' — no transaction fetch stood between the leader and our order. */
  fast?: boolean;
  /**
   * The slot the leader's transaction was observed in.
   *
   * The unit that actually decides the fill price. Milliseconds are what an
   * engineer tunes, but the curve only moves when a block is produced, so
   * landing 300ms later in the SAME slot costs nothing while landing 60ms later
   * across a slot boundary costs a whole candle. Carried from the
   * logsNotification's `context.slot` so slotDelta can score every fill against
   * it. See src/services/slotDelta.ts.
   */
  leaderSlot?: number;
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
  // SPLIT by default: a small wallet following a leader who takes many trades
  // must get a slice per trade. The old default staked a flat 0.05 SOL, which
  // is HALF of a 0.1 SOL wallet on the first copy and the whole wallet by the
  // second. Split divides the wallet across maxOpenPositions instead.
  buySizeMode: 'split',
  fixedBuySol: 0.05,
  proportionalPct: 10,
  maxBuySol: 0.5,
  // 0 = copy EVERY buy, which is the whole point of a wallet copier. Raise it
  // only to deliberately ignore the leader's dust.
  minLeaderBuySol: 0,
  // Don't make dust buys. Below this, our computed size is skipped rather than
  // bought — a sub-0.01 SOL entry loses the round-trip fee before it can move.
  // Split sizing across many slots on a small wallet is exactly what produces
  // these; this stops them without forcing the operator to shrink the book.
  minCopyBuySol: 0.01,
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
  // Also the SPLIT divisor: the wallet is cut this many ways. 5 rather than 10
  // because fixed round-trip costs (ATA rent ~0.002 + fees) do not shrink with
  // the slice — on a 0.1 SOL wallet, 10 slots is ~0.01 a trade and the
  // breakeven is worse than 30%. Raise it only as the wallet grows; the feed
  // prints the per-slot breakeven so the number is never a surprise.
  maxOpenPositions: 5,
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
  /**
   * The RESOLVED endpoint URL currently in use. Tracked separately from the key
   * because a rejected key changes the endpoint without changing the key.
   */
  private heliusEndpointInUse: string | null = null;
  /** Latches the no-key warning so it is stated once per start, not per poll. */
  private warnedNoHeliusKey = false;
  /** Our own logsSubscribe socket — see WalletLogWatcher for why not Connection.onLogs. */
  private logWatcher: WalletLogWatcher | null = null;
  /** Signatures whose transaction is being fetched right now ('processed' logs can repeat). */
  private analyzingSigs = new Set<string>();
  /** Coalesced reconcile: newest unreconciled signature per leader, and the single armed timer. */
  private reconcilePending = new Map<string, string>();
  private reconcileTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Running tally of each leader's token balance per mint (`address:mint`),
   * so a pump.fun SELL decoded from the log lines can be sized as a fraction
   * of their bag without waiting for the transaction. Reconciled against the
   * chain's own balances as soon as each transaction is readable.
   */
  private leaderBalances = new Map<string, number>();
  /** Slot of the last update applied per `${leader}:${mint}` — a late reconcile
   * for an OLDER slot must not clobber a newer balance and mis-size the next
   * mirror sell (copy-correctness-3). */
  private leaderBalanceSlot = new Map<string, number>();
  private static readonly MAX_LEADER_BALANCE_KEYS = 500;

  /**
   * Apply a leader balance, but only if `slot` is at least as new as the last
   * update for that key. A zero balance is dropped (the account emptied) rather
   * than kept forever. Bounds the map so a long run cannot grow it without limit
   * (copy-correctness-7).
   */
  private setLeaderBalance(key: string, value: number, slot: number): void {
    const lastSlot = this.leaderBalanceSlot.get(key) ?? -1;
    if (slot < lastSlot) return; // a stale reconcile — ignore
    this.leaderBalanceSlot.set(key, slot);
    if (value <= 0) {
      this.leaderBalances.delete(key);
      this.leaderBalanceSlot.delete(key);
      return;
    }
    this.leaderBalances.set(key, value);
    if (this.leaderBalances.size > CopyTraderService.MAX_LEADER_BALANCE_KEYS) {
      // Evict the oldest-tracked key (Maps preserve insertion order).
      const oldest = this.leaderBalances.keys().next().value;
      if (oldest !== undefined) { this.leaderBalances.delete(oldest); this.leaderBalanceSlot.delete(oldest); }
    }
  }

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
  /**
   * Concurrent confirmed-fetch cap. A real Helius key comfortably serves ~5 in
   * flight; the public/fallback endpoint does not, so it stays at 2. The value
   * backs OFF toward 2 when the poll loop hits repeated 429s and recovers when
   * the key goes quiet, so a rate-limited key is not hammered (adjusted in
   * fetchParsedTx / on 429).
   */
  private maxConcurrentTxFetch = 2;
  private txFetch429Streak = 0;

  /** Real Helius key -> 5, fallback/public -> 2. Called when the key changes. */
  private refreshFetchConcurrency(): void {
    this.maxConcurrentTxFetch = isFallbackEndpoint(this.heliusKeyInUse) ? 2 : 5;
  }
  /** Live trade-classification fetches (an entry/exit is riding on them) jump ahead of
   * fire-and-forget reconcile bookkeeping so they are never head-of-line-blocked (perf-latency-4). */
  private txFetchPriorityQueue: Array<() => void> = [];
  private txFetchNormalQueue: Array<() => void> = [];
  /** Priority fetches waiting OR in flight — reconcile yields entirely while any is outstanding. */
  private priorityFetchOutstanding = 0;
  /** Throttle feed congestion warnings per leader wallet to avoid spamming the UI feed. */
  private lastFeedWarnAt = new Map<string, number>();
  /** Throttle the "this slice is uneconomic" warning — it would otherwise fire on every copy. */
  private lastBreakevenWarnAt = 0;

  private async acquireTxFetchSlot(priority = false): Promise<() => void> {
    if (priority) this.priorityFetchOutstanding++;
    while (this.txFetchInFlight >= this.maxConcurrentTxFetch) {
      await new Promise<void>((resolve) =>
        (priority ? this.txFetchPriorityQueue : this.txFetchNormalQueue).push(resolve));
    }
    this.txFetchInFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.txFetchInFlight--;
      if (priority) this.priorityFetchOutstanding = Math.max(0, this.priorityFetchOutstanding - 1);
      // Priority waiters are always served before normal ones.
      const next = this.txFetchPriorityQueue.shift() ?? this.txFetchNormalQueue.shift();
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
    // Synthetic dismiss / external-exit legs are not real sells — excluding them
    // keeps the win rate honest (quality-tests-4).
    const sells = this.history.filter(h => h.side === 'sell' && !h.dismissed);
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
      slotDelta: sniperEngine.getSlotDeltaStats(),
    };
  }

  public setEnabled(enabled: boolean): { ok: boolean; error?: string } {
    if (enabled && this.config.tradingMode === 'real') {
      const blockers = sniperEngine.getWalletStatus().blockers;
      if (blockers.length) {
        return { ok: false, error: `Cannot arm REAL copy trading: ${blockers.join(' ')}` };
      }
      // ONE LIVE INSTANCE PER WALLET — copy trading included.
      //
      // This check existed only in sniperEngine.toggleBot. Copy trading arms
      // through here and never asked for the lock, so a second instance could
      // arm REAL copy trading while the first was already live on the same key.
      // Both then copied the same leader, doubling every order and sizing
      // against a balance the other was already spending.
      const lock = sniperEngine.acquireRealLockForCopy();
      if (!lock.ok) {
        return { ok: false, error: `Cannot arm REAL copy trading: ${lock.message}` };
      }
    }
    this.config.enabled = enabled;
    if (enabled) {
      this.startSignalFeeds();
    } else {
      this.stopSignalFeeds();
      // Reference-counted: this drops only the copy trader's claim, so a
      // running sniper keeps the lock.
      sniperEngine.releaseRealLockForCopy();
    }
    this.persist();
    this.emitChange();
    return { ok: true };
  }

  public updateConfig(partial: Partial<CopyTraderConfig>): { ok: boolean; error?: string } {
    const next = { ...this.config, ...sanitizeConfig(partial) };

    // ARMING PREFLIGHT — on the RESULTING state, not on the transition.
    //
    // The old condition also required `this.config.tradingMode !== 'real'`, so
    // it only fired on a paper -> real switch. A restart leaves tradingMode
    // 'real' on disk with enabled forced false, so re-enabling from that state
    // was already "real -> real" and skipped the preflight entirely: no blocker
    // check, and — once the lock was added — no lock either. Any client that
    // POSTs `{enabled: true}` to the config endpoint took that path.
    //
    // Now the question is simply "will this config be live in real mode", which
    // is the question that actually matters.
    const willBeLiveReal = next.tradingMode === 'real' && next.enabled;
    const isLiveReal = this.config.tradingMode === 'real' && this.config.enabled;
    if (willBeLiveReal && !isLiveReal) {
      const blockers = sniperEngine.getWalletStatus().blockers;
      if (blockers.length) {
        return { ok: false, error: `Cannot switch to REAL mode: ${blockers.join(' ')}` };
      }
      const lock = sniperEngine.acquireRealLockForCopy();
      if (!lock.ok) {
        return { ok: false, error: `Cannot arm REAL copy trading: ${lock.message}` };
      }
    }

    const enabledChanged = next.enabled !== this.config.enabled;
    this.config = next;
    if (enabledChanged) {
      if (next.enabled) this.startSignalFeeds();
      else this.stopSignalFeeds();
    }
    // Going off live-real (disabled, or switched to paper) hands the lock back
    // so another instance can arm. Reference-counted, so a running sniper keeps
    // holding it.
    if (isLiveReal && !willBeLiveReal) sniperEngine.releaseRealLockForCopy();
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

    // NEVER track our own signer. The watcher fires on any transaction the
    // address appears in — including the copy trader's OWN buys — so tracking
    // the trading wallet makes every copy a fresh "leader buy" that gets copied
    // again. It is a self-feeding loop with no upstream limiter: one leader
    // signal becomes an unbounded chain of buys, each carving another slice off
    // the wallet, and every one of them looks legitimate in the feed.
    //
    // Easy to do by accident: the trading wallet's address is on screen in the
    // dashboard, one panel away from the "add a wallet to copy" box.
    const own = (sniperEngine.getWalletStatus().address || '').trim();
    if (own && own === trimmed) {
      return {
        ok: false,
        error: 'That is this bot\'s own trading wallet. Tracking it would make the bot copy its own buys in a loop — refused.',
      };
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

  /**
   * Reconcile every open copy position against the wallet's real on-chain token
   * balance (from the v1.1.0 lineage's sync-balances action, rebuilt on master's
   * model). Closes positions whose bag is genuinely gone — sold manually on
   * Photon/Dex, or dust-swept — and corrects tokensHeld where the chain and our
   * record disagree.
   *
   * Only ever closes on POSITIVE evidence of an empty wallet: a null read (RPC
   * down) leaves the position untouched, because "cannot see it" is not "it is
   * gone". Paper positions are skipped — they have no on-chain balance to read.
   */
  public async syncPositionsWithOnChainBalances(): Promise<{ checked: number; closed: number; corrected: number; unreadable: number }> {
    // Now runs automatically on a timer as well as from the button, so it has
    // to be safe against work that is still settling. Three exclusions, each
    // covering a way an honest read can be MISLEADING rather than wrong:
    //
    //  - exitInFlight: a sell mid-settlement has already moved part of the bag.
    //    Correcting to the interim balance would mis-size the rest of the exit,
    //    and reading it as empty would close a position that is still selling.
    //  - too young: the token account can lag a landed buy by seconds. A brand
    //    new position reading zero is propagation, not absence — and treating
    //    it as absence would delete a real position moments after opening it.
    //  - the trade queue busy on this mint: a buy or sell is running for it
    //    right now, so the balance is a moving target.
    const now = Date.now();
    const open = this.positions.filter(p =>
      p.status !== 'CLOSED'
      && !(p.buyTxid ?? '').startsWith('sim_')
      && !p.exitInFlight
      && now - (p.entryTime ?? 0) > POSITION_SYNC_MIN_AGE_MS
      && !this.tradeQueue.isBusy(p.mint));
    let closed = 0;
    let corrected = 0;
    // Counted and reported: a sync that could read nothing must not look like a
    // sync that found nothing wrong.
    let unreadable = 0;
    for (const pos of open) {
      // RE-CHECKED PER POSITION, immediately before acting on it.
      //
      // The exclusions above are a snapshot, and this loop awaits a balance
      // read per position — hundreds of milliseconds each, so a book of eight
      // spans seconds. A leader sell arriving mid-loop sets exitInFlight and
      // starts moving tokens for a position this loop is about to read, and the
      // interim balance would then be written back as the truth or read as
      // empty and the position closed while its exit was still running.
      // The cast is load-bearing: TypeScript narrowed `status` from the filter
      // above and would otherwise call these comparisons impossible — but the
      // whole point is that another task can change it while this loop awaits.
      const busy = (): boolean =>
        (pos.status as string) === 'CLOSED' || Boolean(pos.exitInFlight) || this.tradeQueue.isBusy(pos.mint);
      if (busy()) continue;
      const held = await this.getOwnedTokenAmount(pos.mint);
      // And again after the await, for the same reason.
      if (busy()) continue;
      if (held === null) { unreadable++; continue; } // unreadable — never treat as zero
      const expected = pos.tokensHeld || 0;
      if (held <= Math.max(0, expected * 0.05)) {
        this.closeAsExternallyExited(pos);
        closed++;
      } else if (expected > 0 && Math.abs(held - expected) / expected > 0.05) {
        // The chain is the truth; a drifted record would mis-size the next sell.
        pos.tokensHeld = held;
        corrected++;
      }
    }
    if (closed || corrected) {
      this.persist();
      this.emitChange();
    }
    console.log(`[CopyTrader] Balance sync: ${open.length} checked, ${closed} closed as externally exited, `
      + `${corrected} quantity-corrected, ${unreadable} unreadable (left untouched).`);
    return { checked: open.length, closed, corrected, unreadable };
  }

  /**
   * Alias kept for the v1.1.0 lineage's DISCARD action. It routes to
   * forceClosePosition rather than main's bare removal, so the on-chain balance
   * check and the "you still hold this" warning still apply.
   */
  public async discardPosition(positionId: string): Promise<boolean> {
    return this.forceClosePosition(positionId, 'Discarded by operator');
  }

  public async forceClosePosition(positionId: string, reason = 'Liquidated / dismissed by operator'): Promise<boolean> {
    const pos = this.positions.find(p => p.id === positionId && p.status !== 'CLOSED');
    if (!pos) return false;
    const isReal = !(pos.buyTxid ?? '').startsWith('sim_');
    // The ✕ dismiss means "I already sold this elsewhere". Respect that explicit
    // override, but if the wallet still holds a substantial bag, say so loudly —
    // dismissing a bag that is really still there strands it (copy-correctness-4).
    if (isReal) {
      const held = await this.getOwnedTokenAmount(pos.mint);
      if (held !== null && held > Math.max(0, (pos.tokensHeld || 0) * 0.05)) {
        const wallet = this.wallets.get(pos.leaderWallet) ?? this.standInWallet(pos);
        this.pushFeed(wallet, { mint: pos.mint, side: 'sell', solAmount: 0, tokenAmount: 0, symbol: pos.tokenSymbol, via: 'manual' }, 'failed',
          `⚠️ Dismissing $${pos.tokenSymbol} but the wallet STILL holds ~${held} tokens on-chain — if you have not sold it elsewhere, use LIQUIDATE instead. Dismissed as requested.`);
      }
    }
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
      dismissed: true,
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

  /**
   * Re-read the API keys and rebuild the feeds on them.
   *
   * Called when the operator saves a key in Settings. Without it, a key added
   * after boot changed only the sniper's connection: the copy trader kept the
   * key it resolved at start — usually none — so the on-chain watcher stayed
   * down for the rest of the session while the UI reported a healthy engine.
   * That is a leader whose every trade is invisible, with nothing in the feed
   * to say so. A no-op unless copy trading is armed; restartSignalFeeds()
   * already returns early when it is not.
   */
  public onApiKeysChanged(): void {
    this.restartSignalFeeds();
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

    // Rebuild both the HTTP connection and the socket when the ENDPOINT changes
    // — not merely when the operator edits the key.
    //
    // The old condition compared the key string, so a key that was REJECTED
    // (401, quota exhausted) never triggered a rebuild: the key text is
    // unchanged, while resolveRpcEndpoint has since demoted every caller to the
    // public endpoint. The sniper recovered because it rebinds on the resolved
    // URL; the copy trader stayed pinned to the dead Helius endpoint, so every
    // getParsedTransaction threw, every slow-lane leader signal came back
    // 'fetch_failed', and leader sells were dropped — a copy trader that looked
    // connected and mirrored nothing.
    const endpoint = rpcEndpoint(key);
    if (!this.heliusConn || this.heliusEndpointInUse !== endpoint) {
      if (this.heliusEndpointInUse && this.heliusEndpointInUse !== endpoint) {
        console.warn(`[CopyTrader] RPC endpoint changed (${hostOf(this.heliusEndpointInUse)} → ${hostOf(endpoint)}) — rebuilding the connection and the leader watcher.`);
      }
      this.stopHeliusWatcher();
      this.heliusConn = new Connection(endpoint, connectionConfig());
      this.heliusKeyInUse = key;
      this.heliusEndpointInUse = endpoint;
      this.refreshFetchConcurrency();
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
          // Reuse the decode from just above — do not decode the same log lines twice.
          if (this.handleFastLog(ev, allEvents)) return;
          void this.handleWalletLog(ev.address, ev.signature, false, Date.now(), ev.slot);
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

  private async handleWalletLog(leaderAddress: string, signature: string, isRetry = false, observedAt = Date.now(), leaderSlot = 0): Promise<void> {
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
          // The ORIGINAL observation time is carried into the retry — the age
          // that matters is how long ago the leader traded, not how long ago
          // we last tried to read it.
          void this.handleWalletLog(leaderAddress, signature, true, observedAt, leaderSlot);
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
          if (key.startsWith(`${leaderAddress}:`)) { this.leaderBalances.delete(key); this.leaderBalanceSlot.delete(key); }
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
      // Stamp the ORIGINAL observation time so onLeaderBuy can tell how long
      // ago the leader actually traded, not how long ago we managed to read it.
      sig.observedAt = observedAt;
      // The slot is the notification's, not the fetched transaction's: both
      // name the block the leader landed in, and this one is already in hand.
      if (leaderSlot > 0 && sig.leaderSlot === undefined) sig.leaderSlot = leaderSlot;
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
  private handleFastLog(ev: WalletLogEvent, allEvents: PumpTradeEvent[]): boolean {
    const wallet = this.wallets.get(ev.address);
    if (!wallet || !wallet.enabled || !this.config.enabled) return false;

    const events = allEvents.filter(e => e.user === ev.address);
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
        // ONLY when we already have a real tally for this leader+mint.
        //
        // `(tracked ?? 0) + tokens` treated a first sighting as "they now hold
        // exactly what they just bought", which is only true if they held none
        // before. A leader who already owned 900k of the mint — bought before
        // the bot was armed, or through a venue the pump-log fast lane cannot
        // decode — buys 100k more and the tally reads 100k instead of 1,000,000.
        //
        // Mirror mode then sizes the next partial sell off that number: the
        // leader disposes of 100k (11% of their bag) and
        // `remainingTokens = 100k - 100k = 0` makes leaderSellFraction return
        // 1.0, so we exit 100% of OUR position on an 11% leader trim.
        //
        // Leaving it undefined is the honest state and already has a safe path:
        // the mirror branch below bails to the analysis lane, which sizes from
        // the chain's real balances, and scheduleReconcile fills the tally in
        // from the chain shortly after. The coalescing in 7c5f25e made the
        // fabricated value more likely to persist, but the fabrication is the
        // defect.
        if (tracked !== undefined) tallyUpdates.push([key, tracked + tokens]);
      } else if (this.config.sellMode === 'full') {
        // Full mode sells 100% of OUR bag on any leader sell, so it never needs
        // the leader's post-trade balance — forcing the slow confirmed-fetch
        // here just to compute a fraction it then discards cost ~0.4-1s on
        // every exit. Leave remainingTokens undefined (onLeaderSell forces
        // fraction=1); update the tally only when we already have a real one,
        // and never plant a fabricated 0 (that would over-exit a later
        // mode switch before reconcile lands).
        if (tracked !== undefined) tallyUpdates.push([key, Math.max(0, tracked - tokens)]);
      } else {
        // Mirror mode needs the leader's post-trade balance to size a PARTIAL
        // sell, and the event does not carry it. Our running tally is exact
        // once a transaction has been reconciled against the chain; until
        // then — the first sell of a bag we never saw them buy, or one larger
        // than we tracked — the analysis path sizes it from the real balances.
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
        leaderSlot: ev.slot || undefined,
        // SET ON THE FAST LANE TOO. Only the slow lane stamped this, so every
        // fast signal reported an age of 0 — including one that had been
        // sitting in the per-mint trade queue behind a settling buy, which can
        // hold it for up to 75 seconds. The staleness guard that exists to stop
        // us chasing a trade the leader has already left could therefore never
        // fire on the lane that produces most orders.
        observedAt: Date.now(),
      });
    }
    for (const [key, value] of tallyUpdates) this.setLeaderBalance(key, value, ev.slot);

    this.markSigProcessed(ev.signature);
    // Keep the tally honest against the chain without slowing the order: once
    // the transaction is readable, the leader's real post-trade balances
    // replace whatever was inferred here.
    this.scheduleReconcile(ev.address, ev.signature);
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
        // PER-LEG, because this whole block used to be one uncaught async IIFE.
        // A leader transaction can carry several legs (a token→token rotation
        // decodes to two), and markSigProcessed has ALREADY claimed the
        // signature — so a throw on leg 1 silently dropped every remaining leg
        // and the slow lane could never re-read it. On a rotation that means
        // the SELL is mirrored and the BUY is lost, or worse the reverse: we
        // buy and never learn they were leaving.
        try {
          await this.handleLeaderSignal(wallet, sig);
        } catch (err: any) {
          this.pushFeed(wallet, sig, 'failed',
            `Error handling the leader's ${sig.side} of $${this.symbolFor(sig)}: ${err?.message ?? err}. `
            + 'The other legs of this transaction were still processed.');
          console.error(`[CopyTrader] handleLeaderSignal threw for ${sig.mint}:`, err);
        }
      }
    })();
    return true;
  }

  /**
   * Did the leader's transaction — the one we already copied, buy OR sell —
   * actually land?
   *
   * THE TRADE-OFF THIS MANAGES. The fast lane subscribes at commitment
   * 'processed', which is the whole reason it is fast: a node has EXECUTED the
   * transaction but nothing has voted on it yet, so we learn about the trade
   * ~0.5-1.2s before it is readable at 'confirmed'. A processed transaction can
   * still be dropped or lost on a fork, and when that happens the leader never
   * traded at all — while we have already sent a real buy against it. That is a
   * "random buy" with a completely innocent-looking feed line behind it.
   *
   * Waiting for 'confirmed' before copying would remove the risk and remove the
   * product with it. So the order still goes at 'processed', and the leader's
   * signature is checked afterwards: it costs nothing on the hot path, and it
   * turns a silent bad copy into a named one the operator can act on.
   *
   * A signature seen at 'processed' that still has NO status after this window
   * did not land — a real one confirms in a second or two.
   */
  private fastVerifyInFlight = 0;

  private verifyFastSignal(wallet: TrackedWalletInternal, sig: LeaderSignal): void {
    const conn = this.heliusConn;
    const signature = sig.signature;
    if (!conn || !signature) return;

    // HARD BOUND. Called once per real copy BUY, which the governor already
    // limits — but a ceiling here as well, because an unawaited poll loop per
    // event is exactly the shape that turns a diagnostic into the 429 storm it
    // was meant to diagnose. Dropping a verification is a lost warning; running
    // hundreds of them is a broken bot.
    if (this.fastVerifyInFlight >= MAX_FAST_VERIFY_IN_FLIGHT) return;
    this.fastVerifyInFlight++;

    const started = Date.now();
    const WINDOW_MS = 20_000;

    const poll = async (): Promise<void> => {
      try {
        while (Date.now() - started < WINDOW_MS) {
          try {
            const res = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
            const v = res?.value?.[0];
            if (v) {
              if (v.err) {
                this.warnFastSignalLost(wallet, sig, signature, `it FAILED on-chain (${JSON.stringify(v.err)})`);
                return;
              }
              if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') return; // healthy
            }
          } catch { /* transient — keep polling inside the window */ }
          await sleep(2500);
        }
        this.warnFastSignalLost(wallet, sig, signature,
          `it never reached a confirmed status within ${WINDOW_MS / 1000}s — it was most likely dropped`);
      } finally {
        this.fastVerifyInFlight--;
      }
    };
    void poll();
  }

  private warnFastSignalLost(
    wallet: TrackedWalletInternal,
    sig: LeaderSignal,
    signature: string,
    why: string
  ): void {
    const held = this.positions.find(p => p.mint === sig.mint && p.status !== 'CLOSED');
    // A false SELL signal is the more expensive of the two: we have already
    // dumped a real bag on the strength of it, and the leader may still be in.
    const consequence = sig.side === 'sell'
      ? `We already SOLD $${this.symbolFor(sig)} on the strength of it — the leader may still be holding. `
      : (held
        ? `We are holding $${this.symbolFor(sig)} on a trade the leader may never have made. Review it. `
        : 'Nothing is open for it. ');
    this.pushFeed(wallet, sig, 'failed',
      `⚠️ The leader transaction this copy was based on did not survive — ${why}. ${consequence}`
      + `https://solscan.io/tx/${signature}`);
    this.emitChange();
  }

  /**
   * Coalesce reconcile per leader. Reconcile is pure bookkeeping — it confirms
   * the arithmetic tally against the chain — so a high-volume (arb-bot) leader
   * firing one confirmed-fetch PER trade was the dominant residual RPC load and
   * a real 429 source (measured 2026-08-29). We only need the leader's LATEST
   * post-trade balance, so keep just the newest signature per leader and run a
   * single reconcile ~1s later, cancelling any older pending one. Cuts reconcile
   * fetch volume from once-per-trade to at most once-per-second per leader; the
   * slot-ordered recordLeaderBalances still ignores a stale late resolve.
   */
  private scheduleReconcile(leaderAddress: string, signature: string): void {
    this.reconcilePending.set(leaderAddress, signature);
    if (this.reconcileTimers.has(leaderAddress)) return;
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(leaderAddress);
      const sig = this.reconcilePending.get(leaderAddress);
      this.reconcilePending.delete(leaderAddress);
      if (sig) void this.reconcileLeaderBalances(leaderAddress, sig);
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    this.reconcileTimers.set(leaderAddress, timer);
  }

  private async reconcileLeaderBalances(leaderAddress: string, signature: string): Promise<void> {
    // Reconcile is bookkeeping; yield the fetch slots to any live trade
    // classification rather than head-of-line-block it (perf-latency-4).
    if (this.priorityFetchOutstanding > 0 || this.txFetchNormalQueue.length > 4) return;
    const parsed = await this.fetchParsedTx(signature, false);
    if (!parsed || !parsed.meta || parsed.meta.err) return;
    this.recordLeaderBalances(leaderAddress, parsed.meta.preTokenBalances, parsed.meta.postTokenBalances, parsed.slot ?? 0);
  }

  /**
   * The leader's post-transaction balance per mint, from the transaction's own
   * token balance lists. Applied slot-ordered: a reconcile that resolves late,
   * for a tx OLDER than a balance already recorded by the fast lane, is ignored
   * rather than allowed to overwrite the newer number (copy-correctness-3).
   */
  private recordLeaderBalances(
    leaderAddress: string,
    pre: TokenBalance[] | null | undefined,
    post: TokenBalance[] | null | undefined,
    slot: number
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
    for (const [mint, balance] of balances) this.setLeaderBalance(`${leaderAddress}:${mint}`, balance, slot);
  }

  /**
   * Read OUR wallet's current on-chain balance of `mint`, in UI (human) units,
   * summed across all token accounts for that mint. Returns null when it cannot
   * be determined (no connection, no wallet, RPC error) — callers MUST treat
   * null as "unknown", never as zero. Used to decide whether a bag a failed
   * sell left behind is actually gone before closing the position.
   */
  private async getOwnedTokenAmount(mint: string): Promise<number | null> {
    // ONE reader, and it is the engine's — which queries BOTH token programs
    // and distinguishes "holds none" from "could not ask". This method used to
    // run its own mint-filtered query through heliusConn, which does not
    // reliably enumerate a Token-2022 account: the automatic position sync
    // would then read a real Token-2022 bag as zero and close the position as
    // "externally exited", deleting a live position on the strength of having
    // asked the wrong program.
    return sniperEngine.readOwnedTokenAmount(mint);
  }

  /**
   * Poll for the leader's transaction until the RPC can serve it at
   * 'confirmed'. The log arrives at 'processed', so the first polls are
   * expected to miss; a thrown 429 or socket reset is a reason to wait, not
   * to give up — giving up here is a leader sell we never mirror. (The old
   * code made one fetch, one 700ms retry, and dropped the signal on any
   * exception.)
   */
  /**
   * Rolling estimate of how long after a 'processed' notification the same
   * transaction becomes readable at 'confirmed'. Seeded at the old hardcoded
   * guess so behaviour on the very first trade of a session is unchanged.
   */
  private confirmWaitEwmaMs = 350;

  private recordConfirmWait(observedMs: number): void {
    if (!Number.isFinite(observedMs) || observedMs <= 0) return;
    // Clamped before it enters the average: a read that took 8 seconds because
    // the key was rate-limited describes the KEY, not the chain, and letting it
    // into the estimate would make every later trade wait for a problem that
    // has since gone away.
    const sample = Math.min(observedMs, CONFIRM_WAIT_MAX_MS);
    this.confirmWaitEwmaMs = this.confirmWaitEwmaMs * (1 - CONFIRM_WAIT_ALPHA) + sample * CONFIRM_WAIT_ALPHA;
  }

  /**
   * What to sleep before the first read. Deliberately UNDER the estimate: being
   * early costs one wasted call, being late costs latency on every trade, and
   * only one of those two is the thing this lane is being judged on.
   */
  private estimatedConfirmWaitMs(priority: boolean): number {
    const base = this.confirmWaitEwmaMs * (priority ? CONFIRM_WAIT_PRIORITY_FRACTION : CONFIRM_WAIT_FRACTION);
    return Math.max(CONFIRM_WAIT_MIN_MS, Math.min(CONFIRM_WAIT_MAX_MS, Math.round(base)));
  }

  private async fetchParsedTx(signature: string, priority = false): Promise<ParsedTransactionWithMeta | null> {
    if (!this.heliusConn) return null;
    const release = await this.acquireTxFetchSlot(priority);
    try {
      const deadline = Date.now() + TX_FETCH_DEADLINE_MS;
      const startedAt = Date.now();

      // LEARN THE WAIT INSTEAD OF ASSUMING IT.
      //
      // This lane cannot be made fast the way the other one was. The
      // notification arrives at 'processed', but getParsedTransaction only
      // accepts a Finality — 'confirmed' or 'finalized', never 'processed' —
      // so there is no API by which the transaction can be read at the
      // commitment we already have it at. The processed→confirmed lag is a
      // floor imposed by the RPC surface, not by this code.
      //
      // What WAS wrong is that the wait before the first read was a hardcoded
      // 300/350ms guess, paid in full on every leader trade this lane handles —
      // and this lane handles every non-bonding-curve venue, so every pump-AMM,
      // Raydium and Jupiter buy the leader makes pays it. The real lag varies
      // with the network and, right now, is measured nowhere.
      //
      // So it is measured here, as an EWMA of how long the reads actually took,
      // and the pre-sleep becomes a slightly conservative fraction of that.
      // When the chain is quick this saves most of the fixed wait; when it is
      // slow the sleep grows and stops burning the shared key on reads that
      // cannot possibly succeed yet. Bounded at both ends so one anomalous
      // sample cannot pin it high or drop it to a busy-poll.
      await sleep(this.estimatedConfirmWaitMs(priority));
      let pollDelay = TX_FETCH_INTERVAL_MS;
      while (Date.now() < deadline) {
        try {
          const parsed = await this.heliusConn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (parsed) {
            this.recordConfirmWait(Date.now() - startedAt);
            return parsed;
          }
          // A live sell polls at a flat tight interval so each miss costs a
          // small bounded wait instead of the escalating 250→400→550→700
          // ladder — that backoff growth, not the pre-sleep, was the dominant
          // term delaying a slow-confirmed exit. Non-priority keeps the gentle
          // ramp to stay light on the shared key.
          await sleep(priority ? 200 : pollDelay);
          if (!priority) pollDelay = Math.min(1000, pollDelay + 150);
        } catch (err) {
          const is429 = isRateLimitError(err);
          if (is429) {
            // Repeated 429s mean the key is over budget — shrink the pool
            // toward the safe floor so we stop hammering it.
            if (++this.txFetch429Streak >= 3) {
              this.maxConcurrentTxFetch = Math.max(2, this.maxConcurrentTxFetch - 1);
              this.txFetch429Streak = 0;
            }
          } else {
            this.txFetch429Streak = 0;
          }
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
    // Priority fetch: an entry or exit is riding on this classification.
    const parsed = await this.fetchParsedTx(signature, true);
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
    this.recordLeaderBalances(leaderAddress, meta.preTokenBalances, meta.postTokenBalances, parsed.slot ?? 0);

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
    // Wider than `venueKnown`: did a swap demonstrably happen at all, on any
    // venue including ones we cannot execute on. Used only to classify a
    // token→token BUY leg as a trade rather than a transfer.
    const swapEvidence = sawSwapProgram(keys);

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
        kind: classifyFlow({ side: 'buy', tradeSol, venueKnown, isTokenSwap, swapEvidence }),
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

  /**
   * Total SOL claimed by copy buys currently in flight, across all mints. The
   * sniper shares this wallet and must subtract it when sizing its own entries,
   * or the two engines both size against the same balance and jointly overdraft
   * it (copy-correctness-5). The copy side already subtracts the sniper's
   * in-flight; this makes the accounting symmetric.
   */
  public getInFlightBuyReservedSol(): number {
    let sum = 0;
    for (const sol of this.inFlightBuySol.values()) sum += sol;
    return sum;
  }

  /**
   * How many copy buys are submitted and unresolved.
   */
  public getInFlightBuyCount(): number {
    return this.inFlightBuySol.size;
  }

  /**
   * Mints the copy trader holds or is in the middle of buying — the sniper must
   * not open a position in any of them.
   *
   * The mirror of copyTraderService's own `sniperEngine.getHeldMints()` check,
   * which existed on this side only. A PumpPortal sell is a PERCENTAGE of the
   * WALLET's balance of the mint, not of one bot's notion of its position, so
   * two engines holding the same mint means either one's exit moves part of the
   * other's bag: a sniper take-profit of '50%' on a shared mint sells half of
   * everything, and the copy trader's book still says its bag is intact.
   *
   * In-flight buys are included: a mint whose copy buy has not landed yet is
   * still a mint we are about to share.
   */
  public getHeldMints(): Set<string> {
    const mints = new Set<string>();
    for (const p of this.positions) {
      if (p.status !== 'CLOSED' && !(p.buyTxid ?? '').startsWith('sim_')) mints.add(p.mint);
    }
    for (const m of this.inFlightBuySol.keys()) mints.add(m);
    return mints;
  }

  /**
   * SPLIT sizing: one slice of the wallet per concurrent copy.
   *
   * `maxOpenPositions` is the divisor — it is already "how many copies do I
   * carry at once", so it is also "how many ways is the wallet cut". Dividing
   * by the FREE slots (not the total) keeps the stake stable as positions open:
   * 0.1 SOL over 5 slots stakes 0.02, and after that buy 0.08 over 4 free slots
   * still stakes 0.02. It is self-correcting rather than a budget carved once —
   * a position closing green raises the next stake, a red one lowers it, so the
   * wallet is never over-committed and never strands unused SOL.
   *
   * `deployableSol` must already have the exit-gas reserve and every in-flight
   * claim subtracted by the caller.
   *
   * The slot BUDGET is deployable/freeSlots, but the STAKE is smaller than the
   * budget: a buy also reserves its slippage headroom, ~1.5% protocol fees, the
   * priority fee and token-account rent. Staking the raw budget therefore eats
   * the next slot's money — measured, slices decayed 0.0186 → 0.0069 and the
   * last of five could not be funded at all. maxAffordableBuySol (via
   * splitWalletIntoSlots) backs those costs out, which is what makes the slice
   * hold steady across the whole set.
   */
  private splitStakeSol(
    deployableSol: number,
    openPositionCount: number,
    priorityFeeSol: number,
    isRepeatBuy = false
  ): number {
    const slots = Math.max(1, Math.floor(this.config.maxOpenPositions));
    const open = Math.max(0, openPositionCount);

    // THE WALLET-EMPTYING BUG (fixed 2026-08-30). This line used to read:
    //
    //     const freeSlots = Math.max(1, slots - Math.max(0, openPositionCount));
    //
    // and its comment called the floor "only a guard", on the reasoning that
    // the book cap is enforced separately. It is not enforced separately for a
    // REPEAT buy: onLeaderBuy skips the maxOpenPositions check entirely when a
    // position for the mint already exists (`if (!existing) { …cap check… }`),
    // because a repeat buy merges into that position instead of opening a new
    // one. So with the book full — open == slots, which is the normal steady
    // state of a bot that is working — a repeat buy arrived here with
    // openPositionCount == slots, the subtraction gave 0, the floor turned it
    // into 1, and splitWalletIntoSlots divided the deployable balance by ONE.
    //
    // One slot became the WHOLE WALLET. Every leader top-up on a mint we
    // already held staked everything that was left, and with blockRepeatBuys
    // defaulting to false there was nothing upstream to stop it repeating.
    //
    // THE FIX, in two parts.
    //
    // (a) A REPEAT (DCA) buy always divides by the FULL book. A top-up on a mint
    //     we already hold is not claiming a new slot — it is adding to a
    //     position that already has its slice — so "how many slots are free"
    //     is the wrong question for it, and it is the question whose answer
    //     went to 1 (via the floor) and handed over the wallet. Sizing a
    //     top-up at one full-book slice is bounded no matter how many times
    //     the leader scales in, which is what blockRepeatBuys=false needs in
    //     order to be a safe default.
    //
    // (b) A NEW position keeps the self-correcting free-slot divisor, which is
    //     the whole point of split sizing: 0.1 SOL over 5 free slots stakes
    //     0.02, and after that buy 0.08 over 4 free slots still stakes 0.02.
    //     Dividing a new entry by the full book instead would make each slice
    //     decay (0.02 → 0.016 → 0.0128 …) and strand most of the wallet — the
    //     exact defect the free-slot divisor was introduced to fix. The floor
    //     is gone: with the book full there are no free slots, and the only
    //     honest divisor left is the full book.
    const divisor = (isRepeatBuy || open >= slots) ? slots : slots - open;

    const { stakePerSlotSol } = splitWalletIntoSlots({
      deployableSol: Math.max(0, deployableSol),
      slots: divisor,
      maxSlippagePct: this.config.maxSlippagePct,
      priorityFeeSol,
    });

    // (c) NO SINGLE COPY TAKES MORE THAN THE PER-MINT CEILING.
    //
    // The divisor fix removed the whole-wallet case for a FULL book, but a NEW
    // entry with one free slot still divides by 1 — "the last slot gets what is
    // left", which is the design when the earlier slots were funded from the
    // same balance. It stops being reasonable the moment the balance GREW after
    // those slots were filled: four positions opened cheaply (restored from
    // disk, or opened when the wallet was smaller, or the operator just lowered
    // maxOpenPositions) and then a top-up, and the fifth copy takes most of the
    // wallet in one order.
    //
    // Bounded by the SAME fraction the spend governor enforces per mint, so
    // sizing agrees with the ceiling instead of proposing an order the governor
    // will refuse — a refusal the operator would read as the bot breaking.
    const perMintFraction = tradeGovernor.getLimits().maxWalletFractionPerMint;
    if (perMintFraction > 0) {
      const cap = Math.max(0, deployableSol) * perMintFraction;
      if (cap > 0 && stakePerSlotSol > cap) return round4(cap);
    }
    return stakePerSlotSol;
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

    // STALE SIGNAL. A buy the RPC could not serve in time is re-read 20s later,
    // so this can be the first sight of a trade that happened ~28s ago. On
    // these tokens the leader may already be out; entering now is not copying
    // them, it is buying their exit liquidity. Sells are never aged out — a
    // late exit still gets us out.
    const signalAgeMs = sig.observedAt ? Date.now() - sig.observedAt : 0;
    if (signalAgeMs > MAX_BUY_SIGNAL_AGE_MS) {
      return skip(`Leader buy signal is ${Math.round(signalAgeMs / 1000)}s old (max ${MAX_BUY_SIGNAL_AGE_MS / 1000}s) — the RPC was too slow to read it and the price has moved. Not chased.`);
    }

    // A user-set minimum must MEAN something. `!sig.isTokenSwap` used to let
    // every token->token leg past it, and those legs carry solAmount 0 — so a
    // leader who routes through another token bypassed the minimum entirely.
    // A swap we cannot size in SOL cannot be checked against a SOL minimum, so
    // when the operator has set one, it is skipped rather than waved through.
    if (this.config.minLeaderBuySol > 0) {
      if (sig.isTokenSwap && sig.solAmount <= 0) {
        return skip(`Leader's token→token swap carries no SOL size, so it cannot be checked against the ${this.config.minLeaderBuySol} SOL minimum — skipped. Set the minimum to 0 to copy these.`);
      }
      if (sig.solAmount < this.config.minLeaderBuySol) {
        return skip(`Leader buy ${sig.solAmount.toFixed(4)} SOL is below the ${this.config.minLeaderBuySol} SOL minimum.`);
      }
    }

    const existing = this.mergeablePositionFor(mint);
    if (existing && this.config.blockRepeatBuys) {
      return skip('Already holding this mint and repeat buys are blocked.');
    }

    if (!existing) {
      const openCount = this.openPositionsForCurrentMode().length;
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
    } else if (this.config.buySizeMode === 'split') {
      // Provisional only — real mode re-slices against a freshly read balance
      // inside the queue, where the exit-gas and in-flight reserves are known.
      const openNow = this.openPositionsForCurrentMode().length;
      const deployableSol = sniperEngine.getWalletStatus().deployableSol;
      // A leader top-up on a mint already held is a REPEAT buy — sized at one
      // full-book slice, never at whatever is left of the wallet.
      const stakeSol = this.splitStakeSol(
        deployableSol, openNow, sniperEngine.getSizingPriorityFeeSol(),
        Boolean(this.mergeablePositionFor(mint))
      );
      // Paper must not need a funded wallet. Split sizing returns 0 both with
      // no wallet linked AND for any balance too small to cover a slot's fee
      // plus slippage buffer, so EVERY leader buy was skipped with "the wallet
      // is empty after the exit-gas reserve" — a simulation refusing to
      // simulate over money it was never going to spend. The engine's own paper
      // path already falls back to a notional bankroll; the copy trader never
      // got that, which is why paper copy trading opened nothing.
      //
      // Gate on the computed STAKE, not on the balance: gating on
      // `deployableSol <= 0` leaves a dust-funded wallet skipping every buy for
      // exactly the same reason.
      copySol = (this.config.tradingMode === 'paper' && stakeSol <= 0)
        ? this.config.maxBuySol
        : stakeSol;
    } else {
      if (sig.solAmount <= 0) {
        return skip('Token→token swap carries no SOL size to scale from — switch to fixed sizing to copy these.');
      }
      copySol = sig.solAmount * (this.config.proportionalPct / 100);
    }
    copySol = round4(Math.min(copySol, this.config.maxBuySol));
    if (copySol <= 0) {
      return skip(this.config.buySizeMode === 'split'
        ? 'Split sizing has nothing to stake — the wallet is empty after the exit-gas reserve.'
        : 'Computed copy size is 0 SOL — check buy sizing in Copy Settings.');
    }
    // No dust buys: a size below the floor loses the round-trip fee on entry,
    // so skip it rather than open a guaranteed-underwater mini position.
    if (this.config.minCopyBuySol > 0 && copySol < this.config.minCopyBuySol) {
      return skip(`Copy size ${copySol} SOL is below the ${this.config.minCopyBuySol} SOL minimum — too small to be worth the fees, skipped. Lower "min copy buy" or the open-position count to make each slice bigger.`);
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
      const existingNow = this.mergeablePositionFor(mint);

      // Re-check the book cap HERE too: the arrival-time check cannot see
      // buys of other mints that are still landing (positions are recorded
      // only after confirmation), so N concurrent signals could all pass it.
      if (!existingNow) {
        const openNow = this.openPositionsForCurrentMode().length;
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
        // STOP MUST MEAN STOP. The enabled check runs when the signal ARRIVES,
        // but a buy waits in the per-mint queue behind whatever is already
        // running for that mint — an exit and its retries can hold it for
        // minutes. executeRealMainnetTrade has no notion of either engine's
        // run flag, so the operator could switch copy trading off, watch the
        // feed go quiet, and still get filled. Re-checked HERE, at execution
        // time, which is the only moment that counts.
        if (!this.config.enabled) {
          this.pushFeed(wallet, sig, 'skipped',
            `Copy trading was switched OFF while this buy was queued — not executed.`);
          return;
        }
        // STALENESS, RE-CHECKED HERE. The arrival-time check cannot see how
        // long this order then waited: the per-mint queue serialises it behind
        // whatever is running for the mint, and an exit's retry loop alone can
        // hold it for well over a minute. Entering on a signal that old is not
        // copying the leader, it is buying whatever the price has become.
        const queuedAgeMs = sig.observedAt ? Date.now() - sig.observedAt : 0;
        if (queuedAgeMs > MAX_BUY_SIGNAL_AGE_MS) {
          wallet.skippedSignals++;
          this.pushFeed(wallet, sig, 'skipped',
            `This buy waited ${Math.round(queuedAgeMs / 1000)}s in the queue behind other work for $${symbol} (max ${MAX_BUY_SIGNAL_AGE_MS / 1000}s) — the price has moved, not chased.`);
          return;
        }
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
        // Balance read, but ONLY when one is owed — i.e. when a trade has
        // settled since the last read and the cached number therefore stopped
        // matching the chain. In the steady state the settlement's own
        // background refresh has already landed and this costs nothing;
        // previously it was an unconditional RPC round trip (40-200ms, bounded
        // at 1500ms) sitting on the hot path of every single real copy buy,
        // inside the per-mint queue, with the leader's fill getting further
        // away the whole time. Still bounded, for the same reason as before: a
        // hung socket must not pin this mint's queue while a flip-sell waits.
        const balanceRead = await sniperEngine.refreshWalletBalanceIfOwed(1500);
        if (balanceRead === 'timed-out') {
          // Not fatal — the governor refuses a buy sized against a balance
          // older than its own maxBalanceAgeMs, so a genuinely stale number is
          // caught below rather than traded on. Worth saying out loud, though:
          // it means the RPC is struggling.
          console.warn(`[CopyTrader] Balance read for ${mint.slice(0, 8)}… did not return within 1500ms; sizing against the cached value.`);
        }
        const openAfterThisBuy = this.openPositionsForCurrentMode().length + (existingNow ? 0 : 1);
        // Per open position, sized from the fee this session will actually pay.
        const exitGasPerPosition = copyExitGasReserveSol(sniperEngine.getSizingPriorityFeeSol());
        const reservedForExits = round4(exitGasPerPosition * openAfterThisBuy);
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
        // SPLIT re-slices HERE, against the balance that actually exists now
        // (post-reserves, post-settlement) rather than the pre-queue snapshot.
        if (this.config.buySizeMode === 'split') {
          copySol = round4(Math.min(
            this.splitStakeSol(deployableSol, openAfterThisBuy - (existingNow ? 0 : 1), sizingFeeSol, Boolean(existingNow)),
            this.config.maxBuySol
          ));
        }
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

        // No dust buys, at execution time too: the clamp above can shrink a
        // real order below the floor, and a sub-cent entry loses the round-trip
        // fee the moment it lands.
        if (this.config.minCopyBuySol > 0 && copySol < this.config.minCopyBuySol) {
          wallet.skippedSignals++;
          this.pushFeed(wallet, sig, 'skipped',
            `Copy size ${copySol} SOL is below the ${this.config.minCopyBuySol} SOL minimum after reserves — too small to be worth the fees, skipped.`);
          return;
        }

        // Say what this slice actually has to make back. Fixed round-trip costs
        // (ATA rent + base fees + two priority fees) do NOT shrink with the
        // stake, so a wallet split too many ways needs an implausible move just
        // to break even. Printing it per trade keeps that visible instead of
        // letting it quietly eat the run. Advisory only — never a refusal.
        const beSlot = breakevenPct(copySol, sizingFeeSol);
        if (this.config.buySizeMode === 'split') {
          clampNote += ` · slice ${copySol} SOL of ${this.config.maxOpenPositions} · needs +${beSlot}% to break even`;
        }
        // Loud only when the split is genuinely uneconomic (measured: 10 ways on
        // a 0.1 SOL wallet is ~57%). The per-trade number is already in the buy
        // line above; a warning that fires on every copy is wallpaper, so this
        // one is throttled to once every 10 minutes.
        if (beSlot >= 30 && Date.now() - this.lastBreakevenWarnAt > 600_000) {
          this.lastBreakevenWarnAt = Date.now();
          this.pushFeed(wallet, sig, 'pending',
            `⚠️ A ${copySol} SOL slice needs +${beSlot}% just to break even — fixed costs (token-account rent + fees) do not shrink with the slice. Lower "Max Open Copy Positions" or add SOL.`);
        }

        // Claim the full worst-case outflow (stake + slippage reserve +
        // protocol fees + priority fee + rent) for the duration of the order —
        // plus the exit gas the NEW position will need, so a concurrent buy of
        // another mint reserves for this position before it is recorded.
        this.inFlightBuySol.set(mint,
          copySol * (1 + this.config.maxSlippagePct / 100 + 0.015) + sizingFeeSol + 0.0025
          + (existingNow ? 0 : exitGasPerPosition));
        let result: TradeResult | null;
        try {
          result = await sniperEngine.executeExternalTrade(
            'buy', mint, copySol, undefined, buyPool,
            Math.min(this.config.maxSlippagePct, COPY_BUY_MAX_SLIPPAGE_PCT),
            // What we already hold. On the unresolved-buy recovery path "the
            // wallet holds some" is not evidence a buy landed if it already
            // held some — and a repeat buy is the DEFAULT here
            // (blockRepeatBuys is false), so that case is the common one.
            existingNow ? existingNow.tokensHeld : 0,
            // FREE THE QUEUE FOR AN EXIT. depth() counts this buy plus anything
            // waiting behind it, so >1 means a leader sell (or a second signal)
            // for this mint is already blocked. The confirmation window is 75s;
            // a bag the leader is dumping cannot spend 75s waiting on the
            // entry's book-keeping. The signature is reconciled out of band.
            () => this.tradeQueue.depth(mint) > 1,
            // What the leader did, so the fill can be scored against it.
            { leaderSlot: sig.leaderSlot, signalAtMs: sig.observedAt, lane: sig.fast ? 'fast' : 'slow' }
          );
        } finally {
          this.inFlightBuySol.delete(mint);
        }
        if (!result) {
          this.pushFeed(wallet, sig, 'failed', `Real BUY of ${copySol} SOL failed — see engine log.`);
          return;
        }

        // Balance deltas are facts; quotes are opinions.
        //
        // A non-null `result` now means the transaction demonstrably landed —
        // executeRealMainnetTrade returns null for every outcome that did not,
        // including the unresolved ones it used to report as success. So there
        // IS a bag; the only question left is how big it is.
        //
        // That question is never answered by arithmetic on the leader's price
        // again. The old line was:
        //
        //     tokensBought = fill?.tokenDelta ?? (copySol / leaderPriceSol)
        //
        // and the fallback invented a quantity out of OUR order size and THEIR
        // fill price. It was wrong whenever our fill differed from theirs —
        // i.e. always, and by the most on exactly the volatile launches this
        // bot trades. That fabricated number then sized every later partial
        // sell and every P&L figure the operator was shown.
        let fill = result.fill;

        // A BALANCE-DERIVED fill reports the wallet's TOTAL holding of the mint,
        // not this trade's delta — the engine could not read the transaction, so
        // it read the wallet instead. On a REPEAT (DCA) buy the position already
        // holds most of that total, and recordBuy ADDS what it is given: the
        // position would gain the whole balance a second time and then try to
        // sell tokens the wallet does not have.
        if (fill && result.balanceDerived) {
          const prior = existingNow ? existingNow.tokensHeld : 0;
          const gained = fill.tokenDelta - prior;
          fill = gained > 0 ? { ...fill, tokenDelta: gained } : null;
          if (!fill) {
            this.pushFeed(wallet, sig, 'failed',
              `⚠️ BUY ${result.txid.slice(0, 8)}… landed but the wallet holds no MORE of $${symbol} than the position already records — nothing added rather than double-counting the bag. https://solscan.io/tx/${result.txid}`);
            this.persist();
            this.emitChange();
            return;
          }
        }

        if (!fill || !(fill.tokenDelta > 0)) {
          // The transaction landed but its fill could not be parsed. Ask the
          // wallet what it holds — a real number, one RPC call away.
          const owned = await sniperEngine.readOwnedTokenAmount(mint);
          if (owned !== null && owned > 0) {
            const prior = existingNow ? existingNow.tokensHeld : 0;
            const gained = Math.max(0, owned - prior);
            if (gained > 0) {
              fill = { txid: result.txid, solDelta: -copySol, tokenDelta: gained, feeSol: 0, slot: 0 };
            }
          }
        }

        if (!fill || !(fill.tokenDelta > 0)) {
          // Landed, but we cannot establish a quantity from either the
          // transaction or the wallet. Recording an invented number here is
          // precisely the phantom position the operator reported, so nothing is
          // recorded — and it is said loudly, because a real bag may exist.
          this.pushFeed(wallet, sig, 'failed',
            `⚠️ BUY ${result.txid.slice(0, 8)}… landed but its size could not be read from the transaction OR the wallet. `
            + `No position was opened rather than inventing one. CHECK https://solscan.io/tx/${result.txid}`);
          this.persist();
          this.emitChange();
          return;
        }

        const tokensBought = fill.tokenDelta;
        const solSpent = Math.abs(Math.min(0, fill.solDelta)) || copySol;
        const entryPriceSol = tokensBought > 0 ? solSpent / tokensBought : leaderPriceSol;

        this.recordBuy(wallet, sig, existingNow, {
          tokens: tokensBought,
          solSpent,
          priceSol: entryPriceSol,
          txid: result.txid,
          // Verified means the COST BASIS came from the transaction itself.
          // A balance-derived quantity is real, but its SOL cost is the size we
          // ordered rather than the amount the chain took, so it does not earn
          // the verified badge.
          fillVerified: Boolean(result.fill) && !result.balanceDerived,
        });
        this.pushFeed(wallet, sig, 'copied',
          `REAL BUY ${copySol} SOL of $${symbol}${existingNow ? ' (added to position)' : ''}${clampNote} @ ${fmtPrice(entryPriceSol)} SOL/token`,
          copySol, result.txid);

        // Only NOW, and only for a fast-lane signal: check that the leader
        // transaction we acted on actually survived. Anchored here rather than
        // at the notification because we just spent real money on it — and
        // because the notification rate is the leader's, which can be hundreds
        // per minute, while this rate is bounded by the governor.
        if (sig.fast && sig.signature) this.verifyFastSignal(wallet, sig);
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
  /** A position is paper iff its buy was a simulated fill. */
  private isPaperPos(p: CopyPositionInternal): boolean {
    return (p.buyTxid ?? '').startsWith('sim_');
  }

  /**
   * Open positions of the SAME provenance as the trade the current mode would
   * make. Paper and real positions must never be pooled: counting a leftover
   * paper bag against the real open-position cap collapsed split sizing into a
   * near-all-in real buy, and merging a real buy into a paper position stranded
   * real tokens behind a simulated exit. In a single-mode session this is every
   * open position, so it changes nothing there.
   */
  private openPositionsForCurrentMode(): CopyPositionInternal[] {
    const wantPaper = this.config.tradingMode === 'paper';
    return this.positions.filter(p => p.status !== 'CLOSED' && this.isPaperPos(p) === wantPaper);
  }

  /** The open position for `mint` that the current mode may add to, if any. */
  private mergeablePositionFor(mint: string): CopyPositionInternal | undefined {
    const wantPaper = this.config.tradingMode === 'paper';
    return this.positions.find(p => p.mint === mint && p.status !== 'CLOSED' && this.isPaperPos(p) === wantPaper);
  }

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
    // REAL BAGS WIN. This used to be a bare `.find()` over the whole list with
    // no provenance filter, while the BUY side (mergeablePositionFor) filters by
    // paper/real. After a mode flip the two diverge: loadState forces
    // enabled=false for a restored real config, so the operator re-arms in
    // paper, the leader re-buys the same mint, and a NEW paper position is
    // unshifted to the HEAD of the list. The next leader exit then found the
    // paper twin first and spent the signal on it — while the real tokens sat
    // in the wallet with the leader already gone.
    //
    // A real position is the one with money in it, so it is resolved first
    // whatever the current mode. If the mode is paper, runExit refuses it with
    // "switch back to REAL mode to exit it" — visible and recoverable, unlike
    // silently exiting a simulation and stranding the bag.
    const open = this.positions.filter(p => p.mint === sig.mint && p.status !== 'CLOSED');
    const held = open.find(p => !this.isPaperPos(p)) ?? open[0];
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
      // RESOLVED AGAIN HERE, with the same real-first rule — this is the one
      // that decides what actually gets sold.
      //
      // The pre-queue resolution above only feeds the feed text and the
      // nothing-held check; a buy queued ahead of this exit can have opened a
      // position in the meantime, so re-resolving is required anyway. Applying
      // the rule only to the earlier variable left the real bug in place: this
      // line was an unfiltered `.find()`, so it still took whichever position
      // sat first in the list — and a paper twin created after a mode flip is
      // unshifted to the HEAD.
      const openNow = this.positions.filter(p => p.mint === sig.mint && p.status !== 'CLOSED');
      const pos = openNow.find(p => !this.isPaperPos(p)) ?? openNow[0];
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
      dismissed: true,
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
      /**
       * The bag the CHAIN says is left, when we managed to read it. Preferred
       * over `tokensHeld - tokensSold` because that arithmetic starts from the
       * fraction we requested rather than from what moved.
       */
      let remainingOnChain: number | null = null;

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
          // CHECKED FOR AUTOMATIC EXITS TOO, not only manual ones.
          //
          // The gate used to be `if (isManual)`. So a position whose bag was
          // already gone — sold by hand on Photon, or exited by an earlier
          // attempt that landed after we gave up — stayed OPEN forever, held a
          // slot and its exit-gas reserve, and re-ran the whole six-attempt
          // sell loop on EVERY subsequent leader signal. Each attempt either
          // errors at trade-local or lands and reverts, burning a priority fee
          // (default 0.001 SOL, up to 0.05 by config) for a bag that does not
          // exist. That is the fee-burn grind with an empty trade ledger, which
          // is exactly the shape of the reported drain.
          //
          // One balance read per FAILED exit is a negligible cost next to the
          // loop it ends.
          {
            const held = await this.getOwnedTokenAmount(pos.mint);
            const expected = pos.tokensHeld || 0;
            const effectivelyGone = held !== null && held <= Math.max(0, expected * 0.05);
            if (effectivelyGone) {
              this.closeAsExternallyExited(pos);
              if (wallet) {
                this.pushFeed(wallet, feedSig, 'skipped',
                  `$${pos.tokenSymbol}: the exit failed, but the wallet no longer holds it — the bag was already gone. Position closed instead of retrying into a fee burn.`);
              }
            } else if (isManual && wallet) {
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
          // The transaction landed but could not be parsed. `tokensSold` is
          // still the amount we ASKED to sell and `pos.currentPriceSol` can be
          // stale by a whole dump — multiplying them books an invented
          // proceeds figure and an invented realized P&L.
          //
          // Ask the wallet instead. The balance before the sell is what the
          // position recorded, so the difference is what actually sold; it is a
          // measured number even when the transaction is unreadable.
          const heldAfter = await this.getOwnedTokenAmount(pos.mint);
          if (heldAfter !== null) {
            const measuredSold = Math.max(0, (pos.tokensHeld || 0) - heldAfter);
            if (measuredSold <= 0) {
              // The transaction landed but the bag did not move. Booking the
              // REQUESTED size as proceeds here would credit a sale that did
              // not happen, and writing the unchanged balance back as
              // tokensHeld would then mark the position closed or partial on
              // the strength of it. Keep the position exactly as it is and let
              // the retry path or the periodic sync settle it.
              if (wallet) {
                this.pushFeed(wallet, feedSig, 'failed',
                  `$${pos.tokenSymbol}: the exit landed but the wallet still holds the same ${heldAfter} tokens — nothing was sold. Position kept unchanged.`);
              }
              pos.exitInFlight = false;
              return;
            }
            tokensSold = measuredSold;
            // The remaining bag is now known from the chain rather than from
            // the requested fraction, so a sell that moved less than asked
            // leaves the rest tracked instead of being written off.
            remainingOnChain = heldAfter;
          }
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

      // The chain wins when it answered. `isFull` is the fraction we ASKED for,
      // and closing on it alone writes off whatever did not actually sell —
      // a bag with no position tracking it is a bag nothing will ever exit.
      pos.tokensHeld = remainingOnChain !== null
        ? Math.max(0, remainingOnChain)
        : Math.max(0, pos.tokensHeld - tokensSold);
      pos.realizedPnlSol += pnlSol;
      // Report to the shared breaker. The sniper's loss-based kill switch reads
      // only the sniper's own history and is gated on the sniper being active,
      // so copy trading with the sniper stopped — the configuration in the
      // incident — had no loss cap at all.
      if (realPosition && tradeGovernor.recordRealizedPnlSol(pnlSol)) {
        this.pushFeed(wallet ?? this.standInWallet(pos), feedSig, 'failed',
          `🛑 TRADING HALTED — ${tradeGovernor.haltReason()}`);
      }
      pos.realizedPnlUsd += pnlUsd;
      const emptied = pos.tokensHeld <= 1e-9;
      pos.status = emptied || (isFull && remainingOnChain === null) ? 'CLOSED' : 'PARTIAL';
      if (pos.status === 'CLOSED') pos.tokensHeld = 0;
      if (isFull && !emptied && remainingOnChain !== null) {
        this.pushFeed(wallet ?? this.standInWallet(pos), feedSig, 'pending',
          `$${pos.tokenSymbol}: a FULL exit was requested but the wallet still holds ${pos.tokensHeld} tokens — position kept OPEN so the remainder is still tracked and can be sold.`);
      }
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
        if (outcome === 'unknown') {
          // We do not know whether that sell landed, so retrying it here would
          // be the blind resubmit this whole branch exists to prevent — the
          // retry loop is the resubmit. Stop, keep the position, and let the
          // periodic on-chain balance sync establish the truth; a later exit
          // starts from the wallet's real balance rather than from a guess.
          if (wallet) {
            this.pushFeed(wallet, feedSig, 'failed',
              `SELL ${pct}% of $${pos.tokenSymbol} could not be resolved (the RPC never answered). NOT retried — a blind resubmit can sell the bag twice. `
              + `The position is kept and re-checked against the chain shortly. https://solscan.io/tx/${result.txid}`);
          }
          return null;
        }
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

      // ENDPOINT DRIFT. Nothing calls startHeliusWatcher again when a key is
      // rejected MID-SESSION — the operator did not change anything, so no
      // settings event fires. Without this check the connection stayed pinned
      // to the dead endpoint for the rest of the run while the sniper, which
      // rebinds on the resolved URL, quietly recovered on its own.
      // Throttled. startHeliusWatcher can legitimately decline to rebuild — no
      // enabled leaders, no key — in which case heliusEndpointInUse keeps its
      // old value and an unthrottled check would call it again every 250ms
      // forever, four restart attempts a second for the life of the process.
      if (this.config.enabled && this.heliusEndpointInUse
        && Date.now() - this.lastEndpointDriftCheckAt > ENDPOINT_DRIFT_CHECK_MS) {
        this.lastEndpointDriftCheckAt = Date.now();
        const currentEndpoint = rpcEndpoint(sniperEngine.getConfig().heliusApiKey || process.env.HELIUS_API_KEY || '');
        if (currentEndpoint !== this.heliusEndpointInUse) {
          console.warn(`[CopyTrader] RPC endpoint drifted (${hostOf(this.heliusEndpointInUse)} → ${hostOf(currentEndpoint)}) — rebuilding the watcher.`);
          this.startHeliusWatcher();
        }
      }

      // PERIODIC TRUTH CHECK — the book, against the chain.
      //
      // syncPositionsWithOnChainBalances existed but was reachable ONLY from a
      // button (server.ts POST /api/copy/sync). So a position whose recorded
      // quantity had drifted from the wallet's real balance stayed wrong
      // indefinitely, and a position for a bag that was not there was permanent
      // unless the operator happened to press it. That is what made a phantom
      // position survive: nothing was ever going to notice.
      //
      // Now it runs on its own. Cheap — one balance read per open position, on
      // a slow cadence, and it only ever CORRECTS the record; it never trades.
      // Skipped while an exit is in flight (below, inside the sync) so it
      // cannot race a sell that is mid-settlement.
      if (this.config.tradingMode === 'real'
        && !this.positionsWalletMismatch
        && Date.now() - this.lastPositionSyncAt > POSITION_SYNC_INTERVAL_MS
        && !this.positionSyncInFlight) {
        this.lastPositionSyncAt = Date.now();
        this.positionSyncInFlight = true;
        // The flag is released by a DEADLINE as well as by the promise. A
        // keep-alive socket whose route silently disappears leaves the balance
        // read pending forever — no FIN, no reset — and a plain `finally` then
        // never runs, so this in-flight flag became a permanent latch that
        // disabled the automatic on-chain truth check for the life of the
        // process. The check that exists to catch a phantom position must not
        // be switchable off by the same network fault that creates one.
        const syncGuard = setTimeout(() => { this.positionSyncInFlight = false; }, POSITION_SYNC_INTERVAL_MS);
        if (typeof syncGuard.unref === 'function') syncGuard.unref();
        void this.syncPositionsWithOnChainBalances()
          .catch(() => { /* unreadable now; the next pass retries */ })
          .finally(() => { clearTimeout(syncGuard); this.positionSyncInFlight = false; });
      }

      // No price-based exits here. closePosition is reached from onLeaderSell
      // (when copySells is on) and from the manual sell button; takeProfitPct
      // and maxHoldSeconds stay in the config for compatibility but are inert.
    }, MONITOR_INTERVAL_MS);
  }

  private lastEndpointDriftCheckAt = 0;
  private lastPositionSyncAt = 0;
  private positionSyncInFlight = false;
  /**
   * True when the restored positions were bought by a DIFFERENT wallet than the
   * one linked now. Automatic reconciliation is suppressed while it holds: a
   * balance check against the wrong wallet reads zero for every mint and would
   * close every real position as "externally exited".
   */
  private positionsWalletMismatch = false;

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
  /** The exact bytes of the current state. One definition, three call sites. */
  private serializeState(): string {
    return JSON.stringify({
      // Stamped so the copySells opt-out migration runs exactly once.
      configVersion: COPY_CONFIG_VERSION,
      // Whose positions these are. Without it, restored bags were reconciled
      // against WHATEVER wallet happened to be linked on the next boot — relink
      // a different key and the balance sync reads zero for every mint and
      // closes real positions as "externally exited".
      walletAddress: sniperEngine.getWalletStatus().address ?? null,
      config: this.config,
      wallets: [...this.wallets.values()],
      positions: this.positions.filter(p => p.status !== 'CLOSED'),
      history: this.history.slice(0, HISTORY_LIMIT),
    }, null, 2);
  }

  /**
   * Write the state file so that a process death can never leave it truncated.
   *
   * It used to be a bare `fs.writeFileSync(STATE_FILE, ...)`. A kill, a crash
   * or a power loss partway through that call leaves a half-written file, and
   * the next boot's `JSON.parse` throws — at which point loadState's outer
   * `catch` swallowed it and the service started on DEFAULT_CONFIG. Every open
   * real position, every tracked leader and every hardened safety setting the
   * operator had chosen (a raised minimum, blockRepeatBuys, a cooldown, a
   * smaller book) was gone, silently, replaced by defaults that are more
   * permissive than what they had set.
   *
   * Write to a temp file, then rename — rename is atomic on every platform this
   * ships to, so the state file is only ever the old bytes or the new ones. The
   * previous good copy is kept alongside as .bak for loadState to fall back to.
   */
  private writeStateFile(): void {
    const payload = this.serializeState();
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, { encoding: 'utf8' });
      // Keep the last good file before replacing it — but ONLY if it is
      // actually good. Copying blindly meant that after a boot which had
      // already recovered from the backup (leaving a corrupt STATE_FILE in
      // place), the very first persist() copied that corruption OVER the one
      // surviving good copy. A backup that can be destroyed by the thing it is
      // backing up is not a backup.
      try {
        if (fs.existsSync(STATE_FILE)) {
          JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));   // throws if unusable
          fs.copyFileSync(STATE_FILE, `${STATE_FILE}.bak`);
        }
      } catch { /* the current file is not worth backing up — keep the older .bak */ }
      fs.renameSync(tmp, STATE_FILE);
    } catch (err: any) {
      console.error(`[CopyTrader] ⚠️ Could not write ${STATE_FILE}: ${err?.message ?? err}. `
        + 'If this process dies, open positions and settings will not survive the restart.');
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* nothing more to do */ }
    }
  }

  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeStateFile();
    }, 500);
  }

  /**
   * Write state to disk RIGHT NOW, cancelling any pending debounced write.
   *
   * persist() coalesces behind a 500ms timer, but every shutdown path
   * (gracefulShutdown, SIGTERM, the updater restart, Electron quit) exits
   * synchronously in the same tick — so a copy sell recorded <500ms before
   * shutdown was never written, and the next boot restored a phantom OPEN
   * position for a bag already sold. Shutdown calls this so the last trade is
   * always on disk.
   */
  public flushStateSync(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    this.writeStateFile();
  }

  /**
   * Read the state file, falling back to the backup, and NEVER pretend a
   * corrupt file is an absent one.
   *
   * The old code parsed inside loadState's single outer try/catch, so a
   * truncated or malformed file took the same path as "no file yet": the
   * service started on DEFAULT_CONFIG with no positions, no tracked wallets and
   * every hardened safety setting reverted — without a word in the log. The
   * operator would have seen a bot that had forgotten its own configuration and
   * was trading with more permissive limits than they set.
   *
   * Now: try the file, then the backup, and if both are unreadable say so
   * loudly AND preserve the bad file for inspection instead of overwriting it.
   */
  private readStateFile(): any | null {
    for (const [path, label] of [[STATE_FILE, 'state file'], [`${STATE_FILE}.bak`, 'backup']] as const) {
      if (!fs.existsSync(path)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          if (label === 'backup') {
            console.warn(`[CopyTrader] ⚠️ ${STATE_FILE} was unreadable — recovered settings, wallets and positions from the backup instead.`);
          }
          return parsed;
        }
        console.error(`[CopyTrader] ⚠️ The ${label} parsed but is not an object — ignoring it.`);
      } catch (err: any) {
        console.error(`[CopyTrader] ⚠️ The ${label} at ${path} is CORRUPT (${err?.message ?? err}).`);
      }
    }
    if (fs.existsSync(STATE_FILE)) {
      // Both copies failed. Move the bad file aside rather than letting the
      // next persist() overwrite the only evidence of what was in it.
      const quarantine = `${STATE_FILE}.corrupt`;
      try {
        fs.renameSync(STATE_FILE, quarantine);
        console.error(`[CopyTrader] 🛑 Starting with DEFAULT settings and NO restored positions. The unreadable file was kept at ${quarantine}. `
          + 'CHECK YOUR WALLET for open bags this bot is no longer tracking before you arm real trading again.');
      } catch { /* keep going — defaults are still the only option */ }
    }
    return null;
  }

  private loadState(): void {
    try {
      const raw = this.readStateFile();
      if (!raw) return;

      // Positions belong to the wallet that bought them. Reconciling wallet A's
      // bags against wallet B reads zero for every mint and closes all of them
      // as "externally exited" — real positions, deleted, for a key change.
      const savedWallet = typeof raw.walletAddress === 'string' ? raw.walletAddress : null;
      const currentWallet = sniperEngine.getWalletStatus().address ?? null;
      const walletChanged = Boolean(savedWallet && currentWallet && savedWallet !== currentWallet);
      if (walletChanged) {
        console.warn(`[CopyTrader] ⚠️ The saved positions belong to wallet ${shortAddr(savedWallet!)} but ${shortAddr(currentWallet!)} is linked now. `
          + 'They are restored but will NOT be auto-reconciled against this wallet — a balance check against the wrong wallet would close them all as sold. '
          + 'Relink the original key, or dismiss them once you have checked them.');
      }
      this.positionsWalletMismatch = walletChanged;

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

  /**
   * Tell the UI something changed — NEVER on the caller's own stack.
   *
   * WHY THIS IS DEFERRED. This used to call every listener synchronously, and
   * one of the call sites is the Helius log notification handler
   * (`onLog`), which runs it on every notification that repriced an open
   * position — BEFORE `handleFastLog` decides whether to buy. Each listener is
   * an SSE push that rebuilds the entire copy status (config, every wallet, up
   * to 60 history rows and 80 feed rows, every open position) and serializes it
   * to JSON, per connected client. That is real work, on the one code path
   * whose entire purpose is to be fast, done for the benefit of a dashboard
   * nobody is watching at 3am.
   *
   * A 25ms coalesce also collapses the burst case: a leader transaction with
   * several legs, or several leaders trading in the same instant, produced one
   * full serialization each. The UI cannot show more than one of those anyway.
   *
   * The timer is unref'd — telemetry for a browser tab must never be the reason
   * the process stays alive.
   */
  private emitTimer: NodeJS.Timeout | null = null;

  private emitChange(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.flushChange();
    }, COPY_EMIT_COALESCE_MS);
    this.emitTimer.unref?.();
  }

  /**
   * Push immediately. For the paths where a caller genuinely needs the UI to
   * have the new state before it returns — shutdown, and the tests, which
   * cannot await a timer they do not own.
   */
  private flushChange(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
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
  if (partial.buySizeMode === 'fixed' || partial.buySizeMode === 'proportional' || partial.buySizeMode === 'split') {
    out.buySizeMode = partial.buySizeMode;
  }
  if (isFiniteNum(partial.fixedBuySol)) out.fixedBuySol = clamp(partial.fixedBuySol!, 0.001, 100);
  if (isFiniteNum(partial.proportionalPct)) out.proportionalPct = clamp(partial.proportionalPct!, 1, 200);
  if (isFiniteNum(partial.maxBuySol)) out.maxBuySol = clamp(partial.maxBuySol!, 0.001, 100);
  if (isFiniteNum(partial.minLeaderBuySol)) out.minLeaderBuySol = clamp(partial.minLeaderBuySol!, 0, 100);
  if (isFiniteNum(partial.minCopyBuySol)) out.minCopyBuySol = clamp(partial.minCopyBuySol!, 0, 100);
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
