import fs from 'fs';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { installPath } from './installPaths';
import { walletLedger } from './walletLedger';
import { tradeEventsFromLogs, type PumpTradeEvent } from './pumpEventDecoder';
import { readCurveMoment } from './curveHistory';
import {
  gatherCandidates, type ScoutCandidate, type SourceKeys, type SourceDeps, type SourceOutcome,
} from './traderSources';

/**
 * WHO TO COPY, RIGHT NOW — verified, ranked, and never taken on trust.
 *
 * The operator asked for the three most profitable Solana memecoin traders
 * active at this moment, with the best one named. The lists that claim to
 * answer that are all gameable and several are simply wrong, so this treats
 * every one of them as a source of ADDRESSES ONLY. Each candidate is then
 * walked on chain and re-measured here; the ranking uses nothing a vendor said.
 *
 * THE FIVE WAYS A PROFITABLE-LOOKING WALLET IS USELESS TO COPY. All of these
 * pass a leaderboard and fail here, and every one of them has emptied
 * somebody's wallet:
 *
 *   1. NOT TRADING ANY MORE. The best trader of last month is not a signal
 *      today. "Active right now" was the explicit ask and it is the first gate.
 *   2. ONE LUCKY TOKEN. A wallet up 400 SOL, 390 of it from a single mint, is
 *      one correct call and a lot of noise. Copying it buys the noise.
 *   3. TOO BIG TO COPY. A wallet whose median entry is 40 SOL moves the curve
 *      by buying. The follower fills into that move — the copier's return is
 *      structurally worse than the trader's, and the bigger the trader, the
 *      worse it gets. This is the one a leaderboard actively selects FOR.
 *   4. FASTER THAN US. A wallet holding for four seconds is arbitraging or
 *      running MEV. We land one to two slots behind the leader on a good day;
 *      by the time our buy confirms, theirs has been sold.
 *   5. THE INSIDER. A wallet that is consistently the first buyer of tokens
 *      seconds after they are created is not finding them, it is launching them
 *      or was told. Its edge does not transfer to anyone downstream.
 *
 * WHAT IT CANNOT SEE, stated because it bounds every number below. Realized PnL
 * is computed from pump.fun bonding-curve trades only. A wallet that buys on
 * the curve and sells on Raydium after graduation shows here as an open
 * position, not a win — the AMM's event layout is not something this file can
 * verify, and guessing it to credit somebody with a profit is how a bad
 * recommendation gets made. So these figures are a LOWER BOUND on a trader's
 * performance, biased against wallets that hold through graduation, and the
 * report says so where the operator can read it.
 */

export interface TraderStats {
  wallet: string;
  sources: string[];
  label?: string;
  /** What the leaderboard claimed, for contrast. Never ranked on. */
  claimedRealizedSol?: number;

  // ---- everything below is measured here, from chain data ----
  /** Net SOL out minus SOL in, over positions this wallet fully closed. */
  realizedSol: number;
  /** Positions where they sold everything they bought. The only ones with an answer. */
  closedTrades: number;
  /** Closed positions that made money. */
  wins: number;
  /** Laplace-corrected, so eight-for-eight does not outrank forty-for-fifty. */
  winRate: number;
  /** Median seconds from first buy to last sell, over closed positions. */
  medianHoldSeconds: number;
  /** Median SOL per entry. Drives the too-big-to-copy check. */
  medianBuySol: number;
  /** Distinct mints touched in the window walked. */
  distinctMints: number;
  /** Share of total profit from the single best mint, 0-1. */
  topMintProfitShare: number;
  /** Newest trade seen, ms. */
  lastTradeAt: number;
  /** Hours since that trade. */
  idleHours: number;
  /** Share of sampled entries where they were among the very first buyers, 0-1. */
  frontOfQueueShare?: number;
  /** Positions still open. Their outcome is unknown, so they are not counted either way. */
  openPositions: number;

  /** Every check this wallet failed. Empty means copyable. */
  disqualifiers: string[];
  /** 0-1. Only meaningful when disqualifiers is empty. */
  score: number;
  /** RPC reads spent verifying it. */
  reads: number;
}

export interface ScoutReport {
  ranAt: number;
  /** The one to copy. Null when nothing survived verification. */
  best: TraderStats | null;
  /** Up to three, best first. */
  top: TraderStats[];
  /** Everything that was checked and why it did not make it. */
  rejected: TraderStats[];
  considered: number;
  sourceOutcomes: SourceOutcome[];
  reads: number;
  /** Plain-language caveats shown with the result. Never omitted. */
  notes: string[];
  stoppedEarly?: string;
}

