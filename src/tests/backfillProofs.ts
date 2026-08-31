/**
 * BACKFILL PROOFS — is evidence rebuilt from chain history actually evidence?
 *
 *   npx ts-node src/tests/backfillProofs.ts
 *
 * The operator did not want to wait forty live trades to find out how the good
 * traders pick. They are right that the wait is avoidable: those trades are on
 * the chain already. What is NOT avoidable is the care, because a backfill can
 * manufacture a confident profile out of nothing in three distinct ways, and
 * every one of them looks like success:
 *
 *   1. AGE FROM A TRUNCATED WALK. Page back through a busy token's history,
 *      stop at the page cap, call the oldest thing you saw its birth. Every
 *      busy token now reads as minutes old. The band that follows is a fact
 *      about our page size.
 *   2. A PARTIAL WINDOW REPORTED AS A SMALL ONE. Read eight of the forty
 *      trades in the window, report 0.4 SOL of buying. Indistinguishable, once
 *      written down, from a token nobody wanted.
 *   3. POOLING TWO MEASUREMENT METHODS. The one that would have shipped. Live
 *      snapshots are taken seconds after launch; backfilled ones whenever the
 *      trader actually bought. Pool them and `ageSeconds` separates the groups
 *      almost perfectly — a beautiful rule that encodes WHEN WE LOOKED and
 *      contains no information about anyone's strategy.
 *
 * Test 3 is reproduced against the real deriver before it is fixed, because a
 * guard nobody has watched fail is a guard nobody knows works.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { readCurveMoment, WINDOW_MS, MAX_WINDOW_READS } from '../services/curveHistory';
import {
  backfillFromWallets, MIN_BUY_SOL, MIN_RECOVERED_FEATURES,
} from '../services/entryBackfill';
import { entryProfile, EntryProfileLearner, type TokenSnapshot } from '../services/entryProfile';
import { bondingProgressPct } from '../services/playbookRouter';
import { PUMP_PROGRAM_ID } from '../services/pumpEventDecoder';

let passed = 0;
let failed = 0;
const queue: Array<() => Promise<void>> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function atest(name: string, fn: () => Promise<void>): void {
  queue.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${name}\n        ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// A real encoder, so the real decoder does the work.
//
// A fake that returned hand-written PumpTradeEvent objects would prove the
// test's own understanding of the layout, not the code's. These bytes go
// through tradeEventsFromLogs exactly as a mainnet log line would.
// ---------------------------------------------------------------------------
const DISC = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);

function pk(seed: string): string {
  const b = Buffer.alloc(32);
  Buffer.from(seed).copy(b);
  return new PublicKey(b).toBase58();
}

interface EvSpec {
  mint: string; user: string; isBuy: boolean; sol: number; ts: number; vSol: number;
}
function encodeTradeEvent(e: EvSpec): string {
  const b = Buffer.alloc(129);
  let o = 0;
  DISC.copy(b, o); o += 8;
  new PublicKey(e.mint).toBuffer().copy(b, o); o += 32;
  b.writeBigUInt64LE(BigInt(Math.round(e.sol * 1e9)), o); o += 8;
  b.writeBigUInt64LE(BigInt(1_000_000), o); o += 8;
  b.writeUInt8(e.isBuy ? 1 : 0, o); o += 1;
  new PublicKey(e.user).toBuffer().copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(e.ts), o); o += 8;
  b.writeBigUInt64LE(BigInt(Math.round(e.vSol * 1e9)), o); o += 8;
  b.writeBigUInt64LE(BigInt(1_000_000_000), o); o += 8;
  b.writeBigUInt64LE(BigInt(0), o); o += 8;
  b.writeBigUInt64LE(BigInt(0), o);
  return b.toString('base64');
}
function logsFor(evs: EvSpec[]): string[] {
  const out = [`Program ${PUMP_PROGRAM_ID} invoke [1]`];
  for (const e of evs) out.push(`Program data: ${encodeTradeEvent(e)}`);
  out.push(`Program ${PUMP_PROGRAM_ID} success`);
  return out;
}

interface FakeTx { logs: string[]; err?: unknown; }
class FakeConn {
  public sigCalls: Array<{ address: string; limit: number; before?: string }> = [];
  public txReads: string[] = [];
  constructor(
    /** address (base58) -> signatures, NEWEST FIRST, as the RPC returns them. */
    private sigs: Map<string, Array<{ signature: string; blockTime: number; err?: unknown }>>,
    private txs: Map<string, FakeTx>,
    /** Signatures whose read should throw, to exercise the truncation path. */
    private throwOn: Set<string> = new Set(),
  ) {}
  async getSignaturesForAddress(addr: PublicKey, o: { limit: number; before?: string }) {
    this.sigCalls.push({ address: addr.toBase58(), limit: o.limit, before: o.before });
    const all = this.sigs.get(addr.toBase58()) ?? [];
    let start = 0;
    if (o.before) {
      const i = all.findIndex(s => s.signature === o.before);
      start = i >= 0 ? i + 1 : all.length;
    }
    return all.slice(start, start + o.limit);
  }
  async getTransaction(sig: string) {
    this.txReads.push(sig);
    if (this.throwOn.has(sig)) throw new Error('rpc blew up');
    const t = this.txs.get(sig);
    if (!t) return null;
    return { meta: { err: t.err ?? null, logMessages: t.logs } };
  }
}

