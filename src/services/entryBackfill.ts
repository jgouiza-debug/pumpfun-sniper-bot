import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { tradeEventsFromLogs, type PumpTradeEvent, PUMP_PROGRAM_ID } from './pumpEventDecoder';
import { readCurveMoment, type CurveHistoryDeps, type CurveMoment, READ_SPACING_MS } from './curveHistory';
import { entryProfile, type TokenSnapshot } from './entryProfile';

/**
 * THE PROFILE, WITHOUT THE WAIT.
 *
 * The entry profile needs 40 tokens that proven traders bought and a few
 * hundred they passed on. Watching that happen live is weeks. It is also
 * pointless, because those decisions are already on the chain — a wallet's
 * buys, the exact reserves at each one, and what else was trading in the same
 * second. This walks back and rebuilds them.
 *
 * IT PRODUCES BOTH SIDES, AND THAT IS THE WHOLE DESIGN.
 *
 * The naive version backfills only the entries and reuses the bot's live
 * screening snapshots as the control group. That produces a profile that looks
 * excellent and means nothing, because the two halves are measured at
 * different points in a token's life: live snapshots are taken seconds after
 * launch (that is when the pipeline runs), backfilled entries at whatever
 * minute the trader actually bought. Every feature then separates on WHEN WE
 * LOOKED. `ageSeconds` would separate almost perfectly and the deriver would
 * report it as the strongest rule it had ever seen.
 *
 * So each backfilled entry brings its own matched control: other pump.fun
 * tokens that were being traded in the SAME SECOND, read at the SAME moment,
 * through the SAME function. The comparison is then between tokens, which is
 * the only comparison worth making.
 *
 * WHAT THE CONTROL GROUP ACTUALLY IS, stated plainly because it shapes every
 * rule derived from it: tokens with a trade landing within the same ~second,
 * which over-represents busy tokens and under-represents dead ones. That is
 * deliberate. The alternatives a trader was really choosing between are the
 * ones visible enough to have any flow at all; a control group of thousands of
 * dead-on-arrival launches would make "has any buyers" the top rule and teach
 * the bot nothing it did not already know.
 */

const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);

/** Signature pages walked per wallet. 1000 signatures each. */
export const MAX_WALLET_PAGES = 3;
/** Transactions read per wallet while hunting for its buys. */
export const MAX_WALLET_TX_READS = 120;
/** Entries taken from any ONE wallet. */
export const MAX_ENTRIES_PER_WALLET = 15;
/**
 * A buy smaller than this is not an opinion.
 *
 * Matches walletHarvester's early-call floor. Dust buys are bot probes and
 * airdrop-farming noise; learning a band from them teaches the shape of
 * somebody's scanner, not their strategy.
 */
export const MIN_BUY_SOL = 0.05;
/** Control tokens sampled per entry. 5 x 40 entries clears MIN_SKIPPED_SAMPLES. */
export const CONTROLS_PER_ENTRY = 5;
/** Pump transactions pulled around an entry to find control mints. */
export const CONTROL_SCAN_LIMIT = 60;
/** Transactions read per entry while hunting for control mints. */
export const MAX_CONTROL_TX_READS = 12;
/**
 * Total RPC reads one backfill run may make.
 *
 * ~10k covers 40 entries and 200 matched controls with window metrics on. It
 * is a ceiling, not a target: the run reports what it spent and stops dead
 * rather than quietly borrowing from the trading path's rate limit.
 */
export const DEFAULT_READ_BUDGET = 12_000;

export interface BackfillProgress {
  wallet: string;
  entriesRecorded: number;
  controlsRecorded: number;
  reads: number;
}

export interface BackfillResult {
  wallets: string[];
  entriesRecorded: number;
  controlsRecorded: number;
  reads: number;
  /** Why the run ended, when it was not simply finished. */
  stoppedEarly?: string;
  /** Buys seen but not turned into a snapshot, by reason. Never silent. */
  rejected: Record<string, number>;
  startedAt: number;
  finishedAt: number;
}

