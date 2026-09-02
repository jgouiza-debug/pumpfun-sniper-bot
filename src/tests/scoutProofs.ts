/**
 * TRADER SCOUT PROOFS — is the wallet it recommends actually copyable?
 *
 *   npx ts-node src/tests/scoutProofs.ts
 *
 * The operator asked for the most profitable memecoin trader active right now,
 * a list of three, and the best one named. Every list that claims to answer
 * that is gameable, and several of the wallets at the top of them will empty
 * your account if you follow them. So the scout treats a leaderboard as a
 * source of ADDRESSES and nothing else, and these tests are mostly about the
 * five ways a wallet can look excellent and be useless:
 *
 *   - it stopped trading yesterday
 *   - 97% of its profit is one token it called correctly once
 *   - its median entry is 40 SOL, so its own buy moves the curve and the
 *     follower fills into the move — the bigger the trader, the worse this is,
 *     and it is exactly what a profit-ranked leaderboard selects for
 *   - it holds for four seconds, which is faster than we can land a buy
 *   - it is first in the queue on every token, which means it is launching them
 *
 * Plus the one that is not about wallets at all: a vendor renaming a field, so
 * every source silently returns nobody and the panel reads as "no good traders
 * today" forever.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import {
  verifyTrader, scoreOf, runScout,
  MAX_IDLE_HOURS, MIN_CLOSED_TRADES, MAX_TOP_MINT_SHARE, MAX_COPYABLE_BUY_SOL,
  MIN_SERIOUS_BUY_SOL, MIN_HOLD_SECONDS, MAX_FRONT_OF_QUEUE_SHARE, PRIOR_TRIALS,
  MAX_FILL_DRAG_PCT, OUR_TYPICAL_ENTRY_SOL, STALE_BAG_HOURS, MAX_STALE_SHARE,
  QUEUE_SAMPLE_MINTS, wilsonLower,
  type TraderStats,
} from '../services/traderScout';
import {
  gatherCandidates, fetchSolanaTrackerTop, fetchSolanaTrackerKols, fetchBirdeyeGainers,
  looksLikeWallet,
} from '../services/traderSources';
import {
  discoverRunningMints, earlyBuyersOf, discoverCandidates,
  MIN_RUNNING_VSOL, MIN_EARLY_BUY_SOL, MAX_CURVE_PAGES, RECENT_MINT_MAX_AGE_MS,
} from '../services/walletDiscovery';
import { PUMP_PROGRAM_ID } from '../services/pumpEventDecoder';

let passed = 0;
let failed = 0;
const queue: Array<() => Promise<void>> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err: any) { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
function atest(name: string, fn: () => Promise<void>): void {
  queue.push(async () => {
    try { await fn(); passed++; console.log(`  ok    ${name}`); }
    catch (err: any) { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
  });
}

// ---- real TradeEvent bytes, so the real decoder does the work -------------
const DISC = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);
function pk(seed: string): string {
  const b = Buffer.alloc(32);
  Buffer.from(seed).copy(b);
  return new PublicKey(b).toBase58();
}
interface EvSpec { mint: string; user: string; isBuy: boolean; sol: number; tokens: number; ts: number; vSol?: number; }
function encodeTradeEvent(e: EvSpec): string {
  const b = Buffer.alloc(129);
  let o = 0;
  DISC.copy(b, o); o += 8;
  new PublicKey(e.mint).toBuffer().copy(b, o); o += 32;
  b.writeBigUInt64LE(BigInt(Math.round(e.sol * 1e9)), o); o += 8;
  b.writeBigUInt64LE(BigInt(Math.round(e.tokens)), o); o += 8;
  b.writeUInt8(e.isBuy ? 1 : 0, o); o += 1;
  new PublicKey(e.user).toBuffer().copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(e.ts), o); o += 8;
  b.writeBigUInt64LE(BigInt(Math.round((e.vSol ?? 60) * 1e9)), o); o += 8;
  b.writeBigUInt64LE(BigInt(1_000_000_000), o); o += 8;
  b.writeBigUInt64LE(0n, o); o += 8;
  b.writeBigUInt64LE(0n, o);
  return b.toString('base64');
}
function logsFor(evs: EvSpec[]): string[] {
  return [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    ...evs.map(e => `Program data: ${encodeTradeEvent(e)}`),
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
}

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const TRADER = pk('theTrader');

interface FakeTx { logs: string[]; err?: unknown; }
class FakeConn {
  constructor(
    private sigs: Map<string, Array<{ signature: string; blockTime: number; err?: unknown }>>,
    private txs: Map<string, FakeTx>,
  ) {}
  async getSignaturesForAddress(addr: PublicKey, o: { limit: number; before?: string }) {
    const all = this.sigs.get(addr.toBase58()) ?? [];
    let start = 0;
    if (o.before) {
      const i = all.findIndex(s => s.signature === o.before);
      start = i >= 0 ? i + 1 : all.length;
    }
    return all.slice(start, start + o.limit);
  }
  async getTransaction(sig: string) {
    const t = this.txs.get(sig);
    if (!t) return null;
    return { meta: { err: t.err ?? null, logMessages: t.logs } };
  }
}

/**
 * One closed round trip: buy `sol` in, sell `sol * mult` out, held `holdS`.
 *
 * Token amounts match exactly so the position reads as CLOSED — the scout only
 * scores positions where the wallet sold everything it bought, because an open
 * bag has no outcome yet.
 */
interface TradeSpec { mint: string; sol: number; mult: number; holdS: number; endedSAgo: number; vSol?: number; unsold?: boolean; depth?: number; }