// ---------------------------------------------------------------------------
// The bars. Every one is a number an operator can argue with, and the reasoning
// is here rather than in a commit message nobody will find.
// ---------------------------------------------------------------------------

/**
 * "Active at that period of time" — the operator's own words, made numeric.
 *
 * Six hours, not twenty-four. Memecoin traders rotate wallets constantly, often
 * daily; a wallet quiet for a day is as likely to be abandoned as resting, and
 * copying an abandoned wallet is copying nothing while paying to watch it.
 */
export const MAX_IDLE_HOURS = 6;
/** Closed positions needed before a win rate means anything. Matches walletLedger. */
export const MIN_CLOSED_TRADES = 8;
/** Laplace prior. Eight phantom losses, so a 3-for-3 wallet scores 0.27, not 1.0. */
export const PRIOR_TRIALS = 8;
/**
 * Profit concentration ceiling.
 *
 * Above 60% from one mint the wallet has made one correct call, and the rest of
 * its trades — the ones we would actually be copying, since that call is in the
 * past — are not demonstrably better than noise.
 */
export const MAX_TOP_MINT_SHARE = 0.6;
/**
 * The biggest median entry worth following, SOL.
 *
 * A 15 SOL buy into a bonding curve holding 40 SOL of real liquidity moves the
 * price by a third before a follower's transaction is even built. Beyond this
 * we are not copying their entry, we are providing their exit liquidity.
 */
export const MAX_COPYABLE_BUY_SOL = 15;
/** And a floor: a wallet risking 0.02 SOL a go is testing, not trading. */
export const MIN_SERIOUS_BUY_SOL = 0.1;
/**
 * The shortest hold we can copy, seconds.
 *
 * We land one to two slots behind the leader — 350 to 700 ms — and that is the
 * good case, from a residential connection with no co-location. Thirty seconds
 * leaves room for that plus the time to notice, decide and confirm. Below it we
 * would be buying what they are already selling.
 */
export const MIN_HOLD_SECONDS = 30;
/**
 * Share of entries at the very front of the queue that marks an insider.
 *
 * Being first once is luck. Being among the first handful of buyers on most of
 * your tokens means you knew before anyone could have looked — you launched it,
 * or you were told. Either way the edge does not survive being copied.
 */
export const MAX_FRONT_OF_QUEUE_SHARE = 0.6;
/** Buyers ahead of you that still counts as "the front". */
export const FRONT_OF_QUEUE_RANK = 6;

/** Signature pages walked per candidate. */
export const MAX_PAGES_PER_TRADER = 3;
/** Transactions read per candidate. The expensive call. */
export const MAX_TX_READS_PER_TRADER = 150;
/** Mints sampled per candidate for the insider check. */
export const QUEUE_SAMPLE_MINTS = 5;
/** Candidates verified in one run. */
export const MAX_CANDIDATES_VERIFIED = 25;
/** Total RPC reads one scout run may spend. */
export const DEFAULT_SCOUT_READ_BUDGET = 6_000;
/** Pause between reads. Research pace, not race pace. */
export const READ_SPACING_MS = 120;