export interface BackfillDeps extends CurveHistoryDeps {
  log?: (level: 'info' | 'warn', msg: string) => void;
  onProgress?: (p: BackfillProgress) => void;
}

export interface BackfillOptions {
  /** Fill the 5-minute on-chain window metrics. Costs most of the budget. */
  readWindow?: boolean;
  /** Total RPC reads allowed across the whole run. */
  readBudget?: number;
  /** Stop after this many entries across all wallets. */
  maxEntries?: number;
  /** Controls sampled per entry. 0 skips the control side entirely. */
  controlsPerEntry?: number;
}

/**
 * Rebuild entry evidence from the chain history of the given wallets.
 *
 * Wallets should already be VERIFIED — this reads whatever it is pointed at
 * and does not judge. Pointing it at an unproven address teaches the profile
 * that address's habits, which is why the only caller is the scout's
 * post-verification path and the operator-triggered endpoint.
 */
export async function backfillFromWallets(
  wallets: string[],
  deps: BackfillDeps,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const readWindow = opts.readWindow !== false;
  const maxEntries = Math.max(1, opts.maxEntries ?? 200);
  const controlsPer = Math.max(0, opts.controlsPerEntry ?? CONTROLS_PER_ENTRY);

  let budget = Math.max(1, opts.readBudget ?? DEFAULT_READ_BUDGET);
  const spend = (n: number) => {
    if (budget < n) return false;
    budget -= n;
    return true;
  };
  const curveDeps: CurveHistoryDeps = {
    getConnection: deps.getConnection,
    isBusy: deps.isBusy,
    now: deps.now,
    sleep: deps.sleep,
    spend,
  };

  const result: BackfillResult = {
    wallets: [],
    entriesRecorded: 0,
    controlsRecorded: 0,
    reads: 0,
    rejected: {},
    startedAt: now(),
    finishedAt: 0,
  };
  const reject = (why: string) => { result.rejected[why] = (result.rejected[why] ?? 0) + 1; };

  // Mints any of these wallets ever bought. A "control" that one of them
  // actually took is not a control, it is a mislabelled entry — and one that
  // would push the two populations toward each other, weakening every rule.
  const boughtMints = new Set<string>();
  const usedControls = new Set<string>();

  for (const wallet of wallets) {
    if (result.entriesRecorded >= maxEntries) break;
    if (budget <= 0) { result.stoppedEarly = 'read budget exhausted'; break; }
    result.wallets.push(wallet);

    const buys = await collectWalletBuys(wallet, deps, spend, result);
    for (const b of buys) boughtMints.add(b.ev.mint);

    for (const buy of buys) {
      if (result.entriesRecorded >= maxEntries) break;
      if (budget <= 0) { result.stoppedEarly = 'read budget exhausted'; break; }
      if (deps.isBusy?.()) { result.stoppedEarly = 'trading path busy'; break; }

      const atMs = buy.ev.timestamp * 1000;
      const vSol = Number(buy.ev.virtualSolReserves) / 1e9;
      const moment = await readCurveMoment(buy.ev.mint, atMs, curveDeps, {
        vSolAtMoment: vSol,
        readWindow,
        excludeSignature: buy.signature,
      });
      if (!moment) { reject('curve unreadable'); continue; }
      result.reads += moment.reads;

      const snap = snapshotFromMoment(moment, {
        devBuySol: undefined,
        entrySolSize: Number(buy.ev.solLamports) / 1e9,
      });
      if (!usable(snap)) { reject('too few recoverable features'); continue; }
      entryProfile.recordEntry(snap);
      result.entriesRecorded++;

      if (controlsPer > 0) {
        const controls = await sampleControlMints(
          buy.signature, atMs, controlsPer, boughtMints, usedControls, deps, spend, result,
        );
        for (const c of controls) {
          if (budget <= 0) break;
          const cm = await readCurveMoment(c.mint, atMs, curveDeps, {
            vSolAtMoment: c.vSol,
            readWindow,
          });
          if (!cm) { reject('control curve unreadable'); continue; }
          result.reads += cm.reads;
          const csnap = snapshotFromMoment(cm, {});
          if (!usable(csnap)) { reject('control too few features'); continue; }
          entryProfile.recordSkipped(csnap);
          result.controlsRecorded++;
          usedControls.add(c.mint);
        }
      }

      deps.onProgress?.({
        wallet,
        entriesRecorded: result.entriesRecorded,
        controlsRecorded: result.controlsRecorded,
        reads: result.reads,
      });
      await sleep(READ_SPACING_MS);
    }
  }

  result.finishedAt = now();
  deps.log?.('info',
    `📚 Backfill: ${result.entriesRecorded} entries + ${result.controlsRecorded} controls `
    + `from ${result.wallets.length} wallet(s), ${result.reads} RPC reads`
    + (result.stoppedEarly ? ` (stopped: ${result.stoppedEarly})` : ''));
  return result;
}