function fixture(trades: TradeSpec[], opts: { curveDepth?: number } = {}) {
  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  const txs = new Map<string, FakeTx>();
  const walletSigs: Array<{ signature: string; blockTime: number }> = [];
  const TOKENS = 1_000_000;

  trades.forEach((t, i) => {
    const sellAt = NOW_S - t.endedSAgo;
    const buyAt = sellAt - t.holdS;
    const bSig = `buy${i}`;
    const sSig = `sell${i}`;
    walletSigs.push({ signature: sSig, blockTime: sellAt });
    walletSigs.push({ signature: bSig, blockTime: buyAt });
    txs.set(bSig, { logs: logsFor([{ mint: t.mint, user: TRADER, isBuy: true, sol: t.sol, tokens: TOKENS, ts: buyAt, vSol: t.vSol }]) });
    // An unsold bag: the buy is there, the sell never happened. This is what a
    // rug looks like in a wallet's history — and what the scout used to drop.
    if (!t.unsold) {
      txs.set(sSig, { logs: logsFor([{ mint: t.mint, user: TRADER, isBuy: false, sol: t.sol * t.mult, tokens: TOKENS, ts: sellAt, vSol: t.vSol }]) });
    }
    // The mint's own curve history, for the queue-position sample.
    const depth = t.depth ?? opts.curveDepth ?? 50;
    const curve = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(t.mint).toBuffer()],
      new PublicKey(PUMP_PROGRAM_ID),
    )[0].toBase58();
    // The wallet's own buy is IN the mint's curve history — that is what lets it
    // anchor the walk, and it is true on chain by construction. Without it the
    // anchored read comes back empty and the queue sample silently never runs.
    sigs.set(curve, [
      { signature: bSig, blockTime: buyAt },
      ...Array.from({ length: depth }, (_, k) => ({ signature: `${t.mint}c${k}`, blockTime: buyAt - 1 - k })),
      { signature: `${t.mint}birth`, blockTime: buyAt - depth - 100 },
    ]);
  });
  // Newest first, as the RPC returns them.
  walletSigs.sort((a, b) => b.blockTime - a.blockTime);
  sigs.set(TRADER, walletSigs);
  return { sigs, txs };
}

const deps = (conn: FakeConn) => ({
  getConnection: () => conn as any,
  fetch: (async () => { throw new Error('no network in this test'); }) as any,
  now: () => NOW_MS,
  sleep: async () => {},
});
const alwaysSpend = () => true;

/** A wallet that should pass every bar: steady, spread, recent, copyable size. */
function goodTrades(): TradeSpec[] {
  return Array.from({ length: 12 }, (_, i) => ({
    mint: pk(`good${i}`),
    sol: 1.5,
    mult: i < 8 ? 1.6 : 0.5,          // 8 wins, 4 losses — spread across mints
    holdS: 600,
    endedSAgo: 1200 + i * 60,
  }));
}

async function verify(trades: TradeSpec[], opts: { curveDepth?: number; queue?: boolean } = {}): Promise<TraderStats> {
  const f = fixture(trades, { curveDepth: opts.curveDepth });
  const s = await verifyTrader({ wallet: TRADER, sources: ['test'] }, deps(new FakeConn(f.sigs, f.txs)),
    alwaysSpend, { checkQueuePosition: opts.queue !== false });
  assert.ok(s, 'the wallet should have been readable');
  return s!;
}

console.log('\n-- A wallet that is genuinely worth copying --');

atest('a steady, spread, recent, right-sized wallet passes', async () => {
  const s = await verify(goodTrades());
  assert.deepStrictEqual(s.disqualifiers, [], `unexpectedly rejected: ${s.disqualifiers.join(' | ')}`);
  assert.strictEqual(s.closedTrades, 12);
  assert.strictEqual(s.wins, 8);
  assert.ok(s.realizedSol > 0, `realized ${s.realizedSol}`);
  assert.ok(s.score > 0, 'a passing wallet must be scored');
});

atest('an open position is neither a win nor a loss', async () => {
  // A wallet holding ten bags is not a wallet that lost ten times. Counting
  // unsold positions as losses would reject every trader who holds, which is
  // most of the good ones.
  const f = fixture(goodTrades());
  // Add a buy with no matching sell.
  const openMint = pk('stillOpen');
  f.txs.set('openBuy', { logs: logsFor([{ mint: openMint, user: TRADER, isBuy: true, sol: 2, tokens: 5_000, ts: NOW_S - 400 }]) });
  f.sigs.get(TRADER)!.unshift({ signature: 'openBuy', blockTime: NOW_S - 400 });
  const s = await verifyTrader({ wallet: TRADER, sources: ['t'] }, deps(new FakeConn(f.sigs, f.txs)), alwaysSpend, { checkQueuePosition: false });
  assert.strictEqual(s!.closedTrades, 12, 'the open bag must not be scored');
  assert.strictEqual(s!.openPositions, 1, 'but it must be reported');
});

console.log('\n-- The five ways a profitable-looking wallet is useless --');

atest('1. NOT TRADING ANY MORE', async () => {
  const stale = goodTrades().map(t => ({ ...t, endedSAgo: t.endedSAgo + (MAX_IDLE_HOURS + 2) * 3600 }));
  const s = await verify(stale);
  assert.ok(s.disqualifiers.some(d => /not trading/.test(d)), s.disqualifiers.join(' | '));
});

atest('2. ONE LUCKY TOKEN', async () => {
  // 400 SOL of profit, 390 of it from a single mint. The leaderboard sees a
  // star; what we would be copying is the other eleven trades.
  const trades = goodTrades().map((t, i) => (i === 0 ? { ...t, sol: 50, mult: 9 } : { ...t, mult: 1.02 }));
  const s = await verify(trades);
  assert.ok(s.topMintProfitShare > MAX_TOP_MINT_SHARE, `share was ${s.topMintProfitShare}`);
  assert.ok(s.disqualifiers.some(d => /one token/.test(d)), s.disqualifiers.join(' | '));
});

atest('3. TOO BIG TO COPY — the one a profit ranking selects FOR', async () => {
  // This is the important one. Sorting any leaderboard by profit puts the
  // largest wallets on top, and the largest wallets are exactly the ones whose
  // own entry moves the curve before a follower's transaction is even built.
  const whale = goodTrades().map(t => ({ ...t, sol: MAX_COPYABLE_BUY_SOL + 25 }));
  const s = await verify(whale);
  assert.ok(s.realizedSol > 0, 'and it is genuinely profitable, which is the point');
  assert.ok(s.disqualifiers.some(d => /too large to follow/.test(d)), s.disqualifiers.join(' | '));
});