const MINT_A = pk('mintAAA');
const MINT_B = pk('mintBBB');
const MINT_C = pk('mintCCC');
const W1 = pk('walletONE');
const W2 = pk('walletTWO');

function curveOf(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID),
  );
  return pda.toBase58();
}

const T = 1_800_000_000;             // a fixed block time, seconds
const deps = (conn: FakeConn, spendCap = 1e6) => {
  let left = spendCap;
  return {
    getConnection: () => conn as any,
    now: () => T * 1000,
    sleep: async () => {},
    spend: (n: number) => { if (left < n) return false; left -= n; return true; },
  };
};

console.log('\n-- Reading one moment out of a token\'s history --');

atest('a short page proves the beginning, so the age is exact', async () => {
  const sigs = new Map([[curveOf(MINT_A), [
    { signature: 's3', blockTime: T - 10 },
    { signature: 's2', blockTime: T - 200 },
    { signature: 's1', blockTime: T - 600 },
  ]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())), { vSolAtMoment: 72.5 });
  assert.ok(m);
  assert.strictEqual(m!.sawBeginning, true);
  assert.strictEqual(m!.ageSeconds, 600, 'oldest visible tx is the birth when the page was short');
});

atest('A FULL PAGE IS NOT A BEGINNING — no age is recorded at all', async () => {
  // The defect this prevents: page back through a busy token, stop at the cap,
  // and call the oldest thing you saw its birth. Every busy token then reads
  // as minutes old and the band is a fact about our page size.
  const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `f${i}`, blockTime: T - i }));
  const sigs = new Map([[curveOf(MINT_A), full]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())), { maxPages: 1 });
  assert.ok(m);
  assert.strictEqual(m!.sawBeginning, false);
  assert.strictEqual(m!.ageSeconds, undefined, 'a lower bound must never be filed as a measurement');
  assert.strictEqual(m!.rankCapped, true, 'and the rank is flagged as a floor');
});

atest('the rank counts only what landed before the moment', async () => {
  const sigs = new Map([[curveOf(MINT_A), [
    { signature: 'after2', blockTime: T + 50 },
    { signature: 'after1', blockTime: T + 5 },
    { signature: 'b3', blockTime: T - 1 },
    { signature: 'b2', blockTime: T - 30 },
    { signature: 'b1', blockTime: T - 90 },
  ]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())));
  assert.strictEqual(m!.curveTxRank, 3, 'trades after the moment are not ahead of you');
});