interface WalletBuy {
  signature: string;
  ev: PumpTradeEvent;
}

/**
 * The wallet's own pump.fun buys, newest first, ONE PER MINT.
 *
 * One per mint because a DCA ladder or an order split across transactions is
 * one decision, and counting it five times would let a single conviction
 * dominate the band the same way it would dominate a confluence count. The
 * FIRST buy is kept — their entry, not their adds, since the adds were made
 * with information the entry did not have.
 */
async function collectWalletBuys(
  wallet: string,
  deps: BackfillDeps,
  spend: (n: number) => boolean,
  result: BackfillResult,
): Promise<WalletBuy[]> {
  const conn = deps.getConnection();
  if (!conn) return [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let owner: PublicKey;
  try { owner = new PublicKey(wallet); } catch { return []; }

  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_WALLET_PAGES; page++) {
    if (!spend(1)) { result.stoppedEarly = 'read budget exhausted'; break; }
    if (deps.isBusy?.()) { result.stoppedEarly = 'trading path busy'; break; }
    try {
      const batch = await conn.getSignaturesForAddress(owner, { limit: 1000, before });
      result.reads++;
      for (const b of batch) if (!b.err) sigs.push(b.signature);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
    } catch {
      break;
    }
    await sleep(READ_SPACING_MS);
  }

  const firstByMint = new Map<string, WalletBuy>();
  let reads = 0;
  for (const sig of sigs) {
    if (reads >= MAX_WALLET_TX_READS) break;
    if (firstByMint.size >= MAX_ENTRIES_PER_WALLET) break;
    if (!spend(1)) { result.stoppedEarly = 'read budget exhausted'; break; }
    if (deps.isBusy?.()) { result.stoppedEarly = 'trading path busy'; break; }
    let evs: PumpTradeEvent[] = [];
    try {
      const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      reads++;
      result.reads++;
      if (tx?.meta && !tx.meta.err) evs = tradeEventsFromLogs(tx.meta.logMessages ?? []);
    } catch {
      continue;
    }
    for (const ev of evs) {
      // `user` is the trader the program itself recorded. Matching on the
      // transaction's signer instead would credit a bundler's fee-payer with
      // sixteen wallets' opinions.
      if (ev.user !== wallet || !ev.isBuy) continue;
      if (Number(ev.solLamports) / 1e9 < MIN_BUY_SOL) continue;
      if (!ev.timestamp || ev.timestamp <= 0) continue;
      const prev = firstByMint.get(ev.mint);
      // Signatures arrive newest-first, so each later sighting of a mint is an
      // EARLIER buy — keep overwriting and the last one written is the first
      // one made.
      if (!prev || ev.timestamp < prev.ev.timestamp) firstByMint.set(ev.mint, { signature: sig, ev });
    }
    await sleep(READ_SPACING_MS);
  }
  return [...firstByMint.values()];
}

interface ControlMint { mint: string; vSol: number; }

/**
 * Tokens being traded in the same second as `signature`, that these wallets
 * did not buy.
 *
 * `before` is anchored on the entry's own signature, which is what makes this
 * cheap: the pump program's signature history cannot be paged back weeks, but
 * it can be read from an exact point, and the entry gives us one.
 */