atest('3b. and a wallet too small to be deciding anything', async () => {
  const dust = goodTrades().map(t => ({ ...t, sol: MIN_SERIOUS_BUY_SOL / 2 }));
  const s = await verify(dust);
  assert.ok(s.disqualifiers.some(d => /testing, not trading/.test(d)), s.disqualifiers.join(' | '));
});

atest('4. FASTER THAN WE CAN LAND', async () => {
  // We land one to two slots behind the leader — 350-700ms — from a
  // residential connection. A four-second hold is an arbitrage we would be
  // buying the exit of.
  const fast = goodTrades().map(t => ({ ...t, holdS: 4 }));
  const s = await verify(fast);
  assert.ok(s.medianHoldSeconds < MIN_HOLD_SECONDS);
  assert.ok(s.disqualifiers.some(d => /shorter than we can copy/.test(d)), s.disqualifiers.join(' | '));
});

atest('5. THE INSIDER — first in the queue on everything', async () => {
  // curveDepth 0 means every one of their buys is the first transaction on the
  // token. Nobody finds tokens that fast; they are launching them, or being
  // told.
  const s = await verify(goodTrades(), { curveDepth: 0 });
  assert.ok((s.frontOfQueueShare ?? 0) > MAX_FRONT_OF_QUEUE_SHARE, `share was ${s.frontOfQueueShare}`);
  assert.ok(s.disqualifiers.some(d => /being told, or is launching/.test(d)), s.disqualifiers.join(' | '));
});

atest('a normal trader is NOT flagged as an insider', async () => {
  // The check has to have a negative case or it is just a rejection machine.
  const s = await verify(goodTrades(), { curveDepth: 50 });
  assert.ok((s.frontOfQueueShare ?? 1) === 0, `share was ${s.frontOfQueueShare}`);
  assert.ok(!s.disqualifiers.some(d => /launching/.test(d)));
});

console.log('\n-- Survivorship: the rugs they never sold --');

atest('A WALLET FULL OF UNSOLD BAGS IS NOT A WINNER', async () => {
  // The defect this closes, and the most dangerous one in the file. Scoring
  // only CLOSED positions sounds cautious and is the opposite: not selling is
  // exactly what a trader does when the token went to zero, so every rug
  // quietly leaves the sample and the small wins stay. This wallet has twelve
  // tidy closed wins and twenty bags it has been holding for two days.
  const closed = goodTrades();
  const bags: TradeSpec[] = Array.from({ length: 20 }, (_, i) => ({
    mint: pk(`bag${i}`), sol: 1.5, mult: 0, holdS: 0,
    endedSAgo: (STALE_BAG_HOURS + 36) * 3600 + i * 60,
    unsold: true,
  }));
  const s = await verify([...closed, ...bags], { queue: false });
  assert.strictEqual(s.closedTrades, 12, 'the closed wins are still counted');
  assert.ok(s.stalePositions >= 20, `only ${s.stalePositions} bags were noticed`);
  assert.ok(s.staleShare > MAX_STALE_SHARE, `stale share ${s.staleShare}`);
  assert.ok(s.disqualifiers.some(d => /never sold/.test(d)), s.disqualifiers.join(' | '));
});

atest('a bag bought an hour ago is a position, not a bag', async () => {
  // The negative case: a trader who is holding something they bought this
  // morning is just a trader who is holding something.
  const fresh: TradeSpec[] = Array.from({ length: 6 }, (_, i) => ({
    mint: pk(`fresh${i}`), sol: 1.5, mult: 0, holdS: 0, endedSAgo: 1800 + i * 60, unsold: true,
  }));
  const s = await verify([...goodTrades(), ...fresh], { queue: false });
  assert.strictEqual(s.stalePositions, 0, 'an hour-old position has not had time to be evidence');
  assert.ok(!s.disqualifiers.some(d => /never sold/.test(d)), s.disqualifiers.join(' | '));
});

console.log('\n-- Fill drag: what copying them would actually cost us --');

atest('A SMALL WALLET BUYING A FRESH CURVE IS UNCOPYABLE — a SOL cap misses this', async () => {
  // 3 SOL entries look modest and pass any flat size limit. Into a 31 SOL
  // curve they are not: (3 + 0.5) / 31 = 11.3% worse average fill for us,
  // before the trade has an opinion.
  const early = goodTrades().map(t => ({ ...t, sol: 3, vSol: 31 }));
  const s = await verify(early, { queue: false });
  assert.ok(s.medianBuySol < MAX_COPYABLE_BUY_SOL, 'the flat SOL cap does not fire here — that is the point');
  assert.ok((s.expectedFillDragPct ?? 0) > MAX_FILL_DRAG_PCT, `drag was ${s.expectedFillDragPct}%`);
  assert.ok(s.disqualifiers.some(d => /worse fills/.test(d)), s.disqualifiers.join(' | '));
});

atest('the same size deep in a curve is fine', async () => {
  // And the negative case, which is what makes the drag a measurement rather
  // than a second size limit: identical 3 SOL entries at 200 vSol drag 1.75%.
  const deep = goodTrades().map(t => ({ ...t, sol: 3, vSol: 200 }));
  const s = await verify(deep, { queue: false });
  assert.ok((s.expectedFillDragPct ?? 99) < MAX_FILL_DRAG_PCT, `drag was ${s.expectedFillDragPct}%`);
  assert.ok(!s.disqualifiers.some(d => /worse fills/.test(d)), s.disqualifiers.join(' | '));
});

atest('the drag matches the curve identity, not a fudge factor', async () => {
  const s = await verify(goodTrades().map(t => ({ ...t, sol: 2, vSol: 50 })), { queue: false });
  assert.strictEqual(s.medianEntryVSol, 50);
  assert.strictEqual(s.expectedFillDragPct, ((2 + OUR_TYPICAL_ENTRY_SOL) / 50) * 100);
});

console.log('\n-- One call is not a record --');