atest('A FAILED TRANSACTION IS NOT SOMEBODY AHEAD OF YOU', async () => {
  // Failed transactions stay in the signature list. On a contested launch most
  // of them are snipers who LOST the race — they moved no SOL and touched no
  // reserves — so counting them makes the rank a measure of contention rather
  // than of demand, and puts every ordinary buyer behind a crowd that never
  // actually bought.
  const sigs = new Map([[curveOf(MINT_A), [
    { signature: 'ok2', blockTime: T - 5 },
    { signature: 'lost1', blockTime: T - 6, err: { InstructionError: [0, 'x'] } },
    { signature: 'lost2', blockTime: T - 7, err: { InstructionError: [0, 'x'] } },
    { signature: 'ok1', blockTime: T - 40 },
    { signature: 'birth', blockTime: T - 900 },
  ]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())));
  assert.strictEqual(m!.curveTxRank, 3, 'two failed races were counted as buyers');
  assert.strictEqual(m!.ageSeconds, 900, 'and a failed tx must not be mistaken for the birth either');
});

atest('SAME-SECOND PREDECESSORS COUNT — block time is only second-granular', async () => {
  // A hot launch puts dozens of buys inside one second. A strict `<` drops
  // every one of them, understating the rank most severely exactly where the
  // rank carries the most information — and making an ordinary buyer on a
  // contested launch look like they were at the front, which is the input to
  // the insider check.
  const sigs = new Map([[curveOf(MINT_A), [
    { signature: 'same3', blockTime: T },
    { signature: 'same2', blockTime: T },
    { signature: 'same1', blockTime: T },
    { signature: 'mine', blockTime: T },
    { signature: 'birth', blockTime: T - 600 },
  ]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())), {
    excludeSignature: 'mine',
  });
  assert.strictEqual(m!.curveTxRank, 4, 'three same-second trades plus the birth are all ahead');
});

atest('and a buyer is never counted as ahead of themselves', async () => {
  const sigs = new Map([[curveOf(MINT_A), [
    { signature: 'mine', blockTime: T },
    { signature: 'birth', blockTime: T - 600 },
  ]]]);
  const withOut = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())), { excludeSignature: 'mine' });
  assert.strictEqual(withOut!.curveTxRank, 1, 'only the birth is ahead of them');
  // And a caller with no particular transaction still gets a defensible count.
  const plain = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())));
  assert.strictEqual(plain!.curveTxRank, 2, 'a control moment is not any of the trades, so nothing is excluded');
});

atest('curve position is on the canonical scale, not a local formula', async () => {
  const sigs = new Map([[curveOf(MINT_A), [{ signature: 's1', blockTime: T - 60 }]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())), { vSolAtMoment: 30 + 85 / 2 });
  assert.strictEqual(m!.curveProgressPct, 50);
  assert.strictEqual(m!.curveProgressPct, bondingProgressPct(30 + 85 / 2));
});

atest('a moment before the token existed is never given an age', async () => {
  const sigs = new Map([[curveOf(MINT_A), [{ signature: 's1', blockTime: T + 500 }]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())));
  assert.strictEqual(m!.ageSeconds, undefined, 'a negative age means the caller is wrong, not that the token is new');
});

console.log('\n-- The five-minute window --');

function windowFixture(n: number, opts: { failIdx?: number[]; sells?: number[] } = {}) {
  const sigs: Array<{ signature: string; blockTime: number }> = [];
  const txs = new Map<string, FakeTx>();
  for (let i = 0; i < n; i++) {
    const sig = `w${i}`;
    const ts = T - 10 - i;                     // all inside the 5-minute window
    sigs.push({ signature: sig, blockTime: ts });
    const isSell = (opts.sells ?? []).includes(i);
    txs.set(sig, {
      err: (opts.failIdx ?? []).includes(i) ? { some: 'error' } : undefined,
      logs: logsFor([{ mint: MINT_A, user: pk(`buyer${i % 4}`), isBuy: !isSell, sol: 1, ts, vSol: 60 }]),
    });
  }
  sigs.push({ signature: 'birth', blockTime: T - 4000 });
  return { sigs: new Map([[curveOf(MINT_A), sigs]]), txs };
}