export interface ScoutDeps {
  getConnection: () => Connection | null;
  fetch: typeof fetch;
  isBusy?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export interface ScoutOptions {
  readBudget?: number;
  maxCandidates?: number;
  /** Skip the per-mint queue sample. Cheaper, but the insider check goes with it. */
  checkQueuePosition?: boolean;
}

export async function runScout(
  keys: SourceKeys,
  deps: ScoutDeps,
  opts: ScoutOptions = {},
): Promise<ScoutReport> {
  const now = deps.now ?? (() => Date.now());
  const sourceDeps: SourceDeps = { fetch: deps.fetch, now: deps.now };
  let budget = Math.max(1, opts.readBudget ?? DEFAULT_SCOUT_READ_BUDGET);
  const spend = (n: number) => { if (budget < n) return false; budget -= n; return true; };

  const report: ScoutReport = {
    ranAt: now(),
    best: null,
    top: [],
    rejected: [],
    considered: 0,
    sourceOutcomes: [],
    reads: 0,
    notes: [
      'Every figure below is measured from chain data by this bot. The leaderboards supplied addresses only — none of their numbers were used to rank anything.',
      'PnL covers pump.fun bonding-curve trades. A wallet that sells after graduation on an AMM shows the position as still open, so these are a LOWER BOUND, biased against traders who hold through graduation.',
      `"Active" means a trade in the last ${MAX_IDLE_HOURS} hours.`,
    ],
  };

  const { candidates, outcomes } = await gatherCandidates(keys, sourceDeps);
  report.sourceOutcomes = outcomes;
  report.considered = candidates.length;
  if (!candidates.length) {
    report.notes.push('No source produced a candidate. Nothing was verified, and nothing is being recommended.');
    return report;
  }

  // Sources that name a wallet twice are worth checking first — not because
  // agreement is evidence of skill, but because the verification budget is
  // finite and has to be spent in some order.
  const ordered = [...candidates].sort((a, b) => b.sources.length - a.sources.length);
  const limit = Math.min(ordered.length, opts.maxCandidates ?? MAX_CANDIDATES_VERIFIED);

  const verified: TraderStats[] = [];
  for (const c of ordered.slice(0, limit)) {
    if (budget <= 0) { report.stoppedEarly = 'read budget exhausted'; break; }
    if (deps.isBusy?.()) { report.stoppedEarly = 'trading path busy'; break; }
    const stats = await verifyTrader(c, deps, spend, {
      checkQueuePosition: opts.checkQueuePosition !== false,
    });
    if (!stats) continue;
    report.reads += stats.reads;
    verified.push(stats);
  }

  const clean = verified.filter(v => v.disqualifiers.length === 0);
  clean.sort((a, b) => b.score - a.score);
  report.top = clean.slice(0, 3);
  report.best = report.top[0] ?? null;
  report.rejected = verified.filter(v => v.disqualifiers.length > 0)
    .sort((a, b) => b.realizedSol - a.realizedSol);

  if (!report.best) {
    report.notes.push(
      `${verified.length} wallet(s) were checked and none passed. That is a normal outcome — `
      + 'the bars exist because most profitable-looking wallets cannot be copied profitably.');
  }
  deps.log?.('info',
    `🔎 Scout: ${report.considered} candidate(s), ${verified.length} verified, `
    + `${clean.length} copyable, ${report.reads} RPC reads`);
  return report;
}

// ---------------------------------------------------------------------------

interface Position {
  mint: string;
  buySol: number;
  sellSol: number;
  tokensIn: bigint;
  tokensOut: bigint;
  firstBuyAt: number;
  lastSellAt: number;
  buys: number[];
  /** The wallet's own first buy signature, for the queue-position sample. */
  firstBuySig?: string;
  firstBuyVSol?: number;
}

/**
 * Walk one wallet and measure it.
 *
 * Returns null only when the wallet could not be read at all. A wallet that
 * reads fine and fails every bar comes back WITH its disqualifiers, because
 * "we checked this one and here is why not" is the useful answer.
 */
export async function verifyTrader(
  candidate: ScoutCandidate,
  deps: ScoutDeps,
  spend: (n: number) => boolean,
  opts: { checkQueuePosition?: boolean } = {},
): Promise<TraderStats | null> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const conn = deps.getConnection();
  if (!conn) return null;

  let owner: PublicKey;
  try { owner = new PublicKey(candidate.wallet); } catch { return null; }

  const stats: TraderStats = {
    wallet: candidate.wallet,
    sources: candidate.sources,
    ...(candidate.label ? { label: candidate.label } : {}),
    ...(candidate.claimedRealizedSol !== undefined ? { claimedRealizedSol: candidate.claimedRealizedSol } : {}),
    realizedSol: 0,
    closedTrades: 0,
    wins: 0,
    winRate: 0,
    medianHoldSeconds: 0,
    medianBuySol: 0,
    distinctMints: 0,
    topMintProfitShare: 0,
    lastTradeAt: 0,
    idleHours: Infinity,
    openPositions: 0,
    disqualifiers: [],
    score: 0,
    reads: 0,
  };