atest('LEAVE ONE OUT: remove their best token and see what is left', async () => {
  // Cleaner than the concentration ratio and it costs nothing. The ratio
  // divides by the sum of WINNERS, so it cannot see a wallet that is
  // net-negative once its single good call is removed.
  const trades: TradeSpec[] = [
    { mint: pk('luckyOne'), sol: 2, mult: 20, holdS: 600, endedSAgo: 1200 },
    ...Array.from({ length: 11 }, (_, i) => ({
      mint: pk(`dud${i}`), sol: 2, mult: 0.6, holdS: 600, endedSAgo: 1300 + i * 60,
    })),
  ];
  const s = await verify(trades, { queue: false });
  assert.ok(s.realizedSol > 0, 'overall they are up, which is what a leaderboard sees');
  assert.ok(s.realizedExBestSol < 0, `ex-best was ${s.realizedExBestSol}`);
  assert.ok(s.disqualifiers.some(d => /the record is one call/.test(d)), s.disqualifiers.join(' | '));
});

console.log('\n-- Active means trading, not last seen --');

atest('ONE TRADE FIVE HOURS AGO IS NOT "ACTIVE"', async () => {
  // It passes any last-seen-within-six-hours test while describing a wallet
  // that has stopped.
  const winding: TradeSpec[] = [
    ...Array.from({ length: 11 }, (_, i) => ({
      mint: pk(`old${i}`), sol: 1.5, mult: 1.6, holdS: 600, endedSAgo: 20 * 3600 + i * 60,
    })),
    { mint: pk('lastOne'), sol: 1.5, mult: 1.6, holdS: 600, endedSAgo: 5 * 3600 },
  ];
  const s = await verify(winding, { queue: false });
  assert.ok(s.idleHours < MAX_IDLE_HOURS, 'the last-seen test passes it — that is the trap');
  assert.ok(s.disqualifiers.some(d => /winding down/.test(d)), s.disqualifiers.join(' | '));
});

console.log('\n-- Accusing someone of being an insider needs evidence --');

test('THREE OF FIVE IS NOT PROOF, ELEVEN OF TWELVE IS', () => {
  // At n=5 the binomial spread around a 0.6 threshold is wide enough that the
  // gate fires on coin flips. A Wilson lower bound asks how lopsided a small
  // sample has to be before it can accuse anyone.
  assert.ok(wilsonLower(3, 5) < MAX_FRONT_OF_QUEUE_SHARE,
    `3-of-5 (${wilsonLower(3, 5)}) must not accuse a normal trader`);
  assert.ok(wilsonLower(11, 12) > MAX_FRONT_OF_QUEUE_SHARE,
    `11-of-12 (${wilsonLower(11, 12)}) must accuse`);
  assert.strictEqual(wilsonLower(0, 0), 0, 'no sample accuses nobody');
  assert.ok(wilsonLower(5, 5) < 1, 'even a perfect small sample is not certainty');
});

atest('THE BOUND IS APPLIED ON THE REAL PATH, NOT JUST AVAILABLE', async () => {
  // A wallet first-in-queue on 8 of 12 sampled mints. The raw share is 67% and
  // would accuse; the Wilson lower bound is 39% and does not. This is the
  // failure mode the bound exists for — an ordinary trader with a good week
  // being labelled an insider — and it is only closed if the bound is actually
  // used at the call site, which asserting on wilsonLower() alone does not
  // prove. (Found by mutating the call site back to the raw share and watching
  // every test stay green.)
  const trades: TradeSpec[] = Array.from({ length: 12 }, (_, i) => ({
    mint: pk(`mix${i}`), sol: 1.5, mult: i < 8 ? 1.6 : 0.5, holdS: 600,
    endedSAgo: 1200 + i * 60,
    depth: i < 8 ? 0 : 50,
  }));
  const s = await verify(trades);
  assert.ok(s.frontOfQueueShare !== undefined, 'the sample must have run');
  assert.ok(8 / 12 > MAX_FRONT_OF_QUEUE_SHARE, 'fixture check: the RAW share would accuse');
  assert.ok(s.frontOfQueueShare! < MAX_FRONT_OF_QUEUE_SHARE,
    `reported ${s.frontOfQueueShare} — a raw share, not a bound`);
  assert.ok(!s.disqualifiers.some(d => /launching/.test(d)),
    'a good week is not evidence of being an insider');
});

test('the queue sample is large enough for the threshold to mean anything', () => {
  assert.ok(QUEUE_SAMPLE_MINTS >= 12,
    `${QUEUE_SAMPLE_MINTS} mints is too few to distinguish a launcher from a lucky week`);
});

console.log('\n-- Evidence, not enthusiasm --');

atest('three winning trades is not a track record', async () => {
  const thin = goodTrades().slice(0, 3).map(t => ({ ...t, mult: 3 }));
  const s = await verify(thin);
  assert.ok(s.disqualifiers.some(d => /closed position/.test(d)), s.disqualifiers.join(' | '));
});

atest('THE WIN RATE IS LAPLACE-CORRECTED, so a perfect small sample does not win', async () => {
  const perfect8 = Array.from({ length: 8 }, (_, i) => ({
    mint: pk(`p${i}`), sol: 1, mult: 1.5, holdS: 300, endedSAgo: 600 + i * 30,
  }));
  const s = await verify(perfect8);
  assert.strictEqual(s.wins, 8);
  assert.strictEqual(s.closedTrades, 8);
  assert.ok(s.winRate < 0.6, `8-for-8 reported as ${s.winRate}; an uncorrected rate would be 1.0`);
  assert.strictEqual(s.winRate, 8 / (8 + PRIOR_TRIALS));
});

atest('a losing wallet is rejected however busy it is', async () => {
  const losers = goodTrades().map(t => ({ ...t, mult: 0.6 }));
  const s = await verify(losers);
  assert.ok(s.realizedSol < 0);
  assert.ok(s.disqualifiers.some(d => /realized/.test(d)), s.disqualifiers.join(' | '));
});