atest('flow, buyers and pressure are counted from decoded events', async () => {
  const f = windowFixture(6, { sells: [4, 5] });
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(f.sigs, f.txs)), { readWindow: true });
  assert.strictEqual(m!.windowBuySol, 4);
  assert.strictEqual(m!.windowSellSol, 2);
  assert.strictEqual(m!.windowBuyers, 4, 'four distinct buyers across the six trades');
  assert.strictEqual(m!.windowBuyPressurePct, 66.6667, 'rounded to 4dp, as every stored figure here is');
});

atest('A FAILED TRANSACTION IS NOT DEMAND', async () => {
  // A failed-buy storm — every sniper in the same slot losing the race — would
  // otherwise read as a token being aggressively bought.
  const f = windowFixture(4, { failIdx: [0, 1] });
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(f.sigs, f.txs)), { readWindow: true });
  assert.strictEqual(m!.windowBuySol, 2, 'only the two that landed moved SOL');
});

atest('A TRUNCATED WINDOW REPORTS NOTHING, NOT A SMALL NUMBER', async () => {
  // The defect: read eight of forty trades, report 0.4 SOL of buying. Once
  // written down it is indistinguishable from a token nobody wanted.
  const f = windowFixture(6);
  const conn = new FakeConn(f.sigs, f.txs, new Set(['w2']));
  const m = await readCurveMoment(MINT_A, T * 1000, deps(conn), { readWindow: true });
  assert.strictEqual(m!.windowBuySol, undefined, 'a partial sum must not be filed as a measurement');
  assert.strictEqual(m!.windowBuyPressurePct, undefined);
  assert.ok(m!.stoppedEarly, 'and the walk says it was incomplete');
  assert.strictEqual(m!.curveTxRank, 7, 'the rank does not depend on the window, so it still stands');
});

atest('a genuinely quiet window is zero, but has no pressure ratio', async () => {
  const sigs = new Map([[curveOf(MINT_A), [
    { signature: 'old', blockTime: T - Math.floor(WINDOW_MS / 1000) - 500 },
  ]]]);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(sigs, new Map())), { readWindow: true });
  assert.strictEqual(m!.windowBuySol, 0, 'nobody trading is a real observation, not a missing one');
  assert.strictEqual(m!.windowBuyers, 0);
  assert.strictEqual(m!.windowBuyPressurePct, undefined, 'no flow means no ratio — 0% would be a lie about direction');
});

atest('the window read is capped, and the cap is not silently a full window', async () => {
  const f = windowFixture(MAX_WINDOW_READS + 20);
  const conn = new FakeConn(f.sigs, f.txs);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(conn), { readWindow: true });
  assert.ok(conn.txReads.length <= MAX_WINDOW_READS, `read ${conn.txReads.length} > cap ${MAX_WINDOW_READS}`);
  assert.ok(m);
});

atest('the read budget is a hard ceiling and says so', async () => {
  const f = windowFixture(20);
  const m = await readCurveMoment(MINT_A, T * 1000, deps(new FakeConn(f.sigs, f.txs), 3), { readWindow: true });
  assert.ok(m!.stoppedEarly?.includes('budget'), `expected a budget refusal, got ${m!.stoppedEarly}`);
});

console.log('\n-- Rebuilding a wallet\'s entries --');

