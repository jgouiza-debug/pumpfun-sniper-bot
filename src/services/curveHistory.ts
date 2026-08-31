import type { Connection } from '@solana/web3.js';
import { tradeEventsFromLogs, type PumpTradeEvent } from './pumpEventDecoder';
import { bondingCurveFor } from './walletHarvester';
import { bondingProgressPct } from './playbookRouter';

/**
 * WHAT A TOKEN LOOKED LIKE AT ONE MOMENT — read from the chain, for any moment.
 *
 * The entry profile needs 40 tokens that proven traders bought. Waiting to
 * watch 40 of those happen live is weeks of sitting still, and it is also
 * unnecessary: those buys already happened, and the chain still has them. For a
 * pump.fun mint the bonding curve PDA is touched by every single trade, so
 * `getSignaturesForAddress` on that one account is the token's complete trading
 * history, in order, with block times. That is the whole trick.
 *
 * ONE FUNCTION, BOTH POPULATIONS, AND THAT IS THE POINT.
 *
 * The profile works by comparing tokens the good traders TOOK against ones they
 * PASSED ON. If the two sides are measured differently the comparison is
 * meaningless — worse than meaningless, because it produces a confident band
 * that encodes the measurement difference rather than anyone's judgement. The
 * live path's `uniqueBuyers5m` comes from DexScreener; if this file computed
 * something similar from chain and filed it under the same name, every derived
 * rule on that feature would be describing the gap between two vendors.
 *
 * So: the fields here are NEW fields with their own names, they are computed by
 * this function and only this function, and both sides of the comparison are
 * fed through it. Backfill passes a historical buy's block time. Live
 * enrichment passes a matched later moment (see entryBackfill's deferred
 * queue). Same code, same window, same definitions.
 *
 * WHAT IT REFUSES TO GUESS. Three things are simply not recoverable for a past
 * moment and are left undefined rather than approximated:
 *
 *   - holder distribution (top-10 share, creator holdings, bundled supply).
 *     Reconstructing it means replaying every transfer of the mint. Today's
 *     figures describe today's token, not the one that was bought.
 *   - market cap in USD. The curve gives market cap in SOL exactly, but the
 *     SOL price at that historical instant is not something we have. Pricing a
 *     three-week-old buy at today's SOL would put a real number on a fictional
 *     axis.
 *   - age, when the walk did not reach the token's first transaction. A lower
 *     bound mixed into a population of exact values does not widen the band
 *     honestly, it shifts it — so age is reported only when `sawBeginning`.
 */

/** Trades read per mint. The expensive call, so the tightest cap. */
export const MAX_WINDOW_READS = 40;
/** Signatures asked for in one page. The RPC's own maximum. */
export const SIG_PAGE_LIMIT = 1000;
/**
 * The activity window, ms.
 *
 * Five minutes because that is the horizon a human scalper is actually reading
 * when they decide — the last few candles — and because the live market-data
 * fields the bot already collects use the same horizon, so an operator
 * comparing the two is comparing like with like even though the numbers come
 * from different places and are deliberately named differently.
 */
export const WINDOW_MS = 5 * 60_000;
/** Pause between reads. Deliberately slow: this is research, not a race. */
export const READ_SPACING_MS = 120;

export interface CurveMoment {
  mint: string;
  /** The moment this describes, ms. */
  atMs: number;
  /**
   * Seconds from the token's first curve transaction to `atMs`.
   * Present ONLY when the walk reached the beginning — never a lower bound.
   */
  ageSeconds?: number;
  /** Curve position at `atMs`, on the repo's canonical scale. */
  curveProgressPct?: number;
  /**
   * Curve transactions that landed before `atMs`. An UPPER BOUND, and named
   * for what it counts rather than for what a reader might want it to mean:
   * the bonding curve's signature list holds sells and the create transaction
   * as well as buys, and separating them costs one transaction read per
   * predecessor. Failed transactions are excluded; same-second trades are
   * included (see the note at the filter).
   */
  curveTxRank?: number;
  /** True when the rank hit the page cap and is therefore a floor, not a count. */
  rankCapped: boolean;
  /** SOL bought on the curve in the WINDOW_MS before `atMs`. */
  windowBuySol?: number;
  /** SOL sold on the curve in the same window. */
  windowSellSol?: number;
  /** Buys as a share of window flow, 0-100. */
  windowBuyPressurePct?: number;
  /** Distinct wallets that bought in the window. */
  windowBuyers?: number;
  /** Curve transactions in the window, per minute. */
  windowTradesPerMin?: number;
  /** True when the first curve transaction was seen, so age is exact. */
  sawBeginning: boolean;
  /** Set when a cap or an error stopped the walk. Never silently truncated. */
  stoppedEarly?: string;
  /** RPC reads this call consumed. */
  reads: number;
}