atest('THE BUYER IS THE PROGRAM\'S `user`, NOT THE SIGNER', async () => {
  // A bundler's fee payer signs for wallets that are not it. Attributing by
  // signer would credit one address with sixteen strangers' trades.
  const other = pk('someoneElse');
  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  const txs = new Map<string, FakeTx>();
  sigs.set(TRADER, [{ signature: 'bundle', blockTime: NOW_S - 100 }]);
  txs.set('bundle', {
    logs: logsFor([{ mint: pk('m1'), user: other, isBuy: true, sol: 5, tokens: 100, ts: NOW_S - 100 }]),
  });
  const s = await verifyTrader({ wallet: TRADER, sources: ['t'] }, deps(new FakeConn(sigs, txs)), alwaysSpend, { checkQueuePosition: false });
  assert.ok(s!.disqualifiers.some(d => /no pump\.fun trades/.test(d)),
    'another wallet in the same transaction is not this wallet trading');
});

console.log('\n-- Ranking --');

test('ABSOLUTE PROFIT, NEVER PERCENTAGE RETURN', () => {
  // The single most common way a copy-trading tool ends up following someone
  // useless: a wallet that turned 0.3 SOL into 3 tops any ratio-sorted board,
  // and there is no size at which copying it matters.
  const base = {
    wallet: 'x', sources: [], closedTrades: 20, wins: 12, winRate: 0.5, medianHoldSeconds: 600,
    distinctMints: 20, topMintProfitShare: 0.2, lastTradeAt: 0, idleHours: 1, openPositions: 0,
    stalePositions: 0, staleShare: 0, medianEntryVSol: 60, realizedExBestSol: 10,
    tradesLast2h: 2, tradesLast6h: 6,
    disqualifiers: [], score: 0, reads: 0,
  };
  //
  // The fixture has to make the two orderings DISAGREE, or it proves nothing.
  // An earlier version had the big wallet winning on both ratio and absolute,
  // so swapping the scorer to a ratio left every assertion green — found by
  // mutating scoreOf and watching this test pass.
  //   tiny: 5 SOL profit on 0.2 SOL entries  -> 25x, tiny absolute
  //   real: 60 SOL profit on 6 SOL entries   -> 10x, large absolute
  const tiny: TraderStats = { ...base, realizedSol: 5, medianBuySol: 0.2 };
  const real: TraderStats = { ...base, realizedSol: 60, medianBuySol: 6 };
  assert.ok(tiny.realizedSol / tiny.medianBuySol > real.realizedSol / real.medianBuySol,
    'fixture check: the small wallet must have the BETTER percentage return');
  assert.ok(scoreOf(real) > scoreOf(tiny),
    `a 25x micro-account outranked a 60 SOL trader (${scoreOf(tiny)} vs ${scoreOf(real)})`);
});

test('fresher beats staler, all else equal', () => {
  const base: TraderStats = {
    wallet: 'x', sources: [], realizedSol: 20, closedTrades: 20, wins: 12, winRate: 0.5,
    medianHoldSeconds: 600, medianBuySol: 2, distinctMints: 20, topMintProfitShare: 0.2,
    lastTradeAt: 0, idleHours: 0.5, openPositions: 0, stalePositions: 0, staleShare: 0,
    medianEntryVSol: 60, realizedExBestSol: 10, tradesLast2h: 2, tradesLast6h: 6,
    disqualifiers: [], score: 0, reads: 0,
  };
  assert.ok(scoreOf(base) > scoreOf({ ...base, idleHours: 5 }));
});

test('a concentrated wallet scores below a spread one', () => {
  const base: TraderStats = {
    wallet: 'x', sources: [], realizedSol: 20, closedTrades: 20, wins: 12, winRate: 0.5,
    medianHoldSeconds: 600, medianBuySol: 2, distinctMints: 20, topMintProfitShare: 0.1,
    lastTradeAt: 0, idleHours: 1, openPositions: 0, stalePositions: 0, staleShare: 0,
    medianEntryVSol: 60, realizedExBestSol: 10, tradesLast2h: 2, tradesLast6h: 6,
    disqualifiers: [], score: 0, reads: 0,
  };
  assert.ok(scoreOf(base) > scoreOf({ ...base, topMintProfitShare: 0.55 }));
});

test('a disqualified wallet scores zero, whatever its numbers', () => {
  const s: TraderStats = {
    wallet: 'x', sources: [], realizedSol: 900, closedTrades: 50, wins: 45, winRate: 0.9,
    medianHoldSeconds: 600, medianBuySol: 2, distinctMints: 50, topMintProfitShare: 0.1,
    lastTradeAt: 0, idleHours: 0.1, openPositions: 0, stalePositions: 0, staleShare: 0,
    medianEntryVSol: 60, realizedExBestSol: 10, tradesLast2h: 2, tradesLast6h: 6,
    disqualifiers: ['stale'], score: 0, reads: 0,
  };
  // scoreOf itself is pure; the guarantee is that verifyTrader never calls it
  // for a disqualified wallet.
  const src = readFileSync(join(__dirname, '..', 'services', 'traderScout.ts'), 'utf8');
  assert.ok(/stats\.score = d\.length === 0 \? scoreOf\(stats\) : 0;/.test(src),
    'a disqualified wallet must never carry a rank');
  assert.strictEqual(s.score, 0);
});

console.log('\n-- The sources are leads, not facts --');

function fakeFetch(payload: any, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as any;
}

atest('Solana Tracker rows are read by their REAL field names', async () => {
  // `wallet`, not `address`; `realized`, not `realized_profit`. Guessing yields
  // undefined silently, which is why the parse failure below reports the keys
  // it actually saw.
  const w = pk('stWallet');
  const o = await fetchSolanaTrackerTop('k', {
    fetch: fakeFetch({ traders: [{ wallet: w, period: { realized: 42 }, winRate: 0.6, counts: { trades: 30 } }] }),
  });
  assert.strictEqual(o.ok, true, o.detail);
  assert.strictEqual(o.candidates[0].wallet, w);
  assert.strictEqual(o.candidates[0].claimedRealizedSol, 42);
});

atest('A VENDOR RENAME IS REPORTED, NOT SILENTLY ZERO', async () => {
  // The failure that would take longest to notice: the panel reads "no good
  // traders today", forever, and nothing is wrong with the bot.
  const o = await fetchSolanaTrackerTop('k', {
    fetch: fakeFetch({ traders: [{ walletAddress: pk('renamed'), pnl: 42 }] }),
  });
  assert.strictEqual(o.ok, false);
  assert.ok(o.seenKeys?.includes('walletAddress'),
    'the keys actually returned must be surfaced so the rename is diagnosable');
});

