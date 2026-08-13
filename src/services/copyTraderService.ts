import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  CopyFeedEvent,
  CopyPosition,
  CopyStatusResponse,
  CopyTradeRecord,
  CopyTraderConfig,
  TrackedWalletPublic,
} from '../types';
import { sniperEngine } from './sniperEngine';
import { affordableStakeSol, sellAmountParam } from './pipelineUtils';
import { DexScreenerService } from './dexscreenerService';

/**
 * Mirrors EVERY buy of chosen leader wallets. SELLS ARE NEVER AUTOMATIC —
 * removed 2026-08-12, owner decision: leader sells surface in the feed as
 * signals, and the only sell path is the manual button.
 *
 * Two signal feeds, deduplicated by transaction signature:
 *
 *  1. HELIUS ON-CHAIN WATCHER (the complete feed). Each tracked wallet gets a
 *     log subscription on the Helius RPC websocket; every confirmed
 *     transaction that mentions the wallet is fetched and its SOL + token
 *     balance deltas read. A swap is a swap regardless of venue — pump.fun,
 *     Raydium, Jupiter, anything — because the wallet's balances move the same
 *     way. This is what makes "copy ALL of their trades" literal.
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

const STATE_FILE = path.resolve(process.cwd(), '.copy-trader.json');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Paper fills assume this much slippage vs. the leader's realized price. */
const PAPER_SLIPPAGE_PCT = 1.5;

/** Token-balance noise floor — below this a delta is rounding, not a trade. */
const TOKEN_DELTA_EPSILON = 1e-9;

/** Reprice a held position from DexScreener when its last tick is older than this. */
const PRICE_STALE_MS = 4000;