export interface CurveHistoryDeps {
  getConnection: () => Connection | null;
  /** True while the trading path is doing something this must not slow down. */
  isBusy?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Consume one unit of the caller's RPC budget. False = refused, stop. */
  spend?: (n: number) => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

export interface ReadMomentOptions {
  /**
   * Curve position at `atMs`, in SOL, when the caller already knows it.
   *
   * The backfiller does: the buy's own TradeEvent carries virtualSolReserves.
   * The live path does too, from the launch payload. Passing it in saves the
   * only read that would otherwise be unavoidable, and — more important — it is
   * the EXACT reserves at that instant rather than the nearest trade's.
   */
  vSolAtMoment?: number;
  /**
   * Read transactions to fill the window metrics. Costs up to MAX_WINDOW_READS
   * RPC calls; the age and rank fields cost one call whether this is set or not.
   */
  readWindow?: boolean;
  /** Signature pages to walk. Each is one RPC call and up to 1000 signatures. */
  maxPages?: number;
  /**
   * The transaction this moment IS, when the caller has one.
   *
   * Excluded from the rank so a buyer is not counted as being ahead of
   * themselves. Omit when the moment is not a particular trade.
   */
  excludeSignature?: string;
}

/**
 * Describe one mint at one moment.
 *
 * Cheap mode (`readWindow` false) is a single `getSignaturesForAddress` and
 * yields age, rank and — if the caller supplied reserves — curve progress.
 * Window mode adds up to MAX_WINDOW_READS transaction reads.
 */
export async function readCurveMoment(
  mint: string,
  atMs: number,
  deps: CurveHistoryDeps,
  opts: ReadMomentOptions = {},
): Promise<CurveMoment | null> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const spend = deps.spend ?? (() => true);
  const maxPages = Math.max(1, opts.maxPages ?? 3);

  const conn = deps.getConnection();
  const curve = bondingCurveFor(mint);
  if (!conn || !curve) return null;

  const out: CurveMoment = {
    mint,
    atMs,
    rankCapped: false,
    sawBeginning: false,
    reads: 0,
    ...(typeof opts.vSolAtMoment === 'number'
      ? { curveProgressPct: bondingProgressPct(opts.vSolAtMoment) ?? undefined }
      : {}),
  };

  // ---- pass 1: the signature spine -------------------------------------
  //
  // Newest-first, which is the only order the RPC offers. We page backwards
  // until we either run out (the beginning, and therefore an exact age) or hit
  // the page cap (a floor, and therefore no age at all).
  type Sig = { signature: string; blockTime: number };
  const sigs: Sig[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (deps.isBusy?.()) { out.stoppedEarly = 'trading path busy'; break; }
    if (!spend(1)) { out.stoppedEarly = 'read budget exhausted'; break; }
    let batch: Array<{ signature: string; blockTime?: number | null; err?: unknown }>;
    try {
      batch = await conn.getSignaturesForAddress(curve, { limit: SIG_PAGE_LIMIT, before });
      out.reads++;
    } catch (err: any) {
      out.stoppedEarly = `signature read failed: ${err?.message ?? err}`;
      break;
    }
    for (const b of batch) {
      // A FAILED TRANSACTION IS NOT A TRADE. It moved no SOL and touched no
      // reserves, but it is still in the signature list — so counting it puts
      // every loser of a snipe race into the queue ahead of the winner, and a
      // hot launch's rank becomes a measure of contention rather than demand.
      if (b.err) continue;
      if (typeof b.blockTime === 'number' && b.blockTime > 0) {
        sigs.push({ signature: b.signature, blockTime: b.blockTime });
      }
    }
    // A SHORT PAGE IS THE ONLY PROOF WE SAW THE BEGINNING. A full page means
    // there is more history behind it; treating that as the start would date
    // every busy token to whenever our window happened to end.
    if (batch.length < SIG_PAGE_LIMIT) { out.sawBeginning = true; break; }
    before = batch[batch.length - 1]?.signature;
    if (!before) { out.stoppedEarly = 'page returned no cursor'; break; }
    if (page === maxPages - 1) { out.stoppedEarly = 'page cap reached'; out.rankCapped = true; }
    await sleep(READ_SPACING_MS);
  }

  if (!sigs.length) {
    if (!out.stoppedEarly) out.stoppedEarly = 'no curve transactions visible';
    return out;
  }