/** A wallet with buys on A and B, a dust buy on C, and a sell on A. */
function walletFixture() {
  const txs = new Map<string, FakeTx>();
  const walletSigs = [
    { signature: 'wA_late', blockTime: T - 100 },
    { signature: 'wA_sell', blockTime: T - 300 },
    { signature: 'wB', blockTime: T - 500 },
    { signature: 'wC_dust', blockTime: T - 700 },
    { signature: 'wA_first', blockTime: T - 900 },
  ];
  txs.set('wA_late', { logs: logsFor([{ mint: MINT_A, user: W1, isBuy: true, sol: 2, ts: T - 100, vSol: 90 }]) });
  txs.set('wA_sell', { logs: logsFor([{ mint: MINT_A, user: W1, isBuy: false, sol: 3, ts: T - 300, vSol: 88 }]) });
  txs.set('wB', { logs: logsFor([{ mint: MINT_B, user: W1, isBuy: true, sol: 1.5, ts: T - 500, vSol: 60 }]) });
  txs.set('wC_dust', { logs: logsFor([{ mint: MINT_C, user: W1, isBuy: true, sol: MIN_BUY_SOL / 2, ts: T - 700, vSol: 40 }]) });
  txs.set('wA_first', { logs: logsFor([{ mint: MINT_A, user: W1, isBuy: true, sol: 1, ts: T - 900, vSol: 55 }]) });

  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  sigs.set(W1, walletSigs);
  for (const m of [MINT_A, MINT_B, MINT_C]) {
    sigs.set(curveOf(m), [
      { signature: `${m}_t2`, blockTime: T - 50 },
      { signature: `${m}_t1`, blockTime: T - 2000 },
    ]);
  }
  sigs.set(PUMP_PROGRAM_ID, []);            // no controls by default
  return { sigs, txs };
}

async function runBackfill(overrides: Partial<Parameters<typeof backfillFromWallets>[2]> = {}, conn?: FakeConn) {
  entryProfile.reset();
  const f = walletFixture();
  const c = conn ?? new FakeConn(f.sigs, f.txs);
  const r = await backfillFromWallets([W1], deps(c), { controlsPerEntry: 0, readWindow: false, ...overrides });
  return { r, conn: c, snaps: entryProfile.serialize() };
}

atest('ONE ENTRY PER MINT, AND IT IS THE FIRST BUY', async () => {
  // A DCA ladder is one decision. Counting it five times lets a single
  // conviction dominate the band the way it would dominate a confluence count.
  // And the adds were made with information the entry did not have, so the
  // entry is the one that describes the choice.
  const { r, snaps } = await runBackfill();
  const forA = snaps.entered.filter(s => s.mint === MINT_A);
  assert.strictEqual(forA.length, 1, `expected one snapshot for the laddered mint, got ${forA.length}`);
  assert.strictEqual(forA[0].at, (T - 900) * 1000, 'the FIRST buy, not the latest');
  assert.strictEqual(r.entriesRecorded, 2, 'A and B; the dust buy on C is not an opinion');
});

atest('a dust buy is not an opinion', async () => {
  const { snaps } = await runBackfill();
  assert.ok(!snaps.entered.some(s => s.mint === MINT_C), 'sub-floor buys teach the shape of a scanner, not a strategy');
});

atest('a sell is never an entry', async () => {
  const { snaps } = await runBackfill();
  const a = snaps.entered.find(s => s.mint === MINT_A);
  assert.ok(a);
  assert.notStrictEqual(a!.at, (T - 300) * 1000);
});

atest('THE BUYER IS THE PROGRAM\'S `user`, NOT THE TRANSACTION SIGNER', async () => {
  // A bundler's fee payer signs sixteen wallets' buys in one transaction.
  // Matching on the signer would credit the fee payer with sixteen opinions
  // and the actual traders with none.
  entryProfile.reset();
  const txs = new Map<string, FakeTx>();
  txs.set('bundle', {
    logs: logsFor([
      { mint: MINT_A, user: W2, isBuy: true, sol: 1, ts: T - 100, vSol: 60 },
      { mint: MINT_B, user: W1, isBuy: true, sol: 1, ts: T - 100, vSol: 60 },
    ]),
  });
  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  sigs.set(W1, [{ signature: 'bundle', blockTime: T - 100 }]);
  for (const m of [MINT_A, MINT_B]) sigs.set(curveOf(m), [{ signature: `${m}_t1`, blockTime: T - 3000 }]);
  sigs.set(PUMP_PROGRAM_ID, []);
  await backfillFromWallets([W1], deps(new FakeConn(sigs, txs)), { controlsPerEntry: 0, readWindow: false });
  const s = entryProfile.serialize();
  assert.ok(s.entered.every(e => e.mint !== MINT_A), 'the other wallet in the bundle is not ours');
  assert.ok(s.entered.some(e => e.mint === MINT_B), 'and ours is still credited');
});