  // ---- gather the wallet's pump trades -----------------------------------
  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_TRADER; page++) {
    if (!spend(1)) break;
    if (deps.isBusy?.()) break;
    try {
      const batch = await conn.getSignaturesForAddress(owner, { limit: 1000, before });
      stats.reads++;
      for (const b of batch) if (!b.err) sigs.push(b.signature);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
    } catch {
      break;
    }
    await sleep(READ_SPACING_MS);
  }
  if (!sigs.length) {
    stats.disqualifiers.push('no readable transaction history');
    return stats;
  }

  const positions = new Map<string, Position>();
  let reads = 0;
  for (const sig of sigs) {
    if (reads >= MAX_TX_READS_PER_TRADER) break;
    if (!spend(1)) break;
    if (deps.isBusy?.()) break;
    let evs: PumpTradeEvent[] = [];
    try {
      const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      reads++;
      stats.reads++;
      if (tx?.meta && !tx.meta.err) evs = tradeEventsFromLogs(tx.meta.logMessages ?? []);
    } catch {
      continue;
    }
    for (const ev of evs) {
      // The program's own `user`, not the transaction signer — a bundler's fee
      // payer signs for wallets that are not it.
      if (ev.user !== candidate.wallet) continue;
      if (!ev.timestamp || ev.timestamp <= 0) continue;
      const sol = Number(ev.solLamports) / 1e9;
      const p = positions.get(ev.mint) ?? {
        mint: ev.mint, buySol: 0, sellSol: 0, tokensIn: 0n, tokensOut: 0n,
        firstBuyAt: Number.MAX_SAFE_INTEGER, lastSellAt: 0, buys: [],
      };
      if (ev.isBuy) {
        p.buySol += sol;
        p.tokensIn += ev.tokenRaw;
        p.buys.push(sol);
        // Signatures arrive newest-first, so each later sighting is earlier.
        if (ev.timestamp < p.firstBuyAt) {
          p.firstBuyAt = ev.timestamp;
          p.firstBuySig = sig;
          p.firstBuyVSol = Number(ev.virtualSolReserves) / 1e9;
        }
      } else {
        p.sellSol += sol;
        p.tokensOut += ev.tokenRaw;
        if (ev.timestamp > p.lastSellAt) p.lastSellAt = ev.timestamp;
      }
      positions.set(ev.mint, p);
      const atMs = ev.timestamp * 1000;
      if (atMs > stats.lastTradeAt) stats.lastTradeAt = atMs;
    }
    await sleep(READ_SPACING_MS);
  }

  if (!positions.size) {
    stats.disqualifiers.push('no pump.fun trades in the window walked');
    return stats;
  }

  // ---- measure -----------------------------------------------------------
  //
  // CLOSED means they sold at least as many tokens as they bought, within the
  // window we read. Anything else has an unknown outcome and is counted
  // neither as a win nor a loss — a wallet holding ten bags is not a wallet
  // that lost ten times, and treating it as one would reject every trader who
  // holds. The window is bounded, so a position whose buy is older than our
  // walk looks like a pure sell; those show tokensIn === 0 and are excluded.
  const holds: number[] = [];
  const allBuys: number[] = [];
  const profitByMint: number[] = [];
  let totalProfit = 0;

  for (const p of positions.values()) {
    for (const b of p.buys) allBuys.push(b);
    const closed = p.tokensIn > 0n && p.tokensOut >= p.tokensIn;
    if (!closed) { stats.openPositions++; continue; }
    const pnl = p.sellSol - p.buySol;
    stats.closedTrades++;
    stats.realizedSol += pnl;
    if (pnl > 0) {
      stats.wins++;
      totalProfit += pnl;
      profitByMint.push(pnl);
    }
    if (p.lastSellAt > p.firstBuyAt) holds.push(p.lastSellAt - p.firstBuyAt);
  }

  stats.distinctMints = positions.size;
  stats.realizedSol = round4(stats.realizedSol);
  stats.winRate = stats.closedTrades > 0
    ? clamp01(stats.wins / (stats.closedTrades + PRIOR_TRIALS))
    : 0;
  stats.medianHoldSeconds = median(holds);
  stats.medianBuySol = round4(median(allBuys));
  stats.topMintProfitShare = totalProfit > 0
    ? round4(Math.max(...profitByMint, 0) / totalProfit)
    : 0;
  stats.idleHours = stats.lastTradeAt > 0
    ? round4((now() - stats.lastTradeAt) / 3_600_000)
    : Infinity;

  // ---- the insider check -------------------------------------------------
  //
  // Sampled rather than exhaustive: five curve reads answers "is this wallet
  // usually at the very front" well enough, and the alternative is one read per
  // position on every candidate.
  if (opts.checkQueuePosition !== false) {
    const sample = [...positions.values()]
      .filter(p => p.firstBuySig && p.firstBuyAt < Number.MAX_SAFE_INTEGER)
      .sort((a, b) => b.firstBuyAt - a.firstBuyAt)
      .slice(0, QUEUE_SAMPLE_MINTS);
    let front = 0;
    let sampled = 0;
    for (const p of sample) {
      if (deps.isBusy?.()) break;
      const m = await readCurveMoment(p.mint, p.firstBuyAt * 1000, {
        getConnection: deps.getConnection,
        isBusy: deps.isBusy,
        now: deps.now,
        sleep: deps.sleep,
        spend,
      }, { vSolAtMoment: p.firstBuyVSol, maxPages: 2 });
      if (!m) continue;
      stats.reads += m.reads;
      // A capped rank is a floor, and a floor above the threshold still proves
      // they were NOT at the front — so it counts, in the direction it can.
      if (m.curveTxRank === undefined) continue;
      sampled++;
      if (m.curveTxRank <= FRONT_OF_QUEUE_RANK) front++;
    }
    if (sampled > 0) stats.frontOfQueueShare = round4(front / sampled);
  }

  // ---- the bars ----------------------------------------------------------
  const d = stats.disqualifiers;
  if (stats.idleHours > MAX_IDLE_HOURS) {
    d.push(`not trading — last pump.fun trade ${fmtHours(stats.idleHours)} ago, needs one inside ${MAX_IDLE_HOURS}h`);
  }
  if (stats.closedTrades < MIN_CLOSED_TRADES) {
    d.push(`only ${stats.closedTrades} closed position(s) visible; ${MIN_CLOSED_TRADES} needed before a win rate means anything`);
  }
  if (stats.realizedSol <= 0) {
    d.push(`realized ${stats.realizedSol} SOL on the curve over the window walked`);
  }
  if (stats.topMintProfitShare > MAX_TOP_MINT_SHARE) {
    d.push(`${Math.round(stats.topMintProfitShare * 100)}% of profit came from one token — one correct call, not a method`);
  }
  if (stats.medianBuySol > MAX_COPYABLE_BUY_SOL) {
    d.push(`median entry ${stats.medianBuySol} SOL is too large to follow — their own buy moves the curve before ours lands`);
  }
  if (stats.medianBuySol > 0 && stats.medianBuySol < MIN_SERIOUS_BUY_SOL) {
    d.push(`median entry ${stats.medianBuySol} SOL — testing, not trading`);
  }
  if (stats.medianHoldSeconds > 0 && stats.medianHoldSeconds < MIN_HOLD_SECONDS) {
    d.push(`median hold ${stats.medianHoldSeconds}s is shorter than we can copy — they would be selling before our buy confirms`);
  }
  if (stats.frontOfQueueShare !== undefined && stats.frontOfQueueShare > MAX_FRONT_OF_QUEUE_SHARE) {
    d.push(`first in the queue on ${Math.round(stats.frontOfQueueShare * 100)}% of sampled entries — this wallet is being told, or is launching`);
  }

  stats.score = d.length === 0 ? scoreOf(stats) : 0;
  return stats;
}