const FEED_LIMIT = 120;
const HISTORY_LIMIT = 200;
const MONITOR_INTERVAL_MS = 1000;
const PROCESSED_SIG_LIMIT = 3000;

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
  via: 'pumpportal' | 'helius';
  /** True when this leg is half of a token→token swap (no SOL amount to scale from). */
  isTokenSwap?: boolean;
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
  // INERT since 2026-08-12: no automatic sells of any kind. Kept so old saved
  // configs still load.
  copySells: true,
  sellMode: 'mirror',
  // OFF: a leader adding to a bag adds to ours (DCA mirror) instead of being
  // skipped. Turn on to copy only the first entry per mint.
  blockRepeatBuys: false,
  maxOpenPositions: 10,
  maxSlippagePct: 25,
  perWalletCooldownSec: 0,
  // INERT since 2026-08-12 — no automatic sells; exits are manual only.
  maxHoldSeconds: 0,
  takeProfitPct: 0,
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
  /** Mints currently subscribed for price ticks (open positions). */
  private subscribedMints = new Set<string>();

  // Helius on-chain watcher
  private heliusConn: Connection | null = null;
  private heliusKeyInUse: string | null = null;
  /** onLogs subscription id per tracked wallet address. */
  private logSubs = new Map<string, number>();

  /** Signatures already handled — the cross-feed dedup. FIFO-pruned. */
  private processedSigs = new Set<string>();
  private processedSigOrder: string[] = [];

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
      heliusConnected: this.logSubs.size > 0,
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
    await this.closePosition(pos, 1, 'Manual force sell from copy page');
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

  /** Wallet set changed — rebuild both feeds' subscriptions. User-action rate. */
  private restartSignalFeeds(): void {
    if (!this.config.enabled) return;
    this.stopSignalFeeds();
    this.startSignalFeeds();
  }

  // ---------------- HELIUS ON-CHAIN WATCHER ----------------

  /**
   * One log subscription per tracked wallet on the Helius websocket. Every
   * confirmed transaction touching the wallet is pulled and read as balance
   * deltas — venue-agnostic by construction.
   */
  private startHeliusWatcher(): void {
    const addresses = this.enabledWalletAddresses();
    if (!addresses.length) return;

    const key = sniperEngine.getConfig().heliusApiKey || process.env.HELIUS_API_KEY || '';
    if (!key) return;

    // Rebuild the connection when the operator changed the key in settings.
    if (!this.heliusConn || this.heliusKeyInUse !== key) {
      this.stopHeliusWatcher();
      this.heliusConn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, 'confirmed');
      this.heliusKeyInUse = key;
    }

    for (const address of addresses) {
      if (this.logSubs.has(address)) continue;
      try {
        const subId = this.heliusConn.onLogs(
          new PublicKey(address),
          (logs) => {
            if (logs.err) return; // failed tx — nothing moved
            if (!logs.signature || this.processedSigs.has(logs.signature)) return;
            void this.handleWalletLog(address, logs.signature);
          },
          'confirmed'
        );
        this.logSubs.set(address, subId);
      } catch {
        // Subscription failed (bad RPC, momentary outage) — the PumpPortal
        // lane still covers pump.fun; a feed restart retries this.
      }
    }
    this.emitChange();
  }

  private stopHeliusWatcher(): void {
    if (this.heliusConn) {
      for (const subId of this.logSubs.values()) {
        void this.heliusConn.removeOnLogsListener(subId).catch(() => {});
      }
    }
    this.logSubs.clear();
    this.emitChange();
  }

  private async handleWalletLog(leaderAddress: string, signature: string): Promise<void> {
    const wallet = this.wallets.get(leaderAddress);
    if (!wallet || !wallet.enabled || !this.config.enabled || !this.heliusConn) return;

    const signals = await this.analyzeLeaderTx(leaderAddress, signature);
    if (!signals.length) return;

    // Claim the signature only once we know it was a trade, so the PumpPortal
    // lane is not blocked by unrelated transfers sharing the dedup set.
    if (this.processedSigs.has(signature)) return;
    this.markSigProcessed(signature);

    for (const sig of signals) {
      await this.handleLeaderSignal(wallet, sig);
    }
  }

  /**
   * Read a transaction as the leader wallet's balance deltas and classify:
   * token up + SOL down = BUY; token down + SOL up = SELL; token down + other
   * token up = token→token swap (a sell leg and a buy leg). WSOL moves count
   * as SOL — aggregators route through wrapped SOL and unwrap in the same tx.
   */
  private async analyzeLeaderTx(leaderAddress: string, signature: string): Promise<LeaderSignal[]> {
    if (!this.heliusConn) return [];

    let parsed = null;
    try {
      parsed = await this.heliusConn.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!parsed) {
        // onLogs can outrun tx availability by a moment.
        await sleep(700);
        parsed = await this.heliusConn.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      }
    } catch {
      return [];
    }
    if (!parsed || !parsed.meta || parsed.meta.err) return [];

    const meta = parsed.meta;
    const keys = parsed.transaction.message.accountKeys;
    const leaderIndex = keys.findIndex(k => k.pubkey.toBase58() === leaderAddress);
    if (leaderIndex < 0) return [];

    // Native SOL delta for the leader account itself.
    let effSolDelta = ((meta.postBalances[leaderIndex] ?? 0) - (meta.preBalances[leaderIndex] ?? 0)) / LAMPORTS_PER_SOL;

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

    const buys: Array<{ mint: string; tokens: number }> = [];
    const sells: Array<{ mint: string; tokens: number; remaining: number }> = [];
    for (const [mint, delta] of deltaByMint) {
      if (delta > TOKEN_DELTA_EPSILON) buys.push({ mint, tokens: delta });
      else if (delta < -TOKEN_DELTA_EPSILON) {
        sells.push({ mint, tokens: -delta, remaining: Math.max(0, postByMint.get(mint) ?? 0) });
      }
    }
    if (!buys.length && !sells.length) return []; // plain transfer / staking / rent

    const solSpent = Math.max(0, -effSolDelta);
    const solReceived = Math.max(0, effSolDelta);
    const isTokenSwap = buys.length > 0 && sells.length > 0;

    const signals: LeaderSignal[] = [];
    // Sells first so a token→token swap frees the old bag before the new buy.
    for (const s of sells) {
      signals.push({
        signature,
        mint: s.mint,
        side: 'sell',
        solAmount: sells.length ? round4(solReceived / sells.length) : 0,
        tokenAmount: s.tokens,
        remainingTokens: s.remaining,
        via: 'helius',
        isTokenSwap,
      });
    }
    for (const b of buys) {
      signals.push({
        signature,
        mint: b.mint,
        side: 'buy',
        solAmount: buys.length ? round4(solSpent / buys.length) : 0,
        tokenAmount: b.tokens,
        via: 'helius',
        isTokenSwap: isTokenSwap && solSpent <= TOKEN_DELTA_EPSILON,
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
      this.ws = new WebSocket('wss://pumpportal.fun/api/data');

      this.ws.on('open', () => {
        this.streamConnected = true;
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

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const payload = JSON.parse(data.toString());
          void this.handlePumpPortalMessage(payload);
        } catch { /* malformed frame */ }
      });

      this.ws.on('error', () => { /* close handler drives reconnect */ });

      this.ws.on('close', () => {
        this.ws = null;
        this.streamConnected = false;
        this.emitChange();
        if (this.config.enabled) {
          setTimeout(() => this.connectPumpPortal(), 2000);
        }
      });
    } catch {
      this.ws = null;
      this.streamConnected = false;
    }
  }

  private disconnectPumpPortal(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* dying socket */ }
      this.ws = null;
    }
    this.streamConnected = false;
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
      via: 'pumpportal',
    });
  }

  // ---------------- COPY LOGIC ----------------

  private async handleLeaderSignal(wallet: TrackedWalletInternal, sig: LeaderSignal): Promise<void> {
    wallet.lastSeenAt = Date.now();
    if (sig.side === 'buy') {
      wallet.buysSeen++;
      await this.onLeaderBuy(wallet, sig);
    } else {
      wallet.sellsSeen++;
      await this.onLeaderSell(wallet, sig);
    }
  }

  private async onLeaderBuy(wallet: TrackedWalletInternal, sig: LeaderSignal): Promise<void> {
    const mint = sig.mint;
    const symbol = this.symbolFor(sig);

    const skip = (detail: string) => {
      wallet.skippedSignals++;
      this.pushFeed(wallet, sig, 'skipped', detail);
    };

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
        return skip(`Max open copy positions reached (${openCount}/${this.config.maxOpenPositions}).`);
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

    // Sizing.
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

    // Real mode: never refuse for size and never fail on-chain for size.
    // Whatever the Photon wallet can actually fund caps the order, so even a
    // near-empty wallet still copies the trade — just smaller.
    let clampNote = '';
    if (this.config.tradingMode === 'real') {
      const deployableSol = sniperEngine.getWalletStatus().deployableSol;
      const affordable = round4(affordableStakeSol(
        copySol, deployableSol, this.config.maxSlippagePct, sniperEngine.getConfig().priorityFeeSol
      ));
      if (affordable < copySol && affordable > 0) {
        clampNote = ` (clamped from ${copySol} SOL — all the wallet can fund)`;
      }
      copySol = affordable;
    }
    if (copySol <= 0) {
      return skip('Computed copy size is 0 SOL — nothing deployable in the wallet.');
    }

    // The leader's realized price, straight from their fill; DexScreener as
    // the fallback when the trade carried no usable price (token→token legs).
    let leaderPriceSol = sig.tokenAmount > 0 && sig.solAmount > 0 ? sig.solAmount / sig.tokenAmount : 0;
    if (leaderPriceSol <= 0) {
      leaderPriceSol = await this.quotePriceSol(mint);
    }

    if (this.config.tradingMode === 'real') {
      const blockers = sniperEngine.getWalletStatus().blockers;
      if (blockers.length) {
        wallet.skippedSignals++;
        this.pushFeed(wallet, sig, 'failed', `Wallet not tradable: ${blockers.join(' ')}`);
        return;
      }

      const result = await sniperEngine.executeExternalTrade(
        'buy', mint, copySol, undefined, sig.pool, this.config.maxSlippagePct
      );
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

      this.recordBuy(wallet, sig, existing, {
        tokens: tokensBought,
        solSpent,
        priceSol: entryPriceSol,
        txid: result.txid,
        fillVerified: Boolean(fill),
      });
      this.pushFeed(wallet, sig, 'copied',
        `REAL BUY ${copySol} SOL of $${symbol}${existing ? ' (added to position)' : ''}${clampNote} @ ${fmtPrice(entryPriceSol)} SOL/token`,
        copySol, result.txid);
    } else {
      // Paper: fill at the leader's realized price plus a slippage haircut —
      // we would have landed AFTER them, never at a better price.
      if (leaderPriceSol <= 0) {
        return skip('No usable price for this mint (leader fill and DexScreener both silent) — cannot simulate.');
      }
      const paperPriceSol = leaderPriceSol * (1 + PAPER_SLIPPAGE_PCT / 100);
      const tokensBought = copySol / paperPriceSol;
      const txid = `sim_copy_${Date.now()}_${++this.idCounter}`;

      this.recordBuy(wallet, sig, existing, {
        tokens: tokensBought,
        solSpent: copySol,
        priceSol: paperPriceSol,
        txid,
        fillVerified: false,
      });
      this.pushFeed(wallet, sig, 'copied',
        `PAPER BUY ${copySol} SOL of $${symbol}${existing ? ' (added to position)' : ''} @ ${fmtPrice(paperPriceSol)} SOL/token`,
        copySol, txid);
    }

    this.subscribeMint(mint);
    this.persist();
    this.emitChange();
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
   * AUTO-SELLS REMOVED 2026-08-12, owner decision: the bot never sells on its
   * own — not even to mirror the leader. A leader sell is surfaced in the feed
   * as a signal (with the exact fraction they dumped) so the owner can decide;
   * the only sell path left is the manual button (manualSellPosition).
   */
  private async onLeaderSell(wallet: TrackedWalletInternal, sig: LeaderSignal): Promise<void> {
    const pos = this.positions.find(p => p.mint === sig.mint && p.status !== 'CLOSED');

    if (!pos) {
      // Visible but cheap: the leader disposed of something we never copied
      // (bought before tracking, airdrop, transfer-in).
      this.pushFeed(wallet, sig, 'skipped', 'No copy position in this mint — nothing held.');
      return;
    }

    // Exact sell fraction from the leader's post-trade balance, for the
    // signal's wording only. Both feeds supply it: PumpPortal as
    // newTokenBalance, Helius from post balances.
    let fraction = 1;
    const sold = sig.tokenAmount;
    const remaining = sig.remainingTokens;
    if (remaining !== undefined && sold > 0) {
      fraction = sold / (sold + remaining);
    }

    wallet.skippedSignals++;
    this.pushFeed(wallet, sig, 'skipped',
      `${fraction >= 0.999
        ? `Leader ${wallet.nickname} EXITED FULLY`
        : `Leader ${wallet.nickname} sold ${(fraction * 100).toFixed(0)}% of their bag`} — HOLDING (auto-sells removed; sell manually if you want out).`);
  }

  /**
   * Sell `fraction` (0-1] of a copy position. Real mode routes through the
   * engine's execution path as a percentage-of-holdings order; paper mode
   * fills at the last observed price with the same slippage haircut as entry.
   */
  private async closePosition(
    pos: CopyPositionInternal,
    fraction: number,
    reason: string,
    leaderSig?: LeaderSignal,
    wallet?: TrackedWalletInternal
  ): Promise<void> {
    if (pos.exitInFlight) return;
    pos.exitInFlight = true;

    try {
      fraction = Math.max(0, Math.min(1, fraction));
      const solPriceUsd = sniperEngine.getSolPriceUsd();
      const isFull = fraction >= 0.999;
      let tokensSold = pos.tokensHeld * fraction;
      let solReceived: number;
      let txid: string | undefined;
      let fillVerified = false;

      if (this.config.tradingMode === 'real' && pos.buyTxid && !pos.buyTxid.startsWith('sim_')) {
        const pctParam = sellAmountParam(fraction * 100);
        const result = await sniperEngine.executeExternalTrade(
          'sell', pos.mint, 0, pctParam, pos.pool, this.config.maxSlippagePct
        );
        if (!result) {
          if (wallet) this.pushFeed(wallet, leaderSig ?? { mint: pos.mint, side: 'sell', solAmount: 0, tokenAmount: 0, via: 'helius' }, 'failed',
            `Real SELL ${(fraction * 100).toFixed(0)}% of $${pos.tokenSymbol} failed — position kept, see engine log.`);
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
        // Paper exit at the freshest price we hold, haircut for slippage.
        const exitPriceSol = pos.currentPriceSol * (1 - PAPER_SLIPPAGE_PCT / 100);
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
        if (leaderSig) owner.copiedSells++;
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

      if (wallet && leaderSig) {
        this.pushFeed(wallet, leaderSig, 'copied',
          `${this.config.tradingMode === 'real' ? 'REAL' : 'PAPER'} SELL ${(fraction * 100).toFixed(0)}% of $${pos.tokenSymbol} — ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${reason})`,
          round4(solReceived), txid);
      }

      if (pos.status === 'CLOSED') this.unsubscribeMintIfIdle(pos.mint);
      this.persist();
      this.emitChange();
    } finally {
      pos.exitInFlight = false;
    }
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
   * (non-pump venues). PRICING ONLY — the take-profit and max-hold exits that
   * lived here were removed 2026-08-12 (no automatic sells, owner decision).
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

      // No automatic exits here — closePosition is reached only from the
      // manual sell button. takeProfitPct / maxHoldSeconds stay in the config
      // for compatibility but are inert.
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
      detail,
      copySol,
      txid,
      via: sig.via,
    });
    if (this.feed.length > FEED_LIMIT) this.feed.length = FEED_LIMIT;
    this.emitChange();
  }

  private pushHistory(record: CopyTradeRecord): void {
    this.history.unshift(record);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
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
        this.positions = raw.positions
          .filter((p: any) => p && typeof p.mint === 'string' && p.status !== 'CLOSED')
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
  if (isFiniteNum(partial.maxOpenPositions)) out.maxOpenPositions = Math.round(clamp(partial.maxOpenPositions!, 1, 50));
  if (isFiniteNum(partial.maxSlippagePct)) out.maxSlippagePct = clamp(partial.maxSlippagePct!, 1, 100);
  if (typeof partial.blockRepeatBuys === 'boolean') out.blockRepeatBuys = partial.blockRepeatBuys;
  if (isFiniteNum(partial.perWalletCooldownSec)) out.perWalletCooldownSec = clamp(partial.perWalletCooldownSec!, 0, 86400);
  if (isFiniteNum(partial.maxHoldSeconds)) out.maxHoldSeconds = clamp(partial.maxHoldSeconds!, 0, 86400);
  if (isFiniteNum(partial.takeProfitPct)) out.takeProfitPct = clamp(partial.takeProfitPct!, 0, 100000);
  return out;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const copyTrader = new CopyTraderService();