atest('an HTTP failure is reported per source, and does not stop the others', async () => {
  const good = pk('birdWallet');
  let call = 0;
  const f: typeof fetch = (async () => {
    call++;
    if (call <= 2) return { ok: false, status: 429, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ data: { items: [{ address: good, trade_count: 40 }] } }) } as any;
  }) as any;
  const { candidates, outcomes } = await gatherCandidates({ solanaTracker: 'a', birdeye: 'b' }, { fetch: f });
  assert.strictEqual(outcomes.filter(o => !o.ok).length, 2, 'both Solana Tracker calls failed');
  assert.ok(outcomes.some(o => o.ok && o.name === 'birdeye/gainers'), 'and Birdeye still ran');
  assert.strictEqual(candidates.length, 1);
});

atest('a missing key is a stated reason, not an empty result', async () => {
  const { outcomes } = await gatherCandidates({}, { fetch: fakeFetch({}) });
  assert.ok(outcomes.every(o => !o.ok));
  assert.ok(outcomes.some(o => /no Solana Tracker key/.test(o.detail ?? '')),
    'an operator must be able to tell "not configured" from "found nobody"');
});

atest('the same wallet from two boards is one candidate with two sources', async () => {
  const w = pk('bothBoards');
  const f: typeof fetch = (async (url: string) => {
    if (String(url).includes('kols')) {
      return { ok: true, status: 200, json: async () => ({ traders: [{ wallet: w, name: 'somebody' }] }) } as any;
    }
    if (String(url).includes('leaderboard/top')) {
      return { ok: true, status: 200, json: async () => ({ traders: [{ wallet: w, period: { realized: 10 } }] }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
  const { candidates } = await gatherCandidates({ solanaTracker: 'k' }, { fetch: f });
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].sources.length, 2);
  assert.strictEqual(candidates[0].label, 'somebody');
});

test('a garbage address is never queued for an RPC walk', () => {
  assert.ok(!looksLikeWallet('N/A'));
  assert.ok(!looksLikeWallet(''));
  assert.ok(!looksLikeWallet('0x1234567890abcdef1234567890abcdef12345678'));   // an EVM address
  assert.ok(looksLikeWallet(pk('real')));
});

atest('NOTHING IS RECOMMENDED WHEN NO SOURCE ANSWERS', async () => {
  const r = await runScout({}, {
    getConnection: () => null,
    fetch: fakeFetch({}),
    now: () => NOW_MS,
    sleep: async () => {},
  });
  assert.strictEqual(r.best, null);
  assert.deepStrictEqual(r.top, []);
  assert.ok(r.notes.some(n => /nothing is being recommended/.test(n)));
});

console.log('\n-- Provenance --');

test('the report states that the ranking used none of the vendors\' numbers', () => {
  // The operator has to be able to tell where a recommendation came from. A
  // number with no stated provenance has to be taken on faith, which is the
  // thing this whole design is avoiding.
  const src = readFileSync(join(__dirname, '..', 'services', 'traderScout.ts'), 'utf8');
  assert.ok(/none of their numbers were used to rank anything/.test(src));
  assert.ok(/LOWER BOUND/.test(src), 'and that curve-only PnL understates a trader who holds through graduation');
});

test('following a wallet is a person\'s decision, not the scout\'s', () => {
  const src = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  const idx = src.indexOf("app.post('/api/scout/follow'");
  assert.ok(idx > 0, 'there must be an explicit follow endpoint');
  const body = src.slice(idx, idx + 1200);
  assert.ok(/requireApiToken/.test(body), 'and it must be token-gated');
  assert.ok(/disqualifiers\.length > 0/.test(body), 'and refuse a wallet the scout rejected');
  // Nothing may add a copy target on its own.
  assert.ok(!/copyTrader\.addWallet/.test(readFileSync(join(__dirname, '..', 'services', 'traderScout.ts'), 'utf8')),
    'the scout itself must never add a copy target');
});

// ===========================================================================
// THE SCOUT COULD NOT FIND ANYBODY AT ALL
// ===========================================================================
//
// Reported 2026-09-01: "the wallet finder isnt actually finding wallets to
// copy all it does is say scan complete".
//
// It was right, and it was structural rather than a bad day. The scout had two
// candidate sources and on a default install both are empty: the leaderboards
// need an API key, and the wallet ledger is filled by a harvester that only
// runs behind a feature flag which ships OFF. So gatherCandidates returned
// nothing, runScout returned before making a single RPC call, and the panel
// said "0 wallet(s) checked, none copyable — that is a normal result".
//
// It was not a normal result. Nothing had been checked.
console.log('\n-- Discovery: finding wallets with no key and no flag --');

const PUMP = PUMP_PROGRAM_ID;

/** A curve PDA, the way the real code derives it. */
function curveOf(mint: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP),
  )[0].toBase58();
}

/**
 * A chain where `mint` is mid-run and its whole history is reachable.
 *
 * `curveTrades` is the number of transactions on the token's curve — under a
 * page, so the walk reaches the beginning and the first buyers are genuinely
 * first.
 */
function chainWith(opts: {
  mint: string; vSol: number; firstBuyers: Array<{ user: string; sol: number }>;
  curveTrades?: number; failFirst?: boolean;
}) {
  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  const txs = new Map<string, FakeTx>();
  const curve = curveOf(opts.mint);

  // Recent pump-program activity: one trade on this mint, at vSol.
  const progSigs: Array<{ signature: string; blockTime: number }> = [];
  for (let i = 0; i < 12; i++) {
    const sg = `prog${i}`;
    progSigs.push({ signature: sg, blockTime: NOW_S - i });
    txs.set(sg, {
      logs: logsFor([{ mint: opts.mint, user: pk(`noise${i}`), isBuy: true, sol: 1, tokens: 1000, ts: NOW_S - i, vSol: opts.vSol }]),
      ...(opts.failFirst ? { err: { InstructionError: [0, 'Custom'] } } : {}),
    });
  }
  sigs.set(PUMP, progSigs);

  // The token's own curve history, oldest last (the RPC returns newest first).
  const curveSigs: Array<{ signature: string; blockTime: number }> = [];
  const depth = opts.curveTrades ?? 30;
  for (let i = 0; i < depth; i++) curveSigs.push({ signature: `c${i}`, blockTime: NOW_S - 100 - i });
  // The oldest entries ARE the first buyers.
  opts.firstBuyers.forEach((b, i) => {
    const sg = `first${i}`;
    curveSigs.push({ signature: sg, blockTime: NOW_S - 1000 + i });
    txs.set(sg, {
      logs: logsFor([{ mint: opts.mint, user: b.user, isBuy: true, sol: b.sol, tokens: 1000, ts: NOW_S - 1000 + i, vSol: 31 }]),
    });
  });
  for (const c of curveSigs) if (!txs.has(c.signature)) txs.set(c.signature, { logs: [] });
  sigs.set(curve, curveSigs);
  return new FakeConn(sigs, txs);
}

const dDeps = (conn: FakeConn) => ({ getConnection: () => conn as any, sleep: async () => {} });
const budget = (n: number) => { let left = n; return (k: number) => { if (left < k) return false; left -= k; return true; }; };

atest('OLD BUG: with no key and an empty ledger the scout checked nobody', async () => {
  // The old shape, reproduced exactly: leaderboards only.
  const { candidates } = await gatherCandidates({}, {
    fetch: (async () => { throw new Error('no network'); }) as any,
  });
  assert.strictEqual(candidates.length, 0,
    'no key means no leaderboard candidate — this part is unchanged and correct');
  // And that was the whole list, so the scan ended having examined nothing.
  // What follows is the source that had to exist for it not to.
});

atest('THE FIX: a running token yields its first buyers, with no key at all', async () => {
  const MINT = pk('runningMint');
  const conn = chainWith({
    mint: MINT, vSol: 55,
    firstBuyers: [{ user: pk('early1'), sol: 0.5 }, { user: pk('early2'), sol: 1.2 }],
  });
  const out = await discoverCandidates(dDeps(conn), budget(5_000));
  assert.ok(out.outcome.ok, `discovery should have worked: ${out.outcome.detail}`);
  const found = out.outcome.candidates.map(c => c.wallet).sort();
  assert.deepStrictEqual(found, [pk('early1'), pk('early2')].sort(),
    'the token is running and its first buyers are reachable, so they are the candidates');
  assert.ok(out.reads > 0, 'and it cost real reads — it actually went to the chain');
});

atest('a token that has not moved off its launch price is not a lead', async () => {
  const MINT = pk('flatMint');
  const conn = chainWith({
    mint: MINT, vSol: MIN_RUNNING_VSOL - 5,      // still ~launch
    firstBuyers: [{ user: pk('early1'), sol: 0.5 }],
  });
  const { mints } = await discoverRunningMints(dDeps(conn), budget(5_000));
  assert.strictEqual(mints.length, 0,
    'every pump.fun mint has buyers; only ones whose curve has actually run are evidence of anything');
});

atest('a FAILED transaction is not proof a token is running', async () => {
  const MINT = pk('failMint');
  const conn = chainWith({
    mint: MINT, vSol: 70, failFirst: true,        // every sampled tx errored
    firstBuyers: [{ user: pk('early1'), sol: 0.5 }],
  });
  const { mints } = await discoverRunningMints(dDeps(conn), budget(5_000));
  assert.strictEqual(mints.length, 0,
    'a failed transaction moved nothing, so its reserves are not evidence of a move');
});

atest('a token too busy to walk back credits NOBODY, not whoever we reached', async () => {
  const MINT = pk('busyMint');
  // More curve transactions than the page cap can reach: the oldest addresses
  // the walk sees are a mid-life snapshot, and crediting those as "first
  // buyers" is exactly how a wallet that sprays dust into busy tokens earns a
  // perfect record.
  const conn = chainWith({
    mint: MINT, vSol: 80, curveTrades: MAX_CURVE_PAGES * 1000 + 50,
    firstBuyers: [{ user: pk('early1'), sol: 0.5 }],
  });
  const r = await earlyBuyersOf(MINT, dDeps(conn), budget(50_000));
  assert.strictEqual(r.reachedBeginning, false, 'the walk cannot have reached the beginning');
  assert.deepStrictEqual(r.buyers, [], 'and it must credit nobody rather than somebody wrong');
  assert.ok(r.stoppedEarly, 'and say why, rather than looking like a token with no buyers');
});

atest('a dust buy is not a call', async () => {
  const MINT = pk('dustMint');
  const conn = chainWith({
    mint: MINT, vSol: 60,
    firstBuyers: [{ user: pk('duster'), sol: MIN_EARLY_BUY_SOL / 2 }, { user: pk('real1'), sol: 0.4 }],
  });
  const r = await earlyBuyersOf(MINT, dDeps(conn), budget(5_000));
  assert.deepStrictEqual(r.buyers, [pk('real1')], 'the dust sprayer is not an early buyer');
});

atest('discovery reports WHY it found nothing, rather than going quiet', async () => {
  const MINT = pk('quietMint');
  const conn = chainWith({ mint: MINT, vSol: 32, firstBuyers: [] });
  const out = await discoverCandidates(dDeps(conn), budget(5_000));
  assert.ok(!out.outcome.ok);
  assert.ok((out.outcome.detail ?? '').length > 20,
    'a silent source is indistinguishable from a dead feature — that is the defect being fixed');
});

atest('the scout merges discovery with the leaderboards and counts it', async () => {
  const MINT = pk('mergeMint');
  const conn = chainWith({
    mint: MINT, vSol: 65,
    firstBuyers: [{ user: pk('early1'), sol: 0.6 }],
  });
  const report = await runScout({}, {
    getConnection: () => conn as any,
    fetch: (async () => { throw new Error('no network'); }) as any,
    now: () => NOW_MS,
    sleep: async () => {},
  }, { checkQueuePosition: false });
  assert.ok(report.considered > 0,
    'with no key at all the scout must still have candidates to check — this is the reported bug');
  assert.ok(report.sourceOutcomes.some(o => /on-chain discovery/.test(o.name)),
    'and discovery must appear in the source line whether it worked or not');
});

test('an empty scan is never reported as a normal result', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const idx = app.indexOf('NO CANDIDATE WALLETS WERE FOUND');
  assert.ok(idx > 0,
    'zero candidates must be named as such — "0 wallet(s) checked, none copyable, that is a normal '
    + 'result" made a structurally dead feature read as a working one having a quiet day');
  const block = app.slice(idx - 400, idx + 900);
  assert.ok(/rep\.considered === 0/.test(block), 'and it must branch on there being nothing to check');
  assert.ok(/sourceOutcomes\.filter\(o => !o\.ok\)/.test(block),
    'and show which source failed, at the top, not in dim text at the bottom');
});