/**
 * Rank on absolute profit, not percentage return.
 *
 * A wallet that turned 0.3 SOL into 3 has a 900% return and tops any
 * ratio-sorted board. It is also un-copyable: there is no size at which
 * following it matters, and the return came from a position too small to have
 * been a decision. Absolute realized SOL, log-scaled so a 10x difference in
 * profit is a large but not total advantage, is the honest ordering.
 */
export function scoreOf(s: TraderStats): number {
  // 30 SOL realized over the window saturates. Above that we are choosing
  // between wallets that are all clearly good, and the other terms should
  // decide.
  const profit = clamp01(Math.log1p(Math.max(0, s.realizedSol)) / Math.log1p(30));
  const rate = clamp01(s.winRate);
  // Fresher is better, on a straight ramp across the idle window.
  const fresh = clamp01(1 - s.idleHours / MAX_IDLE_HOURS);
  // Spread of profit across tokens: 1 when no single mint dominates.
  const spread = clamp01(1 - s.topMintProfitShare);
  // Size fit: peaks in the middle of the copyable band. A 0.15 SOL trader and a
  // 14 SOL trader are both harder to follow than a 2 SOL one.
  const size = clamp01(1 - Math.abs(Math.log(Math.max(s.medianBuySol, 0.01) / 2)) / Math.log(20));
  return round4(clamp01(0.4 * profit + 0.2 * rate + 0.2 * fresh + 0.1 * spread + 0.1 * size));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  // Nearest-rank, never interpolated: a reported median is a value that was
  // actually observed, matching the convention in entryProfile.
  return s[Math.min(s.length - 1, Math.floor(s.length / 2))];
}
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : n;
}
function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return 'never';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// ---------------------------------------------------------------------------
// The scheduled run, persistence, and the no-key fallback.
//
// Wired outside the functions above so those stay pure enough to test without
// a filesystem, matching how entryProfile and walletLedger are arranged.
// ---------------------------------------------------------------------------