atest('every backfilled snapshot is tagged as backfilled', async () => {
  const { snaps } = await runBackfill();
  assert.ok(snaps.entered.length > 0);
  assert.ok(snaps.entered.every(s => s.source === 'backfill'),
    'an untagged snapshot would be pooled with live ones — see the confound proof below');
});

atest('a snapshot that recovered almost nothing is refused', async () => {
  // Forty two-field snapshots would clear MIN_ENTERED_SAMPLES and unlock a
  // profile built on air.
  assert.ok(MIN_RECOVERED_FEATURES >= 3, 'two features do not describe a token');
  entryProfile.reset();
  const txs = new Map<string, FakeTx>();
  txs.set('one', { logs: logsFor([{ mint: MINT_A, user: W1, isBuy: true, sol: 1, ts: T - 100, vSol: 60 }]) });
  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  sigs.set(W1, [{ signature: 'one', blockTime: T - 100 }]);
  // Enough history to exhaust the page walk, so the beginning is never seen:
  // no age, and a rank that is only a floor and therefore withheld. That
  // leaves curve progress alone. (One full page is NOT enough — the second
  // page comes back empty, and an empty page IS the beginning.)
  sigs.set(curveOf(MINT_A), Array.from({ length: 3000 }, (_, i) => ({ signature: `p${i}`, blockTime: T - i })));
  sigs.set(PUMP_PROGRAM_ID, []);
  const r = await backfillFromWallets([W1], deps(new FakeConn(sigs, txs)),
    { controlsPerEntry: 0, readWindow: false, });
  assert.strictEqual(r.entriesRecorded, 0, 'one recoverable feature is not a token description');
  assert.ok(r.rejected['too few recoverable features'] > 0, 'and the refusal is counted, not silent');
});

atest('A CAPPED RANK IS A FLOOR AND IS NOT RECORDED AS A COUNT', async () => {
  // The snapshot must SURVIVE for this to prove anything. An earlier version of
  // this test asserted `every(... === undefined)` over a snapshot list that the
  // recovered-features floor had already emptied, so it passed whatever the
  // code did — caught by mutating the guard and watching the test stay green.
  entryProfile.reset();
  const txs = new Map<string, FakeTx>();
  txs.set('one', { logs: logsFor([{ mint: MINT_A, user: W1, isBuy: true, sol: 1, ts: T, vSol: 60 }]) });
  const sigs = new Map<string, Array<{ signature: string; blockTime: number }>>();
  sigs.set(W1, [{ signature: 'one', blockTime: T }]);
  // Deep history, so the walk never reaches the beginning and the rank is a
  // floor — with the newest few readable as real trades, so the window fills
  // and the snapshot clears the recovered-features floor on its own merits.
  const curveSigs: Array<{ signature: string; blockTime: number }> = [];
  for (let i = 0; i < 5; i++) {
    const sig = `win${i}`;
    curveSigs.push({ signature: sig, blockTime: T - 10 - i });
    txs.set(sig, { logs: logsFor([{ mint: MINT_A, user: pk(`b${i}`), isBuy: true, sol: 1, ts: T - 10 - i, vSol: 60 }]) });
  }
  for (let i = 0; i < 3000; i++) curveSigs.push({ signature: `p${i}`, blockTime: T - 100 - i });
  sigs.set(curveOf(MINT_A), curveSigs);
  sigs.set(PUMP_PROGRAM_ID, []);
  await backfillFromWallets([W1], deps(new FakeConn(sigs, txs)), { controlsPerEntry: 0, readWindow: true });
  const s = entryProfile.serialize();
  assert.strictEqual(s.entered.length, 1, 'the snapshot must survive, or this test proves nothing');
  assert.ok(s.entered[0].windowBuySol !== undefined, 'and survive on window evidence, not on a rank');
  assert.strictEqual(s.entered[0].curveTxRank, undefined,
    '"at least 3000 ahead" in a column of exact counts drags the band it belongs to');
});

console.log('\n-- The matched control group --');