  const atSec = Math.floor(atMs / 1000);
  // BLOCK TIME HAS ONE-SECOND GRANULARITY, and a hot launch puts dozens of
  // buys inside one second. A strict `<` therefore drops every same-second
  // predecessor — understating the rank most severely exactly where the rank
  // carries the most information, and making an ordinary buyer on a contested
  // launch look like they were at the front.
  //
  // `<=` counts the moment's own second as ahead of us. That over-counts by
  // however many trades landed in the same second AFTER the one being
  // described, which is the safe direction: the rank is documented as an upper
  // bound, and a buyer wrongly placed further back is not mistaken for an
  // insider. Exact intra-slot ordering needs getBlock and is not worth an RPC
  // call per predecessor here.
  //
  // The moment's OWN transaction is excluded by signature rather than by
  // subtracting one, because whether it is in this list at all depends on the
  // caller: a backfilled entry is one of the mint's trades, a sampled control
  // is an instant at which nobody in particular bought. Blanket-subtracting
  // would have been right for the first and wrong for the second.
  const before_ = sigs.filter(s => s.blockTime <= atSec && s.signature !== opts.excludeSignature);
  out.curveTxRank = before_.length;
  if (out.rankCapped) {
    // The rank is a floor. Reported anyway — "at least 3000 trades ahead of
    // you" is real information — but flagged so a consumer can refuse it.
  }

  if (out.sawBeginning) {
    const first = Math.min(...sigs.map(s => s.blockTime));
    const age = atSec - first;
    // A negative age means the moment predates the token, which means the
    // caller passed the wrong mint or the wrong time. Never record it.
    if (age >= 0) out.ageSeconds = age;
  }

  if (!opts.readWindow) return out;

  // ---- pass 2: the window ----------------------------------------------
  //
  // The trades in the five minutes before the moment. Read newest-first from
  // the window's end so a truncated walk loses the OLDEST part of the window
  // rather than a random slice — a partial window that is missing its tail is
  // still a coherent "the run-up immediately before", which is the thing being
  // measured.
  const windowStart = atSec - Math.floor(WINDOW_MS / 1000);
  const inWindow = before_
    .filter(s => s.blockTime >= windowStart)
    .sort((a, b) => b.blockTime - a.blockTime)
    .slice(0, MAX_WINDOW_READS);

  if (!inWindow.length) {
    // Genuinely quiet, not unread. Zero flow is a real observation about a
    // token nobody is trading, and it is exactly the kind of token a good
    // trader passes on — so it is recorded as zero, not as unknown.
    out.windowBuySol = 0;
    out.windowSellSol = 0;
    out.windowBuyers = 0;
    out.windowTradesPerMin = 0;
    out.windowBuyPressurePct = undefined;   // no flow means no ratio, not 0%
    return out;
  }

  let buySol = 0;
  let sellSol = 0;
  let trades = 0;
  const buyers = new Set<string>();
  let truncated = false;

  for (const s of inWindow) {
    if (deps.isBusy?.()) { truncated = true; out.stoppedEarly = 'trading path busy'; break; }
    if (!spend(1)) { truncated = true; out.stoppedEarly = 'read budget exhausted'; break; }
    let evs: PumpTradeEvent[] = [];
    try {
      const tx = await conn.getTransaction(s.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      out.reads++;
      // A failed transaction moved no SOL. Counting it as demand is how a
      // failed-buy storm reads as a token being aggressively bought.
      if (tx?.meta && !tx.meta.err) evs = tradeEventsFromLogs(tx.meta.logMessages ?? []);
    } catch {
      // One unreadable transaction is not a reason to throw away the window;
      // it is a reason to know the window is incomplete.
      truncated = true;
      continue;
    }
    for (const ev of evs) {
      if (ev.mint !== mint) continue;
      trades++;
      const sol = Number(ev.solLamports) / 1e9;
      if (ev.isBuy) { buySol += sol; buyers.add(ev.user); } else { sellSol += sol; }
    }
    await sleep(READ_SPACING_MS);
  }

  if (truncated && !out.stoppedEarly) out.stoppedEarly = 'window walk incomplete';

  // A TRUNCATED WINDOW IS NOT A SMALL WINDOW. Reporting the partial sums would
  // put "0.4 SOL of buying" next to a token that actually saw forty, and the
  // learner cannot tell the difference. Everything that depends on seeing the
  // whole window is withheld; the rank and age above do not, so they stand.
  if (truncated) return out;

  const flow = buySol + sellSol;
  out.windowBuySol = round4(buySol);
  out.windowSellSol = round4(sellSol);
  out.windowBuyers = buyers.size;
  out.windowTradesPerMin = round4(trades / (WINDOW_MS / 60_000));
  out.windowBuyPressurePct = flow > 0 ? round4((buySol / flow) * 100) : undefined;
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
