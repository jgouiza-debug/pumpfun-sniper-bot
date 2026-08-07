import { bondingProgressPct } from './playbookRouter';

/**
 * Curve-progress watchlist. Flag: playbookRouting.
 *
 * WHY: `subscribeNewToken` delivers exactly ONE event per token — its creation,
 * at 0% bonding progress. The engine therefore only ever saw tokens at the one
 * moment the playbook says never to buy (block 0, insider-dominated), and had
 * no way to observe a token later reaching the 30-60% mid-curve zone that
 * Play 2 targets. That is a structural blindness, not a tuning problem: no
 * threshold change can make a create event reveal what happens ten minutes
 * later.
 *
 * This tracks promising creates and subscribes to their trade streams
 * (`subscribeTokenTrade`), so curve progress, unique buyers and buy pressure
 * are measured from real trades. When a token walks into the Play 2 window
 * with genuine demand, the trigger fires.
 */

export interface WatchedToken {
  mint: string;
  name?: string;
  symbol?: string;
  creator?: string;
  createdAt: number;
  addedAt: number;
  /** Latest virtual SOL reserves seen in a trade event. */
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  marketCapSol: number;
  progressPct: number;
  /** Highest progress reached — used to detect stalls. */
  peakProgressPct: number;
  lastTradeAt: number;
  trades: Array<{ at: number; buyer: string; isBuy: boolean; solAmount: number }>;
  /** Set once a Play 2 buy has fired, so it never fires twice. */
  triggered: boolean;
}

export interface WatchlistStats {
  uniqueBuyers5m: number;
  buys5m: number;
  sells5m: number;
  buyPressurePct: number;
  volume5mSol: number;
  /** Progress gained in the last 5 minutes — the curve's velocity. */
  progressVelocity5m: number;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

export class TokenWatchlist {
  private tokens = new Map<string, WatchedToken>();

  constructor(
    /** Max concurrently watched tokens. Each costs one trade subscription. */
    private maxSize = 150,
    /** Drop a token after this long with no trades — the curve is dead. */
    private staleMs = 20 * 60 * 1000,
    /** Never watch longer than this regardless of activity. */
    private maxAgeMs = 60 * 60 * 1000
  ) {}

  public has(mint: string): boolean {
    return this.tokens.has(mint);
  }

  public size(): number {
    return this.tokens.size;
  }

  public get(mint: string): WatchedToken | undefined {
    return this.tokens.get(mint);
  }

  public all(): WatchedToken[] {
    return [...this.tokens.values()];
  }

  /** @returns true when the token was newly added (caller should subscribe). */
  public add(payload: any, nowMs = Date.now()): boolean {
    const mint = payload?.mint;
    if (!mint || this.tokens.has(mint)) return false;
    if (this.tokens.size >= this.maxSize) {
      // Evict the least active rather than refusing — a stalled curve is worth
      // less than a fresh candidate.
      const victim = [...this.tokens.values()].sort((a, b) => a.lastTradeAt - b.lastTradeAt)[0];
      if (victim) this.tokens.delete(victim.mint);
    }

    const vSol = Number(payload.vSolInBondingCurve) || 0;
    this.tokens.set(mint, {
      mint,
      name: payload.name,
      symbol: payload.symbol,
      creator: payload.traderPublicKey || payload.creator,
      createdAt: nowMs,
      addedAt: nowMs,
      vSolInBondingCurve: vSol,
      vTokensInBondingCurve: Number(payload.vTokensInBondingCurve) || 0,
      marketCapSol: Number(payload.marketCapSol) || 0,
      progressPct: bondingProgressPct(vSol) ?? 0,
      peakProgressPct: bondingProgressPct(vSol) ?? 0,
      lastTradeAt: nowMs,
      trades: [],
      triggered: false,
    });
    return true;
  }

