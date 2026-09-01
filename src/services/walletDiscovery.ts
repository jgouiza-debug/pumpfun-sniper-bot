import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { tradeEventsFromLogs, PUMP_PROGRAM_ID } from './pumpEventDecoder';
import { bondingCurveFor } from './walletHarvester';
import type { ScoutCandidate, SourceOutcome } from './traderSources';

/**
 * FINDING WALLETS WITH NO API KEY AND NO PERMISSION FROM ANYONE.
 *
 * WHY THIS EXISTS. The scout shipped with two candidate sources — a keyed
 * leaderboard, and the bot's own wallet ledger — and on a default install
 * BOTH are empty. No key means no leaderboard. The ledger is filled by the
 * harvester, which only runs behind the `smartMoneySniper` flag (off by
 * default) and only credits wallets the sniper's own lane fed it, and the
 * scout reads only the `promoted`/`observed` end of it, which a fresh install
 * has none of. So `gatherCandidates` returned nothing, `runScout` returned
 * before making a single RPC call, and the panel said a scan had completed.
 * The feature was structurally incapable of finding anybody, and reported
 * that as a normal result.
 *
 * This closes it, and it does not need a key, a flag, a vendor or a ledger —
 * only the RPC connection the bot already holds.
 *
 * HOW IT WORKS, and why this shape.
 *
 *   1. Read the pump.fun program's most recent signatures. One call.
 *   2. Sample transactions across that span and decode their TradeEvents.
 *      Every event carries the mint AND the curve's virtual SOL reserves, so
 *      one read tells us both what is being traded and how far up its curve
 *      it has got. Tokens launch at 30 virtual SOL, so a curve well above
 *      that is a token that is WORKING RIGHT NOW.
 *   3. For the ones that have run furthest, walk the curve back to its first
 *      transactions and decode who bought first.
 *
 * WHY TOKENS THAT ARE RUNNING, RATHER THAN TOKENS THAT RAN. Two reasons, one
 * of them structural. The obvious source of proven wallets is a token that
 * already graduated — but a graduated curve stops trading, so it never appears
 * in recent program activity, and its first buyers sit tens of thousands of
 * signatures back, past any bounded walk. A token mid-run is both visible and
 * reachable. The second reason is that it answers a better question: not who
 * was early to something months ago, but who is early to what is working
 * today, which is what "the most profitable trader active right now" meant.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not judge the wallets. Being
 * early to one token that is up is not evidence of skill — it is a lead, the
 * same status a leaderboard row has. Every address here goes through the same
 * `verifyTrader` pass as any other candidate, which re-derives realized PnL,
 * activity, hold time, fill drag and queue position from the chain and throws
 * most of them out. In particular the front-of-queue bar is what removes the
 * token's own launcher, who is by construction the first buyer of everything
 * they touch — so no special case for insiders is needed here, and adding one
 * would just be a second, weaker copy of a rule that already exists.
 *
 * It also does not touch the wallet ledger. The ledger's promotion state is
 * evidence the harvester earned from a caller's verdict about how a token
 * actually turned out; a guess from curve position is not that, and writing
 * it in would quietly degrade the thing it is imitating.
 */

/** Recent program signatures pulled per run. One RPC call. */
export const PROGRAM_SIGNATURE_PAGE = 1_000;
/** Transactions sampled from that page to see which mints are live. */
export const MINT_SAMPLE_TX = 40;
/**
 * The curve floor for "this token is running".
 *
 * pump.fun curves start at 30 virtual SOL and graduate at 85. 40 is up a
 * third of the way from launch — enough to be a real move rather than the
 * first few buys, and low enough that the token is still young enough for its
 * first buyers to be inside a bounded walk.
 */
export const MIN_RUNNING_VSOL = 40;
/** Mints walked back to their first buyers per run. */
export const MAX_MINTS_WALKED = 4;
/** Signature pages walked per mint. 1000 each. */
export const MAX_CURVE_PAGES = 4;
/** Transactions read per mint when decoding its first buyers. */
export const MAX_EARLY_TX_READS = 45;
/** First buyers taken from one token. */
export const EARLY_BUYER_LIMIT = 20;
/** A buy under this is dust or a bot probe, not a call worth following up. */
export const MIN_EARLY_BUY_SOL = 0.05;
/** Pause between reads. This is research and it yields to trading. */
const READ_SPACING_MS = 120;

