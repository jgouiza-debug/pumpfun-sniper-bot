import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { tradeEventsFromLogs, PUMP_TOKEN_DECIMALS } from './pumpEventDecoder';
import { walletLedger } from './walletLedger';

/**
 * THE RESEARCH STEP — find out who was early to the tokens that ran.
 *
 * This is the half of "follow proven traders" that does the proving. The ledger
 * holds evidence; this produces it, by going back to a token that actually went
 * up and reading who bought it in the first minute.
 *
 * WHY THIS SHAPE, given no paid indexer. The obvious source is a wallet-PnL
 * API, and every one of them is a paid product. What IS free is the chain
 * itself: for a pump.fun mint, the bonding curve account carries every trade,
 * and the pump program emits a fully-specified Anchor TradeEvent into the logs
 * of each one — mint, buyer, direction, lamports. So the earliest buyers of a
 * winner are recoverable with a bounded walk and no third party at all, using
 * the same decoder the copy trader's fast lane already runs.
 *
 * WHY IT IS SO CAREFULLY BOUNDED. This runs in the same process, on the same
 * RPC key, as live trading. The repo has already been bitten once by exactly
 * this: local transaction building was demoted from the default because its
 * extra per-trade RPC calls burst-limited a shared Helius key and slowed both
 * the trades AND the leader watcher using that key. A research job that does
 * that is worse than no research job — so every knob here is a ceiling, the
 * whole thing yields to live trading, and it never runs on the hot path.
 *
 *   - at most MAX_PAGES signature pages per mint
 *   - at most MAX_TX_READS parsed transactions per mint
 *   - at most one mint in flight at a time
 *   - a global hourly budget of RPC reads, refused rather than queued
 *   - a caller-supplied `isBusy()` that stops a harvest mid-walk
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide which mints ran; the
 * caller does, from data it already has. It does not touch the ledger's
 * promotion rules. And it does not follow non-pump venues: a mint that
 * graduated is read up to its graduation and no further, because the AMM's
 * event layout is not something this file can verify from here, and guessing a
 * layout to credit a wallet with a win is how a bad promotion gets made.
 */

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** Signature pages walked back per mint. 1000 signatures each. */
const MAX_PAGES = 4;
/** Parsed transactions read per mint. The expensive call, so the tightest cap. */
const MAX_TX_READS = 60;
/** How many of a token's first buyers count as "early". */
const EARLY_BUYER_LIMIT = 25;
/** A buy smaller than this is dust or a bot probe, not a call worth crediting. */
const MIN_EARLY_BUY_SOL = 0.05;
/** RPC reads this job may make per rolling hour, across every mint. */
const HOURLY_READ_BUDGET = 400;
/** Pause between reads. Deliberately slow: this is research, not a race. */
const READ_SPACING_MS = 120;

export interface HarvestResult {
  mint: string;
  /** Wallets credited, in buy order. */
  earlyBuyers: string[];
  /** RPC reads this harvest consumed. */
  reads: number;
  /** Set when the walk stopped short, with the reason — never silently truncated. */
  stoppedEarly?: string;
}

export interface HarvesterDeps {
  getConnection: () => Connection | null;
  /** True while the trading path is doing something this must not slow down. */
  isBusy: () => boolean;
  log?: (level: 'info' | 'warn', msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/** The bonding curve PDA — the account every trade for a pump mint touches. */
export function bondingCurveFor(mint: string): PublicKey | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM,
    );
    return pda;
  } catch {
    return null;
  }
}

export class WalletHarvester {
  private readsThisHour: number[] = [];
  private inFlight = false;
  /** Mints already harvested. Re-reading one buys nothing and costs the budget. */
  private done = new Set<string>();