const REPORT_FILE = installPath('.trader-scout.json');

/** How often the scheduled run fires. */
export const SCOUT_INTERVAL_MS = 60 * 60_000;
/**
 * Delay before the first run after boot.
 *
 * Long enough that a restart during a busy session does not put a research
 * walk in front of live trading while positions are still being restored.
 */
export const SCOUT_FIRST_RUN_DELAY_MS = 5 * 60_000;

let lastReport: ScoutReport | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function getLastScoutReport(): ScoutReport | null {
  return lastReport;
}

export function saveScoutReport(r: ScoutReport): void {
  lastReport = r;
  try {
    const tmp = `${REPORT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r), 'utf8');
    fs.renameSync(tmp, REPORT_FILE);
  } catch { /* best effort — an unwritable report must not stop trading */ }
}

export function loadScoutReport(): ScoutReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    if (parsed && typeof parsed.ranAt === 'number' && Array.isArray(parsed.top)) {
      lastReport = parsed as ScoutReport;
      return lastReport;
    }
  } catch { /* no report yet, or unreadable */ }
  return null;
}

/**
 * Candidates from the bot's own chain research, when no leaderboard key is set.
 *
 * The wallets the harvester promoted were earned from chain evidence, so they
 * are a legitimate — just slower — answer to "who should I follow". Feeding
 * them back through the same verification is not redundant: the ledger judges a
 * wallet on being EARLY TO WINNERS, and the scout judges it on being COPYABLE,
 * which are different questions with different answers.
 */
export function ledgerCandidates(limit = 15): ScoutCandidate[] {
  return walletLedger.all()
    .filter(w => w.state === 'promoted' || w.state === 'observed')
    .slice(0, limit)
    .map(w => ({ wallet: w.address, sources: ['on-chain research (this bot)'] }));
}

export interface ScheduledScoutDeps extends ScoutDeps {
  getKeys: () => SourceKeys;
}

/**
 * Run once, merging leaderboard candidates with the bot's own, and persist.
 *
 * Never throws: a research job that can take down the trading process is worse
 * than one that reports it had a bad day.
 */
export async function runScoutOnce(
  deps: ScheduledScoutDeps,
  opts: ScoutOptions = {},
): Promise<ScoutReport | null> {
  if (running) return lastReport;
  running = true;
  try {
    const keys = deps.getKeys();
    const report = await runScout(keys, deps, opts);
    // Fold in the bot's own roster whichever way the sources went. When they
    // worked this is a second opinion; when they did not it is the only one.
    const extra = ledgerCandidates().filter(c => !seenIn(report, c.wallet));
    if (extra.length) {
      const budgetLeft = Math.max(0, (opts.readBudget ?? DEFAULT_SCOUT_READ_BUDGET) - report.reads);
      if (budgetLeft > 200) {
        const spend = makeSpender(budgetLeft);
        for (const c of extra.slice(0, 8)) {
          if (deps.isBusy?.()) break;
          const s = await verifyTrader(c, deps, spend, { checkQueuePosition: opts.checkQueuePosition !== false });
          if (!s) continue;
          report.reads += s.reads;
          if (s.disqualifiers.length === 0) report.top.push(s); else report.rejected.push(s);
          report.considered++;
        }
        report.top.sort((a, b) => b.score - a.score);
        report.top = report.top.slice(0, 3);
        report.best = report.top[0] ?? null;
      }
    }
    saveScoutReport(report);
    return report;
  } catch (err: any) {
    deps.log?.('warn', `🔎 Scout run failed: ${err?.message ?? err}`);
    return lastReport;
  } finally {
    running = false;
  }
}

function seenIn(r: ScoutReport, wallet: string): boolean {
  return r.top.some(t => t.wallet === wallet) || r.rejected.some(t => t.wallet === wallet);
}
function makeSpender(n: number): (k: number) => boolean {
  let left = n;
  return (k: number) => { if (left < k) return false; left -= k; return true; };
}

/** Start the hourly run. Idempotent. */
export function startScoutSchedule(deps: ScheduledScoutDeps, opts: ScoutOptions = {}): void {
  if (timer) return;
  const tick = () => { void runScoutOnce(deps, opts); };
  setTimeout(tick, SCOUT_FIRST_RUN_DELAY_MS).unref?.();
  timer = setInterval(tick, SCOUT_INTERVAL_MS);
  timer.unref?.();
}

export function stopScoutSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