test('discovery needs no feature flag and writes no ledger state', () => {
  const src = readFileSync(join(__dirname, '..', 'services', 'walletDiscovery.ts'), 'utf8');
  assert.ok(!/featureFlags/.test(src),
    'gating discovery behind a flag is how the previous on-chain source came to never run');
  assert.ok(!/walletLedger/.test(src),
    'a guess from curve position is not the evidence the ledger promotes on, and writing it in '
    + 'would quietly degrade the thing it imitates');
});

console.log('\n-- Discovery: the tokens the bot already watched get created --');

// THE REPORTED SYMPTOM: "the wallet scanner never pulls anything". The sampled
// path finds tokens that are running NOW at whatever age, and a token hot
// enough to pass the bar has usually traded past what earlyBuyersOf can walk
// back through — so it credited nobody, by design, every run. The engine's
// own watchlist knows which running tokens are YOUNG.

atest('THE WATCHLIST PATH: a young running mint the bot already saw costs zero reads', async () => {
  // A connection that can answer nothing: if discovery touches it, the sampled
  // path ran and this proof is wrong about what it costs.
  const dead = new FakeConn(new Map(), new Map());
  const MINT = pk('youngHot');
  const { mints, reads } = await discoverRunningMints({
    ...dDeps(dead),
    recentMints: () => [{ mint: MINT, createdAt: Date.now() - 60_000, vSolInBondingCurve: 55 }],
  }, budget(5_000));
  assert.deepStrictEqual(mints.map(m => m.mint), [MINT]);
  assert.strictEqual(reads, 0, 'the watchlist is in memory — reading it must not spend the RPC budget');
});