/** The same wallet fixture, plus pump-program traffic around each buy. */
function controlFixture() {
  const f = walletFixture();
  const controlSigs = [
    { signature: 'ctl1', blockTime: T - 900 },
    { signature: 'ctl2', blockTime: T - 901 },
    { signature: 'ctl3', blockTime: T - 902 },
  ];
  f.sigs.set(PUMP_PROGRAM_ID, [
    { signature: 'wA_first', blockTime: T - 900 },
    ...controlSigs,
  ]);
  // ctl1 trades a mint the wallet ALSO bought — it is an entry, not a control.
  f.txs.set('ctl1', { logs: logsFor([{ mint: MINT_B, user: pk('rando1'), isBuy: true, sol: 1, ts: T - 900, vSol: 61 }]) });
  f.txs.set('ctl2', { logs: logsFor([{ mint: pk('ctlMintX'), user: pk('rando2'), isBuy: true, sol: 1, ts: T - 901, vSol: 44 }]) });
  f.txs.set('ctl3', { logs: logsFor([{ mint: pk('ctlMintY'), user: pk('rando3'), isBuy: true, sol: 1, ts: T - 902, vSol: 77 }]) });
  for (const m of [pk('ctlMintX'), pk('ctlMintY')]) {
    f.sigs.set(curveOf(m), [
      { signature: `${m}_t2`, blockTime: T - 800 },
      { signature: `${m}_t1`, blockTime: T - 5000 },
    ]);
  }
  return f;
}

atest('controls are read at the SAME MOMENT as the entry they match', async () => {
  // The whole reason the control group exists. Read at a different moment and
  // every feature separates on when we looked.
  entryProfile.reset();
  const f = controlFixture();
  await backfillFromWallets([W1], deps(new FakeConn(f.sigs, f.txs)), { controlsPerEntry: 3, readWindow: false });
  const s = entryProfile.serialize();
  const entryA = s.entered.find(e => e.mint === MINT_A);
  assert.ok(entryA, 'the entry on A was recorded');
  const controls = s.skipped;
  assert.ok(controls.length > 0, 'controls were sampled');
  for (const c of controls) {
    assert.ok(
      c.at === (T - 900) * 1000 || c.at === (T - 500) * 1000,
      `a control was read at ${c.at}, not at either entry moment`);
  }
});

atest('A TOKEN THEY BOUGHT IS NEVER USED AS A CONTROL', async () => {
  // It would be a mislabelled entry, and one that pushes the two populations
  // toward each other — weakening every rule rather than producing a wrong one,
  // which makes it the harder kind to notice.
  entryProfile.reset();
  const f = controlFixture();
  await backfillFromWallets([W1], deps(new FakeConn(f.sigs, f.txs)), { controlsPerEntry: 3, readWindow: false });
  const s = entryProfile.serialize();
  assert.ok(s.skipped.every(c => c.mint !== MINT_A && c.mint !== MINT_B),
    'mints this wallet bought appeared in its own control group');
});

atest('controls are tagged backfill too, so they pair with the entries', async () => {
  entryProfile.reset();
  const f = controlFixture();
  await backfillFromWallets([W1], deps(new FakeConn(f.sigs, f.txs)), { controlsPerEntry: 3, readWindow: false });
  const s = entryProfile.serialize();
  assert.ok(s.skipped.length > 0);
  assert.ok(s.skipped.every(c => c.source === 'backfill'));
});

console.log('\n-- The confound: pooling two ways of measuring --');

/**
 * The bug, reproduced against the real deriver.
 *
 * Live snapshots are taken seconds after launch. Backfilled entries are taken
 * whenever the trader bought. Nothing here differs about the TOKENS at all —
 * both groups are drawn from the same age distribution in reality — and yet a
 * pooled derivation finds a perfect rule, because the two labels happen to
 * carry different measurement times.
 */