async function sampleControlMints(
  signature: string,
  atMs: number,
  want: number,
  bought: Set<string>,
  used: Set<string>,
  deps: BackfillDeps,
  spend: (n: number) => boolean,
  result: BackfillResult,
): Promise<ControlMint[]> {
  const conn = deps.getConnection();
  if (!conn) return [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  if (!spend(1)) { result.stoppedEarly = 'read budget exhausted'; return []; }
  let batch: Array<{ signature: string }>;
  try {
    batch = await conn.getSignaturesForAddress(PUMP_PROGRAM, { limit: CONTROL_SCAN_LIMIT, before: signature });
    result.reads++;
  } catch {
    return [];
  }

  const out: ControlMint[] = [];
  let reads = 0;
  for (const b of batch) {
    if (out.length >= want) break;
    if (reads >= MAX_CONTROL_TX_READS) break;
    if (!spend(1)) { result.stoppedEarly = 'read budget exhausted'; break; }
    if (deps.isBusy?.()) break;
    let evs: PumpTradeEvent[] = [];
    try {
      const tx = await conn.getTransaction(b.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      reads++;
      result.reads++;
      if (tx?.meta && !tx.meta.err) evs = tradeEventsFromLogs(tx.meta.logMessages ?? []);
    } catch {
      continue;
    }
    for (const ev of evs) {
      if (out.length >= want) break;
      if (bought.has(ev.mint) || used.has(ev.mint)) continue;
      if (out.some(c => c.mint === ev.mint)) continue;
      const vSol = Number(ev.virtualSolReserves) / 1e9;
      if (!Number.isFinite(vSol) || vSol <= 0) continue;
      out.push({ mint: ev.mint, vSol });
    }
    await sleep(READ_SPACING_MS);
  }
  return out;
}

/**
 * A snapshot carries only what the moment actually established.
 *
 * Everything absent from CurveMoment stays absent. Holder distribution, USD
 * market cap and the DexScreener-sourced fields are not recoverable for a past
 * instant, and a plausible-looking substitute for any of them would be
 * indistinguishable from a measurement once it is in the file.
 */
function snapshotFromMoment(m: CurveMoment, extra: { devBuySol?: number; entrySolSize?: number }): TokenSnapshot {
  return {
    mint: m.mint,
    at: m.atMs,
    source: 'backfill',
    ...(m.ageSeconds !== undefined ? { ageSeconds: m.ageSeconds } : {}),
    ...(m.curveProgressPct !== undefined ? { curveProgressPct: m.curveProgressPct } : {}),
    // A capped rank is a floor, not a count. Recording it would put "3000" in
    // a column of exact values and drag the band it belongs to.
    ...(m.curveTxRank !== undefined && !m.rankCapped ? { curveTxRank: m.curveTxRank } : {}),
    ...(m.windowBuySol !== undefined ? { windowBuySol: m.windowBuySol } : {}),
    ...(m.windowSellSol !== undefined ? { windowSellSol: m.windowSellSol } : {}),
    ...(m.windowBuyPressurePct !== undefined ? { windowBuyPressurePct: m.windowBuyPressurePct } : {}),
    ...(m.windowBuyers !== undefined ? { windowBuyers: m.windowBuyers } : {}),
    ...(m.windowTradesPerMin !== undefined ? { windowTradesPerMin: m.windowTradesPerMin } : {}),
    ...(extra.devBuySol !== undefined ? { devBuySol: extra.devBuySol } : {}),
  };
}

/**
 * Two features is not a description of a token.
 *
 * A snapshot that recovered only `at` and a curve position would still be
 * counted toward MIN_ENTERED_SAMPLES, so forty of them would unlock a profile
 * built on almost nothing. The floor is checked per snapshot, at the door.
 */
export const MIN_RECOVERED_FEATURES = 3;

function usable(s: TokenSnapshot): boolean {
  let n = 0;
  for (const [k, v] of Object.entries(s)) {
    if (k === 'mint' || k === 'at' || k === 'source') continue;
    if (typeof v === 'number' && Number.isFinite(v)) n++;
  }
  return n >= MIN_RECOVERED_FEATURES;
}