  constructor(private deps: HarvesterDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? defaultSleep)(ms); }

  /** Reads left in the rolling hour. Exposed so the UI can show the budget. */
  public budgetRemaining(): number {
    const cutoff = this.now() - 3_600_000;
    this.readsThisHour = this.readsThisHour.filter(t => t > cutoff);
    return Math.max(0, HOURLY_READ_BUDGET - this.readsThisHour.length);
  }

  private spend(): boolean {
    if (this.budgetRemaining() <= 0) return false;
    this.readsThisHour.push(this.now());
    return true;
  }

  public hasHarvested(mint: string): boolean {
    return this.done.has(mint);
  }

  /**
   * Read a mint's earliest buyers and credit them in the ledger.
   *
   * `wasWinner` is the caller's verdict on how the token turned out, and it is
   * recorded either way ON PURPOSE. Crediting only winners would measure how
   * often a wallet appears early, which every high-frequency bot on the chain
   * would win; what matters is the RATIO, and that needs the losers too.
   */
  public async harvest(mint: string, wasWinner: boolean): Promise<HarvestResult | null> {
    if (this.inFlight) return null;              // one at a time, always
    if (this.done.has(mint)) return null;
    const conn = this.deps.getConnection();
    if (!conn) return null;
    if (this.budgetRemaining() <= 0) {
      this.deps.log?.('warn', `[Harvester] Hourly read budget spent — skipping ${mint.slice(0, 8)}… until it refills.`);
      return null;
    }

    const curve = bondingCurveFor(mint);
    if (!curve) return null;

    this.inFlight = true;
    let reads = 0;
    let stoppedEarly: string | undefined;

    try {
      // ---- 1. Walk back to the oldest signatures we can reach -------------
      //
      // getSignaturesForAddress returns NEWEST first, so reaching a token's
      // first buyers means paging backwards with `before`. A token that ran has
      // thousands of trades, which is why this is capped: four pages is the
      // most recent 4000 trades, and if the launch is further back than that we
      // say so rather than crediting whoever we happened to reach.
      let all: Array<{ signature: string; blockTime: number | null }> = [];
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (this.deps.isBusy()) { stoppedEarly = 'trading path busy'; break; }
        if (!this.spend()) { stoppedEarly = 'hourly read budget spent'; break; }
        reads++;
        const batch = await conn.getSignaturesForAddress(curve, { limit: 1000, ...(before ? { before } : {}) });
        if (!batch.length) break;
        all = all.concat(batch.map(s => ({ signature: s.signature, blockTime: s.blockTime ?? null })));
        before = batch[batch.length - 1].signature;
        if (batch.length < 1000) break;          // reached the beginning
        await this.sleep(READ_SPACING_MS);
      }
      if (!all.length) {
        // A COMPLETED walk that found nothing is done with — the curve has no
        // trades to read and asking again tomorrow will not change that. A walk
        // that was CUT SHORT is not: the budget refills and the trading path
        // goes quiet, so that mint stays eligible for a later attempt. Marking
        // both as done would silently abandon research the caller asked for.
        if (!stoppedEarly) this.done.add(mint);
        return { mint, earlyBuyers: [], reads, ...(stoppedEarly ? { stoppedEarly } : {}) };
      }

      // Oldest first — the order the token was actually bought in.
      all.reverse();

      // ---- 2. Read the earliest transactions and decode the buyers --------
      const buyers: string[] = [];
      const seen = new Set<string>();
      for (const sig of all.slice(0, MAX_TX_READS)) {
        if (buyers.length >= EARLY_BUYER_LIMIT) break;
        if (this.deps.isBusy()) { stoppedEarly = 'trading path busy'; break; }
        if (!this.spend()) { stoppedEarly = 'hourly read budget spent'; break; }
        reads++;
        let tx;
        try {
          tx = await conn.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
        } catch {
          await this.sleep(READ_SPACING_MS);
          continue;                                // one unreadable tx is not a reason to stop
        }
        const logs = tx?.meta?.logMessages ?? [];
        // The SAME decoder the copy trader's fast lane runs. A second
        // implementation of this parsing is a second thing that can be subtly
        // wrong about who bought what.
        for (const ev of tradeEventsFromLogs(logs)) {
          if (!ev.isBuy) continue;
          if (ev.mint !== mint) continue;
          const sol = Number(ev.solLamports) / 1e9;
          if (sol < MIN_EARLY_BUY_SOL) continue;
          if (seen.has(ev.user)) continue;         // one credit per wallet per token
          seen.add(ev.user);
          buyers.push(ev.user);
          // Recorded as an observed buy too, so a wallet the confluence
          // detector later sees live already has a history.
          walletLedger.recordBuy(ev.user, mint, sol, sig.blockTime ? sig.blockTime * 1000 : this.now());
        }
        await this.sleep(READ_SPACING_MS);
      }

      for (const b of buyers) walletLedger.recordEarlyCall(b, mint, wasWinner, this.now());
      // Same rule as the empty case: only a walk that ran to its own end is
      // finished. One stopped by the budget or by live trading is retryable.
      if (!stoppedEarly) this.done.add(mint);

      this.deps.log?.('info',
        `[Harvester] ${mint.slice(0, 8)}… (${wasWinner ? 'WINNER' : 'dud'}): credited ${buyers.length} early buyers `
        + `from ${reads} reads${stoppedEarly ? ` — stopped early: ${stoppedEarly}` : ''}.`);

      return { mint, earlyBuyers: buyers, reads, ...(stoppedEarly ? { stoppedEarly } : {}) };
    } catch (err: any) {
      this.deps.log?.('warn', `[Harvester] ${mint.slice(0, 8)}… failed: ${err?.message ?? err}`);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  /** Tests only. */
  public reset(): void {
    this.readsThisHour = [];
    this.done.clear();
    this.inFlight = false;
  }
}

export const HARVESTER_LIMITS = {
  MAX_PAGES,
  MAX_TX_READS,
  EARLY_BUYER_LIMIT,
  MIN_EARLY_BUY_SOL,
  HOURLY_READ_BUDGET,
  READ_SPACING_MS,
  PUMP_TOKEN_DECIMALS,
} as const;