  /**
   * Folds a Helius bonding-curve account update into the token's state.
   *
   * This is the free-tier substitute for PumpPortal's paid trade stream. It
   * yields exact curve POSITION, but nothing about who traded — so demand must
   * be judged by how fast the curve fills, not by counting distinct buyers.
   */
  public recordCurveUpdate(
    update: { mint: string; vSolInBondingCurve: number; vTokensInBondingCurve: number; progressPct: number },
    nowMs = Date.now()
  ): WatchedToken | null {
    const token = this.tokens.get(update.mint);
    if (!token) return null;

    const prevVSol = token.vSolInBondingCurve;
    token.vSolInBondingCurve = update.vSolInBondingCurve;
    token.vTokensInBondingCurve = update.vTokensInBondingCurve;
    token.progressPct = update.progressPct;
    if (update.progressPct > token.peakProgressPct) token.peakProgressPct = update.progressPct;
    token.lastTradeAt = nowMs;

    // Net SOL flow since the previous update stands in for a trade: positive is
    // buying pressure, negative is someone taking money out of the curve.
    const deltaSol = update.vSolInBondingCurve - prevVSol;
    if (deltaSol !== 0) {
      token.trades.push({
        at: nowMs,
        buyer: 'curve',           // attribution is unavailable on this feed
        isBuy: deltaSol > 0,
        solAmount: Math.abs(deltaSol),
      });
      const cutoff = nowMs - FIVE_MIN_MS;
      if (token.trades.length > 400 || (token.trades[0] && token.trades[0].at < cutoff)) {
        token.trades = token.trades.filter(t => t.at >= cutoff);
      }
    }
    return token;
  }

  /** Folds a trade event into the token's state. */
  public recordTrade(payload: any, nowMs = Date.now()): WatchedToken | null {
    const token = this.tokens.get(payload?.mint);
    if (!token) return null;

    const vSol = Number(payload.vSolInBondingCurve);
    if (isFinite(vSol) && vSol > 0) {
      token.vSolInBondingCurve = vSol;
      token.progressPct = bondingProgressPct(vSol) ?? token.progressPct;
      if (token.progressPct > token.peakProgressPct) token.peakProgressPct = token.progressPct;
    }
    const vTokens = Number(payload.vTokensInBondingCurve);
    if (isFinite(vTokens) && vTokens > 0) token.vTokensInBondingCurve = vTokens;
    const mc = Number(payload.marketCapSol);
    if (isFinite(mc) && mc > 0) token.marketCapSol = mc;

    token.lastTradeAt = nowMs;
    token.trades.push({
      at: nowMs,
      buyer: payload.traderPublicKey || 'unknown',
      isBuy: payload.txType === 'buy',
      solAmount: Number(payload.solAmount) || 0,
    });

    // Keep only the trailing 5-minute window; this array is read every trade.
    const cutoff = nowMs - FIVE_MIN_MS;
    if (token.trades.length > 400 || (token.trades[0] && token.trades[0].at < cutoff)) {
      token.trades = token.trades.filter(t => t.at >= cutoff);
    }
    return token;
  }

  /**
   * Demand statistics over the trailing 5 minutes.
   * Unique BUYERS is weighted above raw volume deliberately: an estimated 41%
   * of Solana memecoin volume is wash traded, and volume is the single most
   * gameable number on chain. Distinct wallets buying is far harder to fake
   * cheaply than trade count or notional.
   */
  public stats(mint: string, nowMs = Date.now()): WatchlistStats | null {
    const token = this.tokens.get(mint);
    if (!token) return null;

    const cutoff = nowMs - FIVE_MIN_MS;
    const recent = token.trades.filter(t => t.at >= cutoff);
    const buyers = new Set<string>();
    let buys = 0, sells = 0, volume = 0;
    for (const t of recent) {
      volume += t.solAmount;
      if (t.isBuy) { buys++; buyers.add(t.buyer); } else sells++;
    }
    const total = buys + sells;

    // Progress five minutes ago, inferred by unwinding net SOL flow.
    const netSol = recent.reduce((acc, t) => acc + (t.isBuy ? t.solAmount : -t.solAmount), 0);
    const priorProgress = bondingProgressPct(token.vSolInBondingCurve - netSol) ?? token.progressPct;

    return {
      uniqueBuyers5m: buyers.size,
      buys5m: buys,
      sells5m: sells,
      buyPressurePct: total > 0 ? Number(((buys / total) * 100).toFixed(1)) : 0,
      volume5mSol: Number(volume.toFixed(4)),
      progressVelocity5m: Number((token.progressPct - priorProgress).toFixed(2)),
    };
  }

  public markTriggered(mint: string): void {
    const t = this.tokens.get(mint);
    if (t) t.triggered = true;
  }

  public remove(mint: string): void {
    this.tokens.delete(mint);
  }

  /**
   * Drops dead and aged-out tokens.
   * @returns mints that should be unsubscribed.
   */
  public prune(nowMs = Date.now()): string[] {
    const dropped: string[] = [];
    for (const [mint, t] of this.tokens) {
      const stale = nowMs - t.lastTradeAt > this.staleMs;
      const tooOld = nowMs - t.addedAt > this.maxAgeMs;
      if (stale || tooOld || t.triggered) {
        this.tokens.delete(mint);
        dropped.push(mint);
      }
    }
    return dropped;
  }
}

export const tokenWatchlist = new TokenWatchlist();