export interface DiscoveryDeps {
  getConnection: () => Connection | null;
  /** True while the trading path is doing something this must not slow down. */
  isBusy?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export interface RunningMint {
  mint: string;
  /** The highest virtual SOL reserve seen for it in the sample. */
  virtualSolReserves: number;
  /** How many sampled transactions touched it — a crude liveness measure. */
  sampleHits: number;
}

const defaultSleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/**
 * Which pump.fun tokens are being traded right now, and how far up the curve.
 *
 * The sample STRIDES across the signature page rather than taking the first N.
 * Reading the newest 40 signatures back to back is a sample of the last few
 * seconds, which on a busy chain is one or two hot mints and nothing else;
 * spreading the same 40 reads across the whole page covers minutes and sees
 * the tokens that are sustaining a move rather than the one being sprayed
 * this instant. Same cost, much better sample.
 */
export async function discoverRunningMints(
  deps: DiscoveryDeps,
  spend: (n: number) => boolean,
): Promise<{ mints: RunningMint[]; reads: number; detail?: string }> {
  const conn = deps.getConnection();
  if (!conn) return { mints: [], reads: 0, detail: 'no RPC connection' };
  const sleep = deps.sleep ?? defaultSleep;
  let reads = 0;

  if (!spend(1)) return { mints: [], reads, detail: 'read budget spent' };
  reads++;
  let page: Array<{ signature: string }>;
  try {
    page = await conn.getSignaturesForAddress(
      new PublicKey(PUMP_PROGRAM_ID), { limit: PROGRAM_SIGNATURE_PAGE });
  } catch (err: any) {
    return { mints: [], reads, detail: `could not read pump.fun activity: ${err?.message ?? err}` };
  }
  if (!page.length) return { mints: [], reads, detail: 'the pump.fun program returned no recent activity' };

  const stride = Math.max(1, Math.floor(page.length / MINT_SAMPLE_TX));
  const byMint = new Map<string, RunningMint>();
  let sampled = 0;

  for (let i = 0; i < page.length && sampled < MINT_SAMPLE_TX; i += stride) {
    if (deps.isBusy?.()) return { mints: rank(byMint), reads, detail: 'trading path busy' };
    if (!spend(1)) return { mints: rank(byMint), reads, detail: 'read budget spent' };
    reads++; sampled++;
    let tx;
    try {
      tx = await conn.getTransaction(page[i].signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch {
      await sleep(READ_SPACING_MS);
      continue;                                    // one unreadable tx is not a reason to stop
    }
    // A failed transaction moved nothing: its curve reserves are whatever they
    // were before, and treating its event as evidence a token is running is
    // the same mistake as counting a failed buy as demand.
    if (!tx || tx.meta?.err) { await sleep(READ_SPACING_MS); continue; }
    for (const ev of tradeEventsFromLogs(tx.meta?.logMessages ?? [])) {
      const vSol = Number(ev.virtualSolReserves) / 1e9;
      if (!Number.isFinite(vSol) || vSol <= 0) continue;
      const prev = byMint.get(ev.mint);
      if (prev) {
        prev.virtualSolReserves = Math.max(prev.virtualSolReserves, vSol);
        prev.sampleHits++;
      } else {
        byMint.set(ev.mint, { mint: ev.mint, virtualSolReserves: vSol, sampleHits: 1 });
      }
    }
    await sleep(READ_SPACING_MS);
  }

  const mints = rank(byMint);
  return {
    mints, reads,
    ...(mints.length ? {} : {
      detail: `sampled ${sampled} pump.fun transactions and none was on a curve above `
        + `${MIN_RUNNING_VSOL} SOL — nothing is running hard enough to be worth following`,
    }),
  };
}

/** Running first, and among equals the one more of the sample touched. */
function rank(byMint: Map<string, RunningMint>): RunningMint[] {
  return [...byMint.values()]
    .filter(m => m.virtualSolReserves >= MIN_RUNNING_VSOL)
    .sort((a, b) => (b.virtualSolReserves - a.virtualSolReserves) || (b.sampleHits - a.sampleHits));
}

/**
 * Who bought this token first.
 *
 * `reachedBeginning` is the whole safety property, and it is the harvester's
 * rule for the same reason: only a signature page that came back SHORT proves
 * the walk saw the token's first transactions. Without it, a token busier than
 * the page cap yields "the oldest addresses we could reach", which is a
 * mid-life snapshot — and crediting those as early buyers is precisely how a
 * wallet that sprays dust into busy tokens earns a perfect record. A walk that
 * did not reach the beginning returns NOBODY rather than somebody wrong.
 */
export async function earlyBuyersOf(
  mint: string,
  deps: DiscoveryDeps,
  spend: (n: number) => boolean,
): Promise<{ buyers: string[]; reads: number; reachedBeginning: boolean; stoppedEarly?: string }> {
  const conn = deps.getConnection();
  const curve = bondingCurveFor(mint);
  if (!conn || !curve) return { buyers: [], reads: 0, reachedBeginning: false, stoppedEarly: 'no connection' };
  const sleep = deps.sleep ?? defaultSleep;

  let reads = 0;
  let stoppedEarly: string | undefined;
  let all: Array<{ signature: string }> = [];
  let before: string | undefined;
  let reachedBeginning = false;

  // getSignaturesForAddress returns NEWEST first, so reaching a token's first
  // buyers means paging BACKWARDS with `before`.
  for (let p = 0; p < MAX_CURVE_PAGES; p++) {
    if (deps.isBusy?.()) { stoppedEarly = 'trading path busy'; break; }
    if (!spend(1)) { stoppedEarly = 'read budget spent'; break; }
    reads++;
    let batch: Array<{ signature: string }>;
    try {
      batch = await conn.getSignaturesForAddress(curve, { limit: 1000, ...(before ? { before } : {}) });
    } catch (err: any) {
      stoppedEarly = `curve history unreadable: ${err?.message ?? err}`;
      break;
    }
    if (!batch.length) { reachedBeginning = true; break; }
    all = all.concat(batch.map(b => ({ signature: b.signature })));
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) { reachedBeginning = true; break; }
    await sleep(READ_SPACING_MS);
  }
  if (!reachedBeginning) {
    return {
      buyers: [], reads, reachedBeginning: false,
      stoppedEarly: stoppedEarly
        ?? `more than ${MAX_CURVE_PAGES * 1000} curve transactions — never reached the token's first buyers`,
    };
  }
  if (!all.length) return { buyers: [], reads, reachedBeginning: true };

  all.reverse();                                   // oldest first: the order it was bought in
  const buyers: string[] = [];
  const seen = new Set<string>();
  for (const s of all.slice(0, MAX_EARLY_TX_READS)) {
    if (buyers.length >= EARLY_BUYER_LIMIT) break;
    if (deps.isBusy?.()) { stoppedEarly = 'trading path busy'; break; }
    if (!spend(1)) { stoppedEarly = 'read budget spent'; break; }
    reads++;
    let tx;
    try {
      tx = await conn.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch {
      await sleep(READ_SPACING_MS);
      continue;
    }
    if (!tx || tx.meta?.err) { await sleep(READ_SPACING_MS); continue; }  // a failed buy is not a buy
    for (const ev of tradeEventsFromLogs(tx.meta?.logMessages ?? [])) {
      if (!ev.isBuy || ev.mint !== mint) continue;
      if (Number(ev.solLamports) / 1e9 < MIN_EARLY_BUY_SOL) continue;
      if (seen.has(ev.user)) continue;             // one credit per wallet per token
      seen.add(ev.user);
      buyers.push(ev.user);
    }
    await sleep(READ_SPACING_MS);
  }
  return { buyers, reads, reachedBeginning: true, ...(stoppedEarly ? { stoppedEarly } : {}) };
}

/**
 * The whole pass, as a candidate source the scout can treat like any other.
 *
 * A wallet that was early to TWO of the discovered tokens gets two entries in
 * `sources`, which is how the scout orders its verification budget. That is
 * honest evidence — two independent tokens named it — and it is the same
 * reasoning the leaderboard merge already uses when two boards agree.
 */
export async function discoverCandidates(
  deps: DiscoveryDeps,
  spend: (n: number) => boolean,
): Promise<{ outcome: SourceOutcome; reads: number }> {
  const name = 'on-chain discovery (this bot)';
  const found = await discoverRunningMints(deps, spend);
  let reads = found.reads;

  if (!found.mints.length) {
    return {
      outcome: {
        name, ok: false, candidates: [],
        detail: found.detail ?? 'no pump.fun token is currently running',
      },
      reads,
    };
  }

  const byWallet = new Map<string, ScoutCandidate>();
  const walked: string[] = [];
  const unreachable: string[] = [];
  for (const m of found.mints.slice(0, MAX_MINTS_WALKED)) {
    if (deps.isBusy?.()) break;
    const r = await earlyBuyersOf(m.mint, deps, spend);
    reads += r.reads;
    if (!r.reachedBeginning) { unreachable.push(m.mint); continue; }
    walked.push(m.mint);
    const tag = `early to ${m.mint.slice(0, 4)}… (curve ${m.virtualSolReserves.toFixed(0)} SOL)`;
    for (const w of r.buyers) {
      const prev = byWallet.get(w);
      if (prev) { if (!prev.sources.includes(tag)) prev.sources.push(tag); continue; }
      byWallet.set(w, { wallet: w, sources: [tag] });
    }
  }

  const candidates = [...byWallet.values()];
  deps.log?.('info',
    `[Discovery] ${found.mints.length} running mint(s), ${walked.length} walked to their first buyers, `
    + `${candidates.length} candidate wallet(s) from ${reads} RPC reads`
    + `${unreachable.length ? ` (${unreachable.length} too busy to walk back)` : ''}.`);

  if (!candidates.length) {
    return {
      outcome: {
        name, ok: false, candidates: [],
        detail: unreachable.length
          ? `found ${found.mints.length} running token(s) but every one of them has more than `
            + `${MAX_CURVE_PAGES * 1000} trades, so its first buyers are out of reach of a bounded walk`
          : `found ${found.mints.length} running token(s) but no buy above ${MIN_EARLY_BUY_SOL} SOL in their first trades`,
      },
      reads,
    };
  }
  return { outcome: { name, ok: true, candidates }, reads };
}