atest('an OLD mint or a FLAT mint on the watchlist is not a lead, and the sample still runs', async () => {
  const dead = new FakeConn(new Map(), new Map());
  const out = await discoverRunningMints({
    ...dDeps(dead),
    recentMints: () => [
      { mint: pk('oldHot'), createdAt: Date.now() - RECENT_MINT_MAX_AGE_MS - 1, vSolInBondingCurve: 80 },
      { mint: pk('youngFlat'), createdAt: Date.now() - 60_000, vSolInBondingCurve: MIN_RUNNING_VSOL - 1 },
    ],
  }, budget(5_000));
  assert.deepStrictEqual(out.mints, [], 'neither qualifies');
  assert.ok(out.reads > 0, 'so the sampled path must have been tried');
  assert.ok(/no recent activity/.test(out.detail ?? ''), `and its own reason reported: ${out.detail}`);
});

atest('hottest first: two young running mints are ranked by curve depth', async () => {
  const dead = new FakeConn(new Map(), new Map());
  const { mints } = await discoverRunningMints({
    ...dDeps(dead),
    recentMints: () => [
      { mint: pk('warm'), createdAt: Date.now() - 60_000, vSolInBondingCurve: 45 },
      { mint: pk('hot'), createdAt: Date.now() - 60_000, vSolInBondingCurve: 70 },
    ],
  }, budget(5_000));
  assert.deepStrictEqual(mints.map(m => m.mint), [pk('hot'), pk('warm')]);
});

atest('END TO END: a young watchlist mint yields its first buyers with no key at all', async () => {
  const MINT = pk('youngMint');
  const conn = chainWith({
    mint: MINT, vSol: 55,
    firstBuyers: [{ user: pk('early1'), sol: 0.5 }, { user: pk('early2'), sol: 1.2 }],
  });
  const out = await discoverCandidates({
    ...dDeps(conn),
    recentMints: () => [{ mint: MINT, createdAt: Date.now() - 120_000, vSolInBondingCurve: 55 }],
  }, budget(5_000));
  assert.ok(out.outcome.ok, `discovery should have worked: ${out.outcome.detail}`);
  assert.deepStrictEqual(out.outcome.candidates.map(c => c.wallet).sort(), [pk('early1'), pk('early2')].sort());
});

test('the engine hands the scout its live watchlist', () => {
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const deps = engine.slice(engine.indexOf('public researchDeps()'), engine.indexOf('public researchDeps()') + 900);
  assert.ok(/recentMints: \(\) => tokenWatchlist\.all\(\)/.test(deps),
    'the watchlist is the only zero-cost list of young running mints this process has');
});

test('OLD BUG: the hourly scout read API keys once, at boot', () => {
  const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  const bundle = server.slice(server.indexOf('function scoutDeps()'), server.indexOf('function scoutDeps()') + 1200);
  const keys = bundle.slice(bundle.indexOf('getKeys: () =>'));
  assert.ok(/getKeys: \(\) => \{[\s\S]{0,120}sniperEngine\.getConfig\(\)/.test(keys),
    'getConfig() must be called INSIDE getKeys — outside it, the schedule (built once at boot) '
    + 'froze the keys and a key pasted into Settings was ignored until restart');
  const before = bundle.slice(0, bundle.indexOf('getKeys: () =>'));
  assert.ok(!/const cfg = sniperEngine\.getConfig\(\)/.test(before), 'and not captured above the closure');
});

test('a run cut short says so on the panel', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  assert.ok(/rep\.stoppedEarly && \(/.test(app),
    '"trading path busy" and "read budget exhausted" used to render identically to a complete run');
});

(async () => {
  for (const fn of queue) await fn();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