function pooled(): { entered: TokenSnapshot[]; skipped: TokenSnapshot[] } {
  const entered: TokenSnapshot[] = [];
  const skipped: TokenSnapshot[] = [];
  // Their entries, rebuilt from history: read at the moment they bought.
  for (let i = 0; i < 60; i++) {
    entered.push({ mint: `e${i}`, at: Date.now(), source: 'backfill', ageSeconds: 600 + i, curveProgressPct: 20 + (i % 40) });
  }
  // Live screening: every one taken a few seconds after launch.
  for (let i = 0; i < 400; i++) {
    skipped.push({ mint: `s${i}`, at: Date.now(), source: 'live', ageSeconds: 3 + (i % 5), curveProgressPct: 20 + (i % 40) });
  }
  return { entered, skipped };
}

test('REPRODUCTION: pooled, the deriver finds a perfect rule that means nothing', () => {
  const { entered, skipped } = pooled();
  // Strip the labels — this is what the code did before the guard existed.
  const strip = (l: TokenSnapshot[]) => l.map(({ source, ...rest }) => rest as TokenSnapshot);
  const p = EntryProfileLearner.derive(strip(entered), strip(skipped));
  const age = p.rules.find(r => r.feature === 'ageSeconds');
  assert.ok(age, 'unguarded, age becomes a rule');
  assert.strictEqual(age!.separation, 1,
    'and a perfect one — every control falls outside the band, because we looked at them earlier');
});

test('THE GUARD: labelled, the two methods are never mixed', () => {
  const { entered, skipped } = pooled();
  const p = EntryProfileLearner.derive(entered, skipped);
  assert.strictEqual(p.usable, false,
    'there is no method with both enough entries and enough controls, so there is no profile');
  assert.ok(/backfill|live/.test(p.notReady ?? ''), p.notReady);
});

test('the profile names the method it was derived from', () => {
  const l = new EntryProfileLearner();
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    l.recordEntry({ mint: `e${i}`, at: now, source: 'backfill', ageSeconds: 600 + i, curveProgressPct: 20 + (i % 30) });
  }
  for (let i = 0; i < 300; i++) {
    l.recordSkipped({ mint: `s${i}`, at: now, source: 'backfill', ageSeconds: 10 + (i % 3000), curveProgressPct: 20 + (i % 30) });
  }
  const p = l.profile();
  assert.strictEqual(p.source, 'backfill');
  assert.strictEqual(p.usable, true, p.notReady);
});

test('a snapshot saved before the tag existed counts as live', () => {
  // Back-compat, and the safe direction: the live path is what wrote every
  // untagged snapshot that exists.
  const l = new EntryProfileLearner();
  const now = Date.now();
  for (let i = 0; i < 60; i++) l.recordEntry({ mint: `e${i}`, at: now, ageSeconds: 100 + i, curveProgressPct: 10 + (i % 20) });
  for (let i = 0; i < 300; i++) l.recordSkipped({ mint: `s${i}`, at: now, ageSeconds: 1 + (i % 900), curveProgressPct: 10 + (i % 20) });
  assert.strictEqual(l.profile().source, 'live');
});

console.log('\n-- What it refuses to reconstruct --');

test('holder distribution and USD market cap are never rebuilt', () => {
  const src = readFileSync(join(__dirname, '..', 'services', 'entryBackfill.ts'), 'utf8');
  const fn = src.slice(src.indexOf('function snapshotFromMoment('), src.indexOf('export const MIN_RECOVERED_FEATURES'));
  for (const forbidden of ['top10Pct', 'devHoldingsPct', 'bundledSupplyPct', 'marketCapUsd', 'liquidityUsd']) {
    assert.ok(!fn.includes(forbidden),
      `${forbidden} cannot be known for a past moment — today's figure describes today's token`);
  }
});

test('the file states what its control group actually is', () => {
  // The control is "tokens with a trade in the same second", which
  // over-represents busy tokens. That is a deliberate choice and it shapes
  // every rule derived from it, so it is written where the next reader will
  // find it rather than left to be rediscovered.
  const src = readFileSync(join(__dirname, '..', 'services', 'entryBackfill.ts'), 'utf8');
  assert.ok(/over-represents busy tokens/.test(src), 'the sampling bias must be stated');
});

(async () => {
  for (const fn of queue) await fn();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
